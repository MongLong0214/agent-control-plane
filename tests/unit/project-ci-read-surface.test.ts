import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import type { ProjectCi, ProjectCiWorkflow } from "../../src/registry/project-ci.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1257 — `project_get` carries a CI section read from the active manifest and from recorded
 * post-merge observations, and availability says nothing about it.
 */
const WORKFLOW = {
  path: ".github/workflows/ci.yml",
  checkName: "project-ci",
  repositoryRole: "primary",
  approvedDigest: "sha256:approved-ci",
};
const DECLARED = { ...WORKFLOW, unapprovedFirstActivation: false };

interface ProjectGet { project: { availability: string }; ci: ProjectCi }

async function projectGet(h: Harness, projectId: string): Promise<ProjectGet> {
  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: "operator" }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "project-ci-read", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "project_get", arguments: { projectId } });
    const body = result.structuredContent as { ok: boolean; value: ProjectGet };
    expect(body.ok).toBe(true);
    return body.value;
  } finally {
    await client.close();
    await server.close();
  }
}

const onlyWorkflow = (ci: ProjectCi | undefined): ProjectCiWorkflow => {
  expect(ci, "project_get carries no declared CI section").toMatchObject({ declared: true });
  if (!ci?.declared) throw new Error("unreachable: asserted declared above");
  expect(ci.workflows).toHaveLength(1);
  return ci.workflows[0]!;
};

/** A finished run pinned to `pinnedManifestDigest`, holding the repository in role `primary`. */
function seedObservingRun(h: Harness, projectId: string, repositoryId: string, pinnedManifestDigest: string): string {
  const runId = `run_ci_${Math.random().toString(16).slice(2, 10)}`;
  h.cp.db.run(
    `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
                       pinned_manifest_digest, created_at)
     VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'COMPLETED', 'ci fixture', 'sha256:contract', ?, ?)`,
    [runId, projectId, pinnedManifestDigest, h.clock.nowIso()],
  );
  h.cp.db.run(
    `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch) VALUES (?, ?, 'primary', 'dev')`,
    [runId, repositoryId],
  );
  return runId;
}

/** The row post-merge verification writes for one observed commit (github-kernel postMergeVerify). */
function recordPostMergeReceipt(
  h: Harness,
  input: { runId: string; identity: string; commitSha: string; conclusion: string; at: string },
): string {
  const checks = [{ name: WORKFLOW.checkName, conclusion: input.conclusion }];
  const idempotencyKey = `post_merge_verify:${input.identity}:${input.commitSha}`;
  const receiptId = `rcp_${sha256(idempotencyKey).slice(7, 31)}`;
  h.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
        resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
        response_json, created_at, reread_at, verified, status)
     VALUES (?, ?, 'post_merge_verify', ?, ?, 'commit', ?, 0, NULL, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
    [
      receiptId, idempotencyKey, input.runId, input.identity, `acme/fixture@${input.commitSha}`,
      digestOf(checks), digestOf({ mergeCommitSha: input.commitSha, requiredChecks: [WORKFLOW.checkName] }),
      JSON.stringify({ checks }), input.at, input.at,
    ],
  );
  return receiptId;
}

async function declaredProject(h: Harness) {
  const registered = await registerFixtureProject(h, "ci-project", { ciWorkflows: [DECLARED] });
  const activeDigest = h.cp.projects.get(registered.projectId)!.activeManifestDigest!;
  const head = gitSync(h.repoPath, ["rev-parse", "HEAD"]).trim();
  return { ...registered, activeDigest, head };
}

describe("project_get CI section (#1257)", () => {
  it("reports CI undeclared when the project has no active manifest", async () => {
    const h = makeHarness();
    expect(h.cp.projects.register({ projectId: "bare-project", name: "bare" }).allowed).toBe(true);

    const view = await projectGet(h, "bare-project");

    expect(view.ci).toEqual({ declared: false, reason: "NO_ACTIVE_MANIFEST", manifestDigest: null });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reports CI undeclared when the active manifest declares no ciWorkflows", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "no-ci-project", { ciWorkflows: [] });
    const activeDigest = h.cp.projects.get(projectId)!.activeManifestDigest;

    const view = await projectGet(h, projectId);

    expect(view.ci).toEqual({ declared: false, reason: "NO_CI_WORKFLOWS", manifestDigest: activeDigest });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("lists a declared workflow with no recorded observation as unobserved", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);

    const view = await projectGet(h, project.projectId);

    expect(view.ci).toMatchObject({ declared: true, manifestDigest: project.activeDigest });
    expect(onlyWorkflow(view.ci)).toEqual({
      ...WORKFLOW,
      repositoryIdentity: project.identity,
      repositoryHead: { commitSha: project.head, observedAt: expect.any(String) },
      lastObserved: null,
      unobserved: true,
      unobservedReason: "NO_RECORDED_OBSERVATION",
    });
    // HEALTHY with nothing observed: availability does not stand in for CI.
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reports the same workflow's recorded PASS at the current head under the approved digest as current", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    expect(onlyWorkflow((await projectGet(h, project.projectId)).ci).unobserved).toBe(true);

    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const receiptId = recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });

    const workflow = onlyWorkflow((await projectGet(h, project.projectId)).ci);
    expect(workflow.unobserved).toBe(false);
    expect(workflow.unobservedReason).toBeNull();
    expect(workflow.lastObserved).toEqual({
      result: "PASS",
      conclusion: "success",
      commitSha: project.head,
      observedAt: "2026-08-12T01:00:00.000Z",
      source: { kind: "POST_MERGE_VERIFY_RECEIPT", receiptId, runId },
      approvedDigestAtObservation: WORKFLOW.approvedDigest,
      freshness: "current",
      staleReasons: [],
    });
  });

  it("reports a recorded FAIL as FAIL, the latest receipt winning, while availability stays HEALTHY", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const earlier = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordPostMergeReceipt(h, {
      runId: earlier, identity: project.identity, commitSha: "e".repeat(40), conclusion: "success", at: "2026-08-12T00:30:00.000Z",
    });
    const receiptId = recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "failure", at: "2026-08-12T01:00:00.000Z",
    });

    const view = await projectGet(h, project.projectId);

    expect(onlyWorkflow(view.ci).lastObserved).toMatchObject({
      result: "FAIL",
      conclusion: "failure",
      commitSha: project.head,
      source: { receiptId, runId },
      freshness: "current",
      staleReasons: [],
    });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("marks an observation stale with OLDER_COMMIT once the repository head has moved past it", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });
    writeFiles(h.repoPath, { "CHANGELOG.md": "later change\n" });
    const newer = commitAll(h.repoPath, "later change");
    h.cp.repositories.acknowledgeHead(project.repositoryId, newer);

    const workflow = onlyWorkflow((await projectGet(h, project.projectId)).ci);

    expect(workflow.repositoryHead?.commitSha).toBe(newer);
    expect(workflow.lastObserved).toMatchObject({
      result: "PASS",
      commitSha: project.head,
      freshness: "stale",
      staleReasons: ["OLDER_COMMIT"],
    });
  });

  it("marks an observation stale with DIGEST_MISMATCH when its run approved a different workflow digest", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const earlierContract = fixtureManifest(project.projectId, {
      ciWorkflows: [{ ...DECLARED, approvedDigest: "sha256:earlier-ci" }],
    });
    const stored = h.cp.projects.storeManifest(earlierContract, h.cp.manifestAuthorizationForTests(earlierContract));
    if (!stored.allowed) throw new Error(stored.message);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, stored.value);
    recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });

    const workflow = onlyWorkflow((await projectGet(h, project.projectId)).ci);

    expect(workflow.approvedDigest).toBe(WORKFLOW.approvedDigest);
    expect(workflow.lastObserved).toMatchObject({
      result: "PASS",
      commitSha: project.head,
      approvedDigestAtObservation: "sha256:earlier-ci",
      freshness: "stale",
      staleReasons: ["DIGEST_MISMATCH"],
    });
  });
});
