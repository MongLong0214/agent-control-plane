import { isAbsolute } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { PIN_CONDITION_PHRASE, inspectPin } from "../doctor/doctor.ts";
import type { CommitLoreRun, CommitLoreRunner } from "./commitlore-observation.ts";

/**
 * Slice S16 (#246 B3) — the one setting that selects the `commitlore` a bootstrap runs.
 *
 * `ACP_COMMITLORE_BINARY`, named by the convention the provider CLIs' pins follow (`ACP_CLAUDE_BINARY`,
 * `ACP_CODEX_BINARY`, `ACP_GROK_BINARY`), and it is the only one: nothing searches PATH, and there is no
 * alias and no fallback. The daemon's launcher PATH holds no user directory by policy, so a CLI found by
 * searching it would be whichever one happened to be there; a pin says which one.
 *
 * The value is an explicit absolute path. Unset, empty, relative (a bare name included), not there, not a
 * regular file, not executable or unreadable, it refuses. The stat half is the provider pins' own rule
 * (`inspectPin`: followed the way the kernel follows it at exec, never canonicalised); the absolute rule
 * comes first, because a relative pin would be read against this process's working directory and spawned
 * against the checkout's.
 *
 * A path that is executable is not yet a CommitLore that works. Before an observation runs any command
 * with it, the pinned CLI is asked its version and its `doctor` command's usage, once for that observation,
 * under the same bounded child and the same constructed child environment as the observation's commands
 * (`commitloreRunner`'s `ready`).
 */
export const COMMITLORE_BINARY_VARIABLE = "ACP_COMMITLORE_BINARY";

/** Why a pin is refused. The stat conditions are the provider pins' own (`doctor.ts` `PinCondition`). */
export type CommitLorePinCondition =
  | "NOT_CONFIGURED"
  | "NOT_ABSOLUTE"
  | "ABSENT"
  | "NOT_A_FILE"
  | "NOT_EXECUTABLE"
  | "UNREADABLE"
  | "UNSUPPORTED_VERSION"
  | "NO_DOCTOR_COMMAND";

/** The argv the pin is checked with, in this order, before an observation's first `commitlore` command. */
export const COMMITLORE_PIN_CHECK_ARGV: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["--version"]),
  Object.freeze(["doctor", "--help"]),
]);

/**
 * The versions this producer runs: major 1, from 1.4.2. 1.4.2 is the first release whose `init` takes the
 * `--mcp-scope` the observation passes (`COMMITLORE_OBSERVATION_ARGV`); every 1.x since emits the
 * `commitlore_doctor.v2` report the observation judges. Another major is refused until it is measured.
 */
export const COMMITLORE_SUPPORTED_VERSION = Object.freeze({ major: 1, minimum: Object.freeze([1, 4, 2] as const) });

const refusedPin = <T>(condition: CommitLorePinCondition, message: string, evidence: Record<string, unknown> = {}): Decision<T> =>
  deny(ReasonCode.VERIFICATION_GAP, `${COMMITLORE_BINARY_VARIABLE} ${condition}: ${message}`, {
    refusal: "COMMITLORE_PIN_REFUSED",
    variable: COMMITLORE_BINARY_VARIABLE,
    condition,
    ...evidence,
  });

/** The pinned executable, exactly as configured, or why there is none. Reads only the file system. */
export const commitlorePin = (value: string | undefined): Decision<string> => {
  if (value === undefined || value === "") {
    return refusedPin("NOT_CONFIGURED", "is not set, and CommitLore runs only from the absolute path pinned there");
  }
  if (!isAbsolute(value)) {
    return refusedPin("NOT_ABSOLUTE", `${JSON.stringify(value)} is not an absolute path, and no PATH is searched`, { pin: value });
  }
  const unusable = inspectPin(value);
  if (unusable === null) return allow(ReasonCode.OK, value);
  const { condition, error } = unusable;
  // An absolute, non-empty path is never a bare name or unset, so only the stat conditions remain.
  if (condition === "NOT_ON_PATH" || condition === "NOT_CONFIGURED") {
    return refusedPin("UNREADABLE", `${value} could not be read as a pin`, { pin: value });
  }
  return refusedPin(condition, `${value} is ${PIN_CONDITION_PHRASE[condition]}`, { pin: value, ...(error ? { error } : {}) });
};

const tail = (text: string, size = 120): string => text.trim().slice(-size);

/**
 * Whether the pinned CLI's `--version` answer is a supported version: exit 0, exactly `MAJOR.MINOR.PATCH`
 * and nothing else, within `COMMITLORE_SUPPORTED_VERSION`. Null when it is; otherwise the reason.
 */
export const judgeCommitLoreVersion = (pin: string, run: CommitLoreRun): string | null => {
  const answer = run.stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(answer);
  const { major, minimum } = COMMITLORE_SUPPORTED_VERSION;
  if (run.exitCode === 0 && match !== null) {
    const [found, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (found === major && (minor > minimum[1] || (minor === minimum[1] && patch >= minimum[2]))) return null;
  }
  return (
    `${COMMITLORE_BINARY_VARIABLE} UNSUPPORTED_VERSION: ${pin} --version exited ${run.exitCode} with ` +
    `${JSON.stringify(tail(answer) || tail(run.stderr))}; supported is ${major}.x from ${minimum.join(".")}`
  );
};

/**
 * Whether the pinned CLI has the `doctor` command the observation runs, with its `--json` report: its own
 * usage for `doctor --help`, exit 0. A CLI without the command answers with its root usage instead, and
 * exits 0 doing it, so the exit code alone says nothing. Null when it has it; otherwise the reason.
 */
export const judgeCommitLoreDoctorCommand = (pin: string, run: CommitLoreRun): string | null => {
  const usage = run.stdout.trimStart().split("\n", 1)[0] ?? "";
  if (run.exitCode === 0 && /^Usage: commitlore doctor(\s|$)/.test(usage) && /(^|\s)--json(\s|$)/m.test(run.stdout)) return null;
  return (
    `${COMMITLORE_BINARY_VARIABLE} NO_DOCTOR_COMMAND: ${pin} doctor --help exited ${run.exitCode} ` +
    `without a doctor --json usage (${JSON.stringify(tail(usage) || tail(run.stderr))})`
  );
};

/**
 * The pinned CLI's version, then its `doctor` command, each through `run` in `cwd`. Null when both hold;
 * otherwise the first reason. A check that cannot be run at all throws, as `run` does.
 */
export const verifyCommitLorePin = async (pin: string, run: CommitLoreRunner, cwd: string): Promise<string | null> => {
  const [versionArgv, doctorArgv] = COMMITLORE_PIN_CHECK_ARGV as [readonly string[], readonly string[]];
  const version = judgeCommitLoreVersion(pin, await run(versionArgv, cwd));
  if (version !== null) return version;
  return judgeCommitLoreDoctorCommand(pin, await run(doctorArgv, cwd));
};
