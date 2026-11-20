import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createSystemRequestWatcher, systemRequestNotification } from "../../src/buzz/buzz-channel-system-request.ts";
import {
  COMPACT_BOUNDARY_MARK, CTO_CONVERSATION_MAX_BYTES, CTO_CONVERSATION_MAX_COMPACTIONS, CTO_HANDOFF_MAX_BYTES, CTO_HANDOFF_WAIT_MS,
  CTO_REFRESH_BACKOFF_INITIAL_MS, buildFallbackHandoff, clearHandoffRequest, clipUtf8, createConversationMeter, ctoTranscriptPath, handoffPathOf, handoffRequestText,
  hostConversationFiles, hostStoreFiles, inflightPathOf, listInflightProjects, longReasons, readHandoff, readHandoffRequest, readInflightRefresher, readRefreshFailure,
  recordRefreshFailure, refreshLimitsFromEnv, retryNotBefore,
  writeHandoff, writeHandoffRequest, type ConversationFiles, type FallbackFacts,
} from "../../src/cto/cto-session-refresh.ts";
import { createRefreshQueue, ctoRefreshOperator } from "../../src/daemon/cto-refresh-queue.ts";
import { CTO_RECOVERY_RETRY_MS, createCtoRefreshSweep, type RefreshCandidate, type RefreshSweepDeps } from "../../src/daemon/cto-session-refresh-sweep.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

describe("measuring a conversation", () => {
  it("counts compaction boundaries in a transcript of any size, including one the read buffer cuts in two, and never a quoted mention", () => {
    const dir = tempDir("acp-refresh-measure-");
    const file = join(dir, "t.jsonl");
    const boundary = `{"type":"system",${COMPACT_BOUNDARY_MARK},"content":"Conversation compacted"}\n`;
    // A line whose text only quotes the mark (as a JSON string, so the quotes are escaped) is not a boundary.
    const quoted = `{"type":"user","message":"the transcript has ${COMPACT_BOUNDARY_MARK.replaceAll('"', '\\"')} in it"}\n`;
    const pad = (n: number): string => `${"x".repeat(n - 1)}\n`;
    // The first boundary starts a few bytes before the 1 MiB chunk edge, so the edge cuts its mark in two.
    const first = (1 << 20) - 30;
    writeFileSync(file, pad(first) + boundary + quoted + pad(2_500_000) + boundary + boundary);
    expect(hostConversationFiles.countMarks(file, COMPACT_BOUNDARY_MARK)).toBe(3);
    expect(hostConversationFiles.stat(file)?.size).toBeGreaterThan(3_000_000);
    expect(hostConversationFiles.countMarks(join(dir, "absent.jsonl"), COMPACT_BOUNDARY_MARK)).toBeNull();
    expect(hostConversationFiles.stat(join(dir, "absent.jsonl"))).toBeNull();
  });

  it("counts only what was appended: a mark in the new bytes, and none twice", () => {
    const dir = tempDir("acp-refresh-append-");
    const file = join(dir, "t.jsonl");
    const boundary = `{"type":"system",${COMPACT_BOUNDARY_MARK}}\n`;
    writeFileSync(file, `{"type":"user"}\n${boundary}`);
    const meter = createConversationMeter();
    expect(meter.measure(file)).toMatchObject({ compactions: 1 });
    appendFileSync(file, `{"type":"assistant"}\n${boundary}${boundary}`);
    expect(meter.measure(file)).toMatchObject({ compactions: 3 });
    appendFileSync(file, `{"type":"user"}\n`);
    expect(meter.measure(file)).toMatchObject({ compactions: 3 });
    // The counted range starts a few bytes inside the old end, and is what the second look reads.
    const asked: number[] = [];
    let size = 100;
    const files: ConversationFiles = { stat: () => ({ size, mtimeMs: size }), countMarks: (_path, _mark, from = 0) => { asked.push(from); return 0; } };
    const watched = createConversationMeter(files);
    watched.measure("/t");
    size = 160;
    watched.measure("/t");
    size = 120;
    watched.measure("/t");
    expect(asked).toEqual([0, 100 - (Buffer.byteLength(COMPACT_BOUNDARY_MARK) - 1), 0]);
  });

  it("counts again only when the transcript's size or time moved", () => {
    let counts = 0;
    let state = { size: 100, mtimeMs: 1, marks: 1 };
    const files: ConversationFiles = { stat: () => ({ size: state.size, mtimeMs: state.mtimeMs }), countMarks: () => { counts++; return state.marks; } };
    const meter = createConversationMeter(files);
    expect(meter.measure("/t")).toMatchObject({ bytes: 100, compactions: 1 });
    expect(meter.measure("/t")).toMatchObject({ bytes: 100, compactions: 1 });
    expect(counts).toBe(1);
    // The file grew by one mark: the fake counts the marks of the range asked for, which is the appended part.
    state = { size: 150, mtimeMs: 2, marks: 1 };
    expect(meter.measure("/t")).toMatchObject({ bytes: 150, compactions: 2 });
    expect(counts).toBe(2);
  });

  it("is long at 20 MB or at three compactions, inclusive, and the limits are configurable", () => {
    expect(CTO_CONVERSATION_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(CTO_CONVERSATION_MAX_COMPACTIONS).toBe(3);
    expect(longReasons({ bytes: CTO_CONVERSATION_MAX_BYTES - 1, compactions: 2 })).toEqual([]);
    expect(longReasons({ bytes: CTO_CONVERSATION_MAX_BYTES, compactions: 0 })).toEqual(["bytes"]);
    expect(longReasons({ bytes: 1, compactions: 3 })).toEqual(["compactions"]);
    expect(longReasons({ bytes: CTO_CONVERSATION_MAX_BYTES + 1, compactions: 4 })).toEqual(["bytes", "compactions"]);
    const limits = refreshLimitsFromEnv({ ACP_CTO_REFRESH_MAX_BYTES: "1000", ACP_CTO_REFRESH_MAX_COMPACTIONS: "1" });
    expect(longReasons({ bytes: 1000, compactions: 0 }, limits)).toEqual(["bytes"]);
    expect(longReasons({ bytes: 1, compactions: 1 }, limits)).toEqual(["compactions"]);
    // Anything that is not a positive integer leaves the defaults.
    expect(refreshLimitsFromEnv({ ACP_CTO_REFRESH_MAX_BYTES: "0", ACP_CTO_REFRESH_MAX_COMPACTIONS: "many" })).toEqual({ maxBytes: CTO_CONVERSATION_MAX_BYTES, maxCompactions: 3 });
  });

  it("finds a transcript where Claude Code keeps it: under the folder, every non-alphanumeric character a dash", () => {
    expect(ctoTranscriptPath("/Users/me", "/Users/me/projects/logic-pro-mcp", "abc")).toBe("/Users/me/.claude/projects/-Users-me-projects-logic-pro-mcp/abc.jsonl");
  });
});

describe("the handoff store", () => {
  const dir = () => tempDir("acp-refresh-store-");
  const input = (over: Partial<Parameters<typeof writeHandoff>[2]> = {}): Parameters<typeof writeHandoff>[2] =>
    ({ projectId: "p", generation: 3, conversation: "conv-1", source: "cto", text: "keep going", now: iso(T0), ...over });

  it("keeps a handoff durably by project and generation, and nothing for another generation", () => {
    const state = dir();
    expect(writeHandoff(hostStoreFiles, state, input()).ok).toBe(true);
    expect(readHandoff(hostStoreFiles, state, "p", 3)).toMatchObject({ projectId: "p", generation: 3, conversation: "conv-1", source: "cto", text: "keep going" });
    expect(readHandoff(hostStoreFiles, state, "p", 4)).toBeNull();
    expect(readHandoff(hostStoreFiles, state, "q", 3)).toBeNull();
    expect(handoffPathOf(state, "p", 3)).toBe(join(state, "cto-refresh", "handoff-p-g3.json"));
  });

  it("holds a handoff to 2 KB of UTF-8 and says by how much it is over", () => {
    const state = dir();
    const exact = "a".repeat(CTO_HANDOFF_MAX_BYTES);
    expect(writeHandoff(hostStoreFiles, state, input({ text: exact })).ok).toBe(true);
    const over = writeHandoff(hostStoreFiles, state, input({ generation: 4, text: `${exact}b` }));
    expect(over).toEqual({ ok: false, reason: expect.stringContaining("2049 bytes") });
    // Bytes, not characters: 700 three-byte characters are 2100 bytes.
    expect(writeHandoff(hostStoreFiles, state, input({ generation: 5, text: "한".repeat(700) })).ok).toBe(false);
    expect(writeHandoff(hostStoreFiles, state, input({ generation: 6, text: "   " }))).toEqual({ ok: false, reason: "the handoff is empty" });
    expect(readHandoff(hostStoreFiles, state, "p", 4)).toBeNull();
  });

  it("lets the CTO's handoff replace ACP's, and never the other way", () => {
    const state = dir();
    writeHandoff(hostStoreFiles, state, input({ source: "acp", text: "from ACP's records" }));
    expect(readHandoff(hostStoreFiles, state, "p", 3)).toMatchObject({ source: "acp", text: "from ACP's records" });
    writeHandoff(hostStoreFiles, state, input({ source: "cto", text: "from the CTO" }));
    expect(readHandoff(hostStoreFiles, state, "p", 3)).toMatchObject({ source: "cto", text: "from the CTO" });
    const kept = writeHandoff(hostStoreFiles, state, input({ source: "acp", text: "from ACP's records again" }));
    expect(kept).toMatchObject({ ok: true, handoff: { source: "cto", text: "from the CTO" } });
    expect(readHandoff(hostStoreFiles, state, "p", 3)).toMatchObject({ source: "cto", text: "from the CTO" });
  });

  it("refuses a stored file that is not exactly a handoff for that project and generation", () => {
    const state = dir();
    mkdirSync(join(state, "cto-refresh"));
    writeFileSync(handoffPathOf(state, "p", 3), JSON.stringify({ schema: "acp.cto-handoff.v1", projectId: "p", generation: 2, conversation: "c", source: "cto", text: "wrong generation", writtenAt: "x" }));
    expect(readHandoff(hostStoreFiles, state, "p", 3)).toBeNull();
    writeFileSync(handoffPathOf(state, "p", 3), "not json");
    expect(readHandoff(hostStoreFiles, state, "p", 3)).toBeNull();
    expect(() => handoffPathOf(state, "../escape", 1)).toThrow();
  });

  it("cuts a text to the limit without splitting a character", () => {
    const clipped = clipUtf8("가".repeat(1000), 100);
    expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(100);
    expect(clipped).not.toContain("�");
    expect(clipUtf8("short", 100)).toBe("short");
  });

  it("writes, reads and clears the request a CTO's channel shows, and the words name the tool", () => {
    const state = dir();
    expect(readHandoffRequest(hostStoreFiles, state, "p")).toBeNull();
    const request = writeHandoffRequest(hostStoreFiles, state, { requestId: "r1", projectId: "p", generation: 3, conversation: "conv-1", requestedAt: iso(T0) });
    expect(readHandoffRequest(hostStoreFiles, state, "p")).toEqual(request);
    expect(readHandoffRequest(hostStoreFiles, state, "q")).toBeNull();
    expect(handoffRequestText(request)).toContain("cto_handoff_write");
    expect(handoffRequestText(request)).toContain("2048 bytes");
    expect(handoffRequestText(request)).toMatch(/not from the CEO or the owner/u);
    clearHandoffRequest(hostStoreFiles, state, "p");
    expect(readHandoffRequest(hostStoreFiles, state, "p")).toBeNull();
  });

  it("backs a failing refresh off, doubling with every failure up to a cap", () => {
    const state = dir();
    expect(retryNotBefore(readRefreshFailure(hostStoreFiles, state, "p"))).toBe(Number.NEGATIVE_INFINITY);
    recordRefreshFailure(hostStoreFiles, state, "p", "tmux could not start", iso(T0));
    expect(retryNotBefore(readRefreshFailure(hostStoreFiles, state, "p"))).toBe(T0 + CTO_REFRESH_BACKOFF_INITIAL_MS);
    recordRefreshFailure(hostStoreFiles, state, "p", "again", iso(T0));
    expect(retryNotBefore(readRefreshFailure(hostStoreFiles, state, "p"))).toBe(T0 + 2 * CTO_REFRESH_BACKOFF_INITIAL_MS);
    for (let i = 0; i < 12; i++) recordRefreshFailure(hostStoreFiles, state, "p", "again", iso(T0));
    expect(retryNotBefore(readRefreshFailure(hostStoreFiles, state, "p"))).toBe(T0 + 6 * 60 * 60_000);
  });
});

describe("the handoff ACP writes when the CTO writes none", () => {
  const facts = (over: Partial<FallbackFacts> = {}): FallbackFacts => ({
    projectId: "p", conversation: "11111111-2222-4333-8444-555555555555", generation: 7, sessionId: "ses_1",
    openRuns: [{ runId: "run_1", state: "ACTIVE", kind: "STANDARD_WORK" }, { runId: "run_2", state: "READY_FOR_CEO_REVIEW", kind: "CONTRACT_CHANGE" }],
    queued: [{ messageId: "msg_9", kind: "PEER_MESSAGE", status: "PENDING", createdAt: iso(T0), text: "is the CI green yet?" }], ...over,
  });

  it("names the open runs, the queued messages and the binding, and says it is ACP's and not the CTO's", () => {
    const text = buildFallbackHandoff(facts());
    expect(text).toContain("ACP-written handoff");
    expect(text).toContain("generation 7");
    expect(text).toContain("run_1 ACTIVE STANDARD_WORK");
    expect(text).toContain("run_2 READY_FOR_CEO_REVIEW CONTRACT_CHANGE");
    expect(text).toContain("msg_9");
    expect(text).toContain("is the CI green yet?");
    expect(text).toContain("ses_1");
  });

  it("stays within 2 KB however much there is to say", () => {
    const many = facts({
      openRuns: Array.from({ length: 10 }, (_, i) => ({ runId: `run_with_a_very_long_identifier_${i}`, state: "READY_FOR_CEO_REVIEW", kind: "CONTRACT_CHANGE" })),
      queued: Array.from({ length: 5 }, (_, i) => ({ messageId: `msg_${i}`, kind: "PEER_MESSAGE", status: "SENT", createdAt: iso(T0), text: "한".repeat(120) })),
    });
    expect(Buffer.byteLength(buildFallbackHandoff(many), "utf8")).toBeLessThanOrEqual(CTO_HANDOFF_MAX_BYTES);
    expect(buildFallbackHandoff(facts({ openRuns: [], queued: [] }))).toContain("Open runs: none.");
  });
});

describe("a CTO's channel shows ACP's request once", () => {
  it("emits a request once per request id, and again for a new one", async () => {
    const state = tempDir("acp-refresh-watch-");
    const shown: Array<{ content: string; meta: Record<string, string> }> = [];
    const watcher = createSystemRequestWatcher({ stateDir: state, projectId: "p", emit: async (n) => { shown.push({ content: n.content, meta: { ...n.meta } }); } });
    expect(await watcher.poll()).toBe(false);
    const request = writeHandoffRequest(hostStoreFiles, state, { requestId: "r1", projectId: "p", generation: 3, conversation: "c", requestedAt: iso(T0) });
    expect(await watcher.poll()).toBe(true);
    expect(await watcher.poll()).toBe(false);
    writeHandoffRequest(hostStoreFiles, state, { requestId: "r2", projectId: "p", generation: 3, conversation: "c", requestedAt: iso(T0) });
    expect(await watcher.poll()).toBe(true);
    expect(shown).toHaveLength(2);
    expect(shown[0]!.content).toBe(handoffRequestText(request));
    expect(shown[0]!.meta).toEqual({ sender_role: "acp", project: "p", request_id: "r1", trust: "acp_system_request" });
    expect(systemRequestNotification(request).meta["sender_role"]).toBe("acp");
  });

  it("asks again when the channel could not show it", async () => {
    const state = tempDir("acp-refresh-watch-fail-");
    writeHandoffRequest(hostStoreFiles, state, { requestId: "r1", projectId: "p", generation: 3, conversation: "c", requestedAt: iso(T0) });
    let fails = 1;
    const diagnostics: string[] = [];
    const watcher = createSystemRequestWatcher({ stateDir: state, projectId: "p", onDiagnostic: (line) => diagnostics.push(line),
      emit: async () => { if (fails-- > 0) throw new Error("the transport is closed"); } });
    expect(await watcher.poll()).toBe(false);
    expect(diagnostics).toEqual(["a handoff request could not be shown; it is asked again"]);
    expect(await watcher.poll()).toBe(true);
  });
});

describe("the daemon's sweep", () => {
  interface Setup { state: string; clock: { now: number }; refreshed: string[]; recovered: string[]; recovery: { outcome: { ok: boolean; reason: string } }; candidateList: { projects: string[] };
    concurrent: { now: number; max: number }; sweep: ReturnType<typeof createCtoRefreshSweep>;
    transcripts: Map<string, { bytes: number; compactions: number; mtimeMs: number }>; idle: Map<string, string | null>; refresh: { outcome: { ok: boolean; reason: string }; gate: Promise<void> | null } }
  const candidate = (projectId: string, over: Partial<RefreshCandidate> = {}): RefreshCandidate =>
    ({ projectId, roleKey: `PRIMARY_CTO:${projectId}`, generation: 3, conversation: `conv-${projectId}`, sessionId: `ses-${projectId}`, cwd: `/work/${projectId}`, ...over });

  const setup = (projects: string[], over: Partial<RefreshSweepDeps> = {}): Setup => {
    const state = tempDir("acp-refresh-sweep-unit-");
    const clock = { now: T0 };
    const transcripts = new Map<string, { bytes: number; compactions: number; mtimeMs: number }>();
    const idle = new Map<string, string | null>();
    const refreshed: string[] = [];
    const recovered: string[] = [];
    const recovery = { outcome: { ok: true, reason: "" } };
    const candidateList = { projects };
    const concurrent = { now: 0, max: 0 };
    const refresh: Setup["refresh"] = { outcome: { ok: true, reason: "" }, gate: null };
    let ids = 0;
    for (const project of projects) transcripts.set(project, { bytes: CTO_CONVERSATION_MAX_BYTES, compactions: 0, mtimeMs: T0 - 120_000 });
    const measureOf = (path: string) => { const t = transcripts.get(path); return t ? { path, ...t } : null; };
    const sweep = createCtoRefreshSweep({
      stateDir: state, now: () => clock.now,
      candidates: () => candidateList.projects.map((project) => candidate(project)),
      transcriptOf: (c) => c.projectId,
      measure: measureOf,
      idle: (c) => { const because = idle.get(c.projectId) ?? null; return because === null ? { idle: true } : { idle: false, because }; },
      facts: (c) => ({ projectId: c.projectId, conversation: c.conversation, generation: c.generation, sessionId: c.sessionId,
        openRuns: [{ runId: `run_of_${c.projectId}`, state: "ACTIVE", kind: "STANDARD_WORK" }], queued: [] }),
      refresh: async (projectId) => {
        concurrent.now++; concurrent.max = Math.max(concurrent.max, concurrent.now);
        try { if (refresh.gate) await refresh.gate; refreshed.push(projectId); return refresh.outcome; } finally { concurrent.now--; }
      },
      recover: async (projectId) => { recovered.push(projectId); return recovery.outcome; },
      refresherRunning: () => false,
      newId: () => `request-${++ids}`,
      ...over,
    });
    return { state, clock, refreshed, recovered, recovery, candidateList, concurrent, sweep, transcripts, idle, refresh };
  };
  const verdicts = async (s: Setup) => (await s.sweep.tick()).map((v) => `${v.projectId}:${v.action}`);

  it("starts nothing for a conversation below both limits, and clears a request it no longer needs", async () => {
    const s = setup(["a"]);
    s.transcripts.set("a", { bytes: CTO_CONVERSATION_MAX_BYTES - 1, compactions: CTO_CONVERSATION_MAX_COMPACTIONS - 1, mtimeMs: T0 - 120_000 });
    writeHandoffRequest(hostStoreFiles, s.state, { requestId: "old", projectId: "a", generation: 3, conversation: "conv-a", requestedAt: iso(T0 - 1000) });
    expect(await verdicts(s)).toEqual(["a:not-long"]);
    expect(readHandoffRequest(hostStoreFiles, s.state, "a")).toBeNull();
    expect(s.refreshed).toEqual([]);
  });

  it("asks a long, idle CTO for a handoff at either threshold, and not before", async () => {
    for (const over of [{ bytes: CTO_CONVERSATION_MAX_BYTES, compactions: 0 }, { bytes: 1, compactions: CTO_CONVERSATION_MAX_COMPACTIONS }]) {
      const s = setup(["a"]);
      s.transcripts.set("a", { ...over, mtimeMs: T0 - 120_000 });
      expect(await verdicts(s)).toEqual(["a:asked"]);
      expect(readHandoffRequest(hostStoreFiles, s.state, "a")).toMatchObject({ projectId: "a", generation: 3, conversation: "conv-a", requestId: "request-1" });
      expect(s.refreshed).toEqual([]);
    }
  });

  it("does not ask or refresh while the CTO is busy, and says why", async () => {
    const s = setup(["a"]);
    s.idle.set("a", "its transcript changed 5s ago, so a turn may be running");
    const result = await s.sweep.tick();
    expect(result).toEqual([expect.objectContaining({ projectId: "a", action: "waiting-idle", because: expect.stringContaining("turn may be running") })]);
    expect(readHandoffRequest(hostStoreFiles, s.state, "a")).toBeNull();
    expect(readHandoff(hostStoreFiles, s.state, "a", 3)).toBeNull();
    // Even one with a CTO handoff waiting is not refreshed while busy.
    writeHandoff(hostStoreFiles, s.state, { projectId: "a", generation: 3, conversation: "conv-a", source: "cto", text: "ready", now: iso(T0) });
    expect(await verdicts(s)).toEqual(["a:waiting-idle"]);
    expect(s.refreshed).toEqual([]);
  });

  it("refreshes at once with the handoff the CTO wrote, and clears the request after", async () => {
    const s = setup(["a"]);
    expect(await verdicts(s)).toEqual(["a:asked"]);
    writeHandoff(hostStoreFiles, s.state, { projectId: "a", generation: 3, conversation: "conv-a", source: "cto", text: "the CTO's own handoff", now: iso(T0) });
    expect(await s.sweep.tick()).toEqual([{ projectId: "a", action: "refreshed", source: "cto" }]);
    expect(s.refreshed).toEqual(["a"]);
    expect(readHandoffRequest(hostStoreFiles, s.state, "a")).toBeNull();
    // The CTO's handoff was never replaced by ACP's.
    expect(readHandoff(hostStoreFiles, s.state, "a", 3)).toMatchObject({ source: "cto", text: "the CTO's own handoff" });
  });

  it("waits a bounded time for the CTO's handoff, then writes ACP's own and refreshes with it", async () => {
    const s = setup(["a"]);
    expect(await verdicts(s)).toEqual(["a:asked"]);
    s.clock.now = T0 + CTO_HANDOFF_WAIT_MS - 1;
    expect(await verdicts(s)).toEqual(["a:waiting-handoff"]);
    expect(readHandoff(hostStoreFiles, s.state, "a", 3)).toBeNull();
    s.clock.now = T0 + CTO_HANDOFF_WAIT_MS;
    expect(await s.sweep.tick()).toEqual([{ projectId: "a", action: "refreshed", source: "acp" }]);
    expect(readHandoff(hostStoreFiles, s.state, "a", 3)).toMatchObject({ source: "acp", conversation: "conv-a" });
    expect(readHandoff(hostStoreFiles, s.state, "a", 3)!.text).toContain("run_of_a");
    expect(s.refreshed).toEqual(["a"]);
  });

  it("asks again, for the new conversation, when the request on file is another one's", async () => {
    const s = setup(["a"]);
    writeHandoffRequest(hostStoreFiles, s.state, { requestId: "stale", projectId: "a", generation: 2, conversation: "an-earlier-conversation", requestedAt: iso(T0 - 3_600_000) });
    expect(await verdicts(s)).toEqual(["a:asked"]);
    expect(readHandoffRequest(hostStoreFiles, s.state, "a")).toMatchObject({ requestId: "request-1", generation: 3, conversation: "conv-a" });
    expect(s.refreshed).toEqual([]);
  });

  it("runs one refresh at a time: a tick during one starts none, and two ready CTOs go one after the other", async () => {
    const s = setup(["a", "b"]);
    for (const project of ["a", "b"]) writeHandoff(hostStoreFiles, s.state, { projectId: project, generation: 3, conversation: `conv-${project}`, source: "cto", text: "ready", now: iso(T0) });
    let release!: () => void;
    s.refresh.gate = new Promise<void>((resolve) => { release = resolve; });
    const first = s.sweep.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.sweep.running()).toBe(true);
    // A second tick, while the first refresh runs, starts nothing at all.
    expect(await s.sweep.tick()).toEqual([]);
    expect(s.concurrent.max).toBe(1);
    release();
    s.refresh.gate = null;
    expect((await first).map((v) => `${v.projectId}:${v.action}`)).toEqual(["a:refreshed", "b:refreshed"]);
    expect(s.refreshed).toEqual(["a", "b"]);
    expect(s.concurrent.max).toBe(1);
    expect(s.sweep.running()).toBe(false);
  });

  it("backs a failed refresh off, tries again after the wait, and clears the failure on success", async () => {
    const s = setup(["a"]);
    writeHandoff(hostStoreFiles, s.state, { projectId: "a", generation: 3, conversation: "conv-a", source: "cto", text: "ready", now: iso(T0) });
    s.refresh.outcome = { ok: false, reason: "switch: the refresh failed at launch (tmux could not start); the old conversation was resumed" };
    expect(await s.sweep.tick()).toEqual([{ projectId: "a", action: "failed", reason: expect.stringContaining("failed at launch") }]);
    expect(readRefreshFailure(hostStoreFiles, s.state, "a")).toMatchObject({ failures: 1, lastReason: expect.stringContaining("tmux could not start") });
    // Inside the backoff nothing is tried, however idle the CTO is.
    s.clock.now = T0 + CTO_REFRESH_BACKOFF_INITIAL_MS - 1;
    expect(await verdicts(s)).toEqual(["a:backoff"]);
    expect(s.refreshed).toEqual(["a"]);
    // After it, a second failure doubles the wait.
    s.clock.now = T0 + CTO_REFRESH_BACKOFF_INITIAL_MS;
    expect(await verdicts(s)).toEqual(["a:failed"]);
    expect(readRefreshFailure(hostStoreFiles, s.state, "a")!.failures).toBe(2);
    s.clock.now += 2 * CTO_REFRESH_BACKOFF_INITIAL_MS - 1;
    expect(await verdicts(s)).toEqual(["a:backoff"]);
    s.clock.now += 1;
    s.refresh.outcome = { ok: true, reason: "" };
    expect(await verdicts(s)).toEqual(["a:refreshed"]);
    expect(readRefreshFailure(hostStoreFiles, s.state, "a")).toBeNull();
  });

  it("records a refresh that throws as a failure and keeps going", async () => {
    const s = setup(["a", "b"], { refresh: async (projectId) => { if (projectId === "a") throw new Error("spawn ENOENT"); return { ok: true, reason: "" }; } });
    for (const project of ["a", "b"]) writeHandoff(hostStoreFiles, s.state, { projectId: project, generation: 3, conversation: `conv-${project}`, source: "cto", text: "ready", now: iso(T0) });
    expect(await verdicts(s)).toEqual(["a:failed", "b:refreshed"]);
    expect(readRefreshFailure(hostStoreFiles, s.state, "a")).toMatchObject({ lastReason: "spawn ENOENT" });
    expect(s.sweep.running()).toBe(false);
  });

  it("refreshes nothing for a project whose refresh is unfinished, even when it is a candidate and long and idle", async () => {
    const s = setup(["a", "b"], { refresherRunning: () => false });
    hostStoreFiles.replace(inflightPathOf(s.state, "a"), `${JSON.stringify({ projectId: "a", phase: "stopped", refresher: { pid: 4242, startedAt: null } })}\n`);
    s.recovery.outcome = { ok: false, reason: "still failing" };
    for (const project of ["a", "b"]) writeHandoff(hostStoreFiles, s.state, { projectId: project, generation: 3, conversation: `conv-${project}`, source: "cto", text: "ready", now: iso(T0) });
    expect((await s.sweep.tick()).map((v) => `${v.projectId}:${v.action}`)).toEqual(["a:recovery-failed", "b:refreshed"]);
    expect(s.recovered).toEqual(["a"]);
    expect(s.refreshed).toEqual(["b"]);
  });

  it("leaves a conversation whose transcript it cannot measure alone", async () => {
    const s = setup(["a"]);
    s.transcripts.delete("a");
    expect(await verdicts(s)).toEqual(["a:unmeasured"]);
    expect(s.refreshed).toEqual([]);
  });
});

describe("an interrupted refresh is recovered by the daemon's sweep", () => {
  const record = (state: string, projectId: string, refresher?: { pid: number; startedAt: string | null }) =>
    hostStoreFiles.replace(inflightPathOf(state, projectId), `${JSON.stringify({ projectId, phase: "stopped", ...(refresher ? { refresher } : {}) })}\n`);
  const deps = (state: string, over: Partial<RefreshSweepDeps> = {}) => {
    const log = { recovered: [] as string[], refreshed: [] as string[], now: T0, outcome: { ok: true, reason: "" } };
    const sweep = createCtoRefreshSweep({
      stateDir: state, now: () => log.now, candidates: () => [], transcriptOf: () => null, measure: () => null, idle: () => ({ idle: true }), facts: () => null,
      refresh: async (projectId) => { log.refreshed.push(projectId); return { ok: true, reason: "" }; },
      recover: async (projectId) => { log.recovered.push(projectId); return log.outcome; }, newId: () => "id", ...over,
    });
    return { log, sweep };
  };

  it("lists the projects with a record, and who is carrying the refresh out", () => {
    const state = tempDir("acp-refresh-inflight-");
    expect(listInflightProjects(hostStoreFiles, state)).toEqual([]);
    record(state, "b", { pid: 4242, startedAt: "Fri Nov 20 12:00:00 2026" });
    record(state, "a");
    hostStoreFiles.replace(join(state, "cto-refresh", "inflight-../x.json"), "{}");
    hostStoreFiles.replace(join(state, "cto-refresh", "handoff-a-g1.json"), "{}");
    expect(listInflightProjects(hostStoreFiles, state)).toEqual(["a", "b"]);
    expect(readInflightRefresher(hostStoreFiles, state, "b")).toEqual({ pid: 4242, startedAt: "Fri Nov 20 12:00:00 2026" });
    expect(readInflightRefresher(hostStoreFiles, state, "a")).toBeNull();
  });

  it("recovers a project that has no candidate at all: its session is gone or draining and a switchover is pending", async () => {
    const state = tempDir("acp-refresh-recover-");
    record(state, "a", { pid: 4242, startedAt: null });
    const { log, sweep } = deps(state, { refresherRunning: () => false });
    expect(await sweep.tick()).toEqual([{ projectId: "a", action: "recovered" }]);
    expect(log.recovered).toEqual(["a"]);
    expect(log.refreshed).toEqual([]);
  });

  it("leaves a refresh that is still running alone, and a retired project's record", async () => {
    const state = tempDir("acp-refresh-recover-running-");
    record(state, "a", { pid: 4242, startedAt: null });
    record(state, "gone", { pid: 4243, startedAt: null });
    const { log, sweep } = deps(state, { refresherRunning: (project) => project === "a", recoverable: (project) => project !== "gone" });
    expect(await sweep.tick()).toEqual([
      { projectId: "a", action: "recovery-waiting", because: expect.stringContaining("still running") },
      { projectId: "gone", action: "recovery-waiting", because: expect.stringContaining("retired or unknown") },
    ]);
    expect(log.recovered).toEqual([]);
  });

  it("asks the kernel about the recorded refresher by default: this very process is running, a pid that is not there is not", async () => {
    const state = tempDir("acp-refresh-recover-kernel-");
    record(state, "alive", { pid: process.pid, startedAt: null });
    record(state, "dead", { pid: 2_147_483_000, startedAt: null });
    const { log, sweep } = deps(state, { refresherRunning: undefined });
    expect((await sweep.tick()).map((v) => `${v.projectId}:${v.action}`)).toEqual(["alive:recovery-waiting", "dead:recovered"]);
    expect(log.recovered).toEqual(["dead"]);
  });

  it("tries again after a failed recovery, not before the wait, and every tick at first if the daemon restarts", async () => {
    const state = tempDir("acp-refresh-recover-retry-");
    record(state, "a", { pid: 4242, startedAt: null });
    const { log, sweep } = deps(state);
    log.outcome = { ok: false, reason: "recover: tmux could not start" };
    expect(await sweep.tick()).toEqual([{ projectId: "a", action: "recovery-failed", reason: expect.stringContaining("tmux could not start") }]);
    log.now = T0 + CTO_RECOVERY_RETRY_MS - 1;
    expect((await sweep.tick()).map((v) => v.action)).toEqual(["recovery-waiting"]);
    expect(log.recovered).toEqual(["a"]);
    log.now = T0 + CTO_RECOVERY_RETRY_MS;
    log.outcome = { ok: true, reason: "" };
    expect(await sweep.tick()).toEqual([{ projectId: "a", action: "recovered" }]);
    expect(log.recovered).toEqual(["a", "a"]);
  });

  it("runs recovery as the one refresh at a time: a tick during it starts nothing", async () => {
    const state = tempDir("acp-refresh-recover-serial-");
    record(state, "a", { pid: 4242, startedAt: null });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { log, sweep } = deps(state, { recover: async (projectId) => { await gate; log.recovered.push(projectId); return { ok: true, reason: "" }; } });
    const first = sweep.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sweep.running()).toBe(true);
    expect(await sweep.tick()).toEqual([]);
    release();
    expect(await first).toEqual([{ projectId: "a", action: "recovered" }]);
    expect(log.recovered).toEqual(["a"]);
  });
});

describe("the daemon's refresh queue", () => {
  const gated = () => {
    const events: string[] = [];
    const gates = new Map<string, () => void>();
    let live = 0;
    let most = 0;
    const queue = createRefreshQueue(async (job) => {
      events.push(`start ${job.mode}:${job.projectId}`);
      live++; most = Math.max(most, live);
      await new Promise<void>((resolve) => gates.set(`${job.mode}:${job.projectId}`, resolve));
      live--;
      events.push(`end ${job.mode}:${job.projectId}`);
      return { ok: true, reason: "", lines: [{ job: `${job.mode}:${job.projectId}` }] };
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return { queue, events, gates, most: () => most, settle };
  };

  it("runs jobs one at a time, in the order they were asked, whoever asked", async () => {
    const g = gated();
    const results = [g.queue.enqueue("a", "refresh"), g.queue.enqueue("b", "recover"), g.queue.enqueue("c", "refresh")];
    await g.settle();
    expect(g.events).toEqual(["start refresh:a"]);
    for (const key of ["refresh:a", "recover:b", "refresh:c"]) { g.gates.get(key)?.(); await g.settle(); await g.settle(); }
    expect((await Promise.all(results)).map((r) => r.lines[0]!["job"])).toEqual(["refresh:a", "recover:b", "refresh:c"]);
    expect(g.most()).toBe(1);
    expect(g.events).toEqual(["start refresh:a", "end refresh:a", "start recover:b", "end recover:b", "start refresh:c", "end refresh:c"]);
    expect(g.queue.busy()).toBe(false);
  });

  it("answers a request for a job that is already queued or running with that job, never a second run", async () => {
    const g = gated();
    const first = g.queue.enqueue("a", "refresh");
    const again = g.queue.enqueue("a", "refresh");
    const other = g.queue.enqueue("a", "recover");
    await g.settle();
    g.gates.get("refresh:a")!();
    await g.settle(); await g.settle();
    g.gates.get("recover:a")!();
    expect(await first).toBe(await again);
    expect((await other).lines).toEqual([{ job: "recover:a" }]);
    expect(g.events.filter((e) => e.startsWith("start"))).toEqual(["start refresh:a", "start recover:a"]);
    // Once it has ended, asking again is a new job.
    const later = g.queue.enqueue("a", "refresh");
    await g.settle();
    g.gates.get("refresh:a")!();
    await later;
    expect(g.events.filter((e) => e === "start refresh:a")).toHaveLength(2);
  });

  it("keeps going after a job that throws, and says why it failed", async () => {
    const queue = createRefreshQueue(async (job) => { if (job.projectId === "bad") throw new Error("spawn ENOENT"); return { ok: true, reason: "", lines: [] }; });
    expect(await Promise.all([queue.enqueue("bad", "refresh"), queue.enqueue("good", "refresh")])).toEqual([
      { ok: false, reason: "spawn ENOENT", lines: [] }, { ok: true, reason: "", lines: [] }]);
    expect(queue.busy()).toBe(false);
  });

  it("vouches for exactly the running job's token, for its project and mode, and for nothing before or after it", async () => {
    let token = "";
    const verdicts: boolean[] = [];
    const queue = createRefreshQueue(async (job) => {
      token = job.token;
      verdicts.push(queue.verify(job.token, job.projectId, job.mode), queue.verify(job.token, "other", job.mode), queue.verify(job.token, job.projectId, "recover"), queue.verify("forged", job.projectId, job.mode));
      return { ok: true, reason: "", lines: [] };
    });
    expect(queue.verify("anything", "a", "refresh")).toBe(false);
    await queue.enqueue("a", "refresh");
    expect(verdicts).toEqual([true, false, false, false]);
    expect(queue.verify(token, "a", "refresh")).toBe(false);
  });

  it("is the operator's `run` and `verify`, with exactly their parameters", async () => {
    const g = gated();
    const operator = ctoRefreshOperator(g.queue);
    for (const bad of [{}, { projectId: "../x" }, { projectId: "a", extra: 1 }, { projectId: "a", recover: "yes" }]) {
      expect(await operator("run", bad)).toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    }
    expect(await operator("verify", { projectId: "a" })).toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(await operator("verify", { projectId: "a", token: "nope" })).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    const asked = operator("run", { projectId: "a", recover: true });
    await g.settle();
    g.gates.get("recover:a")!();
    expect(await asked).toMatchObject({ allowed: true, value: { ok: true, lines: [{ job: "recover:a" }] } });
  });
});

describe("cto_handoff_write on the acp-cto surface", () => {
  const cto = async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const { projectId } = await registerFixtureProject(harness);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test cto").allowed).toBe(true);
    const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }), projectId, sessionId: session.sessionId });
    expect(bound.allowed).toBe(true);
    const stateDir = join(harness.cp.config.databasePath, "..");
    return { harness, projectId, peer: { sessionId: session.sessionId, incarnation: session.incarnation }, stateDir, generation: bound.allowed ? bound.value.bindingGeneration : 0 };
  };

  it("stores the handoff for the caller's project and generation, within 2 KB", async () => {
    const f = await cto();
    try {
      const answer = await callCtoTool(f.harness, f.peer, "cto_handoff_write", { text: "Finish run_3; the CEO wants CI green first." });
      expect(answer).toMatchObject({ ok: true });
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId, f.generation)).toMatchObject({ source: "cto", text: "Finish run_3; the CEO wants CI green first.", generation: f.generation });
      // Written again before ACP has used it, it replaces itself; the CTO's own is never replaced by ACP's.
      expect(await callCtoTool(f.harness, f.peer, "cto_handoff_write", { text: "A better one." })).toMatchObject({ ok: true });
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId, f.generation)!.text).toBe("A better one.");
      writeHandoff(hostStoreFiles, f.stateDir, { projectId: f.projectId, generation: f.generation, conversation: "x", source: "acp", text: "ACP's", now: iso(T0) });
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId, f.generation)!.text).toBe("A better one.");
    } finally { f.harness.cp.close(); }
  });

  it("refuses a handoff over 2 KB and says so, and stores nothing", async () => {
    const f = await cto();
    try {
      const answer = await callCtoTool(f.harness, f.peer, "cto_handoff_write", { text: "x".repeat(CTO_HANDOFF_MAX_BYTES + 1) });
      expect(answer).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(JSON.stringify(answer)).toContain("2049 bytes");
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId, f.generation)).toBeNull();
    } finally { f.harness.cp.close(); }
  });

  it("is for the project's current PRIMARY_CTO session only", async () => {
    const f = await cto();
    try {
      const stranger = f.harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
      f.harness.cp.sessions.transition(stranger.sessionId, SessionLifecycle.READY, "test");
      const refused = await callCtoTool(f.harness, { sessionId: stranger.sessionId, incarnation: stranger.incarnation }, "cto_handoff_write", { text: "not mine to write" });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      const stale = await callCtoTool(f.harness, { sessionId: f.peer.sessionId, incarnation: "an-older-incarnation" }, "cto_handoff_write", { text: "from a runtime that is gone" });
      expect(stale).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId, f.generation)).toBeNull();
    } finally { f.harness.cp.close(); }
  });
});
