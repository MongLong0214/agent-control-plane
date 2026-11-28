import type * as FsModule from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { ChannelReceipt } from "../../src/buzz/buzz-channel.ts";
import { appendChannelReceipt, channelDir, channelReceiptPath, readChannelReceipts } from "../../src/buzz/buzz-channel-files.ts";
import { applyChannelReceipts, type ChannelQueueDeps } from "../../src/buzz/buzz-channel-queue.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { outboxDeliveryReadback } from "../../src/outbox/outbox.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * #1491. A `replied` receipt the writer counts as already written must be one the daemon accepts, and a retry that
 * finishes its own torn line must not append it again when another writer's line lands while it reads the file.
 *
 * `readFileSync` is wrapped so a second writer can append right after the writer under test first reads the file.
 */
const race = vi.hoisted(() => ({ next: null as (() => void) | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const text = actual.readFileSync(...args);
    const run = race.next;
    race.next = null;
    run?.();
    return text;
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

afterAll(cleanupTempDirs);

const ROOM = "buzz-ceo-room";
const E1 = "e1".repeat(32);
const E2 = "e2".repeat(32);
const cto = generateSecretKey();
const ctoPub = getPublicKey(cto);

const reply = (parent: string): Extract<ChannelReceipt, { type: "replied" }> => ({
  type: "replied",
  event: finalizeEvent({ kind: 9, created_at: 1_700_000_000, tags: [["h", ROOM], ["e", parent, "", "reply"]], content: `done ${parent.slice(0, 4)}` }, cto),
  room: ROOM,
  parentEventId: parent,
  ack: "ACCEPTED",
  repliedAt: 2,
});

const receiptFile = (): string => {
  const dir = tempDir("buzz-channel-1491-");
  mkdirSync(channelDir(dir), { recursive: true });
  return dir;
};

describe("a stored reply receipt counts as written only when the daemon would accept it", () => {
  it("writes a valid replay over a stored copy whose signature does not verify, and that replay completes the message", () => {
    const dir = receiptFile();
    const valid = reply(E1);
    const corrupted = { ...valid, event: { ...valid.event, content: "changed after signing" } };
    writeFileSync(channelReceiptPath(dir, "p"), `${JSON.stringify(corrupted)}\n`);

    appendChannelReceipt(dir, "p", valid);
    // Once a valid copy is there, a further replay adds nothing.
    appendChannelReceipt(dir, "p", valid);

    const receipts = readChannelReceipts(channelReceiptPath(dir, "p")).receipts;
    expect(receipts.map((r) => (r.type === "replied" ? r.event.content : ""))).toEqual(["changed after signing", valid.event.content]);

    const holder = { roleKey: "PRIMARY_CTO:p", bindingGeneration: 1, targetSessionId: "s", sessionIncarnation: "i" };
    const ok = allow(ReasonCode.OK, undefined);
    const deps: ChannelQueueDeps = {
      messages: () => [{ messageId: "m1", delivery: outboxDeliveryReadback({ status: "SENT", failureClass: null }), holder, eventId: E1, room: ROOM }],
      boundActor: () => ctoPub,
      deliver: () => ok,
      complete: () => ok,
    };
    expect(applyChannelReceipts(deps, holder.roleKey, receipts).completed).toEqual(["m1"]);
  });
});

describe("finishing a torn reply line while another writer appends", () => {
  it("does not append the reply again when the other writer's leading newline completes it after the first read", () => {
    const dir = receiptFile();
    const a = reply(E1);
    const b = reply(E2);
    // A short write left A whole but for its newline.
    writeFileSync(channelReceiptPath(dir, "p"), JSON.stringify(a));
    // Right after A's retry first reads the file, B is appended on a new line, which completes A's line.
    race.next = () => appendChannelReceipt(dir, "p", b);

    appendChannelReceipt(dir, "p", a);

    expect(race.next).toBeNull();
    const read = readChannelReceipts(channelReceiptPath(dir, "p"));
    expect(read.receipts.map((r) => (r.type === "replied" ? r.event.id : ""))).toEqual([a.event.id, b.event.id]);
    expect(read.skipped).toEqual([]);
  });
});
