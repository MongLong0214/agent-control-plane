import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type Stats, closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import type { ProjectManifest } from "../contracts/manifest.ts";
import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { git } from "../git/git.ts";
import { runtimeEnvironment } from "../runtime/cli-adapters.ts";
import { gitHardeningEnvironment, pinnedGitEnvironment } from "../run/worker-git.ts";
import {
  COMMITLORE_BINARY_VARIABLE,
  COMMITLORE_PIN_IDENTITY_TIMEOUT_MS,
  type CommitLoreReleaseLookup,
  assertCommitLorePinUnchanged,
  bindCommitLorePin,
  commitlorePin,
  officialCommitLoreRelease,
  verifyCommitLorePin,
} from "./commitlore-pin.ts";
import { type CommitLoreAttempt, commitloreAttempt } from "./commitlore-commit.ts";
import {
  EMPTY_TREE,
  acpGitDirectory,
  assertCommitLoreSnapshotUnchanged,
  disposeCommitLoreSnapshot,
  gitIgnoresAttrSource,
  snapshotCommitLorePackage,
} from "./commitlore-snapshot.ts";
import type { RepoFactoryResult } from "./repo-factory-result.ts";
import { frameRecord, unframeRecord, writeWholeSync } from "./whole-write.ts";

/**
 * #246 B3 — the bootstrap producer enforces the approved manifest's CommitLore mode (CEO c07863f8).
 *
 * What "a valid CommitLore verification" is here is the integration PRD's own CommitLore rule (§18): an
 * enabled repository runs `commitlore init` and `commitlore doctor`, and a failure is never shortened to
 * PASS. The producer runs both in the checkout at the head it publishes and judges the doctor's report the
 * way the Python Repo Factory producer judges it (`publish.py observe_commitlore`).
 *
 * What it is not is a decision record on the bootstrap commit. CommitLore's own policy is that most commits
 * carry no record, and the commit hook validates a record when one is present and never invents one: the
 * bootstrap commit is the reviewed PLAN's files, its diff is the whole of it, and it needs none. Demanding
 * one would demand a fabricated record, so nothing here asks for one and the producer never writes one.
 *
 * - `required`: no passing observation at the published head refuses the gate.
 * - `preferred`: not observed by this producer, and named NOT_OBSERVED at activation; it never blocks.
 * - `off`: asks for nothing.
 * - any other value: the manifest contract refuses it at parse; one that reaches here anyway is held to
 *   `required`, never to `preferred`.
 */

export type CommitLoreMode = ProjectManifest["commitlore"]["mode"];

/**
 * The `bootstrapVerification` row a passing observation is reported as. A manifest command id is
 * kebab-case (`verification-command.ts`), so this id can never be mistaken for, or collide with, one.
 */
export const COMMITLORE_VERIFICATION_ID = "commitlore:doctor";

/**
 * The fixed argv this producer runs, in this order. Nothing in a plan or manifest reaches it.
 *
 * `--no-agent-hooks` (CEO c3c052bf): without it `init` writes its Claude Code injection hook, a PreToolUse
 * hook in `.claude/settings.json`, into the working tree, and the checkout it is verifying is no longer the
 * approved one (`COMMITLORE_CHANGED_CHECKOUT`). It skips only that hook: `init` still installs its git hooks,
 * writes its git config, builds the record index, handles the directive author string and gives its own
 * readiness verdict, and `doctor --json` is judged as before. The pin's checks refuse a CLI whose `init`
 * does not offer the option (`NO_INIT_OPTION`) before `init` runs; there is no fallback to an argv without it.
 *
 * `--json` (#1268): `init` prints its report as JSON, which is how an exit 1 whose one finding is its final
 * check is told from any other (`judgeCommitLoreRuns`). The pin refuses an `init` without it the same way.
 */
export const COMMITLORE_OBSERVATION_ARGV: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["init", "--mcp-scope", "none", "--no-unattended", "--no-agent-hooks", "--json"]),
  Object.freeze(["doctor", "--json"]),
]);

/**
 * A PASS carries the doctor's report exactly as it printed it: the producer records that report, and its
 * digest, beside the attempt that observed it (`writeCommitLoreObservationRecord`).
 */
export type CommitLoreObservation =
  | { outcome: "PASS"; reportStatus: "ok" | "degraded"; warnings: string[]; detail: string; report: string }
  | { outcome: "FAIL"; reportStatus: string | null; warnings: string[]; detail: string };

/** Runs CommitLore in a checkout. Production uses `createCommitLoreCliPort()`; tests pass a double. */
export interface CommitLorePort {
  /** `commitlore init --mcp-scope none --no-unattended --no-agent-hooks --json`, then `commitlore doctor --json`, in `checkoutPath`. */
  observe(checkoutPath: string): Promise<CommitLoreObservation>;
  /**
   * #1268 — CommitLore's drafting contract for a session that has no transcript or diff yet
   * (`harvest --prompt-only`), read in `checkoutPath`. A port without it cannot put a worker's commit
   * through CommitLore.
   */
  contract?(checkoutPath: string, git: CommitLoreGitTarget): Promise<Decision<string>>;
  /**
   * #1268 — one commit attempt in `checkoutPath`: the pin's checks and the newest-release confirmation,
   * made for this attempt alone, then its commands (`commitlore-commit.ts`). A port without it cannot put
   * a commit through CommitLore, and a commit that requires CommitLore is then refused, never made without.
   */
  attempt?(checkoutPath: string, git: CommitLoreGitTarget): Promise<Decision<CommitLoreAttempt>>;
  /**
   * #1268 — what CommitLore holds for the paths a worker may change, read in `checkoutPath` before the worker
   * starts (`commitloreBeforeChange`). Null when this deployment has no CommitLore configured at all.
   */
  beforeChange?(checkoutPath: string, git: CommitLoreGitTarget, request: CommitLoreBeforeChangeRequest): Promise<CommitLoreBeforeChange | null>;
}

/** #1268 — the record values a worker must have before it edits a path, in CommitLore's own priority order. */
export const COMMITLORE_REQUIRED_KEYS = Object.freeze(["Warn", "Limit", "Ruled-out"] as const);
export type CommitLoreRequiredKey = (typeof COMMITLORE_REQUIRED_KEYS)[number];

/** #1268 — one required value `context --json` reported, from a record CommitLore did not withhold. */
export interface CommitLoreRequiredItem {
  readonly recordId: string | null;
  readonly sha: string;
  readonly trust: string;
  readonly key: CommitLoreRequiredKey;
  readonly value: string;
}

/** #1268 — what CommitLore answered for one path. */
export interface CommitLorePathLookup {
  readonly path: string;
  /**
   * `answered`: CommitLore answered for this path at the turn's base, from a whole scan. `incomplete`: it
   * answered, but its scan stopped early or its notes mirror was not fetched, so records may be missing.
   * `failed`: no answer (`detail` says why), a lookup still running at the deadline included.
   */
  readonly outcome: "answered" | "incomplete" | "failed";
  /** `inject`'s payload exactly as it printed it; empty when it had nothing to say or did not answer. */
  readonly text: string;
  /** `inject`'s cache key: the same key means the same bytes. */
  readonly cacheKey: string | null;
  /** How many records CommitLore withheld as `[blocked]`; their content never reaches here. */
  readonly withheld: number;
  /**
   * Set only when `inject`'s budget cut a Warn, Limit or Ruled-out value: every such value `context --json`
   * reported for the path, Warn first, delivered instead of `text`. Null when `inject` carried them all.
   */
  readonly items: readonly CommitLoreRequiredItem[] | null;
  readonly detail: string | null;
  /**
   * #1268 r1 — CommitLore found no blob of this path in the history it read whole (a file the turn creates, or
   * one renamed from a name not asked for): no record names it, and its empty answer is not evidence that
   * nothing was decided about it. Absent or false otherwise.
   */
  readonly noHistory?: boolean;
}

/** #1268 — one guard match, as `guard --json` renders it; a `[blocked]` match carries no content. */
export interface CommitLoreGuardMatch {
  readonly recordId: string | null;
  readonly sha: string;
  readonly score: number;
  readonly trust: string;
  readonly alternative: string | null;
  readonly reason: string | null;
}

/**
 * #1268 — `guard`'s answer on the proposal: `clean` (exit 0, a whole check, nothing matched), `matched`
 * (exit 1: leads to inspect, never a refusal), `incomplete` (exit 3: the check did not finish), or
 * `not_consulted` (no answer at all, `detail` says why). Only `clean` says nothing was matched.
 */
export interface CommitLoreGuardLookup {
  readonly status: "clean" | "matched" | "incomplete" | "not_consulted";
  readonly matches: readonly CommitLoreGuardMatch[];
  readonly detail: string | null;
}

export interface CommitLoreBeforeChange {
  /** One per requested path, in the order requested. */
  readonly paths: readonly CommitLorePathLookup[];
  readonly guard: CommitLoreGuardLookup;
  /** The copied package that answered: its stated version and its digest. Null when none ran. */
  readonly cliIdentity: { readonly version: string; readonly digest: string } | null;
}

export interface CommitLoreBeforeChangeRequest {
  /** The paths to look up, in order. */
  readonly paths: readonly string[];
  /** The commit the checkout is at: an answer from any other head is not an answer for this turn. */
  readonly baseHead: string;
  /** The text `guard` checks. */
  readonly proposal: string;
  /** Where the proposal file is written; never the working tree. */
  readonly scratch: string;
  /** The `Date.now()` by which the whole lookup has answered; whatever has not by then failed. */
  readonly deadline: number;
  /** How many CommitLore children run at once. */
  readonly concurrency: number;
  /**
   * r2 — told each part of the answer the moment it is decided: the CLI that answers, guard's answer, and each
   * path's. A caller whose deadline passes before the whole answer keeps every part told by then.
   */
  readonly report?: (event: CommitLoreLookupEvent) => void;
}

/** #1268 r2 — one decided part of a before-change lookup (`CommitLoreBeforeChangeRequest.report`). */
export type CommitLoreLookupEvent =
  | { readonly kind: "identity"; readonly identity: { readonly version: string; readonly digest: string } }
  | { readonly kind: "guard"; readonly lookup: CommitLoreGuardLookup }
  | { readonly kind: "path"; readonly lookup: CommitLorePathLookup };

import { commitloreGoverned, commitloreRequired, commitloreRunMode } from "./commitlore-mode.ts";
export { commitloreGoverned, commitloreRequired, commitloreRunMode };

/**
 * #1268 — one commit the control plane builds that no session produced and CommitLore has no command to make
 * or bind (a plumbing merge): a commit attempt on `port` in that repository, CommitLore's commit-msg check on
 * the exact message, run with the commit's own index as the staged one (`index`), and the attempt's copy
 * removed. A refusal means the commit is not made. A pass is a message check, not a capture.
 */
export const checkGeneratedCommitMessage = async (
  port: CommitLorePort | null,
  input: { checkout: string; git: CommitLoreGitTarget; message: string; scratch: string; index?: string },
): Promise<Decision<void>> => {
  if (port?.attempt === undefined) {
    return deny(ReasonCode.VERIFICATION_GAP, "this run's contract requires CommitLore, and this deployment has no CommitLore to check its commits", {
      refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE",
    });
  }
  const attempt = await port.attempt(input.checkout, input.git);
  if (!attempt.allowed) return attempt as Decision<void>;
  try {
    return await attempt.value.validateMessage({
      checkout: input.checkout,
      message: input.message,
      scratch: input.scratch,
      ...(input.index === undefined ? {} : { index: input.index }),
    });
  } finally {
    attempt.value.dispose();
  }
};

export interface CommitLoreRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DOCTOR_SCHEMA = "commitlore_doctor.v2";
const REPORT_STATUSES = new Set(["ok", "degraded", "failed"]);
const CHECK_STATUSES = new Set(["ok", "warn", "fail", "skipped"]);

const tail = (text: string, size = 300): string => text.trim().slice(-size);

const fail = (detail: string, warnings: string[] = [], reportStatus: string | null = null): CommitLoreObservation => ({
  outcome: "FAIL",
  reportStatus,
  warnings,
  detail,
});

/**
 * #1268 (CEO msg_db4e1cc1) — the steps `commitlore init --json` reports, by their `step` name, as CommitLore
 * 1.7.5's `runInit` runs them. Its exit code is 2 when a step could not run, 1 when one needs attention, and
 * 0 otherwise; the one step whose code 1 says only "the final check has findings" is `doctor` (its
 * `doctor --fix` run, code 1 when any check needs attention, a warning included).
 */
const INIT_STEPS: ReadonlySet<string> = new Set(["release", "hooks", "trust", "index", "claude-hook", "mcp-registration", "policy", "doctor"]);
const INIT_FINAL_STEP = "doctor";

/**
 * #1268 — why an `init` that exited 1 is not "set up, final check needs attention", or null when it is: its
 * stdout is one JSON object whose `exitCode` is 1, whose `steps` are exactly `INIT_STEPS` (none missing,
 * unknown or repeated), every step but `doctor` with code 0 and `doctor` with code 1 and its lines. Then the
 * doctor run after it decides, judged as after an exit 0. A registration or policy step that needs attention,
 * a step that could not run, or a report that does not say all of that is a failed `init`, as before.
 */
const initAttentionRefusal = (report: Record<string, unknown> | null): string | null => {
  if (report === null) return "its output is not one JSON report";
  if (report["exitCode"] !== 1) return `its report's exitCode is ${JSON.stringify(report["exitCode"])}, not the process's 1`;
  const steps = report["steps"];
  if (!Array.isArray(steps)) return "its report has no steps";
  const names = steps.map((step) => (typeof step === "object" && step !== null ? (step as Record<string, unknown>)["step"] : undefined));
  const unknown = names.filter((name) => typeof name !== "string" || !INIT_STEPS.has(name));
  if (unknown.length > 0) return `its report has an unknown step ${JSON.stringify(unknown[0])}`;
  if (new Set(names).size !== names.length) return "its report repeats a step";
  if (names.length !== INIT_STEPS.size) return "its report is missing a step";
  for (const step of steps as Array<Record<string, unknown>>) {
    const expected = step["step"] === INIT_FINAL_STEP ? 1 : 0;
    if (step["code"] !== expected) return `its ${String(step["step"])} step has code ${JSON.stringify(step["code"])}`;
  }
  return null;
};

/** #1268 — the accepted report's `doctor` step lines, or null when there are none or they are not all text. */
const initFinalCheckLines = (report: Record<string, unknown>): string[] | null => {
  const final = (report["steps"] as Array<Record<string, unknown>>).find((step) => step["step"] === INIT_FINAL_STEP);
  const lines = final?.["lines"];
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => typeof line === "string") ? (lines as string[]) : null;
};

/**
 * #1268 — the verdict on `init` alone: `READY` with the warnings it adds, or the FAIL. Exit 0 is ready, as
 * before, unless its output is a JSON report naming another exitCode. Exit 1 is ready only as
 * `initAttentionRefusal` says, its final check's lines carried, verbatim and each its own warning. Any other
 * exit fails.
 */
const judgeCommitLoreInit = (init: CommitLoreRun): { outcome: "READY"; attention: boolean; warnings: string[] } | CommitLoreObservation => {
  const diagnostic = tail(init.stderr) || tail(init.stdout) || "no diagnostic output";
  if (init.exitCode === 0) {
    const report = parsedObject(init.stdout);
    if (report !== null && "exitCode" in report && report["exitCode"] !== 0) {
      return fail(`commitlore init report exitCode is ${JSON.stringify(report["exitCode"])} while the process exited 0`);
    }
    return { outcome: "READY", attention: false, warnings: [] };
  }
  if (init.exitCode !== 1) return fail(`commitlore init failed (${init.exitCode}): ${diagnostic}`);
  const report = parsedObject(init.stdout);
  const refusal = initAttentionRefusal(report);
  const lines = refusal === null && report !== null ? initFinalCheckLines(report) : null;
  if (lines === null) return fail(`commitlore init failed (1): ${refusal ?? "its doctor step has no lines of text"}: ${diagnostic}`);
  return { outcome: "READY", attention: true, warnings: lines.map((line) => `init ${INIT_FINAL_STEP} --fix: ${line}`) };
};

/** The verdict on `doctor --json` after a ready `init` (`judgeCommitLoreRuns`), unchanged by #1268. */
const judgeCommitLoreDoctor = (doctor: CommitLoreRun | null): CommitLoreObservation => {
  if (doctor === null) return fail("commitlore doctor could not be run");
  let report: unknown;
  try {
    report = JSON.parse(doctor.stdout);
  } catch (error) {
    return fail(`commitlore doctor returned an invalid JSON report: ${(error as Error).message}`);
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return fail("commitlore doctor returned an invalid JSON report: not an object");
  }
  const document = report as Record<string, unknown>;
  if (document["schema"] !== DOCTOR_SCHEMA) return fail("commitlore doctor returned an invalid JSON report: invalid schema");
  const status = document["status"];
  if (typeof status !== "string" || !REPORT_STATUSES.has(status)) {
    return fail("commitlore doctor returned an invalid JSON report: invalid status");
  }
  const checks = document["checks"];
  if (
    !Array.isArray(checks) ||
    !checks.every(
      (check) =>
        typeof check === "object" && check !== null && CHECK_STATUSES.has((check as Record<string, unknown>)["status"] as string),
    )
  ) {
    return fail("commitlore doctor returned an invalid JSON report: invalid checks", [], status);
  }
  const warnings = (checks as Array<Record<string, unknown>>)
    .filter((check) => check["status"] !== "ok")
    .map((check) => {
      const label = [check["detail"], check["skipReason"], check["title"]].find((value) => typeof value === "string") as string | undefined;
      const message = check["status"] === "skipped" ? `skipped${label ? ` (${label})` : ""}` : (label ?? String(check["status"]));
      return typeof check["id"] === "string" ? `${check["id"]}: ${message}` : message;
    });
  if (doctor.exitCode !== 0) {
    return fail(
      `commitlore doctor failed (${doctor.exitCode}): ${tail(doctor.stderr) || tail(doctor.stdout) || "no diagnostic output"}`,
      warnings,
      status,
    );
  }
  const contradictions: string[] = [];
  if (status === "failed") contradictions.push("report status is failed");
  if (checks.some((check) => (check as Record<string, unknown>)["status"] === "fail")) contradictions.push("a check has status fail");
  if ("exitCode" in document && document["exitCode"] !== 0) contradictions.push(`report exitCode is ${JSON.stringify(document["exitCode"])}`);
  if (contradictions.length > 0) {
    return fail(`commitlore doctor ${contradictions.join("; ")} while the process exited 0`, warnings, status);
  }
  return { outcome: "PASS", reportStatus: status as "ok" | "degraded", warnings, detail: "commitlore doctor passed", report: doctor.stdout };
};

/**
 * The verdict on one `init` + `doctor --json` pair, as `publish.py observe_commitlore` gives it: PASS only
 * when both exit 0 and the doctor's report is a well-formed `commitlore_doctor.v2` report that does not
 * contradict its exit code (status `failed`, a `fail` check, or a non-zero `exitCode` field). Every check
 * that is not `ok` is carried as a warning. `run` is `null` for a step that could not be run at all.
 *
 * #1268 — or `init` exited 1 with a report saying only its final check needs attention
 * (`judgeCommitLoreInit`): the doctor after it is judged exactly as after an exit 0, and the final check's
 * lines come first among the warnings, on a PASS and on a FAIL alike.
 */
export const judgeCommitLoreRuns = (init: CommitLoreRun | null, doctor: CommitLoreRun | null): CommitLoreObservation => {
  if (init === null) return fail("commitlore init could not be run");
  const ready = judgeCommitLoreInit(init);
  if (ready.outcome !== "READY") return ready;
  const judged = judgeCommitLoreDoctor(doctor);
  const warnings = [...ready.warnings, ...judged.warnings];
  if (judged.outcome !== "PASS" || !ready.attention) return { ...judged, warnings };
  return { ...judged, warnings, detail: "commitlore doctor passed; commitlore init exited 1: its final check needs attention" };
};

/**
 * Runs one `commitlore` command in `cwd`. A runner whose CLI must be checked before it is used carries
 * `ready`: the CLI port awaits it once per observation, before the observation's first command, runs that
 * observation's commands through the runner it resolves with, and runs no command if it throws (slice S16,
 * `commitloreRunner`).
 */
export interface CommitLoreRunner {
  (argv: readonly string[], cwd: string, options?: CommitLoreRunOptions): Promise<CommitLoreRun>;
  /**
   * #1268 — a runner for one commit attempt in `cwd` on the repository `git` names: the package the pin
   * loads, copied (`commitlore-snapshot.ts`), checked with `checked` (the pin's checks and the newest-release
   * confirmation, against the copy's own version), and every command run from that copy with the worker's
   * git hardening. `dispose` removes the copy.
   */
  readonly prepare?: (cwd: string, git: CommitLoreGitTarget, options: { checked: boolean }) => Promise<PreparedCommitLore>;
  /**
   * #1268 — false when this deployment pins no CommitLore at all (`ACP_COMMITLORE_BINARY` unset), which is not
   * the same as a pin that is set and refused. A runner that does not say is taken to have one.
   */
  readonly configured?: boolean;
}

/** #1268 — the repository a CommitLore command works on, passed to git explicitly. */
export interface CommitLoreGitTarget {
  gitDir: string;
  workTree: string;
  /** The repository's object format, which names its empty tree (`GIT_ATTR_SOURCE`); sha1 when not given. */
  objectFormat?: "sha1" | "sha256";
  /**
   * The bootstrap observation's `init`, whose job is to install CommitLore's hooks into the repository:
   * the one hardening setting left out is `core.hooksPath` (`OBSERVATION_HARDENING_EXCEPTION`).
   */
  installsHooks?: boolean;
}

/**
 * #1268 — the one worker hardening setting the bootstrap observation leaves out: `core.hooksPath=/dev/null`.
 * Under it `commitlore init` answers `init: 1/7 step(s) could not run — hooks install` and exits 2, because
 * the hooks path it installs into is /dev/null. Every other setting stays: fsmonitor, the untracked cache,
 * signing, gc and maintenance, credential helpers and askpass are off, and no system or global config is
 * read. The checkout is ACP's own, made before any worker turn; a worker never runs in it.
 */
export const OBSERVATION_HARDENING_EXCEPTION = "core.hooksPath";

/** #1268 — the git target of a checkout ACP made itself for a bootstrap, its git dir at `.git`. */
export const observationGitTarget = (checkoutPath: string, objectFormat: "sha1" | "sha256" = "sha1"): CommitLoreGitTarget => ({
  gitDir: join(checkoutPath, ".git"),
  workTree: checkoutPath,
  installsHooks: true,
  objectFormat,
});

/**
 * #1268 — the object format of the repository at `gitDir`, as git reports it, which names the empty tree its
 * CommitLore children read attributes from. Rejects when git cannot say, so no run guesses.
 */
export const repositoryObjectFormat = async (gitDir: string): Promise<"sha1" | "sha256"> => {
  // No git dir is no repository: no object store, no tree an attribute source could name, nothing to read.
  if (!existsSync(gitDir)) return "sha1";
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-object-format"], {
    env: { PATH: commitloreChildEnvironment(tmpdir())["PATH"] ?? "/usr/bin:/bin", GIT_DIR: gitDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 10_000,
  });
  const format = stdout.trim();
  if (format !== "sha1" && format !== "sha256") throw new Error(`the repository's object format is ${JSON.stringify(format.slice(0, 40))}, which no empty tree here names`);
  return format;
};

export interface PreparedCommitLore {
  readonly run: CommitLoreRunner;
  readonly dispose: () => void;
  /** #1268 — the copied package's stated version and its digest (`CommitLoreSnapshot`), for evidence. */
  readonly identity?: { readonly version: string; readonly digest: string };
}

/**
 * #1268 — `indexFile` is the index a command reads as the staged one (`GIT_INDEX_FILE`), for a commit ACP
 * makes over a private index: CommitLore's own git calls then see the tree that commit will have. It is
 * the one git variable a child is given beyond `commitloreChildEnvironment`, and only when it is named.
 */
export interface CommitLoreRunOptions {
  indexFile?: string;
  /**
   * #1268 — the repository a commit attempt's command works on. Given, the child runs git in the environment
   * every pinned worker git child has (`pinnedGitEnvironment`), with `GIT_HARDENING` as git reads it from
   * the environment (`gitHardeningEnvironment`): no hook, fsmonitor, credential or askpass program the
   * repository names is run by CommitLore's git.
   */
  git?: CommitLoreGitTarget;
  /**
   * #1268 — a bound on this one command below the runner's `timeoutMs`, measured from its spawn like that one:
   * what is left of a deadline several commands share. Never a longer bound than the runner's.
   */
  timeoutMs?: number;
}

/**
 * The bounds one `commitlore` child runs under. `timeoutMs` is its whole answer; `maxOutputBytes` is what
 * is kept of each stream; `killGraceMs` is how long a child sent SIGTERM has before SIGKILL; `drainMs` is
 * how long its pipes may stay open after it exited.
 *
 * Slice S16 — `checkTimeoutMs` is `timeoutMs` for each of the pin's checks (`--version`, `doctor --help`,
 * `init --help`: `commitloreRunner`'s `ready`), a bound of their own: their time is never taken from a
 * command's.
 *
 * Review S16-R2-01 — `identityTimeoutMs` bounds each reading of the pin's identity (`commitlorePinIdentity`),
 * the binding and every re-check before a spawn: a bound of its own too, taken from no check's or command's.
 */
export interface CommitLoreLimits {
  timeoutMs: number;
  checkTimeoutMs: number;
  identityTimeoutMs: number;
  maxOutputBytes: number;
  killGraceMs: number;
  drainMs: number;
}

export const COMMITLORE_LIMITS: Readonly<CommitLoreLimits> = Object.freeze({
  timeoutMs: 180_000,
  checkTimeoutMs: 180_000,
  identityTimeoutMs: COMMITLORE_PIN_IDENTITY_TIMEOUT_MS,
  maxOutputBytes: 4 * 1024 * 1024,
  killGraceMs: 2_000,
  drainMs: 2_000,
});

/**
 * Review S11-R1-01 (CP-HI-05) — what a `commitlore` child is given: the environment ACP constructs for a
 * child it must not hand its authority to (`runtimeEnvironment`, the agent CLIs' own), with nothing
 * allowlisted on top. PATH, USER, TMPDIR, the locale and the git controls below, and nothing else: no
 * ACP, GitHub, Buzz or provider variable, and no `GIT_*` that would point CommitLore's own git calls away
 * from the checkout it runs in.
 *
 * Review S11-R3 (CEO cb5501eb) — nor any credential git would find on its own, for the child's git calls
 * and for every hook they run, which inherit this environment:
 * - HOME is `home`, this child's own (`commitloreChildHome`), not the daemon's: its git config routes
 *   GitHub to `gh`, and its `.netrc` is read by git's HTTP transport whatever the config says;
 * - the global config is the empty file in that home, and the system config is not read;
 * - no config is injected through the environment (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` and its
 *   `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`) except one command-scope `credential.helper=`, which git
 *   reads after every config file and which empties the helper list a repository's own config built;
 * - no askpass program (an empty `GIT_ASKPASS` stops git consulting `core.askPass` and `SSH_ASKPASS`) and
 *   no terminal prompt.
 * So a git call that needs a credential fails rather than finding one.
 *
 * #1268 — and no ssh program the repository names: `GIT_SSH_COMMAND=ssh`, which git prefers to
 * `core.sshCommand`, so `init` and `doctor` reaching an `ssh://` remote run the ordinary `ssh` (with the
 * operator's ssh config) rather than whatever the checkout's config names. Measured with the real CLI: a
 * marker-writing `core.sshCommand` ran 4 times across `init` and `doctor` without it, and 0 times with it.
 */
const INJECTED_GIT_CONFIG = /^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/;

const execFileAsync = promisify(execFile);

export const commitloreChildEnvironment = (home: string, git?: CommitLoreGitTarget): NodeJS.ProcessEnv => {
  const environment = runtimeEnvironment([], tmpdir());
  // #1268 — no external diff program from the environment either; one a repository's config names refuses the
  // run before CommitLore starts (`externalDiffConfigured`).
  for (const name of Object.keys(environment)) if (INJECTED_GIT_CONFIG.test(name) || name === "GIT_EXTERNAL_DIFF") delete environment[name];
  // #1268 — and the git ACP's own git calls run, first on its PATH (`acpGitDirectory`).
  const gitDirectory = acpGitDirectory();
  const configured: NodeJS.ProcessEnv = {
    ...environment,
    ...(gitDirectory === null ? {} : { PATH: [gitDirectory, environment["PATH"]].filter(Boolean).join(":") }),
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh",
    // #1268 — attributes are read from the empty tree, so no .gitattributes selects a diff, textconv,
    // filter or merge driver for this child's git (`gitIgnoresAttrSource` refuses a git that ignores it).
    GIT_ATTR_SOURCE: EMPTY_TREE[git?.objectFormat ?? "sha1"],

    ...(git === undefined
      ? {}
      : {
          ...pinnedGitEnvironment({ gitDir: git.gitDir, workTree: git.workTree }),
          ...gitHardeningEnvironment(git.installsHooks === true ? { except: [OBSERVATION_HARDENING_EXCEPTION] } : {}),
        }),
  };
  return configured;
};

/**
 * #1268 — whether the repository `git` names configures an external diff program (`diff.external`), which
 * CommitLore's `git diff --cached` would run on every diff, attributes or none. Neither emptying it in the
 * child's config nor an empty `GIT_EXTERNAL_DIFF` turns it off — git then tries to run "" and every diff dies —
 * so a repository that names one is refused before any CommitLore child runs. Read as the child would read
 * it: that git dir, no system or global config. Null when it names none; otherwise the reason.
 */
export const externalDiffConfigured = async (git: CommitLoreGitTarget): Promise<string | null> => {
  // No git dir is no repository, and no config of its own to name one.
  if (!existsSync(git.gitDir)) return null;
  try {
    await execFileAsync("git", ["config", "--get-all", "diff.external"], {
      env: {
        PATH: commitloreChildEnvironment(tmpdir())["PATH"] ?? "/usr/bin:/bin",
        GIT_DIR: git.gitDir,
        GIT_WORK_TREE: git.workTree,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        LC_ALL: "C",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    return "the repository's config names an external diff program (diff.external), which CommitLore's git diff would run";
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    // `git config --get` exits 1, printing nothing, when the key is not set.
    if (failed.code === 1 && (failed.stdout ?? "") === "") return null;
    return `whether the repository's config names an external diff program could not be read (${String(failed.stderr || failed.message || "").trim().slice(0, 200)})`;
  }
};

/**
 * #1268 — whether the repository `git` names has an attribute source `GIT_ATTR_SOURCE` does not replace: a
 * non-empty `$GIT_DIR/info/attributes` (git reads it whatever the attribute source), or a `core.attributesFile`
 * set in the repository's own config or anything it includes (global and system config are already blank for a
 * CommitLore child). Either could select a diff, textconv, filter or merge driver for CommitLore's git, so a
 * repository with one is refused before any CommitLore child runs. A driver that is only defined, with no
 * attribute naming it (an LFS-style filter), cannot fire, and is not refused. Null when there is none.
 */
export const attributeSourcesConfigured = async (git: CommitLoreGitTarget): Promise<string | null> => {
  // No git dir is no repository, and no attribute source of its own: CommitLore's git there reads nothing.
  if (!existsSync(git.gitDir)) return null;
  const env = {
    PATH: commitloreChildEnvironment(tmpdir())["PATH"] ?? "/usr/bin:/bin",
    GIT_DIR: git.gitDir,
    GIT_WORK_TREE: git.workTree,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/attributes"], { cwd: git.workTree, env, encoding: "utf8", timeout: 10_000 });
    const path = resolve(git.workTree, stdout.trim());
    let size = 0;
    try {
      size = statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size > 0) return `the repository has an info/attributes file, an attribute source GIT_ATTR_SOURCE does not replace`;
  } catch (error) {
    return `whether the repository has an info/attributes file could not be read (${(error as Error).message.slice(0, 200)})`;
  }
  try {
    await execFileAsync("git", ["config", "--get", "core.attributesFile"], { env, encoding: "utf8", timeout: 10_000 });
    return "the repository's config sets core.attributesFile, an attribute source GIT_ATTR_SOURCE does not replace";
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (failed.code === 1 && (failed.stdout ?? "") === "") return null;
    return `whether the repository's config sets core.attributesFile could not be read (${String(failed.stderr || failed.message || "").trim().slice(0, 200)})`;
  }
};

/**
 * A `commitlore` child's home: made for that one child under the system temporary directory, owner-only
 * (0700), holding nothing but the empty file its global git config is, and removed once the child has
 * exited or failed to start (`commitloreRunner`).
 */
export const commitloreChildHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "acp-commitlore-home-"));
  closeSync(openSync(join(home, ".gitconfig"), "wx", 0o600));
  return home;
};

/**
 * One `commitlore` child at `executable`: argv only, no shell, bounded in time and output, in the child
 * environment above (whose PATH does not carry it).
 *
 * Review S11-R1-02 — a deadline that expires and an output bound that is exceeded are failures fixed the
 * moment they happen: the answer is refused then, and nothing the child does afterwards, an exit 0 with a
 * passing report included, changes it. So is a child this invocation signalled, by `spawn`'s own `timeout`
 * or by itself: it never answered. Termination then escalates on this invocation's own child, through its
 * own handle and nothing else — SIGTERM, then SIGKILL after `killGraceMs` if it has not exited — never a
 * process id or a group. At most `maxOutputBytes` of each stream is kept, and the answer settles within
 * `timeoutMs`, or within `drainMs` of the child's exit when a descendant holds its pipes open.
 *
 * Review S16-R1-02 — `beforeSpawn` is the last thing done before the spawn, after the child's home and
 * environment are made: if it rejects, the answer is that refusal and nothing is spawned. Its time is not
 * the command's: the deadline starts at the spawn.
 *
 * Review S16-R2-01 — `beforeSpawn` is awaited, so the event loop keeps turning while it runs (the pin's
 * identity is read asynchronously, under its own deadline). The spawn follows its settling with no turn of
 * the event loop between them, only the promise's own continuation.
 */
const commitloreChild =
  (
    executable: string,
    limits: Readonly<CommitLoreLimits>,
    beforeSpawn: () => Promise<void> = async () => {},
    /** #1268 — what precedes `argv` on the command line: the copied bundle, when node runs it. */
    prefix: readonly string[] = [],
  ): CommitLoreRunner =>
  async (argv, cwd, options) => {
    const home = commitloreChildHome();
    const removeHome = (): void => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // What the child left there and made unremovable stays, in its owner-only directory: never a
        // reason to throw from this listener.
      }
    };
    const env = {
      ...commitloreChildEnvironment(home, options?.git),
      ...(options?.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
    };
    // #1268 — a command given a shorter bound runs under it; none is given a longer one.
    const timeoutMs = options?.timeoutMs === undefined ? limits.timeoutMs : Math.max(1, Math.min(limits.timeoutMs, Math.floor(options.timeoutMs)));
    try {
      await beforeSpawn();
    } catch (error) {
      removeHome();
      throw error as Error;
    }
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, [...prefix, ...argv], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        env,
      });
      child.once("exit", removeHome).once("error", removeHome);
      const kept: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
      const size: Record<"stdout" | "stderr", number> = { stdout: 0, stderr: 0 };
      let failure: string | null = null;
      let settled = false;
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let escalation: NodeJS.Timeout | null = null;
      let drain: NodeJS.Timeout | null = null;
      let deadline: NodeJS.Timeout | null = null;
      // The pipes are read, and what arrives discarded, until the child is gone: closed earlier, a child
      // still handling SIGTERM would meet EPIPE instead. Once it has exited they are closed, so a
      // descendant left holding them cannot keep this client reading.
      const release = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const settle = (answer: () => void): void => {
        if (settled) return;
        settled = true;
        if (deadline !== null) clearTimeout(deadline);
        if (drain !== null) clearTimeout(drain);
        if (exit !== null) release();
        answer();
      };
      const terminate = (): void => {
        if (exit !== null) return;
        child.kill("SIGTERM");
        escalation ??= setTimeout(() => {
          if (exit === null) child.kill("SIGKILL");
        }, limits.killGraceMs);
      };
      const stop = (reason: string): void => {
        failure ??= reason;
        terminate();
        settle(() => reject(new Error(`commitlore ${argv[0]} ${failure}`)));
      };
      deadline = setTimeout(() => stop(`did not answer within ${timeoutMs} ms`), timeoutMs);
      const keep = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        if (failure !== null) return;
        if (size[stream] + chunk.length > limits.maxOutputBytes) {
          stop(`wrote more than ${limits.maxOutputBytes} bytes to ${stream}, more than this client reads`);
          return;
        }
        size[stream] += chunk.length;
        kept[stream].push(chunk);
      };
      child.stdout.on("data", keep("stdout"));
      child.stderr.on("data", keep("stderr"));
      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", (code, signal) => {
        exit = { code, signal };
        if (escalation !== null) clearTimeout(escalation);
        if (settled) return release();
        // Signalled by this client — at the time bound `spawn` enforces, or here — or ended by a signal
        // from anywhere else: either way CommitLore did not answer, whatever its exit code says.
        if (child.killed) return stop(`was signalled before it answered (it then exited ${code ?? signal})`);
        if (code === null) return stop(`did not answer (${signal ?? "no signal"})`);
        drain = setTimeout(() => stop("exited and left its output open"), limits.drainMs);
      });
      child.once("close", () => {
        if (exit === null || exit.code === null || failure !== null || child.killed) return;
        const code = exit.code;
        settle(() =>
          resolvePromise({
            exitCode: code,
            stdout: Buffer.concat(kept.stdout).toString("utf8"),
            stderr: Buffer.concat(kept.stderr).toString("utf8"),
          }),
        );
      });
    });
  };

/**
 * Slice S16 — `commitlore` as a child: the executable `ACP_COMMITLORE_BINARY` pins (`commitlore-pin.ts`), read
 * when the runner is made, as the provider CLIs' pins are read when their adapters are made, and never
 * looked up on any PATH. Every command, and every check, is refused before it spawns unless the pin is a
 * usable absolute path. Called directly, the runner spawns the pin at once and checks nothing else.
 *
 * `ready` is the rest of the pin's checks: the CLI there answers a supported `--version`, has the
 * `doctor --json` command and has the `init` command with the options the observation passes, each asked
 * through the same bounded child in the same constructed environment. A pin that fails any of them is
 * refused, and the CLI port runs nothing else with it. They run once per observation, before its first
 * command (`createCommitLoreCliPort`), not inside each command: a command's call is its spawn, so its own
 * `timeoutMs` and its SIGTERM-then-SIGKILL escalation are measured from the moment it starts, never
 * shortened by the checks' time. Each check is bounded by `checkTimeoutMs` from its own spawn, with the
 * same output, grace and drain bounds, so an observation still ends within the sum of its five children's
 * bounds: three checks, then `init` and `doctor`, one at a time.
 *
 * Review S16-R1-02 — `ready` binds the file its checks run (`bindCommitLorePin`, before the first check) and
 * resolves with the runner the observation's commands use. Immediately before every spawn after that
 * binding — each of the three checks and both commands — and once after the last check, the pin is read
 * again and must still be that exact file (`assertCommitLorePinUnchanged`); otherwise it is refused as
 * REPLACED and nothing further is spawned. That is a re-check before each spawn, not an exec bound to the
 * checked bytes: the window from the re-check to the kernel's own resolution of the path at exec remains,
 * as `CommitLorePinIdentity` states.
 *
 * Review S16-R2-01 — each of those readings is asynchronous and bounded on its own: a file over
 * `COMMITLORE_PIN_MAX_BYTES` is refused on its descriptor's size before a byte is read, no reading takes
 * more than that cap plus one byte, and none outlasts `identityTimeoutMs`. Its time is no check's and no
 * command's: each child's bound starts at its own spawn.
 *
 * #1268 — after the three checks, `ready` asks `latest` for the newest published stable release and refuses
 * unless the version the pin answered is that release's (`judgeCommitLoreLatest`). It asks on every call,
 * never reusing an earlier answer, so each observation confirms its own; the production lookup is bounded by
 * `COMMITLORE_RELEASE_TIMEOUT_MS`.
 */
export const commitloreRunner = (
  limits: Readonly<CommitLoreLimits> = COMMITLORE_LIMITS,
  pin: string | undefined = process.env[COMMITLORE_BINARY_VARIABLE],
  latest: CommitLoreReleaseLookup = officialCommitLoreRelease,
): CommitLoreRunner & { readonly prepare: NonNullable<CommitLoreRunner["prepare"]> } => {
  const pinned = (): string => {
    const executable = commitlorePin(pin);
    if (!executable.allowed) throw new Error(executable.message);
    return executable.value;
  };
  const run = async (argv: readonly string[], cwd: string, options?: CommitLoreRunOptions): Promise<CommitLoreRun> =>
    commitloreChild(pinned(), limits)(argv, cwd, options);
  const prepare = async (cwd: string, git: CommitLoreGitTarget, options: { checked: boolean }): Promise<PreparedCommitLore> => {
    const executable = pinned();
    const bound = await bindCommitLorePin(executable, limits.identityTimeoutMs);
    // #1268 — a git that ignores GIT_ATTR_SOURCE would let a work tree's .gitattributes pick a program, and a
    // repository naming an external diff program would have every git diff run it: either refuses here.
    const attrSource = await gitIgnoresAttrSource(commitloreChildEnvironment(tmpdir())["PATH"] ?? "/usr/bin:/bin");
    if (attrSource !== null) throw new Error(`${COMMITLORE_BINARY_VARIABLE} UNSUPPORTED_GIT: ${attrSource}`);
    const external = (await externalDiffConfigured(git)) ?? (await attributeSourcesConfigured(git));
    if (external !== null) throw new Error(`${COMMITLORE_BINARY_VARIABLE} UNSUPPORTED_REPOSITORY: ${external}`);
    const snapshot = await snapshotCommitLorePackage(executable, bound);
    const dispose = (): void => disposeCommitLoreSnapshot(snapshot);
    try {
      // Before every spawn: the pin is still the file it was bound to, and the copy still the bytes written.
      const unchanged = async (): Promise<void> => {
        await assertCommitLorePinUnchanged(pinned(), bound, limits.identityTimeoutMs);
        await assertCommitLoreSnapshotUnchanged(snapshot);
      };
      if (options.checked) {
        const check = commitloreChild(process.execPath, { ...limits, timeoutMs: limits.checkTimeoutMs }, unchanged, [snapshot.entry]);
        const unsupported = await verifyCommitLorePin(executable, (argv, checkCwd) => check(argv, checkCwd, { git }), cwd, latest, snapshot.version);
        if (unsupported !== null) throw new Error(unsupported);
        await unchanged();
      }
      const command = commitloreChild(process.execPath, limits, unchanged, [snapshot.entry]);
      return {
        run: async (argv, commandCwd, commandOptions) => command(argv, commandCwd, { ...commandOptions, git }),
        dispose,
        identity: { version: snapshot.version, digest: snapshot.digest },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  };
  return Object.assign(run, { prepare, configured: pin !== undefined && pin !== "" });
};

/**
 * The production port: the pinned `commitlore` (`commitloreRunner`), run with `COMMITLORE_OBSERVATION_ARGV`.
 * A runner's `ready` is awaited once, before `init`; nothing runs if it refuses, and `init` and `doctor` run
 * through the runner it resolves with.
 *
 * #1268 — `attempt` prepares a checked copy of the package the pin loads once per commit attempt
 * (`commitloreRunner`'s `prepare`), and its commands run from that copy (`commitloreAttempt`). `contract`
 * prints the static drafting contract from an unchecked copy: it is text for a prompt, and the attempt that
 * commits is the one that checks. `beforeChange` reads from an unchecked copy for the same reason
 * (`commitloreBeforeChange`).
 */
export const createCommitLoreCliPort = (run: CommitLoreRunner = commitloreRunner()): CommitLorePort => ({
  async beforeChange(checkoutPath, git, request) {
    return commitloreBeforeChange(run, checkoutPath, git, request);
  },
  async contract(checkoutPath, git) {
    if (run.prepare === undefined) return unprepared();
    let prepared: PreparedCommitLore | null = null;
    try {
      prepared = await run.prepare(checkoutPath, git, { checked: false });
      const printed = await prepared.run(["harvest", "--prompt-only"], checkoutPath);
      if (printed.exitCode === 0 && printed.stdout.trim() !== "") return allow(ReasonCode.OK, printed.stdout);
      return deny(ReasonCode.VERIFICATION_GAP, `commitlore harvest --prompt-only exited ${printed.exitCode} without a contract`, {
        refusal: "COMMITLORE_NOT_RUN",
        stderr: tail(printed.stderr),
      });
    } catch (error) {
      return deny(ReasonCode.VERIFICATION_GAP, `commitlore harvest could not be run: ${(error as Error).message.slice(0, 300)}`, {
        refusal: "COMMITLORE_NOT_RUN",
      });
    } finally {
      prepared?.dispose();
    }
  },
  async attempt(checkoutPath, git) {
    if (run.prepare === undefined) return unprepared();
    try {
      const prepared = await run.prepare(checkoutPath, git, { checked: true });
      return allow(ReasonCode.OK, commitloreAttempt(prepared.run, prepared.dispose));
    } catch (error) {
      return deny(ReasonCode.VERIFICATION_GAP, `commitlore could not be run: ${(error as Error).message.slice(0, 300)}`, {
        refusal: "COMMITLORE_NOT_RUN",
      });
    }
  },
  async observe(checkoutPath) {
    const [initArgv, doctorArgv] = COMMITLORE_OBSERVATION_ARGV as [readonly string[], readonly string[]];
    // #1268 — every child of the observation runs from a checked copy of the package the pin loads, its git
    // under the worker's hardening bar the hooks path `init` installs into (`OBSERVATION_HARDENING_EXCEPTION`).
    let git = observationGitTarget(checkoutPath);
    let command: CommitLoreRunner = run;
    let prepared: PreparedCommitLore | null = null;
    if (run.prepare !== undefined) {
      try {
        // The empty tree of the repository's own object format (sha1 or sha256).
        git = observationGitTarget(checkoutPath, await repositoryObjectFormat(git.gitDir));
        prepared = await run.prepare(checkoutPath, git, { checked: true });
        command = prepared.run;
      } catch (error) {
        return fail(`commitlore could not be run: ${(error as Error).message.slice(0, 300)}`);
      }
    }
    try {
      let init: CommitLoreRun;
      try {
        init = await command(initArgv, checkoutPath, { git });
      } catch (error) {
        return fail(`commitlore init could not be run: ${(error as Error).message.slice(0, 300)}`);
      }
      // #1268 — doctor runs only after a ready init: exit 0, or an exit 1 whose one finding is its final check.
      const ready = judgeCommitLoreInit(init);
      if (ready.outcome !== "READY") return ready;
      let doctor: CommitLoreRun;
      try {
        doctor = await command(doctorArgv, checkoutPath, { git });
      } catch (error) {
        // #1268 — an accepted exit 1's final-check lines stay on this FAIL too, as on every FAIL after the init gate.
        return fail(`commitlore doctor could not be run: ${(error as Error).message.slice(0, 300)}`, ready.warnings);
      }
      return judgeCommitLoreRuns(init, doctor);
    } finally {
      prepared?.dispose();
    }
  },
});

/** #1268 — a runner that cannot copy and check a package runs no commit attempt. */
const unprepared = (): Decision<never> =>
  deny(ReasonCode.VERIFICATION_GAP, "this CommitLore runner cannot run a checked copy of its package, so it makes no commit", {
    refusal: "COMMITLORE_NOT_RUN",
  });

/** #1268 — `inject`'s budget, the CLI's own default, named so the argv says what it asks for. */
const INJECT_BUDGET_TOKENS = "800";
/** The tiers `inject` cuts from the bottom: a cut that reached one of these dropped a required value. */
const REQUIRED_TIERS: ReadonlySet<string> = new Set(["warn", "limit", "ruled-out"]);
/** The notice `inject`'s fixed template prints, at the start of a line, when its scan stopped early. */
const INJECT_SCAN_INCOMPLETE = /^incomplete: the scan stopped/m;

const failedLookup = (path: string, detail: string, cacheKey: string | null = null): CommitLorePathLookup => ({
  path,
  outcome: "failed",
  text: "",
  cacheKey,
  withheld: 0,
  items: null,
  detail: detail.slice(0, 400),
});

const parsedObject = (stdout: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Runs `jobs` at most `width` at a time, each result at its job's index. A job never throws here. */
const inPool = async <T>(width: number, jobs: ReadonlyArray<() => Promise<T>>): Promise<T[]> => {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await (jobs[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, jobs.length)) }, lane));
  return results;
};

/**
 * #1268 r1 P1-1 — every way `context --json` says its answer is not whole: an exit other than 0 (3 is "answered,
 * but the notes mirror is unfetched or the scan was truncated"), `coverage` other than `complete`, unread commits,
 * `history` other than `ready`, `notes` other than `present` or `absent`, and every entry of `diagnostics`. Each of
 * CommitLore's query diagnostics is a caveat on the answer (an unread index or scan, unreadable or shallow history,
 * unfetched notes, a checkout behind its upstream, capped rename aliases, withheld or masked values) and none says
 * it is whole, so each counts, by its presence and not by its wording, with one exception (`noHistory`). A field
 * missing or of an unknown value counts too: empty only for an answer CommitLore itself calls whole.
 *
 * The exception is the one diagnostic that is about the path rather than the answer's coverage: CommitLore's fixed
 * template (`pathPresenceDiagnostics`) for a path no commit in the history it read ever held, with that exact path
 * at its start and, optionally, its fixed hint naming an ancestor that does have history. It is recognised only in
 * that exact form; any other wording, or another path, is an ordinary diagnostic and counts.
 */
const pathWithoutHistory = (path: string): RegExp =>
  new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} matched no blob in the walked history, so 0 records is uninformative rather than a statement that nothing was recorded(?:; \\S+ does have history, so query that if the name has changed)?$`,
  );

const coverageGaps = (exitCode: number, context: Record<string, unknown>, path: string): { gaps: string[]; noHistory: boolean } => {
  const shown = (value: unknown): string => JSON.stringify(value ?? null).slice(0, 60);
  const gaps: string[] = [];
  if (exitCode !== 0) gaps.push(`commitlore context exited ${exitCode}`);
  if (context["coverage"] !== "complete") gaps.push(`coverage is ${shown(context["coverage"])}`);
  if (context["unreadCommits"] !== 0) gaps.push(`unreadCommits is ${shown(context["unreadCommits"])}`);
  if (context["history"] !== "ready") gaps.push(`history is ${shown(context["history"])}`);
  if (context["notes"] !== "present" && context["notes"] !== "absent") gaps.push(`notes are ${shown(context["notes"])}`);
  const diagnostics = context["diagnostics"];
  const withoutHistory = pathWithoutHistory(path);
  let noHistory = false;
  if (!Array.isArray(diagnostics)) gaps.push("it reported no diagnostics list");
  else {
    for (const diagnostic of diagnostics) {
      if (typeof diagnostic === "string" && withoutHistory.test(diagnostic)) noHistory = true;
      else gaps.push(`it said: ${String(diagnostic).slice(0, 160)}`);
    }
  }
  return { gaps, noHistory };
};

/** #1268 r1 — how many records `context --json` reports CommitLore withheld as `[blocked]`. */
const blockedRecords = (records: unknown): number =>
  Array.isArray(records) ? records.filter((record) => (record as { trust?: unknown } | null)?.trust === "blocked").length : 0;

/** The required values `context --json` reports for a path, from active records CommitLore did not withhold. */
const requiredItems = (records: unknown): CommitLoreRequiredItem[] | null => {
  if (!Array.isArray(records)) return null;
  const items: CommitLoreRequiredItem[] = [];
  for (const entry of records) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    // A withheld record's content is the attack: nothing of it is carried, its count comes from `inject`.
    if (record["trust"] === "blocked" || record["lifecycle"] !== "active" || !Array.isArray(record["trailers"])) continue;
    for (const trailer of record["trailers"] as unknown[]) {
      const { key, value } = (trailer ?? {}) as { key?: unknown; value?: unknown };
      if (typeof value !== "string" || !(COMMITLORE_REQUIRED_KEYS as readonly unknown[]).includes(key)) continue;
      items.push({
        recordId: typeof record["recordId"] === "string" ? record["recordId"] : null,
        sha: typeof record["sha"] === "string" ? record["sha"] : "",
        trust: typeof record["trust"] === "string" ? record["trust"] : "unknown",
        key: key as CommitLoreRequiredKey,
        value,
      });
    }
  }
  // Warn, then Limit, then Ruled-out, as `inject` orders its tiers; within one, as `context` listed them.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => COMMITLORE_REQUIRED_KEYS.indexOf(a.item.key) - COMMITLORE_REQUIRED_KEYS.indexOf(b.item.key) || a.index - b.index)
    .map(({ item }) => item);
};

/**
 * #1268 — what CommitLore holds for the paths a worker may change, before it starts, from an unchecked copy of
 * the pinned package (`prepare` with `checked: false`, as `contract` reads its text: this too is text for a
 * prompt, and the commit attempt is the one that checks).
 *
 * - Each path: first `context --json`, whose structured answer says whether CommitLore's answer for the path is
 *   whole (`coverageGaps`; r1 P1-1): one that is not is `incomplete`, whatever else it holds. Then
 *   `inject --path <p> --json --budget 800`, CommitLore's own pre-edit projection, which is what is delivered,
 *   except where its budget provably cut a required value (`truncatedAt` is `warn`, `limit` or `ruled-out`; the
 *   tiers are cut from the bottom, so a cut that reaches only `other` dropped none): then every Warn, Limit and
 *   Ruled-out value `context` listed is. An answer at any head but `baseHead` is never an answer.
 * - Once: `guard --proposal @<file> --json` on those paths, the proposal written into `scratch`.
 * - Every command with `--no-index`: the index lives in the git dir, whose entries the turn is held to from
 *   before this lookup, and reading it rewrites its WAL files and its directory. CommitLore answers the same
 *   from git alone, slower.
 * - At most `concurrency` children at once, each bounded by what is left of `deadline`, and none started after
 *   it: whatever has not answered by then failed. Each part is `report`ed the moment it is decided (r2).
 *
 * Null when this deployment pins no CommitLore at all; never a refusal: the caller decides what a gap means.
 */
export const commitloreBeforeChange = async (
  run: CommitLoreRunner,
  checkoutPath: string,
  git: CommitLoreGitTarget,
  request: CommitLoreBeforeChangeRequest,
): Promise<CommitLoreBeforeChange | null> => {
  if (run.configured === false) return null;
  const unanswered = (detail: string): CommitLoreBeforeChange => ({
    paths: request.paths.map((path) => failedLookup(path, detail)),
    guard: { status: "not_consulted", matches: [], detail },
    cliIdentity: null,
  });
  if (run.prepare === undefined) return unanswered("this CommitLore runner cannot run a copy of its package");
  const left = (): number => request.deadline - Date.now();
  let prepared: PreparedCommitLore;
  let timer: NodeJS.Timeout | undefined;
  try {
    const preparing = run.prepare(checkoutPath, git, { checked: false });
    const expired = new Promise<null>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(null), Math.max(0, left()));
    });
    const ready = await Promise.race([preparing, expired]);
    if (ready === null) {
      // Prepared after the deadline: removed when it arrives, never used.
      preparing.then((late) => late.dispose(), () => {});
      return unanswered("CommitLore could not be prepared before the lookup's deadline");
    }
    prepared = ready;
    if (prepared.identity !== undefined) request.report?.({ kind: "identity", identity: prepared.identity });
  } catch (error) {
    return unanswered(`commitlore could not be run: ${(error as Error).message.slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
  }
  try {
    const command = async (argv: readonly string[]): Promise<CommitLoreRun> => {
      const remaining = left();
      if (remaining <= 0) throw new Error(`commitlore ${argv[0]} was not started: the lookup's deadline had passed`);
      return prepared.run(argv, checkoutPath, { timeoutMs: remaining });
    };
    const proposalPath = join(request.scratch, "commitlore-guard-proposal.txt");
    writeFileSync(proposalPath, request.proposal, { mode: 0o600 });

    const guardLookup = async (): Promise<CommitLoreGuardLookup> => {
      let answer: CommitLoreRun;
      try {
        answer = await command(["guard", "--proposal", `@${proposalPath}`, "--json", "--no-index", "--", ...request.paths]);
      } catch (error) {
        return { status: "not_consulted", matches: [], detail: `commitlore guard did not answer: ${(error as Error).message.slice(0, 300)}` };
      }
      const parsed = [0, 1, 3].includes(answer.exitCode) ? parsedObject(answer.stdout) : null;
      if (parsed === null || !Array.isArray(parsed["matches"]) || typeof parsed["matched"] !== "boolean") {
        return { status: "not_consulted", matches: [], detail: `commitlore guard exited ${answer.exitCode} without its answer: ${tail(answer.stderr)}` };
      }
      const matches = (parsed["matches"] as unknown[]).map((entry): CommitLoreGuardMatch => {
        const match = (entry ?? {}) as Record<string, unknown>;
        const blocked = match["trust"] === "blocked";
        return {
          recordId: typeof match["recordId"] === "string" ? match["recordId"] : null,
          sha: typeof match["sha"] === "string" ? match["sha"] : "",
          score: typeof match["score"] === "number" ? match["score"] : 0,
          trust: typeof match["trust"] === "string" ? match["trust"] : "unknown",
          alternative: !blocked && typeof match["alternative"] === "string" ? match["alternative"] : null,
          reason: !blocked && typeof match["reason"] === "string" ? match["reason"] : null,
        };
      });
      if (answer.exitCode === 1 || parsed["matched"] === true) return { status: "matched", matches, detail: null };
      if (answer.exitCode === 3 || parsed["incomplete"] === true) return { status: "incomplete", matches, detail: "commitlore guard's check was incomplete" };
      return { status: "clean", matches: [], detail: null };
    };

    const pathLookup = async (path: string): Promise<CommitLorePathLookup> => {
      // r1 P1-1 — whether CommitLore's answer for the path is whole is read from `context --json`, its structured
      // answer, and never from what `inject` printed: with the notes mirror unfetched, `inject` exits 0 with
      // nothing to say, and the only sign is a line on its stderr.
      let listed: CommitLoreRun;
      try {
        listed = await command(["context", "--json", "--no-index", "--", path]);
      } catch (error) {
        return failedLookup(path, `commitlore context did not answer: ${(error as Error).message.slice(0, 300)}`);
      }
      const context = listed.exitCode === 0 || listed.exitCode === 3 ? parsedObject(listed.stdout) : null;
      const items = context === null ? null : requiredItems(context["records"]);
      if (context === null || items === null) {
        return failedLookup(path, `commitlore context exited ${listed.exitCode} without its answer: ${tail(listed.stderr)}`);
      }
      const vantage = (context["vantage"] ?? {}) as { head?: unknown };
      if (vantage.head !== request.baseHead) return failedLookup(path, `commitlore context answered at ${String(vantage.head)}, not at the turn's base ${request.baseHead}`);
      const blocked = blockedRecords(context["records"]);
      const { gaps, noHistory } = coverageGaps(listed.exitCode, context, path);
      if (gaps.length > 0) {
        return { path, outcome: "incomplete", text: "", cacheKey: null, withheld: blocked, items: null, detail: `CommitLore's answer for this path is not whole: ${gaps.join("; ")}`.slice(0, 400) };
      }
      let injected: CommitLoreRun;
      try {
        injected = await command(["inject", "--path", path, "--json", "--budget", INJECT_BUDGET_TOKENS, "--no-index"]);
      } catch (error) {
        return failedLookup(path, `commitlore inject did not answer: ${(error as Error).message.slice(0, 300)}`);
      }
      const injection = injected.exitCode === 0 ? parsedObject(injected.stdout) : null;
      const { text, cacheKey, head, withheld, truncatedAt } = injection ?? {};
      if (typeof text !== "string" || typeof cacheKey !== "string" || typeof head !== "string" || typeof withheld !== "number") {
        return failedLookup(path, `commitlore inject exited ${injected.exitCode} without its projection: ${tail(injected.stderr)}`);
      }
      if (head !== request.baseHead) return failedLookup(path, `commitlore inject answered at ${head || "no commit"}, not at the turn's base ${request.baseHead}`, cacheKey);
      const answered = { path, text, cacheKey, withheld: Math.max(withheld, blocked), items: null, detail: null, noHistory };
      if (INJECT_SCAN_INCOMPLETE.test(text)) {
        return { ...answered, outcome: "incomplete", detail: "CommitLore's scan stopped at its time budget, so records for this path may be missing" };
      }
      // Only where `inject`'s budget provably dropped a required value does the section carry `context`'s list.
      if (typeof truncatedAt !== "string" || !REQUIRED_TIERS.has(truncatedAt)) return { ...answered, outcome: "answered" };
      return { ...answered, outcome: "answered", items };
    };

    // r2 — each part is told as it is decided, so a deadline that passes on one keeps the others.
    const [guard, ...paths] = await inPool<CommitLoreGuardLookup | CommitLorePathLookup>(request.concurrency, [
      async () => {
        const lookup = await guardLookup();
        request.report?.({ kind: "guard", lookup });
        return lookup;
      },
      ...request.paths.map((path) => async () => {
        const lookup = await pathLookup(path);
        request.report?.({ kind: "path", lookup });
        return lookup;
      }),
    ]);
    return {
      paths: paths as CommitLorePathLookup[],
      guard: guard as CommitLoreGuardLookup,
      cliIdentity: prepared.identity ?? null,
    };
  } catch (error) {
    return unanswered(`the CommitLore lookup did not complete: ${(error as Error).message.slice(0, 300)}`);
  } finally {
    prepared.dispose();
  }
};

const refuse = (refusal: string, message: string, evidence: Record<string, unknown>): Decision<CommitLoreObservation> =>
  deny(ReasonCode.VERIFICATION_GAP, message, { refusal, ...evidence });

/**
 * A required CommitLore observation in `checkoutPath`: the port's PASS, and the checkout's status unchanged
 * by it — `init` may place hooks under `.git`, but a file it leaves in the working tree is not the approved
 * tree and is refused rather than published, ignored or removed. A port that throws has observed nothing.
 * `--no-agent-hooks` asks `init` to write nothing there; this check does not rely on it, and still refuses
 * any change in the working tree after the observation, a user's change made before it included.
 */
export const requiredCommitLoreObservation = async (
  port: CommitLorePort | null,
  checkoutPath: string,
  evidence: Record<string, unknown> = {},
): Promise<Decision<CommitLoreObservation>> => {
  if (port === null) {
    return refuse(
      "COMMITLORE_REQUIRED_UNOBSERVABLE",
      "the approved manifest requires CommitLore, and this deployment has no CommitLore observer to verify it with",
      { commitloreMode: "required", ...evidence },
    );
  }
  let observation: CommitLoreObservation;
  try {
    observation = await port.observe(checkoutPath);
  } catch (error) {
    observation = fail(`the CommitLore observation did not complete: ${(error as Error).message.slice(0, 300)}`);
  }
  if (observation.outcome !== "PASS") {
    return refuse(
      "COMMITLORE_REQUIRED_NOT_OBSERVED",
      `the approved manifest requires CommitLore, and its verification did not pass: ${observation.detail}`,
      { commitloreMode: "required", observation, ...evidence },
    );
  }
  const status = await git(checkoutPath, ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  if (status.exitCode !== 0 || status.stdout.trim() !== "") {
    return refuse(
      "COMMITLORE_CHANGED_CHECKOUT",
      "CommitLore changed the checkout's working tree, or its state could not be read, so the tree is no longer the approved one",
      { commitloreMode: "required", status: tail(status.stdout || status.stderr), ...evidence },
    );
  }
  return allow(ReasonCode.OK, observation);
};

/**
 * Before anything is consumed or written: whether CommitLore can be observed on this host at all, in a
 * scratch repository of its own under the system temporary directory, removed afterwards. It proves the
 * CLI runs and passes and leaves the working tree alone; the observation the result reports is made again
 * in the real checkout, at the head that is published.
 */
export const probeCommitLore = async (port: CommitLorePort | null): Promise<Decision<CommitLoreObservation>> => {
  if (port === null) return requiredCommitLoreObservation(null, "", { at: "probe" });
  // #1268 — a required CommitLore also makes the bootstrap's own commits: one that cannot is no CommitLore here.
  if (port.attempt === undefined) {
    return refuse("COMMITLORE_REQUIRED_UNOBSERVABLE", "the approved manifest requires CommitLore, and this deployment's CommitLore cannot make a commit", {
      commitloreMode: "required",
      at: "probe",
    });
  }
  const scratch = mkdtempSync(join(tmpdir(), "acp-commitlore-probe-"));
  try {
    const init = await git(scratch, ["init", "-q"], { allowFailure: true });
    if (init.exitCode !== 0) {
      return refuse("COMMITLORE_REQUIRED_NOT_OBSERVED", "a scratch repository to probe CommitLore in could not be created", {
        commitloreMode: "required",
        at: "probe",
        stderr: tail(init.stderr),
      });
    }
    return await requiredCommitLoreObservation(port, scratch, { at: "probe" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** Whether `result` reports a passing CommitLore verification for `repositoryIdentity` at exactly `head`. */
export const commitloreObserved = (result: RepoFactoryResult, repositoryIdentity: string, head: string): boolean =>
  result.bootstrapVerification.some(
    (row) =>
      row.commandId === COMMITLORE_VERIFICATION_ID &&
      row.repositoryIdentity === repositoryIdentity &&
      row.exactHead === head &&
      row.status === "PASS",
  );

/**
 * The activation gate on a producer result whose repository facts are `facts`: `required` (and any value
 * the contract does not define) is refused unless every repository carries a passing CommitLore row at the
 * fact's head. `preferred` and `off` pass; `observed` says whether the row was there, so activation can
 * name a preferred CommitLore NOT_OBSERVED rather than pass over it.
 */
export const commitloreActivationGate = (
  mode: unknown,
  result: RepoFactoryResult,
  facts: ReadonlyArray<{ identity: string; head: string | null }>,
): Decision<{ observed: boolean }> => {
  const observed = facts.length > 0 && facts.every((fact) => fact.head !== null && commitloreObserved(result, fact.identity, fact.head));
  if (!commitloreRequired(mode) || observed) return allow(ReasonCode.OK, { observed });
  return deny(
    ReasonCode.VERIFICATION_GAP,
    "the approved manifest requires CommitLore, and the producer result carries no passing CommitLore verification at the published head",
    {
      refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED",
      commitloreMode: mode,
      expected: { commandId: COMMITLORE_VERIFICATION_ID, repositories: facts.map(({ identity, head }) => ({ identity, head })) },
    },
  );
};

/**
 * Review S11-R1-03 (CEO 49883a25) — the record of a passing CommitLore observation, kept beside the attempt
 * that made it: in the run's work directory, next to the attempt ledger, never in the database. The
 * producer creates it once, exclusively, in the attempt's own checkout's name, when the observation at
 * the published head passes and before the result is stored. It binds that PASS to the run and operation,
 * the attempt (its checkout), the repository identity, the published head and the doctor's report, which
 * it holds whole together with that report's digest.
 */
export const COMMITLORE_OBSERVATION_RECORD_SCHEMA_ID = "acp.bootstrap.commitlore-observation.v1";

const observationRecordSchema = z
  .object({
    schema: z.literal(COMMITLORE_OBSERVATION_RECORD_SCHEMA_ID),
    runId: z.string().min(1),
    bootstrapOperationId: z.string().min(1),
    checkoutPath: z.string().min(1),
    repositoryIdentity: z.string().min(1),
    head: z.string().min(1),
    argv: z.array(z.array(z.string())),
    reportStatus: z.enum(["ok", "degraded"]),
    reportDigest: z.string().min(1),
    report: z.string(),
  })
  .strict();

export type CommitLoreObservationRecord = z.infer<typeof observationRecordSchema>;

/** The attempt whose checkout is `checkoutPath` keeps its record here: one file per attempt, never shared. */
export const commitloreObservationPath = (workDir: string, checkoutPath: string): string =>
  join(resolve(workDir), "commitlore-observation", `${basename(checkoutPath)}.json`);

/** The bound values a record must carry exactly. */
export interface CommitLoreBinding {
  runId: string;
  bootstrapOperationId: string;
  checkoutPath: string;
  repositoryIdentity: string;
  head: string | null;
}

const unrecorded = <T>(refusal: string, message: string, evidence: Record<string, unknown>): Decision<T> =>
  deny(ReasonCode.VERIFICATION_GAP, message, { refusal, commitloreMode: "required", ...evidence });

/**
 * Writes the record of `observation` for `binding`, once and whole: created exclusively (a record already
 * there for this attempt's checkout is not this observation's, and is refused rather than replaced), its
 * bytes the framed record, then the file and its directory synced. Anything short of that refuses, and the
 * producer then reports no result.
 */
export const writeCommitLoreObservationRecord = (
  workDir: string,
  binding: CommitLoreBinding & { head: string },
  observation: Extract<CommitLoreObservation, { outcome: "PASS" }>,
): Decision<CommitLoreObservationRecord> => {
  const path = commitloreObservationPath(workDir, binding.checkoutPath);
  const record: CommitLoreObservationRecord = {
    schema: COMMITLORE_OBSERVATION_RECORD_SCHEMA_ID,
    ...binding,
    argv: COMMITLORE_OBSERVATION_ARGV.map((argv) => [...argv]),
    reportStatus: observation.reportStatus,
    reportDigest: sha256(observation.report),
    report: observation.report,
  };
  const directory = join(resolve(workDir), "commitlore-observation");
  try {
    ensurePrivateDirectory(resolve(workDir));
    ensurePrivateDirectory(directory);
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return unrecorded("COMMITLORE_OBSERVATION_CONFLICT", "a CommitLore observation record already exists for this attempt's checkout", { path });
    }
    try {
      writeWholeSync(descriptor, frameRecord(record));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const handle = openSync(directory, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    return unrecorded("COMMITLORE_OBSERVATION_UNRECORDED", "the CommitLore observation could not be recorded beside its attempt", {
      path,
      message: (error as Error).message,
    });
  }
  return allow(ReasonCode.OK, record);
};

/**
 * The record at `path`, or null when there is none. A symlink, a non-file, another account's file, one
 * writable by others, bytes that are not the whole framed record, or a record of another shape refuse.
 */
const readCommitLoreObservationRecord = (path: string): Decision<CommitLoreObservationRecord | null> => {
  const unreadable = (message: string, evidence: Record<string, unknown> = {}) =>
    unrecorded<CommitLoreObservationRecord | null>("COMMITLORE_OBSERVATION_UNREADABLE", message, { path, ...evidence });
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return allow(ReasonCode.OK, null);
    return unreadable("the CommitLore observation record could not be inspected", { message: (error as Error).message });
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  ) {
    return unreadable("the CommitLore observation record is not a private regular file of this account");
  }
  let content: unknown;
  try {
    content = unframeRecord(readFileSync(path));
  } catch (error) {
    return unreadable("the CommitLore observation record could not be read", { message: (error as Error).message });
  }
  const parsed = content === null ? null : observationRecordSchema.safeParse(content);
  if (parsed === null || !parsed.success) return unreadable("the CommitLore observation record is not a whole record of its schema");
  return allow(ReasonCode.OK, parsed.data);
};

/**
 * Review S11-R1-03 (CEO 49883a25) — the binding a CommitLore verification row in a stored result must
 * hold before anything is activated or completed on it: asked by the runner on activation after
 * production, and by the completion chain a WRITTEN retry and every CONFIRM run on (`writtenChain`), with
 * the same `expected` values — the application's run, operation and repository identity, its last
 * attempt's checkout, and the head that chain reads back from the attempt ledger.
 *
 * Under a mode that requires CommitLore, and whenever the result carries a CommitLore row at all (the
 * producer writes one only when it required and observed CommitLore), every such row must be a PASS for
 * exactly that repository and head, and the attempt's record must exist, be this account's own whole
 * record, name exactly the expected run, operation, checkout, identity and head, state the digest of the
 * report it holds, and that report must still be judged a PASS. Anything missing or different refuses.
 *
 * The boundary: the record and the attempt ledger live outside the database, and that is the whole of
 * their independence — nothing compared here inside the database is evidence of anything else in it. This
 * refuses what a database writer alone can do: a PASS row put in a stored result after a refused
 * observation, a result moved to another attempt or head, or a row whose record is missing or differs. It
 * does not stand against a writer of this account's files as well: one who also writes the work directory
 * can write a record, a ledger and a checkout marker that agree with forged rows, every bound value
 * together, and this check then passes. Nothing here re-runs CommitLore; the report it holds is the
 * producer's, judged again only as text.
 */
export const verifyCommitLoreBinding = (input: {
  mode: unknown;
  result: RepoFactoryResult;
  workDir: string;
  expected: CommitLoreBinding;
}): Decision<void> => {
  const { mode, result, workDir, expected } = input;
  const rows = result.bootstrapVerification.filter((row) => row.commandId === COMMITLORE_VERIFICATION_ID);
  if (!commitloreRequired(mode) && rows.length === 0) return allow(ReasonCode.OK, undefined);
  const path = commitloreObservationPath(workDir, expected.checkoutPath);
  const unbound = (message: string, evidence: Record<string, unknown> = {}): Decision<void> =>
    deny(ReasonCode.VERIFICATION_GAP, message, {
      refusal: "COMMITLORE_OBSERVATION_UNBOUND",
      commitloreMode: mode,
      recordPath: path,
      expected,
      ...evidence,
    });
  if (rows.length === 0) return unbound("the approved manifest requires CommitLore, and the result carries no CommitLore verification");
  const stray = rows.filter(
    (row) => row.status !== "PASS" || row.repositoryIdentity !== expected.repositoryIdentity || row.exactHead !== expected.head,
  );
  if (expected.head === null || stray.length > 0) {
    return unbound("a CommitLore verification row is not a PASS for this repository at the published head", { rows });
  }
  const read = readCommitLoreObservationRecord(path);
  if (!read.allowed) return read as Decision<void>;
  const record = read.value;
  if (record === null) {
    return unbound("no CommitLore observation was recorded for this attempt, so the CommitLore verification the result carries is not one it made");
  }
  const differing = (["runId", "bootstrapOperationId", "checkoutPath", "repositoryIdentity", "head"] as const).filter(
    (field) => record[field] !== expected[field],
  );
  if (differing.length > 0) {
    return unbound("the CommitLore observation record names another run, operation, attempt, repository or head", { differing });
  }
  if (sha256(record.report) !== record.reportDigest) {
    return unbound("the CommitLore observation record's report is not the one its digest names");
  }
  const judged = judgeCommitLoreRuns({ exitCode: 0, stdout: "", stderr: "" }, { exitCode: 0, stdout: record.report, stderr: "" });
  if (judged.outcome !== "PASS" || judged.reportStatus !== record.reportStatus) {
    return unbound("the report the CommitLore observation record holds is not a passing one", { judged: judged.detail });
  }
  return allow(ReasonCode.OK, undefined);
};
