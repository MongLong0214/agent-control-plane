import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionEvent,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  ownerMessageLedger,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { recoverDeadCanonicalBinding } from "../../src/daemon/dead-binding-recovery.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import type { HolderIdentity } from "../../src/outbox/outbox.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * 2026-10-03 10:08:55Z — the canonical CTO, an adopted interactive Claude Code conversation,
 * restarted its process and re-claimed its role through the self-claim's dead-predecessor recovery:
 * generation N to N + 1, the same conversation UUID, the same conversational actor, the same Buzz
 * channel identity and the same room. The recovery's revoke rejected every queued CEO peer message
 * (#1044) and settled its turn, so the CEO's instructions were lost and the CEO was never told.
 *
 * #1044 refuses to hand a peer message to a *different* runtime. A canonical restart is not one,
 * so the message is carried to the restarted conversation once — and every other path that rejects
 * an identity-bound row still does.
 *
 * Everything here is real: SQLite, the self-claim and its recovery, the outbox fence, the Buzz
 * subscriber and ingress that admit the CEO's mention, and the hand-over (`ownerMessageLedger`,
 * which is `claimForHolder` + `peerProofIsCurrent`). Only the process table, the image scan, the
 * transcript lookup and the relay socket are fixtures.
 */

const SECRET = "canonical-restart-peer-test-secret";
const CANON = "55555555-5555-4555-8555-555555555555";
const CWD = "/work/canonical-restart";
const PROJECT_ROOM = "buzz-project-room";
const OTHER_ROOM = "buzz-other-project-room";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const anyBuzzActorIsAuthenticated = { isAllowedActor: () => true };

interface Key {
  secret: Uint8Array;
  pubkey: string;
}
const newKey = (): Key => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};

/** The CTO's claude process as run number `run` (1, 2, 3 …): a new pid and start each restart. */
const claudeRun = (run: number): ProcessSnapshot[] => {
  const claudePid = 9 + run;
  return [
    {
      pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
      command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1",
    },
    {
      pid: 50, ppid: claudePid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD,
      cwdProbeFailure: null, startedAt: "t2",
    },
    {
      pid: claudePid, ppid: 1, argv: ["/opt/claude/claude", "--session-id", CANON],
      command: `/opt/claude/claude --session-id ${CANON}`, cwd: CWD, cwdProbeFailure: null,
      startedAt: `Fri Jan  1 0${run}:00:00 2027`,
    },
  ];
};

/** A pid in the chain answers; any other raises ESRCH — never the real `kill`. */
const signalFrom = (chain: readonly ProcessSnapshot[]) => (pid: number): void => {
  if (chain.some((entry) => entry.pid === pid)) return;
  throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
};

const manualRelay = () => {
  const sockets: { sent: string[]; handlers: BuzzRelaySocketHandlers }[] = [];
  const factory: BuzzRelaySocketFactory = (_url, handlers) => {
    const socket = { sent: [] as string[], handlers };
    sockets.push(socket);
    return { send: (raw) => socket.sent.push(raw), close: () => undefined };
  };
  const live = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("the subscriber opened no relay socket");
    return socket;
  };
  return {
    factory,
    live,
    authenticateAndSubscribe: async (handle: { settled(): Promise<void> }): Promise<string> => {
      const socket = live();
      socket.handlers.onFrame(JSON.stringify(["AUTH", "relay-challenge"]));
      await handle.settled();
      const frames = () => socket.sent.map((raw) => JSON.parse(raw) as unknown[]);
      const auth = frames().at(-1) as [string, { id: string }];
      socket.handlers.onFrame(JSON.stringify(["OK", auth[1].id, true, ""]));
      await handle.settled();
      const req = frames().find((sent) => sent[0] === "REQ") as [string, string, unknown];
      return req[1];
    },
  };
};

const scheduler = (): BuzzSubscriberScheduler => ({
  setTimer: () => 0,
  clearTimer: () => undefined,
  nowSeconds: () => 1_900_000_000,
});

interface PeerRow {
  message_id: string;
  status: string;
  reason_code: string | null;
  binding_generation: number;
  target_session_id: string;
  payload_json: string;
}

/**
 * One deployment: a canonical CTO adopted through the real self-claim (run 1, generation 1) on
 * `PROJECT_ROOM` with Buzz channel identity `cto`, a CEO binding speaking as `ceo`, and the daemon's
 * own Buzz subscriber and message ingress.
 */
const startFixture = async () => {
  const owner = newKey();
  const ceo = newKey();
  const ceoNext = newKey();
  const cto = newKey();
  const harness = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const { projectId } = await registerFixtureProject(harness);
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

  /** The self-claim as the canonical CTO's run number `run` presents it. */
  const claimAs = async (
    run: number,
    options: { expectedBindingGeneration?: number; room?: string } = {},
  ) => {
    const chain = claudeRun(run);
    const subject = new CanonicalSelfClaim(
      harness.cp.db,
      harness.clock,
      harness.cp.audit,
      harness.cp.sessions,
      harness.cp.bindings,
      anyBuzzActorIsAuthenticated,
      async (): Promise<Decision<string>> => allow(ReasonCode.OK, options.room ?? PROJECT_ROOM),
      {
        canonicalSessions: [{ sessionUuid: CANON, projectId, buzzActorId: cto.pubkey }],
        canonicalBuzzChannelId: PROJECT_ROOM,
        expectedPeerProtocolVersion: PEER_PROTOCOL,
        expectedPeerIdentity: PEER_IDENTITY,
      },
      {
        processInspector: { snapshot: (pid) => chain.find((entry) => entry.pid === pid) ?? null },
        imageInspector: {
          resolve: () => ({ imagePath: "/fake/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }),
        },
        transcriptReader: { locate: (uuid) => ({ path: `/fake/transcripts/${uuid}.jsonl`, sizeBytes: 42 }) },
        hostSessionRegistryReader: { read: (pid) => hostSessionRegistryAbsent(`/fake/sessions/${pid}.json is absent`) },
        processSignal: signalFrom(chain),
      },
    );
    return subject.claim({
      callerPid: 100,
      claimedSessionUuid: CANON,
      projectId,
      expectedBindingGeneration: options.expectedBindingGeneration ?? run,
      peerProtocolVersion: PEER_PROTOCOL,
      peerIdentity: PEER_IDENTITY,
      buzzPurpose: "continuity:PRIMARY_CTO",
    });
  };

  const first = await claimAs(1);
  if (!first.allowed) throw new Error(`the first canonical claim failed: ${JSON.stringify(first)}`);

  const readyCeo = (model: string) => {
    const session = harness.cp.sessions.create({ provider: "scripted", model, buzzAddress: null });
    expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    return { sessionId: session.sessionId, sessionSecret: session.sessionSecret! };
  };
  const bindCeo = (key: Key, model: string) => {
    const session = readyCeo(model);
    const bound = harness.cp.bindings.bind({ roleKey: roleKeyFor(Role.CEO), role: Role.CEO, sessionId: session.sessionId });
    if (!bound.allowed) throw new Error(`CEO binding failed: ${bound.message}`);
    const identity = harness.cp.sessions.bindBuzzActor(
      { sessionId: session.sessionId, sessionSecret: session.sessionSecret, buzzActorId: key.pubkey },
      anyBuzzActorIsAuthenticated,
    );
    if (!identity.allowed) throw new Error(`CEO identity binding failed: ${identity.message}`);
    return session;
  };
  const ceoSession = bindCeo(ceo, "ceo");

  // Short: the ingress socket lives in this directory, and a Unix socket path is capped near 104 bytes.
  const dir = tempDir("acp-crp-");
  chmodSync(dir, 0o700);
  const keyFile = join(dir, "cto.nostr.key");
  writeFileSync(keyFile, `${Buffer.from(cto.secret).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(
    join(dir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
    JSON.stringify({
      relayUrl: "wss://relay.example.invalid/buzz",
      identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms: [PROJECT_ROOM, OTHER_ROOM] }],
    }),
  );
  const policy = { allowedActors: [owner.pubkey, ceo.pubkey, ceoNext.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(harness.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
  });
  const relay = manualRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(harness.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: scheduler(),
  });
  const subId = await relay.authenticateAndSubscribe(subscriber);

  const holderOf = (sessionId: string): HolderIdentity => {
    const binding = harness.cp.bindings.active(ctoRoleKey)!;
    return {
      roleKey: ctoRoleKey,
      bindingGeneration: binding.bindingGeneration,
      targetSessionId: sessionId,
      sessionIncarnation: harness.cp.sessions.require(sessionId).incarnation,
    };
  };

  return {
    harness,
    owner,
    ceo,
    ceoNext,
    cto,
    projectId,
    ctoRoleKey,
    first: first.value,
    ceoSession,
    claimAs,
    /** Rebinds the CEO to a fresh runtime with a fresh key: a new CEO generation. */
    rotateCeo: () => {
      expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test rotation").reasonCode).toBe(ReasonCode.OK);
      expect(harness.cp.sessions.transition(ceoSession.sessionId, SessionLifecycle.STOPPED, "rotated").allowed).toBe(true);
      harness.clock.advance(60_000);
      return bindCeo(ceoNext, "ceo-next");
    },
    /** One CEO mention to the CTO, through the daemon's own subscriber and sink. */
    ceoSays: async (text: string): Promise<BuzzMentionEvent> => {
      const event = finalizeEvent(
        {
          kind: 9,
          created_at: Math.floor(harness.clock.now().getTime() / 1000),
          tags: [["p", cto.pubkey], ["h", PROJECT_ROOM]],
          content: text,
        },
        ceo.secret,
      ) as BuzzMentionEvent;
      relay.live().handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
      await subscriber.settled();
      return event;
    },
    peerRows: () =>
      harness.cp.db.all<PeerRow>(
        `SELECT message_id, status, reason_code, binding_generation, target_session_id, payload_json
           FROM outbox WHERE kind = ? ORDER BY created_at, rowid`,
        [MessageKind.PEER_MESSAGE],
      ),
    inbound: (eventId: string) =>
      harness.cp.db.get<{ payload_json: string; turn_claim_json: string | null }>(
        `SELECT payload_json, turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce(eventId)],
      )!,
    turnClaim: (eventId: string): Record<string, unknown> =>
      JSON.parse(
        harness.cp.db.get<{ turn_claim_json: string }>(
          `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
          [buzzMessageNonce(eventId)],
        )!.turn_claim_json,
      ) as Record<string, unknown>,
    holderOf,
    writes: (): number => harness.cp.db.get<{ n: number }>(`SELECT total_changes() AS n`, [])!.n,
    fences: () =>
      harness.cp.db
        .all<{ evidence_json: string }>(
          `SELECT evidence_json FROM audit_events WHERE kind = 'OUTBOX_FENCE' AND role_key = ? ORDER BY event_id`,
          [ctoRoleKey],
        )
        .map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>),
    close: async () => {
      subscriber.close();
      await ingress.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof startFixture>>;

const handedOver = (
  value: unknown,
): { claimed: { messageId: string; text: string; principal: string } | null; withheld: { messageId: string }[] } =>
  value as never;

/** The successor's restart through the real self-claim; throws unless it was admitted. */
const restart = async (fixture: Fixture, run: number, room?: string) => {
  fixture.harness.clock.advance(60_000);
  const claimed = await fixture.claimAs(run, room === undefined ? {} : { room });
  if (!claimed.allowed) throw new Error(`restart ${run} was refused: ${JSON.stringify(claimed)}`);
  return claimed.value;
};

describe("a canonical restart keeps the CEO's queued peer message (2026-10-03)", () => {
  it("(a) carries a PENDING peer message to the restarted conversation, which is handed it with its turn still open", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("CTO, 재시작 전에 보낸 지시입니다");
      const [queued] = fixture.peerRows();
      expect(queued).toMatchObject({
        status: "PENDING",
        binding_generation: 1,
        target_session_id: fixture.first.sessionId,
        reason_code: null,
      });
      const admittedBefore = fixture.inbound(event.id);

      const successor = await restart(fixture, 2);
      expect(successor.binding.bindingGeneration).toBe(2);
      expect(successor.sessionId).not.toBe(fixture.first.sessionId);

      // Carried once, to exactly the successor, and marked so it is never carried again.
      const [carried] = fixture.peerRows();
      expect(carried).toEqual({
        ...queued,
        binding_generation: 2,
        target_session_id: successor.sessionId,
        reason_code: ReasonCode.OUTBOX_RETARGETED,
      });
      // The admitted envelope — the proof included, which still names generation 1 and the
      // predecessor session — is untouched, and the turn it opened is not settled.
      expect(fixture.inbound(event.id)).toEqual(admittedBefore);
      expect(JSON.parse(admittedBefore.payload_json).peer).toMatchObject({
        ctoBindingGeneration: 1,
        ctoSessionId: fixture.first.sessionId,
      });
      const claim = fixture.turnClaim(event.id);
      expect(claim["noReplyAt"]).toBeUndefined();
      expect(claim["settledAt"]).toBeUndefined();
      // The fence evidence for this path lists the carried id under `retargeted`.
      expect(fixture.fences().at(-1)).toMatchObject({
        fromGeneration: 1,
        toGeneration: 2,
        fromSessionId: fixture.first.sessionId,
        toSessionId: successor.sessionId,
        retargeted: [queued!.message_id],
        rejected: [],
      });

      // The real hand-over gives it to the restarted conversation, with the CEO's words intact.
      const ledger = ownerMessageLedger(fixture.harness.cp);
      const holder = fixture.holderOf(successor.sessionId);
      const taken = ledger.claim(holder);
      expect(taken.allowed, JSON.stringify(taken)).toBe(true);
      expect(handedOver(taken.allowed ? taken.value : null).claimed).toMatchObject({
        messageId: queued!.message_id,
        text: "CTO, 재시작 전에 보낸 지시입니다",
        principal: "peer",
      });
      expect(ledger.complete(queued!.message_id, holder).reasonCode).toBe(ReasonCode.OK);
      expect(fixture.peerRows()[0]!.status).toBe("ACKED");
    } finally {
      await fixture.close();
    }
  });

  it("(b) still rejects a peer message the predecessor was already handed (SENT), and settles its turn", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("이미 건네진 지시");
      const ledger = ownerMessageLedger(fixture.harness.cp);
      const taken = ledger.claim(fixture.holderOf(fixture.first.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null).claimed?.text).toBe("이미 건네진 지시");
      expect(fixture.peerRows()[0]!.status).toBe("SENT");

      const successor = await restart(fixture, 2);

      expect(fixture.peerRows()[0]).toMatchObject({
        status: "REJECTED",
        reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        binding_generation: 1,
        target_session_id: fixture.first.sessionId,
      });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      const again = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(again.allowed ? again.value : null)).toMatchObject({ claimed: null, withheld: [] });
    } finally {
      await fixture.close();
    }
  });

  it("(c) carries a row once: the second restart rejects the row the first one carried", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("두 번 재시작되는 지시");
      const [queued] = fixture.peerRows();
      const second = await restart(fixture, 2);
      expect(fixture.peerRows()[0]).toMatchObject({
        status: "PENDING",
        binding_generation: 2,
        target_session_id: second.sessionId,
        reason_code: ReasonCode.OUTBOX_RETARGETED,
      });

      const third = await restart(fixture, 3);
      expect(third.binding.bindingGeneration).toBe(3);
      expect(fixture.peerRows()[0]).toMatchObject({
        message_id: queued!.message_id,
        status: "REJECTED",
        reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        binding_generation: 2,
        target_session_id: second.sessionId,
      });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      // The revoke's own fence rejected it; the carry found nothing left to move.
      expect(fixture.fences().at(-1)).toMatchObject({
        fromGeneration: 2,
        toGeneration: 2,
        rejected: [queued!.message_id],
        held: [],
      });
      const taken = ownerMessageLedger(fixture.harness.cp).claim(fixture.holderOf(third.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({ claimed: null, withheld: [] });
    } finally {
      await fixture.close();
    }
  });

  it("(d1) the operator's dead-binding door still rejects the queued peer message", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("운영자 문으로 풀리는 지시");
      const predecessor = fixture.harness.cp.sessions.require(fixture.first.sessionId);
      // The door's own function and its own (absent) options; the seam only answers ESRCH for the
      // fixture's pid instead of asking the kernel about a pid this host may really be running.
      const released = recoverDeadCanonicalBinding(
        "operator",
        {
          projectId: fixture.projectId,
          role: Role.PRIMARY_CTO,
          sessionId: predecessor.sessionId,
          sessionIncarnation: predecessor.incarnation,
          expectedBindingGeneration: 1,
        },
        {
          db: fixture.harness.cp.db,
          audit: fixture.harness.cp.audit,
          sessions: fixture.harness.cp.sessions,
          bindings: fixture.harness.cp.bindings,
          liveness: { signal: signalFrom(claudeRun(2)) },
        },
      );
      expect(released.allowed, JSON.stringify(released)).toBe(true);
      expect(fixture.peerRows()[0]).toMatchObject({
        status: "REJECTED",
        reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
      });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));

      // A later self-claim of the same conversation binds generation 2 and finds nothing to carry.
      const successor = await restart(fixture, 2);
      expect(fixture.peerRows()[0]!.status).toBe("REJECTED");
      const taken = ownerMessageLedger(fixture.harness.cp).claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({ claimed: null, withheld: [] });
    } finally {
      await fixture.close();
    }
  });

  it("(d2) a takeover by a different runtime, and a plain revoke, still reject the queued peer message", async () => {
    for (const path of ["takeover", "revoke"] as const) {
      const fixture = await startFixture();
      try {
        const event = await fixture.ceoSays(`${path} 로 끝나는 지시`);
        if (path === "takeover") {
          const other = fixture.harness.cp.sessions.create({ provider: "scripted", model: "cto-other", buzzAddress: PROJECT_ROOM });
          expect(fixture.harness.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
          const switched = fixture.harness.cp.bindings.switchTo({
            role: Role.PRIMARY_CTO,
            projectId: fixture.projectId,
            sessionId: other.sessionId,
            reason: "a different CTO takes the role",
            conversation: "REPLACED",
          });
          expect(switched.allowed, JSON.stringify(switched)).toBe(true);
        } else {
          expect(fixture.harness.cp.bindings.revoke(fixture.ctoRoleKey, "operator stop").allowed).toBe(true);
        }
        expect(fixture.peerRows()[0]).toMatchObject({
          status: "REJECTED",
          reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        });
        expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      } finally {
        await fixture.close();
      }
    }
  });

  it("(e) withholds the carried message once the CEO generation has changed since admission, writing nothing", async () => {
    const fixture = await startFixture();
    try {
      await fixture.ceoSays("교체 전 CEO 의 지시");
      const [queued] = fixture.peerRows();
      const successor = await restart(fixture, 2);
      expect(fixture.peerRows()[0]!.reason_code).toBe(ReasonCode.OUTBOX_RETARGETED);

      fixture.rotateCeo();
      const before = fixture.writes();
      const taken = ownerMessageLedger(fixture.harness.cp).claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: queued!.message_id }],
      });
      expect(fixture.writes()).toBe(before);
      expect(fixture.peerRows()[0]!.status).toBe("PENDING");
    } finally {
      await fixture.close();
    }
  });

  it("(f) carries the message to a successor in another room, where the hand-over's room clause withholds it", async () => {
    const fixture = await startFixture();
    try {
      await fixture.ceoSays("원래 방에서 받은 지시");
      const [queued] = fixture.peerRows();
      const successor = await restart(fixture, 2, OTHER_ROOM);
      expect(fixture.harness.cp.sessions.require(successor.sessionId).buzzAddress).toBe(OTHER_ROOM);
      expect(fixture.peerRows()[0]).toMatchObject({
        status: "PENDING",
        binding_generation: 2,
        target_session_id: successor.sessionId,
        reason_code: ReasonCode.OUTBOX_RETARGETED,
      });

      const ledger = ownerMessageLedger(fixture.harness.cp);
      const before = fixture.writes();
      const taken = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: queued!.message_id }],
      });
      expect(fixture.writes()).toBe(before);

      // Control: the same successor back on the room the event arrived on is handed it.
      fixture.harness.cp.sessions.setBuzzAddress(successor.sessionId, PROJECT_ROOM);
      const handed = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(handed.allowed ? handed.value : null).claimed).toMatchObject({
        messageId: queued!.message_id,
        principal: "peer",
      });
    } finally {
      await fixture.close();
    }
  });

  it("(g) a refused restart changes no peer row and no turn: before the release, and after the carry", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("거절된 재시작이 건드리면 안 되는 지시");
      const rowsBefore = fixture.peerRows();
      const inboundBefore = fixture.inbound(event.id);
      const assignments = () =>
        fixture.harness.cp.db.all(
          `SELECT binding_generation, status, session_id FROM assignments WHERE role_key = ? ORDER BY binding_generation`,
          [fixture.ctoRoleKey],
        );
      const assignmentsBefore = assignments();

      // Refused before anything is written: the expected generation is not the next one.
      fixture.harness.clock.advance(60_000);
      const stale = await fixture.claimAs(2, { expectedBindingGeneration: 3 });
      expect(stale).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      expect(fixture.peerRows()).toEqual(rowsBefore);
      expect(fixture.inbound(event.id)).toEqual(inboundBefore);
      expect(assignments()).toEqual(assignmentsBefore);

      // Refused after the release, the hold and the carry have all run: the admission's own audit
      // row is the last write in the claim, and it fails.
      const run = fixture.harness.cp.db.run.bind(fixture.harness.cp.db);
      const refused: unknown[] = [];
      const spy = vi.spyOn(fixture.harness.cp.db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/^\s*INSERT INTO audit_events\b/.test(sql) && params[1] === "CANONICAL_SELF_CLAIM_ADMITTED") {
          refused.push(params[1]);
          throw new Error("injected audit insert failure: database or disk is full");
        }
        return run(sql, params);
      }) as typeof fixture.harness.cp.db.run);
      let late: Awaited<ReturnType<Fixture["claimAs"]>>;
      try {
        late = await fixture.claimAs(2);
      } finally {
        spy.mockRestore();
      }
      expect(refused).toEqual(["CANONICAL_SELF_CLAIM_ADMITTED"]);
      expect(late).toMatchObject({ allowed: false, reasonCode: ReasonCode.AUDIT_WRITE_FAILED });
      expect(fixture.peerRows()).toEqual(rowsBefore);
      expect(fixture.inbound(event.id)).toEqual(inboundBefore);
      expect(assignments()).toEqual(assignmentsBefore);
      expect(fixture.fences().filter((fence) => "fromSessionId" in fence)).toEqual([]);

      // Control: the same restart, unhindered, carries it.
      const successor = await restart(fixture, 2);
      expect(fixture.peerRows()[0]).toMatchObject({
        binding_generation: 2,
        target_session_id: successor.sessionId,
        reason_code: ReasonCode.OUTBOX_RETARGETED,
      });
    } finally {
      await fixture.close();
    }
  });
});
