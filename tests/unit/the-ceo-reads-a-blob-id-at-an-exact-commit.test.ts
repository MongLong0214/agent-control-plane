import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { acpError, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY, HERMES_READ_ONLY_TOOLS } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import type { AuthenticatedMcpPeer } from "../../src/mcp/shared.ts";
import { FakeGitHub, type FakePull } from "../helpers/fake-github.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

/**
 * The CEO reads one file's git blob id at one exact commit through acp-ceo's `repository_blob_get`, so it can
 * compare two files when GitHub left a patch out of a PR's file list. The scenario is PR #1504 of ACP: the head's
 * `src/db/schema-v60.sql` has no patch in the PR's files, and must be the base's `src/db/schema.sql`, byte for byte.
 * GitHub is a fake transport that holds the two commits' trees; nothing in it writes.
 */

const HEAD = "35f19f91b04950373f0490f4c925b9ece9af54e9";
const BASE = "d1e2b1284f2f97a3d119bd4bbc5f4d2100a4055e";
const BLOB = "e5f124254db4c87105b78afb792ebc275b1c3cca";
const OTHER_BLOB = "0a".repeat(20);
const STRANGER = "99".repeat(20);
/** A commit GitHub resolves for this repository's API because a fork or the parent holds it; this repository does not. */
const FORK_ONLY = "f0".repeat(20);
const FORK_ROOT = "c1".repeat(20);
const LINK_TARGET = "1c".repeat(20);

const tree = (n: string): string => n.repeat(20);
const HEAD_ROOT = tree("a1"), HEAD_SRC = tree("a2"), HEAD_DB = tree("a3");
const BASE_ROOT = tree("b1"), BASE_SRC = tree("b2"), BASE_DB = tree("b3");

type Row = Record<string, unknown>;
const blobEntry = (path: string, sha: string, size = 4821): Row => ({ path, mode: "100644", type: "blob", sha, size });
const treeEntry = (path: string, sha: string): Row => ({ path, mode: "040000", type: "tree", sha });

/** Two commits of acme/fixture, their trees, and the PR whose head's file list carries no patch for the moved file. */
class BlobGitHub extends FakeGitHub {
  commits = new Map<string, { tree: string }>([[HEAD, { tree: HEAD_ROOT }], [BASE, { tree: BASE_ROOT }], [FORK_ONLY, { tree: FORK_ROOT }]]);
  trees = new Map<string, Row[]>([
    [HEAD_ROOT, [treeEntry("src", HEAD_SRC), blobEntry("README.md", OTHER_BLOB, 12)]],
    [HEAD_SRC, [treeEntry("db", HEAD_DB)]],
    [HEAD_DB, [blobEntry("schema-v60.sql", BLOB), blobEntry("schema.sql", OTHER_BLOB, 4000),
      { path: "schema-link.sql", mode: "120000", type: "blob", sha: LINK_TARGET, size: 13 }]],
    [BASE_ROOT, [treeEntry("src", BASE_SRC)]],
    [BASE_SRC, [treeEntry("db", BASE_DB)]],
    [BASE_DB, [blobEntry("schema.sql", BLOB)]],
    [FORK_ROOT, [blobEntry("README.md", OTHER_BLOB, 12)]],
  ]);
  /** The default branch's head and the commits it reaches; the PR head is not one of them. */
  mainHead = BASE;
  onMain = new Set<string>([BASE]);
  /** The pull requests of this repository that GitHub lists for a commit. */
  pullsOfCommit = new Map<string, Row[]>();
  /** Answers `commits/{sha}/pulls` or the compare with this status instead, as GitHub does when it cannot say. */
  failingReachability: { pattern: RegExp; status: number } | null = null;
  truncated = new Set<string>();
  failing: Array<{ pattern: RegExp; status: number }> = [];
  /** Rewrites a commit answer, for a response that names another object than the one asked for. */
  reshapeCommit: ((body: Row) => unknown) | null = null;
  pullFiles: Row[] = [];

  override async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const gitCommit = /\/repos\/acme\/fixture\/git\/commits\/([0-9a-f]+)$/.exec(path);
    const gitTree = /\/repos\/acme\/fixture\/git\/trees\/([0-9a-f]+)$/.exec(path);
    const pull = /\/repos\/acme\/fixture\/pulls\/(\d+)$/.exec(path);
    const compare = /\/repos\/acme\/fixture\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?per_page=1$/.exec(path);
    const repository = /\/repos\/acme\/fixture$/.exec(path);
    const mainRef = /\/repos\/acme\/fixture\/git\/ref\/heads\/main$/.exec(path);
    const reaches = /\/repos\/acme\/fixture\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    const commitPulls = /\/repos\/acme\/fixture\/commits\/([0-9a-f]{40})\/pulls\?per_page=100$/.exec(path);
    if (method !== "GET" || !(gitCommit || gitTree || pull || compare || repository || mainRef || reaches || commitPulls)) {
      // Anything else of the PR read (checks, statuses, rules) is a lookup that fails, which that tool names as a gap.
      if (method === "GET" && path.startsWith("/repos/acme/fixture/")) {
        this.calls.push({ method, path, body });
        throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 404 });
      }
      return super.request<T>(method, path, body);
    }
    this.calls.push({ method, path, body });
    const failure = this.failing.find((entry) => entry.pattern.test(path));
    if (failure) throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: failure.status });
    const missing = (): never => { throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 404 }); };
    if (this.failingReachability?.pattern.test(path)) {
      throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: this.failingReachability.status });
    }
    if (repository) return { full_name: "acme/fixture", default_branch: "main" } as T;
    if (mainRef) return { ref: "refs/heads/main", object: { type: "commit", sha: this.mainHead } } as T;
    if (reaches) {
      const [, commit, head] = reaches;
      const status = commit === head ? "identical" : this.onMain.has(commit!) ? "ahead" : "diverged";
      return { status, ahead_by: 0, behind_by: 0, files: [] } as T;
    }
    if (commitPulls) return (this.pullsOfCommit.get(commitPulls[1]!) ?? []) as T;
    if (gitCommit) {
      const found = this.commits.get(gitCommit[1]!);
      if (!found) return missing();
      const answer = { sha: gitCommit[1], tree: { sha: found.tree }, parents: [] };
      return (this.reshapeCommit ? this.reshapeCommit(answer) : answer) as T;
    }
    if (gitTree) {
      const entries = this.trees.get(gitTree[1]!);
      if (!entries) return missing();
      return { sha: gitTree[1], tree: entries, truncated: this.truncated.has(gitTree[1]!) } as T;
    }
    if (pull) {
      const found = this.pulls.find((p) => p.number === Number(pull[1]));
      return (found ? structuredClone(found) : missing()) as T;
    }
    return { status: "ahead", ahead_by: 1, behind_by: 0, base_commit: { sha: compare![1] }, merge_base_commit: { sha: BASE },
      files: this.pullFiles, html_url: `https://github.com/acme/fixture/compare/${BASE}...${HEAD}` } as T;
  }
}

type Answer =
  | { ok: true; reasonCode: string; value: { schema: string; projectId: string; repositoryIdentity: string; commit: string; path: string; blobSha: string; size: number | null; mode: string | null } }
  | { ok: false; reasonCode: string; message: string; evidence: Row };

const LINEAGE = sha256("blob read lineage");
const ANCHOR = { liveHermesSessionId: "hermes-ceo-runtime", lineageRootDigest: LINEAGE };
const OWNER_TURN = { [HERMES_PROVENANCE_META_KEY]: {
  principal: "owner", session_id: ANCHOR.liveHermesSessionId, lineage_root_digest: LINEAGE, cron: false, delegation_depth: 0,
} };

let h: Harness;
let gh: BlobGitHub;
let projectId: string;
let ceoPeer: AuthenticatedMcpPeer;
const open: Array<{ close(): Promise<void> }> = [];

const channel = async (peer: AuthenticatedMcpPeer, withProvenance = true) => {
  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, peer),
    withProvenance ? { provenance: ANCHOR } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "repository-blob", version: "1" });
  await client.connect(clientTransport);
  open.push(client, server);
  const callTool = async (name: string, args: Row) =>
    client.callTool({ name, arguments: args, ...(withProvenance ? { _meta: OWNER_TURN } : {}) });
  return { client, callTool };
};
const blobAt = async (args: Row, peer: AuthenticatedMcpPeer = ceoPeer): Promise<Answer> => {
  const result = await (await channel(peer)).callTool("repository_blob_get", args);
  if (!result.structuredContent) throw new Error(`repository_blob_get gave no structured answer: ${JSON.stringify(result.content)}`);
  return result.structuredContent as Answer;
};

/** Every table of the control plane's database, row by row, as it stands. */
const snapshotOfState = (): string => {
  const tables = h.cp.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
  return sha256(JSON.stringify(tables.map(({ name }) => [name, h.cp.db.all<Row>(`SELECT * FROM "${name}"`).map((row) => JSON.stringify(row)).sort()])));
};

beforeAll(async () => {
  gh = new BlobGitHub();
  h = makeHarness({ githubClient: gh });
  ({ projectId } = await registerFixtureProject(h, "blob-read"));
  const ceoSessionId = bindCeo(h);
  const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  ceoPeer = { actor: ceoSessionId, sessionId: ceoSessionId, sessionIncarnation: ceo.sessionIncarnation,
    binding: { roleKey: ceo.roleKey, bindingGeneration: ceo.bindingGeneration } };
}, 120_000);

beforeEach(() => {
  gh.pulls = [];
  gh.pullFiles = [];
  gh.failing = [];
  gh.truncated.clear();
  gh.reshapeCommit = null;
  gh.failingReachability = null;
  gh.pullsOfCommit.clear();
  // The PR #1504 head is on no default branch; it is in a pull request of the repository.
  gh.pullsOfCommit.set(HEAD, [{ number: 1504, state: "open", base: { ref: "main", repo: { full_name: "acme/fixture" } }, head: { sha: HEAD } }]);
  gh.calls.length = 0;
});

afterEach(async () => {
  // No case below may make GitHub write anything.
  expect(gh.calls.filter((call) => call.method !== "GET")).toEqual([]);
  while (open.length > 0) await open.pop()!.close();
});

afterAll(async () => {
  h?.cp.close();
  cleanupTempDirs();
});

const pullAtHead = (number: number): FakePull & Row => ({
  number,
  head: { sha: HEAD, ref: "feat/schema-v60" },
  base: { sha: BASE, ref: "main", repo: { full_name: "acme/fixture" } } as FakePull["base"],
  merged: false, state: "open", draft: false, title: "re-apply schema v60",
  html_url: `https://github.com/acme/fixture/pull/${number}`, mergeable: true, mergeable_state: "clean",
  changed_files: 1, additions: 120, deletions: 0, commits: 1,
});

describe("repository_blob_get", () => {
  it("is an acp-ceo tool, not a CTO tool, and not one an unadmitted channel may call", async () => {
    const { client } = await channel(ceoPeer);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("repository_blob_get");
    expect(HERMES_READ_ONLY_TOOLS.has("repository_blob_get")).toBe(false);
    const cto = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, ceoPeer));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await cto.connect(serverTransport);
    const ctoClient = new Client({ name: "repository-blob-cto", version: "1" });
    await ctoClient.connect(clientTransport);
    open.push(ctoClient, cto);
    expect((await ctoClient.listTools()).tools.map((tool) => tool.name)).not.toContain("repository_blob_get");
    // The CEO's session on a channel that admits no Hermes turn.
    const noTurn = await (await channel(ceoPeer, false)).callTool("repository_blob_get", { projectId, commit: HEAD, path: "README.md" });
    expect(noTurn.structuredContent).toMatchObject({ ok: false });
    expect(gh.calls).toEqual([]);
  });

  it("(a) gives the blob id at both commits for a PR whose file patch GitHub left out", async () => {
    gh.pulls.push(pullAtHead(1504));
    gh.pullFiles = [{ filename: "src/db/schema-v60.sql", status: "added", additions: 120, deletions: 0, changes: 120,
      blob_url: `https://github.com/acme/fixture/blob/${HEAD}/src/db/schema-v60.sql` }];
    // The PR read names the omitted patch and has no blob id to compare by.
    const { callTool } = await channel(ceoPeer);
    const evidence = (await callTool("pr_evidence_get", { projectId, prNumber: 1504, expectedHead: HEAD })).structuredContent as
      { ok: boolean; evidence: { incomplete: Array<{ kind: string; file?: string }>; summary: { files: Row[] } } };
    expect(evidence.ok).toBe(false);
    expect(evidence.evidence.incomplete).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "PATCH_OMITTED", file: "src/db/schema-v60.sql" })]));
    expect(evidence.evidence.summary.files[0]).toMatchObject({ filename: "src/db/schema-v60.sql", patchOmitted: true });
    expect(JSON.stringify(evidence.evidence.summary.files)).not.toContain(BLOB);

    const head = (await callTool("repository_blob_get", { projectId, commit: HEAD, path: "src/db/schema-v60.sql" })).structuredContent as Answer;
    const base = (await callTool("repository_blob_get", { projectId, commit: BASE, path: "src/db/schema.sql" })).structuredContent as Answer;
    expect(head).toMatchObject({ ok: true, value: { commit: HEAD, path: "src/db/schema-v60.sql", blobSha: BLOB, size: 4821, repositoryIdentity: "github:acme/fixture" } });
    expect(base).toMatchObject({ ok: true, value: { commit: BASE, path: "src/db/schema.sql", blobSha: BLOB, size: 4821 } });
    // A different file at the same commit has a different blob id: the read distinguishes, it does not just echo.
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema.sql" })).toMatchObject({ ok: true, value: { blobSha: OTHER_BLOB, size: 4000 } });
    // Only GET, by object id: no contents API, no branch name.
    expect(gh.calls.map((call) => call.method)).toEqual(expect.arrayContaining(["GET"]));
    expect(gh.calls.filter((call) => /\/contents\//.test(call.path))).toEqual([]);
  });

  it("(b) refuses a wrong or unregistered repository, a URL or remote in place of the registry key, before asking GitHub", async () => {
    expect(await blobAt({ projectId: "not-a-project", commit: HEAD, path: "README.md" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    for (const projectLike of ["https://github.com/acme/fixture", "github:acme/fixture", "acme/fixture", "../blob-read", "/home/fixture/projects/x"]) {
      expect(await blobAt({ projectId: projectLike, commit: HEAD, path: "README.md" }), projectLike)
        .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    }
    for (const roleLike of ["https://github.com/other/repo", "git@github.com:other/repo.git", "other/repo"]) {
      expect(await blobAt({ projectId, repositoryRole: roleLike, commit: HEAD, path: "README.md" }), roleLike)
        .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    }
    expect(await blobAt({ projectId, repositoryRole: "secondary", commit: HEAD, path: "README.md" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(gh.calls).toEqual([]);
  });

  it("(b) refuses a short, non-hex, uppercase or named commit before asking GitHub", async () => {
    for (const commit of ["35f19f9", "main", "HEAD", HEAD.toUpperCase(), `${HEAD}0`, `${HEAD.slice(0, 39)}g`, `${HEAD}:src`, ""]) {
      expect(await blobAt({ projectId, commit, path: "README.md" }), commit).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    }
    expect(gh.calls).toEqual([]);
  });

  it("(b) refuses a path that is a URL, absolute or climbs out, before asking GitHub", async () => {
    for (const path of ["https://github.com/acme/fixture/blob/main/README.md", "/src/db/schema.sql", "src//db/schema.sql", "src/./db/schema.sql",
      "../etc/passwd", "src/db/", "src\\db\\schema.sql", "src/db/schema.sql\u0000"]) {
      expect(await blobAt({ projectId, commit: HEAD, path }), path).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    }
    expect(gh.calls).toEqual([]);
  });

  it("(b) refuses a commit the repository does not hold, and does not read a tree for it", async () => {
    const answer = await blobAt({ projectId, commit: STRANGER, path: "README.md" });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND, evidence: { commit: STRANGER, status: 404 } });
    expect(gh.calls.map((call) => call.path)).toEqual([`/repos/acme/fixture/git/commits/${STRANGER}`]);
    // GitHub's answer for another object than the one asked for is refused, not read.
    gh.reshapeCommit = (body) => ({ ...body, sha: STRANGER });
    expect(await blobAt({ projectId, commit: HEAD, path: "README.md" })).toMatchObject({ ok: false, reasonCode: ReasonCode.PROBE_FAILED });
  });

  it("(b) refuses a commit GitHub resolves but this repository does not reach, reading no tree for it", async () => {
    // The fake answers git/commits for FORK_ONLY, as GitHub does for an object in the fork network.
    const answer = await blobAt({ projectId, commit: FORK_ONLY, path: "README.md" });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND, evidence: { commit: FORK_ONLY } });
    expect(gh.calls.map((call) => call.path)).toEqual(expect.arrayContaining([`/repos/acme/fixture/git/commits/${FORK_ONLY}`]));
    expect(gh.calls.filter((call) => /\/git\/trees\//.test(call.path))).toEqual([]);
    // A PR of another repository that lists the commit does not make it this repository's.
    gh.pullsOfCommit.set(FORK_ONLY, [{ number: 7, state: "open", base: { ref: "main", repo: { full_name: "someone/else" } } }]);
    expect(await blobAt({ projectId, commit: FORK_ONLY, path: "README.md" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    // Reachability that could not be read is a gap, not a verdict that the commit is foreign.
    gh.pullsOfCommit.clear();
    gh.failingReachability = { pattern: /\/commits\/[0-9a-f]{40}\/pulls/, status: 500 };
    expect(await blobAt({ projectId, commit: FORK_ONLY, path: "README.md" })).toMatchObject({ ok: false, reasonCode: ReasonCode.PROBE_FAILED });
    // The base is an ancestor of the default branch's head, and the #1504 head is in a PR of this repository.
    gh.failingReachability = null;
    expect(await blobAt({ projectId, commit: BASE, path: "src/db/schema.sql" })).toMatchObject({ ok: true });
    gh.pullsOfCommit.set(HEAD, [{ number: 1504, state: "closed", base: { ref: "main", repo: { full_name: "acme/fixture" } } }]);
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema-v60.sql" })).toMatchObject({ ok: true, value: { blobSha: BLOB } });
  });

  it("(b) refuses a symbolic link, whose blob is the link target's text and not a file", async () => {
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema-link.sql" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: { mode: "120000" } });
    // An ordinary file beside it is still read.
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema.sql" })).toMatchObject({ ok: true, value: { mode: "100644" } });
  });

  it("(b) refuses a missing path, a directory used as a file, and a file used as a directory", async () => {
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema-v61.sql" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    // schema-v60.sql is not at the base commit.
    expect(await blobAt({ projectId, commit: BASE, path: "src/db/schema-v60.sql" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(await blobAt({ projectId, commit: HEAD, path: "nowhere/at/all.sql" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db" })).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: { foundType: "tree" } });
    expect(await blobAt({ projectId, commit: HEAD, path: "README.md/inner.txt" })).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: { foundType: "blob" } });
    // A tree GitHub cut short cannot say a path is missing: that is a gap, not an absence.
    gh.truncated.add(HEAD_DB);
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema-v61.sql" })).toMatchObject({ ok: false, reasonCode: ReasonCode.PROBE_FAILED });
  });

  it("names a GitHub permission error, and echoes no error text", async () => {
    gh.failing.push({ pattern: /\/git\/commits\//, status: 403 });
    expect(await blobAt({ projectId, commit: HEAD, path: "README.md" })).toMatchObject({
      ok: false, reasonCode: ReasonCode.GITHUB_APP_PERMISSION_DENIED, evidence: { status: 403 } });
    gh.failing = [{ pattern: /\/git\/trees\//, status: 500 }];
    expect(await blobAt({ projectId, commit: HEAD, path: "README.md" })).toMatchObject({ ok: false, reasonCode: ReasonCode.PROBE_FAILED });
  });

  it("(c) changes nothing in review, merge or completion state, with or without a PR whose patch was omitted", async () => {
    gh.pulls.push(pullAtHead(1504));
    gh.pullFiles = [{ filename: "src/db/schema-v60.sql", status: "added", additions: 120, deletions: 0, changes: 120 }];
    // Everything the control plane stores, one digest, before and after reads that succeed and that are refused.
    const before = snapshotOfState();
    const { callTool } = await channel(ceoPeer);
    await callTool("pr_evidence_get", { projectId, prNumber: 1504, expectedHead: HEAD });
    const afterPrRead = snapshotOfState();
    expect(await blobAt({ projectId, commit: HEAD, path: "src/db/schema-v60.sql" })).toMatchObject({ ok: true });
    expect(await blobAt({ projectId, commit: BASE, path: "src/db/schema.sql" })).toMatchObject({ ok: true });
    expect(await blobAt({ projectId, commit: STRANGER, path: "src/db/schema.sql" })).toMatchObject({ ok: false });
    expect(await blobAt({ projectId, commit: "main", path: "src/db/schema.sql" })).toMatchObject({ ok: false });
    // The blob reads wrote nothing beyond what the PR read already did, and they did not complete the omitted patch:
    // the PR read still names it, with the same gap, after two equal blob ids were read.
    expect(snapshotOfState()).toBe(afterPrRead);
    expect(afterPrRead).toBe(before);
    const again = (await callTool("pr_evidence_get", { projectId, prNumber: 1504, expectedHead: HEAD })).structuredContent as
      { ok: boolean; reasonCode: string; evidence: { complete: boolean; incomplete: Array<{ kind: string }> } };
    expect(again).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE, evidence: { complete: false } });
    expect(again.evidence.incomplete).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "PATCH_OMITTED" })]));
    expect(snapshotOfState()).toBe(before);
  });
});
