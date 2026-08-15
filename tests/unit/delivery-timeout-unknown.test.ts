import { afterAll, describe, expect, it } from "vitest";

import { BuzzAdapter, type BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Destination exactly-once — a timeout must not be retried (#451).
 *
 * `classifyTransportFailure` grouped `timed out` with `econn`, `enotfound` and `unavailable` and
 * marked the whole group retryable. Those others are different in kind: they fail *before*
 * anything leaves, so a retry sends the message for the first time. A timeout does not say that.
 * The frame may already be at the far end and the actor already processing it — `send` returning
 * late says nothing about whether it arrived.
 *
 * Retrying there puts the same envelope into the destination twice, which is the gap #451 names:
 * admission uniqueness proves the message was accepted once and says nothing about what happened
 * at the other end.
 *
 * It is also the fold #448 is about — an unknown reported as a definite answer. "It timed out"
 * was being recorded as "it did not happen".
 *
 * The observable is the outbox row: a retryable failure returns to PENDING and will be claimed
 * again; a non-retryable one is REJECTED and stays put. This asserts the row, not the classifier,
 * because a test of the classifier's return value would pass with the delivery loop ignoring it.
 */
const transportThatFails = (error: Error): BuzzTransport => ({
  openChannel: async () => "chan",
  send: async () => {
    throw error;
  },
  available: async () => true,
});

const enqueueOne = (core: ReturnType<typeof makeCore>, seeded: { runId: string; sessionId: string; roleKey: string }) => {
  core.db.run(`UPDATE sessions SET buzz_address = 'chan' WHERE session_id = ?`, [seeded.sessionId]);
  const queued = core.outbox.enqueue({
    idempotencyKey: `idem-${Math.abs(seeded.runId.length)}-${core.clock.nowIso()}`,
    roleKey: seeded.roleKey,
    bindingGeneration: 1,
    targetSessionId: seeded.sessionId,
    runId: seeded.runId,
    kind: MessageKind.RUN_DISPATCH,
    payload: { hello: "world" },
  });
  expect(queued.allowed).toBe(true);
  return queued.allowed ? queued.value.messageId : "";
};

const statusOf = (core: ReturnType<typeof makeCore>, messageId: string) =>
  core.db.get<{ status: string; failure_class: string | null }>(
    `SELECT status, failure_class FROM outbox WHERE message_id = ?`,
    [messageId],
  );

describe("a delivery timeout is unknown, not a failure to deliver (#451)", () => {
  it("does not return a timed-out message to the queue", async () => {
    const core = makeCore();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
    const messageId = enqueueOne(core, seeded);

    const adapter = new BuzzAdapter(
      core.db, core.clock, core.audit, core.sessions, core.bindings, core.outbox,
      transportThatFails(new Error("send timed out after 10000ms")),
    );
    await adapter.deliverPending();

    const row = statusOf(core, messageId);
    expect(
      row?.status,
      "a timed-out send went back to PENDING, so the same envelope will be delivered twice",
    ).toBe("REJECTED");
    expect(row?.failure_class).toBe("unknown_observed");
  });

  it("still retries a failure that happened before anything was sent", async () => {
    // The converse, and the reason this cannot simply mark every transport error final: a
    // refused connection never delivered anything, so declining to retry it would drop messages
    // that were never sent. The distinction is the point of the change, not the caution.
    const core = makeCore();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
    const messageId = enqueueOne(core, seeded);

    const adapter = new BuzzAdapter(
      core.db, core.clock, core.audit, core.sessions, core.bindings, core.outbox,
      transportThatFails(new Error("connect ECONNREFUSED 127.0.0.1:9")),
    );
    await adapter.deliverPending();

    const row = statusOf(core, messageId);
    expect(row?.status).toBe("PENDING");
    expect(row?.failure_class).toBe("transient");
  });
});
