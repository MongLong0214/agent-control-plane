import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { acpError, deny } from "../../src/core/errors.ts";
import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { FINALIZATION_RETRY_CAP, classifyPreMergeRefusal } from "../../src/daemon/finalizer.ts";
import { RunKind, RunState, Role, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { type Harness, driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 §0 — a CEO-approved run refused for its GitHub credential or the App's permissions used to be handed to
 * the owner with no retry and stay CEO_APPROVED with no deadline. Now the credential is retried within the
 * finalizer's cap and the grant re-checked once, each through the daemon's own credential store, and at the bound
 * the run ends FAILED with nothing merged and the CEO told once.
 */

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
const MINUTE = 60_000;
const CREDENTIAL = ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE;
const PERMISSION = ReasonCode.GITHUB_APP_PERMISSION_DENIED;
/** What no action text of these routes may ask of anyone. */
const ASKS_A_PERSON = /\b(log ?in|restore|approve)\b/i;
type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Hook = (method: HttpMethod, path: string, body?: unknown) => void;

const isMergePut = (method: HttpMethod, path: string): boolean => method === "PUT" && /\/pulls\/\d+\/merge$/.test(path);
/** prPrepare's open-pull query, which the kernel does not catch: a client throw reaches the finalizer with its code. */
const isOpenPullQuery = (method: HttpMethod, path: string): boolean => method === "GET" && /\/pulls\?head=/.test(path);

const approved = async (before?: Hook) => {
  const github = new FakeGitHub();
  const request = github.request.bind(github);
  github.request = async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    before?.(method, path, body);
    const response = await request<T>(method, path, body);
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
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/1189-credential",
    manifestOverrides: {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await harness.cp.continuity.evaluate("1189 credential packet");
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
  const daemon = newDaemon(harness);
  return { github, harness, driven, daemon };
};

type Fixture = Awaited<ReturnType<typeof approved>>;

/** The sweep is driven by hand; a timer firing mid-test would add attempts nobody asked for. */
const newDaemon = (harness: Harness): Daemon =>
  new Daemon(harness.cp, { stateDir: tempDir("acp-1189-credential-"), watchdogIntervalMs: 24 * 60 * MINUTE });

const auditOf = (fixture: Fixture, kind: string) =>
  fixture.harness.cp.audit.forRun(fixture.driven.runId).filter((entry) => entry.kind === kind);

const transitions = (fixture: Fixture): Array<[unknown, unknown]> =>
  auditOf(fixture, "RUN_TRANSITION").map((entry) => [entry.evidence.from, entry.evidence.to]);

const failedAttempts = (fixture: Fixture): number => auditOf(fixture, "FINALIZATION_ATTEMPT_FAILED").length;

const outboxOf = (fixture: Fixture, kind: string) =>
  fixture.harness.cp.db.all<{ target_session_id: string; payload_json: string }>(
    "SELECT target_session_id, payload_json FROM outbox WHERE run_id = ? AND kind = ? ORDER BY created_at, rowid",
    [fixture.driven.runId, kind],
  ).map((row) => ({ target: row.target_session_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));

const failureNotices = (fixture: Fixture) =>
  outboxOf(fixture, "CEO_NOTIFICATION").filter((notice) => notice.payload.notification === "CRITICAL_SYSTEM_FAILURE");

const mergeReceipts = (fixture: Fixture): string[] =>
  fixture.harness.cp.db.all<{ status: string }>(
    "SELECT status FROM github_receipts WHERE run_id = ? AND operation = 'merge_execute'",
    [fixture.driven.runId],
  ).map((row) => row.status);

/** Sweeps at each backoff step (1, 2, 4, 8, 16 minutes) and then a day of hourly sweeps. */
const sweepThroughTheCap = async (fixture: Fixture, daemon: Daemon = fixture.daemon): Promise<void> => {
  for (const delay of [1, 2, 4, 8, 16]) {
    fixture.harness.clock.advance(delay * MINUTE);
    await daemon.resumeApprovedRuns();
  }
  for (let sweep = 0; sweep < 24; sweep += 1) {
    fixture.harness.clock.advance(60 * MINUTE);
    await daemon.resumeApprovedRuns();
  }
};

/**
 * A daemon does not start while its credential is unreadable (its doctor's TRUSTED_GATE_CREDENTIAL_MISSING, which
 * this change leaves alone), so each outage here begins once a daemon has started: the loader reads normally while
 * one starts, and `unreadable()` decides on every later read.
 */
let starting = false;
const start = async (daemon: Daemon): Promise<boolean> => {
  starting = true;
  try {
    return (await daemon.start()).allowed;
  } finally {
    starting = false;
  }
};

/** The daemon's credential loader, unreadable while `unreadable()` holds and the real store's answer otherwise. */
const loaderWhile = (fixture: Fixture, unreadable: () => boolean) => {
  const store = fixture.harness.cp.credentials;
  const real = store.availability.bind(store);
  return vi.spyOn(store, "availability").mockImplementation(() => !starting && unreadable()
    ? deny(ReasonCode.GITHUB_APP_PRIVATE_KEY_UNREADABLE, "GitHub App private key is not readable", {})
    : real());
};

/** The daemon's permission probe, refused while `short()` holds: the App's grant does not cover the call. */
const grantWhile = (fixture: Fixture, short: () => boolean) => {
  const store = fixture.harness.cp.credentials;
  const real = store.authenticate.bind(store);
  return vi.spyOn(store, "authenticate").mockImplementation(async () =>
    short() ? deny(PERMISSION, "GitHub App permissions do not match any approved grant shape", {}) : real());
};

/** The GitHub client cannot obtain its credential: the open-pull query throws as the App client does. */
const credentialThrowWhile = (unavailable: () => boolean): Hook => (method, path) => {
  if (unavailable() && isOpenPullQuery(method, path)) {
    throw acpError(CREDENTIAL, "the trusted GitHub credential is not available", { operation: method });
  }
};

/** Nothing merged: no merge request, no merge receipt, no merge record, never past MERGING. */
const expectNothingMerged = (fixture: Fixture): void => {
  expect(fixture.github.mergeCount).toBe(0);
  expect(fixture.github.calls.filter((call) => isMergePut(call.method as HttpMethod, call.path))).toHaveLength(0);
  expect(mergeReceipts(fixture)).toEqual([]);
  expect(auditOf(fixture, "MERGE_EXECUTED")).toHaveLength(0);
  expect(transitions(fixture).some(([, to]) => to === RunState.POST_MERGE_VERIFYING || to === RunState.BLOCKED_POST_MERGE)).toBe(false);
};

/** Ended FAILED at the bound, from `from`, with the approval void and the CEO told exactly once. */
const expectEndedAtTheBound = (fixture: Fixture, input: {
  from: RunState; cause: ReasonCode; failureClass: string; failureRetryCap: number; refusals: number;
  /** Seeded by `seedLegacyHold`: its own exhausted record and owner hand-off precede this outcome. */
  legacy?: boolean;
}): void => {
  const { harness, driven } = fixture;
  const run = harness.cp.runs.require(driven.runId);
  expect(run.state).toBe(RunState.FAILED);
  expect(transitions(fixture).slice(-2)).toEqual([[input.from, RunState.REVISION_REQUIRED], [RunState.REVISION_REQUIRED, RunState.FAILED]]);
  const invalidated = auditOf(fixture, "CEO_APPROVAL_INVALIDATED");
  expect(invalidated).toHaveLength(1);
  expect(invalidated[0]!.evidence).toMatchObject({ disposition: "UNRECOVERABLE", candidateSnapshotDigest: driven.candidateSnapshotDigest });
  expect(harness.cp.runs.currentCandidate(driven.runId)).toBeNull();
  const prior = input.legacy === true ? 1 : 0;
  expect(auditOf(fixture, "FINALIZATION_RETRIES_EXHAUSTED")).toHaveLength(prior + 1);
  const exhausted = auditOf(fixture, "FINALIZATION_RETRIES_EXHAUSTED").slice(prior);
  expect(exhausted[0]!.evidence).toMatchObject({
    candidateSnapshotDigest: driven.candidateSnapshotDigest, failureCause: input.cause, failureClass: input.failureClass,
    refusals: input.refusals, failureRetryCap: input.failureRetryCap, retryCap: FINALIZATION_RETRY_CAP, limit: "FAILURE",
    outcome: "FAILED", merged: false,
  });
  expect(auditOf(fixture, "FINALIZATION_HANDED_OFF")).toHaveLength(prior);
  const notices = failureNotices(fixture);
  expect(notices).toHaveLength(1);
  expect(notices[0]!.target).toBe(harness.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId);
  const attemptIds = auditOf(fixture, "FINALIZATION_ATTEMPT_FAILED").map((entry) => entry.evidence.attemptId);
  expect(notices[0]!.payload).toMatchObject({
    runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest, failureCause: input.cause,
    failureClass: input.failureClass, owner: "CEO", limit: "FAILURE", outcome: "FAILED", merged: false,
    refusals: input.refusals, failureRetryCap: input.failureRetryCap, retryCap: FINALIZATION_RETRY_CAP,
    attempts: attemptIds, reason: expect.any(String), blocker: expect.any(String), evidence: expect.any(Object),
  });
  expect(String(notices[0]!.payload.action)).not.toMatch(ASKS_A_PERSON);
  // No owner route anywhere: not in a notice, not in a hand-off, not in a revision request.
  for (const notice of outboxOf(fixture, "CEO_NOTIFICATION")) expect(notice.payload.owner).not.toBe("OWNER");
  expect(outboxOf(fixture, "REVISION_REQUEST")).toHaveLength(0);
  expectNothingMerged(fixture);
};

/** The records the finalizer wrote at 50b267dd for its first refusal under one of these two reasons. */
const seedLegacyHold = (fixture: Fixture, reasonCode: ReasonCode, delivered: boolean): void => {
  const { harness, driven } = fixture;
  const attemptId = "finalize_legacyhold00000000000";
  const counted = {
    attemptId, candidateSnapshotDigest: driven.candidateSnapshotDigest, failureClass: "OWNER_ACTION", failureCause: reasonCode,
    refusals: 1, failureRetryCap: 0, retries: 0, retryCap: FINALIZATION_RETRY_CAP,
  };
  const legacyAction = reasonCode === CREDENTIAL
    ? "restore the daemon's GitHub App credential"
    : "restore the GitHub App's permissions to an owner-approved grant shape";
  harness.cp.audit.record({
    kind: "FINALIZATION_ATTEMPT_FAILED", runId: driven.runId, reasonCode,
    evidence: { attemptId, candidateSnapshotDigest: driven.candidateSnapshotDigest, disposition: "RETRY", failureClass: "OWNER_ACTION" },
  });
  harness.cp.audit.record({
    kind: "FINALIZATION_HANDED_OFF", runId: driven.runId, reasonCode,
    evidence: {
      ...counted, failureReasonCode: reasonCode, limit: "FAILURE", owner: "OWNER",
      action: `${legacyAction}. The daemon no longer retries this candidate automatically, a restart included`,
      blocker: `${reasonCode}: refused before this change`, reason: "refused before this change", delivered,
    },
  });
  harness.cp.audit.record({ kind: "FINALIZATION_RETRIES_EXHAUSTED", runId: driven.runId, reasonCode, evidence: { ...counted, limit: "FAILURE" } });
};

describe("#1189 §0 — an approved run never waits on a person for a GitHub credential or permission", () => {
  it("the route table: neither reason names the owner, asks anyone to act, or holds the run; HUMAN_GATE_UNSATISFIED stays the owner's", () => {
    const routeOf = (kind: RunKind, reasonCode: ReasonCode, thrown: boolean) => classifyPreMergeRefusal(kind, thrown
      ? deny(ReasonCode.INTERNAL_ERROR, "daemon finalization raised an unexpected error", { errorReasonCode: reasonCode })
      : deny(reasonCode, "refused", {}));
    for (const kind of Object.values(RunKind)) {
      for (const thrown of [false, true]) {
        const owners = Object.values(ReasonCode).filter((code) => {
          const route = routeOf(kind, code, thrown);
          return route.disposition === "RETRY" && route.owner === "OWNER";
        });
        expect(owners, `${kind} thrown=${thrown}`).toEqual([ReasonCode.HUMAN_GATE_UNSATISFIED]);
        expect(routeOf(kind, CREDENTIAL, thrown)).toMatchObject({
          disposition: "RETRY", failureClass: "TRANSIENT", failureCause: CREDENTIAL, retries: FINALIZATION_RETRY_CAP, owner: "CEO", endsAtCap: true,
        });
        expect(routeOf(kind, PERMISSION, thrown)).toMatchObject({
          disposition: "RETRY", failureClass: "UNCLASSIFIED", failureCause: PERMISSION, retries: 1, owner: "CEO", endsAtCap: true,
        });
        for (const code of [CREDENTIAL, PERMISSION]) {
          const route = routeOf(kind, code, thrown);
          if (route.disposition !== "RETRY") throw new Error("not a retry");
          expect(route.action).not.toMatch(ASKS_A_PERSON);
        }
        // Unchanged: the PRD §21 human gate, and the two CEO routes.
        expect(routeOf(kind, ReasonCode.HUMAN_GATE_UNSATISFIED, thrown)).toEqual({
          disposition: "RETRY", failureClass: "OWNER_ACTION", failureCause: ReasonCode.HUMAN_GATE_UNSATISFIED, retries: 0, owner: "OWNER",
          action: "record the owner decision the run's human gate requires for this candidate",
        });
        expect(routeOf(kind, ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, thrown)).toEqual({
          disposition: "RETRY", failureClass: "OWNER_ACTION", failureCause: ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, retries: 0,
          owner: "CEO", action: "re-enter with a CONFIRM of the same candidate",
        });
        expect(routeOf(kind, ReasonCode.MERGE_CLAIM_INVALID, thrown)).toMatchObject({
          disposition: "RETRY", failureClass: "AUTHORITY_RECOVERY", failureCause: ReasonCode.MERGE_CLAIM_INVALID, retries: 0, owner: "CEO",
        });
        expect(routeOf(kind, ReasonCode.MERGE_CLAIM_INVALID, thrown)).not.toHaveProperty("endsAtCap");
      }
    }
  });

  it("credential unavailable, then available: each retry re-reads it through the daemon's loader first, and the run merges", async () => {
    let unavailable = true;
    const fixture = await approved(credentialThrowWhile(() => unavailable));
    const { harness, driven, daemon } = fixture;
    const loader = loaderWhile(fixture, () => unavailable);
    expect(await start(daemon)).toBe(true);
    const first = auditOf(fixture, "FINALIZATION_ATTEMPT_FAILED");
    expect(first).toHaveLength(1);
    expect(first[0]!.evidence).toMatchObject({ errorReasonCode: CREDENTIAL, disposition: "RETRY", failureClass: "TRANSIENT" });
    expect(auditOf(fixture, "FINALIZATION_RETRY_SCHEDULED").map((entry) => entry.evidence)).toEqual([
      expect.objectContaining({ failureCause: CREDENTIAL, refusals: 1, failureRetryCap: FINALIZATION_RETRY_CAP, retries: 0 }),
    ]);
    expect(auditOf(fixture, "FINALIZATION_HANDED_OFF")).toHaveLength(0);

    // Still unreadable at the first retry: the loader says so before anything is sent to GitHub.
    let reads = loader.mock.calls.length;
    const calls = fixture.github.calls.length;
    harness.clock.advance(MINUTE);
    await daemon.resumeApprovedRuns();
    expect(loader.mock.calls.length - reads).toBe(1);
    expect(fixture.github.calls.length).toBe(calls);
    const second = auditOf(fixture, "FINALIZATION_ATTEMPT_FAILED").at(-1)!;
    expect(second.reasonCode).toBe(CREDENTIAL);
    expect(second.evidence).toMatchObject({ loaderReasonCode: ReasonCode.GITHUB_APP_PRIVATE_KEY_UNREADABLE, disposition: "RETRY" });

    // Readable again: the next retry re-reads it, and the run merges once.
    unavailable = false;
    reads = loader.mock.calls.length;
    harness.clock.advance(2 * MINUTE);
    await daemon.resumeApprovedRuns();
    expect(loader.mock.calls.length - reads).toBe(1);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(fixture.github.mergeCount).toBe(1);
    expect(failedAttempts(fixture)).toBe(2);
    expect(failureNotices(fixture)).toHaveLength(0);
    expect(transitions(fixture).some(([, to]) => to === RunState.FAILED || to === RunState.REVISION_REQUIRED)).toBe(false);
    await daemon.stop();
  });

  it("the re-read goes only through the daemon's own trusted store, for the same target: no other credential, no widened grant", async () => {
    let unavailable = true;
    const fixture = await approved(credentialThrowWhile(() => unavailable));
    const { harness, driven, daemon } = fixture;
    const store = harness.cp.credentials;
    const loader = loaderWhile(fixture, () => unavailable);
    const install = vi.spyOn(store, "install");
    expect(await start(daemon)).toBe(true);
    unavailable = false;
    const reads = loader.mock.calls.length;
    harness.clock.advance(MINUTE);
    await daemon.resumeApprovedRuns();
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    // The re-read is the store the kernel holds, asked again; nothing installs, swaps or adds a credential.
    expect(loader.mock.calls.length - reads).toBe(1);
    expect(loader.mock.contexts.every((context) => context === store)).toBe(true);
    expect(install).not.toHaveBeenCalled();
    // The retry addresses the same repository as the refused attempt, and merges into the one the run declares.
    const repositories = new Set(fixture.github.calls.map((call) => /^\/repos\/([^/]+\/[^/?]+)/.exec(call.path)?.[1]).filter(Boolean));
    expect(repositories.size).toBe(1);
    expect(auditOf(fixture, "MERGE_EXECUTED").map((entry) => entry.evidence.repositoryIdentity)).toEqual([driven.identity]);
    // The finalizer reaches credentials only through the daemon's store: its loader and its permission probe.
    const source = readFileSync(join(process.cwd(), "src/daemon/finalizer.ts"), "utf8");
    expect(new Set([...source.matchAll(/this\.cp\.credentials\.(\w+)/g)].map((match) => match[1]))).toEqual(new Set(["availability", "authenticate"]));
    expect(source).not.toMatch(/TrustedCredentialStore|\.install\(|credentials\s*=/);
    await daemon.stop();
  });

  it("credential unavailable through the cap: the run ends FAILED with one CEO notice, no owner route, and nothing merged", async () => {
    const fixture = await approved(credentialThrowWhile(() => true));
    const loader = loaderWhile(fixture, () => true);
    expect(await start(fixture.daemon)).toBe(true);
    const reads = loader.mock.calls.length;
    await sweepThroughTheCap(fixture);
    expect(failedAttempts(fixture)).toBe(FINALIZATION_RETRY_CAP + 1);
    // Every retry re-read the credential first, and none after the bound.
    expect(loader.mock.calls.length - reads).toBe(FINALIZATION_RETRY_CAP);
    expect(auditOf(fixture, "FINALIZATION_RETRY_SCHEDULED").map((entry) => entry.evidence.refusals)).toEqual([1, 2, 3, 4, 5]);
    expectEndedAtTheBound(fixture, {
      from: RunState.CEO_APPROVED, cause: CREDENTIAL, failureClass: "TRANSIENT", failureRetryCap: FINALIZATION_RETRY_CAP, refusals: 6,
    });
    await fixture.daemon.stop();
  });

  it("permission denied: the grant is re-checked once through the permission probe, then the run ends FAILED; never retried beyond it", async () => {
    const fixture = await approved();
    const probe = grantWhile(fixture, () => true);
    expect(await start(fixture.daemon)).toBe(true);
    // The first refusal is the gate publication's own probe of the grant.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(auditOf(fixture, "FINALIZATION_RETRY_SCHEDULED").map((entry) => entry.evidence)).toEqual([
      expect.objectContaining({ failureCause: PERMISSION, refusals: 1, failureRetryCap: 1 }),
    ]);
    const calls = fixture.github.calls.length;
    await sweepThroughTheCap(fixture);
    // One re-check, before anything is sent to GitHub; the run then ends.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(fixture.github.calls.length).toBe(calls);
    expect(failedAttempts(fixture)).toBe(2);
    expectEndedAtTheBound(fixture, {
      from: RunState.CEO_APPROVED, cause: PERMISSION, failureClass: "UNCLASSIFIED", failureRetryCap: 1, refusals: 2,
    });
    await fixture.daemon.stop();
  });

  it("permission denied, then the grant covers the call at its one re-check: the run merges", async () => {
    let short = true;
    const fixture = await approved();
    const probe = grantWhile(fixture, () => short);
    expect(await start(fixture.daemon)).toBe(true);
    short = false;
    fixture.harness.clock.advance(MINUTE);
    await fixture.daemon.resumeApprovedRuns();
    expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.COMPLETED);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.github.mergeCount).toBe(1);
    expect(failureNotices(fixture)).toHaveLength(0);
    await fixture.daemon.stop();
  });

  it.each([
    ["credential", CREDENTIAL, FINALIZATION_RETRY_CAP + 1],
    ["permission", PERMISSION, 2],
  ] as const)("%s: a restart does not refill the budget; the refusals before it count toward the same bound", async (_name, reasonCode, total) => {
    const fixture = await approved(reasonCode === CREDENTIAL ? credentialThrowWhile(() => true) : undefined);
    if (reasonCode === CREDENTIAL) loaderWhile(fixture, () => true);
    else grantWhile(fixture, () => true);
    expect(await start(fixture.daemon)).toBe(true);
    // Part of the budget is used before the restart.
    const before = reasonCode === CREDENTIAL ? [1, 2] : [];
    for (const delay of before) {
      fixture.harness.clock.advance(delay * MINUTE);
      await fixture.daemon.resumeApprovedRuns();
    }
    expect(failedAttempts(fixture)).toBe(1 + before.length);
    await fixture.daemon.stop();
    const restarted = newDaemon(fixture.harness);
    expect(await start(restarted)).toBe(true);
    await sweepThroughTheCap(fixture, restarted);
    expect(failedAttempts(fixture)).toBe(total);
    const counts = [...auditOf(fixture, "FINALIZATION_RETRY_SCHEDULED"), ...auditOf(fixture, "FINALIZATION_RETRIES_EXHAUSTED")]
      .map((entry) => entry.evidence.refusals);
    expect(counts).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.FAILED);
    expect(failureNotices(fixture)).toHaveLength(1);
    await restarted.stop();
  });

  it.each([
    ["credential", CREDENTIAL],
    ["permission", PERMISSION],
  ] as const)("%s refused while a sent merge's outcome is unknown: the run stays on the readback and settlement path, never FAILED", async (_name, reasonCode) => {
    let failWith: ReasonCode | null = null;
    let fixture: Fixture | null = null;
    fixture = await approved((method, path, body) => {
      if (failWith !== null) throw acpError(failWith, "GitHub credential refused", { operation: method });
      if (isMergePut(method, path)) {
        fixture!.github.calls.push({ method, path, body });
        failWith = reasonCode;
        throw acpError(ReasonCode.PROBE_FAILED, "GitHub App API request failed", { operation: method, status: 502 });
      }
    });
    const { harness, driven, daemon } = fixture;
    expect(await start(daemon)).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
    expect(mergeReceipts(fixture)).toEqual(["PENDING"]);
    await sweepThroughTheCap(fixture);
    const refused = auditOf(fixture, "FINALIZATION_ATTEMPT_FAILED");
    expect(refused.length).toBeGreaterThan(1);
    expect(refused.every((entry) => entry.evidence.failureClass === "MERGE_OUTCOME_UNKNOWN")).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.MERGING);
    expect(mergeReceipts(fixture)).toEqual(["PENDING"]);
    expect(transitions(fixture).some(([, to]) => to === RunState.FAILED || to === RunState.REVISION_REQUIRED)).toBe(false);
    expect(auditOf(fixture, "CEO_APPROVAL_INVALIDATED")).toHaveLength(0);
    expect(auditOf(fixture, "FINALIZATION_RETRIES_EXHAUSTED").map((entry) => entry.evidence.outcome)).not.toContain("FAILED");
    expect(fixture.github.mergeCount).toBe(0);
    await daemon.stop();
  });

  it("a run that ended FAILED at the bound stays terminal: sweeps, a restart and an explicit finalization reopen nothing", async () => {
    let unavailable = true;
    const fixture = await approved(credentialThrowWhile(() => unavailable));
    loaderWhile(fixture, () => unavailable);
    expect(await start(fixture.daemon)).toBe(true);
    await sweepThroughTheCap(fixture);
    expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.FAILED);
    const calls = fixture.github.calls.length;
    const attempts = failedAttempts(fixture);
    const finalizationRecords = () =>
      fixture.harness.cp.audit.forRun(fixture.driven.runId).filter((entry) => entry.kind.startsWith("FINALIZATION_")).length;
    const records = finalizationRecords();
    // The credential is back; nothing about the run changes.
    unavailable = false;
    await fixture.daemon.stop();
    const restarted = newDaemon(fixture.harness);
    expect(await start(restarted)).toBe(true);
    await sweepThroughTheCap(fixture, restarted);
    const explicit = await restarted.finalizeApprovedRun(fixture.driven.runId);
    expect(explicit.allowed).toBe(false);
    expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.FAILED);
    expect(fixture.github.calls.length).toBe(calls);
    expect(failedAttempts(fixture)).toBe(attempts);
    expect(auditOf(fixture, "FINALIZATION_ATTEMPT_ACQUIRED")).toHaveLength(attempts);
    expect(finalizationRecords()).toBe(records);
    expect(failureNotices(fixture)).toHaveLength(1);
    expectNothingMerged(fixture);
    await restarted.stop();
  });

  describe("a run held CEO_APPROVED under one of these reasons before this change is picked up after a restart", () => {
    it("credential: retried through the ordinary path with its approval re-confirmed, merged, and the old owner hand-off never sent", async () => {
      const fixture = await approved();
      const { harness, driven } = fixture;
      seedLegacyHold(fixture, CREDENTIAL, false);
      const confirmation = vi.spyOn(harness.cp.ceo, "currentCeoConfirmation");
      expect(await start(fixture.daemon)).toBe(true);
      expect(confirmation).toHaveBeenCalledWith(driven.runId, driven.candidateSnapshotDigest);
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
      expect(fixture.github.mergeCount).toBe(1);
      expect(fixture.github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/check-runs"))).toHaveLength(1);
      for (const notice of outboxOf(fixture, "CEO_NOTIFICATION")) expect(notice.payload.owner).not.toBe("OWNER");
      await fixture.daemon.stop();
    });

    it("credential, owed hand-off: between retries the old owner notice is not delivered", async () => {
      const fixture = await approved(credentialThrowWhile(() => true));
      seedLegacyHold(fixture, CREDENTIAL, false);
      loaderWhile(fixture, () => true);
      expect(await start(fixture.daemon)).toBe(true);
      expect(failedAttempts(fixture)).toBe(2);
      for (let sweep = 0; sweep < 3; sweep += 1) {
        fixture.harness.clock.advance(10_000);
        await fixture.daemon.resumeApprovedRuns();
      }
      expect(failureNotices(fixture)).toHaveLength(0);
      // The refusal before the change counts: the bound is not refilled for the held run.
      await sweepThroughTheCap(fixture);
      expect(failedAttempts(fixture)).toBe(FINALIZATION_RETRY_CAP + 1);
      expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.FAILED);
      expect(failureNotices(fixture)).toHaveLength(1);
      for (const notice of outboxOf(fixture, "CEO_NOTIFICATION")) expect(notice.payload.owner).not.toBe("OWNER");
      await fixture.daemon.stop();
    });

    it("permission still denied: its one re-check after the restart, then FAILED with one CEO notice", async () => {
      const fixture = await approved();
      seedLegacyHold(fixture, PERMISSION, true);
      const probe = grantWhile(fixture, () => true);
      expect(await start(fixture.daemon)).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(failedAttempts(fixture)).toBe(2);
      expectEndedAtTheBound(fixture, {
        from: RunState.CEO_APPROVED, cause: PERMISSION, failureClass: "UNCLASSIFIED", failureRetryCap: 1, refusals: 2, legacy: true,
      });
      await fixture.daemon.stop();
    });

    it("the claim check is not skipped: a held run whose branch claim is gone is refused for it, and nothing merges", async () => {
      const fixture = await approved();
      const { harness, driven } = fixture;
      seedLegacyHold(fixture, CREDENTIAL, true);
      for (const claim of harness.cp.db.all<{ claim_id: string }>("SELECT claim_id FROM resource_claims WHERE run_id = ? AND status = 'HELD'", [driven.runId])) {
        expect(harness.cp.claims.release(claim.claim_id, driven.runId).allowed).toBe(true);
      }
      expect(await start(fixture.daemon)).toBe(true);
      const refused = auditOf(fixture, "FINALIZATION_ATTEMPT_FAILED").at(-1)!;
      expect(refused.reasonCode).toBe(ReasonCode.MERGE_CLAIM_INVALID);
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
      expectNothingMerged(fixture);
      await fixture.daemon.stop();
    });
  });
});
