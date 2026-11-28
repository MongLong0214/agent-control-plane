import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ChannelReceipt } from "../../src/buzz/buzz-channel.ts";
import { channelReceiptPath } from "../../src/buzz/buzz-channel-files.ts";
import {
  applyChannelReceipts,
  channelQueueMessages,
  watchChannelReceipts,
  type ChannelQueueDatabase,
  type ChannelQueueDeps,
} from "../../src/buzz/buzz-channel-queue.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A daemon start replays every mention it missed, and each admission applies the channel's receipts.
 * Applied one receipt at a time against a fresh read of the role's queue, a role with 54 queued
 * messages and 54 receipts cost thousands of database reads per admission and held the event loop for
 * minutes. The queue is read once per pass, receipts already applied are not applied again, and an
 * admission burst is one pass.
 */

const ROOM = "room-1";
const ROLE = "PRIMARY_CTO:p";
const COUNT = 54;
const ADMITS = 57;

const eventIdOf = (i: number): string => `evt-${String(i).padStart(3, "0")}`;
const emitted = (eventId: string): ChannelReceipt => ({ type: "emitted", eventId, room: ROOM, senderPubkey: "owner", emittedAt: 1 });

/** A fake of the daemon's database that answers the two queries the queue reader makes, and counts them. */
const queueOver = (initial: number, status: (i: number) => "PENDING" | "SENT" = () => "PENDING") => {
  const states = new Map<string, "PENDING" | "SENT">();
  const order: string[] = [];
  const add = (i: number, s: "PENDING" | "SENT" = status(i)): void => {
    states.set(`m${i}`, s);
    order.push(`m${i}`);
  };
  for (let i = 0; i < initial; i += 1) add(i);
  const counts = { all: 0, get: 0 };
  const db: ChannelQueueDatabase = {
    all: <T>(): T[] => {
      counts.all += 1;
      return order.map((id) => ({
        message_id: id,
        status: states.get(id)!,
        failure_class: null,
        role_key: ROLE,
        binding_generation: 1,
        target_session_id: "s",
        payload_json: JSON.stringify({ sourceChannel: "buzz", sourceNonce: buzzMessageNonce(eventIdOf(Number(id.slice(1)))), sourcePayloadDigest: "sha256:x" }),
      })) as unknown as T[];
    },
    get: <T>(): T | undefined => {
      counts.get += 1;
      return { payload_json: JSON.stringify({ conversation: ROOM }) } as unknown as T;
    },
  };
  const delivered: string[] = [];
  const deps: ChannelQueueDeps = {
    messages: channelQueueMessages(db, () => "incarnation"),
    boundActor: () => null,
    deliver: (message) => {
      delivered.push(message.messageId);
      states.set(message.messageId, "SENT");
      return allow(ReasonCode.OK, undefined);
    },
    complete: () => allow(ReasonCode.OK, undefined),
  };
  return { deps, counts, states, delivered, add, reads: () => counts.all + counts.get };
};

describe("a start with a large queue and a large receipts file", () => {
  it("reads the role's queue once for the whole batch of receipts, not once per receipt", () => {
    const q = queueOver(COUNT);
    const receipts = Array.from({ length: COUNT }, (_, i) => emitted(eventIdOf(i)));
    const out = applyChannelReceipts(q.deps, ROLE, receipts);
    expect(out.delivered).toHaveLength(COUNT);
    expect(q.counts.all).toBe(1);
    expect(q.reads()).toBeLessThanOrEqual(1 + COUNT);
  });

  it("applies every receipt once however many admissions ask for it, with reads linear in queue plus receipts", () => {
    const q = queueOver(COUNT);
    const stateDir = tempDir("acp-channel-start-");
    mkdirSync(join(stateDir, "buzz-channel"), { recursive: true });
    appendFileSync(channelReceiptPath(stateDir, "p"), Array.from({ length: COUNT }, (_, i) => `${JSON.stringify(emitted(eventIdOf(i)))}\n`).join(""));
    const watcher = watchChannelReceipts(stateDir, () => ROLE, q.deps);
    try {
      for (let i = 0; i < ADMITS; i += 1) watcher.apply();
      expect(q.delivered).toHaveLength(COUNT);
      expect(new Set(q.delivered).size).toBe(COUNT);
      expect([...q.states.values()].every((s) => s === "SENT")).toBe(true);
      // The old shape cost receipts x queue per admission. Linear is one read of the queue and one lookup per row.
      expect(q.reads()).toBeLessThanOrEqual(2 * (COUNT + 1));
    } finally {
      watcher.close();
    }
  });

  it("makes one pass of an admission burst, and a message admitted afterwards still gets its earlier receipt", async () => {
    const q = queueOver(0);
    const stateDir = tempDir("acp-channel-burst-");
    mkdirSync(join(stateDir, "buzz-channel"), { recursive: true });
    appendFileSync(channelReceiptPath(stateDir, "p"), Array.from({ length: COUNT }, (_, i) => `${JSON.stringify(emitted(eventIdOf(i)))}\n`).join(""));
    const watcher = watchChannelReceipts(stateDir, () => ROLE, q.deps);
    try {
      const before = q.counts.all;
      for (let i = 0; i < ADMITS; i += 1) watcher.request();
      await new Promise((r) => setTimeout(r, 300));
      // A leading pass and one trailing pass, never one per admission.
      expect(q.counts.all - before).toBeLessThanOrEqual(2);
      expect(q.delivered).toEqual([]);

      // The receipt was there first; the daemon admits the message afterwards.
      q.add(7);
      watcher.request();
      await new Promise((r) => setTimeout(r, 300));
      expect(q.delivered).toEqual(["m7"]);
      expect(q.states.get("m7")).toBe("SENT");
    } finally {
      watcher.close();
    }
  });

  it("lets a registered receipt through without reading the queue, counting it, or moving a message", () => {
    const q = queueOver(1);
    const out = applyChannelReceipts(q.deps, ROLE, [{ type: "registered", registeredAt: 1, launchId: "this-launch" }]);
    expect(out).toEqual({ delivered: [], completed: [], ignored: 0, invalid: 0 });
    expect(q.reads()).toBe(0);
  });

  it("does not read the queue again for receipts it has already applied", () => {
    const q = queueOver(3);
    const stateDir = tempDir("acp-channel-settled-");
    mkdirSync(join(stateDir, "buzz-channel"), { recursive: true });
    appendFileSync(channelReceiptPath(stateDir, "p"), [0, 1, 2].map((i) => `${JSON.stringify(emitted(eventIdOf(i)))}\n`).join(""));
    const watcher = watchChannelReceipts(stateDir, () => ROLE, q.deps);
    try {
      expect(q.delivered).toHaveLength(3);
      const reads = q.reads();
      watcher.apply();
      watcher.apply();
      expect(q.reads()).toBe(reads);
    } finally {
      watcher.close();
    }
  });
});
