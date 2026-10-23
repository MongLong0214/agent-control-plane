import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createConfiguredHermesGatewayDaemonNoticeTarget } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { adoptedFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-03 — every supported CEO configuration keeps an authenticated route for its notifications.
 * A READY CEO with a bound Buzz identity and address keeps the Buzz route without any Hermes
 * configuration; an adopted Hermes CEO uses the canonical notice transport; a notification is
 * withheld (PENDING, never REJECTED) only while no route exists, and binding a routable CEO
 * establishes the route.
 */

const recordingTransport = () => {
  const send = vi.fn(async (_channel: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> =>
    ({ eventId: `evt-${send.mock.calls.length}`, mentionPubkeys: [...recipients] }));
  const transport: BuzzTransport = { openChannel: async (purpose) => `channel:${purpose}`, available: async () => true, send };
  return { transport, send };
};

type Harness = ReturnType<typeof makeHarness>;

const readyCeo = (h: Harness, route: { room: string; identity: string } | null) => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "ceo", buzzAddress: route?.room ?? null });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "ready").allowed).toBe(true);
  if (route) {
    expect(h.cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: route.identity },
      { isAllowedActor: () => true }).allowed).toBe(true);
  }
  return session;
};

const notify = (h: Harness, key: string) => {
  const binding = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const queued = h.cp.outbox.enqueue({ idempotencyKey: key, roleKey: "CEO", bindingGeneration: binding.bindingGeneration,
    targetSessionId: binding.sessionId, kind: MessageKind.CEO_NOTIFICATION, payload: { question: "decision required", key } });
  if (!queued.allowed) throw new Error(queued.message);
  return queued.value.messageId;
};

const statusOf = (h: Harness, messageId: string) => h.cp.outbox.get(messageId)?.status;

it("delivers a Buzz-backed CEO's notification over its existing Buzz route with no Hermes configuration, past its TTL", async () => {
  const { transport, send } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  try {
    const ceo = readyCeo(h, { room: "ceo-room", identity: "ceo-key" });
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
    expect(createConfiguredHermesGatewayDaemonNoticeTarget(h.cp, {})).toBeUndefined();
    const first = notify(h, "buzz-route");
    const delivered = await h.buzzAdapter.deliverPending();
    expect(delivered.delivered).toContain(first);
    expect(send).toHaveBeenCalledWith("ceo-room", expect.stringContaining(first), ["ceo-key"]);
    expect(statusOf(h, first)).toBe("SENT");

    // A delivery TTL does not dispose of a notification that has a route.
    const late = notify(h, "buzz-route-late");
    h.clock.advance(31 * 60_000);
    expect(h.cp.outbox.expireOverdue()).toBe(0);
    expect((await h.buzzAdapter.deliverPending()).delivered).toContain(late);
  } finally { h.cp.close(); }
});

it("withholds a notification as PENDING while no route exists, and the binding of a routable CEO establishes the route", async () => {
  const { transport, send } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  try {
    const unroutable = readyCeo(h, null);
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: unroutable.sessionId }).allowed).toBe(true);
    const messageId = notify(h, "no-route-yet");
    expect((await h.buzzAdapter.deliverPending())).toEqual({ delivered: [], failed: [] });
    h.clock.advance(31 * 60_000);
    h.cp.outbox.expireOverdue();
    h.cp.outbox.fenceUndeliverable();
    expect(statusOf(h, messageId)).toBe("PENDING");
    expect(send).not.toHaveBeenCalled();

    // The CEO is bound again on a runtime with a Buzz route: the notification follows the role.
    expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "the CEO runtime moves").allowed).toBe(true);
    expect(h.cp.sessions.transition(unroutable.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
    expect(statusOf(h, messageId)).toBe("PENDING");
    const routable = readyCeo(h, { room: "ceo-room", identity: "ceo-key" });
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: routable.sessionId }).allowed).toBe(true);
    const delivered = await h.buzzAdapter.deliverPending();
    expect(delivered.delivered).toEqual([messageId]);
    expect(h.cp.outbox.get(messageId)).toMatchObject({ status: "SENT", targetSessionId: routable.sessionId });
  } finally { h.cp.close(); }
});

it("routes an adopted Hermes CEO's notification only over the canonical transport, and withholds it until that transport exists", async () => {
  const f = adoptedFixture();
  try {
    const cp = f.h.cp;
    // Even with a Buzz route on the adopted runtime, the canonical transport is its route once attached.
    cp.db.run("UPDATE sessions SET buzz_address = 'ceo-room', buzz_actor_id = 'ceo-key' WHERE session_id = ?", [f.gatewaySessionId]);
    const messageId = notify(f.h, "adopted-canonical");
    const sent: string[] = [];
    cp.outbox.attachCeoNotificationDelivery(async (message) => { sent.push(message.messageId); return allow(ReasonCode.OK, undefined); });
    await cp.outbox.deliverCeoNotifications();
    expect(sent).toEqual([messageId]);
    expect(statusOf(f.h, messageId)).toBe("ACKED");
    const second = notify(f.h, "adopted-canonical-2");
    expect(cp.outbox.claimDeliverable()).toEqual([]);
    await cp.outbox.deliverCeoNotifications();
    expect(statusOf(f.h, second)).toBe("ACKED");
  } finally { f.h.cp.close(); }
});
