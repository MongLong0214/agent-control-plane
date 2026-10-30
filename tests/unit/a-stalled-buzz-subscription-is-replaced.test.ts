import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  nativeRelaySocketFactory,
  type BuzzMentionEvent,
  type BuzzMentionLivenessSnapshot,
  type BuzzMentionStallReport,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createBuzzMessageIngress, ownerMessageLedger, startDaemonBuzzMentionSubscriber } from "../../src/daemon/agentcpd.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import type { MentionWakeContext, RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { channelKey, signedMention, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { startLocalWebSocketRelay } from "../helpers/local-websocket-relay.ts";

afterAll(cleanupTempDirs);

/**
 * #1283. The live daemon's mention subscriber held an ESTABLISHED connection per identity to a
 * healthy relay, and doctor was clean, while two CEO replies produced no ingress row, no role
 * message and no wake; a restart replayed both. Those three facts are the counterexample kept
 * here: none of them says a subscription is being answered.
 *
 * The relay is a real WebSocket server on a loopback TCP socket in this process, and the daemon's
 * own `nativeRelaySocketFactory` dials it through Node's `WebSocket`, so "the TCP connection stays
 * open" is a socket's state rather than a stub's flag. Everything downstream is the daemon's own
 * composition: the subscriber over its registry and sink, the Buzz admission seam, the outbox row
 * and the mention's wake. Only the role port's wake is a recorder, and the scheduler's timers are
 * fired by hand; its clock is the control plane's.
 *
 * `checkLiveness` is what the daemon's 30-second health tick calls. It is called optionally, so
 * the same rows run against a build without it: there nothing notices, and the missed mention is
 * never admitted.
 */

const SECRET = "buzz-stall-secret";
const PROJECT = "stall-project";
const ROOM = "room-stall";
const ROLE_KEY = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
const STALE = "BUZZ_MENTION_SUBSCRIBER_STALE";
const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One configured CTO identity: its project and room, and whether a live session holds its role. */
interface CtoSpec {
  readonly project: string;
  readonly room: string;
  readonly live: boolean;
}
const ONE_CTO: readonly CtoSpec[] = [{ project: PROJECT, room: ROOM, live: true }];

const start = async (ctos: readonly CtoSpec[] = ONE_CTO) => {
  const relay = await startLocalWebSocketRelay();
  const dir = tempDir("acp-stall-");
  chmodSync(dir, 0o700);
  const owner = channelKey(dir, "owner.key");
  const keys = ctos.map((_cto, index) => channelKey(dir, `cto-${index}.key`));
  const cto = keys[0]!;
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  ctos.forEach((spec, index) => {
    h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [spec.project, spec.project, h.cp.clock.nowIso()]);
    // Configured, with no session carrying its identity: excluded by design, as a paused CTO is.
    if (!spec.live) return;
    const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: spec.room });
    expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    expect(h.cp.sessions.bindBuzzActor(
      { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: keys[index]!.pubkey },
      { isAllowedActor: () => true },
    ).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: spec.project }).allowed).toBe(true);
  });
  writeSubscriberConfig(dir, ctos.map((spec, index) => ({ keyFile: keys[index]!.keyFile, rooms: [spec.room] })));
  const policy = { allowedActors: [owner.pubkey], secret: SECRET };

  // The wake a delivered mention causes, by the mention it names.
  const wakes: (string | null)[] = [];
  const seam = createBuzzMessageIngress(h.cp, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
    roleConversation: {
      wake: async (_roleKey: string, mention?: MentionWakeContext) => {
        wakes.push(mention?.eventId ?? null);
        return allow(ReasonCode.OK, undefined);
      },
    } as unknown as RoleConversationPort,
  });

  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const nowSeconds = (): number => Math.floor(h.clock.now().getTime() / 1000);
  const scheduler: BuzzSubscriberScheduler = {
    setTimer: (_ms, fire) => {
      const handle = nextTimer++;
      timers.set(handle, fire);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    nowSeconds,
  };
  // Mentions are signed after the binding, never in its second.
  h.clock.advance(1_000);
  const openedAt = nowSeconds();
  const stalls: BuzzMentionStallReport[] = [];
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, { seam }, {
    // The configured relay is a `wss` address; the socket dials the local server instead.
    openSocket: (_url, handlers) => nativeRelaySocketFactory(relay.url, handlers),
    scheduler,
    reportAdmission: () => undefined,
    reportStall: (report) => stalls.push(report),
  });

  /** Lets the sockets and the subscriber's frame queue run for a moment. */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 5; round += 1) {
      await pause(20);
      await subscriber.settled();
    }
  };
  const waitFor = async (what: string, holds: () => boolean, withinMs = 3_000): Promise<void> => {
    const deadline = Date.now() + withinMs;
    while (!holds()) {
      if (Date.now() > deadline) throw new Error(`${what}: did not happen within ${withinMs}ms`);
      await pause(20);
      await subscriber.settled();
    }
    await settle();
  };
  const liveCtos = ctos.filter((spec) => spec.live).length;
  await waitFor("the first subscriptions", () => relay.connections.filter((one) => one.requests.length === 1).length === liveCtos);

  const inboundFor = (eventId: string, roleKey = ROLE_KEY) =>
    h.cp.db.all<{ nonce: string }>(
      `SELECT nonce FROM inbound_messages WHERE channel = 'buzz'
        AND (nonce = ? OR nonce = ? OR json_extract(payload_json, '$.sourceEventId') = ?)`,
      [buzzMessageNonce(eventId), buzzMessageNonce(eventId, roleKey), eventId],
    );

  return {
    h,
    relay,
    subscriber,
    wakes,
    stalls,
    openedAt,
    owner,
    cto,
    keys,
    settle,
    waitFor,
    inboundFor,
    mention: (text: string, to = 0): BuzzMentionEvent =>
      signedMention({ author: owner.secretKey, addressedTo: keys[to]!.pubkey, room: ctos[to]!.room, createdAt: nowSeconds(), text }),
    /** The relay connections identity `index` authenticated on, oldest first. */
    connectionsOf: (index: number) => relay.connections.filter((one) => one.authenticatedAs === keys[index]!.pubkey),
    /** The role's holder claims its next owner message and completes it; returns its text. */
    completeNextOwnerMessage: (): string | null => {
      const binding = h.cp.bindings.active(ROLE_KEY)!;
      const holder = {
        roleKey: ROLE_KEY,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        sessionIncarnation: binding.sessionIncarnation,
      };
      const ledger = ownerMessageLedger(h.cp);
      const claimed = ledger.claim(holder);
      if (!claimed.allowed || claimed.value.claimed === null) return null;
      expect(ledger.complete(claimed.value.claimed.messageId, holder).allowed).toBe(true);
      return claimed.value.claimed.text;
    },
    ownerMessages: () =>
      h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE kind = ?`, [MessageKind.OWNER_MESSAGE])!.n,
    replaysOf: (nonce: string) =>
      h.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'INGRESS_REPLAY' AND reason_code = ?
          AND json_extract(evidence_json, '$.nonce') = ?`,
        [ReasonCode.INGRESS_REPLAY_IGNORED, nonce],
      )!.n,
    liveness: (): BuzzMentionLivenessSnapshot | undefined => subscriber.counters().liveness,
    /** One daemon health tick: thirty seconds pass and the liveness step runs. */
    tick: async (): Promise<void> => {
      h.clock.advance(30_000);
      (subscriber as { checkLiveness?: () => void }).checkLiveness?.();
      await settle();
    },
    /** The reconnect backoff, and any judgement timer, elapse. */
    fireTimers: (): void => {
      for (const [handle, fire] of [...timers]) {
        timers.delete(handle);
        fire();
      }
    },
    close: async () => {
      subscriber.close();
      await relay.close();
      h.cp.close();
    },
  };
};

/**
 * A daemon over the same control plane, reading the subscriber's counters exactly as `main()`
 * installs them, with its doctor and its `health.json`.
 */
const startDoctor = async (f: Awaited<ReturnType<typeof start>>) => {
  const stateDir = tempDir("acp-stall-daemon-");
  f.h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.h.cp, { stateDir });
  expect((await daemon.start()).allowed).toBe(true);
  daemon.setBuzzMentionReceipt({ configuredIdentities: f.subscriber.socketCount, counters: () => f.subscriber.counters() });
  let doctorRuns = 0;
  return {
    staleFindings: async () => {
      doctorRuns += 1;
      const response = await daemon.handleOperatorRequest(
        { requestId: `doctor-${doctorRuns}`, method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
        PEER,
      );
      expect(response.allowed).toBe(true);
      return (response as { value: { findings: Array<{ code: string; severity: string; observedEvidence: Record<string, unknown> }> } })
        .value.findings.filter((finding) => finding.code === STALE);
    },
    healthLiveness: () => {
      daemon.writeHealth(null);
      return (JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as { buzzMention: { liveness?: BuzzMentionLivenessSnapshot } })
        .buzzMention.liveness;
    },
    stop: () => daemon.stop(),
  };
};

describe("a Buzz subscription that stops being answered on an open connection (#1283)", () => {
  it("is replaced, and the mention it missed is admitted once, with a role message and a wake", async () => {
    const f = await start();
    try {
      const first = f.mention("첫 번째 답장");
      f.relay.publish(first);
      await f.waitFor("the first mention admitted", () => f.inboundFor(first.id).length === 1);
      expect(f.wakes).toEqual([first.id]);
      // The CTO takes it and finishes it, so its turn is settled: the replay below is a plain one.
      expect(f.completeNextOwnerMessage()).toBe("첫 번째 답장");

      // The relay's end of the connection stops answering and delivering. TCP stays open.
      const stalled = f.relay.connections[0]!;
      stalled.silent = true;
      f.h.clock.advance(5_000);
      const missed = f.mention("두 번째 답장");
      f.relay.publish(missed);
      await f.settle();
      expect(f.inboundFor(missed.id)).toHaveLength(0);

      // Three health ticks, past the 90-second bound, with the connection ESTABLISHED before each.
      for (let tick = 0; tick < 3; tick += 1) {
        expect(stalled.open).toBe(true);
        await f.tick();
      }
      f.fireTimers();
      await f.waitFor("the missed mention admitted", () => f.inboundFor(missed.id).length === 1);

      // A second connection, asking from the preserved window: the first mention's second.
      expect(f.relay.connections).toHaveLength(2);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: first.created_at });
      // Admitted exactly once, one role message each, one wake each.
      expect(f.inboundFor(missed.id)).toHaveLength(1);
      expect(f.ownerMessages()).toBe(2);
      expect(f.wakes).toEqual([first.id, missed.id]);
      // The window is inclusive, so the first mention came back with it, and the seam refused it as
      // a replay: still one ingress row, no second message, no second wake.
      const firstRows = f.inboundFor(first.id);
      expect(firstRows).toHaveLength(1);
      expect(f.replaysOf(firstRows[0]!.nonce)).toBe(1);
      expect(f.subscriber.counters().rejections["admission-already-durable"]).toBe(1);

      expect(f.stalls).toEqual([
        expect.objectContaining({ identity: "identities[0]", identityPubkey: f.cto.pubkey, roleKey: ROLE_KEY, cause: "UNANSWERED", boundSeconds: 90 }),
      ]);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "LIVE", stalls: 1, lastStall: { cause: "UNANSWERED" } });
      // And the role message is the one the holder's claim hands over.
      expect(f.completeNextOwnerMessage()).toBe("두 번째 답장");
    } finally {
      await f.close();
    }
  });

  it("is replaced when the relay still answers requests but stopped pushing to it", async () => {
    const f = await start();
    try {
      // Requests are still answered on this connection; only the live push to the open
      // subscription has stopped.
      f.relay.connections[0]!.noLivePush = true;
      f.h.clock.advance(2_000);
      const missed = f.mention("세 번째 답장");
      f.relay.publish(missed);
      await f.settle();
      expect(f.inboundFor(missed.id)).toHaveLength(0);

      await f.tick();
      await f.waitFor("the probe finding the missed mention", () => f.stalls.length === 1);
      f.fireTimers();
      await f.waitFor("the mention the live push dropped admitted", () => f.inboundFor(missed.id).length === 1);

      expect(f.relay.connections).toHaveLength(2);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      expect(f.inboundFor(missed.id)).toHaveLength(1);
      expect(f.ownerMessages()).toBe(1);
      expect(f.wakes).toEqual([missed.id]);
    } finally {
      await f.close();
    }
  });

  it("is not what a relay that keeps answering looks like: probed every tick, never replaced", async () => {
    const f = await start();
    try {
      const connection = f.relay.connections[0]!;
      for (let tick = 0; tick < 6; tick += 1) {
        await f.tick();
        await f.waitFor(`probe ${tick + 1} answered and closed`, () => connection.closes.length === tick + 1);
      }

      expect(f.relay.connections).toHaveLength(1);
      const probes = connection.requests.slice(1);
      expect(probes).toHaveLength(6);
      // The subscription's own two filters, from the window the connection opened at.
      expect(probes[0]!.filters).toEqual([
        { kinds: [9], "#p": [f.cto.pubkey], "#h": [ROOM], since: f.openedAt },
        { kinds: [9], authors: [f.owner.pubkey], "#h": [ROOM], since: f.openedAt },
      ]);
      // Each probe is closed once the relay ends it; the subscription itself stays open.
      expect(connection.closes).toEqual(probes.map((probe) => probe.id));
      expect([...connection.subscriptions.keys()]).toEqual([connection.requests[0]!.id]);
      expect(f.stalls).toEqual([]);
      expect(f.subscriber.counters().rejections).toEqual({});
      expect(f.liveness()).toMatchObject({ staleIdentities: 0, identities: [{ state: "LIVE", stalls: 0 }] });
    } finally {
      await f.close();
    }
  });

  it("is STALE in health and doctor while reconnecting cannot restore it, and not once the relay answers", async () => {
    const f = await start();
    const d = await startDoctor(f);
    try {
      expect(await d.staleFindings()).toEqual([]);

      // The relay answers nothing on this connection, nor on any it accepts from now on.
      f.relay.connections[0]!.silent = true;
      f.relay.silentForNewConnections = true;
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      f.fireTimers();
      await f.settle();
      for (let tick = 0; tick < 2; tick += 1) await f.tick();

      // Unanswered for 150 seconds, past the 90-second bound, with a replacement that answers nothing.
      expect(await d.staleFindings()).toEqual([
        expect.objectContaining({
          code: STALE,
          severity: "ERROR",
          observedEvidence: expect.objectContaining({
            boundSeconds: 90,
            staleIdentities: [expect.objectContaining({ identity: "identities[0]", roleKey: ROLE_KEY, unansweredForSeconds: 150, stalls: 1 })],
          }),
        }),
      ]);
      expect(d.healthLiveness()).toMatchObject({ staleIdentities: 1, identities: [{ state: "STALE", stalls: 1 }] });
      // The first connection was replaced; its replacement is the one nothing answers.
      expect(f.relay.connections).toHaveLength(2);

      // The relay answers again. The silent replacement is itself replaced, and the finding clears.
      f.relay.silentForNewConnections = false;
      await f.tick();
      f.fireTimers();
      await f.waitFor("an answered third connection", () => f.relay.connections[2]?.requests.length === 1);
      expect(await d.staleFindings()).toEqual([]);
      expect(d.healthLiveness()).toMatchObject({ staleIdentities: 0, identities: [{ state: "LIVE", stalls: 2 }] });
      // One outage, one report, however many connections it took.
      expect(f.stalls).toHaveLength(1);
    } finally {
      await d.stop();
      await f.close();
    }
  });

  it("is told apart from a CTO excluded for want of a live session, and from one that is delivering", async () => {
    // As the live daemon after its restart: PARTIAL, one identity excluded by design.
    const DELIVERING = 0;
    const STALLED = 1;
    const ctos: readonly CtoSpec[] = [
      { project: "delivering-project", room: "room-delivering", live: true },
      { project: "stalled-project", room: "room-stalled", live: true },
      { project: "paused-project", room: "room-paused", live: false },
    ];
    const deliveringRole = roleKeyFor(Role.PRIMARY_CTO, { projectId: ctos[DELIVERING]!.project });
    const stalledRole = roleKeyFor(Role.PRIMARY_CTO, { projectId: ctos[STALLED]!.project });
    const f = await start(ctos);
    const d = await startDoctor(f);
    try {
      expect(f.subscriber.admission()).toMatchObject({
        continuity: "PARTIAL",
        admittedIdentities: 2,
        identities: [{ state: "ADMITTED" }, { state: "ADMITTED" }, { state: "EXCLUDED", reason: "NO_LIVE_SESSION" }],
      });

      // Only the stalled identity's relay end goes quiet, and so does every connection it opens.
      f.connectionsOf(STALLED)[0]!.silent = true;
      f.relay.silentForNewConnections = true;
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      f.fireTimers();
      await f.settle();
      for (let tick = 0; tick < 2; tick += 1) await f.tick();

      // The delivering identity still delivers, on the connection it has had all along.
      f.h.clock.advance(1_000);
      const delivered = f.mention("배달되는 답장", DELIVERING);
      f.relay.publish(delivered);
      await f.waitFor("the delivering identity's mention admitted", () => f.inboundFor(delivered.id, deliveringRole).length === 1);
      expect(f.connectionsOf(DELIVERING)).toHaveLength(1);
      expect(f.wakes).toEqual([delivered.id]);

      // Health: three states, each with what it means.
      expect(d.healthLiveness()).toMatchObject({
        staleIdentities: 1,
        identities: [
          { identity: "identities[0]", state: "LIVE", roleKey: deliveringRole, exclusionReason: null, stalls: 0 },
          { identity: "identities[1]", state: "STALE", roleKey: stalledRole, exclusionReason: null, stalls: 1 },
          { identity: "identities[2]", state: "EXCLUDED", exclusionReason: "NO_LIVE_SESSION", unansweredForSeconds: null, stalls: 0 },
        ],
      });
      // Doctor: the stalled identity alone is the fault, beside the live one and the excluded one.
      expect(await d.staleFindings()).toEqual([
        expect.objectContaining({
          code: STALE,
          observedEvidence: expect.objectContaining({
            staleIdentities: [expect.objectContaining({ identity: "identities[1]", roleKey: stalledRole })],
            liveIdentities: 1,
            excludedIdentities: [{ identity: "identities[2]", reason: "NO_LIVE_SESSION" }],
          }),
        }),
      ]);
    } finally {
      await d.stop();
      await f.close();
    }
  });
});
