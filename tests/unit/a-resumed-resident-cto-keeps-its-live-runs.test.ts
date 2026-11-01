import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { recoverDeadCanonicalBinding } from "../../src/daemon/dead-binding-recovery.ts";
import type { Db } from "../../src/db/database.ts";
import { WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, makeRepo, seedRun } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  bootstrapCtoProvider,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerRevise,
} from "../helpers/harness.ts";

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

const contract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

interface FixtureOptions {
  /** Drive the run to a BLOCK review (the default), or leave no live run at all. */
  liveRun?: boolean;
  /** Instead, leave the run with its one worker execution still RUNNING under generation 1. */
  inFlight?: boolean;
  /**
   * Instead, finish that execution and submit the result under generation 1, holding the blind review
   * so the candidate pipeline attempt stays RUNNING until `releaseReview`.
   */
  submitting?: boolean;
  /** Also dispatch a second, bare run to generation 1. */
  secondRun?: boolean;
}

const startFixture = async (options: FixtureOptions = {}) => {
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
  let executionId: string | null = null;
  let releaseReview: (() => void) | null = null;
  let submission: Promise<Decision<unknown>> | null = null;
  // The canonical CTO's provider is `claude`; dispatch asks its capacity before it pins the owner.
  if (options.liveRun !== false || options.secondRun === true || options.submitting === true) {
    bootstrapCtoProvider(harness.cp, harness.clock);
  }
  if (options.inFlight === true || options.submitting === true) {
    // The real run path up to a worker turn the daemon has started and not finished.
    if (!harness.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(harness);
    const created = harness.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD, contract,
      repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    runId = created.value.runId;
    const dispatched = await harness.cp.runs.dispatch(runId);
    if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
    expect(dispatched.value).toMatchObject({ ownerSessionId: predecessor.sessionId, ownerBindingGeneration: 1 });
    const tasks = harness.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
    if (!tasks.allowed) throw new Error(tasks.message);
    const impl = harness.cp.tasks.ready(runId)[0]!;
    const started = harness.cp.tasks.startExecution({
      runId, taskId: impl.taskId, ownerBindingGeneration: 1, workerSessionId: bindWorker(harness, impl.taskId),
      provider: "scripted", model: "scripted-worker", repositoryId: registered.repositoryId,
    });
    if (!started.allowed) throw new Error(started.message);
    executionId = started.value.executionId;
    if (options.submitting === true) {
      const head = applyPassingChange(harness.repoPath, "feature/F1-thing");
      const finished = harness.cp.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
      if (!finished.allowed) throw new Error(finished.message);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reviewStarted!: () => void;
      const reviewing = new Promise<void>((resolve) => { reviewStarted = resolve; });
      const invoke = harness.scripted.invoke.bind(harness.scripted);
      vi.spyOn(harness.scripted, "invoke").mockImplementation(async (request) => {
        if (/Candidate review/.test(request.prompt)) {
          reviewStarted();
          await gate;
        }
        return invoke(request);
      });
      harness.scripted.script({
        match: /Candidate review/,
        text: reviewerRevise([`${registered.identity}:src/app.js`], "fixture revision"),
      });
      submission = harness.cp.pipeline.submitResult({
        runId, ownerSessionId: predecessor.sessionId, ownerBindingGeneration: 1,
        resultSummary: "app() returns 2", recommendation: "review it",
      });
      await Promise.race([
        reviewing,
        submission.then((ended) => { throw new Error(`the submission ended before its review: ${JSON.stringify(ended)}`); }),
      ]);
      releaseReview = release;
    }
  } else if (options.liveRun !== false) {
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
  let secondRunId: string | null = null;
  if (options.secondRun === true) {
    if (!harness.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(harness);
    const created = harness.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD, contract: { ...contract, goal: "a second piece of work" },
      repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
    expect(dispatched.value).toMatchObject({ ownerSessionId: predecessor.sessionId, ownerBindingGeneration: 1 });
    secondRunId = created.value.runId;
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
    tasks: db.all<Record<string, unknown>>(`SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id`, [runId]),
    executions: db.all<Record<string, unknown>>(`SELECT * FROM task_executions WHERE run_id = ? ORDER BY execution_id`, [runId]),
  });

  const owner = (of: string = runId) =>
    db.get<{
      owner_session_id: string; owner_binding_generation: number; owner_session_incarnation: string; owner_role_key: string;
    }>(
      `SELECT owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key
         FROM runs WHERE run_id = ?`,
      [of],
    ) ?? null;

  const assignments = () =>
    db.all<{ binding_generation: number; status: string; actor_id: string; session_id: string }>(
      `SELECT binding_generation, status, actor_id, session_id FROM assignments WHERE role_key = ? ORDER BY binding_generation`,
      [roleKey],
    );

  const takeovers = () =>
    db.all<{ run_id: string; session_id: string; role_key: string; actor: string; evidence_json: string }>(
      `SELECT run_id, session_id, role_key, actor, evidence_json FROM audit_events
        WHERE kind = 'CANONICAL_LIVE_RUNS_TAKEN_OVER' ORDER BY event_id`,
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
    harness, db, projectId, roleKey, runId, secondRunId, executionId, releaseReview, submission, runOne,
    first: first.value, predecessor, claimAs,
    work, owner, assignments,
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
    const heldClaims = f.db.all<{ claim_id: string }>(
      `SELECT claim_id FROM resource_claims WHERE run_id = ? AND status = 'HELD' ORDER BY claim_id`, [f.runId],
    ).map((row) => row.claim_id);
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
    // Run, contract, candidate, the BLOCK review, its tasks and executions are byte for byte what they were.
    expect(f.work()).toEqual(before);
    expect(before.tasks.length).toBeGreaterThan(0);
    expect(before.executions.map((row) => row["status"])).toEqual(["SUCCEEDED"]);
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
      run_id: f.runId,
      session_id: successor.sessionId,
      role_key: f.roleKey,
      actor: `canonical-self-claim:${rows[0]!.actor_id}`,
      evidence: {
        claimIds: heldClaims,
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

  it("W8 (F1) — a worker turn still RUNNING under gen 1 refuses the claim with nothing moved; once it ends, the claim keeps its result", async () => {
    const f = await startFixture({ inFlight: true });
    const { harness, db } = f;
    const executionOf = () => db.get<Record<string, unknown>>(`SELECT * FROM task_executions WHERE execution_id = ?`, [f.executionId]);
    const taskOf = () => db.all<Record<string, unknown>>(`SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id`, [f.runId]);
    expect(executionOf()).toMatchObject({ status: "RUNNING", owner_binding_generation: 1 });
    const taskBefore = taskOf();
    const before = f.durable();

    const refused = await f.claimAs(2);

    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT,
      evidence: { runs: [f.runId], inFlight: [{ kind: "EXECUTION", id: f.executionId, runId: f.runId }] },
    });
    f.expectUnchangedBut(before, refused);
    expect(executionOf()).toMatchObject({ status: "RUNNING", owner_binding_generation: 1 });
    expect(taskOf()).toEqual(taskBefore);
    expect(f.owner()).toMatchObject({ owner_session_id: f.predecessor.sessionId, owner_binding_generation: 1 });
    expect(harness.cp.bindings.active(f.roleKey)?.bindingGeneration).toBe(1);

    // The daemon-owned turn ends by itself under the generation that started it.
    const head = applyPassingChange(harness.repoPath, "feature/F1-thing");
    const finished = harness.cp.tasks.finishExecution(f.executionId!, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    expect(finished.allowed, JSON.stringify(finished)).toBe(true);
    const settled = { execution: executionOf(), tasks: taskOf() };
    expect(settled.execution).toMatchObject({ status: "SUCCEEDED", result_digest: `sha256:${head}` });

    const admitted = await f.claimAs(2);

    expect(admitted.allowed, JSON.stringify(admitted)).toBe(true);
    if (!admitted.allowed) return;
    expect(f.owner()).toMatchObject({ owner_session_id: admitted.value.sessionId, owner_binding_generation: 2 });
    // The finished work is kept: neither the execution nor its task was touched by the takeover.
    expect({ execution: executionOf(), tasks: taskOf() }).toEqual(settled);
  });

  it("W9 (F2) — the proof requires the recorded DEAD: a recovery row recording anything else moves nothing", async () => {
    const f = await startFixture();
    const before = f.durable();
    const record = f.harness.cp.audit.record.bind(f.harness.cp.audit);
    const spy = vi.spyOn(f.harness.cp.audit, "record").mockImplementation((entry) =>
      record(entry.kind === "DEAD_BINDING_RECOVERED" ? { ...entry, evidence: { ...entry.evidence, liveness: "UNKNOWN" } } : entry));

    let refused: Decision<unknown>;
    try {
      refused = await f.claimAs(2);
    } finally { spy.mockRestore(); }

    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS });
    f.expectUnchangedBut(before, refused);
  });

  it("W10 (F2) — the repoint proves the succession again: one broken after the authority was minted moves nothing", async () => {
    const f = await startFixture();
    const before = f.durable();
    const carry = f.harness.cp.bindings.carryPeerMessagesToSameActorSuccessor.bind(f.harness.cp.bindings);
    // Between the authority's minting and the repoint: the successor generation is revoked again.
    const spy = vi.spyOn(f.harness.cp.bindings, "carryPeerMessagesToSameActorSuccessor").mockImplementation((...args) => {
      const carried = carry(...args);
      expect(f.harness.cp.bindings.revoke(f.roleKey, "the successor lost its binding after minting").allowed).toBe(true);
      return carried;
    });

    let refused: Decision<unknown>;
    try {
      refused = await f.claimAs(2);
    } finally { spy.mockRestore(); }

    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS });
    f.expectUnchangedBut(before, refused);
  });

  it("W11 (F2) — the repoint runs only inside the claim's transaction", async () => {
    const f = await startFixture();
    const real = f.harness.cp.bindings.repointLiveRunsToSameActorSuccessor.bind(f.harness.cp.bindings);
    let authority: Parameters<typeof real>[0] | null = null;
    const spy = vi.spyOn(f.harness.cp.bindings, "repointLiveRunsToSameActorSuccessor").mockImplementation((...args) => {
      authority = args[0];
      return real(...args);
    });
    let claimed: Decision<unknown>;
    try {
      claimed = await f.claimAs(2);
    } finally { spy.mockRestore(); }
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    expect(authority).not.toBeNull();
    const after = f.durable();

    expect(() => f.harness.cp.bindings.repointLiveRunsToSameActorSuccessor(authority!, [])).toThrow(/requires the self-claim's transaction/);
    expect(f.durable()).toEqual(after);
  });

  it("W12 (F3) — a release whose runs were not moved fails the claim before commit", async () => {
    const f = await startFixture();
    const before = f.durable();
    // The repoint answers success and moves nothing: the release's word is all the claim has.
    const spy = vi.spyOn(f.harness.cp.bindings, "repointLiveRunsToSameActorSuccessor")
      .mockImplementation((_authority, runIds) => allow(ReasonCode.OK, { runIds: [...runIds], claims: [] }));

    let refused: Decision<unknown>;
    try {
      refused = await f.claimAs(2);
    } finally { spy.mockRestore(); }

    expect(refused).toMatchObject({
      allowed: false, reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS, evidence: { runs: [f.runId] },
    });
    f.expectUnchangedBut(before, refused);
  });

  it("W13 (F4) — one CANONICAL_LIVE_RUNS_TAKEN_OVER row per moved run, on its run_id", async () => {
    const f = await startFixture({ secondRun: true });
    expect(f.secondRunId).not.toBeNull();

    const claimed = await f.claimAs(2);

    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    for (const runId of [f.runId, f.secondRunId!]) {
      expect(f.owner(runId)).toMatchObject({ owner_session_id: claimed.value.sessionId, owner_binding_generation: 2 });
    }
    const rows = f.takeovers();
    expect(rows.map((row) => row.run_id).sort()).toEqual([f.runId, f.secondRunId!].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ session_id: claimed.value.sessionId, role_key: f.roleKey });
      expect(row.evidence).toMatchObject({ fromGeneration: 1, toGeneration: 2, liveness: "DEAD" });
    }
  });

  it("W14 (F4) — a run continuity holds is kept held after the takeover, and the takeover row is why", async () => {
    const f = await startFixture();
    const { harness } = f;
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const pause = () => {
      // The daemon's own pause (`Daemon.pauseAffectedRuns`) for a lost CEO.
      const paused = harness.cp.runs.pauseForContinuity(f.runId, ceo.roleKey, "failover refused: SESSION_NOT_READY", {
        roleKey: ceo.roleKey, continuityAction: "PAUSE_NEW_WORK",
      });
      expect(paused.allowed, JSON.stringify(paused)).toBe(true);
    };
    expect(harness.cp.runs.require(f.runId).state).toBe(RunState.ACTIVE);
    // Control: with nothing moved, the same hold is released.
    pause();
    const control = harness.cp.runs.releaseContinuityHold(f.runId, ceo);
    expect(control).toMatchObject({ allowed: true, value: { released: true, kept: null } });
    pause();

    const claimed = await f.claimAs(2);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);

    const decided = harness.cp.runs.releaseContinuityHold(f.runId, ceo);
    expect(decided).toMatchObject({
      allowed: true,
      value: {
        released: false,
        kept: expect.stringMatching(/^CANONICAL_LIVE_RUNS_TAKEN_OVER \(event \d+\) was recorded for the run after continuity's pause \(event \d+\)$/),
      },
    });
    expect(harness.cp.runs.require(f.runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: ceo.roleKey });
  });

  it("W15 (F1) — a candidate pipeline attempt still RUNNING under gen 1 refuses the claim with nothing moved; once it ends, the claim keeps its review", async () => {
    const f = await startFixture({ submitting: true });
    const { db } = f;
    const attemptOf = () => db.get<Record<string, unknown>>(`SELECT * FROM candidate_pipeline_attempts WHERE run_id = ?`, [f.runId]);
    const reviewsOf = () => db.all<Record<string, unknown>>(
      `SELECT * FROM run_artifacts WHERE run_id = ? AND kind = 'BLIND_REVIEW' ORDER BY artifact_id`, [f.runId]);
    const held = attemptOf();
    expect(held).toMatchObject({ state: "RUNNING", owner_session_id: f.predecessor.sessionId, owner_binding_generation: 1 });
    const before = f.durable();

    const refused = await f.claimAs(2);

    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT,
      evidence: { runs: [f.runId], inFlight: [{ kind: "PIPELINE_ATTEMPT", id: held!["attempt_id"], runId: f.runId }] },
    });
    f.expectUnchangedBut(before, refused);
    expect(attemptOf()).toEqual(held);
    expect(f.owner()).toMatchObject({ owner_session_id: f.predecessor.sessionId, owner_binding_generation: 1 });

    // The attempt ends by itself under the generation that started it, and its review is applied.
    f.releaseReview!();
    const outcome = await f.submission!;
    expect(outcome.allowed, JSON.stringify(outcome)).toBe(true);
    const settled = { attempt: attemptOf(), reviews: reviewsOf(), state: f.harness.cp.runs.require(f.runId).state };
    expect(settled.attempt).toMatchObject({ attempt_id: held!["attempt_id"], state: "RELEASED" });
    expect(settled.reviews).toHaveLength(1);
    expect(String(settled.reviews[0]!["content_json"])).toContain('"verdict":"REVISE"');

    const admitted = await f.claimAs(2);

    expect(admitted.allowed, JSON.stringify(admitted)).toBe(true);
    if (!admitted.allowed) return;
    expect(f.owner()).toMatchObject({ owner_session_id: admitted.value.sessionId, owner_binding_generation: 2 });
    // The finished attempt and its review are kept as they were.
    expect({ attempt: attemptOf(), reviews: reviewsOf(), state: f.harness.cp.runs.require(f.runId).state }).toEqual(settled);
  });

  /** The run's repository, and the claims of a run by row, for the claim witnesses below. */
  const repositoryOf = (f: Awaited<ReturnType<typeof startFixture>>) =>
    f.db.get<{ identity: string; checkout_path: string }>(
      `SELECT r.identity, r.checkout_path FROM repositories r JOIN run_repositories rr ON rr.repository_id = r.repository_id
        WHERE rr.run_id = ?`,
      [f.runId],
    )!;
  const claimsOf = (f: Awaited<ReturnType<typeof startFixture>>, runId: string = f.runId) =>
    f.db.all<Record<string, unknown>>(`SELECT * FROM resource_claims WHERE run_id = ? ORDER BY claim_id`, [runId]);
  /** Gen 1 takes claims of its own while it still holds the role (nothing revoked it). */
  const acquireAsGen1 = (f: Awaited<ReturnType<typeof startFixture>>, request: Record<string, unknown>) => {
    const repo = repositoryOf(f);
    const acquired = f.harness.cp.claims.acquire({
      runId: f.runId, ownerRoleKey: f.roleKey, repositoryIdentity: repo.identity,
      ownerSessionId: f.predecessor.sessionId, ownerBindingGeneration: 1, ...request,
    } as Parameters<typeof f.harness.cp.claims.acquire>[0]);
    if (!acquired.allowed) throw new Error(JSON.stringify(acquired));
    return acquired.value;
  };

  it("W16 (claims) — right after a takeover, verification as gen 2 passes with no manual release", async () => {
    const f = await startFixture();
    const { harness } = f;
    // The BLOCK review's verification left its worktree claim HELD at gen 1.
    expect(claimsOf(f).filter((row) => row["status"] === "HELD")).toEqual([
      expect.objectContaining({ owner_session_id: f.predecessor.sessionId, owner_binding_generation: 1 }),
    ]);

    const claimed = await f.claimAs(2);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;

    const digest = harness.cp.runs.currentCandidate(f.runId)!;
    const snapshot = harness.cp.artifacts.latestForSnapshot(f.runId, "CANDIDATE_SNAPSHOT", digest)!.content as
      Parameters<typeof harness.cp.verification.verify>[0]["snapshot"];
    const verified = await harness.cp.verification.verify({
      runId: f.runId, snapshot, contractDigest: snapshot.contractDigest,
      commands: harness.cp.projects.activeManifest(f.projectId)!.manifest.verificationCommands,
    });
    expect(verified.allowed, JSON.stringify(verified)).toBe(true);
    if (!verified.allowed) return;
    expect(verified.value.status).toBe("PASS");
    // The verification used the moved claim: still the one row, now the successor's.
    expect(claimsOf(f).filter((row) => row["status"] === "HELD")).toEqual([
      expect.objectContaining({ owner_session_id: claimed.value.sessionId, owner_binding_generation: 2 }),
    ]);
  });

  it("W17 (claims) — a gen-1 branch and path claimed in separate acquisitions are the successor's to write under", async () => {
    const f = await startFixture();
    const { harness } = f;
    const repo = repositoryOf(f);
    const branch = acquireAsGen1(f, { branch: "feature/F1-thing" });
    const path = acquireAsGen1(f, { declaredPaths: ["src/app.js"] });

    const claimed = await f.claimAs(2);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;

    for (const id of [branch[0]!.claimId, path[0]!.claimId]) {
      expect(claimsOf(f).find((row) => row["claim_id"] === id)).toMatchObject({
        status: "HELD", owner_session_id: claimed.value.sessionId, owner_binding_generation: 2,
      });
    }
    // A managed write to the run's checkout as gen 2: its grant needs the branch claim at the run's generation.
    const granted = harness.cp.guard.evaluate({
      operation: WriteOperation.FILE_MUTATION, runId: f.runId, sessionId: claimed.value.sessionId, bindingGeneration: 2,
      targetPath: join(repo.checkout_path, "src/app.js"),
    });
    expect(granted.allowed, JSON.stringify(granted)).toBe(true);
    if (!granted.allowed) return;
    expect(granted.value.targetBranch).toBe("feature/F1-thing");
    expect(harness.cp.guard.consume(granted.value.grantId)).toMatchObject({ allowed: true, reasonCode: ReasonCode.WRITE_ALLOWED });
    // Nothing needs re-acquiring: the successor holds them, and releasing one frees it to acquire again.
    expect(harness.cp.claims.release(path[0]!.claimId, f.runId).allowed).toBe(true);
    expect(harness.cp.claims.acquire({
      runId: f.runId, ownerRoleKey: f.roleKey, repositoryIdentity: repo.identity,
      ownerSessionId: claimed.value.sessionId, ownerBindingGeneration: 2, declaredPaths: ["src/app.js"],
    }).allowed).toBe(true);
  });

  it("W18 (claims) — an acquisition with one row already released moves whole, so the worktree still hands over", async () => {
    const f = await startFixture();
    const { harness } = f;
    const repo = repositoryOf(f);
    const acquired = acquireAsGen1(f, { worktreeId: repo.checkout_path, branch: "feature/wt", declaredPaths: ["README.md"] });
    const readme = acquired.find((claim) => claim.declaredPath === "README.md")!;
    expect(harness.cp.claims.release(readme.claimId, f.runId).allowed).toBe(true);

    const claimed = await f.claimAs(2);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    const handedOver = harness.cp.claims.acquire({
      runId: f.runId, ownerRoleKey: f.roleKey, repositoryIdentity: repo.identity,
      ownerSessionId: claimed.value.sessionId, ownerBindingGeneration: 2,
      worktreeId: repo.checkout_path, branch: "feature/wt",
    });
    expect(handedOver.allowed, JSON.stringify(handedOver)).toBe(true);
    for (const claim of acquired) {
      expect(claimsOf(f).find((row) => row["claim_id"] === claim.claimId)).toMatchObject({
        status: "RELEASED", owner_session_id: claimed.value.sessionId, owner_binding_generation: 2,
      });
    }
  });

  it("W19 (claims) — a HELD claim of a run that is not moved, owned by another role, is untouched", async () => {
    const f = await startFixture();
    const other = seedRun({ db: f.db, clock: f.harness.clock, repoPath: makeRepo(), identity: "github:acme/other" });
    const before = claimsOf(f, other.runId);
    expect(before).toEqual([expect.objectContaining({ status: "HELD", owner_binding_generation: 1, owner_session_id: other.sessionId })]);

    const claimed = await f.claimAs(2);

    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    expect(claimsOf(f, other.runId)).toEqual(before);
    expect(f.owner(other.runId)).toMatchObject({ owner_session_id: other.sessionId, owner_binding_generation: 1 });
  });

  it("W20 (claims) — a rollback mid-transaction leaves every claim at gen 1", async () => {
    const f = await startFixture();
    acquireAsGen1(f, { branch: "feature/F1-thing" });
    acquireAsGen1(f, { declaredPaths: ["src/app.js"] });
    const claimsBefore = claimsOf(f);
    expect(claimsBefore.filter((row) => row["status"] === "HELD")).toHaveLength(3);
    const before = f.durable();
    const injected = failAuditInsertsOf(f.db, "CANONICAL_LIVE_RUNS_TAKEN_OVER");

    let refused: Decision<unknown>;
    try {
      refused = await f.claimAs(2);
    } finally { injected.restore(); }

    expect(injected.refused).toEqual(["CANONICAL_LIVE_RUNS_TAKEN_OVER"]);
    f.expectUnchangedBut(before, refused);
    expect(claimsOf(f)).toEqual(claimsBefore);
    expect(claimsOf(f).every((row) => row["owner_binding_generation"] === 1)).toBe(true);
  });
});
