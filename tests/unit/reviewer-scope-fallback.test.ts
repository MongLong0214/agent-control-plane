import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ArtifactKind, Role, RunState } from "../../src/domain/types.ts";
import { REVIEWER_FALLBACK_SCOPE_UNCONFIGURED } from "../../src/review/blind-review.ts";
import { CodexCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import { ProviderSessionProvisionError, type InvocationRequest, type SessionSpec } from "../../src/runtime/provider.ts";
import { BOOTSTRAP_REVIEW_RETRY_WAKE, reviewRetryTriggerKind } from "../../src/runtime/provisioned-session-runtime.ts";
import { provisionReviewerCodexHome } from "../../src/runtime/reviewer-codex-home.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { bootstrapCoverageKeys } from "../helpers/bootstrap-plan.ts";
import { resultState } from "../helpers/bootstrap-result.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { reviewerPass } from "../helpers/harness.ts";
import { TestProductionAdapter, testReviewerEgressEvidence } from "../helpers/production-adapter.ts";
import { scriptBootstrapOwner, type ScriptedBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

/**
 * The claude fallback for the packet reviewer, and the official retry of a review that was unavailable
 * (owner directives and CEO 1792123922, 2026-10-16).
 *
 * The preferred reviewer is the fixture's GPT provider, whose packet reviewer session is the real
 * `CodexCliAdapter`'s — its home selection, its capsule claim and its refusals; only `runCli`, the
 * spawn boundary, is stubbed where a row needs a provider answer. The fallback is a reviewer-scoped
 * Claude double, registered for BLIND_REVIEWER as production registers its reviewer Claude. Every
 * review is the gate's own, reached through the owner's `result_submit` on the real CTO socket.
 */

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  __testing.setRunCli(null);
});

const capsules: string[] = [];
afterAll(() => { for (const root of capsules) rmSync(dirname(root), { recursive: true, force: true }); });

const REVIEWER = {
  preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" },
  fallbacks: [{ provider: "claude", model: "opus", effort: null }],
} as const;
const harnessOptions = { reviewer: { preferred: { ...REVIEWER.preferred }, fallbacks: [{ ...REVIEWER.fallbacks[0] }] } };

/** The error the reviewer path raised before this change, for a deployment with no reviewer scope. */
const liveUnavailable = () =>
  new ProviderSessionProvisionError(ReasonCode.ISOLATION_LOST, "Codex packet reviewer requires a dedicated private CODEX_HOME credential scope");

const missingHome = (): string => join(tempDir("acp-rsf-missing-"), ".codex");
const authenticatedHome = (): string => {
  const home = join(tempDir("acp-rsf-user-"), ".codex");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "auth.json"), '{"synthetic":"credential"}', { mode: 0o600 });
  return home;
};

const codexAdapter = (options: { codexHome: string; reviewerCodexHome?: string }) =>
  new CodexCliAdapter({
    clock: new ManualClock("2026-10-16T00:00:00.000Z"),
    capacityFile: join(tempDir("acp-rsf-capacity-"), "gpt.json"),
    binary: process.execPath,
    ...options,
  });

/**
 * The preferred GPT reviewer: the fixture's GPT provider, whose packet reviewer is `codex()`'s, and
 * whose packet scope the gate reads through the port production wires to the raw Codex adapter.
 */
const preferCodex = (
  f: BootstrapRuntimeFixture,
  codex: () => CodexCliAdapter,
  before: () => Error | null = () => null,
  scopeReported: () => boolean = () => true,
) => {
  f.harness.cp.review.attach({
    packetReviewerScope: (provider) => provider === "gpt" && scopeReported() ? codex().packetReviewerScope() : null,
  });
  const start = f.gpt.startSession.bind(f.gpt);
  const invoke = f.gpt.invoke.bind(f.gpt);
  const isolated: SessionSpec[] = [];
  vi.spyOn(f.gpt, "startSession").mockImplementation(async (spec: SessionSpec) => {
    if (!spec.isolation) return start(spec);
    isolated.push(spec);
    const failure = before();
    if (failure) throw failure;
    return codex().startSession(spec);
  });
  vi.spyOn(f.gpt, "invoke").mockImplementation(async (request: InvocationRequest) =>
    request.isolation ? codex().invoke(request) : invoke(request));
  return { isolated };
};

/** runCli at the spawn boundary: the given reply for every Codex call, recorded. */
const stubCodex = (reply: { exitCode?: number; stderr?: string; timedOut?: boolean; invocationExitCode?: number }) => {
  const calls: Array<{ resume: boolean; codexHome: string | undefined }> = [];
  __testing.setRunCli(async (_file, args, options) => {
    const resume = args.includes("resume");
    calls.push({ resume, codexHome: options.reviewerEnvironment?.CODEX_HOME });
    return {
      stdout: JSON.stringify({ type: "thread.started", thread_id: resume ? String(args.at(-2)) : "rsf-thread" }),
      stderr: reply.stderr ?? "",
      exitCode: resume ? (reply.invocationExitCode ?? 0) : (reply.exitCode ?? 0),
      timedOut: reply.timedOut ?? false,
      isolationEnforced: true,
      egressEvidence: testReviewerEgressEvidence("gpt"),
    };
  });
  return calls;
};

/** The reviewer-scoped Claude fallback; it passes the bootstrap plan review, or answers nothing usable. */
const claudeReviewer = (f: BootstrapRuntimeFixture, verdict: "PASS" | "NO_ANSWER") => {
  const claude = new TestProductionAdapter(f.harness.clock, "claude");
  f.harness.cp.providers.registerForRole(claude, Role.BLIND_REVIEWER);
  const invoke = claude.invoke.bind(claude);
  let asked = 0;
  vi.spyOn(claude, "invoke").mockImplementation(async (request) => {
    if (/Bootstrap plan review/.test(request.prompt)) {
      asked += 1;
      if (verdict === "PASS") {
        const reviewing = f.harness.cp.db.all<{ run_id: string }>(
          `SELECT run_id FROM candidate_pipeline_attempts WHERE state = 'RUNNING' ORDER BY started_at`,
        );
        for (const { run_id: runId } of reviewing) {
          claude.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, runId)) });
        }
      }
    }
    return invoke(request);
  });
  return { asked: () => asked };
};

/** A run whose owner planned on its RUN_DISPATCH and, as asked, did or did not submit its result. */
const planned = async (f: BootstrapRuntimeFixture, options: Partial<Pick<ScriptedBootstrapOwner, "onResult" | "onRetry">> = {}) => {
  const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onRevision: "ignore", onResult: "ignore", ...options });
  const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
  await f.awaitFinishedTurns(ownerSessionId, 1);
  await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false), { timeout: 10_000, interval: 25 });
  expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
  return { owner, runId, ownerSessionId, roleKey, planDigest: f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest };
};

const submitResult = async (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string): Promise<string | null> => {
  const answered = await f.cto(ownerSessionId, "result_submit", {
    runId, resultSummary: "the planned bootstrap outputs", recommendation: "create the repository",
  });
  expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
  return ((answered["value"] ?? {}) as { stage?: string }).stage ?? null;
};

const auditOf = (f: BootstrapRuntimeFixture, kind: string, runId: string) =>
  f.harness.cp.audit.byKind(kind).filter((row) => row.runId === runId);

const frozenDigests = (f: BootstrapRuntimeFixture, runId: string): string[] =>
  auditOf(f, "CANDIDATE_FROZEN", runId).map((row) => String((row.evidence as { candidateSnapshotDigest?: unknown }).candidateSnapshotDigest));

/** Nothing a review retry may use to look successful: no replan, no worker, no receipt, no settled task. */
const nothingSynthesized = (f: BootstrapRuntimeFixture, runId: string) => {
  const db = f.harness.cp.db;
  return {
    plans: f.harness.cp.artifacts.list(runId, ArtifactKind.PLAN).length,
    executions: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ?`, [runId])?.n ?? -1,
    workers: db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments WHERE role = 'WORKER' AND (run_id = ? OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?))`,
      [runId, runId],
    )?.n ?? -1,
    tasks: f.harness.cp.tasks.list(runId).map((task) => task.state),
  };
};

const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startDaemon = async (f: BootstrapRuntimeFixture, name: string): Promise<Daemon> => {
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir(`acp-rsf-${name}-`), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};

describe("the packet reviewer falls back to claude only when its scope is UNCONFIGURED", () => {
  it("UNCONFIGURED: a separate claude BLIND_REVIEWER session reviews, the audit names why and who, and the run reaches CEO review", async () => {
    await withBootstrapRuntime(async (f) => {
      const home = missingHome();
      const { isolated } = preferCodex(f, () => codexAdapter({ codexHome: home }));
      const calls = stubCodex({});
      const claude = claudeReviewer(f, "PASS");
      const { runId, ownerSessionId } = await planned(f);

      expect(await submitResult(f, runId, ownerSessionId)).toBe("COMPLETED_REVIEW");
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      // GPT was passed over on its UNCONFIGURED scope before any session or spawn; Claude reviewed once.
      expect(isolated).toEqual([]);
      expect(calls).toEqual([]);
      expect(claude.asked()).toBe(1);

      const fallback = auditOf(f, "BLIND_REVIEW_FALLBACK", runId);
      expect(fallback).toHaveLength(1);
      expect(fallback[0]!.evidence).toMatchObject({
        from: "gpt",
        preferredModel: "gpt-6.1-sol",
        provider: "claude",
        model: "opus",
        reason: REVIEWER_FALLBACK_SCOPE_UNCONFIGURED,
      });
      const candidate = f.harness.cp.runs.currentCandidate(runId)!;
      const packet = f.harness.cp.review.latestPacket(runId, candidate);
      expect(packet).toMatchObject({ provider: "claude", model: "opus", verdict: "PASS" });
      expect(packet!.reviewerSessionId).not.toBe(ownerSessionId);
      expect(fallback[0]!.sessionId).toBe(packet!.reviewerSessionId);
      expect(f.harness.cp.sessions.get(packet!.reviewerSessionId)?.provider).toBe("claude");
      const assignments = f.harness.cp.db.all<{ role: string; mode: string; run_id: string | null }>(
        `SELECT role, mode, run_id FROM assignments WHERE session_id = ?`,
        [packet!.reviewerSessionId],
      );
      expect(assignments).toEqual([{ role: "BLIND_REVIEWER", mode: "FALLBACK", run_id: runId }]);
      expect(auditOf(f, "BLIND_REVIEW_COMPLETED", runId).map((row) => (row.evidence as { provider?: unknown }).provider))
        .toEqual(["claude"]);
    }, harnessOptions);
  });

  it("a configured but broken scope, or a runtime failure, never falls back: the review stays unavailable", async () => {
    await withBootstrapRuntime(async (f) => {
      const usableDefault = authenticatedHome();
      let codex = codexAdapter({ codexHome: usableDefault });
      preferCodex(f, () => codex);
      const claude = claudeReviewer(f, "PASS");
      const { runId, ownerSessionId } = await planned(f);

      const notACapsule = join(tempDir("acp-rsf-not-a-capsule-"), "home");
      mkdirSync(notACapsule, { mode: 0o700 });
      const wrongMode = provisionReviewerCodexHome();
      capsules.push(wrongMode);
      writeFileSync(join(wrongMode, "auth.json"), "{}", { mode: 0o600 });
      chmodSync(wrongMode, 0o755);
      const claimed = provisionReviewerCodexHome();
      capsules.push(claimed);
      mkdirSync(join(dirname(claimed), "claimed"), { mode: 0o700 });
      const unauthenticated = provisionReviewerCodexHome();
      capsules.push(unauthenticated);
      const unusable = join(tempDir("acp-rsf-unusable-"), ".codex");
      mkdirSync(join(unusable, "auth.json"), { recursive: true });

      const rows: Array<{ name: string; codexHome: string; override?: string; reply: Parameters<typeof stubCodex>[0] }> = [
        { name: "override: a bad path", codexHome: usableDefault, override: notACapsule, reply: {} },
        { name: "override: the wrong mode", codexHome: usableDefault, override: wrongMode, reply: {} },
        { name: "override: already claimed", codexHome: usableDefault, override: claimed, reply: {} },
        { name: "override: not authenticated", codexHome: usableDefault, override: unauthenticated,
          reply: { exitCode: 1, stderr: "Not logged in" } },
        { name: "default home: auth refused at run time", codexHome: usableDefault, reply: { exitCode: 1, stderr: "401 Unauthorized" } },
        { name: "default home: handshake timed out", codexHome: usableDefault, reply: { timedOut: true } },
        { name: "default home: the review invocation failed", codexHome: usableDefault, reply: { invocationExitCode: 1, stderr: "stream error" } },
        { name: "default home present but unusable", codexHome: unusable, reply: {} },
      ];
      for (const row of rows) {
        codex = codexAdapter({ codexHome: row.codexHome, ...(row.override === undefined ? {} : { reviewerCodexHome: row.override }) });
        const calls = stubCodex(row.reply);
        expect(await submitResult(f, runId, ownerSessionId), row.name).toBe("REVIEW_UNAVAILABLE");
        // An override never ran under the default home.
        if (row.override !== undefined) {
          expect(calls.every((call) => call.codexHome !== usableDefault), row.name).toBe(true);
        }
        expect(f.harness.cp.runs.require(runId).state, row.name).toBe(RunState.ACTIVE);
      }
      expect(claude.asked()).toBe(0);
      expect(auditOf(f, "BLIND_REVIEW_FALLBACK", runId)).toEqual([]);
      expect(auditOf(f, "BLIND_REVIEW_COMPLETED", runId)).toEqual([]);
      expect(f.harness.cp.review.latestPacket(runId, f.harness.cp.runs.currentCandidate(runId)!)).toBeNull();
      expect(auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId)).toHaveLength(rows.length);
    }, harnessOptions);
  });

  it("a fallback reviewer that fails leaves the review unavailable, with no review recorded as done", async () => {
    await withBootstrapRuntime(async (f) => {
      preferCodex(f, () => codexAdapter({ codexHome: missingHome() }));
      const claude = claudeReviewer(f, "NO_ANSWER");
      const { runId, ownerSessionId } = await planned(f);

      expect(await submitResult(f, runId, ownerSessionId)).toBe("REVIEW_UNAVAILABLE");
      expect(claude.asked()).toBe(1);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
      expect(auditOf(f, "BLIND_REVIEW_FALLBACK", runId)).toHaveLength(1);
      expect(auditOf(f, "BLIND_REVIEW_COMPLETED", runId)).toEqual([]);
      expect(f.harness.cp.review.latestPacket(runId, f.harness.cp.runs.currentCandidate(runId)!)).toBeNull();
      expect(auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId).map((row) => row.reasonCode)).toEqual([ReasonCode.EVIDENCE_MISSING]);
    }, harnessOptions);
  });
});

describe("a configured scope never reaches the fallback, whatever stops its reviewer (R1-01)", () => {
  const noFallback = (f: BootstrapRuntimeFixture, runId: string, claude: { asked: () => number }) => {
    expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    expect(claude.asked()).toBe(0);
    expect(auditOf(f, "BLIND_REVIEW_FALLBACK", runId)).toEqual([]);
    expect(auditOf(f, "BLIND_REVIEW_COMPLETED", runId)).toEqual([]);
  };

  it("(a) a broken configured override with an unavailable runtime probe stays unavailable", async () => {
    await withBootstrapRuntime(async (f) => {
      const adapter = codexAdapter({ codexHome: authenticatedHome(), reviewerCodexHome: "/invalid/configured/home" });
      expect(adapter.packetReviewerScope().state).toBe("OVERRIDE");
      const { isolated } = preferCodex(f, () => adapter);
      const claude = claudeReviewer(f, "PASS");
      const { runId, ownerSessionId } = await planned(f);
      vi.spyOn(f.gpt, "probeRuntime").mockResolvedValue("UNAVAILABLE");

      expect(await submitResult(f, runId, ownerSessionId)).toBe("REVIEW_UNAVAILABLE");
      expect(isolated).toEqual([]);
      noFallback(f, runId, claude);
    }, harnessOptions);
  });

  it("(b) an authenticated default home with exhausted quota still attempts its reviewer", async () => {
    await withBootstrapRuntime(async (f) => {
      const adapter = codexAdapter({ codexHome: authenticatedHome() });
      expect(adapter.packetReviewerScope().state).toBe("DEFAULT");
      stubCodex({ invocationExitCode: 1 });
      const { isolated } = preferCodex(f, () => adapter);
      const claude = claudeReviewer(f, "PASS");
      const { runId, ownerSessionId } = await planned(f);
      f.gpt.setCapacity({
        provider: "gpt", sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY", observedAt: f.harness.clock.nowIso(),
        source: "r1-01-witness",
        buckets: [{ id: "gpt-window", remainingPercent: 0, resetAt: null, capabilities: ["ceo", "cto", "blind-review", "worker"] }],
      });

      expect(await submitResult(f, runId, ownerSessionId)).toBe("REVIEW_UNAVAILABLE");
      expect(isolated).toHaveLength(1);
      noFallback(f, runId, claude);
    }, harnessOptions);
  });

  it("(c) a preferred reviewer whose BLIND_REVIEWER binding is refused stays unavailable", async () => {
    await withBootstrapRuntime(async (f) => {
      const adapter = codexAdapter({ codexHome: authenticatedHome() });
      const { isolated } = preferCodex(f, () => adapter);
      const calls = stubCodex({});
      const claude = claudeReviewer(f, "PASS");
      const { runId, ownerSessionId } = await planned(f);
      const bindings = f.harness.cp.bindings;
      const bind = bindings.bind.bind(bindings);
      let refused = 0;
      vi.spyOn(bindings, "bind").mockImplementation((input) => {
        // Only the preferred GPT reviewer's binding is refused; a Claude fallback could still bind.
        if (input.role !== Role.BLIND_REVIEWER || f.harness.cp.sessions.get(input.sessionId)?.provider !== "gpt") return bind(input);
        refused += 1;
        return deny(ReasonCode.CONFLICT, "witness: reviewer binding refused", {});
      });

      expect(await submitResult(f, runId, ownerSessionId)).toBe("REVIEW_UNAVAILABLE");
      expect(isolated).toHaveLength(1);
      expect(calls.map((call) => call.resume)).toEqual([false]);
      expect(refused).toBe(1);
      noFallback(f, runId, claude);
    }, harnessOptions);
  });
});

describe("a frozen result whose review was unavailable gets one official retry of the same candidate", () => {
  /**
   * The live shape: the owner submitted, the candidate froze, the review was unavailable as the
   * pre-fix reviewer path left it (no fallback tried), and the run is ACTIVE with nothing running.
   */
  const liveShape = async (f: BootstrapRuntimeFixture, options: Partial<Pick<ScriptedBootstrapOwner, "onRetry">> = {}) => {
    let deployed = false;
    // Before the deploy the gate had no scope to read, and the reviewer refused as it did live.
    preferCodex(f, () => codexAdapter({ codexHome: missingHome() }), () => deployed ? null : liveUnavailable(), () => deployed);
    const run = await planned(f, { onResult: "follow-prompt", ...options });
    expect(run.owner.results).toEqual([{ runId: run.runId, ok: true, stage: "REVIEW_UNAVAILABLE" }]);
    const unavailable = auditOf(f, "BLIND_REVIEW_UNAVAILABLE", run.runId);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.evidence).toMatchObject({ attempts: [] });
    const candidate = f.harness.cp.runs.currentCandidate(run.runId)!;
    expect(resultState(f, run.runId)).toEqual({ state: RunState.ACTIVE, candidate, attempts: ["RELEASED"] });
    // What the result-stage recovery reads as already submitted: before this change nothing re-entered.
    deployed = true;
    return { ...run, candidate, unavailableEventId: unavailable[0]!.eventId, before: nothingSynthesized(f, run.runId) };
  };

  it("wakes the owner once, its result_submit reviews the same candidate, and the run reaches CEO review with nothing synthesized", async () => {
    await withBootstrapRuntime(async (f) => {
      const claude = claudeReviewer(f, "PASS");
      const { owner, runId, ownerSessionId, roleKey, planDigest, candidate, unavailableEventId, before } = await liveShape(f);

      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({
        woken: [{ runId, roleKey, bindingGeneration: 1, planDigest, retry: { candidateSnapshotDigest: candidate, unavailableEventId } }],
      });
      await vi.waitFor(() => expect(owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      expect(owner.prompts.at(-1)).toContain(`The control plane woke you for: ${reviewRetryTriggerKind(runId)}.`);
      expect(owner.results.at(-1)).toEqual({ runId, ok: true, stage: "COMPLETED_REVIEW" });
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(claude.asked()).toBe(1);
      // The same frozen candidate, reviewed through the owner's own submission; nothing else moved.
      expect(new Set(frozenDigests(f, runId))).toEqual(new Set([candidate]));
      expect(f.harness.cp.runs.currentCandidate(runId)).toBe(candidate);
      expect(f.harness.cp.review.latestPacket(runId, candidate)).toMatchObject({ verdict: "PASS", provider: "claude" });
      expect(nothingSynthesized(f, runId)).toEqual(before);
      expect(before).toMatchObject({ plans: 1, executions: 0, workers: 0, tasks: ["READY"] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId).map((row) => row.evidence)).toEqual([expect.objectContaining({
        bindingGeneration: 1, planDigest, candidateSnapshotDigest: candidate, unavailableEventId,
      })]);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
    }, harnessOptions);
  });

  it("a second pass or a restart does not retry the same unavailable review again", async () => {
    await withBootstrapRuntime(async (f) => {
      claudeReviewer(f, "PASS");
      const { owner, runId, ownerSessionId, candidate } = await liveShape(f, { onRetry: "ignore" });
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2), { timeout: 10_000, interval: 25 });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      const daemon = await startDaemon(f, "restart");
      try {
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
      expect(owner.results).toHaveLength(1);
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(1);
      expect(resultState(f, runId)).toEqual({ state: RunState.ACTIVE, candidate, attempts: ["RELEASED"] });
    }, harnessOptions);
  });

  it("a retry whose own review is unavailable again is not retried in a loop", async () => {
    await withBootstrapRuntime(async (f) => {
      const claude = claudeReviewer(f, "NO_ANSWER");
      const { owner, runId, ownerSessionId } = await liveShape(f);
      expect(f.daemon.wakeBootstrapResultRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(owner.results).toHaveLength(2), { timeout: 10_000, interval: 25 });
      expect(owner.results.at(-1)).toMatchObject({ stage: "REVIEW_UNAVAILABLE" });
      expect(claude.asked()).toBe(1);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(auditOf(f, "BLIND_REVIEW_UNAVAILABLE", runId)).toHaveLength(2);
      expect(f.daemon.wakeBootstrapResultRecovery()).toEqual({ woken: [] });
      expect(auditOf(f, BOOTSTRAP_REVIEW_RETRY_WAKE, runId)).toHaveLength(1);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    }, harnessOptions);
  });
});
