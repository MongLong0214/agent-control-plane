import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { describe, it, expect, afterEach } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import {
  judgeDirectoryOwnership,
  produceRepoFactoryResult,
  repositoryCheckoutPath,
  trackedFilesOrDeny,
  VERIFICATION_KINDS,
  type RepoFactoryPlanFixture,
} from "../../src/bootstrap/repo-factory-producer.ts";
import { git } from "../../src/git/git.ts";

/**
 * Issue #246 — the control plane's half of the bootstrap contract (repo-factory-result.ts)
 * has existed with nothing producing it; every test handed the parser a hand-written
 * fixture. These tests build a real local filesystem/git producer and prove its output
 * — never a hand-authored RepoFactoryResult — satisfies the real parser.
 *
 * CEO review round 3 added three attacks, executed and confirmed against a real run:
 *   1. `verificationArgs` was arbitrary argv; `["-C", <outside>, "init", "-b", "pwn"]`
 *      overrode the trusted `-C <localRepoPath>` and wrote a real `.git` outside `workDir`.
 *   2. `local-clean-tree` (`git status --porcelain`) exits 0 whether or not the tree is
 *      dirty; the producer's own untracked ownership marker made every "clean" receipt a
 *      provable lie.
 *   3. Every operation after the one containment check at the top passed a bare pathname
 *      straight through, so a symlink swapped in afterward was silently followed.
 */

const sandboxes: string[] = [];

const makeSandbox = (): { sandbox: string; workDir: string } => {
  const sandbox = mkdtempSync(join(tmpdir(), "acp-246-producer-"));
  sandboxes.push(sandbox);
  const workDir = join(sandbox, "workdir");
  return { sandbox, workDir };
};

afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const basePlan = (): RepoFactoryPlanFixture => ({
  runId: "run_bootstrap_246",
  bootstrapOperationId: "bootstrap_246",
  requestDigest: "sha256:" + "a".repeat(64),
  planDigest: "sha256:" + "b".repeat(64),
  projectManifestDigest: "sha256:" + "c".repeat(64),
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: "local-clean-tree",
  verificationKind: "CLEAN_TREE",
  githubOperations: [],
});

describe("repo factory producer (#246)", () => {
  it("produces a RepoFactoryResult — never hand-written — that the real parser accepts", async () => {
    const { workDir } = makeSandbox();
    const produced = await produceRepoFactoryResult({
      plan: basePlan(),
      workDir,
      clock: new ManualClock("2026-08-23T00:00:00.000Z"),
    });

    expect(produced.allowed).toBe(true);
    if (!produced.allowed) return;

    const parsed = parseRepoFactoryResult(produced.value);
    expect(parsed.allowed).toBe(true);

    expect(produced.value.repositories).toHaveLength(1);
    expect(produced.value.externalWriteReceipts).toHaveLength(1);
    expect(produced.value.bootstrapVerification).toHaveLength(1);
    expect(produced.value.bootstrapVerification[0]?.exactHead).toMatch(/^[0-9a-f]{40}$/);
    expect(produced.value.ciEvidence).toEqual([]);
    expect(produced.value.unresolvedGaps).toEqual([]);
  });

  it("the produced repository's working tree is really clean, verified with a real `git status`, not just the receipt's own claim", async () => {
    const { workDir } = makeSandbox();
    const produced = await produceRepoFactoryResult({ plan: basePlan(), workDir });
    expect(produced.allowed).toBe(true);
    if (!produced.allowed) return;

    const checkoutPath = produced.value.repositories[0]?.proposedCheckoutPath;
    expect(checkoutPath).toBeTruthy();
    if (!checkoutPath) return;
    // The ownership marker is deliberately never committed, so it would show as untracked
    // to a plain `git status` if it were not excluded via `.git/info/exclude` (CEO review
    // round 3, defect 2). This is the real, external command — not the producer's own judge.
    const status = execFileSync("git", ["-C", checkoutPath, "status", "--porcelain"], { encoding: "utf8" });
    expect(status).toBe("");
    expect(existsSync(join(checkoutPath, ".repo-factory-operation.json"))).toBe(true);
  });

  it("is rejected by the real overclaim check when a forbidden activation claim is added to genuine producer output", async () => {
    const { workDir } = makeSandbox();
    const produced = await produceRepoFactoryResult({
      plan: basePlan(),
      workDir,
      clock: new ManualClock("2026-08-23T00:00:00.000Z"),
    });
    expect(produced.allowed).toBe(true);
    if (!produced.allowed) return;

    const overclaiming = { ...produced.value, activity: "ACTIVE" };
    const parsed = parseRepoFactoryResult(overclaiming);
    expect(parsed.allowed).toBe(false);
    if (parsed.allowed) return;
    expect(parsed.reasonCode).toBe(ReasonCode.BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION);
  });

  it("refuses a plan that requires a GitHub write instead of fabricating a receipt for one", async () => {
    const { workDir } = makeSandbox();
    const plan: RepoFactoryPlanFixture = {
      ...basePlan(),
      githubOperations: [
        { operationId: "repo-create", resourceType: "repository", resourceIdentity: "github:acme/repo" },
      ],
    };
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
    // Refusing before ever touching the filesystem — no local checkout was fabricated either.
    expect(existsSync(repositoryCheckoutPath(workDir, plan.repositoryRole))).toBe(false);
  });

  describe("CEO review round 3, defect 1 — verification argv injection (`-C` override)", () => {
    it("the plan schema has no argv field left to inject through — an old-shaped attack plan is rejected outright", async () => {
      const { sandbox, workDir } = makeSandbox();
      const outsideTarget = join(sandbox, "outside-target");
      mkdirSync(outsideTarget, { recursive: true });
      // The exact attack CEO ran, reconstructed against the fixed schema: `verificationArgs`
      // no longer exists as a field at all, so `.strict()` rejects the unrecognized key
      // before any git call happens.
      const attackPlan = {
        ...basePlan(),
        verificationArgs: ["-C", outsideTarget, "init", "-b", "pwn"],
      } as unknown as RepoFactoryPlanFixture;

      const produced = await produceRepoFactoryResult({ plan: attackPlan, workDir });
      expect(produced.allowed).toBe(false);
      if (produced.allowed) return;
      expect(produced.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
      // The attack's actual objective — a `.git` created outside workDir — never happened.
      expect(readdirSync(outsideTarget)).toEqual([]);
    });

    it("demonstrates the underlying vulnerability class directly: a bare pathname-based git call follows a swap, which is exactly why argv can never be allowed to name a second target", async () => {
      const { sandbox } = makeSandbox();
      const real = join(sandbox, "real");
      const elsewhere = join(sandbox, "elsewhere");
      mkdirSync(real, { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      // Simulates the exact attack shape: the trusted `-C <real>` is followed by argv that
      // itself contains a second `-C`, which git resolves last-wins.
      const result = await git(real, ["-C", elsewhere, "init", "-b", "pwn"], { allowFailure: true });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(elsewhere, ".git"))).toBe(true);
    });
  });

  describe("CEO review round 3, defect 2 — a verification that could not fail", () => {
    it("CLEAN_TREE denies a real exit-0 result whose stdout reports a dirty tree, not just a non-zero exit code", () => {
      const dirty = VERIFICATION_KINDS.CLEAN_TREE.judge({
        exitCode: 0,
        stdout: "?? .repo-factory-operation.json\n",
        stderr: "",
      });
      expect(dirty.allowed).toBe(false);

      const clean = VERIFICATION_KINDS.CLEAN_TREE.judge({ exitCode: 0, stdout: "", stderr: "" });
      expect(clean.allowed).toBe(true);

      const failed = VERIFICATION_KINDS.CLEAN_TREE.judge({ exitCode: 128, stdout: "", stderr: "fatal" });
      expect(failed.allowed).toBe(false);
    });
  });

  /**
   * CEO review round 3's fix re-verified the checkout path's device+inode identity
   * immediately before every subsequent operation (`anchorDirectory` + `assertStillAnchored`,
   * wired through `gitAnchored`/`writeFileAnchored`). CEO's round 4 verdict was that this
   * shrinks a check-then-act window rather than closing it, and demonstrated it directly by
   * composing the exact same exported primitives `gitAnchored` used internally, with a real
   * symlink swap injected in the reproduction's own code strictly between them:
   *
   *   anchorDirectory(real)                                   // "the check" — passes
   *   assertStillAnchored(anchored.value)                     // passes: allowed === true
   *   rmSync(real, ...); symlinkSync(elsewhere, real);         // "the swap", injected here,
   *                                                             //   strictly after the check
   *   await git(anchored.value.path, ["init", "-b", "pwn"])    // "the use" — followed it
   *
   * Observed against commit 94dc8f2: `git init exitCode: 0`, and `.git` created inside
   * `elsewhere` — the swapped-to directory, not `real`. That reproduction is the RED this
   * defect was reopened for.
   *
   * `anchorDirectory`/`assertStillAnchored`/`gitAnchored`/`writeFileAnchored` were removed
   * entirely rather than patched — no amount of re-checking closes a check-then-act race,
   * only removing the actor who could win it does. `assertParentChainNotAttackerWritable`
   * below is that removal: a directory-ownership/permission precondition, verified once
   * (not race-prone — see the function's own doc comment for why), tested here.
   */
  describe("CEO review round 4, defect 3 — a real close, not a smaller race window", () => {
    it("judgeDirectoryOwnership refuses a directory writable by another user or group, even one this process owns", () => {
      const myUid = process.getuid ? process.getuid() : 0;
      const worldWritable = judgeDirectoryOwnership("/some/dir", { uid: myUid, mode: 0o40777 }, myUid);
      expect(worldWritable.allowed).toBe(false);

      const groupWritable = judgeDirectoryOwnership("/some/dir", { uid: myUid, mode: 0o40775 }, myUid);
      expect(groupWritable.allowed).toBe(false);

      const safe = judgeDirectoryOwnership("/some/dir", { uid: myUid, mode: 0o40755 }, myUid);
      expect(safe.allowed).toBe(true);
    });

    it("judgeDirectoryOwnership refuses a directory owned by a different account regardless of its permission bits", () => {
      // A real directory owned by a different uid cannot be created in a test sandbox
      // without root, so this exercises the exact decision function
      // `assertParentChainNotAttackerWritable` calls, with the exact `{ uid, mode }` shape
      // `fs.Stats` carries.
      const notMine = judgeDirectoryOwnership("/some/dir", { uid: 0, mode: 0o40700 }, 501);
      expect(notMine.allowed).toBe(false);
    });

    it("refuses to operate when a directory between workDir and the checkout is writable by another user or group — real and deterministic, no race required", async () => {
      const { workDir } = makeSandbox();
      mkdirSync(workDir, { recursive: true });
      const repositoriesDir = join(workDir, "repositories");
      mkdirSync(repositoriesDir, { recursive: true });
      chmodSync(repositoriesDir, 0o777);

      const produced = await produceRepoFactoryResult({ plan: basePlan(), workDir });
      expect(produced.allowed).toBe(false);
      // Refusing before ever creating the checkout — the unsafe directory is left exactly as
      // found, not silently written into anyway.
      expect(existsSync(join(repositoriesDir, "primary"))).toBe(false);
    });
  });

  it("refuses to overwrite or silently resume a preexisting same-named local checkout", async () => {
    const { workDir } = makeSandbox();
    const plan = basePlan();
    const checkoutPath = repositoryCheckoutPath(workDir, plan.repositoryRole);
    mkdirSync(dirname(checkoutPath), { recursive: true });
    writeFileSync(checkoutPath, "collision", { flag: "wx" });
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
  });

  it("rejects a repository role that would escape the given work directory", async () => {
    const { workDir } = makeSandbox();
    const plan: RepoFactoryPlanFixture = { ...basePlan(), repositoryRole: "../../etc" };
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
  });

  it("rejects a repository role that is not kebab-case even when it never escapes the work directory", async () => {
    // "Primary_Role" is not path-shaped at all — `repositoryCheckoutPath` joins it straight
    // onto workDir with no escape, so the realpath containment check alone would let it
    // through. Only the plan schema's own kebab-case format rule stands here.
    const { workDir } = makeSandbox();
    const plan: RepoFactoryPlanFixture = { ...basePlan(), repositoryRole: "Primary_Role" };
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
  });

  it("refuses when an existing path component between the work directory and the checkout escapes it via a symlink", async () => {
    const { sandbox, workDir } = makeSandbox();
    mkdirSync(workDir, { recursive: true });
    const outsideTarget = join(sandbox, "outside-target");
    mkdirSync(outsideTarget, { recursive: true });
    // The leaf ("primary") does not exist yet — only "repositories" is planted, and it is a
    // symlink to a directory outside workDir. A lexical-only check that only compares
    // `resolve()`d strings cannot see this; the escape is real only once symlinks resolve.
    symlinkSync(outsideTarget, join(workDir, "repositories"));

    const plan = basePlan();
    const produced = await produceRepoFactoryResult({ plan, workDir });
    expect(produced.allowed).toBe(false);
    // Nothing was ever written through the symlink into the real outside directory.
    expect(readdirSync(outsideTarget)).toEqual([]);
  });

  it("cleans up its own newly-created checkout on failure so the exact same operation can retry", async () => {
    const { workDir } = makeSandbox();
    const failingPlan: RepoFactoryPlanFixture = {
      ...basePlan(),
      // A real, deterministically-failing `git init -b <name>`: consecutive dots are not a
      // valid ref name component.
      defaultBranch: "bad..branch",
    };
    const firstAttempt = await produceRepoFactoryResult({ plan: failingPlan, workDir });
    expect(firstAttempt.allowed).toBe(false);
    // The failed attempt must not leave permanent collision residue behind — otherwise the
    // existsSync collision check refuses every future retry of this exact same operation.
    expect(existsSync(repositoryCheckoutPath(workDir, failingPlan.repositoryRole))).toBe(false);

    const retryPlan: RepoFactoryPlanFixture = { ...failingPlan, defaultBranch: "main" };
    const retried = await produceRepoFactoryResult({ plan: retryPlan, workDir });
    expect(retried.allowed).toBe(true);
  });

  it("does not build a verified receipt on top of a tracked-file listing that genuinely failed", () => {
    // Forcing `git ls-tree` itself to fail at exactly that point in a real repository is not
    // reliably reproducible without corrupting the process's own working tree mid-run, so
    // this exercises the exact exported decision function `produceRepoFactoryResult` calls
    // with the exact shape `git()` returns — the same entry point production uses, not a
    // different layer standing in for it.
    const failed = trackedFilesOrDeny({ stdout: "", stderr: "fatal: not a tree object", exitCode: 128 });
    expect(failed.allowed).toBe(false);

    const passed = trackedFilesOrDeny({ stdout: "a.txt\nb.txt\n", stderr: "", exitCode: 0 });
    expect(passed.allowed).toBe(true);
    if (!passed.allowed) return;
    expect(passed.value).toEqual(["a.txt", "b.txt"]);
  });

  it("writes only inside the given work directory and nothing outside it", async () => {
    const { sandbox, workDir } = makeSandbox();
    const outsideMarker = join(sandbox, "outside.txt");
    writeFileSync(outsideMarker, "sentinel");

    const produced = await produceRepoFactoryResult({ plan: basePlan(), workDir });
    expect(produced.allowed).toBe(true);

    expect(readFileSync(outsideMarker, "utf8")).toBe("sentinel");
    expect(readdirSync(sandbox).sort()).toEqual(["outside.txt", "workdir"].sort());
    if (!produced.allowed) return;
    const proposedPath = produced.value.repositories[0]?.proposedCheckoutPath;
    expect(proposedPath).toBeTruthy();
    expect(proposedPath?.startsWith(workDir)).toBe(true);
  });
});
