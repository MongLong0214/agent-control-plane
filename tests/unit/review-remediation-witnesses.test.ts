/* eslint-disable @typescript-eslint/no-unused-vars, no-console -- the reviewer's preserved witness, copied unchanged below this line */
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


describe("RF-REVIEW-01 replacement-ref sibling", () => {
  it("refuses an unapproved commit whose original tree is hidden by a local replacement before publication", async () => {
    homeWithHook("printf 'unreviewed private bytes\\n' > PRIVATE.txt\ngit add PRIVATE.txt");
    const hooks = join(process.env["HOME"]!, "hooks");
    writeFileSync(join(hooks, "post-commit"), [
      "#!/bin/sh",
      "set -e",
      "original=$(git rev-parse HEAD)",
      "git rm -q --cached PRIVATE.txt",
      "approved=$(git write-tree)",
      'replacement=$(git -c user.name=review -c user.email=review@example.invalid commit-tree "$approved" -m approved-replacement)',
      'git replace "$original" "$replacement"',
      "git reset -q --hard HEAD",
      "rm -f PRIVATE.txt",
      "",
    ].join("\n"), { mode: 0o755 });
    const { workDir, github } = sandbox();
    const produced = await produce(workDir, github, APPROVED);
    const remote = github.repository("acme", "fixture");
    const remotePrivate = remote ? await git(remote.bare, ["show", "refs/heads/main:PRIVATE.txt"], { allowFailure: true }) : null;
    const checkout = repositoryCheckoutPath(workDir, "primary");
    const localResolved = existsSync(checkout) ? await git(checkout, ["ls-tree", "-r", "--name-only", "HEAD"]) : null;
    const localOriginal = existsSync(checkout) ? await git(checkout, ["--no-replace-objects", "ls-tree", "-r", "--name-only", "HEAD"]) : null;
    console.log("replacement witness", JSON.stringify({
      allowed: produced.allowed,
      reasonCode: produced.reasonCode,
      verification: produced.allowed ? produced.value.bootstrapVerification : null,
      writes: github.writes.map((write) => write.method),
      remotePrivate,
      localResolved,
      localOriginal,
    }));
    expect(github.writes).toEqual([]);
    expect(produced).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT });
  });
});
