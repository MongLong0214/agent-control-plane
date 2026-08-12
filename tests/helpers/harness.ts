import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
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

export const fixtureManifest = (projectId: string): ProjectManifest => ({
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
});

/** Register a real project and repository the way an owner would, with no Repo Factory. */
export const registerFixtureProject = async (
  harness: Harness,
  projectId = "fixture-project",
): Promise<{ projectId: string; repositoryId: string; identity: string }> => {
  const manifest = fixtureManifest(projectId);
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
export const startWorkBranch = (repoPath: string, branch = "task/T1-app"): string => {
  const current = gitSync(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) gitSync(repoPath, ["checkout", "-q", "-b", branch]);
  return branch;
};

/** The change that makes `verify.js` pass. */
export const applyPassingChange = (repoPath: string): string => {
  startWorkBranch(repoPath);
  writeFiles(repoPath, { "src/app.js": "module.exports = () => 2;\n" });
  return commitAll(repoPath, "make app() return 2");
};

/** A change that leaves `verify.js` failing. */
export const applyFailingChange = (repoPath: string): string => {
  startWorkBranch(repoPath);
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
