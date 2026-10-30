import { afterAll, describe, expect, it, vi } from "vitest";

import { acpError } from "../../src/core/errors.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { RunState, Role, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 B5 — a CEO-approved run whose merge is refused before anything merged used to stay CEO_APPROVED
 * (or MERGING) and be retried on every watchdog tick, with no end state and no way back to its CTO.
 */

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
const MINUTE = 60_000;
type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Hook = (method: HttpMethod, path: string, body?: unknown) => void;

const isMergePut = (method: HttpMethod, path: string): boolean => method === "PUT" && /\/pulls\/\d+\/merge$/.test(path);

/**
 * GitHub as the merge sees it: the merged pull keeps its base snapshot and the target ref moves; a merge PUT
 * GitHub would refuse (a conflict, or a failing required check under branch protection) answers 405; `before`
 * runs ahead of every request and may throw, and `after` runs after it.
 */
const githubFor = (options: { before?: Hook; after?: Hook } = {}) => {
  const github = new FakeGitHub();
  const request = github.request.bind(github);
  github.request = async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    options.before?.(method, path, body);
    if (isMergePut(method, path)) {
      const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
      const pull = github.pulls.find((entry) => entry.number === number);
      const redCheck = github.checkRuns.some((check) =>
        check.head_sha === pull?.head.sha && check.name === "project-ci" && check.conclusion === "failure");
      if (pull?.mergeable === false || redCheck) {
        github.calls.push({ method, path, body });
        throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 405 });
      }
    }
    const response = await request<T>(method, path, body);
    options.after?.(method, path, body);
    if (isMergePut(method, path) && response && typeof response === "object") {
      const merged = response as { merged?: unknown; sha?: unknown };
      const pull = github.pulls.find((entry) => entry.number === Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]));
      if (merged.merged === true && typeof merged.sha === "string" && pull) {
        pull.merge_commit_sha = merged.sha;
        github.setBranch(pull.base.ref, merged.sha);
      }
    }
    return response;
  };
  return github;
};

const approved = async (options: {
  before?: Hook;
  after?: Hook;
  manifest?: Partial<ProjectManifest>;
  /** A contract admitted before #1269 pinned this strategy; no manifest is admitted with it now. */
  pinnedMergeStrategy?: ProjectManifest["branchProfile"]["mergeStrategy"];
} = {}) => {
  const github = githubFor(options);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/B5-merge",
    manifestOverrides: {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
      ...options.manifest,
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
  const legacy = options.pinnedMergeStrategy;
  if (legacy !== undefined) {
    const stored = harness.cp.projects.manifest.bind(harness.cp.projects);
    vi.spyOn(harness.cp.projects, "manifest").mockImplementation((digest) => {
      const pinned = stored(digest);
      return pinned ? { ...pinned, branchProfile: { ...pinned.branchProfile, mergeStrategy: legacy } } : null;
    });
  }
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await harness.cp.continuity.evaluate("B5 packet");
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
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
  // The sweep is driven by hand below; a timer firing mid-test would add attempts nobody asked for.
  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-b5-"), watchdogIntervalMs: 24 * 60 * MINUTE });
  return { github, harness, driven, daemon };
};

type Fixture = Awaited<ReturnType<typeof approved>>;

const transitions = (fixture: Fixture): Array<[unknown, unknown]> =>
  fixture.harness.cp.audit.forRun(fixture.driven.runId)
    .filter((entry) => entry.kind === "RUN_TRANSITION")
    .map((entry) => [entry.evidence.from, entry.evidence.to]);

const mergePuts = (fixture: Fixture): number =>
  fixture.github.calls.filter((call) => isMergePut(call.method as HttpMethod, call.path)).length;

const outboxOf = (fixture: Fixture, kind: string) =>
  fixture.harness.cp.db.all<{ target_session_id: string; payload_json: string }>(
    "SELECT target_session_id, payload_json FROM outbox WHERE run_id = ? AND kind = ? ORDER BY created_at, rowid",
    [fixture.driven.runId, kind],
  ).map((row) => ({ target: row.target_session_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));

const failedAttempts = (fixture: Fixture): number =>
  fixture.harness.cp.audit.forRun(fixture.driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").length;

/** The approval of the frozen candidate is invalidated, the run is back with its CTO, and nothing merged. */
const expectReturnedForRevision = (fixture: Fixture, from: RunState, reasonCode: ReasonCode): void => {
  const { harness, driven } = fixture;
  const run = harness.cp.runs.require(driven.runId);
  expect(run.state).toBe(RunState.ACTIVE);
  expect(run.ownerSessionId).toBe(driven.ownerSessionId);
  expect(transitions(fixture).slice(-2)).toEqual([[from, RunState.REVISION_REQUIRED], [RunState.REVISION_REQUIRED, RunState.ACTIVE]]);
  const invalidated = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED");
  expect(invalidated).toHaveLength(1);
  expect(invalidated[0]!.reasonCode).toBe(reasonCode);
  expect(invalidated[0]!.evidence).toMatchObject({
    from, candidateSnapshotDigest: driven.candidateSnapshotDigest, disposition: "REVISION",
  });
  expect(invalidated[0]!.evidence.approvedBy).toBe(harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId);
  // The CONFIRM names a candidate that is no longer current, so no finalization can use it again.
  expect(harness.cp.runs.currentCandidate(driven.runId)).toBeNull();
  expect(harness.cp.ceo.currentCeoConfirmation(driven.runId, driven.candidateSnapshotDigest).allowed).toBe(false);
  const revision = outboxOf(fixture, "REVISION_REQUEST");
  expect(revision).toHaveLength(1);
  expect(revision[0]!.target).toBe(driven.ownerSessionId);
  expect(revision[0]!.payload).toMatchObject({ runId: driven.runId, reasonCode, candidateSnapshotDigest: driven.candidateSnapshotDigest });
  expect(mergePuts(fixture)).toBe(0);
  expect(fixture.github.mergeCount).toBe(0);
  expect(harness.cp.db.get("SELECT 1 FROM github_receipts WHERE run_id = ? AND operation = 'merge_execute'", [driven.runId])).toBeUndefined();
};

describe("#1189 B5 — an approved run that cannot merge has an exit", () => {
  it("stale base at publication: CEO_APPROVED → REVISION_REQUIRED → ACTIVE with the approval invalidated, and the sweep leaves it alone", async () => {
    const fixture = await approved();
    fixture.github.setBranch("dev", "b".repeat(40));
    const started = await fixture.daemon.start();
    expect(started.allowed).toBe(true);
    expectReturnedForRevision(fixture, RunState.CEO_APPROVED, ReasonCode.MERGE_BASE_STALE);
    const calls = fixture.github.calls.length;
    fixture.harness.clock.advance(2 * MINUTE);
    await fixture.daemon.resumeApprovedRuns();
    expect(fixture.github.calls.length).toBe(calls);
    await fixture.daemon.stop();
  });

  it("stale base at the merge: MERGING → REVISION_REQUIRED before any merge reservation", async () => {
    let fixture: Fixture | null = null;
    fixture = await approved({
      after: (method, path) => {
        if (method !== "POST" || !path.endsWith("/check-runs") || !fixture) return;
        fixture.github.setBranch("dev", "c".repeat(40));
        for (const pull of fixture.github.pulls) pull.base.sha = "c".repeat(40);
      },
    });
    const started = await fixture.daemon.start();
    expect(started.allowed).toBe(true);
    expectReturnedForRevision(fixture, RunState.MERGING, ReasonCode.MERGE_BASE_STALE);
    await fixture.daemon.stop();
  });

  it("stale base after the owner lost its binding: the run waits in REVISION_REQUIRED for a dispatch and the CEO is told the blocker", async () => {
    // The owner's binding is retired while the attempt reads the base ref that turns out stale: the kernel had
    // the owner's authority, and the return finds no current owner to give the revision to.
    let fixture: Fixture | null = null;
    fixture = await approved({
      after: (method, path) => {
        if (method !== "GET" || !path.endsWith("/git/ref/heads/dev") || !fixture) return;
        const roleKey = fixture.harness.cp.runs.require(fixture.driven.runId).ownerRoleKey!;
        fixture.harness.cp.db.run(
          "UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'B5 witness' WHERE role_key = ? AND status = 'ACTIVE'",
          [fixture.harness.clock.nowIso(), roleKey],
        );
      },
    });
    const { harness, driven, daemon } = fixture;
    fixture.github.setBranch("dev", "b".repeat(40));
    expect((await daemon.start()).allowed).toBe(true);
    const run = harness.cp.runs.require(driven.runId);
    expect(run.state).toBe(RunState.REVISION_REQUIRED);
    expect(transitions(fixture).slice(-1)).toEqual([[RunState.CEO_APPROVED, RunState.REVISION_REQUIRED]]);
    expect(harness.cp.runs.currentCandidate(driven.runId)).toBeNull();
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED")).toHaveLength(1);
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(0);
    const notices = outboxOf(fixture, "CEO_NOTIFICATION").filter((notice) => notice.payload.notification === "CRITICAL_SYSTEM_FAILURE");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({
      runId: driven.runId, failureReasonCode: ReasonCode.MERGE_BASE_STALE, failureClass: "REVISION", owner: "CEO",
      blocker: expect.stringMatching(/^MERGE_BASE_STALE: /),
    });
    expect(fixture.github.mergeCount).toBe(0);
    await daemon.stop();
  });

  it("conflict: GitHub's unmergeable pull returns the run for revision instead of a merge attempt", async () => {
    let fixture: Fixture | null = null;
    fixture = await approved({
      after: (method, path) => {
        if (method === "POST" && /\/pulls$/.test(path)) for (const pull of fixture!.github.pulls) pull.mergeable = false;
      },
    });
    const started = await fixture.daemon.start();
    expect(started.allowed).toBe(true);
    expectReturnedForRevision(fixture, RunState.MERGING, ReasonCode.MERGE_CONFLICT);
    await fixture.daemon.stop();
  });

  it("a declared check that failed on the candidate head returns the run for revision instead of a merge attempt", async () => {
    const fixture = await approved();
    fixture.github.setPostMergeCheck(fixture.driven.candidateHead, "project-ci", "failure");
    const started = await fixture.daemon.start();
    expect(started.allowed).toBe(true);
    expectReturnedForRevision(fixture, RunState.MERGING, ReasonCode.MERGE_CHECK_FAILED);
    await fixture.daemon.stop();
  });

  it("a transient GitHub 5xx backs off 1–16 minutes, stops after 5 automatic retries, is handed to the CEO once with a blocker, and never fails", async () => {
    const fixture = await approved({
      before: (method) => {
        throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 503 });
      },
    });
    const { harness, driven, daemon } = fixture;
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    expect(failedAttempts(fixture)).toBe(1);

    // The first attempt is not a retry; retries follow at 1, 2, 4, 8 and 16 minutes, and an early sweep
    // attempts nothing.
    let elapsed = 0;
    for (const [delay, attempts] of [[1, 2], [2, 3], [4, 4], [8, 5], [16, 6]] as const) {
      harness.clock.advance(delay * MINUTE - 30_000);
      await daemon.resumeApprovedRuns();
      expect(failedAttempts(fixture), `${elapsed + delay - 0.5} min`).toBe(attempts - 1);
      harness.clock.advance(30_000);
      await daemon.resumeApprovedRuns();
      expect(failedAttempts(fixture), `${elapsed + delay} min`).toBe(attempts);
      elapsed += delay;
    }
    const last = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").at(-1)!;
    expect(last.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(last.evidence).toMatchObject({ candidateSnapshotDigest: driven.candidateSnapshotDigest, disposition: "RETRY", failureClass: "TRANSIENT" });
    const schedules = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_RETRY_SCHEDULED");
    expect(schedules.map((entry) => [entry.evidence.refusals, entry.evidence.retries])).toEqual([[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]);
    const exhausted = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_RETRIES_EXHAUSTED");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.evidence).toMatchObject({
      candidateSnapshotDigest: driven.candidateSnapshotDigest, failureClass: "TRANSIENT", failureCause: "TRANSIENT",
      refusals: 6, retries: 5, retryCap: 5, limit: "FAILURE",
    });
    expect(exhausted[0]!.evidence.retryNotBefore).toBeUndefined();

    // The cap: handed to the CEO once, the run still approved, nothing FAILED and nothing invalidated.
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(transitions(fixture).some(([, to]) => to === RunState.FAILED || to === RunState.REVISION_REQUIRED)).toBe(false);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED")).toHaveLength(0);
    const handed = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_HANDED_OFF");
    expect(handed).toHaveLength(1);
    expect(handed[0]!.evidence).toMatchObject({
      candidateSnapshotDigest: driven.candidateSnapshotDigest, failureClass: "TRANSIENT", owner: "CEO", retries: 5, delivered: true,
      blocker: "PROBE_FAILED: could not enumerate active release branches",
    });
    const notices = () => outboxOf(fixture, "CEO_NOTIFICATION").filter((notice) => notice.payload.notification === "CRITICAL_SYSTEM_FAILURE");
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.payload).toMatchObject({
      runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest, failureReasonCode: ReasonCode.PROBE_FAILED, owner: "CEO",
      blocker: "PROBE_FAILED: could not enumerate active release branches", retries: 5, retryCap: 5,
    });
    expect(notices()[0]!.payload.action).toEqual(expect.stringContaining("no longer retries this candidate automatically"));
    await daemon.stop();
  });

  it("past the cap the watchdog stops: a day of sweeps and a restart attempt nothing, and the hand-off is not repeated", async () => {
    let outage = true;
    const fixture = await approved({
      before: (method) => {
        if (outage) throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 503 });
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    for (let sweep = 0; sweep < 5; sweep += 1) {
      harness.clock.advance(60 * MINUTE);
      await daemon.resumeApprovedRuns();
    }
    expect(failedAttempts(fixture)).toBe(6);
    const calls = fixture.github.calls.length;
    // GitHub recovers; nothing retries the run automatically any more, not the watchdog and not a restart.
    outage = false;
    for (let sweep = 0; sweep < 24; sweep += 1) {
      harness.clock.advance(60 * MINUTE);
      await daemon.resumeApprovedRuns();
    }
    await daemon.stop();
    const restarted = new Daemon(harness.cp, { stateDir: tempDir("acp-b5-restart-"), watchdogIntervalMs: 24 * 60 * MINUTE });
    expect((await restarted.start()).allowed).toBe(true);
    expect(failedAttempts(fixture)).toBe(6);
    expect(fixture.github.calls.length).toBe(calls);
    expect(fixture.github.mergeCount).toBe(0);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_HANDED_OFF")).toHaveLength(1);
    expect(outboxOf(fixture, "CEO_NOTIFICATION").filter((notice) => notice.payload.notification === "CRITICAL_SYSTEM_FAILURE")).toHaveLength(1);
    await restarted.stop();
  });

  it("a GitHub outage seen as a caught denial at one step and a thrown error at the next is one failure for the cap", async () => {
    // "all" fails the first request, which the kernel catches (PROBE_FAILED); "list" fails only the open-pull
    // query prPrepare makes before any reservation, which it does not catch (INTERNAL_ERROR naming PROBE_FAILED).
    let mode: "all" | "list" = "all";
    const fixture = await approved({
      before: (method, path) => {
        if (mode === "all" || (method === "GET" && /\/pulls\?head=/.test(path))) {
          throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 502 });
        }
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    for (const next of ["list", "all", "list", "all", "list"] as const) {
      mode = next;
      harness.clock.advance(60 * MINUTE);
      await daemon.resumeApprovedRuns();
    }
    const failed = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED");
    expect(failed.map((entry) => entry.reasonCode)).toEqual([
      ReasonCode.PROBE_FAILED, ReasonCode.INTERNAL_ERROR, ReasonCode.PROBE_FAILED, ReasonCode.INTERNAL_ERROR, ReasonCode.PROBE_FAILED,
      ReasonCode.INTERNAL_ERROR,
    ]);
    expect(failed.every((entry) => entry.evidence.failureClass === "TRANSIENT")).toBe(true);
    const schedules = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_RETRY_SCHEDULED");
    expect(schedules.map((entry) => entry.evidence.refusals)).toEqual([1, 2, 3, 4, 5]);
    const handed = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_HANDED_OFF");
    expect(handed).toHaveLength(1);
    expect(handed[0]!.evidence).toMatchObject({ failureClass: "TRANSIENT", failureCause: "TRANSIENT", refusals: 6, retries: 5, limit: "FAILURE", owner: "CEO" });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(fixture.github.mergeCount).toBe(0);
    await daemon.stop();
  });

  it("alternating failures keep their counts: each failure's refusals accumulate across the other's, and the candidate's 5 retries end it", async () => {
    // Two different refusals, each thrown by the open-pull query prPrepare makes before any reservation.
    const causes = [ReasonCode.CONFLICT, ReasonCode.NOT_FOUND] as const;
    let turn = 0;
    const fixture = await approved({
      before: (method, path) => {
        if (method === "GET" && /\/pulls\?head=/.test(path)) throw acpError(causes[turn % 2]!, "refused for the witness", {});
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    for (let sweep = 0; sweep < 12; sweep += 1) {
      turn += 1;
      harness.clock.advance(60 * MINUTE);
      await daemon.resumeApprovedRuns();
    }
    const counts = harness.cp.audit.forRun(driven.runId)
      .filter((entry) => entry.kind === "FINALIZATION_RETRY_SCHEDULED" || entry.kind === "FINALIZATION_RETRIES_EXHAUSTED")
      .map((entry) => [entry.evidence.failureCause, entry.evidence.refusals, entry.evidence.retries]);
    expect(counts).toEqual([
      [ReasonCode.CONFLICT, 1, 0], [ReasonCode.NOT_FOUND, 1, 1], [ReasonCode.CONFLICT, 2, 2],
      [ReasonCode.NOT_FOUND, 2, 3], [ReasonCode.CONFLICT, 3, 4], [ReasonCode.NOT_FOUND, 3, 5],
    ]);
    expect(failedAttempts(fixture)).toBe(6);
    const handed = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_HANDED_OFF");
    expect(handed).toHaveLength(1);
    expect(handed[0]!.evidence).toMatchObject({ limit: "CANDIDATE", owner: "CEO", retries: 5, delivered: true });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    await daemon.stop();
  });

  it.each(["fast_forward", "squash", "rebase"] as const)("an unrecoverable refusal ends FAILED with its reason: a pinned %s contract, which is not a merge commit", async (strategy) => {
    const fixture = await approved({ pinnedMergeStrategy: strategy });
    const { harness, driven, daemon } = fixture;
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    const run = harness.cp.runs.require(driven.runId);
    expect(run.state).toBe(RunState.FAILED);
    expect(run.stateReason).toContain(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
    expect(transitions(fixture).slice(-2)).toEqual([[RunState.MERGING, RunState.REVISION_REQUIRED], [RunState.REVISION_REQUIRED, RunState.FAILED]]);
    const invalidated = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]!.evidence).toMatchObject({ disposition: "UNRECOVERABLE", candidateSnapshotDigest: driven.candidateSnapshotDigest });
    // FAILED on GitHub's own read that the pull request is unmerged, not on the absence of a receipt alone.
    const refused = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").at(-1)!;
    expect(refused.evidence).toMatchObject({ mergeStrategy: strategy, pullMerged: false, disposition: "UNRECOVERABLE" });
    const notices = outboxOf(fixture, "CEO_NOTIFICATION").filter((notice) => notice.payload.notification === "CRITICAL_SYSTEM_FAILURE");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ failureReasonCode: ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, failureClass: "UNRECOVERABLE" });
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(0);
    expect(fixture.github.mergeCount).toBe(0);
    await daemon.stop();
  });

  const pendingMergeReceipts = (fixture: Fixture) =>
    fixture.harness.cp.db.all<{ status: string }>(
      "SELECT status FROM github_receipts WHERE run_id = ? AND operation = 'merge_execute'",
      [fixture.driven.runId],
    ).map((row) => row.status);

  /** A merge request whose outcome is unknown is held: MERGING, its PENDING receipt kept, nothing invalidated. */
  const expectHeld = (fixture: Fixture, outcome: Record<string, unknown>): void => {
    const { harness, driven } = fixture;
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
    expect(pendingMergeReceipts(fixture)).toEqual(["PENDING"]);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_BLOCKED_POST_MERGE")).toHaveLength(0);
    const unknown = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "MERGE_OUTCOME_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.evidence).toMatchObject({ repositoryIdentity: driven.identity, exactHead: driven.candidateHead, ...outcome });
    const refused = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").at(-1)!;
    expect(refused.evidence).toMatchObject({ disposition: "RETRY", failureClass: "MERGE_OUTCOME_UNKNOWN" });
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED")).toHaveLength(0);
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(0);
    // Never returned for revision while a merge could have happened.
    const returned = harness.cp.runs.returnApprovedCandidate(driven.runId, {
      candidateSnapshotDigest: driven.candidateSnapshotDigest, attemptId: "finalize_witness",
      reasonCode: ReasonCode.MERGE_CONFLICT, reason: "witness", unrecoverable: false,
    });
    expect(returned.reasonCode).toBe(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
  };

  it("a merge request GitHub answers 405 after an evaluation that saw mergeable null is held; the next attempt re-reads the pull and, proven unmerged, returns it for revision", async () => {
    let fixture: Fixture | null = null;
    // GitHub had not computed mergeability when the merge was evaluated, and finds the conflict only as the
    // merge is requested.
    fixture = await approved({
      before: (method, path) => {
        if (isMergePut(method, path)) for (const pull of fixture!.github.pulls) pull.mergeable = false;
      },
      after: (method, path) => {
        if (method === "POST" && /\/pulls$/.test(path)) for (const pull of fixture!.github.pulls) pull.mergeable = null;
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    expect(mergePuts(fixture)).toBe(1);
    expectHeld(fixture, { status: 405, outcome: "answered" });

    // The backoff holds the reconciliation for a minute; then the pull is re-read before anything else is sent.
    harness.clock.advance(30_000);
    await daemon.resumeApprovedRuns();
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
    const callsBefore = fixture.github.calls.length;
    harness.clock.advance(30_000);
    await daemon.resumeApprovedRuns();
    const after = fixture.github.calls.slice(callsBefore);
    expect(after.some((call) => call.method === "GET" && /\/pulls\/\d+$/.test(call.path))).toBe(true);
    expect(mergePuts(fixture)).toBe(1);
    const run = harness.cp.runs.require(driven.runId);
    expect(run.state).toBe(RunState.ACTIVE);
    expect(transitions(fixture).slice(-2)).toEqual([[RunState.MERGING, RunState.REVISION_REQUIRED], [RunState.REVISION_REQUIRED, RunState.ACTIVE]]);
    const invalidated = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]!.reasonCode).toBe(ReasonCode.MERGE_CONFLICT);
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(1);
    expect(pendingMergeReceipts(fixture)).toEqual([]);
    expect(fixture.github.mergeCount).toBe(0);
    await daemon.stop();
  });

  it("a merge request whose answer was lost after GitHub merged it is proven merged by the next attempt's first read, though its pull is closed: never sent again, revised, failed or released", async () => {
    let lose = true;
    const fixture = await approved({
      after: (method, path) => {
        if (isMergePut(method, path) && lose) {
          lose = false;
          throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method });
        }
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    expect(fixture.github.mergeCount).toBe(1);
    expectHeld(fixture, { outcome: "unheard" });
    expect(fixture.github.pulls.map((pull) => [pull.state, pull.merged])).toEqual([["closed", true]]);
    const callsBefore = fixture.github.calls.length;
    harness.clock.advance(MINUTE);
    await daemon.resumeApprovedRuns();
    // The pending receipt is settled by a read of the pull before anything is published, prepared or gated
    // again: a closed pull that GitHub reports merged is this run's merge, not a closed pull request.
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    const after = fixture.github.calls.slice(callsBefore);
    expect(after[0]!.method).toBe("GET");
    expect(after[0]!.path).toMatch(/\/pulls\/\d+$/);
    expect(after.filter((call) => call.method !== "GET")).toEqual([]);
    expect(transitions(fixture).slice(-2)).toEqual([[RunState.MERGING, RunState.POST_MERGE_VERIFYING], [RunState.POST_MERGE_VERIFYING, RunState.COMPLETED]]);
    expect(mergePuts(fixture)).toBe(1);
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.harness.cp.db.all<{ status: string; verified: number }>(
      "SELECT status, verified FROM github_receipts WHERE run_id = ? AND operation = 'merge_execute'", [driven.runId],
    )).toEqual([{ status: "APPLIED", verified: 1 }]);
    expect(failedAttempts(fixture)).toBe(1);
    for (const kind of ["CEO_APPROVAL_INVALIDATED", "FINALIZATION_HANDED_OFF", "FINALIZATION_BLOCKED_POST_MERGE"]) {
      expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === kind), kind).toHaveLength(0);
    }
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(0);
    await daemon.stop();
  });

  it("#1269: a merge whose answer was lost is settled by the daemon's next attempt, which carries the candidate's CommitLore notes to the remote without a second merge", async () => {
    let lose = true;
    const fixture = await approved({
      after: (method, path) => {
        if (isMergePut(method, path) && lose) {
          lose = false;
          throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method });
        }
      },
    });
    const { harness, driven, daemon } = fixture;
    gitSync(harness.repoPath, ["notes", "--ref=commitlore", "add", "-m", "Limit: a record kept only in a note", driven.candidateHead]);
    const blob = gitSync(harness.repoPath, ["notes", "--ref=commitlore", "list", driven.candidateHead]);
    expect((await daemon.start()).allowed).toBe(true);
    expectHeld(fixture, { outcome: "unheard" });
    expect(fixture.github.remoteNoteFor(driven.candidateHead)).toBeUndefined();
    harness.clock.advance(MINUTE);
    await daemon.resumeApprovedRuns();
    expect(fixture.github.remoteNoteFor(driven.candidateHead)).toBe(blob);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(mergePuts(fixture)).toBe(1);
    expect(fixture.github.mergeCount).toBe(1);
    await daemon.stop();
  });

  it("a merge request held unknown whose base then moved, unmerged, is reconciled before anything is replayed: the read proves it unmerged and it returns for revision as a stale base", async () => {
    let fail = true;
    let fixture: Fixture | null = null;
    fixture = await approved({
      before: (method, path, body) => {
        if (isMergePut(method, path) && fail) {
          fail = false;
          fixture!.github.calls.push({ method, path, body });
          throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 502 });
        }
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    expectHeld(fixture, { status: 502, outcome: "answered" });
    fixture.github.setBranch("dev", "c".repeat(40));
    for (const pull of fixture.github.pulls) pull.base.sha = "c".repeat(40);
    const callsBefore = fixture.github.calls.length;
    harness.clock.advance(MINUTE);
    await daemon.resumeApprovedRuns();
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.ACTIVE);
    const after = fixture.github.calls.slice(callsBefore);
    expect(after[0]!.method).toBe("GET");
    expect(after[0]!.path).toMatch(/\/pulls\/\d+$/);
    expect(after.filter((call) => call.method !== "GET")).toEqual([]);
    expect(mergePuts(fixture)).toBe(1);
    expect(fixture.github.mergeCount).toBe(0);
    expect(transitions(fixture).slice(-2)).toEqual([[RunState.MERGING, RunState.REVISION_REQUIRED], [RunState.REVISION_REQUIRED, RunState.ACTIVE]]);
    const invalidated = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]!.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(1);
    expect(pendingMergeReceipts(fixture)).toEqual([]);
    await daemon.stop();
  });

  for (const [field, rewrite] of [
    ["body", (pull: { body?: string | null }) => { pull.body = "Closes #999"; }],
    ["title", (pull: { title?: string }) => { pull.title = "Closes #999"; }],
  ] as const) {
    it(`a merge request held unknown whose pull ${field} was rewritten while unmerged is never sent again by its settlement: the read releases it, and preparation refuses the rewritten pull as on the ordinary path`, async () => {
      let fail = true;
      let fixture: Fixture | null = null;
      fixture = await approved({
        before: (method, path, body) => {
          if (isMergePut(method, path) && fail) {
            fail = false;
            fixture!.github.calls.push({ method, path, body });
            throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 502 });
          }
        },
      });
      const { harness, driven, daemon } = fixture;
      expect((await daemon.start()).allowed).toBe(true);
      expectHeld(fixture, { status: 502, outcome: "answered" });
      for (const pull of fixture.github.pulls) rewrite(pull);
      const callsBefore = fixture.github.calls.length;
      for (let sweep = 0; sweep < 2; sweep += 1) {
        harness.clock.advance(2 * MINUTE);
        await daemon.resumeApprovedRuns();
      }
      const after = fixture.github.calls.slice(callsBefore);
      expect(after[0]!.method).toBe("GET");
      expect(after[0]!.path).toMatch(/\/pulls\/\d+$/);
      expect(after.filter((call) => call.method !== "GET")).toEqual([]);
      expect(mergePuts(fixture)).toBe(1);
      expect(fixture.github.mergeCount).toBe(0);
      // Proven unmerged, nothing was applied: the reservation is gone, and the pull it named is refused by
      // preparation's live re-read, as an ordinary attempt refuses it.
      expect(pendingMergeReceipts(fixture)).toEqual([]);
      const refusals = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").slice(1);
      expect(refusals.length).toBeGreaterThan(0);
      for (const refused of refusals) {
        expect(refused.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
        expect(refused.evidence).toMatchObject({
          disposition: "RETRY", failureClass: "UNCLASSIFIED", pullNumber: fixture.github.pulls[0]!.number,
        });
      }
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
      expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_BLOCKED_POST_MERGE")).toHaveLength(0);
      await daemon.stop();
    });
  }

  it("a cap reached while no CEO is bound keeps its notice owed, without retrying the run: once a CEO is bound the next sweep sends it, exactly once", async () => {
    const fixture = await approved();
    const { harness, driven, daemon } = fixture;
    for (const claim of harness.cp.db.all<{ claim_id: string }>("SELECT claim_id FROM resource_claims WHERE run_id = ? AND status = 'HELD'", [driven.runId])) {
      expect(harness.cp.claims.release(claim.claim_id, driven.runId).allowed).toBe(true);
    }
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "the CEO seat is vacated").allowed).toBe(true);
    expect((await daemon.start()).allowed).toBe(true);
    const handedOff = () => harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_HANDED_OFF");
    const notices = () => outboxOf(fixture, "CEO_NOTIFICATION").filter((notice) => notice.payload.notification === "CRITICAL_SYSTEM_FAILURE");
    expect(handedOff().map((entry) => entry.evidence.delivered)).toEqual([false]);
    expect(notices()).toHaveLength(0);
    // No CEO yet: the sweeps neither retry the run nor enqueue anything.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      harness.clock.advance(60 * MINUTE);
      await daemon.resumeApprovedRuns();
    }
    expect(notices()).toHaveLength(0);
    const ceoSessionId = bindCeo(harness);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      harness.clock.advance(60 * MINUTE);
      await daemon.resumeApprovedRuns();
    }
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.target).toBe(ceoSessionId);
    expect(notices()[0]!.payload).toMatchObject({
      runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest, failureReasonCode: ReasonCode.MERGE_CLAIM_INVALID,
      failureClass: "AUTHORITY_RECOVERY", owner: "CEO", retries: 0, retryCap: 5, blocker: expect.stringMatching(/^MERGE_CLAIM_INVALID: /),
    });
    expect(handedOff().map((entry) => entry.evidence.delivered)).toEqual([false, true]);
    // The run itself stays capped: one refusal in all, nothing sent to GitHub, still approved.
    expect(failedAttempts(fixture)).toBe(1);
    expect(fixture.github.mergeCount).toBe(0);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    await daemon.stop();
  });

  it("a merge request that got a 5xx is not sent again until a re-read shows the pull unmerged; then it merges once", async () => {
    let fail = true;
    let fixture: Fixture | null = null;
    fixture = await approved({
      before: (method, path, body) => {
        if (isMergePut(method, path) && fail) {
          fail = false;
          fixture!.github.calls.push({ method, path, body });
          throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 502 });
        }
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    expectHeld(fixture, { status: 502, outcome: "answered" });
    const firstPut = fixture.github.calls.findIndex((call) => isMergePut(call.method as HttpMethod, call.path));
    harness.clock.advance(MINUTE);
    await daemon.resumeApprovedRuns();
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(mergePuts(fixture)).toBe(2);
    expect(fixture.github.mergeCount).toBe(1);
    const secondPut = fixture.github.calls.findIndex((call, index) => index > firstPut && isMergePut(call.method as HttpMethod, call.path));
    expect(fixture.github.calls.slice(firstPut + 1, secondPut).some((call) => call.method === "GET" && /\/pulls\/\d+$/.test(call.path))).toBe(true);
    await daemon.stop();
  });

  it("a pinned fast-forward whose unmerged state could not be read is retried, never FAILED", async () => {
    let gated = false;
    let reads = 0;
    const fixture = await approved({
      pinnedMergeStrategy: "fast_forward",
      // After the gate, the merge evaluation reads the pull once; the second read is the fast-forward refusal's.
      before: (method, path) => {
        if (method === "POST" && path.endsWith("/check-runs")) gated = true;
        if (gated && method === "GET" && /\/pulls\/\d+$/.test(path) && ++reads === 2) {
          throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 502 });
        }
      },
    });
    const { harness, driven, daemon } = fixture;
    expect((await daemon.start()).allowed).toBe(true);
    const refused = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reasonCode).toBe(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
    expect(refused[0]!.evidence).toMatchObject({ mergeStrategy: "fast_forward", pullMerged: null, disposition: "RETRY", failureClass: "UNCLASSIFIED" });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
    expect(transitions(fixture).some(([, to]) => to === RunState.FAILED || to === RunState.REVISION_REQUIRED)).toBe(false);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED")).toHaveLength(0);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_RETRY_SCHEDULED")).toHaveLength(1);
    await daemon.stop();
  });

  it("an invalid branch claim is an authority blocker, not a candidate defect: no approval is invalidated and no revision request goes to any owner", async () => {
    const fixture = await approved();
    const { harness, driven, daemon } = fixture;
    const held = harness.cp.db.all<{ claim_id: string }>("SELECT claim_id FROM resource_claims WHERE run_id = ? AND status = 'HELD'", [driven.runId]);
    expect(held.length).toBeGreaterThan(0);
    for (const claim of held) expect(harness.cp.claims.release(claim.claim_id, driven.runId).allowed).toBe(true);
    expect((await daemon.start()).allowed).toBe(true);
    const refused = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reasonCode).toBe(ReasonCode.MERGE_CLAIM_INVALID);
    expect(refused[0]!.evidence).toMatchObject({ disposition: "RETRY", failureClass: "AUTHORITY_RECOVERY" });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(harness.cp.runs.currentCandidate(driven.runId)).toBe(driven.candidateSnapshotDigest);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED")).toHaveLength(0);
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(0);
    const handed = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_HANDED_OFF");
    expect(handed).toHaveLength(1);
    expect(handed[0]!.evidence).toMatchObject({
      failureClass: "AUTHORITY_RECOVERY", failureCause: ReasonCode.MERGE_CLAIM_INVALID, owner: "CEO", refusals: 1, retries: 0, delivered: true,
      blocker: expect.stringMatching(/^MERGE_CLAIM_INVALID: /),
    });
    // It allows no automatic retry.
    harness.clock.advance(3 * 60 * MINUTE);
    await daemon.resumeApprovedRuns();
    expect(failedAttempts(fixture)).toBe(1);
    await daemon.stop();
  });

  it("an approval is invalidated only for the refused candidate, and never once a merge receipt exists", async () => {
    const fixture = await approved();
    const { harness, driven } = fixture;
    const input = {
      candidateSnapshotDigest: driven.candidateSnapshotDigest, attemptId: "finalize_witness",
      reasonCode: ReasonCode.MERGE_BASE_STALE, reason: "witness", unrecoverable: false,
    };
    const other = harness.cp.runs.returnApprovedCandidate(driven.runId, { ...input, candidateSnapshotDigest: `sha256:${"0".repeat(64)}` });
    expect(other.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    harness.cp.db.run(
      `INSERT INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
          request_digest, response_json, created_at, status)
       VALUES ('receipt_b5_pending_merge', ?, 'merge_execute', ?, ?, 'merge', 'acme/fixture#1', 'sha256:r', '{"pending":true}', ?, 'PENDING')`,
      [`merge_execute:${driven.identity}:1`, driven.runId, driven.identity, harness.clock.nowIso()],
    );
    const merged = harness.cp.runs.returnApprovedCandidate(driven.runId, input);
    expect(merged.reasonCode).toBe(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(harness.cp.runs.currentCandidate(driven.runId)).toBe(driven.candidateSnapshotDigest);
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_APPROVAL_INVALIDATED")).toHaveLength(0);
  });

  it("a refusal after the approval's invalidation was recorded rolls the whole return back: the run stays approved with its candidate current", async () => {
    const fixture = await approved();
    const { harness, driven } = fixture;
    const before = harness.cp.runs.require(driven.runId);
    const auditBefore = harness.cp.audit.forRun(driven.runId).length;
    // The owner's REVISION_REQUEST, the body's last write, is refused: its idempotency key already names
    // another request.
    const taken = harness.cp.outbox.enqueue({
      idempotencyKey: `approved-candidate-returned:${driven.runId}:r${before.revisionCount + 1}:${driven.candidateSnapshotDigest}`,
      roleKey: before.ownerRoleKey!,
      bindingGeneration: before.ownerBindingGeneration!,
      targetSessionId: before.ownerSessionId!,
      runId: driven.runId,
      kind: MessageKind.REVISION_REQUEST,
      payload: { runId: driven.runId, note: "an earlier request under the same key" },
    });
    expect(taken.allowed).toBe(true);
    const returned = harness.cp.runs.returnApprovedCandidate(driven.runId, {
      candidateSnapshotDigest: driven.candidateSnapshotDigest, attemptId: "finalize_witness",
      reasonCode: ReasonCode.MERGE_BASE_STALE, reason: "witness", unrecoverable: false,
    });
    expect(returned.allowed).toBe(false);
    expect(returned.reasonCode).toBe(ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH);
    const after = harness.cp.runs.require(driven.runId);
    expect(after.state).toBe(RunState.CEO_APPROVED);
    expect(after.revisionCount).toBe(before.revisionCount);
    expect(harness.cp.runs.currentCandidate(driven.runId)).toBe(driven.candidateSnapshotDigest);
    expect(harness.cp.ceo.currentCeoConfirmation(driven.runId, driven.candidateSnapshotDigest).allowed).toBe(true);
    // Not one record of the CEO_APPROVAL_INVALIDATED, CANDIDATE_INVALIDATED and two RUN_TRANSITIONs it wrote.
    expect(harness.cp.audit.forRun(driven.runId)).toHaveLength(auditBefore);
    expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(1);
  });

  it("the normal merge path is unchanged: one branch, one PR, one gate, one merge, COMPLETED, and no B5 record", async () => {
    const fixture = await approved();
    const { harness, driven, daemon } = fixture;
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    const writes = fixture.github.calls.filter((call) => call.method !== "GET");
    expect(writes.filter((call) => call.method === "POST" && /\/pulls$/.test(call.path))).toHaveLength(1);
    expect(writes.filter((call) => call.method === "POST" && call.path.endsWith("/check-runs"))).toHaveLength(1);
    expect(mergePuts(fixture)).toBe(1);
    expect(fixture.github.mergeCount).toBe(1);
    expect(transitions(fixture).slice(-4)).toEqual([
      [RunState.READY_FOR_CEO_REVIEW, RunState.CEO_APPROVED], [RunState.CEO_APPROVED, RunState.MERGING],
      [RunState.MERGING, RunState.POST_MERGE_VERIFYING], [RunState.POST_MERGE_VERIFYING, RunState.COMPLETED],
    ]);
    for (const kind of ["CEO_APPROVAL_INVALIDATED", "FINALIZATION_HANDED_OFF", "FINALIZATION_ATTEMPT_FAILED"]) {
      expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === kind), kind).toHaveLength(0);
    }
    await daemon.stop();
  });
});
