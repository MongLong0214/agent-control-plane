import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { recoverDeadCanonicalBinding } from "../../src/daemon/dead-binding-recovery.ts";
import type { Db } from "../../src/db/database.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bootstrapCtoProvider, driveToReviewedCandidate, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/** The first runtime's stand-in process, live while its run is dispatched, killed before the restart. */
const stragglers: ChildProcess[] = [];
afterEach(() => {
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/**
 * CEO msg_00ce7760, option A. A resident canonical CTO whose stdio relay is gone is relaunched as
 * `claude --resume <its conversation>`; the resumed relay's self-claim releases the dead
 * predecessor generation and, until this change, was refused REVOCATION_BLOCKED_ACTIVE_RUNS
 * whenever that generation still owned a live run — no path kept both the conversation and the run.
 *
 * Now the successor generation takes the predecessor's live runs over in the claim transaction,
 * only when the succession is proven (same conversation UUID, actor, role, project and Buzz
 * identity, predecessor proven DEAD). Everything here is real (SQLite, the control plane, the
 * self-claim, its recovery, the binding registry, the run and its blind review, the run engine's
 * owner fence); only the claim's process table, the image scan, the transcript lookup and the Buzz
 * room resolver are fixtures. The first runtime is a real process for the one step that reads the
 * kernel itself — dispatch pins a canonical CTO's run only to a running one — and is dead before
 * the restart, as in production.
 */

const CANON = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";
const CWD = "/work/resident-cto";
const ROOM = "buzz-resident-room";
const CTO_ACTOR = "buzz:resident-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const RUN_ID = "run_resident_live_owned";

/** The CTO's claude process as run number `run`: a new pid and start each restart. */
const claudeRun = (
  run: number,
  sessionUuid = CANON,
  claude: { pid: number; startedAt: string } = { pid: 9 + run, startedAt: `Fri Jan  1 0${run}:00:00 2027` },
): ProcessSnapshot[] => {
  const claudePid = claude.pid;
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
      pid: claudePid, ppid: 1, argv: ["/opt/claude/claude", "--resume", sessionUuid],
      command: `/opt/claude/claude --resume ${sessionUuid}`, cwd: CWD, cwdProbeFailure: null,
      startedAt: claude.startedAt,
    },
  ];
};

/** A pid in the chain answers; any other raises ESRCH — never the real `kill`. */
const signalFrom = (chain: readonly ProcessSnapshot[]) => (pid: number): void => {
  if (chain.some((entry) => entry.pid === pid)) return;
  throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
};

const errno = (code: string) => Object.assign(new Error(code), { code });

interface ClaimOptions {
  expectedBindingGeneration?: number;
  buzzActorId?: string;
  chain?: ProcessSnapshot[];
  processSignal?: (pid: number) => void;
  claimedSessionUuid?: string;
}

const startFixture = async (options: { liveRun?: boolean } = {}) => {
  const harness = makeHarness();
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;

  const live = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(live);
  await once(live, "spawn");
  const liveStart = readProcessStartToken(live.pid!);
  if (liveStart === null) throw new Error("the stand-in process has no readable start token");
  /** Run 1: the stand-in's real pid and start token, as the claim records them. */
  const runOne = claudeRun(1, CANON, { pid: live.pid!, startedAt: liveStart });

  const claimAs = (run: number, claim: ClaimOptions = {}): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = claim.chain ?? (run === 1 ? runOne : claudeRun(run));
    return new CanonicalSelfClaim(
      db,
      harness.clock,
      harness.cp.audit,
      harness.cp.sessions,
      harness.cp.bindings,
      { isAllowedActor: () => true },
      async (): Promise<Decision<string>> => allow(ReasonCode.OK, ROOM),
      {
        canonicalSessions: [{ sessionUuid: CANON, projectId, buzzActorId: claim.buzzActorId ?? CTO_ACTOR }],
        canonicalBuzzChannelId: ROOM,
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
        processSignal: claim.processSignal ?? signalFrom(chain),
      },
    ).claim({
      callerPid: 100,
      claimedSessionUuid: claim.claimedSessionUuid ?? CANON,
      projectId,
      expectedBindingGeneration: claim.expectedBindingGeneration ?? run,
      peerProtocolVersion: PEER_PROTOCOL,
      peerIdentity: PEER_IDENTITY,
      buzzPurpose: "continuity:PRIMARY_CTO",
    });
  };

  const first = await claimAs(1);
  if (!first.allowed) throw new Error(`the first canonical claim failed: ${JSON.stringify(first)}`);
  const predecessor = harness.cp.sessions.require(first.value.sessionId);
  // Deliberately no revoke: the relay died with the process and nothing revoked the binding.
  expect(harness.cp.bindings.active(roleKey)?.bindingGeneration).toBe(1);

  expect(predecessor.osPid).toBe(live.pid);

  let runId = RUN_ID;
  if (options.liveRun !== false) {
    // The production shape, driven through the real run path with this canonical CTO as owner:
    // contract, dispatch, a worker change, a frozen candidate, verification and a blind review that
    // answers BLOCK (scripted first, so it is the response the review consumes).
    harness.scripted.script({
      match: /Candidate review/,
      text: JSON.stringify({
        verdict: "BLOCK",
        coveredFiles: [`${registered.identity}:src/app.js`],
        omittedItems: [],
        findings: [{
          category: "correctness", severity: "BLOCKER", repository: registered.identity, path: "src/app.js",
          summary: "fixture block", detail: "fixture block",
        }],
      }),
    });
    // The canonical CTO's provider is `claude`; dispatch asks its capacity before it pins the owner.
    bootstrapCtoProvider(harness.cp, harness.clock);
    // The helper stops at the review's refusal; the run, its evidence and the BLOCK are what it left.
    await expect(driveToReviewedCandidate(harness, { registeredProject: registered })).rejects.toThrow(/REVIEW_BLOCK/);
    const driven = db.all<{ run_id: string; state: string; owner_session_id: string; owner_binding_generation: number }>(
      `SELECT run_id, state, owner_session_id, owner_binding_generation FROM runs WHERE project_id = ?`,
      [projectId],
    );
    expect(driven).toHaveLength(1);
    runId = driven[0]!.run_id;
    expect(driven[0]).toMatchObject({ owner_session_id: predecessor.sessionId, owner_binding_generation: 1 });
    expect(["COMPLETED", "FAILED", "CANCELLED"]).not.toContain(driven[0]!.state);
  }
  // The relay and the process are gone; nothing revoked the binding.
  live.kill("SIGKILL");
  await once(live, "exit");

  /** Every durable fact the takeover must leave alone: the run but its owner pin, and its evidence. */
  const work = () => ({
    run: db.get<Record<string, unknown>>(
      `SELECT run_id, project_id, kind, state, goal, contract_digest, current_candidate_digest, revision_count,
              created_at, dispatched_at, ended_at, state_reason FROM runs WHERE run_id = ?`,
      [runId],
    ) ?? null,
    artifacts: db.all<Record<string, unknown>>(`SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY artifact_id`, [runId]),
    verification: db.all<Record<string, unknown>>(`SELECT * FROM verification_results ORDER BY rowid`),
  });

  const owner = () =>
    db.get<{
      owner_session_id: string; owner_binding_generation: number; owner_session_incarnation: string; owner_role_key: string;
    }>(
      `SELECT owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key
         FROM runs WHERE run_id = ?`,
      [runId],
    ) ?? null;

  const assignments = () =>
    db.all<{ binding_generation: number; status: string; actor_id: string; session_id: string }>(
      `SELECT binding_generation, status, actor_id, session_id FROM assignments WHERE role_key = ? ORDER BY binding_generation`,
      [roleKey],
    );

  const takeovers = () =>
    db.all<{ session_id: string; role_key: string; actor: string; evidence_json: string }>(
      `SELECT session_id, role_key, actor, evidence_json FROM audit_events WHERE kind = 'CANONICAL_LIVE_RUNS_TAKEN_OVER'`,
    ).map(({ evidence_json, ...row }) => ({ ...row, evidence: JSON.parse(evidence_json) as Record<string, unknown> }));

  /** Every table, and the audit log up to what it held: the rollback oracle. */
  const durable = (): Record<string, Record<string, unknown>[]> => Object.fromEntries(
    db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map(({ name }) => [name, db.all<Record<string, unknown>>(`SELECT * FROM "${name.replaceAll('"', '""')}"`)]),
  );

  /** Nothing but the refusal's own audit row was written. */
  const expectUnchangedBut = (before: Record<string, Record<string, unknown>[]>, refusal: Decision<unknown>) => {
    expect(refusal.allowed).toBe(false);
    const { audit_events: auditBefore = [], ...tablesBefore } = before;
    const { audit_events: auditAfter = [], ...tablesAfter } = durable();
    expect(tablesAfter).toEqual(tablesBefore);
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
    expect(auditAfter.slice(auditBefore.length).map(({ kind, reason_code }) => ({ kind, reason_code })))
      .toEqual([{ kind: "CANONICAL_SELF_CLAIM_REFUSED", reason_code: refusal.reasonCode }]);
  };

  return {
    harness, db, projectId, roleKey, runId, runOne, first: first.value, predecessor, claimAs, work, owner, assignments,
    takeovers, durable, expectUnchangedBut,
  };
};

/** The existing seam (canonical-self-claim.test.ts `failAuditInserts`): one audit kind's insert throws. */
const failAuditInsertsOf = (db: Db, kind: string) => {
  const run = db.run.bind(db);
  const refused: unknown[] = [];
  const spy = vi.spyOn(db, "run").mockImplementation(((sql: string, params: unknown[] = []) => {
    if (/^\s*INSERT INTO audit_events\b/.test(sql) && params[1] === kind) {
      refused.push(params[1]);
      throw new Error("injected audit insert failure: database or disk is full");
    }
    return run(sql, params);
  }) as typeof db.run);
  return { refused, restore: () => spy.mockRestore() };
};

describe("a resumed resident CTO keeps its live runs (CEO msg_00ce7760, option A)", () => {
  it("W1 — the same conversation, proven DEAD predecessor: admitted at gen+1 and the run's owner moves, nothing else", async () => {
    const f = await startFixture();
    const before = f.work();
    expect(f.owner()).toEqual({
      owner_session_id: f.predecessor.sessionId, owner_binding_generation: 1,
      owner_session_incarnation: f.predecessor.incarnation, owner_role_key: f.roleKey,
    });

    const claimed = await f.claimAs(2);

    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    expect(claimed.value.binding.bindingGeneration).toBe(2);
    const successor = f.harness.cp.sessions.require(claimed.value.sessionId);
    expect(f.owner()).toEqual({
      owner_session_id: successor.sessionId, owner_binding_generation: 2,
      owner_session_incarnation: successor.incarnation, owner_role_key: f.roleKey,
    });
    // Run, contract, candidate and the BLOCK review are byte for byte what they were.
    expect(f.work()).toEqual(before);
    const kinds = before.artifacts.map((row) => row["kind"]);
    expect(kinds).toEqual(expect.arrayContaining(["TASK_CONTRACT", "CANDIDATE_SNAPSHOT", "VERIFICATION", "BLIND_REVIEW"]));
    const review = before.artifacts.find((row) => row["kind"] === "BLIND_REVIEW")!;
    expect(String(review["content_json"])).toContain('"verdict":"BLOCK"');
    const rows = f.assignments();
    expect(rows.map(({ binding_generation, status }) => ({ binding_generation, status }))).toEqual([
      { binding_generation: 1, status: "REVOKED" },
      { binding_generation: 2, status: "ACTIVE" },
    ]);
    expect(rows[1]!.actor_id).toBe(rows[0]!.actor_id);

    const recovered = f.db.all<{ event_id: number; evidence_json: string }>(
      `SELECT event_id, evidence_json FROM audit_events WHERE kind = 'DEAD_BINDING_RECOVERED'`,
    );
    expect(recovered).toHaveLength(1);
    expect(JSON.parse(recovered[0]!.evidence_json)).toMatchObject({ liveness: "DEAD", releasedGeneration: 1 });
    expect(f.takeovers()).toEqual([{
      session_id: successor.sessionId,
      role_key: f.roleKey,
      actor: `canonical-self-claim:${rows[0]!.actor_id}`,
      evidence: {
        runIds: [f.runId],
        fromGeneration: 1,
        toGeneration: 2,
        fromSession: f.predecessor.sessionId,
        toSessionId: successor.sessionId,
        actorId: rows[0]!.actor_id,
        recoveryAuditEventId: recovered[0]!.event_id,
        sessionIncarnation: f.predecessor.incarnation,
        osPid: f.predecessor.osPid,
        recordedStartedAt: f.predecessor.osProcessStartedAt,
        liveness: "DEAD",
      },
    }]);
  });

  /** Each row is handed the predecessor's own snapshot (run 1, as its row recorded it). */
  it.each([
    {
      shape: "ALIVE (its process still runs under the recorded start token)",
      chain: (one: ProcessSnapshot): ProcessSnapshot[] => [...claudeRun(2), one],
    },
    {
      shape: "EPERM (the pid exists and cannot be signalled)",
      chain: () => claudeRun(2),
      signal: (one: ProcessSnapshot) => (pid: number) => { if (pid === one.pid) throw errno("EPERM"); },
    },
    {
      shape: "UNKNOWN (the pid answers but its start token cannot be read)",
      chain: (one: ProcessSnapshot): ProcessSnapshot[] => [...claudeRun(2), { ...one, startedAt: null }],
    },
    {
      shape: "UNKNOWN (signalling fails with an unclassified error)",
      chain: () => claudeRun(2),
      signal: (one: ProcessSnapshot) => (pid: number) => { if (pid === one.pid) throw errno("EIO"); },
    },
  ])("W2 — a predecessor that is $shape is refused and nothing moves", async (row) => {
    const f = await startFixture();
    const one = f.runOne[2]!;
    const before = f.durable();

    const refused = await f.claimAs(2, {
      chain: row.chain(one),
      ...(row.signal === undefined ? {} : { processSignal: row.signal(one) }),
    });

    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE });
    f.expectUnchangedBut(before, refused);
    expect(f.owner()?.owner_session_id).toBe(f.predecessor.sessionId);
  });

  it("W3a — the same conversation UUID under another registered Buzz identity is refused and nothing moves", async () => {
    const f = await startFixture();
    const before = f.durable();

    const refused = await f.claimAs(2, { buzzActorId: "buzz:someone-else" });

    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS });
    f.expectUnchangedBut(before, refused);
  });

  it("W3b — a caller asserting the UUID while its process is another conversation is refused and nothing moves", async () => {
    const f = await startFixture();
    const before = f.durable();

    const refused = await f.claimAs(2, { chain: claudeRun(2, OTHER), claimedSessionUuid: CANON });

    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    f.expectUnchangedBut(before, refused);
  });

  it("W3c — the role held by a different actor is left bound, though the UUID's actor is dead, and nothing moves", async () => {
    const f = await startFixture({ liveRun: false });
    const { harness, db, roleKey, projectId } = f;
    // Generation 2 is another actor's: a plain bind mints a new one, and it owns the live run.
    expect(harness.cp.bindings.revoke(roleKey, "handed to another actor").allowed).toBe(true);
    const other = harness.cp.sessions.create({ provider: "scripted", model: "other", buzzAddress: null });
    expect(harness.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: other.sessionId });
    if (!bound.allowed) throw new Error(JSON.stringify(bound));
    db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
                         owner_session_id, owner_session_incarnation, owner_binding_generation, owner_role_key, created_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'other goal', 'sha256:contract', ?, ?, 2, ?, ?)`,
      [RUN_ID, projectId, other.sessionId, bound.value.sessionIncarnation, roleKey, harness.clock.nowIso()],
    );
    const before = f.durable();

    const refused = await f.claimAs(2, { expectedBindingGeneration: 3 });

    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE });
    f.expectUnchangedBut(before, refused);
    expect(f.owner()?.owner_session_id).toBe(other.sessionId);
  });

  it.each(["CANONICAL_LIVE_RUNS_TAKEN_OVER", "CANONICAL_SELF_CLAIM_ADMITTED"])(
    "W4 — a fault at the %s row rolls the whole takeover back", async (kind) => {
      const f = await startFixture();
      const before = f.durable();
      const injected = failAuditInsertsOf(f.db, kind);

      let refused: Decision<unknown>;
      try {
        refused = await f.claimAs(2);
      } finally { injected.restore(); }

      expect(injected.refused).toEqual([kind]);
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.AUDIT_WRITE_FAILED });
      f.expectUnchangedBut(before, refused);
      expect(f.harness.cp.bindings.active(f.roleKey)?.assignmentId).toBe(f.first.binding.assignmentId);
      expect(f.owner()?.owner_session_id).toBe(f.predecessor.sessionId);
      expect(f.assignments().map(({ binding_generation }) => binding_generation)).toEqual([1]);

      // Nothing was left half-done: the same claim then succeeds.
      const retried = await f.claimAs(2);
      expect(retried.allowed, JSON.stringify(retried)).toBe(true);
    },
  );

  it("W4 — a refusal after the repoint really moved the run rolls the move back too", async () => {
    const f = await startFixture();
    const before = f.durable();
    const real = f.harness.cp.bindings.repointLiveRunsToSameActorSuccessor.bind(f.harness.cp.bindings);
    let movedInside: unknown = null;
    const spy = vi.spyOn(f.harness.cp.bindings, "repointLiveRunsToSameActorSuccessor").mockImplementation((...args) => {
      const result = real(...args);
      expect(result.allowed).toBe(true);
      movedInside = f.owner()?.owner_binding_generation;
      return deny(ReasonCode.CONFLICT, "injected after the real repoint", {});
    });

    let refused: Decision<unknown>;
    try {
      refused = await f.claimAs(2);
    } finally { spy.mockRestore(); }

    expect(movedInside).toBe(2);
    f.expectUnchangedBut(before, refused);
    expect(f.owner()?.owner_binding_generation).toBe(1);
  });

  it("W5 — after the takeover the old generation's submit, ACK and claim are refused by the existing fences", async () => {
    const f = await startFixture();
    const { harness, roleKey } = f;
    const claimed = await f.claimAs(2);
    if (!claimed.allowed) throw new Error(JSON.stringify(claimed));
    const old = f.predecessor;
    const next = harness.cp.sessions.require(claimed.value.sessionId);

    // Submit: every authority operation on a run funnels through `assertOwner` (§11.1).
    expect(harness.cp.runs.assertOwner(f.runId, old.sessionId, 1)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.RUN_OWNER_REVOKED,
    });
    expect(harness.cp.runs.assertOwner(f.runId, next.sessionId, 2).allowed).toBe(true);
    expect(harness.cp.bindings.isCurrent(roleKey, 1)).toBe(false);
    expect(harness.cp.bindings.authenticateBoundSession({
      roleKey, sessionId: old.sessionId, sessionSecret: f.first.sessionSecret!, bindingGeneration: 1,
    }).allowed).toBe(false);
    expect(harness.cp.bindings.authenticateBoundSession({
      roleKey, sessionId: next.sessionId, sessionSecret: claimed.value.sessionSecret!, bindingGeneration: 2,
    }).allowed).toBe(true);

    // A late message to the old generation is not admitted.
    expect(harness.cp.outbox.enqueue({
      idempotencyKey: "late-to-old", roleKey, bindingGeneration: 1, targetSessionId: old.sessionId, runId: f.runId,
      kind: MessageKind.REVIEW_REQUEST, payload: { note: "late" },
    })).toMatchObject({ allowed: false, reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT });

    // ACK: the old generation cannot settle the successor's message.
    const queued = harness.cp.outbox.enqueue({
      idempotencyKey: "for-new", roleKey, bindingGeneration: 2, targetSessionId: next.sessionId, runId: f.runId,
      kind: MessageKind.REVIEW_REQUEST, payload: { note: "for the successor" },
    });
    if (!queued.allowed) throw new Error(JSON.stringify(queued));
    expect(harness.cp.outbox.acknowledge(queued.value.messageId, old.sessionId, 1, old.incarnation)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
    });

    // Claim: the old holder tuple is handed nothing addressed to the role.
    const owed = harness.cp.outbox.enqueue({
      idempotencyKey: "owner-now", roleKey, bindingGeneration: 2, targetSessionId: next.sessionId,
      kind: MessageKind.OWNER_MESSAGE, payload: { text: "owner message", nonce: "owner-nonce" },
    });
    if (!owed.allowed) throw new Error(JSON.stringify(owed));
    expect(harness.cp.outbox.claimForHolder({
      roleKey, bindingGeneration: 1, targetSessionId: old.sessionId, sessionIncarnation: old.incarnation,
    }).claimed).toEqual([]);
    expect(harness.cp.outbox.claimForHolder({
      roleKey, bindingGeneration: 2, targetSessionId: next.sessionId, sessionIncarnation: next.incarnation,
    }).claimed.map((message) => message.messageId)).toEqual([owed.value.messageId]);
    // And a late self-claim for the generation already taken is refused.
    expect(await f.claimAs(2)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(f.owner()?.owner_session_id).toBe(next.sessionId);
  });

  it("W6 — of two concurrent self-claims exactly one generation is admitted and the run moves once", async () => {
    const f = await startFixture();
    const before = f.work();

    const results = await Promise.all([f.claimAs(2), f.claimAs(3, { expectedBindingGeneration: 2 })]);

    const admitted = results.filter((result) => result.allowed);
    const refused = results.filter((result) => !result.allowed);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reasonCode: ReasonCode.CONFLICT });
    const winner = admitted[0]!;
    if (!winner.allowed) return;
    expect(f.owner()).toMatchObject({ owner_session_id: winner.value.sessionId, owner_binding_generation: 2 });
    expect(f.assignments().map(({ binding_generation, status }) => ({ binding_generation, status }))).toEqual([
      { binding_generation: 1, status: "REVOKED" },
      { binding_generation: 2, status: "ACTIVE" },
    ]);
    expect(f.takeovers()).toHaveLength(1);
    expect(f.work()).toEqual(before);
  });

  it("W7a — control: a dead predecessor with no live run is recovered as before, with no takeover row", async () => {
    const f = await startFixture({ liveRun: false });

    const claimed = await f.claimAs(2);

    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    expect(f.takeovers()).toEqual([]);
    const recovered = f.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = 'DEAD_BINDING_RECOVERED'`,
    );
    expect(recovered.map((row) => JSON.parse(row.evidence_json) as unknown)).toEqual([{
      assignmentId: f.first.binding.assignmentId,
      releasedGeneration: 1,
      sessionIncarnation: f.predecessor.incarnation,
      osPid: f.predecessor.osPid,
      liveness: "DEAD",
    }]);
  });

  it("W7b — control: every other revoke of a binding that owns a live run is still refused", async () => {
    const f = await startFixture();
    const { harness, db, roleKey, projectId, predecessor } = f;
    const before = f.durable();

    expect(harness.cp.bindings.revoke(roleKey, "plain revoke")).toMatchObject({
      allowed: false, reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS,
    });
    // The operator door, on the same DEAD proof, binds no successor and still refuses.
    const chain = claudeRun(2);
    expect(recoverDeadCanonicalBinding("operator:test", {
      projectId, role: Role.PRIMARY_CTO, sessionId: predecessor.sessionId,
      sessionIncarnation: predecessor.incarnation, expectedBindingGeneration: 1,
    }, {
      db, audit: harness.cp.audit, sessions: harness.cp.sessions, bindings: harness.cp.bindings,
      liveness: { signal: signalFrom(chain), startedAt: (pid) => chain.find((entry) => entry.pid === pid)?.startedAt ?? null },
    })).toMatchObject({ allowed: false, reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS });
    expect(f.durable()).toEqual(before);
  });
});
