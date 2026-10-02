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
  /**
   * The native token to pin for a legacy row this admission decided, or null. Not written here:
   * the caller pins it with `pinNativeStart` once every check of its own admission has passed, so
   * an admission refused after this point leaves nothing behind (review PR1046-R4). Writing it
   * here, as this function first did, was rejected rather than kept: a refusal that came later
   * left a pin row for a process the admission never accepted.
   */
  pinToRecord: string | null;
}

/**
 * A durable, write-once record of the native start a runtime row's process was admitted with
 * (#1037). `SessionRegistry` keeps it; this module only reads it and asks for it to be written.
 */
export interface NativeStartPins {
  pinnedNativeStart(sessionId: string): string | null;
  pinNativeStart(sessionId: string, startToken: string): void;
}

const refuse = (message: string): Decision<RuntimeLineage> => deny(ReasonCode.CONFLICT, message, {});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

interface LocalSecond {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const rendersAs = (instant: number, local: LocalSecond): boolean => {
  const at = new Date(instant);
  if (at.getFullYear() !== local.year) return false;
  if (at.getMonth() !== local.month) return false;
  if (at.getDate() !== local.day) return false;
  if (at.getHours() !== local.hours) return false;
  if (at.getMinutes() !== local.minutes) return false;
  return at.getSeconds() === local.seconds;
};

/** Every DST shift in use is a multiple of 15 minutes and at most two hours; four hours is margin. */
const OFFSET_STEP_MS = 15 * 60_000;
const OFFSET_STEPS = 16;

/**
 * The one UTC instant at which the second `ps -o lstart=` rendered began, or null.
 *
 * `ps` renders in its own local time and the daemon spawns it with its own environment, so the
 * daemon's local time is the zone the text is in. A local time is not always one instant: where
 * clocks fall back it names two (review PR1046-R1, round 2: `Sun Nov  1 01:30:00 2026` in
 * America/New_York is both 05:30Z and 06:30Z), and where they spring forward it names none. Every
 * instant within four hours of the naive reading is tried, and only a reading with exactly one
 * instant is an answer; the rest are null, which every caller refuses.
 */
const lstartInstant = (lstart: string): number | null => {
  const parts = LSTART.exec(lstart);
  if (parts === null) return null;
  const month = MONTHS.indexOf(parts[1]!);
  if (month === -1) return null;
  const local: LocalSecond = {
    year: Number(parts[6]),
    month,
    day: Number(parts[2]),
    hours: Number(parts[3]),
    minutes: Number(parts[4]),
    seconds: Number(parts[5]),
  };
  const naive = new Date(local.year, local.month, local.day, local.hours, local.minutes, local.seconds).getTime();
  if (!Number.isFinite(naive)) return null;
  const instants: number[] = [];
  for (let step = -OFFSET_STEPS; step <= OFFSET_STEPS; step += 1) {
    const candidate = naive + step * OFFSET_STEP_MS;
    if (rendersAs(candidate, local)) instants.push(candidate);
  }
  return instants.length === 1 ? instants[0]! : null;
};

/**
 * Is the live process at the row's pid the one the row recorded? Returns the native token to pin
 * when the answer was decided from a legacy record, or null when nothing needs pinning. It writes
 * nothing: the caller pins only once its whole admission holds (review PR1046-R4).
 *
 * Three cases, exact wherever exact is possible:
 *
 *   - the row recorded the native token (the canonical claim does): equal, or not this process;
 *   - the row's process has a pinned native token: equal to it, or not this process;
 *   - neither — a row that recorded only `ps` lstart, as incumbent adoption did until #1037. Its
 *     one-second grain cannot tell two processes started in the same second apart, so a matching
 *     lstart is decisive only when the row was written after that second ended: the recorded
 *     process was alive then, so any process that replaced it started later, in a later second,
 *     and renders a different lstart. Then the live token is pinned and compared exactly from then
 *     on. A row written inside its own process's start second is ambiguous and is refused, and so is
 *     an lstart whose local time is not exactly one instant (`lstartInstant`).
 *
 * Exported for the Gateway delivery authority, which asks the same question of the same row.
 */
export const recordedStartIsLive = (
  runtime: { sessionId: string; osProcessStartedAt: string; createdAt: string },
  pid: number,
  startToken: string,
  processes: Pick<ProcessLineageReader, "startedAt">,
  pins: Pick<NativeStartPins, "pinnedNativeStart">,
): Decision<string | null> => {
  const notThis = (): Decision<string | null> =>
    deny(ReasonCode.CONFLICT, "the runtime's pid now belongs to another process", {});
  if (runtime.osProcessStartedAt === startToken) return allow(ReasonCode.OK, null);
  const pinned = pins.pinnedNativeStart(runtime.sessionId);
  if (pinned !== null) return pinned === startToken ? allow(ReasonCode.OK, null) : notThis();
  if (runtime.osProcessStartedAt !== processes.startedAt(pid)) return notThis();
  const started = lstartInstant(runtime.osProcessStartedAt);
  if (started === null) {
    return deny(
      ReasonCode.CONFLICT,
      "the runtime row's lstart is not exactly one instant in this zone, so it cannot identify a process",
      {},
    );
  }
  if (Date.parse(runtime.createdAt) < started + 1000) {
    return deny(
      ReasonCode.CONFLICT,
      "the runtime row was written inside its process's start second, so its lstart cannot tell that process from a successor",
      {},
    );
  }
  return allow(ReasonCode.OK, startToken);
};

/**
 * Admits `peerPid` only when the runtime's recorded process is alive as recorded and is a proper
 * ancestor of the peer. The peer itself is never its own proof.
 *
 * "Alive as recorded" is `recordedStartIsLive`: an exact native-token comparison, against the row
 * or against the token pinned for it, and for a legacy lstart-only row the one case where lstart is
 * decisive — reported back as `pinToRecord` for the caller to pin, so the next admission is exact.
 * Nothing here writes.
 */
export const admitRuntimeLineage = (
  peerPid: number,
  runtime: {
    sessionId: string;
    incarnation: string;
    osPid: number | null;
    osProcessStartedAt: string | null;
    createdAt: string;
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
  const live = recordedStartIsLive(
    { sessionId: runtime.sessionId, osProcessStartedAt: recorded, createdAt: runtime.createdAt },
    pid,
    startToken,
    processes,
    pins,
  );
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
      return allow(ReasonCode.OK, { pid, startToken, runtime: admitted, pinToRecord: live.value });
    }
    if (current <= 1) break;
    if (visited.has(current)) break;
    visited.add(current);
    current = processes.parentOf(current);
  }
  return refuse("the caller does not descend from the runtime's process");
};
