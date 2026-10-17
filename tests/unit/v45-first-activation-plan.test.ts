import { afterAll, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { RunKind } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import {
  ContractChangeRefusal,
  type FirstActivationFacts,
  currentFirstActivationPlan,
  firstActivationEligibility,
  firstActivationRevisions,
  sameContractChangeBinding,
  workflowRevisionsDigest,
} from "../../src/registry/contract-change-plan.ts";
import {
  type FirstActivationWorkflowEvidence,
  sameFirstActivationCoverage,
  sameWorkflowCoverage,
} from "../../src/registry/manifest-activation-grants.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  FIRST_IDENTITY,
  createRun,
  firstManifest,
  firstPlan,
  lintWorkflow,
  operatorRegisteredProject,
  revisionsFor,
  unitTestsWorkflow,
} from "../helpers/first-activation.ts";
import { fixtureManifest, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { WORKFLOW_PATH, normalized, planCarrying } from "../helpers/contract-change.ts";

afterAll(cleanupTempDirs);

/**
 * #512 (v45) witnesses D1-a … D1-d and the plan_submit half of E1/E4/E6: a first-activation PLAN
 * carries the manifest it activates and an exact, non-empty, bijective binding of every CI workflow
 * it names to a commit; an empty or mismatched binding is refused at plan_submit, through the CTO
 * MCP port's own routing, with no network call. The binding is required on this path only: an
 * ordinary project and the general CONTRACT_CHANGE path keep accepting `ciWorkflows: []`.
 *
 * RED at A0's head: the PLAN is refused CONTRACT_CHANGE_BASE_UNAVAILABLE whatever it binds (trace
 * P3), and the first-activation exports this file imports do not exist.
 */

const SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);

const nullProjectRun = async (projectId: string) => {
  const h = makeHarness();
  const project = await operatorRegisteredProject(h, projectId);
  const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
  return { h, project, run };
};

const submit = (h: ReturnType<typeof makeHarness>, runId: string, plan: Record<string, unknown>) =>
  createCtoMcpPort(h.cp).submitPlan(runId, plan);

describe("plan_submit for a first activation (E1, E4, E6), through the CTO port", () => {
  it("an operator-registered NULL project's CONTRACT_CHANGE stays NULL-pinned at dispatch, and its first-activation PLAN is stored", async () => {
    const { h, project, run } = await nullProjectRun("fa-plan-ok");
    expect(h.cp.projects.require(project.projectId).activeManifestDigest).toBeNull();
    expect(run.pinnedManifestDigest).toBeNull();
    const m1 = firstManifest(project.projectId);
    const submitted = submit(h, run.runId, firstPlan(m1, revisionsFor(m1, SHA)));
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ allowed: true });
    const stored = h.cp.artifacts.latest<Record<string, unknown>>(run.runId, "PLAN")!;
    expect(stored.content).toMatchObject({
      firstActivation: true,
      projectManifestDigest: manifestDigest(m1),
      projectManifest: m1,
      workflowRevisions: revisionsFor(m1, SHA),
    });
    const current = currentFirstActivationPlan(run, stored, null);
    expect(current, JSON.stringify(current)).toMatchObject({
      allowed: true,
      value: {
        binding: {
          planDigest: stored.digest,
          manifestDigest: manifestDigest(m1),
          baseManifestDigest: null,
          firstActivation: true,
          workflowRevisionsDigest: workflowRevisionsDigest(revisionsFor(m1, SHA)),
        },
        baseManifest: null,
      },
    });
    // The PLAN digest covers the revisions: another commit is another PLAN.
    const again = submit(h, run.runId, firstPlan(m1, revisionsFor(m1, OTHER_SHA)));
    expect(again.allowed && again.value.digest).not.toBe(stored.digest);
  });

  it("D1-a: a first-activation manifest with ciWorkflows: [] is refused", async () => {
    const { h, project, run } = await nullProjectRun("fa-plan-d1a");
    const empty = firstManifest(project.projectId, []);
    expect(submit(h, run.runId, firstPlan(empty, []))).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_WORKFLOWS_REQUIRED },
    });
    const unapproved = normalized({ ...firstManifest(project.projectId), ciWorkflows: [{ ...unitTestsWorkflow, approvedDigest: null, unapprovedFirstActivation: true }] });
    expect(submit(h, run.runId, firstPlan(unapproved, revisionsFor(firstManifest(project.projectId), SHA)))).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_WORKFLOWS_REQUIRED },
    });
    expect(h.cp.artifacts.latest(run.runId, "PLAN")).toBeNull();
  });

  it("D1-b: workflows declared but workflowRevisions: [] (or absent, or not a list) is refused", async () => {
    const { h, project, run } = await nullProjectRun("fa-plan-d1b");
    const m1 = firstManifest(project.projectId);
    for (const revisions of [[], undefined, "nope", {}]) {
      expect(submit(h, run.runId, firstPlan(m1, revisions)), JSON.stringify(revisions)).toMatchObject({
        allowed: false,
        evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_REVISIONS_MISMATCH },
      });
    }
    expect(h.cp.artifacts.latest(run.runId, "PLAN")).toBeNull();
  });

  it("D1-c: equal counts with a mismatch are refused — swapped checkName, wrong path, wrong identity, another entry's digest, one duplicate plus one missing", async () => {
    const { h, project, run } = await nullProjectRun("fa-plan-d1c");
    const m1 = firstManifest(project.projectId, [unitTestsWorkflow, lintWorkflow]);
    const [unit, lint] = revisionsFor(m1, SHA) as [ReturnType<typeof revisionsFor>[number], ReturnType<typeof revisionsFor>[number]];
    const cases: Record<string, unknown[]> = {
      "swapped checkName": [{ ...unit, checkName: lint.checkName }, { ...lint, checkName: unit.checkName }],
      "wrong path": [{ ...unit, path: ".github/workflows/other.yml" }, lint],
      "wrong repositoryIdentity": [{ ...unit, repositoryIdentity: "github:acme/elsewhere" }, lint],
      "another entry's fileDigest": [{ ...unit, fileDigest: lint.fileDigest }, lint],
      "one duplicate plus one missing": [unit, unit],
      "abbreviated commit": [{ ...unit, commitSha: SHA.slice(0, 12) }, lint],
      "uppercase commit": [{ ...unit, commitSha: "A".repeat(40) }, lint],
      "an extra field": [{ ...unit, branch: "dev" }, lint],
      "an extra entry": [unit, lint, { ...lint, path: ".github/workflows/third.yml" }],
    };
    for (const [name, revisions] of Object.entries(cases)) {
      expect(submit(h, run.runId, firstPlan(m1, revisions)), name).toMatchObject({
        allowed: false,
        evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_REVISIONS_MISMATCH },
      });
    }
    // The duplicate is named as one, not only as the entry it leaves missing.
    expect(submit(h, run.runId, firstPlan(m1, cases["one duplicate plus one missing"]!))).toMatchObject({ allowed: false, message: expect.stringMatching(/listed twice/) });
    expect(h.cp.artifacts.latest(run.runId, "PLAN")).toBeNull();
    // The exact binding, in any order, is accepted.
    expect(submit(h, run.runId, firstPlan(m1, [lint, unit])).allowed).toBe(true);
  });

  it("E1: a first-activation PLAN on a run with a base is refused; a general PLAN on a NULL-pinned run is refused as before", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "fa-plan-e1");
    const pinned = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
    expect(pinned.pinnedManifestDigest).not.toBeNull();
    const m1 = firstManifest(projectId);
    expect(submit(h, pinned.runId, firstPlan(m1, revisionsFor(m1, SHA)))).toMatchObject({
      allowed: false,
      reasonCode: "CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN",
      evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_RUN_HAS_BASE },
    });
    const { h: h2, project, run } = await nullProjectRun("fa-plan-e1-general");
    const general = firstManifest(project.projectId);
    expect(submit(h2, run.runId, planCarrying(general))).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.BASE_UNAVAILABLE },
    });
  });

  it("E4 at plan_submit: the manifest names the run's project, is portable, and hashes to the named digest", async () => {
    const { h, project, run } = await nullProjectRun("fa-plan-e4");
    const m1 = firstManifest(project.projectId);
    const other = firstManifest("another-project");
    expect(submit(h, run.runId, firstPlan(other, revisionsFor(other, SHA)))).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.PROJECT_MISMATCH },
    });
    expect(submit(h, run.runId, { ...firstPlan(m1, revisionsFor(m1, SHA)), projectManifestDigest: sha256("not it") })).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.MANIFEST_DIGEST_MISMATCH },
    });
    expect(submit(h, run.runId, { ...firstPlan(m1, revisionsFor(m1, SHA)), projectManifest: undefined })).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.MANIFEST_MISSING },
    });
  });
});

describe("D1-d: the binding is this path's only — an ordinary project and the general path keep ciWorkflows: []", () => {
  it("an ordinary project registers with ciWorkflows: [], and a general CONTRACT_CHANGE keeping [] is stored", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "fa-plan-d1d");
    expect(h.cp.projects.activeManifest(projectId)?.manifest.ciWorkflows).toEqual([]);
    const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
    const proposed = normalized({ ...fixtureManifest(projectId), commitlore: { mode: "required" } });
    expect(proposed.ciWorkflows).toEqual([]);
    expect(submit(h, run.runId, planCarrying(proposed))).toMatchObject({ allowed: true });
  });
});

describe("E2–E6 with the database's facts, as CONFIRM, issue, PRE_MERGE and ACTIVATION ask them", () => {
  const m1 = firstManifest("fa-facts");
  const run = { kind: "CONTRACT_CHANGE", projectId: "fa-facts", pinnedManifestDigest: null };
  const facts: FirstActivationFacts = {
    activeManifestDigest: null,
    registrationEventId: 7,
    bootstrapApplications: 0,
    registeredRepositories: [{ role: "primary", identity: FIRST_IDENTITY }],
    runRepositories: 0,
  };

  it("eligible facts pass and name the registration", () => {
    expect(firstActivationEligibility(run, m1, facts)).toMatchObject({ allowed: true, value: { registrationEventId: 7 } });
  });

  it("each fact that fails is refused under its own name", () => {
    const refusal = (changed: Partial<FirstActivationFacts>) => firstActivationEligibility(run, m1, { ...facts, ...changed }).evidence["refusal"];
    expect(refusal({ activeManifestDigest: manifestDigest(m1) })).toBe(ContractChangeRefusal.FIRST_ACTIVATION_PROJECT_NOT_NULL);
    expect(refusal({ registrationEventId: null })).toBe(ContractChangeRefusal.FIRST_ACTIVATION_NOT_OPERATOR_REGISTERED);
    expect(refusal({ bootstrapApplications: 1 })).toBe(ContractChangeRefusal.FIRST_ACTIVATION_NOT_OPERATOR_REGISTERED);
    expect(refusal({ registeredRepositories: [] })).toBe(ContractChangeRefusal.FIRST_ACTIVATION_REPOSITORIES_MISMATCH);
    expect(refusal({ registeredRepositories: [{ role: "secondary", identity: FIRST_IDENTITY }] })).toBe(ContractChangeRefusal.FIRST_ACTIVATION_REPOSITORIES_MISMATCH);
    expect(refusal({ registeredRepositories: [...facts.registeredRepositories, { role: "secondary", identity: "github:acme/two" }] }))
      .toBe(ContractChangeRefusal.FIRST_ACTIVATION_REPOSITORIES_MISMATCH);
    expect(refusal({ runRepositories: 1 })).toBe(ContractChangeRefusal.FIRST_ACTIVATION_RUN_HAS_REPOSITORIES);
  });

  it("E6 against the REGISTERED identity: a revision whose identity matches the manifest but not the registration is refused", () => {
    const moved = normalized({ ...m1, repositories: [{ role: "primary", remote: "github:acme/moved", manifestRoot: "." }] });
    expect(firstActivationRevisions(moved, revisionsFor(moved, SHA), facts.registeredRepositories)).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_REVISIONS_MISMATCH, registeredIdentity: FIRST_IDENTITY },
    });
    expect(firstActivationRevisions(m1, revisionsFor(m1, SHA), facts.registeredRepositories).allowed).toBe(true);
  });
});

describe("D1-a / D1-c in activation coverage", () => {
  const m1 = firstManifest("fa-cover", [unitTestsWorkflow, lintWorkflow]);
  const bound = revisionsFor(m1, SHA);
  const expected = m1.ciWorkflows.map((workflow) => ({
    repositoryRole: workflow.repositoryRole,
    repositoryRemote: FIRST_IDENTITY,
    path: workflow.path,
    checkName: workflow.checkName,
    approvedDigest: workflow.approvedDigest,
    unapprovedFirstActivation: false,
    unchangedFromBase: false,
  }));
  const readOf = (revision: (typeof bound)[number]): FirstActivationWorkflowEvidence => ({
    repositoryRole: revision.repositoryRole,
    repositoryIdentity: revision.repositoryIdentity,
    path: revision.path,
    checkName: revision.checkName,
    approvedDigest: revision.fileDigest,
    evidence: "READ",
    revision: revision.commitSha,
    observedDigest: revision.fileDigest,
    commitSha: revision.commitSha,
    objectType: "commit",
    blobSha: "b".repeat(40),
    readVia: "LOCAL",
    reachable: "UNKNOWN",
    defaultBranchHead: null,
  });
  const supplied = bound.map(readOf);

  it("D1-a: ([], []) is coverage on the general path and never on the first-activation path", () => {
    expect(sameWorkflowCoverage([], [])).toBe(true);
    expect(sameFirstActivationCoverage([], [], [])).toBe(false);
    expect(sameFirstActivationCoverage(bound, expected, supplied)).toBe(true);
  });

  it("D1-c: equal counts with a mismatch are not coverage — checkName, path, identity, digest, revision, duplicate", () => {
    const [unit, lint] = supplied as [FirstActivationWorkflowEvidence, FirstActivationWorkflowEvidence];
    const cases: Record<string, FirstActivationWorkflowEvidence[]> = {
      "swapped checkName": [{ ...unit, checkName: lint.checkName }, { ...lint, checkName: unit.checkName }],
      "wrong path": [{ ...unit, path: WORKFLOW_PATH + ".bak" }, lint],
      "wrong identity": [{ ...unit, repositoryIdentity: "github:acme/elsewhere" }, lint],
      "another entry's digest": [{ ...unit, observedDigest: lint.observedDigest }, lint],
      "the default head read instead of the bound commit": [{ ...unit, revision: OTHER_SHA, commitSha: OTHER_SHA }, lint],
      "revision differs from the commit read": [{ ...unit, revision: OTHER_SHA }, lint],
      "one duplicate plus one missing": [unit, unit],
      "not read": [{ ...unit, evidence: "NOT_READ" as "READ" }, lint],
    };
    for (const [name, entries] of Object.entries(cases)) {
      expect(sameFirstActivationCoverage(bound, expected, entries), name).toBe(false);
    }
  });

  it("a first-activation binding never equals a general one, and equal ones need the same revisions", () => {
    const first = { planDigest: "p", manifestDigest: "m", baseManifestDigest: null, firstActivation: true as const, workflowRevisionsDigest: "r" };
    expect(sameContractChangeBinding(first, { ...first })).toBe(true);
    expect(sameContractChangeBinding(first, { ...first, workflowRevisionsDigest: "other" })).toBe(false);
    expect(sameContractChangeBinding(first, { planDigest: "p", manifestDigest: "m", baseManifestDigest: "base" })).toBe(false);
    expect(sameContractChangeBinding({ planDigest: "p", manifestDigest: "m", baseManifestDigest: "b" }, { planDigest: "p", manifestDigest: "m", baseManifestDigest: "b" })).toBe(true);
  });
});
