import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ATTEMPT_RELEASE_NOTICE_DEFERRED, OWNERLESS_STALL_OWED } from "../../src/doctor/watchdog.ts";
import { ArtifactKind, ExecutionMode, Role, RunState, SessionLifecycle, type RunRow } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { ATTEMPT_RELEASED_NOTICE } from "../../src/run/candidate-pipeline.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { BOOTSTRAP_REVIEW_RETRY_WAKE, reviewRetryTriggerKind } from "../../src/runtime/provisioned-session-runtime.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";
import { scriptBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

afterAll(cleanupTempDirs);

/**
 * #1344 A, C1 — a candidate pipeline attempt runs in its daemon's process, so none survives a restart. The restart's
 * reconcile releases one an ended daemon left RUNNING, through the watchdog's deadline release, with the reason
 * "daemon restart": its evidence is kept and a fresh result_submit is admitted at once, rather than refused CONFLICT
 * until its deadline. On either path the run's owner CTO is told in band that the attempt was released.
 */

const MINUTE = 60_000;

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const prepare = async () => {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h, "fixture-project");
  bindCeo(h);
  const created = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(h.repoPath);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  return { h, run, covered: `${identity}:src/app.js` };
};

const submission = (run: RunRow) => ({
  runId: run.runId,
  ownerSessionId: run.ownerSessionId!,
  ownerBindingGeneration: run.ownerBindingGeneration!,
  resultSummary: "app() now returns 2",
  recommendation: "merge",
});

/** An attempt a daemon that has since ended took for the run: RUNNING, its deadline 28 minutes ahead. */
const strandAttempt = (h: Pick<Harness, "clock" | "cp">, run: RunRow, attemptId = "attempt_endeddaemon000000000001"): string => {
  const now = h.clock.now();
  h.cp.db.run(
    `INSERT INTO candidate_pipeline_attempts
       (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
     VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
    [run.runId, attemptId, run.ownerSessionId, run.ownerBindingGeneration, now.toISOString(),
      new Date(now.getTime() + 28 * MINUTE).toISOString()],
  );
  return attemptId;
};

const attemptRow = (h: Harness, runId: string) =>
  h.cp.db.get<{ attempt_id: string; state: string; started_at: string }>(
    "SELECT attempt_id, state, started_at FROM candidate_pipeline_attempts WHERE run_id = ?",
    [runId],
  )!;

const releaseNotices = (h: Harness, runId: string) =>
  h.cp.outbox.listByRun(runId).filter((message) =>
    message.kind === MessageKind.REVISION_REQUEST && (message.payload as { stage?: unknown }).stage === "attempt-released");

const owedRelease = (h: Harness, runId: string) =>
  h.cp.audit.forRun(runId).filter((row) => row.kind === OWNERLESS_STALL_OWED);

const restartReconcile = (h: Harness) => new Daemon(h.cp, { stateDir: tempDir("acp-1344-restart-") }).reconcile();

describe("#1344 A: a daemon restart releases the candidate pipeline attempts its predecessor left RUNNING", () => {
  it("releases the dead attempt with the restart reason, keeps its evidence, and admits a fresh result_submit at once", async () => {
    const { h, run, covered } = await prepare();
    const frozen = await h.cp.pipeline.freeze(run.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const attemptId = strandAttempt(h, run);
    // Before the restart's reconcile the dead attempt holds the run: a fresh submission is refused.
    expect(await h.cp.pipeline.submitResult(submission(run))).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    const artifactsBefore = h.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ?", [run.runId])!.n;

    const report = await restartReconcile(h);

    expect(report.releasedCandidateAttempts).toEqual([expect.objectContaining({
      runId: run.runId,
      attemptId,
      reason: "daemon restart",
      since: h.clock.nowIso(),
    })]);
    expect(attemptRow(h, run.runId)).toMatchObject({ attempt_id: attemptId, state: "RELEASED" });
    // The watchdog's release record, with the restart's reason: the CEO is owed the stall, as on a deadline.
    expect(owedRelease(h, run.runId).map((row) => row.evidence)).toEqual([
      { kind: "candidate_pipeline_attempt", target: attemptId, since: h.clock.nowIso(), reason: "daemon restart" },
    ]);
    // Only the hold ended: what the run had recorded is all still there.
    expect(h.cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ?", [run.runId])!.n).toBe(artifactsBefore);

    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    const fresh = await h.cp.pipeline.submitResult(submission(run));
    expect(fresh).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(attemptRow(h, run.runId).attempt_id).not.toBe(attemptId);
  });

  it("never releases an attempt this process runs", async () => {
    const { h, run, covered } = await prepare();
    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]), delayMs: 25 });
    const inFlight = h.cp.pipeline.submitResult(submission(run));
    const live = attemptRow(h, run.runId);
    expect(live.state).toBe("RUNNING");

    const report = await restartReconcile(h);

    expect(report.releasedCandidateAttempts).toEqual([]);
    expect(owedRelease(h, run.runId)).toEqual([]);
    expect(await inFlight).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(releaseNotices(h, run.runId)).toEqual([]);
  });
});

describe("#1344 C1: the run's owner CTO is told its attempt was released, on both paths", () => {
  const expectOwnerNotice = (h: Harness, run: RunRow, attemptId: string, reason: string, noticeId: string | null): void => {
    const notices = releaseNotices(h, run.runId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      messageId: noticeId,
      runId: run.runId,
      targetSessionId: run.ownerSessionId,
      bindingGeneration: run.ownerBindingGeneration,
      payload: {
        runId: run.runId,
        reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
        stage: "attempt-released",
        attemptId,
        reason,
        notice: ATTEMPT_RELEASED_NOTICE,
      },
    });
    expect(ATTEMPT_RELEASED_NOTICE).toBe("attempt released, outcome not applied; submit a fresh result");
  };

  it("the restart reconcile's release", async () => {
    const { h, run } = await prepare();
    const attemptId = strandAttempt(h, run);

    const [released] = (await restartReconcile(h)).releasedCandidateAttempts;

    expectOwnerNotice(h, run, attemptId, "daemon restart", released!.ownerNoticeId);
    // A second reconcile finds nothing RUNNING, so it tells the owner nothing more.
    expect((await restartReconcile(h)).releasedCandidateAttempts).toEqual([]);
    expect(releaseNotices(h, run.runId)).toHaveLength(1);
  });

  it("the watchdog's deadline release", async () => {
    const { h, run } = await prepare();
    const attemptId = strandAttempt(h, run);
    h.clock.advance(29 * MINUTE);

    const tick = await h.cp.watchdog.tick();

    expect(tick.stalls).toContainEqual(expect.objectContaining({ kind: "candidate_pipeline_attempt", id: attemptId }));
    expect(attemptRow(h, run.runId).state).toBe("RELEASED");
    const [owed] = owedRelease(h, run.runId);
    expect(owed?.evidence).toMatchObject({ target: attemptId, reason: "deadline" });
    const [notice] = releaseNotices(h, run.runId);
    expectOwnerNotice(h, run, attemptId, "deadline", notice?.messageId ?? null);
  });
});

describe("#1344: a release notice is never lost, and a project-less bootstrap owner is woken to resubmit", () => {
  it("an owner whose session is ERROR at the restart is told once it recovers: the notice stays owed, never dropped", async () => {
    const { h, run } = await prepare();
    const attemptId = strandAttempt(h, run);
    const down = h.cp.sessions.transition(run.ownerSessionId!, SessionLifecycle.ERROR, "the owner's process ended with the daemon");
    expect(down.allowed).toBe(true);

    const [released] = (await restartReconcile(h)).releasedCandidateAttempts;

    // The outbox refuses a target that is not live; the release still commits, and the notice is owed, not dropped.
    expect(released).toMatchObject({ attemptId, ownerNoticeId: null, ownerNoticeDeferred: ReasonCode.OUTBOX_TARGET_NOT_CURRENT });
    expect(attemptRow(h, run.runId).state).toBe("RELEASED");
    expect(releaseNotices(h, run.runId)).toEqual([]);
    expect(h.cp.audit.forRun(run.runId).filter((row) => row.kind === ATTEMPT_RELEASE_NOTICE_DEFERRED)).toEqual([
      expect.objectContaining({ reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT, evidence: { attemptId, reason: "daemon restart" } }),
    ]);
    // While the owner is down, a tick asks again and writes nothing.
    await h.cp.watchdog.tick();
    expect(releaseNotices(h, run.runId)).toEqual([]);

    // The owner recovers: the role is given a live holder.
    const replacement = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    h.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement CTO");
    const switched = h.cp.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      projectId: run.projectId!,
      sessionId: replacement.sessionId,
      reason: "the CTO is replaced",
      conversation: "REPLACED",
      takeover: true,
    });
    if (!switched.allowed) throw new Error(switched.message);

    await h.cp.watchdog.tick();

    expect(releaseNotices(h, run.runId)).toEqual([expect.objectContaining({
      targetSessionId: replacement.sessionId,
      bindingGeneration: switched.value.bindingGeneration,
      payload: expect.objectContaining({ attemptId, reason: "daemon restart", notice: ATTEMPT_RELEASED_NOTICE }),
    })]);
    // Told once: a later tick writes no second notice.
    await h.cp.watchdog.tick();
    expect(releaseNotices(h, run.runId)).toHaveLength(1);
  });

  it("a project-less bootstrap run with a frozen PLAN and a stranded attempt: its owner is woken to resubmit, and its review completes", async () => {
    await withBootstrapRuntime(async (f) => {
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onRevision: "ignore", onResult: "ignore", onRetry: "follow-prompt" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await f.awaitFinishedTurns(ownerSessionId, 1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
      const plans = owner.submissions.length;
      const planDigest = f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest;
      const run = f.harness.cp.runs.require(runId);
      // A daemon that has since ended took the attempt and froze the PLAN's candidate; its review never answered.
      const attemptId = strandAttempt(f.harness, run);
      const frozen = await f.harness.cp.pipeline.freeze(runId, attemptId);
      if (!frozen.allowed) throw new Error(frozen.message);
      const candidate = f.harness.cp.runs.currentCandidate(runId)!;
      expect(f.harness.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE")).toEqual([]);

      const [released] = f.harness.cp.watchdog.releaseAttemptsOfEndedDaemons();

      expect(released).toMatchObject({ runId, attemptId, reason: "daemon restart", ownerNoticeId: null, ownerNoticeDeferred: null });
      // No REVISION_REQUEST: one would make the driven bootstrap CTO replace the PLAN under review.
      expect(f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.REVISION_REQUEST)).toEqual([]);

      f.harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, runId)) });
      const swept = f.daemon.wakeBootstrapResultRecovery();

      expect(swept.woken).toEqual([expect.objectContaining({
        runId,
        retry: expect.objectContaining({ candidateSnapshotDigest: candidate, releasedAttemptId: attemptId }),
      })]);
      expect(f.harness.cp.audit.forRun(runId).filter((row) => row.kind === BOOTSTRAP_REVIEW_RETRY_WAKE)).toEqual([
        expect.objectContaining({ evidence: expect.objectContaining({ candidateSnapshotDigest: candidate, releasedAttemptId: attemptId }) }),
      ]);
      await vi.waitFor(() => expect(owner.results).toHaveLength(1), { timeout: 10_000, interval: 25 });
      expect(owner.prompts.at(-1)).toContain(`The control plane woke you for: ${reviewRetryTriggerKind(runId)}.`);
      expect(owner.results).toEqual([{ runId, ok: true, stage: "COMPLETED_REVIEW" }]);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      // It resubmitted the same PLAN's result: no new PLAN.
      expect(owner.submissions).toHaveLength(plans);
      expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest).toBe(planDigest);
    });
  });
});
