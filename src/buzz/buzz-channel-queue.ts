import { existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { verifyEvent } from "nostr-tools/pure";

import type { Decision } from "../core/errors.ts";
import { buzzMessageEventId, ownerMessagePointerOf } from "../ingress/buzz-message.ts";
import type { HolderIdentity } from "../outbox/outbox.ts";
import type { ChannelReceipt } from "./buzz-channel.ts";
import { isChannelReceipt, replyToOf } from "./buzz-channel.ts";
import { BUZZ_CHANNEL_RECEIPT_SUFFIX, channelDir, readChannelReceipts } from "./buzz-channel-files.ts";

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
 *   - `replied`: the CTO's reply was posted. The row is completed only when the reply is a signed
 *     kind-9 by the identity this session is bound to as its Buzz actor, in the room the message came
 *     from, answering that message's own event.
 *
 * A receipt is a claim by a file anyone running as this user can append to, so none of it is trusted
 * for what it says about itself: the message is found from the daemon's own rows, the reply's
 * signature and tags are checked here, and a receipt that matches no pending message changes nothing.
 * Nothing is lost by ignoring one: the message stays `PENDING` and the doctor names it.
 */

export interface ChannelQueueMessage {
  readonly messageId: string;
  readonly status: "PENDING" | "SENT";
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

export const applyChannelReceipts = (
  deps: ChannelQueueDeps,
  roleKey: string,
  receipts: readonly unknown[],
): ChannelApplyResult => {
  const result: ChannelApplyResult = { delivered: [], completed: [], ignored: 0, invalid: 0 };
  for (const receipt of receipts) {
    // One receipt that is not a receipt, or that the queue cannot make sense of, never stops the others.
    if (!isChannelReceipt(receipt)) {
      result.invalid += 1;
      continue;
    }
    try {
      applyOne(deps, roleKey, receipt, result);
    } catch {
      result.invalid += 1;
    }
  }
  return result;
};

const applyOne = (deps: ChannelQueueDeps, roleKey: string, receipt: ChannelReceipt, result: ChannelApplyResult): void => {
  const eventId = receipt.type === "emitted" ? receipt.eventId : receipt.parentEventId;
  const message = deps.messages(roleKey).find((m) => m.eventId === eventId);
  if (message === undefined || message.room === null || message.room !== receipt.room) {
    result.ignored += 1;
    return;
  }
  if (receipt.type === "replied") {
    const event = receipt.event;
    const actor = deps.boundActor(message.holder);
    const rooms = event.tags.filter((tag) => tag[0] === "h").map((tag) => tag[1]);
    if (
      actor === null ||
      event.pubkey !== actor ||
      event.kind !== 9 ||
      // A fresh seven-field copy: `verifyEvent` caches its verdict on the object it is given, and a
      // spread of an already-verified event carries that verdict over a body that was changed after.
      !verifyEvent({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
        sig: event.sig,
      }) ||
      rooms.length !== 1 ||
      rooms[0] !== message.room ||
      replyToOf(event) !== message.eventId ||
      (receipt.ack !== "ACCEPTED" && receipt.ack !== "DUPLICATE")
    ) {
      result.ignored += 1;
      return;
    }
  }
  let current = message;
  if (current.status === "PENDING") {
    if (!deps.deliver(current).allowed) {
      result.ignored += 1;
      return;
    }
    result.delivered.push(current.messageId);
    current = { ...current, status: "SENT" };
  }
  if (receipt.type === "replied" && current.status === "SENT") {
    if (deps.complete(current).allowed) result.completed.push(current.messageId);
    else result.ignored += 1;
  }
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

export const channelQueueMessages = (db: ChannelQueueDatabase, incarnationOf: (sessionId: string) => string | null) =>
  (roleKey: string): ChannelQueueMessage[] =>
    db
      .all<{ message_id: string; status: "PENDING" | "SENT"; role_key: string; binding_generation: number; target_session_id: string; payload_json: string }>(
        `SELECT message_id, status, role_key, binding_generation, target_session_id, payload_json FROM outbox
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
        const source = db.get<{ payload_json: string | null }>(
          "SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?",
          [pointer.sourceChannel, pointer.sourceNonce],
        );
        let room: string | null = null;
        try {
          const envelope = source?.payload_json ? (JSON.parse(source.payload_json) as { conversation?: unknown }) : null;
          room = typeof envelope?.conversation === "string" ? envelope.conversation : null;
        } catch {
          room = null;
        }
        return [{
          messageId: row.message_id,
          status: row.status,
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

export interface ChannelReceiptWatcher {
  /** Applies every receipt on disk now; safe to call at any time and as often as wanted. */
  apply(): ChannelApplyResult[];
  close(): void;
}

/**
 * Applies receipts when a receipt file changes, once at start, and whenever the caller says a new
 * message was admitted (a receipt can arrive before the daemon has admitted the event it names).
 * Event-driven: a directory watch, not a poll.
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
  const reported = new Set<string>();
  const apply = (): ChannelApplyResult[] => {
    if (busy) return [];
    busy = true;
    try {
      return readAllChannelReceipts(stateDir).map(({ projectId, receipts, skipped }) => {
        for (const line of skipped) {
          if (reported.has(`${projectId}:${line}`)) continue;
          reported.add(`${projectId}:${line}`);
          onSkipped(projectId, line);
        }
        return applyChannelReceipts(deps, roleKeyOf(projectId), receipts);
      });
    } catch (error) {
      onError(error);
      return [];
    } finally {
      busy = false;
    }
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dir, { persistent: false }, () => void apply());
    watcher.on("error", onError);
  } catch (error) {
    onError(error);
  }
  apply();
  return { apply, close: () => watcher?.close() };
};
