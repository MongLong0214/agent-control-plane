import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  type BootstrapRuntimeFixture,
  acknowledgeInBandOnWorkTurns,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The CEO's door to a CTO escalation: a project-less bootstrap run whose driven BOOTSTRAP_CTO opened a
 * blocking escalation is BLOCKED with CEO_DECISION_REQUIRED, and `escalation_resolve` over the real
 * Hermes socket is the one way the CEO answers it. Only the model is scripted.
 */

const LONG_RESOLUTION = `use acp-new; ${"keep the plan's other choices exactly as they are. ".repeat(40)}`.trim();

let escalationKeys = 0;

/** A dispatched bootstrap run whose first work turn read and acknowledged its RUN_DISPATCH. */
const dispatchedAndAcked = async (f: BootstrapRuntimeFixture) => {
  const handled = acknowledgeInBandOnWorkTurns(f);
  const dispatched = await f.dispatchBootstrap();
  await vi.waitFor(() => expect(f.finishedTurns(dispatched.ownerSessionId)).toBe(2));
  return { ...dispatched, handled };
};

/** The run's owner opens an escalation over its own authenticated CTO socket. */
const escalate = async (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string, blocksCriticalPath = true) => {
  const opened = await f.cto(ownerSessionId, "escalation_open", {
    idempotencyKey: `door-escalation-${++escalationKeys}`,
    runId,
    question: "which repository name?",
    options: ["acp-new", "acp-next"],
    ctoRecommendation: "acp-new",
    whyItMatters: "it is the repository's permanent identity",
    blocksCriticalPath,
  });
  expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
  return latestEscalationId(f, runId);
};

const latestEscalationId = (f: BootstrapRuntimeFixture, runId: string): number =>
  f.harness.cp.db.get<{ id: number }>(
    `SELECT MAX(event_id) AS id FROM audit_events WHERE kind = 'CTO_ESCALATION' AND run_id = ?`,
    [runId],
  )!.id;

const replies = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.ESCALATION_REPLY);

const ceoDecisions = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.db.all<{ evidence_json: string; session_id: string | null }>(
    `SELECT evidence_json, session_id FROM audit_events WHERE kind = 'CEO_DECISION' AND run_id = ? ORDER BY event_id`,
    [runId],
  );

const resolve = (
  f: BootstrapRuntimeFixture,
  args: { runId: string; escalationId: number; resolution: string; idempotencyKey?: string },
) => f.hermes("escalation_resolve", args);

/** A BLOCKED, escalated bootstrap run, as run_7717 is live. */
const blockedEscalatedRun = async (f: BootstrapRuntimeFixture) => {
  const dispatched = await dispatchedAndAcked(f);
  const escalationId = await escalate(f, dispatched.runId, dispatched.ownerSessionId);
  expect(f.harness.cp.runs.require(dispatched.runId)).toMatchObject({
    state: RunState.BLOCKED,
    stateReason: "CEO_DECISION_REQUIRED",
  });
  return { ...dispatched, escalationId };
};

/** The run and its escalation are exactly as the escalation left them: nothing moved. */
const expectUnmoved = (f: BootstrapRuntimeFixture, runId: string, escalationId: number) => {
  expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });
  expect(ceoDecisions(f, runId)).toEqual([]);
  expect(replies(f, runId)).toEqual([]);
  expect(latestEscalationId(f, runId)).toBe(escalationId);
};

describe("escalation_resolve: the CEO's door to a CTO escalation", () => {
  it("resolves a BLOCKED escalated run: ACTIVE, one ESCALATION_REPLY to the exact owner with the raw resolution, CEO_DECISION audited with a digest and a length only", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, escalationId, handled } = await blockedEscalatedRun(f);
      const owner = f.harness.cp.bindings.active(roleKey)!;
      const turns = f.finishedTurns(ownerSessionId);

      const resolved = await resolve(f, { runId, escalationId, resolution: LONG_RESOLUTION });
      expect(resolved, JSON.stringify(resolved)).toMatchObject({
        ok: true,
        value: { runId, escalationId, state: RunState.ACTIVE },
      });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);

      const [reply, ...more] = replies(f, runId);
      expect(more).toEqual([]);
      expect(reply).toMatchObject({
        roleKey: owner.roleKey,
        bindingGeneration: owner.bindingGeneration,
        targetSessionId: owner.sessionId,
        payload: { runId, escalationId, resolution: LONG_RESOLUTION },
      });

      const decisions = ceoDecisions(f, runId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.session_id).toBe(f.ceoSessionId);
      const evidence = JSON.parse(decisions[0]!.evidence_json) as Record<string, unknown>;
      expect(Object.keys(evidence).sort()).toEqual(["escalation", "escalationId", "resolutionDigest", "resolutionLength"]);
      expect(evidence).toMatchObject({ escalation: true, escalationId, resolutionLength: LONG_RESOLUTION.length });
      expect(evidence["resolutionDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(decisions[0]!.evidence_json).not.toContain("acp-new");

      // The driven owner is woken for it, reads it in band and acknowledges it.
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(turns + 1));
      await vi.waitFor(() => expect(replies(f, runId).map((message) => message.status)).toEqual(["ACKED"]));
      expect(handled.map((entry) => entry.kind)).toContain(MessageKind.ESCALATION_REPLY);

      // The escalation is closed: the door does not answer it twice.
      const again = await resolve(f, { runId, escalationId, resolution: "use acp-next" });
      expect(again).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(replies(f, runId)).toHaveLength(1);
    });
  });

  it("refuses a session that is not the current CEO, and moves nothing", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      const stranger = f.harness.cp.sessions.create({ provider: "scripted", model: "not-the-ceo" });
      f.harness.cp.sessions.transition(stranger.sessionId, SessionLifecycle.READY, "fixture");
      const peer = { actor: stranger.sessionId, sessionId: stranger.sessionId, sessionIncarnation: f.harness.cp.sessions.require(stranger.sessionId).incarnation };
      const server = createHermesServer(createHermesMcpPort(f.harness.cp), () => allow(ReasonCode.OK, peer));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "not-the-ceo", version: "1" });
      await client.connect(clientTransport);
      try {
        const refused = await client.callTool({
          name: "escalation_resolve",
          arguments: { idempotencyKey: "stranger-1", runId, escalationId, resolution: "use acp-new" },
        });
        expect(refused.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED });
      } finally {
        await client.close();
      }
      expectUnmoved(f, runId, escalationId);
    });
  });

  it("refuses a run without an escalation, and a run whose escalation does not block it", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await dispatchedAndAcked(f);
      const none = await resolve(f, { runId, escalationId: 1, resolution: "use acp-new" });
      expect(none).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });

      const advisory = await escalate(f, runId, ownerSessionId, false);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
      const notBlocked = await resolve(f, { runId, escalationId: advisory, resolution: "use acp-new" });
      expect(notBlocked).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
      expect(ceoDecisions(f, runId)).toEqual([]);
      expect(replies(f, runId)).toEqual([]);
    });
  });

  it("refuses an empty, a blank and an over-bound resolution", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      for (const resolution of ["", "   \n", "x".repeat(4001)]) {
        const refused = await resolve(f, { runId, escalationId, resolution });
        expect(refused, JSON.stringify(refused).slice(0, 400)).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      }
      expectUnmoved(f, runId, escalationId);
      // The bound itself is admitted.
      const atBound = await resolve(f, { runId, escalationId, resolution: "y".repeat(4000) });
      expect(atBound).toMatchObject({ ok: true, value: { state: RunState.ACTIVE } });
    });
  });

  it("answers a repeat of the same idempotencyKey with the first result and no second enqueue, and refuses the key with different content", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      const request = { runId, escalationId, resolution: "use acp-new", idempotencyKey: "door-repeat" };
      const first = await resolve(f, request);
      expect(first).toMatchObject({ ok: true, value: { state: RunState.ACTIVE } });
      // The first response is lost; the CEO retries the same request with the same key.
      const retried = await resolve(f, request);
      expect(retried).toEqual(first);
      expect(replies(f, runId)).toHaveLength(1);
      expect(ceoDecisions(f, runId)).toHaveLength(1);

      for (const changed of [{ resolution: "use acp-next" }, { escalationId: escalationId + 1 }]) {
        const reused = await resolve(f, { ...request, ...changed });
        expect(reused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      }
      expect(replies(f, runId)).toHaveLength(1);
      expect(ceoDecisions(f, runId)).toHaveLength(1);
    });
  });

  it("concurrent resolutions: one wins, the other is refused or answered idempotently, and exactly one reply is enqueued", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      const distinct = await Promise.all([
        resolve(f, { runId, escalationId, resolution: "use acp-new", idempotencyKey: "door-race-a" }),
        resolve(f, { runId, escalationId, resolution: "use acp-next", idempotencyKey: "door-race-b" }),
      ]);
      expect(distinct.filter((result) => result["ok"] === true)).toHaveLength(1);
      expect(distinct.filter((result) => result["ok"] !== true)).toEqual([
        expect.objectContaining({ ok: false, reasonCode: ReasonCode.CONFLICT }),
      ]);
      expect(replies(f, runId)).toHaveLength(1);
      expect(ceoDecisions(f, runId)).toHaveLength(1);
    });
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      const request = { runId, escalationId, resolution: "use acp-new", idempotencyKey: "door-race-same" };
      const same = await Promise.all([resolve(f, request), resolve(f, request)]);
      const won = same.filter((result) => result["ok"] === true);
      expect(won.length).toBeGreaterThanOrEqual(1);
      for (const other of same) {
        if (other["ok"] === true) expect(other).toEqual(won[0]);
        else expect(other).toMatchObject({ ok: false, reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED });
      }
      expect(replies(f, runId)).toHaveLength(1);
      expect(ceoDecisions(f, runId)).toHaveLength(1);
    });
  });

  it("rolls back when the reply cannot be enqueued: the run stays BLOCKED and the escalation stays open", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      const outbox = f.harness.cp.outbox;
      const enqueue = outbox.enqueue.bind(outbox);
      const spy = vi.spyOn(outbox, "enqueue").mockImplementation((input) =>
        input.kind === MessageKind.ESCALATION_REPLY
          ? deny(ReasonCode.OUTBOX_TARGET_NOT_CURRENT, "fixture: the owner cannot receive it", {})
          : enqueue(input));
      const refused = await resolve(f, { runId, escalationId, resolution: "use acp-new" });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT });
      expectUnmoved(f, runId, escalationId);

      spy.mockRestore();
      const resolved = await resolve(f, { runId, escalationId, resolution: "use acp-new" });
      expect(resolved).toMatchObject({ ok: true, value: { state: RunState.ACTIVE } });
      expect(replies(f, runId)).toHaveLength(1);
    });
  });

  it("refuses a delayed request naming an earlier escalation once a newer one is open, and never resolves the newer one", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, escalationId: first } = await blockedEscalatedRun(f);
      expect(await resolve(f, { runId, escalationId: first, resolution: "use acp-new" })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(replies(f, runId).map((message) => message.status)).toEqual(["ACKED"]));

      const second = await escalate(f, runId, ownerSessionId);
      expect(second).toBeGreaterThan(first);
      const stale = await resolve(f, { runId, escalationId: first, resolution: "use acp-new" });
      expect(stale).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });
      expect(replies(f, runId)).toHaveLength(1);
      expect(ceoDecisions(f, runId)).toHaveLength(1);

      const current = await resolve(f, { runId, escalationId: second, resolution: "use acp-next" });
      expect(current).toMatchObject({ ok: true, value: { escalationId: second, state: RunState.ACTIVE } });
      const payloads = replies(f, runId).map((message) => message.payload as { escalationId: number });
      expect(payloads.sort((left, right) => left.escalationId - right.escalationId)).toEqual([
        { runId, escalationId: first, resolution: "use acp-new" },
        { runId, escalationId: second, resolution: "use acp-next" },
      ]);
    });
  });

  it("the driven owner's prompt says what an ESCALATION_REPLY asks of it, in the same bytes for every run", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      expect(await resolve(f, { runId, escalationId, resolution: "use acp-new" })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(replies(f, runId).map((message) => message.status)).toEqual(["ACKED"]));
      const prompts = f.claude.turns.filter((turn) => !/nonce set to/.test(turn.prompt)).map((turn) => turn.prompt);
      expect(prompts.length).toBeGreaterThanOrEqual(2);
      const directive = (prompt: string) => prompt.split("\n").find((line) => line.startsWith("An ESCALATION_REPLY"));
      for (const prompt of prompts) {
        const line = directive(prompt);
        expect(line, prompt).toBeDefined();
        expect(line).toContain("escalationId");
        expect(line).toContain("current owner");
        expect(line).toContain("mcp__acp-cto__run_ack");
        expect(line).toContain("mcp__acp-cto__plan_submit");
        expect(line).toContain("mcp__acp-cto__result_submit");
        expect(line).toContain("never bypasses");
        expect(line).toContain("CONFIRM");
        expect(line).toContain("do not acknowledge it");
        expect(line).toContain("mcp__acp-cto__escalation_open");
        expect(line).not.toContain(runId);
        expect(line).not.toContain("acp-new");
      }
      expect(new Set(prompts.map(directive)).size).toBe(1);
    });
  });

  it("leaves FINAL_REVISE and CONFIRM as they were: both refused while the run is BLOCKED and while it is ACTIVE", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blockedEscalatedRun(f);
      const decide = (decision: "FINAL_REVISE" | "CONFIRM") =>
        f.hermes("ceo_decision_submit", {
          runId,
          decision,
          candidateSnapshotDigest: "sha256:bootstrap-candidate",
          ceoSessionId: f.ceoSessionId,
          rationale: "decide while escalated",
        });
      for (const decision of ["FINAL_REVISE", "CONFIRM"] as const) {
        expect(await decide(decision)).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL, message: "run is BLOCKED" });
      }
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
      expect(await resolve(f, { runId, escalationId, resolution: "use acp-new" })).toMatchObject({ ok: true });
      for (const decision of ["FINAL_REVISE", "CONFIRM"] as const) {
        expect(await decide(decision)).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL, message: "run is ACTIVE" });
      }
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    });
  });
});
