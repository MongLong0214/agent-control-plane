import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import {
  CONTRACT_CHANGE_CONTRACT,
  UNIT_TESTS,
  WORKFLOW,
  WORKFLOW_PATH,
  dispatchRun,
  normalized,
  planCarrying,
  storedPlan,
  stricter,
  type DispatchedRun,
} from "../helpers/contract-change.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Issue #246 B2-a — W17: a CONTRACT_CHANGE run's PLAN carries the manifest it proposes, checked
 * against the run's pinned manifest, and every way it can be wrong is refused with its own code.
 *
 * Every PLAN here goes through the `plan_submit` tool of the CTO MCP server, authenticated as the
 * run's own CTO session. The refusal codes are written out rather than imported, so that this file
 * runs against main too.
 */

/** `plan_submit` over the CTO MCP server, authenticated as the run's own CTO session. */
const planSubmit = async (harness: Harness, run: DispatchedRun, plan: Record<string, unknown>) => {
  const session = harness.cp.sessions.require(run.ownerSessionId);
  const server = createCtoServer(createCtoMcpPort(harness.cp), () =>
    allow(ReasonCode.OK, { actor: "primary-cto", sessionId: session.sessionId, sessionIncarnation: session.incarnation }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-change-witness", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "plan_submit",
      arguments: {
        idempotencyKey: `plan-${digestOf(plan).slice(7, 23)}`,
        runId: run.runId,
        plan,
        tasks: [{ key: "contract", title: "change the contract", category: "implementation" }],
      },
    });
    return result.structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
  }
};


const contractChangeProject = async (harness: Harness, projectId: string, overrides: Partial<ProjectManifest> = {}) => {
  const registered = await registerFixtureProject(harness, projectId, overrides);
  return dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE);
};

const expectRefused = async (
  harness: Harness,
  run: DispatchedRun,
  plan: Record<string, unknown>,
  reasonCode: string,
  refusal: string,
) => {
  const answer = await planSubmit(harness, run, plan);
  expect(answer, JSON.stringify(answer)).toMatchObject({ ok: false, reasonCode, evidence: { refusal } });
  expect(storedPlan(harness, run.runId)).toBeNull();
  return answer;
};

describe("W17: plan_submit carries a CONTRACT_CHANGE manifest", () => {
  it("keeps the manifest in the stored PLAN, so the PLAN digest covers it", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-carry");
    const m1 = stricter(run.base);
    const answer = await planSubmit(harness, run, planCarrying(m1));
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    const plan = storedPlan(harness, run.runId)!;
    expect(plan.content["projectManifest"]).toEqual(m1);
    expect(plan.content["projectManifestDigest"]).toBe(manifestDigest(m1));
    expect(plan.digest).toBe(digestOf(plan.content));
    // A PLAN that differs only in the manifest it carries is a different PLAN.
    const m1b = normalized({ ...m1, commitlore: { mode: "required" } });
    expect((await planSubmit(harness, run, planCarrying(m1b)))["ok"]).toBe(true);
    expect(storedPlan(harness, run.runId)!.digest).not.toBe(plan.digest);
  });

  it("refuses a PLAN that carries no manifest, rather than storing it without one", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-missing");
    await expectRefused(harness, run, { summary: "no manifest" }, ReasonCode.INVALID_ARGUMENT, "CONTRACT_CHANGE_MANIFEST_MISSING");
    await expectRefused(harness, run, { summary: "a digest only", projectManifestDigest: manifestDigest(stricter(run.base)) }, ReasonCode.INVALID_ARGUMENT, "CONTRACT_CHANGE_MANIFEST_MISSING");
  });

  it("refuses a manifest that is not portable", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-portable");
    const leaking = {
      ...stricter(run.base),
      verificationCommands: [...run.base.verificationCommands, { ...UNIT_TESTS, argv: ["node", "/Users/someone/verify.js"] }],
    };
    await expectRefused(harness, run, planCarrying(leaking, digestOf(leaking)), ReasonCode.MANIFEST_NOT_PORTABLE, "CONTRACT_CHANGE_MANIFEST_NOT_PORTABLE");
  });

  it("refuses a manifest whose digest is not the one the PLAN names", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-digest");
    const m1 = stricter(run.base);
    await expectRefused(harness, run, planCarrying(m1, manifestDigest(run.base)), ReasonCode.CONTRACT_DIGEST_MISMATCH, "CONTRACT_CHANGE_MANIFEST_DIGEST_MISMATCH");
  });

  it("refuses a manifest that names another project", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-project");
    const other = normalized({ ...stricter(run.base), projectId: "another-project" });
    await expectRefused(harness, run, planCarrying(other), ReasonCode.INVALID_ARGUMENT, "CONTRACT_CHANGE_PROJECT_MISMATCH");
  });

  it("refuses a change to repositories[]", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-repositories");
    const moved = normalized({ ...stricter(run.base), repositories: [{ role: "primary", remote: "github:acme/elsewhere", manifestRoot: "." }] });
    await expectRefused(harness, run, planCarrying(moved), ReasonCode.REPOSITORY_IDENTITY_MISMATCH, "CONTRACT_CHANGE_REPOSITORIES_CHANGED");
  });

  it("refuses a no-op: the run's own pinned manifest", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-noop");
    await expectRefused(harness, run, planCarrying(run.base), ReasonCode.INVALID_ARGUMENT, "CONTRACT_CHANGE_NO_CHANGE");
  });

  it("refuses run_create for a CONTRACT_CHANGE that names no project, storing no run", () => {
    const harness = makeHarness();
    const before = harness.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM runs")!.n;
    const created = harness.cp.runs.create({ kind: RunKind.CONTRACT_CHANGE, executionMode: ExecutionMode.STANDARD, contract: CONTRACT_CHANGE_CONTRACT });
    expect(created.allowed).toBe(false);
    expect(created.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(created.evidence["refusal"]).toBe("CONTRACT_CHANGE_PROJECT_MISSING");
    expect(harness.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM runs")!.n).toBe(before);
  });
});

describe("W17: lowering the verification bar is detected against the pin and refused", () => {
  const WORKFLOW_ENTRY = { path: WORKFLOW_PATH, checkName: "unit-tests", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" };
  /** A base that already requires `unit-tests` in CI and locally, and the CommitLore record. */
  const richBase = (projectId: string): Partial<ProjectManifest> => {
    const base = fixtureManifest(projectId);
    return {
      verificationCommands: [...base.verificationCommands, UNIT_TESTS],
      verificationProfiles: { simple: ["verify"], standard: ["verify", "unit-tests"], guarded: ["verify", "unit-tests"] },
      postMergeCommands: ["verify"],
      ciWorkflows: [WORKFLOW_ENTRY],
      commitlore: { mode: "required" },
    };
  };
  const lowered = (answer: Record<string, unknown>) =>
    ((answer["evidence"] as { lowered: Array<{ kind: string }> }).lowered).map((entry) => entry.kind);

  const cases: Array<[string, (base: ProjectManifest) => unknown, string[]]> = [
    ["a removed required command", (base) => ({
      ...base,
      verificationCommands: base.verificationCommands.filter((command) => command.id !== "unit-tests"),
      verificationProfiles: { simple: ["verify"], standard: ["verify"], guarded: ["verify"] },
      ciWorkflows: [],
    }), ["COMMAND_REMOVED", "PROFILE_COMMAND_REMOVED", "PROFILE_COMMAND_REMOVED", "CI_WORKFLOW_DROPPED"]],
    ["a downgraded evidenceMode", (base) => ({
      ...base,
      verificationCommands: base.verificationCommands.map((command) => command.id === "unit-tests" ? { ...command, evidenceMode: "LOCAL_COMMAND" } : command),
    }), ["EVIDENCE_MODE_DOWNGRADED"]],
    ["an unapproved CI workflow", (base) => ({
      ...base,
      ciWorkflows: [{ ...WORKFLOW_ENTRY, approvedDigest: null, unapprovedFirstActivation: true }],
    }), ["CI_WORKFLOW_UNAPPROVED"]],
    ["a dropped ciWorkflows entry", (base) => ({ ...base, ciWorkflows: [] }), ["CI_WORKFLOW_DROPPED"]],
    ["a command whose argv no longer checks the same thing", (base) => ({
      ...base,
      verificationCommands: base.verificationCommands.map((command) => command.id === "unit-tests" ? { ...command, argv: ["node", "--version"] } : command),
    }), ["COMMAND_REPLACED"]],
    ["a dropped post-merge command", (base) => ({ ...base, postMergeCommands: [] }), ["POST_MERGE_COMMAND_REMOVED"]],
    ["a lower CommitLore mode", (base) => ({ ...base, commitlore: { mode: "preferred" } }), ["COMMITLORE_MODE_DOWNGRADED"]],
  ];

  for (const [name, change, kinds] of cases) {
    it(`refuses ${name} with no owner binding`, async () => {
      const harness = makeHarness();
      const run = await contractChangeProject(harness, "cc-lowered", richBase("cc-lowered"));
      const proposed = normalized(change(run.base));
      const answer = await expectRefused(harness, run, planCarrying(proposed), ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT, "CONTRACT_CHANGE_VERIFICATION_BAR_LOWERED");
      expect(lowered(answer)).toEqual(kinds);
      expect(answer["evidence"]).toMatchObject({ baseManifestDigest: run.baseDigest, ownerApproval: "NOT_AVAILABLE" });
    });
  }

  it("allows a stricter change and an equivalent one", async () => {
    const harness = makeHarness();
    const run = await contractChangeProject(harness, "cc-stricter", richBase("cc-stricter"));
    const stricterStill = normalized({
      ...run.base,
      verificationCommands: run.base.verificationCommands.map((command) =>
        command.id === "verify" ? { ...command, evidenceMode: "BOTH_REQUIRED" } : command,
      ),
      postMergeCommands: ["verify", "unit-tests"],
    });
    expect((await planSubmit(harness, run, planCarrying(stricterStill)))["ok"]).toBe(true);
    // Equivalent: the bar is the same, the timeout is not part of it.
    const equivalent = normalized({
      ...run.base,
      verificationCommands: run.base.verificationCommands.map((command) => ({ ...command, timeoutSeconds: command.timeoutSeconds + 60 })),
    });
    expect((await planSubmit(harness, run, planCarrying(equivalent)))["ok"]).toBe(true);
    expect(storedPlan(harness, run.runId)!.content["projectManifestDigest"]).toBe(manifestDigest(equivalent));
  });
});

describe("regression controls: other runs are unchanged", () => {
  it("a STANDARD_WORK PLAN carrying projectManifest is stored without it, exactly as before", async () => {
    const harness = makeHarness();
    const registered = await registerFixtureProject(harness, "cc-standard");
    const run = await dispatchRun(harness, registered.projectId, RunKind.STANDARD_WORK, [
      { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ]);
    const answer = await planSubmit(harness, run, { summary: "ordinary work", projectManifestDigest: "sha256:named-only", projectManifest: { anything: true } });
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    expect(storedPlan(harness, run.runId)?.content).toEqual({
      summary: "ordinary work",
      dependencies: [],
      repositoryIntent: [],
      verificationIntent: [],
      knownConflicts: [],
      risks: [],
      removedOverengineering: [],
      projectManifestDigest: "sha256:named-only",
    });
  });

});
