import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  type BootstrapRuntimeFixture,
  acknowledgeInBandOnWorkTurns,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Round-1 witnesses for the CEO's escalation door (#1120): a committed resolution keeps its request
 * identity however the MCP layer's stored response fares (ESC-01), a refused escalation opening
 * changes nothing (ESC-02), and a PENDING reply follows every takeover to the run's new owner only,
 * until it is acknowledged (ESC-03; ACP-R1-01 retired the once-only budget).
 */

let keys = 0;

/** A dispatched bootstrap run whose owner then stops acknowledging, so a reply stays PENDING. */
const quietOwner = async (f: BootstrapRuntimeFixture) => {
  acknowledgeInBandOnWorkTurns(f);
  const run = await f.dispatchBootstrap();
  await f.awaitFinishedTurns(run.ownerSessionId, 1);
  f.claude.onWorkTurn = async () => {};
  return run;
};

const open = async (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string, blocksCriticalPath = true) =>
  f.cto(ownerSessionId, "escalation_open", {
    idempotencyKey: `r1-open-${++keys}`,
    runId,
    question: "which repository?",
    options: ["one", "two"],
    ctoRecommendation: "one",
    whyItMatters: "repository identity",
    blocksCriticalPath,
  });

const blocked = async (f: BootstrapRuntimeFixture) => {
  const run = await quietOwner(f);
  expect(await open(f, run.runId, run.ownerSessionId)).toMatchObject({ ok: true });
  const escalationId = f.harness.cp.ceo.openEscalationOf(run.runId)!.escalationId;
  return { ...run, escalationId };
};

const resolve = (f: BootstrapRuntimeFixture, runId: string, escalationId: number, idempotencyKey: string, resolution = "use one") =>
  f.hermes("escalation_resolve", { idempotencyKey, runId, escalationId, resolution });

const replies = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.ESCALATION_REPLY);

const count = (f: BootstrapRuntimeFixture, kind: string, runId: string): number =>
  f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND run_id = ?`, [kind, runId])!.n;

const carries = (f: BootstrapRuntimeFixture, messageId: string) =>
  f.harness.cp.db.all<{ evidence_json: string }>(
    `SELECT evidence_json FROM audit_events WHERE kind = 'ESCALATION_REPLY_CARRIED'
       AND json_extract(evidence_json, '$.messageId') = ?`,
    [messageId],
  ).map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);

/** The MCP layer's own response store fails once for `key`, after the decision committed. */
const failResultStore = (f: BootstrapRuntimeFixture, key: string) => {
  const db = f.harness.cp.db;
  const original = db.run.bind(db);
  const state = { injected: false };
  vi.spyOn(db, "run").mockImplementation((sql, params) => {
    if (!state.injected && sql.includes("UPDATE inbound_messages SET result_json") && params?.[1] === key) {
      state.injected = true;
      throw new Error("witness: result store lost after the decision committed");
    }
    return original(sql, params);
  });
  return state;
};

describe("ESC-01: the decision record is the replay source of truth", () => {
  it("(a) the result store fails after commit: every retry of the same request answers the committed result, a changed request is CONFLICT, no extra enqueue", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blocked(f);
      const key = "r1-store-fails";
      const fault = failResultStore(f, key);
      const first = await resolve(f, runId, escalationId, key);
      vi.restoreAllMocks();
      expect(fault.injected).toBe(true);
      expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
      const [reply] = replies(f, runId);
      const committed = { ok: true, value: { runId, escalationId, state: RunState.ACTIVE, messageId: reply!.messageId } };

      // While the reservation is still held, and after it lapsed and the handler runs again.
      expect(await resolve(f, runId, escalationId, key)).toMatchObject(committed);
      f.harness.clock.advance(60_001);
      expect(await resolve(f, runId, escalationId, key)).toMatchObject(committed);
      expect(await resolve(f, runId, escalationId, key, "use two")).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(replies(f, runId)).toHaveLength(1);
      expect(count(f, "CEO_DECISION", runId)).toBe(1);
    });
  });

  it("(b) a lost response then a retry answers the same result; the key reused on a NEW escalation is CONFLICT with no second reply", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, escalationId } = await blocked(f);
      const key = "r1-lost-response";
      failResultStore(f, key);
      await resolve(f, runId, escalationId, key);
      vi.restoreAllMocks();
      f.harness.clock.advance(60_001);
      const retried = await resolve(f, runId, escalationId, key);
      expect(retried).toMatchObject({ ok: true, value: { runId, escalationId, state: RunState.ACTIVE } });

      expect(await open(f, runId, ownerSessionId)).toMatchObject({ ok: true });
      const second = f.harness.cp.ceo.openEscalationOf(runId)!.escalationId;
      expect(second).toBeGreaterThan(escalationId);
      f.harness.clock.advance(60_001);
      const reused = await resolve(f, runId, second, key, "use two");
      expect(reused).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(replies(f, runId)).toHaveLength(1);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });
      expect(f.harness.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId: second });
    });
  });

  it("(c) a concurrent resend that bypassed the reservation answers the committed result; the same key with different content is CONFLICT; one enqueue", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blocked(f);
      const ceo = f.harness.cp.ceo;
      const target = { escalationId, idempotencyKey: "r1-concurrent" };
      const first = ceo.resolveEscalation(runId, "use one", f.ceoSessionId, target);
      const resend = ceo.resolveEscalation(runId, "use one", f.ceoSessionId, target);
      expect(first).toMatchObject({ allowed: true });
      expect(resend).toEqual(first);
      expect(ceo.resolveEscalation(runId, "use two", f.ceoSessionId, target)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.CONFLICT,
      });
      // The same escalation under another key is refused as already resolved.
      const otherKey = ceo.resolveEscalation(runId, "use one", f.ceoSessionId, { escalationId, idempotencyKey: "r1-other" });
      expect(otherKey).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: { resolved: true } });
      expect(replies(f, runId)).toHaveLength(1);
      expect(count(f, "CEO_DECISION", runId)).toBe(1);

      // Over the door, two identical requests at once: every answer is the committed result.
      const answers = await Promise.all([resolve(f, runId, escalationId, "r1-concurrent"), resolve(f, runId, escalationId, "r1-concurrent")]);
      for (const answer of answers) expect(answer).toMatchObject({ ok: true, value: first.allowed ? first.value : {} });
      expect(replies(f, runId)).toHaveLength(1);
    });
  });
});

describe("ESC-02: a refused escalation opening changes nothing", () => {
  it("a refused blocking open leaves no audit, no notification and the first escalation current and resolvable; a non-blocking one does not shadow it", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, escalationId } = await blocked(f);
      const notifications = f.harness.cp.outbox.listByRun(runId).filter((m) => m.kind === MessageKind.CEO_NOTIFICATION).length;
      const before = { escalations: count(f, "CTO_ESCALATION", runId), notified: count(f, "CEO_NOTIFICATION", runId) };

      const refused = await open(f, runId, ownerSessionId);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
      expect({ escalations: count(f, "CTO_ESCALATION", runId), notified: count(f, "CEO_NOTIFICATION", runId) }).toEqual(before);
      expect(f.harness.cp.outbox.listByRun(runId).filter((m) => m.kind === MessageKind.CEO_NOTIFICATION)).toHaveLength(notifications);
      expect(f.harness.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });

      const advisory = await open(f, runId, ownerSessionId, false);
      expect(advisory).toMatchObject({ ok: true });
      expect(count(f, "CTO_ESCALATION", runId)).toBe(before.escalations + 1);
      expect(f.harness.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });

      expect(await resolve(f, runId, escalationId, "r1-resolve-first")).toMatchObject({
        ok: true,
        value: { runId, escalationId, state: RunState.ACTIVE },
      });
      expect(replies(f, runId)).toHaveLength(1);
    });
  });
});

describe("a refused resolution rolls back the transition, the reply and the decision together", () => {
  /** The run is exactly as its escalation left it, and the BLOCKED -> ACTIVE edge left no trace. */
  const expectRolledBack = (f: BootstrapRuntimeFixture, runId: string, escalationId: number, transitions: number) => {
    expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });
    expect(count(f, "CEO_DECISION", runId)).toBe(0);
    expect(count(f, "RUN_TRANSITION", runId)).toBe(transitions);
    expect(replies(f, runId)).toEqual([]);
    expect(f.harness.cp.ceo.openEscalationOf(runId)).toEqual({ escalationId });
  };

  it("rolls back when the run has no current owner: the run stays BLOCKED, no decision, no reply", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, roleKey, escalationId } = await blocked(f);
      expect(f.harness.cp.bindings.revoke(roleKey, "fixture: the owner is gone", { allowBlockedRuns: true })).toMatchObject({ allowed: true });
      const transitions = count(f, "RUN_TRANSITION", runId);
      const refused = await resolve(f, runId, escalationId, "r1-no-owner");
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT });
      expectRolledBack(f, runId, escalationId, transitions);
    });
  });

  it("rolls back when the CEO_DECISION record is refused: the transition and the reply are taken back", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, escalationId } = await blocked(f);
      const audit = f.harness.cp.audit;
      const record = audit.record.bind(audit);
      vi.spyOn(audit, "record").mockImplementation((entry) =>
        entry.kind === "CEO_DECISION"
          ? { allowed: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED, message: "fixture: refused", evidence: {} }
          : record(entry));
      const transitions = count(f, "RUN_TRANSITION", runId);
      const refused = await resolve(f, runId, escalationId, "r1-record-refused");
      vi.restoreAllMocks();
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
      expectRolledBack(f, runId, escalationId, transitions);
    });
  });
});

/** A READY session that can take the role over. */
const replacementSession = (f: BootstrapRuntimeFixture): string => {
  const session = f.harness.cp.sessions.create({ provider: "scripted", model: `replacement-${++keys}` });
  f.harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "fixture session");
  return session.sessionId;
};

const takeover = (f: BootstrapRuntimeFixture, runId: string, sessionId: string, projectId?: string) =>
  f.harness.cp.bindings.switchTo({
    role: Role.BOOTSTRAP_CTO,
    runId,
    sessionId,
    ...(projectId ? { projectId } : {}),
    reason: "fixture takeover",
    conversation: "REPLACED",
    takeover: true,
  });

/** A resolved run whose ESCALATION_REPLY is still PENDING at the owner's generation. */
const resolvedWithPendingReply = async (f: BootstrapRuntimeFixture) => {
  const run = await blocked(f);
  expect(await resolve(f, run.runId, run.escalationId, `r1-resolve-${++keys}`)).toMatchObject({ ok: true });
  const [reply] = replies(f, run.runId);
  expect(reply).toMatchObject({ status: "PENDING", bindingGeneration: 1, targetSessionId: run.ownerSessionId });
  return { ...run, reply: reply! };
};

/** Not carried: the reply never reached the replacement and no carry record names it. */
const expectNotCarried = (f: BootstrapRuntimeFixture, messageId: string, replacement: string) => {
  const row = f.harness.cp.outbox.get(messageId)!;
  expect(row.targetSessionId).not.toBe(replacement);
  expect(row.status).not.toBe("PENDING");
  expect(carries(f, messageId)).toEqual([]);
};

describe("ESC-03: a PENDING ESCALATION_REPLY follows every takeover, to the run's new owner only", () => {
  it("a takeover carries it to the successor; the old generation cannot claim it; a second takeover carries it on until it is ACKed", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, reply } = await resolvedWithPendingReply(f);
      const oldIncarnation = f.harness.cp.sessions.get(ownerSessionId)!.incarnation;
      const successor = replacementSession(f);
      const switched = takeover(f, runId, successor);
      expect(switched, JSON.stringify(switched)).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });

      const carried = f.harness.cp.outbox.get(reply.messageId)!;
      expect(carried).toMatchObject({ status: "PENDING", bindingGeneration: 2, targetSessionId: successor, payload: reply.payload });
      expect(replies(f, runId)).toHaveLength(1);
      expect(carries(f, reply.messageId)).toEqual([
        {
          messageId: reply.messageId,
          correlationId: reply.messageId,
          fromGeneration: 1,
          fromSession: ownerSessionId,
          toGeneration: 2,
          toSessionId: successor,
        },
      ]);

      // The old generation neither sees nor settles it.
      expect(f.harness.cp.outbox.pendingInBandFor(ownerSessionId, oldIncarnation).map((m) => m.messageId)).not.toContain(reply.messageId);
      expect(f.harness.cp.outbox.acknowledge(reply.messageId, ownerSessionId, 1, oldIncarnation)).toMatchObject({ allowed: false });
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("PENDING");

      // The successor is handed it exactly once.
      const successorIncarnation = f.harness.cp.sessions.get(successor)!.incarnation;
      expect(f.harness.cp.outbox.pendingInBandFor(successor, successorIncarnation).filter((m) => m.messageId === reply.messageId))
        .toHaveLength(1);

      // A second takeover carries the same unACKed reply on, with its id, to the run's next owner:
      // repeated recovery never spends the CEO's resolution (ACP-R1-01).
      const third = replacementSession(f);
      expect(takeover(f, runId, third)).toMatchObject({ allowed: true, value: { bindingGeneration: 3 } });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 3, targetSessionId: third,
        payload: reply.payload });
      expect(replies(f, runId)).toHaveLength(1);
      expect(carries(f, reply.messageId).map((carry) => [carry["fromGeneration"], carry["toGeneration"]])).toEqual([[1, 2], [2, 3]]);
      const thirdIncarnation = f.harness.cp.sessions.get(third)!.incarnation;
      expect(f.harness.cp.outbox.acknowledge(reply.messageId, successor, 2, successorIncarnation)).toMatchObject({ allowed: false });
      expect(f.harness.cp.outbox.acknowledge(reply.messageId, third, 3, thirdIncarnation)).toMatchObject({ allowed: true });
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("ACKED");
    });
  });

  it("the successor settles the carried reply once", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, reply } = await resolvedWithPendingReply(f);
      const successor = replacementSession(f);
      expect(takeover(f, runId, successor)).toMatchObject({ allowed: true });
      const incarnation = f.harness.cp.sessions.get(successor)!.incarnation;
      expect(f.harness.cp.outbox.acknowledge(reply.messageId, successor, 2, incarnation)).toMatchObject({ allowed: true });
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("ACKED");
      expect(f.harness.cp.outbox.pendingInBandFor(successor, incarnation).map((m) => m.messageId)).not.toContain(reply.messageId);
    });
  });

  // Cancelling reclaims the run's owner and rejects the reply itself, before any takeover could
  // carry it; `#escalationReplyCarriable`'s live-run and new-owner clause is the second guard.
  it("not carried for a cancelled run", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, reply } = await resolvedWithPendingReply(f);
      expect(await f.hermes("run_cancel", { runId, reason: "fixture cancel" })).toMatchObject({ ok: true });
      const successor = replacementSession(f);
      takeover(f, runId, successor);
      expectNotCarried(f, reply.messageId, successor);
    });
  });

  it("not carried once a newer escalation makes the reply stale", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, reply } = await resolvedWithPendingReply(f);
      expect(await open(f, runId, ownerSessionId)).toMatchObject({ ok: true });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
      const successor = replacementSession(f);
      expect(takeover(f, runId, successor)).toMatchObject({ allowed: true });
      expect(f.harness.cp.runs.require(runId).ownerSessionId).toBe(successor);
      expectNotCarried(f, reply.messageId, successor);
    });
  });

  it("not carried to a successor bound in another project", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, reply } = await resolvedWithPendingReply(f);
      const projectId = "r1-other-project";
      const manifest = fixtureManifest(projectId);
      const registered = f.harness.cp.projects.register({
        projectId,
        name: projectId,
        manifest,
        authorization: f.harness.cp.manifestAuthorizationForTests(manifest),
      });
      expect(registered).toMatchObject({ allowed: true });
      const successor = replacementSession(f);
      expect(takeover(f, runId, successor, projectId)).toMatchObject({ allowed: true });
      expect(f.harness.cp.runs.require(runId).ownerSessionId).toBe(successor);
      expectNotCarried(f, reply.messageId, successor);
    });
  });

  it("not carried once SENT", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, reply } = await resolvedWithPendingReply(f);
      f.harness.cp.db.run("UPDATE outbox SET status = 'SENT' WHERE message_id = ?", [reply.messageId]);
      const successor = replacementSession(f);
      expect(takeover(f, runId, successor)).toMatchObject({ allowed: true });
      const row = f.harness.cp.outbox.get(reply.messageId)!;
      expect(row.targetSessionId).toBe(reply.targetSessionId);
      expect(row.bindingGeneration).toBe(1);
      expect(carries(f, reply.messageId)).toEqual([]);
    });
  });

  // ACP-R1-01: a delivery claim the replaced holder's send still held proves nothing was received,
  // so the claim is released and the reply follows the takeover with its id (at-least-once).
  it("carried, its delivery claim released, once claimed", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, reply } = await resolvedWithPendingReply(f);
      f.harness.cp.db.run(
        "UPDATE outbox SET status = 'IN_FLIGHT', claim_token = 'r1-claim', claimed_at = '2026-08-12T00:00:00.000Z' WHERE message_id = ?",
        [reply.messageId],
      );
      const successor = replacementSession(f);
      expect(takeover(f, runId, successor)).toMatchObject({ allowed: true });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", targetSessionId: successor, bindingGeneration: 2 });
      expect(f.harness.cp.db.get<{ claim_token: string | null }>("SELECT claim_token FROM outbox WHERE message_id = ?",
        [reply.messageId])?.claim_token).toBeNull();
      expect(carries(f, reply.messageId)).toHaveLength(1);
    });
  });
});
