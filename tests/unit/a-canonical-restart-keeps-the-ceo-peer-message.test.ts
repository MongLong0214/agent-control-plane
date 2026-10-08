import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionEvent,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { digestOf } from "../../src/core/digest.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { installMigrationLedger } from "../../src/db/migrations.ts";
import {
  ownerMessageLedger,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
  startLocalMcpListeners,
} from "../../src/daemon/agentcpd.ts";
import { createCtoBindingRuntime } from "../../src/daemon/cto-binding-runtime.ts";
import { type DaemonNoticeBody, deliverOwedPeerMessageNotices } from "../../src/runtime/acp-daemon-notice.ts";
import { runBoundedChild } from "../helpers/bounded-child.ts";
import { recoverDeadCanonicalBinding } from "../../src/daemon/dead-binding-recovery.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { type HolderIdentity, Outbox } from "../../src/outbox/outbox.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun, tempDir } from "../helpers/fixtures.ts";
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
  source_payload_digest: string | null;
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
      // The table is WITHOUT ROWID, so its write order is the record time, then the outbox queue order.
      harness.cp.db.all<CarryRow>(
        `SELECT c.* FROM peer_message_carries c LEFT JOIN outbox o ON o.message_id = c.message_id
          ORDER BY c.created_at, o.created_at, o.rowid, c.outcome`,
        [],
      ),
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
        source_payload_digest: digestOf(JSON.parse(fixture.inbound(event.id).payload_json)),
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

  /** The ingress row of one admitted Buzz event, whole. */
  const admittedRow = (fixture: Fixture, eventId: string) =>
    fixture.harness.cp.db.get<{ actor: string; received_at: string; payload_json: string; turn_claim_json: string | null }>(
      `SELECT actor, received_at, payload_json, turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
      [buzzMessageNonce(eventId)],
    )!;

  /**
   * The reviewer's ACP-RESTART-02 substitution, in ordinary statements: the admitted row moved off
   * its key, other words inserted at the vacated key, and the outbox pointer's digest rewritten to
   * match them. Each step's refusal is returned rather than thrown, so the hand-over is asked either
   * way.
   */
  const substitute = (fixture: Fixture, eventId: string, messageId: string, text: string): string[] => {
    const { db } = fixture.harness.cp;
    const nonce = buzzMessageNonce(eventId);
    const original = admittedRow(fixture, eventId);
    const forged = { ...(JSON.parse(original.payload_json) as Record<string, unknown>), text };
    const refused: string[] = [];
    const attempt = (sql: string, params: unknown[]) => {
      try {
        db.run(sql, params);
      } catch (error) {
        refused.push(String((error as Error).message));
      }
    };
    attempt(`UPDATE inbound_messages SET nonce = nonce || ':moved' WHERE channel = 'buzz' AND nonce = ?`, [nonce]);
    attempt(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('buzz', ?, ?, ?, ?)`,
      [nonce, original.actor, original.received_at, JSON.stringify(forged)],
    );
    attempt(
      `UPDATE outbox SET payload_json = json_set(payload_json, '$.sourcePayloadDigest', ?) WHERE message_id = ?`,
      [digestOf(forged), messageId],
    );
    return refused;
  };

  it("(o) ACP-RESTART-02: the reviewer's substitution after a genuine carry is refused — the moved key, and the bytes the carry record does not name", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const event = await fixture.ceoSays("원래의 CEO 지시");
      const [queued] = fixture.peerRows();
      const successor = await restart(fixture, 2);
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(successor.sessionId);

      // The reviewer's witness, through the ordinary statement path. The move is refused, so the
      // key is never vacated and the insert of other words at it is refused too; only the outbox
      // pointer's digest (finding 01's raw-writable column) is rewritten, which withholds the row.
      const admittedBefore = admittedRow(fixture, event.id);
      const refused = substitute(fixture, event.id, queued!.message_id, "바꿔치기된 지시");
      const before = fixture.writes();
      const taken = ledger.claim(holder);
      expect(handedOver(taken.allowed ? taken.value : null).claimed?.text).not.toBe("바꿔치기된 지시");
      expect(refused).toEqual([
        expect.stringMatching(/INBOUND_BUZZ_SOURCE_KEY_IMMUTABLE/),
        expect.stringMatching(/INBOUND_MESSAGE_NO_REPLACE/),
      ]);
      expect(admittedRow(fixture, event.id)).toEqual(admittedBefore);
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: queued!.message_id }],
      });
      expect(fixture.writes()).toBe(before);
      // The record names the admitted bytes, read from the admitted row.
      expect(fixture.carries()).toEqual([expect.objectContaining({
        outcome: "CARRIED",
        source_payload_digest: digestOf(JSON.parse(admittedBefore.payload_json)),
      })]);
    } finally {
      await fixture.close();
    }

    // The record's digest holds on its own: a writer that got past the key guard — here, a second
    // connection that drops it — substitutes the bytes, and the hand-over still refuses them.
    const past = await startFixture();
    try {
      const { harness } = past;
      const event = await past.ceoSays("키 가드 뒤에서도 지켜지는 지시");
      const [queued] = past.peerRows();
      const successor = await restart(past, 2);
      const side = new Database(harness.cp.db.file);
      try {
        side.exec(`DROP TRIGGER inbound_messages_buzz_source_key_immutable`);
      } finally {
        side.close();
      }
      expect(substitute(past, event.id, queued!.message_id, "가드를 넘어 바꿔치기된 지시")).toEqual([]);
      const before = past.writes();
      const taken = ownerMessageLedger(harness.cp).claim(past.holderOf(successor.sessionId));
      expect(taken.allowed, JSON.stringify(taken)).toBe(true);
      expect(handedOver(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: queued!.message_id }],
      });
      expect(past.writes()).toBe(before);
      expect(past.peerRows()[0]!.status).toBe("PENDING");
    } finally {
      await past.close();
    }
  });

  it("(o2) ACP-RESTART-02: the carry record's insert trigger checks its digest against the admitted row — other bytes are refused even under the capability", async () => {
    const fixture = await startFixture();
    try {
      const event = await fixture.ceoSays("다이제스트로 묶이는 지시");
      const rowsBefore = fixture.peerRows();
      const inboundBefore = fixture.inbound(event.id);
      const { db } = fixture.harness.cp;
      const run = db.run.bind(db);
      let swapped = 0;
      const spy = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/INSERT INTO peer_message_carries/.test(sql) && params[1] === "CARRIED") {
          swapped += 1;
          return run(sql, params.map((value, index) => (index === 5 ? digestOf({ text: "다른 바이트" }) : value)));
        }
        return run(sql, params);
      }) as typeof db.run);
      let outcome: unknown;
      try {
        outcome = await fixture.claimAs(2).catch((error: unknown) => error);
      } finally {
        spy.mockRestore();
      }
      expect(swapped).toBe(1);
      expect(String(outcome instanceof Error ? outcome.message : JSON.stringify(outcome))).toMatch(/PEER_MESSAGE_CARRY_AUTHORITY_DENIED/);
      expect(fixture.peerRows()).toEqual(rowsBefore);
      expect(fixture.inbound(event.id)).toEqual(inboundBefore);
      expect(fixture.carries()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  /** Writes a receipt's settlement onto one admitted turn, as the receipt path would. */
  const settleReceipt = (fixture: Fixture, eventId: string, settlement: "REPLY_OUTBOX" | "UNANSWERABLE" | "UNRESOLVED") =>
    fixture.harness.cp.db.run(
      `UPDATE inbound_messages
          SET turn_claim_json = json_set(turn_claim_json, '$.settledAt', ?, '$.settlement', ?)
        WHERE channel = 'buzz' AND nonce = ?`,
      [fixture.harness.clock.nowIso(), settlement, buzzMessageNonce(eventId)],
    );

  it("(p) ACP-RESTART-03: a restart with a queued message whose turn a receipt already settled completes, refuses the row and keeps the receipt", async () => {
    for (const settlement of ["REPLY_OUTBOX", "UNANSWERABLE", "UNRESOLVED"] as const) {
      const fixture = await startFixture();
      try {
        const event = await fixture.ceoSays(`${settlement} 로 정리된 지시`);
        const [queued] = fixture.peerRows();
        settleReceipt(fixture, event.id, settlement);
        const receipt = fixture.inbound(event.id);

        fixture.harness.clock.advance(60_000);
        const claimed = await fixture.claimAs(2).catch((error: unknown) => error);
        expect(claimed, String(claimed instanceof Error ? claimed.message : "")).toMatchObject({ allowed: true });
        const successor = (claimed as { value: { sessionId: string; binding: { bindingGeneration: number } } }).value;
        expect(successor.binding.bindingGeneration).toBe(2);
        expect(fixture.harness.cp.bindings.active(fixture.ctoRoleKey)?.sessionId).toBe(successor.sessionId);
        expect(fixture.peerRows()[0]).toMatchObject({
          message_id: queued!.message_id,
          status: "REJECTED",
          reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
          binding_generation: 1,
        });
        // The receipt stands exactly as it was: no no-reply fact written beside it.
        expect(fixture.inbound(event.id)).toEqual(receipt);
        expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
          [queued!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        ]);
        expect(noticesFor(fixture, fixture.holderOf(successor.sessionId))).toEqual([
          expect.objectContaining({ messageId: queued!.message_id, reason: "ALREADY_CLAIMED" }),
        ]);
      } finally {
        await fixture.close();
      }
    }
  });

  it("(p2) ACP-RESTART-03: the ordinary fences — revoke, takeover, runtime move, the stranded-SENT sweep — keep a settled receipt too", async () => {
    for (const path of ["revoke", "takeover", "runtime-move", "sweep"] as const) {
      const fixture = await startFixture();
      try {
        const { harness } = fixture;
        const event = await fixture.ceoSays(`${path} 전에 정리된 지시`);
        const [queued] = fixture.peerRows();
        if (path === "sweep") {
          const taken = ownerMessageLedger(harness.cp).claim(fixture.holderOf(fixture.first.sessionId));
          expect(handedOver(taken.allowed ? taken.value : null).claimed?.messageId).toBe(queued!.message_id);
        }
        settleReceipt(fixture, event.id, "REPLY_OUTBOX");
        const receipt = fixture.inbound(event.id);
        const other = () => {
          const session = harness.cp.sessions.create({ provider: "scripted", model: "cto-other", buzzAddress: PROJECT_ROOM });
          expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
          return session;
        };
        const run = (): unknown => {
          switch (path) {
            case "revoke":
              return harness.cp.bindings.revoke(fixture.ctoRoleKey, "operator stop");
            case "takeover":
            case "runtime-move":
              return harness.cp.bindings.switchTo({
                role: Role.PRIMARY_CTO,
                projectId: fixture.projectId,
                sessionId: other().sessionId,
                reason: path,
                conversation: path === "takeover" ? "REPLACED" : "SURVIVED",
              });
            case "sweep":
              harness.cp.db.run(`UPDATE sessions SET lifecycle = 'STOPPED' WHERE session_id = ?`, [fixture.first.sessionId]);
              return { allowed: harness.cp.outbox.fenceUndeliverable() === 1 };
          }
        };
        const outcome = (() => {
          try {
            return run();
          } catch (error) {
            return error;
          }
        })();
        expect(outcome, `${path}: ${outcome instanceof Error ? outcome.message : JSON.stringify(outcome)}`)
          .toMatchObject({ allowed: true });
        expect(fixture.peerRows()[0], path).toMatchObject({ message_id: queued!.message_id, status: "REJECTED" });
        expect(fixture.inbound(event.id), path).toEqual(receipt);
      } finally {
        await fixture.close();
      }
    }
  });

  /** The notices the role's current holder is shown, as `role_owner_message_claim` returns them. */
  const noticesFor = (fixture: Fixture, holder: HolderIdentity): unknown => {
    const taken = ownerMessageLedger(fixture.harness.cp).claim(holder);
    expect(taken.allowed, JSON.stringify(taken)).toBe(true);
    return (taken.allowed ? (taken.value as unknown as Record<string, unknown>) : {})["refusedAtRestart"];
  };

  it("(q) ACP-RESTART-04: a plain revoke, then a canonical restart — the new holder is told, until it reports it", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const event = await fixture.ceoSays("철회로 거절된 지시");
      const [queued] = fixture.peerRows();
      expect(harness.cp.bindings.revoke(fixture.ctoRoleKey, "operator stop").allowed).toBe(true);
      expect(fixture.peerRows()[0]!.status).toBe("REJECTED");
      const successor = await restart(fixture, 2);

      const notice = {
        messageId: queued!.message_id,
        sourceEventId: event.id,
        sender: fixture.ceo.pubkey,
        reason: "REVOKED",
      };
      const holder = fixture.holderOf(successor.sessionId);
      expect(noticesFor(fixture, holder)).toEqual([notice]);
      expect(JSON.stringify(noticesFor(fixture, holder))).not.toContain("철회로 거절된");
      // Shown again until reported; a former holder's tuple is shown nothing and cannot report.
      expect(noticesFor(fixture, holder)).toEqual([notice]);
      expect(noticesFor(fixture, fixture.holderAt(fixture.first.sessionId, 1))).toBeUndefined();
      const ledger = ownerMessageLedger(harness.cp);
      expect(ledger.reportRefusal(queued!.message_id, fixture.holderAt(fixture.first.sessionId, 1)).allowed).toBe(false);
      expect(ledger.reportRefusal("msg_nothing_owed", holder).reasonCode).toBe(ReasonCode.NOT_FOUND);

      // The holder reports it: retired for it and for every later holder; a repeat is OK.
      expect(ledger.reportRefusal(queued!.message_id, holder).reasonCode).toBe(ReasonCode.OK);
      expect(ledger.reportRefusal(queued!.message_id, holder).reasonCode).toBe(ReasonCode.OK);
      expect(noticesFor(fixture, holder)).toBeUndefined();
      const third = await restart(fixture, 3);
      expect(noticesFor(fixture, fixture.holderOf(third.sessionId))).toBeUndefined();

      // The entries are evidence: ordinary SQL can neither forge, rewrite nor remove one.
      const entries = harness.cp.db.all<Record<string, unknown>>(
        `SELECT * FROM peer_message_refusal_notices ORDER BY created_at, message_id, entry`,
      );
      expect(entries.map((entry) => [entry["message_id"], entry["entry"], entry["reason"]])).toEqual([
        [queued!.message_id, "OWED", "REVOKED"],
        [queued!.message_id, "REPORTED", null],
      ]);
      const columns = Object.keys(entries[0]!);
      const insert = (row: Record<string, unknown>) => harness.cp.db.run(
        `INSERT INTO peer_message_refusal_notices (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        columns.map((column) => row[column]),
      );
      expect(() => insert({ ...entries[0], message_id: "msg_forged" })).toThrow(/PEER_MESSAGE_NOTICE_AUTHORITY_DENIED/);
      expect(() => harness.cp.db.run(`UPDATE peer_message_refusal_notices SET reason = 'REPLACED'`))
        .toThrow(/PEER_MESSAGE_NOTICE_IMMUTABLE/);
      expect(() => harness.cp.db.run(`DELETE FROM peer_message_refusal_notices WHERE entry = 'REPORTED'`))
        .toThrow(/PEER_MESSAGE_NOTICE_IMMUTABLE/);
      for (const counterfeit of [{}, { entry: entries[0] }, null]) {
        expect(() => harness.cp.db.tx(() =>
          harness.cp.db.withPeerMessageNotice(counterfeit as never, () => insert({ ...entries[0], message_id: "msg_forged" })),
        )).toThrow(/PEER_MESSAGE_NOTICE_AUTHORITY_DENIED/);
      }
    } finally {
      await fixture.close();
    }
  });

  it("(q2) ACP-RESTART-04: a takeover, the operator's door and a runtime move each leave the next holder a notice", async () => {
    for (const path of ["takeover", "operator", "runtime-move"] as const) {
      const fixture = await startFixture();
      try {
        const { harness } = fixture;
        const event = await fixture.ceoSays(`${path} 로 거절된 지시`);
        const [queued] = fixture.peerRows();
        let next: HolderIdentity;
        if (path === "operator") {
          operatorReleases(fixture);
          next = fixture.holderOf((await restart(fixture, 2)).sessionId);
        } else {
          const other = harness.cp.sessions.create({ provider: "scripted", model: "cto-other", buzzAddress: PROJECT_ROOM });
          expect(harness.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
          const switched = harness.cp.bindings.switchTo({
            role: Role.PRIMARY_CTO,
            projectId: fixture.projectId,
            sessionId: other.sessionId,
            reason: path,
            conversation: path === "takeover" ? "REPLACED" : "SURVIVED",
          });
          expect(switched.allowed, JSON.stringify(switched)).toBe(true);
          next = fixture.holderOf(other.sessionId);
        }
        expect(fixture.peerRows()[0]!.status, path).toBe("REJECTED");
        expect(noticesFor(fixture, next), path).toEqual([{
          messageId: queued!.message_id,
          sourceEventId: event.id,
          sender: fixture.ceo.pubkey,
          reason: { takeover: "REPLACED", operator: "REVOKED", "runtime-move": "RUNTIME_MOVED" }[path],
        }]);
      } finally {
        await fixture.close();
      }
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
  /** v40's other objects (ACP-RESTART-02, -04): the notices and their guards, and the Buzz key guard. */
  const NOTICE_TRIGGERS = [
    "peer_message_refusal_notices_immutable",
    "peer_message_refusal_notices_insert_authority",
    "peer_message_refusal_notices_no_delete",
    "peer_message_refusal_notices_no_replace",
  ];
  /** v40's finding-04 delivery record's guards (acp-daemon-notice/v1). */
  const DELIVERY_TRIGGERS = [
    "peer_message_notice_deliveries_immutable",
    "peer_message_notice_deliveries_insert_authority",
    "peer_message_notice_deliveries_no_delete",
    "peer_message_notice_deliveries_no_replace",
  ];
  /** v40's finding-01 triggers: the departure records' guards and the triggers that write them. */
  const DEPARTURE_TRIGGERS = [
    "holder_message_departures_immutable",
    "holder_message_departures_no_delete",
    "holder_message_departures_no_replace",
    "holder_message_source_departures_immutable",
    "holder_message_source_departures_no_delete",
    "holder_message_source_departures_no_replace",
    "inbound_messages_turn_terminal_departs",
    "inbound_messages_turn_terminal_departs_on_insert",
    "outbox_departed_no_delete",
    "outbox_holder_message_departs",
    "outbox_holder_message_source_departs",
    "outbox_message_id_immutable",
  ];
  /** Every row of every table, by table, so a migration that touched any of them shows. */
  const dump = (raw: Database.Database, except: readonly string[]): Record<string, unknown[]> =>
    Object.fromEntries(
      (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[])
        .filter(({ name }) => !except.includes(name))
        // Sorted here, not by rowid: v40's record tables are WITHOUT ROWID.
        .map(({ name }) => [name, (raw.prepare(`SELECT * FROM "${name}"`).all() as unknown[])
          .map((row) => JSON.stringify(row)).sort()]),
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
    // Finding 01's departure records, their outbox and ingress triggers and the id guard: v40's too.
    legacy.exec(`${DEPARTURE_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n")}
      DROP TABLE holder_message_departures; DROP TABLE holder_message_source_departures;`);
    // And finding 04's delivery record, which v39 did not have either.
    legacy.exec(`${DELIVERY_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n")}
      DROP TABLE peer_message_notice_deliveries;`);
    legacy.exec(`${NOTICE_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n")}
      DROP INDEX peer_message_refusal_notices_by_role; DROP TABLE peer_message_refusal_notices;
      DROP TRIGGER inbound_messages_buzz_source_key_immutable;`);
    if (populateCarries) {
      legacy.exec(`INSERT INTO peer_message_carries VALUES (
        'msg_unvouched', 'CARRIED', NULL, 'buzz', 'buzz-message:x', 'sha256:x', 'PRIMARY_CTO:p', 's1', 'i1', 1, 'a1',
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
    expect(Object.keys(before)).not.toContain("peer_message_refusal_notices");
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
      expect(migrated.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'peer_message_refusal_notices' ORDER BY name`,
      ).map((row) => row.name)).toEqual(NOTICE_TRIGGERS);
      expect(migrated.get<{ n: number }>(`SELECT COUNT(*) AS n FROM peer_message_refusal_notices`)?.n).toBe(0);
      // Finding 04's delivery record arrives guarded and empty.
      expect(migrated.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'peer_message_notice_deliveries' ORDER BY name`,
      ).map((row) => row.name)).toEqual(DELIVERY_TRIGGERS);
      expect(migrated.get<{ n: number }>(`SELECT COUNT(*) AS n FROM peer_message_notice_deliveries`)?.n).toBe(0);
      // ACP-RESTART-02: the Buzz row written before v40 keeps its key from v40 on.
      expect(() => migrated.run(
        `UPDATE inbound_messages SET nonce = nonce || ':moved' WHERE channel = 'buzz'`,
      )).toThrow(/INBOUND_BUZZ_SOURCE_KEY_IMMUTABLE/u);
      expect(() => migrated.run(
        `INSERT INTO peer_message_carries VALUES (
          'msg_forged', 'CARRIED', NULL, 'buzz', 'buzz-message:x', 'sha256:x', 'PRIMARY_CTO:p', 's1', 'i1', 1, 'a1',
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
      expect(dump(after, ["schema_migrations", "peer_message_carries", "peer_message_refusal_notices",
        "holder_message_departures", "holder_message_source_departures", "peer_message_notice_deliveries"]))
        .toEqual(before);
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

  it("W4 finding 01: a v39 database's rows outside PENDING get a BACKFILL departure, exactly those, of every kind", () => {
    const { path } = legacyImage(39);
    const legacy = new Database(path);
    // The v38 claim guard names this function; SQLite resolves it whenever an inbound row is inserted.
    legacy.function("acp_ingress_claim_authorized", { varargs: true }, () => 0);
    // `legacyImage` already took away the departure objects v39 did not have.
    const row = legacy.prepare(
      `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation, target_session_id, kind,
                           payload_json, payload_digest, request_fingerprint, expires_at, created_at, status)
       VALUES (?, ?, 'PRIMARY_CTO:p', 1, 'sess_cto', ?, ?, 'sha256:x', ?, ?, ?, ?)`,
    );
    /** A holder-claimed row's payload: the pointer to its admitted Buzz event. */
    const pointer = (id: string): string =>
      JSON.stringify({ sourceChannel: "buzz", sourceNonce: `buzz-message:${id}`, sourcePayloadDigest: "sha256:x" });
    const rows: Array<[string, MessageKind, string]> = [
      ["msg_peer_sent", MessageKind.PEER_MESSAGE, "SENT"],
      ["msg_owner_acked", MessageKind.OWNER_MESSAGE, "ACKED"],
      ["msg_peer_pending", MessageKind.PEER_MESSAGE, "PENDING"],
      ["msg_owner_pending", MessageKind.OWNER_MESSAGE, "PENDING"],
      // Not holder-claimed: recorded all the same, since the kind is no more fixed than the status.
      ["msg_dispatch_sent", MessageKind.RUN_DISPATCH, "SENT"],
      ["msg_dispatch_pending", MessageKind.RUN_DISPATCH, "PENDING"],
    ];
    for (const [id, kind, status] of rows) {
      row.run(id, `key:${id}`, kind, kind === MessageKind.RUN_DISPATCH ? "{}" : pointer(id), `fp:${id}`, NOW, NOW, status);
    }
    // An admitted Buzz event whose turn was already answered, and one still open.
    const inbound = legacy.prepare(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json) VALUES ('buzz', ?, 'ceo', ?, ?)`,
    );
    inbound.run("buzz-message:answered", NOW, JSON.stringify({ turnRequestId: "msg_answered", noReplyAt: NOW }));
    inbound.run("buzz-message:open", NOW, JSON.stringify({ turnRequestId: "msg_open" }));
    expect(legacy.prepare(
      `SELECT name FROM sqlite_master
        WHERE name IN (${[...DEPARTURE_TRIGGERS, "holder_message_departures", "holder_message_source_departures"]
          .map((name) => `'${name}'`).join(", ")})`,
    ).all()).toEqual([]);
    const before = dump(legacy, ["schema_migrations"]);
    legacy.close();

    approveMigration(path, "finding 01 v39 backfill fixture");
    const migrated = openDb(path);
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(40);
      expect(migrated.all(`SELECT * FROM holder_message_departures ORDER BY message_id`)).toEqual([
        { message_id: "msg_dispatch_sent", from_status: null, to_status: "SENT", departed_at: expect.any(String), basis: "BACKFILL" },
        { message_id: "msg_owner_acked", from_status: null, to_status: "ACKED", departed_at: expect.any(String), basis: "BACKFILL" },
        { message_id: "msg_peer_sent", from_status: null, to_status: "SENT", departed_at: expect.any(String), basis: "BACKFILL" },
      ]);
      // The events: once per handed-over pointer (the generic row names none), and the answered turn.
      expect(migrated.all(
        `SELECT source_channel, source_nonce, reason, message_id, basis FROM holder_message_source_departures
          ORDER BY source_nonce, reason`,
      )).toEqual([
        { source_channel: "buzz", source_nonce: "buzz-message:answered", reason: "TURN_TERMINAL", message_id: null, basis: "BACKFILL" },
        { source_channel: "buzz", source_nonce: "buzz-message:msg_owner_acked", reason: "MESSAGE_DEPARTED", message_id: "msg_owner_acked", basis: "BACKFILL" },
        { source_channel: "buzz", source_nonce: "buzz-message:msg_peer_sent", reason: "MESSAGE_DEPARTED", message_id: "msg_peer_sent", basis: "BACKFILL" },
      ]);
      expect(migrated.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${DEPARTURE_TRIGGERS
          .map((name) => `'${name}'`).join(", ")}) ORDER BY name`,
      ).map((trigger) => trigger.name)).toEqual(DEPARTURE_TRIGGERS);
    } finally {
      migrated.close();
    }
    // Every v39 row is kept as it was; only the new table has rows.
    const after = new Database(path, { readonly: true });
    try {
      expect(dump(after, ["schema_migrations", "holder_message_departures", "holder_message_source_departures",
        "peer_message_carries", "peer_message_refusal_notices", "peer_message_notice_deliveries"])).toEqual(before);
    } finally {
      after.close();
    }
    // And from v40 on, a PENDING row that leaves PENDING is recorded as it happens.
    const reopened = openDb(path);
    try {
      reopened.run(`UPDATE outbox SET status = 'SENT' WHERE message_id = 'msg_peer_pending'`);
      reopened.run(`UPDATE outbox SET status = 'IN_FLIGHT' WHERE message_id = 'msg_dispatch_pending'`);
      // Leaving a status other than PENDING records nothing new, and a second departure is not tried.
      reopened.run(`UPDATE outbox SET status = 'REJECTED' WHERE message_id = 'msg_dispatch_sent'`);
      reopened.run(`UPDATE outbox SET status = 'PENDING' WHERE message_id = 'msg_dispatch_pending'`);
      reopened.run(`UPDATE outbox SET status = 'IN_FLIGHT' WHERE message_id = 'msg_dispatch_pending'`);
      expect(reopened.all(
        `SELECT message_id, from_status, to_status, basis FROM holder_message_departures
          WHERE basis = 'TRANSITION' ORDER BY message_id`,
      )).toEqual([
        { message_id: "msg_dispatch_pending", from_status: "PENDING", to_status: "IN_FLIGHT", basis: "TRANSITION" },
        { message_id: "msg_peer_pending", from_status: "PENDING", to_status: "SENT", basis: "TRANSITION" },
      ]);
      expect(reopened.all(
        `SELECT source_nonce, reason, message_id FROM holder_message_source_departures WHERE basis = 'TRANSITION'`,
      )).toEqual([{ source_nonce: "buzz-message:msg_peer_pending", reason: "MESSAGE_DEPARTED", message_id: "msg_peer_pending" }]);
    } finally {
      reopened.close();
    }
  });
});

/**
 * Review finding 01. The carry and the hand-over decided "never claimed" from the outbox row's own
 * status, attempts, sent_at and claim_token — columns any statement can put back. A raw writer could
 * therefore return a claimed or settled peer message to PENDING, and the restart carried the CEO's
 * words to the successor, or the same holder was handed them a second time. Schema v40's
 * `holder_message_departures` records the first departure from PENDING for every writer, and every
 * hand-over path refuses a message that has one.
 */
describe("finding 01: a holder-claimed message that ever left PENDING is never handed over again", () => {
  /** What a raw writer does to make a claimed row read as one nobody was ever handed. */
  const putBack = (fixture: Fixture, messageId: string): void => {
    fixture.harness.cp.db.run(
      `UPDATE outbox SET status = 'PENDING', attempts = 0, sent_at = NULL, acked_at = NULL,
                         claim_token = NULL, claimed_at = NULL, reason_code = NULL
        WHERE message_id = ?`,
      [messageId],
    );
  };
  const rowOf = (fixture: Fixture, messageId: string) =>
    fixture.harness.cp.db.get<Record<string, unknown>>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
  const carried = (fixture: Fixture) => fixture.carries().filter((carry) => carry.outcome === "CARRIED");
  const refusals = (fixture: Fixture) =>
    fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal]);

  it("records a departure for every kind: the trigger and the backfill name no kind at all", () => {
    // The kind is as rewritable as the status (W7), so a filter on it is a way around the record.
    const schema = readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8");
    const trigger = /CREATE TRIGGER IF NOT EXISTS outbox_holder_message_departs\n[\s\S]*?\nEND;/.exec(schema)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).not.toMatch(/\bkind\b/);
    const migrations = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
    const backfill = /INSERT INTO holder_message_departures[\s\S]*?`\);/.exec(migrations)?.[0];
    expect(backfill).toBeDefined();
    expect(backfill).not.toMatch(/\bkind\b/);
  });

  it("W1a a claimed (SENT) peer message put back to PENDING by raw SQL is not carried; the successor gets nothing", async () => {
    const fixture = await startFixture();
    try {
      const ledger = ownerMessageLedger(fixture.harness.cp);
      await fixture.ceoSays("건네진 뒤 되돌려진 지시");
      const [queued] = fixture.peerRows();
      const taken = ledger.claim(fixture.holderOf(fixture.first.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null).claimed?.messageId).toBe(queued!.message_id);
      putBack(fixture, queued!.message_id);
      expect(rowOf(fixture, queued!.message_id)).toMatchObject({
        status: "PENDING", attempts: 0, sent_at: null, claim_token: null,
      });

      const successor = await restart(fixture, 2);

      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture)).toEqual([[queued!.message_id, "REFUSED", "ALREADY_CLAIMED"]]);
      expect(fixture.peerRows()[0]).toMatchObject({
        status: "REJECTED", binding_generation: 1, target_session_id: fixture.first.sessionId,
      });
      const got = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("W1b the same put-back row is not handed to its holder again, and the doctor names it", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("두 번 건네지면 안 되는 지시");
      const [queued] = fixture.peerRows();
      const taken = ledger.claim(holder);
      expect(handedOver(taken.allowed ? taken.value : null).claimed?.messageId).toBe(queued!.message_id);
      putBack(fixture, queued!.message_id);
      const putBackRow = rowOf(fixture, queued!.message_id);

      const before = fixture.writes();
      const again = ledger.claim(holder);
      expect(again.allowed, JSON.stringify(again)).toBe(true);
      expect(handedOver(again.allowed ? again.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: queued!.message_id }],
      });
      // The outbox itself refuses it, whatever the caller's predicate admits.
      const bare = harness.cp.outbox.claimForHolder(holder, () => true);
      expect(bare.claimed).toEqual([]);
      expect(bare.hasMore).toBe(false);
      expect(fixture.writes()).toBe(before);
      expect(rowOf(fixture, queued!.message_id)).toEqual(putBackRow);

      const report = await harness.cp.doctor.run("system");
      expect(report.findings.find((finding) => finding.code === "OUTBOX_HOLDER_MESSAGE_RETURNED_TO_PENDING"))
        .toMatchObject({ observedEvidence: { count: 1, messageIds: [queued!.message_id] } });
    } finally {
      await fixture.close();
    }
  });

  it("W2 the same for a message that went ACKED, REJECTED or EXPIRED before the put-back", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("받고 끝낸 지시");
      await fixture.ceoSays("받고 거절한 지시");
      await fixture.ceoSays("만료된 지시");
      const [acked, rejected, expired] = fixture.peerRows();
      const first = ledger.claim(holder);
      expect(handedOver(first.allowed ? first.value : null).claimed?.messageId).toBe(acked!.message_id);
      expect(ledger.complete(acked!.message_id, holder).reasonCode).toBe(ReasonCode.OK);
      const second = ledger.claim(holder);
      expect(handedOver(second.allowed ? second.value : null).claimed?.messageId).toBe(rejected!.message_id);
      expect(ledger.reject(rejected!.message_id, holder).allowed).toBe(true);
      // No product path expires a holder-claimed row; a raw writer can.
      harness.cp.db.run(`UPDATE outbox SET status = 'EXPIRED' WHERE message_id = ?`, [expired!.message_id]);
      expect(fixture.peerRows().map((row) => row.status)).toEqual(["ACKED", "REJECTED", "EXPIRED"]);
      for (const row of [acked, rejected, expired]) putBack(fixture, row!.message_id);
      expect(fixture.peerRows().map((row) => row.status)).toEqual(["PENDING", "PENDING", "PENDING"]);

      // Not handed to the holder again.
      const before = fixture.writes();
      const again = ledger.claim(holder);
      expect(handedOver(again.allowed ? again.value : null).claimed).toBeNull();
      expect(harness.cp.outbox.claimForHolder(holder, () => true).claimed).toEqual([]);
      expect(fixture.writes()).toBe(before);

      // Not carried on restart, and the successor gets nothing.
      const successor = await restart(fixture, 2);
      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture)).toEqual([
        [acked!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [rejected!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [expired!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
      const got = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("W3 the departure refuses raw UPDATE, DELETE and REPLACE, and survives the outbox row being deleted and re-inserted", async () => {
    const fixture = await startFixture();
    const external = new Database(join(fixture.harness.root, "state.sqlite"));
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("기록을 지워 되살리려는 지시");
      const [queued] = fixture.peerRows();
      const id = queued!.message_id;
      const departures = () => harness.cp.db.all(`SELECT * FROM holder_message_departures ORDER BY message_id`);
      expect(departures()).toEqual([]);
      ledger.claim(holder);
      const [departure] = departures();
      expect(departures()).toEqual([
        { message_id: id, from_status: "PENDING", to_status: "SENT", departed_at: expect.any(String), basis: "TRANSITION" },
      ]);

      // ACP's own connection and an external one with none of ACP's pragmas: both refused.
      const writers: Array<[string, (sql: string, params: unknown[]) => unknown]> = [
        ["acp", (sql, params) => harness.cp.db.run(sql, params)],
        ["external", (sql, params) => external.prepare(sql).run(...(params as never[]))],
      ];
      for (const [name, write] of writers) {
        for (const set of ["to_status = 'PENDING'", "from_status = 'SENT'", "departed_at = '2000-01-01T00:00:00.000Z'",
                           "basis = 'BACKFILL', from_status = NULL", "message_id = 'msg_elsewhere'"]) {
          expect(() => write(`UPDATE holder_message_departures SET ${set} WHERE message_id = ?`, [id]), `${name}: ${set}`)
            .toThrow(/HOLDER_MESSAGE_DEPARTURE_IMMUTABLE/);
        }
        expect(() => write(`DELETE FROM holder_message_departures WHERE message_id = ?`, [id]), name)
          .toThrow(/HOLDER_MESSAGE_DEPARTURE_IMMUTABLE/);
        expect(() => write(`DELETE FROM holder_message_departures`, []), name)
          .toThrow(/HOLDER_MESSAGE_DEPARTURE_IMMUTABLE/);
        for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"]) {
          const replaced = (): unknown => write(
            `${verb} INTO holder_message_departures (message_id, from_status, to_status, departed_at, basis)
             VALUES (?, 'PENDING', 'REJECTED', '2000-01-01T00:00:00.000Z', 'TRANSITION')`,
            [id],
          );
          expect(replaced, `${name}: ${verb}`).toThrow(/HOLDER_MESSAGE_DEPARTURE_NO_REPLACE/);
        }
      }
      expect(departures()).toEqual([departure]);

      // The outbox row deleted and re-inserted under the same id, as a message nobody was handed. A
      // plain DELETE of a row that left PENDING is refused; a REPLACE through its hidden rowid, on this
      // connection with recursive triggers off, still removes it, and the departure stands regardless.
      const row = external.prepare(`SELECT * FROM outbox WHERE message_id = ?`).get(id) as Record<string, unknown>;
      expect(() => external.prepare(`DELETE FROM outbox WHERE message_id = ?`).run(id))
        .toThrow(/OUTBOX_DEPARTED_ROW_NO_DELETE/);
      const target = external.prepare(`SELECT rowid AS r FROM outbox WHERE message_id = ?`).get(id) as { r: number };
      const decoy: Record<string, unknown> = {
        ...row, message_id: "msg_decoy", idempotency_key: "decoy", kind: MessageKind.TASK_ASSIGN,
        status: "REJECTED", payload_json: "{}",
      };
      const decoyColumns = Object.keys(decoy);
      external.prepare(
        `REPLACE INTO outbox (rowid, ${decoyColumns.join(", ")}) VALUES (?, ${decoyColumns.map(() => "?").join(", ")})`,
      ).run(target.r, ...decoyColumns.map((column) => decoy[column] as never));
      expect(rowOf(fixture, id)).toBeUndefined();
      const reborn: Record<string, unknown> = { ...row, status: "PENDING", attempts: 0, sent_at: null, claim_token: null, claimed_at: null };
      const columns = Object.keys(reborn);
      external.prepare(`INSERT INTO outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => reborn[column] as never));
      expect(rowOf(fixture, id)).toMatchObject({ status: "PENDING", attempts: 0, sent_at: null });
      expect(departures()).toEqual([departure]);

      const again = ledger.claim(holder);
      expect(handedOver(again.allowed ? again.value : null).claimed).toBeNull();
      const successor = await restart(fixture, 2);
      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture)).toEqual([[id, "REFUSED", "ALREADY_CLAIMED"]]);
      const got = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();
    } finally {
      external.close();
      await fixture.close();
    }
  });

  it("W5 a put-back row does not strand the queue: a later message is claimable, and a clean one is carried exactly once", async () => {
    const fixture = await startFixture();
    try {
      const ledger = ownerMessageLedger(fixture.harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("되돌려진 첫 지시");
      const [reverted] = fixture.peerRows();
      ledger.claim(holder);
      putBack(fixture, reverted!.message_id);
      await fixture.ceoSays("그 뒤에 온 진짜 지시");
      const later = fixture.peerRows()[1]!;

      // The put-back row stands first in the queue and is skipped, not handed and not blocking.
      const next = ledger.claim(holder);
      expect(handedOver(next.allowed ? next.value : null)).toMatchObject({
        claimed: { messageId: later.message_id, text: "그 뒤에 온 진짜 지시" },
        withheld: [{ messageId: reverted!.message_id }],
      });
      expect(ledger.complete(later.message_id, holder).reasonCode).toBe(ReasonCode.OK);

      await fixture.ceoSays("재시작 전에 대기 중인 지시");
      const clean = fixture.peerRows()[2]!;
      const successor = await restart(fixture, 2);
      expect(carried(fixture).map((carry) => carry.message_id)).toEqual([clean.message_id]);
      expect(refusals(fixture)).toEqual([
        [reverted!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [clean.message_id, "CARRIED", null],
      ]);
      const newHolder = fixture.holderOf(successor.sessionId);
      const taken = ledger.claim(newHolder);
      expect(handedOver(taken.allowed ? taken.value : null).claimed).toMatchObject({
        messageId: clean.message_id, text: "재시작 전에 대기 중인 지시",
      });
      expect(ledger.complete(clean.message_id, newHolder).reasonCode).toBe(ReasonCode.OK);
      const after = ledger.claim(newHolder);
      expect(handedOver(after.allowed ? after.value : null).claimed).toBeNull();
      expect(carried(fixture)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("W7 a row flipped to a generic kind, taken out of PENDING and put back, then flipped back, is never handed over or carried", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("일반 종류로 바뀌어 쓸려 나간 지시");
      await fixture.ceoSays("일반 종류로 바뀌어 손으로 돌려진 지시");
      const [swept, handled] = fixture.peerRows();
      const flip = (messageId: string, kind: MessageKind): void => {
        harness.cp.db.run(`UPDATE outbox SET kind = ? WHERE message_id = ?`, [kind, messageId]);
      };

      // One goes out through the generic sweep, as a generic kind, and the lease reclaim puts it back.
      flip(swept!.message_id, MessageKind.TASK_ASSIGN);
      expect(harness.cp.outbox.claimDeliverable().map((message) => message.messageId)).toEqual([swept!.message_id]);
      expect(rowOf(fixture, swept!.message_id)).toMatchObject({ status: "IN_FLIGHT" });
      harness.clock.advance(5 * 60 * 1000 + 1);
      expect(harness.cp.outbox.reclaimStaleLeases()).toBe(1);
      // The other is moved PENDING -> IN_FLIGHT -> PENDING by raw statements, as a generic kind.
      flip(handled!.message_id, MessageKind.TASK_ASSIGN);
      harness.cp.db.run(
        `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = 'tok-raw', claimed_at = ? WHERE message_id = ?`,
        [harness.clock.nowIso(), handled!.message_id],
      );
      harness.cp.db.run(
        `UPDATE outbox SET status = 'PENDING', claim_token = NULL, claimed_at = NULL WHERE message_id = ?`,
        [handled!.message_id],
      );
      // Both flipped back: each now reads as a peer message nobody was ever handed.
      for (const row of [swept, handled]) {
        flip(row!.message_id, MessageKind.PEER_MESSAGE);
        expect(rowOf(fixture, row!.message_id)).toMatchObject({
          kind: MessageKind.PEER_MESSAGE, status: "PENDING", attempts: 0, sent_at: null, claim_token: null,
        });
      }

      const before = fixture.writes();
      const again = ledger.claim(holder);
      expect(handedOver(again.allowed ? again.value : null).claimed).toBeNull();
      expect(harness.cp.outbox.claimForHolder(holder, () => true).claimed).toEqual([]);
      expect(fixture.writes()).toBe(before);

      const successor = await restart(fixture, 2);
      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture)).toEqual([
        [swept!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [handled!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
      const got = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("W8 renaming a departed row while putting it back to PENDING is refused; the original is still not handed over or carried", async () => {
    const fixture = await startFixture();
    const external = new Database(join(fixture.harness.root, "state.sqlite"));
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      await fixture.ceoSays("새 이름으로 되살리려는 지시");
      const [queued] = fixture.peerRows();
      const id = queued!.message_id;
      const renamed = `${id}_renamed`;
      ledger.claim(holder);
      expect(rowOf(fixture, id)).toMatchObject({ status: "SENT" });

      // The status trigger does not fire on a row leaving SENT, and a new id has no departure.
      const renameAndPutBack = `UPDATE outbox SET message_id = ?, status = 'PENDING', attempts = 0, sent_at = NULL,
                                                   claim_token = NULL, claimed_at = NULL
                                 WHERE message_id = ?`;
      let refused: unknown = null;
      try {
        harness.cp.db.run(renameAndPutBack, [renamed, id]);
      } catch (error) {
        refused = error;
      }

      // Nothing under either id is handed to the holder again.
      const again = ledger.claim(holder);
      expect(handedOver(again.allowed ? again.value : null).claimed).toBeNull();
      expect(harness.cp.outbox.claimForHolder(holder, () => true).claimed).toEqual([]);
      expect(rowOf(fixture, renamed)).toBeUndefined();
      expect(rowOf(fixture, id)).toMatchObject({ status: "SENT" });
      expect(String(refused)).toMatch(/OUTBOX_MESSAGE_ID_IMMUTABLE/);

      // The original put back by a status write alone: its departure still refuses it.
      putBack(fixture, id);
      const putBackAgain = ledger.claim(holder);
      expect(handedOver(putBackAgain.allowed ? putBackAgain.value : null).claimed).toBeNull();
      const successor = await restart(fixture, 2);
      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture)).toEqual([[id, "REFUSED", "ALREADY_CLAIMED"]]);
      const got = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();

      // Refused on a connection with none of ACP's pragmas too, with or without the status revert.
      for (const sql of [renameAndPutBack, `UPDATE outbox SET message_id = ? WHERE message_id = ?`]) {
        expect(() => external.prepare(sql).run(renamed, id)).toThrow(/OUTBOX_MESSAGE_ID_IMMUTABLE/);
      }
      expect(rowOf(fixture, renamed)).toBeUndefined();
    } finally {
      external.close();
      await fixture.close();
    }
  });

  /**
   * Round-2 review, 01(a): an outside connection, where SQLite's `recursive_triggers` is off, writes
   * `REPLACE INTO <table>(rowid, …)` with an existing row's hidden rowid and a different declared key.
   * The no-replace guard checks the declared key only, and the implicit delete fires no delete guard.
   * An outside writer can also define ACP's authority functions on its own connection, which is what
   * stands in front of the carry and notice records' inserts.
   */
  it("W9 01(a): a REPLACE through the hidden rowid deletes no departure, carry record or notice", async () => {
    const fixture = await startFixture();
    const external = new Database(join(fixture.harness.root, "state.sqlite"));
    external.function("acp_peer_message_carry_authorized", { varargs: true }, () => 1);
    external.function("acp_peer_message_notice_authorized", { varargs: true }, () => 1);
    try {
      expect(external.pragma("recursive_triggers", { simple: true })).toBe(0);
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      /** Deletes the row `where` names by REPLACE-ing a decoy into its rowid; the error, or null. */
      const replaceThroughRowid = (table: string, where: string, args: unknown[], decoy: Record<string, unknown>) => {
        try {
          const target = external.prepare(`SELECT rowid AS r FROM ${table} WHERE ${where}`).get(...(args as never[])) as
            { r: number } | undefined;
          if (!target) return new Error(`no ${table} row`);
          const columns = Object.keys(decoy);
          external.prepare(
            `REPLACE INTO ${table} (rowid, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
          ).run(target.r, ...columns.map((column) => decoy[column] as never));
          return null;
        } catch (error) {
          return error;
        }
      };

      await fixture.ceoSays("숨은 rowid 로 출발 기록을 지우려는 지시");
      const [handed] = fixture.peerRows();
      ledger.claim(holder);
      const departure = harness.cp.db.get(`SELECT * FROM holder_message_departures WHERE message_id = ?`, [handed!.message_id]);
      expect(departure).toMatchObject({ message_id: handed!.message_id, to_status: "SENT" });
      const departureAttack = replaceThroughRowid("holder_message_departures", "message_id = ?", [handed!.message_id], {
        message_id: "msg_decoy", from_status: "PENDING", to_status: "SENT",
        departed_at: harness.clock.nowIso(), basis: "TRANSITION",
      });
      putBack(fixture, handed!.message_id);
      // The departure still stands, so the put-back row is not handed to its holder again.
      expect(harness.cp.db.get(`SELECT * FROM holder_message_departures WHERE message_id = ?`, [handed!.message_id]))
        .toEqual(departure);
      const again = ledger.claim(holder);
      expect(handedOver(again.allowed ? again.value : null).claimed).toBeNull();

      // The restart refuses the put-back row (a REFUSED record and an OWED notice) and carries the other.
      await fixture.ceoSays("운반 기록이 지워지려는 지시");
      const queued = fixture.peerRows()[1];
      const successor = await restart(fixture, 2);
      expect(refusals(fixture)).toEqual([
        [handed!.message_id, "REFUSED", "ALREADY_CLAIMED"],
        [queued!.message_id, "CARRIED", null],
      ]);
      const carriedRecord = harness.cp.db.get<Record<string, unknown>>(
        `SELECT * FROM peer_message_carries WHERE message_id = ? AND outcome = 'CARRIED'`, [queued!.message_id],
      )!;
      const owed = harness.cp.db.get<Record<string, unknown>>(
        `SELECT * FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'OWED'`, [handed!.message_id],
      )!;
      const carryAttack = replaceThroughRowid(
        "peer_message_carries", "message_id = ? AND outcome = 'CARRIED'", [queued!.message_id],
        { ...carriedRecord, message_id: "msg_decoy" },
      );
      const noticeAttack = replaceThroughRowid(
        "peer_message_refusal_notices", "message_id = ? AND entry = 'OWED'", [handed!.message_id],
        { ...owed, message_id: "msg_decoy" },
      );
      expect(harness.cp.db.get(
        `SELECT * FROM peer_message_carries WHERE message_id = ? AND outcome = 'CARRIED'`, [queued!.message_id],
      )).toEqual(carriedRecord);
      expect(harness.cp.db.get(
        `SELECT * FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'OWED'`, [handed!.message_id],
      )).toEqual(owed);
      for (const table of ["holder_message_departures", "peer_message_carries", "peer_message_refusal_notices"]) {
        expect(harness.cp.db.get(`SELECT 1 AS present FROM ${table} WHERE message_id = 'msg_decoy'`), table).toBeUndefined();
      }
      // The carried row is still the successor's, through its record.
      const taken = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(taken.allowed ? taken.value : null).claimed).toMatchObject({ messageId: queued!.message_id });
      // None of the three tables has a hidden rowid to reach.
      for (const attack of [departureAttack, carryAttack, noticeAttack]) expect(String(attack)).toMatch(/rowid/);
    } finally {
      external.close();
      await fixture.close();
    }
  });

  /**
   * Round-2 review, 01(b): the claimed row deleted and its admitted-event pointer re-inserted under a
   * new message id, and the same pointer copied into a second row beside a handed-over original. A
   * departure keyed by the message id alone sees neither.
   */
  it("W10 01(b): a new row pointing at an event whose message already left PENDING is never handed over or carried", async () => {
    const fixture = await startFixture();
    const external = new Database(join(fixture.harness.root, "state.sqlite"));
    try {
      const { harness } = fixture;
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      const copyAs = (row: Record<string, unknown>, messageId: string): void => {
        const copy: Record<string, unknown> = {
          ...row, message_id: messageId, idempotency_key: `${String(row["idempotency_key"])}:${messageId}`,
          status: "PENDING", attempts: 0, sent_at: null, acked_at: null, claim_token: null, claimed_at: null,
          reason_code: null,
        };
        const columns = Object.keys(copy);
        external.prepare(`INSERT INTO outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .run(...columns.map((column) => copy[column] as never));
      };

      await fixture.ceoSays("지워졌다 새 아이디로 돌아오는 지시");
      const [first] = fixture.peerRows();
      ledger.claim(holder);
      const original = external.prepare(`SELECT * FROM outbox WHERE message_id = ?`).get(first!.message_id) as
        Record<string, unknown>;
      // The plain DELETE, as the review ran it; where it is refused, the hidden rowid is the way round.
      let plainDelete: unknown = null;
      try {
        external.prepare(`DELETE FROM outbox WHERE message_id = ?`).run(first!.message_id);
      } catch (error) {
        plainDelete = error;
      }
      if (plainDelete !== null) {
        const target = external.prepare(`SELECT rowid AS r FROM outbox WHERE message_id = ?`).get(first!.message_id) as
          { r: number };
        const decoy: Record<string, unknown> = {
          ...original, message_id: "msg_decoy", idempotency_key: "decoy", kind: MessageKind.TASK_ASSIGN,
          status: "REJECTED", payload_json: "{}",
        };
        const columns = Object.keys(decoy);
        external.prepare(`REPLACE INTO outbox (rowid, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
          .run(target.r, ...columns.map((column) => decoy[column] as never));
      }
      expect(rowOf(fixture, first!.message_id)).toBeUndefined();
      copyAs(original, `${first!.message_id}_again`);

      await fixture.ceoSays("그 뒤에 온 진짜 지시");
      const genuine = fixture.peerRows().find((row) => row.status === "PENDING" &&
        !row.message_id.startsWith(first!.message_id))!;
      // The re-created row stands first in the queue and is skipped: the genuine one is handed over.
      const next = ledger.claim(holder);
      expect(handedOver(next.allowed ? next.value : null).claimed).toMatchObject({ messageId: genuine.message_id });
      // And a copy of the handed-over genuine row, under another id, beside its original.
      copyAs(external.prepare(`SELECT * FROM outbox WHERE message_id = ?`).get(genuine.message_id) as
        Record<string, unknown>, `${genuine.message_id}_copy`);

      const successor = await restart(fixture, 2);
      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture)).toEqual(expect.arrayContaining([
        [`${first!.message_id}_again`, "REFUSED", "ALREADY_CLAIMED"],
        [`${genuine.message_id}_copy`, "REFUSED", "ALREADY_CLAIMED"],
      ]));
      const got = ledger.claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();
      expect(String(plainDelete)).toMatch(/OUTBOX_DEPARTED_ROW_NO_DELETE/);
    } finally {
      external.close();
      await fixture.close();
    }
  });

  /**
   * Round-2 review, 01(c): the real ingress no-reply completion records `noReplyAt` while the peer
   * row stays PENDING; an ordinary `json_remove` erases it, or the admitted row is recreated without
   * it through its hidden rowid. The carry read the terminal fact from that JSON alone.
   */
  it("W11 01(c): a turn the ingress completed is never carried, however its terminal fact is erased afterwards", async () => {
    const fixture = await startFixture();
    const external = new Database(join(fixture.harness.root, "state.sqlite"));
    // An outside writer defines the ingress claim authority on its own connection to re-insert a claim.
    external.function("acp_ingress_claim_authorized", { varargs: true }, () => 1);
    try {
      const { harness } = fixture;
      const guard = new IngressGuard(harness.cp.db, harness.clock, harness.cp.audit, {});
      const erased = await fixture.ceoSays("끝난 뒤 기록이 지워진 지시");
      const recreated = await fixture.ceoSays("끝난 뒤 행이 다시 만들어진 지시");
      for (const event of [erased, recreated]) {
        expect(guard.completeNoReplyAndResolveTurn("buzz", buzzMessageNonce(event.id)).allowed).toBe(true);
        expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      }
      expect(fixture.peerRows().map((row) => row.status)).toEqual(["PENDING", "PENDING"]);

      harness.cp.db.run(
        `UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.noReplyAt')
          WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce(erased.id)],
      );
      // The admitted row deleted through its hidden rowid and inserted again without the fact.
      const row = external.prepare(`SELECT rowid AS r, * FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`)
        .get(buzzMessageNonce(recreated.id)) as Record<string, unknown>;
      external.prepare(`REPLACE INTO inbound_messages (rowid, channel, nonce, actor, received_at) VALUES (?, 'buzz', ?, ?, ?)`)
        .run(row["r"] as never, "buzz-message:decoy", "decoy", harness.clock.nowIso());
      const { r: _rowid, ...kept } = row;
      const claim = JSON.parse(String(kept["turn_claim_json"])) as Record<string, unknown>;
      delete claim["noReplyAt"];
      const restored: Record<string, unknown> = { ...kept, turn_claim_json: JSON.stringify(claim) };
      const columns = Object.keys(restored);
      external.prepare(`INSERT INTO inbound_messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => restored[column] as never));
      for (const event of [erased, recreated]) {
        expect(fixture.turnClaim(event.id)["noReplyAt"], event.id).toBeUndefined();
      }

      const successor = await restart(fixture, 2);
      expect(carried(fixture)).toEqual([]);
      expect(refusals(fixture).map(([, outcome, refusal]) => [outcome, refusal])).toEqual([
        ["REFUSED", "ALREADY_CLAIMED"],
        ["REFUSED", "ALREADY_CLAIMED"],
      ]);
      const got = ownerMessageLedger(harness.cp).claim(fixture.holderOf(successor.sessionId));
      expect(handedOver(got.allowed ? got.value : null).claimed).toBeNull();
    } finally {
      external.close();
      await fixture.close();
    }
  });

  /**
   * Round-3 review, 01: the holder's claim read only MESSAGE_DEPARTED. A turn the ingress completed,
   * its terminal fact then erased with an ordinary json_remove, kept its TURN_TERMINAL record — and
   * the holder still received the instruction: the original holder, and the successor after a
   * genuine carry. Every hand-over path now asks one predicate, `handOverEligibleSql`.
   */
  const TERMINAL_FACTS = ["noReplyAt", "repliedAt", "settledAt"] as const;
  /**
   * The turn reaches a terminal fact and a statement then erases it. `noReplyAt` through the real
   * ingress no-reply completion; `repliedAt` and `settledAt` as the reply and receipt paths write
   * them onto the claim (the receipt path's own settlement is covered by (p)).
   */
  const answerThenErase = (fixture: Fixture, eventId: string, fact: (typeof TERMINAL_FACTS)[number]): void => {
    const { harness } = fixture;
    const nonce = buzzMessageNonce(eventId);
    if (fact === "noReplyAt") {
      expect(new IngressGuard(harness.cp.db, harness.clock, harness.cp.audit, {})
        .completeNoReplyAndResolveTurn("buzz", nonce).allowed).toBe(true);
    } else {
      harness.cp.db.run(
        `UPDATE inbound_messages SET turn_claim_json = json_set(turn_claim_json, '$.${fact}', ?)
          WHERE channel = 'buzz' AND nonce = ?`,
        [harness.clock.nowIso(), nonce],
      );
    }
    expect(fixture.turnClaim(eventId)[fact]).toEqual(expect.any(String));
    harness.cp.db.run(
      `UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.${fact}')
        WHERE channel = 'buzz' AND nonce = ?`,
      [nonce],
    );
    expect(fixture.turnClaim(eventId)[fact]).toBeUndefined();
    expect(harness.cp.db.get(
      `SELECT reason FROM holder_message_source_departures WHERE source_channel = 'buzz' AND source_nonce = ?`,
      [nonce],
    )).toEqual({ reason: "TURN_TERMINAL" });
  };

  it.each(TERMINAL_FACTS)("R3a the original holder is not handed a turn that held %s, after it was erased", async (fact) => {
    const fixture = await startFixture();
    try {
      const ledger = ownerMessageLedger(fixture.harness.cp);
      const holder = fixture.holderOf(fixture.first.sessionId);
      const event = await fixture.ceoSays(`${fact} 뒤에 기록이 지워진 지시`);
      const [queued] = fixture.peerRows();
      answerThenErase(fixture, event.id, fact);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "PENDING" });
      const before = fixture.writes();
      const again = ledger.claim(holder);
      expect(handedOver(again.allowed ? again.value : null)).toMatchObject({
        claimed: null, withheld: [{ messageId: queued!.message_id }],
      });
      expect(fixture.harness.cp.outbox.claimForHolder(holder, () => true).claimed).toEqual([]);
      expect(fixture.writes()).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  it.each(TERMINAL_FACTS)("R3b the successor after a genuine carry is not handed a turn that held %s, after it was erased", async (fact) => {
    const fixture = await startFixture();
    try {
      const ledger = ownerMessageLedger(fixture.harness.cp);
      const event = await fixture.ceoSays(`옮겨진 뒤 ${fact} 가 지워진 지시`);
      const [queued] = fixture.peerRows();
      const successor = await restart(fixture, 2);
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome])).toEqual([[queued!.message_id, "CARRIED"]]);
      answerThenErase(fixture, event.id, fact);
      const holder = fixture.holderOf(successor.sessionId);
      const got = ledger.claim(holder);
      expect(handedOver(got.allowed ? got.value : null)).toMatchObject({
        claimed: null, withheld: [{ messageId: queued!.message_id }],
      });
      expect(fixture.harness.cp.outbox.claimForHolder(holder, () => true).claimed).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it.each(TERMINAL_FACTS)("R3c a takeover and a runtime move reject an owner's message whose turn held %s", (fact) => {
    for (const move of ["takeover", "runtime-move"] as const) {
      const core = makeCore();
      const run = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
      const enqueue = (nonce: string): string => {
        const queued = core.outbox.enqueue({
          idempotencyKey: `owner-message:${nonce}`, roleKey: run.roleKey, bindingGeneration: run.generation,
          targetSessionId: run.sessionId, runId: run.runId, kind: MessageKind.OWNER_MESSAGE,
          payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: `sha256:${nonce}` },
        });
        if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
        return queued.value.messageId;
      };
      // The admitted event, answered, and the fact then erased from its claim.
      core.db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json)
         VALUES ('buzz', 'buzz-message:answered', 'owner', ?, ?)`,
        [core.clock.nowIso(), JSON.stringify({ turnRequestId: "turn-answered", [fact]: core.clock.nowIso() })],
      );
      core.db.run(
        `UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.${fact}')
          WHERE channel = 'buzz' AND nonce = 'buzz-message:answered'`,
      );
      const answered = enqueue("buzz-message:answered");
      const fresh = enqueue("buzz-message:fresh");
      const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
      expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
      const moved = move === "takeover"
        ? core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId)
        : core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
      const passed = "retargeted" in moved ? moved.retargeted : moved.carried;
      expect(passed, `${move} ${fact}`).toEqual([fresh]);
      expect(moved.rejected, `${move} ${fact}`).toEqual([answered]);
    }
  });

  /**
   * The predicate is asserted twice on a path: by the read that chooses the row and by the statement
   * that moves it, in one transaction. Each layer gets a row that fails when only it is removed: the
   * read is made to miss the answered turn, so only the write stands between it and a hand-over; or
   * the write is watched, so the read's refusal is seen to come before any write is attempted.
   *
   * Since the narrow review every read also asks the history of the *parsed* pointer
   * (`Outbox.#payloadHandOverEligible`), which refuses the same answered turn on its own. A seam for
   * one SQL layer therefore also makes that lookup miss — the source-ledger query with exactly the
   * read's two reasons; the fence's own TURN_TERMINAL-only lookup is left alone — so only the layer
   * under test stands. The parsed-pointer layer has its own rows in the narrow-review block below.
   */
  const PARSED_POINTER_LOOKUP =
    /^\s*SELECT 1 AS present FROM holder_message_source_departures[\s\S]*reason IN \('MESSAGE_DEPARTED', 'TURN_TERMINAL'\)/;
  it("R3d the claim's write refuses an answered turn even when its read has missed it", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const holder = fixture.holderOf(fixture.first.sessionId);
      const event = await fixture.ceoSays("읽기가 놓친 끝난 지시");
      const [queued] = fixture.peerRows();
      answerThenErase(fixture, event.id, "noReplyAt");
      const all = db.all.bind(db);
      const get = db.get.bind(db);
      const spy = vi.spyOn(db, "all").mockImplementation(((sql: string, params: unknown[] = []) => {
        const rows = all(sql, params) as Array<Record<string, unknown>>;
        return /AS never_departed/.test(sql) ? rows.map((row) => ({ ...row, never_departed: 1 })) : rows;
      }) as typeof db.all);
      const parsed = vi.spyOn(db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
        PARSED_POINTER_LOOKUP.test(sql) ? undefined : get(sql, params)) as typeof db.get);
      let claimed: unknown[];
      try {
        claimed = fixture.harness.cp.outbox.claimForHolder(holder, () => true).claimed;
      } finally {
        spy.mockRestore();
        parsed.mockRestore();
      }
      expect(claimed).toEqual([]);
      expect(fixture.peerRows()[0]).toMatchObject({ message_id: queued!.message_id, status: "PENDING" });
    } finally {
      await fixture.close();
    }
  });

  it("R3i the claim's read refuses an answered turn from its SQL alone, before any write", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const holder = fixture.holderOf(fixture.first.sessionId);
      const event = await fixture.ceoSays("SQL 읽기만으로 거절되는 끝난 지시");
      const [queued] = fixture.peerRows();
      answerThenErase(fixture, event.id, "noReplyAt");
      const get = db.get.bind(db);
      const run = db.run.bind(db);
      let writes = 0;
      const parsed = vi.spyOn(db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
        PARSED_POINTER_LOOKUP.test(sql) ? undefined : get(sql, params)) as typeof db.get);
      const moves = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/^\s*UPDATE outbox SET status = 'SENT', sent_at = \?/.test(sql)) writes += 1;
        return run(sql, params);
      }) as typeof db.run);
      let result: ReturnType<Outbox["claimForHolder"]>;
      try {
        result = fixture.harness.cp.outbox.claimForHolder(holder, () => true);
      } finally {
        parsed.mockRestore();
        moves.mockRestore();
      }
      expect(writes).toBe(0);
      expect(result.claimed).toEqual([]);
      expect(result.withheld.map((row) => row.messageId)).toEqual([queued!.message_id]);
    } finally {
      await fixture.close();
    }
  });

  it("R3e the carry's write refuses an answered turn even when its read has missed it", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const event = await fixture.ceoSays("운반 읽기가 놓친 끝난 지시");
      const [queued] = fixture.peerRows();
      answerThenErase(fixture, event.id, "noReplyAt");
      const get = db.get.bind(db);
      const spy = vi.spyOn(db, "get").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (PARSED_POINTER_LOOKUP.test(sql)) return undefined;
        const row = get(sql, params) as Record<string, unknown> | undefined;
        return /AS eligible(?:, o\.payload_json)? FROM outbox o/.test(sql) && row ? { ...row, eligible: 1 } : row;
      }) as typeof db.get);
      try {
        await restart(fixture, 2);
      } finally {
        spy.mockRestore();
      }
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [queued!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "REJECTED", binding_generation: 1 });
    } finally {
      await fixture.close();
    }
  });

  it("R3f the carry's read refuses an answered turn before any carry write is attempted", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const event = await fixture.ceoSays("쓰기 전에 거절되는 끝난 지시");
      const [queued] = fixture.peerRows();
      answerThenErase(fixture, event.id, "noReplyAt");
      const run = db.run.bind(db);
      const get = db.get.bind(db);
      let carryWrites = 0;
      const spy = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/AND attempts = 0 AND sent_at IS NULL AND claim_token IS NULL/.test(sql)) carryWrites += 1;
        return run(sql, params);
      }) as typeof db.run);
      const parsed = vi.spyOn(db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
        PARSED_POINTER_LOOKUP.test(sql) ? undefined : get(sql, params)) as typeof db.get);
      try {
        await restart(fixture, 2);
      } finally {
        spy.mockRestore();
        parsed.mockRestore();
      }
      expect(carryWrites).toBe(0);
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [queued!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
    } finally {
      await fixture.close();
    }
  });

  /** An owner's message whose admitted event was answered and the fact erased, beside a fresh one. */
  const answeredOwnerMessage = () => {
    const core = makeCore();
    const run = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
    const enqueue = (nonce: string): string => {
      const queued = core.outbox.enqueue({
        idempotencyKey: `owner-message:${nonce}`, roleKey: run.roleKey, bindingGeneration: run.generation,
        targetSessionId: run.sessionId, runId: run.runId, kind: MessageKind.OWNER_MESSAGE,
        payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: `sha256:${nonce}` },
      });
      if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
      return queued.value.messageId;
    };
    core.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json)
       VALUES ('buzz', 'buzz-message:answered', 'owner', ?, ?)`,
      [core.clock.nowIso(), JSON.stringify({ turnRequestId: "turn-answered", noReplyAt: core.clock.nowIso() })],
    );
    core.db.run(`UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.noReplyAt')
                  WHERE channel = 'buzz' AND nonce = 'buzz-message:answered'`);
    const answered = enqueue("buzz-message:answered");
    const fresh = enqueue("buzz-message:fresh");
    const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
    expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
    const move = (kind: "takeover" | "runtime-move") => {
      const moved = kind === "takeover"
        ? core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId)
        : core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
      return { passed: "retargeted" in moved ? moved.retargeted : moved.carried, rejected: moved.rejected };
    };
    return { core, answered, fresh, move };
  };

  it.each(["takeover", "runtime-move"] as const)("R3g the %s write refuses an answered turn even when its read has missed it", (kind) => {
    const { core, answered, fresh, move } = answeredOwnerMessage();
    const get = core.db.get.bind(core.db);
    const spy = vi.spyOn(core.db, "get").mockImplementation(((sql: string, params: unknown[] = []) => {
      if (PARSED_POINTER_LOOKUP.test(sql)) return undefined;
      const row = get(sql, params) as Record<string, unknown> | undefined;
      return /AS eligible(?:, o\.payload_json)? FROM outbox o/.test(sql) && row ? { ...row, eligible: 1 } : row;
    }) as typeof core.db.get);
    let moved: ReturnType<typeof move>;
    try {
      moved = move(kind);
    } finally {
      spy.mockRestore();
    }
    expect(moved).toEqual({ passed: [fresh], rejected: [answered] });
  });

  it.each(["takeover", "runtime-move"] as const)("R3h the %s read refuses an answered turn before any move is attempted", (kind) => {
    const { core, answered, fresh, move } = answeredOwnerMessage();
    const run = core.db.run.bind(core.db);
    const get = core.db.get.bind(core.db);
    const attempts: string[] = [];
    const spy = vi.spyOn(core.db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
      if (/^\s*UPDATE outbox SET (binding_generation = \?, )?target_session_id = \?/.test(sql) &&
          params.includes(answered)) attempts.push(answered);
      return run(sql, params);
    }) as typeof core.db.run);
    const parsed = vi.spyOn(core.db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
      PARSED_POINTER_LOOKUP.test(sql) ? undefined : get(sql, params)) as typeof core.db.get);
    let moved: ReturnType<typeof move>;
    try {
      moved = move(kind);
    } finally {
      spy.mockRestore();
      parsed.mockRestore();
    }
    expect(attempts).toEqual([]);
    expect(moved).toEqual({ passed: [fresh], rejected: [answered] });
  });

  describe("an owner's message put back by raw SQL is not moved to anyone either", () => {
    const SEEDED_INCARNATION = "inc-1";
    const seeded = () => {
      const core = makeCore();
      const run = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
      const holder: HolderIdentity = {
        roleKey: run.roleKey,
        bindingGeneration: run.generation,
        targetSessionId: run.sessionId,
        sessionIncarnation: SEEDED_INCARNATION,
      };
      const enqueue = (text: string): string => {
        const queued = core.outbox.enqueue({
          idempotencyKey: `owner:${crypto.randomUUID()}`,
          roleKey: run.roleKey,
          bindingGeneration: run.generation,
          targetSessionId: run.sessionId,
          runId: run.runId,
          kind: MessageKind.OWNER_MESSAGE,
          payload: { text },
        });
        if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
        return queued.value.messageId;
      };
      // Handed over, then put back as if nobody had been.
      const reverted = enqueue("handed over, then put back");
      expect(core.outbox.claimForHolder(holder).claimed.map((m) => m.messageId)).toEqual([reverted]);
      core.db.run(
        `UPDATE outbox SET status = 'PENDING', attempts = 0, sent_at = NULL, claim_token = NULL, claimed_at = NULL
          WHERE message_id = ?`,
        [reverted],
      );
      const fresh = enqueue("never handed over");
      const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
      expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
      return { core, run, reverted, fresh, successor };
    };

    it("W10o 01(b): a takeover and a runtime move reject a second row pointing at an event already handed over", () => {
      for (const move of ["takeover", "runtime-move"] as const) {
        const core = makeCore();
        const run = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
        const holder: HolderIdentity = {
          roleKey: run.roleKey, bindingGeneration: run.generation, targetSessionId: run.sessionId,
          sessionIncarnation: SEEDED_INCARNATION,
        };
        const enqueue = (nonce: string): string => {
          const queued = core.outbox.enqueue({
            idempotencyKey: `owner-message:${nonce}`, roleKey: run.roleKey, bindingGeneration: run.generation,
            targetSessionId: run.sessionId, runId: run.runId, kind: MessageKind.OWNER_MESSAGE,
            payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: `sha256:${nonce}` },
          });
          if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
          return queued.value.messageId;
        };
        const handed = enqueue("buzz-message:handed");
        expect(core.outbox.claimForHolder(holder).claimed.map((m) => m.messageId)).toEqual([handed]);
        // A second row for the same admitted event, never handed over itself.
        const copy = `${handed}_copy`;
        core.db.run(
          `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation, target_session_id, run_id,
                               kind, payload_json, payload_digest, request_fingerprint, expires_at, created_at, status)
           SELECT ?, idempotency_key || ':copy', role_key, binding_generation, target_session_id, run_id,
                  kind, payload_json, payload_digest, request_fingerprint, expires_at, created_at, 'PENDING'
             FROM outbox WHERE message_id = ?`,
          [copy, handed],
        );
        const fresh = enqueue("buzz-message:fresh");
        const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
        expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
        const moved = move === "takeover"
          ? core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId)
          : core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
        const passed = "retargeted" in moved ? moved.retargeted : moved.carried;
        expect(passed, move).toEqual([fresh]);
        expect([...moved.rejected].sort(), move).toEqual([handed, copy].sort());
        expect(core.outbox.get(copy), move).toMatchObject({ status: "REJECTED" });
      }
    });

    it("W1o a takeover retargets the untouched one and rejects the put-back one", () => {
      const { core, run, reverted, fresh, successor } = seeded();
      const moved = core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId);
      expect(moved).toEqual({ retargeted: [fresh], rejected: [reverted] });
      expect(core.outbox.get(reverted)).toMatchObject({ status: "REJECTED", bindingGeneration: run.generation });
    });

    it("W1o a runtime move re-addresses the untouched one and rejects the put-back one", () => {
      const { core, run, reverted, fresh, successor } = seeded();
      const moved = core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
      expect(moved).toEqual({ carried: [fresh], rejected: [reverted] });
      expect(core.outbox.get(reverted)).toMatchObject({ status: "REJECTED", targetSessionId: run.sessionId });
    });
  });
});

/**
 * W6. The holder's claim and the restart's carry, on two connections to one database file: the
 * message reaches exactly one holder — claimed and then not carried, or carried once and then
 * refused to the old holder — never both and never twice. Both run in `BEGIN IMMEDIATE`, so a
 * statement of one cannot land inside the other; the two "inside the window" cases start one while
 * the other's transaction is open and show that it is refused (SQLITE_BUSY after the connection's
 * busy timeout) rather than interleaved, and that its retry after the commit sees the decided row.
 *
 * The second connection is a bare `Db` and `Outbox` on the same file — one process admits a single
 * control plane per database — and claims through `Outbox.claimForHolder` with a predicate that
 * admits every row, so only the claim's own SQL and compare-and-set stand between it and the row.
 */
/**
 * The coverage the final review (round 3) listed as unverified: an explicit unlink, retargeting by
 * two independent OS processes at once, and the refusal reported through the real CTO socket.
 */
describe("finding 01/04: an explicit unlink, two OS processes, and the real CTO socket", () => {
  it("an explicit unlink — the CEO releases the live CTO's binding — refuses the queued peer message and owes its sender a notice", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const event = await fixture.ceoSays("풀려나기 전에 대기 중인 지시");
      const [queued] = fixture.peerRows();
      // The CEO's own door for ending a live CTO's binding, as `cto_binding_release` calls it.
      const released = createCtoBindingRuntime(harness.cp, undefined).release(fixture.ceoSession, {
        requestId: "release-1", projectId: fixture.projectId, role: "PRIMARY_CTO", action: "release",
        expectedBindingGeneration: 1, reason: "explicit unlink",
      });
      expect(released.allowed, JSON.stringify(released)).toBe(true);
      expect(harness.cp.bindings.active(fixture.ctoRoleKey)).toBeNull();
      expect(fixture.peerRows()[0]).toMatchObject({ message_id: queued!.message_id, status: "REJECTED", binding_generation: 1 });
      expect(fixture.turnClaim(event.id)["noReplyAt"]).toEqual(expect.any(String));
      expect(fixture.carries()).toEqual([]);
      expect(harness.cp.db.all(
        `SELECT message_id, entry, reason, sender FROM peer_message_refusal_notices ORDER BY entry`,
      )).toEqual([{ message_id: queued!.message_id, entry: "OWED", reason: "REVOKED", sender: fixture.ceo.pubkey }]);

      // And with no CTO at all the daemon tells the sender: one notice, settled once, metadata only.
      const destination = {
        session_id: "20261004_000000_ceo", lineage_root_digest: `sha256:${"a".repeat(64)}`,
        process_pid: 4242, process_started_at: "darwin-tv:1790000000.000001",
      };
      const sent: DaemonNoticeBody[] = [];
      const report = await deliverOwedPeerMessageNotices(harness.cp.outbox, async () => ({
        destination,
        send: async (body) => {
          sent.push(body);
          return { kind: "RESPONDED", status: 200, body: {
            event_id: body.event_id, payload_digest: body.payload_digest, text: "noted",
            receipt: { receipt_id: "receipt-1", status: "completed", session_id: destination.session_id,
              lineage_root_digest: destination.lineage_root_digest },
          } };
        },
      }), "unlink-test-lane-secret");
      expect(report.settled).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain(`message_id=${queued!.message_id}`);
      expect(sent[0]!.text).toContain("reason=REVOKED");
      expect(sent[0]!.text).not.toContain("풀려나기 전에");
    } finally {
      await fixture.close();
    }
  });

  it("two independent OS processes restarting the conversation at once: one carry, one holder", async () => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      await fixture.ceoSays("두 프로세스가 동시에 옮기려는 지시");
      const [queued] = fixture.peerRows();
      const barrier = tempDir("acp-xproc-");
      const child = fileURLToPath(new URL("../helpers/canonical-restart-child.ts", import.meta.url));
      const input = (name: string): string => JSON.stringify({
        root: harness.root, repoPath: harness.repoPath,
        nowIso: new Date(harness.clock.now().getTime() + 60_000).toISOString(),
        projectId: fixture.projectId, ctoBuzzActor: fixture.cto.pubkey, ownerActor: fixture.owner.pubkey,
        barrierDir: barrier, name, run: 2, canon: CANON, cwd: CWD, room: PROJECT_ROOM,
        protocol: PEER_PROTOCOL, identity: PEER_IDENTITY,
      });
      const spawn = (name: string) => runBoundedChild(
        process.execPath, ["--experimental-transform-types", "--no-warnings", child, input(name)],
        { cwd: process.cwd(), budgetMs: 120_000 },
      );
      const running = [spawn("a"), spawn("b")];
      // Both processes are up, with their own connection open, before either claims.
      const deadline = Date.now() + 110_000;
      while (!(existsSync(join(barrier, "a.ready")) && existsSync(join(barrier, "b.ready")))) {
        if (Date.now() > deadline) throw new Error("the child processes never became ready");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      writeFileSync(join(barrier, "go"), "");
      const outcomes = (await Promise.all(running)).map((result) => {
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
          allowed: boolean; sessionId?: string; reasonCode?: string; threw?: string; pid: number;
        };
      });
      expect(new Set(outcomes.map((outcome) => outcome.pid)).size).toBe(2);
      expect(outcomes.every((outcome) => outcome.pid !== process.pid)).toBe(true);
      const winners = outcomes.filter((outcome) => outcome.allowed);
      expect(winners, JSON.stringify(outcomes)).toHaveLength(1);
      const loser = outcomes.find((outcome) => !outcome.allowed)!;
      expect(loser.threw, JSON.stringify(loser)).toBeUndefined();
      // Exactly one record for the message, the carry, and the row with exactly one holder.
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.to_session_id]))
        .toEqual([[queued!.message_id, "CARRIED", winners[0]!.sessionId]]);
      expect(fixture.peerRows()[0]).toMatchObject({
        status: "PENDING", binding_generation: 2, target_session_id: winners[0]!.sessionId,
      });
      const ledger = ownerMessageLedger(harness.cp);
      const holder = fixture.holderOf(winners[0]!.sessionId!);
      expect(handedOver((() => { const t = ledger.claim(holder); return t.allowed ? t.value : null; })()).claimed)
        .toMatchObject({ messageId: queued!.message_id });
      expect(handedOver((() => { const t = ledger.claim(holder); return t.allowed ? t.value : null; })()).claimed)
        .toBeNull();
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("the refusal reaches the successor through the real CTO socket, and its report travels back over it", async () => {
    const fixture = await startFixture();
    const listeners = await startLocalMcpListeners(fixture.harness.cp, tempDir("acp-crs-"), "socket-test-token");
    let socket: ReturnType<typeof createConnection> | null = null;
    try {
      await fixture.ceoSays("소켓으로 알려질 거절된 지시");
      const [queued] = fixture.peerRows();
      // The operator's dead-binding door releases generation 1: the row is rejected and a notice owed.
      const predecessor = fixture.harness.cp.sessions.require(fixture.first.sessionId);
      expect(recoverDeadCanonicalBinding("operator", {
        projectId: fixture.projectId, role: Role.PRIMARY_CTO, sessionId: predecessor.sessionId,
        sessionIncarnation: predecessor.incarnation, expectedBindingGeneration: 1,
      }, {
        db: fixture.harness.cp.db, audit: fixture.harness.cp.audit, sessions: fixture.harness.cp.sessions,
        bindings: fixture.harness.cp.bindings, liveness: { signal: signalFrom(claudeRun(2)) },
      }).allowed).toBe(true);
      const successor = await restart(fixture, 2);
      const ctoPath = listeners.socketPaths[1]!;
      socket = createConnection(ctoPath);
      await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
      const pending = new Map<number, (body: Record<string, unknown>) => void>();
      let buffer = "";
      let nextId = 2;
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: { id?: number; method?: string; result?: { structuredContent?: Record<string, unknown> } };
          try { message = JSON.parse(line) as typeof message; } catch { continue; }
          if (message.method === undefined && message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)!(message.result?.structuredContent ?? { ok: false });
            pending.delete(message.id);
          }
        }
      });
      socket.write(`${JSON.stringify({ token: "socket-test-token", sessionId: successor.sessionId,
        sessionSecret: successor.sessionSecret })}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: { sampling: {} },
          clientInfo: { name: "cto-peer", version: "1" } } })}\n${JSON.stringify({ jsonrpc: "2.0",
        method: "notifications/initialized", params: {} })}\n`);
      const call = (name: string, args: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
      const first = await call("role_owner_message_claim", { roleKey: fixture.ctoRoleKey });
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
      expect((first["value"] as { refusedAtRestart?: unknown[] }).refusedAtRestart).toEqual([
        expect.objectContaining({ messageId: queued!.message_id, reason: "REVOKED" }),
      ]);
      expect(JSON.stringify(first)).not.toContain("소켓으로 알려질");
      const reported = await call("role_owner_message_report_refusal", {
        roleKey: fixture.ctoRoleKey, messageId: queued!.message_id,
      });
      expect(reported, JSON.stringify(reported)).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      const after = await call("role_owner_message_claim", { roleKey: fixture.ctoRoleKey });
      expect((after["value"] as { refusedAtRestart?: unknown[] }).refusedAtRestart).toBeUndefined();
    } finally {
      socket?.destroy();
      await listeners.close();
      await fixture.close();
    }
  }, 60_000);
});

describe("W6 the holder's claim and the restart's carry, on two connections, hand the message to one holder once", () => {
  /** A second connection to the same database file, as another process holds one. */
  const secondConnection = (fixture: Fixture) => {
    const db = openDb(join(fixture.harness.root, "state.sqlite"));
    const outbox = new Outbox(db, fixture.harness.clock, new AuditLog(db, fixture.harness.clock));
    return { db, outbox };
  };
  type Other = ReturnType<typeof secondConnection>;
  const CARRY_WRITE = /^\s*UPDATE outbox SET binding_generation = \?, target_session_id = \?, reason_code = \?/;
  const CLAIM_WRITE = /^\s*UPDATE outbox SET status = 'SENT', sent_at = \?, attempts = attempts \+ 1/;
  /** Every hand-over either connection made, by message and holder session. */
  const handOvers: Array<{ messageId: string; to: string }> = [];
  /** The holder's claim on the restart's own connection, through the real hand-over. */
  const takeHere = (fixture: Fixture, holder: HolderIdentity): string | null => {
    const taken = ownerMessageLedger(fixture.harness.cp).claim(holder);
    const claimed = handedOver(taken.allowed ? taken.value : null)?.claimed?.messageId ?? null;
    if (claimed) handOvers.push({ messageId: claimed, to: holder.targetSessionId });
    return claimed;
  };
  /** The holder's claim on the other connection. */
  const takeThere = (other: Other, holder: HolderIdentity): string | null => {
    const claimed = other.outbox.claimForHolder(holder, () => true).claimed[0]?.messageId ?? null;
    if (claimed) handOvers.push({ messageId: claimed, to: holder.targetSessionId });
    return claimed;
  };
  const exactlyOnce = (fixture: Fixture, messageId: string, to: string, carriedOnce: boolean) => {
    expect(handOvers.filter((h) => h.messageId === messageId)).toEqual([{ messageId, to }]);
    expect(fixture.carries().filter((carry) => carry.outcome === "CARRIED").map((carry) => carry.message_id))
      .toEqual(carriedOnce ? [messageId] : []);
  };

  it("claim first, on the other connection: the holder has it, the restart does not carry it", async () => {
    handOvers.length = 0;
    const fixture = await startFixture();
    const other = secondConnection(fixture);
    try {
      await fixture.ceoSays("다른 연결이 먼저 받는 지시");
      const [queued] = fixture.peerRows();
      expect(takeThere(other, fixture.holderOf(fixture.first.sessionId))).toBe(queued!.message_id);
      const successor = await restart(fixture, 2);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "REJECTED", binding_generation: 1 });
      expect(takeHere(fixture, fixture.holderOf(successor.sessionId))).toBeNull();
      expect(takeThere(other, fixture.holderOf(successor.sessionId))).toBeNull();
      exactlyOnce(fixture, queued!.message_id, fixture.first.sessionId, false);
    } finally {
      other.db.close();
      await fixture.close();
    }
  });

  it("carry first: the old holder's claim on the other connection is refused, the successor has it once", async () => {
    handOvers.length = 0;
    const fixture = await startFixture();
    const other = secondConnection(fixture);
    try {
      await fixture.ceoSays("먼저 옮겨지는 지시");
      const [queued] = fixture.peerRows();
      const successor = await restart(fixture, 2);
      const carriedRows = fixture.peerRows();
      expect(takeThere(other, fixture.holderAt(fixture.first.sessionId, 1))).toBeNull();
      expect(fixture.peerRows()).toEqual(carriedRows);
      expect(takeThere(other, fixture.holderOf(successor.sessionId))).toBe(queued!.message_id);
      expect(takeHere(fixture, fixture.holderOf(successor.sessionId))).toBeNull();
      exactlyOnce(fixture, queued!.message_id, successor.sessionId, true);
    } finally {
      other.db.close();
      await fixture.close();
    }
  });

  it("the old holder's claim started inside the carry's transaction is refused, not interleaved; the carry wins once", async () => {
    handOvers.length = 0;
    const fixture = await startFixture();
    const other = secondConnection(fixture);
    try {
      await fixture.ceoSays("옮겨지는 도중에 받으려는 지시");
      const [queued] = fixture.peerRows();
      const oldHolder = fixture.holderAt(fixture.first.sessionId, 1);
      const { db } = fixture.harness.cp;
      const run = db.run.bind(db);
      let inside: { claimed: string | null } | { error: unknown } | null = null;
      const spy = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (inside === null && CARRY_WRITE.test(sql)) {
          // The carry has read the row and holds the write lock; the other connection claims now.
          try {
            inside = { claimed: takeThere(other, oldHolder) };
          } catch (error) {
            inside = { error };
          }
        }
        return run(sql, params);
      }) as typeof db.run);
      let successor: Awaited<ReturnType<typeof restart>>;
      try {
        successor = await restart(fixture, 2);
      } finally {
        spy.mockRestore();
      }
      expect(inside).not.toBeNull();
      expect(inside).toHaveProperty("error");
      expect(String((inside as unknown as { error: unknown }).error)).toMatch(/locked|busy/i);
      expect(takeThere(other, oldHolder)).toBeNull();
      expect(takeThere(other, fixture.holderOf(successor.sessionId))).toBe(queued!.message_id);
      expect(takeHere(fixture, fixture.holderOf(successor.sessionId))).toBeNull();
      exactlyOnce(fixture, queued!.message_id, successor.sessionId, true);
    } finally {
      other.db.close();
      await fixture.close();
    }
  });

  it("a restart started inside the old holder's claim transaction does not carry what that claim took", async () => {
    handOvers.length = 0;
    const fixture = await startFixture();
    const other = secondConnection(fixture);
    try {
      await fixture.ceoSays("받는 도중에 재시작이 끼어드는 지시");
      const [queued] = fixture.peerRows();
      const run = other.db.run.bind(other.db);
      let restarting: Promise<unknown> | null = null;
      const spy = vi.spyOn(other.db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (restarting === null && CLAIM_WRITE.test(sql)) {
          // The claim has chosen the row and holds the write lock; the restart begins now.
          fixture.harness.clock.advance(60_000);
          restarting = fixture.claimAs(2).then((claimed) => claimed, (error: unknown) => ({ error }));
        }
        return run(sql, params);
      }) as typeof other.db.run);
      try {
        expect(takeThere(other, fixture.holderOf(fixture.first.sessionId))).toBe(queued!.message_id);
      } finally {
        spy.mockRestore();
      }
      expect(restarting).not.toBeNull();
      const first = (await restarting!) as { allowed?: boolean };
      // Either the restart's transaction ran after the claim committed, or it was refused while the
      // claim held the lock and is run again now. Either way it sees the row the claim took.
      const successorSessionId = first.allowed === true
        ? fixture.harness.cp.bindings.active(fixture.ctoRoleKey)!.sessionId
        : (await restart(fixture, 2)).sessionId;
      expect(successorSessionId).not.toBe(fixture.first.sessionId);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "REJECTED", binding_generation: 1 });
      expect(takeHere(fixture, fixture.holderOf(successorSessionId))).toBeNull();
      expect(takeThere(other, fixture.holderOf(successorSessionId))).toBeNull();
      exactlyOnce(fixture, queued!.message_id, fixture.first.sessionId, false);
    } finally {
      other.db.close();
      await fixture.close();
    }
  });
});


// Independent narrow-review witness: SQLite and JSON.parse choose different duplicate keys.
it.each(["original-holder", "restart-carry"] as const)("NARROW duplicate sourceNonce bypasses terminal history on %s", async (path) => {
  const fixture = await startFixture();
  try {
    const { harness } = fixture;
    const event = await fixture.ceoSays("a completed instruction must not be handed over");
    const [queued] = fixture.peerRows();
    const nonce = buzzMessageNonce(event.id);
    expect(new IngressGuard(harness.cp.db, harness.clock, harness.cp.audit, {})
      .completeNoReplyAndResolveTurn("buzz", nonce).allowed).toBe(true);
    harness.cp.db.run(
      `UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.noReplyAt')
       WHERE channel = 'buzz' AND nonce = ?`, [nonce]);
    const pointer = JSON.parse(queued!.payload_json) as Record<string, unknown>;
    const duplicate = '{"sourceNonce":"buzz-message:never-spent",' + queued!.payload_json.slice(1);
    expect(JSON.parse(duplicate)).toEqual(pointer);
    expect(harness.cp.db.get(`SELECT json_extract(?, '$.sourceNonce') AS nonce`, [duplicate]))
      .toEqual({ nonce: "buzz-message:never-spent" });
    harness.cp.db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [duplicate, queued!.message_id]);
    expect(harness.cp.db.get(
      `SELECT reason FROM holder_message_source_departures WHERE source_channel = 'buzz' AND source_nonce = ?`,
      [nonce])).toEqual({ reason: "TURN_TERMINAL" });
    if (path === "restart-carry") {
      await restart(fixture, 2);
      expect(fixture.carries().map((carry) => carry.outcome)).toEqual(["REFUSED"]);
    } else {
      const claimed = ownerMessageLedger(harness.cp).claim(fixture.holderOf(fixture.first.sessionId));
      expect(handedOver(claimed.allowed ? claimed.value : null).claimed).toBeNull();
    }
  } finally {
    await fixture.close();
  }
});


it.each(["takeover", "runtime-move"] as const)("NARROW duplicate sourceNonce bypasses terminal history on %s", (path) => {
  const core = makeCore();
  const run = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
  const nonce = "buzz-message:answered";
  core.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json)
     VALUES ('buzz', ?, 'owner', ?, ?)`,
    [nonce, core.clock.nowIso(), JSON.stringify({ turnRequestId: "turn-answered", noReplyAt: core.clock.nowIso() })]);
  core.db.run(`UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.noReplyAt')
                WHERE channel = 'buzz' AND nonce = ?`, [nonce]);
  const enqueue = (sourceNonce: string) => {
    const result = core.outbox.enqueue({
      idempotencyKey: sourceNonce, roleKey: run.roleKey, bindingGeneration: run.generation,
      targetSessionId: run.sessionId, runId: run.runId, kind: MessageKind.OWNER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce, sourcePayloadDigest: `sha256:${sourceNonce}` },
    });
    if (!result.allowed) throw new Error(result.message);
    return result.value.messageId;
  };
  const answered = enqueue(nonce);
  const fresh = enqueue("buzz-message:fresh");
  const row = core.db.get<{ payload_json: string }>(`SELECT payload_json FROM outbox WHERE message_id = ?`, [answered])!;
  const duplicate = '{"sourceNonce":"buzz-message:never-spent",' + row.payload_json.slice(1);
  core.db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [duplicate, answered]);
  const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
  expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
  const result = path === "takeover"
    ? core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId)
    : core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
  expect("retargeted" in result ? result.retargeted : result.carried).toEqual([fresh]);
  expect(result.rejected).toEqual([answered]);
});

/**
 * Review finding 01, narrow review of a5a0800a — the class behind the four witnesses above. SQLite's
 * `json_extract` reads the first of two duplicate keys and `JSON.parse` the last, so the predicate
 * could check one event while the consumer delivered another. Two layers close it, each with a
 * witness below that fails when only it is removed:
 *
 * - every hand-over *read* decides from the very parse the consumer delivers
 *   (`Outbox.#payloadHandOverEligible`): bytes that are not the canonical serialization of that parse
 *   — what `enqueue` writes — are refused, and the event the parsed pointer names must be unspent.
 *   That is the restart carry's parsed-pointer check from 22c8b40d, restored and on every path;
 * - every hand-over *write* asserts `handOverEligibleSql`, which now refuses a payload with a
 *   duplicate key, so the pointer its own `json_extract` checks is the one `JSON.parse` returns.
 *
 * The rows are written with ordinary statements: no schema guard refuses a duplicate key at write,
 * so the hand-over is what must not move one.
 */
describe("finding 01, narrow review: the pointer the predicate checks is the pointer the consumer delivers", () => {
  const NEVER_SPENT = "buzz-message:never-spent";
  /** A spelling of `"sourceNonce"` SQLite and JSON.parse both decode to the same key. */
  const SPELLINGS = { plain: "sourceNonce", escaped: "source\\u004eonce" } as const;
  /** The reviewer's pointer: a never-spent `sourceNonce` first, the real one still last. */
  const duplicated = (payloadJson: string, spelling: keyof typeof SPELLINGS = "plain"): string =>
    `{"${SPELLINGS[spelling]}":"${NEVER_SPENT}",${payloadJson.slice(1)}`;
  /** What SQLite reads of that pointer — the never-spent event — written canonically. */
  const sqliteView = (payloadJson: string): string =>
    JSON.stringify({ ...(JSON.parse(payloadJson) as Record<string, unknown>), sourceNonce: NEVER_SPENT });
  /** Bytes with each key once but not as `enqueue` wrote them: something else rewrote the row. */
  const respelled = (payloadJson: string): string => JSON.stringify(JSON.parse(payloadJson), null, 1);

  /** The real ingress no-reply completion, then the terminal fact erased; its TURN_TERMINAL stays. */
  const answerAndErase = (fixture: Fixture, eventId: string): void => {
    const { harness } = fixture;
    const nonce = buzzMessageNonce(eventId);
    expect(new IngressGuard(harness.cp.db, harness.clock, harness.cp.audit, {})
      .completeNoReplyAndResolveTurn("buzz", nonce).allowed).toBe(true);
    harness.cp.db.run(
      `UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.noReplyAt')
        WHERE channel = 'buzz' AND nonce = ?`, [nonce]);
    expect(harness.cp.db.get(
      `SELECT reason FROM holder_message_source_departures WHERE source_channel = 'buzz' AND source_nonce = ?`,
      [nonce])).toEqual({ reason: "TURN_TERMINAL" });
  };

  /** Two owner's messages for a takeover or a runtime move: one whose turn was answered, one fresh. */
  const coreWithAnswered = () => {
    const core = makeCore();
    const run = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
    const enqueue = (sourceNonce: string): string => {
      const result = core.outbox.enqueue({
        idempotencyKey: sourceNonce, roleKey: run.roleKey, bindingGeneration: run.generation,
        targetSessionId: run.sessionId, runId: run.runId, kind: MessageKind.OWNER_MESSAGE,
        payload: { sourceChannel: "buzz", sourceNonce, sourcePayloadDigest: `sha256:${sourceNonce}` },
      });
      if (!result.allowed) throw new Error(result.message);
      return result.value.messageId;
    };
    core.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json)
       VALUES ('buzz', 'buzz-message:answered', 'owner', ?, ?)`,
      [core.clock.nowIso(), JSON.stringify({ turnRequestId: "turn-answered", noReplyAt: core.clock.nowIso() })]);
    core.db.run(`UPDATE inbound_messages SET turn_claim_json = json_remove(turn_claim_json, '$.noReplyAt')
                  WHERE channel = 'buzz' AND nonce = 'buzz-message:answered'`);
    const answered = enqueue("buzz-message:answered");
    const fresh = enqueue("buzz-message:fresh");
    const payloadOf = (messageId: string): string =>
      core.db.get<{ payload_json: string }>(`SELECT payload_json FROM outbox WHERE message_id = ?`, [messageId])!.payload_json;
    const rewrite = (messageId: string, payloadJson: string): void => {
      expect(core.db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [payloadJson, messageId]).changes).toBe(1);
    };
    const move = (path: "takeover" | "runtime-move") => {
      const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
      expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
      const moved = path === "takeover"
        ? core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId)
        : core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
      return { passed: "retargeted" in moved ? moved.retargeted : moved.carried, rejected: moved.rejected };
    };
    return { core, enqueue, answered, fresh, payloadOf, rewrite, move };
  };

  it.each(["takeover", "runtime-move"] as const)("the escape-spelled duplicate (\"source\\u004eonce\") is refused on %s as well", (path) => {
    const { core, answered, fresh, payloadOf, rewrite, move } = coreWithAnswered();
    const duplicate = duplicated(payloadOf(answered), "escaped");
    expect(core.db.get(`SELECT json_extract(?, '$.sourceNonce') AS nonce`, [duplicate])).toEqual({ nonce: NEVER_SPENT });
    expect(JSON.parse(duplicate)).toEqual(JSON.parse(payloadOf(answered)));
    rewrite(answered, duplicate);
    expect(move(path)).toEqual({ passed: [fresh], rejected: [answered] });
  });

  it.each(["original-holder", "restart-carry"] as const)("the escape-spelled duplicate is refused on %s as well", async (path) => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      const event = await fixture.ceoSays("이스케이프된 중복 키의 지시");
      const [queued] = fixture.peerRows();
      answerAndErase(fixture, event.id);
      harness.cp.db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`,
        [duplicated(queued!.payload_json, "escaped"), queued!.message_id]);
      if (path === "restart-carry") {
        await restart(fixture, 2);
        expect(fixture.carries().map((carry) => [carry.outcome, carry.refusal])).toEqual([["REFUSED", "ALREADY_CLAIMED"]]);
      } else {
        const claimed = ownerMessageLedger(harness.cp).claim(fixture.holderOf(fixture.first.sessionId));
        expect(handedOver(claimed.allowed ? claimed.value : null).claimed).toBeNull();
      }
    } finally {
      await fixture.close();
    }
  });

  // The write layer: `handOverEligibleSql`'s duplicate-key clause, in each path's moving write. The
  // read is made to have seen what SQLite reads — the never-spent event, written canonically — so it
  // admits the row, and only the write stands between the answered turn and a hand-over.
  it("W the claim's write refuses a duplicate-key pointer even when its read has missed it", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const event = await fixture.ceoSays("읽기가 놓친 중복 키 지시");
      const [queued] = fixture.peerRows();
      answerAndErase(fixture, event.id);
      db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [duplicated(queued!.payload_json), queued!.message_id]);
      const view = sqliteView(queued!.payload_json);
      const all = db.all.bind(db);
      const spy = vi.spyOn(db, "all").mockImplementation(((sql: string, params: unknown[] = []) => {
        const rows = all(sql, params) as Array<Record<string, unknown>>;
        return /AS never_departed/.test(sql)
          ? rows.map((row) => row["message_id"] === queued!.message_id ? { ...row, never_departed: 1, payload_json: view } : row)
          : rows;
      }) as typeof db.all);
      let claimed: unknown[];
      try {
        claimed = fixture.harness.cp.outbox.claimForHolder(fixture.holderOf(fixture.first.sessionId), () => true).claimed;
      } finally {
        spy.mockRestore();
      }
      expect(claimed).toEqual([]);
      expect(fixture.peerRows()[0]).toMatchObject({ message_id: queued!.message_id, status: "PENDING" });
    } finally {
      await fixture.close();
    }
  });

  it("W the carry's write refuses a duplicate-key pointer even when its read has missed it", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const event = await fixture.ceoSays("운반 읽기가 놓친 중복 키 지시");
      const [queued] = fixture.peerRows();
      answerAndErase(fixture, event.id);
      db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [duplicated(queued!.payload_json), queued!.message_id]);
      const view = sqliteView(queued!.payload_json);
      const get = db.get.bind(db);
      const spy = vi.spyOn(db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
        /AS eligible(?:, o\.payload_json)? FROM outbox o/.test(sql) ? { eligible: 1, payload_json: view } : get(sql, params)) as typeof db.get);
      try {
        await restart(fixture, 2);
      } finally {
        spy.mockRestore();
      }
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [queued!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
      expect(fixture.peerRows()[0]).toMatchObject({ status: "REJECTED", binding_generation: 1 });
    } finally {
      await fixture.close();
    }
  });

  it.each(["takeover", "runtime-move"] as const)("W the %s write refuses a duplicate-key pointer even when its read has missed it", (path) => {
    const { core, answered, fresh, payloadOf, rewrite, move } = coreWithAnswered();
    const canonical = payloadOf(answered);
    rewrite(answered, duplicated(canonical));
    const view = sqliteView(canonical);
    const get = core.db.get.bind(core.db);
    const spy = vi.spyOn(core.db, "get").mockImplementation(((sql: string, params: unknown[] = []) =>
      /AS eligible(?:, o\.payload_json)? FROM outbox o/.test(sql) && params.includes(answered)
        ? { eligible: 1, payload_json: view }
        : get(sql, params)) as typeof core.db.get);
    let moved: ReturnType<typeof move>;
    try {
      moved = move(path);
    } finally {
      spy.mockRestore();
    }
    expect(moved).toEqual({ passed: [fresh], rejected: [answered] });
  });

  // The read layer, canonical bytes: each key once, the event never spent — refused all the same,
  // because the bytes are not what `enqueue` wrote, on every path.
  it.each(["original-holder", "restart-carry"] as const)("R a payload not in its canonical bytes is not handed over on %s", async (path) => {
    const fixture = await startFixture();
    try {
      const { harness } = fixture;
      await fixture.ceoSays("다시 쓰인 바이트의 지시");
      const [queued] = fixture.peerRows();
      const bytes = respelled(queued!.payload_json);
      expect(JSON.parse(bytes)).toEqual(JSON.parse(queued!.payload_json));
      harness.cp.db.run(`UPDATE outbox SET payload_json = ? WHERE message_id = ?`, [bytes, queued!.message_id]);
      if (path === "restart-carry") {
        await restart(fixture, 2);
        expect(fixture.carries().map((carry) => [carry.outcome, carry.refusal])).toEqual([["REFUSED", "ALREADY_CLAIMED"]]);
      } else {
        const claimed = ownerMessageLedger(harness.cp).claim(fixture.holderOf(fixture.first.sessionId));
        expect(handedOver(claimed.allowed ? claimed.value : null)).toMatchObject({
          claimed: null, withheld: [{ messageId: queued!.message_id }],
        });
      }
      expect(fixture.peerRows()[0]!.status).not.toBe("SENT");
    } finally {
      await fixture.close();
    }
  });

  it.each(["takeover", "runtime-move"] as const)("R a payload not in its canonical bytes is not moved on %s", (path) => {
    const { enqueue, answered, fresh, payloadOf, rewrite, move } = coreWithAnswered();
    const rewritten = enqueue("buzz-message:rewritten");
    rewrite(rewritten, respelled(payloadOf(rewritten)));
    const moved = move(path);
    expect(moved.passed).toEqual([fresh]);
    expect([...moved.rejected].sort()).toEqual([answered, rewritten].sort());
  });

  // The read layer, the parsed pointer — 22c8b40d's carry check, on every path. The SQL read is made
  // to have missed an answered turn; the read still refuses, from the parse, before any write.
  it("R the claim's read refuses an answered turn from the parsed pointer before any write", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const event = await fixture.ceoSays("파싱된 포인터로 거절되는 지시");
      const [queued] = fixture.peerRows();
      answerAndErase(fixture, event.id);
      const all = db.all.bind(db);
      const run = db.run.bind(db);
      let writes = 0;
      const reads = vi.spyOn(db, "all").mockImplementation(((sql: string, params: unknown[] = []) => {
        const rows = all(sql, params) as Array<Record<string, unknown>>;
        return /AS never_departed/.test(sql) ? rows.map((row) => ({ ...row, never_departed: 1 })) : rows;
      }) as typeof db.all);
      const moves = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/^\s*UPDATE outbox SET status = 'SENT', sent_at = \?/.test(sql)) writes += 1;
        return run(sql, params);
      }) as typeof db.run);
      let result: ReturnType<Outbox["claimForHolder"]>;
      try {
        result = fixture.harness.cp.outbox.claimForHolder(fixture.holderOf(fixture.first.sessionId), () => true);
      } finally {
        reads.mockRestore();
        moves.mockRestore();
      }
      expect(writes).toBe(0);
      expect(result.claimed).toEqual([]);
      expect(result.withheld.map((row) => row.messageId)).toEqual([queued!.message_id]);
    } finally {
      await fixture.close();
    }
  });

  it("R the carry's read refuses an answered turn from the parsed pointer before any write", async () => {
    const fixture = await startFixture();
    try {
      const { db } = fixture.harness.cp;
      const event = await fixture.ceoSays("운반이 파싱으로 거절하는 지시");
      const [queued] = fixture.peerRows();
      answerAndErase(fixture, event.id);
      const get = db.get.bind(db);
      const run = db.run.bind(db);
      let carryWrites = 0;
      const reads = vi.spyOn(db, "get").mockImplementation(((sql: string, params: unknown[] = []) => {
        const row = get(sql, params) as Record<string, unknown> | undefined;
        return /AS eligible(?:, o\.payload_json)? FROM outbox o/.test(sql) && row ? { ...row, eligible: 1 } : row;
      }) as typeof db.get);
      const moves = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
        if (/AND attempts = 0 AND sent_at IS NULL AND claim_token IS NULL/.test(sql)) carryWrites += 1;
        return run(sql, params);
      }) as typeof db.run);
      try {
        await restart(fixture, 2);
      } finally {
        reads.mockRestore();
        moves.mockRestore();
      }
      expect(carryWrites).toBe(0);
      expect(fixture.carries().map((carry) => [carry.message_id, carry.outcome, carry.refusal])).toEqual([
        [queued!.message_id, "REFUSED", "ALREADY_CLAIMED"],
      ]);
    } finally {
      await fixture.close();
    }
  });

  it.each(["takeover", "runtime-move"] as const)("R the %s read refuses an answered turn from the parsed pointer before any move", (path) => {
    const { core, answered, fresh, move } = coreWithAnswered();
    const get = core.db.get.bind(core.db);
    const run = core.db.run.bind(core.db);
    const attempts: string[] = [];
    const reads = vi.spyOn(core.db, "get").mockImplementation(((sql: string, params: unknown[] = []) => {
      const row = get(sql, params) as Record<string, unknown> | undefined;
      return /AS eligible(?:, o\.payload_json)? FROM outbox o/.test(sql) && row ? { ...row, eligible: 1 } : row;
    }) as typeof core.db.get);
    const moves = vi.spyOn(core.db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
      if (/^\s*UPDATE outbox SET (binding_generation = \?, )?target_session_id = \?/.test(sql) &&
          params.includes(answered)) attempts.push(answered);
      return run(sql, params);
    }) as typeof core.db.run);
    let moved: ReturnType<typeof move>;
    try {
      moved = move(path);
    } finally {
      reads.mockRestore();
      moves.mockRestore();
    }
    expect(attempts).toEqual([]);
    expect(moved).toEqual({ passed: [fresh], rejected: [answered] });
  });

  // The read layer, bytes with no parse (narrow review 2). SQLite stops at a NUL that `JSON.parse`
  // rejects, so a pointer followed by one is valid to `json_valid`, names a never-spent event to
  // `json_extract` and has no duplicate key: only the read's own parse refuses it, before any move.
  it.each(["takeover", "runtime-move"] as const)("R bytes JSON.parse refuses but SQLite reads (a trailing NUL) are not moved on %s", (path) => {
    const { core, answered, fresh, payloadOf, rewrite, move } = coreWithAnswered();
    const bytes = `${payloadOf(fresh)}\u0000`;
    expect(() => JSON.parse(bytes)).toThrow();
    expect(core.db.get(`SELECT json_valid(?) AS valid, json_extract(?, '$.sourceNonce') AS nonce`, [bytes, bytes]))
      .toEqual({ valid: 1, nonce: "buzz-message:fresh" });
    rewrite(fresh, bytes);
    expect(payloadOf(fresh)).toBe(bytes);
    const moved = move(path);
    expect(moved.passed).toEqual([]);
    expect([...moved.rejected].sort()).toEqual([answered, fresh].sort());
  });

  // The same question for the other JSON the predicate reads: an ingress turn claim's terminal facts
  // are read by SQL (`json_extract`, and `json_type` in the TURN_TERMINAL triggers) and by
  // `JSON.parse`. v38's claim guards already refuse a claim with a duplicate key on every write:
  // shown here for the three facts, on UPDATE of an open claim, on the first claim, and on INSERT.
  it.each(["noReplyAt", "repliedAt", "settledAt"] as const)("a turn claim with a duplicated %s is refused on every write", (fact) => {
    const core = makeCore();
    const claim = `{"turnRequestId":"turn-open","${fact}":null,"${fact}":"2026-10-04T00:00:00.000Z"}`;
    expect(core.db.get(`SELECT json_extract(?, '$.${fact}') AS first`, [claim])).toEqual({ first: null });
    core.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json) VALUES ('buzz', 'buzz-message:open', 'owner', ?, ?)`,
      [core.clock.nowIso(), JSON.stringify({ turnRequestId: "turn-open" })]);
    core.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('buzz', 'buzz-message:unclaimed', 'owner', ?)`,
      [core.clock.nowIso()]);
    expect(() => core.db.run(`UPDATE inbound_messages SET turn_claim_json = ? WHERE nonce = 'buzz-message:open'`, [claim]))
      .toThrow(/INBOUND_OVERRIDE_AUTHORITY_IMMUTABLE/u);
    expect(() => core.db.run(`UPDATE inbound_messages SET turn_claim_json = ? WHERE nonce = 'buzz-message:unclaimed'`, [claim]))
      .toThrow(/INGRESS_OVERRIDE_CLAIM_AUTHORITY_DENIED/u);
    expect(() => core.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json) VALUES ('buzz', 'buzz-message:new', 'owner', ?, ?)`,
      [core.clock.nowIso(), claim])).toThrow(/INGRESS_OVERRIDE_CLAIM_AUTHORITY_DENIED/u);
  });
});
