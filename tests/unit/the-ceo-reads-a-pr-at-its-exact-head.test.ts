import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { acpError, allow, deny, type Evidence } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor, SessionLifecycle } from "../../src/domain/types.ts";
import { PR_EVIDENCE_DIFF_PAGE_MAX_CHARS } from "../../src/github/pr-evidence.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { type AuthenticatedMcpPeer, respond } from "../../src/mcp/shared.ts";
import { FakeGitHub, type FakePull } from "../helpers/fake-github.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

/**
 * The CEO reads one pull request of a project's registered repository at an exact head through acp-ceo's
 * `pr_evidence_get`: head, base and merge-base, mergeability, the changed files, the whole diff in bounded
 * pages, and the check runs and statuses at exactly that head against the repository's required checks.
 * GitHub is the kernel tests' FakeGitHub, extended below only with the read routes this tool asks for.
 */

const HEAD_A = "a1".repeat(20);
const HEAD_B = "b2".repeat(20);
const BASE = "c3".repeat(20);
const MERGE_BASE = "d4".repeat(20);
const ELSEWHERE = "e5".repeat(20);

type Row = Record<string, unknown>;

/** FakeGitHub plus the PR files, combined status, branch, rules and compare reads. */
class PrEvidenceGitHub extends FakeGitHub {
  /** The changed files GitHub holds for each head SHA. */
  filesByHead = new Map<string, Row[]>();
  /** Runs after a PR read is answered: a push landing between that read and the next one. */
  afterPullRead: ((number: number) => void) | null = null;
  statuses: Array<{ sha: string; context: string; state: string; target_url: string | null }> = [];
  branchBodies = new Map<string, Row>();
  rules = new Map<string, Row[]>();
  /** Each GET whose path matches answers with this HTTP status instead, as the credential store reports one. */
  failing: Array<{ pattern: RegExp; status: number }> = [];
  /** Rewrites an answer GitHub would give, for a response that is malformed or missing a field. */
  reshape: { compare?: (body: Row) => unknown; checkRuns?: (body: Row) => unknown; status?: (body: Row) => unknown } = {};

  override async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const failure = method === "GET" ? this.failing.find((entry) => entry.pattern.test(path)) : undefined;
    const pull = /\/pulls\/(\d+)$/.exec(path);
    const files = /\/repos\/acme\/fixture\/pulls\/(\d+)\/files\?per_page=(\d+)&page=(\d+)$/.exec(path);
    const status = /\/repos\/acme\/fixture\/commits\/([0-9a-f]{40})\/status\?per_page=(\d+)&page=(\d+)$/.exec(path);
    const branch = /\/repos\/acme\/fixture\/branches\/([^/?]+)$/.exec(path);
    const rules = /\/repos\/acme\/fixture\/rules\/branches\/([^/?]+)\?per_page=(\d+)&page=(\d+)$/.exec(path);
    const compare = /\/repos\/acme\/fixture\/compare\/([0-9a-f]{40})\.\.\.([^?]+)\?per_page=1$/.exec(path);
    const runs = /\/repos\/acme\/fixture\/commits\/([0-9a-f]{40})\/check-runs\?filter=latest&per_page=(\d+)&page=(\d+)$/.exec(path);
    const mine = failure !== undefined || files || status || branch || rules || compare || runs || (method === "GET" && pull);
    if (!mine) return super.request<T>(method, path, body);
    this.calls.push({ method, path, body });
    if (failure) throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: failure.status });
    const page = <R>(all: R[], size: string, at: string): R[] => all.slice((Number(at) - 1) * Number(size), Number(at) * Number(size));
    if (pull) {
      const found = this.pulls.find((p) => p.number === Number(pull[1]));
      if (!found) throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 404 });
      const answered = structuredClone(found);
      this.afterPullRead?.(found.number);
      return answered as T;
    }
    // By PR number: whatever the PR's head is when this request is answered.
    if (files) {
      const current = this.pulls.find((p) => p.number === Number(files[1]));
      return page(this.filesByHead.get(current?.head.sha ?? "") ?? [], files[2]!, files[3]!) as T;
    }
    if (status) {
      const sha = status[1]!;
      const all = this.statuses.filter((s) => s.sha === sha);
      const answer = { sha, state: all.every((s) => s.state === "success") ? "success" : "failure", total_count: all.length,
        statuses: page(all, status[2]!, status[3]!) };
      return (this.reshape.status ? this.reshape.status(answer) : answer) as T;
    }
    if (runs) {
      const all = this.checkRuns.filter((run) => run.head_sha === runs[1]);
      const answer = { total_count: all.length, check_runs: page(all, runs[2]!, runs[3]!) };
      return (this.reshape.checkRuns ? this.reshape.checkRuns(answer) : answer) as T;
    }
    if (branch) {
      const found = this.branchBodies.get(decodeURIComponent(branch[1]!));
      if (!found) throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 404 });
      return found as T;
    }
    if (rules) return page(this.rules.get(decodeURIComponent(rules[1]!)) ?? [], rules[2]!, rules[3]!) as T;
    if (compare) {
      // A 40-hex head is that commit; anything else is a branch name, resolved to its PR's head now.
      const named = decodeURIComponent(compare[2]!);
      const head = /^[0-9a-f]{40}$/.test(named) ? named : this.pulls.find((p) => p.head.ref === named)?.head.sha ?? "";
      // GitHub's compare lists at most 300 files.
      const answer = { status: "ahead", ahead_by: 2, behind_by: 0, base_commit: { sha: compare[1] }, merge_base_commit: { sha: MERGE_BASE },
        files: (this.filesByHead.get(head) ?? []).slice(0, 300),
        html_url: `https://github.com/acme/fixture/compare/${compare[1]}...${compare[2]}` };
      return (this.reshape.compare ? this.reshape.compare(answer) : answer) as T;
    }
    throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 404 });
  }
}

const fileRow = (index: number, padding = 900, tag = "A"): Row => ({
  filename: `src/f${String(index).padStart(3, "0")}.ts`,
  status: "modified",
  additions: 2,
  deletions: 1,
  changes: 3,
  patch: `@@ -1 +1,2 @@\n-old ${index}\n+new ${tag}${index}\n+${"x".repeat(padding)}`,
  blob_url: `https://github.com/acme/fixture/blob/${HEAD_A}/src/f${index}.ts`,
});

const pullRow = (number: number, head: string, changedFiles: number, extra: Row = {}): FakePull & Row => ({
  number,
  head: { sha: head, ref: `feat/pr-${number}` },
  base: { sha: BASE, ref: "main", repo: { full_name: "acme/fixture" } } as FakePull["base"],
  merged: false,
  state: "open",
  draft: false,
  title: `pull ${number}`,
  html_url: `https://github.com/acme/fixture/pull/${number}`,
  diff_url: `https://github.com/acme/fixture/pull/${number}.diff`,
  patch_url: `https://github.com/acme/fixture/pull/${number}.patch`,
  mergeable: true,
  mergeable_state: "clean",
  changed_files: changedFiles,
  additions: changedFiles * 2,
  deletions: changedFiles,
  commits: 2,
  ...extra,
});

interface Page {
  brief: {
    complete: boolean;
    baseSha: string;
    headSha: string;
    page: { offset: number; chars: number; totalChars: number; done: boolean; hasNextCursor: boolean; textAt: string };
    pull: { state: string; merged: boolean | null; mergeability: string } | null;
    gaps: { count: number; kinds: Record<string, number>; first: string[] };
  };
  compared: { baseSha: string; headSha: string };
  diff: { offset: number; chars: number; nextCursor: string | null; done: boolean; totalChars: number; sha256: string; text: string };
  incomplete: Array<{ kind: string; lookup: string; detail: string; file?: string; page?: number; status?: number }>;
  complete: boolean;
  summary: null | {
    pull: { state: string; merged: boolean | null; mergeable: boolean | null; mergeableState: string | null; mergeability: string };
    mergeBase: { sha: string } | null;
    files: Array<{ filename: string; additions: number; deletions: number; patchOmitted: boolean }>;
    checks: {
      checkRuns: Array<{ name: string; headSha: string; conclusion: string | null; url: string | null }>;
      statuses: Array<{ context: string; state: string; url: string | null }>;
    };
    requiredChecks: { declared: boolean; allSatisfied: boolean | null; contexts: Array<{ context: string; satisfied: boolean; observed: Array<{ state: string | null }> }> };
    urls: Record<string, unknown>;
  };
}
type Answer =
  | { ok: true; reasonCode: string; value: Page }
  | { ok: false; reasonCode: string; message: string; evidence: Row };

const LINEAGE = sha256("pr evidence lineage");
const ANCHOR = { liveHermesSessionId: "hermes-ceo-runtime", lineageRootDigest: LINEAGE };
const OWNER_TURN = { [HERMES_PROVENANCE_META_KEY]: {
  principal: "owner", session_id: ANCHOR.liveHermesSessionId, lineage_root_digest: LINEAGE, cron: false, delegation_depth: 0,
} };

let h: Harness;
let gh: PrEvidenceGitHub;
let projectId: string;
let ceoPeer: AuthenticatedMcpPeer;
let ctoPeer: AuthenticatedMcpPeer;
const open: Array<{ close(): Promise<void> }> = [];

const channel = async (peer: AuthenticatedMcpPeer, withProvenance = true) => {
  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, peer),
    withProvenance ? { provenance: ANCHOR } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pr-evidence", version: "1" });
  await client.connect(clientTransport);
  open.push(client, server);
  const raw = async (args: Row) =>
    client.callTool({ name: "pr_evidence_get", arguments: args, ...(withProvenance ? { _meta: OWNER_TURN } : {}) });
  return { client, raw, call: async (args: Row): Promise<Answer> => {
    const result = await raw(args);
    // Every answer of the tool is structured; anything else (an RPC error) fails the case with its text.
    if (!result.structuredContent) throw new Error(`pr_evidence_get gave no structured answer: ${JSON.stringify(result.content)}`);
    return result.structuredContent as Answer;
  } };
};

/**
 * What Hermes shows its model of a tool error: an MCP result with isError has its text blocks joined
 * (hermes-agent tools/mcp_tool.py) and cut at 2048 characters (tools/registry.py `_MAX_TOOL_ERROR_CHARS`).
 */
const HERMES_TOOL_ERROR_CAP = 2048;
const hermesView = (content: unknown): string =>
  (content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("").slice(0, HERMES_TOOL_ERROR_CAP);

/** What a reader of `seen` cannot find of an incomplete answer's key state; empty when all of it is there. */
const missingKeyState = (seen: string, page: Page): string[] => {
  const missing: string[] = [];
  if (!seen.includes(`"reasonCode": "${ReasonCode.COVERAGE_INCOMPLETE}"`)) missing.push("reasonCode");
  if (!seen.includes(`"baseSha": "${page.compared.baseSha}"`)) missing.push("baseSha");
  if (!seen.includes(`"headSha": "${page.compared.headSha}"`)) missing.push("headSha");
  if (!seen.includes(`"done": ${page.diff.done}`)) missing.push("done");
  if (!seen.includes(`"hasNextCursor": ${page.diff.nextCursor !== null}`) && !(page.diff.nextCursor !== null && seen.includes(`"nextCursor": "`))) {
    missing.push("nextCursor");
  }
  const kinds = new Map<string, number>();
  for (const entry of page.incomplete) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
  for (const [kind, n] of kinds) if (!seen.includes(`"${kind}": ${n}`)) missing.push(`count of ${kind}`);
  if (!seen.includes(page.incomplete[0]!.detail.slice(0, 30))) missing.push("first detail");
  return missing;
};

const ceoCall = async (args: Row): Promise<Answer> => (await channel(ceoPeer)).call(args);
const pageOf = (answer: Answer): Page => {
  if (!answer.ok) throw new Error(`pr_evidence_get refused: ${answer.reasonCode} ${answer.message}`);
  return answer.value;
};
const writesTo = (fake: FakeGitHub) => fake.calls.filter((call) => call.method !== "GET");

beforeAll(async () => {
  gh = new PrEvidenceGitHub();
  h = makeHarness({ githubClient: gh });
  ({ projectId } = await registerFixtureProject(h, "pr-evidence"));
  const ceoSessionId = bindCeo(h);
  const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  ceoPeer = { actor: ceoSessionId, sessionId: ceoSessionId, sessionIncarnation: ceo.sessionIncarnation,
    binding: { roleKey: ceo.roleKey, bindingGeneration: ceo.bindingGeneration } };
  const ctoSession = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
  h.cp.sessions.transition(ctoSession.sessionId, SessionLifecycle.READY, "test");
  const cto = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: ctoSession.sessionId, projectId });
  if (!cto.allowed) throw new Error(cto.message);
  ctoPeer = { actor: ctoSession.sessionId, sessionId: ctoSession.sessionId, sessionIncarnation: ctoSession.incarnation,
    binding: { roleKey: cto.value.roleKey, bindingGeneration: cto.value.bindingGeneration } };
}, 120_000);

beforeEach(() => {
  gh.pulls = [];
  gh.filesByHead.clear();
  gh.afterPullRead = null;
  gh.checkRuns = [];
  gh.statuses = [];
  gh.failing = [];
  gh.reshape = {};
  gh.rules.clear();
  gh.branchBodies.clear();
  gh.branchBodies.set("main", { name: "main", protected: true, protection: { enabled: true,
    required_status_checks: { enforcement_level: "everyone", contexts: ["ci"], checks: [{ context: "ci", app_id: null }] } } });
  gh.rules.set("main", [{ type: "required_status_checks", ruleset_id: 9, parameters: { required_status_checks: [{ context: "lint" }] } }]);
  gh.calls.length = 0;
});

afterEach(async () => {
  // No case below may make GitHub write anything.
  expect(writesTo(gh)).toEqual([]);
  while (open.length > 0) await open.pop()!.close();
});

afterAll(async () => {
  h?.cp.close();
  cleanupTempDirs();
});

/** A green 150-file PR at HEAD_A: two GitHub file pages, a passing check and status at the head. */
const seedNormalPull = (number: number, extra: Row = {}): void => {
  gh.pulls.push(pullRow(number, HEAD_A, 150, extra));
  gh.filesByHead.set(HEAD_A, Array.from({ length: 150 }, (_, i) => fileRow(i)));
  gh.checkRuns.push(
    { id: 1, name: "ci", head_sha: HEAD_A, status: "completed", conclusion: "success", app: { slug: "github-actions" },
      details_url: "https://github.com/acme/fixture/actions/runs/1" },
    // The same check at another commit is never this head's evidence.
    { id: 2, name: "ci", head_sha: ELSEWHERE, status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
  );
  gh.statuses.push(
    { sha: HEAD_A, context: "lint", state: "success", target_url: "https://ci.example/lint/1" },
    { sha: ELSEWHERE, context: "lint", state: "failure", target_url: null },
  );
};

/** Every page from the first, following nextCursor, each one answered. */
const readAllPages = async (number: number, pageChars: number): Promise<Page[]> => {
  const pages: Page[] = [];
  let cursor: string | null | undefined;
  do {
    const page = pageOf(await ceoCall({ projectId, prNumber: number, expectedHead: HEAD_A, pageChars, ...(cursor ? { cursor } : {}) }));
    pages.push(page);
    cursor = page.diff.nextCursor;
  } while (cursor);
  return pages;
};

describe("pr_evidence_get", () => {
  it("is an acp-ceo tool and not a CTO tool", async () => {
    const { client } = await channel(ceoPeer);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("pr_evidence_get");
    const cto = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, ctoPeer));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await cto.connect(serverTransport);
    const ctoClient = new Client({ name: "pr-evidence-cto", version: "1" });
    await ctoClient.connect(clientTransport);
    open.push(ctoClient, cto);
    expect((await ctoClient.listTools()).tools.map((tool) => tool.name)).not.toContain("pr_evidence_get");
  });

  it("returns the whole diff of a multi-page PR in chained pages, with the checks at exactly its head", async () => {
    seedNormalPull(7);
    const pages = await readAllPages(7, 40_000);
    expect(pages.length).toBeGreaterThan(3);
    const [first] = pages;
    // Every page carries the compared SHAs, a token and a done flag; only the last is done.
    for (const page of pages) expect(page.compared).toEqual({ baseSha: BASE, headSha: HEAD_A });
    expect(pages.slice(0, -1).every((page) => !page.diff.done && typeof page.diff.nextCursor === "string")).toBe(true);
    expect(pages.at(-1)!.diff).toMatchObject({ done: true, nextCursor: null });
    // The pages chain with no gap and join to the text the digest names.
    pages.forEach((page, i) => expect(page.diff.offset).toBe(i === 0 ? 0 : pages[i - 1]!.diff.offset + pages[i - 1]!.diff.chars));
    const joined = pages.map((page) => page.diff.text).join("");
    expect(joined.length).toBe(first!.diff.totalChars);
    expect(sha256(joined)).toBe(first!.diff.sha256);
    expect(pages.every((page) => page.diff.sha256 === first!.diff.sha256 && page.diff.totalChars === joined.length)).toBe(true);
    // Every file's patch is in the diff, in GitHub's order, under its own header.
    let at = 0;
    for (const row of gh.filesByHead.get(HEAD_A)!) {
      const header = joined.indexOf(`diff --git a/${String(row["filename"])} b/${String(row["filename"])}\n`, at);
      expect(header, String(row["filename"])).toBeGreaterThanOrEqual(at);
      const patch = joined.indexOf(String(row["patch"]), header);
      expect(patch).toBeGreaterThan(header);
      at = patch;
    }
    // The files and patches were read by the compared SHAs on every page, never by PR number.
    const compares = gh.calls.filter((call) => call.path.includes("/compare/"));
    expect(compares.length).toBe(pages.length);
    expect(compares.every((call) => call.path === `/repos/acme/fixture/compare/${BASE}...${HEAD_A}?per_page=1`)).toBe(true);
    expect(gh.calls.some((call) => call.path.includes("/files"))).toBe(false);

    const summary = first!.summary!;
    expect(first!.complete).toBe(true);
    expect(first!.incomplete).toEqual([]);
    expect(summary.pull).toMatchObject({ state: "open", mergeable: true, mergeableState: "clean" });
    expect(summary.mergeBase).toMatchObject({ sha: MERGE_BASE });
    expect(summary.files).toHaveLength(150);
    expect(summary.files[0]).toMatchObject({ filename: "src/f000.ts", additions: 2, deletions: 1, patchOmitted: false });
    expect(summary.checks.checkRuns).toEqual([expect.objectContaining({ name: "ci", headSha: HEAD_A, conclusion: "success",
      url: "https://github.com/acme/fixture/actions/runs/1" })]);
    expect(summary.checks.statuses).toEqual([expect.objectContaining({ context: "lint", state: "success", url: "https://ci.example/lint/1" })]);
    expect(summary.requiredChecks).toMatchObject({ declared: true, allSatisfied: true });
    expect(summary.requiredChecks.contexts.map((c) => [c.context, c.satisfied])).toEqual([["ci", true], ["lint", true]]);
    expect(summary.urls).toMatchObject({ pull: "https://github.com/acme/fixture/pull/7", diff: "https://github.com/acme/fixture/pull/7.diff" });
    // Continuation pages carry no second summary.
    expect(pages.slice(1).every((page) => page.summary === null)).toBe(true);
    // Checks were asked for at the head SHA, never by branch or by another commit.
    const checkReads = gh.calls.filter((call) => /\/check-runs|\/status\?/.test(call.path));
    expect(checkReads.length).toBeGreaterThan(0);
    expect(checkReads.every((call) => call.path.includes(`/commits/${HEAD_A}/`))).toBe(true);
  });

  it("reports a required check that is not green at the head as unsatisfied", async () => {
    seedNormalPull(8);
    gh.checkRuns[0] = { ...gh.checkRuns[0]!, conclusion: "failure" };
    const page = pageOf(await ceoCall({ projectId, prNumber: 8, expectedHead: HEAD_A }));
    expect(page.summary!.requiredChecks).toMatchObject({ declared: true, allSatisfied: false });
    expect(page.summary!.requiredChecks.contexts.find((c) => c.context === "ci")).toMatchObject({ satisfied: false });
  });

  it("counts neutral and skipped like success for a required check, as GitHub's protected branches do", async () => {
    seedNormalPull(20);
    gh.checkRuns[0] = { ...gh.checkRuns[0]!, conclusion: "neutral" };
    gh.checkRuns.push({ id: 4, name: "docs", head_sha: HEAD_A, status: "completed", conclusion: "skipped" });
    gh.branchBodies.set("main", { name: "main", protected: true, protection: { enabled: true,
      required_status_checks: { enforcement_level: "everyone", contexts: ["ci", "docs"], checks: [{ context: "ci", app_id: null }, { context: "docs", app_id: null }] } } });
    const page = pageOf(await ceoCall({ projectId, prNumber: 20, expectedHead: HEAD_A }));
    expect(page.summary!.requiredChecks.contexts.map((c) => [c.context, c.satisfied, c.observed.map((o) => o.state)]))
      .toEqual([["ci", true, ["neutral"]], ["docs", true, ["skipped"]], ["lint", true, ["success"]]]);
    expect(page.summary!.requiredChecks.allSatisfied).toBe(true);
  });

  it("binds the diff to the head it is labelled with when the PR moves while it is read", async () => {
    // Same file count at both heads, different patches.
    gh.pulls.push(pullRow(18, HEAD_A, 3));
    gh.filesByHead.set(HEAD_A, [0, 1, 2].map((i) => fileRow(i, 10, "A")));
    gh.filesByHead.set(HEAD_B, [0, 1, 2].map((i) => fileRow(i, 10, "B")));
    gh.checkRuns.push({ id: 5, name: "ci", head_sha: HEAD_A, status: "completed", conclusion: "success" });
    gh.statuses.push({ sha: HEAD_A, context: "lint", state: "success", target_url: null });
    // A push to B lands right after the PR read answers A.
    gh.afterPullRead = (number) => { if (number === 18) gh.pulls[0] = pullRow(18, HEAD_B, 3); };
    const page = pageOf(await ceoCall({ projectId, prNumber: 18, expectedHead: HEAD_A }));
    expect(page.compared.headSha).toBe(HEAD_A);
    expect(page.diff.text).toContain("+new A0\n");
    expect(page.diff.text).not.toContain("+new B");
    expect(page.summary!.checks.checkRuns.every((run) => run.headSha === HEAD_A)).toBe(true);
  });

  it("carries the first page's incompleteness onto every continuation page", async () => {
    seedNormalPull(19);
    gh.failing.push({ pattern: /\/check-runs/, status: 502 });
    const first = await ceoCall({ projectId, prNumber: 19, expectedHead: HEAD_A, pageChars: 40_000 });
    expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
    if (first.ok) throw new Error("unreachable");
    let cursor = (first.evidence as unknown as Page).diff.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    // GitHub recovers; the snapshot the pages belong to stays incomplete.
    gh.failing = [];
    let continuations = 0;
    while (cursor) {
      const next = await ceoCall({ projectId, prNumber: 19, expectedHead: HEAD_A, pageChars: 40_000, cursor });
      expect(next).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
      if (next.ok) throw new Error("unreachable");
      const page = next.evidence as unknown as Page;
      expect(page.complete).toBe(false);
      expect(page.incomplete).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "SNAPSHOT_INCOMPLETE" })]));
      cursor = page.diff.nextCursor;
      continuations += 1;
    }
    expect(continuations).toBeGreaterThan(1);
  });

  describe("never reads a malformed or missing field as complete", () => {
    /** A valid PR with no changed files and passing required checks: only the reshaped answer can be wrong. */
    const seedEmptyPull = (): void => {
      gh.pulls.push(pullRow(22, HEAD_A, 0));
      gh.filesByHead.set(HEAD_A, []);
      gh.checkRuns.push({ id: 7, name: "ci", head_sha: HEAD_A, status: "completed", conclusion: "success" });
      gh.statuses.push({ sha: HEAD_A, context: "lint", state: "success", target_url: null });
    };
    const without = (body: Row, field: string): Row => {
      const copy = { ...body };
      delete copy[field];
      return copy;
    };

    it("answers the unreshaped PR as complete", async () => {
      seedEmptyPull();
      const page = pageOf(await ceoCall({ projectId, prNumber: 22, expectedHead: HEAD_A }));
      expect(page).toMatchObject({ complete: true, incomplete: [] });
      expect(page.summary!.requiredChecks.allSatisfied).toBe(true);
    });

    it.each<[string, PrEvidenceGitHub["reshape"], string]>([
      ["a null compare answer", { compare: () => null }, "/compare/"],
      ["a compare answer that is a list", { compare: () => [] }, "/compare/"],
      ["a compare with no merge_base_commit", { compare: (b) => without(b, "merge_base_commit") }, "/compare/"],
      ["a compare whose merge-base is not a SHA", { compare: (b) => ({ ...b, merge_base_commit: { sha: "main" } }) }, "/compare/"],
      ["a compare with no files list", { compare: (b) => without(b, "files") }, "/compare/"],
      ["a compare with no status", { compare: (b) => without(b, "status") }, "/compare/"],
      ["a compare for another base commit", { compare: (b) => ({ ...b, base_commit: { sha: ELSEWHERE } }) }, "/compare/"],
      ["a compare with no base commit", { compare: (b) => without(b, "base_commit") }, "/compare/"],
      ["a null check-runs answer", { checkRuns: () => null }, "/check-runs"],
      ["check runs with no total_count", { checkRuns: (b) => without(b, "total_count") }, "/check-runs"],
      ["a null combined status", { status: () => null }, "/status"],
      ["a combined status with no total_count", { status: (b) => without(b, "total_count") }, "/status"],
      ["a combined status with no sha", { status: (b) => without(b, "sha") }, "/status"],
    ])("names %s as incomplete", async (_name, reshape, lookup) => {
      seedEmptyPull();
      gh.reshape = reshape;
      const answer = await ceoCall({ projectId, prNumber: 22, expectedHead: HEAD_A });
      expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
      if (answer.ok) throw new Error("unreachable");
      const page = answer.evidence as unknown as Page;
      expect(page.complete).toBe(false);
      expect(page.incomplete).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "MALFORMED_RESPONSE", lookup: expect.stringContaining(lookup) }),
      ]));
      expect(page.summary!.requiredChecks.allSatisfied).not.toBe(true);
    });
  });

  describe("mergeability on a pull request that is no longer open", () => {
    /** GitHub never computes mergeability again once a pull request is closed: null and "unknown" for good. */
    const uncomputed = { mergeable: null, mergeable_state: "unknown" };

    it.each<[string, Row, string]>([
      ["merged", { state: "closed", merged: true }, "NOT_APPLICABLE_MERGED"],
      ["closed without merging", { state: "closed", merged: false }, "NOT_APPLICABLE_CLOSED"],
    ])("names mergeability as not applying to a %s PR, which alone leaves the answer complete", async (_name, extra, mergeability) => {
      seedNormalPull(23, { ...uncomputed, ...extra });
      const page = pageOf(await ceoCall({ projectId, prNumber: 23, expectedHead: HEAD_A }));
      expect(page).toMatchObject({ complete: true, incomplete: [] });
      const pull = { state: "closed", merged: extra["merged"], mergeability };
      expect(page.summary!.pull).toMatchObject({ ...pull, mergeable: null, mergeableState: "unknown" });
      expect(page.brief.pull).toEqual(pull);
      // Checks are judged at the head as for any PR: here they pass there.
      expect(page.summary!.requiredChecks.allSatisfied).toBe(true);
    });

    it("still names an open PR whose mergeability GitHub has not computed as incomplete", async () => {
      seedNormalPull(24, uncomputed);
      const answer = await ceoCall({ projectId, prNumber: 24, expectedHead: HEAD_A });
      expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
      if (answer.ok) throw new Error("unreachable");
      const page = answer.evidence as unknown as Page;
      expect(page.incomplete).toEqual([expect.objectContaining({ kind: "MERGEABILITY_NOT_COMPUTED" })]);
      expect(page.summary!.pull).toMatchObject({ state: "open", merged: false, mergeability: "NOT_COMPUTED" });
      expect(page.summary!.requiredChecks.allSatisfied).toBeNull();
    });

    it("keeps a merged PR whose check read fails incomplete", async () => {
      seedNormalPull(25, { ...uncomputed, state: "closed", merged: true });
      gh.failing.push({ pattern: /\/check-runs/, status: 502 });
      const answer = await ceoCall({ projectId, prNumber: 25, expectedHead: HEAD_A });
      expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
      if (answer.ok) throw new Error("unreachable");
      const page = answer.evidence as unknown as Page;
      expect(page.complete).toBe(false);
      expect(page.incomplete).toEqual([expect.objectContaining({ kind: "LOOKUP_FAILED", status: 502, lookup: expect.stringContaining("/check-runs") })]);
      expect(page.summary!.pull).toMatchObject({ merged: true, mergeability: "NOT_APPLICABLE_MERGED" });
      expect(page.summary!.requiredChecks.allSatisfied).not.toBe(true);
    });
  });

  it("keeps an incomplete answer's key state inside what Hermes shows of a tool error", async () => {
    // Twenty files GitHub gave no patch for, each with a long path that JSON escapes, ahead of a diff larger than one page.
    const longPath = (i: number): string => `assets/${"gen \"q\\\\\"/".repeat(18)}blob-${String(i).padStart(2, "0")}.bin`;
    const omitted = Array.from({ length: 20 }, (_, i) => {
      const row: Row = { ...fileRow(i), filename: longPath(i) };
      delete row["patch"];
      return row;
    });
    gh.filesByHead.set(HEAD_A, [...omitted, ...Array.from({ length: 150 }, (_, i) => fileRow(100 + i))]);
    // Every kind of gap a first page can name, at once.
    gh.pulls.push(pullRow(30, HEAD_A, 171, { mergeable: null, mergeable_state: "unknown" }));
    gh.reshape = { compare: (body) => ({ ...body, status: null }), status: (body) => ({ ...body, sha: ELSEWHERE }) };
    gh.failing.push({ pattern: /\/check-runs/, status: 502 }, { pattern: /\/branches\/main$/, status: 403 });
    gh.rules.set("main", Array.from({ length: 1_000 }, () => ({ type: "deletion" })));

    const { raw } = await channel(ceoPeer);
    const result = await raw({ projectId, prNumber: 30, expectedHead: HEAD_A, pageChars: PR_EVIDENCE_DIFF_PAGE_MAX_CHARS - 1 });
    expect(result.isError).toBe(true);
    const body = result.structuredContent as { reasonCode: string; message: string; evidence: Row };
    expect(body.reasonCode).toBe(ReasonCode.COVERAGE_INCOMPLETE);
    const page = body.evidence as unknown as Page;
    expect(page.incomplete.length).toBeGreaterThanOrEqual(25);
    expect(new Set(page.incomplete.map((entry) => entry.kind)).size).toBe(8);
    expect(page.diff.chars).toBe(PR_EVIDENCE_DIFF_PAGE_MAX_CHARS - 1);
    expect(page.diff.nextCursor!.length).toBeGreaterThan(400);

    const seen = hermesView(result.content);
    expect(missingKeyState(seen, page)).toEqual([]);
    // The page's text is not in view, and what is in view says where it is rather than presenting it.
    expect(seen).not.toContain("diff --git");
    expect(seen).toContain(`"chars": ${page.diff.chars}`);
    expect(seen).toContain(JSON.stringify(page.brief.page.textAt));
    expect(page.brief.gaps.first.length).toBeGreaterThan(1);
    for (const first of page.brief.gaps.first) expect(seen).toContain(JSON.stringify(first));

    // Mutation witnesses, through the same emitter: the field order this tool had before fails the check,
    // and so does moving `incomplete` ahead of the diff without the bounded brief.
    const emitted = (evidence: Row): string => hermesView(respond(deny(ReasonCode.COVERAGE_INCOMPLETE, body.message, evidence as Evidence)).content);
    const e = body.evidence;
    const before = { schema: e["schema"], projectId: e["projectId"], repositoryIdentity: e["repositoryIdentity"], repositoryRole: e["repositoryRole"],
      prNumber: e["prNumber"], compared: e["compared"], diff: e["diff"], incomplete: e["incomplete"], complete: e["complete"], summary: e["summary"] };
    expect(missingKeyState(emitted(before), page)).toEqual(expect.arrayContaining(["first detail", "count of PATCH_OMITTED"]));
    const reorderedOnly = { schema: e["schema"], projectId: e["projectId"], repositoryIdentity: e["repositoryIdentity"], repositoryRole: e["repositoryRole"],
      prNumber: e["prNumber"], compared: e["compared"], complete: e["complete"], incomplete: e["incomplete"], summary: e["summary"], diff: e["diff"] };
    expect(missingKeyState(emitted(reorderedOnly), page)).toEqual(expect.arrayContaining(["done", "nextCursor", "count of PATCH_OMITTED"]));
  });

  it("names a PR over GitHub's 300-file compare limit as incomplete", async () => {
    gh.pulls.push(pullRow(21, HEAD_A, 301));
    gh.filesByHead.set(HEAD_A, Array.from({ length: 301 }, (_, i) => fileRow(i, 1)));
    gh.checkRuns.push({ id: 6, name: "ci", head_sha: HEAD_A, status: "completed", conclusion: "success" });
    gh.statuses.push({ sha: HEAD_A, context: "lint", state: "success", target_url: null });
    const answer = await ceoCall({ projectId, prNumber: 21, expectedHead: HEAD_A });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
    if (answer.ok) throw new Error("unreachable");
    expect((answer.evidence as unknown as Page).incomplete).toEqual([expect.objectContaining({ kind: "COUNT_MISMATCH" })]);
  });

  it("refuses a project, PR or input that is not a registered repository's, before asking GitHub", async () => {
    seedNormalPull(9);
    expect(await ceoCall({ projectId: "not-a-project", prNumber: 9, expectedHead: HEAD_A }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    for (const projectLike of ["https://github.com/acme/fixture", "github:acme/fixture", "../pr-evidence", "/Users/isaac/projects/x"]) {
      expect(await ceoCall({ projectId: projectLike, prNumber: 9, expectedHead: HEAD_A }), projectLike)
        .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    }
    expect(await ceoCall({ projectId, prNumber: 9, expectedHead: HEAD_A, repositoryRole: "https://github.com/other/repo" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(await ceoCall({ projectId, prNumber: 9, expectedHead: HEAD_A, repositoryRole: "secondary" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(await ceoCall({ projectId, prNumber: 9, expectedHead: "main" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(gh.calls).toEqual([]);
    // A PR number the registered repository does not have is GitHub's 404, named NOT_FOUND.
    expect(await ceoCall({ projectId, prNumber: 404, expectedHead: HEAD_A }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    // A page token another PR was issued is not this PR's.
    const first = pageOf(await ceoCall({ projectId, prNumber: 9, expectedHead: HEAD_A, pageChars: 1_000 }));
    gh.pulls.push(pullRow(10, HEAD_A, 150));
    expect(await ceoCall({ projectId, prNumber: 10, expectedHead: HEAD_A, cursor: first.diff.nextCursor }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(await ceoCall({ projectId, prNumber: 9, expectedHead: HEAD_A, cursor: "eyJ2IjoxfQ" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    // A token whose payload was edited (here: a later offset) is not one this tool issued.
    const [payload, mac] = first.diff.nextCursor!.split(".");
    const edited = { ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Row, o: 5_000 };
    const forged = `${Buffer.from(JSON.stringify(edited), "utf8").toString("base64url")}.${mac}`;
    expect(await ceoCall({ projectId, prNumber: 9, expectedHead: HEAD_A, cursor: forged }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
  });

  it("reports a head that is not the expected one as a mismatch with both SHAs and nothing else", async () => {
    seedNormalPull(11);
    const answer = await ceoCall({ projectId, prNumber: 11, expectedHead: HEAD_B });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.MERGE_HEAD_STALE,
      evidence: { expectedHead: HEAD_B, headSha: HEAD_A, prNumber: 11 } });
    expect(JSON.stringify(answer)).not.toContain("diff --git");
    expect(gh.calls.every((call) => /\/pulls\/11$/.test(call.path))).toBe(true);
  });

  it("refuses a page token issued against another head, and a head that moved between pages", async () => {
    seedNormalPull(12);
    const first = pageOf(await ceoCall({ projectId, prNumber: 12, expectedHead: HEAD_A, pageChars: 5_000 }));
    const token = first.diff.nextCursor!;
    expect(first.diff.done).toBe(false);
    // The head moves to HEAD_B with the same files.
    gh.pulls[0] = pullRow(12, HEAD_B, 150);
    gh.filesByHead.set(HEAD_B, gh.filesByHead.get(HEAD_A)!);
    // The CEO asking for HEAD_B with HEAD_A's token: the token names another head.
    expect(await ceoCall({ projectId, prNumber: 12, expectedHead: HEAD_B, cursor: token })).toMatchObject({
      ok: false, reasonCode: ReasonCode.SNAPSHOT_STALE, evidence: { tokenHeadSha: HEAD_A, expectedHead: HEAD_B } });
    // The CEO still expecting HEAD_A: the PR's head moved under the pages already read.
    expect(await ceoCall({ projectId, prNumber: 12, expectedHead: HEAD_A, cursor: token })).toMatchObject({
      ok: false, reasonCode: ReasonCode.MERGE_HEAD_STALE, evidence: { expectedHead: HEAD_A, headSha: HEAD_B } });
    // The same head with a different diff (a page of files changed under it) refuses the token too.
    gh.pulls[0] = pullRow(12, HEAD_A, 150);
    gh.filesByHead.set(HEAD_A, [...gh.filesByHead.get(HEAD_A)!.slice(0, 149), fileRow(999)]);
    expect(await ceoCall({ projectId, prNumber: 12, expectedHead: HEAD_A, cursor: token }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.SNAPSHOT_STALE });
  });

  it("names a failed diff read as incomplete and never reports the checks as satisfied", async () => {
    seedNormalPull(13);
    gh.failing.push({ pattern: /\/compare\//, status: 502 });
    const answer = await ceoCall({ projectId, prNumber: 13, expectedHead: HEAD_A });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
    if (answer.ok) throw new Error("unreachable");
    const page = answer.evidence as unknown as Page;
    expect(page.complete).toBe(false);
    expect(page.incomplete).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "LOOKUP_FAILED", status: 502 }),
      expect.objectContaining({ kind: "COUNT_MISMATCH" }),
    ]));
    expect(page.summary!.requiredChecks.allSatisfied).toBeNull();
    expect(JSON.stringify(answer)).not.toMatch(/"allSatisfied":\s*true/);
  });

  it("names every file whose patch GitHub omitted as incomplete", async () => {
    gh.pulls.push(pullRow(14, HEAD_A, 3));
    const omitted: Row = { ...fileRow(1), filename: "assets/huge.json", additions: 40_000, changes: 40_000 };
    delete omitted["patch"];
    gh.filesByHead.set(HEAD_A, [fileRow(0), omitted, fileRow(2)]);
    gh.checkRuns.push({ id: 3, name: "ci", head_sha: HEAD_A, status: "completed", conclusion: "success" });
    gh.statuses.push({ sha: HEAD_A, context: "lint", state: "success", target_url: null });
    const answer = await ceoCall({ projectId, prNumber: 14, expectedHead: HEAD_A });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
    if (answer.ok) throw new Error("unreachable");
    const page = answer.evidence as unknown as Page;
    expect(page.incomplete).toEqual([expect.objectContaining({ kind: "PATCH_OMITTED", file: "assets/huge.json" })]);
    expect(page.summary!.files.find((f) => f.filename === "assets/huge.json")).toMatchObject({ patchOmitted: true });
    expect(page.summary!.requiredChecks.allSatisfied).toBeNull();
    expect(page.diff.text).toContain("diff --git a/assets/huge.json b/assets/huge.json\n");
  });

  it("names a GitHub permission error explicitly", async () => {
    seedNormalPull(15);
    gh.failing.push({ pattern: /\/pulls\/15$/, status: 403 });
    expect(await ceoCall({ projectId, prNumber: 15, expectedHead: HEAD_A })).toMatchObject({
      ok: false, reasonCode: ReasonCode.GITHUB_APP_PERMISSION_DENIED, evidence: { status: 403 } });
    gh.failing = [{ pattern: /\/check-runs/, status: 403 }];
    const answer = await ceoCall({ projectId, prNumber: 15, expectedHead: HEAD_A });
    expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
    if (answer.ok) throw new Error("unreachable");
    expect((answer.evidence as unknown as Page).incomplete).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "PERMISSION_DENIED", status: 403 }),
    ]));
  });

  it("refuses a CTO caller and any caller that is not the current CEO's admitted turn, with no GitHub read", async () => {
    seedNormalPull(16);
    const asCto = await (await channel(ctoPeer)).call({ projectId, prNumber: 16, expectedHead: HEAD_A });
    expect(asCto).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    // The CEO's session presented with a CTO binding.
    const mixed = await (await channel({ ...ceoPeer, binding: ctoPeer.binding! })).call({ projectId, prNumber: 16, expectedHead: HEAD_A });
    expect(mixed).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    // The CEO's session on a channel that admits no Hermes turn.
    const noTurn = await (await channel(ceoPeer, false)).call({ projectId, prNumber: 16, expectedHead: HEAD_A });
    expect(noTurn).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    expect(gh.calls).toEqual([]);
  });

  it("issues only GET requests to GitHub", async () => {
    seedNormalPull(17);
    await readAllPages(17, 20_000);
    expect(gh.calls.length).toBeGreaterThan(5);
    expect(new Set(gh.calls.map((call) => call.method))).toEqual(new Set(["GET"]));
  });
});
