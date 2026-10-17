import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { fileAt } from "../../src/git/git.ts";
import {
  ExactReadRefusal,
  type ExactCommitReaderPorts,
  workflowDigestAtCommit,
} from "../../src/github/workflow-digest-at-commit.ts";
import { WORKFLOW, WORKFLOW_PATH } from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { GitObjectGitHub } from "../helpers/git-object-github.ts";

afterAll(cleanupTempDirs);

/**
 * #512 (v45) witnesses D2-a … D2-e: the exact-commit reader reads one workflow file's bytes at one
 * exact commit object of one exact repository. A tree, a tag, a blob, an abbreviated or uppercase id
 * or a ref is refused; a local object of the wrong type never falls through to GitHub; GitHub's answer
 * must be the same object; the default branch head is recorded as reachability evidence and never read
 * in the commit's place; and a `refs/replace/*` entry never stands in for the object checked or read.
 *
 * RED at A0's head: `src/github/workflow-digest-at-commit.ts` does not exist there, so this file does
 * not load. The general reader's behaviour these replace is shown alongside, through `fileAt`, the
 * local read `workflowDigestAt` uses, which follows a tree, a tag and a replacement alike.
 */

const IDENTITY = "github:acme/fixture";
const PROJECT = "prj_exact_reader";
const ALTERNATE = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo not the approved workflow\n";

const rawGit = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000 });

interface Fixture {
  remote: string;
  local: string;
  github: GitObjectGitHub;
  ports: ExactCommitReaderPorts;
  /** The commit both repositories hold, with the approved workflow bytes. */
  c1: string;
}

/** A remote with the approved workflow at `c1` on `dev`, and a local clone of it registered in PROJECT. */
const fixture = (): Fixture => {
  const remote = makeRepo({ "README.md": "# fixture\n", [WORKFLOW_PATH]: WORKFLOW }, "dev");
  const c1 = gitSync(remote, ["rev-parse", "HEAD"]);
  const local = join(tempDir("acp-v45-local-"), "checkout");
  execFileSync("git", ["clone", "-q", remote, local], { timeout: 30_000 });
  const github = new GitObjectGitHub(remote);
  const ports: ExactCommitReaderPorts = {
    repositories: {
      byIdentity: (identity) => (identity === IDENTITY ? { checkoutPath: local, projectId: PROJECT, registration: "REGISTERED" } : null),
    },
    client: github,
  };
  return { remote, local, github, ports, c1 };
};

const read = (f: Fixture, commitSha: string, path = WORKFLOW_PATH) =>
  workflowDigestAtCommit(f.ports, { repositoryIdentity: IDENTITY, projectId: PROJECT, commitSha, path, defaultBranch: "dev" });

const objectRequests = (f: Fixture): string[] => f.github.requests.filter((request) => /\/git\/(commits|trees|blobs)\//.test(request));

describe("V45 exact-commit reader: the bound commit, read as itself", () => {
  it("reads a local commit with replacement disabled and records the commit and blob it read", async () => {
    const f = fixture();
    const result = await read(f, f.c1);
    expect(result, JSON.stringify(result)).toMatchObject({ allowed: true });
    if (!result.allowed) return;
    expect(result.value).toEqual({
      repositoryIdentity: IDENTITY,
      commitSha: f.c1,
      objectType: "commit",
      blobSha: gitSync(f.remote, ["rev-parse", `${f.c1}:${WORKFLOW_PATH}`]),
      path: WORKFLOW_PATH,
      observedDigest: sha256(WORKFLOW),
      readVia: "LOCAL",
      reachable: "REACHABLE",
      defaultBranch: "dev",
      defaultBranchHead: f.c1,
    });
    // Nothing but the branch head for the evidence was asked of GitHub; only GET, ever.
    expect(objectRequests(f)).toEqual([]);
    expect(f.github.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("reads a commit absent locally from GitHub by object id — commit, trees, blob — never the contents API", async () => {
    const f = fixture();
    writeFiles(f.remote, { "README.md": "# later\n" });
    const c2 = commitAll(f.remote, "later, absent from the checkout");
    const result = await read(f, c2);
    expect(result, JSON.stringify(result)).toMatchObject({
      allowed: true,
      value: { commitSha: c2, readVia: "GITHUB", observedDigest: sha256(WORKFLOW), blobSha: gitSync(f.remote, ["rev-parse", `${c2}:${WORKFLOW_PATH}`]) },
    });
    const tree = gitSync(f.remote, ["rev-parse", `${c2}^{tree}`]);
    expect(objectRequests(f)).toEqual([
      `GET /repos/acme/fixture/git/commits/${c2}`,
      `GET /repos/acme/fixture/git/trees/${tree}`,
      `GET /repos/acme/fixture/git/trees/${gitSync(f.remote, ["rev-parse", `${c2}:.github`])}`,
      `GET /repos/acme/fixture/git/trees/${gitSync(f.remote, ["rev-parse", `${c2}:.github/workflows`])}`,
      `GET /repos/acme/fixture/git/blobs/${gitSync(f.remote, ["rev-parse", `${c2}:${WORKFLOW_PATH}`])}`,
    ]);
    expect(f.github.requests.some((request) => request.includes("/contents/"))).toBe(false);
    expect(f.github.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });
});

describe("D2-a: a tree id is refused, locally and remotely", () => {
  it("locally: cat-file -t says tree, the read is refused and GitHub is never asked for it", async () => {
    const f = fixture();
    const tree = gitSync(f.local, ["rev-parse", `${f.c1}^{tree}`]);
    // What the general reader does with it: `git show <tree>:<path>` hands back the workflow.
    expect(await fileAt(f.local, tree, WORKFLOW_PATH)).toBe(WORKFLOW);
    const result = await read(f, tree);
    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED",
      evidence: { refusal: ExactReadRefusal.OBJECT_NOT_COMMIT, objectType: "tree", readVia: "LOCAL" },
    });
    expect(objectRequests(f)).toEqual([]);
  });

  it("remotely: git/commits/{tree} is not a commit (non-200, or a body without commit fields), so it is refused", async () => {
    const f = fixture();
    writeFiles(f.remote, { "README.md": "# only on the remote\n" });
    const c2 = commitAll(f.remote, "a tree the checkout does not have");
    const tree = gitSync(f.remote, ["rev-parse", `${c2}^{tree}`]);
    expect(await read(f, tree)).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.OBJECT_UNREADABLE, readVia: "GITHUB" } });
    f.github.overrides.set(`/repos/acme/fixture/git/commits/${tree}`, () => ({ sha: tree, tree: [], truncated: false }));
    expect(await read(f, tree)).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.OBJECT_NOT_COMMIT, readVia: "GITHUB" } });
    expect(f.github.requests.some((request) => request.includes("/git/blobs/"))).toBe(false);
  });
});

describe("D2-b: a tag, a blob, an abbreviated or uppercase id is refused; a tag is never dereferenced", () => {
  it("an annotated tag object, locally: cat-file -t says tag, refused, not dereferenced, GitHub not asked", async () => {
    const f = fixture();
    gitSync(f.local, ["tag", "-a", "v1", "-m", "release", f.c1]);
    const tag = gitSync(f.local, ["rev-parse", "refs/tags/v1"]);
    expect(rawGit(f.local, ["cat-file", "-t", tag]).trim()).toBe("tag");
    // The general reader dereferences it.
    expect(await fileAt(f.local, tag, WORKFLOW_PATH)).toBe(WORKFLOW);
    expect(await read(f, tag)).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.OBJECT_NOT_COMMIT, objectType: "tag" } });
    expect(objectRequests(f)).toEqual([]);
  });

  it("an annotated tag object only GitHub holds is not a commit there either", async () => {
    const f = fixture();
    gitSync(f.remote, ["tag", "-a", "v2", "-m", "release", f.c1]);
    const tag = gitSync(f.remote, ["rev-parse", "refs/tags/v2"]);
    expect(await read(f, tag)).toMatchObject({ allowed: false, evidence: { readVia: "GITHUB" } });
    expect(f.github.requests.some((request) => request.includes("/git/trees/") || request.includes("/git/blobs/"))).toBe(false);
  });

  it("a blob id, an abbreviated id, an uppercase id and a ref name are refused", async () => {
    const f = fixture();
    const blob = gitSync(f.local, ["rev-parse", `${f.c1}:${WORKFLOW_PATH}`]);
    expect(await read(f, blob)).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.OBJECT_NOT_COMMIT, objectType: "blob" } });
    for (const name of [f.c1.slice(0, 12), f.c1.toUpperCase(), "dev", "HEAD", `${f.c1}^{commit}`, `${f.c1}~0`]) {
      expect(await read(f, name), name).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.COMMIT_SHA_MALFORMED } });
    }
    expect(f.github.requests).toEqual([]);
  });
});

describe("D2-c: the same object across every step; the default head is never substituted", () => {
  it("GitHub answering with another object than the one asked for is refused", async () => {
    const f = fixture();
    writeFiles(f.remote, { "README.md": "# only on the remote\n" });
    const c2 = commitAll(f.remote, "absent locally");
    f.github.overrides.set(`/repos/acme/fixture/git/commits/${c2}`, () => ({
      sha: f.c1,
      tree: { sha: gitSync(f.remote, ["rev-parse", `${f.c1}^{tree}`]) },
      parents: [],
    }));
    expect(await read(f, c2)).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.SHA_MISMATCH, answeredSha: f.c1 } });
  });

  it("a newer default head with identical bytes is evidence only: the bound commit is what is read and recorded", async () => {
    const f = fixture();
    writeFiles(f.remote, { "README.md": "# newer head, same workflow bytes\n" });
    const head = commitAll(f.remote, "newer head");
    const result = await read(f, f.c1);
    expect(result).toMatchObject({
      allowed: true,
      value: { commitSha: f.c1, readVia: "LOCAL", defaultBranchHead: head, reachable: "REACHABLE", observedDigest: sha256(WORKFLOW) },
    });
    expect(objectRequests(f)).toEqual([]);

    // A bound commit nobody holds is refused, even though the head carries the approved bytes.
    const unknown = "0123456789abcdef0123456789abcdef01234567";
    expect(await read(f, unknown)).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.OBJECT_UNREADABLE } });
    expect(f.github.requests.some((request) => request.includes(head) && /git\/(trees|blobs|commits)/.test(request))).toBe(false);
  });

  it("a bound commit the default head does not reach is read and recorded NOT_REACHABLE, and an unreadable head is UNKNOWN; neither refuses", async () => {
    const f = fixture();
    gitSync(f.remote, ["checkout", "-q", "-b", "side"]);
    writeFiles(f.remote, { "README.md": "# side\n" });
    const side = commitAll(f.remote, "side, never merged");
    gitSync(f.remote, ["checkout", "-q", "dev"]);
    writeFiles(f.remote, { "README.md": "# dev moves on\n" });
    commitAll(f.remote, "dev");
    expect(await read(f, side)).toMatchObject({ allowed: true, value: { commitSha: side, reachable: "NOT_REACHABLE", readVia: "GITHUB" } });
    f.github.overrides.set("/repos/acme/fixture/git/ref/heads/dev", () => {
      throw new Error("GitHub 500");
    });
    expect(await read(f, f.c1)).toMatchObject({ allowed: true, value: { commitSha: f.c1, reachable: "UNKNOWN", defaultBranchHead: null } });
  });

  it("the repository must be REGISTERED in the run's project, and the path a file of plain segments", async () => {
    const f = fixture();
    const elsewhere: ExactCommitReaderPorts = {
      ...f.ports,
      repositories: { byIdentity: () => ({ checkoutPath: f.local, projectId: "another", registration: "REGISTERED" }) },
    };
    expect(await workflowDigestAtCommit(elsewhere, { repositoryIdentity: IDENTITY, projectId: PROJECT, commitSha: f.c1, path: WORKFLOW_PATH, defaultBranch: "dev" }))
      .toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.REPOSITORY_NOT_REGISTERED } });
    const temporary: ExactCommitReaderPorts = {
      ...f.ports,
      repositories: { byIdentity: () => ({ checkoutPath: f.local, projectId: PROJECT, registration: "TEMPORARY" }) },
    };
    expect(await workflowDigestAtCommit(temporary, { repositoryIdentity: IDENTITY, projectId: PROJECT, commitSha: f.c1, path: WORKFLOW_PATH, defaultBranch: "dev" }))
      .toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.REPOSITORY_NOT_REGISTERED } });
    for (const path of ["../ci.yml", "/.github/workflows/ci.yml", ".github//workflows/ci.yml", "./.github/workflows/ci.yml"]) {
      expect(await read(f, f.c1, path), path).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.PATH_MALFORMED } });
    }
    expect(await read(f, f.c1, ".github/workflows")).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.PATH_NOT_BLOB, pathType: "tree" } });
    expect(await read(f, f.c1, ".github/workflows/absent.yml")).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.PATH_NOT_BLOB } });
  });
});

describe("D2-d / D2-e: a refs/replace entry never stands in for the object checked or read", () => {
  it("D2-d: a tree replaced by a commit with the approved bytes is still a tree, and refused", async () => {
    const f = fixture();
    // The bound id is a tree whose workflow is NOT the approved one …
    writeFiles(f.local, { [WORKFLOW_PATH]: ALTERNATE });
    const other = commitAll(f.local, "a tree with other bytes");
    const tree = gitSync(f.local, ["rev-parse", `${other}^{tree}`]);
    // … and refs/replace/<tree> points at a commit whose workflow is.
    gitSync(f.local, ["update-ref", `refs/replace/${tree}`, f.c1]);
    expect(rawGit(f.local, ["cat-file", "-t", tree]).trim()).toBe("commit");
    expect(await fileAt(f.local, tree, WORKFLOW_PATH)).toBe(WORKFLOW);

    const result = await read(f, tree);
    expect(result).toMatchObject({ allowed: false, evidence: { refusal: ExactReadRefusal.OBJECT_NOT_COMMIT, objectType: "tree" } });
    expect(JSON.stringify(result)).not.toContain(sha256(WORKFLOW));
    expect(objectRequests(f)).toEqual([]);
  });

  it("D2-e: a commit replaced by one with the approved bytes is read as the original, whose digest does not match", async () => {
    const f = fixture();
    writeFiles(f.local, { [WORKFLOW_PATH]: ALTERNATE });
    const original = commitAll(f.local, "the bound commit, with other workflow bytes");
    gitSync(f.local, ["update-ref", `refs/replace/${original}`, f.c1]);
    // Today's reader follows the replacement and returns the approved bytes.
    expect(await fileAt(f.local, original, WORKFLOW_PATH)).toBe(WORKFLOW);
    expect(rawGit(f.local, ["cat-file", "blob", `${original}:${WORKFLOW_PATH}`])).toBe(WORKFLOW);

    const result = await read(f, original);
    expect(result).toMatchObject({
      allowed: true,
      value: {
        commitSha: original,
        readVia: "LOCAL",
        observedDigest: sha256(ALTERNATE),
        blobSha: rawGit(f.local, ["--no-replace-objects", "rev-parse", `${original}:${WORKFLOW_PATH}`]).trim(),
      },
    });
    // What a first activation compares: the original's bytes against the approved digest — a mismatch.
    if (result.allowed) expect(result.value.observedDigest).not.toBe(sha256(WORKFLOW));
  });
});
