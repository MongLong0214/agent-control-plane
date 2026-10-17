import { describe, expect, it } from "vitest";

import {
  COMMITLORE_OBSERVATION_ARGV,
  COMMITLORE_VERIFICATION_ID,
  type CommitLoreRun,
  commitloreActivationGate,
  commitloreRequired,
  createCommitLoreCliPort,
  judgeCommitLoreRuns,
} from "../../src/bootstrap/commitlore-observation.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

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
      { argv: ["init", "--mcp-scope", "none", "--no-unattended"], cwd: "/checkout" },
      { argv: ["doctor", "--json"], cwd: "/checkout" },
    ]);
    expect(COMMITLORE_OBSERVATION_ARGV.map((argv) => argv.join(" "))).toEqual(["init --mcp-scope none --no-unattended", "doctor --json"]);

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
