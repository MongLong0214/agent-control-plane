import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { bootstrapActivationHandoff, currentBootstrapPlan, executablePlanOf, planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { submittedPlanSchema } from "../../src/bootstrap/plan-input-schema.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { activateAndConfirm, ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const retired = async (h: Harness) => {
  await registerFixtureProject(h, "freshreadme");
  const run = h.cp.runs.create({ projectId: "freshreadme", kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "historical contract", why: "preserve history", scope: [], nonGoals: [], acceptance: [], priority: "NORMAL", humanGate: [], references: [] } });
  if (!run.allowed) throw new Error(run.message);
  h.cp.artifacts.put(run.value.runId, "PLAN", { historicalEvidence: "keep exact bytes" });
  h.cp.db.run(`UPDATE projects SET retired_at = ? WHERE project_id = ?`, [h.clock.nowIso(), "freshreadme"]);
  return run.value.runId;
};

const history = (h: Harness, runId: string) => ({
  project: h.cp.projects.get("freshreadme"),
  repositories: h.cp.db.all(`SELECT * FROM repositories WHERE project_id = ?`, ["freshreadme"]),
  manifests: h.cp.db.all(`SELECT * FROM manifests`),
  runs: h.cp.db.all(`SELECT * FROM runs WHERE project_id = ?`, ["freshreadme"]),
  evidence: h.cp.db.all(`SELECT * FROM run_artifacts WHERE run_id = ?`, [runId]),
  audit: h.cp.db.all(`SELECT * FROM audit_events WHERE project_id = ? OR run_id = ?`, ["freshreadme", runId]),
});

// Snapshot every table, including audit/outbox/manifest storage, across a refused activation.
const database = (h: Harness) => h.cp.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
  .map(({ name }) => [name, h.cp.db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`)]);

const prepare = async (supersedesProjectId?: string) => {
  const base = cleanTreeManifest("freshreadme-2");
  const manifest = { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
  const p = await prepareBootstrapRun("freshreadme-2", {
    manifest,
    ops: [{ operationId: "create-repository:fixture", resourceType: "repository", resourceIdentity: "github:acme/fixture", desiredState: { visibility: "public", autoInit: true } }],
    ...(supersedesProjectId === undefined ? {} : { supersedesProjectId }),
  });
  return { ...p, input: { ...p.input, handoff: bootstrapActivationHandoff(manifest) } };
};

describe("explicit bootstrap predecessor", () => {
  it("survives submission normalization and changes both PLAN and planned outputs digests", () => {
    const manifest = cleanTreeManifest("freshreadme-2");
    const normalize = (extra: Record<string, unknown>) => {
      const parsed = submittedPlanSchema.parse({ ...bootstrapPlan(manifest), ...extra });
      const normalized = planForSubmission({ kind: RunKind.PROJECT_BOOTSTRAP, projectId: null }, parsed);
      if (!normalized.allowed) throw new Error(normalized.message);
      return normalized.value;
    };
    const absent = normalize({});
    const named = normalize({ supersedesProjectId: "freshreadme" });
    expect(named["supersedesProjectId"]).toBe("freshreadme");
    expect(digestOf(named)).not.toBe(digestOf(absent));
    const outputs = (content: Record<string, unknown>) => {
      const planned = currentBootstrapPlan("run", { digest: digestOf(content), content });
      if (!planned.allowed) throw new Error(planned.message);
      return planned;
    };
    expect(outputs(named).value.binding.plannedOutputsDigest).not.toBe(outputs(absent).value.binding.plannedOutputsDigest);
  });

  it("registers and reads back the explicit retired predecessor through activation and CONFIRM, preserving its history", async () => {
    const p = await prepare("freshreadme");
    const oldRun = await retired(p.harness);
    // A different inferred predecessor must never override the one the PLAN names.
    p.harness.cp.db.run(`INSERT INTO projects(project_id,name,created_at,retired_at) VALUES ('inferred','inferred',?,?)`, [p.harness.clock.nowIso(), p.harness.clock.nowIso()]);
    p.harness.cp.db.run(`UPDATE repositories SET retired_at = ? WHERE project_id = 'freshreadme'`, [p.harness.clock.nowIso()]);
    p.harness.cp.db.run(`INSERT INTO repositories(repository_id,identity,checkout_path,project_id,created_at,retired_at) VALUES ('inferred-repo','github:acme/fixture','/inferred','inferred',?,?)`, [p.harness.clock.nowIso(), p.harness.clock.nowIso()]);
    const before = history(p.harness, oldRun);
    const { beforeConfirm, final } = await activateAndConfirm(p);
    expect(p.harness.cp.projects.get("freshreadme-2")?.supersedesProjectId).toBe("freshreadme");
    expect(p.harness.cp.audit.byKind("PROJECT_REGISTERED").filter(row => row.projectId === "freshreadme-2")).toHaveLength(1);
    for (const result of [beforeConfirm, final]) expect(result).toMatchObject({ projectRegistration: { supersedesProjectId: "freshreadme" } });
    const after = history(p.harness, oldRun);
    // Registration adds only the new manifest; every predecessor manifest remains byte-identical.
    expect(after.manifests).toEqual(expect.arrayContaining(before.manifests));
    expect({ ...after, manifests: before.manifests }).toEqual(before);
  });

  it.each([
    ["missing", "PROJECT_PREDECESSOR_NOT_FOUND"],
    ["active", "PROJECT_PREDECESSOR_NOT_RETIRED"],
    ["freshreadme-2", "PROJECT_PREDECESSOR_SELF"],
    ["claimed", "PROJECT_PREDECESSOR_ALREADY_SUPERSEDED"],
  ])("refuses %s at activation with %s and writes nothing", async (predecessor, reasonCode) => {
    const p = await prepare(predecessor);
    if (predecessor === "active" || predecessor === "claimed") {
      p.harness.cp.projects.register({ projectId: predecessor, name: predecessor });
      if (predecessor === "claimed") {
        p.harness.cp.db.run(`UPDATE projects SET retired_at = ? WHERE project_id = ?`, [p.harness.clock.nowIso(), predecessor]);
        p.harness.cp.db.run(`INSERT INTO projects(project_id,name,created_at,supersedes_project_id) VALUES ('claimant','claimant',?,?)`, [p.harness.clock.nowIso(), predecessor]);
      }
    }
    const beforeRegistration = database(p.harness);
    expect(p.harness.cp.projects.register({ projectId: p.manifest.projectId, name: "refused", supersedesProjectId: predecessor,
      manifest: p.manifest, authorization: p.harness.cp.manifestAuthorizationForTests(p.manifest) }))
      .toMatchObject({ allowed: false, reasonCode });
    expect(database(p.harness)).toEqual(beforeRegistration);
    const current = currentBootstrapPlan(p.runId, p.harness.cp.artifacts.latest(p.runId, "PLAN"));
    if (!current.allowed) throw new Error(current.message);
    const factory = await produceRepoFactoryResult({
      plan: executablePlanOf(current.value.outputs, current.value.binding.planDigest), workDir: join(p.workRoot, "activation-fixture"),
      approvedFiles: current.value.outputs.files,
      github: { port: p.github, authority: { owner: "acme", visibility: "public", approvedOperations: current.value.outputs.githubOperations.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity })) } },
    });
    if (!factory.allowed) throw new Error(factory.message);
    const before = database(p.harness);
    const activated = await p.harness.cp.bootstrap.activate({
      ...p.input, factoryResult: factory.value,
      localBindings: factory.value.repositories.map(r => ({ identity: r.identity, repositoryRole: r.role, checkoutPath: r.proposedCheckoutPath! })),
    });
    expect(activated).toMatchObject({ allowed: false, reasonCode });
    expect(database(p.harness)).toEqual(before);
    const approval = ownerApprovalFor(p);
    const beforeRunner = database(p.harness);
    const writes = [...p.github.writes];
    expect(await p.runner.produceAndActivate({ ...p.input, ownerApproval: approval })).toMatchObject({ allowed: false, reasonCode });
    expect(p.github.writes).toEqual(writes);
    expect(database(p.harness)).toEqual(beforeRunner);
  });

  it.each([null, "earlier"])("refuses replacing an existing %s link, and serial registrations cannot claim the same predecessor", async (existingLink) => {
    const h = makeHarness();
    await retired(h);
    h.cp.projects.register({ projectId: "existing", name: "existing" });
    if (existingLink !== null) {
      h.cp.projects.register({ projectId: existingLink, name: existingLink });
      h.cp.db.run(`UPDATE projects SET supersedes_project_id = ? WHERE project_id = 'existing'`, [existingLink]);
    }
    const before = database(h);
    expect(h.cp.projects.register({ projectId: "existing", name: "existing", supersedesProjectId: "freshreadme" }))
      .toMatchObject({ allowed: false, reasonCode: "PROJECT_PREDECESSOR_LINK_CONFLICT" });
    expect(database(h)).toEqual(before);
    expect(h.cp.projects.register({ projectId: "successor", name: "successor", supersedesProjectId: "freshreadme" }))
      .toMatchObject({ allowed: true, value: { supersedesProjectId: "freshreadme" } });
    const claimed = database(h);
    expect(h.cp.projects.register({ projectId: "other", name: "other", supersedesProjectId: "freshreadme" }))
      .toMatchObject({ allowed: false, reasonCode: "PROJECT_PREDECESSOR_ALREADY_SUPERSEDED" });
    expect(database(h)).toEqual(claimed);
  });

  it("allows a predecessor that itself supersedes an older project", async () => {
    const h = makeHarness();
    await retired(h);
    h.cp.projects.register({ projectId: "earlier", name: "earlier" });
    h.cp.db.run(`UPDATE projects SET supersedes_project_id = 'earlier' WHERE project_id = 'freshreadme'`);
    expect(h.cp.projects.register({ projectId: "successor", name: "successor", supersedesProjectId: "freshreadme" }))
      .toMatchObject({ allowed: true, value: { supersedesProjectId: "freshreadme" } });
    expect(h.cp.projects.get("freshreadme")?.supersedesProjectId).toBe("earlier");
  });

  it.each([false, true])("the same link retry succeeds without another write or audit (manifest: %s)", async (withManifest) => {
    const h = makeHarness();
    await retired(h);
    const manifest = cleanTreeManifest("successor");
    const input = { projectId: "successor", name: "successor", supersedesProjectId: "freshreadme",
      ...(withManifest ? { manifest, authorization: h.cp.manifestAuthorizationForTests(manifest) } : {}) };
    const first = h.cp.projects.register(input);
    expect(first).toMatchObject({ allowed: true });
    const before = database(h);
    const writes = vi.spyOn(h.cp.db, "run");
    expect(h.cp.projects.register(input)).toEqual(first);
    expect(writes).not.toHaveBeenCalled();
    expect(database(h)).toEqual(before);
    expect(h.cp.audit.byKind("PROJECT_REGISTERED").filter(row => row.projectId === "successor")).toHaveLength(1);
  });

  it.each(["not-retired", "claimed"])("refuses a predecessor that becomes %s after PLAN validation", async (change) => {
    const p = await prepare("freshreadme");
    await retired(p.harness);
    expect(p.harness.cp.projects.validatePredecessor(p.manifest.projectId, "freshreadme")).toMatchObject({ allowed: true });
    if (change === "not-retired") {
      p.harness.cp.db.run(`UPDATE projects SET retired_at = NULL WHERE project_id = 'freshreadme'`);
    } else {
      p.harness.cp.db.run(`INSERT INTO projects(project_id,name,created_at,supersedes_project_id) VALUES ('claimant','claimant',?,'freshreadme')`, [p.harness.clock.nowIso()]);
    }
    const approval = ownerApprovalFor(p);
    const before = database(p.harness);
    expect(await p.runner.produceAndActivate({ ...p.input, ownerApproval: approval })).toMatchObject({ allowed: false,
      reasonCode: change === "not-retired" ? "PROJECT_PREDECESSOR_NOT_RETIRED" : "PROJECT_PREDECESSOR_ALREADY_SUPERSEDED" });
    expect(database(p.harness)).toEqual(before);
    expect(p.github.writes).toEqual([]);
  });

  it("a resumed activation rechecks predecessor conditions inside its registration transaction", async () => {
    const p = await prepare("freshreadme");
    await retired(p.harness);
    p.harness.cp.db.run(`UPDATE repositories SET retired_at = ? WHERE project_id = 'freshreadme'`, [p.harness.clock.nowIso()]);
    const first = await p.runner.produceAndActivate({ ...p.input, ownerApproval: ownerApprovalFor(p) });
    expect(first).toMatchObject({ allowed: false, reasonCode: "BOOTSTRAP_ACTIVATION_INCOMPLETE" });
    expect(p.harness.cp.projects.get(p.manifest.projectId)?.supersedesProjectId).toBe("freshreadme");
    const result = p.harness.cp.artifacts.latest<RepoFactoryResult>(p.runId, "REPO_FACTORY_RESULT")!.content;
    const validate = p.harness.cp.projects.validatePredecessor.bind(p.harness.cp.projects);
    let checkedInTransaction = false;
    vi.spyOn(p.harness.cp.projects, "validatePredecessor").mockImplementation((projectId, predecessor) => {
      if (p.harness.cp.db.inTransaction) {
        checkedInTransaction = true;
        // The earlier preflight passed; the transaction must observe the changed condition.
        p.harness.cp.db.run(`UPDATE projects SET retired_at = NULL WHERE project_id = 'freshreadme'`);
      }
      return validate(projectId, predecessor);
    });
    const before = database(p.harness);
    const retried = await p.harness.cp.bootstrap.activate({ ...p.input, factoryResult: result,
      localBindings: result.repositories.map(r => ({ identity: r.identity, repositoryRole: r.role, checkoutPath: r.proposedCheckoutPath! })) });
    expect(retried).toMatchObject({ allowed: false, reasonCode: "PROJECT_PREDECESSOR_NOT_RETIRED" });
    expect(checkedInTransaction).toBe(true);
    expect(database(p.harness)).toEqual(before);
  });

  it("rolls the manifest and linked registration back together if the registration audit fails", async () => {
    const h = makeHarness();
    await retired(h);
    const manifest = cleanTreeManifest("successor");
    const before = database(h);
    vi.spyOn(h.cp.audit, "record").mockImplementation(() => { throw new Error("audit unavailable"); });
    expect(() => h.cp.projects.register({ projectId: manifest.projectId, name: "successor", supersedesProjectId: "freshreadme", manifest, authorization: h.cp.manifestAuthorizationForTests(manifest) }))
      .toThrow("audit unavailable");
    expect(database(h)).toEqual(before);
  });

  it("keeps absent-field registration and activation unchanged", async () => {
    const p = await prepare();
    const { final } = await activateAndConfirm(p);
    expect(p.harness.cp.projects.get("freshreadme-2")?.supersedesProjectId).toBeNull();
    expect(final).toMatchObject({ projectRegistration: { registered: true } });
    const h = makeHarness();
    await retired(h);
    h.cp.db.run(`UPDATE repositories SET retired_at = ? WHERE project_id = 'freshreadme'`, [h.clock.nowIso()]);
    const manifest = cleanTreeManifest("implicit-successor");
    const registered = h.cp.projects.register({ projectId: manifest.projectId, name: "implicit", manifest, authorization: h.cp.manifestAuthorizationForTests(manifest) });
    expect(registered).toMatchObject({ allowed: true, value: { supersedesProjectId: "freshreadme" } });
  });
});
