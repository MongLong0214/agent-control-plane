import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

import {
  BuzzChannelRelay,
  PARENT_LOOKUP_TIMEOUT_MS,
  type ChannelScheduler,
  type ChannelState,
  type ChannelStateStore,
} from "../../src/buzz/buzz-channel.ts";
import type { BuzzRelaySocketFactory } from "../../src/buzz/buzz-mention-subscriber.ts";

/**
 * A reply the relay refuses is a reply nobody answers. The relay does not take a reply on faith: it reads the NIP-10 markers
 * of the event it is given, finds the parent, and when that parent is itself a reply it requires the root the reply names to
 * be the thread's real root (buzz-relay `resolve_nip10_thread_meta`: "root tag does not match thread ancestry"). A reply
 * marker alone says "the thing I answer is the thread's root", which is false for any answer to a reply.
 *
 * `RelayModel` is that rule, ported line for line, plus the relay's timestamp, `h` and author gates and its `ids` lookup.
 * Each case is a way the channel threaded a reply that the real relay refuses.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM = "22222222-2222-4222-8222-222222222222";
const RELAY = "wss://relay.example.test";
const NOW = 2_000;

const cto = generateSecretKey();
const ctoPub = getPublicKey(cto);
const ceo = generateSecretKey();
const ceoPub = getPublicKey(ceo);
const owner = generateSecretKey();
const ownerPub = getPublicKey(owner);

type Signed = ReturnType<typeof finalizeEvent>;
const sign = (key: Uint8Array, tags: string[][], content: string, createdAt: number): Signed =>
  finalizeEvent({ kind: 9, created_at: createdAt, tags, content }, key);

// ---- the relay -----------------------------------------------------------------------------------------------------

const isEventId = (value: string | undefined): value is string => typeof value === "string" && /^[0-9a-fA-F]{64}$/u.test(value);

/** `parse_thread_markers_from_parts`: only an `e` tag with a marker and a 64-hex id counts; the last valid one of each wins. */
const markersOf = (tags: readonly (readonly string[])[]): { root?: string; reply?: string } => {
  const markers: { root?: string; reply?: string } = {};
  for (const tag of tags) {
    if (tag.length >= 4 && tag[0] === "e" && isEventId(tag[1])) {
      if (tag[3] === "root") markers.root = tag[1];
      else if (tag[3] === "reply") markers.reply = tag[1];
    }
  }
  return markers;
};

/** `ThreadMarkers::resolve`: root + reply -> both; reply alone -> the target is the root; anything else is top-level. */
const resolveMarkers = (m: { root?: string; reply?: string }): [root: string, parent: string] | null =>
  m.root !== undefined && m.reply !== undefined ? [m.root, m.reply] : m.reply !== undefined ? [m.reply, m.reply] : null;

interface StoredEvent {
  readonly event: Signed;
  readonly room: string;
  /** `thread_metadata.root_event_id`: set for an event that is itself a reply. */
  readonly threadRoot: string | null;
}

class RelayModel {
  readonly stored = new Map<string, StoredEvent>();
  readonly accepted: Signed[] = [];
  /** What an `ids` lookup answers. Default: the stored event, as the relay does. */
  answer: (id: string, room: string) => Signed[] = (id, room) => {
    const found = this.stored.get(id);
    return found !== undefined && found.room === room ? [found.event] : [];
  };
  /** A refusal text to give instead of the rule's own, to see how one is carried. */
  refuseEverythingWith: string | null = null;
  silentOnLookups = false;

  seed(event: Signed): void {
    const verdict = this.judge(event, event.pubkey);
    if (verdict !== null) throw new Error(`the model's own seed was refused: ${verdict}`);
    this.store(event);
  }

  private store(event: Signed): void {
    const room = event.tags.find((t) => t[0] === "h")?.[1] ?? "";
    const resolved = resolveMarkers(markersOf(event.tags));
    this.stored.set(event.id, { event, room, threadRoot: resolved === null ? null : this.rootFor(event, resolved) });
  }

  private rootFor(_event: Signed, resolved: [string, string]): string {
    return resolved[0];
  }

  /** `null` when the relay accepts `event` from `authed`, else the text of its refusal. */
  judge(event: Signed, authed: string): string | null {
    if (Math.abs(event.created_at - NOW) > 900) return "invalid: event timestamp too far from server time";
    const rooms = event.tags.filter((t) => t[0] === "h");
    if (rooms.length === 0) return "invalid: channel-scoped events must include an h tag";
    const room = rooms[0]![1]!;
    if (event.pubkey !== authed) return "invalid: event pubkey does not match authenticated identity";
    const resolved = resolveMarkers(markersOf(event.tags));
    if (resolved === null) return null;
    const [clientRoot, parentId] = resolved;
    const parent = this.stored.get(parentId);
    if (parent === undefined || parent.room !== room) return "invalid: reply parent not found";
    if (parent.threadRoot !== null) {
      // The parent is itself a reply: the thread's root is the one its metadata names.
      if (clientRoot !== parent.threadRoot) return "invalid: root tag does not match thread ancestry";
    } else {
      const own = resolveMarkers(markersOf(parent.event.tags));
      const parentRoot = own === null ? parentId : own[0];
      if (clientRoot !== parentRoot) return "invalid: root tag does not match thread ancestry";
    }
    return null;
  }

  accept(event: Signed, authed: string): { ok: boolean; message: string } {
    const refusal = this.refuseEverythingWith ?? this.judge(event, authed);
    if (refusal !== null) return { ok: false, message: refusal };
    this.store(event);
    this.accepted.push(event);
    return { ok: true, message: "" };
  }
}

// ---- the channel under it ------------------------------------------------------------------------------------------

const scheduler = (): ChannelScheduler & { advance(ms: number): void } => {
  let ms = NOW * 1000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn, delay) => {
      const id = next++;
      timers.set(id, { at: ms + delay, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    nowSeconds: () => Math.floor(ms / 1000),
    advance(by: number) {
      const target = ms + by;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        ms = Math.max(ms, due[1].at);
        due[1].fn();
      }
      ms = target;
    },
  };
};

const harness = async (options: { relayModel: RelayModel; state?: ChannelState }) => {
  const sent: unknown[][] = [];
  const saved: ChannelState[] = [];
  const clock = scheduler();
  let push: (frame: unknown[]) => void = () => undefined;
  const openSocket: BuzzRelaySocketFactory = (_url, handlers) => {
    push = (frame) => handlers.onFrame(JSON.stringify(frame));
    return {
      send: (raw) => {
        const frame = JSON.parse(raw) as unknown[];
        sent.push(frame);
        if (frame[0] === "EVENT") {
          const event = frame[1] as Signed;
          const verdict = options.relayModel.accept(event, ctoPub);
          push(["OK", event.id, verdict.ok, verdict.message]);
        } else if (frame[0] === "REQ" && !options.relayModel.silentOnLookups) {
          const filter = frame[2] as { ids?: string[]; "#h"?: string[] };
          if (Array.isArray(filter.ids)) {
            for (const id of filter.ids) for (const event of options.relayModel.answer(id, filter["#h"]?.[0] ?? "")) push(["EVENT", frame[1], event]);
            push(["EOSE", frame[1]]);
          }
        }
      },
      close: () => undefined,
    };
  };
  const store: ChannelStateStore = { load: () => options.state ?? null, save: (s) => saved.push(s) };
  const relay = new BuzzChannelRelay({
    relayUrl: RELAY,
    projectId: "demo",
    secretKey: cto,
    rooms: [ROOM],
    ceoPubkeys: () => [ceoPub],
    ownerPubkeys: [ownerPub],
    onNotification: async () => undefined,
    openSocket,
    scheduler: clock,
    store,
  });
  relay.start();
  push(["AUTH", "challenge-1"]);
  await relay.settled();
  const auth = sent.find((f) => f[0] === "AUTH") as [string, { id: string }];
  push(["OK", auth[1].id, true, ""]);
  await relay.settled();
  const deliver = async (event: unknown) => {
    push(["EVENT", "acp-channel-" + ctoPub.slice(0, 12), event]);
    await relay.settled();
  };
  const lookups = () => sent.filter((f) => f[0] === "REQ" && Array.isArray((f[2] as { ids?: unknown }).ids));
  return { relay, sent, saved, clock, deliver, lookups, push };
};

/** The live thread: a root, the CTO's own CLI answer to it, and the CEO's answer to that, which the channel delivers. */
const liveThread = () => {
  const model = new RelayModel();
  const root = sign(ceo, [["h", ROOM], ["p", ctoPub]], "the question that started the thread", 1_970);
  model.seed(root);
  const ctoPost = sign(cto, [["h", ROOM], ["e", root.id, "", "reply"], ["p", ceoPub]], "the CTO's own CLI post", 1_980);
  model.seed(ctoPost);
  const ceoAnswer = sign(
    ceo,
    [["h", ROOM], ["e", root.id, "", "root"], ["e", ctoPost.id, "", "reply"], ["p", ctoPub]],
    "수신 확인을 부탁합니다.",
    1_990,
  );
  model.seed(ceoAnswer);
  return { model, root, ctoPost, ceoAnswer };
};

// ---- cases ----------------------------------------------------------------------------------------------------------

describe("a reply carries the thread markers the relay requires", () => {
  it("answers a reply with the thread's root and the parent, though the channel never saw the rest of the thread", async () => {
    const { model, root, ceoAnswer } = liveThread();
    const h = await harness({ relayModel: model });
    await h.deliver(ceoAnswer);

    const pending = h.relay.reply({ room: ROOM, eventId: ceoAnswer.id, kind: "report", text: "@ceo 수신 확인." });
    // The root is known from the event's own tags, so nothing is asked of the relay and the event goes out at once.
    const published = h.sent.find((f) => f[0] === "EVENT") as [string, Signed];
    expect(published[1].tags).toEqual([
      ["h", ROOM],
      ["e", root.id, "", "root"],
      ["e", ceoAnswer.id, "", "reply"],
      ["p", ceoPub],
      ["acp-kind", "report"],
    ]);
    expect(verifyEvent(published[1])).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, eventId: published[1].id, ack: "ACCEPTED" });
    expect(h.lookups()).toEqual([]);
  });

  it("answers a message that starts a thread with the reply marker alone", async () => {
    const model = new RelayModel();
    const asked = sign(ceo, [["h", ROOM], ["p", ctoPub]], "status?", 1_990);
    model.seed(asked);
    const h = await harness({ relayModel: model });
    await h.deliver(asked);

    const pending = h.relay.reply({ room: ROOM, eventId: asked.id, kind: "report", text: "green on main" });
    const published = h.sent.find((f) => f[0] === "EVENT") as [string, Signed];
    expect(published[1].tags).toEqual([["h", ROOM], ["e", asked.id, "", "reply"], ["p", ceoPub], ["acp-kind", "report"]]);
    await expect(pending).resolves.toMatchObject({ ok: true, ack: "ACCEPTED" });
  });

  it("keeps threading right down a conversation: the CEO answers the CTO's reply, and the CTO answers that", async () => {
    const { model, root, ceoAnswer } = liveThread();
    const h = await harness({ relayModel: model });
    await h.deliver(ceoAnswer);
    const first = await h.relay.reply({ room: ROOM, eventId: ceoAnswer.id, kind: "report", text: "first answer" });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;

    const next = sign(ceo, [["h", ROOM], ["e", root.id, "", "root"], ["e", first.eventId, "", "reply"], ["p", ctoPub]], "and then?", 1_995);
    model.seed(next);
    await h.deliver(next);
    const second = h.relay.reply({ room: ROOM, eventId: next.id, kind: "report", text: "second answer" });
    const published = h.sent.filter((f) => f[0] === "EVENT").at(-1) as [string, Signed];
    expect(published[1].tags.filter((t) => t[0] === "e")).toEqual([["e", root.id, "", "root"], ["e", next.id, "", "reply"]]);
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("asks the relay for the parent when the root it remembers was guessed by an earlier version, and then threads right", async () => {
    const { model, root, ceoAnswer } = liveThread();
    // The saved state an earlier channel wrote: it never saw the CTO's own post, so it took the answer for its own root.
    const state: ChannelState = { cursor: 1_990, failed: [], events: [[ceoAnswer.id, 1_990, ceoPub, ROOM, ceoAnswer.id, true]] };
    const h = await harness({ relayModel: model, state });

    const result = await h.relay.reply({ room: ROOM, eventId: ceoAnswer.id, kind: "report", text: "@ceo 수신 확인." });
    expect(result).toMatchObject({ ok: true, ack: "ACCEPTED" });
    // One lookup, by id and in the room, closed once answered, and sent before the reply.
    expect(h.lookups()).toHaveLength(1);
    const lookup = h.lookups()[0]!;
    expect(lookup[2]).toMatchObject({ ids: [ceoAnswer.id], "#h": [ROOM], limit: 1 });
    expect(h.sent.some((f) => f[0] === "CLOSE" && f[1] === lookup[1])).toBe(true);
    expect(h.sent.indexOf(lookup)).toBeLessThan(h.sent.findIndex((f) => f[0] === "EVENT"));
    expect(model.accepted.at(-1)!.tags.filter((t) => t[0] === "e")).toEqual([["e", root.id, "", "root"], ["e", ceoAnswer.id, "", "reply"]]);
    // What was learned is kept, so the next reply to it asks nothing.
    expect(h.saved.at(-1)!.events.find((e) => e[0] === ceoAnswer.id)![4]).toBe(root.id);
    await h.relay.reply({ room: ROOM, eventId: ceoAnswer.id, kind: "report", text: "once more" });
    expect(h.lookups()).toHaveLength(1);
  });
});

/**
 * A lone `root` marker never anchors a reply: with no `reply` marker the relay reads the event as top-level, so the thread
 * that event starts has its own id as root, whatever its `root` tag names (`ThreadMarkers::resolve`, buzz-core nip10.rs).
 */
describe("an event that carries only a root marker starts its own thread", () => {
  const loneRoot = () => {
    const model = new RelayModel();
    const named = sign(ceo, [["h", ROOM], ["p", ctoPub]], "the thread a stray root marker names", 1_970);
    model.seed(named);
    const lone = sign(ceo, [["h", ROOM], ["e", named.id, "", "root"], ["p", ctoPub]], "a message whose only marker is a root", 1_990);
    model.seed(lone);
    return { model, named, lone };
  };

  it("is answered with the reply marker alone when it is delivered here, even though the channel knows the root it names", async () => {
    const { model, named, lone } = loneRoot();
    const h = await harness({ relayModel: model });
    await h.deliver(named);
    await h.deliver(lone);

    const pending = h.relay.reply({ room: ROOM, eventId: lone.id, kind: "report", text: "acknowledged" });
    const published = h.sent.filter((f) => f[0] === "EVENT").at(-1) as [string, Signed];
    expect(published[1].tags).toEqual([["h", ROOM], ["e", lone.id, "", "reply"], ["p", ceoPub], ["acp-kind", "report"]]);
    await expect(pending).resolves.toMatchObject({ ok: true, ack: "ACCEPTED" });
  });

  it("is answered with the reply marker alone when it is restored from a saved state and the relay is asked for it", async () => {
    const { model, lone } = loneRoot();
    const state: ChannelState = { cursor: 1_990, failed: [], events: [[lone.id, 1_990, ceoPub, ROOM, lone.id, true]] };
    const h = await harness({ relayModel: model, state });

    const result = await h.relay.reply({ room: ROOM, eventId: lone.id, kind: "report", text: "acknowledged" });
    expect(result).toMatchObject({ ok: true, ack: "ACCEPTED" });
    expect(h.lookups()).toHaveLength(1);
    expect(model.accepted.at(-1)!.tags.filter((t) => t[0] === "e")).toEqual([["e", lone.id, "", "reply"]]);
    expect(h.saved.at(-1)!.events.find((e) => e[0] === lone.id)![4]).toBe(lone.id);
  });
});

describe("the relay's own words reach the session", () => {
  it("says why the relay refused: the relay's text, on one bounded line", async () => {
    const { model, ceoAnswer } = liveThread();
    // A relay that cannot answer the lookup: the channel sends the root it remembers, which here is the guessed one.
    model.silentOnLookups = true;
    const state: ChannelState = { cursor: 1_990, failed: [], events: [[ceoAnswer.id, 1_990, ceoPub, ROOM, ceoAnswer.id, true]] };
    const h = await harness({ relayModel: model, state });

    const pending = h.relay.reply({ room: ROOM, eventId: ceoAnswer.id, kind: "report", text: "@ceo 수신 확인." });
    await h.relay.settled();
    h.clock.advance(PARENT_LOOKUP_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "the relay did not accept the reply (REFUSED): invalid: root tag does not match thread ancestry",
    });
  });

  it("bounds what a relay can say: control characters become spaces and a long text is cut", async () => {
    const model = new RelayModel();
    const asked = sign(ceo, [["h", ROOM], ["p", ctoPub]], "status?", 1_990);
    model.seed(asked);
    const h = await harness({ relayModel: model });
    await h.deliver(asked);
    model.refuseEverythingWith = `blocked: first line\nsecond line\u0007 ${"x".repeat(600)}`;

    const result = await h.relay.reply({ room: ROOM, eventId: asked.id, kind: "report", text: "hello" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^the relay did not accept the reply \(REFUSED\): blocked: first line second line /u);
    expect(result.reason).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(result.reason.length).toBeLessThan(300);
  });
});

describe("what the relay says about a parent is believed only when it is the parent", () => {
  const legacy = (ceoAnswer: Signed): ChannelState => ({ cursor: 1_990, failed: [], events: [[ceoAnswer.id, 1_990, ceoPub, ROOM, ceoAnswer.id, true]] });

  it.each([
    ["another event than the one asked for", (_a: Signed, other: Signed) => [other]],
    ["the right event with its signature broken", (a: Signed) => [{ ...a, sig: "00".repeat(64) }]],
    ["the right event with its text changed after signing", (a: Signed) => [{ ...a, content: "tampered" }]],
    ["an event written in another room", () => [sign(ceo, [["h", OTHER_ROOM], ["e", "ab".repeat(32), "", "root"], ["e", "cd".repeat(32), "", "reply"]], "x", 1_990)]],
  ])("ignores %s", async (_name, make) => {
    const { model, ceoAnswer, root } = liveThread();
    model.answer = () => make(ceoAnswer, root);
    const h = await harness({ relayModel: model, state: legacy(ceoAnswer) });
    const result = await h.relay.reply({ room: ROOM, eventId: ceoAnswer.id, kind: "report", text: "@ceo 수신 확인." });
    // Nothing of it was used: the root stayed the remembered, wrong one, and the relay said so.
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("root tag does not match thread ancestry") });
  });

  it("still answers when an event nobody here received is asked about", async () => {
    const { model } = liveThread();
    const h = await harness({ relayModel: model });
    await expect(h.relay.reply({ room: ROOM, eventId: "ef".repeat(32), kind: "report", text: "x" })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not received/u),
    });
    expect(h.lookups()).toEqual([]);
  });
});
