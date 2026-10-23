import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it } from "vitest";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { createBuzzMessageIngress, buzzMentionInputFor, createCeoNotificationSender,
  createConfiguredHermesGatewayDaemonNoticeTarget, ownerMessageLedger } from "../../src/daemon/agentcpd.ts";
import { buzzMessageSigningRequest, deliverBuzzMessage } from "../../src/ingress/buzz-message.ts";
import { ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { channelKey } from "../helpers/buzz-mention-relay.ts";
import { adoptedFixture, DIGEST, LIVE, GATEWAY, TOKEN, LSTART } from "../helpers/adopted-ceo.ts";

afterAll(cleanupTempDirs);
const SECRET = "no-loss-test-secret";
const ROOM = "shared-cto-room";
const ready = (h: ReturnType<typeof makeHarness>, projectId: string, actor: string) => {
  if (!h.cp.projects.get(projectId)) h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)", [projectId, projectId, h.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "test", buzzAddress: ROOM });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  expect(h.cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: actor },
    { isAllowedActor: () => true }).allowed).toBe(true);
  return session;
};
const holder = (h: ReturnType<typeof makeHarness>, roleKey: string) => {
  const binding = h.cp.bindings.active(roleKey)!;
  return { roleKey, bindingGeneration: binding.bindingGeneration, targetSessionId: binding.sessionId,
    sessionIncarnation: binding.sessionIncarnation };
};

it("#4 stores one signed room broadcast and independently delivers, dedupes, claims and ACKs both intended recipients", async () => {
  const dir = tempDir("acp-fanout-");
  const owner = channelKey(dir, "owner");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  try {
    const keys = [channelKey(dir, "cto-a"), channelKey(dir, "cto-b")];
    const roles = keys.map((key, index) => {
      const projectId = `broadcast-${index}`;
      const session = ready(h, projectId, key.pubkey);
      const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      return bound.value.roleKey;
    });
    const seam = createBuzzMessageIngress(h.cp, { allowedActors: [owner.pubkey], secret: SECRET }, {
      ownerActors: [owner.pubkey], ceoConversation: new CeoConversationPort(),
    });
    seam.port.wakeRole = async () => allow(ReasonCode.OK, undefined);
    h.clock.advance(1000);
    const event = finalizeEvent({ kind: 9, content: "both CTOs must receive this", tags: [["h", ROOM]],
      created_at: Math.floor(h.clock.now().getTime() / 1000) }, owner.secretKey);
    const inputs = keys.map((key, index) => buzzMentionInputFor(seam.ingress, SECRET, {
      roleKey: roles[index]!, identityPubkey: key.pubkey, conversation: ROOM, event, receipt: null,
    }));
    for (const input of inputs) expect((await deliverBuzzMessage(seam.ingress, seam.port, input)).allowed).toBe(true);
    const rows = h.cp.db.all<{ message_id: string }>("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'");
    expect(rows).toHaveLength(2);
    for (const input of inputs) await deliverBuzzMessage(seam.ingress, seam.port, input);
    expect(h.cp.db.all("SELECT * FROM outbox")).toHaveLength(2);
    expect(h.cp.db.all("SELECT * FROM buzz_events")).toHaveLength(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'buzz'")).toHaveLength(2);
    expect(JSON.stringify(h.cp.db.all("SELECT payload_json FROM inbound_messages"))).not.toContain(event.content);
    const ledger = ownerMessageLedger(h.cp);
    const ids: string[] = [];
    for (const role of roles) {
      const claimed = ledger.claim(holder(h, role));
      if (!claimed.allowed) throw new Error(claimed.message);
      expect(claimed.value.claimed?.text).toBe(event.content);
      ids.push(claimed.value.claimed!.messageId);
      expect(ledger.complete(ids.at(-1)!, holder(h, role)).allowed).toBe(true);
    }
    expect(new Set(ids).size).toBe(2);
    for (const role of roles) expect(ledger.claim(holder(h, role))).toMatchObject({ allowed: true, value: { claimed: null } });
  } finally { h.cp.close(); }
});

it("#5 admits offline mail against the stable role floor and retains the same ID through repeated takeovers and crash-before-ACK", async () => {
  const h = makeHarness();
  try {
    const projectId = "mail-role";
    const first = ready(h, projectId, "cto-old");
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: first.sessionId }).allowed).toBe(true);
    h.clock.advance(1000);
    const createdAt = Math.floor(h.clock.now().getTime() / 1000);
    const seam = createBuzzMessageIngress(h.cp, { allowedActors: ["owner"], secret: SECRET }, {
      ownerActors: ["owner"], ceoConversation: new CeoConversationPort(),
    });
    seam.port.wakeRole = async () => allow(ReasonCode.OK, undefined);
    const takeover = (n: number) => {
      h.clock.advance(10000);
      const next = ready(h, projectId, `cto-${n}`);
      const result = h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId, sessionId: next.sessionId,
        reason: "holder restart", conversation: "REPLACED", takeover: true });
      if (!result.allowed) throw new Error(result.message);
      return next;
    };
    const next = takeover(2);
    const input = { actor: "owner", conversation: ROOM, eventId: "offline-unread", addressedTo: "CTO", mention: "cto-2",
      text: "never discard unread mail", createdAt };
    const admitted = await deliverBuzzMessage(seam.ingress, seam.port,
      { ...input, signature: ingressSignature(SECRET, buzzMessageSigningRequest(input)) });
    expect(admitted.allowed).toBe(true);
    if (!admitted.allowed) throw new Error(admitted.message);
    const id = admitted.value.turnRequestId;
    takeover(3); takeover(4);
    expect(h.cp.outbox.get(id)).toMatchObject({ status: "PENDING", targetSessionId: holder(h, roleKey).targetSessionId });
    const ledger = ownerMessageLedger(h.cp);
    const claimed = ledger.claim(holder(h, roleKey));
    expect(claimed).toMatchObject({ allowed: true, value: { claimed: { messageId: id, text: input.text } } });
    takeover(5); // Receiver crashed after getting the bytes, before its ACK.
    expect(ledger.claim(holder(h, roleKey))).toMatchObject({ allowed: true, value: { claimed: { messageId: id, text: input.text } } });
    expect(ledger.complete(id, { roleKey, bindingGeneration: 2, targetSessionId: next.sessionId, sessionIncarnation: next.incarnation }).allowed).toBe(false);
    expect(ledger.complete(id, holder(h, roleKey)).allowed).toBe(true);
    expect(ledger.claim(holder(h, roleKey))).toMatchObject({ allowed: true, value: { claimed: null } });
  } finally { h.cp.close(); }
});

it("#6 retains a refused wake and retries delivery on replay without duplicating the message", async () => {
  const h = makeHarness();
  try {
    const session = ready(h, "wake-replay", "cto");
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "wake-replay", sessionId: session.sessionId }).allowed).toBe(true);
    const seam = createBuzzMessageIngress(h.cp, { allowedActors: ["owner"], secret: SECRET }, {
      ownerActors: ["owner"], ceoConversation: new CeoConversationPort(),
    });
    let attempts = 0;
    seam.port.wakeRole = async () => ++attempts === 1 ? deny(ReasonCode.ROLE_PEER_FAILED, "proxy forward failed") : allow(ReasonCode.OK, undefined);
    const input = { actor: "owner", conversation: ROOM, eventId: "retry-wake", addressedTo: "CTO", mention: "cto", text: "work" };
    const signed = { ...input, signature: ingressSignature(SECRET, buzzMessageSigningRequest(input)) };
    const one = await deliverBuzzMessage(seam.ingress, seam.port, signed);
    expect(one).toMatchObject({ allowed: true, evidence: { wake: ReasonCode.ROLE_PEER_FAILED } });
    const two = await deliverBuzzMessage(seam.ingress, seam.port, signed);
    expect(two).toMatchObject({ allowed: true, evidence: { wake: ReasonCode.OK } });
    expect(attempts).toBe(2);
    expect(h.cp.db.all("SELECT * FROM outbox")).toHaveLength(1);
  } finally { h.cp.close(); }
});

it("#1 delivers adopted CEO notifications over the pinned canonical surface and retains failures until a matching completed receipt", async () => {
  const f = adoptedFixture();
  try {
    const cp = f.h.cp;
    expect(cp.sessions.get(f.gatewaySessionId)?.buzzAddress).toBeNull();
    const config = { ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
      ACP_HERMES_PROFILE: "test", ACP_HERMES_HOME: "/opt/test/home", ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test",
      ACP_HERMES_GATEWAY_API_KEY: "test-key" };
    let accepted = false;
    const eventIds: string[] = [];
    const parts = new Map<string, string>();
    const target = createConfiguredHermesGatewayDaemonNoticeTarget(cp, config, {
      authorityHeld: () => true, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
      identityReader: () => async () => ({ session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN }),
      noticeSenderFactory: () => async (body) => {
        eventIds.push(body.event_id);
        expect(body.text.length).toBeLessThanOrEqual(2000);
        parts.set(body.event_id, body.text.replace(/^ACP notification .*? part \d+\/\d+: /, ""));
        return { kind: "RESPONDED", status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
          receipt: { status: accepted ? "completed" : "failed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST } } };
      },
    })!;
    const binding = cp.bindings.active("CEO")!;
    const result = cp.outbox.enqueue({ idempotencyKey: "ceo-notice", roleKey: "CEO", bindingGeneration: binding.bindingGeneration,
      targetSessionId: binding.sessionId, kind: MessageKind.CEO_NOTIFICATION, payload: { notification: "ESCALATION", text: "decision required" } });
    if (!result.allowed) throw new Error(result.message);
    if (typeof createCeoNotificationSender === "function") {
      cp.outbox.attachCeoNotificationDelivery(createCeoNotificationSender(target, "lane-secret"));
    } else {
      await f.h.buzzAdapter.deliverPending();
    }
    await cp.outbox.deliverCeoNotifications?.();
    expect(cp.outbox.get(result.value.messageId)?.status).toBe("PENDING");
    f.h.clock.advance(31 * 60_000);
    cp.outbox.expireOverdue();
    expect(cp.outbox.claimDeliverable()).toEqual([]);
    expect(cp.outbox.get(result.value.messageId)?.status).toBe("PENDING");
    accepted = true;
    await cp.outbox.deliverCeoNotifications();
    expect(cp.outbox.get(result.value.messageId)?.status).toBe("ACKED");
    expect(new Set(eventIds).size).toBe(1);
    parts.clear();
    const unicodePayload = { text: "📨".repeat(4000) };
    const unicode = cp.outbox.enqueue({ idempotencyKey: "unicode-ceo-notice", roleKey: "CEO", bindingGeneration: binding.bindingGeneration,
      targetSessionId: binding.sessionId, kind: MessageKind.CEO_NOTIFICATION, payload: unicodePayload });
    if (!unicode.allowed) throw new Error(unicode.message);
    await cp.outbox.deliverCeoNotifications();
    expect(cp.outbox.get(unicode.value.messageId)?.status).toBe("ACKED");
    expect(JSON.parse([...parts.values()].join(""))).toEqual({ messageId: unicode.value.messageId,
      kind: MessageKind.CEO_NOTIFICATION, payload: unicodePayload });
  } finally { f.h.cp.close(); }
});
