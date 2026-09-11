import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { readProcessArgv, readProcessStartToken } from "../core/process-argv.ts";
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
// Deployment identity (#760). The one session UUID, the required executor version, and
// the canonical Buzz channel are deployment-private facts, not source constants. They are
// required fields on `CanonicalSelfClaimConfig` (below), sourced by the composition root
// (`src/daemon/agentcpd.ts`) from required environment variables with no fallback to a real
// value; a missing one fails construction closed, before any effect. The executing image's
// version must still be read from the actual resolved artifact at check time, never from a
// symlink or a fresh `claude --version` invocation resolved through PATH — see
// `resolveExecutingImagePath`/`versionFromImagePath` below.
// ---------------------------------------------------------------------------

/**
 * `actor_target_bindings.executor_kind` is a closed vocabulary; the schema seeds `'hermes'`
 * (src/db/schema.sql), and `src/db/migrations.ts`'s `v37-seed-claude-cli-executor-kind` seeds this
 * value the same way — a migration, not this module, writes it. Reusing `'hermes'` for a Claude
 * CLI target would mislabel every row a reader later queries by executor kind, which is why this
 * is its own value rather than a reused one.
 */
export const SELF_CLAIM_EXECUTOR_KIND = "claude-cli";

/** This primitive's own attestation protocol; deliberately distinct from `hermes.target-bind/v1`. */
export const SELF_CLAIM_PROTOCOL = "acp.canonical-self-claim/v1";

/**
 * The operation name a claim's `OwnerApprovalReceipt` must carry, and the domain tag of the
 * digest that binds it to one exact project, claimant session, role and generation:
 * `OwnerApprovalReceipt.parameterDigest` is a generic field `OwnerAuthority` never interprets —
 * binding it to *these* parameters is this module's job, not the ledger's.
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
const RECOGNIZED_SESSION_SELECTORS = new Set(["--session-id", "--resume"]);
/** Flags that mean the invocation is a headless, non-interactive query (§ probeSession usage). */
const HEADLESS_CLAUDE_FLAGS = new Set(["-p", "--print", "--output-format", "--input-format"]);

// ---------------------------------------------------------------------------
// Process ancestry — real OS state, never a caller's word.
// ---------------------------------------------------------------------------

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  /**
   * The full command line as `ps -o command=` reports it (never the truncated `comm` field).
   * Diagnostic only: `ps` renders argv as one whitespace-joined string and cannot preserve the
   * boundary between a real argv element and text that merely sits inside one quoted positional
   * argument, so nothing here treats this as the authority for identity or session selection —
   * see `argv` for that.
   */
  command: string;
  /**
   * The working directory this snapshot actually observed, or `null` when it observed none.
   *
   * `null` is never an observation of a different directory. It means the probe produced no
   * answer — see `cwdProbeFailure` for whether the probe ran at all. Reading `null` as a value
   * that failed to match is exactly what left the canonical PRIMARY_CTO role unclaimable while
   * its working directory was correct (#834).
   */
  cwd: string | null;
  /**
   * Non-null when the probe that would have read `cwd` could not run — it timed out, or lsof was
   * not reachable. `null` covers both the ordinary case (the probe ran) and the case where it ran
   * and reported no `cwd` descriptor; neither of those is a failure of the probe itself.
   *
   * Required rather than optional on purpose. An inspector that does not state this has not
   * stated that the probe succeeded, and a missing field would silently read as "it did".
   */
  cwdProbeFailure: LsofProbeFailure | null;
  /**
   * An opaque, native-resolution process-start token (`../core/process-argv.ts`'s
   * `readProcessStartToken`) — never `ps -o lstart=`'s whole-second rendered text, which a
   * same-second pid-reuse race can make indistinguishable between two different processes. `null`
   * means unverifiable; every caller treats that as fail-closed.
   */
  startedAt: string | null;
  /**
   * The real, kernel-supplied argv vector — each element exactly as the process's own `execve`
   * received it, never reconstructed from rendered text. `null` means unavailable: no reachable
   * interface exists on this platform (see `../core/process-argv.ts`'s `readProcessArgv`), the
   * process is gone, or the read otherwise failed. Every caller treats `null` as a fail-closed
   * signal, not a reason to fall back to `command`.
   */
  argv: readonly string[] | null;
}

export interface ProcessAncestryInspector {
  snapshot(pid: number): ProcessSnapshot | null;
}

interface LsofEntry {
  fd: string;
  type: string;
  name: string;
  /** Hex device number (lsof's `D` field, e.g. `"0x1000011"`), or `null` if lsof did not report one. */
  device: string | null;
  /** Decimal inode number (lsof's `i` field), or `null` if lsof did not report one. */
  inode: string | null;
}

/**
 * Why an `lsof` scan produced nothing, when it produced nothing because it never ran to completion.
 *
 * This type exists so that "the probe failed" cannot be spelled the same way as "the probe ran and
 * the answer was empty". Both used to be `[]`, and every consumer below read `[]` as a definite
 * negative about the process — which is how a claim whose working directory was exactly right came
 * to be refused for a working directory that did not match (#834).
 */
export interface LsofProbeFailure {
  /** The process the scan was about — the claimant, not this daemon. */
  pid: number;
  /** The budget the scan was given, in milliseconds; `TIMED_OUT` means it outlived this. */
  timeoutMs: number;
  /**
   * `TIMED_OUT` when the scan outlived `timeoutMs` and was killed — the #834 signature, measured
   * at 30.07s against a 5_000ms budget. `SCAN_FAILED` for everything else: lsof not on the PATH
   * this process was launched with (the recurring #423/#785/`deploy/install-launchd.sh` shape),
   * a non-zero exit, or a spawn that failed outright.
   */
  kind: "TIMED_OUT" | "SCAN_FAILED";
  /** The OS error code when there was one (`ENOENT` when lsof is not on the PATH), else `null`. */
  errorCode: string | null;
  /** lsof's own exit status when it ran and exited non-zero, else `null`. */
  exitStatus: number | null;
}

/** The outcome of one scan: entries that were genuinely read, or the reason none were. */
type LsofScan =
  | { ok: true; entries: LsofEntry[] }
  | { ok: false; failure: LsofProbeFailure };

/**
 * The exact argv `lsofEntries` passes. Exported so a test can pin the flags rather than the
 * timing of a scan, which is what a later edit would otherwise quietly drop.
 *
 * `-n` and `-P` suppress name resolution — `-n` for hostnames, `-P` for service port names — and
 * neither changes a single byte this module reads. The field selector is `f p t D i n`: fd, pid,
 * type, device, inode, and lsof's *name* field. The two entries anything here consults are the
 * `cwd` DIR entry and the `txt` REG entry, and for both of those the name field is a filesystem
 * path, which `-n` and `-P` do not touch at all. What they suppress is the name rendering of
 * network entries — the IPv4/IPv6 sockets this module never looks at.
 *
 * Their absence is what took the canonical PRIMARY_CTO role off production (#834). Without `-n`,
 * lsof does a reverse-DNS lookup for every network descriptor the claimant holds before it prints
 * anything at all, because the output is one stream: measured against the live canonical claude
 * process (53 descriptors, 7 of them IPv4), `lsof -p <pid> -FfptDin` took 30.07s / 30.08s / 30.08s
 * over three runs, and `lsof -n -p <pid> -FfptDin` took 0.05s — 600x. `SUBPROCESS_TIMEOUT_MS` is
 * 5_000, so the scan was killed every time and the claim never saw the cwd that was sitting three
 * descriptors away.
 */
export const lsofScanArgv = (pid: number): string[] => ["-n", "-P", "-p", String(pid), "-FfptDin"];

/**
 * Parses `lsof -n -P -p <pid> -FfptDin`'s field-per-line output into (fd, type, name, device,
 * inode) tuples, or reports why it could not.
 *
 * This one call is what the default cwd and executing-image lookups below are both built on.
 * `comm=` truncates a resolved path once it exceeds `ps`'s short-name column width, so this reads
 * lsof's own name field instead of any `ps` short-name column. Device and inode are requested
 * alongside the path in the same scan — deriving them from a second, separate `lsof` call would
 * let a path swapped in between the two calls go uncaught.
 *
 * A scan that could not run returns `{ ok: false }`, never an empty entry list. The two are
 * different facts and the callers below act on them differently; folding them together is the
 * defect this signature exists to make unspellable.
 */
const lsofEntries = (pid: number): LsofScan => {
  let out: string;
  try {
    out = execFileSync("lsof", lsofScanArgv(pid), {
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `execFileSync` sets `killed` when it is the timeout that ended the child, which is the one
    // case whose repair is "the scan needs to be cheaper or the budget bigger" rather than "lsof
    // is not reachable". Distinguishing them here is what puts the right next step in the
    // operator's hands; a single "scan failed" would send both diagnoses the same way.
    const failed = error as { killed?: boolean; code?: unknown; status?: unknown };
    return {
      ok: false,
      failure: {
        pid,
        timeoutMs: SUBPROCESS_TIMEOUT_MS,
        kind: failed.killed === true ? "TIMED_OUT" : "SCAN_FAILED",
        errorCode: typeof failed.code === "string" ? failed.code : null,
        exitStatus: typeof failed.status === "number" ? failed.status : null,
      },
    };
  }
  const entries: LsofEntry[] = [];
  let fd = "";
  let type = "";
  let device: string | null = null;
  let inode: string | null = null;
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0]!;
    const value = line.slice(1);
    if (tag === "f") { fd = value; type = ""; device = null; inode = null; continue; }
    if (tag === "t") { type = value; continue; }
    if (tag === "D") { device = value; continue; }
    if (tag === "i") { inode = value; continue; }
    if (tag === "n") entries.push({ fd, type, name: value, device, inode });
  }
  return { ok: true, entries };
};

const psField = (pid: number, field: string): string | null => {
  try {
    // `-ww` disables ps's output-width truncation (default width tracks the controlling
    // terminal, or a platform default with none): without it, a `command` long enough to carry
    // a real invocation's flags is silently cut short.
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
 *
 * Returns the two facts separately, because they answer different questions. `cwd` is a directory
 * this function actually observed. `probeFailure` is non-null only when the scan that would have
 * read it could not run at all, and it is the evidence the refusal needs in order to say so. A
 * `cwd` of `null` with a `null` `probeFailure` is the third state — the scan ran and reported no
 * `cwd` descriptor — and it is still not an observation of a *different* directory. No caller may
 * read a `null` `cwd` as a mismatch, whichever of the two produced it.
 */
const resolveProcessCwd = (pid: number): { cwd: string | null; probeFailure: LsofProbeFailure | null } => {
  try {
    return { cwd: realpathSync(`/proc/${pid}/cwd`), probeFailure: null };
  } catch {
    /* not Linux, or the process is gone; fall through to lsof */
  }
  const scan = lsofEntries(pid);
  if (!scan.ok) return { cwd: null, probeFailure: scan.failure };
  return {
    cwd: scan.entries.find((entry) => entry.fd === "cwd" && entry.type === "DIR")?.name ?? null,
    probeFailure: null,
  };
};

export const defaultProcessAncestryInspector: ProcessAncestryInspector = {
  snapshot(pid) {
    const ppidRaw = psField(pid, "ppid");
    const command = psField(pid, "command");
    if (ppidRaw === null || command === null) return null;
    const ppid = Number.parseInt(ppidRaw, 10);
    if (!Number.isSafeInteger(ppid)) return null;
    const workdir = resolveProcessCwd(pid);
    return {
      pid,
      ppid,
      command,
      cwd: workdir.cwd,
      cwdProbeFailure: workdir.probeFailure,
      startedAt: readProcessStartToken(pid),
      argv: readProcessArgv(pid),
    };
  },
};

/**
 * Matches `argv[0]`'s basename against `claude` — a directly executed compiled binary
 * (`/path/to/claude ...`) only. A real argv vector's first element is exactly the exec'd path (or
 * the name a caller's `execvp` search resolved), never a `ps`-rendered approximation of it.
 *
 * Deliberately does **not** also match a second element whose basename is `claude` — an
 * interpreter-launched script, `node /path/to/claude ...`. Matching that shape breaks clause 2 in
 * both directions at once: the executing-image inspector below always authenticates the
 * kernel-loaded image, which for `node script` is `node` itself, never the script. A deployment
 * that pins the real Node binary's realpath/hash would admit *any* attacker-controlled script
 * merely named `claude` and launched through that same, legitimate interpreter — the
 * interpreter's own identity would be doing all the authenticating, and the script's identity
 * none of it. A deployment that instead pinned the script's own path could never be satisfied by
 * real interpreter execution, since the kernel-loaded image is still `node`. Requiring the first
 * element to itself be `claude` closes this: only a process whose own exec'd image is the
 * `claude` binary can ever be the claimant, so the image check that follows authenticates the
 * same file this check named.
 */
export const looksLikeClaudeInvocation = (argv: readonly string[]): boolean => {
  const [firstElement] = argv;
  return firstElement !== undefined && /(^|\/)claude$/.test(firstElement);
};

/**
 * The point past which argv holds only positional arguments, never flags — the POSIX `--`
 * end-of-options marker. A selector or a headless-interactivity flag occurring after it is text
 * the invocation is passing *through*, not a flag this process itself is parsing, so neither scan
 * below looks past the first `--` element.
 */
const argvBeforeOptionsBoundary = (argv: readonly string[]): readonly string[] => {
  const boundary = argv.indexOf("--");
  return boundary === -1 ? argv : argv.slice(0, boundary);
};

/**
 * The flag this codebase's own adapters already use to name an external Claude session
 * (`src/runtime/cli-adapters.ts` passes `--session-id <externalSessionId>`); `--resume` is
 * accepted too since interactive resumption commonly spells it that way.
 *
 * Operates on real argv elements, never rendered text: an argv element counts as a selector only
 * when it *is*, exactly, `--session-id` or `--resume`, or *starts with* `--session-id=` /
 * `--resume=` (the attached form). Selector-looking text sitting inside some other, unrelated
 * positional argv element — `"please use --session-id"` as one quoted argument — is not an argv
 * element that *is* a selector, so it is never counted; a real argv vector's element boundaries
 * make that distinction exact where rendered text cannot. The scan also stops at the first `--`
 * element: a selector-looking token after it is a positional argument being passed through, not a
 * flag this process is parsing.
 *
 * Exactly one selector occurrence must be present, and a selector that carries an empty or
 * malformed value still counts as an occurrence — `--session-id=` alone, or `--session-id` with
 * nothing following it, is a selector with no usable value, not an absent selector, so a second,
 * different selector elsewhere on the same argv still fails as a duplicate rather than winning by
 * default: counting occurrences happens before any value is judged valid. The one occurrence's
 * value (attached after `=`, or the immediately following argv element for the bare form) must
 * equal a UUID exactly.
 */
export const extractSessionUuidFromArgv = (argv: readonly string[]): string | null => {
  const scanRange = argvBeforeOptionsBoundary(argv);
  const occurrences: Array<{ index: number; attachedValue: string | null }> = [];
  for (let i = 0; i < scanRange.length; i += 1) {
    const element = scanRange[i]!;
    if (RECOGNIZED_SESSION_SELECTORS.has(element)) {
      occurrences.push({ index: i, attachedValue: null });
      continue;
    }
    for (const selector of RECOGNIZED_SESSION_SELECTORS) {
      if (element.startsWith(`${selector}=`)) {
        occurrences.push({ index: i, attachedValue: element.slice(selector.length + 1) });
        break;
      }
    }
  }
  // Zero occurrences, or more than one — whether the same flag twice, `--session-id` and
  // `--resume` disagreeing, or one empty/malformed selector alongside one otherwise-valid one —
  // are all refused rather than resolved by a tiebreak: only exactly one occurrence unambiguously
  // names the process's one real session.
  if (occurrences.length !== 1) return null;
  const occurrence = occurrences[0]!;
  const rawValue = occurrence.attachedValue ?? scanRange[occurrence.index + 1];
  if (rawValue === undefined || rawValue === "") return null;
  const candidate = rawValue.toLowerCase();
  // The value must equal a UUID exactly, never merely contain, prefix, or suffix one.
  return UUID_PATTERN.test(candidate) ? candidate : null;
};

/** A headless flag matches an argv element exactly, or the element's `${flag}=`-attached form. */
const isHeadlessToken = (token: string): boolean => {
  for (const flag of HEADLESS_CLAUDE_FLAGS) {
    if (token === flag || token.startsWith(`${flag}=`)) return true;
  }
  return false;
};

/**
 * Absence of a headless query flag, not presence of a TTY — no cross-process TTY probe exists.
 * Same argv-element and `--`-boundary discipline as `extractSessionUuidFromArgv`: a headless flag
 * is recognized in its bare form (its own argv element, e.g. `--output-format`) and its attached
 * form (`--output-format=json` as one element), and only before the first `--`.
 */
export const isInteractiveClaudeInvocation = (argv: readonly string[]): boolean =>
  !argvBeforeOptionsBoundary(argv).some(isHeadlessToken);

export interface DerivedClaimantIdentity {
  pid: number;
  ppid: number;
  startedAt: string | null;
  /** Observed, or `null` for "not observed" — never "observed to be something else". */
  cwd: string | null;
  /** Carried through from the snapshot so a refusal can say the probe failed, and how. */
  cwdProbeFailure: LsofProbeFailure | null;
  argv: readonly string[];
  sessionUuid: string;
}

/**
 * Clause 1 — identity is derived, never accepted. Walks the process ancestry from `callerPid` to
 * the nearest `claude` ancestor and reads the session UUID out of *that* ancestor's real argv
 * vector. A caller-supplied UUID or PID is never consulted here; `CanonicalSelfClaim.claim` checks
 * one against the value this returns, afterward, and refuses on any mismatch.
 *
 * Every hop's argv must be available for this walk to say anything about it: a hop whose argv
 * cannot be established is not silently treated as "not claude" and skipped — this deployment
 * cannot tell the difference between that and a real claude ancestor whose argv happened to be
 * unreadable, so it refuses rather than guess past it.
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
    if (snapshot.argv === null) {
      return deny(
        ReasonCode.NOT_FOUND,
        "process argv could not be established",
        { pid: snapshot.pid },
      );
    }
    if (looksLikeClaudeInvocation(snapshot.argv)) {
      const sessionUuid = extractSessionUuidFromArgv(snapshot.argv);
      if (!sessionUuid) {
        return deny(
          ReasonCode.NOT_FOUND,
          "the claude ancestor's argv names no session id",
          { pid: snapshot.pid },
        );
      }
      return allow(ReasonCode.OK, {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        startedAt: snapshot.startedAt,
        cwd: snapshot.cwd,
        cwdProbeFailure: snapshot.cwdProbeFailure,
        argv: snapshot.argv,
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
  /** `sha256:<hex>` of the resolved image's actual bytes — this module's own `sha256` helper. */
  sha256: string;
}

/**
 * The scan that would have named the executing image could not run. Distinguished from `null` for
 * the same reason `cwd` is (#834): `null` means the image was looked at and is not one this
 * deployment can accept, and this means nobody looked. The one-key shape is the discriminator —
 * `ExecutingImageEvidence` never carries `probeFailure`.
 */
export interface ExecutingImageProbeFailure {
  probeFailure: LsofProbeFailure;
}

export const isExecutingImageProbeFailure = (
  resolution: ExecutingImageEvidence | ExecutingImageProbeFailure | null,
): resolution is ExecutingImageProbeFailure => resolution !== null && "probeFailure" in resolution;

export interface ExecutingImageInspector {
  /**
   * The image, `null` when the scan ran and produced no usable image, or a probe failure when the
   * scan itself could not run. An implementation that cannot fail its probe may keep returning
   * only the first two — the union is wider than what it produces, not narrower.
   */
  resolve(pid: number): ExecutingImageEvidence | ExecutingImageProbeFailure | null;
}

/**
 * Reads the version out of the resolved image's own path rather than executing it or trusting a
 * file placed beside it. Invoking the resolved path with `--version` is deliberately avoided: a
 * self-reported string from a binary this check exists to not trust the caller's word about is
 * the same shape of evidence, one hop removed.
 *
 * An adjacent `package.json` is not used as version authority: it is a second file, independently
 * writable from the binary it sits beside, so it can be forged without touching the realpath or
 * the bytes clause 2 already authenticates — a version read that way proves nothing the other two
 * checks do not already have to hold for separately. The one thing that cannot be forged without
 * also changing the resolved path itself is the path's own `/versions/<version>` executable-file
 * layout, or the legacy `/versions/<version>/<binary>` layout — so that version segment, taken
 * verbatim, is the only version authority. It is compared for exact equality against
 * `CanonicalSelfClaimConfig.requiredExecutorVersion` afterward; nothing here re-validates its
 * shape, so a deployment's real version and a test's synthetic prerelease segment (e.g.
 * `9.0.0-test`) are read identically.
 */
const IMAGE_VERSION_FILE_PATTERN = /\/versions\/([^/]+)$/;
const IMAGE_VERSION_DIRECTORY_PATTERN = /\/versions\/([^/]+)\/[^/]+$/;

export const versionFromImagePath = (imagePath: string): string | null =>
  IMAGE_VERSION_FILE_PATTERN.exec(imagePath)?.[1]
  ?? IMAGE_VERSION_DIRECTORY_PATTERN.exec(imagePath)?.[1]
  ?? null;

/**
 * Hashes the bytes reached through an already-open file descriptor, then closes it. A version
 * string and a realpath both describe the file; neither is the file, and neither is the FD. A
 * renamed Node binary placed at a forged, expected-looking path with a forged adjacent manifest
 * would satisfy a realpath check and a version check alike — hashing bytes read through the exact
 * FD `openLinuxImageFd`/`openVerifiedDarwinImageFd` bound is the one comparison that requires the
 * actual invocation artifact to actually be the expected one, not merely labeled or path-matched
 * as it. Resolving a path and hashing a *later, separate* open of that same path string is not
 * this: a file swapped into place after the path resolves and before that second open runs would
 * authenticate bytes that were never the running image.
 */
const hashImageFd = (fd: number): string | null => {
  try {
    return sha256(readFileSync(fd));
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed, or never validly open */
    }
  }
};

/**
 * `/proc/<pid>/exe` is a magic symlink the kernel resolves to the live mapped image at `open()`
 * time itself, atomically — opening it directly is the read, with no separate path-resolution step
 * in between for a swap to land in. `realpathSync` on the same link is used only for the reported
 * `imagePath` label and `versionFromImagePath`, never for the bytes that get hashed.
 */
const openLinuxImageFd = (pid: number): number | null => {
  try {
    return openSync(`/proc/${pid}/exe`, "r");
  } catch {
    return null;
  }
};

/**
 * Darwin has no magic-symlink equivalent to open directly: `lsof`'s reported `txt` path is still
 * just a path, resolved at scan time. This opens that reported path, then verifies — via `fstat`,
 * in `bigint` mode (a real inode on this filesystem exceeds `Number.MAX_SAFE_INTEGER`; the default,
 * non-bigint stat silently rounds it, which would make two genuinely different inodes compare
 * equal) — that the opened file's device and inode match `lsof`'s own report from the *same* scan.
 * A path swapped in between the scan and the open changes what `fstat` sees without changing what
 * `lsof` already reported, so the mismatch is caught rather than silently hashed.
 */
const openVerifiedDarwinImageFd = (imagePath: string, entry: LsofEntry): number | null => {
  if (entry.device === null || entry.inode === null) return null;
  let reportedDevice: bigint;
  let reportedInode: bigint;
  try {
    reportedDevice = BigInt(entry.device);
    reportedInode = BigInt(entry.inode);
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = openSync(imagePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (stat.dev !== reportedDevice || stat.ino !== reportedInode) {
      closeSync(fd);
      return null;
    }
  } catch {
    closeSync(fd);
    return null;
  }
  return fd;
};

export const defaultExecutingImageInspector: ExecutingImageInspector = {
  resolve(pid) {
    if (platform() === "linux") {
      let imagePath: string;
      try {
        imagePath = realpathSync(`/proc/${pid}/exe`);
      } catch {
        return null;
      }
      const version = versionFromImagePath(imagePath);
      if (!version) return null;
      const fd = openLinuxImageFd(pid);
      if (fd === null) return null;
      const hash = hashImageFd(fd);
      if (!hash) return null;
      return { imagePath, version, sha256: hash };
    }
    // Darwin (and any other platform lsof can answer for): one lsof scan is the single source for
    // both the reported path and the device+inode `fstat` verifies the opened FD against — two
    // separate scans could each see a different reality if a path were swapped in between them.
    const scan = lsofEntries(pid);
    // The image resolution has exactly one channel on this platform, and a channel that did not
    // run says nothing about the image that would have come back through it. This is the same
    // `lsof` scan the cwd lookup uses and it fails the same two ways — a timeout, or an
    // unreachable lsof — so it is reported the same way rather than collapsed into `null`.
    if (!scan.ok) return { probeFailure: scan.failure };
    const entry = scan.entries.find((candidate) => candidate.fd === "txt" && candidate.type === "REG");
    if (!entry) return null;
    const imagePath = entry.name;
    const version = versionFromImagePath(imagePath);
    if (!version) return null;
    const fd = openVerifiedDarwinImageFd(imagePath, entry);
    if (fd === null) return null;
    const hash = hashImageFd(fd);
    if (!hash) return null;
    return { imagePath, version, sha256: hash };
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
  /**
   * The one session this deployment may adopt. Required — deployment-private configuration only,
   * sourced from the composition root's own environment. There is no default and no fallback: a
   * missing value is a construction-time failure, never a silent substitution for a real ID.
   */
  canonicalSessionUuid: string;
  /**
   * The exact executor version this deployment currently requires. Required — deployment-private
   * configuration only, same no-fallback rule as `canonicalSessionUuid`.
   */
  requiredExecutorVersion: string;
  /**
   * This deployment's one canonical project Buzz channel. Required — deployment-private
   * configuration only, same no-fallback rule as `canonicalSessionUuid`.
   */
  canonicalBuzzChannelId: string;
  /**
   * The daemon-owned expected realpath of the executor image, compared against the actual
   * resolved invocation artifact (`ExecutingImageEvidence.imagePath`, itself never a symlink —
   * see `resolveExecutingImagePath`). Required — a version string read from an adjacent,
   * spoofable `package.json` is not sufficient on its own: a renamed binary plus a forged
   * manifest would still read as the required version. Comparing the actual resolved path closes
   * that gap. No fallback to a real value.
   */
  expectedExecutorRealpath: string;
  /**
   * The daemon-owned expected sha256 of the executor image's actual bytes (`sha256:<hex>`, this
   * module's own `sha256` helper), compared against a hash computed from the resolved image at
   * check time. Required, same no-fallback rule. Realpath alone would still trust whatever bytes
   * happen to live at that path; hashing the bytes closes that second half of the gap — a renamed
   * Node binary with a forged adjacent manifest, placed at the expected path, still fails here.
   */
  expectedExecutorSha256: string;
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
   * Real owner authority, not a caller-typed string. This is evidence from an admitted ingress
   * envelope — `OwnerAuthority.assertApproval`'s own contract — never a tuple this call can
   * fabricate. `claim()` also requires `operation === SELF_CLAIM_OPERATION` and
   * `parameterDigest === canonicalSelfClaimParameterDigest({ projectId, claimedSessionUuid,
   * expectedBindingGeneration })`, so a real approval minted for a *different* claim (wrong
   * project, session, role or generation) is rejected before it is ever presented for
   * consumption.
   *
   * Consumed exactly once **per commit, not per presentation**: `OwnerAuthority.consumeApproval`
   * runs inside the same transaction as the mutation it authorises, so a denial anywhere in that
   * transaction — including one after consumption already ran — rolls the consumption back with
   * everything else. The same receipt is therefore genuinely reusable after a failed attempt and
   * remains valid until an attempt actually commits. This is deliberate, not an oversight:
   * refusing to let a caller retry after an unrelated failure (an unauthenticated Buzz channel
   * identity, a transient denial) with the *same* owner approval would make every such failure
   * also cost a fresh owner round-trip.
   */
  ownerApproval: OwnerApprovalReceipt;
  /**
   * The binding generation this claim expects to create. Checked against the actual next
   * generation for `PRIMARY_CTO:<projectId>` inside the transaction; a mismatch means the role's
   * assignment history moved after the owner approved this exact attempt, and denies rather than
   * silently approving a different generation than the owner actually saw.
   */
  expectedBindingGeneration: number;
  // No caller-supplied `cwd` field: the real check (clause 2) compares the *derived*
  // `identity.cwd` — read from the actual claude ancestor process — against
  // `config.expectedCwd`, the deployment's own authority. A caller-supplied cwd would be an
  // unused input at best (dead surface a later change could wire up by accident, a shape refused
  // everywhere else in this request) or a second, redundant identity claim at worst — never wired
  // to any check, so it is not a field on this type.
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
 * (`conversational_actor_registrations` and that state row). This mutation creates exactly five
 * rows across five tables; calling `register` as well would make it seven and add a second,
 * unrelated CAS. Active-set registration is left as a distinct, later concern for whatever
 * composes this primitive into the daemon.
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
    // Fail closed before any effect: these three are deployment-private configuration with no
    // fallback to a real value. A blank string (an absent env var coerced by a caller, or a typo
    // in the composition root) must construct nothing, never silently adopt a hardcoded default.
    for (const [field, value] of [
      ["canonicalSessionUuid", config.canonicalSessionUuid],
      ["requiredExecutorVersion", config.requiredExecutorVersion],
      ["canonicalBuzzChannelId", config.canonicalBuzzChannelId],
      ["expectedExecutorRealpath", config.expectedExecutorRealpath],
      ["expectedExecutorSha256", config.expectedExecutorSha256],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(
          `CanonicalSelfClaim: config.${field} is required deployment configuration and was missing or empty`,
        );
      }
    }
    if (!UUID_PATTERN.test(config.canonicalSessionUuid)) {
      throw new Error("CanonicalSelfClaim: config.canonicalSessionUuid must be a UUID");
    }

    this.#processInspector = deps.processInspector ?? defaultProcessAncestryInspector;
    this.#imageInspector = deps.imageInspector ?? defaultExecutingImageInspector;
    this.#transcriptReader = deps.transcriptReader ?? defaultTranscriptReader;
    this.#maxAncestryHops = deps.maxAncestryHops ?? MAX_ANCESTRY_HOPS;
    this.#canonicalSessionUuid = config.canonicalSessionUuid;
    this.#requiredExecutorVersion = config.requiredExecutorVersion;
    this.#canonicalBuzzChannelId = config.canonicalBuzzChannelId;
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

    // An owner directive is real owner authority, bound to the exact operation, project, claimant
    // session and generation this attempt names — never a caller-typed string. Checked here,
    // before derivation even runs, so a fabricated or mis-scoped approval is refused for that
    // reason specifically rather than folded into a later, less exact denial.
    if (request.ownerApproval.operation !== SELF_CLAIM_OPERATION) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval names a different operation",
        { observed: request.ownerApproval.operation, expected: SELF_CLAIM_OPERATION },
      );
    }
    // `approved` is a real boolean on an authenticated receipt, and `approved: false` is exactly
    // what an owner mints when they explicitly *refuse* an operation — a rejection is otherwise
    // structurally indistinguishable from an approval that happens to also bind the right
    // operation/project/session/generation, so this must be checked explicitly, matching
    // `src/doctor/repair.ts`'s owner-gated repair path (`receipt.approved !== true`).
    if (request.ownerApproval.approved !== true) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner approval receipt is not an approval",
        { approved: request.ownerApproval.approved },
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

    // Clause 4 — same-session restore only, checked immediately after the derived identity is
    // confirmed to match what the caller claimed, and before any of clause 2's environment checks
    // below. Ordering matters: the transcript check a few lines down is real filesystem I/O
    // against whatever session was actually derived, and a caller connected from a real,
    // otherwise-legitimate claude process that simply isn't the canonical session must not reach
    // that I/O and fail with NOT_FOUND ("no transcript exists") — a true but wrong-shaped refusal
    // for what this block exists to name. No fallback bootstraps a new session or actor here
    // regardless of when this runs; checking this first means a non-canonical session always fails
    // for the reason this check names, not for whichever unrelated check happens to run first
    // against a session this primitive was never going to adopt anyway.
    if (identity.sessionUuid !== this.#canonicalSessionUuid) {
      return deny(
        ReasonCode.CONFLICT,
        "only the canonical session may be adopted by this primitive",
        { observed: identity.sessionUuid, canonical: this.#canonicalSessionUuid },
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
    if (!isInteractiveClaudeInvocation(identity.argv)) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor is not an interactive CLI invocation",
        { pid: identity.pid },
      );
    }
    // Clause 2 — cwd. A probe that could not run is not a value that did not match (#834).
    //
    // These two refusals deny identically — nothing is admitted here that was refused before, and
    // nothing that was admitted is now refused. What changes is which fact the operator is told,
    // and that is the whole repair: the daemon's claim socket puts only the `reasonCode` on the
    // wire (`publicClaimResponse`, src/daemon/canonical-self-claim-listener.ts), so a probe
    // failure arriving as `CONFLICT` is indistinguishable from a genuinely wrong workdir, and it
    // sends the operator to check a directory that was already correct. It cost most of a day.
    //
    // `null` here covers both shapes of "not observed": the scan could not run (`cwdProbeFailure`
    // is non-null and names the timeout or the OS error), or it ran and reported no `cwd`
    // descriptor (`cwdProbeFailure` is null). Neither is an observation of a different directory,
    // so neither may be reported as one — the same distinction `CONTRACT_UNVERIFIED` draws for a
    // pinned contract that could not be produced to compare (#448).
    if (identity.cwd === null) {
      return deny(
        ReasonCode.PROBE_FAILED,
        "the claude ancestor's working directory could not be read, so this says nothing about whether it is the canonical workdir",
        { pid: identity.pid, probe: "lsof", probeFailure: identity.cwdProbeFailure },
      );
    }
    if (identity.cwd !== this.config.expectedCwd) {
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
    // Clause 2 — target version exactly the configured required executor version, from the
    // executing image.
    const image = this.#imageInspector.resolve(identity.pid);
    // The second consumer of the same scan, and the same distinction (#834). On Darwin the
    // executing image is reached only through `lsof`, so an lsof that times out or is missing
    // from the daemon's PATH resolves every image to nothing — which used to refuse a genuine
    // claim as `CONFLICT`, the exact wrong-direction diagnosis the PATH row in
    // `scripts/falsifiability-cases/` already names as this deployment's recurring shape.
    if (isExecutingImageProbeFailure(image)) {
      return deny(
        ReasonCode.PROBE_FAILED,
        "the claude ancestor's executing image could not be scanned, so this says nothing about which image it is",
        { pid: identity.pid, probe: "lsof", probeFailure: image.probeFailure },
      );
    }
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
    // Clause 2 — the executing image is the exact expected artifact, not merely a file that
    // reports the expected version. A version string (and even the resolved path alone) can be
    // spoofed by a renamed binary with a forged adjacent manifest placed at the expected
    // location; comparing both the realpath and a hash of the actual bytes closes that gap.
    if (image.imagePath !== this.config.expectedExecutorRealpath) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor's executing image is not at the expected realpath",
        { observed: image.imagePath, expected: this.config.expectedExecutorRealpath },
      );
    }
    if (image.sha256 !== this.config.expectedExecutorSha256) {
      return deny(
        ReasonCode.CONFLICT,
        "the claude ancestor's executing image does not hash to the expected sha256",
        { observed: image.sha256, expected: this.config.expectedExecutorSha256, imagePath: image.imagePath },
      );
    }
    // Clause 2 — pid/startedAt re-verified immediately after the image check. Both the ancestry
    // walk and this image resolution did real, non-instantaneous I/O; a pid reused in between
    // must be caught here, before the transcript check or the async Buzz boundary below run
    // anything else against `identity.pid` as though it still names the verified process.
    const stillLiveAfterImage = this.#assertClaimantStillLive(identity);
    if (!stillLiveAfterImage.allowed) return stillLiveAfterImage as Decision<CanonicalSelfClaimReceipt>;
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
    // A real comparison against the one channel this deployment names, never a decorative
    // pass-through.
    if (request.buzzChannelId !== this.#canonicalBuzzChannelId) {
      return deny(
        ReasonCode.CONFLICT,
        "buzz channel is not the canonical project channel",
        { observed: request.buzzChannelId, expected: this.#canonicalBuzzChannelId },
      );
    }
    // The Buzz routing address is resolved here, before the synchronous transaction opens, never
    // awaited inside it. `sessions.create` accepts `buzzAddress` directly, so the resolved value
    // is written in the same transaction as everything else even though resolving it could not
    // run inside that transaction.
    const buzzAddress = await this.resolveBuzzAddress(request.buzzPurpose);
    if (!buzzAddress.allowed) return buzzAddress as Decision<CanonicalSelfClaimReceipt>;
    // Clause 2 — pid/startedAt re-verified again here. This `await` is the real TOCTOU window:
    // control left this process entirely (a shelled Buzz CLI transport), for however long that
    // took, before returning. A pid reused during that gap must be caught before `#mutate` ever
    // opens its transaction and writes `identity.pid` as though it were still the verified one.
    const stillLiveAfterBuzz = this.#assertClaimantStillLive(identity);
    if (!stillLiveAfterBuzz.allowed) return stillLiveAfterBuzz as Decision<CanonicalSelfClaimReceipt>;

    // Clause 3 — one atomic mutation, or none. Every identity and authority check above is over;
    // nothing past this point may refuse for a reason this transaction cannot also undo.
    return this.#mutate(request, identity, image, transcript, buzzAddress.value);
  }

  /**
   * Re-verifies the immutable `(pid, startedAt)` adoption identity `deriveClaimantIdentity`
   * established at clause 1, at a point later than that derivation. `identity.startedAt` is
   * guaranteed non-null here — clause 2's own null check above already denied that case — so this
   * is always a real string-to-string comparison, never a vacuous pass on two nulls.
   *
   * Goes through `this.#processInspector`, the same seam `deriveClaimantIdentity` itself used —
   * never the raw `readProcessStartToken` OS call directly. A test that fakes process ancestry (a
   * synthetic pid with no real corresponding OS process) must re-verify against that same fake,
   * not against a real kernel lookup for a pid that was never real to begin with.
   */
  #assertClaimantStillLive(identity: DerivedClaimantIdentity): Decision<true> {
    const observed = this.#processInspector.snapshot(identity.pid)?.startedAt ?? null;
    if (observed !== identity.startedAt) {
      return deny(
        ReasonCode.CONFLICT,
        "the claimant process's start time no longer matches the identity verified earlier in this claim — its pid may have been reused",
        { pid: identity.pid, verifiedStartedAt: identity.startedAt, observedStartedAt: observed },
      );
    }
    return allow(ReasonCode.OK, true);
  }

  /**
   * Whether the predecessor session's *process* is provably gone — not whether its row says so.
   *
   * A `sessions.lifecycle` is a record this daemon wrote; a process's liveness is a fact the
   * kernel holds. Nothing transitions a row when its runtime dies, so a READY row routinely
   * outlives the process it names (`doctor` reports exactly this as `SESSION_PROCESS_MISSING`,
   * blocking, and has no way to act on it). Same-live recovery is about a *live* actor replacing
   * its own revoked attachment, so it must be entered on the process fact, never on the row.
   *
   * The pin is the same `(osPid, native start token)` pair the rest of this file uses to name one
   * OS process, read through the same `#processInspector` seam `deriveClaimantIdentity` and
   * `#assertClaimantStillLive` use — never a raw kernel call, so a test with a synthetic ancestry
   * is answered by that same fake.
   *
   * "Unknown" is never "gone". An unrecorded pair, or a pid that exists but whose start token
   * cannot be read, both return `false` and leave the strict same-live branch engaged: widening
   * this from "proven dead" to "not proven alive" is the single edit that would turn recovery into
   * eviction of a live holder whose probe merely failed.
   */
  #predecessorProcessIsGone(osPid: number | null, osProcessStartedAt: string | null): boolean {
    if (osPid === null || osProcessStartedAt === null) return false;
    const observed = this.#processInspector.snapshot(osPid);
    if (observed === null) return true;
    if (observed.startedAt === null) return false;
    return observed.startedAt !== osProcessStartedAt;
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
      // The owner approved this exact next generation for this exact role key. Checked before any
      // write — including before the owner approval is consumed — so a stale expectation denies
      // with nothing to roll back yet.
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

      // Clause 2 — pid/startedAt re-verified one last time, at the commit boundary itself, inside
      // this transaction. Everything above this point ran outside the transaction (including the
      // async Buzz-resolution await); a pid reused in the gap between that last check and this
      // write is still a real, distinct window, and this is the last point it can be caught
      // before `identity.pid`/`identity.startedAt` are written as though verified.
      const stillLiveAtCommit = this.#assertClaimantStillLive(identity);
      if (!stillLiveAtCommit.allowed) return stillLiveAtCommit as Decision<CanonicalSelfClaimReceipt>;

      // A live canonical actor may replace only its exact revoked runtime attachment.
      // This is not dead-process recovery and grants no authority over another holder.
      const incumbent = this.db.get<{
        actor_id: string; current_session_id: string; current_session_incarnation: string;
        target_binding_id: string;
      }>(
        `SELECT a.actor_id, a.current_session_id, a.current_session_incarnation, t.target_binding_id
           FROM conversational_actors a JOIN actor_target_bindings t ON t.target_actor_id = a.actor_id
          WHERE t.executor_kind = ? AND t.target_locator = ? AND t.target_locator_digest = ?`,
        [SELF_CLAIM_EXECUTOR_KIND, identity.sessionUuid, sha256(identity.sessionUuid)],
      );
      const predecessor = incumbent ? this.sessions.get(incumbent.current_session_id) : null;
      let predecessorSessionId: string | null = null;
      /**
       * The #831 path. Non-null only when the predecessor row is non-terminal while its process is
       * measurably gone: the row is reconciled to the fact, it is not replaced in place, and this
       * claim adopts nothing from it.
       */
      let abandonedRuntimeSessionId: string | null = null;
      // Liveness of a row is not liveness of a process (#831). This branch's subject is a *live*
      // runtime replacing its own revoked attachment, so a predecessor whose recorded
      // `(osPid, start token)` pair no longer resolves to a running process is not its case at
      // all, and a rule about a live actor must not answer for an actor that no longer exists.
      const predecessorRuntimeIsGone = predecessor !== null &&
        this.#predecessorProcessIsGone(predecessor.osPid, predecessor.osProcessStartedAt);
      if (incumbent && predecessor && predecessorRuntimeIsGone &&
          predecessor.lifecycle !== SessionLifecycle.STOPPED && predecessor.lifecycle !== SessionLifecycle.ERROR) {
        // Falling through alone does not reach the ordinary claim: `sessions_buzz_actor` is a
        // partial unique index over *live* rows, so a dead runtime left at READY keeps the
        // canonical Buzz identity and the ordinary claim below dies at `bindBuzzActor` with
        // SESSION_BUZZ_ACTOR_ALREADY_BOUND instead of CONFLICT — measured, same refusal, different
        // code. The restore path this claim then takes states the same precondition (a genuine
        // restart leaves the old session terminal), so the row is reconciled to the process fact
        // below, inside this transaction, and rolls back with everything else if anything denies.
        abandonedRuntimeSessionId = predecessor.sessionId;
      } else if (incumbent && predecessor &&
          predecessor.lifecycle !== SessionLifecycle.STOPPED && predecessor.lifecycle !== SessionLifecycle.ERROR) {
        const active = this.db.get(
          `SELECT 1 FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
            WHERE a.status = 'ACTIVE' AND (a.actor_id = ? OR a.session_id = ? OR c.current_session_id = ?)`,
          [incumbent.actor_id, predecessor.sessionId, predecessor.sessionId],
        );
        if (active) return deny(ReasonCode.BINDING_ALREADY_ACTIVE, "live actor or session still holds an assignment", {});
        const revoked = this.db.get(
          `SELECT 1 FROM assignments a JOIN actor_target_attestations t ON t.assignment_id = a.assignment_id
            WHERE a.role_key = ? AND a.binding_generation = ? AND a.status = 'REVOKED'
              AND a.actor_id = ? AND a.session_id = ? AND a.session_incarnation = ?
              AND t.target_binding_id = ? AND t.binding_generation = a.binding_generation
              AND t.executor_session_id = a.session_id AND t.executor_session_incarnation = a.session_incarnation`,
          [roleKey, currentMax, incumbent.actor_id, predecessor.sessionId, predecessor.incarnation,
            incumbent.target_binding_id],
        );
        const work = this.db.get(
          `SELECT 1 FROM runs r WHERE r.state NOT IN ('COMPLETED','FAILED','CANCELLED')
            AND (r.owner_session_id = ? OR EXISTS (
              SELECT 1 FROM assignments a WHERE a.actor_id = ? AND a.role_key = r.owner_role_key
                AND a.binding_generation = r.owner_binding_generation
                AND a.session_id = r.owner_session_id AND a.session_incarnation = r.owner_session_incarnation))`,
          [predecessor.sessionId, incumbent.actor_id],
        );
        // Revocation alone does not stop a worker or release an independently held lease.
        const outstanding = this.db.get(
          `WITH runtimes AS (
             SELECT ? AS session_id UNION SELECT session_id FROM assignments WHERE actor_id = ?
           )
           SELECT 1 FROM task_executions WHERE status = 'RUNNING' AND worker_session_id IN (SELECT session_id FROM runtimes)
           UNION ALL SELECT 1 FROM candidate_pipeline_attempts WHERE state = 'RUNNING' AND owner_session_id IN (SELECT session_id FROM runtimes)
           UNION ALL SELECT 1 FROM resource_claims WHERE status = 'HELD' AND owner_session_id IN (SELECT session_id FROM runtimes)`,
          [predecessor.sessionId, incumbent.actor_id],
        );
        if (!revoked || work || outstanding || predecessor.lifecycle !== SessionLifecycle.READY ||
            incumbent.current_session_incarnation !== predecessor.incarnation ||
            predecessor.osPid !== identity.pid || predecessor.osProcessStartedAt !== identity.startedAt ||
            predecessor.workdir !== identity.cwd || predecessor.buzzActorId !== request.buzzActorId ||
            predecessor.buzzAddress !== buzzAddress || predecessor.provider !== "claude" ||
            predecessor.model !== "claude-cli") {
          return deny(ReasonCode.CONFLICT, "same-live recovery requires the exact idle revoked runtime", {});
        }
        predecessorSessionId = predecessor.sessionId;
      }

      // Consumed exactly once, inside this transaction. A denial anywhere below rolls this
      // consumption back too, so a refused claim leaves the approval reusable; only a committed
      // one burns it. `OwnerAuthority.consumeApproval` itself denies a replay or a presentation
      // against a different candidate — both re-checked here for a non-run operation.
      const consumed = this.ownerAuthority.consumeApproval(request.ownerApproval, null);
      if (!consumed.allowed) return consumed as Decision<CanonicalSelfClaimReceipt>;
      if (abandonedRuntimeSessionId !== null) {
        const reconciled = this.sessions.transition(abandonedRuntimeSessionId, SessionLifecycle.STOPPED,
          `canonical predecessor runtime is gone; row reconciled before generation ${nextGeneration}`);
        if (!reconciled.allowed) return reconciled as Decision<CanonicalSelfClaimReceipt>;
      }
      if (predecessorSessionId !== null) {
        const stopped = this.sessions.transition(predecessorSessionId, SessionLifecycle.STOPPED,
          `canonical same-live successor generation ${nextGeneration}`);
        if (!stopped.allowed) return stopped as Decision<CanonicalSelfClaimReceipt>;
      }

      const created = this.sessions.create({
        provider: "claude",
        model: "claude-cli",
        workdir: identity.cwd,
        osPid: identity.pid,
        // The exact verified pair (#760), not a fresh `processStartedAt` read at write time —
        // `SessionRegistry.create` accepts this and stores it as-is rather than re-deriving its
        // own start time, which is precisely the TOCTOU window this field closes.
        osStartedAt: identity.startedAt,
        buzzAddress,
      });
      // `bind()` requires a READY session (SESSION_NOT_READY otherwise); `create()` always starts
      // a session in STARTING. This transition sits inside the same transaction, so a legality
      // failure here rolls back the session insert too, exactly like every other denial in `#mutate`.
      const ready = this.sessions.transition(created.sessionId, SessionLifecycle.READY,
        predecessorSessionId === null ? "canonical self-claim" :
          `canonical same-live successor of ${predecessorSessionId}, generation ${nextGeneration}`);
      if (!ready.allowed) return ready as Decision<CanonicalSelfClaimReceipt>;

      // The routable half: this session also authenticates as a Buzz channel identity, inside the
      // same transaction, or none of it lands. `bindBuzzActor` requires the
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
        predecessorSessionId,
        successorSessionId: created.sessionId,
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
