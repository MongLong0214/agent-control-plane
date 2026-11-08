import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { dispatch } from "../../src/cli/agentctl.ts";
import { Daemon, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import type { ProjectCi, ProjectCiWorkflow } from "../../src/registry/project-ci.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1257 — `project_get` and `agentctl project list` carry a CI section read from the active manifest
 * and from recorded post-merge receipts and trusted-CI verification results, and availability says
 * nothing about it.
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

/** A pinned contract stored the way registration stores one, returning its digest. */
function storeContract(h: Harness, projectId: string, ciWorkflows: Array<typeof DECLARED>): string {
  const contract = fixtureManifest(projectId, { ciWorkflows });
  const stored = h.cp.projects.storeManifest(contract, h.cp.manifestAuthorizationForTests(contract));
  if (!stored.allowed) throw new Error(stored.message);
  return stored.value;
}

/** The row `VerificationEngine.collectCi` writes for one trusted-CI result. */
function recordCiVerification(
  h: Harness,
  input: { runId: string; identity: string; head: string; status: string; reasonCode?: string | null; at: string },
): string {
  const snapshot = digestOf({ runId: input.runId, head: input.head, at: input.at });
  const resultId = `${snapshot}:${WORKFLOW.checkName}:${input.identity}:ci`;
  h.cp.db.run(
    `INSERT INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, 'ci', ?, ?, ?, NULL, ?, 0, ?, ?)`,
    [resultId, input.runId, snapshot, WORKFLOW.checkName, input.identity, input.head, input.at, input.at,
      digestOf({ commandId: WORKFLOW.checkName, head: input.head }), input.status, input.reasonCode ?? null],
  );
  return resultId;
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

/**
 * A bootstrap run's producer result as the runner stores it, with CI evidence at the project's head, and
 * a doctor report: `activation` is the one activation stores right after the result once every check on
 * it passed; `other-source` a report from elsewhere; `before` activation's report stored before the result.
 */
function storeBootstrapResult(
  h: Harness,
  project: { projectId: string; identity: string; head: string; activeDigest: string },
  input: { marker: "activation" | "other-source" | "before"; workflowDigest?: string; evidenceHead?: string },
): { runId: string; artifactId: string } {
  const runId = `run_boot_${Math.random().toString(16).slice(2, 10)}`;
  h.cp.db.run(
    `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
     VALUES (?, ?, 'PROJECT_BOOTSTRAP', 'STANDARD', 'NORMAL', 'COMPLETED', 'bootstrap fixture', 'sha256:contract', ?)`,
    [runId, project.projectId, h.clock.nowIso()],
  );
  const at = h.clock.nowIso();
  const doctorReport = (source: string) => h.cp.artifacts.put(runId, "DOCTOR_REPORT", {
    source,
    projectId: project.projectId,
    report: { scope: "project", target: project.projectId, status: "HEALTHY", findings: [], ranAt: at },
  });
  if (input.marker === "before") doctorReport("bootstrap-activation");
  const stored = h.cp.artifacts.put(runId, "REPO_FACTORY_RESULT", {
    schema: "repo-factory.result.v2",
    runId,
    bootstrapOperationId: "op-bootstrap",
    planDigest: "sha256:plan",
    projectManifestDigest: project.activeDigest,
    repositories: [{ role: "primary", identity: project.identity, proposedCheckoutPath: null, defaultBranch: "main", createdBranches: [] }],
    externalWriteReceipts: [{
      bootstrapOperationId: "op-bootstrap", requestDigest: "sha256:request", operationId: "create", resourceType: "repository",
      resourceIdentity: project.identity, preexisting: false, beforeStateDigest: null, afterStateDigest: null,
      createdAt: at, rereadAt: at, verified: true,
    }],
    bootstrapVerification: [{ commandId: "clean-tree", repositoryIdentity: project.identity, exactHead: project.head, status: "PASS" }],
    ciEvidence: [{
      repositoryIdentity: project.identity, checkName: WORKFLOW.checkName, head: input.evidenceHead ?? project.head,
      conclusion: "PASS", workflowDigest: input.workflowDigest ?? WORKFLOW.approvedDigest,
    }],
    unresolvedGaps: [],
  });
  if (input.marker === "activation") doctorReport("bootstrap-activation");
  if (input.marker === "other-source") doctorReport("watchdog");
  return { runId, artifactId: stored.artifactId };
}

async function declaredProject(h: Harness) {
  const registered = await registerFixtureProject(h, "ci-project", { ciWorkflows: [DECLARED] });
  const activeDigest = h.cp.projects.get(registered.projectId)!.activeManifestDigest!;
  const head = gitSync(h.repoPath, ["rev-parse", "HEAD"]).trim();
  return { ...registered, activeDigest, head };
}

describe("project_get CI section (#1257)", () => {
  it("reports CI UNKNOWN, never undeclared, when the project has no active manifest (#1172)", async () => {
    const h = makeHarness();
    expect(h.cp.projects.register({ projectId: "bare-project", name: "bare" }).allowed).toBe(true);

    const view = await projectGet(h, "bare-project");

    expect(view.ci).toEqual({ status: "UNKNOWN", declared: null, reason: "NO_ACTIVE_MANIFEST", manifestDigest: null });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reports CI undeclared when the active manifest declares no ciWorkflows", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "no-ci-project", { ciWorkflows: [] });
    const activeDigest = h.cp.projects.get(projectId)!.activeManifestDigest;

    const view = await projectGet(h, projectId);

    expect(view.ci).toEqual({ status: "NOT_DECLARED", declared: false, reason: "NO_CI_WORKFLOWS", manifestDigest: activeDigest });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("lists a declared workflow with no recorded observation as unobserved", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);

    const view = await projectGet(h, project.projectId);

    expect(view.ci).toMatchObject({ status: "DECLARED_UNOBSERVED", declared: true, manifestDigest: project.activeDigest });
    expect(onlyWorkflow(view.ci)).toEqual({
      ...WORKFLOW,
      status: "DECLARED_UNOBSERVED",
      repositoryIdentity: project.identity,
      repositoryHead: { commitSha: project.head, observedAt: expect.any(String) },
      lastObserved: null,
      observedAtHead: null,
      latestNonResult: null,
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

  it("reports a trusted-CI check that finished failing as FAIL, the newest record winning, while availability stays HEALTHY", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const earlier = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordPostMergeReceipt(h, {
      runId: earlier, identity: project.identity, commitSha: "e".repeat(40), conclusion: "success", at: "2026-08-12T00:30:00.000Z",
    });
    const resultId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "FAIL",
      reasonCode: ReasonCode.VERIFICATION_CI_CHECK_FAILED, at: "2026-08-12T01:00:00.000Z",
    });

    const view = await projectGet(h, project.projectId);

    expect(onlyWorkflow(view.ci)).toMatchObject({
      unobserved: false,
      latestNonResult: null,
      lastObserved: {
        result: "FAIL",
        conclusion: null,
        commitSha: project.head,
        source: { kind: "CI_VERIFICATION_RESULT", resultId, runId, status: "FAIL", reasonCode: ReasonCode.VERIFICATION_CI_CHECK_FAILED },
        freshness: "stale",
        staleReasons: ["DIGEST_UNVERIFIED"],
      },
    });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reports a trusted-CI check that had not finished as PENDING, not as a result", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const resultId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "FAIL",
      reasonCode: ReasonCode.VERIFICATION_CI_CHECK_PENDING, at: "2026-08-12T01:00:00.000Z",
    });

    expect(onlyWorkflow((await projectGet(h, project.projectId)).ci)).toMatchObject({
      lastObserved: null,
      unobserved: true,
      unobservedReason: "PENDING",
      latestNonResult: {
        reason: "PENDING",
        conclusion: null,
        commitSha: project.head,
        source: { kind: "CI_VERIFICATION_RESULT", resultId, status: "FAIL", reasonCode: ReasonCode.VERIFICATION_CI_CHECK_PENDING },
      },
    });
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

  it("attributes an observation to the workflow its run pinned, not to another workflow sharing the check name", async () => {
    const h = makeHarness();
    const legacy = { ...DECLARED, path: ".github/workflows/old.yml" };
    const project = await registerFixtureProject(h, "ci-project", { ciWorkflows: [DECLARED, legacy] });
    const head = gitSync(h.repoPath, ["rev-parse", "HEAD"]).trim();
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, storeContract(h, project.projectId, [legacy]));
    const receiptId = recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });

    const ci = (await projectGet(h, project.projectId)).ci;

    if (!ci.declared) throw new Error(`expected declared CI, got ${ci.reason}`);
    expect(ci.workflows.map((workflow) => workflow.path)).toEqual([DECLARED.path, legacy.path]);
    expect(ci.workflows[0]).toMatchObject({ lastObserved: null, unobserved: true, unobservedReason: "NO_RECORDED_OBSERVATION" });
    expect(ci.workflows[0]!.latestNonResult).toBeNull();
    expect(ci.workflows[1]).toMatchObject({
      unobserved: false,
      lastObserved: { result: "PASS", commitSha: head, source: { receiptId, runId }, freshness: "current" },
    });
  });

  it.each([
    ["missing", "NOT_A_RESULT"],
    ["incomplete:in_progress", "PENDING"],
    // Post-merge records a failing check by name before proving who produced it (J-6).
    ["failure", "PROVENANCE_UNRECORDED"],
  ])("does not report a %s receipt as an observed result", async (conclusion, reason) => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const receiptId = recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion, at: "2026-08-12T01:00:00.000Z",
    });

    const workflow = onlyWorkflow((await projectGet(h, project.projectId)).ci);

    expect(workflow).toMatchObject({
      lastObserved: null,
      unobserved: true,
      unobservedReason: reason,
      latestNonResult: {
        reason,
        conclusion,
        commitSha: project.head,
        observedAt: "2026-08-12T01:00:00.000Z",
        source: { kind: "POST_MERGE_VERIFY_RECEIPT", receiptId, runId },
      },
    });
  });

  it("reports a trusted-CI verification PASS with its commit and time, never current on a digest it does not keep", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const resultId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "PASS", at: "2026-08-12T01:00:00.000Z",
    });

    const workflow = onlyWorkflow((await projectGet(h, project.projectId)).ci);

    expect(workflow.unobserved).toBe(false);
    expect(workflow.lastObserved).toEqual({
      result: "PASS",
      conclusion: null,
      commitSha: project.head,
      observedAt: "2026-08-12T01:00:00.000Z",
      source: { kind: "CI_VERIFICATION_RESULT", resultId, runId, status: "PASS", reasonCode: null },
      approvedDigestAtObservation: null,
      freshness: "stale",
      staleReasons: ["DIGEST_UNVERIFIED"],
    });
  });

  it("shows a newer trusted-CI FAIL beside the PASS, not as an observed FAIL, since it keeps no conclusion", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const passId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "PASS", at: "2026-08-12T01:00:00.000Z",
    });
    // The general code is what every trusted-CI FAIL row carried before the engine kept the
    // conclusion's kind, finished or not; such a row stays no result.
    const failId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "FAIL",
      reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED, at: "2026-08-12T02:00:00.000Z",
    });

    const workflow = onlyWorkflow((await projectGet(h, project.projectId)).ci);

    expect(workflow).toMatchObject({
      unobserved: false,
      lastObserved: { result: "PASS", source: { resultId: passId } },
      latestNonResult: {
        reason: "CONCLUSION_UNRECORDED",
        conclusion: null,
        observedAt: "2026-08-12T02:00:00.000Z",
        source: { kind: "CI_VERIFICATION_RESULT", resultId: failId, status: "FAIL", reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED },
      },
    });
  });

  it("gives `agentctl project list` the same CI section through the daemon's operator door", async () => {
    const h = makeHarness();
    h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    expect(h.cp.projects.register({ projectId: "bare-project", name: "bare" }).allowed).toBe(true);
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "PASS", at: "2026-08-12T01:00:00.000Z",
    });
    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-project-ci-cli-") });
    expect((await daemon.start()).allowed).toBe(true);
    const peer: AuthenticatedOperatorPeer = { channel: "cli", peerId: "cli:fixture-operator", actor: "fixture-operator", incarnation: "incarnation-1" };
    const client = {
      request: (method: string, params: Record<string, unknown> = {}) =>
        daemon.handleOperatorRequest({ requestId: `req-${method}`, method, params }, peer),
    };
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let exit: number;
    try {
      exit = await dispatch(client, "project", ["list"], false);
    } finally {
      stdout.mockRestore();
    }
    const fromProjectGet = (await projectGet(h, project.projectId)).ci;
    await daemon.stop();

    expect(exit).toBe(0);
    const listed = written.map((chunk) => { try { return JSON.parse(chunk) as unknown; } catch { return null; } })
      .find(Array.isArray) as Array<{ projectId: string; availability: string; ci: ProjectCi }>;
    const byId = new Map(listed.map((entry) => [entry.projectId, entry]));
    expect(byId.get("bare-project")).toMatchObject({
      availability: "HEALTHY",
      ci: { status: "UNKNOWN", declared: null, reason: "NO_ACTIVE_MANIFEST", manifestDigest: null },
    });
    expect(byId.get(project.projectId)?.availability).toBe("HEALTHY");
    expect(onlyWorkflow(byId.get(project.projectId)?.ci).lastObserved).toMatchObject({
      result: "PASS", source: { kind: "CI_VERIFICATION_RESULT" }, freshness: "stale",
    });
    expect(byId.get(project.projectId)?.ci).toEqual(fromProjectGet);
  });
});

/**
 * #1172 — one CI status beside availability: NOT_DECLARED, DECLARED_UNOBSERVED, DECLARED_OBSERVED or
 * UNKNOWN. Observed is not passed: the result stays the workflow's own `lastObserved.result`, the
 * declared check its `checkName`, and the target head its `repositoryHead`.
 */
describe("project_get CI status (#1172)", () => {
  it("reads NOT_DECLARED only when the active manifest was read and declares no CI", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "no-ci-project", { ciWorkflows: [] });

    const view = await projectGet(h, projectId);

    expect(view.ci.status).toBe("NOT_DECLARED");
    expect(view.ci.declared).toBe(false);
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reads UNKNOWN, not NOT_DECLARED, when the declaration cannot be read", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    vi.spyOn(h.cp.projects, "manifest").mockImplementation(() => {
      throw new SyntaxError("Unexpected token in JSON");
    });

    const view = await projectGet(h, project.projectId);

    expect(view.ci).toEqual({ status: "UNKNOWN", declared: null, reason: "ACTIVE_MANIFEST_UNREADABLE", manifestDigest: project.activeDigest });
    expect(view.project.availability).toBe("HEALTHY");

    // A manifest row that is missing reads the same way.
    vi.spyOn(h.cp.projects, "manifest").mockReturnValue(null);
    expect((await projectGet(h, project.projectId)).ci).toEqual({
      status: "UNKNOWN", declared: null, reason: "ACTIVE_MANIFEST_UNREADABLE", manifestDigest: project.activeDigest,
    });
  });

  it("reads DECLARED_UNOBSERVED when CI is declared and nothing is recorded", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_UNOBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({ status: "DECLARED_UNOBSERVED", checkName: WORKFLOW.checkName, lastObserved: null });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reads DECLARED_OBSERVED for a success at the current head, with the check, the conclusion, the SHA and the source apart", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const receiptId = recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_OBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({
      status: "DECLARED_OBSERVED",
      checkName: WORKFLOW.checkName,
      repositoryHead: { commitSha: project.head },
      lastObserved: {
        result: "PASS",
        conclusion: "success",
        commitSha: project.head,
        source: { kind: "POST_MERGE_VERIFY_RECEIPT", receiptId, runId },
      },
    });
    const workflow = onlyWorkflow(view.ci);
    expect(workflow.observedAtHead).toEqual(workflow.lastObserved);
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reads DECLARED_OBSERVED for a failure at the current head and keeps it a FAIL, never a success", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const resultId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "FAIL",
      reasonCode: ReasonCode.VERIFICATION_CI_CHECK_FAILED, at: "2026-08-12T01:00:00.000Z",
    });

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_OBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({
      status: "DECLARED_OBSERVED",
      lastObserved: { result: "FAIL", commitSha: project.head, source: { kind: "CI_VERIFICATION_RESULT", resultId } },
    });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reads an unfinished check at the current head as DECLARED_UNOBSERVED, not as observed", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "FAIL",
      reasonCode: ReasonCode.VERIFICATION_CI_CHECK_PENDING, at: "2026-08-12T01:00:00.000Z",
    });

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_UNOBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({ status: "DECLARED_UNOBSERVED", unobservedReason: "PENDING", lastObserved: null });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("shows a success for another SHA as that SHA's observation and the current head as unobserved", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });
    writeFiles(h.repoPath, { "CHANGELOG.md": "later change\n" });
    const newer = commitAll(h.repoPath, "later change");
    h.cp.repositories.acknowledgeHead(project.repositoryId, newer);

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_UNOBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({
      status: "DECLARED_UNOBSERVED",
      repositoryHead: { commitSha: newer },
      lastObserved: { result: "PASS", commitSha: project.head, staleReasons: ["OLDER_COMMIT"] },
      observedAtHead: null,
    });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("keeps a current-head failure DECLARED_OBSERVED as FAIL when a delayed success for an older SHA lands after it", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    const failId = recordCiVerification(h, {
      runId, identity: project.identity, head: project.head, status: "FAIL",
      reasonCode: ReasonCode.VERIFICATION_CI_CHECK_FAILED, at: "2026-08-12T01:00:00.000Z",
    });
    const older = "e".repeat(40);
    const receiptId = recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: older, conclusion: "success", at: "2026-08-12T02:00:00.000Z",
    });

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_OBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({
      status: "DECLARED_OBSERVED",
      repositoryHead: { commitSha: project.head },
      observedAtHead: { result: "FAIL", commitSha: project.head, source: { kind: "CI_VERIFICATION_RESULT", resultId: failId } },
      // The newer success stays shown, as the older commit's.
      lastObserved: { result: "PASS", commitSha: older, staleReasons: ["OLDER_COMMIT"], source: { receiptId } },
    });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it("reads a bootstrap's activation-validated CI evidence as an observation at its head, its source named", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const { runId, artifactId } = storeBootstrapResult(h, project, { marker: "activation" });

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_OBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({
      status: "DECLARED_OBSERVED",
      observedAtHead: {
        result: "PASS",
        conclusion: "PASS",
        commitSha: project.head,
        source: { kind: "BOOTSTRAP_CI_EVIDENCE", artifactId, runId },
        approvedDigestAtObservation: WORKFLOW.approvedDigest,
        freshness: "current",
        staleReasons: [],
      },
    });
    expect(view.project.availability).toBe("HEALTHY");
  });

  it.each([
    ["only another doctor report follows it", { marker: "other-source" }],
    ["it was stored after activation's report", { marker: "before" }],
    ["its workflow digest is not the approved one", { marker: "activation", workflowDigest: "sha256:another-workflow" }],
    ["it names a head its verification does not", { marker: "activation", evidenceHead: "f".repeat(40) }],
  ] as const)("does not read bootstrap CI evidence when %s", async (_why, input) => {
    const h = makeHarness();
    const project = await declaredProject(h);
    storeBootstrapResult(h, project, input);

    const view = await projectGet(h, project.projectId);

    expect(view.ci.status).toBe("DECLARED_UNOBSERVED");
    expect(onlyWorkflow(view.ci)).toMatchObject({ lastObserved: null, observedAtHead: null, unobservedReason: "NO_RECORDED_OBSERVATION" });
  });

  it("gives doctor scope \"project\" the same CI section through the doctor door, its status unchanged", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const unobserved = await h.cp.doctor.run("project", project.projectId);
    const runId = seedObservingRun(h, project.projectId, project.repositoryId, project.activeDigest);
    recordPostMergeReceipt(h, {
      runId, identity: project.identity, commitSha: project.head, conclusion: "success", at: "2026-08-12T01:00:00.000Z",
    });
    const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: "operator" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "project-ci-doctor", version: "1" });
    await client.connect(clientTransport);
    let doctor: { status: string; findings: unknown[]; ci?: unknown };
    try {
      const result = await client.callTool({ name: "doctor_run", arguments: { scope: "project", target: project.projectId } });
      doctor = (result.structuredContent as { value: typeof doctor }).value;
    } finally {
      await client.close();
      await server.close();
    }

    const ci = (await projectGet(h, project.projectId)).ci;
    expect(ci.status).toBe("DECLARED_OBSERVED");
    expect(doctor.ci).toEqual([{ projectId: project.projectId, ci }]);
    // Beside the doctor's status, never part of it: unobserved and observed CI give the same status and findings.
    expect(unobserved.ci).toMatchObject([{ projectId: project.projectId, ci: { status: "DECLARED_UNOBSERVED" } }]);
    expect(doctor.status).toBe(unobserved.status);
    expect(doctor.findings).toEqual(unobserved.findings);
    expect("ci" in (await h.cp.doctor.run("cto", project.projectId))).toBe(false);
  });

  it("reads UNKNOWN with the reason when the observation lookup is unavailable", async () => {
    const h = makeHarness();
    const project = await declaredProject(h);
    const all = h.cp.db.all.bind(h.cp.db);
    vi.spyOn(h.cp.db, "all").mockImplementation(((sql: string, params?: unknown[]) => {
      if (sql.includes("github_receipts")) throw new Error("SQLITE_IOERR: disk I/O error");
      return all(sql, params as never);
    }) as typeof h.cp.db.all);

    const view = await projectGet(h, project.projectId);

    expect(view.ci).toMatchObject({ status: "UNKNOWN", declared: true, manifestDigest: project.activeDigest });
    expect(onlyWorkflow(view.ci)).toMatchObject({
      status: "UNKNOWN",
      checkName: WORKFLOW.checkName,
      lastObserved: null,
      unobserved: true,
      unobservedReason: "OBSERVATIONS_UNREADABLE",
    });
    expect(view.project.availability).toBe("HEALTHY");
  });
});
