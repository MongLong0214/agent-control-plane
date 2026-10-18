import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
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
 * with it, the pinned CLI is asked its version, its `doctor` command's usage and its `init` command's
 * usage, once for that observation, under the same bounded child and the same constructed child
 * environment as the observation's commands (`commitloreRunner`'s `ready`). The file those checks ran is
 * the file every later spawn of that observation must still be (`commitlorePinIdentity`).
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
  | "NO_DOCTOR_COMMAND"
  | "NO_INIT_COMMAND"
  | "REPLACED";

/** The argv the pin is checked with, in this order, before an observation's first `commitlore` command. */
export const COMMITLORE_PIN_CHECK_ARGV: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["--version"]),
  Object.freeze(["doctor", "--help"]),
  Object.freeze(["init", "--help"]),
]);

/** The options of `init` the observation passes (`COMMITLORE_OBSERVATION_ARGV`); its usage must list each. */
export const COMMITLORE_INIT_OPTIONS: readonly string[] = Object.freeze(["--mcp-scope", "--no-unattended"]);

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
 * Review S16-R1-04 — the one `--version` answer accepted: exit 0, and stdout, surrounding whitespace aside,
 * exactly `MAJOR.MINOR.PATCH` — three canonical decimal numerals joined by dots, each `0` or an ASCII digit
 * 1-9 followed by ASCII digits. So no sign, no leading zero (`01.7.3`, `1.04.02`), no prefix (`v1.7.3`),
 * no pre-release or build suffix, and nothing on another line.
 */
const CANONICAL_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** A canonical `MAJOR.MINOR.PATCH` as its three numbers, exact at any length; null for anything else. */
export const parseCommitLoreVersion = (answer: string): readonly [bigint, bigint, bigint] | null => {
  const match = CANONICAL_VERSION.exec(answer);
  if (match === null) return null;
  return [BigInt(match[1] as string), BigInt(match[2] as string), BigInt(match[3] as string)];
};

/**
 * The supported range, judged on the parsed numbers and never on the text: major
 * `COMMITLORE_SUPPORTED_VERSION.major`, and (minor, patch) at least the minimum's, so 1.4.2 <= version < 2.0.0.
 */
const supportedVersion = ([major, minor, patch]: readonly [bigint, bigint, bigint]): boolean => {
  const [, floorMinor, floorPatch] = COMMITLORE_SUPPORTED_VERSION.minimum;
  return (
    major === BigInt(COMMITLORE_SUPPORTED_VERSION.major) &&
    (minor > BigInt(floorMinor) || (minor === BigInt(floorMinor) && patch >= BigInt(floorPatch)))
  );
};

/**
 * Whether the pinned CLI's `--version` answer is a supported version: the canonical answer
 * (`CANONICAL_VERSION`) within `COMMITLORE_SUPPORTED_VERSION`. Null when it is; otherwise the reason.
 */
export const judgeCommitLoreVersion = (pin: string, run: CommitLoreRun): string | null => {
  const answer = run.stdout.trim();
  const version = run.exitCode === 0 ? parseCommitLoreVersion(answer) : null;
  if (version !== null && supportedVersion(version)) return null;
  const { major, minimum } = COMMITLORE_SUPPORTED_VERSION;
  return (
    `${COMMITLORE_BINARY_VARIABLE} UNSUPPORTED_VERSION: ${pin} --version exited ${run.exitCode} with ` +
    `${JSON.stringify(tail(answer) || tail(run.stderr))}; supported is a canonical MAJOR.MINOR.PATCH, ${major}.x from ${minimum.join(".")}`
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
 * Review S16-R1-03 — whether the pinned CLI has the `init` command the observation runs, taking the options
 * it passes: its own usage for `init --help`, exit 0, listing each of `COMMITLORE_INIT_OPTIONS` as an option
 * (a line that starts with it). As for `doctor`, a CLI without the command answers with its root usage and
 * exits 0. Null when it has it; otherwise the reason.
 *
 * This reads a usage and runs no `init`: it shows the CLI declares the command and those options, and it is
 * no evidence that `init` succeeds in a checkout or of what it changes there.
 */
export const judgeCommitLoreInitCommand = (pin: string, run: CommitLoreRun): string | null => {
  const usage = run.stdout.trimStart().split("\n", 1)[0] ?? "";
  // The first word of each line, a short alias (`-m, `) aside: an option the usage lists starts its line.
  const listed = new Set(run.stdout.split("\n").map((line) => line.trim().replace(/^-\w, /, "").split(/\s/, 1)[0]));
  const missing = COMMITLORE_INIT_OPTIONS.filter((option) => !listed.has(option));
  if (run.exitCode === 0 && /^Usage: commitlore init(\s|$)/.test(usage) && missing.length === 0) return null;
  return (
    `${COMMITLORE_BINARY_VARIABLE} NO_INIT_COMMAND: ${pin} init --help exited ${run.exitCode} without an init usage ` +
    `listing ${COMMITLORE_INIT_OPTIONS.join(" and ")} (${JSON.stringify(tail(usage) || tail(run.stderr))})`
  );
};

/**
 * The pinned CLI's version, then its `doctor` command, then its `init` command, each through `run` in
 * `cwd`. Null when all hold; otherwise the first reason, and no later check is run. A check that cannot be
 * run at all throws, as `run` does.
 */
export const verifyCommitLorePin = async (pin: string, run: CommitLoreRunner, cwd: string): Promise<string | null> => {
  const [versionArgv, doctorArgv, initArgv] = COMMITLORE_PIN_CHECK_ARGV as [readonly string[], readonly string[], readonly string[]];
  const version = judgeCommitLoreVersion(pin, await run(versionArgv, cwd));
  if (version !== null) return version;
  const doctor = judgeCommitLoreDoctorCommand(pin, await run(doctorArgv, cwd));
  if (doctor !== null) return doctor;
  return judgeCommitLoreInitCommand(pin, await run(initArgv, cwd));
};

/**
 * Review S16-R1-02 — which file a pin is, at one moment: the target the pin resolves to through every
 * link, that file's device, inode, size, modification and change times (nanoseconds), and the SHA-256 of
 * its bytes. Read through one descriptor opened on the resolved target without following a link and
 * without blocking (a FIFO swapped in is refused, never waited on), and refused if that file changed while
 * it was read or the target no longer names it.
 *
 * `commitloreRunner`'s `ready` reads it before the pin's first check, and then again immediately before
 * every later spawn of that observation — each check and each command — and after the last check: any
 * field that differs refuses, with nothing further run. A pin replaced through its link, renamed over,
 * rewritten in place or re-linked elsewhere before a re-check is refused there.
 *
 * Its verification boundary: this is a comparison made before a spawn, not an exec bound to these bytes.
 * The kernel resolves the pin's path again at exec, and a script's interpreter opens the script by path
 * once more, after this read: a replacement made in that window, after the last re-check, is not seen. And
 * it covers this one file: not the interpreter a script names, nor any file the CLI loads once it runs.
 */
export interface CommitLorePinIdentity {
  readonly target: string;
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly sha256: string;
}

const IDENTITY_FIELDS = ["target", "dev", "ino", "size", "mtimeNs", "ctimeNs", "sha256"] as const;

const sameFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** The identity of the file `pin` names now (`CommitLorePinIdentity`). Throws when it cannot be read as one. */
export const commitlorePinIdentity = (pin: string): CommitLorePinIdentity => {
  const target = realpathSync(pin);
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) throw new Error(`${target} is not a regular file`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let length = 0n;
    for (let read = readSync(descriptor, chunk, 0, chunk.length, null); read > 0; read = readSync(descriptor, chunk, 0, chunk.length, null)) {
      hash.update(chunk.subarray(0, read));
      length += BigInt(read);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (length !== opened.size || !sameFile(opened, after) || !sameFile(after, statSync(target, { bigint: true }))) {
      throw new Error(`${target} changed while it was read`);
    }
    return {
      target,
      dev: String(after.dev),
      ino: String(after.ino),
      size: String(after.size),
      mtimeNs: String(after.mtimeNs),
      ctimeNs: String(after.ctimeNs),
      sha256: hash.digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
};

/** The identity a pin's checks are about to run, or the refusal when the pin cannot be read as one. */
export const bindCommitLorePin = (pin: string): CommitLorePinIdentity => {
  try {
    return commitlorePinIdentity(pin);
  } catch (error) {
    throw new Error(`${COMMITLORE_BINARY_VARIABLE} UNREADABLE: ${pin} could not be read as a file to check (${(error as Error).message})`);
  }
};

/** Throws `REPLACED` unless `pin` still names exactly the file `bound` is; nothing is run either way. */
export const assertCommitLorePinUnchanged = (pin: string, bound: CommitLorePinIdentity): void => {
  let now: CommitLorePinIdentity;
  try {
    now = commitlorePinIdentity(pin);
  } catch (error) {
    throw new Error(`${COMMITLORE_BINARY_VARIABLE} REPLACED: ${pin} can no longer be read as the file its checks ran (${(error as Error).message})`);
  }
  const changed = IDENTITY_FIELDS.filter((field) => now[field] !== bound[field]);
  if (changed.length > 0) {
    throw new Error(`${COMMITLORE_BINARY_VARIABLE} REPLACED: ${pin} is no longer the file its checks ran (${changed.join(", ")} changed)`);
  }
};
