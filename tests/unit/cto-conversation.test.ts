import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  CTO_HANDOFF_MAX_BYTES, ctoTranscriptPath, fallbackHandoff, hostStoreFiles, longReasons, measureConversation, readHandoff, refreshLimitsFromEnv, writeHandoff,
} from "../../src/cto/cto-conversation.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CONVERSATION, PROJECT, canonicalCtoFixture } from "../helpers/canonical-cto-reattach.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const MARK = "\"subtype\":\"compact_boundary\"";
const LIMITS = refreshLimitsFromEnv({});

describe("the conversation meter", () => {
  it("counts bytes and compaction boundaries, including a mark cut by the read chunk, and not a quoted mention", () => {
    const file = join(tempDir("acp-conv-"), "t.jsonl");
    const boundary = `{"type":"system",${MARK}}\n`;
    const quoted = `{"m":"quotes ${MARK.replaceAll('"', '\\"')}"}\n`;
    writeFileSync(file, `${"x".repeat((1 << 20) - 30)}\n${boundary}${quoted}${boundary}`);
    expect(measureConversation(file)).toEqual({ bytes: (1 << 20) - 29 + boundary.length * 2 + quoted.length, compactions: 2 });
    expect(measureConversation(join(tempDir("acp-conv-"), "absent.jsonl"))).toBeNull();
  });

  it("is long at 20 MB or 3 compactions, inclusive, and the environment may name others", () => {
    expect(LIMITS).toEqual({ maxBytes: 20 * 1024 * 1024, maxCompactions: 3 });
    expect(longReasons({ bytes: 20 * 1024 * 1024 - 1, compactions: 2 }, LIMITS)).toEqual([]);
    expect(longReasons({ bytes: 20 * 1024 * 1024, compactions: 2 }, LIMITS)).toEqual(["bytes"]);
    expect(longReasons({ bytes: 1, compactions: 3 }, LIMITS)).toEqual(["compactions"]);
    expect(refreshLimitsFromEnv({ ACP_CTO_REFRESH_MAX_BYTES: "100", ACP_CTO_REFRESH_MAX_COMPACTIONS: "1" })).toEqual({ maxBytes: 100, maxCompactions: 1 });
    expect(refreshLimitsFromEnv({ ACP_CTO_REFRESH_MAX_BYTES: "-5", ACP_CTO_REFRESH_MAX_COMPACTIONS: "x" })).toEqual(LIMITS);
  });
});

describe("the handoff store", () => {
  it("keeps at most 2048 bytes by project and refuses more, saying by how much", () => {
    const state = tempDir("acp-handoff-");
    const base = { projectId: "p", conversation: "c1", source: "cto" as const, now: "2026-11-20T00:00:00Z" };
    expect(writeHandoff(hostStoreFiles, state, { ...base, text: "x".repeat(CTO_HANDOFF_MAX_BYTES) }).ok).toBe(true);
    expect(readHandoff(hostStoreFiles, state, "p")).toMatchObject({ conversation: "c1", source: "cto" });
    expect(readHandoff(hostStoreFiles, state, "q")).toBeNull();
    const over = writeHandoff(hostStoreFiles, state, { ...base, text: "x".repeat(CTO_HANDOFF_MAX_BYTES + 1) });
    expect(over).toEqual({ ok: false, reason: expect.stringContaining("2049 bytes") });
    expect(writeHandoff(hostStoreFiles, state, { ...base, text: "  " }).ok).toBe(false);
    expect(() => writeHandoff(hostStoreFiles, state, { ...base, projectId: "../x", text: "t" })).toThrow();
  });

  it("an ACP-written handoff stays under 2 KB however many runs are open", () => {
    const openRuns = Array.from({ length: 200 }, (_, i) => ({ runId: `run_${"x".repeat(20)}${i}`, state: "ACTIVE", kind: "IMPLEMENT" }));
    expect(Buffer.byteLength(fallbackHandoff({ projectId: "p", conversation: "c", generation: 2, openRuns }))).toBeLessThanOrEqual(CTO_HANDOFF_MAX_BYTES);
  });
});

const boundCto = async (workdir?: string) => {
  const harness = makeHarness();
  bindCeo(harness);
  const { projectId } = await registerFixtureProject(harness);
  const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto", ...(workdir ? { workdir } : {}) });
  expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test cto").allowed).toBe(true);
  const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }), projectId, sessionId: session.sessionId });
  expect(bound.allowed).toBe(true);
  return { harness, projectId, session, stateDir: join(harness.cp.config.databasePath, "..") };
};

describe("cto_handoff_write", () => {
  it("stores the handoff for the caller's project, refuses over 2 KB, and is for the current PRIMARY_CTO only", async () => {
    const f = await boundCto();
    try {
      const peer = { sessionId: f.session.sessionId, incarnation: f.session.incarnation };
      expect(await callCtoTool(f.harness, peer, "cto_handoff_write", { text: "Finish run_3 first." })).toMatchObject({ ok: true });
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId)).toMatchObject({ source: "cto", text: "Finish run_3 first." });
      const over = await callCtoTool(f.harness, peer, "cto_handoff_write", { text: "x".repeat(CTO_HANDOFF_MAX_BYTES + 1) });
      expect(over).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(readHandoff(hostStoreFiles, f.stateDir, f.projectId)!.text).toBe("Finish run_3 first.");
      expect(await callCtoTool(f.harness, { ...peer, incarnation: "stale" }, "cto_handoff_write", { text: "no" })).toMatchObject({ ok: false });
    } finally { f.harness.cp.close(); }
  });
});

describe("doctor CTO_CONVERSATION_LONG", () => {
  it("names a long conversation without blocking, and says nothing for a short or unreadable one", async () => {
    const home = tempDir("acp-conv-home-");
    const workdir = tempDir("acp-conv-work-");
    const f = canonicalCtoFixture();
    try {
      f.h.cp.doctor.useHomeDir(home);
      f.h.cp.db.run(`UPDATE sessions SET workdir = ? WHERE session_id = ?`, [workdir, f.sessionId]);
      const findings = async () => (await f.h.cp.doctor.run("system")).findings.filter((x) => x.code === "CTO_CONVERSATION_LONG");
      expect(await findings()).toEqual([]);
      const transcript = ctoTranscriptPath(home, workdir, CONVERSATION);
      mkdirSync(join(transcript, ".."), { recursive: true });
      writeFileSync(transcript, `{"a":1}\n`);
      expect(await findings()).toEqual([]);
      writeFileSync(transcript, `{${MARK}}\n`.repeat(3));
      expect(await findings()).toEqual([expect.objectContaining({ code: "CTO_CONVERSATION_LONG", blocking: false, scope: `project:${PROJECT}`, observedEvidence: expect.objectContaining({ compactions: 3, reasons: ["compactions"] }) })]);
    } finally { f.h.cp.close(); }
  });
});
