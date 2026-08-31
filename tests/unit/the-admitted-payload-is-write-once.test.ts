import { describe, expect, it } from "vitest";

import { AuditLog } from "../../src/db/audit.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress } from "../../src/ingress/telegram.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, TEST_OWNER } from "../helpers/harness.ts";
import { afterAll } from "vitest";

afterAll(cleanupTempDirs);

const OWNER_ID = "424242";
const CHAT_ID = "-100999";
const SECRET = "telegram-configured-secret";
const PROMPT = "배포 멈춰. 지금 올라간 커밋 되돌려.";

const ingressOver = (harness: ReturnType<typeof makeHarness>) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, new AuditLog(harness.cp.db, harness.cp.clock), {
    telegram: {
      allowedActors: [OWNER_ID],
      allowedConversations: [CHAT_ID],
      recoverInFlight: true,
      transportRetentionMs: 24 * 60 * 60 * 1000,
    },
  });
  return { guard, ingress: new TelegramIngress(guard, { webhookSecret: SECRET }) };
};

const updateFrom = (updateId: number, text: string) => ({
  update_id: updateId,
  message: {
    message_id: 7,
    date: 1_700_000_000,
    text,
    from: { id: Number(OWNER_ID), username: "owner" },
    chat: { id: Number(CHAT_ID) },
  },
});

const payloadOf = (harness: ReturnType<typeof makeHarness>, nonce: string): string | null =>
  harness.cp.db.get<{ payload_json: string | null }>(
    `SELECT payload_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [nonce],
  )?.payload_json ?? null;

/**
 * #631 stores the sender's own words on the ingress row. #646 is the reason this test exists: the
 * turn claim used to share `result_json` with the reply lifecycle, the reservation wrote that
 * column whole, and a completed turn came back looking like a message nobody had claimed. Two
 * lifecycles in one field.
 *
 * A payload column that any UPDATE can reach is that defect with a third lifecycle waiting to be
 * given to it — and the writers being careful today is not the property, because #646's writers
 * were careful too and the reservation still did it. The trigger is the property: the words are
 * not reachable by an UPDATE at all, so no future lifecycle can be handed them by accident.
 */
describe("the admitted payload is write-once", () => {
  it("survives the whole reply lifecycle running over the same row", () => {
    const harness = makeHarness({ ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }] });
    const { ingress } = ingressOver(harness);
    const admitted = ingress.admit(updateFrom(4242, PROMPT), SECRET);
    expect(admitted.allowed).toBe(true);
    const stored = payloadOf(harness, "update:4242");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ text: PROMPT, messageId: 7 });

    // Every writer that touches this row in the ordinary course of one message: `admit`'s own
    // ADMITTED marker, then the reply reservation and its completion. Each writes `result_json`
    // whole, which is exactly the move that erased the turn claim before #646.
    ingress.recordResult("update:4242", { kind: "TELEGRAM_WORKFLOW", phase: "ADMITTED" });
    ingress.recordResult("update:4242", {
      kind: "TELEGRAM_WORKFLOW",
      phase: "REPLIED",
      reply: { chatId: CHAT_ID, text: "…", replyToMessageId: 7, correlationId: "c" },
      sent: false,
      deliveryStatus: "PENDING",
    });
    ingress.recordResult("update:4242", {
      kind: "TELEGRAM_WORKFLOW",
      phase: "REPLIED",
      reply: { chatId: CHAT_ID, text: "…", replyToMessageId: 7, correlationId: "c" },
      sent: true,
      deliveryStatus: "APPLIED",
    });

    expect(payloadOf(harness, "update:4242")).toBe(stored);
  });

  it("refuses an UPDATE that would change it, so no lifecycle can be given this column", () => {
    const harness = makeHarness({ ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }] });
    const { ingress } = ingressOver(harness);
    expect(ingress.admit(updateFrom(4243, PROMPT), SECRET).allowed).toBe(true);

    expect(() =>
      harness.cp.db.run(
        `UPDATE inbound_messages SET payload_json = ? WHERE channel = 'telegram' AND nonce = ?`,
        [JSON.stringify({ text: "something else", messageId: 7 }), "update:4243"],
      ),
    ).toThrow(/INBOUND_PAYLOAD_IMMUTABLE/);

    // Erasure is the same defect as replacement, and a NULL is what an UPDATE that "clears" a
    // column writes. `IS NOT` in the trigger's WHEN is what makes this case reach the RAISE at
    // all — `<>` is NULL for a NULL operand, and a NULL condition does not fire a trigger.
    expect(() =>
      harness.cp.db.run(
        `UPDATE inbound_messages SET payload_json = NULL WHERE channel = 'telegram' AND nonce = ?`,
        ["update:4243"],
      ),
    ).toThrow(/INBOUND_PAYLOAD_IMMUTABLE/);

    expect(JSON.parse(payloadOf(harness, "update:4243")!)).toEqual({ text: PROMPT, messageId: 7 });
  });

  it("refuses an INSERT OR REPLACE, which rewrites the row without running an UPDATE trigger", () => {
    const harness = makeHarness({ ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }] });
    const { ingress } = ingressOver(harness);
    expect(ingress.admit(updateFrom(4244, PROMPT), SECRET).allowed).toBe(true);

    // The other half of write-once, and the half an UPDATE trigger cannot see: REPLACE deletes the
    // row and inserts a new one. Without this the payload rule would read as enforced and be
    // reachable — and so would the replay defence this whole table exists for, because a replaced
    // row is a nonce that has never been seen. `pnpm schema:census` refuses a table guarded on one
    // verb and open on the other, and named this one.
    expect(() =>
      harness.cp.db.run(
        `INSERT OR REPLACE INTO inbound_messages (channel, nonce, actor, received_at, payload_json)
         VALUES ('telegram', 'update:4244', ?, ?, ?)`,
        [OWNER_ID, "2026-08-12T00:00:00.000Z", JSON.stringify({ text: "something else", messageId: 7 })],
      ),
    ).toThrow(/INBOUND_MESSAGE_NO_REPLACE/);

    expect(JSON.parse(payloadOf(harness, "update:4244")!)).toEqual({ text: PROMPT, messageId: 7 });
  });
});
