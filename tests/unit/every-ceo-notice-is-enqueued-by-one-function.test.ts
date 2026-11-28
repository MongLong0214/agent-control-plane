import { describe, expect, it } from "vitest";

import { enqueueCeoNotice } from "../../src/ceo/ceo-incident-notices.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { EnqueueInput, OutboxMessage } from "../../src/outbox/outbox.ts";

/**
 * #1442 PR 1 — every CEO notice is enqueued by `enqueueCeoNotice`: the role key, binding generation and target
 * session come from the CEO binding, the kind is always CEO_NOTIFICATION, and the outbox's decision is returned
 * as it is. The callers keep their own lookup, key, payload, dedup and audit.
 */
describe("enqueueCeoNotice", () => {
  it("addresses the notice to the CEO binding as a CEO_NOTIFICATION and returns the outbox decision", () => {
    const inputs: EnqueueInput[] = [];
    const decision = allow(ReasonCode.OK, { messageId: "m-1" } as OutboxMessage);
    const outbox = { enqueue: (input: EnqueueInput) => (inputs.push(input), decision) };
    const ceo = { roleKey: "CEO", bindingGeneration: 7, sessionId: "ceo-session" };

    const result = enqueueCeoNotice(outbox, ceo, { idempotencyKey: "k-1", runId: "run-1", payload: { a: 1 } });

    expect(result).toBe(decision);
    expect(inputs).toEqual([{
      idempotencyKey: "k-1",
      roleKey: "CEO",
      bindingGeneration: 7,
      targetSessionId: "ceo-session",
      runId: "run-1",
      kind: MessageKind.CEO_NOTIFICATION,
      payload: { a: 1 },
    }]);
  });
});
