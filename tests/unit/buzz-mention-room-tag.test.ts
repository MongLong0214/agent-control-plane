import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it } from "vitest";

import { BUZZ_MENTION_KIND, type BuzzMentionEvent, startBuzzMentionSubscriberFromStateDir } from "../../src/buzz/buzz-mention-subscriber.ts";
import { channelKey, movableRegistry, seamSink, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A mention is delivered only from the room its CTO answers in, as the registry stores it.
 *
 * Every frame below is handed to the subscriber's connection directly, past the relay's `#h`
 * filter, so the only thing that can refuse a wrong room is the subscriber's own check. The
 * identity subscribes in two rooms and its bound session answers in the first.
 */

const STORED_ROOM = "room-stored";
const OTHER_CONFIGURED_ROOM = "room-also-configured";
const FOREIGN_ROOM = "room-not-configured";
const ROLE_KEY = "PRIMARY_CTO:repo-factory";

const start = () => {
  const dir = tempDir("acp-room-tag-");
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [STORED_ROOM, OTHER_CONFIGURED_ROOM] }]);
  const registry = movableRegistry();
  registry.hold(cto.pubkey, { roleKey: ROLE_KEY, buzzActorId: cto.pubkey, bindingGeneration: 1, sessionId: "s1", room: STORED_ROOM });
  const relay = storingRelay();
  const clock = steppedClock();
  const sink = seamSink();
  const handle = startBuzzMentionSubscriberFromStateDir(dir, {
    registry,
    sink,
    openSocket: relay.factory,
    scheduler: clock.scheduler,
    reportAdmission: () => undefined,
  });
  let created = 1_800_000_000;
  const mention = (rooms: readonly string[]): BuzzMentionEvent =>
    finalizeEvent(
      {
        kind: BUZZ_MENTION_KIND,
        created_at: (created += 1),
        tags: [["p", cto.pubkey], ...rooms.map((room) => ["h", room])],
        content: `in ${rooms.join(",") || "no room"}`,
      },
      owner.secretKey,
    ) as BuzzMentionEvent;
  /** Straight onto the live connection's subscription: no relay filter stands in front of it. */
  const hand = async (event: BuzzMentionEvent): Promise<void> => {
    const connection = relay.openFor(cto.pubkey).at(-1)!;
    const [subId] = [...connection.subscriptions.keys()];
    connection.handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
    await relay.drain(handle);
  };
  const reconnect = async (): Promise<unknown> => {
    const connection = relay.openFor(cto.pubkey).at(-1)!;
    connection.closed = true;
    connection.handlers.onClose();
    clock.fireAll();
    await relay.drain(handle);
    return relay.requested.at(-1)!.filter["since"];
  };
  return { relay, sink, handle, mention, hand, reconnect };
};

it("delivers a mention from the stored room, and refuses one from any other room without consuming it or moving the window", async () => {
  const f = start();
  try {
    await f.relay.drain(f.handle);
    const delivered = f.mention([STORED_ROOM]);
    await f.hand(delivered);
    expect(f.sink.calls.map((call) => call.eventId)).toEqual([delivered.id]);
    const windowBefore = await f.reconnect();
    expect(windowBefore).toBe(delivered.created_at);

    const refused = [
      f.mention([OTHER_CONFIGURED_ROOM]),
      f.mention([FOREIGN_ROOM]),
      f.mention([STORED_ROOM, FOREIGN_ROOM]),
      f.mention([FOREIGN_ROOM, STORED_ROOM]),
      f.mention([]),
    ];
    for (const event of refused) await f.hand(event);

    // None reached the seam, so none was consumed or executed on anyone's behalf.
    expect(f.sink.calls.map((call) => call.eventId)).toEqual([delivered.id]);
    const rejections = f.handle.counters().rejections;
    expect(rejections["event-room-not-bound"]).toBe(2);
    expect(rejections["event-conversation-unusable"]).toBe(3);
    // The window is where the delivered event put it: a refusal moves nothing.
    expect(await f.reconnect()).toBe(windowBefore);
  } finally {
    f.handle.close();
  }
});
