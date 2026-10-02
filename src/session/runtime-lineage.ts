import { execFileSync } from "node:child_process";

import { type Decision, allow, deny } from "../core/errors.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { processStartedAt } from "../core/process-identity.ts";
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
  /** Native start token (`darwin-tv:sec.usec`): the exact form. */
  startToken(pid: number): string | null;
  /** `ps -o lstart=`: the form `SessionRegistry.create` records when not handed a verified pair. */
  startedAt(pid: number): string | null;
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
  startedAt: processStartedAt,
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

const refuse = (message: string): Decision<RuntimeLineage> => deny(ReasonCode.CONFLICT, message, {});

/**
 * Admits `peerPid` only when the runtime's recorded process is alive as recorded and is a proper
 * ancestor of the peer. The peer itself is never its own proof.
 *
 * The recorded start is compared in whichever of the two forms the row holds — the canonical
 * claim stores the native token, `SessionRegistry.create` without a verified pair stores `ps`
 * lstart. Both are read from the live process at that pid, so either matching means that pid has
 * not been reused since the row was written; lstart's one-second grain is why a caller holding an
 * independent native report (the adopted Gateway's `gatewayOrigin`) also compares `startToken`.
 */
export const admitRuntimeLineage = (
  peerPid: number,
  runtime: { sessionId: string; incarnation: string; osPid: number | null; osProcessStartedAt: string | null },
  processes: ProcessLineageReader,
): Decision<RuntimeLineage> => {
  const pid = runtime.osPid;
  const recorded = runtime.osProcessStartedAt;
  if (pid === null) return refuse("the runtime recorded no process");
  if (recorded === null) return refuse("the runtime recorded no process start");
  const startToken = processes.startToken(pid);
  if (startToken === null) return refuse("the runtime's process is not running");
  const recordedHere = recorded === startToken ? true : recorded === processes.startedAt(pid);
  if (!recordedHere) return refuse("the runtime's pid now belongs to another process");

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
