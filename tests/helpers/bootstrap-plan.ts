import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { bootstrapPlanCoverageTargets, currentBootstrapPlan } from "../../src/bootstrap/bootstrap-plan.ts";
import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { bindCeo, bindWorker, fixtureManifest, reviewerPass, reviewerRevise, type Harness } from "./harness.ts";

/**
 * Issue #246 PR-C slice C2 — fixtures for a project-less PROJECT_BOOTSTRAP run's plan and its
 * BOOTSTRAP_PLAN review, shared by the tests that need a bootstrap run at CEO review.
 *
 * `reviewBootstrapPlan` reaches READY_FOR_CEO_REVIEW the way production does: the run's bootstrap CTO
 * submits the PLAN (manifest included) through the `plan_submit` tool, the PLAN's tasks are carried
 * to SUCCEEDED by workers of their own, and `result_submit`'s pipeline freezes the candidate and runs
 * the blind review, answered here by the scripted reviewer. It writes no review and moves no state
 * itself. The witnesses of slice C2 drive the same path over the real sockets instead.
 */

export const BOOTSTRAP_IDENTITY = "github:acme/fixture";

export const APPROVED_PROTECTION = {
  requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
  enforceAdmins: true,
  requiredApprovingReviewCount: 1,
  allowForcePushes: false,
  allowDeletions: false,
};

/** The four operations the Repo Factory producer performs, desired state included. */
export const bootstrapOperations = (protection: Record<string, unknown> = APPROVED_PROTECTION, identity = BOOTSTRAP_IDENTITY) => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository" as const,
    resourceIdentity: identity,
    desiredState: { visibility: "public" as const },
  },
  { operationId: "push-default-branch:fixture", resourceType: "branch" as const, resourceIdentity: `${identity}#main` },
  {
    operationId: "set-default-branch:fixture",
    resourceType: "setting" as const,
    resourceIdentity: `${identity}#default-branch`,
    desiredState: { defaultBranch: "main" },
  },
  {
    operationId: "protect-default-branch:fixture",
    resourceType: "branch-protection" as const,
    resourceIdentity: `${identity}#main`,
    desiredState: protection,
  },
];

/** The one verification the producer can honestly run, declared as a manifest command. */
export const CLEAN_TREE_COMMAND = {
  id: "clean-tree",
  argv: ["git", "status", "--porcelain"],
  repositoryRole: "primary",
  cwd: ".",
  timeoutSeconds: 120,
  envAllowlist: [],
  network: "deny" as const,
  networkAllowlist: [],
  required: true as const,
  evidenceMode: "LOCAL_COMMAND" as const,
  maxOutputBytes: 1_048_576,
  maxMemoryMb: 2048,
};

export const cleanTreeManifest = (projectId: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest =>
  fixtureManifest(projectId, {
    verificationCommands: [CLEAN_TREE_COMMAND],
    verificationProfiles: { simple: ["clean-tree"], standard: ["clean-tree"], guarded: ["clean-tree"] },
    ...overrides,
  });

export const BOOTSTRAP_REQUEST_DIGEST = digestOf({ request: "bootstrap" });

/** A bootstrap PLAN as the bootstrap CTO submits it: the manifest in full beside its digest. */
export const bootstrapPlan = (
  manifest: ProjectManifest,
  options: { operations?: unknown[]; bootstrapOperationId?: string; requestDigest?: string; summary?: string } = {},
): Record<string, unknown> => ({
  summary: options.summary ?? "create the repository the owner asked for",
  bootstrapOperationId: options.bootstrapOperationId ?? "op-bootstrap",
  requestDigest: options.requestDigest ?? BOOTSTRAP_REQUEST_DIGEST,
  projectManifestDigest: manifestDigest(manifest),
  githubOperations: options.operations ?? bootstrapOperations(),
  projectManifest: manifest,
});

/**
 * One CTO MCP tool call as the run's owner, through a real MCP client and server pair so the tool's
 * input schema is applied exactly as it is for the bootstrap CTO.
 */
export const callCtoToolAsOwner = async (
  harness: Harness,
  runId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> => {
  const run = harness.cp.runs.require(runId);
  const session = harness.cp.sessions.require(run.ownerSessionId!);
  const server = createCtoServer(createCtoMcpPort(harness.cp), () =>
    allow(ReasonCode.OK, { actor: `cto:${session.sessionId}`, sessionId: session.sessionId, sessionIncarnation: session.incarnation }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "acp-246-bootstrap-plan", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return {
      isError: result.isError === true,
      text: content.map((part) => part.text ?? "").join("\n"),
      body: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  } finally {
    await client.close();
    await server.close();
  }
};

let planSequence = 0;

/** `plan_submit` as the run's bootstrap CTO, with one task; throws unless it is accepted. */
export const submitBootstrapPlan = async (harness: Harness, runId: string, plan: Record<string, unknown>): Promise<string> => {
  planSequence += 1;
  const submitted = await callCtoToolAsOwner(harness, runId, "plan_submit", {
    idempotencyKey: `bootstrap-plan-${runId}-${planSequence}`,
    runId,
    plan,
    tasks: [{ key: `bootstrap-${planSequence}`, title: `bootstrap the repository (${planSequence})`, category: "implementation" }],
  });
  if (submitted.isError || submitted.body["ok"] !== true) throw new Error(`plan_submit refused: ${submitted.text}`);
  const stored = harness.cp.artifacts.latest(runId, "PLAN");
  if (stored === null) throw new Error("plan_submit stored no PLAN artifact");
  return stored.digest;
};

/** Every READY task carried to SUCCEEDED by a worker session of its own, as the existing fixtures do. */
export const completeReadyTasks = (harness: Harness, runId: string): void => {
  const ownerBindingGeneration = harness.cp.runs.require(runId).ownerBindingGeneration;
  if (ownerBindingGeneration === null) throw new Error("the bootstrap run has no owner generation");
  for (const task of harness.cp.tasks.ready(runId)) {
    const started = harness.cp.tasks.startExecution({
      runId,
      taskId: task.taskId,
      ownerBindingGeneration,
      workerSessionId: bindWorker(harness, task.taskId),
      provider: "scripted",
      model: "scripted-worker",
    });
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    const finished = harness.cp.tasks.finishExecution(started.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: digestOf({ task: task.taskId }),
    });
    if (!finished.allowed) throw new Error(`${finished.reasonCode}: ${finished.message}`);
  }
};

/** The coverage keys a passing reviewer of the run's current PLAN must name. */
export const bootstrapCoverageKeys = (harness: Harness, runId: string): string[] => {
  const current = currentBootstrapPlan(runId, harness.cp.artifacts.latest(runId, "PLAN"));
  if (!current.allowed) throw new Error(`the run's PLAN has no planned outputs: ${current.reasonCode} ${current.message}`);
  return bootstrapPlanCoverageTargets(current.value.outputs).map(({ identity, path }) => `${identity}:${path}`);
};

export interface ReviewedBootstrapPlan {
  planDigest: string;
  snapshotDigest: string;
  ceoSessionId: string;
}

/**
 * The PLAN submitted by the run's bootstrap CTO, its task done, and `result_submit`'s pipeline run:
 * the candidate frozen with its PLAN binding and its BOOTSTRAP_PLAN review answered PASS by the
 * scripted reviewer, so the run is at CEO review.
 */
export const reviewBootstrapPlan = async (
  harness: Harness,
  runId: string,
  plan: Record<string, unknown>,
): Promise<ReviewedBootstrapPlan> => {
  const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
  const ceoSessionId = ceo?.sessionId ?? bindCeo(harness);
  const planDigest = await submitBootstrapPlan(harness, runId, plan);
  completeReadyTasks(harness, runId);
  harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(harness, runId)) });
  const run = harness.cp.runs.require(runId);
  const outcome = await harness.cp.pipeline.submitResult({
    runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "the planned bootstrap outputs",
    recommendation: "create the repository",
  });
  if (!outcome.allowed || outcome.value.stage !== "COMPLETED_REVIEW") {
    throw new Error(`the bootstrap plan was not reviewed to CEO review: ${JSON.stringify(outcome)}`);
  }
  return { planDigest, snapshotDigest: outcome.value.snapshotDigest, ceoSessionId };
};

/**
 * The CEO sends the reviewed candidate back (FINAL_REVISE), the run is dispatched again to its live
 * bootstrap CTO, and that CTO submits `plan`, which is reviewed to CEO review as a new candidate.
 */
export const replanBootstrap = async (
  harness: Harness,
  runId: string,
  reviewed: ReviewedBootstrapPlan,
  plan: Record<string, unknown>,
): Promise<ReviewedBootstrapPlan> => {
  await harness.cp.continuity.evaluate("bootstrap revision");
  const revised = harness.cp.ceo.submitCeoDecision({
    runId,
    decision: "FINAL_REVISE",
    candidateSnapshotDigest: reviewed.snapshotDigest,
    ceoSessionId: reviewed.ceoSessionId,
    rationale: "revise the bootstrap plan",
  });
  if (!revised.allowed) throw new Error(`FINAL_REVISE refused: ${revised.reasonCode}: ${revised.message}`);
  const redispatched = await harness.cp.runs.dispatch(runId);
  if (!redispatched.allowed) throw new Error(`re-dispatch refused: ${redispatched.reasonCode}: ${redispatched.message}`);
  return reviewBootstrapPlan(harness, runId, plan);
};

/** A REVISE answer from the scripted reviewer for the run's current PLAN. */
export const scriptBootstrapRevise = (harness: Harness, runId: string, summary: string): void => {
  harness.scripted.script({
    match: /Bootstrap plan review/,
    text: reviewerRevise(bootstrapCoverageKeys(harness, runId), summary),
  });
};
