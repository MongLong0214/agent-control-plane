import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import type { AuthenticatedTargetBinding, BindingRegistry, VerifiedTargetBinding } from "../session/binding-registry.ts";
import type { BuzzActorAuthenticator, SessionRegistry } from "../session/session-registry.ts";

/**
 * Canonical runtime self-claim / adoption (#760).
 *
 * There is no public activation surface that can safely adopt an *already-running*
 * conversation into a first-class role: `agentctl bootstrap hermes` launches a new runtime, which
 * is exactly what must not happen for the canonical PRIMARY_CTO conversational actor, because the
 * canonical conversation already exists and must be adopted in place. This module is the claim
 * primitive that composition does: it derives who is asking independently of what it is told,
 * verifies eight independently fatal facts about the claimant, and only then performs one atomic
 * mutation that either creates the session/actor/assignment/target-binding/attestation tuple or
 * writes nothing at all.
 *
 * What this module deliberately does not do:
 *  - It never accepts an argument as identity. A caller-supplied session UUID or PID is checked
 *    against the independently derived value; a mismatch is a refusal, never a substitution.
 *  - It never creates a session other than the one exact canonical UUID this deployment names.
 *    There is no fallback that mints a fresh session or actor on any failure — absence is a
 *    refusal, not a reason to bootstrap something new (that is `bootstrap hermes`'s job, for a
 *    runtime that does not yet exist).
 *  - It never touches a Hermes/CEO actor. CEO direction is out of scope; nothing here mints one.
 *  - It never opens a write transaction before every identity check has already passed. Every
 *    refusal above `#mutate` therefore leaves the database exactly as it found it, by construction
 *    rather than by inspecting what `#mutate` decided.
 */

// ---------------------------------------------------------------------------
// Deployment constants. Two facts the packet supplied and this module must not re-derive.
// ---------------------------------------------------------------------------

/** The one session this primitive may ever adopt (#760). No other UUID is a restore target. */
export const CANONICAL_SESSION_UUID = "dc54ab12-e2da-497a-a3c5-9a2a5f8f579a";

/**
 * The exact executor version this deployment currently requires. Measured live: the
 * `~/.local/bin/claude` symlink was repointed to this version on Sep 3, while the running
 * canonical pane still executes 2.1.241 — so this has to be read from the executing image, never
 * from the symlink and never from a fresh `claude --version` invocation resolved through PATH.
 */
export const REQUIRED_EXECUTOR_VERSION = "2.1.259";

/** The canonical project's Buzz channel (`repo-factory`). */
export const CANONICAL_PROJECT_BUZZ_CHANNEL_ID = "c37e88d0-8576-48aa-a69c-9cbd54d47be2";

/**
 * `actor_target_bindings.executor_kind` is a closed vocabulary; the schema seeds exactly one
 * value, `'hermes'` (src/db/schema.sql). This one is now seeded the same way, by
 * `src/db/migrations.ts`'s `v37-seed-claude-cli-executor-kind` — not written here at application
 * time. Reusing `'hermes'` for a Claude CLI target would mislabel every row a reader later queries
 * by executor kind, which is why this is its own value rather than a reused one.
 */
export const SELF_CLAIM_EXECUTOR_KIND = "claude-cli";

/** This primitive's own attestation protocol; deliberately distinct from `hermes.target-bind/v1`. */
export const SELF_CLAIM_PROTOCOL = "acp.canonical-self-claim/v1";

/**
 * The operation name a claim's `OwnerApprovalReceipt` must carry, and the domain tag of the
 * digest that binds it to one exact project, claimant session, role and generation (correction
 * 4): `OwnerApprovalReceipt.parameterDigest` is a generic field `OwnerAuthority` never interprets
 * — binding it to *these* parameters is this module's job, not the ledger's.
 */
export const SELF_CLAIM_OPERATION = "actor.claim_canonical_cto";

/**
 * The exact digest an owner approval for one claim attempt must carry as `parameterDigest`. A
 * mismatch (wrong project, wrong session, wrong role, or a stale `expectedBindingGeneration`)
 * fails `OwnerAuthority.assertApproval`'s completeness check indirectly — `claim()` compares this
 * value itself before ever presenting the receipt for consumption, which is the earlier and more
 * exact refusal point of the two.
 */
export const canonicalSelfClaimParameterDigest = (input: {
  projectId: string;
  claimedSessionUuid: string;
  expectedBindingGeneration: number;
}): string =>
  digestOf({
    domain: SELF_CLAIM_OPERATION,
    projectId: input.projectId,
    claimedSessionUuid: input.claimedSessionUuid,
    role: "PRIMARY_CTO",
    expectedBindingGeneration: input.expectedBindingGeneration,
  });

const MAX_ANCESTRY_HOPS = 64;
const SUBPROCESS_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMBEDDED_UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;
/** Flags that mean the invocation is a headless, non-interactive query (§ probeSession usage). */
const HEADLESS_CLAUDE_FLAGS = new Set(["-p", "--print", "--output-format", "--input-format"]);

// ---------------------------------------------------------------------------
// Process ancestry — real OS state, never a caller's word.
// ---------------------------------------------------------------------------

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  /** The full command line as `ps -o command=` reports it (never the truncated `comm` field). */
  command: string;
  cwd: string | null;
  /** `null` means unverifiable, the fail-closed reading (#505's `processStartedAt` contract). */
  startedAt: string | null;
}

export interface ProcessAncestryInspector {
  snapshot(pid: number): ProcessSnapshot | null;
}

interface LsofEntry {
  fd: string;
  type: string;
  name: string;
}

/**
 * Parses `lsof -p <pid> -Fftn`'s field-per-line output into (fd, type, name) triples.
 *
 * This one call is what both the default cwd and executing-image lookups below are built on.
 * `comm=` was measured to truncate a real path (`/tmp/claude-test-bin/claude` read back as
 * `/tmp/claude-test`), so this reads lsof's own name field instead of any `ps` short-name column.
 */
const lsofEntries = (pid: number): LsofEntry[] => {
  let out: string;
  try {
    out = execFileSync("lsof", ["-p", String(pid), "-Fftn"], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const entries: LsofEntry[] = [];
  let fd = "";
  let type = "";
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0]!;
    const value = line.slice(1);
    if (tag === "f") { fd = value; type = ""; continue; }
    if (tag === "t") { type = value; continue; }
    if (tag === "n") entries.push({ fd, type, name: value });
  }
  return entries;
};

const psField = (pid: number, field: string): string | null => {
  try {
    // `-ww` disables ps's output-width truncation (default width tracks the controlling
    // terminal, or a platform default with none) — measured to matter here: a `command` long
    // enough to carry a real invocation's flags was silently cut short without it.
    const out = execFileSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
};

/**
 * Linux exposes the live cwd directly; everywhere else (this deployment runs on Darwin) falls
 * back to lsof's own `cwd` file descriptor, which the kernel — not a later filesystem lookup —
 * populated at the time the descriptor was opened.
 */
const resolveProcessCwd = (pid: number): string | null => {
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {
    /* not Linux, or the process is gone; fall through to lsof */
  }
  return lsofEntries(pid).find((entry) => entry.fd === "cwd" && entry.type === "DIR")?.name ?? null;
};

export const defaultProcessAncestryInspector: ProcessAncestryInspector = {
  snapshot(pid) {
    const ppidRaw = psField(pid, "ppid");
    const command = psField(pid, "command");
    if (ppidRaw === null || command === null) return null;
    const ppid = Number.parseInt(ppidRaw, 10);
    if (!Number.isSafeInteger(ppid)) return null;
    return { pid, ppid, command, cwd: resolveProcessCwd(pid), startedAt: processStartedAt(pid) };
  },
};

/**
 * Matches the first or second whitespace token's basename against `claude` — covering both a
 * directly executed compiled binary (`/path/to/claude ...`) and an interpreter-launched script
 * (`node /path/to/claude ...`). `ps -o comm=` is not used here: it truncates long paths.
 */
export const looksLikeClaudeInvocation = (command: string): boolean => {
  const tokens = command.trim().split(/\s+/).slice(0, 2);
  return tokens.some((token) => /(^|\/)claude$/.test(token));
};

/**
 * The flag this codebase's own adapters already use to name an external Claude session
 * (`src/runtime/cli-adapters.ts` passes `--session-id <externalSessionId>`); `--resume` is
 * accepted too since interactive resumption commonly spells it that way.
 */
export const extractSessionUuidFromCommand = (command: string): string | null => {
  const match = /--session-id[= ]+(\S+)/.exec(command) ?? /--resume[= ]+(\S+)/.exec(command);
  const candidate = match?.[1];
  if (!candidate) return null;
  const uuid = EMBEDDED_UUID_PATTERN.exec(candidate)?.[0];
  return uuid ? uuid.toLowerCase() : null;
};

/** Absence of a headless query flag, not presence of a TTY — no cross-process TTY probe exists. */
export const isInteractiveClaudeInvocation = (command: string): boolean =>
  !command.trim().split(/\s+/).some((token) => HEADLESS_CLAUDE_FLAGS.has(token));

export interface DerivedClaimantIdentity {
  pid: number;
  ppid: number;
  startedAt: string | null;
  cwd: string | null;
  command: string;
  sessionUuid: string;
}

/**
 * Clause 1 — identity is derived, never accepted. Walks the process ancestry from `callerPid` to
 * the nearest `claude` ancestor and reads the session UUID out of *that* ancestor's actual command
 * line. A caller-supplied UUID or PID is never consulted here; `CanonicalSelfClaim.claim` checks
 * one against the value this returns, afterward, and refuses on any mismatch.
 */
export const deriveClaimantIdentity = (
  callerPid: number,
  inspector: ProcessAncestryInspector,
  maxHops = MAX_ANCESTRY_HOPS,
): Decision<DerivedClaimantIdentity> => {
  if (!Number.isSafeInteger(callerPid) || callerPid <= 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "callerPid must be a positive integer", { callerPid });
  }
  const visited = new Set<number>();
  let current = callerPid;
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (visited.has(current)) {
      return deny(
        ReasonCode.CONFLICT,
        "process ancestry cycle detected before a claude ancestor was found",
        { callerPid, cycleAt: current },
      );
    }
    visited.add(current);
    const snapshot = inspector.snapshot(current);
    if (!snapshot) {
      return deny(
        ReasonCode.NOT_FOUND,
        "process ancestry could not be walked to a claude ancestor",
        { callerPid, stoppedAtPid: current },
      );
    }
    if (looksLikeClaudeInvocation(snapshot.command)) {
      const sessionUuid = extractSessionUuidFromCommand(snapshot.command);
      if (!sessionUuid) {
        return deny(
          ReasonCode.NOT_FOUND,
          "the claude ancestor's command line names no session id",
          { pid: snapshot.pid },
        );
      }
      return allow(ReasonCode.OK, {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        startedAt: snapshot.startedAt,
        cwd: snapshot.cwd,
        command: snapshot.command,
        sessionUuid,
      });
    }
    if (snapshot.ppid <= 1 || snapshot.ppid === current) {
      return deny(
        ReasonCode.NOT_FOUND,
        "no claude ancestor exists between the calling process and pid 1",
        { callerPid },
      );
    }
    current = snapshot.ppid;
  }
  return deny(
    ReasonCode.CONFLICT,
    "process ancestry walk exceeded its hop limit without finding a claude ancestor",
    { callerPid, maxHops },
  );
};

// ---------------------------------------------------------------------------
// Executing image — the specific file the OS loaded, not a symlink read at check time.
// ---------------------------------------------------------------------------

export interface ExecutingImageEvidence {
  imagePath: string;
  version: string;
}

export interface ExecutingImageInspector {
  resolve(pid: number): ExecutingImageEvidence | null;
}

/**
 * `/proc/<pid>/exe` is the kernel's own record of the file that was actually exec'd — resolved at
 * exec time and unaffected by later renaming the path that produced it. On Darwin, lsof's `txt`
 * file descriptor carries the same property: measured directly (spawn a process through a symlink,
 * repoint the symlink, then read `lsof -p <pid> -Fftn` for the still-running pid) — it kept
 * reporting the original target, not the symlink's new one. Neither route ever reads the symlink
 * path itself, which is exactly the property clause 2 requires.
 */
const resolveExecutingImagePath = (pid: number): string | null => {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch {
    /* not Linux, or permission denied; fall through to lsof */
  }
  return lsofEntries(pid).find((entry) => entry.fd === "txt" && entry.type === "REG")?.name ?? null;
};

/**
 * Reads version metadata colocated with the resolved image rather than executing it. Invoking the
 * resolved path with `--version` was considered and rejected: the packet's instruction is to stop
 * reading `claude --version`, and a self-reported string from a binary a security check is actively
 * trying not to trust the caller's word about is the same shape of evidence, one hop removed. A
 * sibling manifest (or a `/versions/<version>/` segment in the resolved path itself, the layout
 * `~/.local/bin/claude` is measured to use) is the OS's own filesystem state, not a report from the
 * thing being checked.
 */
const versionFromImagePath = (imagePath: string): string | null => {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(imagePath), "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof manifest.version === "string" && VERSION_PATTERN.test(manifest.version)) {
      return manifest.version;
    }
  } catch {
    /* no adjacent manifest; fall through to the path itself */
  }
  return VERSION_PATTERN.exec(imagePath)?.[1] ?? null;
};

export const defaultExecutingImageInspector: ExecutingImageInspector = {
  resolve(pid) {
    const imagePath = resolveExecutingImagePath(pid);
    if (!imagePath) return null;
    const version = versionFromImagePath(imagePath);
    return version ? { imagePath, version } : null;
  },
};

// ---------------------------------------------------------------------------
// Transcript — the on-disk record of the conversational actor's history, checked, not assumed.
// ---------------------------------------------------------------------------

export interface TranscriptEvidence {
  path: string;
  sizeBytes: number;
}

export interface TranscriptReader {
  locate(sessionUuid: string): TranscriptEvidence | null;
}

export const defaultTranscriptRoot = (): string => join(homedir(), ".claude", "projects");

/**
 * Searches every project directory under the transcript root for `<sessionUuid>.jsonl`. The root
 * is a constructor parameter everywhere this is used precisely so a test never has to write into
 * a real `~/.claude`.
 */
export const makeDefaultTranscriptReader = (root: string = defaultTranscriptRoot()): TranscriptReader => ({
  locate(sessionUuid) {
    if (!existsSync(root)) return null;
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return null;
    }
    for (const dir of entries) {
      const candidate = join(root, dir, `${sessionUuid}.jsonl`);
      try {
        const stats = statSync(candidate);
        if (stats.isFile()) return { path: candidate, sizeBytes: stats.size };
      } catch {
        continue;
      }
    }
    return null;
  },
});

export const defaultTranscriptReader: TranscriptReader = makeDefaultTranscriptReader();

// ---------------------------------------------------------------------------
// The claim primitive.
// ---------------------------------------------------------------------------

export interface CanonicalSelfClaimConfig {
  /** Overridable only for tests; production has exactly one canonical session. */
  canonicalSessionUuid?: string;
  /** Overridable only for tests; production requires exactly `REQUIRED_EXECUTOR_VERSION`. */
  requiredExecutorVersion?: string;
  /** Overridable only for tests; production has exactly one canonical project channel. */
  canonicalBuzzChannelId?: string;
  /** The one working directory the canonical CTO's claude process may run from. */
  expectedCwd: string;
  /**
   * The peer protocol version this deployment's transport already authenticated the connection
   * as speaking. Established outside this module (daemon/MCP transport, out of scope here) —
   * this is the expectation side of the comparison, never the caller's own claim about itself.
   */
  expectedPeerProtocolVersion: string;
  /** The connected peer identity the deployment's transport already authenticated. */
  expectedPeerIdentity: string;
}

export interface CanonicalSelfClaimRequest {
  /** pid of the process making this claim call — the walk starts here, not at the claude pid. */
  callerPid: number;
  /** Checked against the independently derived UUID; never substituted for it. */
  claimedSessionUuid: string;
  /** Checked against the derived ancestor pid, when supplied. */
  claimedPid?: number;
  projectId: string;
  /**
   * Real owner authority, not a caller-typed string (correction 4). This is evidence from an
   * admitted ingress envelope — `OwnerAuthority.assertApproval`'s own contract — never a tuple
   * this call can fabricate. `claim()` also requires `operation === SELF_CLAIM_OPERATION` and
   * `parameterDigest === canonicalSelfClaimParameterDigest({ projectId, claimedSessionUuid,
   * expectedBindingGeneration })`, so a real approval minted for a *different* claim (wrong
   * project, session, role or generation) is rejected before it is ever presented for
   * consumption. It is consumed exactly once, inside the same transaction as the mutation it
   * authorises — a denied mutation leaves it unconsumed and reusable; a committed one burns it.
   */
  ownerApproval: OwnerApprovalReceipt;
  /**
   * The binding generation this claim expects to create. Checked against the actual next
   * generation for `PRIMARY_CTO:<projectId>` inside the transaction; a mismatch means the role's
   * assignment history moved after the owner approved this exact attempt, and denies rather than
   * silently approving a different generation than the owner actually saw.
   */
  expectedBindingGeneration: number;
  /** Reported by the (out-of-scope) transport/caller; compared to the config's expectation. */
  cwd: string;
  peerProtocolVersion: string;
  peerIdentity: string;
  buzzChannelId: string;
  /** The Buzz channel identity this session will authenticate as, bound via `bindBuzzActor`. */
  buzzActorId: string;
  /** Passed to `resolveBuzzAddress` to open the routing channel before the transaction opens. */
  buzzPurpose: string;
}

export interface CanonicalSelfClaimReceipt {
  sessionId: string;
  sessionSecret: string | null;
  binding: RoleBinding;
  derivedSessionUuid: string;
  executorImageVersion: string;
  executorImagePath: string;
  buzzAddress: string;
}

export interface CanonicalSelfClaimDeps {
  processInspector?: ProcessAncestryInspector;
  imageInspector?: ExecutingImageInspector;
  transcriptReader?: TranscriptReader;
  maxAncestryHops?: number;
}

/**
 * The claim primitive (#760). Composes `SessionRegistry.create` and `BindingRegistry.bind` —
 * it mints no writer of its own for any of the five tables the mutation touches (sessions,
 * conversational_actors, assignments, actor_target_bindings, actor_target_attestations).
 *
 * `ConversationalActorRegistry.register` is deliberately not composed here: it requires an
 * already-existing, already-unregistered actor row and advances a *different* generation
 * (`conversational_actor_registry_state`) over two additional tables
 * (`conversational_actor_registrations` and that state row). The packet's own accounting names
 * exactly five tables and five things this mutation creates; calling `register` as well would
 * make it seven and a second, unrelated CAS. Active-set registration is left as a distinct,
 * later concern for whatever composes this primitive into the daemon.
 */
export class CanonicalSelfClaim {
  readonly #processInspector: ProcessAncestryInspector;
  readonly #imageInspector: ExecutingImageInspector;
  readonly #transcriptReader: TranscriptReader;
  readonly #maxAncestryHops: number;
  readonly #canonicalSessionUuid: string;
  readonly #requiredExecutorVersion: string;
  readonly #canonicalBuzzChannelId: string;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    /** The canonical owner-authenticated directive/turn mechanism — never a caller-typed string. */
    private readonly ownerAuthority: OwnerAuthorityPort,
    /** Authenticates `buzzActorId` for `SessionRegistry.bindBuzzActor` (deployment ingress policy). */
    private readonly buzzActorAuthenticator: BuzzActorAuthenticator,
    /**
     * Opens the Buzz routing channel and returns its address. Async and shells a CLI transport
     * (`BuzzAdapter.connect` → `BuzzTransport.openChannel`), so it must run — and does, in
     * `claim()` — *before* the synchronous transaction opens; `Db.txDecision`'s body cannot await.
     */
    private readonly resolveBuzzAddress: (purpose: string) => Promise<Decision<string>>,
    private readonly config: CanonicalSelfClaimConfig,
    deps: CanonicalSelfClaimDeps = {},
  ) {
    this.#processInspector = deps.processInspector ?? defaultProcessAncestryInspector;
    this.#imageInspector = deps.imageInspector ?? defaultExecutingImageInspector;
    this.#transcriptReader = deps.transcriptReader ?? defaultTranscriptReader;
    this.#maxAncestryHops = deps.maxAncestryHops ?? MAX_ANCESTRY_HOPS;
    this.#canonicalSessionUuid = config.canonicalSessionUuid ?? CANONICAL_SESSION_UUID;
    this.#requiredExecutorVersion = config.requiredExecutorVersion ?? REQUIRED_EXECUTOR_VERSION;
    this.#canonicalBuzzChannelId = config.canonicalBuzzChannelId ?? CANONICAL_PROJECT_BUZZ_CHANNEL_ID;
  }

  async claim(request: CanonicalSelfClaimRequest): Promise<Decision<CanonicalSelfClaimReceipt>> {
    if (!UUID_PATTERN.test(request.claimedSessionUuid)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "claimedSessionUuid must be a UUID", {});
    }
    if (request.projectId.trim().length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "projectId is required", {});
    }
    if (!Number.isSafeInteger(request.expectedBindingGeneration) || request.expectedBindingGeneration <= 0) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "expectedBindingGeneration must be a positive safe integer",
        { expectedBindingGeneration: request.expectedBindingGeneration },
      );
    }
    if (request.buzzActorId.trim().length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "buzzActorId is required", {});
    }

    // Correction 4 — an owner directive is real owner authority, bound to the exact operation,
    // project, claimant session and generation this attempt names — never a caller-typed string.
    // Checked here, before derivation even runs, so a fabricated or mis-scoped approval is refused
    // for that reason specifically rather than folded into a later, less exact denial.
    if (request.ownerApproval.operation !== SELF_CLAIM_OPERATION) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval names a different operation",
        { observed: request.ownerApproval.operation, expected: SELF_CLAIM_OPERATION },
      );
    }
    if (request.ownerApproval.runId !== null || request.ownerApproval.candidateSnapshotDigest !== null) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval for a canonical self-claim must not bind a run or candidate",
        {},
      );
    }
    const expectedParameterDigest = canonicalSelfClaimParameterDigest({
      projectId: request.projectId,
      claimedSessionUuid: request.claimedSessionUuid,
      expectedBindingGeneration: request.expectedBindingGeneration,
    });
    if (request.ownerApproval.parameterDigest !== expectedParameterDigest) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval does not bind the exact project, claimant session and generation of this attempt",
        { observed: request.ownerApproval.parameterDigest, expected: expectedParameterDigest },
      );
    }
    // A currently-admitted approval, checked before derivation runs any process/filesystem I/O.
    // The atomic, consume-exactly-once check happens again inside `#mutate` — this is the fail-fast
    // half, not a substitute for it: `assertApproval` alone cannot see a concurrent consumption.
    const admitted = this.ownerAuthority.assertApproval(request.ownerApproval);
    if (!admitted.allowed) return admitted as Decision<CanonicalSelfClaimReceipt>;

    // Clause 1 — derive independently before anything the caller said is ever consulted.
    const derived = deriveClaimantIdentity(request.callerPid, this.#processInspector, this.#maxAncestryHops);
    if (!derived.allowed) return derived as Decision<CanonicalSelfClaimReceipt>;
    const identity = derived.value;

    // Clause 1 — a caller-supplied UUID/PID is checked against the derived value, never substituted.
    if (identity.sessionUuid !== request.claimedSessionUuid.toLowerCase()) {
      return deny(
        ReasonCode.CONFLICT,
        "claimed session UUID does not match the independently derived identity",
        { claimed: request.claimedSessionUuid, derived: identity.sessionUuid },
      );
    }
    if (request.claimedPid !== undefined && request.claimedPid !== identity.pid) {
      return deny(
        ReasonCode.CONFLICT,
        "claimed pid does not match the derived claude ancestor process",
        { claimed: request.claimedPid, derived: identity.pid },
      );
    }

    // Clause 2 — pid and process start time as a pair; a pid alone is reused (CP-HI-04).
    if (identity.startedAt === null) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor's process start time could not be established",
        { pid: identity.pid },
      );
    }
    // Clause 2 — the process is an interactive CLI.
    if (!isInteractiveClaudeInvocation(identity.command)) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor is not an interactive CLI invocation",
        { pid: identity.pid },
      );
    }
    // Clause 2 — cwd.
    if (identity.cwd === null || identity.cwd !== this.config.expectedCwd) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor's working directory does not match the expected canonical workdir",
        { observed: identity.cwd, expected: this.config.expectedCwd },
      );
    }
    // Clause 2 — peer protocol.
    if (request.peerProtocolVersion !== this.config.expectedPeerProtocolVersion) {
      return deny(
        ReasonCode.CONFLICT,
        "peer protocol version does not match the deployment's expected protocol",
        { observed: request.peerProtocolVersion, expected: this.config.expectedPeerProtocolVersion },
      );
    }
    // Clause 2 — target version exactly REQUIRED_EXECUTOR_VERSION, from the executing image.
    const image = this.#imageInspector.resolve(identity.pid);
    if (!image) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor's executing image could not be resolved",
        { pid: identity.pid },
      );
    }
    if (image.version !== this.#requiredExecutorVersion) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor's executing image is not the required version",
        {
          observedVersion: image.version,
          requiredVersion: this.#requiredExecutorVersion,
          imagePath: image.imagePath,
        },
      );
    }
    // Clause 2 — the transcript.
    const transcript = this.#transcriptReader.locate(identity.sessionUuid);
    if (!transcript) {
      return deny(
        ReasonCode.NOT_FOUND,
        "no transcript exists on disk for the derived conversational actor",
        { sessionUuid: identity.sessionUuid },
      );
    }
    // Clause 2 — the connected peer identity.
    if (request.peerIdentity !== this.config.expectedPeerIdentity) {
      return deny(
        ReasonCode.CONFLICT,
        "connected peer identity does not match the deployment's expected peer",
        { observed: request.peerIdentity, expected: this.config.expectedPeerIdentity },
      );
    }
    // The channel check the daemon's continuity failover needed and never had (PROBE_FAILED):
    // a real comparison against the one channel this deployment names, not a decorative pass-through.
    if (request.buzzChannelId !== this.#canonicalBuzzChannelId) {
      return deny(
        ReasonCode.CONFLICT,
        "buzz channel is not the canonical project channel",
        { observed: request.buzzChannelId, expected: this.#canonicalBuzzChannelId },
      );
    }
    // Clause 4 — same-session restore only. No fallback bootstraps a new session or actor here.
    if (identity.sessionUuid !== this.#canonicalSessionUuid) {
      return deny(
        ReasonCode.CONFLICT,
        "only the canonical session may be adopted by this primitive",
        { observed: identity.sessionUuid, canonical: this.#canonicalSessionUuid },
      );
    }

    // Correction 5 — the Buzz routing address is resolved here, before the synchronous
    // transaction opens, never awaited inside it. `sessions.create` accepts `buzzAddress`
    // directly, so the resolved value is written in the same transaction as everything else even
    // though resolving it could not run inside that transaction.
    const buzzAddress = await this.resolveBuzzAddress(request.buzzPurpose);
    if (!buzzAddress.allowed) return buzzAddress as Decision<CanonicalSelfClaimReceipt>;

    // Clause 3 — one atomic mutation, or none. Every identity and authority check above is over;
    // nothing past this point may refuse for a reason this transaction cannot also undo.
    return this.#mutate(request, identity, image, transcript, buzzAddress.value);
  }

  #mutate(
    request: CanonicalSelfClaimRequest,
    identity: DerivedClaimantIdentity,
    image: ExecutingImageEvidence,
    transcript: TranscriptEvidence,
    buzzAddress: string,
  ): Decision<CanonicalSelfClaimReceipt> {
    // `db.txDecision` — not `db.tx` — is load-bearing here. `tx()` treats a denied `Decision` as
    // an ordinary return value and commits it; a nested `bindings.bind()` denial (BindingRegistry
    // uses `txDecision` itself, which at depth > 0 just hands the Decision back as data rather
    // than throwing) would otherwise be committed together with the session row already written
    // below. Only the outermost `txDecision` turns a propagated denial into a real ROLLBACK.
    return this.db.txDecision((): Decision<CanonicalSelfClaimReceipt> => {
      // Correction 4's generation half: the owner approved this exact next generation for this
      // exact role key. Checked before any write — including before the owner approval is
      // consumed — so a stale expectation denies with nothing to roll back yet.
      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: request.projectId });
      const currentMax = this.db.get<{ maximum: number | null }>(
        `SELECT MAX(binding_generation) AS maximum FROM assignments WHERE role_key = ?`,
        [roleKey],
      )?.maximum ?? 0;
      const nextGeneration = currentMax + 1;
      if (nextGeneration !== request.expectedBindingGeneration) {
        return deny(
          ReasonCode.CONFLICT,
          "expected binding generation does not match the next generation for this role",
          { roleKey, expected: request.expectedBindingGeneration, actual: nextGeneration },
        );
      }

      // Correction 4 — consumed exactly once, inside this transaction. A denial anywhere below
      // rolls this consumption back too, so a refused claim leaves the approval reusable; only a
      // committed one burns it. `OwnerAuthority.consumeApproval` itself denies a replay or a
      // presentation against a different candidate — both re-checked here for a non-run operation.
      const consumed = this.ownerAuthority.consumeApproval(request.ownerApproval, null);
      if (!consumed.allowed) return consumed as Decision<CanonicalSelfClaimReceipt>;

      const created = this.sessions.create({
        provider: "claude",
        model: "claude-cli",
        workdir: identity.cwd,
        osPid: identity.pid,
        buzzAddress,
      });
      // `bind()` requires a READY session (SESSION_NOT_READY otherwise); `create()` always starts
      // a session in STARTING. This transition sits inside the same transaction, so a legality
      // failure here rolls back the session insert too, exactly like every other denial in `#mutate`.
      const ready = this.sessions.transition(created.sessionId, SessionLifecycle.READY, "canonical self-claim");
      if (!ready.allowed) return ready as Decision<CanonicalSelfClaimReceipt>;

      // Correction 5 — the routable half: this session also authenticates as a Buzz channel
      // identity, inside the same transaction, or none of it lands. `bindBuzzActor` requires the
      // session secret `create()` just minted (proving the caller *is* this session) plus the
      // deployment's own ingress authenticator (proving the actor id is one it recognizes) —
      // never an identity tuple taken on its own word.
      if (created.sessionSecret === null) {
        return deny(
          ReasonCode.SESSION_SECRET_STORAGE_UNAVAILABLE,
          "session secret storage is unavailable; a routable claim requires one",
          { sessionId: created.sessionId },
        );
      }
      const boundBuzzActor = this.sessions.bindBuzzActor(
        { sessionId: created.sessionId, sessionSecret: created.sessionSecret, buzzActorId: request.buzzActorId },
        this.buzzActorAuthenticator,
      );
      if (!boundBuzzActor.allowed) return boundBuzzActor as Decision<CanonicalSelfClaimReceipt>;

      const targetLocator = identity.sessionUuid;
      const claimed: VerifiedTargetBinding = {
        executorKind: SELF_CLAIM_EXECUTOR_KIND,
        targetLocator,
        targetLocatorDigest: sha256(targetLocator),
      };
      const attestationDigest = digestOf({
        domain: "acp.canonical-self-claim",
        sessionUuid: identity.sessionUuid,
        pid: identity.pid,
        startedAt: identity.startedAt,
        cwd: identity.cwd,
        executorImagePath: image.imagePath,
        executorVersion: image.version,
        transcriptPath: transcript.path,
        transcriptSizeBytes: transcript.sizeBytes,
        peerProtocolVersion: request.peerProtocolVersion,
        peerIdentity: request.peerIdentity,
        buzzChannelId: request.buzzChannelId,
        buzzActorId: request.buzzActorId,
        buzzAddress,
        ownerApprovalDigest: digestOf(request.ownerApproval),
        expectedBindingGeneration: request.expectedBindingGeneration,
      });
      const authenticatedTarget: AuthenticatedTargetBinding = {
        claimed,
        protocolVersion: SELF_CLAIM_PROTOCOL,
        attestationDigest,
        // There is no external executor RPC to ask here (unlike `hermes.target-bind`): the
        // identity checks above *are* the authentication. This callback's job is structural —
        // confirming the planned tuple names the same locator this call already independently
        // derived — not re-deriving proof a second time.
        verify: () => claimed,
      };

      const bound = this.bindings.bind({
        role: Role.PRIMARY_CTO,
        projectId: request.projectId,
        sessionId: created.sessionId,
        mode: "PREFERRED",
        authenticatedTarget,
      });
      if (!bound.allowed) return bound as Decision<CanonicalSelfClaimReceipt>;

      return allow(ReasonCode.OK, {
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        binding: bound.value,
        derivedSessionUuid: identity.sessionUuid,
        executorImageVersion: image.version,
        executorImagePath: image.imagePath,
        buzzAddress,
      });
    });
  }
}
