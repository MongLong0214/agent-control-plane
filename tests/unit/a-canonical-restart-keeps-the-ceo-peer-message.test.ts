import Database from "better-sqlite3";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
import { SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { installMigrationLedger } from "../../src/db/migrations.ts";
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

interface CarryRow {
  message_id: string;
  outcome: "CARRIED" | "REFUSED";
  refusal: string | null;
  source_channel: string | null;
  source_nonce: string | null;
  role_key: string;
  from_session_id: string;
  from_session_incarnation: string;
  from_binding_generation: number;
  from_assignment_id: string;
  to_session_id: string;
  to_session_incarnation: string;
  to_binding_generation: number;
  to_assignment_id: string;
  actor_id: string;
  conversation_uuid: string;
  buzz_actor_id: string;
  recovery_audit_event_id: number;
  created_at: string;
}

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
    options: { expectedBindingGeneration?: number; room?: string; buzzActor?: Key } = {},
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
        canonicalSessions: [{ sessionUuid: CANON, projectId, buzzActorId: (options.buzzActor ?? cto).pubkey }],
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
    /** The exact holder tuple a session had at `generation`: what a late caller still presents. */
    holderAt: (sessionId: string, generation: number): HolderIdentity => ({
      roleKey: ctoRoleKey,
      bindingGeneration: generation,
      targetSessionId: sessionId,
      sessionIncarnation: harness.cp.sessions.require(sessionId).incarnation,
    }),
    carries: () =>
      harness.cp.db.all<CarryRow>(`SELECT * FROM peer_message_carries ORDER BY rowid`, []),
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

  /** The operator's dead-binding door releases generation 1, as an operator would run it. */
  const operatorReleases = (fixture: Fixture) => {
    const predecessor = fixture.harness.cp.sessions.require(fixture.first.sessionId);
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
    return predecessor;
  };

  it("(h) withholds the reviewer's forgery — raw retarget, forged recovery audit, OUTBOX_RETARGETED, no carry record — and writes nothing", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      await fixture.ceoSays("위조된 승계로 건네지면 안 되는 지시");
      const [queued] = fixture.peerRows();
      // The operator door releases generation 1: the row is rejected and its turn settled, and the
      // door's recovery record names the operator. The same conversation then restarts at
      // generation 2 — same actor, same Buzz identity — with nothing held and nothing carried.
      const predecessor = operatorReleases(fixture);
      expect(fixture.peerRows()[0]!.status).toBe("REJECTED");
      const successor = await restart(fixture, 2);

      // The forgery, in ordinary statements: the rejected row put back, addressed to the successor
      // and stamped OUTBOX_RETARGETED, and a DEAD_BINDING_RECOVERED row spelled as the self-claim's.
      const actorId = harness.cp.db.get<{ actor_id: string }>(
        `SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = 1`,
        [fixture.ctoRoleKey],
      )!.actor_id;
      harness.cp.db.run(
        `UPDATE outbox SET status = 'PENDING', binding_generation = 2, target_session_id = ?, reason_code = ?
          WHERE message_id = ?`,
        [successor.sessionId, ReasonCode.OUTBOX_RETARGETED, queued!.message_id],
      );
      harness.cp.db.run(
        `INSERT INTO audit_events (at, kind, reason_code, session_id, role_key, actor, evidence_json)
         VALUES (?, 'DEAD_BINDING_RECOVERED', 'OK', ?, ?, ?, ?)`,
        [
          harness.clock.nowIso(), predecessor.sessionId, fixture.ctoRoleKey, `canonical-self-claim:${actorId}`,
          JSON.stringify({
            assignmentId: fixture.first.binding.assignmentId,
            releasedGeneration: 1,
            sessionIncarnation: predecessor.incarnation,
            osPid: predecessor.osPid,
            liveness: "DEAD",
          }),
        ],
      );
      const forged = fixture.peerRows()[0];

      const before = fixture.writes();
      const taken = ownerMessageLedger(harness.cp).claim(fixture.holderOf(successor.sessionId));
      expect(taken.allowed, JSON.stringify(taken)).toBe(true);
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: queued!.message_id }],
      });
      expect(fixture.writes()).toBe(before);
      expect(fixture.peerRows()[0]).toEqual(forged);
      // Nothing a statement can write is a carry record, and none was written.
      expect(fixture.carries()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("(i) a carry record is refused to ordinary SQL, and once written is never updated, replaced or deleted", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const event = await fixture.ceoSays("기록으로만 건네지는 지시");
      const [queued] = fixture.peerRows();
      const successor = await restart(fixture, 2);

      // What the restart recorded binds every field of the succession and the admitted event.
      const recovery = harness.cp.db.get<{ event_id: number }>(
        `SELECT event_id FROM audit_events WHERE kind = 'DEAD_BINDING_RECOVERED' ORDER BY event_id DESC LIMIT 1`,
      )!;
      const actorId = harness.cp.db.get<{ actor_id: string }>(
        `SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = 1`,
        [fixture.ctoRoleKey],
      )!.actor_id;
      const [carried] = fixture.carries();
      expect(fixture.carries()).toHaveLength(1);
      expect(carried).toEqual({
        message_id: queued!.message_id,
        outcome: "CARRIED",
        refusal: null,
        source_channel: "buzz",
        source_nonce: buzzMessageNonce(event.id),
        role_key: fixture.ctoRoleKey,
        from_session_id: fixture.first.sessionId,
        from_session_incarnation: fixture.first.binding.sessionIncarnation,
        from_binding_generation: 1,
        from_assignment_id: fixture.first.binding.assignmentId,
        to_session_id: successor.sessionId,
        to_session_incarnation: successor.binding.sessionIncarnation,
        to_binding_generation: 2,
        to_assignment_id: successor.binding.assignmentId,
        actor_id: actorId,
        conversation_uuid: CANON,
        buzz_actor_id: fixture.cto.pubkey,
        recovery_audit_event_id: recovery.event_id,
        created_at: expect.any(String),
      });

      const columns = Object.keys(carried!);
      const insert = (verb: string, row: Record<string, unknown>) =>
        harness.cp.db.run(
          `${verb} INTO peer_message_carries (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((column) => row[column]),
        );
      // A record for another message, copying every field of a real one: refused.
      expect(() => insert("INSERT", { ...carried, message_id: "msg_forged" })).toThrow(/PEER_MESSAGE_CARRY_AUTHORITY_DENIED/);
      // A refusal notice is no easier to forge.
      expect(() => insert("INSERT", { ...carried, outcome: "REFUSED", refusal: "ALREADY_CLAIMED" }))
        .toThrow(/PEER_MESSAGE_CARRY_AUTHORITY_DENIED/);
      // REPLACE of the real record, retargeted to another session: refused.
      expect(() => insert("INSERT OR REPLACE", { ...carried, to_session_id: "sess_elsewhere" }))
        .toThrow(/PEER_MESSAGE_CARRY_(AUTHORITY_DENIED|NO_REPLACE)/);
      // UPDATE and DELETE: refused.
      expect(() => harness.cp.db.run(
        `UPDATE peer_message_carries SET to_session_id = 'sess_elsewhere' WHERE message_id = ?`, [queued!.message_id],
      )).toThrow(/PEER_MESSAGE_CARRY_IMMUTABLE/);
      expect(() => harness.cp.db.run(
        `DELETE FROM peer_message_carries WHERE message_id = ?`, [queued!.message_id],
      )).toThrow(/PEER_MESSAGE_CARRY_IMMUTABLE/);
      // And the marker cannot be raised without the self-claim's capability, inside a transaction or not.
      for (const counterfeit of [{}, { succession: { ...carried } }, null]) {
        expect(() => harness.cp.db.tx(() =>
          harness.cp.db.withPeerMessageCarry(counterfeit as never, () => insert("INSERT", { ...carried, message_id: "msg_forged" })),
        )).toThrow(/PEER_MESSAGE_CARRY_AUTHORITY_DENIED/);
      }
      expect(fixture.carries()).toEqual([carried]);
    } finally {
      await fixture.close();
    }
  });

  it("(j) refuses the old holder's late ACK, reject and claim after the carry; the message is claimed exactly once", async () => {
    const fixture = await startFixture();
    try {
      const ledger = ownerMessageLedger(fixture.harness.cp);
      await fixture.ceoSays("죽기 전에 건네진 지시");
      const oldHolder = fixture.holderOf(fixture.first.sessionId);
      const handed = ledger.claim(oldHolder);
      expect(handedOver(handed.allowed ? handed.value : null).claimed?.text).toBe("죽기 전에 건네진 지시");
      await fixture.ceoSays("재시작 뒤에 건네질 지시");
      const [sentBefore, queued] = fixture.peerRows();
      expect(sentBefore!.status).toBe("SENT");

      const successor = await restart(fixture, 2);
      // The one the dead holder was handed has an unknown outcome: rejected, never carried.
      expect(fixture.peerRows()[0]).toMatchObject({ message_id: sentBefore!.message_id, status: "REJECTED" });
      expect(fixture.peerRows()[1]).toMatchObject({
        message_id: queued!.message_id,
        status: "PENDING",
        binding_generation: 2,
        target_session_id: successor.sessionId,
      });

      // The old holder, late: every ACK, reject and claim it presents is refused and writes nothing.
      const rowsAfterRestart = fixture.peerRows();
      expect(ledger.complete(sentBefore!.message_id, oldHolder).allowed).toBe(false);
      expect(ledger.complete(queued!.message_id, oldHolder).allowed).toBe(false);
      expect(ledger.reject(queued!.message_id, oldHolder).allowed).toBe(false);
      const lateClaim = ledger.claim(oldHolder);
      expect(handedOver(lateClaim.allowed ? lateClaim.value : null)?.claimed ?? null).toBeNull();
      expect(fixture.peerRows()).toEqual(rowsAfterRestart);

      // The successor claims it once; the old holder's ACK after that is refused too.
      const newHolder = fixture.holderOf(successor.sessionId);
      const taken = ledger.claim(newHolder);
      expect(handedOver(taken.allowed ? taken.value : null).claimed).toMatchObject({
        messageId: queued!.message_id,
        text: "재시작 뒤에 건네질 지시",
      });
      expect(ledger.complete(queued!.message_id, oldHolder).allowed).toBe(false);
      expect(fixture.harness.cp.db.get<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM outbox WHERE message_id = ?`, [queued!.message_id],
      )).toEqual({ status: "SENT", attempts: 1 });
      expect(ledger.complete(queued!.message_id, newHolder).reasonCode).toBe(ReasonCode.OK);
      const again = ledger.claim(newHolder);
      expect(handedOver(again.allowed ? again.value : null).claimed).toBeNull();
      expect(fixture.harness.cp.db.get<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM outbox WHERE message_id = ?`, [queued!.message_id],
      )).toEqual({ status: "ACKED", attempts: 1 });
      expect(fixture.carries().filter((carry) => carry.outcome === "CARRIED")).toEqual([
        expect.objectContaining({ message_id: queued!.message_id, to_session_id: successor.sessionId }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("(k1) the carry run twice with the same capability carries the row once", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("두 번 옮겨지려는 지시");
      const [queued] = fixture.peerRows();
      const bindings = fixture.harness.cp.bindings;
      const carry = bindings.carryPeerMessagesToSameActorSuccessor.bind(bindings) as (...args: unknown[]) => unknown;
      const results: unknown[] = [];
      const spy = vi.spyOn(bindings, "carryPeerMessagesToSameActorSuccessor").mockImplementation(((...args: unknown[]) => {
        results.push(carry(...args));
        results.push(carry(...args));
        return results[0];
      }) as never);
      let successor: Awaited<ReturnType<typeof restart>>;
      try {
        successor = await restart(fixture, 2);
      } finally {
        spy.mockRestore();
      }
      expect(results).toEqual([
        { retargeted: [queued!.message_id], rejected: [] },
        { retargeted: [], rejected: [] },
      ]);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "PENDING", binding_generation: 2, target_session_id: successor.sessionId });
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome])).toEqual([[queued!.message_id, "CARRIED"]]);
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("(k2) a carry that lands between another carry's read and its write wins, and the loser leaves it alone", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("경합 중에 옮겨지는 지시");
      const [queued] = fixture.peerRows();
      const { db, bindings } = fixture.harness.cp;
      const carry = bindings.carryPeerMessagesToSameActorSuccessor.bind(bindings) as (...args: unknown[]) => unknown;
      let carryArgs: unknown[] | null = null;
      let raced = false;
      const carrySpy = vi.spyOn(bindings, "carryPeerMessagesToSameActorSuccessor").mockImplementation(((...args: unknown[]) => {
        carryArgs = args;
        return carry(...args);
      }) as never);
      const run = db.run.bind(db);
      const runSpy = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (!raced && carryArgs !== null &&
            /^\s*UPDATE outbox SET binding_generation = \?, target_session_id = \?, reason_code = \?/.test(sql)) {
          raced = true;
          // The competing carry of the same row, after this one decided to move it and before it does.
          carry(...carryArgs);
        }
        return run(sql, params);
      }) as typeof db.run);
      let successor: Awaited<ReturnType<typeof restart>>;
      try {
        successor = await restart(fixture, 2);
      } finally {
        runSpy.mockRestore();
        carrySpy.mockRestore();
      }
      expect(raced).toBe(true);
      // Exactly one carry happened, and the loser neither rejected it nor settled its turn.
      expect(fixture.peerRows()[0]).toMatchObject({
        status: "PENDING",
        binding_generation: 2,
        target_session_id: successor.sessionId,
        reason_code: ReasonCode.OUTBOX_RETARGETED,
      });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toBeUndefined();
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome])).toEqual([[queued!.message_id, "CARRIED"]]);
      const taken = ownerMessageLedger(fixture.harness.cp).claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null).claimed).toMatchObject({ messageId: queued!.message_id });
    } finally {
      await fixture.close();
    }
  });

  it("(k3) the database refuses a second CARRIED record for one message, even under the capability, and the claim rolls back whole", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("두 번 기록되려는 지시");
      const rowsBefore = fixture.peerRows();
      const inboundBefore = fixture.inbound(event.id);
      const { db } = fixture.harness.cp;
      const run = db.run.bind(db);
      let doubled = 0;
      const spy = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/INSERT INTO peer_message_carries/.test(sql) && params[1] === "CARRIED") {
          doubled += 1;
          run(sql, params);
        }
        return run(sql, params);
      }) as typeof db.run);
      let outcome: unknown;
      try {
        outcome = await fixture.claimAs(2).catch((error: unknown) => error);
      } finally {
        spy.mockRestore();
      }
      expect(doubled).toBe(1);
      expect(String(outcome instanceof Error ? outcome.message : JSON.stringify(outcome))).toMatch(/PEER_MESSAGE_CARRY_NO_REPLACE/);
      expect(fixture.peerRows()).toEqual(rowsBefore);
      expect(fixture.inbound(event.id)).toEqual(inboundBefore);
      expect(fixture.carries()).toEqual([]);

      // Control: unhindered, the same restart carries it once.
      const successor = await restart(fixture, 2);
      expect(fixture.peerRows()[0]).toMatchObject({ binding_generation: 2, target_session_id: successor.sessionId });
      expect(fixture.carries()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("(l) never carries an UNKNOWN, IN_DOUBT or already-claimed message, or one whose turn has a receipt", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      // UNKNOWN: the dead holder was handed it and never answered.
      await fixture.ceoSays("결과를 모르는 지시");
      ledger.claim(fixture.holderOf(fixture.first.sessionId));
      const inDoubtEvent = await fixture.ceoSays("전달 중이던 지시");
      const attemptedEvent = await fixture.ceoSays("한 번 시도된 지시");
      const receiptEvent = await fixture.ceoSays("이미 답이 정리된 지시");
      const cleanEvent = await fixture.ceoSays("깨끗하게 대기 중인 지시");
      const [unknown, inDoubt, attempted, settled, clean] = fixture.peerRows();
      expect(unknown!.status).toBe("SENT");
      // IN_DOUBT: claimed by a delivery attempt whose outcome nobody recorded.
      harness.cp.db.run(
        `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = 'tok-in-doubt', claimed_at = ? WHERE message_id = ?`,
        [harness.clock.nowIso(), inDoubt!.message_id],
      );
      // Already claimed once: PENDING again, but it was attempted.
      harness.cp.db.run(`UPDATE outbox SET attempts = 1 WHERE message_id = ?`, [attempted!.message_id]);
      // A receipt already exists for its turn.
      harness.cp.db.run(
        `UPDATE inbound_messages SET turn_claim_json = json_set(turn_claim_json, '$.noReplyAt', ?) WHERE channel = 'buzz' AND nonce = ?`,
        [harness.clock.nowIso(), buzzMessageNonce(receiptEvent.id)],
      );

      const successor = await restart(fixture, 2);
      const after = new Map(fixture.peerRows().map((row) => [row.message_id, row]));
      for (const row of [unknown, inDoubt, attempted, settled]) {
        expect(after.get(row!.message_id), row!.message_id).toMatchObject({
          status: "REJECTED",
          reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
          binding_generation: 1,
        });
      }
      expect(after.get(clean!.message_id)).toMatchObject({ status: "PENDING", binding_generation: 2, target_session_id: successor.sessionId });
      for (const event of [inDoubtEvent, attemptedEvent, receiptEvent]) {
        expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      }
      expect(fixture.turnClaim(cleanEvent.id)["noReplyAt"]).toBeUndefined();
      // Only the clean one carries; the two the hold took and refused are recorded as such.
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [attempted!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [settled!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [clean!.message_id, "CARRIED", null],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("(l2) a raw OUTBOX_RETARGETED mark admits nothing: with no carry record the row is refused, not carried", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("표시만 위조된 지시");
      const [queued] = fixture.peerRows();
      fixture.harness.cp.db.run(
        `UPDATE outbox SET reason_code = ? WHERE message_id = ?`,
        [ReasonCode.OUTBOX_RETARGETED, queued!.message_id],
      );
      await restart(fixture, 2);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "REJECTED", binding_generation: 1 });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [queued!.message_id, "REFUSED", "DIFFERENT_LINEAGE"],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("(m) never revives a message that was already REJECTED, even one a raw writer put back to PENDING", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const oldHolder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("이미 거절된 지시");
      await fixture.ceoSays("거절된 뒤 되살려진 지시");
      for (let i = 0; i < 2; i += 1) {
        const taken = ledger.claim(oldHolder);
        const claimed = handedOver(taken.allowed ? taken.value : null).claimed!;
        expect(ledger.reject(claimed.messageId, oldHolder).allowed).toBe(true);
      }
      const [rejected, revived] = fixture.peerRows();
      expect([rejected!.status, revived!.status]).toEqual(["REJECTED", "REJECTED"]);
      // A raw writer puts the second back as if it had never been handed over.
      harness.cp.db.run(
        `UPDATE outbox SET status = 'PENDING', attempts = 0, sent_at = NULL, reason_code = NULL WHERE message_id = ?`,
        [revived!.message_id],
      );

      const successor = await restart(fixture, 2);
      expect(fixture.peerRows()[0]).toEqual(rejected);
      expect(fixture.peerRows()[1]).toMatchObject({
        message_id: revived!.message_id,
        status: "REJECTED",
        binding_generation: 1,
        target_session_id: fixture.first.sessionId,
      });
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [revived!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
      const taken = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({ claimed: null, withheld: [] });
    } finally {
      await fixture.close();
    }
  });

  it("(n) shows the successor every message its restart refused to carry — by id, event and reason, never the text", async () => {
    // A different Buzz signer: the restarted conversation speaks as another identity.
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("다른 서명자에게는 건네지면 안 되는 지시");
      const [queued] = fixture.peerRows();
      fixture.harness.clock.advance(60_000);
      const claimed = await fixture.claimAs(2, { buzzActor: fixture.ceoNext });
      if (!claimed.allowed) throw new Error(`restart was refused: ${JSON.stringify(claimed)}`);
      const successor = claimed.value;
      expect(fixture.peerRows()[0]).toMatchObject({ status: "REJECTED", binding_generation: 1 });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));

      const taken = ownerMessageLedger(fixture.harness.cp).claim(fixture.holderOf(successor.sessionId));
      expect(taken.allowed, JSON.stringify(taken)).toBe(true);
      const handover = taken.allowed ? (taken.value as unknown as Record<string, unknown>) : {};
      expect(handover).toMatchObject({
        claimed: null,
        withheld: [],
        refusedAtRestart: [
          { messageId: queued!.message_id, sourceEventId: event.id, reason: "DIFFERENT_ACTOR_OR_SIGNER" },
        ],
      });
      expect(JSON.stringify(handover)).not.toContain("다른 서명자에게는");
      // Only that holder is told: the predecessor's tuple is shown nothing.
      const stale = ownerMessageLedger(fixture.harness.cp).claim(fixture.holderAt(fixture.first.sessionId, 1));
      expect((stale.allowed ? (stale.value as unknown as Record<string, unknown>) : {})["refusedAtRestart"]).toBeUndefined();
    } finally {
      await fixture.close();
    }

    // One hop only: the second restart refuses the row the first one carried, and says so.
    const twice = await startFixture();
    try {
      const event = await twice.ceoSays("두 번째 재시작에서 멈추는 지시");
      const [queued] = twice.peerRows();
      await restart(twice, 2);
      const third = await restart(twice, 3);
      expect(twice.peerRows()[0]).toMatchObject({ status: "REJECTED" });
      const taken = ownerMessageLedger(twice.harness.cp).claim(twice.holderOf(third.sessionId));
      expect(taken.allowed ? taken.value : null).toMatchObject({
        claimed: null,
        refusedAtRestart: [{ messageId: queued!.message_id, sourceEventId: event.id, reason: "ALREADY_CARRIED" }],
      });
    } finally {
      await twice.close();
    }
  });
});

describe("schema v40: the carry record arrives by an additive migration", () => {
  const statePath = (): string => {
    const root = join(tempDir("acp-carry-v40-"), "state");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o700);
    return join(root, "state.sqlite");
  };
  const NOW = "2026-10-03T19:28:00.000Z";
  const CARRY_TRIGGERS = [
    "peer_message_carries_immutable",
    "peer_message_carries_insert_authority",
    "peer_message_carries_no_delete",
    "peer_message_carries_no_replace",
  ];
  /** Every row of every table, by table, so a migration that touched any of them shows. */
  const dump = (raw: Database.Database, except: readonly string[]): Record<string, unknown[]> =>
    Object.fromEntries(
      (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[])
        .filter(({ name }) => !except.includes(name))
        .map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
    );
  /** A database written at the current version, with rows in it, taken back to `version`'s image. */
  const legacyImage = (version: 38 | 39, populateCarries = false): { path: string; before: Record<string, unknown[]> } => {
    const path = statePath();
    const db = openDb(path);
    db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, result_json)
       VALUES ('owner-reply-intent', 'turn:written-before-v40', 'cto', ?, ?, '{"status":"RECORDED"}')`,
      [NOW, JSON.stringify({ transport: "buzz", event: { id: "before-v40" } })],
    );
    db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('buzz', 'buzz-message:before-v40', 'ceo', ?)`,
      [NOW],
    );
    db.run(
      `INSERT INTO audit_events (at, kind, reason_code, actor, evidence_json) VALUES (?, 'WRITTEN_BEFORE_V40', 'OK', 'test', '{}')`,
      [NOW],
    );
    db.close();
    const legacy = new Database(path);
    legacy.exec(CARRY_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n"));
    if (populateCarries) {
      legacy.exec(`INSERT INTO peer_message_carries VALUES (
        'msg_unvouched', 'CARRIED', NULL, 'buzz', 'buzz-message:x', 'PRIMARY_CTO:p', 's1', 'i1', 1, 'a1',
        's2', 'i2', 2, 'a2', 'actor', 'uuid', 'buzz', 1, '${NOW}')`);
    } else {
      legacy.exec(`DROP INDEX peer_message_carries_by_successor; DROP TABLE peer_message_carries;`);
    }
    if (version === 38) {
      // v38 as it wrote its claim guards (live only beside a receipt at exactly 38), and no v39 key guard.
      const gated = legacy.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%WHERE version >= 38)%' ORDER BY name`,
      ).all() as { name: string; sql: string }[];
      expect(gated).toHaveLength(3);
      for (const trigger of gated) {
        legacy.exec(`DROP TRIGGER ${trigger.name}; ${trigger.sql.replace("WHERE version >= 38)", "WHERE version = 38)")};`);
      }
      legacy.exec(`DROP TRIGGER inbound_messages_owner_reply_key_immutable;`);
    }
    legacy.exec(`
      DROP TRIGGER schema_migrations_no_delete;
      DROP TRIGGER schema_migrations_insert_authority;
      DELETE FROM schema_migrations WHERE version > ${version};
      INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
        VALUES (${version}, 'bootstrap-v${version}', 'sha256:${"0".repeat(64)}', '${NOW}');
      PRAGMA user_version = ${version};
    `);
    installMigrationLedger(legacy);
    const before = dump(legacy, ["schema_migrations"]);
    legacy.close();
    return { path, before };
  };

  it("migrates a v38 database through v39 to v40, keeping every row, and the new record is guarded from the first", () => {
    const { path, before } = legacyImage(38);
    expect(Object.keys(before)).not.toContain("peer_message_carries");
    approveMigration(path, "ACP-PEER-SUCCESSION-01 v38 fixture");
    const migrated = openDb(path);
    try {
      expect(SCHEMA_VERSION).toBe(40);
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(40);
      expect(migrated.all<{ version: number; migration_id: string }>(
        `SELECT version, migration_id FROM schema_migrations WHERE version >= 38 ORDER BY version`,
      )).toEqual([
        { version: 38, migration_id: "bootstrap-v38" },
        { version: 39, migration_id: "v39-owner-reply-intent-keeps-its-key" },
        { version: 40, migration_id: "v40-peer-message-carry-record" },
      ]);
      expect(migrated.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'peer_message_carries' ORDER BY name`,
      ).map((row) => row.name)).toEqual(CARRY_TRIGGERS);
      expect(migrated.get<{ n: number }>(`SELECT COUNT(*) AS n FROM peer_message_carries`)?.n).toBe(0);
      expect(() => migrated.run(
        `INSERT INTO peer_message_carries VALUES (
          'msg_forged', 'CARRIED', NULL, 'buzz', 'buzz-message:x', 'PRIMARY_CTO:p', 's1', 'i1', 1, 'a1',
          's2', 'i2', 2, 'a2', 'actor', 'uuid', 'buzz', 1, ?)`, [NOW],
      )).toThrow(/PEER_MESSAGE_CARRY_AUTHORITY_DENIED/);
      // v39's own guard arrived on the way.
      expect(() => migrated.run(
        `UPDATE inbound_messages SET nonce = nonce || ':moved' WHERE channel = 'owner-reply-intent'`,
      )).toThrow(/INBOUND_OWNER_REPLY_KEY_IMMUTABLE/u);
    } finally {
      migrated.close();
    }
    const after = new Database(path, { readonly: true });
    try {
      expect(dump(after, ["schema_migrations", "peer_message_carries"])).toEqual(before);
    } finally {
      after.close();
    }
  });

  it("refuses a v39 image whose carry table already holds a record nothing vouched for, and restores it", () => {
    const { path, before } = legacyImage(39, true);
    approveMigration(path, "ACP-PEER-SUCCESSION-01 populated fixture");
    expect(() => openDb(path)).toThrow(/migration failed; the original database was restored/);
    const restored = new Database(path, { readonly: true });
    try {
      expect(Number(restored.pragma("user_version", { simple: true }))).toBe(39);
      expect(dump(restored, ["schema_migrations"])).toEqual(before);
    } finally {
      restored.close();
    }
  });
});
