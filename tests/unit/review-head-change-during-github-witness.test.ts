/* eslint-disable no-console -- direct review witness */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  plannedBootstrapFiles,
  produceRepoFactoryResult,
  repositoryCheckoutPath,
  type PlannedBootstrapFile,
  type RepoFactoryPlanFixture,
} from "../../src/bootstrap/repo-factory-producer.ts";
import { git } from "../../src/git/git.ts";
import { FakeGitHub, type Protection } from "../helpers/fake-github-write-port.ts";

/**
 * Issue #246 PR-C, review round 1 (RF-REVIEW-01) — a produced tree that is not the approved files
 * is refused before anything reaches GitHub.
 *
 * The drift check used to run after the GitHub operations, so the branch operation pushed a commit
 * nobody had compared with the approved files: a refusal that came after the repository was created,
 * the unreviewed bytes pushed, the default branch set and the branch protected undoes none of it. The
 * GitHub here is the bare-repository double (`tests/helpers/fake-github-write-port.ts`), so "pushed"
 * means a real ref in a real repository and `writes` counts every write the producer made.
 *
 * Three paths reach the branch operation with a head: the first push of the commit this run made; a
 * resumed push, where the receipted head GitHub already holds is fetched and checked out; and a push
 * whose answer was lost, adopted by the head the ledger recorded before it. Each head is compared
 * with the approved files before the next write.
 */

const roots: string[] = [];
const realHome = process.env["HOME"];
afterEach(async () => {
  process.env["HOME"] = realHome;
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** A HOME whose git configuration runs `hook` before every commit. Null installs no hook. */
const homeWithHook = (hook: string | null): void => {
  const home = mkdtempSync(join(tmpdir(), "acp-rf01-home-"));
  roots.push(home);
  if (hook !== null) {
    const hooks = join(home, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nset -e\n${hook}\n`);
    chmodSync(join(hooks, "pre-commit"), 0o755);
    writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
  }
  process.env["HOME"] = home;
};

/** A HOME whose git configuration runs `script` after every commit. */
const homeWithPostCommit = (script: string): void => {
  const home = mkdtempSync(join(tmpdir(), "acp-rf04-home-"));
  roots.push(home);
  const hooks = join(home, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\nset -e\n${script}\n`);
  chmodSync(join(hooks, "post-commit"), 0o755);
  writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
  process.env["HOME"] = home;
};

const sandbox = (): { workDir: string; github: FakeGitHub } => {
  const root = mkdtempSync(join(tmpdir(), "acp-rf01-github-"));
  roots.push(root);
  return { workDir: join(root, "workdir"), github: new FakeGitHub(root) };
};

const IDENTITY = "github:acme/fixture";
const PROTECTION: Protection = {
  requiredStatusChecks: { strict: true, contexts: ["project-ci"] },
  enforceAdmins: true,
  requiredApprovingReviewCount: null,
  allowForcePushes: false,
  allowDeletions: false,
};

const operations = () => [
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
    desiredState: PROTECTION,
  },
];

const PLAN = {
  runId: "run_rf_review_01",
  bootstrapOperationId: "bootstrap_rf_review_01",
  requestDigest: "sha256:" + "a".repeat(64),
  planDigest: "sha256:" + "b".repeat(64),
  projectManifestDigest: "sha256:" + "c".repeat(64),
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: "local-clean-tree",
  verificationKind: "CLEAN_TREE",
  githubOperations: operations(),
} as unknown as RepoFactoryPlanFixture;

const AUTHORITY = {
  owner: "acme",
  visibility: "public",
  approvedOperations: operations().map(({ operationId, resourceType, resourceIdentity }) => ({
    operationId,
    resourceType,
    resourceIdentity,
  })),
};

const APPROVED = plannedBootstrapFiles(PLAN);
/** Another approved file set: what an earlier attempt of the same operation was told to commit. */
const APPROVED_WITH_SECOND: PlannedBootstrapFile[] = [...APPROVED, { path: "SECOND.md", mode: "100644", content: "second\n" }];

const produce = (workDir: string, github: FakeGitHub, approvedFiles: readonly PlannedBootstrapFile[], at = "2026-10-09T00:00:00.000Z") =>
  produceRepoFactoryResult({
    plan: PLAN,
    workDir,
    clock: new ManualClock(at),
    github: { port: github, authority: AUTHORITY },
    approvedFiles,
  } as Parameters<typeof produceRepoFactoryResult>[0]);

const ledgerPath = (workDir: string): string => join(workDir, "github-ledger", "primary.json");

/** The paths the double's `main` holds, read from the bare repository itself. */
const remoteFiles = async (github: FakeGitHub): Promise<string[]> => {
  const remote = github.repository("acme", "fixture");
  if (!remote) throw new Error("the double holds no repository");
  const listed = await git(remote.bare, ["ls-tree", "-r", "--name-only", "refs/heads/main"]);
  return listed.stdout.split("\n").filter((line) => line.length > 0).sort();
};

describe("RF-REVIEW-01: a drifted tree is refused before any GitHub write", () => {
  it("control: with no hook the same plan is produced, and GitHub holds exactly the approved file", async () => {
    homeWithHook(null);
    const { workDir, github } = sandbox();
    const produced = await produce(workDir, github, APPROVED);
    expect(produced, JSON.stringify(produced)).toMatchObject({ allowed: true });
    expect(github.writes.map((write) => write.method)).toEqual(["createRepository", "pushBranch", "setDefaultBranch", "protectBranch"]);
    expect(await remoteFiles(github)).toEqual([".repo-factory-bootstrap.json"]);
  });

  it("a pre-commit hook that adds PRIVATE.txt is refused BOOTSTRAP_CONTRACT_DRIFT with zero GitHub writes, no repository and no ledger", async () => {
    homeWithHook("printf 'unreviewed private bytes\\n' > PRIVATE.txt\ngit add PRIVATE.txt");
    const { workDir, github } = sandbox();
    const produced = await produce(workDir, github, APPROVED);
    expect(produced).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: { refusal: "BOOTSTRAP_CONTRACT_DRIFT", missing: [], extra: ["PRIVATE.txt"], changed: [] },
    });
    // Not a write, not a read: the drifted commit never reached the port.
    expect(github.writes).toEqual([]);
    expect(github.reads).toEqual([]);
    expect(github.repository("acme", "fixture")).toBeUndefined();
    expect(existsSync(ledgerPath(workDir))).toBe(false);
    expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);
  });

  it("a resumed push whose receipted head is not the approved files is refused after the fetch and reset, before any further write", async () => {
    homeWithHook(null);
    const { workDir, github } = sandbox();
    // The first attempt was approved two files, created the repository, pushed them and stopped at
    // the default-branch setting: a refusal a retry resumes from.
    github.failNext = "setDefaultBranch";
    const first = await produce(workDir, github, APPROVED_WITH_SECOND);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { refusal: "REMOTE_REFUSED", resumable: true } });
    expect(github.writes.map((write) => write.method)).toEqual(["createRepository", "pushBranch", "setDefaultBranch"]);
    expect(await remoteFiles(github)).toEqual([".repo-factory-bootstrap.json", "SECOND.md"]);
    const ledgerBefore = readFileSync(ledgerPath(workDir), "utf8");

    // The retry is approved one file. Its own commit is that file exactly, so the check before the
    // GitHub operations passes; the head GitHub holds — fetched and checked out — is not.
    github.writes.length = 0;
    const retry = await produce(workDir, github, APPROVED, "2026-10-09T00:05:00.000Z");
    expect(github.writes).toEqual([]);
    expect(retry).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: {
        refusal: "BOOTSTRAP_CONTRACT_DRIFT",
        failedOperationId: "push-default-branch:fixture",
        extra: ["SECOND.md"],
        resumable: false,
        rollback: "none",
      },
    });
    expect(github.reads).toContain("fetch acme/fixture#main");
    expect(github.repository("acme", "fixture")?.protections.size).toBe(0);
    // The ledger is what it was: nothing was receipted on the strength of the drifted head.
    expect(readFileSync(ledgerPath(workDir), "utf8")).toBe(ledgerBefore);
    expect(existsSync(repositoryCheckoutPath(workDir, "primary"))).toBe(false);
  });

  it("a push whose answer was lost, adopted by its recorded head, is refused when that head is not the approved files, before any further write", async () => {
    homeWithHook(null);
    const { workDir, github } = sandbox();
    github.failAfter = { method: "pushBranch", mode: "response" };
    const first = await produce(workDir, github, APPROVED_WITH_SECOND);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { refusal: "REMOTE_REFUSED", resumable: true } });
    expect(github.writes.map((write) => write.method)).toEqual(["createRepository", "pushBranch"]);
    expect(await remoteFiles(github)).toEqual([".repo-factory-bootstrap.json", "SECOND.md"]);
    const ledgerBefore = readFileSync(ledgerPath(workDir), "utf8");

    github.writes.length = 0;
    const retry = await produce(workDir, github, APPROVED, "2026-10-09T00:05:00.000Z");
    expect(github.writes).toEqual([]);
    expect(retry).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: {
        refusal: "BOOTSTRAP_CONTRACT_DRIFT",
        failedOperationId: "push-default-branch:fixture",
        extra: ["SECOND.md"],
        resumable: false,
      },
    });
    expect(github.repository("acme", "fixture")?.protections.size).toBe(0);
    expect(readFileSync(ledgerPath(workDir), "utf8")).toBe(ledgerBefore);
  });

  it("a resumed push whose receipted head a local replacement makes read as the approved files is refused after the fetch, before any further write (RF-REVIEW-04)", async () => {
    homeWithHook(null);
    const { workDir, github } = sandbox();
    github.failNext = "setDefaultBranch";
    const first = await produce(workDir, github, APPROVED_WITH_SECOND);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { refusal: "REMOTE_REFUSED", resumable: true } });
    const remote = github.repository("acme", "fixture");
    if (!remote) throw new Error("the double holds no repository");
    const pushed = (await git(remote.bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
    expect(await remoteFiles(github)).toEqual([".repo-factory-bootstrap.json", "SECOND.md"]);

    // The retry's own commit is the one approved file. After it, a hook points a replacement for the
    // head GitHub holds at a commit of that approved tree: once fetched, the head reads locally as
    // the approved files, and GitHub still holds SECOND.md.
    homeWithPostCommit(
      [
        'approved=$(git rev-parse "HEAD^{tree}")',
        'replacement=$(git -c user.name=review -c user.email=review@example.invalid commit-tree "$approved" -m approved-replacement)',
        `git update-ref refs/replace/${pushed} "$replacement"`,
      ].join("\n"),
    );
    github.writes.length = 0;
    const retry = await produce(workDir, github, APPROVED, "2026-10-09T00:05:00.000Z");
    expect(github.writes).toEqual([]);
    expect(retry).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: {
        refusal: "BOOTSTRAP_CONTRACT_DRIFT",
        failedOperationId: "push-default-branch:fixture",
        head: pushed,
        extra: ["SECOND.md"],
        resumable: false,
      },
    });
    expect(github.repository("acme", "fixture")?.protections.size).toBe(0);
  });
});


describe("RF-REVIEW-01: the validated HEAD is the HEAD published", () => {
  it("does not push unapproved bytes if HEAD moves while GitHub repository creation is awaited", async () => {
    homeWithHook(null);
    const { workDir, github } = sandbox();
    const checkout = repositoryCheckoutPath(workDir, "primary");
    const create = github.createRepository.bind(github);
    let validatedHead = "";
    let movedHead = "";
    // A timing seam: the producer has validated its initial commit, then waits for GitHub.
    // A local writer advances HEAD during that wait. All commits and the remote push are real Git.
    github.createRepository = async (...args) => {
      validatedHead = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
      const result = await create(...args);
      writeFileSync(join(checkout, "PRIVATE.txt"), "unreviewed private bytes\n");
      await git(checkout, ["add", "PRIVATE.txt"]);
      await git(checkout, ["-c", "user.name=review", "-c", "user.email=review@example.invalid", "commit", "-q", "-m", "concurrent unapproved change"]);
      movedHead = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
      return result;
    };
    const result = await produce(workDir, github, APPROVED);
    const remote = github.repository("acme", "fixture");
    const remotePrivate = remote ? await git(remote.bare, ["show", "refs/heads/main:PRIVATE.txt"], { allowFailure: true }) : null;
    console.log("HEAD-change witness", JSON.stringify({ validatedHead, movedHead, result, writes: github.writes, remotePrivate }));
    expect(validatedHead).not.toBe(movedHead);
    // Refusal or publication of the pinned, validated commit are both safe outcomes.
    expect(remotePrivate?.exitCode).not.toBe(0);
    if (remote) {
      const pushed = await git(remote.bare, ["rev-parse", "--verify", "refs/heads/main"], { allowFailure: true });
      if (pushed.exitCode === 0) expect(pushed.stdout.trim()).toBe(validatedHead);
    }
  });
});
