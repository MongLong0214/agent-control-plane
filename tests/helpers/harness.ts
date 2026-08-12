import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { commitAll, gitSync, makeRepo, tempDir, writeFiles } from "./fixtures.ts";

export interface Harness {
  cp: ControlPlane;
  clock: ManualClock;
  scripted: ScriptedAdapter;
  repoPath: string;
  root: string;
}

/**
 * A control plane wired to the deterministic adapter, a real git repository and a real
 * verification command. Only the model runtime is scripted — the database, the sandbox,
 * git and every gate are the production implementations.
 */
export const makeHarness = (options: { githubClient?: GitHubClient } = {}): Harness => {
  const root = tempDir("acp-harness-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const scripted = new ScriptedAdapter(clock);

  const repoPath = makeRepo({
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
    ctoPreference: { provider: "scripted", model: "scripted-cto", effort: null },
    reviewer: {
      preferred: { provider: "scripted", model: "scripted-reviewer", effort: "xhigh" },
      fallbacks: [],
    },
    ...(options.githubClient ? { githubClient: options.githubClient } : {}),
  });

  return { cp, clock, scripted, repoPath, root };
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
): Promise<{ projectId: string; repositoryId: string; identity: string }> => {
  const manifest = fixtureManifest(projectId, manifestOverrides);
  const project = harness.cp.projects.register({ projectId, name: "fixture", manifest });
  if (!project.allowed) throw new Error(`project registration failed: ${project.message}`);

  const repository = await harness.cp.repositories.register({
    checkoutPath: harness.repoPath,
    projectId,
    repositoryRole: "primary",
    activeManifestDigest: project.value.activeManifestDigest,
    identity: "github:acme/fixture",
  });
  if (!repository.allowed) throw new Error(`repository registration failed: ${repository.message}`);

  return {
    projectId,
    repositoryId: repository.value.repositoryId,
    identity: repository.value.identity,
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
  );
  bindCeo(harness);

  const contract: TaskContract = {
    goal: "make app() return 2",
    why: "downstream callers expect 2",
    scope: ["src/app.js"],
    nonGoals: [],
    acceptance: ["verify.js exits 0"],
    priority: "NORMAL",
    humanGate: [],
    references: [],
  };

  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
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
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: impl.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: run.ownerSessionId,
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

  harness.scripted.script({ match: /Candidate review/, text: reviewerPass([`${identity}:src/app.js`]) });
  const reviewed = await harness.cp.review.review({
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
