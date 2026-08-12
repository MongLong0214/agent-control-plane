import { readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixtureManifest, makeHarness } from "../helpers/harness.ts";
import { applyPassingChange } from "../helpers/harness.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { assertPortableManifest } from "../../src/contracts/manifest.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import {
  buildCandidateSnapshot,
  verifySnapshotFreshness,
} from "../../src/snapshot/candidate-snapshot.ts";
import { buildSandboxEnvironment, runSandboxed } from "../../src/verify/sandbox.ts";
import { WorktreeManager } from "../../src/verify/worktree.ts";

afterEach(cleanupTempDirs);

const contract = {
  goal: "verification regression",
  why: "test",
  scope: [],
  nonGoals: [],
  acceptance: ["verified"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const sandboxIt = process.platform === "darwin" ? it : it.skip;

const frozenPinnedCandidate = async (options: {
  manifest?: ReturnType<typeof fixtureManifest>;
  trustClass?: "OWNER_TRUSTED" | "UNTRUSTED";
} = {}) => {
  const harness = makeHarness();
  const manifest = options.manifest ?? fixtureManifest("verify-r2-project");
  const project = harness.cp.projects.register({ projectId: manifest.projectId, name: "verify-r2", manifest });
  if (!project.allowed) throw new Error(project.message);
  const repository = await harness.cp.repositories.register({
    checkoutPath: harness.repoPath,
    projectId: manifest.projectId,
    repositoryRole: "primary",
    activeManifestDigest: project.value.activeManifestDigest,
    identity: "github:acme/fixture",
    trustClass: options.trustClass,
  });
  if (!repository.allowed) throw new Error(repository.message);
  const created = harness.cp.runs.create({
    projectId: manifest.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [{ repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  applyPassingChange(harness.repoPath, "task/verify-r2");
  const snapshot = await harness.cp.pipeline.freeze(created.value.runId);
  if (!snapshot.allowed) throw new Error(snapshot.message);
  return { harness, manifest, repository: repository.value, run: dispatched.value, snapshot: snapshot.value };
};

describe("round-2 verification isolation and candidate freshness", () => {
  it("#160 refuses a weaker caller command even when pin fields are omitted", async () => {
    const { harness, run, snapshot } = await frozenPinnedCandidate();
    const refused = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: [parseVerificationCommand({ id: "verify", argv: ["node", "-e", "process.exit(0)"] })],
      contractDigest: snapshot.contractDigest,
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT });
  });

  it("#161 rejects a worktree id paired with a different checkout", async () => {
    const repo = makeRepo({ "a.txt": "base\n" });
    const candidate = join(tempDir("acp-candidate-"), "candidate");
    gitSync(repo, ["worktree", "add", "--detach", candidate, "HEAD"]);
    const id = readdirSync(join(repo, ".git", "worktrees"))[0]!;

    await expect(
      buildCandidateSnapshot(
        {
          runId: "run_1",
          contractDigest: "sha256:contract",
          repositories: [{
            identity: "github:acme/repo",
            repositoryRole: "primary",
            checkoutPath: repo,
            baseBranch: "dev",
            worktreeId: id,
          }],
        },
        makeHarness().clock,
      ),
    ).rejects.toMatchObject({ reasonCode: ReasonCode.SNAPSHOT_STALE });
  });

  sandboxIt("#162 refuses a cwd symlink that resolves outside the frozen worktree", async () => {
    const repo = makeRepo();
    const outside = tempDir("acp-outside-");
    // A committed symlink is the candidate-controlled path the command would otherwise
    // follow outside its frozen checkout.
    const link = join(repo, "linked");
    symlinkSync(outside, link);
    commitAll(repo, "commit escaping cwd symlink");
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "symlink-cwd", argv: ["node", "-e", "process.exit(0)"], cwd: "linked" }),
      worktreePath: repo,
    });
    expect(outcome).toMatchObject({ status: "ERROR", reasonCode: ReasonCode.SANDBOX_PATH_OUTSIDE_WORKTREE });
  });

  it("#163 drops an opaque provider token even when a command asks for its name", () => {
    process.env.PROVIDER_TOKEN = "opaque-value-that-is-not-pattern-matched";
    const env = buildSandboxEnvironment(
      parseVerificationCommand({ id: "env", argv: ["node", "-e", "process.exit(0)"], envAllowlist: ["PROVIDER_TOKEN"] }),
      tempDir("acp-env-"),
      undefined,
    );
    delete process.env.PROVIDER_TOKEN;
    expect(env.PROVIDER_TOKEN).toBeUndefined();
  });

  sandboxIt("#164 refuses the detached-descendant sequence unless containment is established", async () => {
    const repo = makeRepo();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "detached",
        argv: ["node", "-e", "require('child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'}).unref()"],
        timeoutSeconds: 2,
      }),
      worktreePath: repo,
    });
    expect(outcome.status).not.toBe("PASS");
  });

  it("#165 treats a deleted frozen base branch as snapshot drift", async () => {
    const repo = makeRepo({ "a.txt": "base\n" });
    gitSync(repo, ["checkout", "-q", "-b", "task/base-delete"]);
    writeFiles(repo, { "a.txt": "candidate\n" });
    commitAll(repo, "candidate");
    const snapshot = await buildCandidateSnapshot(
      {
        runId: "run_1",
        contractDigest: "sha256:contract",
        repositories: [{ identity: "github:acme/repo", repositoryRole: "primary", checkoutPath: repo, baseBranch: "dev" }],
      },
      makeHarness().clock,
    );
    gitSync(repo, ["branch", "-D", "dev"]);
    const fresh = await verifySnapshotFreshness(snapshot, [{ identity: "github:acme/repo", checkoutPath: repo }]);
    expect(fresh).toMatchObject({ allowed: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
  });

  sandboxIt("#166/#233 never passes a memory-pressure command without an installed hard limit", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "memory.js"), "Buffer.alloc(512 * 1024 * 1024);\n");
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "memory",
        argv: ["node", "memory.js"],
        maxMemoryMb: 16,
      }),
      worktreePath: repo,
    });
    expect(outcome.status).not.toBe("PASS");
  });

  sandboxIt("#167 finishes timeout escalation before returning an outcome", async () => {
    const repo = makeRepo();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "timeout", argv: ["node", "-e", "setInterval(() => {}, 1000)"], timeoutSeconds: 1 }),
      worktreePath: repo,
    });
    expect(["TIMEOUT", "ERROR"]).toContain(outcome.status);
    expect(outcome.reasonCode).not.toBeNull();
  });

  it("#168 rejects a project contract that requests unsupported host allowlisting", () => {
    const manifest = fixtureManifest("allowlist-contract");
    manifest.verificationCommands[0]!.network = "allowlist";
    manifest.verificationCommands[0]!.networkAllowlist = ["registry.npmjs.org"];
    expect(assertPortableManifest(manifest)).toMatchObject({ allowed: false, reasonCode: ReasonCode.MANIFEST_NOT_PORTABLE });
  });

  it("#169 chooses the newest exact-head CI result instead of an obsolete failure", async () => {
    const ci = parseVerificationCommand({
      id: "ci",
      argv: ["node", "verify.js"],
      repositoryRole: "primary",
      evidenceMode: "TRUSTED_CI",
    });
    const manifest = fixtureManifest("ci-current-result", {
      verificationProfiles: { simple: ["ci"], standard: ["ci"], guarded: ["ci"] },
      verificationCommands: [ci],
    });
    const { harness, run, snapshot } = await frozenPinnedCandidate({ manifest });
    const repository = snapshot.repositories[0]!;
    harness.cp.verification.attachCi({
      fetch: async () => [
        { commandId: "ci", repositoryIdentity: repository.identity, head: repository.candidateHead, conclusion: "failure", workflowDigest: "sha256:w", creatorIdentity: "trusted", completedAt: "2026-08-12T00:00:00.000Z", nonVacuous: true },
        { commandId: "ci", repositoryIdentity: repository.identity, head: repository.candidateHead, conclusion: "success", workflowDigest: "sha256:w", creatorIdentity: "trusted", completedAt: "2026-08-12T01:00:00.000Z", nonVacuous: true },
      ],
      approvedWorkflowDigests: async () => ["sha256:w"],
      trustedCreators: async () => ["trusted"],
    });
    const verified = await harness.cp.verification.verify({ runId: run.runId, snapshot, commands: [ci], contractDigest: snapshot.contractDigest });
    expect(verified).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
  });

  it("#170/#236 structurally rejects absolute, traversing, and non-identity manifest paths", () => {
    const manifest = fixtureManifest("path-contract");
    manifest.repositories[0]!.remote = "/etc/passwd";
    manifest.repositories[0]!.manifestRoot = "../../outside";
    manifest.ciWorkflows = [{ path: "C:\\private\\ci.yml", checkName: "ci", approvedDigest: null }];
    manifest.verificationCommands[0]!.argv = ["node", "../../outside.js"];
    expect(assertPortableManifest(manifest)).toMatchObject({ allowed: false, reasonCode: ReasonCode.MANIFEST_NOT_PORTABLE });
  });

  it("#171/#235 rejects shell paths and env launcher forms", () => {
    expect(() => parseVerificationCommand({ id: "shell", argv: ["/bin/sh", "-c", "true"] })).toThrow();
    expect(() => parseVerificationCommand({ id: "env-shell", argv: ["/usr/bin/env", "bash", "-c", "true"] })).toThrow();
  });

  it("#232 refuses a traversal id without deleting the external target", async () => {
    const repo = makeRepo();
    const root = tempDir("acp-worktrees-");
    const outside = tempDir("acp-outside-");
    writeFileSync(join(outside, "sentinel"), "keep");
    const manager = new WorktreeManager(root);
    await expect(manager.create(repo, "HEAD", "../../outside")).rejects.toMatchObject({ reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(readdirSync(outside)).toContain("sentinel");
  });

  it("#234 rejects a colliding live worktree instead of destroying its owner", async () => {
    const repo = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-worktrees-"));
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolveEntered) => { enter = resolveEntered; });
    const held = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const first = manager.withWorktree(repo, "HEAD", "same", async () => {
      enter();
      await held;
    });
    await entered;
    await expect(manager.withWorktree(repo, "HEAD", "same", async () => undefined)).rejects.toMatchObject({ reasonCode: ReasonCode.CONFLICT });
    release();
    await first;
  });

  it("#237 refuses untrusted and another run's temporary repositories before execution", async () => {
    const { harness, manifest, run, snapshot } = await frozenPinnedCandidate({ trustClass: "UNTRUSTED" });
    const refused = await harness.cp.verification.verify({
      runId: run.runId,
      snapshot,
      commands: manifest.verificationCommands,
      contractDigest: snapshot.contractDigest,
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_REPOSITORY_UNTRUSTED });

    const temporaryHarness = makeHarness();
    const temporaryPath = makeRepo();
    const temporary = await temporaryHarness.cp.repositories.registerTemporary(temporaryPath, "other-run");
    if (!temporary.allowed) throw new Error(temporary.message);
    const temporaryRun = temporaryHarness.cp.runs.create({
      executionMode: ExecutionMode.SIMPLE,
      contract,
      repositories: [{ repositoryId: temporary.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!temporaryRun.allowed) throw new Error(temporaryRun.message);
    const dispatched = await temporaryHarness.cp.runs.dispatch(temporaryRun.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const temporarySnapshot = await buildCandidateSnapshot(
      {
        runId: dispatched.value.runId,
        contractDigest: dispatched.value.contractDigest,
        repositories: [{
          identity: temporary.value.identity,
          repositoryRole: "primary",
          checkoutPath: temporaryPath,
          baseBranch: "dev",
          manifestDigest: null,
        }],
      },
      temporaryHarness.clock,
    );
    const crossRun = await temporaryHarness.cp.verification.verify({
      runId: dispatched.value.runId,
      snapshot: temporarySnapshot,
      commands: [parseVerificationCommand({ id: "temporary", argv: ["node", "-e", "0"] })],
      contractDigest: dispatched.value.contractDigest,
      runScoped: true,
    });
    expect(crossRun).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP });
  });

  it("#238 throws a typed denial instead of returning one as a candidate snapshot", async () => {
    await expect(
      buildCandidateSnapshot({ runId: "run_1", contractDigest: "sha256:contract", repositories: [] }, makeHarness().clock),
    ).rejects.toMatchObject({ reasonCode: ReasonCode.EVIDENCE_MISSING });
  });
});
