import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { executablePlanOf } from "../../src/bootstrap/bootstrap-plan.ts";
import type { CommitLoreAttempt } from "../../src/bootstrap/commitlore-commit.ts";
import {
  COMMITLORE_LIMITS,
  type CommitLoreObservation,
  type CommitLorePort,
  commitloreRunner,
  createCommitLoreCliPort,
} from "../../src/bootstrap/commitlore-observation.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { git } from "../../src/git/git.ts";
import { cleanTreeManifest, bootstrapOperations } from "../helpers/bootstrap-plan.ts";
import { type Operation, noGitHubCall, ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { gitCommitAttempt } from "../helpers/commitlore-attempt.ts";
import { latestRelease } from "../helpers/commitlore-release.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";

/**
 * #1268 — under a required CommitLore the bootstrap's own commits are CommitLore's: the bootstrap commit, a
 * root commit, and the genesis commit, which has GitHub's initialization as its parent. No session produced
 * them, so there is no transcript and nothing is recorded: CommitLore's one-call commit with no records,
 * never a draft made up for it. A port that cannot commit, or a CommitLore that refuses, leaves no commit.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const PASS: CommitLoreObservation = {
  outcome: "PASS",
  reportStatus: "ok",
  warnings: [],
  detail: "commitlore doctor passed",
  report: JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] }),
};

const requiredBootstrap = (projectId: string, commitlore: CommitLorePort) =>
  prepareBootstrapRun(projectId, {
    manifest: cleanTreeManifest(projectId, { commitlore: { mode: "required" } }),
    ops: bootstrapOperations() as Operation[],
    commitlore,
  });

describe("#1268: the bootstrap commit is CommitLore's", () => {
  it("a required bootstrap's commit is made by a CommitLore commit attempt, with nothing recorded", async () => {
    const committed: string[] = [];
    const prepared = await requiredBootstrap("cl-bootstrap-commit", { observe: async () => PASS, attempt: gitCommitAttempt(committed) });
    const produced = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    // Activation waits on the CEO's confirmation; what is witnessed here is the commit the producer made.
    expect(produced.allowed || produced.reasonCode === ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, JSON.stringify(produced)).toBe(true);
    expect(committed).toEqual(["repo factory bootstrap"]);
  });

  it("a required bootstrap whose CommitLore cannot commit is refused before anything is written", async () => {
    const prepared = await requiredBootstrap("cl-bootstrap-no-attempt", { observe: async () => PASS });
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE", commitloreMode: "required" },
    });
    noGitHubCall(prepared);
  });

  it("a CommitLore that refuses the commit leaves no commit, and nothing is written to GitHub", async () => {
    const refusing = async (): Promise<Decision<CommitLoreAttempt>> => {
      const double = await gitCommitAttempt()();
      if (!double.allowed) return double;
      return allow(ReasonCode.OK, {
        ...double.value,
        commitWithoutTranscript: async () => deny(ReasonCode.VERIFICATION_GAP, "CommitLore did not make this commit", { refusal: "COMMITLORE_COMMIT_REFUSED" }),
      });
    };
    const prepared = await requiredBootstrap("cl-bootstrap-refused", { observe: async () => PASS, attempt: refusing });
    const refused = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_COMMIT_REFUSED" } });
    expect(prepared.github.writes).toEqual([]);
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
  });
});

describe("#1268: the genesis commit is CommitLore's", () => {
  it("a required genesis commit, on GitHub's initialization, is made by a CommitLore commit attempt with the bundle's message", async () => {
    const f = genesisPlanFixture();
    const root = tempDir("cl-genesis-");
    const port = new GenesisGitHub(root);
    const committed: string[] = [];
    const result = await produceRepoFactoryResult({
      plan: executablePlanOf(f.outputs, f.binding.planDigest),
      workDir: join(root, "work"),
      approvedFiles: f.outputs.files,
      github: {
        port,
        authority: {
          owner: "acme",
          visibility: "public" as const,
          approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })),
        },
      },
      commitlore: { mode: "required", port: { observe: async () => PASS, attempt: gitCommitAttempt(committed) } },
    });
    expect(result.allowed, result.allowed ? "" : `${result.message} ${JSON.stringify(result.evidence)}`).toBe(true);
    expect(committed).toEqual([f.genesis.commitMessage]);
  });
});

/**
 * A GitHub double whose autoInit commit already holds exactly the approved genesis files, so the genesis
 * commit on it changes nothing.
 */
class AutoInitHoldsGenesis extends GenesisGitHub {
  autoInitHead: string | null = null;
  bare: string | null = null;
  constructor(root: string, private readonly files: ReadonlyArray<{ path: string; mode: string; content: string; contentBase64?: string }>) {
    super(root);
  }
  override async createRepository(target: Parameters<GenesisGitHub["createRepository"]>[0], visibility: string, description?: string, autoInit?: boolean) {
    const created = await super.createRepository(target, visibility, description, autoInit);
    const repo = this.repository(target.owner, target.name)!;
    const seed = tempDir("cl-autoinit-genesis-");
    await git(seed, ["init", "-q", "-b", "main"]);
    for (const file of this.files) {
      mkdirSync(dirname(join(seed, file.path)), { recursive: true });
      writeFileSync(join(seed, file.path), file.contentBase64 === undefined ? file.content : Buffer.from(file.contentBase64, "base64"), {
        mode: file.mode === "100755" ? 0o755 : 0o644,
      });
    }
    await git(seed, ["add", "--", "."]);
    await git(seed, ["-c", "user.name=GitHub", "-c", "user.email=github@local", "commit", "-q", "-m", "Initial commit"]);
    await git(seed, ["push", "-q", "--force", repo.bare, "HEAD:refs/heads/main"]);
    this.autoInitHead = (await git(seed, ["rev-parse", "HEAD"])).stdout.trim();
    this.bare = repo.bare;
    return created;
  }
}

/** A genesis whose approved files equal GitHub's initialization, produced with `commitlore`, its message `message`. */
const emptyGenesis = async (commitlore: CommitLorePort, message?: string) => {
  const f = genesisPlanFixture();
  const root = tempDir("cl-genesis-empty-");
  const port = new AutoInitHoldsGenesis(root, f.outputs.files);
  const plan = executablePlanOf(f.outputs, f.binding.planDigest);
  if (message !== undefined) plan.genesis = { ...plan.genesis!, commitMessage: message };
  const result = await produceRepoFactoryResult({
    plan,
    workDir: join(root, "work"),
    approvedFiles: f.outputs.files,
    github: {
      port,
      authority: {
        owner: "acme",
        visibility: "public" as const,
        approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })),
      },
    },
    commitlore: { mode: "required", port: commitlore },
  });
  return { result, port };
};

describe("#1268: a genesis that adds nothing to GitHub's initialization", () => {
  it("is committed as before, on the autoInit head, with no CommitLore commit asked for", async () => {
    const committed: string[] = [];
    const { result, port } = await emptyGenesis({ observe: async () => PASS, attempt: gitCommitAttempt(committed) });
    expect(result.allowed, result.allowed ? "" : `${result.message} ${JSON.stringify(result.evidence)}`).toBe(true);
    expect(committed).toEqual([]);
    const genesis = (await git(port.bare!, ["rev-parse", "refs/heads/genesis"])).stdout.trim();
    const parents = (await git(port.bare!, ["rev-list", "--parents", "-n", "1", genesis])).stdout.trim().split(" ").slice(1);
    expect(parents).toEqual([port.autoInitHead]);
    expect((await git(port.bare!, ["rev-parse", `${genesis}^{tree}`])).stdout.trim()).toBe(
      (await git(port.bare!, ["rev-parse", `${port.autoInitHead}^{tree}`])).stdout.trim(),
    );
  });
});

/**
 * The real CLI: `ACP_TEST_REAL_COMMITLORE`, else the first `commitlore` on PATH; skipped when there is neither.
 * Its release lookup confirms the CLI's own version, so no witness reaches the network.
 */
const realCommitLore = (): string | null => {
  const explicit = process.env["ACP_TEST_REAL_COMMITLORE"];
  if (explicit !== undefined && explicit !== "") return explicit;
  for (const directory of (process.env["PATH"] ?? "").split(":").filter((entry) => entry.startsWith("/"))) {
    try {
      accessSync(join(directory, "commitlore"), constants.X_OK);
      return join(directory, "commitlore");
    } catch {
      // not here
    }
  }
  return null;
};
const REAL = realCommitLore();

describe.skipIf(REAL === null)("#1268: CommitLore's own one-call commit, through the pinned CLI (real CLI)", () => {
  const realPort = () => {
    const version = execFileSync(REAL as string, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
    return createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, REAL as string, latestRelease(version)));
  };
  const repoWith = async (prefix: string, parent: boolean): Promise<string> => {
    const repo = tempDir(prefix);
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "repo-factory@local"]);
    await git(repo, ["config", "user.name", "Repo Factory"]);
    if (parent) {
      await git(repo, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
    }
    execFileSync("sh", ["-c", "echo approved > README.md && git add README.md"], { cwd: repo, timeout: 20_000 });
    return repo;
  };

  it.each([
    ["a root commit, on an unborn branch", false],
    ["a commit on a parent", true],
  ])("%s: CommitLore makes it with nothing recorded, and binds its consideration to that HEAD", async (_name, parent) => {
    const repo = await repoWith("cl-real-commit-", parent);
    const before = parent ? (await git(repo, ["rev-parse", "HEAD"])).stdout.trim() : null;
    const attempt = await realPort().attempt!(repo, { gitDir: join(repo, ".git"), workTree: repo });
    expect(attempt.allowed, JSON.stringify(attempt)).toBe(true);
    if (!attempt.allowed) return;
    const made = await attempt.value.commitWithoutTranscript({ checkout: repo, message: "repo factory bootstrap", scratch: tempDir("cl-real-message-") });
    expect(made.allowed, JSON.stringify(made)).toBe(true);
    if (!made.allowed) return;
    expect((await git(repo, ["rev-parse", "HEAD"])).stdout.trim()).toBe(made.value);
    const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", made.value])).stdout.trim().split(" ").slice(1);
    expect(parents).toEqual(before === null ? [] : [before]);
    expect((await git(repo, ["log", "-1", "--format=%B", made.value])).stdout.trim()).toBe("repo factory bootstrap");
    const considered = JSON.parse(readFileSync(join(repo, ".git", "commitlore", "considered.json"), "utf8")) as Record<string, unknown>;
    expect(considered).toMatchObject({ outcome: "empty", records: 0, head: before });
  });

  it.each([
    ["a malformed trailer", "Create runnable project\n\nRecord-Id: NOT AN ID", false],
    ["a clean message", "Create runnable project", true],
  ])("review r2 P1: an empty genesis is considered by CommitLore's commit-msg check on its exact message — %s", async (_name, message, passes) => {
    const { result, port } = await emptyGenesis({ observe: async () => PASS, attempt: realPort().attempt! }, message);
    if (passes) {
      expect(result.allowed, result.allowed ? "" : `${result.message} ${JSON.stringify(result.evidence)}`).toBe(true);
      const genesis = (await git(port.bare!, ["rev-parse", "refs/heads/genesis"])).stdout.trim();
      expect((await git(port.bare!, ["rev-list", "--parents", "-n", "1", genesis])).stdout.trim().split(" ").slice(1)).toEqual([port.autoInitHead]);
      expect((await git(port.bare!, ["log", "-1", "--format=%B", genesis])).stdout).not.toContain("Record-Id:");
    } else {
      expect(result, JSON.stringify(result)).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_MESSAGE_REFUSED" } });
      expect((await git(port.bare!, ["rev-parse", "--verify", "-q", "refs/heads/genesis"], { allowFailure: true })).exitCode).not.toBe(0);
    }
  });

  it("an empty commit is not one CommitLore makes: it refuses, and no commit is made", async () => {
    const repo = await repoWith("cl-real-empty-", true);
    await git(repo, ["commit", "-q", "-m", "README"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const attempt = await realPort().attempt!(repo, { gitDir: join(repo, ".git"), workTree: repo });
    if (!attempt.allowed) throw new Error(attempt.message);
    const made = await attempt.value.commitWithoutTranscript({ checkout: repo, message: "nothing staged", scratch: tempDir("cl-real-message-") });
    expect(made).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_COMMIT_REFUSED" } });
    expect((await git(repo, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });
});
