import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
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
 * the file every later spawn of that observation must still be (`commitlorePinIdentity`). Its version
 * must then be the newest published stable CommitLore release, confirmed for that observation
 * (`judgeCommitLoreLatest`, #1268).
 *
 * The `init` usage must offer every option the observation passes (`COMMITLORE_INIT_OPTIONS`), among them
 * `--no-agent-hooks`, without which `init` writes its Claude Code injection hook into the checkout. A CLI
 * whose `init` lacks one is refused `NO_INIT_OPTION` before any `init` runs; nothing falls back to an argv
 * without it.
 */
export const COMMITLORE_BINARY_VARIABLE = "ACP_COMMITLORE_BINARY";

/**
 * Why a pin is refused. The stat conditions are the provider pins' own (`doctor.ts` `PinCondition`).
 * `NO_DOCTOR_COMMAND`: `doctor --help` gives no `doctor` usage that declares `--json` (`judgeCommitLoreDoctorCommand`).
 * `NO_INIT_COMMAND`: `init --help` gives no `init` usage at all (it fails, or answers something else).
 * `NO_INIT_OPTION`: it gives one, and that usage does not offer an option the observation passes.
 * `RELEASE_UNCONFIRMED`: the newest published stable release could not be confirmed for this observation.
 * `NOT_LATEST`: it was, and the pinned CLI's version is not that release's.
 * `PACKAGE_MISMATCH`, `UNSUPPORTED_ENTRYPOINT`, `UNSUPPORTED_PACKAGE`: the package a commit attempt copies
 * and runs (`commitlore-snapshot.ts`) states another version than it answers, cannot be named from the pin,
 * or is not one package of regular files with a published file list.
 */
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
  | "NO_INIT_OPTION"
  | "RELEASE_UNCONFIRMED"
  | "NOT_LATEST"
  | "PACKAGE_MISMATCH"
  | "UNSUPPORTED_ENTRYPOINT"
  | "UNSUPPORTED_PACKAGE"
  | "TOO_LARGE"
  | "REPLACED";

/** The argv the pin is checked with, in this order, before an observation's first `commitlore` command. */
export const COMMITLORE_PIN_CHECK_ARGV: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["--version"]),
  Object.freeze(["doctor", "--help"]),
  Object.freeze(["init", "--help"]),
]);

/** The options of `init` the observation passes (`COMMITLORE_OBSERVATION_ARGV`); its usage must list each. */
export const COMMITLORE_INIT_OPTIONS = Object.freeze(["--mcp-scope", "--no-unattended", "--no-agent-hooks"] as const);

/**
 * What the observation needs each of `COMMITLORE_INIT_OPTIONS` for, as a `NO_INIT_OPTION` refusal names it.
 * `--no-agent-hooks` skips only `init`'s Claude Code injection hook (`.claude/settings.json`, its one write
 * into the working tree); the git hooks, the git config, the record index, the trusted-author handling and
 * `init`'s own readiness verdict all stay, so it is not a skip of agent integration as a whole.
 */
const INIT_OPTION_NEEDS: Readonly<Record<(typeof COMMITLORE_INIT_OPTIONS)[number], string>> = Object.freeze({
  "--mcp-scope": "to register no MCP server (`--mcp-scope none`) without a prompt",
  "--no-unattended": "to leave unattended capture off without a prompt",
  "--no-agent-hooks": "so that it writes nothing into the checkout",
});

/**
 * The versions this producer runs: major 1, from 1.4.2. 1.4.2 is the first release whose `init` takes the
 * `--mcp-scope` the observation passes (`COMMITLORE_OBSERVATION_ARGV`); every 1.x since emits the
 * `commitlore_doctor.v2` report the observation judges. Another major is refused until it is measured.
 *
 * The version does not show that `init` offers `--no-agent-hooks`: a build without it and a build with it
 * answer the same one (the 1.7.4 release, and the unreleased source after it, both say 1.7.4), so that
 * capability is read from `init --help` (`judgeCommitLoreInitCommand`) and the range is not raised for it.
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
 * Review B3-R1-01 — one option declaration in a usage's `Options:` section, as the CLI's argument parser
 * (commander) prints it: exactly two spaces of indent, then `--name` or `-x, --name`, then whitespace, `<`,
 * `[`, `=` or the end of the line. The name is taken whole, so a longer option (`--no-agent-hooks-x`) or a
 * shorter prefix (`--no-agent`) is another option, and a short alias alone (`-n`) declares no long option.
 */
const OPTION_DECLARATION = /^ {2}(?:-[A-Za-z0-9], )?(--[A-Za-z0-9][A-Za-z0-9-]*)(?=[\s<[=]|$)/;

/**
 * Review B3-R1-01 — the long options a usage declares: only the declarations (`OPTION_DECLARATION`) inside
 * its `Options:` section, which runs from the first line that is `Options:` to the first blank line or the
 * first line not indented by a space. A description's wrapped continuation (indented deeper), the command's
 * description and the prose after the section (at column 0) declare nothing, whatever word they start with.
 * A layout this does not recognise declares nothing, so every required option is missing (fail closed): no
 * `Options:` section, option lines at another indent, or a tab in place of the two spaces.
 */
const declaredCommitLoreOptions = (usage: string): ReadonlySet<string> => {
  const lines = usage.split("\n");
  const start = lines.findIndex((line) => /^Options:\s*$/.test(line));
  const declared = new Set<string>();
  if (start === -1) return declared;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || !line.startsWith(" ")) break;
    const declaration = OPTION_DECLARATION.exec(line);
    if (declaration !== null) declared.add(declaration[1] as string);
  }
  return declared;
};

/**
 * Whether the pinned CLI has the `doctor` command the observation runs, with its `--json` report: its own
 * usage for `doctor --help`, exit 0, declaring `--json` in its `Options:` section (`declaredCommitLoreOptions`,
 * the one declaration rule `init`'s options are read by too; review B3-R1-01: `--json` named in prose, in a
 * description or in a wrapped continuation is no declaration). A CLI without the command answers with its
 * root usage instead, and exits 0 doing it, so the exit code alone says nothing. Null when it has it;
 * otherwise the reason, `NO_DOCTOR_COMMAND` either way: the observation needs the one `doctor --json`.
 */
export const judgeCommitLoreDoctorCommand = (pin: string, run: CommitLoreRun): string | null => {
  const usage = run.stdout.trimStart().split("\n", 1)[0] ?? "";
  if (run.exitCode === 0 && /^Usage: commitlore doctor(\s|$)/.test(usage) && declaredCommitLoreOptions(run.stdout).has("--json")) return null;
  return (
    `${COMMITLORE_BINARY_VARIABLE} NO_DOCTOR_COMMAND: ${pin} doctor --help exited ${run.exitCode} ` +
    `without a doctor usage declaring --json (${JSON.stringify(tail(usage) || tail(run.stderr))})`
  );
};

/**
 * Review S16-R1-03 — whether the pinned CLI has the `init` command the observation runs, taking the options
 * it passes: its own usage for `init --help`, exit 0, declaring each of `COMMITLORE_INIT_OPTIONS` in its
 * `Options:` section (`declaredCommitLoreOptions`; a mention anywhere else is no declaration). As for
 * `doctor`, a CLI without the command answers with its root usage and exits 0. Null when it has it;
 * otherwise the reason: `NO_INIT_COMMAND` when there is no `init` usage at all, `NO_INIT_OPTION` naming each
 * option that usage does not declare and what the observation needs it for.
 *
 * This reads a usage and runs no `init`: it shows the CLI declares the command and those options, and it is
 * no evidence that `init` succeeds in a checkout or of what it changes there.
 */
export const judgeCommitLoreInitCommand = (pin: string, run: CommitLoreRun): string | null => {
  const usage = run.stdout.trimStart().split("\n", 1)[0] ?? "";
  if (run.exitCode !== 0 || !/^Usage: commitlore init(\s|$)/.test(usage)) {
    return (
      `${COMMITLORE_BINARY_VARIABLE} NO_INIT_COMMAND: ${pin} init --help exited ${run.exitCode} without an init usage ` +
      `(${JSON.stringify(tail(usage) || tail(run.stderr))})`
    );
  }
  const declared = declaredCommitLoreOptions(run.stdout);
  const missing = COMMITLORE_INIT_OPTIONS.filter((option) => !declared.has(option));
  if (missing.length === 0) return null;
  return (
    `${COMMITLORE_BINARY_VARIABLE} NO_INIT_OPTION: ${pin} init does not offer ` +
    missing.map((option) => `${option}, which the observation needs ${INIT_OPTION_NEEDS[option]}`).join("; nor ")
  );
};

/**
 * #1268 — the release a pin must be: the newest published stable release of the official CommitLore
 * repository, as GitHub's `releases/latest` answers it (a published release that is neither a draft nor a
 * prerelease). The source is fixed here: nothing in a plan, a manifest, a checkout or a candidate's
 * submission names it or answers for it.
 *
 * It is confirmed once per readiness (`commitloreRunner`'s `ready`), so once per attempt, and never kept:
 * the next attempt, a restart included, asks again. A lookup that fails, times out or answers anything but
 * one whole stable release refuses `RELEASE_UNCONFIRMED`, and no earlier answer stands in for it. A release
 * published after an attempt's lookup does not fail that attempt; the next attempt's lookup sees it.
 */
export const COMMITLORE_RELEASE_REPOSITORY = "MongLong0214/commitlore";
export const COMMITLORE_LATEST_RELEASE_URL = `https://api.github.com/repos/${COMMITLORE_RELEASE_REPOSITORY}/releases/latest`;
const COMMITLORE_RELEASE_ORIGIN = "https://api.github.com";

/** How long one lookup may take, its body included: a bound of its own, taken from no check's or command's. */
export const COMMITLORE_RELEASE_TIMEOUT_MS = 10_000;

/** The most of an answer read as a release. One release's JSON, its notes included, is far below it. */
const COMMITLORE_RELEASE_MAX_BYTES = 1024 * 1024;

/** One lookup of the newest stable release: the answer as parsed JSON, or a rejection when there is none. */
export type CommitLoreReleaseLookup = () => Promise<unknown>;

/** A confirmed release: GitHub's id for it, its tag, and the version that tag names. */
export interface CommitLoreRelease {
  readonly id: number;
  readonly tag: string;
  readonly version: readonly [bigint, bigint, bigint];
}

/** The production lookup: one unauthenticated GET of `COMMITLORE_LATEST_RELEASE_URL`, bounded in time and size. */
export const officialCommitLoreRelease: CommitLoreReleaseLookup = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMITLORE_RELEASE_TIMEOUT_MS);
  try {
    const response = await fetch(COMMITLORE_LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-control-plane" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`GitHub answered ${response.status}`);
    if (new URL(response.url || COMMITLORE_LATEST_RELEASE_URL).origin !== COMMITLORE_RELEASE_ORIGIN) {
      throw new Error("the release was answered from an unexpected origin");
    }
    const body = await response.text();
    if (body.length > COMMITLORE_RELEASE_MAX_BYTES) throw new Error("the answer is larger than one release");
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timer);
  }
};

/** `answer` as one published stable release with a canonical `vMAJOR.MINOR.PATCH` tag; throws the reason otherwise. */
export const confirmCommitLoreRelease = (answer: unknown): CommitLoreRelease => {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new Error("the answer is not one release");
  const release = answer as Record<string, unknown>;
  if (release["draft"] !== false || release["prerelease"] !== false || typeof release["published_at"] !== "string") {
    throw new Error("the answer is not a published stable release");
  }
  const { id, tag_name: tag } = release;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("the release has no id");
  const version = typeof tag === "string" && tag.startsWith("v") ? parseCommitLoreVersion(tag.slice(1)) : null;
  if (version === null) throw new Error(`the release tag ${JSON.stringify(tail(String(tag)))} is not vMAJOR.MINOR.PATCH`);
  return { id, tag: tag as string, version };
};

/**
 * Whether `answer`, the pinned CLI's own `--version` answer, is the version of the release `lookup` confirms
 * now. Null when it is; otherwise the reason, `RELEASE_UNCONFIRMED` or `NOT_LATEST`. Equal versions only: an
 * older pin is not the newest release, and a newer one is no published release.
 */
export const judgeCommitLoreLatest = async (pin: string, answer: string, lookup: CommitLoreReleaseLookup): Promise<string | null> => {
  let release: CommitLoreRelease;
  try {
    release = confirmCommitLoreRelease(await lookup());
  } catch (error) {
    return (
      `${COMMITLORE_BINARY_VARIABLE} RELEASE_UNCONFIRMED: the newest published stable release of ${COMMITLORE_RELEASE_REPOSITORY} ` +
      `could not be confirmed for this attempt (${tail(error instanceof Error ? error.message : String(error), 200)}); no earlier answer stands in for it`
    );
  }
  const version = parseCommitLoreVersion(answer.trim());
  if (version !== null && version.every((part, index) => part === release.version[index])) return null;
  return (
    `${COMMITLORE_BINARY_VARIABLE} NOT_LATEST: ${pin} --version answered ${JSON.stringify(tail(answer))}, and the newest ` +
    `published stable release of ${COMMITLORE_RELEASE_REPOSITORY} is ${release.tag} (release ${release.id})`
  );
};

/**
 * The pinned CLI's version, then its `doctor` command, then its `init` command, each through `run` in
 * `cwd`, then that version against the newest stable release `latest` confirms (#1268). Null when all hold;
 * otherwise the first reason, and nothing later is asked. A check that cannot be run at all throws, as `run`
 * does.
 *
 * #1268 — `packageVersion`, for a run of a copied package (`commitlore-snapshot.ts`): the version that
 * package's own `package.json` states. It must be the version the copy answers, and it is what the newest
 * release is compared with.
 */
export const verifyCommitLorePin = async (
  pin: string,
  run: CommitLoreRunner,
  cwd: string,
  latest: CommitLoreReleaseLookup,
  packageVersion?: string,
): Promise<string | null> => {
  const [versionArgv, doctorArgv, initArgv] = COMMITLORE_PIN_CHECK_ARGV as [readonly string[], readonly string[], readonly string[]];
  const versionRun = await run(versionArgv, cwd);
  const version = judgeCommitLoreVersion(pin, versionRun);
  if (version !== null) return version;
  const doctor = judgeCommitLoreDoctorCommand(pin, await run(doctorArgv, cwd));
  if (doctor !== null) return doctor;
  const init = judgeCommitLoreInitCommand(pin, await run(initArgv, cwd));
  if (init !== null) return init;
  if (packageVersion !== undefined && packageVersion !== versionRun.stdout.trim()) {
    return (
      `${COMMITLORE_BINARY_VARIABLE} PACKAGE_MISMATCH: the CommitLore package ${pin} runs states version ` +
      `${JSON.stringify(tail(packageVersion))} and answers ${JSON.stringify(tail(versionRun.stdout))}`
    );
  }
  return judgeCommitLoreLatest(pin, packageVersion ?? versionRun.stdout, latest);
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

/**
 * Review S16-R2-01 — the largest file read as a pin, in bytes: 8 MiB, set from the entrypoints this producer
 * supports, not from any one of them.
 * - The installer's wrapper (`# commitlore:wrapper:v1`, written by CommitLore's `install.sh`): a `/bin/sh`
 *   script whose only variable parts are two absolute paths, 238 bytes on this host at 1.7.4, and under
 *   4 KiB even with both paths at macOS's 1,024-byte PATH_MAX.
 * - The release bundle itself, `dist/commitlore.mjs`, an executable `#!/usr/bin/env node` script, pinned
 *   directly: 1,510,851 bytes at 1.4.2, the first supported version, to 1,571,351 bytes at 1.7.4 (+4% over
 *   that range).
 * 8 MiB is over five times the largest of those, room for the rest of the supported 1.x line. A larger
 * file — a native or single-executable build (tens of MiB), or a sparse file of any apparent size — is no
 * supported entrypoint, and it is refused on the descriptor's own size before a byte of it is read.
 */
export const COMMITLORE_PIN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Review S16-R2-01 — how long one reading of a pin's identity may take, from its start: 10 s. Its own bound,
 * never part of a check's or a command's: each child's `timeoutMs` starts at its spawn, after this read.
 * Reading a pin at the cap took milliseconds on this host; the bound is there for a file system that does
 * not answer, so that an observation still ends — within its children's bounds plus one of these for each
 * of its seven readings (the binding, before each of five spawns, and after the last check).
 */
export const COMMITLORE_PIN_IDENTITY_TIMEOUT_MS = 10_000;

/** Why a pin could not be read as one file: `TOO_LARGE` over the cap; `UNREADABLE` for every other way. */
export class CommitLorePinIdentityError extends Error {
  constructor(
    readonly condition: "TOO_LARGE" | "UNREADABLE",
    message: string,
  ) {
    super(message);
    this.name = "CommitLorePinIdentityError";
  }
}

const IDENTITY_FIELDS = ["target", "dev", "ino", "size", "mtimeNs", "ctimeNs", "sha256"] as const;

/** The bytes asked of one read: the descriptor is read in chunks of this, each its own turn of the event loop. */
const IDENTITY_CHUNK_BYTES = 64 * 1024;

const sameFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/**
 * The reading itself. On the descriptor, before any byte: a regular file, of at most the cap. Then exactly
 * its size, chunk by chunk at explicit offsets, and one byte past it: at most size + 1 <= cap + 1 bytes are
 * read, however the file changes. A file that ends early, has a byte past its size, or whose descriptor or
 * path state differs afterwards changed while it was read. Every await is a turn of the event loop, and
 * `expired` is asked after each, so a reading past its deadline stops at its next step. The descriptor is
 * closed on every path, an expired one included; a FileHandle's close waits for a read still in flight, so
 * the descriptor number is never released under one.
 */
const readPinIdentity = async (pin: string, expired: () => boolean): Promise<CommitLorePinIdentity> => {
  const step = <T>(value: T): T => {
    if (expired()) throw new CommitLorePinIdentityError("UNREADABLE", `${pin} was still being read at its deadline`);
    return value;
  };
  const target = step(await realpath(pin));
  let handle: FileHandle | null = null;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    step(handle);
    const opened = step(await handle.stat({ bigint: true }));
    if (!opened.isFile()) throw new CommitLorePinIdentityError("UNREADABLE", `${target} is not a regular file`);
    if (opened.size > BigInt(COMMITLORE_PIN_MAX_BYTES)) {
      throw new CommitLorePinIdentityError(
        "TOO_LARGE",
        `${target} is ${opened.size} bytes, more than the ${COMMITLORE_PIN_MAX_BYTES} bytes a supported entrypoint is`,
      );
    }
    const size = Number(opened.size);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(IDENTITY_CHUNK_BYTES, size + 1)));
    let position = 0;
    while (position < size) {
      const { bytesRead } = step(await handle.read(chunk, 0, Math.min(chunk.length, size - position), position));
      if (bytesRead === 0) throw new CommitLorePinIdentityError("UNREADABLE", `${target} changed while it was read (it ended at ${position} of ${size} bytes)`);
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const { bytesRead: beyond } = step(await handle.read(chunk, 0, 1, size));
    if (beyond !== 0) throw new CommitLorePinIdentityError("UNREADABLE", `${target} changed while it was read (it grew past ${size} bytes)`);
    const after = step(await handle.stat({ bigint: true }));
    const named = step(await stat(target, { bigint: true }));
    if (!sameFile(opened, after) || !sameFile(after, named)) throw new CommitLorePinIdentityError("UNREADABLE", `${target} changed while it was read`);
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
    await handle?.close();
  }
};

/**
 * The identity of the file `pin` names now (`CommitLorePinIdentity`), read without blocking the event loop
 * and within `timeoutMs` (review S16-R2-01). Rejects with a `CommitLorePinIdentityError` when it cannot be
 * read as one file within its bounds: too large, not a regular file, changed or grown while it was read,
 * not there, or not read by its deadline. Whatever it rejects with, it never resolves after that.
 */
export const commitlorePinIdentity = (pin: string, timeoutMs: number = COMMITLORE_PIN_IDENTITY_TIMEOUT_MS): Promise<CommitLorePinIdentity> => {
  let expired = false;
  let deadline: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => {
      expired = true;
      reject(new CommitLorePinIdentityError("UNREADABLE", `${pin} could not be read within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const reading = readPinIdentity(pin, () => expired).catch((error: unknown) => {
    throw error instanceof CommitLorePinIdentityError ? error : new CommitLorePinIdentityError("UNREADABLE", (error as Error).message);
  });
  return Promise.race([reading, late]).finally(() => clearTimeout(deadline));
};

/** The identity a pin's checks are about to run, or the refusal when the pin cannot be read as one. */
export const bindCommitLorePin = async (pin: string, timeoutMs?: number): Promise<CommitLorePinIdentity> => {
  try {
    return await commitlorePinIdentity(pin, timeoutMs);
  } catch (error) {
    if (error instanceof CommitLorePinIdentityError && error.condition === "TOO_LARGE") {
      throw new Error(`${COMMITLORE_BINARY_VARIABLE} TOO_LARGE: ${pin} is no supported entrypoint (${error.message})`);
    }
    throw new Error(`${COMMITLORE_BINARY_VARIABLE} UNREADABLE: ${pin} could not be read as a file to check (${(error as Error).message})`);
  }
};

/** Rejects `REPLACED` unless `pin` still names exactly the file `bound` is; nothing is run either way. */
export const assertCommitLorePinUnchanged = async (pin: string, bound: CommitLorePinIdentity, timeoutMs?: number): Promise<void> => {
  let now: CommitLorePinIdentity;
  try {
    now = await commitlorePinIdentity(pin, timeoutMs);
  } catch (error) {
    throw new Error(`${COMMITLORE_BINARY_VARIABLE} REPLACED: ${pin} can no longer be read as the file its checks ran (${(error as Error).message})`);
  }
  const changed = IDENTITY_FIELDS.filter((field) => now[field] !== bound[field]);
  if (changed.length > 0) {
    throw new Error(`${COMMITLORE_BINARY_VARIABLE} REPLACED: ${pin} is no longer the file its checks ran (${changed.join(", ")} changed)`);
  }
};
