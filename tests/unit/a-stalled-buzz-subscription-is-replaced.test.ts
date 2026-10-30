import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS,
  LIVENESS_PROBE_PAGE_LIMIT,
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

/** A live CEO binding, so a notification has someone to be addressed to. */
const bindCeo = (h: ReturnType<typeof makeHarness>): void => {
  const ceo = h.cp.sessions.create({ provider: "scripted", model: "ceo" });
  expect(h.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
};

const start = async (ctos: readonly CtoSpec[] = ONE_CTO, options: { readonly ceo?: boolean } = {}) => {
  const relay = await startLocalWebSocketRelay();
  const dir = tempDir("acp-stall-");
  chmodSync(dir, 0o700);
  const owner = channelKey(dir, "owner.key");
  const keys = ctos.map((_cto, index) => channelKey(dir, `cto-${index}.key`));
  const cto = keys[0]!;
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  if (options.ceo === true) bindCeo(h);
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
  const startSubscriber = () => startDaemonBuzzMentionSubscriber(h.cp, dir, policy, { seam }, {
    // The configured relay is a `wss` address; the socket dials the local server instead.
    openSocket: (_url, handlers) => nativeRelaySocketFactory(relay.url, handlers),
    scheduler,
    reportAdmission: () => undefined,
    reportStall: (report) => stalls.push(report),
  });
  // Replaced by `restart`: a new subscriber over the same control plane, with nothing in memory.
  let subscriber = startSubscriber();

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
    get subscriber() {
      return subscriber;
    },
    /**
     * The daemon restarts: this subscriber is closed, `downForMs` passes, and a new one starts over
     * the same control plane and database, holding nothing the old one kept in memory.
     */
    restart: async (downForMs = 0): Promise<void> => {
      subscriber.close();
      timers.clear();
      h.clock.advance(downForMs);
      const before = relay.connections.length;
      subscriber = startSubscriber();
      await waitFor("the restarted subscription", () => relay.connections.slice(before).filter((one) => one.requests.length >= 1).length === liveCtos);
    },
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
    /** Every CEO notification row, oldest first, with the run it names. */
    ceoNotices: () =>
      h.cp.db
        .all<{ run_id: string | null; payload_json: string }>(
          `SELECT run_id, payload_json FROM outbox WHERE kind = ? ORDER BY created_at, rowid`,
          [MessageKind.CEO_NOTIFICATION],
        )
        .map((row) => ({ runId: row.run_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> })),
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
      // The replacement's own EOSE is not the end of the outage; the next probe coming back clean is.
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", outageSinceSeconds: f.stalls[0]!.outageSinceSeconds });
      await f.tick();
      // Its head check, then its sweep's page, both answered and clean.
      await f.waitFor("a clean probe on the replacement", () => f.relay.connections[1]!.closes.length === 2);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "LIVE", stalls: 1, lastStall: { cause: "UNANSWERED" }, outageSinceSeconds: null });
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
        // Each tick's head check, and the sweep's page that follows it.
        await f.waitFor(`probe ${tick + 1} answered and closed`, () => connection.closes.length === 2 * (tick + 1));
      }

      expect(f.relay.connections).toHaveLength(1);
      const probes = connection.requests.slice(1);
      expect(probes).toHaveLength(12);
      // The subscription's own two filters, from the probe's floor: the window its first backlog's
      // durable answers left, here nothing at all. One page each, bounded by the page limit.
      expect(probes[0]!.filters).toEqual([
        { kinds: [9], "#p": [f.cto.pubkey], "#h": [ROOM], since: 0, limit: LIVENESS_PROBE_PAGE_LIMIT },
        { kinds: [9], authors: [f.owner.pubkey], "#h": [ROOM], since: 0, limit: LIVENESS_PROBE_PAGE_LIMIT },
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
      // Answered is not yet delivering: the outage ends when a probe on it comes back clean.
      expect(d.healthLiveness()).toMatchObject({ staleIdentities: 1, identities: [{ state: "STALE", stalls: 2 }] });
      await f.tick();
      await f.waitFor("a clean probe on the third connection", () => f.relay.connections[2]!.closes.length === 2);
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

/**
 * The review of the liveness probe above (#1283, lane-n-fs). Each row is a way the probe could still
 * leave a mention undelivered while health said LIVE, or leave an outage with nobody told.
 */
describe("a stalled Buzz subscription's recovery, under the probe's review (#1283)", () => {
  it("asks again from a skipped mention even after a newer one was delivered", async () => {
    const f = await start();
    try {
      // The live push skips A; B, signed later, arrives and is admitted, so the window moves to B.
      const skipped = f.mention("건너뛴 답장");
      f.relay.publish(skipped, { push: false });
      f.h.clock.advance(5_000);
      const newer = f.mention("나중 답장");
      f.relay.publish(newer);
      await f.waitFor("the newer mention admitted", () => f.inboundFor(newer.id).length === 1);
      expect(f.inboundFor(skipped.id)).toHaveLength(0);

      // The probe finds A stored and never delivered; the replacement must ask from A, not from B.
      await f.tick();
      await f.waitFor("the probe finding the skipped mention", () => f.stalls.length === 1);
      f.fireTimers();
      await f.waitFor("the skipped mention admitted", () => f.inboundFor(skipped.id).length === 1);

      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      expect(f.relay.connections).toHaveLength(2);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: skipped.created_at });
      // Each admitted once: B came back with the wider window and the seam refused it.
      expect(f.inboundFor(skipped.id)).toHaveLength(1);
      expect(f.inboundFor(newer.id)).toHaveLength(1);
      expect(f.ownerMessages()).toBe(2);
      expect(f.wakes).toEqual([newer.id, skipped.id]);
      expect(f.subscriber.counters().rejections["admission-already-durable"]).toBe(1);

      await f.tick();
      await f.waitFor("a clean probe on the replacement", () => f.relay.connections[1]!.closes.length === 2);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "LIVE", stalls: 1, outageSinceSeconds: null });
    } finally {
      await f.close();
    }
  });

  it("does not count a probe the relay refuses as an answer", async () => {
    const f = await start();
    try {
      // One subscription per connection, on this one and every replacement: each probe is refused.
      f.relay.maxSubscriptionsPerConnection = 1;
      f.relay.connections[0]!.noLivePush = true;
      f.h.clock.advance(2_000);
      const missed = f.mention("거절된 프로브");
      f.relay.publish(missed);
      await f.settle();
      expect(f.inboundFor(missed.id)).toHaveLength(0);

      // Within the bound's three ticks the refused connection is a stall like an unanswered one.
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "UNANSWERED" })]);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", stalls: 1 });
      // One probe, refused, and no second one sent on the strength of the refusal.
      expect(f.relay.connections[0]!.refused).toHaveLength(1);

      // The replacement asks from the preserved window, so the mention is delivered; but no probe
      // has been answered, so the identity is still not LIVE.
      f.fireTimers();
      await f.waitFor("the missed mention admitted", () => f.inboundFor(missed.id).length === 1);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", stalls: 1 });

      // Still refused on the replacement: replaced again within the bound, still one report.
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.relay.connections[1]!.refused).toHaveLength(1);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", stalls: 2 });
      expect(f.stalls).toHaveLength(1);
      expect(f.relay.connections).toHaveLength(2);
      f.fireTimers();
      await f.waitFor("a third connection", () => f.relay.connections[2]?.requests.length === 1);
      expect(f.inboundFor(missed.id)).toHaveLength(1);
      expect(f.wakes).toEqual([missed.id]);
    } finally {
      await f.close();
    }
  });

  it("finds a mention published long after it was signed", async () => {
    const f = await start();
    try {
      const late = f.mention("늦게 게시된 답장");
      // Three healthy ticks: every probe comes back clean and the window moves past `late`'s second.
      const connection = f.relay.connections[0]!;
      for (let tick = 0; tick < 3; tick += 1) {
        await f.tick();
        // Its head check and its sweep's page.
        await f.waitFor(`probe ${tick + 1} answered and closed`, () => connection.closes.length === 2 * (tick + 1));
      }
      expect(f.stalls).toEqual([]);

      // Then it reaches the relay, while the live push has stopped.
      connection.noLivePush = true;
      f.relay.publish(late);
      await f.settle();
      expect(f.inboundFor(late.id)).toHaveLength(0);

      // The next tick's probe still reaches back to it.
      await f.tick();
      await f.waitFor("the probe finding the late mention", () => f.stalls.length === 1);
      f.fireTimers();
      await f.waitFor("the late mention admitted", () => f.inboundFor(late.id).length === 1);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      expect(f.inboundFor(late.id)).toHaveLength(1);
      expect(f.wakes).toEqual([late.id]);
    } finally {
      await f.close();
    }
  });

  it("tells the CEO once per outage, as a CRITICAL_SYSTEM_FAILURE notice that names no run", async () => {
    const f = await start(ONE_CTO, { ceo: true });
    try {
      await f.tick();
      expect(f.ceoNotices()).toEqual([]);

      // An outage that two replacements do not cure: one notice.
      f.relay.connections[0]!.silent = true;
      f.relay.silentForNewConnections = true;
      for (let round = 0; round < 2; round += 1) {
        for (let tick = 0; tick < 3; tick += 1) await f.tick();
        f.fireTimers();
        await f.settle();
      }
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", stalls: 2 });
      expect(f.stalls).toHaveLength(1);
      const first = {
        runId: null,
        payload: expect.objectContaining({
          notification: "CRITICAL_SYSTEM_FAILURE",
          runId: null,
          code: STALE,
          identity: "identities[0]",
          roleKey: ROLE_KEY,
          cause: "UNANSWERED",
          boundSeconds: 90,
          outageSinceSeconds: f.stalls[0]!.outageSinceSeconds,
        }),
      };
      expect(f.ceoNotices()).toEqual([first]);
      // Recorded with no run and its evidence kept, the explanation left to the notice itself.
      const audit = f.h.cp.db.all<{ run_id: string | null; reason_code: string | null; evidence_json: string }>(
        `SELECT run_id, reason_code, evidence_json FROM audit_events WHERE kind = 'CEO_NOTIFICATION'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.run_id).toBeNull();
      expect(audit[0]!.reason_code).toBeNull();
      const evidence = JSON.parse(audit[0]!.evidence_json) as Record<string, unknown>;
      expect(evidence).toMatchObject({ notification: "CRITICAL_SYSTEM_FAILURE", code: STALE, identity: "identities[0]" });
      expect(evidence).not.toHaveProperty("whyItMatters");

      // The relay answers again: replaced once more, a probe comes back clean, the outage is over.
      f.relay.silentForNewConnections = false;
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      f.fireTimers();
      await f.waitFor("an answered fourth connection", () => f.relay.connections[3]?.requests.length === 1);
      await f.tick();
      await f.waitFor("a clean probe on it", () => f.relay.connections[3]!.closes.length === 2);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "LIVE", stalls: 3, outageSinceSeconds: null });
      expect(f.ceoNotices()).toEqual([first]);

      // A second outage is a second notice.
      f.relay.connections[3]!.silent = true;
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.stalls).toHaveLength(2);
      expect(f.stalls[1]!.outageSinceSeconds).toBeGreaterThan(f.stalls[0]!.outageSinceSeconds);
      expect(f.ceoNotices()).toEqual([
        first,
        { runId: null, payload: expect.objectContaining({ notification: "CRITICAL_SYSTEM_FAILURE", outageSinceSeconds: f.stalls[1]!.outageSinceSeconds }) },
      ]);
    } finally {
      await f.close();
    }
  });
});

/**
 * The second review of the probe (#1283, lane-n-fs-r2): delivery taken from an evictable cache, a
 * fixed lookback, and an incident nobody retried.
 */
/** The control plane's clock, in the whole seconds the subscriber reads. */
const nowSeconds = (f: Awaited<ReturnType<typeof start>>): number => Math.floor(f.h.clock.now().getTime() / 1000);

/** Stalls found so far, across identities and outages: `stalls` holds an outage's first one only. */
const stallCount = (f: Awaited<ReturnType<typeof start>>): number =>
  (f.liveness()?.identities ?? []).reduce((sum, one) => sum + one.stalls, 0);

/**
 * One tick, then until every probe it sent has been answered and closed (or a stall found). A tick's
 * probe may be followed by another once it is answered, so this waits for the connection to go quiet.
 */
const probeTick = async (f: Awaited<ReturnType<typeof start>>, label: string): Promise<void> => {
  const connection = f.relay.connections.at(-1)!;
  const closes = connection.closes.length;
  const stalls = stallCount(f);
  await f.tick();
  const quiet = (): boolean => connection.closes.length > closes && connection.closes.length === connection.requests.length - 1;
  await f.waitFor(label, () => quiet() || stallCount(f) > stalls, 10_000);
  await f.waitFor(label, () => quiet() || stallCount(f) > stalls, 10_000);
};

/** The probe pages of one connection's historical sweeps, oldest first: not its head checks. */
const sweepPages = (connection: { readonly requests: readonly { readonly id: string; readonly filters: readonly Record<string, unknown>[] }[] }) =>
  connection.requests.filter((one) => /^live-[0-9a-f]+-s\d+$/u.test(one.id));

/** Moves the control plane's clock to `second`. */
const jumpTo = (f: Awaited<ReturnType<typeof start>>, second: number): void => {
  f.h.clock.advance((second - nowSeconds(f)) * 1000);
};

describe("a stalled Buzz subscription's evidence, under the probe's second review (#1283)", () => {
  it("does not take a full cache of newer deliveries as proof an older mention was delivered", async () => {
    const f = await start();
    try {
      // The live push skips A. Then 257 newer mentions arrive and are admitted, one second apart.
      const skipped = f.mention("밀려난 답장");
      f.relay.publish(skipped, { push: false });
      for (let n = 0; n < 257; n += 1) {
        f.h.clock.advance(1_000);
        f.relay.publish(f.mention(`나중 답장 ${n}`));
      }
      await f.waitFor("the newer mentions admitted", () => f.ownerMessages() === 257, 30_000);
      expect(f.inboundFor(skipped.id)).toHaveLength(0);

      // Delivered is what the seam's durable record or this subscription shows, never the absence of
      // an evicted id. The probe pages back past the 257 and finds A undelivered.
      for (let tick = 0; tick < 4 && f.stalls.length === 0; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      expect(sweepPages(f.relay.connections[0]!).map((one) => one.filters[0]!["until"])).toEqual([undefined, skipped.created_at + 58]);

      f.fireTimers();
      await f.waitFor("the skipped mention admitted", () => f.inboundFor(skipped.id).length === 1, 30_000);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: skipped.created_at });
      expect(f.ownerMessages()).toBe(258);
      expect(f.wakes.filter((id) => id === skipped.id)).toHaveLength(1);
      expect(f.wakes).toHaveLength(258);
    } finally {
      await f.close();
    }
  }, 120_000);

  it("finds a mention signed before eleven minutes of clean probes and published while live push is stopped", async () => {
    const f = await start();
    try {
      // One mention admitted, so the floor rests on a durable admission rather than on nothing.
      const first = f.mention("먼저 온 답장");
      f.relay.publish(first);
      await f.waitFor("the first mention admitted", () => f.inboundFor(first.id).length === 1);
      f.h.clock.advance(1_000);
      const late = f.mention("열한 분 늦게 게시된 답장");

      // Eleven minutes of healthy probes, every one clean.
      for (let tick = 0; tick < 22; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([]);
      expect(f.relay.connections).toHaveLength(1);

      // Then it reaches the relay, while the live push has stopped.
      const connection = f.relay.connections[0]!;
      connection.noLivePush = true;
      f.relay.publish(late);
      await f.settle();
      expect(f.inboundFor(late.id)).toHaveLength(0);

      for (let tick = 0; tick < 4 && f.stalls.length === 0; tick += 1) await probeTick(f, `late probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      // The probe asked from a day before the last clean sweep began (the previous tick), the lookback
      // guarantee, not from ten minutes back.
      expect(connection.requests.at(-1)!.filters[0]).toMatchObject({ since: nowSeconds(f) - 30 - LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS });
      f.fireTimers();
      await f.waitFor("the late mention admitted", () => f.inboundFor(late.id).length === 1);
      expect(f.inboundFor(late.id)).toHaveLength(1);
      expect(f.wakes).toEqual([first.id, late.id]);
    } finally {
      await f.close();
    }
  }, 60_000);

  it("keeps the CEO notice owed while it is refused, and enqueues it once when a CEO is bound mid-outage", async () => {
    const f = await start();
    try {
      // No CEO binding: the outage is found and reported, and the notice is refused.
      f.relay.connections[0]!.silent = true;
      f.relay.silentForNewConnections = true;
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.stalls).toHaveLength(1);
      expect(f.ceoNotices()).toEqual([]);
      f.fireTimers();
      await f.settle();
      await f.tick();
      expect(f.ceoNotices()).toEqual([]);

      // A CEO is bound while the outage continues: the next tick enqueues exactly one notice.
      bindCeo(f.h);
      await f.tick();
      const notice = {
        runId: null,
        payload: expect.objectContaining({
          notification: "CRITICAL_SYSTEM_FAILURE",
          code: STALE,
          identity: "identities[0]",
          outageSinceSeconds: f.stalls[0]!.outageSinceSeconds,
        }),
      };
      expect(f.ceoNotices()).toEqual([notice]);

      // The outage goes on through another replacement: still one notice, still one report.
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      f.fireTimers();
      await f.settle();
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", stalls: 3 });
      expect(f.stalls).toHaveLength(1);
      expect(f.ceoNotices()).toEqual([notice]);
    } finally {
      await f.close();
    }
  });
});

/** A 90-second outage on the current connection, then a replacement whose sweep comes back clean. */
const outageAndRecovery = async (f: Awaited<ReturnType<typeof start>>, label: string): Promise<void> => {
  const stalls = f.stalls.length;
  const connections = f.relay.connections.length;
  f.relay.connections.at(-1)!.silent = true;
  for (let tick = 0; tick < 3; tick += 1) await f.tick();
  expect(f.stalls).toHaveLength(stalls + 1);
  expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE" });
  f.fireTimers();
  await f.waitFor(`${label}: an answered replacement`, () => f.relay.connections[connections]?.requests.length === 1);
  await probeTick(f, `${label}: a clean sweep on it`);
  expect(f.liveness()?.identities[0]).toMatchObject({ state: "LIVE", outageSinceSeconds: null });
};

/** The CEO notice an outage's report is owed. */
const noticeOf = (report: BuzzMentionStallReport) => ({
  runId: null,
  payload: expect.objectContaining({
    notification: "CRITICAL_SYSTEM_FAILURE",
    code: STALE,
    identity: report.identity,
    outageSinceSeconds: report.outageSinceSeconds,
  }),
});

/**
 * The third review of the probe (#1283, lane-n-fs-r3): a second a page cannot get past, a floor
 * moved past a mention not yet published, and an outage's notice dropped by its recovery.
 */
describe("a stalled Buzz subscription's evidence, under the probe's third review (#1283)", () => {
  it("does not take a second holding more than a page as checked: the mention stored behind it is found", async () => {
    const f = await start();
    try {
      // A full page of mentions in one second, all pushed and admitted.
      const second = nowSeconds(f);
      for (let n = 0; n < LIVENESS_PROBE_PAGE_LIMIT; n += 1) f.relay.publish(f.mention(`같은 초 답장 ${n}`));
      await f.waitFor("the mentions admitted", () => f.ownerMessages() === LIVENESS_PROBE_PAGE_LIMIT, 30_000);
      // One more in that second, stored after them and never pushed: no page with that second as
      // its `until` returns it.
      const hidden = f.mention("같은 초에 묻힌 답장");
      expect(hidden.created_at).toBe(second);
      f.relay.publish(hidden, { push: false });
      await f.settle();
      expect(f.inboundFor(hidden.id)).toHaveLength(0);

      for (let tick = 0; tick < 6 && f.stalls.length === 0; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);
      // The sweep could not get past that second, so it is not clean: it went on below it, and at its
      // floor the identity is STALE and replaced, asking from that floor.
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "UNCERTIFIED" })]);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", outageSinceSeconds: f.stalls[0]!.outageSinceSeconds });
      const pages = sweepPages(f.relay.connections[0]!);
      expect(pages.map((one) => one.filters[0]!["until"])).toEqual([undefined, hidden.created_at, hidden.created_at - 1]);
      f.fireTimers();
      await f.waitFor("the hidden mention admitted", () => f.inboundFor(hidden.id).length === 1, 30_000);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: pages[0]!.filters[0]!["since"] });
      expect(f.ownerMessages()).toBe(LIVENESS_PROBE_PAGE_LIMIT + 1);
      expect(f.wakes.filter((id) => id === hidden.id)).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 120_000);

  it("finds a mention signed before a newer one was admitted and published after a clean sweep, while live push is stopped", async () => {
    const f = await start();
    try {
      const early = f.mention("먼저 서명되고 늦게 게시된 답장");
      f.h.clock.advance(1_000);
      const newer = f.mention("나중에 서명되고 먼저 온 답장");
      f.relay.publish(newer);
      await f.waitFor("the newer mention admitted", () => f.inboundFor(newer.id).length === 1);

      // A clean sweep: the durable floor moves to the newer admission.
      await probeTick(f, "a clean sweep");
      expect(f.stalls).toEqual([]);
      const connection = f.relay.connections[0]!;
      // Its head check and the sweep's one page.
      expect(connection.closes).toHaveLength(2);

      // The older mention reaches the relay only now, while the live push has stopped.
      connection.noLivePush = true;
      f.relay.publish(early);
      await f.settle();
      expect(f.inboundFor(early.id)).toHaveLength(0);

      for (let tick = 0; tick < 4 && f.stalls.length === 0; tick += 1) await probeTick(f, `late probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      // The probe asked from a day before the clean sweep began, not from the newer admission.
      expect(connection.requests.at(-1)!.filters[0]).toMatchObject({ since: nowSeconds(f) - 30 - LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS });
      f.fireTimers();
      await f.waitFor("the early mention admitted", () => f.inboundFor(early.id).length === 1);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: early.created_at });
      expect(f.inboundFor(early.id)).toHaveLength(1);
      expect(f.wakes).toEqual([newer.id, early.id]);
    } finally {
      await f.close();
    }
  });

  it("keeps an outage's refused notice owed after it recovers, and enqueues it once when a CEO is bound", async () => {
    const f = await start();
    try {
      // No CEO binding: the outage is found and reported, its notice refused, and it is over.
      await outageAndRecovery(f, "the outage");
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "UNANSWERED" })]);
      expect(f.ceoNotices()).toEqual([]);

      // A CEO is bound after the recovery: the next ticks enqueue exactly one notice, for that outage.
      bindCeo(f.h);
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.ceoNotices()).toEqual([noticeOf(f.stalls[0]!)]);
      expect(f.stalls).toHaveLength(1);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "LIVE", stalls: 1 });
    } finally {
      await f.close();
    }
  });

  it("owes each refused outage its own notice: two outages before a CEO is bound are two notices, once each", async () => {
    const f = await start();
    try {
      await outageAndRecovery(f, "the first outage");
      await outageAndRecovery(f, "the second outage");
      expect(f.stalls).toHaveLength(2);
      expect(f.ceoNotices()).toEqual([]);

      bindCeo(f.h);
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.ceoNotices()).toEqual([noticeOf(f.stalls[0]!), noticeOf(f.stalls[1]!)]);
    } finally {
      await f.close();
    }
  });
});

/**
 * The fourth review of the probe (#1283, lane-n-fs-r4): a saturated second that kept an older
 * mention out of reach, a lookback measured from the probe rather than from publication, a sweep
 * through history that kept a current stall from being seen, and an owed notice kept in memory only.
 */
describe("a stalled Buzz subscription's evidence, under the probe's fourth review (#1283)", () => {
  it("pages past a second holding more than a page, so an older mention the push skipped is still found", async () => {
    const f = await start();
    try {
      // A is signed; a full page of mentions follows one second later, all pushed and admitted.
      const older = f.mention("포화된 초보다 먼저 서명된 답장");
      f.h.clock.advance(1_000);
      const second = nowSeconds(f);
      for (let n = 0; n < LIVENESS_PROBE_PAGE_LIMIT; n += 1) f.relay.publish(f.mention(`한 초에 몰린 답장 ${n}`));
      await f.waitFor("the mentions admitted", () => f.ownerMessages() === LIVENESS_PROBE_PAGE_LIMIT, 30_000);
      // Then A is stored, and never pushed.
      f.relay.publish(older, { push: false });
      await f.settle();
      expect(f.inboundFor(older.id)).toHaveLength(0);

      // The sweep pages from the newest, asks the saturated second again, and goes on below it to A.
      for (let tick = 0; tick < 4 && f.stalls.length === 0; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      const first = f.relay.connections[0]!;
      expect(sweepPages(first).map((one) => one.filters[0]!["until"])).toEqual([undefined, second, second - 1]);
      f.fireTimers();
      await f.waitFor("the older mention admitted", () => f.inboundFor(older.id).length === 1, 30_000);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: older.created_at });
      expect(f.wakes.filter((id) => id === older.id)).toHaveLength(1);
      expect(f.ownerMessages()).toBe(LIVENESS_PROBE_PAGE_LIMIT + 1);

      // The saturated second still cannot be shown delivered: the next sweep pages past it again,
      // finds nothing missed, and ends UNCERTIFIED. The identity stays STALE, and its replacement
      // asks from that sweep's floor, not from the saturated second.
      const stalls = stallCount(f);
      for (let tick = 0; tick < 6 && stallCount(f) === stalls; tick += 1) await probeTick(f, `replacement probe ${tick + 1} answered`);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE", lastStall: { cause: "UNCERTIFIED" } });
      const floor = sweepPages(f.relay.connections[1]!).at(-1)!.filters[0]!["since"] as number;
      expect(floor).toBeLessThan(second);
      f.fireTimers();
      await f.waitFor("a third connection", () => f.relay.connections[2]?.requests.length === 1, 30_000);
      expect(f.relay.connections[2]!.requests[0]!.filters[0]).toMatchObject({ since: floor });
      expect(f.inboundFor(older.id)).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 120_000);

  it("finds a mention published 86,399 s after it was signed, while live push is stopped", async () => {
    const f = await start();
    try {
      const early = f.mention("서명하고 하루에서 1초 모자라게 게시된 답장");
      f.h.clock.advance(1_000);
      const newer = f.mention("먼저 온 답장");
      f.relay.publish(newer);
      await f.waitFor("the newer mention admitted", () => f.inboundFor(newer.id).length === 1);
      await probeTick(f, "a clean sweep");
      expect(f.stalls).toEqual([]);

      // A day less one second after `early` was signed, the connection is still answered: a mention
      // signed then is pushed and admitted. Then the live push stops and `early` reaches the relay.
      jumpTo(f, early.created_at + LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS - 1);
      const current = f.mention("방금 온 답장");
      f.relay.publish(current);
      await f.waitFor("the current mention admitted", () => f.inboundFor(current.id).length === 1);
      const connection = f.relay.connections[0]!;
      connection.noLivePush = true;
      f.relay.publish(early);
      await f.settle();
      expect(f.inboundFor(early.id)).toHaveLength(0);

      // Inside the guarantee: the next probe still reaches back to it, though it is now more than a
      // day older than the probe.
      for (let tick = 0; tick < 3 && f.stalls.length === 0; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      f.fireTimers();
      await f.waitFor("the early mention admitted", () => f.inboundFor(early.id).length === 1);
      expect(f.relay.connections[1]!.requests[0]!.filters[0]).toMatchObject({ since: early.created_at });
      expect(f.inboundFor(early.id)).toHaveLength(1);
      expect(f.wakes).toEqual([newer.id, current.id, early.id]);
    } finally {
      await f.close();
    }
  });

  it("claims nothing for a mention published a day and an hour after it was signed: it is outside the guarantee", async () => {
    const f = await start();
    try {
      const stale = f.mention("서명하고 하루 한 시간 뒤 게시된 답장");
      f.h.clock.advance(1_000);
      const newer = f.mention("먼저 온 답장");
      f.relay.publish(newer);
      await f.waitFor("the newer mention admitted", () => f.inboundFor(newer.id).length === 1);
      await probeTick(f, "a clean sweep");

      // A day and an hour on, the connection is still answered and a sweep comes back clean.
      jumpTo(f, stale.created_at + LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS + 3_600);
      const current = f.mention("방금 온 답장");
      f.relay.publish(current);
      await f.waitFor("the current mention admitted", () => f.inboundFor(current.id).length === 1);
      await probeTick(f, "a clean sweep a day and an hour on");
      expect(f.stalls).toEqual([]);

      // Only now does `stale` reach the relay, with the live push stopped.
      const connection = f.relay.connections[0]!;
      connection.noLivePush = true;
      f.relay.publish(stale);
      for (let tick = 0; tick < 3; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);

      // Each sweep asks from a day before the last clean sweep began, which here is the previous
      // tick: 24 h plus the probe's latency. `stale` was signed an hour before even that.
      const since = nowSeconds(f) - 30 - LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS;
      // The tick's last request is its sweep page.
      expect(connection.requests.at(-1)!.filters[0]).toMatchObject({ since });
      expect(stale.created_at).toBeLessThan(since - 3_600);
      // Outside the guarantee, and nothing says otherwise: no stall is claimed for it, and it is not admitted.
      expect(f.stalls).toEqual([]);
      expect(f.inboundFor(stale.id)).toHaveLength(0);
      expect(f.wakes).toEqual([newer.id, current.id]);
    } finally {
      await f.close();
    }
  });

  it("checks the newest page on every tick, so a sweep through a long history cannot hide a stall past the bound", async () => {
    const f = await start();
    try {
      // 800 mentions, one second apart, all pushed and admitted: a sweep takes five pages.
      for (let n = 0; n < 4 * LIVENESS_PROBE_PAGE_LIMIT; n += 1) {
        f.h.clock.advance(1_000);
        f.relay.publish(f.mention(`지난 답장 ${n}`));
      }
      await f.waitFor("the mentions admitted", () => f.ownerMessages() === 4 * LIVENESS_PROBE_PAGE_LIMIT, 90_000);
      // One clean sweep through all of it, then the first page of the next one.
      for (let tick = 0; tick < 6; tick += 1) await probeTick(f, `probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([]);

      // The live push stops right after that page, and a mention is published.
      const connection = f.relay.connections[0]!;
      connection.noLivePush = true;
      const missed = f.mention("긴 기록 뒤에 묻힌 답장");
      f.relay.publish(missed);
      await f.settle();

      // Found within the 90-second bound, while the sweep still has four pages of history to go.
      for (let tick = 0; tick < 3 && f.stalls.length === 0; tick += 1) await probeTick(f, `late probe ${tick + 1} answered`);
      expect(f.stalls).toEqual([expect.objectContaining({ cause: "MISSED_EVENTS" })]);
      expect(f.liveness()?.identities[0]).toMatchObject({ state: "STALE" });
      f.fireTimers();
      await f.waitFor("the missed mention admitted", () => f.inboundFor(missed.id).length === 1, 60_000);
      expect(f.wakes.filter((id) => id === missed.id)).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 240_000);

  it("keeps an outage's refused notice owed across a restart and a day's downtime, and enqueues it once when a CEO is bound", async () => {
    const f = await start();
    try {
      await outageAndRecovery(f, "the outage");
      expect(f.ceoNotices()).toEqual([]);
      const outage = f.stalls[0]!;

      // The daemon is down for a day and an hour, then restarts with nothing in memory.
      await f.restart(LIVENESS_PROBE_LOOKBACK_GUARANTEE_SECONDS * 1000 + 3_600_000);
      for (let tick = 0; tick < 2; tick += 1) await f.tick();
      expect(f.ceoNotices()).toEqual([]);

      // A CEO is bound: the notice the outage is still owed is enqueued, once.
      bindCeo(f.h);
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.ceoNotices()).toEqual([noticeOf(outage)]);

      // Taken is durable too: another restart does not send it again.
      await f.restart();
      for (let tick = 0; tick < 3; tick += 1) await f.tick();
      expect(f.ceoNotices()).toEqual([noticeOf(outage)]);
      expect(f.stalls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});
