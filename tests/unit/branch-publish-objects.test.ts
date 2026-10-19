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
    expect((await collectBranchObjects(path, base, two, limits({ maxObjectBytes: 1024 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
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

/**
 * #1161 r1 (BP-01, BP-03; CEO 4729a06b, 37f3fcb3) — the reviewer's counterexamples, pinned. The scan is a
 * pure function over the collected objects, so a refusal here is a refusal before any upload; the
 * scenario suite asserts the same surfaces end to end with zero uploads.
 */
describe("#1161 r1 BP-01: one public-safety standard on every surface", () => {
  const UNICODE_PATH = "/private/팀/checkouts";
  const CHATGPT = "https://chatgpt.com/c/12345678-1234-5678-1234-123456789012";
  const DATES = { author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00" };
  const scanWith = (objects: BranchObjects, overrides: Partial<Parameters<typeof scanPublication>[0]> = {}) =>
    scanPublication({
      objects,
      branch: "feature/F1-test",
      pullRequestTitle: "t",
      pullRequestBody: "b",
      forbiddenPaths: [UNICODE_PATH],
      limits: DEFAULT_BRANCH_PUBLISH_LIMITS,
      ...overrides,
    });
  const collect = async (files: Record<string, string | Buffer>, message = "clean", env: Record<string, string> = {}): Promise<BranchObjects> => {
    const { path, base } = repository();
    git(path, ["checkout", "-q", "--detach", base]);
    for (const [file, content] of Object.entries(files)) {
      execFileSync("mkdir", ["-p", join(path, file, "..")], { timeout: 30_000 });
      execFileSync("sh", ["-c", 'cat > "$1"', "sh", join(path, file)], { input: content, timeout: 30_000 });
    }
    git(path, ["add", "-A"]);
    const tree = git(path, ["write-tree"]);
    const head = git(path, ["commit-tree", tree, "-p", base, "--no-gpg-sign", "-m", message], {
      GIT_AUTHOR_DATE: DATES.author,
      GIT_COMMITTER_DATE: DATES.committer,
      ...env,
    });
    const collected = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    if (!collected.allowed) throw new Error(`${collected.reasonCode}: ${collected.message}`);
    return collected.value;
  };
  const expectRefused = (result: ReturnType<typeof scanPublication>, rule: string): void => {
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect((result.evidence["findings"] as Array<{ rule: string }>).map((finding) => finding.rule)).toContain(rule);
    expect(JSON.stringify(result.evidence)).not.toContain("팀");
    expect(JSON.stringify(result.evidence)).not.toContain("12345678-1234");
  };

  it("pins the reported Unicode registered path in a blob", async () => {
    expectRefused(scanWith(await collect({ "a.txt": `${UNICODE_PATH}/private.txt` })), "local absolute path");
  });

  it("pins the reported Unicode registered path in a commit message", async () => {
    expectRefused(scanWith(await collect({ "a.txt": "clean" }, `work at ${UNICODE_PATH}`)), "local absolute path");
  });

  it("refuses the Unicode path in the author and in the committer field", async () => {
    expectRefused(scanWith(await collect({ "a.txt": "clean" }, "clean", { GIT_AUTHOR_NAME: `dev ${UNICODE_PATH}` })), "local absolute path");
    expectRefused(scanWith(await collect({ "a.txt": "clean" }, "clean", { GIT_COMMITTER_EMAIL: `x${UNICODE_PATH}@example.invalid` })), "local absolute path");
  });

  it("refuses the path written decomposed (NFD) or in another letter case", async () => {
    expectRefused(scanWith(await collect({ "a.txt": `${UNICODE_PATH.normalize("NFD")}/x` })), "local absolute path");
    expectRefused(scanWith(await collect({ "a.txt": `${UNICODE_PATH.toUpperCase()}/x` })), "local absolute path");
  });

  it("binary policy: a blob that is not UTF-8 is scanned as raw bytes for each rule and for each path's UTF-8 bytes", async () => {
    const binary = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0x00, 0xc3]), Buffer.from(text, "utf8"), Buffer.from([0x80, 0xfe])]);
    const pathBlob = await collect({ "image.bin": binary(`${UNICODE_PATH}/x`) });
    expect(pathBlob.blobs.some((blob) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }) && (() => {
      try { new TextDecoder("utf-8", { fatal: true }).decode(blob.content); return false; } catch { return true; }
    })())).toBe(true);
    expectRefused(scanWith(pathBlob), "local absolute path");
    expectRefused(scanWith(await collect({ "image.bin": binary(CHATGPT) })), "session url");
    expectRefused(scanWith(await collect({ "image.bin": binary(`ghp_${"Ab1Cd2Ef3G".repeat(4)}`) })), "github token");
  });

  it("a UTF-16 blob with a byte-order mark is decoded and scanned as text", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`see ${CHATGPT}`, "utf16le")]);
    expectRefused(scanWith(await collect({ "notes.txt": utf16 })), "session url");
  });

  it("pins the reported full tree path ~/.hermes/state, scanned joined rather than per component", async () => {
    const objects = await collect({ "~/.hermes/state": "clean" });
    expect(objects.trees.flatMap((tree) => tree.entries.map((entry) => entry.path))).not.toContain("~/.hermes/state");
    expectRefused(scanWith(objects), "home state path");
  });

  it("the joined path is scanned from the sent trees themselves, whatever the changed-path list says", () => {
    const id = (n: number): string => n.toString(16).padStart(40, "0");
    const commit = { sha: id(9), raw: Buffer.from("clean"), fields: { message: "clean", tree: id(1), parents: [], author: { name: "a", email: "a@example.invalid", date: "2026-10-19T12:00:00+09:00" }, committer: { name: "a", email: "a@example.invalid", date: "2026-10-19T12:00:00+09:00" } } };
    const objects: BranchObjects = {
      commits: [commit],
      trees: [
        { sha: id(3), entries: [{ path: "state", mode: "100644", type: "blob", sha: id(4) }] },
        { sha: id(2), entries: [{ path: ".hermes", mode: "040000", type: "tree", sha: id(3) }] },
        { sha: id(1), entries: [{ path: "~", mode: "040000", type: "tree", sha: id(2) }] },
      ],
      blobs: [],
      changedPaths: [],
      candidateTree: id(1),
      bytes: 0,
    };
    expectRefused(scanWith(objects), "home state path");
  });

  it("a session URL laid out as directories is caught on the joined path", async () => {
    expectRefused(scanWith(await collect({ "chatgpt.com/c/12345678-1234-5678-1234-123456789012/readme.md": "clean" })), "session url");
  });

  it("pins chatgpt.com/c/<uuid> in the PR body, and covers every session URL form on every surface", async () => {
    const empty: BranchObjects = { commits: [], trees: [], blobs: [], changedPaths: [], candidateTree: "", bytes: 0 };
    expectRefused(scanWith(empty, { pullRequestBody: CHATGPT }), "session url");
    const forms = [
      CHATGPT,
      "https://chatgpt.com/share/6712-abcd-ef01",
      "https://chat.openai.com/c/12345678-1234-5678-1234-123456789012",
      "https://chatgpt.com/g/g-abc123/c/12345678-1234-5678-1234-123456789012",
      "https://chatgpt.com/codex/tasks/task_e_0123456789",
      "https://claude.ai/chat/0123abcd-0000-0000-0000-000000000000",
      "https://claude.ai/share/0123abcd-0000-0000-0000-000000000000",
      "https://claude.ai/code/session_0123456789abcdef",
      "https://gemini.google.com/app/0123456789abcdef",
      "https://g.co/gemini/share/0123456789ab",
      "https://grok.com/share/abcdef0123",
      "https://example.invalid/sessions/0123456789abcdef",
    ];
    for (const form of forms) {
      expectRefused(scanWith(empty, { pullRequestTitle: `see ${form}` }), "session url");
      expectRefused(scanWith(empty, { branch: `feature/${form.replace(/^https:\/\//, "")}` }), "session url");
    }
    expectRefused(scanWith(await collect({ "a.txt": `see ${CHATGPT}` })), "session url");
    expectRefused(scanWith(await collect({ "a.txt": "clean" }, `see ${CHATGPT}`)), "session url");
    expectRefused(scanWith(await collect({ "a.txt": "clean" }, "clean", { GIT_AUTHOR_NAME: "chatgpt.com/c/12345678-1234" })), "session url");
  });

  it("control: clean UTF-8 text with other Unicode passes", async () => {
    const objects = await collect({ "docs/팀.md": "팀 문서 — 깨끗함\n" }, "팀 변경");
    expect(scanWith(objects).allowed).toBe(true);
  });
});

describe("#1161 r1 BP-03: the caps count every object and every byte, from metadata, before any payload is read", () => {
  const DATES = { author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00" };
  const limits = (overrides: Partial<typeof DEFAULT_BRANCH_PUBLISH_LIMITS>) => ({ ...DEFAULT_BRANCH_PUBLISH_LIMITS, ...overrides });
  /** The sizes git states for every object `base..head` sends, read independently of the collector. */
  const stated = (path: string, base: string, head: string): Array<{ type: string; size: number }> => {
    const ids = git(path, ["rev-list", "--objects", "--no-object-names", head, `^${base}`]);
    return git(path, ["cat-file", "--batch-check"], {}, `${ids}\n`).split("\n").map((line) => {
      const [, type, size] = line.split(" ");
      return { type: type!, size: Number(size) };
    });
  };

  it("pins the reported 26 MiB commit: refused under the default caps, and by the total alone when the per-object cap allows it", async () => {
    const { path, base } = repository();
    const tree = git(path, ["rev-parse", `${base}^{tree}`]);
    const raw = `tree ${tree}\nparent ${base}\nauthor x <x@example.invalid> 1792378367 +0000\ncommitter x <x@example.invalid> 1792378367 +0000\n\n${"x".repeat(26 * 1024 * 1024)}\n`;
    const head = git(path, ["hash-object", "-t", "commit", "-w", "--stdin"], {}, raw);
    const byDefault = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    expect(byDefault.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect(byDefault.evidence).toMatchObject({ type: "commit" });
    const byTotal = await collectBranchObjects(path, base, head, limits({ maxObjectBytes: 64 * 1024 * 1024 }));
    expect(byTotal.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect(byTotal.evidence).toMatchObject({ limit: DEFAULT_BRANCH_PUBLISH_LIMITS.maxTotalBytes });
  });

  it("pins the reported tree and commit-message bytes against a 1,024-byte total", async () => {
    const { path, base } = repository();
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}-${"a".repeat(80)}`, "clean"]));
    const treeHeavy = workerCommit(path, base, files, "clean", DATES);
    expect(stated(path, base, treeHeavy).filter((object) => object.type === "tree").reduce((n, object) => n + object.size, 0)).toBeGreaterThan(1024);
    expect((await collectBranchObjects(path, base, treeHeavy, limits({ maxTotalBytes: 1024 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    const messageHeavy = workerCommit(path, base, { "b.txt": "clean" }, "x".repeat(2048), DATES);
    expect((await collectBranchObjects(path, base, messageHeavy, limits({ maxTotalBytes: 1024 }))).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
  });

  it("every bound is exact: at the bound passes, one past it refuses (count, commits, largest object as commit and as tree, total, text)", async () => {
    const { path, base } = repository();
    const one = workerCommit(path, base, { "a.txt": "1\n" }, "one", DATES);
    const head = workerCommit(path, one, { "dir/b.txt": "2\n" }, `two ${"m".repeat(600)}`, DATES);
    const objects = stated(path, base, head);
    const total = objects.reduce((n, object) => n + object.size, 0);
    const largest = Math.max(...objects.map((object) => object.size));
    expect(objects.find((object) => object.size === largest)?.type).toBe("commit");
    const at = async (overrides: Partial<typeof DEFAULT_BRANCH_PUBLISH_LIMITS>) => collectBranchObjects(path, base, head, limits(overrides));
    for (const [bound, value] of [["maxTotalBytes", total], ["maxObjectBytes", largest], ["maxObjects", objects.length], ["maxCommits", 2]] as const) {
      const pass = await at({ [bound]: value });
      expect(pass.allowed, `${bound} = ${value}`).toBe(true);
      const refuse = await at({ [bound]: value - 1 });
      expect(refuse.reasonCode, `${bound} = ${value - 1}`).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    }
    const full = await at({});
    if (!full.allowed) throw new Error(full.message);
    expect(full.value.bytes).toBe(total);
    const scanned = scanPublication({ objects: full.value, branch: "feature/F1-x", pullRequestTitle: "title", pullRequestBody: "body", forbiddenPaths: [], limits: limits({ maxTextBytes: 5 }) });
    expect(scanned.allowed && scanned.value.counts).toEqual({ commits: 2, trees: objects.filter((o) => o.type === "tree").length, blobs: objects.filter((o) => o.type === "blob").length, bytes: total });
    const overText = scanPublication({ objects: full.value, branch: "feature/F1-x", pullRequestTitle: "title", pullRequestBody: "body", forbiddenPaths: [], limits: limits({ maxTextBytes: 4 }) });
    expect(overText.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);

    const { path: treePath, base: treeBase } = repository();
    const wide = workerCommit(treePath, treeBase, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i}-${"t".repeat(60)}`, "x"])), "w", DATES);
    const wideObjects = stated(treePath, treeBase, wide);
    const widest = Math.max(...wideObjects.map((object) => object.size));
    expect(wideObjects.find((object) => object.size === widest)?.type).toBe("tree");
    expect((await collectBranchObjects(treePath, treeBase, wide, limits({ maxObjectBytes: widest }))).allowed).toBe(true);
    const tooWide = await collectBranchObjects(treePath, treeBase, wide, limits({ maxObjectBytes: widest - 1 }));
    expect(tooWide.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect(tooWide.evidence).toMatchObject({ type: "tree" });
  });
});

/**
 * #1161 r1 — the reviewer's object probes (pr1161-reviewer-probes-round1/object-probes.test.ts), ported: the
 * same cases and assertions, with only the logging dropped and names prefixed. The unmodified file is replayed
 * separately (evidence r3/replay-*).
 */
describe("#1161 r1 reviewer object probes, ported", () => {
  const reviewForbidden = "/private/팀/checkouts";
  const reviewInspect = (objects: BranchObjects) => scanPublication({objects, branch: "feature/F1-test", pullRequestTitle: "t", pullRequestBody: "b", forbiddenPaths: [reviewForbidden], limits: DEFAULT_BRANCH_PUBLISH_LIMITS});
  for (const site of ["blob", "message"]) {
    it(`review: refuses a literal registered Unicode path in ${site}`, async () => {
      const {path, base} = repository();
      const head = workerCommit(path, base, {"a.txt": site === "blob" ? `${reviewForbidden}/private.txt` : "clean"}, site === "message" ? `work at ${reviewForbidden}` : "clean", {author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00"});
      const collected = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
      if (!collected.allowed) throw new Error(collected.message);
      const result = reviewInspect(collected.value);
      expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    });
  }
  it("review: refuses a home-state path composed of tree path components", async () => {
    const {path, base} = repository();
    const head = workerCommit(path, base, {"~/.hermes/state": "clean"}, "clean", {author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00"});
    const collected = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    if (!collected.allowed) throw new Error(collected.message);
    const result = reviewInspect(collected.value);
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
  });
  it("review: refuses a ChatGPT session URL in the PR body", () => {
    const result = scanPublication({objects: {commits: [], trees: [], blobs: [], changedPaths: [], candidateTree: "", bytes: 0}, branch: "feature/F1-test", pullRequestTitle: "t", pullRequestBody: "https://chatgpt.com/c/12345678-1234-5678-1234-123456789012", forbiddenPaths: [], limits: DEFAULT_BRANCH_PUBLISH_LIMITS});
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
  });

  it("review: total upload cap includes commit message bytes", async () => {
    const {path, base} = repository();
    const head = workerCommit(path, base, {"a.txt": "clean"}, "x".repeat(2048), {author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00"});
    const result = await collectBranchObjects(path, base, head, {...DEFAULT_BRANCH_PUBLISH_LIMITS, maxTotalBytes: 1024});
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
  });

  it("review: default total cap also refuses a 26 MiB commit object", async () => {
    const {path, base} = repository();
    const tree = git(path, ["rev-parse", `${base}^{tree}`]);
    const raw = `tree ${tree}\nparent ${base}\nauthor x <x@example.invalid> 1792378367 +0000\ncommitter x <x@example.invalid> 1792378367 +0000\n\n${"x".repeat(26*1024*1024)}\n`;
    const head = git(path, ["hash-object", "-t", "commit", "-w", "--stdin"], {}, raw);
    const result = await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
  });
  it("review: total upload cap includes tree bytes", async () => {
    const {path, base} = repository();
    const files = Object.fromEntries(Array.from({length: 20}, (_,i)=>[`${i}-${"a".repeat(80)}`, "clean"]));
    const head = workerCommit(path, base, files, "clean", {author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T12:00:00+09:00"});
    const result = await collectBranchObjects(path, base, head, {...DEFAULT_BRANCH_PUBLISH_LIMITS, maxTotalBytes: 1024});
    const bytes = result.allowed ? result.value.trees.reduce((n,t)=>n+execFileSync("git", ["-C", path, "cat-file", "tree", t.sha], {timeout: 30_000}).length, 0) : null;
    void bytes; // the original probe logged it
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
  });
  it("review control: rejects unrepresentable encoding, mergetag and extra commit headers", () => {
    for (const extra of ["encoding ISO-8859-1", "mergetag object "+"a".repeat(40), "x-private unknown"]) {
      const raw = Buffer.from(`tree ${"a".repeat(40)}\nauthor x <x@example.invalid> 1792378367 +0000\ncommitter x <x@example.invalid> 1792378367 +0000\n${extra}\n\nclean\n`);
      expect(parseCommitObject("b".repeat(40), raw).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED);
    }
  });
  it("review control: a two-parent merge reproduces all local object IDs", async () => {
    const {path, base} = repository();
    const dates={author: "2026-10-19T12:00:00+09:00", committer: "2026-10-19T03:00:00+00:00"};
    const one=workerCommit(path, base, {"one": "one"}, "one", dates);
    const two=workerCommit(path, base, {"two": "two"}, "two", dates);
    const tree=git(path, ["rev-parse", `${two}^{tree}`]);
    const head=git(path, ["commit-tree", tree, "-p", one, "-p", two, "-m", "merge"], {GIT_AUTHOR_DATE: dates.author, GIT_COMMITTER_DATE: dates.committer});
    const result=await collectBranchObjects(path, base, head, DEFAULT_BRANCH_PUBLISH_LIMITS);
    if(!result.allowed) throw new Error(result.message);
    expect(result.value.commits.at(-1)!.fields.parents).toEqual([one,two]);
    const remote=new GitDataGitHub(bareRemoteAt(join(tempDir("acp-review-merge-"), "remote.git"), path, "dev", base));
    const answers=await sendThrough(remote,result.value);
    expect(answers.length).toBeGreaterThan(0);
    for(const answer of answers) expect(answer.answered).toBe(answer.local);
  });
});
