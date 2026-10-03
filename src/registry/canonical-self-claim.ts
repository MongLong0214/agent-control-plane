import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { systemClock, type Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { readProcessArgv, readProcessStartToken } from "../core/process-argv.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { probeSessionLiveness, recoverDeadCanonicalBinding } from "../daemon/dead-binding-recovery.ts";
import type { AuditLog, AuditRecord } from "../db/audit.ts";
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
 * verifies a set of independently fatal facts about the claimant, and only then performs one
 * atomic mutation that either creates the session/actor/assignment/target-binding/attestation
 * tuple or writes nothing at all.
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
 *    refusal above `#mutate` therefore leaves every table but `audit_events` exactly as it found
 *    it, by construction rather than by inspecting what `#mutate` decided; `audit_events` gains the
 *    one refusal row `claim()` writes on its way out.
 */

// ---------------------------------------------------------------------------
// Deployment identity (#760). The adoptable sessions and the canonical Buzz channel are
// deployment-private facts, not source constants. They are required fields on
// `CanonicalSelfClaimConfig` (below), sourced by the composition root (`src/daemon/agentcpd.ts`)
// from required environment variables with no fallback to a real value; a missing one fails
// construction closed, before any effect. The claimant's executing image is not one of them: it is
// observed and recorded, and compared against no configured value (clause 2 in
// `verifyClaudeIdentity`). What gets recorded is still read from the image the kernel actually
// loaded, never from a symlink or a fresh `claude --version` invocation resolved through PATH —
// see `defaultExecutingImageInspector`/`versionFromImagePath` below.
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
  /** Re-read only the kernel start token after a host registry read. Synthetic inspectors may omit this and use snapshot. */
  readStartToken?(pid: number): string | null;
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

/**
 * Which failure a synchronous child-process probe suffered, from the error it threw.
 *
 * Read `code`, not `killed`. **`execFileSync` does not set `killed`** — the field this branch used
 * to test was never present, so `TIMED_OUT` was unreachable on every path and every probe failure
 * was reported as `SCAN_FAILED` (#838). Measured on Node 22.23.2:
 *
 * ```
 * sleep 5, timeout 200ms   killed=undefined signal=SIGTERM code=ETIMEDOUT status=null
 * ps on a dead pid         killed=undefined signal=null    code=undefined  status=1
 * ```
 *
 * The consequence was not cosmetic: #834 was a real 30.07s lsof timeout, and the classification
 * added in its own fix would have reported it as "lsof is not reachable", sending the diagnosis
 * toward the PATH shape (#423/#785) instead of toward the budget.
 *
 * `signal === "SIGTERM"` is the other candidate and is weaker — a child killed by an unrelated
 * SIGTERM would read as a timeout, while `ETIMEDOUT` is set by the timeout path alone.
 *
 * Exported and separate from `lsofEntries` so the split can be tested without a clock: the subject
 * is the shape of the error object, not the speed of any scan. 239aa3d ruled out pinning a real
 * scan with a timing assertion — flaky on a host with nothing to resolve, and a failure would say
 * "slow" rather than name the defect — and that reasoning still holds; this keeps the split
 * witnessable without reopening it.
 */
export const probeFailureKind = (failed: { code?: unknown }): "TIMED_OUT" | "SCAN_FAILED" =>
  failed.code === "ETIMEDOUT" ? "TIMED_OUT" : "SCAN_FAILED";

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
    // Which of the two failures this was decides the operator's next step — "the scan needs to be
    // cheaper or the budget bigger" against "lsof is not reachable" — and a single "scan failed"
    // would send both diagnoses the same way. `probeFailureKind` owns that split; see its comment
    // for why the field it reads is `code` and not `killed`.
    const failed = error as { code?: unknown; status?: unknown };
    return {
      ok: false,
      failure: {
        pid,
        timeoutMs: SUBPROCESS_TIMEOUT_MS,
        kind: probeFailureKind(failed),
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
  readStartToken: readProcessStartToken,
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
 * Tests whether `argv[0]` is one of the two native Claude invocation shapes: a directly executed
 * binary whose basename is `claude` (`/path/to/claude ...`), or the current native updater layout
 * `<dir>/claude/versions/<x.y.z>`. The vector is the kernel's copy of the real argv, never a
 * `ps`-rendered approximation of it, but its first element is still whatever the `execve` caller
 * chose to pass. By convention that is the path or name it invoked; nothing binds it to the file
 * the kernel loaded — `exec -a`, or node's `spawn(file, args, { argv0 })`, sets it to any string.
 * So these are invocation-shape tests on a caller-chosen string, not statements about the image.
 * They are still worth keeping: the ancestry walk stops at the first ancestor it matches, so they
 * distinguish the claude process from the shells and tools between it and the caller, and a
 * process that presents neither permitted shape never becomes the claimant.
 *
 * Deliberately does **not** also match a second element whose basename is `claude` — an
 * interpreter-launched script, `node /path/to/claude ...`. For that shape the kernel-loaded image
 * is the interpreter, never the script, so matching it would let any script merely named `claude`
 * stand as the claimant on the strength of whichever legitimate interpreter launched it.
 *
 * This is now the only process-shape check between a same-uid process and the claim, and it is a
 * check on a name or exact updater path shape. It used to be the first half of a pair: the
 * executing image was then compared against a deployment-configured version, realpath and sha256,
 * which is what tied the name read here to the bytes actually running. That comparison is
 * withdrawn (clause 2 in `verifyClaudeIdentity`), so neither accepted `argv[0]` form attests the
 * loaded image. What still bounds the claim is the kernel peer credential on the claim socket, the
 * configured session UUID derived from this process's argv or supplementary host registry, its
 * PID/start-identity rechecks, and the project that UUID's entry names.
 */
const NATIVE_VERSIONED_CLAUDE_PATH =
  /^.+\/claude\/versions\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export const looksLikeClaudeInvocation = (argv: readonly string[]): boolean => {
  const [firstElement] = argv;
  return firstElement !== undefined &&
    (/(^|\/)claude$/.test(firstElement) || NATIVE_VERSIONED_CLAUDE_PATH.test(firstElement));
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
const sessionSelectorOccurrences = (argv: readonly string[]): Array<{ index: number; attachedValue: string | null }> => {
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
  return occurrences;
};

export const extractSessionUuidFromArgv = (argv: readonly string[]): string | null => {
  const scanRange = argvBeforeOptionsBoundary(argv);
  const occurrences = sessionSelectorOccurrences(argv);
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
  sessionSource: "argv" | "host-session-registry";
}

/**
 * Clause 1 — identity is derived, never accepted. Walks the process ancestry from `callerPid` to
 * the nearest `claude` ancestor and reads its argv selector first. Without a selector, the host
 * session registry must match that ancestor's pid and kernel start time; a valid registry entry
 * that disagrees with an argv selector is refused. A caller-supplied UUID or PID is never used as
 * the derived identity.
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
  registryReader: HostSessionRegistryReader = makeDefaultHostSessionRegistryReader(),
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
      const argvSessionUuid = extractSessionUuidFromArgv(snapshot.argv);
      const selectorCount = sessionSelectorOccurrences(snapshot.argv).length;
      if (selectorCount > 0 && !argvSessionUuid) {
        return deny(
          ReasonCode.NOT_FOUND,
          "the claude ancestor's argv names no session id",
          { pid: snapshot.pid },
        );
      }
      const registry = registryReader.read(snapshot.pid, snapshot.startedAt);
      // Only a file that is not there leaves argv to stand alone. A file that is there and could
      // not be verified — replaced during the read, the wrong shape, an earlier process's, or
      // unverifiable — refuses even a valid argv selector: the selector cannot outvote evidence
      // that the process may now be running a session it does not name.
      if (!registry.allowed && argvSessionUuid && !isHostSessionRegistryAbsent(registry)) {
        return deny(
          registry.reasonCode,
          `the claude ancestor's host session registry entry could not be verified, so its argv selector is not accepted: ${registry.message}`,
          { pid: snapshot.pid },
        );
      }
      if (registry.allowed) {
        // A registry entry belongs to the process observed before the file read only if the
        // kernel still reports that exact native-resolution start token afterward.
        const afterRead = inspector.readStartToken !== undefined
          ? inspector.readStartToken(snapshot.pid)
          : inspector.snapshot(snapshot.pid)?.startedAt ?? null;
        if (snapshot.startedAt === null || afterRead !== snapshot.startedAt) {
          return deny(ReasonCode.CONFLICT, "claude ancestor start token changed during host session registry read", {
            pid: snapshot.pid, beforeRead: snapshot.startedAt, afterRead,
          });
        }
      }
      let sessionUuid: string;
      let sessionSource: DerivedClaimantIdentity["sessionSource"];
      if (argvSessionUuid) {
        if (registry.allowed && registry.value.sessionUuid !== argvSessionUuid) {
          return deny(
            ReasonCode.CONFLICT,
            "the claude ancestor's argv and host session registry disagree on the session id",
            { pid: snapshot.pid },
          );
        }
        sessionUuid = argvSessionUuid;
        sessionSource = "argv";
      } else {
        if (!registry.allowed) {
          return deny(
            registry.reasonCode,
            `the claude ancestor's argv names no session id, and the host session registry does not identify it: ${registry.message}`,
            { pid: snapshot.pid },
          );
        }
        sessionUuid = registry.value.sessionUuid;
        sessionSource = "host-session-registry";
      }
      return allow(ReasonCode.OK, {
        pid: snapshot.pid,
        ppid: snapshot.ppid,
        startedAt: snapshot.startedAt,
        cwd: snapshot.cwd,
        cwdProbeFailure: snapshot.cwdProbeFailure,
        argv: snapshot.argv,
        sessionUuid,
        sessionSource,
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
// Executing image — the specific file the OS loaded, not a symlink read at check time. Observed and
// recorded; no claim is refused on what it says, or on its absence.
// ---------------------------------------------------------------------------

export interface ExecutingImageEvidence {
  imagePath: string;
  version: string;
  /**
   * `sha256:<hex>` of the image's bytes, read through the verified FD (see `hashImageFd`) — or
   * absent, and which one depends on the inspector that produced the evidence.
   *
   * Always absent from `defaultExecutingImageInspector`, which is the canonical claim's. That
   * claim's attestation and receipt take the path and version only, so the inspector reads no byte
   * of the image. It used to hash the whole binary on every claim for a field nothing there read,
   * and when that read failed it returned `null` — losing the path and version the claim does read.
   *
   * Present from `hashingExecutingImageInspector`, whose one caller is the delegated CTO binding's
   * attestation digest (`cto-binding-runtime.ts`), except when the bytes could not be read. That
   * absence is the report: the evidence still names the image the scan resolved instead of
   * collapsing into `null`, and the delegated binding refuses it rather than attesting an observed
   * image without its hash. A reader that needs this field must treat its absence as "not read",
   * never as "nothing to read".
   */
  sha256?: string;
}

/**
 * The scan that would have named the executing image could not run. Distinguished from `null` for
 * the same reason `cwd` is (#834): `null` means the scan ran and produced no usable image — the
 * file it names is gone from disk, was replaced after exec, or carries no `/versions/` segment —
 * and this means nobody looked. Neither refuses a claim, and the claim records both as no image;
 * the distinction survives for a caller that must not read a scan that never ran as an
 * observation of nothing. The one-key shape is the discriminator — `ExecutingImageEvidence` never
 * carries `probeFailure`.
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
   * only the first two — the union is wider than what it produces, not narrower. Whether the
   * evidence carries `sha256` is the implementation's to say; `ExecutingImageEvidence` states what
   * each of the two shipped here does.
   */
  resolve(pid: number): ExecutingImageEvidence | ExecutingImageProbeFailure | null;
}

/**
 * Reads the version out of the resolved image's own path rather than executing it or trusting a
 * file placed beside it. The version is an observation — the claim records it in its attestation
 * and receipt and compares it against nothing — so the one requirement on it is that it describe
 * the image the kernel actually loaded. Invoking the resolved path with `--version` would record
 * whatever that binary chose to say about itself instead.
 *
 * An adjacent `package.json` is not read either: it is a second file, independently writable from
 * the binary it sits beside, so it can say anything while the running image stays the same. The
 * path's own `/versions/<version>` executable-file layout, or the legacy
 * `/versions/<version>/<binary>` layout, is where the running image was resolved, so that segment,
 * taken verbatim, is the version recorded. Nothing here validates its shape, so a deployment's real
 * version and a test's synthetic prerelease segment (e.g. `9.0.0-test`) are read identically.
 */
const IMAGE_VERSION_FILE_PATTERN = /\/versions\/([^/]+)$/;
const IMAGE_VERSION_DIRECTORY_PATTERN = /\/versions\/([^/]+)\/[^/]+$/;

export const versionFromImagePath = (imagePath: string): string | null =>
  IMAGE_VERSION_FILE_PATTERN.exec(imagePath)?.[1]
  ?? IMAGE_VERSION_DIRECTORY_PATTERN.exec(imagePath)?.[1]
  ?? null;

/**
 * Hashes the bytes reached through an already-open file descriptor, then closes it; `null` when
 * they could not be read. Only `hashingExecutingImageInspector` gets here — the canonical claim's
 * inspector never opens the image. No claim compares the hash against a configured value. It is
 * read through the exact FD `openLinuxImageFd`/`openVerifiedDarwinImageFd` bound rather than
 * through a *later, separate* open of the same path string, so that what it reports is the running
 * image's bytes: a file swapped into place after the path resolves and before a second open runs
 * would otherwise be hashed in the running image's name.
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
 * The (device, inode) `lsof` reported for the image, parsed into what a `bigint` `stat` returns, or
 * `null` when the scan did not report one. `bigint` because a real inode on this filesystem
 * exceeds `Number.MAX_SAFE_INTEGER`; the default, non-bigint stat silently rounds it, which would
 * make two genuinely different inodes compare equal.
 */
interface ReportedImageFile {
  device: bigint;
  inode: bigint;
}

const reportedImageFile = (entry: LsofEntry): ReportedImageFile | null => {
  if (entry.device === null || entry.inode === null) return null;
  try {
    return { device: BigInt(entry.device), inode: BigInt(entry.inode) };
  } catch {
    return null;
  }
};

/**
 * Whether a stat describes the file `lsof` reported the process running. `lsof`'s `txt` path is
 * only a path, resolved at scan time; a file swapped in at that path afterwards changes what a
 * later stat sees without changing what `lsof` already reported, so this is what catches it. Both
 * uses below go through this one comparison: the canonical label (`pathIsReportedImageFile`) and
 * the FD the hashing inspector reads (`openVerifiedDarwinImageFd`).
 */
const isReportedImageFile = (stat: BigIntStats, reported: ReportedImageFile): boolean =>
  stat.dev === reported.device && stat.ino === reported.inode;

/**
 * Whether the path `lsof` reported still names the running image — `stat`, not an open, so it
 * reads no byte of the file and needs no read permission on it. A process can execute an image its
 * uid cannot read (mode `--x`), and that image's path and version are exactly as observable as any
 * other's; an open here would lose them to a read nobody on the canonical path consumes.
 *
 * What it still refuses to label is a path that no longer names the running file: a build the
 * updater deleted from disk (the stat fails) or a file renamed over the image after exec (the
 * stat names another inode). Both resolve to no image, as they did when this was an open.
 */
const pathIsReportedImageFile = (imagePath: string, reported: ReportedImageFile): boolean => {
  try {
    return isReportedImageFile(statSync(imagePath, { bigint: true }), reported);
  } catch {
    return false;
  }
};

/**
 * Darwin has no magic-symlink equivalent to open directly, so the hashing inspector opens the
 * reported path and then verifies — via `fstat` on the opened FD — that it is the file `lsof`
 * reported in the *same* scan. `pathIsReportedImageFile` already checked the path a moment
 * earlier, but that check is on the path and this is on the handle whose bytes get hashed: a swap
 * landing between the two is caught here rather than silently hashed.
 */
const openVerifiedDarwinImageFd = (imagePath: string, reported: ReportedImageFile): number | null => {
  let fd: number;
  try {
    fd = openSync(imagePath, "r");
  } catch {
    return null;
  }
  try {
    if (!isReportedImageFile(fstatSync(fd, { bigint: true }), reported)) {
      closeSync(fd);
      return null;
    }
  } catch {
    closeSync(fd);
    return null;
  }
  return fd;
};

/**
 * What one scan says the process is running, and how to open exactly that file if a caller needs
 * its bytes. Producing it reads none of them: `open` runs only for the hashing inspector.
 */
interface ObservedImage {
  evidence: ExecutingImageEvidence;
  open: () => number | null;
}

const observeExecutingImage = (pid: number): ObservedImage | ExecutingImageProbeFailure | null => {
  if (platform() === "linux") {
    let imagePath: string;
    try {
      imagePath = realpathSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
    const version = versionFromImagePath(imagePath);
    if (!version) return null;
    return { evidence: { imagePath, version }, open: () => openLinuxImageFd(pid) };
  }
  // Darwin (and any other platform lsof can answer for): one lsof scan is the single source for
  // both the reported path and the device+inode the path and the opened FD are verified against —
  // two separate scans could each see a different reality if a path were swapped in between them.
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
  const reported = reportedImageFile(entry);
  if (!reported) return null;
  if (!pathIsReportedImageFile(imagePath, reported)) return null;
  return { evidence: { imagePath, version }, open: () => openVerifiedDarwinImageFd(imagePath, reported) };
};

const resolveExecutingImage = (
  pid: number, hash: boolean,
): ExecutingImageEvidence | ExecutingImageProbeFailure | null => {
  const observed = observeExecutingImage(pid);
  if (observed === null) return null;
  if ("probeFailure" in observed) return observed;
  if (!hash) return observed.evidence;
  const fd = observed.open();
  const imageSha256 = fd === null ? null : hashImageFd(fd);
  // The scan above already resolved the image, so a read that failed says nothing about whether it
  // exists. Folding it into `null` is what this used to do, and it reported an image it had
  // observed as no image at all. The evidence goes back without `sha256` instead, and the caller
  // that needed the hash decides what an unhashed image means to it.
  if (imageSha256 === null) return observed.evidence;
  return { ...observed.evidence, sha256: imageSha256 };
};

/**
 * The canonical claim's inspector: the image's path and version, and no byte of the image read.
 * The canonical attestation and receipt take nothing else, so there is no hash here to compute.
 */
export const defaultExecutingImageInspector: ExecutingImageInspector = {
  resolve: (pid) => resolveExecutingImage(pid, false),
};

/**
 * The same observation plus `sha256` of the image, read through the verified FD — for the one
 * reader of that hash, the delegated CTO binding's attestation digest (`cto-binding-runtime.ts`).
 * An image it resolved but could not read comes back without `sha256`, never as `null`; that
 * caller refuses it rather than attest an observed image without its hash.
 */
export const hashingExecutingImageInspector: ExecutingImageInspector = {
  resolve: (pid) => resolveExecutingImage(pid, true),
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

export interface HostSessionRegistryReader {
  read(pid: number, startToken: string | null): Decision<{ sessionUuid: string }>;
}

/**
 * The one registry refusal that is not an anomaly: no file exists at the ancestor's path. Only this
 * answer lets an argv selector stand on its own. A read that found a file and could not verify it
 * — replaced during the read, the wrong shape, the wrong process, unverifiable — refuses the claim
 * whatever argv names, because the file it did find is evidence the selector may be stale.
 */
const HOST_SESSION_REGISTRY_ABSENT = "absent";
export const hostSessionRegistryAbsent = (message: string): Decision<{ sessionUuid: string }> =>
  deny(ReasonCode.NOT_FOUND, message, { hostSessionRegistry: HOST_SESSION_REGISTRY_ABSENT });
const isHostSessionRegistryAbsent = (registry: Decision<{ sessionUuid: string }>): boolean =>
  registry.evidence["hostSessionRegistry"] === HOST_SESSION_REGISTRY_ABSENT;

/**
 * Injectable descriptor operations keep path swaps and fstat failures deterministic in tests.
 * `fstat` answers at bigint precision: the file's creation time is compared to the process's start
 * token at nanosecond resolution, which a number millisecond field cannot carry exactly.
 */
export interface HostSessionRegistryFileOps {
  open(path: string, flags: number): number;
  fstat(fd: number): BigIntStats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

const defaultHostSessionRegistryFileOps: HostSessionRegistryFileOps = {
  open: openSync, fstat: (fd) => fstatSync(fd, { bigint: true }), read: readSync, close: closeSync,
};

const HOST_SESSION_REGISTRY_MAX_BYTES = 64 * 1024;
/**
 * O_NOFOLLOW refuses a symlink at the final path component when the descriptor is created, so
 * everything checked afterward is checked on the fd rather than on the path. O_NONBLOCK keeps a
 * FIFO planted at the path from blocking this synchronous open; it changes nothing for the
 * regular file the fstat below then requires.
 */
export const HOST_SESSION_REGISTRY_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const registrySizeWithinBound = (size: number): boolean =>
  Number.isSafeInteger(size) && size >= 0 && size <= HOST_SESSION_REGISTRY_MAX_BYTES;

/**
 * The registry is bound to a process instance only by Darwin's native start token: the kernel's
 * own `pbi_start_tvsec`/`tvusec` wall-clock pair, which places the start exactly on the clock a
 * file's `st_birthtime` is read from. ACP deploys only on Darwin (launchd). Any other token —
 * Linux's `linux-clk:` ticks since boot among them — has no such instant: placing it on the wall
 * clock means sampling the boot time, and that estimate moves with probe latency. Such a token is
 * not converted at all; the reader refuses the registry as unverifiable.
 */
const DARWIN_START_TOKEN = /^darwin-tv:(\d+)\.(\d{6})$/;

/** The ancestor's native start as nanoseconds since the Unix epoch, or `null` for a non-Darwin token. */
const darwinStartEpochNs = (token: string | null): bigint | null => {
  const darwin = DARWIN_START_TOKEN.exec(token ?? "");
  if (!darwin) return null;
  return BigInt(darwin[1]!) * 1_000_000_000n + BigInt(darwin[2]!) * 1_000n;
};

/** Claude records UTC ctime at whole-second precision, while the process snapshot keeps its native start token. */
const registryProcStartFromStartNs = (startedNs: bigint): string | null => {
  const seconds = Number(startedNs / 1_000_000_000n);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
};

/**
 * The upper bound of the current wall clock in nanoseconds since the Unix epoch. `Clock` answers
 * in whole milliseconds, so the end of the current millisecond is taken: a file created earlier in
 * the same millisecond as the check is not mistaken for one from the future.
 */
const wallClockUpperNs = (clock: Clock): bigint => (BigInt(clock.now().getTime()) + 1n) * 1_000_000n;

/**
 * The host registry directory sits beside the one transcript root this module already uses.
 * The reader owns all host-file checks so synthetic ancestry tests can inject a reader without
 * consulting the actual Claude home. `clock` is the wall clock a registry file's creation time
 * must not be later than; it is injectable so a backward step can be reproduced.
 */
export const makeDefaultHostSessionRegistryReader = (
  root: string = join(dirname(defaultTranscriptRoot()), "sessions"),
  fileOps: HostSessionRegistryFileOps = defaultHostSessionRegistryFileOps,
  clock: Clock = systemClock,
): HostSessionRegistryReader => ({
  read(pid, startToken) {
    const path = join(root, `${pid}.json`);
    const processUid = process.getuid?.();
    const uid = processUid === undefined ? undefined : BigInt(processUid);
    let fd: number;
    try {
      fd = fileOps.open(path, HOST_SESSION_REGISTRY_OPEN_FLAGS);
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          return hostSessionRegistryAbsent(`host session registry file is absent: ${path}`);
        }
        if (error.code === "ELOOP") {
          return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file is a symlink: ${path}`);
        }
      }
      return deny(ReasonCode.PROBE_FAILED, `host session registry file could not be opened safely: ${path}`);
    }
    let raw: string;
    let opened: BigIntStats;
    try {
      opened = fileOps.fstat(fd);
      if (!opened.isFile()) return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file is not regular: ${path}`);
      if (uid === undefined || opened.uid !== uid) {
        return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file is not owned by the daemon uid: ${path}`);
      }
      if (!registrySizeWithinBound(Number(opened.size))) {
        return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file exceeds the size limit: ${path}`);
      }
      const bytes = Buffer.alloc(HOST_SESSION_REGISTRY_MAX_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const n = fileOps.read(fd, bytes, count, bytes.length - count, count);
        if (n === 0) break;
        count += n;
      }
      if (!registrySizeWithinBound(count)) return deny(ReasonCode.INVALID_ARGUMENT, `host session registry file exceeds the size limit: ${path}`);
      if (BigInt(count) !== opened.size) return deny(ReasonCode.PROBE_FAILED, `host session registry file changed during read: ${path}`);
      raw = bytes.subarray(0, count).toString("utf8");
    } catch {
      return deny(ReasonCode.PROBE_FAILED, `host session registry file could not be read: ${path}`);
    } finally {
      fileOps.close(fd);
    }
    // Reopen safely after the read. The bytes came from the first fd; a replacement of its path
    // during that read must not be accepted as the current registry entry.
    let currentFd: number;
    try {
      currentFd = fileOps.open(path, HOST_SESSION_REGISTRY_OPEN_FLAGS);
    } catch {
      return deny(ReasonCode.PROBE_FAILED, `host session registry file changed during read: ${path}`);
    }
    try {
      const current = fileOps.fstat(currentFd);
      if (!current.isFile() || current.uid !== uid || current.size !== opened.size ||
          current.dev !== opened.dev || current.ino !== opened.ino) {
        return deny(ReasonCode.PROBE_FAILED, `host session registry file changed during read: ${path}`);
      }
    } catch {
      return deny(ReasonCode.PROBE_FAILED, `host session registry file could not be rechecked: ${path}`);
    } finally {
      fileOps.close(currentFd);
    }
    let entry: unknown;
    try {
      entry = JSON.parse(raw) as unknown;
    } catch {
      return deny(ReasonCode.INVALID_ARGUMENT, `host session registry JSON is malformed: ${path}`);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return deny(ReasonCode.INVALID_ARGUMENT, `host session registry JSON is not an object: ${path}`);
    }
    const fields = entry as Record<string, unknown>;
    if (typeof fields.pid !== "number" || fields.pid !== pid) {
      return deny(ReasonCode.CONFLICT, `host session registry pid does not match the claude ancestor: ${path}`);
    }
    // Only a native Darwin start token and a native file creation time bind this entry to the
    // process instance below the second. Anything else is refused as unverifiable, never estimated:
    // the refusal is not an absent file, so it also refuses a valid argv selector.
    const startedNs = darwinStartEpochNs(startToken);
    if (startedNs === null) {
      return deny(
        ReasonCode.PROBE_FAILED,
        `claude ancestor start token is not a native Darwin start token, so it cannot verify host session registry: ${path}`,
      );
    }
    const expectedProcStart = registryProcStartFromStartNs(startedNs);
    if (expectedProcStart === null) {
      return deny(ReasonCode.PROBE_FAILED, `claude ancestor start token cannot verify host session registry: ${path}`);
    }
    if (typeof fields.procStart !== "string" || fields.procStart !== expectedProcStart) {
      return deny(ReasonCode.CONFLICT, `host session registry procStart does not match the kernel start time: ${path}`);
    }
    // procStart is whole seconds, so a process that reuses this pid within the same second as an
    // earlier one matches a file the earlier one left. The file itself was created by a process
    // that existed when it was written: a file whose kernel birth time precedes this process's
    // native start token was written before this process instance existed, and is refused. A
    // birth time later than the wall clock now means the clock stepped backward after the file
    // was written, so neither instant can be trusted against the other, and that is refused too.
    //
    // Residual risk: on Darwin, a backward wall-clock step smaller than the gap between the stale
    // file's creation and the claim, combined with a reuse of its pid within the same second, by a
    // same-uid process that could already write the registry, still admits the stale file. A
    // same-uid process can also set a file's birth time (`setattrlist`), which is inside the same
    // threat model: the registry is supplementary evidence a same-uid writer controls.
    if (opened.birthtimeNs <= 0n) {
      return deny(ReasonCode.PROBE_FAILED, `host session registry file creation time cannot be established: ${path}`);
    }
    if (opened.birthtimeNs < startedNs) {
      return deny(
        ReasonCode.CONFLICT,
        `host session registry file was created before the claude ancestor started, so it belongs to an earlier process at this pid: ${path}`,
      );
    }
    if (opened.birthtimeNs > wallClockUpperNs(clock)) {
      return deny(
        ReasonCode.PROBE_FAILED,
        `host session registry file was created after the current wall clock, so the clock stepped backward after it was written: ${path}`,
      );
    }
    if (typeof fields.sessionId !== "string" || !UUID_PATTERN.test(fields.sessionId)) {
      return deny(ReasonCode.INVALID_ARGUMENT, `host session registry sessionId is not an exact UUID: ${path}`);
    }
    if (fields.kind !== "interactive") {
      return deny(ReasonCode.INVALID_ARGUMENT, `host session registry kind is not interactive: ${path}`);
    }
    return allow(ReasonCode.OK, { sessionUuid: fields.sessionId.toLowerCase() });
  },
});

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

/**
 * One session this deployment may adopt, and the single project it may hold the CTO role for.
 *
 * The project is part of the entry rather than something the claim takes on the caller's word.
 * Before this existed the pin named a session and nothing else, so the one adoptable session could
 * claim `PRIMARY_CTO` for whichever `projectId` its request happened to carry — the role key was
 * assembled from that value (`roleKeyFor`) with no check that this session was the deployment's
 * answer for that project. Entitlement and identity are one fact here.
 *
 * `buzzActorId` is per entry because it has to be: `sessions_buzz_actor` is UNIQUE over
 * live lifecycles, so two adopted sessions sharing one actor id means the second `bindBuzzActor`
 * is refused by the index and the whole claim rolls back.
 *
 * `buzzAddress` is per entry for the same kind of reason. Each CTO answers in its own project's
 * CEO room, and the peer rule admits a CEO mention only when it arrived on the addressed CTO's
 * `sessions.buzz_address` (`src/ingress/buzz-message.ts`, rule 4). With one deployment-wide channel
 * every adopted CTO was written into the same room, so mentions to all but one of them were refused
 * or misrouted. It is optional: an entry without it routes to `canonicalBuzzChannelId`, which is
 * what every entry did before it existed. Unlike the other three fields it need not be unique,
 * because two projects may share a room.
 */
export interface CanonicalAdoptableSession {
  /** The claude session UUID, matched against the independently derived ancestry, never a claim. */
  sessionUuid: string;
  /** The only project this session may hold `PRIMARY_CTO` for. */
  projectId: string;
  /** The Buzz channel identity this session authenticates as; unique across live sessions. */
  buzzActorId: string;
  /** The Buzz room (a lower-case channel UUID) this session's row routes to; see above. */
  buzzAddress?: string;
}

/**
 * The Buzz room an entry routes to: its own `buzzAddress`, or the deployment's channel when it
 * names none. The claim opens this room and records it in the attestation digest from this one
 * reading, so the two cannot name different rooms for one entry.
 */
export const canonicalBuzzChannelFor = (
  entry: CanonicalAdoptableSession,
  canonicalBuzzChannelId: string,
): string => entry.buzzAddress ?? canonicalBuzzChannelId;

/** A deployment adopting more entries than this has stopped being a local deployment. */
export const MAX_CANONICAL_ADOPTABLE_SESSIONS = 32;

/**
 * The one authority over what a configured adoptable set may be. Both the composition root's
 * `ACP_CANONICAL_SESSIONS_JSON` parser and this class's constructor call it, because they used to
 * hold different halves of the rule: the parser checked shape and size, the constructor checked
 * blanks and uniqueness, and the constructor runs per claim rather than at startup. A deployment
 * with two entries sharing a UUID therefore started a listener that reported itself up and then
 * answered every claim with INTERNAL_ERROR, while `deploy/README.md` promised startup would refuse
 * it.
 *
 * Fields must already be in canonical form; this never normalizes them. Normalizing here would
 * make this a second authority over the value the rest of the system compares. Uniqueness below
 * runs on the configured strings, `SessionRegistry.bindBuzzActor` trims the actor id before it
 * reaches the `sessions_buzz_actor` unique index, and the session UUID derived from process
 * ancestry is lowercased — so `"a"` and `" a "` are two entries here and one row there, and an
 * upper-case configured UUID is an entry no live session can ever match.
 */
export const assertCanonicalSessionsValid = (
  canonicalSessions: unknown,
): readonly CanonicalAdoptableSession[] => {
  // An empty set is not a deployment that adopts nothing by choice — it is a composition root that
  // failed to supply its configuration, and admitting it would leave a listener bound that can
  // never say yes.
  if (!Array.isArray(canonicalSessions) || canonicalSessions.length === 0) {
    throw new Error(
      "CanonicalSelfClaim: config.canonicalSessions is required deployment configuration and was missing or empty",
    );
  }
  if (canonicalSessions.length > MAX_CANONICAL_ADOPTABLE_SESSIONS) {
    throw new Error(
      `CanonicalSelfClaim: config.canonicalSessions holds more than ${MAX_CANONICAL_ADOPTABLE_SESSIONS} entries`,
    );
  }
  for (const entry of canonicalSessions) {
    for (const field of ["sessionUuid", "projectId", "buzzActorId"] as const) {
      const value: unknown = entry?.[field];
      // Spelled `.trim() === ""` rather than `.trim().length === 0` on purpose: the falsifiability
      // row `a-deployment-value-is-not-blank` anchors on that exact substring and the harness
      // requires its `find` to match this file exactly once. A second spelling of the same
      // predicate would leave that row with no unique anchor and silently no verdict.
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `CanonicalSelfClaim: config.canonicalSessions[].${field} is required deployment configuration and was missing or empty`,
        );
      }
      // Refused rather than trimmed: see this function's contract above.
      if (value !== value.trim()) {
        throw new Error(
          `CanonicalSelfClaim: config.canonicalSessions[].${field} must not be surrounded by whitespace`,
        );
      }
    }
    const configuredUuid = (entry as CanonicalAdoptableSession).sessionUuid;
    if (!UUID_PATTERN.test(configuredUuid)) {
      throw new Error("CanonicalSelfClaim: config.canonicalSessions[].sessionUuid must be a UUID");
    }
    // `UUID_PATTERN` admits `A-F`, and the UUID this primitive resolves membership against is
    // lowercased where it is extracted from the ancestor's argv. An upper-case entry would parse,
    // start, and then refuse its own session with CONFLICT forever.
    if (configuredUuid !== configuredUuid.toLowerCase()) {
      throw new Error("CanonicalSelfClaim: config.canonicalSessions[].sessionUuid must be lower-case");
    }
    // Absent is the fallback to the deployment channel. Present, it is a channel UUID or the set is
    // refused: never trimmed, never treated as absent when blank. Lower-case, because the transport
    // refuses a channel the relay reports under another spelling (`BuzzCliTransport` requires the
    // answered `channel_id` to equal the one asked for), so an upper-case room would start the
    // daemon and then fail every claim for that entry.
    const configuredAddress: unknown = (entry as { buzzAddress?: unknown }).buzzAddress;
    if (configuredAddress !== undefined) {
      if (
        typeof configuredAddress !== "string" ||
        !UUID_PATTERN.test(configuredAddress) ||
        configuredAddress !== configuredAddress.toLowerCase()
      ) {
        throw new Error("CanonicalSelfClaim: config.canonicalSessions[].buzzAddress must be a lower-case channel UUID");
      }
    }
  }
  // Duplicates are refused rather than resolved by first-match. A repeated `sessionUuid` would make
  // one of the two entries dead configuration that reads as live; a repeated `buzzActorId` would
  // construct fine and then be refused at `bindBuzzActor` by the `sessions_buzz_actor` unique index
  // the moment both sessions are live, which is a startup error surfacing as a runtime claim
  // failure; and a repeated `projectId` would give one role key two entitled sessions, which is the
  // one-CTO-per-project property every reader downstream assumes.
  for (const field of ["sessionUuid", "projectId", "buzzActorId"] as const) {
    const values = (canonicalSessions as readonly CanonicalAdoptableSession[]).map((entry) => entry[field]);
    if (new Set(values).size !== values.length) {
      throw new Error(`CanonicalSelfClaim: config.canonicalSessions[].${field} must be unique across entries`);
    }
  }
  return canonicalSessions as readonly CanonicalAdoptableSession[];
};

export interface CanonicalSelfClaimConfig {
  /**
   * The sessions this deployment may adopt, each with the one project it may hold. Required —
   * deployment-private configuration only, sourced from the composition root's own environment.
   * There is no default and no fallback: an empty set constructs nothing, never a silent
   * substitution for a real ID.
   *
   * This is a set rather than a scalar because the deployment runs one session per project and
   * every one of them needs the role. A single pin made the capability this primitive exists for
   * available to exactly one session out of however many the host is running, and the alternative
   * — `CtoLifecycle.spawn` — starts a *new* provider session rather than adopting the live one,
   * which puts a second writer in a checkout a running session already holds.
   */
  canonicalSessions: readonly CanonicalAdoptableSession[];
  /**
   * This deployment's default canonical project Buzz channel: the room of every entry that names
   * no `buzzAddress` of its own. Required — deployment-private configuration only, same
   * no-fallback rule as `canonicalSessions`.
   */
  canonicalBuzzChannelId: string;
  // No executor version, realpath or sha256. Those three were deployment-wide values the claimant's
  // executing image had to equal, which admitted exactly one CLI build per host while every project
  // runs its own session on whichever build it started with. The image is recorded now, not
  // required — see clause 2 in `verifyClaudeIdentity` for what that withdraws.
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
   * The binding generation this claim expects to create. Checked against the actual next
   * generation for `PRIMARY_CTO:<projectId>` inside the transaction; a mismatch means the role's
   * assignment history moved between reading it and claiming it, and denies rather than
   * silently creating a different generation than the caller computed against.
   */
  expectedBindingGeneration: number;
  // No caller-supplied `cwd` field. Nothing compares a working directory any more, but what
  // gets recorded as this binding's `workdir` — and compared against a predecessor's on the
  // idempotent re-claim — is the *derived* `identity.cwd`, read from the actual claude ancestor
  // process. A caller-supplied cwd would be an unused input at best (dead surface a later change
  // could wire up by accident, a shape refused everywhere else in this request) or a claimant
  // naming its own recorded provenance at worst, so it is not a field on this type.
  peerProtocolVersion: string;
  peerIdentity: string;
  // No `buzzChannelId` and no `buzzActorId` field. They used to be request fields that the
  // orchestration filled from deployment configuration and this method then compared back against
  // that same configuration — a real comparison, but of a value the caller had no say in. Now that
  // the actor is per entry it is read from the entry this claim resolves, and the channel from that
  // entry's `buzzAddress` or else `#canonicalBuzzChannelId`, so there is no caller-supplied field
  // left to check. That is the same reasoning the removed comparison itself carried: removing the
  // surface beats guarding it.
  /** Passed to `resolveBuzzAddress` to open the routing channel before the transaction opens. */
  buzzPurpose: string;
}

export interface CanonicalSelfClaimReceipt {
  sessionId: string;
  sessionSecret: string | null;
  binding: RoleBinding;
  derivedSessionUuid: string;
  sessionSource: DerivedClaimantIdentity["sessionSource"];
  /**
   * What the claimant's executing image was observed to be — recorded, never required. `null` when
   * the scan could not run or found no usable image (a binary the updater has already deleted from
   * disk resolves to nothing); the claim is admitted either way.
   */
  executorImageVersion: string | null;
  executorImagePath: string | null;
  buzzAddress: string;
}

export interface CanonicalSelfClaimDeps {
  processInspector?: ProcessAncestryInspector;
  imageInspector?: ExecutingImageInspector;
  transcriptReader?: TranscriptReader;
  hostSessionRegistryReader?: HostSessionRegistryReader;
  maxAncestryHops?: number;
  /**
   * The existence probe `#predecessorProcessIsGone` uses, defaulting to `kill(pid, 0)`.
   *
   * Injectable because a test that wants "this pid is gone" must be able to say *how it knows* —
   * `ESRCH` and `EPERM` are different answers and only one of them may evict an incumbent. Before
   * #842 there was nothing to inject: absence was inferred from `ProcessAncestryInspector.snapshot`
   * returning `null`, which a failed `ps` produces just as readily as a dead process.
   */
  processSignal?: (pid: number) => void;
}

/** Read-only evidence only: no owner authority, session creation or binding writes.
 * callerPid must come from authenticated transport or a deployment-owned session pin,
 * never a delegated request. The native UUID is independently read and compared; the executing
 * image is independently observed and recorded, never compared.
 */
/**
 * What identity verification needs: the set of session UUIDs this caller considers admissible, and
 * nothing else. It used to carry the executor pins as well — a version, a realpath and a sha256 the
 * executing image had to equal — and clause 2 below no longer compares any of them. The daemon's
 * delegated CTO binding still accepts those three in a target's configuration and drops them at
 * parse (`src/daemon/cto-binding-runtime.ts`), so they never reach this function.
 *
 * It is a set of bare UUIDs rather than `CanonicalAdoptableSession` entries because that second
 * caller checks one already-provisioned session and has no project or Buzz identity to entitle;
 * the entitlement half is enforced by `CanonicalSelfClaim` against the entry it resolves, not here.
 */
export interface ClaudeIdentityConfig {
  canonicalSessionUuids: readonly string[];
}
export type ClaudeIdentityRequest = Pick<CanonicalSelfClaimRequest,
  "callerPid" | "claimedPid" | "claimedSessionUuid">;
export interface VerifiedClaudeIdentity {
  identity: DerivedClaimantIdentity;
  /**
   * Observed, not verified: clause 2 resolves it and refuses on nothing it says. It carries
   * `sha256` only when the caller passed an inspector that hashes (`hashingExecutingImageInspector`);
   * the canonical claim's default inspector never does.
   */
  image: ExecutingImageEvidence | ExecutingImageProbeFailure | null;
  transcript: TranscriptEvidence;
}
export function verifyClaudeIdentity(
  config: ClaudeIdentityConfig, request: ClaudeIdentityRequest, deps: CanonicalSelfClaimDeps = {},
  // Canonical claims retain their transport checks at the original ordering points.
  // A daemon-local delegated check has no target peer connection to attest.
  peer?: { protocolVersion: string; identity: string; expectedProtocolVersion: string; expectedIdentity: string },
): Decision<VerifiedClaudeIdentity> {
  const processInspector = deps.processInspector ?? defaultProcessAncestryInspector;
  const imageInspector = deps.imageInspector ?? defaultExecutingImageInspector;
  const transcriptReader = deps.transcriptReader ?? defaultTranscriptReader;
  const registryReader = deps.hostSessionRegistryReader ?? makeDefaultHostSessionRegistryReader();
  // Clause 1 — derive independently before anything the caller said is ever consulted.
  const derived = deriveClaimantIdentity(
    request.callerPid, processInspector, deps.maxAncestryHops ?? MAX_ANCESTRY_HOPS, registryReader,
  );
  if (!derived.allowed) return derived as Decision<VerifiedClaudeIdentity>;
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
  // Membership is tested against `identity.sessionUuid`, which clause 1 derived from process
  // ancestry — never against `request.claimedSessionUuid`. Resolving the admissible entry from
  // what the caller said would move this authority from the deployment's configuration to the
  // claimant, and the comparison a few lines above would then be comparing a value to itself.
  if (!config.canonicalSessionUuids.includes(identity.sessionUuid)) {
    return deny(
      ReasonCode.CONFLICT,
      "only a canonical session may be adopted by this primitive",
      { observed: identity.sessionUuid, canonicalCount: config.canonicalSessionUuids.length },
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
  // The working directory is recorded, not required to equal anything. It used to have to match
  // `ACP_CANONICAL_CTO_WORKDIR` exactly, which meant the canonical CTO could only ever be a
  // session started in one directory — a session the owner opened anywhere else was refused
  // CONFLICT no matter who they were. The role is a job, not a place. That variable, and the
  // `expectedCwd` config field it filled, are now gone: with no comparison left, a configured
  // directory was a value the deployment had to keep correct for nothing to read.
  //
  // Dropping the refusal above along with the comparison it was written about was considered
  // and rejected: `identity.cwd` is still what this claim writes as the binding's `workdir` and
  // still what an idempotent re-claim compares against its predecessor's, so admitting a null
  // here would record "no working directory" as the claimant's, and the next re-claim would read
  // that absence as a changed session. The refusal outlives the comparison.
  // Clause 2 — peer protocol.
  if (peer && peer.protocolVersion !== peer.expectedProtocolVersion) {
    return deny(
      ReasonCode.CONFLICT,
      "peer protocol version does not match the deployment's expected protocol",
      { observed: peer.protocolVersion, expected: peer.expectedProtocolVersion },
    );
  }
  // Clause 2 — the executing image, observed and never required. It is resolved here and carried
  // to the attestation as what the claimant was running; no claim is refused on what it says or on
  // its absence. Which inspector resolves it is the caller's: the canonical claim's reads the path
  // and version and no byte of the image, and the delegated CTO binding passes the hashing one,
  // because its attestation digest is the only reader of the image's `sha256`.
  //
  // It used to have to equal a deployment-wide triple (`ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION`,
  // `ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH`, `ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256`) while the
  // deployment runs one session per project, each on whichever build it was started with. On
  // 2026-09-27, with three such sessions live, one matched the triple, one ran the previous patch
  // release and was refused CONFLICT, and one ran a build the updater had already deleted from
  // disk — which no realpath or sha256 comparison can ever be satisfied by. At most one project
  // could hold the role. The owner withdrew the comparison rather than restart live sessions, and
  // with it went the two refusals that existed only to feed it: an image whose scan could not run
  // (`ExecutingImageProbeFailure`, refused PROBE_FAILED) and one the scan resolved to nothing
  // (`null`, refused CONFLICT). With nothing to compare against, neither says anything about
  // whether this claimant is entitled.
  //
  // What that gives up, stated rather than implied: the realpath+sha256 pair is what refused a
  // renamed binary with a forged adjacent manifest placed at the expected location — a process
  // whose argv[0] reads `claude` while its bytes are something else. `looksLikeClaudeInvocation`
  // checks only the name, so that process is no longer refused here. What remains is the kernel
  // peer credential on the claim socket, the configured session UUID derived from the claimant's
  // own argv, and the project that UUID's entry names.
  const image = imageInspector.resolve(identity.pid);
  // Clause 2 — pid/startedAt re-verified immediately after the image resolution. Both the ancestry
  // walk and this image resolution did real, non-instantaneous I/O; a pid reused in between
  // must be caught here, before the transcript check or the async Buzz boundary below run
  // anything else against `identity.pid` as though it still names the verified process.
  const stillLiveAfterImage = assertClaudeIdentityStillLive(identity, processInspector, registryReader);
  if (!stillLiveAfterImage.allowed) return stillLiveAfterImage as Decision<VerifiedClaudeIdentity>;
  // Clause 2 — the transcript.
  const transcript = transcriptReader.locate(identity.sessionUuid);
  if (!transcript) {
    return deny(
      ReasonCode.NOT_FOUND,
      "no transcript exists on disk for the derived conversational actor",
      { sessionUuid: identity.sessionUuid },
    );
  }
  // Clause 2 — the connected peer identity.
  if (peer && peer.identity !== peer.expectedIdentity) {
    return deny(
      ReasonCode.CONFLICT,
      "connected peer identity does not match the deployment's expected peer",
      { observed: peer.identity, expected: peer.expectedIdentity },
    );
  }
  return allow(ReasonCode.OK, { identity, image, transcript });
}

/**
 * Re-verifies an identity `deriveClaimantIdentity` established earlier, at a later checkpoint: the
 * process at `identity.pid` still has the verified start token, *and* deriving its session again —
 * argv and host registry, with every check the first derivation ran — still yields the UUID verified earlier.
 * A process keeps its pid and start token across an in-process `/resume`, so the start token alone
 * cannot see the session change; the re-derivation can, and it refuses rather than substituting
 * either the new session or the one the request named.
 *
 * The re-derivation starts at `identity.pid` itself and walks no further: the claimant is that
 * process, and an ancestor it no longer looks like is not one to climb past. It reuses the snapshot
 * just taken for the start-token check, so each checkpoint scans the process once.
 */
export function assertClaudeIdentityStillLive(
  identity: DerivedClaimantIdentity,
  inspector: ProcessAncestryInspector = defaultProcessAncestryInspector,
  registryReader: HostSessionRegistryReader = makeDefaultHostSessionRegistryReader(),
): Decision<true> {
  const snapshot = inspector.snapshot(identity.pid);
  const observed = snapshot?.startedAt ?? null;
  if (observed !== identity.startedAt) {
    return deny(
      ReasonCode.CONFLICT,
      "the claimant process's start time no longer matches the identity verified earlier in this claim — its pid may have been reused",
      { pid: identity.pid, verifiedStartedAt: identity.startedAt, observedStartedAt: observed },
    );
  }
  const pinned: ProcessAncestryInspector = {
    snapshot: (pid) => pid === identity.pid ? snapshot : inspector.snapshot(pid),
    // The after-read start-token check must reach the kernel again, never the pinned snapshot.
    readStartToken: (pid) => inspector.readStartToken !== undefined
      ? inspector.readStartToken(pid)
      : inspector.snapshot(pid)?.startedAt ?? null,
  };
  const rederived = deriveClaimantIdentity(identity.pid, pinned, 1, registryReader);
  if (!rederived.allowed) {
    return deny(
      rederived.reasonCode,
      `the claimant's session could not be derived again at this checkpoint: ${rederived.message}`,
      { pid: identity.pid },
    );
  }
  // The pid needs no comparison: a one-hop derivation starting at `identity.pid` answers for it alone.
  if (rederived.value.sessionUuid !== identity.sessionUuid) {
    return deny(
      ReasonCode.CONFLICT,
      "the claimant process's session changed after its identity was verified in this claim",
      { pid: identity.pid, verifiedSessionUuid: identity.sessionUuid, observedSessionUuid: rederived.value.sessionUuid },
    );
  }
  return allow(ReasonCode.OK, true);
}

/** What a claim asked for, read from the caller's request before `claim()` first awaits. */
interface ClaimAsked {
  claimedSessionUuid: string;
  projectId: string;
}

/**
 * The audit row for one decision `CanonicalSelfClaim.claim()` returns.
 *
 * Only the reason code and identifiers cross into the record. The decision's `message` and
 * `evidence` do not: between them they can carry an executor image path, a transcript path, or a
 * Buzz transport's own error text, none of which is the claimant's to put in a durable log. The
 * receipt's `sessionSecret` is never read.
 *
 * The claimed session is recorded only when it has the shape of one. The first refusal in `claim`
 * is exactly the case where it does not, and there it is arbitrary caller text.
 *
 * A refusal's project is recorded only when it names a row in `projects`, and is otherwise null.
 * The request's `projectId` is any nonempty string the caller sent, so without that bound a refused
 * claim could put a private path or a token into a durable log verbatim — the same exposure that
 * keeps `message` and `evidence` off the row, and `AuditLog.record` redacts only `evidence`. The
 * registry is the existing authority for what a project id is; this adds no second one, no pattern
 * and no length cap. A null project loses less than a verbatim secret, and the reason code stays.
 *
 * An admission names the project from the binding, not from the request: the entitlement is what
 * decided the project, and the request is the caller's object.
 */
const claimDecisionAuditRecord = (
  asked: ClaimAsked,
  decision: Decision<CanonicalSelfClaimReceipt>,
  isRegisteredProject: (projectId: string) => boolean,
): AuditRecord => {
  if (decision.allowed) {
    return {
      kind: "CANONICAL_SELF_CLAIM_ADMITTED",
      reasonCode: decision.reasonCode,
      projectId: decision.value.binding.projectId,
      sessionId: decision.value.sessionId,
      roleKey: decision.value.binding.roleKey,
      evidence: {
        identity: decision.value.derivedSessionUuid,
        generation: decision.value.binding.bindingGeneration,
        // Only the registry source is named: an admission row without the key is an argv-derived
        // identity, which is what every row written before the registry fallback existed means.
        ...(decision.value.sessionSource === "host-session-registry" ? { sessionSource: decision.value.sessionSource } : {}),
      },
    };
  }
  return {
    kind: "CANONICAL_SELF_CLAIM_REFUSED",
    reasonCode: decision.reasonCode,
    projectId: isRegisteredProject(asked.projectId) ? asked.projectId : null,
    evidence: { identity: UUID_PATTERN.test(asked.claimedSessionUuid) ? asked.claimedSessionUuid : null },
  };
};

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
  readonly #processSignal: (pid: number) => void;
  readonly #imageInspector: ExecutingImageInspector;
  readonly #transcriptReader: TranscriptReader;
  readonly #hostSessionRegistryReader: HostSessionRegistryReader;
  readonly #maxAncestryHops: number;
  readonly #canonicalBuzzChannelId: string;
  readonly #canonicalSessions: readonly CanonicalAdoptableSession[];

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    /** Where every decision `claim()` returns is recorded; see `claim()` and `claimDecisionAuditRecord`. */
    private readonly audit: AuditLog,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    /** Authenticates `buzzActorId` for `SessionRegistry.bindBuzzActor` (deployment ingress policy). */
    private readonly buzzActorAuthenticator: BuzzActorAuthenticator,
    /**
     * Opens the Buzz routing channel `channelId` names and returns its address. Async and shells a
     * CLI transport (`BuzzAdapter.connect` → `BuzzTransport.openChannel`), so it must run — and
     * does, in `claim()` — *before* the synchronous transaction opens; `Db.txDecision`'s body
     * cannot await. `channelId` is the claiming entry's room (`canonicalBuzzChannelFor`), so a
     * per-entry room is opened exactly the way the deployment's default one is.
     */
    private readonly resolveBuzzAddress: (purpose: string, channelId: string) => Promise<Decision<string>>,
    private readonly config: CanonicalSelfClaimConfig,
    deps: CanonicalSelfClaimDeps = {},
  ) {
    // Fail closed before any effect: the channel is deployment-private configuration with no
    // fallback to a real value. A blank string (an absent env var coerced by a caller, or a typo
    // in the composition root) must construct nothing, never silently adopt a hardcoded default.
    // One row since the three executor pins that shared this table were withdrawn.
    for (const [field, value] of [
      ["canonicalBuzzChannelId", config.canonicalBuzzChannelId],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(
          `CanonicalSelfClaim: config.${field} is required deployment configuration and was missing or empty`,
        );
      }
    }
    // Shape, emptiness, the bound, blank and padded fields, UUID form and uniqueness all live in
    // `assertCanonicalSessionsValid`, which the composition root also calls at startup. Holding
    // half the rule here was how an invalid set got a started listener and a per-claim throw.
    const validatedSessions = assertCanonicalSessionsValid(config.canonicalSessions);

    this.#processInspector = deps.processInspector ?? defaultProcessAncestryInspector;
    this.#processSignal = deps.processSignal ?? ((pid) => process.kill(pid, 0));
    this.#imageInspector = deps.imageInspector ?? defaultExecutingImageInspector;
    this.#transcriptReader = deps.transcriptReader ?? defaultTranscriptReader;
    this.#hostSessionRegistryReader = deps.hostSessionRegistryReader ?? makeDefaultHostSessionRegistryReader();
    this.#maxAncestryHops = deps.maxAncestryHops ?? MAX_ANCESTRY_HOPS;
    this.#canonicalBuzzChannelId = config.canonicalBuzzChannelId;
    // Frozen at construction, like every other deployment fact here: a later mutation of the array
    // the composition root passed must not change which sessions this instance will adopt.
    this.#canonicalSessions = validatedSessions.map((entry) => Object.freeze({ ...entry }));
  }

  /**
   * Every decision this hands back — each refusal and the admission — leaves one row, and every
   * refusal's row is written here, once, on its way out. Recorded at this one boundary rather than
   * beside each `deny`: this file alone has over thirty, more arrive from what it composes, and a
   * record written per site means the next refusal someone adds has no row. That absence is what
   * hid a weeks-long adoption outage.
   *
   * The admission's row is not written here. It is written in `#mutate`, inside the transaction
   * that commits the admission, so the two land or roll back together. Written here, after that
   * commit, a failed insert threw out of a claim whose session, binding and generation bump were
   * already durable: the listener answered `INTERNAL_ERROR` while the database said the claim had
   * succeeded. Inside, a failed insert rolls the admission back and the claim refuses with
   * `AUDIT_WRITE_FAILED`, and that refusal is recorded here like any other.
   *
   * A refusal commits nothing, so its row has no transaction to join. An insert that fails here is
   * swallowed rather than allowed to escape: a refusal must reach its caller with its own reason
   * code, not as a throw the listener turns into `INTERNAL_ERROR`. That refusal is then left with
   * no row, and nothing else records that its row was lost.
   *
   * What was asked is read before the first `await`. `request` is the caller's object and the
   * Buzz-address resolution hands control away, so reading it afterwards would record whatever the
   * caller changed it to rather than what it claimed.
   *
   * A claim that *throws* is not a returned decision and is not recorded here.
   */
  async claim(request: CanonicalSelfClaimRequest): Promise<Decision<CanonicalSelfClaimReceipt>> {
    const asked = { claimedSessionUuid: request.claimedSessionUuid, projectId: request.projectId };
    const decision = await this.#decide(request, asked);
    // Its row was committed with it; writing one here as well would be the admission's second.
    if (decision.allowed) return decision;
    try {
      this.audit.record(claimDecisionAuditRecord(asked, decision, (projectId) => this.#isRegisteredProject(projectId)));
    } catch {
      // Deliberately empty: the refusal stands without its row. See the docblock above.
    }
    return decision;
  }

  /**
   * Whether `projectId` names a row in `projects`, for the audit record alone. It decides nothing
   * about the decision. A lookup that fails answers "not registered": the record then carries a
   * null project, and neither the decision nor its reason code changes, nor does the failure
   * escape `claim()`.
   *
   * Which state it reads depends on where the record is built. A refusal's row is built in
   * `claim()` after `#decide` has returned, when any transaction has already rolled back, so the
   * lookup reads committed state after the decision is final. The admission's row is built inside
   * the admission's own transaction, where this lookup would read that transaction's snapshot —
   * but an admission names its project from the binding, so `claimDecisionAuditRecord` never
   * consults the lookup for one.
   */
  #isRegisteredProject(projectId: string): boolean {
    try {
      return this.db.get(`SELECT 1 FROM projects WHERE project_id = ?`, [projectId]) !== undefined;
    } catch {
      return false;
    }
  }

  async #decide(request: CanonicalSelfClaimRequest, asked: ClaimAsked): Promise<Decision<CanonicalSelfClaimReceipt>> {
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

    // No owner approval is required or read here. This claim used to demand a `(channel, nonce)`
    // handle naming a decision an owner had minted beforehand, which meant the canonical CTO role
    // could only be (re)bound after a human typed a command — measured on this deployment, four
    // such mints between 2026-09-08 and 2026-09-13 and then nothing, so the role sat unbound for
    // eight days and every Buzz mention in that window was delivered nowhere. On a single-owner
    // local deployment that gate bought no authority it did not already have: the claim still
    // authenticates by kernel peer credential on its own socket, still derives the claimant's
    // identity from process ancestry rather than accepting it, and still refuses a generation the
    // assignment history did not hand it. What it removes is the human in the loop.
    const verified = verifyClaudeIdentity({
      ...this.config,
      canonicalSessionUuids: this.#canonicalSessions.map((entry) => entry.sessionUuid),
    }, request, {
      processInspector: this.#processInspector, imageInspector: this.#imageInspector,
      transcriptReader: this.#transcriptReader, hostSessionRegistryReader: this.#hostSessionRegistryReader,
      maxAncestryHops: this.#maxAncestryHops,
    }, { protocolVersion: request.peerProtocolVersion, identity: request.peerIdentity,
      expectedProtocolVersion: this.config.expectedPeerProtocolVersion, expectedIdentity: this.config.expectedPeerIdentity });
    if (!verified.allowed) return verified;
    const { identity, image, transcript } = verified.value;
    // Entitlement. `verifyClaudeIdentity` has established that the derived session is one this
    // deployment may adopt; this establishes that the project it is asking to hold is the one that
    // session is configured for. The two used to be a single fact by accident of there being one
    // entry: a session that passed the pin could name whichever `projectId` its request carried,
    // and `roleKeyFor` below would assemble `PRIMARY_CTO:<that project>` from it. Resolved on the
    // derived UUID, never on `request.claimedSessionUuid`.
    const entry = this.#canonicalSessions.find((candidate) => candidate.sessionUuid === identity.sessionUuid);
    if (!entry) {
      // Unreachable while this instance hands `verifyClaudeIdentity` the UUIDs of these same
      // entries, and refused rather than asserted because "unreachable" is a property of today's
      // composition and this is the seam where the two sets could stop agreeing.
      return deny(
        ReasonCode.CONFLICT,
        "the adopted session has no configured entry",
        { observed: identity.sessionUuid },
      );
    }
    if (entry.projectId !== request.projectId) {
      return deny(
        ReasonCode.CONFLICT,
        "this session is not the canonical CTO for the requested project",
        { observed: request.projectId, entitled: entry.projectId },
      );
    }
    // The Buzz routing address is resolved here, before the synchronous transaction opens, never
    // awaited inside it. `sessions.create` accepts `buzzAddress` directly, so the resolved value
    // is written in the same transaction as everything else even though resolving it could not
    // run inside that transaction. The room is the entry's, never the request's: the entitlement
    // resolved above is what names it.
    const buzzAddress = await this.resolveBuzzAddress(
      request.buzzPurpose,
      canonicalBuzzChannelFor(entry, this.#canonicalBuzzChannelId),
    );
    if (!buzzAddress.allowed) return buzzAddress as Decision<CanonicalSelfClaimReceipt>;
    // Clause 2 — pid/startedAt re-verified again here. This `await` is the real TOCTOU window:
    // control left this process entirely (a shelled Buzz CLI transport), for however long that
    // took, before returning. A pid reused during that gap must be caught before `#mutate` ever
    // opens its transaction and writes `identity.pid` as though it were still the verified one.
    // The session is derived again here too: a `/resume` during that await keeps the pid and start
    // token and changes the session, and the UUID derived before it must not be bound (#1035).
    const stillLiveAfterBuzz = this.#assertClaimantStillLive(identity);
    if (!stillLiveAfterBuzz.allowed) return stillLiveAfterBuzz as Decision<CanonicalSelfClaimReceipt>;

    // Clause 3 — one atomic mutation, or none. Every identity and authority check above is over;
    // nothing past this point may refuse for a reason this transaction cannot also undo.
    return this.#mutate(request, asked, identity, image, transcript, buzzAddress.value, entry);
  }

  /**
   * Re-verifies the immutable `(pid, startedAt)` adoption identity `deriveClaimantIdentity`
   * established at clause 1, at a point later than that derivation, and derives the claimant's
   * session again through the same registry reader (#1035): the session a live process runs can
   * change under an unchanged pid and start token. `identity.startedAt` is
   * guaranteed non-null here — clause 2's own null check above already denied that case — so this
   * is always a real string-to-string comparison, never a vacuous pass on two nulls.
   *
   * Goes through `this.#processInspector`, the same seam `deriveClaimantIdentity` itself used —
   * never the raw `readProcessStartToken` OS call directly. A test that fakes process ancestry (a
   * synthetic pid with no real corresponding OS process) must re-verify against that same fake,
   * not against a real kernel lookup for a pid that was never real to begin with.
   */
  #assertClaimantStillLive(identity: DerivedClaimantIdentity): Decision<true> {
    return assertClaudeIdentityStillLive(identity, this.#processInspector, this.#hostSessionRegistryReader);
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
   * OS process. The start token is still read through the `#processInspector` seam
   * `deriveClaimantIdentity` and `#assertClaimantStillLive` use, so a test with a synthetic
   * ancestry is answered by that same fake; *existence* is a separate question and now has its own
   * injectable probe.
   *
   * "Unknown" is never "gone". An unrecorded pair, a pid whose existence could not be established,
   * and a pid that exists but whose start token cannot be read all return `false` and leave the
   * strict same-live branch engaged: widening this from "proven dead" to "not proven alive" is the
   * single edit that would turn recovery into eviction of a live holder whose probe merely failed.
   *
   * **That edit was present until #842.** The paragraph above was already here, and the line below
   * it read `if (observed === null) return true`. A `null` from `snapshot` is not "proven dead":
   * `defaultProcessAncestryInspector` returns `null` whenever `psField` does, and `psField` ends
   * `catch { return null }`, which is equally a pid that does not exist, a `ps` that outlived
   * `SUBPROCESS_TIMEOUT_MS`, and a fork that failed. So a five-second `ps` hiccup during a claim
   * declared a live incumbent gone and let a challenger take the role. The doc was right and the
   * code did the opposite of it.
   *
   * **This also moves where existence is decided, and that is a second behaviour change.** The old
   * branch judged existence from `ps` (the ancestry snapshot); this one judges it from
   * `kill(pid, 0)`. Measured across every combination of `(pid, recorded token, snapshot answer,
   * signal answer)`, the two disagree in 23 of 128 — 21 of them the fail-closed direction this
   * change is for, and **two the other way**: when the kernel says `ESRCH` while `ps` still shows
   * the process, the old code refused and this one evicts. `probeSessionLiveness` signals first
   * and returns `DEAD` on `ESRCH` before the start-token probe runs at all, so the snapshot's
   * answer stops mattering. That is the right authority — `kill` asks the kernel now, `ps` output
   * can be older — but it is a widening, and a reader comparing this to the old branch should not
   * have to rediscover it. `EPERM` stays `ALIVE`, which is the case where a live process cannot be
   * signalled, and both versions refuse there.
   *
   * `probeSessionLiveness` (`../daemon/dead-binding-recovery.ts`) already answers exactly this
   * question in three values for exactly this reason — its own comment says `EPERM` "means the pid
   * exists and belongs to someone else, and reading that as dead would let a live incumbent be
   * evicted by a caller who cannot even signal it". Reusing it is what keeps one deployment from
   * holding two different definitions of "that process is gone"; only `DEAD` may evict, and
   * `UNKNOWN` joins the fail-closed answers above.
   */
  #predecessorProcessIsGone(osPid: number | null, osProcessStartedAt: string | null): boolean {
    if (osPid === null || osProcessStartedAt === null) return false;
    return (
      probeSessionLiveness(osPid, osProcessStartedAt, {
        signal: this.#processSignal,
        startedAt: (pid) => this.#processInspector.snapshot(pid)?.startedAt ?? null,
      }) === "DEAD"
    );
  }

  #mutate(
    request: CanonicalSelfClaimRequest,
    /** What `claim()` read from `request` before its first await; the admission's row is built from it. */
    asked: ClaimAsked,
    identity: DerivedClaimantIdentity,
    image: VerifiedClaudeIdentity["image"],
    transcript: TranscriptEvidence,
    buzzAddress: string,
    /**
     * The configured entitlement `claim` resolved on the derived UUID and already checked against
     * `request.projectId`. Passed in rather than looked up again here: a second lookup would be a
     * second authority over the same fact, and this transaction would be free to write a Buzz
     * actor id belonging to a different entry than the one the entitlement check passed.
     */
    entry: CanonicalAdoptableSession,
  ): Decision<CanonicalSelfClaimReceipt> {
    // An observation, never an authority (clause 2): a scan that could not run and a scan that
    // found no usable image are both recorded as no image, and neither refused anything upstream.
    // The second is already `null`; the type guard folds the first into it.
    const observedImage = isExecutingImageProbeFailure(image) ? null : image;
    // `db.txDecision` — not `db.tx` — is load-bearing here. `tx()` treats a denied `Decision` as
    // an ordinary return value and commits it; a nested `bindings.bind()` denial (BindingRegistry
    // uses `txDecision` itself, which at depth > 0 just hands the Decision back as data rather
    // than throwing) would otherwise be committed together with the session row already written
    // below. Only the outermost `txDecision` turns a propagated denial into a real ROLLBACK.
    return this.db.txDecision((): Decision<CanonicalSelfClaimReceipt> => {
      // The owner approved this exact next generation for this exact role key. Checked before any
      // write — including before the owner approval is consumed — so a stale expectation denies
      // with nothing to roll back yet.
      // `entry.projectId`, never `request.projectId`. They were compared before the Buzz-address
      // await, and `request` is the caller's object: a caller holding a reference could change
      // `projectId` during that await and this key would name the project the entitlement never
      // authorized. The entitlement is the authority, so it is what assembles the role key.
      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: entry.projectId });
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

      // A live canonical actor may replace only its exact revoked runtime attachment (the same-live
      // branch). Dead-process recovery happens only in the #831 branch, only for this same actor's
      // own binding, and grants no authority over another holder.
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
      if (incumbent && predecessor && predecessorRuntimeIsGone) {
        // Falling through alone does not reach the ordinary claim: `sessions_buzz_actor` is a
        // partial unique index over *live* rows, so a dead runtime left at READY keeps the
        // canonical Buzz identity and the ordinary claim below dies at `bindBuzzActor` with
        // SESSION_BUZZ_ACTOR_ALREADY_BOUND instead of CONFLICT — measured, same refusal, different
        // code. The restore path this claim then takes states the same precondition (a genuine
        // restart leaves the old session terminal), so the row is reconciled to the process fact
        // below, inside this transaction, and rolls back with everything else if anything denies.
        // A row that is already STOPPED or ERROR already says so and is left as written.
        if (predecessor.lifecycle !== SessionLifecycle.STOPPED && predecessor.lifecycle !== SessionLifecycle.ERROR) {
          abandonedRuntimeSessionId = predecessor.sessionId;
        }
        // Policy change (2026-10-02): the dead predecessor may still hold the role ACTIVE, because
        // nothing revokes an assignment when its process dies, and `bind` below then refused the
        // restarted canonical session BINDING_ALREADY_ACTIVE — locked out of its own role until an
        // operator ran `binding recover-dead`. Keeping that refusal and leaving the release to the
        // operator door was rejected: a restarted canonical session must recover its own role
        // without owner authority, and the proof that bounds it is the one that door applies.
        // When the holder is this same actor (the UUID derived and verified above), the release is
        // made here by `recoverDeadCanonicalBinding` itself, not a copy of its rule: the same
        // DEAD-only proof over this claim's own seam, the same revoke and the same
        // DEAD_BINDING_RECOVERED record, inside this transaction so it lands only together with
        // the successor generation. Another actor's binding is not this claim's
        // to release and is left for `bind` to refuse; ALIVE, EPERM and UNKNOWN never reach here.
        // Policy change (2026-10-02, later): this used to require a non-terminal row as well, and
        // a daemon restart is exactly what makes the row terminal — its reconcile moves every
        // live session whose pid is gone to ERROR and revokes nothing — so the commonest restart
        // still refused BINDING_ALREADY_ACTIVE. The row's lifecycle decides only whether it is
        // reconciled; whether the binding is released is still the probe's answer alone.
        const held = this.db.get<{ actor_id: string }>(
          `SELECT actor_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
          [roleKey],
        );
        if (held?.actor_id === incumbent.actor_id) {
          // The entitlement's project, never the request's, for the reason the role key is.
          const { projectId } = entry;
          // The seam `#predecessorProcessIsGone` reads, so the start token is compared in the
          // format this claim recorded it and the two reads cannot disagree about one row.
          const startedAt = (pid: number) => this.#processInspector.snapshot(pid)?.startedAt ?? null;
          const released = recoverDeadCanonicalBinding(`canonical-self-claim:${incumbent.actor_id}`, {
            projectId,
            role: Role.PRIMARY_CTO,
            sessionId: predecessor.sessionId,
            sessionIncarnation: predecessor.incarnation,
            expectedBindingGeneration: currentMax,
          }, {
            db: this.db,
            audit: this.audit,
            sessions: this.sessions,
            bindings: this.bindings,
            liveness: { signal: this.#processSignal, startedAt },
          });
          if (!released.allowed) return released as Decision<CanonicalSelfClaimReceipt>;
        }
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
            predecessor.workdir !== identity.cwd || predecessor.buzzActorId !== entry.buzzActorId ||
            predecessor.buzzAddress !== buzzAddress || predecessor.provider !== "claude" ||
            predecessor.model !== "claude-cli") {
          return deny(ReasonCode.CONFLICT, "same-live recovery requires the exact idle revoked runtime", {});
        }
        predecessorSessionId = predecessor.sessionId;
      }

      // Clause 2 — pid/startedAt and the derived session re-verified one last time, at the commit
      // boundary itself, inside this transaction. Everything before the transaction ran outside it
      // (including the async Buzz-resolution await), and the predecessor probes above — the
      // release's included — signal and shell out to `ps` inside it: real time in which the
      // claimant can `/resume` into another conversation or lose its pid to reuse. So this check
      // was moved here, after the last process read the transaction makes, rather than repeated
      // (ACP1039-R1-01: it used to sit before the probes, and a claimant that changed during the
      // release committed under its old identity); a refusal here rolls the release back with
      // everything else. A further check just before `bind` was rejected: nothing from here to the
      // commit leaves this process, so it would re-read the same facts without closing a window.
      // Any process read added to this transaction later belongs above this line.
      const stillLiveAtCommit = this.#assertClaimantStillLive(identity);
      if (!stillLiveAtCommit.allowed) return stillLiveAtCommit as Decision<CanonicalSelfClaimReceipt>;

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
        { sessionId: created.sessionId, sessionSecret: created.sessionSecret, buzzActorId: entry.buzzActorId },
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
        executorImagePath: observedImage?.imagePath ?? null,
        executorVersion: observedImage?.version ?? null,
        transcriptPath: transcript.path,
        transcriptSizeBytes: transcript.sizeBytes,
        peerProtocolVersion: request.peerProtocolVersion,
        peerIdentity: request.peerIdentity,
        buzzChannelId: canonicalBuzzChannelFor(entry, this.#canonicalBuzzChannelId),
        buzzActorId: entry.buzzActorId,
        buzzAddress,
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
        // Same authority as the role key above, for the same reason.
        projectId: entry.projectId,
        sessionId: created.sessionId,
        mode: "PREFERRED",
        authenticatedTarget,
      });
      if (!bound.allowed) return bound as Decision<CanonicalSelfClaimReceipt>;

      const admitted = allow(ReasonCode.OK, {
        sessionId: created.sessionId,
        sessionSecret: created.sessionSecret,
        binding: bound.value,
        derivedSessionUuid: identity.sessionUuid,
        sessionSource: identity.sessionSource,
        executorImageVersion: observedImage?.version ?? null,
        executorImagePath: observedImage?.imagePath ?? null,
        buzzAddress,
      });
      // The admission's row, last, inside this transaction: the admission commits only with its
      // row, and a failed insert takes the session, the binding and the generation bump back with
      // it. `better-sqlite3` throws on a constraint, a busy database or a full disk; the throw is
      // caught here and returned as a denial so `txDecision` rolls back and hands a refusal to
      // `claim()`, never an exception to the listener. Only this insert is caught — a throw from
      // anything above still propagates as a throw.
      try {
        this.audit.record(claimDecisionAuditRecord(asked, admitted, (projectId) => this.#isRegisteredProject(projectId)));
      } catch (error) {
        return deny(
          ReasonCode.AUDIT_WRITE_FAILED,
          "the admission's audit row could not be written, so the admission was rolled back",
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      return admitted;
    });
  }
}
