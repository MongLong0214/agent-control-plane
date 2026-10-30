import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { currentBootstrapPlan } from "../../src/bootstrap/bootstrap-plan.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { routeOwnerlessStalls } from "../../src/ceo/ownerless-stalls.ts";
import { resumeRetirements, retireProject } from "../../src/registry/project-retirement.ts";
import { bootstrapPlan, cleanTreeManifest, reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { dispatchRun, normalized } from "../helpers/contract-change.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  bindCeo,
  carryContractChange,
  dispatchBootstrapRun,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1189, CEO ruling 5 and the ruling on post-merge follow-ups — a stall nothing in the system moves on its own is
 * routed to the CEO through the existing CRITICAL_SYSTEM_FAILURE notification, once per stall, with its
 * owner, its concrete blocker and the recovery action the CEO owns. Merged facts are never changed: no
 * re-merge, no revert, and a merge is never turned into a failure.
 *
 * The module under test is imported dynamically where it is called directly, so the daemon-level cases run,
 * and fail on their assertions, against a tree that predates it.
 */

const CRITICAL = "CRITICAL_SYSTEM_FAILURE";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Notice {
  messageId: string;
  status: string;
  roleKey: string;
  targetSessionId: string;
  payload: Record<string, unknown>;
}

/** Every CRITICAL_SYSTEM_FAILURE the outbox holds for this run, in any status. */
const criticalNotices = (h: Harness, runId: string): Notice[] =>
  h.cp.db
    .all<{ message_id: string; status: string; role_key: string; target_session_id: string; payload_json: string }>(
      `SELECT message_id, status, role_key, target_session_id, payload_json FROM outbox
        WHERE kind = 'CEO_NOTIFICATION' AND run_id = ? ORDER BY created_at, message_id`,
      [runId],
    )
    .map((row) => ({
      messageId: row.message_id,
      status: row.status,
      roleKey: row.role_key,
      targetSessionId: row.target_session_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }))
    .filter((notice) => notice.payload["notification"] === CRITICAL);

/** The delivery records of this run's CRITICAL_SYSTEM_FAILURE notices (a stall's is OWNERLESS_STALL_ROUTED). */
const criticalAudits = (h: Harness, runId: string) =>
  h.cp.audit
    .forRun(runId)
    .filter((entry) => (entry.kind === "OWNERLESS_STALL_ROUTED" || entry.kind.startsWith("CEO_NOTIFICATION")) &&
      entry.evidence["notification"] === CRITICAL);

/** Waits for `count` more watchdog passes; a new pass starts only once the previous one has finished. */
const ticker = (h: Harness) => {
  const tick = vi.spyOn(h.cp.watchdog, "tick");
  return async (count: number): Promise<void> => {
    const target = tick.mock.calls.length + count;
    const deadline = Date.now() + 10_000;
    while (tick.mock.calls.length < target && Date.now() < deadline) await delay(20);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(target);
  };
};

/** GitHub's merged pull retains its base snapshot; the target ref is reread separately. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") return response;
    const merged = response as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return response;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return response;
  };
};

/** A CEO-confirmed run whose one merge lands and whose declared post-merge check then fails (or passes). */
const confirmedRun = async (options: { noChecks?: boolean } = {}) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/stall-routing",
    manifestOverrides: {
      ciWorkflows: options.noChecks ? [] : [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = options.noChecks ? null : ({ mergeSha }) => github.setPostMergeCheck(mergeSha, "project-ci", "failure");
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await harness.cp.continuity.evaluate("stall routing packet");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "candidate verified",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId: driven.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    ceoSessionId: ceo.sessionId,
    rationale: "exact packet accepted",
  });
  if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);
  return { github, harness, driven };
};

/** What a merge left behind: the run, its finalization attempt, its GitHub receipts and its merge states. */
const mergedFacts = (h: Harness, runId: string) => {
  const run = h.cp.runs.require(runId);
  return {
    run: { state: run.state, stateReason: run.stateReason, endedAt: run.endedAt },
    attempt: h.cp.db.get(
      `SELECT attempt_id, candidate_digest, state, last_step, failure_reason, compensation_plan_json, completed_at
         FROM finalization_attempts WHERE run_id = ?`,
      [runId],
    ),
    receipts: h.cp.db.all(
      `SELECT receipt_id, operation, repository_identity, status, verified, response_json
         FROM github_receipts WHERE run_id = ? ORDER BY receipt_id`,
      [runId],
    ),
    repositories: h.cp.db.all(`SELECT * FROM run_repositories WHERE run_id = ? ORDER BY 1, 2`, [runId]),
    transitions: h.cp.audit
      .forRun(runId)
      .filter((entry) => entry.kind === "RUN_TRANSITION")
      .map((entry) => `${String(entry.evidence["from"])}->${String(entry.evidence["to"])}`),
  };
};

describe("a merge whose post-merge verification failed reaches the CEO", () => {
  it("is routed once as CRITICAL_SYSTEM_FAILURE with the merged commit, the failed check, the kept effects and the CEO's action, and the merge stays as it is across passes, an ACK and a restart", async () => {
    const { github, harness, driven } = await confirmedRun();
    const ticks = ticker(harness);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-stall-post-merge-"), watchdogIntervalMs: 25 });
    let facts: ReturnType<typeof mergedFacts>;
    let notice: Notice;
    try {
      expect((await daemon.start()).allowed).toBe(true);
      facts = mergedFacts(harness, driven.runId);
      // The merge happened and its check failed: terminal BLOCKED_POST_MERGE, the merge kept, nothing reverted.
      expect(facts.run.state).toBe(RunState.BLOCKED_POST_MERGE);
      expect(facts.attempt).toMatchObject({ state: "BLOCKED", failure_reason: ReasonCode.POST_MERGE_VERIFICATION_FAILED });
      expect(facts.receipts.filter((receipt) => (receipt as { operation: string }).operation === "merge_execute"))
        .toEqual([expect.objectContaining({ status: "APPLIED", verified: 1 })]);
      expect(facts.transitions.filter((edge) => edge.startsWith(`${RunState.BLOCKED_POST_MERGE}->`))).toEqual([]);
      expect(github.mergeCount).toBe(1);

      const notices = criticalNotices(harness, driven.runId);
      expect(notices).toHaveLength(1);
      notice = notices[0]!;
      expect(notice).toMatchObject({ roleKey: "CEO", targetSessionId: harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId });
      expect(notice.payload).toMatchObject({
        notification: CRITICAL,
        runId: driven.runId,
        stall: "BLOCKED_POST_MERGE",
        owner: "CEO",
        projectId: driven.projectId,
        state: RunState.BLOCKED_POST_MERGE,
        failureReasonCode: ReasonCode.POST_MERGE_VERIFICATION_FAILED,
        repositories: [{ repositoryIdentity: driven.identity, mergeCommitSha: driven.candidateHead, status: "APPLIED", verified: true }],
        failedChecks: [{ repositoryIdentity: driven.identity, mergeCommitSha: driven.candidateHead, name: "project-ci", conclusion: "failure" }],
        compensation: [expect.objectContaining({
          repositoryIdentity: driven.identity,
          mergeCommitSha: driven.candidateHead,
          requiredAction: "halt and review rollback plan",
        })],
      });
      expect(notice.payload["reason"]).toEqual(expect.stringContaining("terminal in BLOCKED_POST_MERGE"));
      expect(notice.payload["action"]).toEqual(expect.stringContaining("run_create"));
      expect(notice.payload["detail"]).toEqual(expect.stringContaining("the merge commits stay merged"));
      // The owner, the recovery action and the blocker are recorded, not only sent.
      expect(criticalAudits(harness, driven.runId)).toEqual([expect.objectContaining({
        kind: "OWNERLESS_STALL_ROUTED",
        evidence: expect.objectContaining({
          stall: "BLOCKED_POST_MERGE",
          owner: "CEO",
          reason: notice.payload["reason"],
          action: notice.payload["action"],
          repositories: notice.payload["repositories"],
        }),
      })]);

      // Later passes find the same block and send nothing more; an undelivered notice is not a failure.
      await ticks(3);
      expect(criticalNotices(harness, driven.runId)).toEqual([notice]);
      expect(criticalAudits(harness, driven.runId)).toHaveLength(1);
      expect(mergedFacts(harness, driven.runId)).toEqual(facts);

      // A prior ACK neither ends the notice nor sends it again.
      harness.cp.db.run(`UPDATE outbox SET status = 'ACKED' WHERE message_id = ?`, [notice.messageId]);
      await ticks(2);
      expect(criticalNotices(harness, driven.runId)).toEqual([{ ...notice, status: "ACKED" }]);
    } finally {
      await daemon.stop();
    }

    const restarted = new Daemon(harness.cp, { stateDir: tempDir("acp-stall-post-merge-restart-") });
    try {
      expect((await restarted.start()).allowed).toBe(true);
      expect(criticalNotices(harness, driven.runId)).toEqual([{ ...notice, status: "ACKED" }]);
      expect(criticalAudits(harness, driven.runId)).toHaveLength(1);
      expect(mergedFacts(harness, driven.runId)).toEqual(facts);
      expect(github.mergeCount).toBe(1);
    } finally {
      await restarted.stop();
    }
  });

  it("with no CEO to hold it nothing is queued or recorded, and the first pass once a CEO is bound routes it, once", async () => {
    const { routePostMergeStall } = await import("../../src/ceo/ownerless-stalls.ts");
    const { harness, driven } = await confirmedRun();
    const blocked = await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId);
    expect(blocked.reasonCode).toBe(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED);
    const facts = mergedFacts(harness, driven.runId);
    expect(facts.run.state).toBe(RunState.BLOCKED_POST_MERGE);

    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO replaced").allowed).toBe(true);
    const audit = harness.cp.audit.forRun(driven.runId).length;
    expect(routePostMergeStall(harness.cp, driven.runId)).toMatchObject({ allowed: false });
    expect(criticalNotices(harness, driven.runId)).toEqual([]);
    expect(harness.cp.audit.forRun(driven.runId)).toHaveLength(audit);

    const ceoSessionId = bindCeo(harness);
    expect(routePostMergeStall(harness.cp, driven.runId)).toMatchObject({ allowed: true, value: { created: true } });
    expect(routePostMergeStall(harness.cp, driven.runId)).toMatchObject({ allowed: true, value: { created: false } });
    expect(criticalNotices(harness, driven.runId)).toEqual([expect.objectContaining({ targetSessionId: ceoSessionId })]);
    expect(mergedFacts(harness, driven.runId)).toEqual(facts);
  });

  it("a historical block the daemon resumes is completed, not routed", async () => {
    const { harness, driven } = await confirmedRun({ noChecks: true });
    const verifier = vi.spyOn(harness.cp.github, "postMergeVerify").mockResolvedValueOnce({
      allowed: false, reasonCode: ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED,
      message: "the pinned manifest declares no post-merge checks", evidence: {},
    });
    await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId);
    verifier.mockRestore();
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-stall-resumable-") });
    try {
      expect((await daemon.start()).allowed).toBe(true);
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
      expect(criticalNotices(harness, driven.runId)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });
});

describe("an owner retirement held by a terminal BLOCKED_POST_MERGE run", () => {
  it("names the run it waits on, is routed to the CEO once, stays refused, and changes nothing merged", async () => {
    const { github, harness, driven } = await confirmedRun();
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-stall-retirement-") });
    try {
      expect((await daemon.start()).allowed).toBe(true);
      const facts = mergedFacts(harness, driven.runId);
      expect(facts.run.state).toBe(RunState.BLOCKED_POST_MERGE);
      const held = () => criticalNotices(harness, driven.runId).filter((notice) => notice.payload["stall"] === "PROJECT_RETIREMENT_HELD");

      for (const reason of ["retire the project", "retire the project again"]) {
        expect(await retireProject(harness.cp, driven.projectId, reason)).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CONFLICT,
          evidence: { projectId: driven.projectId, waitingOn: [{ runId: driven.runId, state: RunState.BLOCKED_POST_MERGE }] },
        });
        expect(held()).toHaveLength(1);
      }
      expect(held()[0]!.payload).toMatchObject({ owner: "CEO", projectId: driven.projectId, state: RunState.BLOCKED_POST_MERGE });
      expect(held()[0]!.payload["action"]).toEqual(expect.stringContaining("none within existing authority"));
      expect(held()[0]!.payload["needsTransition"]).toEqual(expect.stringMatching(/settled for retirement \(pending\)$/));
      expect(mergedFacts(harness, driven.runId)).toEqual(facts);
      expect(github.mergeCount).toBe(1);
      expect(harness.cp.projects.get(driven.projectId)?.retiredAt ?? null).toBeNull();
    } finally {
      await daemon.stop();
    }
  });

  it("requested before the run's own stall is routed, the refusal delivers the notice, whose text states what the refusal left: nothing suspended, nothing pending, nothing retried", async () => {
    const { routePostMergeStall } = await import("../../src/ceo/ownerless-stalls.ts");
    const { github, harness, driven } = await confirmedRun();
    const blocked = await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId);
    expect(blocked.reasonCode).toBe(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED);
    const facts = mergedFacts(harness, driven.runId);
    expect(facts.run.state).toBe(RunState.BLOCKED_POST_MERGE);
    // The run's own stall is not routed yet: no notice of any kind for it.
    expect(criticalNotices(harness, driven.runId)).toEqual([]);
    const held = () => criticalNotices(harness, driven.runId).filter((notice) => notice.payload["stall"] === "PROJECT_RETIREMENT_HELD");
    /** What a refused retirement leaves: no suspension, no pending retirement, no intent for a sweep to resume. */
    const left = () => ({
      suspended: harness.cp.projects.get(driven.projectId)?.suspended,
      pending: harness.cp.db.all(`SELECT project_id FROM project_retirements WHERE project_id = ?`, [driven.projectId]),
      intents: harness.cp.db.all(`SELECT kind FROM audit_events WHERE kind = 'PROJECT_RETIREMENT_INTENT' AND project_id = ?`, [driven.projectId]),
    });
    const nothingLeft = { suspended: false, pending: [], intents: [] };

    expect(await retireProject(harness.cp, driven.projectId, "retire the project")).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CONFLICT,
      evidence: { projectId: driven.projectId, waitingOn: [{ runId: driven.runId, state: RunState.BLOCKED_POST_MERGE }] },
    });
    expect(left()).toEqual(nothingLeft);
    expect(held()).toHaveLength(1);
    const payload = held()[0]!.payload;
    expect(payload).toMatchObject({ owner: "CEO", projectId: driven.projectId, state: RunState.BLOCKED_POST_MERGE });
    expect(payload["action"]).toEqual(expect.stringContaining("none within existing authority"));
    expect(payload["needsTransition"]).toEqual(expect.stringMatching(/settled for retirement \(pending\)$/));
    // The text states the refusal as it is: refused, nothing changed, not suspended, no request pending, ask again.
    const said = [payload["reason"], payload["action"], payload["needsTransition"]].join(" ");
    expect(said).toEqual(expect.stringContaining("refused and nothing was changed"));
    expect(said).toEqual(expect.stringContaining("the project is not suspended and no retirement request is pending"));
    expect(said).toEqual(expect.stringContaining("requested again once this transition exists"));
    expect(said).not.toMatch(/stays suspended|stays pending|every daemon pass/);

    // The stall routed later and the daemon's sweep: nothing retries the refused retirement, and nothing is sent twice.
    expect(routePostMergeStall(harness.cp, driven.runId)).toMatchObject({ allowed: true, value: { created: true } });
    await resumeRetirements(harness.cp);
    expect(held()).toHaveLength(1);
    expect(left()).toEqual(nothingLeft);
    expect(mergedFacts(harness, driven.runId)).toEqual(facts);
    expect(github.mergeCount).toBe(1);
  });
});

describe("a stranded bootstrap application reaches the CEO", () => {
  const strandedBootstrap = async () => {
    const h = makeHarness();
    h.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: {
      goal: "bootstrap", why: "stall routing", scope: [], nonGoals: [], acceptance: ["verify"], priority: "NORMAL", humanGate: [], references: [],
    } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    const { planDigest } = await reviewBootstrapPlan(h, runId, bootstrapPlan(cleanTreeManifest("prj_stranded")));
    const plan = currentBootstrapPlan(runId, h.cp.artifacts.latest(runId, "PLAN"));
    if (!plan.allowed) throw new Error(plan.message);
    expect(h.cp.bootstrapApplications.reserve({
      runId, projectId: "prj_stranded", repositoryIdentity: "github:acme/stranded",
      bootstrapOperationId: "op-bootstrap", planDigest,
      manifestDigest: plan.value.binding.projectManifestDigest, plannedOutputsDigest: plan.value.binding.plannedOutputsDigest,
      candidateSnapshotDigest: h.cp.runs.currentCandidate(runId)!, reviewDigest: "sha256:review", approvalDigest: "sha256:scope",
    }, { writer: null }).allowed).toBe(true);
    expect(h.cp.bootstrapApplications.markStranded(runId, {
      cause: "ATTRIBUTION_UNCERTAIN", requiredRecovery: "recorded recovery", evidence: { ledger: "attempt-ledger" },
    }).allowed).toBe(true);
    return { h, runId };
  };

  it("is routed once with its blocker and the CEO's action, and its reservation and run stay as recorded", async () => {
    const { h, runId } = await strandedBootstrap();
    const kept = () => ({
      state: h.cp.runs.require(runId).state,
      application: h.cp.bootstrapApplications.get(runId),
      held: h.cp.db.all(`SELECT run_id, phase FROM bootstrap_applications WHERE run_id = ?`, [runId]),
    });
    const before = kept();
    expect(before).toMatchObject({ state: RunState.READY_FOR_CEO_REVIEW, application: { phase: "STRANDED" } });
    const ticks = ticker(h);
    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-stall-stranded-"), watchdogIntervalMs: 25 });
    try {
      const started = await daemon.start();
      expect(started.allowed, JSON.stringify(started)).toBe(true);
      await ticks(3);
      const notices = criticalNotices(h, runId);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.payload).toMatchObject({
        stall: "BOOTSTRAP_APPLICATION_STRANDED",
        owner: "CEO",
        projectId: "prj_stranded",
        repositoryIdentity: "github:acme/stranded",
        state: RunState.READY_FOR_CEO_REVIEW,
        cause: "ATTRIBUTION_UNCERTAIN",
        attempts: 1,
      });
      expect(notices[0]!.payload["reason"]).toEqual(expect.stringContaining("cannot be attributed to this run"));
      expect(notices[0]!.payload["action"]).toEqual(expect.stringContaining("new project id and repository identity"));
      expect(notices[0]!.payload["detail"]).toEqual(expect.stringContaining("never released"));
      expect(kept()).toEqual(before);
    } finally {
      await daemon.stop();
    }
  });
});

describe("a CONTRACT_CHANGE run the activation path cannot finish reaches the CEO", () => {
  const readyContractChange = async (h: Harness, projectId: string) => {
    const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    carryContractChange(h, run.runId, normalized({ ...run.base, commitlore: { mode: "required" } } as ProjectManifest));
    await h.cp.continuity.evaluate("contract change candidate");
    const submitted = await h.cp.pipeline.submitResult({
      runId: run.runId,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      resultSummary: "the proposed manifest",
      recommendation: "activate the contract change",
      residualRisk: [],
    });
    if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
    return { run, candidate: h.cp.runs.currentCandidate(run.runId)! };
  };

  it("a run confirmed without a grant is routed once with an action its state allows, stays as recorded, and the doctor names the CEO", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "cc-stall");
    const { run, candidate } = await readyContractChange(h, projectId);
    // What a run confirmed before grants existed looks like: CEO_APPROVED, with no grant.
    expect(h.cp.runs.transition(run.runId, RunState.CEO_APPROVED, "confirmed before grants", { candidateSnapshotDigest: candidate }).allowed).toBe(true);
    const artifacts = h.cp.artifacts.list(run.runId).length;
    for (const prefix of ["acp-stall-cc-", "acp-stall-cc-restart-"]) {
      const daemon = new Daemon(h.cp, { stateDir: tempDir(prefix) });
      try {
        const started = await daemon.start();
        expect(started.allowed, JSON.stringify(started)).toBe(true);
      } finally {
        await daemon.stop();
      }
      const notices = criticalNotices(h, run.runId);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.payload).toMatchObject({
        stall: "CONTRACT_CHANGE_RUN_WITHOUT_GRANT",
        owner: "CEO",
        projectId,
        state: RunState.CEO_APPROVED,
        cause: "CONFIRMED_WITHOUT_GRANT",
      });
      expect(notices[0]!.payload["action"]).toEqual(expect.stringContaining("cancel it with run_cancel"));
    }
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.CEO_APPROVED);
    expect(h.cp.artifacts.list(run.runId)).toHaveLength(artifacts);
    const finding = (await h.cp.doctor.run("run", run.runId)).findings.find((entry) => entry.code === "CONTRACT_CHANGE_RUN_WITHOUT_GRANT");
    expect(finding?.recommendedAction).toEqual(expect.stringContaining("the CEO, notified with CRITICAL_SYSTEM_FAILURE"));
    expect(finding?.recommendedAction).not.toEqual(expect.stringContaining("the CTO cancels it"));
  });

  it("an ACTIVE run whose PLAN carries no manifest is routed with run_cancel or a new PLAN from its CTO", async () => {
    const { routeOwnerlessStalls } = await import("../../src/ceo/ownerless-stalls.ts");
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "cc-no-manifest");
    const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    h.cp.artifacts.put(run.runId, "PLAN", { tasks: [] });
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
    routeOwnerlessStalls(h.cp);
    routeOwnerlessStalls(h.cp);
    const notices = criticalNotices(h, run.runId);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ stall: "CONTRACT_CHANGE_RUN_WITHOUT_GRANT", cause: "PLAN_CARRIES_NO_MANIFEST", state: RunState.ACTIVE });
    expect(notices[0]!.payload["action"]).toEqual(expect.stringContaining("run_cancel"));
    expect(notices[0]!.payload["action"]).toEqual(expect.stringContaining("its CTO submit a PLAN carrying the manifest"));
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });
});

/** The CEO role recovered onto a new runtime: the old binding revoked, a new session bound. */
const replaceCeo = (h: Harness): string => {
  expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
  return bindCeo(h);
};

/** A CONTRACT_CHANGE run whose latest PLAN carries no manifest, in a project registered on first use: a stall nothing moves. */
const manifestlessContractChange = async (h: Harness, projectId: string) => {
  if (!h.cp.projects.get(projectId)) await registerFixtureProject(h, projectId);
  const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
  h.cp.artifacts.put(run.runId, "PLAN", { tasks: [] });
  return run;
};

describe("round 2, item 1 — an ACK is not a resolution: an unresolved incident reaches a replacement CEO once", () => {
  it("a CEO replacement with the post-merge block unresolved: exactly one re-delivery, to the new CEO, under the same correlation; more passes and a restart add none", async () => {
    const { github, harness, driven } = await confirmedRun();
    const ticks = ticker(harness);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-incident-redelivery-"), watchdogIntervalMs: 25 });
    let facts: ReturnType<typeof mergedFacts>;
    let first: Notice;
    let second: Notice;
    try {
      expect((await daemon.start()).allowed).toBe(true);
      facts = mergedFacts(harness, driven.runId);
      expect(facts.run.state).toBe(RunState.BLOCKED_POST_MERGE);
      [first] = criticalNotices(harness, driven.runId) as [Notice];
      expect(first.payload).toMatchObject({ stall: "BLOCKED_POST_MERGE" });
      const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(harness.cp.outbox.acknowledge(first.messageId, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
      await ticks(2);
      // The CEO that ACKed it is not told again.
      expect(criticalNotices(harness, driven.runId)).toEqual([{ ...first, status: "ACKED" }]);

      const replacement = replaceCeo(harness);
      await ticks(3);
      const notices = criticalNotices(harness, driven.runId);
      expect(notices).toHaveLength(2);
      // Rows written at one clock instant come back in either order: the re-delivery is the other one.
      second = notices.find((notice) => notice.messageId !== first.messageId)!;
      expect(second).toMatchObject({ targetSessionId: replacement, status: "PENDING" });
      expect(first.payload).toMatchObject({ correlation: `ceo-incident:RUN_STALLED:${driven.runId}` });
      expect(second.payload).toMatchObject({
        redelivery: true,
        correlation: first.payload["correlation"],
        episode: first.payload["episode"],
        stall: "BLOCKED_POST_MERGE",
        repositories: first.payload["repositories"],
        failedChecks: first.payload["failedChecks"],
      });
      await ticks(3);
      expect(criticalNotices(harness, driven.runId)).toHaveLength(2);
      expect(criticalNotices(harness, driven.runId)).toEqual(expect.arrayContaining([{ ...first, status: "ACKED" }, second]));
      expect(mergedFacts(harness, driven.runId)).toEqual(facts);
    } finally {
      await daemon.stop();
    }
    const restarted = new Daemon(harness.cp, { stateDir: tempDir("acp-incident-redelivery-restart-") });
    try {
      expect((await restarted.start()).allowed).toBe(true);
      expect(criticalNotices(harness, driven.runId)).toHaveLength(2);
      expect(criticalNotices(harness, driven.runId)).toEqual(expect.arrayContaining([{ ...first, status: "ACKED" }, second]));
      expect(mergedFacts(harness, driven.runId)).toEqual(facts);
      expect(github.mergeCount).toBe(1);
    } finally {
      await restarted.stop();
    }
  });

  it("a resolved incident is never delivered again: the run that left its stall gets nothing after the CEO is replaced, the one still stalled gets one", async () => {
    const h = makeHarness();
    const open = await manifestlessContractChange(h, "cc-two-runs");
    const closed = await manifestlessContractChange(h, "cc-two-runs");
    routeOwnerlessStalls(h.cp);
    const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
    for (const runId of [open.runId, closed.runId]) {
      const [notice] = criticalNotices(h, runId);
      expect(h.cp.outbox.acknowledge(notice!.messageId, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
    }
    // The CEO cancels one of them: that run left its stall.
    expect(h.cp.runs.cancel(closed.runId, "replaced by a CONTRACT_CHANGE carrying its manifest").allowed).toBe(true);

    const replacement = replaceCeo(h);
    routeOwnerlessStalls(h.cp);
    routeOwnerlessStalls(h.cp);
    expect(criticalNotices(h, closed.runId).map((notice) => notice.status)).toEqual(["ACKED"]);
    expect(criticalNotices(h, open.runId)).toHaveLength(2);
    expect(criticalNotices(h, open.runId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "ACKED" }),
      expect.objectContaining({ targetSessionId: replacement, payload: expect.objectContaining({ redelivery: true }) }),
    ]));
    // What the CEO has of each: an ACK is a receipt, the open one is ENQUEUED to the new CEO, and the cancelled
    // run's is RESOLVED by the run having ended since it opened.
    const { noticeStatus, IncidentClass, runEpisode } = await import("../../src/ceo/ceo-incident-notices.ts");
    const incident = (runId: string) => ({ cls: IncidentClass.RUN_STALLED, subject: runId, runId, episode: runEpisode(h.cp.db, runId), payload: {} });
    expect(noticeStatus(h.cp, incident(open.runId)).state).toBe("ENQUEUED");
    expect(noticeStatus(h.cp, incident(closed.runId))).toMatchObject({ state: "RESOLVED", resolvedBy: { kind: "RUN_ENDED" } });
  });

  it("a CTO escalation the CEO decided before its deferred notice went out is never delivered; the undecided one is, once", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "escalations");
    const decided = await dispatchRun(h, projectId, RunKind.STANDARD_WORK);
    const undecided = await dispatchRun(h, projectId, RunKind.STANDARD_WORK);
    // The CEO's session is not ready: the outbox refuses both notices, and both escalations are kept.
    const ceoSession = h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;
    h.cp.sessions.transition(ceoSession, SessionLifecycle.ERROR, "the CEO's runtime failed");
    const escalate = (run: { runId: string; ownerSessionId: string }) => h.cp.ceo.openEscalation({
      runId: run.runId, question: "v1 or v2?", options: ["v1", "v2"], ctoRecommendation: "v2",
      whyItMatters: "the importer cannot target both", blocksCriticalPath: true,
      openedBySessionId: run.ownerSessionId, openedAt: h.clock.nowIso(),
    });
    const opened = [escalate(decided), escalate(undecided)];
    for (const result of opened) expect(result).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const escalationNotices = (runId: string) => h.cp.outbox.listByRun(runId).filter((message) =>
      message.kind === "CEO_NOTIFICATION" && (message.payload as Record<string, unknown>)["notification"] === "TRUE_ESCALATION");
    expect([...escalationNotices(decided.runId), ...escalationNotices(undecided.runId)]).toEqual([]);

    const replacement = replaceCeo(h);
    const escalationId = opened[0]!.allowed ? opened[0]!.value.escalationId! : -1;
    expect(h.cp.ceo.resolveEscalation(decided.runId, "v2", replacement, { escalationId })).toMatchObject({ allowed: true });

    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-incident-decided-") });
    try {
      const started = await daemon.start();
      expect(started.allowed, JSON.stringify(started)).toBe(true);
      expect(escalationNotices(decided.runId)).toEqual([]);
      expect(escalationNotices(undecided.runId)).toEqual([
        expect.objectContaining({ targetSessionId: replacement, payload: expect.objectContaining({ question: "v1 or v2?" }) }),
      ]);
    } finally {
      await daemon.stop();
    }
  });
});

describe("round 2, item 2 — a CTO escalation's notice the outbox refused is retried later and delivered once", () => {
  it.each(["refused", "unknown"] as const)("an enqueue %s at opening keeps the escalation open, and a later pass delivers its notice, once", async (outcome) => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, `escalation-${outcome}`);
    const run = await dispatchRun(h, projectId, RunKind.STANDARD_WORK);
    if (outcome === "refused") {
      h.cp.sessions.transition(h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId, SessionLifecycle.ERROR, "the CEO's runtime failed");
    } else {
      vi.spyOn(h.cp.outbox, "enqueue").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
    }
    const opened = h.cp.ceo.openEscalation({
      runId: run.runId, question: "which schema version?", options: ["v1", "v2"], ctoRecommendation: "v2",
      whyItMatters: "the importer cannot target both", blocksCriticalPath: true,
      openedBySessionId: run.ownerSessionId, openedAt: h.clock.nowIso(),
    });
    expect(opened).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const notices = () => h.cp.outbox.listByRun(run.runId).filter((message) =>
      message.kind === "CEO_NOTIFICATION" && (message.payload as Record<string, unknown>)["notification"] === "TRUE_ESCALATION");
    // Not "escalation recorded, notice sent": nothing claims a notice that does not exist.
    expect(notices()).toEqual([]);
    expect(h.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "CEO_NOTIFICATION")).toEqual([]);
    expect(h.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "CEO_NOTIFICATION_DEFERRED")).toHaveLength(1);

    const target = outcome === "refused" ? replaceCeo(h) : h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;
    const ticks = ticker(h);
    const daemon = new Daemon(h.cp, { stateDir: tempDir(`acp-escalation-${outcome}-`), watchdogIntervalMs: 25 });
    try {
      const started = await daemon.start();
      expect(started.allowed, JSON.stringify(started)).toBe(true);
      await ticks(3);
      const escalationId = opened.allowed ? opened.value.escalationId : null;
      expect(notices()).toEqual([expect.objectContaining({
        targetSessionId: target,
        payload: expect.objectContaining({
          escalationId, question: "which schema version?", whyItMatters: "the importer cannot target both", blocksCriticalPath: true,
        }),
      })]);
      expect(h.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    } finally {
      await daemon.stop();
    }
  });
});

describe("H-1 — a grantless CONTRACT_CHANGE that holds its project's finalization names the transition it needs", () => {
  it("in MERGING its notice recommends nothing that cannot work: it says what it blocks, by which run, and that the exit transition is pending", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "cc-holding");
    const holding = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    carryContractChange(h, holding.runId, normalized({ ...holding.base, commitlore: { mode: "required" } } as ProjectManifest));
    await h.cp.continuity.evaluate("contract change candidate");
    expect((await h.cp.pipeline.submitResult({
      runId: holding.runId, ownerSessionId: holding.ownerSessionId, ownerBindingGeneration: holding.ownerBindingGeneration,
      resultSummary: "the proposed manifest", recommendation: "activate", residualRisk: [],
    })).allowed).toBe(true);
    // What a run confirmed before grants existed and caught mid-finalization looks like.
    const candidate = h.cp.runs.currentCandidate(holding.runId)!;
    expect(h.cp.runs.transition(holding.runId, RunState.CEO_APPROVED, "confirmed before grants", { candidateSnapshotDigest: candidate }).allowed).toBe(true);
    expect(h.cp.runs.transition(holding.runId, RunState.MERGING, "finalization began before grants").allowed).toBe(true);
    const replacement = h.cp.runs.create({
      projectId, kind: RunKind.CONTRACT_CHANGE, executionMode: "STANDARD",
      contract: { goal: "replace it", why: "it cannot finish", scope: [], nonGoals: [], acceptance: ["verify"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!replacement.allowed) throw new Error(replacement.message);

    routeOwnerlessStalls(h.cp);
    const [notice] = criticalNotices(h, holding.runId);
    expect(notice?.payload).toMatchObject({
      stall: "CONTRACT_CHANGE_RUN_WITHOUT_GRANT",
      cause: "CONFIRMED_WITHOUT_GRANT",
      state: RunState.MERGING,
      blocks: { by: holding.runId, runs: [replacement.value.runId] },
    });
    expect(notice?.payload["action"]).toEqual(expect.stringContaining("none within existing authority"));
    expect(notice?.payload["action"]).not.toEqual(expect.stringContaining("create a new CONTRACT_CHANGE"));
    expect(notice?.payload["needsTransition"]).toEqual(expect.stringMatching(/^an exit from MERGING .*\(pending\)$/));
    // The delivery record keeps what the notice says and the correlation a later pass resolves it by.
    expect(criticalAudits(h, holding.runId)).toEqual([expect.objectContaining({
      kind: "OWNERLESS_STALL_ROUTED",
      evidence: expect.objectContaining({
        correlation: `ceo-incident:RUN_STALLED:${holding.runId}`,
        needsTransition: notice?.payload["needsTransition"],
        blocks: expect.objectContaining({ by: holding.runId }),
      }),
    })]);
    const finding = (await h.cp.doctor.run("run", holding.runId)).findings.find((entry) => entry.code === "CONTRACT_CHANGE_RUN_WITHOUT_GRANT");
    expect(finding?.recommendedAction).toEqual(expect.stringContaining("needs an exit transition from MERGING (pending)"));
    expect(h.cp.runs.require(holding.runId).state).toBe(RunState.MERGING);
  });
});

describe("H-2 — the reviewer's probe: one ACTIVE CONTRACT_CHANGE with no manifest, seen by both detectors, is one notice", () => {
  it.each(["contract change first", "watchdog first"] as const)("%s: exactly one CRITICAL_SYSTEM_FAILURE for the unchanged run", async (order) => {
    const { AgentOwnedWaits, DEFAULT_AGENT_WAIT_DEADLINES } = await import("../../src/ceo/agent-owned-waits.ts");
    const h = makeHarness();
    const run = await manifestlessContractChange(h, "cc-probe");
    const waits = new AgentOwnedWaits({
      db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit, runs: h.cp.runs, bindings: h.cp.bindings,
      outbox: h.cp.outbox, artifacts: h.cp.artifacts, gate: h.cp.ceo,
    }, DEFAULT_AGENT_WAIT_DEADLINES);
    const watchdogPath = async () => {
      h.clock.advance(121 * 60 * 1000);
      // The watchdog's stalls of the run itself; a message stalled to the CTO role is that role's own incident.
      const stalls = (await h.cp.watchdog.tick()).stalls.filter((stall) => stall.runId === run.runId && stall.kind !== "outbox");
      expect(stalls).toEqual([expect.objectContaining({ kind: "run", id: run.runId })]);
      waits.routeWatchdogStalls(stalls);
    };
    if (order === "contract change first") {
      routeOwnerlessStalls(h.cp);
      await watchdogPath();
    } else {
      await watchdogPath();
      routeOwnerlessStalls(h.cp);
    }
    routeOwnerlessStalls(h.cp);
    const notices = criticalNotices(h, run.runId);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ correlation: `ceo-incident:RUN_STALLED:${run.runId}` });
  });
});

/** A CEO session the generic Buzz sweep can deliver to: its room, and who it is in that room. */
const withBuzzRoute = (h: Harness, sessionId: string): string => {
  h.cp.db.run(`UPDATE sessions SET buzz_address = 'ceo-room', buzz_actor_id = 'actor:ceo' WHERE session_id = ?`, [sessionId]);
  return sessionId;
};

const withdrawals = (h: Harness, runId: string) =>
  h.cp.audit.forRun(runId).filter((entry) => entry.kind === "CEO_NOTIFICATION_WITHDRAWN");

describe("H3-1 — a resolved incident's queued notice is handed to no CEO, by the resolution deliverIncident uses", () => {
  it("the run cancelled: a replacement CEO can claim nothing of it, while the open run's notice follows the replacement", async () => {
    const h = makeHarness();
    const open = await manifestlessContractChange(h, "cc-queued");
    const cancelled = await manifestlessContractChange(h, "cc-queued");
    routeOwnerlessStalls(h.cp);
    const [queued] = criticalNotices(h, cancelled.runId);
    expect(queued).toMatchObject({ status: "PENDING" });
    expect(h.cp.runs.cancel(cancelled.runId, "replaced by a CONTRACT_CHANGE carrying its manifest").allowed).toBe(true);

    const replacement = withBuzzRoute(h, replaceCeo(h));
    const claimed = h.cp.outbox.claimDeliverable().filter((message) => message.kind === "CEO_NOTIFICATION");
    expect(claimed.filter((message) => message.runId === cancelled.runId)).toEqual([]);
    expect(claimed.filter((message) => message.runId === open.runId)).toEqual([
      expect.objectContaining({ kind: "CEO_NOTIFICATION", targetSessionId: replacement }),
    ]);
    expect(criticalNotices(h, cancelled.runId)).toEqual([expect.objectContaining({ messageId: queued!.messageId, status: "REJECTED" })]);
    expect(withdrawals(h, cancelled.runId)).toEqual([expect.objectContaining({
      evidence: expect.objectContaining({ messageId: queued!.messageId, correlation: queued!.payload["correlation"], resolvedBy: "RUN_ENDED" }),
    })]);

    // Later passes neither deliver it nor withdraw it twice.
    routeOwnerlessStalls(h.cp);
    expect(h.cp.outbox.claimDeliverable().filter((message) => message.runId === cancelled.runId && message.kind === "CEO_NOTIFICATION")).toEqual([]);
    expect(criticalNotices(h, cancelled.runId)).toHaveLength(1);
    expect(withdrawals(h, cancelled.runId)).toHaveLength(1);
  });

  it("a CEO decision recorded on the run: a replacement CEO can claim neither the escalation's notice nor the run's CRITICAL_SYSTEM_FAILURE", async () => {
    const { IncidentClass, deliverIncident, noticeStatus, runEpisode } = await import("../../src/ceo/ceo-incident-notices.ts");
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "decided-queued");
    const run = await dispatchRun(h, projectId, RunKind.STANDARD_WORK);
    const opened = h.cp.ceo.openEscalation({
      runId: run.runId, question: "v1 or v2?", options: ["v1", "v2"], ctoRecommendation: "v2",
      whyItMatters: "the importer cannot target both", blocksCriticalPath: true,
      openedBySessionId: run.ownerSessionId, openedAt: h.clock.nowIso(),
    });
    expect(opened).toMatchObject({ allowed: true, value: { state: RunState.BLOCKED } });
    const stalled = {
      cls: IncidentClass.RUN_STALLED, subject: run.runId, runId: run.runId, episode: runEpisode(h.cp.db, run.runId),
      payload: { stall: "BLOCKED_ON_ESCALATION" },
    };
    expect(deliverIncident(h.cp, stalled)).toMatchObject({ allowed: true, value: { created: true } });
    const ceoNotices = () => h.cp.outbox.listByRun(run.runId).filter((message) => message.kind === "CEO_NOTIFICATION");
    const queued = ceoNotices();
    expect(queued.map((message) => [(message.payload as Record<string, unknown>)["notification"], message.status]).sort()).toEqual([
      [CRITICAL, "PENDING"], ["TRUE_ESCALATION", "PENDING"],
    ]);

    const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const escalationId = opened.allowed ? opened.value.escalationId! : -1;
    expect(h.cp.ceo.resolveEscalation(run.runId, "v2", ceo.sessionId, { escalationId })).toMatchObject({ allowed: true });
    expect(noticeStatus(h.cp, stalled)).toMatchObject({ state: "RESOLVED", resolvedBy: { kind: "CEO_DECISION" } });

    withBuzzRoute(h, replaceCeo(h));
    expect(h.cp.outbox.claimDeliverable().filter((message) => message.runId === run.runId && message.kind === "CEO_NOTIFICATION")).toEqual([]);
    expect(ceoNotices().map((message) => [message.messageId, message.status]).sort()).toEqual(
      queued.map((message) => [message.messageId, "REJECTED"]).sort(),
    );
    expect(withdrawals(h, run.runId).map((entry) => entry.evidence["resolvedBy"])).toEqual(["CEO_DECISION", "CEO_DECISION"]);
  });
});
