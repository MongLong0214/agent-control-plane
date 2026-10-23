import { acknowledgeBootstrapHandoff } from "../helpers/bootstrap-handoff-ack.ts";

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../src/app/control-plane.ts";
import type { GitHubWritePort } from "../../src/bootstrap/github-write-port.ts";
import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github-write-port.ts";
import { TEST_MCP_TOKEN, bindCeo, dispatchBootstrapRun, fixtureManifest, makeHarness, type Harness } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { bootstrapPlan, callCtoToolAsOwner, reviewBootstrapPlan, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";

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
 *
 * #246 PR-C slice C1: the bootstrap run's owner is the BOOTSTRAP_CTO its dispatch staffs (no
 * `bindBootstrapCto`). Slice C3 reopens the bootstrap CONFIRM through the runner's full path, so
 * every CONFIRM below goes through the CEO's Hermes door.
 *
 * #246 PR-C slice C2: the run reaches CEO review as production gets there — the bootstrap CTO's
 * `plan_submit` carries the manifest, and `result_submit`'s BOOTSTRAP_PLAN review passes the
 * planned outputs — rather than through a hand-written review and a state transition.
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

interface PreparedRun {
  runId: string;
  planDigest: string;
  snapshotDigest: string;
  manifest: ProjectManifest;
  bootstrapCtoSessionId: string;
}

/**
 * A PROJECT_BOOTSTRAP run at CEO review (#246 C2): dispatch staffs its BOOTSTRAP_CTO, which submits
 * the PLAN with its manifest through `plan_submit`; the PLAN's task is done, and `result_submit`'s
 * BOOTSTRAP_PLAN review passes the planned outputs. With `review: false` the run stops after the
 * PLAN, still ACTIVE: a PLAN the producer could not execute has no outputs to review.
 */
const prepareRun = async (
  harness: Harness,
  projectId: string,
  options: { operations?: unknown[]; review?: boolean } = {},
): Promise<PreparedRun> => {
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  // Dispatch staffs the run's BOOTSTRAP_CTO and pins it as the owner (#246 C1), in place of the
  // deleted test-only `bindBootstrapCto`.
  const dispatched = await dispatchBootstrapRun(harness.cp, harness.clock, runId);
  const bootstrapCtoSessionId = dispatched.ownerSessionId!;
  const manifest = cleanTreeManifest(projectId);
  const plan = bootstrapPlan(manifest, { operations: options.operations ?? operations() });
  if (options.review === false) {
    // Planned and never reviewed: its task stays READY, as a project-less bootstrap's does until CONFIRM.
    const planDigest = await submitBootstrapPlan(harness, runId, plan);
    return { runId, planDigest, snapshotDigest: "", manifest, bootstrapCtoSessionId };
  }
  const reviewed = await reviewBootstrapPlan(harness, runId, plan);
  return { runId, planDigest: reviewed.planDigest, snapshotDigest: reviewed.snapshotDigest, manifest, bootstrapCtoSessionId };
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
    operations?: unknown[];
    review?: boolean;
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
  const prepared = await prepareRun(harness, projectId, {
    ...(options.operations === undefined ? {} : { operations: options.operations }),
    ...(options.review === undefined ? {} : { review: options.review }),
  });
  return { ...prepared, harness, daemon, github, ceoSessionId };
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

/**
 * #246 PR-C slice C3 — the CEO's CONFIRM through the Hermes door, which runs the Repo Factory
 * runner's full path (pre-write checks, reservation, attempt record, producer, WRITTEN, activation)
 * before the decision, and completes the run on the WRITTEN application.
 */
const confirm = (
  wired: Wired,
  key: string,
  overrides: { ceoSessionId?: string; candidateSnapshotDigest?: string } = {},
): Promise<Record<string, unknown>> => ceoDecision(wired, key, overrides);

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
    expect(recordedApprovals(wired)).toHaveLength(0);
    // Minting is not consuming: nothing is consumed and nothing written until the CEO confirms.
    expect(consumedApprovals(wired)).toBe(0);
    expect(wired.github.writes).toEqual([]);

    const first = await confirm(wired, "confirm-1");
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
    expect(consumedApprovals(wired)).toBe(0);
    expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    const primary = wired.harness.cp.bindings.activePrimaryCto("wired-normal");
    if (!primary) throw new Error("activation bound no primary CTO");
    const handoffId = (first["evidence"] as Record<string, unknown>)["pendingHandoffId"] as string;
    expect((await acknowledgeBootstrapHandoff(wired.harness, handoffId, primary.sessionId)).allowed).toBe(true);

    wired.github.writes.length = 0;
    const second = await confirm(wired, "confirm-2");
    expect(second).toMatchObject({ ok: true, value: { state: RunState.COMPLETED } });
    expect(wired.github.writes).toEqual([]);
    expect(consumedApprovals(wired)).toBe(0);
    expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.COMPLETED);
    const activation = wired.harness.cp.artifacts.latest<{ ceoConfirm: unknown; localBindings: unknown[] }>(
      wired.runId,
      "BOOTSTRAP_ACTIVATION_RESULT",
    );
    expect(activation?.content.ceoConfirm).toMatchObject({ decision: "CONFIRM" });
    expect(activation?.content.localBindings).toEqual([expect.objectContaining({ identity: IDENTITY })]);

    // RF-S17 arm:activation: on this real runner path, no RepoFactoryResult stored for the run (the
    // runner's and activation's retained copy) states a CTO or Doctor fact, and the
    // BOOTSTRAP_ACTIVATION_RESULT the CONFIRM wrote supplies both, from the PRIMARY_CTO binding that
    // acknowledged the handoff and from activation's own doctor report.
    const stored = wired.harness.cp.artifacts.list<Record<string, unknown>>(wired.runId, "REPO_FACTORY_RESULT");
    expect(stored.length).toBeGreaterThan(0);
    for (const result of stored) {
      expect(parseRepoFactoryResult(result.content).allowed).toBe(true);
      expect(Object.keys(result.content).filter((key) => /cto|doctor/i.test(key))).toEqual([]);
    }
    const doctorReport = wired.harness.cp.artifacts.latest<{ source: string; report: { status: string; findings: unknown[] } }>(
      wired.runId,
      "DOCTOR_REPORT",
    );
    if (!doctorReport) throw new Error("activation stored no DOCTOR_REPORT");
    expect(doctorReport.content.source).toBe("bootstrap-activation");
    expect(activation?.content).toMatchObject({
      schema: "agent-control-plane.bootstrap-activation.v1",
      primaryCtoBinding: {
        roleKey: primary.roleKey,
        sessionId: primary.sessionId,
        bindingGeneration: primary.bindingGeneration,
        promotedFromBootstrap: false,
      },
      handoffAck: { handoffId },
      doctor: { status: doctorReport.content.report.status, findings: doctorReport.content.report.findings.length },
    });
  });

  it("a CONFIRM naming a session that does not hold the CEO role writes nothing, even with an owner approval on record", async () => {
    const wired = await wire("wired-not-ceo");
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

/** Identities only — the shape `plan_submit` accepted before desired state. */
const identitiesOnly = (ops: ReturnType<typeof operations>) =>
  ops.map(({ operationId, resourceType, resourceIdentity }) => ({ operationId, resourceType, resourceIdentity }));

/** Owner approval → first CONFIRM (writes) → handoff ack → second CONFIRM (COMPLETED). */
const approveAndConfirm = async (wired: Wired, projectId: string): Promise<void> => {
  const first = await confirm(wired, `${projectId}-confirm-1`);
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
  expect((await acknowledgeBootstrapHandoff(wired.harness, handoffId, primary.sessionId)).allowed).toBe(true);
  const second = await confirm(wired, `${projectId}-confirm-2`);
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
      const refused = await confirm(wired, `${projectId}-confirm`);
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
    const wired = await wire("cto-plan");
    const plan = wired.harness.cp.artifacts.latest<{ githubOperations: unknown[] }>(wired.runId, "PLAN");
    expect(plan?.content.githubOperations).toEqual(operations());

    await approveAndConfirm(wired, "cto-plan");
    // The protection GitHub holds is the one the CTO's PLAN carried and the owner approved.
    expect(wired.github.repository("acme", "fixture")?.protections.get("main")).toEqual(APPROVED_PROTECTION);
    expect(consumedApprovals(wired)).toBe(0);
  });

  it("a PLAN without desired state is still accepted by plan_submit and refused as PLAN_NOT_EXECUTABLE; malformed desired state is refused by the same schema", async () => {
    const executable = operations();
    // Mixed: some operations carry their state, the repository's does not.
    const mixed = [identitiesOnly(executable)[0], ...executable.slice(1)];
    for (const [projectId, githubOperations] of [
      ["plan-identities-only", identitiesOnly(executable)],
      ["plan-mixed", mixed],
    ] as const) {
      const wired = await wire(projectId, { operations: [...githubOperations], review: false });
      expect(recordedApprovals(wired)).toEqual([]);
      // #246 C2 — such a PLAN has no planned outputs, so `result_submit` freezes no candidate and
      // no review runs: the run never reaches the CEO, and nothing is written or consumed.
      const submitted = await callCtoToolAsOwner(wired.harness, wired.runId, "result_submit", {
        idempotencyKey: `${projectId}-result`,
        runId: wired.runId,
        resultSummary: "the planned bootstrap outputs",
        recommendation: "create the repository",
      });
      expect(submitted.body).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        evidence: { refusal: "PLAN_NOT_EXECUTABLE" },
      });
      expect(wired.harness.cp.runs.require(wired.runId).state).toBe(RunState.ACTIVE);
      expect(wired.harness.cp.runs.currentCandidate(wired.runId)).toBeNull();
      expect(wired.github.writes).toEqual([]);
      expect(wired.github.reads).toEqual([]);
      expect(consumedApprovals(wired)).toBe(0);
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
    // #246 C2 — `result_submit` freezes a bootstrap candidate and promotes it like any other, so the
    // unpromoted pointer this row was written for no longer occurs; the CONFIRM still names its own.
    expect(wired.harness.cp.runs.currentCandidate(wired.runId)).toBe(wired.snapshotDigest);

    const refused = await confirm(wired, "rf1050-01-unreviewed", { candidateSnapshotDigest: unreviewed });
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect(refused["evidence"]).toMatchObject({ stage: "precondition", candidateSnapshotDigest: unreviewed });
    nothingWrittenOrConsumed(wired);

    // The reviewed candidate is still confirmed: the first CONFIRM writes and waits on the handoff.
    const reviewed = await confirm(wired, "rf1050-01-reviewed");
    expect(reviewed).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect((reviewed["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
    expect(consumedApprovals(wired)).toBe(0);
  });

  it("RF1050-01: the same holds once the reviewed candidate is promoted", async () => {
    const wired = await wire("rf1050-01-promoted");
    wired.harness.cp.runs.promoteCandidate(wired.runId, wired.snapshotDigest);

    const refused = await confirm(wired, "rf1050-01p-unreviewed", { candidateSnapshotDigest: unreviewed });
    expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    nothingWrittenOrConsumed(wired);

    const reviewed = await confirm(wired, "rf1050-01p-reviewed");
    expect((reviewed["evidence"] as Record<string, unknown>)["stage"]).toBe("activation");
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
  });
});

/**
 * #246 PR-C slice C3 — every bootstrap CONFIRM door goes through the runner's one full path: the
 * Hermes socket and the runner's own entry perform the writes under the reservation, and the
 * production gate on its own completes nothing without a WRITTEN application.
 */
describe("#246 C3: every bootstrap CONFIRM door goes through the same path", () => {
  it("the CEO's ceo_decision_submit over hermes.mcp.sock runs the full path: the writes under a reservation, one approval consumed", async () => {
    const wired = await wire("c3-door-hermes-socket");
    // The creation response is the only place a session secret exists, so the CEO the socket
    // authenticates is one created here and switched in.
    const ceo = wired.harness.cp.sessions.create({ provider: "scripted", model: "c3-wire-ceo" });
    if (!ceo.sessionSecret) throw new Error("the CEO session has no secret");
    wired.harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "c3 wire CEO");
    const switched = wired.harness.cp.bindings.switchTo({
      role: Role.CEO, sessionId: ceo.sessionId, reason: "c3 wire CEO", conversation: "REPLACED",
    });
    if (!switched.allowed) throw new Error(switched.message);
    await wired.harness.cp.continuity.evaluate("bootstrap confirmation");
    const listeners = await startLocalMcpListeners(wired.harness.cp, tempDir("acp-246-c3-mcp-"), TEST_MCP_TOKEN);
    try {
      const first = await callMcpToolOverSocket(
        listeners.socketPaths[0]!,
        { token: TEST_MCP_TOKEN, sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret },
        "ceo_decision_submit",
        {
          idempotencyKey: "c3-door-hermes-socket",
          runId: wired.runId,
          decision: "CONFIRM",
          candidateSnapshotDigest: wired.snapshotDigest,
          ceoSessionId: ceo.sessionId,
          rationale: "issue #246 C3 door",
        },
      );
      expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    } finally {
      await listeners.close();
    }
    expect(wired.github.writes.map((write) => write.method)).toEqual([
      "createRepository",
      "pushBranch",
      "setDefaultBranch",
      "protectBranch",
    ]);
    expect(consumedApprovals(wired)).toBe(0);
    expect(wired.harness.cp.bootstrapApplications.get(wired.runId)).toMatchObject({ phase: "WRITTEN", attempts: 1 });
  });

  it("ProductionGate.submitCeoDecision completes nothing without the runner: no WRITTEN application, BOOTSTRAP_APPLICATION_NOT_AVAILABLE", async () => {
    const wired = await wire("c3-door-gate");
    await wired.harness.cp.continuity.evaluate("bootstrap confirmation");
    const input = {
      runId: wired.runId,
      decision: "CONFIRM" as const,
      candidateSnapshotDigest: wired.snapshotDigest,
      ceoSessionId: wired.ceoSessionId,
      rationale: "issue #246 C3 door",
    };
    // The CEO is admissible to apply the CONFIRM; the decision on its own completes nothing.
    expect(wired.harness.cp.ceo.assertCeoDecisionAdmissible(input).allowed).toBe(true);
    expect(wired.harness.cp.ceo.submitCeoDecision(input).reasonCode).toBe(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE);
    nothingWrittenOrConsumed(wired);
    expect(wired.harness.cp.bootstrapApplications.get(wired.runId)).toBeNull();
    expect(wired.harness.cp.artifacts.latest(wired.runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
  });

  it("the runner's CONFIRM entry produceAndActivateApproved is the same path, and asks the CEO's admission itself", async () => {
    const wired = await wire("c3-door-runner");
    await wired.harness.cp.continuity.evaluate("bootstrap confirmation");
    // A session that does not hold the CEO role sets off nothing, even at the runner's own door.
    const notCeo = await wired.harness.cp.bootstrapProducer.produceAndActivateApproved({
      runId: wired.runId,
      candidateSnapshotDigest: wired.snapshotDigest,
      ceoSessionId: wired.bootstrapCtoSessionId,
    });
    expect(notCeo).toMatchObject({ allowed: false, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED });
    nothingWrittenOrConsumed(wired);
    expect(wired.harness.cp.bootstrapApplications.get(wired.runId)).toBeNull();

    const applied = await wired.harness.cp.bootstrapProducer.produceAndActivateApproved({
      runId: wired.runId,
      candidateSnapshotDigest: wired.snapshotDigest,
      ceoSessionId: wired.ceoSessionId,
    });
    expect(applied).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect(wired.github.writes.map((write) => write.method)).toContain("createRepository");
    expect(wired.harness.cp.bootstrapApplications.get(wired.runId)).toMatchObject({ phase: "WRITTEN" });
  });
});
