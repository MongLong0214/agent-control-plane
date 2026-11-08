import { chmodSync, copyFileSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  COMMITLORE_OBSERVATION_ARGV,
  COMMITLORE_VERIFICATION_ID,
  type CommitLoreBinding,
  type CommitLoreObservation,
  type CommitLoreRun,
  commitloreActivationGate,
  commitloreChildEnvironment,
  commitloreObservationPath,
  commitloreRequired,
  createCommitLoreCliPort,
  judgeCommitLoreRuns,
  verifyCommitLoreBinding,
  writeCommitLoreObservationRecord,
} from "../../src/bootstrap/commitlore-observation.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Issue #246 B3 — the CommitLore verdict a required manifest rests on, judged as the Python Repo Factory
 * producer judges it (`publish.py observe_commitlore`), and the activation gate per mode. No real
 * `commitlore` runs here: the CLI port is driven through a runner double.
 */

const ok = (stdout = ""): CommitLoreRun => ({ exitCode: 0, stdout, stderr: "" });
const report = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: "commitlore_doctor.v2",
    status: "ok",
    exitCode: 0,
    checks: [{ id: "commit-msg-hook", status: "ok" }],
    ...overrides,
  });

const HEAD = "a".repeat(40);
const IDENTITY = "github:acme/fixture";
const resultWith = (rows: RepoFactoryResult["bootstrapVerification"]): RepoFactoryResult => ({
  schema: "repo-factory.result.v2",
  runId: "run_b3",
  bootstrapOperationId: "op",
  planDigest: "plan",
  projectManifestDigest: "manifest",
  repositories: [{ role: "primary", identity: IDENTITY, proposedCheckoutPath: null, defaultBranch: "main", createdBranches: [] }],
  externalWriteReceipts: [],
  bootstrapVerification: rows,
  ciEvidence: [],
  unresolvedGaps: [],
});
const CLEAN = { commandId: "clean-tree", repositoryIdentity: IDENTITY, exactHead: HEAD, status: "PASS" as const };
const OBSERVED = { commandId: COMMITLORE_VERIFICATION_ID, repositoryIdentity: IDENTITY, exactHead: HEAD, status: "PASS" as const };
const FACTS = [{ identity: IDENTITY, head: HEAD }];

describe("#246 B3: the CommitLore verdict", () => {
  it("passes only a well-formed doctor report that both commands answered with 0, carrying every non-ok check as a warning", () => {
    expect(judgeCommitLoreRuns(ok(), ok(report()))).toMatchObject({ outcome: "PASS", reportStatus: "ok", warnings: [] });
    const degraded = report({
      status: "degraded",
      checks: [
        { id: "notes-refspec", status: "warn", detail: "no remote is configured" },
        { id: "squash-conservation", status: "skipped", skipReason: "no HEAD yet" },
      ],
    });
    expect(judgeCommitLoreRuns(ok(), ok(degraded))).toEqual({
      outcome: "PASS",
      reportStatus: "degraded",
      warnings: ["notes-refspec: no remote is configured", "squash-conservation: skipped (no HEAD yet)"],
      detail: "commitlore doctor passed",
      report: degraded,
    });
  });

  it.each([
    ["init could not run", null, ok(report()), /init could not be run/],
    ["init exits non-zero", { exitCode: 2, stdout: "", stderr: "hooks install failed" }, ok(report()), /init failed \(2\): hooks install failed/],
    ["doctor could not run", ok(), null, /doctor could not be run/],
    ["doctor is not JSON", ok(), ok("not json"), /invalid JSON report/],
    ["doctor has another schema", ok(), ok(report({ schema: "commitlore_doctor.v1" })), /invalid schema/],
    ["doctor has no known status", ok(), ok(report({ status: "fine" })), /invalid status/],
    ["doctor has a malformed check", ok(), ok(report({ checks: [{ id: "x", status: "green" }] })), /invalid checks/],
    ["doctor exits non-zero", ok(), { exitCode: 1, stdout: report({ status: "failed" }), stderr: "" }, /doctor failed \(1\)/],
    ["doctor says failed while exiting 0", ok(), ok(report({ status: "failed" })), /report status is failed while the process exited 0/],
    ["a check fails while exiting 0", ok(), ok(report({ checks: [{ id: "x", status: "fail" }] })), /a check has status fail/],
    ["the report's exitCode contradicts 0", ok(), ok(report({ exitCode: 1 })), /report exitCode is 1/],
  ])("refuses when %s", (_label, init, doctor, detail) => {
    const verdict = judgeCommitLoreRuns(init as CommitLoreRun | null, doctor as CommitLoreRun | null);
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.detail).toMatch(detail);
  });

  it("the CLI port runs exactly init then doctor, in the checkout, and a spawn failure is FAIL, never PASS", async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const passing = createCommitLoreCliPort(async (argv, cwd) => {
      calls.push({ argv, cwd });
      return argv[0] === "doctor" ? ok(report()) : ok();
    });
    expect(await passing.observe("/checkout")).toMatchObject({ outcome: "PASS" });
    expect(calls).toEqual([
      { argv: ["init", "--mcp-scope", "none", "--no-unattended", "--no-agent-hooks", "--json"], cwd: "/checkout" },
      { argv: ["doctor", "--json"], cwd: "/checkout" },
    ]);
    expect(COMMITLORE_OBSERVATION_ARGV.map((argv) => argv.join(" "))).toEqual(["init --mcp-scope none --no-unattended --no-agent-hooks --json", "doctor --json"]);

    const missing = createCommitLoreCliPort(async () => {
      throw Object.assign(new Error("spawn commitlore ENOENT"), { code: "ENOENT" });
    });
    expect(await missing.observe("/checkout")).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(/ENOENT/) });

    let doctorRan = false;
    const initFails = createCommitLoreCliPort(async (argv) => {
      if (argv[0] === "doctor") doctorRan = true;
      return argv[0] === "init" ? { exitCode: 1, stdout: "", stderr: "an agent host still needs configuring" } : ok(report());
    });
    expect(await initFails.observe("/checkout")).toMatchObject({ outcome: "FAIL" });
    expect(doctorRan).toBe(false);
  });
});

/**
 * #1268 (CEO msg_db4e1cc1) — `init --json` as CommitLore 1.7.5 prints it (`runInit`): eight steps, each with
 * its code, and `exitCode` 2 when one could not run, 1 when one needs attention. Its `doctor` step is code 1
 * whenever a doctor check needs attention, a warning included, so a checkout whose only findings are warnings
 * init cannot fix exits 1 after every setup step succeeded.
 */
const INIT_STEPS = ["release", "hooks", "trust", "index", "claude-hook", "mcp-registration", "policy", "doctor"] as const;
// The real case: every setup step ✓, then "doctor --fix — needs attention" over four warnings.
const FINAL_CHECK_LINES = [
  "ok    commit-msg hook — installed",
  "warn  notes fetch refspec — no remote is configured",
  "warn  notes mirror — refs/notes/commitlore is unfetched",
  "      fix: git fetch origin 'refs/notes/commitlore:refs/notes/commitlore'",
  "warn  index — the index is behind HEAD",
  "warn  inject-runtime — the PreToolUse hook is not installed",
];
type InitStep = { step: unknown; title?: string; code?: unknown; lines?: unknown; detail?: unknown };
const initSteps = (codes: Partial<Record<(typeof INIT_STEPS)[number], number>> = {}): InitStep[] =>
  INIT_STEPS.map((step) => ({
    step,
    title: step === "doctor" ? "doctor --fix" : step,
    code: codes[step] ?? (step === "doctor" ? 1 : 0),
    lines: step === "doctor" ? FINAL_CHECK_LINES : [`${step} done`],
    detail: {},
  }));
const initReport = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ steps: initSteps(), notesBefore: "absent", exitCode: 1, ...overrides }, null, 2)}\n`;
const attention = (stdout = initReport(), exitCode = 1): CommitLoreRun => ({ exitCode, stdout, stderr: "" });
const DEGRADED = report({
  status: "degraded",
  checks: [
    { id: "commit-msg-hook", status: "ok" },
    { id: "notes-refspec", status: "warn", detail: "no remote is configured" },
    { id: "notes-mirror", status: "warn", detail: "refs/notes/commitlore is unfetched" },
    { id: "index", status: "warn", detail: "the index is behind HEAD" },
    { id: "inject-runtime", status: "warn", detail: "the PreToolUse hook is not installed" },
  ],
});
const withSteps = (steps: InitStep[], overrides: Record<string, unknown> = {}): CommitLoreRun => attention(initReport({ steps, ...overrides }));

describe("#1268: a warning-only init exit 1 is initialization done, its final check needing attention", () => {
  it("passes when every step but doctor is 0, doctor is 1, and the doctor after it is degraded with no fail, carrying the final check's lines verbatim", () => {
    const verdict = judgeCommitLoreRuns(attention(), ok(DEGRADED));
    expect(verdict).toEqual({
      outcome: "PASS",
      reportStatus: "degraded",
      warnings: [
        ...FINAL_CHECK_LINES.map((line) => `init doctor --fix: ${line}`),
        "notes-refspec: no remote is configured",
        "notes-mirror: refs/notes/commitlore is unfetched",
        "index: the index is behind HEAD",
        "inject-runtime: the PreToolUse hook is not installed",
      ],
      detail: "commitlore doctor passed; commitlore init exited 1: its final check needs attention",
      report: DEGRADED,
    });
    // The original text of each line, unchanged, and none left out.
    for (const line of FINAL_CHECK_LINES) expect(verdict.warnings.filter((warning) => warning.endsWith(line)), line).toHaveLength(1);
  });

  it("the CLI port runs doctor after that init, and judges it as after an exit 0", async () => {
    const calls: string[] = [];
    const port = createCommitLoreCliPort(async (argv) => {
      calls.push(argv[0] as string);
      return argv[0] === "init" ? attention() : ok(DEGRADED);
    });
    expect(await port.observe("/checkout")).toMatchObject({ outcome: "PASS", reportStatus: "degraded", report: DEGRADED });
    expect(calls).toEqual(["init", "doctor"]);
  });

  const renamed = (from: string, to: unknown): InitStep[] => initSteps().map((step) => (step.step === from ? { ...step, step: to } : step));
  const changed = (name: string, change: Partial<InitStep>): InitStep[] => initSteps().map((step) => (step.step === name ? { ...step, ...change } : step));
  it.each<[string, CommitLoreRun, RegExp]>([
    ["mcp-registration has code 1", withSteps(initSteps({ "mcp-registration": 1 })), /init failed \(1\): its mcp-registration step has code 1/],
    ["policy has code 1", withSteps(initSteps({ policy: 1 })), /init failed \(1\): its policy step has code 1/],
    ["another setup step has code 1", withSteps(initSteps({ release: 1 })), /init failed \(1\): its release step has code 1/],
    ["a setup step could not run (code 2)", withSteps(initSteps({ hooks: 2 })), /init failed \(1\): its hooks step has code 2/],
    ["the doctor step has code 0", withSteps(initSteps({ doctor: 0 })), /init failed \(1\): its doctor step has code 0/],
    ["the doctor step's code is not a number", withSteps(changed("doctor", { code: "1" })), /init failed \(1\): its doctor step has code "1"/],
    ["a step is missing", withSteps(initSteps().filter((step) => step.step !== "trust")), /init failed \(1\): its report is missing a step/],
    ["the doctor step is missing", withSteps(initSteps().filter((step) => step.step !== "doctor")), /init failed \(1\): its report is missing a step/],
    ["a step is repeated", withSteps([...initSteps(), initSteps()[1] as InitStep]), /init failed \(1\): its report repeats a step/],
    ["a step is repeated in place of another", withSteps(renamed("trust", "hooks")), /init failed \(1\): its report repeats a step/],
    ["the doctor step is repeated", withSteps([...initSteps(), { ...(initSteps()[7] as InitStep) }]), /init failed \(1\): its report repeats a step/],
    ["a step is unknown", withSteps([...initSteps(), { step: "agents", code: 0, lines: [] }]), /init failed \(1\): its report has an unknown step "agents"/],
    ["a step is unknown in place of another", withSteps(renamed("claude-hook", "agents")), /init failed \(1\): its report has an unknown step "agents"/],
    ["a step has no name", withSteps(renamed("index", undefined)), /init failed \(1\): its report has an unknown step/],
    ["the steps are not an array", withSteps([], { steps: { doctor: 1 } }), /init failed \(1\): its report has no steps/],
    ["the report's exitCode is 0", attention(initReport({ exitCode: 0 })), /init failed \(1\): its report's exitCode is 0, not the process's 1/],
    ["the report's exitCode is 2", attention(initReport({ exitCode: 2 })), /init failed \(1\): its report's exitCode is 2, not the process's 1/],
    ["the report's exitCode is \"1\"", attention(initReport({ exitCode: "1" })), /init failed \(1\): its report's exitCode is "1"/],
    ["the report has no exitCode", attention(initReport({ exitCode: undefined })), /init failed \(1\): its report's exitCode is undefined/],
    ["the doctor step has no lines", withSteps(changed("doctor", { lines: [] })), /init failed \(1\): its doctor step has no lines of text/],
    ["the doctor step's lines are not text", withSteps(changed("doctor", { lines: [{ text: "warn" }] })), /init failed \(1\): its doctor step has no lines of text/],
    ["stdout is not JSON", attention("  ✓ Release\n  ! Final check — needs attention\n\ninit: 1 step(s) need(s) attention — doctor --fix\n"), /init failed \(1\): its output is not one JSON report/],
    ["stdout is truncated", attention(initReport().slice(0, 400)), /init failed \(1\): its output is not one JSON report/],
    ["stdout is empty", attention(""), /init failed \(1\): its output is not one JSON report: no diagnostic output/],
    ["stdout is a JSON array", attention(JSON.stringify([JSON.parse(initReport())])), /init failed \(1\): its output is not one JSON report/],
    ["stdout is two reports", attention(`${initReport()}${initReport()}`), /init failed \(1\): its output is not one JSON report/],
    ["init exits 2", attention(initReport({ exitCode: 2, steps: initSteps({ hooks: 2 }) }), 2), /^commitlore init failed \(2\): /],
    ["init exits 2 with an otherwise warning-only report", attention(initReport({ exitCode: 2 }), 2), /^commitlore init failed \(2\): /],
    ["init exits 3", attention(initReport(), 3), /^commitlore init failed \(3\): /],
    ["init exits -1", attention(initReport(), -1), /^commitlore init failed \(-1\): /],
  ])("an init exit 1 fails, and doctor never runs, when %s", async (_label, init, detail) => {
    const verdict = judgeCommitLoreRuns(init, ok(DEGRADED));
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.detail).toMatch(detail);
    const calls: string[] = [];
    const port = createCommitLoreCliPort(async (argv) => {
      calls.push(argv[0] as string);
      return argv[0] === "init" ? init : ok(DEGRADED);
    });
    expect(await port.observe("/checkout")).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(detail) });
    expect(calls).toEqual(["init"]);
  });

  it.each<[string, CommitLoreRun | null, RegExp]>([
    ["has a fail check and exits 1", { exitCode: 1, stdout: report({ status: "failed", exitCode: 1, checks: [{ id: "x", status: "fail" }] }), stderr: "" }, /doctor failed \(1\)/],
    ["has a fail check while exiting 0", ok(report({ status: "degraded", checks: [{ id: "x", status: "fail", detail: "broken" }] })), /a check has status fail/],
    ["says failed while exiting 0", ok(report({ status: "failed", checks: [{ id: "x", status: "warn" }] })), /report status is failed/],
    ["reports a non-zero exitCode while exiting 0", ok(report({ status: "degraded", exitCode: 1, checks: [{ id: "x", status: "warn" }] })), /report exitCode is 1/],
    ["is not JSON", ok("not json"), /invalid JSON report/],
    ["is truncated", ok(DEGRADED.slice(0, 60)), /invalid JSON report/],
    ["has another schema", ok(report({ schema: "commitlore_doctor.v1" })), /invalid schema/],
    ["has a malformed check", ok(report({ checks: [{ id: "x", status: "green" }] })), /invalid checks/],
    ["could not run", null, /doctor could not be run/],
  ])("after a warning-only init exit 1, the doctor fails as today when it %s", (_label, doctor, detail) => {
    const verdict = judgeCommitLoreRuns(attention(), doctor);
    expect(verdict.outcome).toBe("FAIL");
    expect(verdict.detail).toMatch(detail);
    // The final check's lines still reach the failure's warnings.
    expect(verdict.warnings.slice(0, FINAL_CHECK_LINES.length)).toEqual(FINAL_CHECK_LINES.map((line) => `init doctor --fix: ${line}`));
  });

  it("a doctor that cannot be run after a warning-only init exit 1 fails with the final check's lines still carried; after an exit 0 it carries none", async () => {
    const throwing = (init: CommitLoreRun) =>
      createCommitLoreCliPort(async (argv) => {
        if (argv[0] === "doctor") throw new Error("commitlore doctor did not answer within 180000 ms");
        return init;
      });
    expect(await throwing(attention()).observe("/checkout")).toEqual({
      outcome: "FAIL",
      reportStatus: null,
      warnings: FINAL_CHECK_LINES.map((line) => `init doctor --fix: ${line}`),
      detail: "commitlore doctor could not be run: commitlore doctor did not answer within 180000 ms",
    });
    expect(await throwing(ok()).observe("/checkout")).toMatchObject({ outcome: "FAIL", warnings: [], detail: expect.stringMatching(/^commitlore doctor could not be run: /) });
  });

  it("an init exit 0 whose JSON report names another exitCode fails, never a PASS; any other exit 0 is judged as before", async () => {
    for (const exitCode of [1, 2, "0", null]) {
      const init = ok(initReport({ exitCode }));
      expect(judgeCommitLoreRuns(init, ok(DEGRADED)), String(exitCode)).toMatchObject({
        outcome: "FAIL",
        detail: `commitlore init report exitCode is ${JSON.stringify(exitCode)} while the process exited 0`,
        warnings: [],
      });
      const calls: string[] = [];
      const port = createCommitLoreCliPort(async (argv) => {
        calls.push(argv[0] as string);
        return argv[0] === "init" ? init : ok(DEGRADED);
      });
      expect(await port.observe("/checkout"), String(exitCode)).toMatchObject({ outcome: "FAIL" });
      expect(calls).toEqual(["init"]);
    }
    // A JSON report saying 0, a report with no exitCode field, and a text or empty stdout: as before.
    const before = judgeCommitLoreRuns(ok(), ok(DEGRADED));
    expect(before).toMatchObject({ outcome: "PASS", detail: "commitlore doctor passed" });
    for (const stdout of [initReport({ exitCode: 0, steps: initSteps({ doctor: 0 }) }), JSON.stringify({ steps: [] }), "init: ready\n", "[1]"]) {
      expect(judgeCommitLoreRuns(ok(stdout), ok(DEGRADED)), stdout).toEqual(before);
    }
  });
});

describe("#246 B3: the activation gate per mode", () => {
  it("required: refused without a passing CommitLore row at the fact's head, admitted with one", () => {
    expect(commitloreActivationGate("required", resultWith([CLEAN]), FACTS)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", commitloreMode: "required" },
    });
    // A row at another head, or for another repository, is not the published head's verification.
    expect(commitloreActivationGate("required", resultWith([CLEAN, { ...OBSERVED, exactHead: "b".repeat(40) }]), FACTS).allowed).toBe(false);
    expect(commitloreActivationGate("required", resultWith([CLEAN, { ...OBSERVED, repositoryIdentity: "github:acme/other" }]), FACTS).allowed).toBe(false);
    expect(commitloreActivationGate("required", resultWith([CLEAN, OBSERVED]), FACTS)).toMatchObject({ allowed: true, value: { observed: true } });
    expect(commitloreActivationGate("required", resultWith([CLEAN, OBSERVED]), [])).toMatchObject({ allowed: false });
  });

  it("preferred and off: admitted either way, saying whether CommitLore was observed", () => {
    expect(commitloreActivationGate("preferred", resultWith([CLEAN]), FACTS)).toMatchObject({ allowed: true, value: { observed: false } });
    expect(commitloreActivationGate("preferred", resultWith([CLEAN, OBSERVED]), FACTS)).toMatchObject({ allowed: true, value: { observed: true } });
    expect(commitloreActivationGate("off", resultWith([CLEAN]), FACTS)).toMatchObject({ allowed: true, value: { observed: false } });
  });

  it("an unsupported or missing value past the manifest contract is held to required, never lowered to preferred", () => {
    for (const mode of ["mandatory", "", undefined, null, "Required"]) {
      expect(commitloreRequired(mode), String(mode)).toBe(true);
      expect(commitloreActivationGate(mode, resultWith([CLEAN]), FACTS), String(mode)).toMatchObject({
        allowed: false,
        evidence: { refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED" },
      });
    }
    expect(commitloreRequired("preferred")).toBe(false);
    expect(commitloreRequired("off")).toBe(false);
  });
});

describe("review S11-R1-01: the CommitLore child environment is the CP-HI-05 constructed one", () => {
  it("names only PATH, HOME, USER, TMPDIR, the locale and git's controls (S11-R3), whatever the daemon carries", () => {
    const environment = commitloreChildEnvironment("/acp-s11-r3/home");
    expect(Object.keys(environment).sort()).toEqual(
      [
        "GIT_ASKPASS",
        // #1268 — attributes from the empty tree.
        "GIT_ATTR_SOURCE",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_VALUE_0",
        // #1268 — git prefers it to the repository's core.sshCommand.
        "GIT_SSH_COMMAND",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TMPDIR",
        ...(process.env["USER"] ? ["USER"] : []),
      ].sort(),
    );
    expect(environment["PATH"]).not.toBe(process.env["PATH"]);
  });
});

describe("review S11-R1-03: a CommitLore row is bound to the record its attempt made", () => {
  const HEAD2 = "b".repeat(40);
  const report = JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] });
  const pass: Extract<CommitLoreObservation, { outcome: "PASS" }> = { outcome: "PASS", reportStatus: "ok", warnings: [], detail: "passed", report };
  const setup = () => {
    const workDir = tempDir("acp-s11-r1-binding-");
    const binding: CommitLoreBinding & { head: string } = {
      runId: "run_b3",
      bootstrapOperationId: "op",
      checkoutPath: join(workDir, "checkouts", "primary.attempt-1"),
      repositoryIdentity: IDENTITY,
      head: HEAD,
    };
    const written = writeCommitLoreObservationRecord(workDir, binding, pass);
    expect(written.allowed, JSON.stringify(written)).toBe(true);
    const path = commitloreObservationPath(workDir, binding.checkoutPath);
    const verify = (overrides: { mode?: unknown; rows?: RepoFactoryResult["bootstrapVerification"]; expected?: Partial<CommitLoreBinding> } = {}) =>
      verifyCommitLoreBinding({
        mode: "mode" in overrides ? overrides.mode : "required",
        result: resultWith(overrides.rows ?? [CLEAN, OBSERVED]),
        workDir,
        expected: { ...binding, ...overrides.expected },
      });
    const rewrite = (content: Record<string, unknown>): void => {
      writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    };
    return { workDir, binding, path, verify, rewrite, genuine: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
  };
  const unbound = { allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP, evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND" } };

  it("the producer's record binds run, operation, attempt, repository, head and the report's digest", () => {
    const { verify, genuine, binding } = setup();
    expect(genuine).toEqual({
      schema: "acp.bootstrap.commitlore-observation.v1",
      ...binding,
      argv: [["init", "--mcp-scope", "none", "--no-unattended", "--no-agent-hooks", "--json"], ["doctor", "--json"]],
      reportStatus: "ok",
      reportDigest: sha256(report),
      report,
    });
    expect(verify()).toMatchObject({ allowed: true });
  });

  it("refuses a PASS row with no record, and a record reused from another attempt, run, operation, repository or head", () => {
    const { verify, workDir, binding, path } = setup();
    // Another attempt: its own checkout has no record. Copied there, it still names the first attempt.
    const second = join(workDir, "checkouts", "primary.attempt-2");
    expect(verify({ expected: { checkoutPath: second } })).toMatchObject({ ...unbound, evidence: { refusal: "COMMITLORE_OBSERVATION_UNBOUND", recordPath: commitloreObservationPath(workDir, second) } });
    copyFileSync(path, commitloreObservationPath(workDir, second));
    expect(verify({ expected: { checkoutPath: second } })).toMatchObject({ ...unbound, evidence: { differing: ["checkoutPath"] } });
    expect(verify({ expected: { runId: "run_other" } })).toMatchObject({ ...unbound, evidence: { differing: ["runId"] } });
    expect(verify({ expected: { bootstrapOperationId: "op_other" } })).toMatchObject({ ...unbound, evidence: { differing: ["bootstrapOperationId"] } });
    // Another head or repository: the rows themselves no longer match the published head's facts.
    expect(verify({ expected: { head: HEAD2 } })).toMatchObject(unbound);
    expect(verify({ expected: { head: HEAD2 }, rows: [CLEAN, { ...OBSERVED, exactHead: HEAD2 }] })).toMatchObject({ ...unbound, evidence: { differing: ["head"] } });
    expect(verify({ expected: { repositoryIdentity: "github:acme/other" }, rows: [CLEAN, { ...OBSERVED, repositoryIdentity: "github:acme/other" }] })).toMatchObject({
      ...unbound,
      evidence: { differing: ["repositoryIdentity"] },
    });
    expect(verify({ expected: { head: null } })).toMatchObject(unbound);
    expect(binding.head).toBe(HEAD);
  });

  it("refuses a missing row under required, a second row at another head, and an unrecorded row under preferred", () => {
    const { verify } = setup();
    expect(verify({ rows: [CLEAN] })).toMatchObject(unbound);
    expect(verify({ rows: [CLEAN, OBSERVED, { ...OBSERVED, exactHead: HEAD2 }] })).toMatchObject(unbound);
    // An unsupported or missing mode is held to required.
    expect(verify({ mode: "mandatory", rows: [CLEAN] })).toMatchObject(unbound);
    expect(verify({ mode: undefined, rows: [CLEAN] })).toMatchObject(unbound);
    // Preferred and off with no row ask for nothing; with a row, the row must still be bound.
    expect(verify({ mode: "preferred", rows: [CLEAN] })).toMatchObject({ allowed: true });
    expect(verify({ mode: "off", rows: [CLEAN] })).toMatchObject({ allowed: true });
    expect(verify({ mode: "preferred", expected: { checkoutPath: "/nowhere/primary.attempt-9" } })).toMatchObject(unbound);
  });

  it("refuses a report its digest does not name, a report that does not pass, and a record that is not this account's whole record", () => {
    const { verify, rewrite, genuine, path } = setup();
    // Still a passing report, with the same status, and not the one its digest names.
    rewrite({ ...genuine, report: `${report} ` });
    expect(verify()).toMatchObject(unbound);
    const failing = JSON.stringify({ schema: "commitlore_doctor.v2", status: "failed", exitCode: 1, checks: [] });
    rewrite({ ...genuine, report: failing, reportDigest: sha256(failing) });
    expect(verify()).toMatchObject(unbound);
    const degraded = JSON.stringify({ schema: "commitlore_doctor.v2", status: "degraded", exitCode: 0, checks: [] });
    rewrite({ ...genuine, report: degraded, reportDigest: sha256(degraded) });
    expect(verify()).toMatchObject(unbound);

    const unreadable = { allowed: false, evidence: { refusal: "COMMITLORE_OBSERVATION_UNREADABLE" } };
    writeFileSync(path, JSON.stringify(genuine, null, 2), { mode: 0o600 });
    expect(verify()).toMatchObject(unreadable);
    rewrite({ ...genuine, extra: true });
    expect(verify()).toMatchObject(unreadable);
    rewrite(genuine);
    chmodSync(path, 0o666);
    expect(verify()).toMatchObject(unreadable);
    chmodSync(path, 0o600);
    expect(verify()).toMatchObject({ allowed: true });
    const target = `${path}.target`;
    copyFileSync(path, target);
    unlinkSync(path);
    symlinkSync(target, path);
    expect(verify()).toMatchObject(unreadable);
  });

  it("writes a record once: one already there for the attempt's checkout is refused, never replaced", () => {
    const { workDir, binding, path, genuine } = setup();
    expect(writeCommitLoreObservationRecord(workDir, { ...binding, head: HEAD2 }, pass)).toMatchObject({
      allowed: false,
      evidence: { refusal: "COMMITLORE_OBSERVATION_CONFLICT" },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(genuine);
  });
});
