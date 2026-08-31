import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { Daemon, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { startOperatorSocket } from "../../src/daemon/agentcpd.ts";
import type { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { REVIEWER_PROVIDER_ENDPOINTS } from "../../src/runtime/provider.ts";
import { BuzzAdapter, InMemoryBuzzTransport, type BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { TestProductionAdapter } from "./production-adapter.ts";
import type { GitHubClient, GitHubKernelOptions } from "../../src/github/github-kernel.ts";
import type { OwnerIdentity } from "../../src/ceo/owner-authority.ts";
import type { BaselineHarnessInput } from "../../src/export/baseline-contract.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { ManagedManifestWrite } from "../../src/registry/project-registry.ts";
import { commitAll, gitSync, makeRepo, tempDir, writeFiles } from "./fixtures.ts";

/** The single allowlisted owner identity of the fixture deployment. */
export const TEST_OWNER = { channel: "cli", actor: "test-owner" } as const;
export const TEST_OPERATOR_TOKEN = "operator-token";
export const TEST_MCP_TOKEN = "mcp-token";

export interface Harness {
  cp: ControlPlane;
  clock: ManualClock;
  scripted: ScriptedAdapter;
  repoPath: string;
  root: string;
  buzz: InMemoryBuzzTransport;
  /** The adapter the control plane is wired to, whichever transport it holds. */
  buzzAdapter: BuzzAdapter;
}

/**
 * A control plane wired to the deterministic adapter, a real git repository and a real
 * verification command. Only the model runtime is scripted — the database, the sandbox,
 * git and every gate are the production implementations.
 */
export const makeHarness = (
  options: {
    githubClient?: GitHubClient;
    githubKernelOptions?: GitHubKernelOptions;
    /** A caller-owned checkout, used only by live acceptance captures. */
    repoPath?: string;
    /** Owner-provisioned App credential paths for a live acceptance capture. */
    githubAppEnvFile?: string;
    githubAppPrivateKeyPath?: string;
    ownerIdentities?: readonly OwnerIdentity[];
    allowTestEvidenceWriters?: boolean;
    /**
     * Replaces the in-memory route. Live acceptance captures pass the real CLI transport so
     * "connected" means a channel on the relay rather than an entry in an array.
     */
    buzzTransport?: BuzzTransport;
    /**
     * Live acceptance captures pass the system clock. A capture writes to a real remote,
     * and evidence stamped from a deterministic clock disagrees with the timestamps that
     * remote records — see the P1-01 finding on the P0-14 gate canary.
     */
    clock?: ManualClock;
  } = {},
): Harness => {
  const root = tempDir("acp-harness-");
  const clock = options.clock ?? new ManualClock("2026-08-12T00:00:00.000Z");
  const scripted = new TestProductionAdapter(clock);

  const repoPath = options.repoPath ?? makeRepo({
    "README.md": "# fixture project\n",
    "src/app.js": "module.exports = () => 1;\n",
    // The verification command is a real process the sandbox actually executes.
    "verify.js": `const app = require('./src/app.js');
if (app() !== 2) { console.error('expected app() === 2'); process.exit(1); }
console.log('verification ok');`,
  });

  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [scripted],
    allowNonProductionAdapters: true,
    // Test-only adapters do no I/O, but their deterministic egress evidence still has to
    // be checked against a policy the same way a real provider record is.
    reviewerEgress: {
      profilePath: join(root, "test-reviewer.sb"),
      proxyPath: join(root, "test-allowlist-proxy.py"),
      runtimeDir: join(root, "test-egress-runs"),
      providerEndpoints: {
        ...REVIEWER_PROVIDER_ENDPOINTS,
        scripted: ["scripted.provider.test"],
      },
    },
    // §21 — the fixture deployment has exactly one owner identity.
    ownerIdentities: options.ownerIdentities ?? [TEST_OWNER],
    // A fixture writes evidence directly in a few places; the daemon never unlocks this.
    allowTestEvidenceWriters: options.allowTestEvidenceWriters ?? true,
    ctoPreference: { provider: "scripted", model: "scripted-cto", effort: null },
    reviewer: {
      preferred: { provider: "scripted", model: "scripted-reviewer", effort: "xhigh" },
      fallbacks: [],
    },
    ...(options.githubClient ? { githubClient: options.githubClient } : {}),
    ...(options.githubKernelOptions ? { githubKernelOptions: options.githubKernelOptions } : {}),
    ...(options.githubAppEnvFile ? { githubAppEnvFile: options.githubAppEnvFile } : {}),
    ...(options.githubAppPrivateKeyPath ? { githubAppPrivateKeyPath: options.githubAppPrivateKeyPath } : {}),
  });

  // A route for the roles the control plane binds. The daemon wires the real CLI
  // transport; the fixture wires an in-memory one so "connected" means something.
  const buzz = new InMemoryBuzzTransport();
  const adapter = new BuzzAdapter(
    cp.db, cp.clock, cp.audit, cp.sessions, cp.bindings, cp.outbox, options.buzzTransport ?? buzz,
  );
  cp.cto.attach({
    buzz: {
      connect: (sessionId, purpose) => adapter.connect(sessionId, purpose),
      disconnect: (sessionId) => adapter.disconnect(sessionId),
    },
  });
  cp.continuity.attach({
    buzz: { connect: (sessionId, purpose) => adapter.connect(sessionId, purpose) },
  });

  return { cp, clock, scripted, repoPath, root, buzz, buzzAdapter: adapter };
};

export const fixtureManifest = (
  projectId: string,
  overrides: Partial<ProjectManifest> = {},
): ProjectManifest => ({
  schema: PROJECT_MANIFEST_SCHEMA_ID,
  projectId,
  repositories: [{ role: "primary", remote: "github:acme/fixture", manifestRoot: "." }],
  branchProfile: {
    longLived: ["main", "dev"],
    defaultBranch: "dev",
    updateStrategy: "rebase_before_review",
    mergeStrategy: "merge_commit",
    releaseTagPolicy: "semver",
    releaseBranchCleanup: "keep",
  },
  verificationProfiles: { simple: ["verify"], standard: ["verify"], guarded: ["verify"] },
  verificationCommands: [
    {
      id: "verify",
      argv: ["node", "verify.js"],
      repositoryRole: "primary",
      cwd: ".",
      timeoutSeconds: 120,
      envAllowlist: ["CI"],
      network: "deny",
      networkAllowlist: [],
      required: true,
      evidenceMode: "LOCAL_COMMAND",
      maxOutputBytes: 1_048_576,
      maxMemoryMb: 2048,
    },
  ],
  postMergeCommands: [],
  ciWorkflows: [],
  commitlore: { mode: "preferred" },
  ...overrides,
});

/** Register a real project and repository the way an owner would, with no Repo Factory. */
export const registerFixtureProject = async (
  harness: Harness,
  projectId = "fixture-project",
  manifestOverrides: Partial<ProjectManifest> = {},
  options: { identity?: string } = {},
): Promise<{ projectId: string; repositoryId: string; identity: string }> => {
  const manifest = fixtureManifest(projectId, manifestOverrides);
  const project = harness.cp.projects.register({
    projectId,
    name: "fixture",
    manifest,
    authorization: harness.cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(`project registration failed: ${project.message}`);

  const repository = await harness.cp.repositories.register({
    checkoutPath: harness.repoPath,
    projectId,
    repositoryRole: "primary",
    activeManifestDigest: project.value.activeManifestDigest,
    identity: options.identity ?? "github:acme/fixture",
  });
  if (!repository.allowed) throw new Error(`repository registration failed: ${repository.message}`);

  return {
    projectId,
    repositoryId: repository.value.repositoryId,
    identity: repository.value.identity,
  };
};

/** Managed activation proof for tests that complete a dedicated contract-change run. */
export const manifestAuthorizationForRun = (
  harness: Harness,
  projectId: string,
  manifest: ProjectManifest,
  runId: string,
): ManagedManifestWrite => {
  const run = harness.cp.runs.require(runId);
  return {
    projectId,
    runId,
    sessionId: run.ownerSessionId,
    bindingGeneration: run.ownerBindingGeneration,
    expectedManifestDigest: manifestDigest(manifest),
  };
};

/** Bind a CEO session so production-ready notifications have somewhere to land. */
export const bindCeo = (harness: Harness): string => {
  const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-ceo" });
  harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
  const bound = harness.cp.bindings.bind({
    roleKey: roleKeyFor(Role.CEO),
    role: Role.CEO,
    sessionId: session.sessionId,
  });
  if (!bound.allowed) throw new Error(`CEO binding failed: ${bound.message}`);
  return session.sessionId;
};

export interface StartedOperator {
  harness: Harness;
  daemon: Daemon;
  socketPath: string;
  peer: AuthenticatedOperatorPeer;
  close(): Promise<void>;
}

/** Starts the same authenticated in-process operator surface used by socket integration tests. */
export const makeStartedOperator = async (options: {
  operatorToken?: string;
  operatorActor?: string;
} = {}): Promise<StartedOperator> => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  bindCeo(harness);
  const stateDir = tempDir("acp-operator-daemon-");
  const daemon = new Daemon(harness.cp, { stateDir });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  const operatorToken = options.operatorToken ?? TEST_OPERATOR_TOKEN;
  const operatorActor = options.operatorActor ?? TEST_OWNER.actor;
  const peer: AuthenticatedOperatorPeer = {
    channel: "cli",
    peerId: `cli:${operatorActor}`,
    actor: operatorActor,
    // This value is only used for direct daemon calls; the listener supplies its live value.
    incarnation: "test-live-incarnation",
  };
  const listener = await startOperatorSocket(
    daemon,
    stateDir,
    { token: operatorToken, peerId: peer.peerId, actor: peer.actor },
    { mcpToken: TEST_MCP_TOKEN },
  );
  return {
    harness,
    daemon,
    socketPath: listener.socketPath,
    peer,
    close: async () => {
      await listener.close();
      await daemon.stop();
    },
  };
};

/**
 * Fixtures model a real worker as its own READY session with the task-scoped binding that
 * execution admission persists. Reusing the CTO session here would hide CP-HI-04 gaps.
 */
export const bindWorkerForTask = (
  controlPlane: Pick<ControlPlane, "sessions" | "bindings">,
  taskId: string,
): string => {
  const session = controlPlane.sessions.create({ provider: "scripted", model: "scripted-worker" });
  const ready = controlPlane.sessions.transition(session.sessionId, SessionLifecycle.READY, "test worker");
  if (!ready.allowed) throw new Error(`worker session readiness failed: ${ready.message}`);
  const bound = controlPlane.bindings.bind({
    role: Role.WORKER,
    sessionId: session.sessionId,
    taskId,
  });
  if (!bound.allowed) throw new Error(`worker binding failed: ${bound.message}`);
  return session.sessionId;
};

export const bindWorker = (harness: Harness, taskId: string): string =>
  bindWorkerForTask(harness.cp, taskId);

/**
 * Work happens on a task branch cut from the base, exactly as the branch contract
 * requires — committing straight onto the base branch would make base and candidate the
 * same commit and produce an empty diff.
 */
export const startWorkBranch = (repoPath: string, branch: string = "task/T1-app"): string => {
  const current = gitSync(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) gitSync(repoPath, ["checkout", "-q", "-b", branch]);
  return branch;
};

/** The change that makes `verify.js` pass. */
export const applyPassingChange = (repoPath: string, branch?: string): string => {
  startWorkBranch(repoPath, branch);
  writeFiles(repoPath, { "src/app.js": "module.exports = () => 2;\n" });
  return commitAll(repoPath, "make app() return 2");
};

/** A change that leaves `verify.js` failing. */
export const applyFailingChange = (repoPath: string, branch?: string): string => {
  startWorkBranch(repoPath, branch);
  writeFiles(repoPath, { "src/app.js": "module.exports = () => 3;\n" });
  return commitAll(repoPath, "make app() return 3");
};

export const reviewerPass = (coveredFiles: string[]): string =>
  JSON.stringify({
    verdict: "PASS",
    coveredFiles,
    omittedItems: [],
    findings: [],
  });

export const reviewerRevise = (coveredFiles: string[], summary: string): string =>
  JSON.stringify({
    verdict: "REVISE",
    coveredFiles,
    omittedItems: [],
    findings: [
      {
        category: "correctness",
        severity: "MAJOR",
        repository: "github:acme/fixture",
        path: "src/app.js",
        summary,
        detail: summary,
      },
    ],
  });

/**
 * Drives one real run to *evidence*: task graph, worker change, a frozen candidate,
 * deterministic verification and a fresh scripted blind review — stopping short of the
 * CEO packet so the run is still ACTIVE and can perform managed writes.
 *
 * The GitHub kernel scenarios need this because a gate payload is only publishable when
 * the evidence it names actually exists (§24.4), and a merge is a managed write that only
 * an active run may make.
 */
export const driveToReviewedCandidate = async (
  harness: Harness,
  options: {
    projectId?: string;
    workBranch?: string;
    /** Lets GitHub regressions exercise release/hotfix targets without bypassing the run path. */
    baseBranch?: string;
    /** Lets GitHub regressions exercise the real durable human-gate contract. */
    humanGate?: readonly string[];
    /** Extra candidate-relative paths the scripted blind reviewer must attest to. */
    reviewedPaths?: readonly string[];
    /** Explicit GitHub identity for a disposable live repository. */
    repositoryIdentity?: string;
    manifestOverrides?: Partial<ProjectManifest>;
  } = {},
): Promise<{
  projectId: string;
  repositoryId: string;
  identity: string;
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  candidateSnapshotDigest: string;
  verificationDigest: string;
  blindReviewDigest: string;
  contractDigest: string;
  candidateHead: string;
  baseHead: string;
  workBranch: string;
}> => {
  const workBranch = options.workBranch ?? "feature/F1-thing";
  const { projectId, repositoryId, identity } = await registerFixtureProject(
    harness,
    options.projectId ?? "fixture-project",
    options.manifestOverrides ?? {},
    ...(options.repositoryIdentity ? [{ identity: options.repositoryIdentity }] : []),
  );
  bindCeo(harness);

  const contract: TaskContract = {
    goal: "make app() return 2",
    why: "downstream callers expect 2",
    scope: ["src/app.js"],
    nonGoals: [],
    acceptance: ["verify.js exits 0"],
    priority: "NORMAL",
    humanGate: [...(options.humanGate ?? [])],
    references: [],
  };

  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: options.baseBranch ?? "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;

  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;

  const tasks = harness.cp.tasks.submit(runId, [
    { key: "impl", title: "change app()", category: "implementation" },
  ]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = harness.cp.tasks.ready(runId)[0]!;
  const workerSessionId = bindWorker(harness, impl.taskId);
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: impl.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);

  const head = applyPassingChange(harness.repoPath, workBranch);
  harness.cp.tasks.finishExecution(execution.value.executionId, {
    status: "SUCCEEDED",
    resultDigest: `sha256:${head}`,
  });

  const frozen = await harness.cp.pipeline.freeze(runId);
  if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message}`);
  const snapshot = frozen.value;
  const manifest = harness.cp.projects.activeManifest(projectId)!.manifest;

  const verified = await harness.cp.verification.verify({
    runId,
    snapshot,
    commands: manifest.verificationCommands,
    contractDigest: snapshot.contractDigest,
  });
  if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);

  harness.scripted.script({
    match: /Candidate review/,
    text: reviewerPass((options.reviewedPaths ?? ["src/app.js"]).map((path) => `${identity}:${path}`)),
  });
  const reviewed = await harness.cp.review.controlPlaneInvoker()({
    runId,
    projectId,
    executionMode: run.executionMode,
    snapshot,
    contract,
    contractDigest: snapshot.contractDigest,
    verification: verified.value,
  });
  if (!reviewed.allowed) throw new Error(`${reviewed.reasonCode}: ${reviewed.message}`);

  const candidateSnapshotDigest = harness.cp.runs.currentCandidate(runId)!;
  const repository = snapshot.repositories.find((r) => r.identity === identity)!;
  const verification = harness.cp.artifacts.latestForSnapshot(
    runId,
    "VERIFICATION",
    candidateSnapshotDigest,
  )!;
  const review = harness.cp.artifacts.latestForSnapshot(
    runId,
    "BLIND_REVIEW",
    candidateSnapshotDigest,
  )!;

  return {
    projectId,
    repositoryId,
    identity,
    runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    candidateSnapshotDigest,
    verificationDigest: verification.digest,
    blindReviewDigest: review.digest,
    contractDigest: run.contractDigest,
    candidateHead: repository.candidateHead,
    baseHead: repository.baseHead,
    workBranch,
  };
};

/**
 * Move a real reviewed candidate through the same packet and CEO-confirmation path that
 * production uses before the daemon receives authority to perform GitHub finalization.
 *
 * Keeping this separate from `driveToReviewedCandidate` matters: source-work tests still
 * need a genuinely ACTIVE run, while GitHub-write tests must not quietly exercise the
 * superseded "ACTIVE may merge" contract.
 */
export const approveReviewedCandidateForFinalization = async (
  harness: Harness,
  driven: Awaited<ReturnType<typeof driveToReviewedCandidate>>,
  options: { bypassCeoConfirmation?: boolean } = {},
): Promise<void> => {
  await harness.cp.continuity.evaluate("test finalization packet");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "candidate verified",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);

  if (options.bypassCeoConfirmation) {
    // Low-level GitHub boundary fixtures need a CEO-approved state while the durable human
    // gate is deliberately unsatisfied. ProductionGate correctly refuses CONFIRM in that
    // situation; this state-only fixture keeps the test focused on the kernel's own re-check
    // without making the production path capable of bypassing that predicate.
    const staged = harness.cp.runs.transition(
      driven.runId,
      RunState.CEO_APPROVED,
      "synthetic finalization state for GitHub boundary fixture",
      { candidateSnapshotDigest: driven.candidateSnapshotDigest },
    );
    if (!staged.allowed) throw new Error(`${staged.reasonCode}: ${staged.message}`);
    return;
  }

  const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) throw new Error("fixture CEO binding missing");
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId: driven.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    ceoSessionId: ceo.sessionId,
    rationale: "test finalization approval",
  });
  if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);
};

/**
 * Test-only adapter for low-level kernel cases. It models calls made by the daemon, rather
 * than making a CLI or source worker capable of possessing the opaque finalizer token.
 */
export const installDaemonFinalizerGitHubFixture = (harness: Harness): void => {
  const kernel = harness.cp.github;
  const authority = harness.cp.daemonFinalizationAuthorities().write;
  const daemonKernel = new Proxy(kernel, {
    get(target, property, receiver) {
      if (property === "prPrepare") {
        return (input: Parameters<typeof kernel.prPrepare>[0]) =>
          target.prPrepare({ ...input, daemonFinalizerAuthority: authority });
      }
      if (property === "gatePublish") {
        return (
          payload: Parameters<typeof kernel.gatePublish>[0],
          repositoryIdentity: Parameters<typeof kernel.gatePublish>[1],
        ) => target.gatePublish(payload, repositoryIdentity, authority);
      }
      if (property === "mergeExecute") {
        return (input: Parameters<typeof kernel.mergeExecute>[0]) =>
          target.mergeExecute({ ...input, daemonFinalizerAuthority: authority });
      }
      if (property === "postMergeVerify") {
        return (...input: Parameters<typeof kernel.postMergeVerify>) =>
          target.postMergeVerify(input[0], input[1], input[2], input[3], authority);
      }
      if (property === "releaseTag") {
        return (...input: Parameters<typeof kernel.releaseTag>) =>
          target.releaseTag(input[0], input[1], input[2], input[3], {
            ...input[4],
            daemonFinalizerAuthority: authority,
          });
      }
      if (property === "issueProject") {
        return (...input: Parameters<typeof kernel.issueProject>) =>
          target.issueProject(input[0], input[1], input[2], {
            ...input[3],
            daemonFinalizerAuthority: authority,
          });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(harness.cp, "github", {
    configurable: true,
    enumerable: true,
    value: daemonKernel,
    writable: false,
  });
};

/**
 * Drives an empty participation set through the production candidate packet, CEO confirmation,
 * and lock-held daemon finalizer. The registry tests use this instead of manually advancing
 * the state machine with a completion capability.
 */
export const finalizeNoRepositoryRun = async (
  harness: Harness,
  projectId: string,
  contract: TaskContract,
  /** Baseline exports only count a run whose harness identity attests production evidence. */
  options: { baselineHarness?: BaselineHarnessInput } = {},
): Promise<{ runId: string; candidateSnapshotDigest: string }> => {
  bindCeo(harness);
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const created = harness.cp.runs.create({
    projectId,
    kind: RunKind.CONTRACT_CHANGE,
    // These registry fixtures declare no human-gate item. Keep that contract honest while
    // exercising the real packet/CEO/daemon path; guarded runs still fail closed when they
    // omit their required owner item.
    executionMode: ExecutionMode.STANDARD,
    contract,
    ...(options.baselineHarness ? { baselineHarness: options.baselineHarness } : {}),
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  await harness.cp.continuity.evaluate("empty run candidate packet");
  const submitted = await harness.cp.pipeline.submitResult({
    runId: created.value.runId,
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    resultSummary: "no participating repositories",
    recommendation: "complete administrative contract change",
    residualRisk: [],
  });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  const candidateSnapshotDigest = harness.cp.runs.currentCandidate(created.value.runId);
  if (!candidateSnapshotDigest) throw new Error("empty run did not produce a candidate snapshot");
  await harness.cp.continuity.evaluate("empty run finalization");
  const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) throw new Error("fixture CEO binding missing");
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId: created.value.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest,
    ceoSessionId: ceo.sessionId,
    rationale: "nothing participates in this administrative finalization",
  });
  if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);

  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-empty-finalization-") });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  await daemon.stop();
  if (harness.cp.runs.require(created.value.runId).state !== "COMPLETED") {
    throw new Error("empty finalization did not complete through the daemon");
  }
  return { runId: created.value.runId, candidateSnapshotDigest };
};

/**
 * Mints the operation-bound owner proof that the production gate verifies (#102).
 *
 * An allowlisted *name* stopped being authority: the gate takes a receipt the ingress guard
 * admitted for this exact run, operation and parameters, so a caller that merely knows the
 * owner's identity cannot approve anything.
 */
export const ownerDecisionReceipt = (
  harness: Harness,
  runId: string,
  item: string,
  approved: boolean,
  note: string,
  actor: string = TEST_OWNER.actor,
  channel: "cli" | "telegram" | "buzz" | "mcp" = "cli",
) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    [channel]: {
      allowedActors: [actor],
      ...(channel === "telegram" ? { allowedConversations: ["owner"] } : {}),
    },
  });
  const approval = {
    runId,
    candidateSnapshotDigest: harness.cp.runs.currentCandidate(runId),
    operation: "owner_decision_submit",
    parameters: { item, approved, note },
    idempotencyKey: `owner-decision:${digestOf({ runId, item, approved, note, actor })}`,
    approved,
  };
  const admitted = guard.admitOwnerApproval(
    { channel, actor, nonce: `owner-decision:${digestOf(approval)}`, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) throw new Error(admitted.message);
  return admitted.value;
};

/**
 * Admits one message through the real ingress path, so a `TurnSource` a fixture builds names a
 * payload `claim()` can verify against `INGRESS_ADMITTED`'s own record — not one only the fixture
 * typed into `inbound_messages` by hand.
 *
 * `claim()` used to check only that a `(channel, nonce)` row existed, so a fixture's raw `INSERT`
 * and a fixture's independently-constructed `TurnSource.payload` were never the same claim a real
 * caller has to make — the fixture built exactly the counterexample the admission check exists to
 * refuse (a source whose payload nothing ties to what was admitted), and every positive test in
 * the file passed anyway because nothing compared the two. Going through `IngressGuard.admit`
 * closes that: the row and the `INGRESS_ADMITTED` audit event it writes are the one durable
 * record of what this nonce carries, and a fixture that later builds a `TurnSource` for the same
 * nonce has to supply that same payload or `claim()` refuses it, same as production.
 *
 * Idempotent by design, not by an `INSERT OR IGNORE`: a retry (`attempt > 1`) names the same
 * nonce, and re-admitting it is a no-op the same way a genuine replay is.
 */
export const admitInbound = (
  harness: Harness,
  input: {
    nonce: string;
    payload: unknown;
    channel?: "telegram" | "buzz" | "mcp" | "cli";
    actor?: string;
    conversation?: string;
  },
): void => {
  const channel = input.channel ?? "telegram";
  const already = harness.cp.db.get<{ 1: number }>(
    `SELECT 1 FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [channel, input.nonce],
  );
  if (already) return;
  const actor = input.actor ?? "owner";
  const conversation = input.conversation ?? "convo";
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    [channel]: { allowedActors: [actor], allowedConversations: [conversation] },
  });
  const admitted = guard.admit({ channel, actor, conversation, nonce: input.nonce, payload: input.payload });
  if (!admitted.allowed) {
    throw new Error(`fixture could not admit ${channel}:${input.nonce}: ${admitted.reasonCode}`);
  }
};
