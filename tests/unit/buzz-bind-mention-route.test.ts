import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chmodSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it, vi } from "vitest";

import { BuzzAdapter, type BuzzSendReceipt, type BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { buzzMentionWakeGate, createBuzzMessageIngress, createCeoNotificationSender, createDaemonBuzzBindChallenges, createDaemonBuzzMentionSink, startDaemonBuzzMentionSubscriber } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { RoleConversationPort, ROLE_WAKE_FRAME, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { outboxDeliveryReadback } from "../../src/outbox/outbox.ts";
import type { DaemonNoticeTarget } from "../../src/runtime/acp-daemon-notice.ts";
import { adoptedFixture, DIGEST, GATEWAY, LIVE, TOKEN } from "../helpers/adopted-ceo.ts";
import { channelKey, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
const ROOM = "bind-mention-room";
const ROLE = "PRIMARY_CTO:bind-mention";

const start = async (options: { registerWake?: boolean } = {}) => {
  const f = adoptedFixture();
  const { cp } = f.h;
  const dir = tempDir("acp-bmr-");
  chmodSync(dir, 0o700);
  const ceo = channelKey(dir, "ceo.key");
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)", ["bind-mention", "bind-mention", cp.clock.nowIso()]);
  const session = cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  expect(cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: cto.pubkey }, { isAllowedActor: () => true }).allowed).toBe(true);
  expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "bind-mention", sessionId: session.sessionId }).allowed).toBe(true);
  const conversation = new RoleConversationPort(Role.PRIMARY_CTO, {
    currentCandidates: () => [cp.bindings.active(ROLE)!],
    active: (roleKey) => cp.bindings.active(roleKey),
  }, {
    endpointDir: dir,
    holderHasWork: () => cp.db.get("SELECT 1 FROM outbox WHERE role_key = ? AND status IN ('PENDING','SENT')", [ROLE]) !== undefined,
    onWakeWritten: ({ roleKey, cause }) => { cp.audit.record({ kind: "ROLE_WAKE_SENT", roleKey, evidence: { cause } }); },
  });
  const frames: string[] = [];
  const endpoint = createServer((socket) => {
    let frame = "";
    socket.on("data", (data: Buffer) => { frame += data.toString(); });
    socket.on("end", () => { frames.push(frame); socket.end(); });
  });
  const socketPath = join(dir, "wake.sock");
  await new Promise<void>((resolve) => endpoint.listen(socketPath, resolve));
  const server = new McpServer({ name: "bind-mention", version: "1" });
  vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
  conversation.attach(server, () => allow(ReasonCode.OK, { actor: session.sessionId, sessionId: session.sessionId, sessionIncarnation: session.incarnation }));
  const registerWake = () => conversation.registerEndpoint(server, socketPath);
  if (options.registerWake !== false) expect((await registerWake()).allowed).toBe(true);
  const policy = { secret: "bind-mention-secret", allowedActors: [ceo.pubkey, owner.pubkey] };
  const challenges = createDaemonBuzzBindChallenges(cp, policy);
  const seam = createBuzzMessageIngress(cp, policy, { ceoConversation: new CeoConversationPort(), ownerActors: [owner.pubkey], roleConversation: conversation });
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const relay = storingRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(cp, dir, policy, { seam }, { bindChallenges: challenges, openSocket: relay.factory, scheduler: steppedClock().scheduler });
  await relay.drain(subscriber);
  conversation.useMentionWakeGate(buzzMentionWakeGate(cp, () => subscriber));
  const admission = await f.admit();
  if (!admission.allowed) throw new Error(admission.message);
  const mint = (actor = ceo.pubkey) => {
    const result = challenges.mint(admission.value.runtime, actor);
    if (!result.allowed) throw new Error(result.message);
    return result.value.challenge;
  };
  const event = (content: string, author = ceo, mentioned = true) => finalizeEvent({ kind: 9, created_at: Math.floor(cp.clock.now().getTime() / 1000), tags: [...(mentioned ? [["p", cto.pubkey]] : []), ["h", ROOM]], content }, author.secretKey);
  const deliver = async (message: ReturnType<typeof event>) => { relay.publish(message); await relay.drain(subscriber); };
  const send = vi.fn(async (_room: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> => ({ eventId: `sent-${send.mock.calls.length}`, mentionPubkeys: [...recipients] }));
  const policyReadiness = vi.fn<NonNullable<BuzzTransport["policyReadiness"]>>(async (_room, _content, recipient, signer) =>
    ({ verdict: "allowed", policyDigest: "fixture-policy", signer, recipient }));
  const adapter = new BuzzAdapter(cp.db, cp.clock, cp.audit, cp.sessions, cp.bindings, cp.outbox, {
    available: async () => true, openChannel: async () => ROOM, send,
    signerReadiness: async () => ({ signer: "fixture-signer", registered: true }),
    localSendPolicyDigest: () => "fixture-policy",
    policyReadiness,
  });
  const notify = (key: string) => {
    const binding = cp.bindings.active("CEO")!;
    const result = cp.outbox.enqueue({ idempotencyKey: key, roleKey: "CEO", bindingGeneration: binding.bindingGeneration, targetSessionId: binding.sessionId, kind: MessageKind.CEO_NOTIFICATION, payload: { key } });
    if (!result.allowed) throw new Error(result.message);
    return result.value.messageId;
  };
  return { f, cp, ceo, owner, mint, event, deliver, frames, send, policyReadiness, adapter, notify, challenges, dir, conversation, registerWake,
    noStoreSink: createDaemonBuzzMentionSink(cp, policy, { seam }),
    sink: createDaemonBuzzMentionSink(cp, policy, { seam }, { bindChallenges: challenges }), cto,
    bound: () => cp.audit.byKind("SESSION_BUZZ_ACTOR_BOUND").filter((row) => row.sessionId === f.gatewaySessionId),
    stored: () => cp.db.all("SELECT * FROM buzz_events"),
    peer: () => cp.db.all("SELECT * FROM outbox WHERE kind = 'PEER_MESSAGE'"),
    close: async () => { subscriber.close(); await server.close(); await new Promise<void>((resolve) => endpoint.close(() => resolve())); cp.close(); },
  };
};

it("binds, stores and delivers the same signed challenge + mention once, with no duplicate wake on replay", async () => {
  const f = await start();
  try {
    const message = f.event(`${f.mint()}\n@cto-repo-factory implement the bounded slice`);
    await f.deliver(message);
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.bound()).toHaveLength(1);
    expect(f.cp.sessions.require(f.f.gatewaySessionId)).toMatchObject({ buzzActorId: f.ceo.pubkey, buzzAddress: ROOM });
    expect(f.cp.audit.byKind("SESSION_BUZZ_ADDRESS_CHANGED").filter((row) => row.sessionId === f.f.gatewaySessionId)).toHaveLength(1);
    expect(f.stored()).toHaveLength(1);
    expect(f.peer()).toHaveLength(1);
    expect(f.frames).toEqual([ROLE_WAKE_FRAME]);
    expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(1);
    expect(f.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(1);
    await f.deliver(message);
    expect(f.bound()).toHaveLength(1);
    expect(f.stored()).toHaveLength(1);
    expect(f.peer()).toHaveLength(1);
    expect(f.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(1);
    expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.frames).toEqual([ROLE_WAKE_FRAME]);
  } finally { await f.close(); }
});

it.each(["valid", "invalid", "plain"] as const)("replayed %s owner mentions create exactly one wake and recipient row, including concurrent replays", async (shape) => {
  const f = await start();
  try {
    const token = shape === "valid" ? f.mint(f.owner.pubkey) : shape === "invalid" ? `acp-buzz-bind:${"0".repeat(32)}` : "";
    const event = f.event(`${token}\n@cto-repo-factory owner work`, f.owner);
    await f.deliver(event);
    await vi.waitFor(() => expect(f.frames).toEqual([ROLE_WAKE_FRAME]));
    await Promise.all([f.deliver(event), f.deliver(event)]);
    await f.deliver(event);
    expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(1);
    expect(f.bound()).toHaveLength(shape === "valid" ? 1 : 0);
    expect(f.stored()).toHaveLength(1);
    expect(f.cp.db.all("SELECT * FROM outbox WHERE kind = 'OWNER_MESSAGE'")).toHaveLength(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.frames).toEqual([ROLE_WAKE_FRAME]);
  } finally { await f.close(); }
});

for (const outcome of ["succeeded", "failed"] as const) {
  it.each(["room", "current binding", "generation", "signature", "signed time"] as const)(`mention admission rechecks %s after the bind ${outcome}`, async (boundary) => {
    const f = await start();
    try {
      const token = outcome === "succeeded" ? f.mint(f.owner.pubkey) : `acp-buzz-bind:${"0".repeat(32)}`;
      const signed = f.event(`${token}\n@cto-repo-factory authority check`, f.owner);
      const event = boundary === "signed time" ? finalizeEvent({
        kind: signed.kind, tags: signed.tags, content: signed.content, created_at: signed.created_at - 5,
      }, f.owner.secretKey) : { ...signed, tags: signed.tags.map((tag) => [...tag]) };
      const binding = f.cp.bindings.active(ROLE)!;
      const settle = f.challenges.settle.bind(f.challenges);
      vi.spyOn(f.challenges, "settle").mockImplementation((answer) => {
        const decision = settle(answer);
        expect(decision?.allowed).toBe(outcome === "succeeded");
        // The bind decision must never stand in for the subsequent admission checks.
        if (boundary === "room") f.cp.sessions.setBuzzAddress(binding.sessionId, "another-room");
        if (boundary === "current binding" || boundary === "generation") {
          expect(f.cp.bindings.revoke(ROLE, "fixture authority change").allowed).toBe(true);
          if (boundary === "generation") expect(f.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "bind-mention", sessionId: binding.sessionId }).allowed).toBe(true);
        }
        if (boundary === "signature") event.sig = "0".repeat(128);
        return decision;
      });
      const verdict = await f.sink.admit({ event, identityPubkey: f.cto.pubkey, roleKey: ROLE, conversation: ROOM, receipt: null,
        binding: { bindingGeneration: binding.bindingGeneration, sessionId: binding.sessionId } });
      expect(verdict).toEqual(boundary === "signature" ? { admission: "REFUSED", reasonCode: ReasonCode.INGRESS_SIGNATURE_INVALID }
        : boundary === "signed time" ? { admission: "PRECEDES_BINDING" } : "RETRY");
      expect(f.bound()).toHaveLength(outcome === "succeeded" ? 1 : 0);
      expect(f.stored()).toHaveLength(0);
      expect(f.cp.db.all("SELECT * FROM outbox WHERE kind IN ('PEER_MESSAGE','OWNER_MESSAGE')")).toHaveLength(0);
      expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(0);
      expect(f.frames).toHaveLength(0);
    } finally { await f.close(); }
  });
}

const pendingVisible = async (f: Awaited<ReturnType<typeof start>>, ids: string[]) => {
  const expected = ids.map((messageId) => expect.objectContaining({ messageId, status: "PENDING", delivered: false, completed: false }));
  expect(f.cp.outbox.deliveryReadback()).toMatchObject({ pendingCeoNotifications: expect.arrayContaining(expected) });
  const report = await f.cp.doctor.run("system");
  expect(report.findings.find((finding) => finding.code === "CEO_NOTIFICATION_PENDING")).toMatchObject({
    observedEvidence: { pending: expect.arrayContaining(expected) },
  });
  const daemon = new Daemon(f.cp, { stateDir: f.dir });
  daemon.writeHealth(null);
  expect(JSON.parse(readFileSync(join(f.dir, "health.json"), "utf8")).outbox).toMatchObject({ pendingCeoNotifications: expect.arrayContaining(expected) });
};

const noPendingVisible = async (f: Awaited<ReturnType<typeof start>>) => {
  expect(f.cp.outbox.deliveryReadback()).toMatchObject({ pendingCeoNotifications: [] });
  expect((await f.cp.doctor.run("system")).findings.some((finding) => finding.code === "CEO_NOTIFICATION_PENDING")).toBe(false);
  new Daemon(f.cp, { stateDir: f.dir }).writeHealth(null);
  expect(JSON.parse(readFileSync(join(f.dir, "health.json"), "utf8")).outbox).toMatchObject({ pendingCeoNotifications: [] });
};

it.each(["unknown", "malformed", "wrong author", "no store"])("a %s challenge never grants or blocks an independently authorized owner mention", async (shape) => {
  const f = await start();
  try {
    const token = shape === "wrong author" ? f.mint() : shape === "malformed" ? "acp-buzz-bind:broken" : `acp-buzz-bind:${"0".repeat(32)}`;
    const message = f.event(`${token}\n@cto-repo-factory carry out these instructions`, f.owner);
    if (shape === "no store") {
      // Same real ingress, with no challenge store: token presence cannot change admission.
      const request = { event: message, identityPubkey: f.cto.pubkey, roleKey: ROLE, conversation: ROOM, receipt: null };
      const wake = vi.spyOn(f.conversation, "wake");
      await f.noStoreSink.admit(request);
      await f.noStoreSink.admit(request);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(await wake.mock.results[0]?.value).toMatchObject({ allowed: true });
    } else { await f.deliver(message); await f.deliver(message); }
    expect(f.bound()).toHaveLength(0);
    expect(f.cp.sessions.require(f.f.gatewaySessionId)).toMatchObject({ buzzActorId: null, buzzAddress: null });
    expect(f.stored()).toHaveLength(1);
    expect(f.cp.db.all("SELECT * FROM outbox WHERE kind = 'OWNER_MESSAGE'")).toHaveLength(1);
    await vi.waitFor(() => expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(1));
  } finally { await f.close(); }
});

it("a refused wake stays durable and late endpoint registration drains it once without replay wakes", async () => {
  const f = await start({ registerWake: false });
  try {
    const wake = vi.spyOn(f.conversation, "wake");
    const event = f.event("@cto-repo-factory offline work", f.owner);
    await f.deliver(event);
    await f.deliver(event);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(f.frames).toHaveLength(0);
    const rows = f.cp.db.all<{ message_id: string }>("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'");
    expect(rows).toHaveLength(1);
    expect((await f.registerWake()).allowed).toBe(true);
    await vi.waitFor(() => expect(f.frames).toEqual([ROLE_WAKE_FRAME]));
    expect(f.cp.outbox.get(rows[0]!.message_id)?.status).toBe("PENDING");
    expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(1);
    await f.deliver(event);
    expect(wake).toHaveBeenCalledTimes(2); // one refused delivery wake, one registration drain
    expect(f.cp.audit.byKind("ROLE_WAKE_SENT")).toHaveLength(1);
  } finally { await f.close(); }
});

it("a failed challenge does not authorize an unbound CEO's mention", async () => {
  const f = await start();
  try {
    await f.deliver(f.event(`acp-buzz-bind:${"0".repeat(32)}\n@cto-repo-factory unauthorized`));
    expect(f.bound()).toHaveLength(0);
    expect(f.peer()).toHaveLength(0);
    expect(f.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(0);
  } finally { await f.close(); }
});

it("a binding writer exception cannot swallow an independently authorized mention or retry the binding", async () => {
  const f = await start();
  try {
    const admission = await f.f.admit();
    if (!admission.allowed) throw new Error(admission.message);
    const challenge = f.challenges.mint(admission.value.runtime, f.owner.pubkey);
    if (!challenge.allowed) throw new Error(challenge.message);
    const bind = vi.spyOn(f.cp.sessions, "bindBuzzActor").mockImplementation(() => { throw new Error("fixture writer failed"); });
    const event = f.event(`${challenge.value.challenge}\n@cto-repo-factory owner instructions`, f.owner);
    await f.deliver(event);
    await f.deliver(event);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(f.bound()).toHaveLength(0);
    expect(f.stored()).toHaveLength(1);
    expect(f.cp.db.all("SELECT * FROM outbox WHERE kind = 'OWNER_MESSAGE'")).toHaveLength(1);
    expect(f.cp.audit.byKind("ROLE_WAKE_SENT").length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

it("a challenge without a mention keeps its existing subscriber refusal and grants nothing", async () => {
  const f = await start();
  try {
    await f.deliver(f.event(f.mint(), f.ceo, false));
    expect(f.bound()).toHaveLength(0);
    expect(f.stored()).toHaveLength(0);
    expect(f.peer()).toHaveLength(0);
    expect(f.frames).toHaveLength(0);
  } finally { await f.close(); }
});

it("a binding-only event submitted to the sink keeps its binding outcome without storing a message", async () => {
  const f = await start();
  try {
    const event = f.event(f.mint(), f.ceo, false);
    await f.sink.admit({ event, identityPubkey: f.cto.pubkey, roleKey: ROLE, conversation: ROOM, receipt: null });
    expect(f.bound()).toHaveLength(1);
    expect(f.stored()).toHaveLength(0);
    expect(f.peer()).toHaveLength(0);
    expect(f.frames).toHaveLength(0);
  } finally { await f.close(); }
});

it("an address-audit failure rolls back both binding and address; the spent proof cannot bind on replay", async () => {
  const f = await start();
  try {
    const event = f.event(f.mint());
    const record = f.cp.audit.record.bind(f.cp.audit);
    f.cp.audit.record = (entry) => {
      if (entry.kind === "SESSION_BUZZ_ADDRESS_CHANGED") throw new Error("fixture address audit failed");
      return record(entry);
    };
    expect(() => f.challenges.settle(event)).toThrow("fixture address audit failed");
    expect(f.cp.sessions.require(f.f.gatewaySessionId)).toMatchObject({ buzzActorId: null, buzzAddress: null });
    expect(f.bound()).toHaveLength(0);
    f.cp.audit.record = record;
    expect(f.challenges.settle(event)).toMatchObject({ allowed: false });
    expect(f.bound()).toHaveLength(0);
  } finally { await f.close(); }
});

it("a fresh signed bind restores the same CEO runtime's room and the real sweep sends all 12 pending ids once", async () => {
  const f = await start();
  try {
    // The live shape: this exact adopted runtime already holds its key, but has no room.
    const admitted = await f.f.admit();
    if (!admitted.allowed) throw new Error(admitted.message);
    expect(f.cp.sessions.bindBuzzActor({ admitted: admitted.value.runtime, buzzActorId: f.ceo.pubkey }, { isAllowedActor: () => true }).allowed).toBe(true);
    const bound = f.bound().length;
    const ids = Array.from({ length: 12 }, (_, n) => f.notify(`pending-${n}`));
    for (let n = 0; n < 3; n++) {
      await f.cp.outbox.deliverCeoNotifications();
      expect(await f.adapter.deliverPending()).toEqual({ delivered: [], failed: [] });
    }
    for (const id of ids) expect(f.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 0, targetSessionId: f.f.gatewaySessionId });
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE")).toHaveLength(12);
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_DELIVERY_FAILED")).toHaveLength(0);
    await pendingVisible(f, ids);
    const answer = f.event(`${f.mint()}\n@cto-repo-factory route restored`);
    await f.deliver(answer);
    await f.deliver(answer);
    expect(f.cp.sessions.require(f.f.gatewaySessionId)).toMatchObject({ buzzAddress: ROOM, buzzActorId: f.ceo.pubkey });
    expect(f.bound()).toHaveLength(bound);
    expect(f.cp.audit.byKind("SESSION_BUZZ_ADDRESS_CHANGED").filter((row) => row.sessionId === f.f.gatewaySessionId)).toEqual([expect.objectContaining({ evidence: { from: null, to: ROOM } })]);
    expect((await f.adapter.deliverPending()).delivered).toEqual(ids);
    expect(f.send).toHaveBeenCalledTimes(12);
    expect(f.policyReadiness).toHaveBeenCalledTimes(12);
    for (const id of ids) {
      expect(f.policyReadiness).toHaveBeenCalledWith(ROOM, expect.stringContaining(id), f.ceo.pubkey, "fixture-signer");
      expect(f.send).toHaveBeenCalledWith(ROOM, expect.stringContaining(id), [f.ceo.pubkey]);
      expect(f.cp.outbox.get(id)).toMatchObject({ status: "SENT", attempts: 1 });
      expect(f.cp.db.get("SELECT acked_at FROM outbox WHERE message_id = ?", [id])).toEqual({ acked_at: null });
    }
    expect((await f.adapter.deliverPending()).delivered).toEqual([]);
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE")).toHaveLength(12);
    await noPendingVisible(f);
  } finally { await f.close(); }
});

it("canonical target resolution withholding does not count or audit a send attempt on every sweep", async () => {
  const f = await start();
  try {
    const resolveTarget = vi.fn(async (): Promise<DaemonNoticeTarget | null> => null);
    f.cp.outbox.attachCeoNotificationDelivery(createCeoNotificationSender(resolveTarget, "fixture-secret"));
    const id = f.notify("canonical-unavailable");
    for (let n = 0; n < 4; n++) await f.cp.outbox.deliverCeoNotifications();
    expect(resolveTarget).toHaveBeenCalled();
    expect(f.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE")).toHaveLength(1);
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE")[0]).toMatchObject({
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
      evidence: { messageId: id, targetSessionId: f.f.gatewaySessionId, reason: "CANONICAL_TARGET_UNAVAILABLE" },
    });
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_DELIVERY_FAILED")).toHaveLength(0);
    await pendingVisible(f, [id]);
    const sent: string[] = [];
    const target: DaemonNoticeTarget = {
      destination: { session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN },
      send: async (body) => {
        sent.push(body.text);
        return { kind: "RESPONDED", status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
          receipt: { status: "completed", receipt_id: "fixture-receipt", session_id: LIVE, lineage_root_digest: DIGEST } } };
      },
    };
    resolveTarget.mockResolvedValue(target);
    await f.cp.outbox.deliverCeoNotifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(id);
    expect(f.cp.outbox.get(id)).toMatchObject({ status: "ACKED", attempts: 1 });
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE")).toHaveLength(1);
    await noPendingVisible(f);
    // A real transport failure still counts as an attempt.
    resolveTarget.mockResolvedValue(null);
    const failedId = f.notify("canonical-transport-failure");
    await f.cp.outbox.deliverCeoNotifications();
    f.cp.outbox.attachCeoNotificationDelivery(async () => deny(ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED, "transport refused"));
    await f.cp.outbox.deliverCeoNotifications();
    expect(f.cp.outbox.get(failedId)?.attempts).toBeGreaterThan(0);
    expect(f.cp.audit.byKind("CEO_NOTIFICATION_DELIVERY_FAILED").length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

it("restoring the same signed room after a Buzz timeout preserves the unknown outcome and never resends that id", async () => {
  const f = await start();
  try {
    await f.deliver(f.event(`${f.mint()}\n@cto-repo-factory bind`));
    const id = f.notify("unknown-outcome");
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    expect((await f.adapter.deliverPending()).failed).toEqual([id]);
    expect(f.policyReadiness).toHaveBeenCalledExactlyOnceWith(ROOM, expect.stringContaining(id), f.ceo.pubkey, "fixture-signer");
    // With explicit readiness this follows the existing PENDING/unknown branch, not the legacy
    // unchecked transport's SENT branch. Neither state proves delivery or permits a resend.
    expect(f.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 1, failureClass: "unknown_observed" });
    expect(outboxDeliveryReadback(f.cp.outbox.get(id)!)).toMatchObject({ status: "OUTCOME_UNKNOWN",
      delivered: false, completed: false, automaticResendHeld: true });
    f.cp.sessions.setBuzzAddress(f.f.gatewaySessionId, null);
    await f.deliver(f.event(`${f.mint()}\n@cto-repo-factory restore`));
    expect(f.cp.sessions.require(f.f.gatewaySessionId).buzzAddress).toBe(ROOM);
    f.f.h.clock.advance(60 * 60_000);
    expect((await f.adapter.deliverPending()).delivered).toEqual([]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.cp.db.get("SELECT status, failure_class FROM outbox WHERE message_id = ?", [id])).toEqual({ status: "PENDING", failure_class: "unknown_observed" });
  } finally { await f.close(); }
});

it.each(["refused", "undeterminable"] as const)("a restored signed room still enforces a %s policy verdict", async verdict => {
  const f = await start();
  try {
    await f.deliver(f.event(`${f.mint()}\n@cto-repo-factory restore`));
    const id = f.notify(`policy-${verdict}`);
    f.policyReadiness.mockResolvedValue({ verdict, cause: "POLICY", policyDigest: "fixture-policy", signer: "fixture-signer", recipient: f.ceo.pubkey });
    expect((await f.adapter.deliverPending()).delivered).toEqual([]);
    expect(f.policyReadiness).toHaveBeenCalledExactlyOnceWith(ROOM, expect.stringContaining(id), f.ceo.pubkey, "fixture-signer");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.cp.outbox.get(id)).toMatchObject({ status: "PENDING" });
    expect(f.cp.db.all("SELECT * FROM outbox_sent_destinations WHERE message_id = ?", [id])).toEqual([]);
  } finally { await f.close(); }
});
