import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../src/app/control-plane.ts";
import type { GitHubWritePort } from "../../src/bootstrap/github-write-port.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../../src/ceo/owner-authority.ts";
import { createOperatorClient, dispatch } from "../../src/cli/agentctl.ts";
import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { startOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github-write-port.ts";
import {
  TEST_MCP_TOKEN,
  TEST_OPERATOR_TOKEN,
  TEST_OWNER,
  bindCeo,
  bindWorker,
  fixtureManifest,
  makeHarness,
  makeStartedOperator,
  type Harness,
} from "../helpers/harness.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

/**
 * Issue #246 — the two links between the Repo Factory runner and a live control plane:
 *
 * 1. the owner's approval for `repo_factory_github_write` is minted only through the operator
 *    socket (the owner token), bound to owner, visibility, the PLAN artifact digest and its
 *    operations in full; and
 * 2. a PROJECT_BOOTSTRAP run's CEO CONFIRM runs the Repo Factory runner before the CEO decision,
 *    outside the decision's transaction, and returns the runner's refusal unchanged.
 *
 * GitHub is the bare-repository double; nothing here reaches GitHub or a live daemon. Every
 * refusal asserts no GitHub call and no consumption of an owner approval.
 */

afterAll(cleanupTempDirs);

const roots: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop();
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const CONTRACT = {
  goal: "bootstrap",
  why: "bootstrap",
  scope: [],
  nonGoals: [],
  acceptance: ["verify"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const IDENTITY = "github:acme/fixture";

const APPROVED_PROTECTION = {
  requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
  enforceAdmins: true,
  requiredApprovingReviewCount: 1,
  allowForcePushes: false,
  allowDeletions: false,
};

const operations = (protection: Record<string, unknown> = APPROVED_PROTECTION) => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository" as const,
    resourceIdentity: IDENTITY,
    desiredState: { visibility: "public" as const },
  },
  { operationId: "push-default-branch:fixture", resourceType: "branch" as const, resourceIdentity: `${IDENTITY}#main` },
  {
    operationId: "set-default-branch:fixture",
    resourceType: "setting" as const,
    resourceIdentity: `${IDENTITY}#default-branch`,
    desiredState: { defaultBranch: "main" },
  },
  {
    operationId: "protect-default-branch:fixture",
    resourceType: "branch-protection" as const,
    resourceIdentity: `${IDENTITY}#main`,
    desiredState: protection,
  },
];

const CLEAN_TREE_COMMAND = {
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

const cleanTreeManifest = (projectId: string): ProjectManifest =>
  fixtureManifest(projectId, {
    verificationCommands: [CLEAN_TREE_COMMAND],
    verificationProfiles: { simple: ["clean-tree"], standard: ["clean-tree"], guarded: ["clean-tree"] },
  });

/** The blind-reviewed candidate a bootstrap run reaches CEO review with. */
const recordBootstrapBlindReview = (harness: Harness, runId: string): string => {
  const run = harness.cp.runs.require(runId);
  const head = gitSync(harness.repoPath, ["rev-parse", "HEAD"]);
  const snapshot: CandidateSnapshot = {
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId,
    contractDigest: run.contractDigest,
    repositories: [{
      identity: IDENTITY,
      repositoryRole: "primary",
      baseBranch: "main",
      baseHead: head,
      candidateHead: head,
      treeDigest: `git-tree:${gitSync(harness.repoPath, ["rev-parse", "HEAD^{tree}"])}`,
      diffDigest: digestOf({ bootstrapCandidate: runId }),
      worktreeId: null,
      manifestDigest: null,
      touchedPaths: [],
    }],
    createdAt: harness.clock.nowIso(),
  };
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  harness.cp.artifacts.put(runId, "CANDIDATE_SNAPSHOT", snapshot, snapshotDigest);
  const reviewer = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap-reviewer" });
  harness.cp.sessions.transition(reviewer.sessionId, SessionLifecycle.READY, "test reviewer");
  const reviewerBinding = harness.cp.bindings.bind({
    role: Role.BLIND_REVIEWER,
    roleKey: roleKeyFor(Role.BLIND_REVIEWER, { runId }),
    runId,
    sessionId: reviewer.sessionId,
  });
  if (!reviewerBinding.allowed) throw new Error(reviewerBinding.message);
  harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().BLIND_REVIEW, runId, "BLIND_REVIEW", {
    runId,
    candidateSnapshotDigest: snapshotDigest,
    contractDigest: run.contractDigest,
    reviewerRoleBindingGeneration: reviewerBinding.value.bindingGeneration,
    reviewerSessionId: reviewer.sessionId,
    reviewerSessionIncarnation: reviewer.incarnation,
    reviewerProviderSessionId: reviewer.sessionId,
    provider: reviewer.provider,
    model: reviewer.model,
    effort: reviewer.effort,
    egressEvidence: testReviewerEgressEvidence(reviewer.provider),
    inputManifest: {
      contract: true,
      snapshotManifest: true,
      diff: true,
      verificationEvidence: true,
      projectContext: true,
      withheld: [],
      binaryArtifacts: [],
    },
    coveredRepositories: [IDENTITY],
    coveredFiles: [],
    omittedItems: [],
    verdict: "PASS",
    findings: [],
    chunked: false,
    createdAt: harness.clock.nowIso(),
  }, snapshotDigest);
  return snapshotDigest;
};

interface PreparedRun {
  runId: string;
  planDigest: string;
  snapshotDigest: string;
  manifest: ProjectManifest;
  bootstrapCtoSessionId: string;
}

/** Puts the PLAN on the run and returns its artifact digest. */
type PlanSubmitter = (
  harness: Harness,
  runId: string,
  manifest: ProjectManifest,
  cto: { sessionId: string; incarnation: string },
) => Promise<string>;

/** The PLAN written straight into the artifact store, as the runner's own tests do. */
const putPlanArtifact: PlanSubmitter = async (harness, runId, manifest) =>
  harness.cp.artifacts.put(runId, "PLAN", {
    bootstrapOperationId: "op-bootstrap",
    requestDigest: digestOf({ request: "bootstrap" }),
    projectManifestDigest: manifestDigest(manifest),
    githubOperations: operations(),
  }).digest;

/** A PROJECT_BOOTSTRAP run at CEO review, holding the PLAN `submitPlan` put on it. */
const prepareRun = async (
  harness: Harness,
  projectId: string,
  submitPlan: PlanSubmitter = putPlanArtifact,
): Promise<PreparedRun> => {
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const bootstrapCto = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap" });
  harness.cp.sessions.transition(bootstrapCto.sessionId, SessionLifecycle.READY, "test");
  const bound = harness.cp.bootstrap.bindBootstrapCto(runId, bootstrapCto.sessionId);
  if (!bound.allowed) throw new Error(bound.message);
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const manifest = cleanTreeManifest(projectId);
  const planDigest = await submitPlan(harness, runId, manifest, {
    sessionId: bootstrapCto.sessionId,
    incarnation: bootstrapCto.incarnation,
  });
  const snapshotDigest = recordBootstrapBlindReview(harness, runId);
  harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed");
  return { runId, planDigest, snapshotDigest, manifest, bootstrapCtoSessionId: bootstrapCto.sessionId };
};

interface Wired extends PreparedRun {
  harness: Harness;
  daemon: Daemon;
  github: FakeGitHub;
  ceoSessionId: string;
}

/** A lock-held daemon whose control plane composes the runner over a GitHub double. */
const wire = async (
  projectId: string,
  options: {
    /** `"default"` composes `defaultConfig(root).repoFactory` — the work root production gets. */
    workRoot?: "default" | string;
    submitPlan?: PlanSubmitter;
  } = {},
): Promise<Wired> => {
  const bareRoot = mkdtempSync(join(tmpdir(), "acp-246-wiring-"));
  roots.push(bareRoot);
  const github = new FakeGitHub(bareRoot);
  let harness: Harness;
  if (options.workRoot === "default") {
    const root = tempDir("acp-246-default-root-");
    harness = makeHarness({ root, repoFactory: defaultConfig(root).repoFactory });
    // `defaultConfig()` composes the production `gh` port beside its work root. This test needs
    // that work root and must not reach GitHub, so only the port is replaced after composition.
    const deps = (harness.cp.bootstrapProducer as unknown as { deps: { workRoot: string | null; githubPort: GitHubWritePort } }).deps;
    expect(deps.workRoot).toBe(join(root, "repo-factory"));
    deps.githubPort = github;
  } else {
    harness = makeHarness({ repoFactory: { workRoot: options.workRoot ?? bareRoot, githubPort: github } });
  }
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const ceoSessionId = bindCeo(harness);
  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-246-wiring-daemon-") });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  daemons.push(daemon);
  const prepared = await prepareRun(harness, projectId, options.submitPlan);
  return { ...prepared, harness, daemon, github, ceoSessionId };
};

const OWNER_PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: `cli:${TEST_OWNER.actor}`,
  actor: TEST_OWNER.actor,
  incarnation: "owner-incarnation",
};

let requestSequence = 0;

/** The owner's approval through the daemon's operator method — the only door that mints one. */
const approve = (
  wired: Pick<Wired, "daemon" | "runId" | "planDigest" | "manifest">,
  overrides: Record<string, unknown> = {},
  peer: AuthenticatedOperatorPeer = OWNER_PEER,
) => {
  requestSequence += 1;
  return wired.daemon.handleOperatorRequest({
    requestId: `rf-approve-${requestSequence}`,
    method: OPERATOR_METHOD.REPO_FACTORY_GITHUB_WRITE_APPROVE,
    params: {
      runId: wired.runId,
      owner: "acme",
      visibility: "public",
      planDigest: wired.planDigest,
      manifest: wired.manifest,
      projectName: "fixture project",
      ...overrides,
    },
    idempotencyKey: `rf-approve-${requestSequence}`,
  }, peer);
};

type ToolHandler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>;
const registeredTools = (server: object): Record<string, { handler: ToolHandler }> =>
  (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools;

const hermesServer = (harness: Harness) =>
  createHermesServer(createHermesMcpPort(harness.cp), () => allow(ReasonCode.OK, { actor: "hermes-daemon" }));

/** The CEO's decision through the registered Hermes MCP tool, as Hermes sends it. */
const ceoDecision = async (
  wired: Pick<Wired, "harness" | "runId" | "snapshotDigest" | "ceoSessionId">,
  key: string,
  overrides: { decision?: string; ceoSessionId?: string; candidateSnapshotDigest?: string } = {},
): Promise<Record<string, unknown>> => {
  await wired.harness.cp.continuity.evaluate("bootstrap confirmation");
  const result = await registeredTools(hermesServer(wired.harness))["ceo_decision_submit"]!.handler({
    idempotencyKey: key,
    runId: wired.runId,
    decision: overrides.decision ?? "CONFIRM",
    candidateSnapshotDigest: overrides.candidateSnapshotDigest ?? wired.snapshotDigest,
    ceoSessionId: overrides.ceoSessionId ?? wired.ceoSessionId,
    rationale: "issue #246 wiring",
  });
  return result.structuredContent ?? {};
};

const consumedApprovals = (wired: Pick<Wired, "harness" | "runId">): number =>
  wired.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED' AND run_id = ?`,
    [wired.runId],
  )?.n ?? 0;

const recordedApprovals = (wired: Pick<Wired, "harness" | "runId">) =>
  wired.harness.cp.artifacts
    .list<{ kind?: unknown }>(wired.runId, "APPROVAL")
    .filter((artifact) => artifact.content.kind === "REPO_FACTORY_GITHUB_WRITE");

/** A refusal is only "before GitHub" if the double counted nothing at all. */
const nothingWrittenOrConsumed = (wired: Wired): void => {
  expect(wired.github.writes).toEqual([]);
  expect(wired.github.reads).toEqual([]);
  expect(consumedApprovals(wired)).toBe(0);
  expect(wired.harness.cp.artifacts.latest(wired.runId, "REPO_FACTORY_RESULT")).toBeNull();
  expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
};

describe("#246 wiring: owner approval, then the CEO confirm runs Repo Factory", () => {
  it("owner approval → CEO confirm → GitHub writes (double) → activation → COMPLETED", async () => {
    const wired = await wire("wired-normal");
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
    expect(recordedApprovals(wired)).toHaveLength(1);
    // Minting is not consuming: nothing is consumed and nothing written until the CEO confirms.
    expect(consumedApprovals(wired)).toBe(0);
    expect(wired.github.writes).toEqual([]);

    const first = await ceoDecision(wired, "confirm-1");
    // A fresh bootstrap stops once, after the writes: the incoming CTO has not acknowledged.
    expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect((first["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toEqual([
      "createRepository",
      "pushBranch",
      "setDefaultBranch",
      "protectBranch",
    ]);
    expect(wired.github.repository("acme", "fixture")?.protections.get("main")).toEqual(APPROVED_PROTECTION);
    expect(consumedApprovals(wired)).toBe(1);
    expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    const primary = wired.harness.cp.bindings.activePrimaryCto("wired-normal");
    if (!primary) throw new Error("activation bound no primary CTO");
    const handoffId = (first["evidence"] as Record<string, unknown>)["pendingHandoffId"] as string;
    expect(wired.harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primary.sessionId).allowed).toBe(true);

    wired.github.writes.length = 0;
    const second = await ceoDecision(wired, "confirm-2");
    expect(second).toMatchObject({ ok: true, value: { state: RunState.COMPLETED } });
    expect(wired.github.writes).toEqual([]);
    expect(consumedApprovals(wired)).toBe(1);
    expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.COMPLETED);
    const activation = wired.harness.cp.artifacts.latest<{ ceoConfirm: unknown; localBindings: unknown[] }>(
      wired.runId,
      "BOOTSTRAP_ACTIVATION_RESULT",
    );
    expect(activation?.content.ceoConfirm).toMatchObject({ decision: "CONFIRM" });
    expect(activation?.content.localBindings).toEqual([expect.objectContaining({ identity: IDENTITY })]);
  });

  it("a CEO confirm with no owner approval is refused by the runner; no GitHub call, nothing consumed, not COMPLETED", async () => {
    const wired = await wire("wired-unapproved");
    const refused = await ceoDecision(wired, "confirm-unapproved");
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE });
    expect(refused["evidence"]).toMatchObject({ stage: "approval", refusal: "APPROVAL_MISSING" });
    nothingWrittenOrConsumed(wired);
  });

  it("the CEO cannot mint it: Hermes refuses an owner decision for this operation and has no tool that mints one", async () => {
    const wired = await wire("wired-ceo-mint");
    const tools = registeredTools(hermesServer(wired.harness));
    expect(Object.keys(tools).filter((name) => /repo.?factory|github.?write|approve/i.test(name))).toEqual([]);
    const minted = await tools["owner_decision_submit"]!.handler({
      idempotencyKey: "ceo-mints",
      runId: wired.runId,
      item: "repo_factory_github_write",
      approved: true,
      note: "",
    });
    expect(minted.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE });
    expect(recordedApprovals(wired)).toEqual([]);

    const refused = await ceoDecision(wired, "confirm-after-ceo-mint");
    expect(refused["evidence"]).toMatchObject({ stage: "approval", refusal: "APPROVAL_MISSING" });
    nothingWrittenOrConsumed(wired);
  });

  it("the CTO cannot mint it: an operator peer that is not an allowlisted owner is refused, and the CTO MCP has no such tool", async () => {
    const wired = await wire("wired-cto-mint");
    const ctoTools = registeredTools(
      createCtoServer(createCtoMcpPort(wired.harness.cp), () => allow(ReasonCode.OK, { actor: "cto" })),
    );
    expect(Object.keys(ctoTools).filter((name) => /repo.?factory|github.?write|approve/i.test(name))).toEqual([]);

    const ctoPeer: AuthenticatedOperatorPeer = {
      channel: "cli",
      peerId: `cli:${wired.bootstrapCtoSessionId}`,
      actor: wired.bootstrapCtoSessionId,
      incarnation: "cto-incarnation",
    };
    const minted = await approve(wired, {}, ctoPeer);
    expect(minted.allowed).toBe(false);
    expect(minted.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
    expect(recordedApprovals(wired)).toEqual([]);

    const refused = await ceoDecision(wired, "confirm-after-cto-mint");
    expect(refused["evidence"]).toMatchObject({ stage: "approval", refusal: "APPROVAL_MISSING" });
    nothingWrittenOrConsumed(wired);
  });

  it("an approval of one PLAN does not execute another: a PLAN replaced after approval is refused at the CEO confirm", async () => {
    const wired = await wire("wired-plan-replaced");
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
    wired.harness.cp.artifacts.put(wired.runId, "PLAN", {
      bootstrapOperationId: "op-bootstrap",
      requestDigest: digestOf({ request: "bootstrap" }),
      projectManifestDigest: manifestDigest(wired.manifest),
      githubOperations: operations({ ...APPROVED_PROTECTION, allowForcePushes: true, allowDeletions: true }),
    });

    const refused = await ceoDecision(wired, "confirm-replaced-plan");
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE });
    expect(refused["evidence"]).toMatchObject({ stage: "approval", refusal: "APPROVAL_MISMATCH" });
    nothingWrittenOrConsumed(wired);
  });

  it("the owner cannot approve a PLAN the run does not hold: the named digest must be the current PLAN, checked before ingress", async () => {
    const wired = await wire("wired-plan-named");
    const admittedBefore = wired.harness.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'INGRESS_ADMITTED'`,
    )?.n;
    const refused = await approve(wired, { planDigest: digestOf({ another: "plan" }) });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    expect(refused.evidence["refusal"]).toBe("PLAN_NOT_CURRENT");
    expect(recordedApprovals(wired)).toEqual([]);
    expect(
      wired.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'INGRESS_ADMITTED'`)?.n,
    ).toBe(admittedBefore);

    // A manifest other than the one the PLAN names is refused the same way, before ingress.
    const otherManifest = await approve(wired, { manifest: cleanTreeManifest("someone-else") });
    expect(otherManifest.allowed).toBe(false);
    expect(otherManifest.evidence["refusal"]).toBe("MANIFEST_MISMATCH");
    expect(recordedApprovals(wired)).toEqual([]);
    nothingWrittenOrConsumed(wired);
  });

  it("a CONFIRM naming a session that does not hold the CEO role writes nothing, even with an owner approval on record", async () => {
    const wired = await wire("wired-not-ceo");
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
    const refused = await ceoDecision(wired, "confirm-not-ceo", { ceoSessionId: wired.bootstrapCtoSessionId });
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED });
    nothingWrittenOrConsumed(wired);
  });

  it("non-PROJECT_BOOTSTRAP runs, and bootstrap decisions other than CONFIRM, never reach the runner", async () => {
    const wired = await wire("wired-unaffected");
    const runner = vi.spyOn(wired.harness.cp.bootstrapProducer, "produceAndActivate");
    const standard = wired.harness.cp.runs.create({
      kind: RunKind.STANDARD_WORK,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
    });
    if (!standard.allowed) throw new Error(standard.message);
    const direct = wired.harness.cp.ceo.submitCeoDecision({
      runId: standard.value.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: wired.snapshotDigest,
      ceoSessionId: wired.ceoSessionId,
      rationale: "issue #246 wiring",
    });
    const viaHermes = await ceoDecision({ ...wired, runId: standard.value.runId }, "confirm-standard");
    expect(direct.allowed).toBe(false);
    expect(viaHermes).toMatchObject({ ok: false, reasonCode: direct.reasonCode });

    const revised = await ceoDecision(wired, "revise-bootstrap", { decision: "FINAL_REVISE" });
    expect(revised).toMatchObject({ ok: true, value: { state: RunState.REVISION_REQUIRED } });
    expect(runner).not.toHaveBeenCalled();
    expect(wired.github.writes).toEqual([]);
    expect(wired.github.reads).toEqual([]);
    expect(consumedApprovals(wired)).toBe(0);
  });
});

/**
 * A CTO MCP tool call through a real MCP client and server pair, so the tool's input schema is
 * applied exactly as it is for the bootstrap CTO — the registered handler alone would skip it.
 */
const callCtoTool = async (
  harness: Harness,
  cto: { sessionId: string; incarnation: string },
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> => {
  const server = createCtoServer(createCtoMcpPort(harness.cp), () =>
    allow(ReasonCode.OK, { actor: `cto:${cto.sessionId}`, sessionId: cto.sessionId, sessionIncarnation: cto.incarnation }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "acp-246-cto", version: "1" });
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

/** Every task the PLAN submitted, driven to SUCCEEDED by its own worker, as a CTO would. */
const completeTasks = (harness: Harness, runId: string): void => {
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

/** The PLAN through the bootstrap CTO's `plan_submit`, then its task carried to SUCCEEDED. */
const submitPlanOverCto = (githubOperations: unknown[]): PlanSubmitter => async (harness, runId, manifest, cto) => {
  const submitted = await callCtoTool(harness, cto, "plan_submit", {
    idempotencyKey: `plan-${runId}`,
    runId,
    plan: {
      summary: "create the repository the owner approved",
      bootstrapOperationId: "op-bootstrap",
      requestDigest: digestOf({ request: "bootstrap" }),
      projectManifestDigest: manifestDigest(manifest),
      githubOperations,
    },
    tasks: [{ key: "bootstrap", title: "bootstrap the repository", category: "implementation" }],
  });
  if (submitted.isError) throw new Error(`plan_submit refused: ${submitted.text}`);
  completeTasks(harness, runId);
  const plan = harness.cp.artifacts.latest(runId, "PLAN");
  if (plan === null) throw new Error("plan_submit stored no PLAN artifact");
  return plan.digest;
};

/** Identities only — the shape `plan_submit` accepted before desired state. */
const identitiesOnly = (ops: ReturnType<typeof operations>) =>
  ops.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity }));

/** Owner approval → first CONFIRM (writes) → handoff ack → second CONFIRM (COMPLETED). */
const approveAndConfirm = async (wired: Wired, projectId: string): Promise<void> => {
  const approved = await approve(wired);
  if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
  const first = await ceoDecision(wired, `${projectId}-confirm-1`);
  expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
  expect(wired.github.writes.map((write) => write.method)).toEqual([
    "createRepository",
    "pushBranch",
    "setDefaultBranch",
    "protectBranch",
  ]);
  const primary = wired.harness.cp.bindings.activePrimaryCto(projectId);
  if (!primary) throw new Error("activation bound no primary CTO");
  const handoffId = (first["evidence"] as Record<string, unknown>)["pendingHandoffId"] as string;
  expect(wired.harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primary.sessionId).allowed).toBe(true);
  const second = await ceoDecision(wired, `${projectId}-confirm-2`);
  expect(second).toMatchObject({ ok: true, value: { state: RunState.COMPLETED } });
  expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.COMPLETED);
};

describe("#246 production defaults: the work root and an executable plan_submit", () => {
  it("with no work root configured, the default under the state root is created 0700 and the run completes there", async () => {
    const wired = await wire("default-work-root", { workRoot: "default" });
    const workRoot = (wired.harness.cp.bootstrapProducer as unknown as { deps: { workRoot: string } }).deps.workRoot;
    expect(existsSync(workRoot)).toBe(false);

    await approveAndConfirm(wired, "default-work-root");
    expect(statSync(workRoot).mode & 0o777).toBe(0o700);
    expect(existsSync(join(workRoot, wired.runId))).toBe(true);
    const binding = wired.harness.cp.repositories.byIdentity(IDENTITY);
    // The registry keeps the canonical path; the temp root sits behind macOS's /var alias.
    expect(binding?.checkoutPath.startsWith(realpathSync(join(workRoot, wired.runId)))).toBe(true);
  });

  it("refuses a work root reached through a symlink, or not exactly 0700, before the approval is consumed or GitHub is called", async () => {
    const real = mkdtempSync(join(tmpdir(), "acp-246-real-root-"));
    roots.push(real);
    const linkParent = mkdtempSync(join(tmpdir(), "acp-246-link-parent-"));
    roots.push(linkParent);
    const linked = join(linkParent, "work-root");
    symlinkSync(real, linked);
    const permissive = join(mkdtempSync(join(tmpdir(), "acp-246-permissive-")), "work-root");
    roots.push(join(permissive, ".."));
    mkdirSync(permissive, { mode: 0o755 });
    chmodSync(permissive, 0o755);

    for (const [projectId, workRoot] of [["work-root-symlink", linked], ["work-root-permissive", permissive]] as const) {
      const wired = await wire(projectId, { workRoot });
      const approved = await approve(wired);
      if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
      const refused = await ceoDecision(wired, `${projectId}-confirm`);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.STATE_PATH_INSECURE });
      expect(refused["evidence"]).toMatchObject({ stage: "precondition", refusal: "WORK_ROOT_INSECURE" });
      nothingWrittenOrConsumed(wired);
    }
    // Refused, not repaired: the permissive root keeps the mode it had.
    expect(statSync(permissive).mode & 0o777).toBe(0o755);
    // A directory owned by another account cannot be made here without root; that refusal is
    // the same `ensurePrivateDirectory` owner check, and this test does not exercise it.
  });

  it("plan_submit with desired state → owner approval → CEO confirm → GitHub writes (double) → activation → COMPLETED", async () => {
    const wired = await wire("cto-plan", { submitPlan: submitPlanOverCto(operations()) });
    const plan = wired.harness.cp.artifacts.latest<{ githubOperations: unknown[] }>(wired.runId, "PLAN");
    expect(plan?.content.githubOperations).toEqual(operations());

    await approveAndConfirm(wired, "cto-plan");
    // The protection GitHub holds is the one the CTO's PLAN carried and the owner approved.
    expect(wired.github.repository("acme", "fixture")?.protections.get("main")).toEqual(APPROVED_PROTECTION);
    expect(consumedApprovals(wired)).toBe(1);
  });

  it("a PLAN without desired state is still accepted by plan_submit and refused as PLAN_NOT_EXECUTABLE; malformed desired state is refused by the same schema", async () => {
    const executable = operations();
    // Mixed: some operations carry their state, the repository's does not.
    const mixed = [identitiesOnly(executable)[0], ...executable.slice(1)];
    for (const [projectId, githubOperations] of [
      ["plan-identities-only", identitiesOnly(executable)],
      ["plan-mixed", mixed],
    ] as const) {
      const wired = await wire(projectId, { submitPlan: submitPlanOverCto([...githubOperations]) });
      const refused = await approve(wired);
      expect(refused.allowed).toBe(false);
      expect(refused.evidence["refusal"]).toBe("PLAN_NOT_EXECUTABLE");
      expect(recordedApprovals(wired)).toEqual([]);
      const confirm = await ceoDecision(wired, `${projectId}-confirm`);
      expect(confirm["evidence"]).toMatchObject({ stage: "approval", refusal: "APPROVAL_MISSING" });
      nothingWrittenOrConsumed(wired);
    }

    // A desired state the runner would refuse never reaches the PLAN: `githubOperationSchema`
    // rejects it at plan_submit.
    const malformed = await wire("plan-malformed");
    const before = malformed.harness.cp.artifacts.list(malformed.runId, "PLAN").length;
    const cto = malformed.harness.cp.runs.require(malformed.runId);
    const session = malformed.harness.cp.sessions.get(cto.ownerSessionId!);
    const rejected = await callCtoTool(
      malformed.harness,
      { sessionId: session!.sessionId, incarnation: session!.incarnation },
      "plan_submit",
      {
        idempotencyKey: "plan-malformed",
        runId: malformed.runId,
        plan: {
          summary: "internal visibility",
          githubOperations: [{ ...executable[0], desiredState: { visibility: "internal" } }],
        },
        tasks: [{ key: "bootstrap", title: "bootstrap", category: "implementation" }],
      },
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("Input validation error");
    expect(malformed.harness.cp.artifacts.list(malformed.runId, "PLAN")).toHaveLength(before);
  });
});

/**
 * PR #1050 review witnesses. Each fails against 08e05ade, the reviewed head, and is kept as that
 * finding's regression guard.
 */
describe("PR #1050 review witnesses", () => {
  const unreviewed = digestOf({ candidate: "never reviewed" });

  it("RF1050-01: a CONFIRM naming a candidate with no passing review consumes nothing and writes nothing (unpromoted run)", async () => {
    const wired = await wire("rf1050-01-unpromoted");
    expect(wired.harness.cp.runs.currentCandidate(wired.runId)).toBeNull();
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);

    const refused = await ceoDecision(wired, "rf1050-01-unreviewed", { candidateSnapshotDigest: unreviewed });
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect(refused["evidence"]).toMatchObject({ stage: "precondition", candidateSnapshotDigest: unreviewed });
    nothingWrittenOrConsumed(wired);

    // The reviewed candidate is still confirmed: the first CONFIRM writes and waits on the handoff.
    const reviewed = await ceoDecision(wired, "rf1050-01-reviewed");
    expect(reviewed).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect((reviewed["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
    expect(consumedApprovals(wired)).toBe(1);
  });

  it("RF1050-01: the same holds once the reviewed candidate is promoted", async () => {
    const wired = await wire("rf1050-01-promoted");
    wired.harness.cp.runs.promoteCandidate(wired.runId, wired.snapshotDigest);
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);

    const refused = await ceoDecision(wired, "rf1050-01p-unreviewed", { candidateSnapshotDigest: unreviewed });
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    nothingWrittenOrConsumed(wired);

    const reviewed = await ceoDecision(wired, "rf1050-01p-reviewed");
    expect((reviewed["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
  });

  /**
   * A second candidate beside the prepared one: its own snapshot, and a passing review by the
   * same independent reviewer, so the review check admits a CONFIRM naming either of them.
   */
  const recordSecondReviewedCandidate = (wired: Wired): string => {
    const { harness, runId } = wired;
    const snapshot = harness.cp.artifacts.latestForSnapshot<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT", wired.snapshotDigest);
    const review = harness.cp.artifacts.latestForSnapshot<Record<string, unknown>>(runId, "BLIND_REVIEW", wired.snapshotDigest);
    if (!snapshot || !review) throw new Error("the prepared candidate has no snapshot or no review");
    const second: CandidateSnapshot = {
      ...snapshot.content,
      repositories: snapshot.content.repositories.map((repository) => ({
        ...repository,
        diffDigest: digestOf({ bootstrapCandidate: runId, second: true }),
      })),
    };
    const digest = candidateSnapshotDigest(second);
    harness.cp.artifacts.put(runId, "CANDIDATE_SNAPSHOT", second, digest);
    harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().BLIND_REVIEW, runId, "BLIND_REVIEW", {
      ...review.content,
      candidateSnapshotDigest: digest,
    }, digest);
    return digest;
  };

  const newestReceipt = (wired: Wired): OwnerApprovalReceipt => {
    const receipt = (recordedApprovals(wired).at(-1)?.content as { receipt?: OwnerApprovalReceipt } | undefined)?.receipt;
    if (!receipt) throw new Error("no owner receipt is recorded on the run");
    return receipt;
  };

  it("RF1050-03: a receipt naming one candidate is not consumed for another reviewed candidate, and still serves its own", async () => {
    const wired = await wire("rf1050-03-other-candidate");
    wired.harness.cp.runs.promoteCandidate(wired.runId, wired.snapshotDigest);
    // Recorded after the promotion, which supersedes reviews of every other candidate.
    const other = recordSecondReviewedCandidate(wired);
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
    expect(newestReceipt(wired).candidateSnapshotDigest).toBe(wired.snapshotDigest);
    // Both candidates pass the review check, so only the owner admission can tell them apart.
    expect(wired.harness.cp.bootstrap.reviewForConfirmation(wired.runId, other).allowed).toBe(true);

    const refused = await ceoDecision(wired, "rf1050-03-other", { candidateSnapshotDigest: other });
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.EVIDENCE_STALE });
    expect(refused["evidence"]).toMatchObject({
      stage: "approval",
      approvedCandidateSnapshotDigest: wired.snapshotDigest,
      presentedCandidateSnapshotDigest: other,
    });
    nothingWrittenOrConsumed(wired);

    // The receipt was not spent on the other candidate: the CONFIRM naming its own candidate writes.
    const own = await ceoDecision(wired, "rf1050-03-own");
    expect(own).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect((own["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
    expect(consumedApprovals(wired)).toBe(1);
  });

  it("RF1050-04: a receipt an earlier head consumed with no candidate is refused by name, and a new owner decision resumes from the ledger", async () => {
    const wired = await wire("rf1050-04-legacy");
    expect(wired.harness.cp.runs.currentCandidate(wired.runId)).toBeNull();
    const approved = await approve(wired);
    if (!approved.allowed) throw new Error(`${approved.reasonCode}: ${approved.message}`);
    const legacy = newestReceipt(wired);

    // The heads before RF1050-01 consumed the approval for the run's candidate pointer, which an
    // unpromoted bootstrap leaves null. That admission is replayed here around the real owner
    // authority, and production fails after the repository is created, as the reviewer's did.
    const deps = (wired.harness.cp.bootstrapProducer as unknown as {
      deps: { ownerAuthority: Pick<OwnerAuthorityPort, "assertConsumedApproval" | "consumeApproval"> };
    }).deps;
    const upgraded = deps.ownerAuthority;
    const pointer = () => wired.harness.cp.runs.currentCandidate(wired.runId);
    deps.ownerAuthority = {
      assertConsumedApproval: (receipt) => upgraded.assertConsumedApproval(receipt, pointer()),
      consumeApproval: (receipt) => upgraded.consumeApproval(receipt, pointer()),
    };
    wired.github.failNext = "pushBranch";
    const failed = await ceoDecision(wired, "rf1050-04-earlier-head");
    expect((failed["evidence"] as Record<string, unknown>)["stage"]).toBe("production");
    expect(wired.github.writes.map((write) => write.method)).toEqual(["createRepository", "pushBranch"]);
    expect(consumedApprovals(wired)).toBe(1);
    deps.ownerAuthority = upgraded;

    // After the upgrade that consumption authorises no candidate, and the refusal names its remedy.
    wired.github.writes.length = 0;
    const refused = await ceoDecision(wired, "rf1050-04-upgraded");
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.EVIDENCE_STALE });
    expect(refused["evidence"]).toMatchObject({
      stage: "approval",
      approvedCandidateSnapshotDigest: null,
      presentedCandidateSnapshotDigest: wired.snapshotDigest,
      remedy: "NEW_OWNER_DECISION",
    });
    expect(wired.github.writes).toEqual([]);
    expect(consumedApprovals(wired)).toBe(1);

    // The recovery: a new owner decision is consumed for the confirmed candidate, and production
    // resumes from the GitHub ledger without creating the repository again.
    const reapproved = await approve(wired);
    if (!reapproved.allowed) throw new Error(`${reapproved.reasonCode}: ${reapproved.message}`);
    const resumed = await ceoDecision(wired, "rf1050-04-new-decision");
    expect(resumed).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect((resumed["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toEqual(["pushBranch", "setDefaultBranch", "protectBranch"]);
    expect(consumedApprovals(wired)).toBe(2);
    expect(wired.harness.cp.ownerAuthority.assertConsumedApproval(newestReceipt(wired), wired.snapshotDigest).allowed).toBe(true);
    // The earlier head's receipt still authorises nothing, the confirmed candidate included.
    expect(wired.harness.cp.ownerAuthority.assertConsumedApproval(legacy, wired.snapshotDigest)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.EVIDENCE_STALE,
    });
  });

  /** The owner's CLI on the wired daemon's own operator socket, with the owner token. */
  const ownerCli = async (wired: Wired) => {
    const listener = await startOperatorSocket(
      wired.daemon,
      tempDir("acp-246-owner-sock-"),
      { token: TEST_OPERATOR_TOKEN, peerId: `cli:${TEST_OWNER.actor}`, actor: TEST_OWNER.actor },
      { mcpToken: TEST_MCP_TOKEN },
    );
    const manifestPath = join(tempDir("acp-246-owner-manifest-"), "project.json");
    writeFileSync(manifestPath, JSON.stringify(wired.manifest));
    const client = createOperatorClient({ socketPath: listener.socketPath, token: TEST_OPERATOR_TOKEN });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return {
      run: (...extra: string[]) =>
        dispatch(client, "approve", [
          "repo-factory-github-write",
          wired.runId,
          "--github-owner",
          "acme",
          "--visibility",
          "public",
          "--plan-digest",
          wired.planDigest,
          "--manifest",
          manifestPath,
          "--project-name",
          "fixture project",
          ...extra,
        ], false),
      close: async () => {
        stdout.mockRestore();
        stderr.mockRestore();
        await listener.close();
      },
    };
  };

  const newestDecision = (wired: Wired): unknown => {
    const records = recordedApprovals(wired);
    return (records.at(-1)?.content as { receipt?: { approved?: unknown } } | undefined)?.receipt?.approved;
  };

  it("RF1050-02: approve → decline → approve with the CLI's own keys leaves the approval newest, and the runner proceeds", async () => {
    const wired = await wire("rf1050-02-reapprove");
    const cli = await ownerCli(wired);
    try {
      expect(await cli.run()).toBe(0);
      const declined = await approve(wired, { approved: false });
      if (!declined.allowed) throw new Error(`${declined.reasonCode}: ${declined.message}`);
      expect(newestDecision(wired)).toBe(false);
      expect(await cli.run()).toBe(0);
    } finally {
      await cli.close();
    }
    expect(recordedApprovals(wired)).toHaveLength(3);
    expect(newestDecision(wired)).toBe(true);

    const first = await ceoDecision(wired, "rf1050-02-confirm");
    expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect((first["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
  });

  it("RF1050-02: --decision-key retries one decision idempotently, and --decline records a refusal", async () => {
    const wired = await wire("rf1050-02-retry");
    const cli = await ownerCli(wired);
    try {
      expect(await cli.run("--decision-key", "owner-decision-1")).toBe(0);
      expect(await cli.run("--decision-key", "owner-decision-1")).toBe(0);
      expect(recordedApprovals(wired)).toHaveLength(1);
      expect(await cli.run("--decline")).toBe(0);
    } finally {
      await cli.close();
    }
    expect(recordedApprovals(wired)).toHaveLength(2);
    expect(newestDecision(wired)).toBe(false);
    const refused = await ceoDecision(wired, "rf1050-02-declined");
    expect(refused["evidence"]).toMatchObject({ stage: "approval", refusal: "APPROVAL_DECLINED" });
    nothingWrittenOrConsumed(wired);
  });
});

describe("#246 wiring: agentctl approve repo-factory-github-write", () => {
  const argv = (prepared: PreparedRun, manifestPath: string): string[] => [
    "repo-factory-github-write",
    prepared.runId,
    "--github-owner",
    "acme",
    "--visibility",
    "public",
    "--plan-digest",
    prepared.planDigest,
    "--manifest",
    manifestPath,
    "--project-name",
    "fixture project",
  ];

  it("sends the owner's approval over the operator socket with the owner token, and is refused without it", async () => {
    const running = await makeStartedOperator();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const prepared = await prepareRun(running.harness, "cli-approval");
      const manifestPath = join(tempDir("acp-246-cli-manifest-"), "project.json");
      writeFileSync(manifestPath, JSON.stringify(prepared.manifest));
      const records = () =>
        running.harness.cp.artifacts
          .list<{ kind?: unknown; owner?: unknown; visibility?: unknown; planDigest?: unknown }>(prepared.runId, "APPROVAL")
          .filter((artifact) => artifact.content.kind === "REPO_FACTORY_GITHUB_WRITE");

      const withoutToken = createOperatorClient({ socketPath: running.socketPath, token: "not-the-operator-token" });
      expect(await dispatch(withoutToken, "approve", argv(prepared, manifestPath), false)).toBe(1);
      expect(records()).toEqual([]);

      const owner = createOperatorClient({ socketPath: running.socketPath, token: TEST_OPERATOR_TOKEN });
      expect(await dispatch(owner, "approve", argv(prepared, manifestPath), false)).toBe(0);
      expect(records().map((record) => record.content)).toEqual([
        expect.objectContaining({ owner: "acme", visibility: "public", planDigest: prepared.planDigest }),
      ]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      await running.close();
    }
  });
});
