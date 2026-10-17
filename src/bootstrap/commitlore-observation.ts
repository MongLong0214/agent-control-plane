import { spawn } from "node:child_process";
import { type Stats, closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import type { ProjectManifest } from "../contracts/manifest.ts";
import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { git } from "../git/git.ts";
import { resolveExecutable, runtimeEnvironment } from "../runtime/cli-adapters.ts";
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

/** The fixed argv this producer runs, in this order. Nothing in a plan or manifest reaches it. */
export const COMMITLORE_OBSERVATION_ARGV: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(["init", "--mcp-scope", "none", "--no-unattended"]),
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
  /** `commitlore init --mcp-scope none --no-unattended`, then `commitlore doctor --json`, in `checkoutPath`. */
  observe(checkoutPath: string): Promise<CommitLoreObservation>;
}

/**
 * Whether the mode holds the gate shut without a passing observation. Fail closed: only the two lenient
 * values the manifest contract defines are lenient, so an unsupported value is never downgraded.
 */
export const commitloreRequired = (mode: unknown): boolean => mode !== "preferred" && mode !== "off";

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
 * The verdict on one `init` + `doctor --json` pair, as `publish.py observe_commitlore` gives it: PASS only
 * when both exit 0 and the doctor's report is a well-formed `commitlore_doctor.v2` report that does not
 * contradict its exit code (status `failed`, a `fail` check, or a non-zero `exitCode` field). Every check
 * that is not `ok` is carried as a warning. `run` is `null` for a step that could not be run at all.
 */
export const judgeCommitLoreRuns = (init: CommitLoreRun | null, doctor: CommitLoreRun | null): CommitLoreObservation => {
  if (init === null) return fail("commitlore init could not be run");
  if (init.exitCode !== 0) {
    return fail(`commitlore init failed (${init.exitCode}): ${tail(init.stderr) || tail(init.stdout) || "no diagnostic output"}`);
  }
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

export type CommitLoreRunner = (argv: readonly string[], cwd: string) => Promise<CommitLoreRun>;

/**
 * The bounds one `commitlore` child runs under. `timeoutMs` is its whole answer; `maxOutputBytes` is what
 * is kept of each stream; `killGraceMs` is how long a child sent SIGTERM has before SIGKILL; `drainMs` is
 * how long its pipes may stay open after it exited.
 */
export interface CommitLoreLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs: number;
  drainMs: number;
}

export const COMMITLORE_LIMITS: Readonly<CommitLoreLimits> = Object.freeze({
  timeoutMs: 180_000,
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
 */
const INJECTED_GIT_CONFIG = /^GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)$/;

export const commitloreChildEnvironment = (home: string): NodeJS.ProcessEnv => {
  const environment = runtimeEnvironment([], tmpdir());
  for (const name of Object.keys(environment)) if (INJECTED_GIT_CONFIG.test(name)) delete environment[name];
  return {
    ...environment,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
  };
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
 * `commitlore` as a child: resolved on this process's PATH before the child's environment is built (that
 * environment's PATH does not carry it), argv only, no shell, bounded in time and output.
 *
 * Review S11-R1-02 — a deadline that expires and an output bound that is exceeded are failures fixed the
 * moment they happen: the answer is refused then, and nothing the child does afterwards, an exit 0 with a
 * passing report included, changes it. So is a child this invocation signalled, by `spawn`'s own `timeout`
 * or by itself: it never answered. Termination then escalates on this invocation's own child, through its
 * own handle and nothing else — SIGTERM, then SIGKILL after `killGraceMs` if it has not exited — never a
 * process id or a group. At most `maxOutputBytes` of each stream is kept, and the answer settles within
 * `timeoutMs`, or within `drainMs` of the child's exit when a descendant holds its pipes open.
 */
export const commitloreRunner =
  (limits: Readonly<CommitLoreLimits> = COMMITLORE_LIMITS): CommitLoreRunner =>
  (argv, cwd) =>
    new Promise((resolvePromise, reject) => {
      const home = commitloreChildHome();
      const child = spawn(resolveExecutable("commitlore"), [...argv], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: limits.timeoutMs,
        env: commitloreChildEnvironment(home),
      });
      const removeHome = (): void => {
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          // What the child left there and made unremovable stays, in its owner-only directory: never a
          // reason to throw from this listener.
        }
      };
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
      deadline = setTimeout(() => stop(`did not answer within ${limits.timeoutMs} ms`), limits.timeoutMs);
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

/** The production port: the `commitlore` on this process's PATH, run with `COMMITLORE_OBSERVATION_ARGV`. */
export const createCommitLoreCliPort = (run: CommitLoreRunner = commitloreRunner()): CommitLorePort => ({
  async observe(checkoutPath) {
    const [initArgv, doctorArgv] = COMMITLORE_OBSERVATION_ARGV as [readonly string[], readonly string[]];
    let init: CommitLoreRun;
    try {
      init = await run(initArgv, checkoutPath);
    } catch (error) {
      return fail(`commitlore init could not be run: ${(error as Error).message.slice(0, 300)}`);
    }
    if (init.exitCode !== 0) return judgeCommitLoreRuns(init, null);
    let doctor: CommitLoreRun;
    try {
      doctor = await run(doctorArgv, checkoutPath);
    } catch (error) {
      return fail(`commitlore doctor could not be run: ${(error as Error).message.slice(0, 300)}`);
    }
    return judgeCommitLoreRuns(init, doctor);
  },
});

const refuse = (refusal: string, message: string, evidence: Record<string, unknown>): Decision<CommitLoreObservation> =>
  deny(ReasonCode.VERIFICATION_GAP, message, { refusal, ...evidence });

/**
 * A required CommitLore observation in `checkoutPath`: the port's PASS, and the checkout's status unchanged
 * by it — `init` may place hooks under `.git`, but a file it leaves in the working tree is not the approved
 * tree and is refused rather than published, ignored or removed. A port that throws has observed nothing.
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
