import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createOperatorClient, dispatch } from "../../src/cli/agentctl.ts";
import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
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
  TEST_OPERATOR_TOKEN,
  TEST_OWNER,
  bindCeo,
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

/** A PROJECT_BOOTSTRAP run at CEO review, holding an executable PLAN artifact. */
const prepareRun = async (harness: Harness, projectId: string): Promise<PreparedRun> => {
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
  const snapshotDigest = recordBootstrapBlindReview(harness, runId);
  harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed");
  const manifest = cleanTreeManifest(projectId);
  const plan = harness.cp.artifacts.put(runId, "PLAN", {
    bootstrapOperationId: "op-bootstrap",
    requestDigest: digestOf({ request: "bootstrap" }),
    projectManifestDigest: manifestDigest(manifest),
    githubOperations: operations(),
  });
  return { runId, planDigest: plan.digest, snapshotDigest, manifest, bootstrapCtoSessionId: bootstrapCto.sessionId };
};

interface Wired extends PreparedRun {
  harness: Harness;
  daemon: Daemon;
  github: FakeGitHub;
  ceoSessionId: string;
}

/** A lock-held daemon whose control plane composes the runner over a GitHub double. */
const wire = async (projectId: string): Promise<Wired> => {
  const workRoot = mkdtempSync(join(tmpdir(), "acp-246-wiring-"));
  roots.push(workRoot);
  const github = new FakeGitHub(workRoot);
  const harness = makeHarness({ repoFactory: { workRoot, githubPort: github } });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const ceoSessionId = bindCeo(harness);
  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-246-wiring-daemon-") });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  daemons.push(daemon);
  const prepared = await prepareRun(harness, projectId);
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
  overrides: { decision?: string; ceoSessionId?: string } = {},
): Promise<Record<string, unknown>> => {
  await wired.harness.cp.continuity.evaluate("bootstrap confirmation");
  const result = await registeredTools(hermesServer(wired.harness))["ceo_decision_submit"]!.handler({
    idempotencyKey: key,
    runId: wired.runId,
    decision: overrides.decision ?? "CONFIRM",
    candidateSnapshotDigest: wired.snapshotDigest,
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
