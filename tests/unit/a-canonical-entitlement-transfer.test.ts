import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { buzzMentionSubscriberRegistry } from "../../src/daemon/agentcpd.ts";
import { executeCanonicalSelfClaimOperator } from "../../src/daemon/canonical-self-claim-operator.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import {
  type CanonicalAdoptableSession,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
  hostSessionRegistryAbsent,
} from "../../src/registry/canonical-self-claim.ts";
import { CanonicalSessionRegistry } from "../../src/registry/canonical-session-registry.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, bootstrapCtoProvider, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const stragglers: ChildProcess[] = [];
afterEach(() => {
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/**
 * A project's canonical PRIMARY_CTO was pinned to one conversation, and nothing could move it: self-claim admits
 * only the entitled UUID, cto_replace refuses a canonical holder, and grant() refuses a row or a tombstone. v57's
 * `cto_entitlement_transfer` lets the current CEO move it to another running conversation; that conversation's
 * next self-claim takes the role, the old binding and session end, and the old binding's unfinished runs follow.
 */

const OLD = "58cac5c6-0000-4000-8000-000000000001";
const NEW = "36276d16-0000-4000-8000-000000000002";
const ELSEWHERE = "66666666-0000-4000-8000-000000000003";
const SPARE = "77777777-0000-4000-8000-000000000004";
const CWD = "/work/transfer";
const ROOM = "aaaaaaaa-0000-4000-8000-00000000000a";
const CTO_ACTOR = "buzz:transfer-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_UID = 501;
const PEER_IDENTITY = `uid:${PEER_UID}`;
const NOWHERE = "99999999-0000-4000-8000-000000000005";
const CONTRACT = {
  goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
  acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [],
};

/** The claude process of conversation `uuid`, as process `pid`. */
const claudeOf = (uuid: string, pid: number, startedAt = `start-${pid}`): ProcessSnapshot[] => [
  { pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"], command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1" },
  { pid: 50, ppid: pid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD, cwdProbeFailure: null, startedAt: "t2" },
  { pid, ppid: 1, argv: ["/opt/claude/claude", "--resume", uuid], command: `/opt/claude/claude --resume ${uuid}`, cwd: CWD, cwdProbeFailure: null, startedAt },
];

interface Answer { ok: boolean; reasonCode: string; message?: string; value?: Record<string, unknown> }

const world = async () => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const ceoSessionId = bindCeo(harness);
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;
  bootstrapCtoProvider(harness.cp, harness.clock);
  // The deployment's configuration names the old conversation; the daemon grants it at start.
  const configured: CanonicalAdoptableSession[] = [{ sessionUuid: OLD, projectId, buzzActorId: CTO_ACTOR, buzzAddress: ROOM }];
  const registry = new CanonicalSessionRegistry(db);
  for (const entry of registry.effective(configured)) registry.grant({ ...entry, buzzAddress: entry.buzzAddress ?? ROOM }, null);

  // The old conversation's claude process is a live stand-in, so its run is dispatched to a running CTO.
  const live = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(live);
  await once(live, "spawn");
  const liveStart = readProcessStartToken(live.pid!);
  if (liveStart === null) throw new Error("the stand-in process has no readable start token");

  /** One self-claim through the operator door, over the configured entries the daemon started with. */
  const claimAs = (uuid: string, generation: number, pid: number): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = pid === live.pid ? claudeOf(uuid, pid, liveStart) : claudeOf(uuid, pid);
    return executeCanonicalSelfClaimOperator({ peerPid: 100, uid: PEER_UID }, { claimedSessionUuid: uuid, projectId, expectedBindingGeneration: generation }, {
      db, clock: harness.clock, audit: harness.cp.audit, sessions: harness.cp.sessions, bindings: harness.cp.bindings,
      buzzActorAuthenticator: { isAllowedActor: () => true },
      resolveBuzzAddress: async (): Promise<Decision<string>> => allow(ReasonCode.OK, ROOM),
      config: {
        canonicalSessions: configured, canonicalBuzzChannelId: ROOM, expectedPeerProtocolVersion: PEER_PROTOCOL,
        expectedPeerIdentity: PEER_IDENTITY, peerProtocolVersion: PEER_PROTOCOL, buzzPurpose: "continuity:PRIMARY_CTO",
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

  const first = await claimAs(OLD, 1, live.pid!);
  if (!first.allowed) throw new Error(`the old conversation's claim failed: ${JSON.stringify(first)}`);
  const oldSessionId = first.value.sessionId;

  const created = harness.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const repo = db.get<{ identity: string }>(
    `SELECT r.identity FROM repositories r JOIN run_repositories rr ON rr.repository_id = r.repository_id WHERE rr.run_id = ?`, [runId])!;
  const acquired = harness.cp.claims.acquire({
    runId, ownerRoleKey: roleKey, repositoryIdentity: repo.identity, ownerSessionId: oldSessionId, ownerBindingGeneration: 1, branch: "task/transfer",
  } as Parameters<typeof harness.cp.claims.acquire>[0]);
  if (!acquired.allowed) throw new Error(JSON.stringify(acquired));

  let keys = 0;
  /** One Hermes tool call, authenticated as `peerSessionId` (the CEO unless named). */
  const hermes = async (name: string, args: Record<string, unknown>, peerSessionId = ceoSessionId): Promise<Answer> => {
    const peer = { actor: peerSessionId, sessionId: peerSessionId, sessionIncarnation: harness.cp.sessions.require(peerSessionId).incarnation };
    const server = createHermesServer(createHermesMcpPort(harness.cp), () => allow(ReasonCode.OK, peer));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-entitlement-transfer", version: "1" });
    await client.connect(clientTransport);
    try {
      return (await client.callTool({ name, arguments: { idempotencyKey: `et-${++keys}`, ...args } })).structuredContent as unknown as Answer;
    } finally {
      await client.close();
    }
  };
  const transfer = (overrides: Record<string, unknown> = {}, peerSessionId?: string) =>
    hermes("cto_entitlement_transfer", { projectId, fromSessionUuid: OLD, toSessionUuid: NEW, expectedBindingGeneration: 1, ...overrides }, peerSessionId);
  const transfers = () => db.all<{ transfer_id: string; to_session_uuid: string; claimed_at: string | null; claimed_binding_generation: number | null }>(
    `SELECT transfer_id, to_session_uuid, claimed_at, claimed_binding_generation FROM canonical_entitlement_transfers ORDER BY created_at`);
  const audits = (kind: string) => db.all<{ run_id: string | null; session_id: string | null; evidence_json: string }>(
    `SELECT run_id, session_id, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`, [kind]);
  const owner = () => db.get<{ owner_session_id: string; owner_binding_generation: number }>(
    `SELECT owner_session_id, owner_binding_generation FROM runs WHERE run_id = ?`, [runId]);
  const judge = () => buzzMentionSubscriberRegistry(harness.cp, { sessions: configured }).judgeIdentity?.(CTO_ACTOR);
  return { harness, db, projectId, roleKey, ceoSessionId, oldSessionId, runId, configured, registry, claimAs, hermes, transfer, transfers, audits, owner, judge };
};
type World = Awaited<ReturnType<typeof world>>;

/** Nothing moved: the old conversation still holds the entitlement, its binding and its run. */
const expectUnmoved = (w: World) => {
  expect(w.transfers()).toEqual([]);
  expect(w.registry.effective(w.configured).filter((entry) => entry.projectId === w.projectId).map((entry) => entry.sessionUuid)).toEqual([OLD]);
  expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.oldSessionId);
  expect(w.owner()).toEqual({ owner_session_id: w.oldSessionId, owner_binding_generation: 1 });
  expect(w.audits("CANONICAL_ENTITLEMENT_TRANSFERRED")).toEqual([]);
};

describe("cto_entitlement_transfer moves a project's canonical CTO to another running conversation", () => {
  it("the new conversation self-claims at gen + 1, holds the entitlement alone, and the old binding's run follows it", async () => {
    const w = await world();
    const answer = await w.transfer();
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true, value: { projectId: w.projectId, fromSessionUuid: OLD, toSessionUuid: NEW, claimedAt: null } });
    // Pending: until the new conversation claims, the old one keeps the entitlement, binding and Buzz channel.
    expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([OLD]);
    expect(w.db.get(`SELECT revoked_at FROM canonical_session_entitlements WHERE session_uuid = ?`, [OLD])).toEqual({ revoked_at: null });
    expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.oldSessionId);
    expect(w.judge()).toMatchObject({ verdict: "ADMITTED", binding: { sessionId: w.oldSessionId } });

    const claimed = await w.claimAs(NEW, 2, 22);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) throw new Error("unreachable");
    expect(claimed.value.binding.bindingGeneration).toBe(2);
    // The claim is the verification: only now is the old entitlement revoked, and the new one the project's.
    expect(w.registry.effective(w.configured)).toEqual([{ sessionUuid: NEW, projectId: w.projectId, buzzActorId: CTO_ACTOR, buzzAddress: ROOM }]);
    expect(w.db.get(`SELECT revoked_at IS NOT NULL AS revoked FROM canonical_session_entitlements WHERE session_uuid = ?`, [OLD])).toEqual({ revoked: 1 });
    expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(claimed.value.sessionId);
    expect(w.db.get(`SELECT status FROM assignments WHERE role_key = ? AND binding_generation = 1`, [w.roleKey])).toEqual({ status: "REVOKED" });
    expect(w.harness.cp.sessions.require(w.oldSessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    // The unfinished run and its claim follow, and run_ack's owner fence admits the new generation only.
    expect(w.owner()).toEqual({ owner_session_id: claimed.value.sessionId, owner_binding_generation: 2 });
    expect(w.db.all(`SELECT owner_session_id, owner_binding_generation FROM resource_claims WHERE run_id = ?`, [w.runId]))
      .toEqual([{ owner_session_id: claimed.value.sessionId, owner_binding_generation: 2 }]);
    expect(w.harness.cp.runs.assertOwner(w.runId, claimed.value.sessionId, 2).allowed).toBe(true);
    expect(w.harness.cp.runs.assertOwner(w.runId, w.oldSessionId, 1).allowed).toBe(false);
    expect(w.transfers()).toEqual([expect.objectContaining({ to_session_uuid: NEW, claimed_binding_generation: 2 })]);
    expect(w.transfers()[0]!.claimed_at).not.toBeNull();
    // Audited: the transfer, each run's hand-over, and the claim that consumed it. Earlier history is not rewritten.
    expect(w.audits("CANONICAL_ENTITLEMENT_TRANSFERRED")).toHaveLength(1);
    expect(w.audits("CANONICAL_ENTITLEMENT_TRANSFER_RUN_HANDED_OVER").map((row) => ({ runId: row.run_id, sessionId: row.session_id })))
      .toEqual([{ runId: w.runId, sessionId: claimed.value.sessionId }]);
    expect(w.audits("CANONICAL_ENTITLEMENT_TRANSFER_CLAIMED")).toHaveLength(1);
    expect(w.db.get(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND kind = 'RUN_CREATED' AND session_id IS NOT ?`, [w.runId, claimed.value.sessionId]))
      .toEqual({ n: 1 });
    // The Buzz channel is the new conversation's.
    expect(w.judge()).toMatchObject({ verdict: "ADMITTED", binding: { sessionId: claimed.value.sessionId, bindingGeneration: 2 } });

    // The old conversation's claim is refused.
    const back = await w.claimAs(OLD, 3, 33);
    expect(back).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, message: "only a canonical session may be adopted by this primitive" });
    // grant() keeps its tombstone: the old conversation, and the new one for another project, are refused.
    expect(() => w.registry.grant({ sessionUuid: OLD, projectId: w.projectId, buzzActorId: CTO_ACTOR, buzzAddress: ROOM }, null)).toThrow();
    w.harness.cp.projects.register({ projectId: "elsewhere", name: "elsewhere" });
    expect(() => w.registry.grant({ sessionUuid: NEW, projectId: "elsewhere", buzzActorId: "buzz:elsewhere", buzzAddress: ROOM }, null)).toThrow();
    // A daemon start grants every effective entry, the transferred one included, and does not throw.
    expect(() => { for (const entry of w.registry.effective(w.configured)) w.registry.grant({ ...entry, buzzAddress: entry.buzzAddress ?? ROOM }, null); }).not.toThrow();
  });

  it("a transfer to a conversation that never claims leaves the old CTO fully reachable, admits no third conversation, and is cancelled", async () => {
    const w = await world();
    const pending = await w.transfer({ toSessionUuid: NOWHERE });
    expect(pending.ok, JSON.stringify(pending)).toBe(true);
    const transferId = pending.value!["transferId"] as string;
    expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([OLD]);
    expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.oldSessionId);
    expect(w.harness.cp.sessions.require(w.oldSessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(w.judge()).toMatchObject({ verdict: "ADMITTED", binding: { sessionId: w.oldSessionId } });
    expect(w.owner()).toEqual({ owner_session_id: w.oldSessionId, owner_binding_generation: 1 });
    // Neither a third conversation nor the transfer's own target, on another project's claim, is admitted.
    expect(await w.claimAs(SPARE, 2, 44)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, message: "only a canonical session may be adopted by this primitive" });
    expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.oldSessionId);
    // The CEO withdraws it; nothing else moves, and the project is free for the right transfer.
    expect(await w.hermes("cto_entitlement_transfer_cancel", { projectId: w.projectId, transferId }, w.oldSessionId))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    expect(await w.hermes("cto_entitlement_transfer_cancel", { projectId: w.projectId, transferId })).toMatchObject({ ok: true, value: { transferId } });
    expect(await w.hermes("cto_entitlement_transfer_cancel", { projectId: w.projectId, transferId })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(w.audits("CANONICAL_ENTITLEMENT_TRANSFER_CANCELLED")).toHaveLength(1);
    expect(await w.claimAs(NOWHERE, 2, 55)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([OLD]);
    expect((await w.transfer()).ok).toBe(true);
    expect((await w.claimAs(NEW, 2, 22)).allowed).toBe(true);
    expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([NEW]);
  });

  it("a retirement revokes the transfer as it revokes an entitlement row, and the Buzz channel with it", async () => {
    const w = await world();
    expect((await w.transfer()).ok).toBe(true);
    expect((await w.claimAs(NEW, 2, 22)).allowed).toBe(true);
    expect(w.judge()).toMatchObject({ verdict: "ADMITTED" });
    // What project retirement does to the registry.
    w.db.run(`INSERT INTO project_retirements (project_id, requested_at, reason) VALUES (?, ?, 'retired')`, [w.projectId, w.harness.clock.nowIso()]);
    w.registry.revoke(w.projectId, w.harness.clock.nowIso());
    expect(w.db.get(`SELECT revoked_at IS NOT NULL AS revoked FROM canonical_entitlement_transfers`)).toEqual({ revoked: 1 });
    expect(w.registry.holder(w.projectId)).toBeNull();
    expect(w.registry.effective(w.configured)).toEqual([]);
    expect(w.judge()).toMatchObject({ verdict: "EXCLUDED", reason: "CANONICAL_ENTITLEMENT_REVOKED" });
  });

  it("a retry with the same key returns the recorded transfer and moves nothing twice", async () => {
    const w = await world();
    const args = { idempotencyKey: "et-same", projectId: w.projectId, fromSessionUuid: OLD, toSessionUuid: NEW, expectedBindingGeneration: 1 };
    const first = await w.hermes("cto_entitlement_transfer", args);
    const again = await w.hermes("cto_entitlement_transfer", args);
    expect(first.ok).toBe(true);
    expect(again).toEqual(first);
    expect(w.transfers()).toHaveLength(1);
    expect(w.audits("CANONICAL_ENTITLEMENT_TRANSFERRED")).toHaveLength(1);
  });

  describe("refuses, and moves nothing", () => {
    it("a mismatched project, from-uuid or generation", async () => {
      const w = await world();
      expect(await w.transfer({ projectId: "no-such-project" })).toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
      w.harness.cp.projects.register({ projectId: "elsewhere", name: "elsewhere" });
      w.registry.grant({ sessionUuid: ELSEWHERE, projectId: "elsewhere", buzzActorId: "buzz:elsewhere", buzzAddress: ROOM }, null);
      expect(await w.transfer({ projectId: "elsewhere" })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(await w.transfer({ fromSessionUuid: SPARE })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(await w.transfer({ expectedBindingGeneration: 0 })).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      expect(await w.transfer({ expectedBindingGeneration: 2 })).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      expectUnmoved(w);
    });

    it("a caller that is not the current CEO", async () => {
      const w = await world();
      expect(await w.transfer({}, w.oldSessionId)).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      expectUnmoved(w);
    });

    it("while a task execution or a candidate pipeline attempt of the project's runs is RUNNING", async () => {
      const w = await world();
      const tasks = w.harness.cp.tasks.submit(w.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
      if (!tasks.allowed) throw new Error(tasks.message);
      const task = w.harness.cp.tasks.ready(w.runId)[0]!;
      const execution = w.harness.cp.tasks.startExecution({
        runId: w.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId: bindWorker(w.harness, task.taskId),
        provider: "scripted", model: "scripted-worker",
      });
      if (!execution.allowed) throw new Error(execution.message);
      expect(await w.transfer()).toMatchObject({ ok: false, reasonCode: ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT });
      expectUnmoved(w);
      w.db.run(`UPDATE task_executions SET status = 'SUCCEEDED' WHERE run_id = ?`, [w.runId]);
      w.db.run(
        `INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation, state, started_at, deadline_at)
         VALUES (?, 'cpa_transfer', ?, 1, 'RUNNING', ?, '2999-01-01T00:00:00.000Z')`,
        [w.runId, w.oldSessionId, w.harness.clock.nowIso()],
      );
      expect(await w.transfer()).toMatchObject({ ok: false, reasonCode: ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT });
      expectUnmoved(w);
    });

    it("a to-uuid already entitled to another project", async () => {
      const w = await world();
      w.harness.cp.projects.register({ projectId: "elsewhere", name: "elsewhere" });
      w.registry.grant({ sessionUuid: ELSEWHERE, projectId: "elsewhere", buzzActorId: "buzz:elsewhere", buzzAddress: ROOM }, null);
      expect(await w.transfer({ toSessionUuid: ELSEWHERE })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(await w.transfer({ toSessionUuid: OLD })).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expectUnmoved(w);
    });

    it("a retired project", async () => {
      const w = await world();
      w.db.run(`INSERT INTO project_retirements (project_id, requested_at, reason) VALUES (?, ?, 'retired')`, [w.projectId, w.harness.clock.nowIso()]);
      expect(await w.transfer()).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(w.transfers()).toEqual([]);
    });

    it("a second, different transfer while the first is unclaimed", async () => {
      const w = await world();
      expect((await w.transfer()).ok).toBe(true);
      expect(await w.transfer({ fromSessionUuid: NEW, toSessionUuid: SPARE })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(await w.transfer({ toSessionUuid: SPARE })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(w.transfers().map((row) => row.to_session_uuid)).toEqual([NEW]);
    });
  });

  describe("the new conversation's claim takes nothing while it cannot take everything", () => {
    it("refuses while a worker turn of an owned run is RUNNING, and rolls the release back", async () => {
      const w = await world();
      expect((await w.transfer()).ok).toBe(true);
      // Started after the transfer, by the old binding that still holds the role until the claim.
      const tasks = w.harness.cp.tasks.submit(w.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
      if (!tasks.allowed) throw new Error(tasks.message);
      const task = w.harness.cp.tasks.ready(w.runId)[0]!;
      const execution = w.harness.cp.tasks.startExecution({
        runId: w.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId: bindWorker(w.harness, task.taskId),
        provider: "scripted", model: "scripted-worker",
      });
      if (!execution.allowed) throw new Error(execution.message);
      const claimed = await w.claimAs(NEW, 2, 22);
      expect(claimed).toMatchObject({ allowed: false, reasonCode: ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT });
      expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.oldSessionId);
      expect(w.harness.cp.sessions.require(w.oldSessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(w.owner()).toEqual({ owner_session_id: w.oldSessionId, owner_binding_generation: 1 });
      expect(w.transfers()[0]).toMatchObject({ claimed_at: null });
      expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([OLD]);
    });

    it("rolls everything back when the hand-over's record is refused", async () => {
      const w = await world();
      expect((await w.transfer()).ok).toBe(true);
      const record = w.harness.cp.audit.record.bind(w.harness.cp.audit);
      vi.spyOn(w.harness.cp.audit, "record").mockImplementation((entry) =>
        entry.kind === "CANONICAL_ENTITLEMENT_TRANSFER_RUN_HANDED_OVER" ? deny(ReasonCode.AUDIT_WRITE_FAILED, "test: refused") : record(entry));
      const claimed = await w.claimAs(NEW, 2, 22);
      expect(claimed).toMatchObject({ allowed: false, reasonCode: ReasonCode.AUDIT_WRITE_FAILED });
      expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.oldSessionId);
      expect(w.owner()).toEqual({ owner_session_id: w.oldSessionId, owner_binding_generation: 1 });
      expect(w.transfers()[0]).toMatchObject({ claimed_at: null });
      expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([OLD]);
    });
  });
});
