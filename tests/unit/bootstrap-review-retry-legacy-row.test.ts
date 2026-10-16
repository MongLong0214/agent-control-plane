import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import { BOOTSTRAP_REVIEW_RETRY_WAKE, reviewRetryTriggerKind } from "../../src/runtime/provisioned-session-runtime.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys } from "../helpers/bootstrap-plan.ts";
import { resultState } from "../helpers/bootstrap-result.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { reviewerPass } from "../helpers/harness.ts";
import { scriptBootstrapOwner, type ScriptedBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

/**
 * The review retry for an UNAVAILABLE row written before #1117: its evidence was rejected by the audit
 * log, so it carries `{auditEvidenceRejected:true}` and no candidate digest, only its trusted run_id
 * column. The sweep links it to the run's current candidate by audit order alone — the freeze right
 * before it froze exactly that candidate and nothing moved after that freeze — and otherwise refuses.
 * The row itself is produced by the real audit log, from the free-text evidence the pre-#1117
 * pipeline spread into it.
 */

afterAll(cleanupTempDirs);
afterEach(() => { vi.restoreAllMocks(); });

const PRE_1117_ANSWER = `The reviewer answered outside the verdict schema. ${"It described the plan in prose instead. ".repeat(12)}`;
const OTHER_CANDIDATE = `sha256:${"0".repeat(64)}`;

const auditOf = (f: BootstrapRuntimeFixture, kind: string, runId: string) =>
  f.harness.cp.audit.byKind(kind).filter((row) => row.runId === runId);
const rawRow = (f: BootstrapRuntimeFixture, eventId: number) =>
  f.harness.cp.db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE event_id = ?`, [eventId]);
const sweep = (f: BootstrapRuntimeFixture) => f.daemon.wakeBootstrapResultRecovery();
const retries = (report: ReturnType<BootstrapRuntimeFixture["daemon"]["wakeBootstrapResultRecovery"]>) =>
  report.woken.filter((woken) => "retry" in woken);
const idle = (f: BootstrapRuntimeFixture, sessionId: string) =>
  vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });

/** The fixture's reviewer: unanswered (an EVIDENCE_MISSING review) until `answer`, held while `gate` is pending. */
const reviews = (f: BootstrapRuntimeFixture) => {
  const scripted = f.harness.scripted;
  const invoke = scripted.invoke.bind(scripted);
  const control = { answer: false, gate: null as Promise<void> | null, asked: 0 };
  vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
    if (/Bootstrap plan review/.test(request.prompt)) {
      control.asked += 1;
      if (control.gate) await control.gate;
      if (control.answer) {
        const reviewing = f.harness.cp.db.all<{ run_id: string }>(
          `SELECT run_id FROM candidate_pipeline_attempts WHERE state = 'RUNNING' ORDER BY started_at`,
        );
        for (const { run_id: runId } of reviewing) {
          scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, runId)) });
        }
      }
    }
    return invoke(request);
  });
  return control;
};

/** While `on`, the pipeline's UNAVAILABLE row carries the pre-#1117 free text, which the real audit log rejects. */
const legacyRows = (f: BootstrapRuntimeFixture, before: () => void = () => undefined) => {
  const audit = f.harness.cp.audit;
  const record = audit.record.bind(audit);
  const state = { on: true };
  vi.spyOn(audit, "record").mockImplementation((entry) => {
    if (!state.on || entry.kind !== "BLIND_REVIEW_UNAVAILABLE") return record(entry);
    before();
    return record({ ...entry, evidence: { ...entry.evidence, reviewerAnswer: PRE_1117_ANSWER } });
  });
  return state;
};

const expectLegacyShape = (f: BootstrapRuntimeFixture, runId: string, row: ReturnType<typeof auditOf>[number] | undefined) => {
  expect(row).toBeDefined();
  expect(row!.runId).toBe(runId);
  expect(row!.reasonCode).toBe(ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED);
  expect(row!.evidence).toEqual({ auditEvidenceRejected: true });
  expect(rawRow(f, row!.eventId)).toMatchObject({ run_id: runId, kind: "BLIND_REVIEW_UNAVAILABLE" });
};

/** The live shape: the owner submitted, the candidate froze, and the review's row is the legacy one. */
const legacyRun = async (
  f: BootstrapRuntimeFixture,
  options: { onRetry?: ScriptedBootstrapOwner["onRetry"]; beforeLegacyRow?: () => void } = {},
) => {
  const review = reviews(f);
  const legacy = legacyRows(f, options.beforeLegacyRow);
  const owner = scriptBootstrapOwner(f, {
    onDispatch: "follow-prompt", onRevision: "ignore", onResult: "follow-prompt", onRetry: options.onRetry ?? "follow-prompt",
  });
  const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
  await vi.waitFor(() => expect(owner.results).toHaveLength(1), { timeout: 10_000, interval: 25 });
  await idle(f, ownerSessionId);
  expect(owner.results).toEqual([{ runId, ok: true, stage: "REVIEW_UNAVAILABLE" }]);
  const rows = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId);
  expect(rows).toHaveLength(1);
  expectLegacyShape(f, runId, rows[0]);
  const candidate = f.harness.cp.runs.currentCandidate(runId)!;
  expect(resultState(f, runId)).toEqual({ state: RunState.ACTIVE, candidate, attempts: ["RELEASED"] });
  legacy.on = false;
  review.answer = true;
  const freezes = auditOf(f, "CANDIDATE_FROZEN", runId);
  return {
    review, owner, runId, ownerSessionId, roleKey, candidate,
    planDigest: f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest,
    unavailableEventId: rows[0]!.eventId,
    freezeEventId: freezes.at(-1)!.eventId,
    original: rawRow(f, rows[0]!.eventId),
  };
};

const startDaemon = async (f: BootstrapRuntimeFixture, name: string): Promise<Daemon> => {
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir(`acp-rlr-${name}-`), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};
const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a legacy UNAVAILABLE row with no candidate digest gets the one official retry of the current candidate", () => {
  it("wakes the owner once, its result_submit reviews the same candidate, and the original row is unchanged", async () => {
    await withBootstrapRuntime(async (f) => {
      const run = await legacyRun(f);
      expect(auditOf(f, "CANDIDATE_FROZEN", run.runId).at(-1)!.evidence["candidateSnapshotDigest"]).toBe(run.candidate);
      expect(run.freezeEventId).toBeLessThan(run.unavailableEventId);

      expect(sweep(f)).toEqual({
        woken: [{
          runId: run.runId, roleKey: run.roleKey, bindingGeneration: 1, planDigest: run.planDigest,
          retry: { candidateSnapshotDigest: run.candidate, unavailableEventId: run.unavailableEventId, candidateFrozenEventId: run.freezeEventId },
        }],
      });
      await vi.waitFor(() => expect(run.owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      expect(run.owner.prompts.at(-1)).toContain(`The control plane woke you for: ${reviewRetryTriggerKind(run.runId)}.`);
      expect(run.owner.results.at(-1)).toEqual({ runId: run.runId, ok: true, stage: "COMPLETED_REVIEW" });
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(run.review.asked).toBe(2);
      expect(new Set(auditOf(f, "CANDIDATE_FROZEN", run.runId).map((row) => row.evidence["candidateSnapshotDigest"]))).toEqual(new Set([run.candidate]));
      expect(f.harness.cp.review.latestPacket(run.runId, run.candidate)).toMatchObject({ verdict: "PASS" });
      // The recovery decision names the original row and the candidate it was linked to; the row is untouched.
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, run.runId).map((row) => row.evidence)).toEqual([expect.objectContaining({
        bindingGeneration: 1, planDigest: run.planDigest, candidateSnapshotDigest: run.candidate,
        unavailableEventId: run.unavailableEventId, unavailableLinkedBy: "AUDIT_ORDER", candidateFrozenEventId: run.freezeEventId,
      })]);
      expect(rawRow(f, run.unavailableEventId)).toEqual(run.original);
      await idle(f, run.ownerSessionId);
      expect(sweep(f)).toEqual({ woken: [] });
    });
  });

  it("two sweeps at once, a second pass, and a restart wake nothing more", async () => {
    await withBootstrapRuntime(async (f) => {
      const run = await legacyRun(f, { onRetry: "ignore" });
      const other = new Daemon(f.harness.cp, { stateDir: tempDir("acp-rlr-other-") });
      const [a, b] = await Promise.all([
        Promise.resolve().then(() => f.daemon.wakeBootstrapResultRecovery()),
        Promise.resolve().then(() => other.wakeBootstrapResultRecovery()),
      ]);
      expect([...retries(a), ...retries(b)]).toHaveLength(1);
      await vi.waitFor(() => expect(f.finishedTurns(run.ownerSessionId)).toBe(3), { timeout: 10_000, interval: 25 });
      await idle(f, run.ownerSessionId);
      expect(sweep(f)).toEqual({ woken: [] });
      expect(other.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      const daemon = await startDaemon(f, "restart");
      try {
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(run.ownerSessionId)).toBe(3);
      expect(run.owner.results).toHaveLength(1);
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, run.runId)).toHaveLength(1);
      expect(resultState(f, run.runId)).toEqual({ state: RunState.ACTIVE, candidate: run.candidate, attempts: ["RELEASED"] });
      expect(rawRow(f, run.unavailableEventId)).toEqual(run.original);
    });
  });
});

describe("a legacy row is never linked when the trail moved on after its freeze", () => {
  const record = (f: BootstrapRuntimeFixture, kind: string, runId: string, evidence: Record<string, unknown>, reasonCode?: string) =>
    expect(f.harness.cp.audit.record({ kind, runId, evidence, ...(reasonCode ? { reasonCode: reasonCode as never } : {}) }).allowed).toBe(true);

  const replan = async (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string, revise: boolean) => {
    const plan = f.harness.cp.artifacts.latest<Record<string, unknown>>(runId, ArtifactKind.PLAN)!;
    const answered = await f.cto(ownerSessionId, "plan_submit", {
      runId,
      plan: revise ? { ...plan.content, summary: `${String(plan.content["summary"])}; revised` } : plan.content,
      tasks: [{ key: "bootstrap", title: "create the repository", category: "implementation" }],
    });
    expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
  };

  const rows: Array<{ name: string; after: (f: BootstrapRuntimeFixture, run: Awaited<ReturnType<typeof legacyRun>>) => Promise<void> | void }> = [
    { name: "a revised PLAN", after: (f, run) => replan(f, run.runId, run.ownerSessionId, true) },
    { name: "the same PLAN submitted again", after: (f, run) => replan(f, run.runId, run.ownerSessionId, false) },
    { name: "a re-freeze of the candidate with no outcome yet", after: (f, run) =>
      record(f, "CANDIDATE_FROZEN", run.runId, { candidateSnapshotDigest: run.candidate }) },
    { name: "a revision returned to the CTO", after: (f, run) =>
      record(f, "REVISION_RETURNED_TO_CTO", run.runId, { stage: "blind-review", candidateSnapshotDigest: run.candidate }) },
    { name: "a newer legacy UNAVAILABLE row", after: (f, run) =>
      record(f, "BLIND_REVIEW_UNAVAILABLE", run.runId, { auditEvidenceRejected: true }, ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED) },
    { name: "a completed review of the candidate", after: (f, run) =>
      record(f, "BLIND_REVIEW_COMPLETED", run.runId, { candidateSnapshotDigest: run.candidate, verdict: "PASS" }) },
    { name: "a terminal transition", after: (f, run) =>
      record(f, "RUN_TRANSITION", run.runId, { from: RunState.ACTIVE, to: RunState.FAILED }) },
  ];

  it.each(rows)("$name: no retry", async ({ after }) => {
    await withBootstrapRuntime(async (f) => {
      const run = await legacyRun(f, { onRetry: "ignore" });
      await after(f, run);
      await idle(f, run.ownerSessionId);
      expect(retries(sweep(f))).toEqual([]);
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, run.runId)).toEqual([]);
      expect(rawRow(f, run.unavailableEventId)).toEqual(run.original);
    });
  });

  it("the freeze right before the row froze a different candidate: no retry", async () => {
    await withBootstrapRuntime(async (f) => {
      let runId: string | null = null;
      const run = await legacyRun(f, {
        onRetry: "ignore",
        beforeLegacyRow: () => {
          runId = f.harness.cp.db.get<{ run_id: string }>(
            `SELECT run_id FROM candidate_pipeline_attempts WHERE state = 'RUNNING' LIMIT 1`,
          )!.run_id;
          record(f, "CANDIDATE_FROZEN", runId, { candidateSnapshotDigest: OTHER_CANDIDATE });
        },
      });
      expect(runId).toBe(run.runId);
      expect(auditOf(f, "CANDIDATE_FROZEN", run.runId).at(-1)!.evidence["candidateSnapshotDigest"]).toBe(OTHER_CANDIDATE);
      expect(retries(sweep(f))).toEqual([]);
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, run.runId)).toEqual([]);
    });
  });
});

describe("a legacy row is not retried twice", () => {
  it("while a review of the candidate is running, and not after it completed", async () => {
    await withBootstrapRuntime(async (f) => {
      const run = await legacyRun(f, { onRetry: "ignore" });
      let release = (): void => undefined;
      run.review.gate = new Promise<void>((resolve) => { release = resolve; });
      const submitting = f.cto(run.ownerSessionId, "result_submit", {
        runId: run.runId, resultSummary: "the planned bootstrap outputs", recommendation: "create the repository",
      });
      await vi.waitFor(() => expect(resultState(f, run.runId).attempts).toEqual(["RUNNING"]), { timeout: 10_000, interval: 25 });
      expect(retries(sweep(f))).toEqual([]);
      release();
      expect(await submitting).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(sweep(f)).toEqual({ woken: [] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, run.runId)).toEqual([]);
    });
  });

  it("once the official retry for (run, generation, candidate) is spent; the digest path's retry is unchanged", async () => {
    await withBootstrapRuntime(async (f) => {
      reviews(f);
      const legacy = legacyRows(f);
      legacy.on = false;
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onRevision: "ignore", onResult: "follow-prompt", onRetry: "follow-prompt" });
      const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(owner.results).toHaveLength(1), { timeout: 10_000, interval: 25 });
      await idle(f, ownerSessionId);
      const candidate = f.harness.cp.runs.currentCandidate(runId)!;
      const planDigest = f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest;
      const first = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId);
      expect(first.map((row) => row.evidence["candidateSnapshotDigest"])).toEqual([candidate]);
      // The digest-bearing row: exactly the retry, report and marker this sweep made before.
      legacy.on = true;
      expect(sweep(f)).toEqual({
        woken: [{ runId, roleKey, bindingGeneration: 1, planDigest, retry: { candidateSnapshotDigest: candidate, unavailableEventId: first[0]!.eventId } }],
      });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId).map((row) => row.evidence)).toEqual([{
        bindingGeneration: 1, planDigest, candidateSnapshotDigest: candidate, unavailableEventId: first[0]!.eventId, triggerId: expect.any(String),
      }]);
      await vi.waitFor(() => expect(owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      expect(owner.results.at(-1)).toMatchObject({ stage: "REVIEW_UNAVAILABLE" });
      await idle(f, ownerSessionId);
      // The retried review's row is the legacy shape, right after a freeze of the current candidate.
      const rows = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId);
      expect(rows).toHaveLength(2);
      expectLegacyShape(f, runId, rows[1]);
      const freezes = auditOf(f, "CANDIDATE_FROZEN", runId);
      expect(freezes.at(-1)!.evidence["candidateSnapshotDigest"]).toBe(candidate);
      expect(freezes.at(-1)!.eventId).toBeLessThan(rows[1]!.eventId);
      expect(sweep(f)).toEqual({ woken: [] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(1);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    });
  });
});
