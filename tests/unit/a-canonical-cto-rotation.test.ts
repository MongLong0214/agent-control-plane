import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dispatch } from "../../src/cli/agentctl.ts";
import {
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionEvent,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { sha256 } from "../../src/core/digest.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionSubscriberRegistry,
  canonicalCtoOperator,
  ownerMessageLedger,
  ownerOnlyCanonicalCtoOperator,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { executeCanonicalSelfClaimOperator } from "../../src/daemon/canonical-self-claim-operator.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { HolderIdentity } from "../../src/outbox/outbox.ts";
import type { CanonicalSwitchoverPrepared, HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import {
  type CanonicalAdoptableSession,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
  hostSessionRegistryAbsent,
} from "../../src/registry/canonical-self-claim.ts";
import { CanonicalSessionRegistry } from "../../src/registry/canonical-session-registry.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bootstrapCtoProvider, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const stragglers: ChildProcess[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/**
 * v58 — `agentctl canonical-cto rotate` moves a project's canonical PRIMARY_CTO to a new conversation UUID as the
 * SAME conversational actor. The owner's rotate records a pending v57 transfer and its rotation; the new
 * conversation's self-claim at exactly the issued generation fences the old holder (binding revoked, session
 * stopped), moves the actor's target to the new UUID, binds the same actor, and carries what the old holder left.
 *
 * Real: SQLite, the self-claim, the outbox, the Buzz subscriber and ingress that admit the CEO's mentions, and the
 * hand-over. Fixtures: the process table, image scan, transcript lookup and the relay socket.
 */

const OLD = "58cac5c6-0000-4000-8000-0000000000a1";
const NEW = "36276d16-0000-4000-8000-0000000000a2";
const SPARE = "77777777-0000-4000-8000-0000000000a3";
const OTHER = "66666666-0000-4000-8000-0000000000b1";
const CWD = "/work/rotation";
const ROOM = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_ROOM = "bbbbbbbb-0000-4000-8000-00000000000b";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_UID = 501;
const SECRET = "canonical-cto-rotation-test-secret";
const OWNER = "isaac-cli";
const HANDOFF: HandoffPackage = {
  projectStatus: "green; nothing in flight", activeManifestDigest: null, recentDecisions: ["keep the v58 rotation"],
  openBlockers: [], queuedWork: ["answer the CEO's queued mentions"], repositoryFacts: [], knownRisks: [],
  recommendedNextAction: "acknowledge the switchover and continue",
};
const CONTRACT = {
  goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
  acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [],
};

const key = () => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};

/** The claude process of conversation `uuid`, as process `pid`. */
const claudeOf = (uuid: string, pid: number, startedAt = `start-${pid}`): ProcessSnapshot[] => [
  { pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/agentctl.js"], command: "/usr/bin/node /opt/acp/agentctl.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1" },
  { pid: 50, ppid: pid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD, cwdProbeFailure: null, startedAt: "t2" },
  { pid, ppid: 1, argv: ["/opt/claude/claude", "--session-id", uuid], command: `/opt/claude/claude --session-id ${uuid}`, cwd: CWD, cwdProbeFailure: null, startedAt },
];

const manualRelay = () => {
  const sockets: { sent: string[]; handlers: BuzzRelaySocketHandlers }[] = [];
  const factory: BuzzRelaySocketFactory = (_url, handlers) => {
    const socket = { sent: [] as string[], handlers };
    sockets.push(socket);
    return { send: (raw) => socket.sent.push(raw), close: () => undefined };
  };
  const live = () => sockets.at(-1)!;
  return {
    factory, live,
    subscribe: async (handle: { settled(): Promise<void> }): Promise<string> => {
      const socket = live();
      socket.handlers.onFrame(JSON.stringify(["AUTH", "relay-challenge"]));
      await handle.settled();
      const frames = () => socket.sent.map((raw) => JSON.parse(raw) as unknown[]);
      const auth = frames().at(-1) as [string, { id: string }];
      socket.handlers.onFrame(JSON.stringify(["OK", auth[1].id, true, ""]));
      await handle.settled();
      return (frames().find((sent) => sent[0] === "REQ") as [string, string])[1];
    },
  };
};

interface Handover { claimed: { messageId: string; text: string } | null; unresolved: { messageId: string }[]; withheld: { messageId: string }[] }

const world = async () => {
  const ceo = key();
  const cto = key();
  const otherCto = key();
  const buzzOwner = key();
  const harness = makeHarness({ ownerIdentities: [{ channel: "cli", actor: OWNER }, { channel: "buzz", actor: buzzOwner.pubkey }] });
  const { db } = harness.cp;
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  harness.cp.projects.register({ projectId: "other-project", name: "other" });
  const other = { projectId: "other-project" };
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  bootstrapCtoProvider(harness.cp, harness.clock);
  // The deployment's configuration names the old conversation; the daemon grants it at start. It is never edited.
  const configured: CanonicalAdoptableSession[] = [
    { sessionUuid: OLD, projectId, buzzActorId: cto.pubkey, buzzAddress: ROOM },
    { sessionUuid: OTHER, projectId: other.projectId, buzzActorId: otherCto.pubkey, buzzAddress: OTHER_ROOM },
  ];
  const registry = new CanonicalSessionRegistry(db);
  for (const entry of registry.effective(configured)) registry.grant({ ...entry, buzzAddress: entry.buzzAddress! }, null);

  // Each conversation's claude process is a live stand-in, so a run is dispatched to a running CTO.
  const standIn = async () => {
    const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
    stragglers.push(child);
    await once(child, "spawn");
    return { pid: child.pid!, start: readProcessStartToken(child.pid!)! };
  };
  const live = await standIn();
  const next = await standIn();
  const starts = new Map([[live.pid, live.start], [next.pid, next.start]]);

  /** One self-claim through the daemon's operator door, over the configured entries the daemon started with. */
  const claimAs = (uuid: string, generation: number, pid: number): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = claudeOf(uuid, pid, starts.get(pid));
    return executeCanonicalSelfClaimOperator({ peerPid: 100, uid: PEER_UID }, { claimedSessionUuid: uuid, projectId: uuid === OTHER ? other.projectId : projectId, expectedBindingGeneration: generation }, {
      db, clock: harness.clock, audit: harness.cp.audit, sessions: harness.cp.sessions, bindings: harness.cp.bindings,
      buzzActorAuthenticator: { isAllowedActor: () => true },
      resolveBuzzAddress: async (_purpose, channel): Promise<Decision<string>> => allow(ReasonCode.OK, channel),
      config: {
        canonicalSessions: configured, canonicalBuzzChannelId: ROOM, expectedPeerProtocolVersion: PEER_PROTOCOL,
        expectedPeerIdentity: `uid:${PEER_UID}`, peerProtocolVersion: PEER_PROTOCOL, buzzPurpose: "continuity:PRIMARY_CTO",
      },
      claimDeps: {
        processInspector: { snapshot: (p) => chain.find((entry) => entry.pid === p) ?? null },
        imageInspector: { resolve: () => ({ imagePath: "/fake/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }) },
        transcriptReader: { locate: (u) => ({ path: `/fake/transcripts/${u}.jsonl`, sizeBytes: 42 }) },
        hostSessionRegistryReader: { read: (p) => hostSessionRegistryAbsent(`/fake/sessions/${p}.json is absent`) },
        processSignal: (p) => {
          if (!chain.some((entry) => entry.pid === p)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        },
      },
    });
  };

  const first = await claimAs(OLD, 1, live.pid);
  if (!first.allowed) throw new Error(`the old conversation's claim failed: ${JSON.stringify(first)}`);
  const oldSessionId = first.value.sessionId;
  const otherClaim = await claimAs(OTHER, 1, 33);
  if (!otherClaim.allowed) throw new Error(`the other project's claim failed: ${JSON.stringify(otherClaim)}`);

  // The CEO, its Buzz identity, and the daemon's own mention subscriber and ingress.
  const ceoSession = harness.cp.sessions.create({ provider: "scripted", model: "ceo", buzzAddress: null });
  harness.cp.sessions.transition(ceoSession.sessionId, SessionLifecycle.READY, "test");
  const ceoBound = harness.cp.bindings.bind({ roleKey: roleKeyFor(Role.CEO), role: Role.CEO, sessionId: ceoSession.sessionId });
  if (!ceoBound.allowed) throw new Error(ceoBound.message);
  harness.cp.sessions.bindBuzzActor({ sessionId: ceoSession.sessionId, sessionSecret: ceoSession.sessionSecret!, buzzActorId: ceo.pubkey },
    { isAllowedActor: () => true });
  const dir = tempDir("acp-rot-");
  chmodSync(dir, 0o700);
  const keyFile = join(dir, "cto.nostr.key");
  writeFileSync(keyFile, `${Buffer.from(cto.secret).toString("hex")}\n`, { mode: 0o600 });
  writeFileSync(join(dir, BUZZ_SUBSCRIBER_CONFIG_FILENAME), JSON.stringify({
    relayUrl: "wss://relay.example.invalid/buzz", identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms: [ROOM] }],
  }));
  const policy = { allowedActors: [buzzOwner.pubkey, ceo.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(harness.cp, dir, policy, { ceoConversation: new CeoConversationPort(), ownerActors: [buzzOwner.pubkey] });
  const relay = manualRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(harness.cp, dir, policy, ingress, {
    openSocket: relay.factory, scheduler: { setTimer: () => 0, clearTimer: () => undefined, nowSeconds: () => 1_900_000_000 },
  });
  let receiving = true;
  const closeReception = async () => { if (receiving) { receiving = false; subscriber.close(); await ingress.close(); } };
  closers.push(closeReception);
  const subId = await relay.subscribe(subscriber);
  const ceoSays = async (text: string): Promise<string> => {
    const before = db.get<{ n: number }>(`SELECT COALESCE(MAX(rowid), 0) AS n FROM outbox WHERE kind = ?`, [MessageKind.PEER_MESSAGE])!.n;
    harness.clock.advance(1_000);
    const event = finalizeEvent({ kind: 9, created_at: Math.floor(harness.clock.now().getTime() / 1000),
      tags: [["p", cto.pubkey], ["h", ROOM]], content: text }, ceo.secret) as BuzzMentionEvent;
    relay.live().handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
    await subscriber.settled();
    const row = db.get<{ message_id: string }>(`SELECT message_id FROM outbox WHERE kind = ? AND rowid > ? ORDER BY rowid DESC`,
      [MessageKind.PEER_MESSAGE, before]);
    if (!row) {
      const recent = db.all<{ kind: string; reason_code: string | null }>(`SELECT kind, reason_code FROM audit_events ORDER BY event_id DESC LIMIT 6`);
      throw new Error(`the CEO's mention "${text}" was not queued: ${JSON.stringify(recent)}`);
    }
    return row.message_id;
  };

  /** A run of the project, created; dispatched to whoever holds the role when `dispatch` is set. */
  const run = async (dispatch: boolean) => {
    const created = harness.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
      repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    return { runId: created.value.runId, dispatched: dispatch ? await harness.cp.runs.dispatch(created.value.runId) : null };
  };

  /** The owner's `agentctl canonical-cto rotate`, with the handoff package unless `handoff` is undefined. */
  const rotate = (toSessionUuid: string, expectedGeneration: number, handoff: HandoffPackage | undefined = HANDOFF): Decision<CanonicalSwitchoverPrepared> =>
    harness.cp.cto.prepareCanonicalSwitchover({ projectId, toSessionUuid, expectedGeneration, ...(handoff ? { handoff } : {}) }, OWNER);
  const holder = (sessionId: string, generation: number): HolderIdentity => ({
    roleKey, bindingGeneration: generation, targetSessionId: sessionId, sessionIncarnation: harness.cp.sessions.require(sessionId).incarnation,
  });
  const ledger = ownerMessageLedger(harness.cp);
  const take = (sessionId: string, generation: number): Handover => {
    const taken = ledger.claim(holder(sessionId, generation));
    if (!taken.allowed) throw new Error(JSON.stringify(taken));
    return taken.value as unknown as Handover;
  };
  const actorOf = (generation: number, role = roleKey) =>
    db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = ?`, [role, generation])?.actor_id;
  const target = (actorId: string) => db.get<{ target_binding_id: string; target_locator: string }>(
    `SELECT target_binding_id, target_locator FROM actor_target_bindings WHERE target_actor_id = ?`, [actorId]);
  const status = (generation: number) =>
    db.get<{ status: string }>(`SELECT status FROM assignments WHERE role_key = ? AND binding_generation = ?`, [roleKey, generation])?.status;
  const audits = (kind: string) => db.all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`, [kind])
    .map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);
  const judge = () => buzzMentionSubscriberRegistry(harness.cp, { sessions: configured }).judgeIdentity?.(cto.pubkey);
  /** Every row the other project owns: its binding, actor, target, sessions, entitlement and mail. */
  const otherProjectRows = () => {
    const otherRole = roleKeyFor(Role.PRIMARY_CTO, { projectId: other.projectId });
    return JSON.stringify([
      db.all(`SELECT * FROM assignments WHERE role_key = ? ORDER BY binding_generation`, [otherRole]),
      db.all(`SELECT c.* , tb.target_locator FROM conversational_actors c JOIN actor_target_bindings tb ON tb.target_actor_id = c.actor_id WHERE tb.target_locator = ?`, [OTHER]),
      db.all(`SELECT session_id, lifecycle, buzz_actor_id, buzz_address FROM sessions WHERE buzz_actor_id = ?`, [otherCto.pubkey]),
      db.all(`SELECT * FROM canonical_session_entitlements WHERE project_id = ?`, [other.projectId]),
      db.all(`SELECT * FROM canonical_entitlement_transfers WHERE project_id = ?`, [other.projectId]),
      db.all(`SELECT message_id, status, binding_generation, target_session_id FROM outbox WHERE role_key = ?`, [otherRole]),
    ]);
  };
  return {
    harness, db, projectId, roleKey, registry, configured, oldSessionId, other, claimAs, rotate, take, ledger, holder,
    actorOf, target, status, audits, judge, ceoSays, otherProjectRows, cto, run, newPid: next.pid,
    reception: () => ({ subscriber, ingress }), closeReception,
  };
};
type World = Awaited<ReturnType<typeof world>>;

const pending = (decision: Decision<CanonicalSwitchoverPrepared>) => {
  expect(decision.allowed, JSON.stringify(decision)).toBe(true);
  if (!decision.allowed || decision.value.outcome !== "SWITCHOVER_PENDING") throw new Error("not a pending switchover");
  return decision.value;
};
const claimed = (decision: Decision<CanonicalSelfClaimReceipt>) => {
  expect(decision.allowed, JSON.stringify(decision)).toBe(true);
  if (!decision.allowed) throw new Error("unreachable");
  return decision.value;
};

/** Nothing about the role moved: the old conversation still holds the entitlement and the ACTIVE binding, in `lifecycle`. */
const expectUnmoved = (w: World, lifecycle: SessionLifecycle = SessionLifecycle.READY) => {
  expect(w.registry.effective(w.configured).find((entry) => entry.projectId === w.projectId)?.sessionUuid).toBe(OLD);
  expect(w.harness.cp.bindings.active(w.roleKey)).toMatchObject({ sessionId: w.oldSessionId, bindingGeneration: 1 });
  expect(w.harness.cp.sessions.require(w.oldSessionId).lifecycle).toBe(lifecycle);
  expect(w.target(w.actorOf(1)!)?.target_locator).toBe(OLD);
  expect(w.db.get(`SELECT COUNT(*) AS n FROM handoffs`)).toEqual({ n: 0 });
};

describe("agentctl canonical-cto rotate: the §10.1 switchover of a canonical CTO to a new conversation, as the same actor", () => {
  it("normal rotation: the old CTO drains and keeps the role until the new UUID's claim acknowledges; same actor and Buzz identity; history stays", async () => {
    const w = await world();
    const actor = w.actorOf(1)!;
    const binding = w.target(actor)!;
    // Before any switchover, knowing the new UUID grants nothing.
    expect((await w.claimAs(NEW, 2, w.newPid)).allowed).toBe(false);
    // #246 C1-05 stays: the ordinary switchover never swaps a canonical CTO for a spawned replacement.
    expect(await w.harness.cp.cto.prepareSwitchover(w.projectId, HANDOFF)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE });

    const prepared = pending(w.rotate(NEW, 1));
    expect(prepared).toMatchObject({ projectId: w.projectId, actorId: actor, fromSessionUuid: OLD, toSessionUuid: NEW, fromGeneration: 1, toGeneration: 2 });
    // Until the acknowledgement the old binding is the authority, draining; a UUID the switchover does not name claims nothing.
    expectUnmoved(w, SessionLifecycle.DRAINING);
    expect(w.judge()).toMatchObject({ verdict: "ADMITTED", binding: { sessionId: w.oldSessionId } });
    expect((await w.claimAs(SPARE, 2, 23)).allowed).toBe(false);
    // The launcher's safe boundary is read here: the outgoing binding drains and owns no live run.
    const boundary = canonicalCtoOperator(w.harness.cp, w.configured)("status", { projectId: w.projectId }, OWNER);
    expect(boundary.allowed && boundary.value).toMatchObject({
      holderSessionUuid: OLD, binding: { generation: 1, sessionId: w.oldSessionId, lifecycle: SessionLifecycle.DRAINING, liveRuns: [] },
      // What a new conversation's Buzz channel is started with: the entitlement's own identity and room.
      channel: { actorId: w.cto.pubkey, room: ROOM },
      rotations: [{ state: "PENDING", fromSessionUuid: OLD, toSessionUuid: NEW, fromGeneration: 1, toGeneration: 2 }],
    });

    const incoming = claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    expect(incoming.binding.bindingGeneration).toBe(2);
    // The same conversational actor and target binding, now naming the new conversation.
    expect(w.actorOf(2)).toBe(actor);
    expect(w.target(actor)).toEqual({ target_binding_id: binding.target_binding_id, target_locator: NEW });
    expect(w.db.get(`SELECT current_session_id FROM conversational_actors WHERE actor_id = ?`, [actor])).toEqual({ current_session_id: incoming.sessionId });
    // The same Buzz identity and room, on the new runtime; the subscriber now delivers to it.
    expect(w.harness.cp.sessions.require(incoming.sessionId)).toMatchObject({ buzzActorId: w.cto.pubkey, buzzAddress: ROOM });
    expect(w.judge()).toMatchObject({ verdict: "ADMITTED", binding: { sessionId: incoming.sessionId, bindingGeneration: 2 } });
    // The old holder is fenced at ACP: its binding REVOKED, its session STOPPED, its entitlement a tombstone.
    expect(w.status(1)).toBe("REVOKED");
    expect(w.harness.cp.sessions.require(w.oldSessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(w.registry.effective(w.configured).find((entry) => entry.projectId === w.projectId)?.sessionUuid).toBe(NEW);
    expect((await w.claimAs(OLD, 3, 24)).allowed).toBe(false);
    // The acknowledged handoff: from the old session at generation 1 to the claimant, with the owner's package.
    const handoff = w.db.get<{ handoff_id: string; from_session_id: string; from_generation: number; to_session_id: string; status: string; ack_by_session_id: string; package_json: string }>(
      `SELECT * FROM handoffs WHERE project_id = ?`, [w.projectId])!;
    expect(handoff).toMatchObject({ from_session_id: w.oldSessionId, from_generation: 1, to_session_id: incoming.sessionId, status: "ACKED", ack_by_session_id: incoming.sessionId });
    expect(JSON.parse(handoff.package_json)).toEqual(HANDOFF);
    expect(w.audits("HANDOFF_SUBMITTED")).toHaveLength(1);
    expect(w.audits("HANDOFF_ACK")).toEqual([expect.objectContaining({ handoffId: handoff.handoff_id, fromGeneration: 1, toGeneration: 2 })]);
    // History: the old generation's attestation still cites the binding, and the transfer keeps the old conversation.
    expect(w.db.all(`SELECT binding_generation FROM actor_target_attestations WHERE target_binding_id = ? ORDER BY binding_generation`,
      [binding.target_binding_id])).toEqual([{ binding_generation: 1 }, { binding_generation: 2 }]);
    expect(w.db.get(`SELECT from_session_uuid, to_session_uuid, claimed_binding_generation FROM canonical_entitlement_transfers WHERE transfer_id = ?`,
      [prepared.transferId])).toEqual({ from_session_uuid: OLD, to_session_uuid: NEW, claimed_binding_generation: 2 });
    // The status read the launcher verifies against, reception read from the daemon's own subscriber and ingress.
    const read = canonicalCtoOperator(w.harness.cp, w.configured, w.reception)("status", { projectId: w.projectId }, OWNER);
    expect(read.allowed && read.value).toMatchObject({
      holderSessionUuid: NEW, generation: 2, binding: { generation: 2, sessionId: incoming.sessionId },
      buzz: { verdict: "ADMITTED", sessionId: incoming.sessionId, reception: { subscriber: { connected: true, liveness: "LIVE" }, ingress: { listening: true } } },
      rotations: [{ transferId: prepared.transferId, state: "ACKED", handoffId: handoff.handoff_id }],
    });
  });

  it("Buzz reception is read from the live subscriber connection and ingress, never from registry eligibility alone", async () => {
    const w = await world();
    const prepared = pending(w.rotate(NEW, 1));
    const incoming = claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    const read = () => {
      const now = canonicalCtoOperator(w.harness.cp, w.configured, w.reception)("status", { projectId: w.projectId }, OWNER);
      if (!now.allowed) throw new Error(JSON.stringify(now));
      return now.value as { buzz: { verdict: string; sessionId: string; reception: unknown } };
    };
    expect(read().buzz).toMatchObject({ verdict: "ADMITTED", sessionId: incoming.sessionId,
      reception: { subscriber: { connected: true, liveness: "LIVE" }, ingress: { listening: true } } });
    // The subscriber and the ingress close: the registry still judges the holder ADMITTED, and reception says it is not.
    await w.closeReception();
    expect(read().buzz).toMatchObject({ verdict: "ADMITTED", sessionId: incoming.sessionId,
      reception: { subscriber: { connected: false }, ingress: { listening: false } } });
    // A daemon that wired no subscriber or ingress proves no reception either.
    expect((canonicalCtoOperator(w.harness.cp, w.configured)("status", { projectId: w.projectId }, OWNER) as { value: { buzz: unknown } }).value.buzz)
      .toMatchObject({ verdict: "ADMITTED", reception: { subscriber: { connected: false }, ingress: { listening: false } } });
  });

  it("concurrent rotate requests: one switchover per project is pending; the second request and a second claim are refused", async () => {
    const w = await world();
    const first = pending(w.rotate(NEW, 1));
    expect(w.rotate(SPARE, 1)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(w.rotate(NEW, 1)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(w.db.get(`SELECT COUNT(*) AS n FROM canonical_cto_rotations`)).toEqual({ n: 1 });
    // The two claims a racing pair of launches would make: exactly one acknowledges and binds generation 2.
    const [a, b] = await Promise.all([w.claimAs(NEW, first.toGeneration, w.newPid), w.claimAs(NEW, first.toGeneration, 25)]);
    expect([a.allowed, b.allowed].sort()).toEqual([false, true]);
    expect(w.db.get(`SELECT COUNT(*) AS n FROM assignments WHERE role_key = ? AND binding_generation = 2`, [w.roleKey])).toEqual({ n: 1 });
    expect(w.db.get(`SELECT COUNT(*) AS n FROM handoffs WHERE status = 'ACKED'`)).toEqual({ n: 1 });
  });

  it("stale generation: a rotate and a claim at any generation but the current one and the issued one are refused", async () => {
    const w = await world();
    for (const stale of [2, 3]) {
      expect(w.rotate(NEW, stale)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    }
    expectUnmoved(w);
    const prepared = pending(w.rotate(NEW, 1));
    expect((await w.claimAs(NEW, 3, w.newPid)).allowed).toBe(false);
    expectUnmoved(w, SessionLifecycle.DRAINING);
    claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    // Once acknowledged, the generation it was prepared from is stale for every later rotate.
    expect(w.rotate(SPARE, 1)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    pending(w.rotate(SPARE, 2));
  });

  it("incomplete-message handoff: queued and in-flight work are told apart and carried; the old holder's late ACK completes nothing", async () => {
    const w = await world();
    const inFlight = await w.ceoSays("m1 — handed to the old holder, not yet done");
    expect(w.take(w.oldSessionId, 1).claimed?.messageId).toBe(inFlight);
    const queued = await w.ceoSays("m2 — queued, never handed");
    const prepared = pending(w.rotate(NEW, 1));
    // The drain: the outgoing holder keeps what it holds and is handed nothing new, and is not invited to reject it;
    // a run created now queues instead of being dispatched to it.
    const draining = w.take(w.oldSessionId, 1);
    expect(draining.claimed?.messageId ?? null).not.toBe(queued);
    expect(draining.withheld.map((row) => row.messageId)).not.toContain(queued);
    const late = await w.ceoSays("m3 — arrives while the switchover is pending");
    expect(w.take(w.oldSessionId, 1).claimed?.messageId ?? null).not.toBe(late);
    const queuedRun = await w.run(true);
    expect(queuedRun.dispatched).toMatchObject({ allowed: false, reasonCode: ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING });

    // What the old holder was handed, as the row stands before anything moves it on.
    const handedOld = w.db.get<{ sent_at: string; attempts: number }>(`SELECT sent_at, attempts FROM outbox WHERE message_id = ?`, [inFlight])!;
    const incoming = claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    // The switchover's record, written by the acknowledging claim, tells the two kinds apart, and so does the receipt.
    const recorded = w.db.get<{ carried_json: string }>(`SELECT carried_json FROM canonical_cto_rotations WHERE transfer_id = ?`, [prepared.transferId])!;
    const carried = { pendingMessageIds: [queued, late], inFlightMessageIds: [inFlight],
      inFlightHandedOver: { [inFlight]: { sentAt: handedOld.sent_at, attempts: handedOld.attempts } } };
    expect(JSON.parse(recorded.carried_json)).toEqual(carried);
    expect(incoming.carried).toEqual({ transferId: prepared.transferId, ...carried });
    expect(w.db.all(`SELECT message_id, status, binding_generation, target_session_id FROM outbox WHERE kind = ? ORDER BY rowid`, [MessageKind.PEER_MESSAGE]))
      .toEqual([
        { message_id: inFlight, status: "SENT", binding_generation: 2, target_session_id: incoming.sessionId },
        { message_id: queued, status: "PENDING", binding_generation: 2, target_session_id: incoming.sessionId },
        { message_id: late, status: "PENDING", binding_generation: 2, target_session_id: incoming.sessionId },
      ]);
    // A stale ACK from the old holder completes nothing.
    expect(w.ledger.complete(inFlight, w.holder(w.oldSessionId, 1)).allowed).toBe(false);
    expect(w.db.get(`SELECT status FROM outbox WHERE message_id = ?`, [inFlight])).toEqual({ status: "SENT" });
    // The message the old holder took and never completed is never handed over as ordinary work: it comes marked
    // previousHolderInFlight and listed unresolved, with its id and the evidence of the earlier hand-over, so the new
    // holder judges it (done, safe to redo, or refused) before anything repeats it.
    const evidence = { messageId: inFlight, previousHolderInFlight: true, unresolved: true, transferId: prepared.transferId,
      previousHolder: { sessionId: w.oldSessionId, bindingGeneration: 1, sentAt: handedOld.sent_at, attempts: handedOld.attempts } };
    for (let look = 0; look < 2; look++) {
      const handed = w.take(incoming.sessionId, 2) as Handover & { claimed: { previousHolderInFlight?: boolean } | null };
      expect(handed.claimed, JSON.stringify(handed)).toMatchObject({ messageId: inFlight, previousHolderInFlight: true });
      expect(handed.unresolved).toEqual([expect.objectContaining(evidence)]);
    }
    // Judged done by the old holder: completed without being redone.
    expect(w.ledger.complete(inFlight, w.holder(incoming.sessionId, 2)).allowed).toBe(true);
    // What was only queued is ordinary work for the new holder, unmarked, and nothing is unresolved any more.
    for (const id of [queued, late]) {
      const handed = w.take(incoming.sessionId, 2) as Handover & { claimed: Record<string, unknown> | null };
      expect(handed.claimed?.messageId, JSON.stringify(handed)).toBe(id);
      expect(handed.claimed).not.toHaveProperty("previousHolderInFlight");
      expect(handed.unresolved).toEqual([]);
      expect(w.ledger.complete(id, w.holder(incoming.sessionId, 2)).allowed).toBe(true);
    }
    // The run that queued during the drain goes to the new holder, and only it may answer for it.
    const dispatched = await w.harness.cp.runs.dispatch(queuedRun.runId);
    expect(dispatched.allowed, JSON.stringify(dispatched)).toBe(true);
    expect(w.harness.cp.runs.assertOwner(queuedRun.runId, incoming.sessionId, 2).allowed).toBe(true);
    expect(w.harness.cp.runs.assertOwner(queuedRun.runId, w.oldSessionId, 1).allowed).toBe(false);
  });

  it("an in-flight unsafe item is blocked explicitly: no switchover while the old CTO owns a live run, and no acknowledgement if it gains one", async () => {
    const w = await world();
    const owned = await w.run(true);
    expect(owned.dispatched?.allowed, JSON.stringify(owned.dispatched)).toBe(true);
    expect(w.rotate(NEW, 1)).toMatchObject({ allowed: false, reasonCode: ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS, evidence: { activeRuns: [owned.runId] } });
    const read = canonicalCtoOperator(w.harness.cp, w.configured)("status", { projectId: w.projectId }, OWNER);
    expect(read.allowed && read.value).toMatchObject({ binding: { lifecycle: SessionLifecycle.READY, liveRuns: [owned.runId] } });
    expect(w.db.get(`SELECT COUNT(*) AS n FROM canonical_cto_rotations`)).toEqual({ n: 0 });
    expectUnmoved(w);
    expect(w.harness.cp.runs.cancel(owned.runId, "test: cleared for the switchover").allowed).toBe(true);
    const prepared = pending(w.rotate(NEW, 1));
    // A run the old CTO holds at the acknowledgement (one whose dispatch raced the drain) refuses it, and nothing moves.
    const raced = await w.run(false);
    const old = w.harness.cp.sessions.require(w.oldSessionId);
    w.db.run(`UPDATE runs SET owner_session_id = ?, owner_binding_generation = 1, owner_session_incarnation = ?, owner_role_key = ? WHERE run_id = ?`,
      [w.oldSessionId, old.incarnation, w.roleKey, raced.runId]);
    expect(await w.claimAs(NEW, prepared.toGeneration, w.newPid)).toMatchObject({ allowed: false, reasonCode: ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS });
    expectUnmoved(w, SessionLifecycle.DRAINING);
  });

  it("other projects unchanged: a switchover touches no row of another project, and cannot take its conversation", async () => {
    const w = await world();
    const before = w.otherProjectRows();
    expect(w.rotate(OTHER, 1)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    const prepared = pending(w.rotate(NEW, 1));
    claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    await w.ceoSays("after the switchover");
    expect(w.otherProjectRows()).toBe(before);
  });

  it("start-failure recovery: generation 1 is never restored; the old conversation stays fenced and never claims again, and the switchover completes forward", async () => {
    const w = await world();
    const queued = await w.ceoSays("queued while the new process fails to start");
    const prepared = pending(w.rotate(NEW, 1));
    // The drain: while the switchover is pending, the old holder is handed nothing new.
    expect(w.take(w.oldSessionId, 1)).toMatchObject({ claimed: null, withheld: [] });
    // Switching back to the outgoing conversation, with or without a package, restores neither generation 1 nor its READY state.
    for (const back of [w.rotate(OLD, 1, undefined), w.rotate(OLD, 1), w.rotate(OLD, 2, undefined)]) {
      expect(back.allowed, JSON.stringify(back)).toBe(false);
    }
    expectUnmoved(w, SessionLifecycle.DRAINING);
    expect(w.db.get(`SELECT revoked_at FROM canonical_entitlement_transfers WHERE transfer_id = ?`, [prepared.transferId])).toEqual({ revoked_at: null });
    expect(w.take(w.oldSessionId, 1).claimed).toBeNull();
    // Nor does the old conversation come back by relaunching: once a switchover is prepared from it, it claims nothing.
    expect(await w.claimAs(OLD, 2, 24)).toMatchObject({ allowed: false });
    expectUnmoved(w, SessionLifecycle.DRAINING);
    // Recovery is forward: the record still names exactly the new conversation, which completes the switchover late.
    const incoming = claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    expect(w.take(incoming.sessionId, 2).claimed?.messageId).toBe(queued);
    expect(w.ledger.complete(queued, w.holder(incoming.sessionId, 2)).allowed).toBe(true);
    expect((await w.claimAs(OLD, 3, 24)).allowed).toBe(false);
  });

  it("rollback is a new fenced switchover at a new generation: the new holder is fenced and checked first, and generation 1 never returns", async () => {
    const w = await world();
    const first = pending(w.rotate(NEW, 1));
    const incoming = claimed(await w.claimAs(NEW, first.toGeneration, w.newPid));
    // The new holder already executed and still owns a live run: going back would risk running it twice, so it stops
    // with nothing changed and says why.
    const owned = await w.run(true);
    expect(owned.dispatched?.allowed, JSON.stringify(owned.dispatched)).toBe(true);
    expect(w.rotate(SPARE, 2)).toMatchObject({ allowed: false, reasonCode: ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS, evidence: { activeRuns: [owned.runId] } });
    expect(w.harness.cp.sessions.require(incoming.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(w.db.get(`SELECT COUNT(*) AS n FROM canonical_cto_rotations`)).toEqual({ n: 1 });
    // The old conversation is a tombstone: going back to it is refused at any generation.
    for (const back of [w.rotate(OLD, 1, undefined), w.rotate(OLD, 2), w.rotate(OLD, 2, undefined)]) expect(back.allowed).toBe(false);
    // Cleared, the way back is a new switchover from the new holder (fenced: draining) at generation 3, never 1.
    expect(w.harness.cp.runs.cancel(owned.runId, "test: cleared for the rollback").allowed).toBe(true);
    const back = pending(w.rotate(SPARE, 2));
    expect(back).toMatchObject({ fromSessionUuid: NEW, toSessionUuid: SPARE, fromGeneration: 2, toGeneration: 3, actorId: w.actorOf(1) });
    expect(w.harness.cp.sessions.require(incoming.sessionId).lifecycle).toBe(SessionLifecycle.DRAINING);
    // Fenced means fenced: a relaunch of the holder being switched from cannot take generation 3 from the record.
    expect(await w.claimAs(NEW, back.toGeneration, 28)).toMatchObject({ allowed: false });
    claimed(await w.claimAs(SPARE, back.toGeneration, 26));
    expect(w.db.all(`SELECT binding_generation AS g, status FROM assignments WHERE role_key = ? ORDER BY binding_generation`, [w.roleKey]))
      .toEqual([{ g: 1, status: "REVOKED" }, { g: 2, status: "REVOKED" }, { g: 3, status: "ACTIVE" }]);
    expect(w.actorOf(3)).toBe(w.actorOf(1));
    for (const [uuid, generation] of [[OLD, 4], [NEW, 4]] as const) expect((await w.claimAs(uuid, generation, 27)).allowed).toBe(false);
  });

  it("only the allowlisted CLI owner reaches rotate or status, with exactly its parameters", async () => {
    const w = await world();
    const operator = canonicalCtoOperator(w.harness.cp, w.configured);
    const params = { projectId: w.projectId, toSessionUuid: NEW, expectedGeneration: 1, handoff: HANDOFF };
    expect(ownerOnlyCanonicalCtoOperator(w.harness.cp, "someone-else", operator)("rotate", params, "someone-else"))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED });
    expect(w.db.get(`SELECT COUNT(*) AS n FROM canonical_cto_rotations`)).toEqual({ n: 0 });
    expect(operator("rotate", { ...params, extra: 1 }, OWNER)).toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(operator("rotate", { ...params, handoff: undefined }, OWNER)).toMatchObject({ allowed: false, reasonCode: ReasonCode.HANDOFF_PACKAGE_INCOMPLETE });
    pending(ownerOnlyCanonicalCtoOperator(w.harness.cp, OWNER, operator)("rotate", params, OWNER) as Decision<CanonicalSwitchoverPrepared>);
  });
});

describe("v58 guards: the binding moves only for its unacknowledged switchover, which is written and acknowledged once", () => {
  const BOUND = /ACTOR_TARGET_BINDING_IMMUTABLE/;
  const RECORD = /CANONICAL_ENTITLEMENT_TRANSFER_IMMUTABLE/;
  it("refuses every other rewrite of an actor's target, and every other write of a switchover", async () => {
    const w = await world();
    const actor = w.actorOf(1)!;
    const retarget = (to: string, set = "") => () => w.db.run(
      `UPDATE actor_target_bindings SET target_locator = ?, target_locator_digest = ?${set} WHERE target_actor_id = ?`, [to, sha256(to), actor]);
    // No switchover: nothing moves the target.
    expect(retarget(NEW)).toThrow(BOUND);
    const prepared = pending(w.rotate(NEW, 1));
    // A switchover moves it only to its own conversation, keeping every other column and changing the digest.
    expect(retarget(SPARE)).toThrow(BOUND);
    expect(retarget(NEW, ", bound_at = 'x'")).toThrow(BOUND);
    expect(() => w.db.run(`UPDATE actor_target_bindings SET target_locator = ? WHERE target_actor_id = ?`, [NEW, actor])).toThrow(BOUND);
    expect(() => w.db.run(`DELETE FROM actor_target_bindings WHERE target_actor_id = ?`, [actor])).toThrow(BOUND);
    // A second switchover row, a replaced one, an acknowledgement with no ACKED handoff, an edit and a delete.
    const row = w.db.get<Record<string, unknown>>(`SELECT * FROM canonical_cto_rotations WHERE transfer_id = ?`, [prepared.transferId])!;
    expect(() => w.db.run(`INSERT OR REPLACE INTO canonical_cto_rotations (transfer_id, actor_id, target_binding_id, from_session_id, from_generation, to_generation, package_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [row["transfer_id"], row["actor_id"], row["target_binding_id"], row["from_session_id"], 1, 2, "{}"])).toThrow(RECORD);
    expect(() => w.db.run(`UPDATE canonical_cto_rotations SET handoff_id = NULL, carried_json = NULL, package_json = '{}', revision = revision + 1`)).toThrow(RECORD);
    // A handoff row that is not the acknowledged one from the outgoing generation acknowledges nothing.
    w.db.run(`INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation, to_session_id, package_json, digest, status, created_at)
      VALUES ('hof_unacked', ?, 'HANDOFF', ?, 1, ?, '{}', 'd', 'PENDING', ?)`, [w.projectId, w.oldSessionId, w.oldSessionId, w.harness.clock.nowIso()]);
    expect(() => w.db.run(`UPDATE canonical_cto_rotations SET handoff_id = 'hof_unacked', carried_json = '{}', revision = revision + 1`)).toThrow(RECORD);
    expect(() => w.db.run(`DELETE FROM canonical_cto_rotations`)).toThrow(RECORD);
    const incoming = claimed(await w.claimAs(NEW, prepared.toGeneration, w.newPid));
    // Acknowledged: the target is the new conversation's for good; no later write moves it or reopens the record.
    expect(w.target(actor)?.target_locator).toBe(NEW);
    expect(retarget(SPARE)).toThrow(BOUND);
    expect(() => w.db.run(`UPDATE canonical_cto_rotations SET carried_json = '{}', revision = revision + 1`)).toThrow(RECORD);
    expect(w.db.get(`SELECT to_session_id FROM handoffs h JOIN canonical_cto_rotations r ON r.handoff_id = h.handoff_id`))
      .toEqual({ to_session_id: incoming.sessionId });
  });

  it("refuses a switchover row the transfer does not stand behind", async () => {
    const w = await world();
    const actor = w.actorOf(1)!;
    const binding = w.target(actor)!;
    // A pending transfer the owner's switchover did not write (the CEO's v57 transfer) takes no rider for another generation or session.
    const transfer = w.db.txDecision(() => w.registry.transfer({ projectId: w.projectId, fromSessionUuid: OLD, toSessionUuid: NEW, expectedBindingGeneration: 1 }, "ceo", w.harness.clock.nowIso()));
    if (!transfer.allowed) throw new Error(JSON.stringify(transfer));
    const rider = (generation: number, session: string) => () => w.db.run(
      `INSERT INTO canonical_cto_rotations (transfer_id, actor_id, target_binding_id, from_session_id, from_generation, to_generation, package_json)
       VALUES (?, ?, ?, ?, ?, ?, '{}')`, [transfer.value.transferId, actor, binding.target_binding_id, session, generation, generation + 1]);
    expect(rider(2, w.oldSessionId)).toThrow(RECORD);
    const otherActor = w.db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id <> ? LIMIT 1`, [actor])!.actor_id;
    expect(() => w.db.run(
      `INSERT INTO canonical_cto_rotations (transfer_id, actor_id, target_binding_id, from_session_id, from_generation, to_generation, package_json)
       VALUES (?, ?, ?, ?, 1, 2, '{}')`, [transfer.value.transferId, otherActor, binding.target_binding_id, w.oldSessionId])).toThrow(RECORD);
    expect(rider(1, "ses_elsewhere")).toThrow();
    const otherSession = w.db.get<{ session_id: string }>(`SELECT session_id FROM sessions WHERE session_id <> ? LIMIT 1`, [w.oldSessionId])!.session_id;
    expect(rider(1, otherSession)).toThrow(RECORD);
    // The one row the transfer does stand behind is admitted, once.
    rider(1, w.oldSessionId)();
    expect(rider(1, w.oldSessionId)).toThrow(RECORD);
  });
});

describe("agentctl canonical-cto", () => {
  it("sends rotate with the handoff package read from its file, and status, over the operator client; refuses a malformed argv", async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const client = { request: async (method: string, params?: Record<string, unknown>) => { sent.push({ method, params }); return allow(ReasonCode.OK, {}); } };
    const file = join(tempDir("acp-rot-cli-"), "handoff.json");
    writeFileSync(file, JSON.stringify(HANDOFF));
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await dispatch(client, "canonical-cto", ["rotate", "--project", "p", "--to", NEW, "--expected-generation", "3", "--handoff", file], false)).toBe(0);
      expect(await dispatch(client, "canonical-cto", ["rotate", "--project", "p", "--to", OLD, "--expected-generation", "3"], false)).toBe(0);
      expect(await dispatch(client, "canonical-cto", ["status", "--project", "p"], false)).toBe(0);
      expect(await dispatch(client, "canonical-cto", ["rotate", "--project", "p", "--to", NEW], false)).not.toBe(0);
      expect(await dispatch(client, "canonical-cto", ["rotate", "--project", "p", "--to", NEW, "--expected-generation", "0"], false)).not.toBe(0);
    } finally {
      process.stdout.write = write;
      process.stderr.write = stderr;
    }
    expect(sent).toEqual([
      { method: "canonicalCto.rotate", params: { projectId: "p", toSessionUuid: NEW, expectedGeneration: 3, handoff: HANDOFF } },
      { method: "canonicalCto.rotate", params: { projectId: "p", toSessionUuid: OLD, expectedGeneration: 3 } },
      { method: "canonicalCto.status", params: { projectId: "p" } },
    ]);
  });
});

