import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  type BranchObjects,
  DEFAULT_BRANCH_PUBLISH_LIMITS,
  collectBranchObjects,
  commitIdFromApiFields,
  parseCommitObject,
} from "../../src/git/branch-objects.ts";
import { scanPublication, workflowChanges } from "../../src/github/branch-publish.ts";
import { GitDataGitHub, bareRemoteAt } from "../helpers/git-data-github.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #512 S-PUSH (CEO f5879479 D1) — a branch publication builds every Git Data API field from the local
 * object, keeps each identity's own offset, and checks every id the API answers. The remote here is an
 * in-process double over a real bare repository whose commit rendering is its own code (`git hash-object`
 * of the fields it receives), so a field the kernel renders wrongly yields another id.
 */

const WORKER = {
  GIT_AUTHOR_NAME: "agent-control-plane",
  GIT_AUTHOR_EMAIL: "agent-control-plane@localhost.invalid",
  GIT_COMMITTER_NAME: "agent-control-plane",
  GIT_COMMITTER_EMAIL: "agent-control-plane@localhost.invalid",
};

const git = (cwd: string, args: readonly string[], env: Record<string, string> = {}, input?: string): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", ...WORKER, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();

/** A repository on `dev` with one base commit. */
const repository = (): { path: string; base: string } => {
  const path = join(tempDir("acp-bp-objects-"), "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", path], { stdio: "ignore", timeout: 30_000 });
  git(path, ["config", "--local", "maintenance.auto", "false"]);
  execFileSync("sh", ["-c", "printf '# fixture\\n' > README.md && mkdir -p src && printf 'module.exports = 1;\\n' > src/app.js"], {
    cwd: path,
    timeout: 30_000,
  });
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", "base"], { GIT_AUTHOR_DATE: "2026-10-18T09:00:00+00:00", GIT_COMMITTER_DATE: "2026-10-18T09:00:00+00:00" });
  return { path, base: git(path, ["rev-parse", "HEAD"]) };
};

/**
 * A worker-style commit: the tree written from the index, `commit-tree -p <parent> --no-gpg-sign -m`,
 * under the control plane's identity, with the author and committer dates (and offsets) given.
 */
const workerCommit = (
  path: string,
  parent: string,
  files: Record<string, string>,
  message: string,
  dates: { author: string; committer: string },
): string => {
  git(path, ["checkout", "-q", "--detach", parent]);
  for (const [file, content] of Object.entries(files)) {
    execFileSync("sh", ["-c", `mkdir -p "$(dirname "$1")" && printf '%s' "$2" > "$1"`, "sh", file, content], { cwd: path, timeout: 30_000 });
  }
  git(path, ["add", "-A"]);
  const tree = git(path, ["write-tree"]);
  return git(path, ["commit-tree", tree, "-p", parent, "--no-gpg-sign", "-m", message], {
    GIT_AUTHOR_DATE: dates.author,
    GIT_COMMITTER_DATE: dates.committer,
  });
};

/** Sends what the kernel sends, in its order, and returns every id the double answered beside the local one. */
const sendThrough = async (remote: GitDataGitHub, objects: BranchObjects): Promise<Array<{ local: string; answered: string; type: string }>> => {
  const out: Array<{ local: string; answered: string; type: string }> = [];
  const prefix = "/repos/acme/fixture/git";
  for (const blob of objects.blobs) {
    const answer = await remote.request<{ sha: string }>("POST", `${prefix}/blobs`, { content: blob.content.toString("base64"), encoding: "base64" });
    out.push({ local: blob.sha, answered: answer.sha, type: "blob" });
  }
  for (const tree of objects.trees) {
    const answer = await remote.request<{ sha: string }>("POST", `${prefix}/trees`, { tree: tree.entries });
    out.push({ local: tree.sha, answered: answer.sha, type: "tree" });
  }
  for (const commit of objects.commits) {
    const answer = await remote.request<{ sha: string; tree: { sha: string } }>("POST", `${prefix}/commits`, commit.fields);
    out.push({ local: commit.sha, answered: answer.sha, type: "commit" });
    out.push({ local: commit.fields.tree, answered: answer.tree.sha, type: "commit-tree" });
  }
  return out;
};

describe("D1: every field from the local object, every answered id checked", () => {
  it("reproduces worker commits at +0900, -0230 and +0000 exactly: each blob, tree and commit id the API answers is the local one", async () => {
    const { path, base } = repository();
    const first = workerCommit(path, base, { "src/app.js": "module.exports = 2;\n", "docs/notes/a.md": "nested\n" }, "first change", {
      author: "2026-10-19T12:00:00+09:00",
      committer: "2026-10-19T12:00:00+09:00",
    });
    const second = workerCommit(path, first, { "README.md": "# fixture\n\nmore\n" }, "second change\n\nwith a body", {
      author: "2026-10-19T01:30:00-02:30",
      committer: "2026-10-19T04:00:00+00:00",
    });
    const collected = await collectBranchObjects(path, base, second, DEFAULT_BRANCH_PUBLISH_LIMITS);
    expect(collected.allowed).toBe(true);
    if (!collected.allowed) return;
    const objects = collected.value;
    expect(objects.commits.map((commit) => commit.sha)).toEqual([first, second]);
    // The fields carry the commit's own offsets, and the exact message bytes (commit-tree -m adds the newline).
    expect(objects.commits[0]!.fields.author.date).toBe("2026-10-19T12:00:00+09:00");
    expect(objects.commits[1]!.fields.author.date).toBe("2026-10-19T01:30:00-02:30");
    expect(objects.commits[1]!.fields.committer.date).toBe("2026-10-19T04:00:00+00:00");
    expect(objects.commits[1]!.fields.message).toBe("second change\n\nwith a body\n");
    // Local reproduction: the same fields name the same commit.
    for (const commit of objects.commits) expect(commitIdFromApiFields(commit.fields)).toBe(commit.sha);
    // Subtrees are sent before the trees that hold them.
    const order = objects.trees.map((tree) => tree.sha);
    for (const tree of objects.trees) {
      for (const entry of tree.entries.filter((e) => e.type === "tree" && order.includes(e.sha))) {
        expect(order.indexOf(entry.sha)).toBeLessThan(order.indexOf(tree.sha));
      }
    }

    const remote = new GitDataGitHub(bareRemoteAt(join(tempDir("acp-bp-remote-"), "remote.git"), path, "dev", base));
    const answered = await sendThrough(remote, objects);
    expect(answered.length).toBe(objects.blobs.length + objects.trees.length + objects.commits.length * 2);
    for (const entry of answered) expect(entry.answered, `${entry.type} ${entry.local}`).toBe(entry.local);
    expect(answered.find((entry) => entry.type === "commit" && entry.local === second)?.answered).toBe(second);
  });

  it("a commit whose offset is rendered as UTC instead (the mutation) yields another id, so the check would refuse it", async () => {
    const { path, base } = repository();
    const head = workerCommit(path, base, { "src/app.js": "module.exports = 3;\n" }, "change", {
      author: "2026-10-19T12:00:00+09:00",
      committer: "2026-10-19T12:00:00+09:00",
    });
    const collected = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    if (!collected.allowed) throw new Error(collected.message);
    const commit = collected.value.commits[0]!;
    const utc = (date: string): string => `${new Date(date).toISOString().slice(0, 19)}+00:00`;
    const mutated = { ...commit.fields, author: { ...commit.fields.author, date: utc(commit.fields.author.date) }, committer: { ...commit.fields.committer, date: utc(commit.fields.committer.date) } };
    expect(commitIdFromApiFields(mutated)).not.toBe(head);
    const remote = new GitDataGitHub(bareRemoteAt(join(tempDir("acp-bp-remote-"), "remote.git"), path, "dev", base));
    await sendThrough(remote, { ...collected.value, commits: [] });
    const answer = await remote.request<{ sha: string }>("POST", "/repos/acme/fixture/git/commits", mutated);
    expect(answer.sha).not.toBe(head);
  });

  it("refuses a commit carrying a header the API cannot reproduce (a signature), before anything is sent", async () => {
    const { path, base } = repository();
    const tree = git(path, ["rev-parse", `${base}^{tree}`]);
    const raw = `tree ${tree}\nparent ${base}\nauthor a <a@b.invalid> 1792378367 +0900\ncommitter a <a@b.invalid> 1792378367 +0900\n` +
      "gpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned\n";
    const signed = git(path, ["hash-object", "-t", "commit", "-w", "--stdin"], {}, raw);
    const parsed = parseCommitObject(signed, Buffer.from(raw, "utf8"));
    expect(parsed.allowed).toBe(false);
    expect(parsed.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED);
    const collected = await collectBranchObjects(path, base, signed, DEFAULT_BRANCH_PUBLISH_LIMITS);
    expect(collected.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED);
  });
});

describe("the refusing public-safety scan", () => {
  const objectsWith = async (
    files: Record<string, string>,
    message = "change",
  ): Promise<{ objects: BranchObjects; path: string }> => {
    const { path, base } = repository();
    const head = workerCommit(path, base, files, message, { author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00" });
    const collected = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    if (!collected.allowed) throw new Error(collected.message);
    return { objects: collected.value, path };
  };
  const scan = (objects: BranchObjects, overrides: Partial<Parameters<typeof scanPublication>[0]> = {}) =>
    scanPublication({
      objects,
      branch: "feature/F1-thing",
      pullRequestTitle: "ACP finalization: make app() return 2",
      pullRequestBody: "Automated daemon finalization.\n\n<!-- acp-run:run_x -->",
      forbiddenPaths: ["/private/state/root"],
      limits: DEFAULT_BRANCH_PUBLISH_LIMITS,
      ...overrides,
    });

  it("passes clean content and binds the scanned set in its digest", async () => {
    const { objects } = await objectsWith({ "src/app.js": "module.exports = 2;\n" });
    const first = scan(objects);
    expect(first.allowed).toBe(true);
    const again = scan(objects);
    expect(again.allowed && first.allowed && again.value.scanDigest).toBe(first.allowed && first.value.scanDigest);
    const otherTitle = scan(objects, { pullRequestTitle: "another title" });
    expect(otherTitle.allowed && first.allowed && otherTitle.value.scanDigest).not.toBe(first.allowed && first.value.scanDigest);
  });

  const SECRET = `ghp_${"A1b2C3d4E5".repeat(4)}`;
  const PEM = ["-----BEGIN", "OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"].join(" ");
  const cases: Array<{ name: string; files?: Record<string, string>; message?: string; overrides?: Partial<Parameters<typeof scanPublication>[0]>; rule: string }> = [
    { name: "a secret pattern in a blob", files: { "config.txt": `token=${SECRET}\n` }, rule: "github token" },
    { name: "a session URL in a blob", files: { "README.md": "see https://claude.ai/code/session_0123456789abcdef\n" }, rule: "session url" },
    { name: "a session trailer in a commit message", files: { "a.txt": "x\n" }, message: "change\n\nClaude-Session: https://example.invalid/x", rule: "session trailer" },
    { name: "a PEM private key", files: { "id_key": PEM }, rule: "private key" },
    { name: "the home state directory", files: { "notes.md": "state lives in ~/.hermes/state\n" }, rule: "home state path" },
    { name: "an absolute home path", files: { "notes.md": "cd /Users/someone/projects\n" }, rule: "absolute home path" },
    { name: "a registered local path", files: { "notes.md": "db at /private/state/root/state.sqlite\n" }, rule: "local absolute path" },
    { name: "a session URL in the pull request body", files: { "a.txt": "x\n" }, overrides: { pullRequestBody: "https://claude.ai/code/session_0123456789abcdef" }, rule: "session url" },
  ];
  for (const testCase of cases) {
    it(`refuses ${testCase.name}, naming the rule and never the text`, async () => {
      const { objects } = await objectsWith(testCase.files ?? { "a.txt": "x\n" }, testCase.message ?? "change");
      const refused = scan(objects, testCase.overrides ?? {});
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
      expect((refused.evidence["findings"] as Array<{ rule: string }>).map((finding) => finding.rule)).toContain(testCase.rule);
      const evidence = JSON.stringify(refused.evidence);
      expect(evidence).not.toContain(SECRET);
      expect(evidence).not.toContain("0123456789abcdef");
      expect(evidence).not.toContain("/Users/someone");
    });
  }

  it("refuses past each cap, before any blob is read", async () => {
    const { path, base } = repository();
    const one = workerCommit(path, base, { "a.txt": "1\n" }, "one", { author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00" });
    const two = workerCommit(path, one, { "big.bin": "x".repeat(2048) }, "two", { author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00" });
    const limits = (overrides: Partial<typeof DEFAULT_BRANCH_PUBLISH_LIMITS>) => ({ ...DEFAULT_BRANCH_PUBLISH_LIMITS, ...overrides });
    expect((await collectBranchObjects(path, base, two, limits({ maxCommits: 1 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect((await collectBranchObjects(path, base, two, limits({ maxObjects: 3 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect((await collectBranchObjects(path, base, two, limits({ maxBlobBytes: 1024 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect((await collectBranchObjects(path, base, two, limits({ maxTotalBytes: 1024 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    const collected = await collectBranchObjects(path, base, two, DEFAULT_BRANCH_PUBLISH_LIMITS);
    if (!collected.allowed) throw new Error(collected.message);
    expect(scan(collected.value, { limits: limits({ maxTextBytes: 8 }) }).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
  });

  it("names every change under .github/workflows (D5), and nothing else", () => {
    expect(workflowChanges(["src/app.js", ".github/workflows/ci.yml", ".github/CODEOWNERS", ".GitHub/Workflows/x.yml"])).toEqual([
      ".github/workflows/ci.yml",
      ".GitHub/Workflows/x.yml",
    ]);
  });
});
