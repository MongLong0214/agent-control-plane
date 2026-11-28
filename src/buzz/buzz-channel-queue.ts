import { existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import type { Decision } from "../core/errors.ts";
import { buzzMessageEventId, ownerMessagePointerOf } from "../ingress/buzz-message.ts";
import { outboxDeliveryReadback, type HolderIdentity, type OutboxMessage } from "../outbox/outbox.ts";
import type { ChannelReceipt } from "./buzz-channel.ts";
import { isChannelReceipt, replyParentOf } from "./buzz-channel.ts";
import { BUZZ_CHANNEL_RECEIPT_SUFFIX, channelDir, readChannelReceipts, replyReceiptVerifies } from "./buzz-channel-files.ts";

/**
 * The daemon's half of a CTO's Buzz channel: what the durable queue does with a channel's receipts.
 *
 * The queue stays the record. A CTO session that has the channel never calls `role_owner_message_claim`
 * in the ordinary path; the message moves instead when the channel says what happened to it:
 *
 *   - `emitted`: the channel wrote the message into the session. The row leaves `PENDING` through the
 *     same claim every holder-claimed message leaves it by, restricted to that one message, so every
 *     gate a claim applies (the peer proof, the mention gate, the source digest) still applies and a
 *     message those gates refuse is not delivered however the session came to see it.
 *   - `replied`: the CTO's reply was posted, by the reply tool or seen on the relay whatever sent it.
 *     It completes exactly one message: the one whose event the reply answers by its NIP-10 `reply`
 *     marker, when the reply is a signed kind-9 by the identity this session is bound to as its Buzz
 *     actor, in the room the message came from. A reply is settled per message it completed, never as
 *     a whole receipt, so a message admitted after its reply was read is still completed.
 *
 * A receipt is a claim by a file anyone running as this user can append to, so none of it is trusted
 * for what it says about itself: the message is found from the daemon's own rows, the reply's
 * signature and tags are checked here, and a receipt that matches no pending message changes nothing.
 * Nothing is lost by ignoring one: the message stays `PENDING` and the doctor names it.
 */

/** What the row says about delivery, as the shared interpretation reads it: never a status on its own. */
export type ChannelQueueDelivery = ReturnType<typeof outboxDeliveryReadback>;

export interface ChannelQueueMessage {
  readonly messageId: string;
  /** The row's status and failure class through `outboxDeliveryReadback`, the one projection every reader uses. */
  readonly delivery: ChannelQueueDelivery;
  readonly holder: HolderIdentity;
  readonly eventId: string;
  /** The Buzz room the event was written in; `null` when the stored envelope cannot say. */
  readonly room: string | null;
}

export interface ChannelQueueDeps {
  /** The role's pending or handed-over Buzz messages, as the daemon's own rows describe them. */
  messages(roleKey: string): readonly ChannelQueueMessage[];
  /** The Buzz identity this holder's session is bound to, or `null`. */
  boundActor(holder: HolderIdentity): string | null;
  /** Claims exactly this message for its holder, through every gate the holder's own claim passes. */
  deliver(message: ChannelQueueMessage): Decision<unknown>;
  complete(message: ChannelQueueMessage): Decision<void>;
}

export interface ChannelApplyResult {
  delivered: string[];
  completed: string[];
  ignored: number;
  /** Receipts that did not have a receipt's shape, or whose handling threw: skipped, the rest still applied. */
  invalid: number;
}

/** A receipt's identity: the same receipt read again from the file is the same key. */
const receiptKey = (receipt: ChannelReceipt): string =>
  receipt.type === "registered" ? `registered|${receipt.registeredAt}` : receipt.type === "emitted" ? `emitted|${receipt.room}|${receipt.eventId}` : `replied|${receipt.room}|${receipt.event.id}`;

/** A reply is settled for the one message it completed: its key, then the message id after this separator. */
const ROW = "\u0000";

/**
 * Applies `receipts` to the role's queue, reading the queue once for the whole batch and finding each
 * receipt's message by its event id, so a role with a long queue and a long receipts file costs one
 * read and one pass, not one read per receipt.
 *
 * `settled` holds the receipts a previous pass already carried out (a delivery that happened, a
 * completion that happened); they are skipped, and the ones this pass carries out are added. The queue's
 * own rows stay the durable record of what was applied: a restarted daemon starts with no `settled`, reads
 * the queue once, and finds each receipt's effect already there, so nothing is delivered twice.
 */
export const applyChannelReceipts = (
  deps: ChannelQueueDeps,
  roleKey: string,
  receipts: readonly unknown[],
  settled: Set<string> = new Set(),
): ChannelApplyResult => {
  const result: ChannelApplyResult = { delivered: [], completed: [], ignored: 0, invalid: 0 };
  let queue: Map<string, ChannelQueueMessage> | null = null;
  const queued = (): Map<string, ChannelQueueMessage> => {
    if (queue === null) {
      const index = new Map<string, ChannelQueueMessage>();
      // The first row for an event is the one a receipt moves, as it was when each receipt searched the list in order.
      for (const message of deps.messages(roleKey)) if (!index.has(message.eventId)) index.set(message.eventId, message);
      queue = index;
    }
    return queue;
  };
  for (const receipt of receipts) {
    // One receipt that is not a receipt, or that the queue cannot make sense of, never stops the others.
    if (!isChannelReceipt(receipt)) {
      result.invalid += 1;
      continue;
    }
    // A `registered` receipt proves a launch to its launcher and moves no message.
    if (receipt.type === "registered") continue;
    const key = receiptKey(receipt);
    try {
      if (receipt.type === "replied") {
        const parent = replyParentOf(receipt.event);
        const target = parent === null ? undefined : queued().get(parent);
        if (target === undefined) result.ignored += 1;
        else if (!settled.has(`${key}${ROW}${target.messageId}`) && applyReply(deps, receipt, target, result, queued())) {
          settled.add(`${key}${ROW}${target.messageId}`);
        }
        continue;
      }
      if (settled.has(key)) continue;
      if (applyOne(deps, receipt, result, queued())) settled.add(key);
    } catch {
      result.invalid += 1;
    }
  }
  return result;
};

/** Whether an `emitted` receipt's effect is now in the queue, so a later pass has nothing left to do for it. */
const applyOne = (
  deps: ChannelQueueDeps,
  receipt: Extract<ChannelReceipt, { type: "emitted" }>,
  result: ChannelApplyResult,
  queue: Map<string, ChannelQueueMessage>,
): boolean => {
  const message = queue.get(receipt.eventId);
  if (message === undefined || message.room === null || message.room !== receipt.room) {
    result.ignored += 1;
    return false;
  }
  return settleOne(deps, message, false, result, queue);
};

/**
 * Whether a CTO's posted reply completed `message`, the one whose event its `reply` marker names: a signed kind-9 by the
 * holder's bound Buzz actor, in the message's room. Naming the event's id is the proof it answered that message.
 */
const applyReply = (
  deps: ChannelQueueDeps,
  receipt: Extract<ChannelReceipt, { type: "replied" }>,
  message: ChannelQueueMessage,
  result: ChannelApplyResult,
  queue: Map<string, ChannelQueueMessage>,
): boolean => {
  if (
    message.room === null ||
    message.room !== receipt.room ||
    receipt.event.pubkey !== deps.boundActor(message.holder) ||
    // The rest is the check the receipt writer applies too, so a stored copy it counts as written is one accepted here.
    !replyReceiptVerifies(receipt)
  ) {
    result.ignored += 1;
    return false;
  }
  return settleOne(deps, message, true, result, queue);
};

/** Delivers `message` when it has not been, then completes it when asked to. A message whose outcome is unknown, or held from automatic resend, is not this module's to move. */
const settleOne = (
  deps: ChannelQueueDeps,
  message: ChannelQueueMessage,
  complete: boolean,
  result: ChannelApplyResult,
  queue: Map<string, ChannelQueueMessage>,
): boolean => {
  let current = message;
  if (current.delivery.automaticResendHeld) {
    result.ignored += 1;
    return false;
  }
  if (!current.delivery.delivered) {
    if (!deps.deliver(current).allowed) {
      result.ignored += 1;
      return false;
    }
    result.delivered.push(current.messageId);
    // The claim moved the row to SENT, with no failure class: read the same way it will be next time.
    current = { ...current, delivery: outboxDeliveryReadback({ status: "SENT", failureClass: null }) };
    queue.set(current.eventId, current);
  }
  if (!complete) return true;
  if (current.delivery.delivered && !current.delivery.completed) {
    if (!deps.complete(current).allowed) {
      result.ignored += 1;
      return false;
    }
    result.completed.push(current.messageId);
    // A completed row is no longer a pending or handed-over message: the next read would not list it.
    queue.delete(current.eventId);
  }
  return true;
};

/** Every receipt file beneath the daemon's state directory: its project, its well-formed receipts, and the numbers of the lines skipped. */
export const readAllChannelReceipts = (stateDir: string): { projectId: string; receipts: ChannelReceipt[]; skipped: number[] }[] => {
  const dir = channelDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(BUZZ_CHANNEL_RECEIPT_SUFFIX))
    .map((name) => ({ projectId: name.slice(0, -BUZZ_CHANNEL_RECEIPT_SUFFIX.length), ...readChannelReceipts(join(dir, name)) }));
};

/** The message-resolving half of `ChannelQueueDeps`, over the daemon's database. */
export interface ChannelQueueDatabase {
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
}

/** The room an admitted message came from is fixed when it is admitted, so it is read from the database once. */
const ROOM_CACHE_LIMIT = 10_000;

export const channelQueueMessages = (db: ChannelQueueDatabase, incarnationOf: (sessionId: string) => string | null) => {
  const rooms = new Map<string, string | null>();
  return (roleKey: string): ChannelQueueMessage[] =>
    db
      .all<{ message_id: string; status: "PENDING" | "SENT"; failure_class: OutboxMessage["failureClass"]; role_key: string; binding_generation: number; target_session_id: string; payload_json: string }>(
        `SELECT message_id, status, failure_class, role_key, binding_generation, target_session_id, payload_json FROM outbox
          WHERE role_key = ? AND kind IN ('OWNER_MESSAGE','PEER_MESSAGE') AND status IN ('PENDING','SENT')
          ORDER BY created_at, rowid`,
        [roleKey],
      )
      .flatMap((row): ChannelQueueMessage[] => {
        let pointer: ReturnType<typeof ownerMessagePointerOf> = null;
        try {
          pointer = ownerMessagePointerOf(JSON.parse(row.payload_json) as unknown);
        } catch {
          return [];
        }
        const incarnation = incarnationOf(row.target_session_id);
        if (pointer === null || incarnation === null) return [];
        const roomKey = `${pointer.sourceChannel}\u0000${pointer.sourceNonce}`;
        let room: string | null = null;
        if (rooms.has(roomKey)) room = rooms.get(roomKey) ?? null;
        else {
          const source = db.get<{ payload_json: string | null }>(
            "SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?",
            [pointer.sourceChannel, pointer.sourceNonce],
          );
          try {
            const envelope = source?.payload_json ? (JSON.parse(source.payload_json) as { conversation?: unknown }) : null;
            room = typeof envelope?.conversation === "string" ? envelope.conversation : null;
          } catch {
            room = null;
          }
          // A row that is not there yet is asked for again; one that is there does not change.
          if (source != null) {
            if (rooms.size >= ROOM_CACHE_LIMIT) rooms.clear();
            rooms.set(roomKey, room);
          }
        }
        return [{
          messageId: row.message_id,
          delivery: outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class ?? null }),
          holder: {
            roleKey: row.role_key,
            bindingGeneration: row.binding_generation,
            targetSessionId: row.target_session_id,
            sessionIncarnation: incarnation,
          },
          eventId: buzzMessageEventId(pointer.sourceNonce),
          room,
        }];
      });
};

export interface ChannelReceiptWatcher {
  /** Applies every receipt on disk now; safe to call at any time and as often as wanted. */
  apply(): ChannelApplyResult[];
  /**
   * Asks for a pass: now when none has run lately, otherwise once more shortly, however many ask in between.
   * What a burst of admissions calls, so a replay of missed mentions is one pass and not one per mention.
   */
  request(): void;
  close(): void;
}

/** The least time between two passes asked for with `request`. */
export const CHANNEL_RECEIPT_PASS_GAP_MS = 100;

/**
 * Applies receipts when a receipt file changes, once at start, and whenever the caller says a new
 * message was admitted (a receipt can arrive before the daemon has admitted the event it names).
 * Event-driven: a directory watch, not a poll.
 *
 * A receipt a pass carried out is remembered for the life of the watcher and not applied again; the
 * receipts still waiting for their message are looked at again each pass, against one read of the queue.
 */
export const watchChannelReceipts = (
  stateDir: string,
  roleKeyOf: (projectId: string) => string,
  deps: ChannelQueueDeps,
  onError: (error: unknown) => void = () => undefined,
  /** Told once per skipped line, never once per replay of the file. */
  onSkipped: (projectId: string, line: number) => void = () => undefined,
): ChannelReceiptWatcher => {
  const dir = channelDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let busy = false;
  let closed = false;
  let lastPassAt = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | null = null;
  const reported = new Set<string>();
  const settledByProject = new Map<string, Set<string>>();
  const apply = (): ChannelApplyResult[] => {
    if (busy) return [];
    busy = true;
    lastPassAt = Date.now();
    try {
      return readAllChannelReceipts(stateDir).map(({ projectId, receipts, skipped }) => {
        for (const line of skipped) {
          if (reported.has(`${projectId}:${line}`)) continue;
          reported.add(`${projectId}:${line}`);
          onSkipped(projectId, line);
        }
        const settled = settledByProject.get(projectId) ?? new Set<string>();
        const result = applyChannelReceipts(deps, roleKeyOf(projectId), receipts, settled);
        // Only receipts still in the file are remembered, so a trimmed file does not leave its old keys behind.
        const present = new Set(receipts.map(receiptKey));
        for (const key of settled) if (!present.has(key.split(ROW)[0]!)) settled.delete(key);
        settledByProject.set(projectId, settled);
        return result;
      });
    } catch (error) {
      onError(error);
      return [];
    } finally {
      busy = false;
    }
  };
  const request = (): void => {
    if (closed || timer !== null) return;
    const wait = lastPassAt + CHANNEL_RECEIPT_PASS_GAP_MS - Date.now();
    if (wait <= 0) {
      apply();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!closed) apply();
    }, wait);
    timer.unref();
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dir, { persistent: false }, request);
    watcher.on("error", onError);
  } catch (error) {
    onError(error);
  }
  apply();
  return {
    apply,
    request,
    close: () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      watcher?.close();
    },
  };
};
