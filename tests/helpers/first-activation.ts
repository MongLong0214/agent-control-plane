import { digestOf, sha256 } from "../../src/core/digest.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, Role, type RunKind, roleKeyFor, type RunRow } from "../../src/domain/types.ts";
import type { WorkflowRevision } from "../../src/registry/contract-change-plan.ts";
import { CONTRACT_CHANGE_CONTRACT, WORKFLOW, WORKFLOW_PATH, normalized } from "./contract-change.ts";
import { bindCeo, fixtureManifest, type Harness } from "./harness.ts";

/**
 * #512 (v45) — the first-activation fixture: a project the operator registered the way
 * `agentctl project register` does (no manifest, so its active manifest is NULL and its
 * PROJECT_REGISTERED row records a JSON-null manifest), with one REGISTERED repository, and the
 * manifest M1 a first activation proposes for it, which names one approved CI workflow.
 */

export const FIRST_IDENTITY = "github:acme/fixture";
export const LINT_PATH = ".github/workflows/lint.yml";
export const LINT = "name: lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --check verify.js\n";

export const unitTestsWorkflow = {
  path: WORKFLOW_PATH,
  checkName: "unit-tests",
  approvedDigest: sha256(WORKFLOW),
  unapprovedFirstActivation: false,
  repositoryRole: "primary",
};

export const lintWorkflow = {
  path: LINT_PATH,
  checkName: "lint",
  approvedDigest: sha256(LINT),
  unapprovedFirstActivation: false,
  repositoryRole: "primary",
};

/** M1 for `projectId`: the fixture manifest naming `workflows` (by default the one unit-tests workflow). */
export const firstManifest = (
  projectId: string,
  workflows: ReadonlyArray<typeof unitTestsWorkflow> = [unitTestsWorkflow],
  overrides: Partial<ProjectManifest> = {},
): ProjectManifest => normalized({ ...fixtureManifest(projectId), ciWorkflows: workflows, ...overrides });

/** One exact revision per workflow of `manifest`, at `commitSha` of the role's remote. */
export const revisionsFor = (manifest: ProjectManifest, commitSha: string): WorkflowRevision[] =>
  manifest.ciWorkflows.map((workflow) => ({
    repositoryRole: workflow.repositoryRole,
    repositoryIdentity: manifest.repositories.find((repository) => repository.role === workflow.repositoryRole)!.remote,
    path: workflow.path,
    checkName: workflow.checkName,
    commitSha,
    fileDigest: workflow.approvedDigest!,
  }));

export const firstPlan = (manifest: ProjectManifest, workflowRevisions: unknown) => ({
  summary: "activate the project's first manifest",
  firstActivation: true,
  projectManifestDigest: manifestDigest(manifest),
  projectManifest: manifest,
  workflowRevisions,
});

/** Registers `projectId` the way the operator socket does: no manifest, then its primary repository. */
export const operatorRegisteredProject = async (
  h: Harness,
  projectId: string,
  options: { identity?: string; checkoutPath?: string } = {},
): Promise<{ projectId: string; repositoryId: string; identity: string; registrationEventId: number }> => {
  const project = h.cp.projects.register({ projectId, name: "operator-registered" });
  if (!project.allowed) throw new Error(`${project.reasonCode}: ${project.message}`);
  const repository = await h.cp.repositories.register({
    checkoutPath: options.checkoutPath ?? h.repoPath,
    projectId,
    repositoryRole: "primary",
    identity: options.identity ?? FIRST_IDENTITY,
  });
  if (!repository.allowed) throw new Error(`${repository.reasonCode}: ${repository.message}`);
  const registration = h.cp.db.get<{ event_id: number }>(
    `SELECT event_id FROM audit_events WHERE kind = 'PROJECT_REGISTERED' AND project_id = ?`,
    [projectId],
  )!;
  return { projectId, repositoryId: repository.value.repositoryId, identity: repository.value.identity, registrationEventId: registration.event_id };
};

/** Creates a run of `kind` on `projectId` and, unless told not to, dispatches it. */
export const createRun = async (
  h: Harness,
  projectId: string,
  kind: RunKind,
  options: { dispatch?: boolean } = {},
): Promise<RunRow> => {
  if (!h.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(h);
  h.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const created = h.cp.runs.create({ projectId, kind, executionMode: ExecutionMode.STANDARD, contract: CONTRACT_CHANGE_CONTRACT, repositories: [] });
  if (!created.allowed) throw new Error(`${created.reasonCode}: ${created.message}`);
  if (options.dispatch === false) return h.cp.runs.require(created.value.runId);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  return dispatched.value;
};

/**
 * The database effect of a first activation, written with the raw handle: a first-activation grant
 * for `runId` (a NULL-pinned CONTRACT_CHANGE of the NULL project), consumed, and the pointer moved
 * NULL → M1. Used where the activation is the precondition of a witness, not what it measures; every
 * schema guard still applies to these writes.
 */
export const rawFirstActivation = (
  h: Harness,
  input: { projectId: string; runId: string; registrationEventId: number; manifest: ProjectManifest },
): string => {
  const digest = manifestDigest(input.manifest);
  const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const db = h.cp.db;
  if (!db.get(`SELECT 1 FROM manifests WHERE digest = ?`, [digest])) {
    db.run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`, [
      digest, input.manifest.schema, JSON.stringify(input.manifest), h.cp.clock.nowIso(),
    ]);
  }
  const revisions = revisionsFor(input.manifest, "a".repeat(40));
  db.run(
    `INSERT INTO manifest_first_activation_grants
       (grant_id, run_id, project_id, run_kind, registration_event_id, manifest_digest, plan_digest,
        candidate_snapshot_digest, packet_digest, review_digest, workflow_revisions_json,
        workflow_revisions_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
        ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
        consumer_session_id, consumer_session_incarnation, consumer_bound_at)
     VALUES (?, ?, ?, 'CONTRACT_CHANGE', ?, ?, 'sha256:plan', 'sha256:candidate', 'sha256:packet', 'sha256:review', ?, ?, ?, 'actor', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `mfa_raw_${input.runId}`, input.runId, input.projectId, input.registrationEventId, digest,
      JSON.stringify(revisions), digestOf({ revisions }), ceo.assignmentId, ceo.sessionId, ceo.sessionIncarnation,
      ceo.bindingGeneration, h.cp.clock.nowIso(), digestOf({ raw: input.runId }), ceo.sessionId, ceo.sessionIncarnation, h.cp.clock.nowIso(),
    ],
  );
  db.run(`UPDATE manifest_first_activation_grants SET consumed_at = ?, consumed_attempt_id = 'raw-attempt' WHERE run_id = ?`, [
    h.cp.clock.nowIso(), input.runId,
  ]);
  db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [digest, input.projectId]);
  return digest;
};
