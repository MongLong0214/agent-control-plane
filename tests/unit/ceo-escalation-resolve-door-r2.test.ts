import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  BOOTSTRAP_FIXTURE_TOKEN,
  type BootstrapRuntimeFixture,
  acknowledgeInBandOnWorkTurns,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Round-2 regressions for the CEO's escalation door (#1120): the committed decision answers a replay
 * before the MCP response cache can (ESC-01), and the official restart renewal of a run's bootstrap
 * owner carries a reply the outage would have lost (ESC-03). The sequences are the reviewer's.
 */

let keys = 0;

/**
 * A dispatched run whose owner has finished its two turns: the attestation `run_dispatch` awaits, and
 * the RUN_DISPATCH work turn its commit wakes and that runs behind its reply (#1156: waited for, not
 * timed). Later work turns of the owner do nothing.
 */
const quietOwner = async (f: BootstrapRuntimeFixture) => {
  acknowledgeInBandOnWorkTurns(f);
  const run = await f.dispatchBootstrap();
  await f.awaitFinishedTurns(run.ownerSessionId, 1);
  f.claude.onWorkTurn = async () => {};
  return run;
};

/**
 * Blocks the owner's first work turn at the provider until the test calls `release`, as a slow runner
 * keeps it there. `entered` settles once the turn is blocked, so the session already shows it running;
 * `returned` settles once that turn's provider call has returned after its release. `release` is
 * idempotent: a second call does nothing.
 */
const latchFirstWorkTurn = (f: BootstrapRuntimeFixture) => {
  const runTurn = f.claude.runSessionTurn.bind(f.claude);
  let enter = (): void => undefined;
  let release = (): void => undefined;
  let markReturned = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const returned = new Promise<void>((resolve) => {
    markReturned = resolve;
  });
  let held = 0;
  f.claude.runSessionTurn = async (request) => {
    if (held === 0 && request.relay !== null) {
      held += 1;
      enter();
      await released;
      try {
        return await runTurn(request);
      } finally {
        markReturned();
      }
    }
    return runTurn(request);
  };
  return { entered, returned, release: () => release(), held: () => held };
};

/**
 * Keeps `failure` the error the test reports when the cleanup after it fails too: the cleanup error is
 * recorded on it (`cleanupErrors`) and printed beside it, never thrown in its place.
 */
const keepFailureOverCleanupError = (failure: unknown, cleanupError: unknown): void => {
  if (typeof failure === "object" && failure !== null) {
    const carrier = failure as { cleanupErrors?: unknown[] };
    (carrier.cleanupErrors ??= []).push(cleanupError);
  }
  console.error("the cleanup after this test's failure also failed:", cleanupError);
};

const open = async (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string) => {
  const opened = await f.cto(ownerSessionId, "escalation_open", {
    idempotencyKey: `r2-open-${++keys}`,
    runId,
    question: "which repository?",
    options: ["one", "two"],
    ctoRecommendation: "one",
    whyItMatters: "repository identity",
    blocksCriticalPath: true,
  });
  expect(opened).toMatchObject({ ok: true });
  return f.harness.cp.ceo.openEscalationOf(runId)!.escalationId;
};

const resolve = (f: BootstrapRuntimeFixture, runId: string, escalationId: number, idempotencyKey: string, resolution = "use repository one") =>
  f.hermes("escalation_resolve", { idempotencyKey, runId, escalationId, resolution });

const replies = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.ESCALATION_REPLY);

const count = (f: BootstrapRuntimeFixture, kind: string, runId: string): number =>
  f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND run_id = ?`, [kind, runId])!.n;

const records = (f: BootstrapRuntimeFixture, kind: string, messageId: string) =>
  f.harness.cp.db.all<{ evidence_json: string }>(
    `SELECT evidence_json FROM audit_events WHERE kind = ? AND json_extract(evidence_json, '$.messageId') = ? ORDER BY event_id`,
    [kind, messageId],
  ).map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);

/** The MCP layer's own response store fails once for `key`, after the decision committed. */
const failResultStore = (f: BootstrapRuntimeFixture, key: string) => {
  const db = f.harness.cp.db;
  const original = db.run.bind(db);
  let injected = false;
  vi.spyOn(db, "run").mockImplementation((sql, params) => {
    if (!injected && sql.includes("UPDATE inbound_messages SET result_json") && params?.[1] === key) {
      injected = true;
      throw new Error("witness: replay cache lost after commit");
    }
    return original(sql, params);
  });
  return () => injected;
};

describe("#1156: quietOwner waits for the RUN_DISPATCH turn, not a wall clock", () => {
  it("while the RUN_DISPATCH turn is held past vi.waitFor's default 1000 ms quietOwner stays pending; once it is released, quietOwner resolves with one finished turn", async ({ signal, onTestFinished }) => {
    // This test's own end, which the runner awaits before the next test on every cooperative exit (a pass,
    // an assertion failure, a rejection, its timeout), bounded by hookTimeout: release the held turn, then
    // collect the body, fixture close included. The body never waits on this hook. Its failure is already
    // the test's, so it is neither reported again here nor replaced.
    let releaseHeldTurn = (): void => undefined;
    let body: Promise<void> = Promise.resolve();
    onTestFinished(async () => {
      try {
        releaseHeldTurn();
      } catch {
        // The body's cleanup releases it too, and reports that error beside the test's failure.
      }
      await body.then(
        () => undefined,
        () => undefined,
      );
    });
    body = withBootstrapRuntime(async (f) => {
      const latch = latchFirstWorkTurn(f);
      releaseHeldTurn = () => latch.release();
      // quietOwner past run_dispatch's reply: from there only its wait for the turn can keep it pending.
      const dispatchBootstrap = f.dispatchBootstrap;
      let answer = (_run: Awaited<ReturnType<typeof dispatchBootstrap>>): void => undefined;
      const answered = new Promise<Awaited<ReturnType<typeof dispatchBootstrap>>>((resolve) => {
        answer = resolve;
      });
      f.dispatchBootstrap = async () => {
        const run = await dispatchBootstrap();
        answer(run);
        return run;
      };
      // quietOwner's settlement is observed from the moment it exists, so a rejection is captured here and
      // never left unhandled; it is rethrown after the release.
      let state: "pending" | "resolved" | "rejected" = "pending";
      const settled = quietOwner(f).then(
        (run) => {
          state = "resolved";
          return { ok: true as const, run };
        },
        (error: unknown) => {
          state = "rejected";
          return { ok: false as const, error };
        },
      );
      let run: Awaited<ReturnType<typeof dispatchBootstrap>> | null = null;
      let failure: { error: unknown } | null = null;
      // A runner timeout aborts the test's signal: the held turn is released, and every observation wait
      // below is interrupted, so the body reaches its cleanup at once. The listener is removed on every exit.
      let abort = (): void => undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => {
          latch.release();
          reject(signal.reason);
        };
      });
      aborted.catch(() => undefined);
      const untilAborted = <T>(wait: Promise<T>): Promise<T> => Promise.race([wait, aborted]);
      let observation: ReturnType<typeof setTimeout> | undefined;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        run = await untilAborted(
          Promise.race([
            Promise.all([latch.entered, answered]).then(([, dispatched]) => dispatched),
            // quietOwner settled before its turn was held: nothing is left to observe pending.
            settled.then(() => null),
          ]),
        );
        expect(run, `quietOwner settled (${state}) before its RUN_DISPATCH turn was held`).not.toBeNull();
        const { ownerSessionId } = run!;
        // A macrotask boundary: whatever quietOwner could finish without the turn has finished.
        await untilAborted(new Promise((resolve) => setImmediate(resolve)));
        // The only timed step in this test, and one is necessary: no latch can tell a wait that gives up at
        // 1000 ms (vi.waitFor's default, the wait #1156 replaced) from one that never gives up, unless 1000 ms
        // pass while the turn is held. It is deterministic: that old wait started its 1000 ms timer before the
        // boundary above, so it is registered ahead of this 1100 ms one (its 1000 ms plus two 50 ms polls) and
        // always fires first. Timer order decides, not how fast the turn runs.
        await untilAborted(
          new Promise((resolve) => {
            observation = setTimeout(resolve, 1_100);
          }),
        );
        expect(state).toBe("pending");
        expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(true);
        expect(f.finishedTurns(ownerSessionId)).toBe(0);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        clearTimeout(observation);
        // On every cooperative exit path (assertion failure, rejection, runner timeout) the held turn is
        // released, quietOwner settles, and the released turn returns before the fixture closes (a wait
        // that already gave up no longer waits for it), each step tried even if another throws. A cleanup
        // error never replaces the failure that brought us here.
        const cleanupErrors: unknown[] = [];
        const turnReturned = async (): Promise<void> => {
          if (latch.held() === 0) return;
          await latch.returned;
          // The runtime records the returned turn and frees the session's lane before the next macrotask.
          await new Promise((resolve) => setImmediate(resolve));
        };
        for (const step of [() => latch.release(), () => settled, turnReturned]) {
          try {
            await step();
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          if (failure === null) throw cleanupErrors[0];
          for (const cleanupError of cleanupErrors) keepFailureOverCleanupError(failure.error, cleanupError);
        }
      }

      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      const { runId, ownerSessionId } = run!;
      expect(outcome.run).toMatchObject({ runId, ownerSessionId });
      expect(latch.held()).toBe(1);
      expect(f.finishedTurns(ownerSessionId)).toBe(1);
      expect(f.harness.cp.outbox.listByRun(runId).filter((m) => m.kind === MessageKind.RUN_DISPATCH)).toMatchObject([{ status: "ACKED" }]);
    });
    await body;
  });

  it("a RUN_DISPATCH turn that never runs fails at once, naming the turns finished and the state reached", async () => {
    await withBootstrapRuntime(async (f) => {
      // The commit's wake reaches nothing, so no turn follows the attestation.
      f.harness.cp.outbox.attachInBandWake(async () => allow(ReasonCode.OK, undefined));
      await expect(quietOwner(f)).rejects.toThrow(
        /expected 1 finished turns of \S+; reached 0 finished, no turn running or queued; turns \[\]; in-band rows \[RUN_DISPATCH:PENDING\]$/,
      );
    });
  });
});

describe("ESC-01: the committed decision answers before the response cache", () => {
  it("a changed retry after cache loss cannot poison the original committed replay", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await quietOwner(f);
      const escalationId = await open(f, runId, ownerSessionId);
      const key = "poison-after-result-loss";
      const injected = failResultStore(f, key);
      const first = await resolve(f, runId, escalationId, key);
      vi.restoreAllMocks();
      expect(injected()).toBe(true);
      expect(first).toMatchObject({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
      f.harness.clock.advance(60_001);

      const changed = await resolve(f, runId, escalationId, key, "use repository two");
      expect(changed).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      const originalRetry = await resolve(f, runId, escalationId, key);
      expect(originalRetry).toMatchObject({
        ok: true,
        value: { runId, escalationId, state: RunState.ACTIVE, messageId: replies(f, runId)[0]!.messageId },
      });
      expect(replies(f, runId)).toHaveLength(1);
      expect(count(f, "CEO_DECISION", runId)).toBe(1);
    });
  });

  it("original success, then the same key with different content is CONFLICT, then the original resend returns the existing success; one decision, one reply", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await quietOwner(f);
      const escalationId = await open(f, runId, ownerSessionId);
      const key = "r2-ordered";
      const original = await resolve(f, runId, escalationId, key);
      expect(original).toMatchObject({ ok: true, value: { runId, escalationId, state: RunState.ACTIVE } });
      expect(await resolve(f, runId, escalationId, key, "use repository two")).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(await resolve(f, runId, escalationId, key)).toEqual(original);
      expect(replies(f, runId)).toHaveLength(1);
      expect(count(f, "CEO_DECISION", runId)).toBe(1);
    });
  });

  it("a cached refusal is never upgraded to success by durable fallback", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await quietOwner(f);
      const escalationId = await open(f, runId, ownerSessionId);
      const key = "r2-cached-conflict";
      const original = await resolve(f, runId, escalationId, key);
      expect(original).toMatchObject({ ok: true });
      // Even a matching fingerprint cannot authorize replacing a stored refusal with success.
      const conflict = {
        content: [{ type: "text", text: "{}" }],
        isError: true,
        structuredContent: { ok: false, reasonCode: ReasonCode.CONFLICT, message: "cached", evidence: { requestDigest: "sha256:other" } },
      };
      f.harness.cp.db.run(`UPDATE inbound_messages SET result_json = ? WHERE channel = 'mcp' AND nonce = ?`, [JSON.stringify({ ...JSON.parse(f.harness.cp.db.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [key])!.result_json), result: conflict }), key]);
      expect(await resolve(f, runId, escalationId, key)).toEqual(conflict.structuredContent);
      expect(replies(f, runId)).toHaveLength(1);
      expect(count(f, "CEO_DECISION", runId)).toBe(1);
    });
  });

  it("the committed decision is read only after the current-CEO fence: another peer resending the key is refused", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await quietOwner(f);
      const escalationId = await open(f, runId, ownerSessionId);
      const key = "r2-fenced";
      expect(await resolve(f, runId, escalationId, key)).toMatchObject({ ok: true });
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
          arguments: { idempotencyKey: key, runId, escalationId, resolution: "use repository one" },
        });
        expect(refused.structuredContent).toMatchObject({ ok: false });
        expect(refused.structuredContent).not.toHaveProperty("value");
      } finally {
        await client.close();
      }
      expect(replies(f, runId)).toHaveLength(1);
      expect(count(f, "CEO_DECISION", runId)).toBe(1);
    });
  });
});

/** A resolved run whose reply is PENDING and unclaimed at generation 1, its owner idle. */
const resolvedWithPendingReply = async (f: BootstrapRuntimeFixture) => {
  const run = await quietOwner(f);
  const escalationId = await open(f, run.runId, run.ownerSessionId);
  expect(await resolve(f, run.runId, escalationId, `r2-resolve-${++keys}`)).toMatchObject({ ok: true });
  const reply = replies(f, run.runId)[0]!;
  expect(reply).toMatchObject({ status: "PENDING", bindingGeneration: 1, targetSessionId: run.ownerSessionId });
  await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(run.ownerSessionId)).toBe(false));
  return { ...run, escalationId, reply };
};

/** The restart: the daemon no longer holds the runtime's credential. */
const restart = async (f: BootstrapRuntimeFixture, ownerSessionId: string) => {
  await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
  f.harness.cp.sessionRuntime.release(ownerSessionId);
  await f.daemon.reconcileContinuity("first tick after restart");
};

/** The second tick: continuity recovers the same official owner at the next generation. */
const recover = (f: BootstrapRuntimeFixture) => f.daemon.reconcileContinuity("recover the same bootstrap owner");

describe("ESC-03: the official restart renewal carries a held reply once", () => {
  it("the reviewer's restart: held at the revocation, delivered once to generation 2, and generation 1 cannot claim it", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      // Generation 1's authority is the credential its runtime held; the renewal rotates it.
      const generationOne = { ...f.claude.credentials.get(ownerSessionId)! };
      await restart(f, ownerSessionId);
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_HELD", reply.messageId)).toHaveLength(1);
      // The generic fence leaves a held reply alone while its run waits for that renewal.
      f.harness.cp.outbox.fenceUndeliverable();
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("PENDING");

      await recover(f);
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ sessionId: ownerSessionId, bindingGeneration: 2 });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ ownerSessionId, ownerBindingGeneration: 2 });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({
        status: "PENDING", bindingGeneration: 2, targetSessionId: ownerSessionId, payload: reply.payload,
      });
      expect(replies(f, runId)).toHaveLength(1);
      expect(records(f, "ESCALATION_REPLY_CARRIED", reply.messageId)).toEqual([
        { messageId: reply.messageId, correlationId: reply.messageId, fromGeneration: 1, fromSession: ownerSessionId, toGeneration: 2, toSessionId: ownerSessionId },
      ]);

      expect(f.claude.credentials.get(ownerSessionId)!.sessionSecret).not.toBe(generationOne.sessionSecret);
      const asGenerationOne = { token: BOOTSTRAP_FIXTURE_TOKEN, sessionId: ownerSessionId, sessionSecret: generationOne.sessionSecret };
      for (const tool of ["role_dispatch_pending", "run_ack"]) {
        const refused = await callMcpToolOverSocket(f.ctoSocket, asGenerationOne, tool, { idempotencyKey: `r2-g1-${tool}`, runId, messageId: reply.messageId });
        expect(refused, tool).toMatchObject({ ok: false, reasonCode: ReasonCode.SESSION_SECRET_INVALID });
      }
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("PENDING");

      // Generation 2 is handed it exactly once, and settles it once.
      const pending = await f.cto(ownerSessionId, "role_dispatch_pending", {});
      const listed = (pending["value"] as { messages: Array<{ messageId: string }> }).messages.filter((m) => m.messageId === reply.messageId);
      expect(listed).toHaveLength(1);
      expect(await f.cto(ownerSessionId, "run_ack", { runId, messageId: reply.messageId })).toMatchObject({ ok: true });
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("ACKED");
      const after = await f.cto(ownerSessionId, "role_dispatch_pending", {});
      expect((after["value"] as { messages: Array<{ messageId: string }> }).messages.map((m) => m.messageId)).not.toContain(reply.messageId);
    });
  });

  // ACP-R1-01 retired the once-only budget: an unACKed reply follows every authenticated recovery.
  it("a second restart carries the same unACKed reply again, with its id, to generation 3", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      await recover(f);
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 2 });

      await restart(f, ownerSessionId);
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 2 });
      await recover(f);
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 3 });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 3,
        targetSessionId: ownerSessionId, payload: reply.payload });
      expect(records(f, "ESCALATION_REPLY_HELD", reply.messageId)).toHaveLength(1);
      expect(records(f, "ESCALATION_REPLY_CARRIED", reply.messageId).map((carry) => [carry["fromGeneration"], carry["toGeneration"]]))
        .toEqual([[1, 2], [2, 3]]);
      expect(replies(f, runId)).toHaveLength(1);
    });
  });

  it("a cancel between the revocation and the renewal rejects the held reply, in the cancel's own transaction", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("PENDING");
      expect(await f.hermes("run_cancel", { runId, reason: "fixture cancel" })).toMatchObject({ ok: true });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "REJECTED", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_HOLD_REJECTED", reply.messageId)).toMatchObject([{ reason: "run CANCELLED" }]);
      await recover(f);
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expect(records(f, "ESCALATION_REPLY_CARRIED", reply.messageId)).toEqual([]);
    });
  });

  it("a reply made stale by a newer escalation before the restart is rejected at the revocation, never held", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, reply } = await resolvedWithPendingReply(f);
      await open(f, runId, ownerSessionId);
      await restart(f, ownerSessionId);
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "REJECTED", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_HELD", reply.messageId)).toEqual([]);
      await recover(f);
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "REJECTED", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_CARRIED", reply.messageId)).toEqual([]);
    });
  });

  it.each([
    [
      "made stale while held",
      (f: BootstrapRuntimeFixture, runId: string) => {
        f.harness.cp.audit.record({ kind: "CTO_ESCALATION", runId, evidence: { question: "newer", blocksCriticalPath: true } });
      },
    ],
    [
      "claimed while held",
      (f: BootstrapRuntimeFixture, _runId: string, messageId: string) => {
        f.harness.cp.db.run(`UPDATE outbox SET claim_token = 'r2-claim' WHERE message_id = ?`, [messageId]);
      },
    ],
  ])("the renewal re-checks the held reply and rejects it when %s", async (_label, change) => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      expect(records(f, "ESCALATION_REPLY_HELD", reply.messageId)).toHaveLength(1);
      change(f, runId, reply.messageId);
      await recover(f);
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 2 });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "REJECTED", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_HOLD_REJECTED", reply.messageId)).toMatchObject([{ reason: "the renewal cannot carry it" }]);
      expect(records(f, "ESCALATION_REPLY_CARRIED", reply.messageId)).toEqual([]);
    });
  });

  it("a revocation that is not a renewal path holds nothing, and keeps the reply queued for the role's next binding", async () => {
    await withBootstrapRuntime(async (f) => {
      const { roleKey, reply } = await resolvedWithPendingReply(f);
      // A release, not an outage: no renewal follows it, so nothing asks for the hold. The reply
      // still answers its live run, so the one handover policy keeps it (ACP-R1-01).
      expect(f.harness.cp.runs.transition(reply.runId!, RunState.BLOCKED, "fixture hold")).toMatchObject({ allowed: true });
      expect(f.harness.cp.bindings.revoke(roleKey, "operator release", { allowBlockedRuns: true })).toMatchObject({ allowed: true });
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_HELD", reply.messageId)).toEqual([]);
      f.harness.cp.outbox.fenceUndeliverable();
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("PENDING");
    });
  });
});

/** A READY session that is not the run's owner: what a permanent replacement binds. */
const strangerSession = (f: BootstrapRuntimeFixture): string => {
  const next = f.harness.cp.sessions.create({ provider: "scripted", model: `permanent replacement ${++keys}` });
  expect(f.harness.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "replacement ready")).toMatchObject({ allowed: true });
  return next.sessionId;
};

/** The reply is never delivered: not to generation 1, not to the replacement, and never carried. */
const expectRejectedUndelivered = (f: BootstrapRuntimeFixture, messageId: string, ownerSessionId: string, reason: string) => {
  expect(f.harness.cp.outbox.get(messageId)).toMatchObject({ status: "REJECTED", bindingGeneration: 1, targetSessionId: ownerSessionId });
  expect(records(f, "ESCALATION_REPLY_HOLD_REJECTED", messageId)).toMatchObject([{ reason }]);
  expect(records(f, "ESCALATION_REPLY_CARRIED", messageId)).toEqual([]);
};

describe("ESC-03 round 3: a held reply stays held only while its renewal is still possible", () => {
  it("a permanent replacement after the hold rejects the reply in the replacement's own transaction (the reviewer's sequence)", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 1 });
      expect(records(f, "ESCALATION_REPLY_HELD", reply.messageId)).toHaveLength(1);

      const next = strangerSession(f);
      const replacement = f.harness.cp.bindings.switchTo({
        role: Role.BOOTSTRAP_CTO, runId, sessionId: next, reason: "permanent replacement, previous owner no longer authorized",
        conversation: "REPLACED", takeover: true,
      });
      expect(replacement).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
      expectRejectedUndelivered(f, reply.messageId, ownerSessionId, "the role was replaced, not renewed");
      const incarnation = f.harness.cp.sessions.get(next)!.incarnation;
      expect(f.harness.cp.outbox.pendingInBandFor(next, incarnation).map((m) => m.messageId)).not.toContain(reply.messageId);

      expect(await f.harness.cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE });
      f.harness.cp.outbox.fenceUndeliverable();
      expectRejectedUndelivered(f, reply.messageId, ownerSessionId, "the role was replaced, not renewed");
    });
  });

  it("a fresh bind of the role after the hold rejects the reply in the bind's own transaction", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      expect(f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId: strangerSession(f) })).toMatchObject({ allowed: true });
      expectRejectedUndelivered(f, reply.messageId, ownerSessionId, "the role was bound again, not renewed");
    });
  });

  it("the sweep is the backstop: a holder written past the bind paths ends the renewal, and the sweep rejects the reply", async () => {
    await withBootstrapRuntime(async (f) => {
      const { ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      // No bind path skips the transactional rejection; a raw write is the only way past it.
      f.harness.cp.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, task_id, actor_id, session_id,
                                  session_incarnation, binding_generation, mode, status, created_at)
         SELECT 'asg_r3_raw', role_key, role, project_id, run_id, task_id, actor_id, session_id,
                session_incarnation, binding_generation + 1, mode, 'ACTIVE', created_at
           FROM assignments WHERE role_key = ? AND binding_generation = 1`,
        [roleKey],
      );
      expect(f.harness.cp.outbox.get(reply.messageId)!.status).toBe("PENDING");
      expect(f.harness.cp.outbox.fenceUndeliverable()).toBeGreaterThanOrEqual(1);
      expectRejectedUndelivered(f, reply.messageId, ownerSessionId, "its renewal can no longer come");
    });
  });

  it("a reversible withdrawal (DRAINING) keeps the hold, and the renewal still carries it once after READY", async () => {
    await withBootstrapRuntime(async (f) => {
      const { ownerSessionId, roleKey, reply } = await resolvedWithPendingReply(f);
      await restart(f, ownerSessionId);
      expect(f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.DRAINING, "authority withdrawn for now")).toMatchObject({ allowed: true });
      expect(await f.harness.cp.bootstrapCtos.recover(roleKey)).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      f.harness.cp.outbox.fenceUndeliverable();
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 1 });

      expect(f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.READY, "authority restored")).toMatchObject({ allowed: true });
      f.harness.clock.advance(15 * 60_000 + 1);
      await recover(f);
      expect(f.harness.cp.outbox.get(reply.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 2, targetSessionId: ownerSessionId });
      expect(records(f, "ESCALATION_REPLY_CARRIED", reply.messageId)).toHaveLength(1);
    });
  });
});
