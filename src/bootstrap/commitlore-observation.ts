import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectManifest } from "../contracts/manifest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git } from "../git/git.ts";
import type { RepoFactoryResult } from "./repo-factory-result.ts";

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

export type CommitLoreObservation =
  | { outcome: "PASS"; reportStatus: "ok" | "degraded"; warnings: string[]; detail: string }
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
  return { outcome: "PASS", reportStatus: status as "ok" | "degraded", warnings, detail: "commitlore doctor passed" };
};

export type CommitLoreRunner = (argv: readonly string[], cwd: string) => Promise<CommitLoreRun>;

const COMMITLORE_TIMEOUT_MS = 180_000;
const COMMITLORE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The caller's environment without any `GIT_*` variable, so CommitLore's own git calls address `cwd`. */
const commitloreChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));

/** `commitlore` as a child: argv only, no shell, a time bound and an output bound. A spawn failure rejects. */
const spawnCommitLore: CommitLoreRunner = (argv, cwd) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("commitlore", [...argv], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMITLORE_TIMEOUT_MS,
      env: commitloreChildEnv(process.env),
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > COMMITLORE_MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > COMMITLORE_MAX_OUTPUT_BYTES) stderr = stderr.slice(-COMMITLORE_MAX_OUTPUT_BYTES);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (overflow) return reject(new Error(`commitlore ${argv[0]} produced more output than this client reads`));
      // Killed, by the time bound or anything else, is not CommitLore answering.
      if (code === null) return reject(new Error(`commitlore ${argv[0]} did not answer (${signal ?? "no signal"})`));
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  });

/** The production port: the `commitlore` on this process's PATH, run with `COMMITLORE_OBSERVATION_ARGV`. */
export const createCommitLoreCliPort = (run: CommitLoreRunner = spawnCommitLore): CommitLorePort => ({
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
