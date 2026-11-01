import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig, readProjectReviewerFile } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role } from "../../src/domain/types.ts";
import {
  BlindReviewGate,
  REVIEWER_FALLBACK_SCOPE_UNCONFIGURED,
  resolveProjectReviewerPreferences,
  type ReviewerPreference,
} from "../../src/review/blind-review.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

/**
 * CEO msg_e91da929 (2026-10-31): a project the daemon's state file names gets that reviewer as its
 * preferred Blind Reviewer, with no fallback. Every other project keeps the global preference and its
 * fallbacks. A file that cannot be applied whole applies nothing and says so.
 */

afterAll(cleanupTempDirs);

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

const OPUS: ReviewerPreference = { provider: "claude", model: "opus", effort: null };

const persistPassingVerification = (
  harness: ReturnType<typeof makeHarness>,
  run: { runId: string; contractDigest: string },
  snapshot: CandidateSnapshot,
): VerificationReport => {
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  const repository = snapshot.repositories[0]!;
  const now = harness.clock.nowIso();
  const report: VerificationReport = {
    runId: run.runId,
    candidateSnapshotDigest: snapshotDigest,
    contractDigest: run.contractDigest,
    expectedInputs: 1,
    observedInputs: 1,
    results: [{
      commandId: "verify", repositoryIdentity: repository.identity, source: "local", exactHead: repository.candidateHead,
      startedAt: now, endedAt: now, exitCode: 0, outputDigest: "sha256:test-verification-output", outputTruncated: false,
      status: "PASS", reasonCode: null,
    }],
    status: "PASS",
    reasonCode: ReasonCode.OK,
    gaps: [],
  };
  harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().VERIFICATION, run.runId, "VERIFICATION", report, snapshotDigest);
  harness.cp.db.run(
    `INSERT OR REPLACE INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${snapshotDigest}:verify:${repository.identity}:local`, run.runId, snapshotDigest, "verify", repository.identity,
      "local", repository.candidateHead, now, now, 0, "sha256:test-verification-output", 0, "PASS", null,
    ],
  );
  return report;
};

/** A frozen, verified candidate on a project run whose worker is a Claude session. */
const prepared = async () => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const workerSessionId = bindWorker(harness, task.taskId, { provider: "claude", model: "opus" });
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId, taskId: task.taskId, ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId,
    provider: "claude", model: "opus", repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await harness.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const verification = persistPassingVerification(harness, run, frozen.value);

  const gpt = new TestProductionAdapter(harness.clock, "gpt");
  const claude = new TestProductionAdapter(harness.clock, "claude");
  for (const adapter of [gpt, claude]) {
    adapter.script({ match: /Candidate review/, text: reviewerPass([`${identity}:src/app.js`]) });
    harness.cp.providers.registerForRole(adapter, Role.BLIND_REVIEWER);
  }
  return { harness, projectId, identity, run, snapshot: frozen.value, verification, workerSessionId, gpt, claude };
};

type Prepared = Awaited<ReturnType<typeof prepared>>;

/** The production default (gpt-6.1-sol preferred, Claude Opus fallback) plus the given project entries. */
const gateFor = (setup: Prepared, projects: Record<string, ReviewerPreference>) => {
  const cp = setup.harness.cp;
  return new BlindReviewGate(
    cp.clock, cp.db, cp.audit, cp.artifacts, cp.evidenceWritersForTests().BLIND_REVIEW, cp.sessions, cp.bindings,
    cp.providers, cp.repositories, cp.telemetry,
    {
      preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" },
      fallbacks: [{ provider: "claude", model: "opus", effort: null }],
      projects: new Map(Object.entries(projects)),
    },
  );
};

const review = (gate: BlindReviewGate, setup: Prepared) => gate.controlPlaneInvoker()({
  runId: setup.run.runId,
  projectId: setup.projectId,
  executionMode: setup.run.executionMode,
  snapshot: setup.snapshot,
  contract: CONTRACT,
  contractDigest: setup.run.contractDigest,
  verification: setup.verification,
});

const reviewerMode = (setup: Prepared, sessionId: string) =>
  setup.harness.cp.db.get<{ mode: string }>(`SELECT mode FROM assignments WHERE session_id = ?`, [sessionId])?.mode;

const completed = (setup: Prepared) =>
  setup.harness.cp.audit.byKind("BLIND_REVIEW_COMPLETED").filter((row) => row.runId === setup.run.runId);

describe("a project's own Blind Reviewer", () => {
  it("1: a project with an entry gets Claude Opus as its PREFERRED reviewer, and the completion receipt names the project preference", async () => {
    const setup = await prepared();
    try {
      const result = await review(gateFor(setup, { [setup.projectId]: OPUS }), setup);

      expect(result.allowed, JSON.stringify(result)).toBe(true);
      if (!result.allowed) return;
      expect(result.value).toMatchObject({ provider: "claude", model: "opus", effort: null });
      expect(setup.gpt.invocations).toHaveLength(0);
      expect(reviewerMode(setup, result.value.reviewerSessionId)).toBe("PREFERRED");
      expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
      expect(completed(setup)).toEqual([expect.objectContaining({
        sessionId: result.value.reviewerSessionId,
        evidence: expect.objectContaining({
          provider: "claude", model: "opus", reviewerSource: "PROJECT_PREFERENCE", projectId: setup.projectId,
        }),
      })]);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("2 (control): a project without an entry keeps gpt-6.1-sol preferred and its Claude fallback, unchanged", async () => {
    const setup = await prepared();
    try {
      const gate = gateFor(setup, { "some-other-project": OPUS });
      const preferred = await review(gate, setup);
      expect(preferred.allowed, JSON.stringify(preferred)).toBe(true);
      if (!preferred.allowed) return;
      expect(preferred.value).toMatchObject({ provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" });
      expect(setup.claude.invocations).toHaveLength(0);
      expect(completed(setup)[0]?.evidence).not.toHaveProperty("reviewerSource");

      // The global fallback still applies on exactly its one condition.
      gate.attach({ packetReviewerScope: (provider) => provider === "gpt" ? { state: "UNCONFIGURED", root: "/fixture/no-codex-home" } : null });
      const fallback = await review(gate, setup);
      expect(fallback.allowed, JSON.stringify(fallback)).toBe(true);
      if (!fallback.allowed) return;
      expect(fallback.value.provider).toBe("claude");
      expect(reviewerMode(setup, fallback.value.reviewerSessionId)).toBe("FALLBACK");
      expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toEqual([expect.objectContaining({
        runId: setup.run.runId,
        evidence: expect.objectContaining({ from: "gpt", provider: "claude", reason: REVIEWER_FALLBACK_SCOPE_UNCONFIGURED }),
      })]);
      expect(completed(setup)[1]?.evidence).not.toHaveProperty("reviewerSource");
    } finally {
      setup.harness.cp.close();
    }
  });

  it("3: a capacity refusal on the project's Claude reviewer ends selection, with no fallback to gpt", async () => {
    const setup = await prepared();
    try {
      const gate = gateFor(setup, { [setup.projectId]: OPUS });
      const admitted: string[] = [];
      gate.attach({
        capacity: {
          refreshForBlindReview: async (target) => {
            admitted.push(target?.provider ?? "none");
            return target?.provider === "claude"
              ? deny(ReasonCode.CAPACITY_ADMISSION_SUSPENDED, "claude reviewer capacity exhausted", {})
              : allow(ReasonCode.OK, undefined);
          },
        },
      });
      const gptStart = vi.spyOn(setup.gpt, "startSession");

      const result = await review(gate, setup);

      expect(result).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.CAPACITY_ADMISSION_SUSPENDED,
        evidence: { reviewerSource: "PROJECT_PREFERENCE", projectId: setup.projectId },
      });
      expect(admitted).toEqual(["claude"]);
      expect(gptStart).not.toHaveBeenCalled();
      expect(setup.gpt.invocations).toHaveLength(0);
      expect(setup.claude.invocations).toHaveLength(0);
      expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
      expect(completed(setup)).toHaveLength(0);
    } finally {
      setup.harness.cp.close();
    }
  });

  it("5: the project's Claude reviewer is a session distinct from the run's Claude producer", async () => {
    const setup = await prepared();
    try {
      const result = await review(gateFor(setup, { [setup.projectId]: OPUS }), setup);
      expect(result.allowed, JSON.stringify(result)).toBe(true);
      if (!result.allowed) return;
      const { cp } = setup.harness;
      const reviewer = cp.sessions.get(result.value.reviewerSessionId)!;
      const producer = cp.sessions.get(setup.workerSessionId)!;

      expect(reviewer.provider).toBe("claude");
      expect(producer.provider).toBe("claude");
      expect(reviewer.sessionId).not.toBe(producer.sessionId);
      expect(reviewer.incarnation).not.toBe(producer.incarnation);
      expect(cp.bindings.assertReviewerIndependence(setup.run.runId, reviewer.sessionId).allowed).toBe(true);
      // The same check refuses the producer, so a reused producer session could not stand in for the reviewer.
      expect(cp.bindings.assertReviewerIndependence(setup.run.runId, producer.sessionId)).toMatchObject({ allowed: false });
    } finally {
      setup.harness.cp.close();
    }
  });
});

describe("the daemon's reviewer preference file", () => {
  const registered = (provider: string) => provider === "claude" || provider === "gpt";

  it("is read from <stateDir>/reviewer-preferences.json; a missing file means no project preferences", () => {
    const root = tempDir("acp-reviewer-pref-root-");
    expect(defaultConfig(root).reviewerPreferencesFile).toEqual({ path: join(root, "reviewer-preferences.json"), text: null });
    expect(resolveProjectReviewerPreferences(defaultConfig(root).reviewerPreferencesFile!, registered))
      .toEqual({ byProject: new Map(), refused: null });

    writeFileSync(join(root, "reviewer-preferences.json"), JSON.stringify({ "e2e-1": OPUS }));
    expect(resolveProjectReviewerPreferences(defaultConfig(root).reviewerPreferencesFile!, registered))
      .toEqual({ byProject: new Map([["e2e-1", OPUS]]), refused: null });
  });

  it.each([
    ["not JSON", "{ e2e-1: claude"],
    ["not an object of entries", JSON.stringify([OPUS])],
    ["an entry missing its effort", JSON.stringify({ "e2e-1": { provider: "claude", model: "opus" } })],
    ["an entry with an extra key", JSON.stringify({ "e2e-1": { ...OPUS, fallbacks: [] } })],
    ["an unknown provider beside a valid entry", JSON.stringify({ "e2e-1": OPUS, "e2e-2": { provider: "nonesuch", model: "x", effort: null } })],
  ])("4: %s applies nothing and names why", (_label, text) => {
    const resolved = resolveProjectReviewerPreferences({ path: "/state/reviewer-preferences.json", text }, registered);
    expect(resolved.byProject.size).toBe(0);
    expect(resolved.refused).toMatchObject({ path: "/state/reviewer-preferences.json", reason: expect.any(String) });
  });

  it("4: a file that exists but cannot be read applies nothing and names why", () => {
    expect(resolveProjectReviewerPreferences({ path: "/state/reviewer-preferences.json", text: null, unreadable: "EACCES" }, registered))
      .toEqual({ byProject: new Map(), refused: { path: "/state/reviewer-preferences.json", reason: "unreadable: EACCES" } });
  });

  it("4: a control plane given an unregistered provider applies nothing, audits the refusal and reports a doctor finding", () => {
    const root = tempDir("acp-reviewer-pref-cp-");
    const file = join(root, "reviewer-preferences.json");
    writeFileSync(file, JSON.stringify({ "e2e-1": OPUS, "e2e-2": { provider: "grok", model: "grok-5", effort: null } }));
    const clock = new ManualClock("2026-11-01T00:00:00.000Z");
    const open = () => new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock,
      adapters: [new TestProductionAdapter(clock, "gpt"), new TestProductionAdapter(clock, "claude")],
      allowNonProductionAdapters: true,
      reviewerPreferencesFile: readProjectReviewerFile(file),
    });

    const refused = open();
    try {
      // The default applies: no project entry, the global preferred and fallbacks as they were.
      const preferences = refused.review["preferences"];
      expect(preferences.projects?.size ?? 0).toBe(0);
      expect(preferences.preferred).toEqual({ provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" });
      expect(refused.audit.byKind("REVIEWER_PREFERENCES_REFUSED")).toEqual([expect.objectContaining({
        reasonCode: ReasonCode.REVIEWER_PREFERENCES_INVALID,
        evidence: expect.objectContaining({ path: file, reason: expect.stringContaining("grok") }),
      })]);
      expect(refused.doctor["checkReviewerPreferences"]()).toEqual([expect.objectContaining({
        code: ReasonCode.REVIEWER_PREFERENCES_INVALID,
        severity: "ERROR",
        observedEvidence: expect.objectContaining({ path: file }),
      })]);
    } finally {
      refused.close();
    }

    writeFileSync(file, JSON.stringify({ "e2e-1": OPUS }));
    const applied = open();
    try {
      expect(applied.review["preferences"].projects).toEqual(new Map([["e2e-1", OPUS]]));
      expect(applied.audit.byKind("REVIEWER_PREFERENCES_REFUSED")).toHaveLength(1);
      expect(applied.doctor["checkReviewerPreferences"]()).toEqual([]);
    } finally {
      applied.close();
    }
  });
});
