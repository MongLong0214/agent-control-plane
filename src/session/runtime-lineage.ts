import { execFileSync } from "node:child_process";

import { type Decision, allow, deny } from "../core/errors.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * Whether a kernel-authenticated peer is running inside the process a runtime row recorded
 * (#1037).
 *
 * A session row records `os_pid` and the start of that process. A peer the kernel vouches for —
 * same uid, direct connection — that descends from exactly that process is a child the runtime
 * itself started: an MCP server its host spawned, a relay, a hook. That is an identity the
 * process cannot hand to anything it did not start, so a secret proving the same thing a second
 * time adds nothing, and a secret that was dropped (incumbent adoption keeps none) no longer locks
 * the runtime out of its own tools.
 *
 * What it does not prove: anything about which conversation or turn inside that process is
 * calling. Callers that need that ask for it separately.
 *
 * Every refusal is its own statement; no condition here is an operand of an `&&`/`||` chain.
 */

const MAX_ANCESTRY_HOPS = 64;

/** What this check reads about processes. Injected so a test can state a process tree. */
export interface ProcessLineageReader {
  parentOf(pid: number): number | null;
  /** Native start token (`darwin-tv:sec.usec`): the exact form, and the only one compared. */
  startToken(pid: number): string | null;
}

/**
 * `ps -o ppid=`, bounded like every other `ps` read here. Not the canonical claim's ancestry
 * inspector: that one also runs lsof and reads argv on every hop, and this question needs neither.
 */
const parentPid = (pid: number): number | null => {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const defaultProcessLineageReader: ProcessLineageReader = {
  parentOf: parentPid,
  startToken: readProcessStartToken,
};

/**
 * The runtime row a lineage admission settled on, as a value only this module mints (#1037).
 *
 * A consumer that writes on a runtime's behalf — the one writer of `sessions.buzz_actor_id` — takes
 * this in place of the session secret: it was issued by `admitRuntimeLineage` and nothing else, so
 * holding one means the admission happened, and the consumer re-derives nothing. A structurally
 * identical object built anywhere else is not one (`isAdmittedRuntime`).
 */
export interface AdmittedRuntime {
  readonly sessionId: string;
  readonly sessionIncarnation: string;
}

const ADMITTED_RUNTIMES = new WeakSet<object>();

export const isAdmittedRuntime = (value: unknown): value is AdmittedRuntime => {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  return ADMITTED_RUNTIMES.has(value);
};

/** The runtime row's process, as the check found it running. */
export interface RuntimeLineage {
  pid: number;
  /** The live native start token, for a caller that compares it against another report. */
  startToken: string;
  /** The admitted row, for a consumer that acts as it. */
  runtime: AdmittedRuntime;
}

/**
 * The durable, write-once native start pinned for a runtime row's process when it was created or
 * adopted. `SessionRegistry` keeps it; this module only reads it, and no admission writes one.
 */
export interface NativeStartPins {
  pinnedNativeStart(sessionId: string): string | null;
}

const refuse = (message: string): Decision<RuntimeLineage> => deny(ReasonCode.CONFLICT, message, {});

/**
 * Is the live process at the row's pid the one the row recorded? Exact or refused, in two cases:
 *
 *   - the row recorded the native token (the canonical claim does): equal, or not this process;
 *   - the row recorded `ps` lstart (incumbent adoption, and every row `create()` writes without a
 *     verified pair) and the token pinned beside it: equal to the pin, or not this process.
 *
 * A row with neither — lstart and no pin — is refused, whatever its lstart says. The lstart rule
 * that decided such a row once (written after its start second, then pinned) is deleted rather
 * than narrowed to the adopted CEO row that relied on it. The decision that reviewed it (efb9dbd0)
 * allowed keeping it for that one row only, and the row's process ended with the Gateway redeploy
 * of 2026-10-03, so the stricter option was taken. The risk that rule carried — a pid reused
 * inside the same second, which no lstart can see — went with it: the path is deleted, not made
 * safe. A runtime refused for want of a pin is re-adopted, and adoption pins the exact token.
 *
 * The pin is compared exactly whoever wrote it. The unread-capacity keep (#1045) still pins an
 * lstart row by its own lstart rule, and a row it pinned is admitted here on that pin.
 *
 * Writes nothing. Exported for the Gateway delivery authority, which asks the same question of
 * the same row.
 */
export const recordedStartIsLive = (
  runtime: { sessionId: string; osProcessStartedAt: string },
  startToken: string,
  pins: Pick<NativeStartPins, "pinnedNativeStart">,
): Decision<null> => {
  if (runtime.osProcessStartedAt === startToken) return allow(ReasonCode.OK, null);
  const pinned = pins.pinnedNativeStart(runtime.sessionId);
  if (pinned === null) {
    return deny(
      ReasonCode.CONFLICT,
      "the runtime row has no exact start to compare: it recorded no native start and none is pinned for it",
      {},
    );
  }
  if (pinned !== startToken) {
    return deny(ReasonCode.CONFLICT, "the runtime's pid now belongs to another process", {});
  }
  return allow(ReasonCode.OK, null);
};

/**
 * Admits `peerPid` only when the runtime's recorded process is alive as recorded and is a proper
 * ancestor of the peer. The peer itself is never its own proof.
 *
 * "Alive as recorded" is `recordedStartIsLive`: an exact native-token comparison, against the row
 * or against the token pinned for it, and nothing else. Nothing here writes.
 */
export const admitRuntimeLineage = (
  peerPid: number,
  runtime: {
    sessionId: string;
    incarnation: string;
    osPid: number | null;
    osProcessStartedAt: string | null;
  },
  processes: ProcessLineageReader,
  pins: Pick<NativeStartPins, "pinnedNativeStart">,
): Decision<RuntimeLineage> => {
  const pid = runtime.osPid;
  const recorded = runtime.osProcessStartedAt;
  if (pid === null) return refuse("the runtime recorded no process");
  if (recorded === null) return refuse("the runtime recorded no process start");
  const startToken = processes.startToken(pid);
  if (startToken === null) return refuse("the runtime's process is not running");
  const live = recordedStartIsLive({ sessionId: runtime.sessionId, osProcessStartedAt: recorded }, startToken, pins);
  if (!live.allowed) return live as Decision<RuntimeLineage>;

  const visited = new Set<number>([peerPid]);
  let current = processes.parentOf(peerPid);
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop += 1) {
    if (current === null) break;
    if (current === pid) {
      const admitted: AdmittedRuntime = Object.freeze({
        sessionId: runtime.sessionId,
        sessionIncarnation: runtime.incarnation,
      });
      ADMITTED_RUNTIMES.add(admitted);
      return allow(ReasonCode.OK, { pid, startToken, runtime: admitted });
    }
    if (current <= 1) break;
    if (visited.has(current)) break;
    visited.add(current);
    current = processes.parentOf(current);
  }
  return refuse("the caller does not descend from the runtime's process");
};
