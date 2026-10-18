import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { GATE_CHECK_NAME, type GatePayload, gateExternalId, NO_HUMAN_GATE_DIGEST } from "../../src/github/github-kernel.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { FakeGitHub, type FakePull } from "../helpers/fake-github.ts";
import { humanGateBindingOf } from "../helpers/human-gate-binding.ts";
import {
  approveReviewedCandidateForFinalization,
  driveToReviewedCandidate,
  fixtureManifest,
  type Harness,
  makeHarness,
  ownerDecisionReceipt,
  TEST_OWNER,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * FINALIZER-DIGEST (CEO 7d7f2375, reproduced; corrected by FIX-FINALIZER-DIGEST, CEO 4b4317b0). A
 * human-gated run goes through the real daemon finalizer and the real GitHub kernel, with only GitHub
 * itself faked. The finalizer names the gate payload's `humanGateDigest` with
 * `ProductionGate.currentHumanGateDecisionDigest`; the kernel compares it, when it publishes and again
 * when it merges, with `ProductionGate.humanGateBinding`. Both answer from one resolver, whose binding
 * is the digest of the gate definition digest, the candidate and each item's authenticated decision.
 *
 * Before the correction the finalizer named one approval artifact's digest and the kernel expected the
 * definition digest, so no human-gated run could finalize: (a) was an expected failure (`it.fails`).
 *
 * FD-GATE (CEO ef7fa698). Once the owner decides again after a gate is published, the head carries a
 * gate for the binding that held and, after the next attempt, one for the binding that holds now. The
 * kernel selects only a gate that names the current binding exactly and passes every trust check
 * (creator, this repository's publication record, head); it never takes the first or the newest gate,
 * and with no current binding it takes none. Before that selection the stale gate was found first and
 * the head could never merge.
 */

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
const ITEMS = ["irreversible production action", "undelegated public release"] as const;

/** GitHub's merged pull retains its base snapshot; the target ref is reread separately. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") {
      return response;
    }
    const merged = response as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return response;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return response;
  };
};

/** Runs `effect` once, right after GitHub accepted the first production-gate check run. */
const afterFirstGatePublished = (github: FakeGitHub, effect: () => void): void => {
  const request = github.request.bind(github);
  let fired = false;
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (!fired && method === "POST" && /\/check-runs$/.test(path) && (body as { name?: unknown } | undefined)?.name === GATE_CHECK_NAME) {
      fired = true;
      effect();
    }
    return response;
  };
};

/** A squash is composed from the pull's commits: the opened pull carries the candidate commit as its one commit. */
const giveOpenedPullItsCommit = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method === "POST" && /\/pulls$/.test(path)) {
      github.setPullCommits((response as FakePull).number, [{ message: "make app() return 2\n" }]);
    }
    return response;
  };
};

/**
 * Runs `effect` on the first read of a single pull request after the `nth` production-gate check run was
 * accepted: in a daemon attempt, the read that opens the merge evaluation, after that gate's publication
 * was re-read and recorded. A returned pull replaces GitHub's answer for that one read.
 */
const atMergeAfterGate = (github: FakeGitHub, nth: number, effect: (pull: FakePull) => FakePull | void): void => {
  const request = github.request.bind(github);
  let gates = 0;
  let fired = false;
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method === "POST" && /\/check-runs$/.test(path) && (body as { name?: unknown } | undefined)?.name === GATE_CHECK_NAME) {
      gates += 1;
    } else if (!fired && gates === nth && method === "GET" && /\/pulls\/\d+$/.test(path)) {
      fired = true;
      return (effect(response as FakePull) ?? response) as T;
    }
    return response;
  };
};

/** The only owner-decision ingress ProductionGate counts: an admitted receipt for this exact decision. */
const recordOwnerDecision = (harness: Harness, runId: string, item: string, approved: boolean, note: string): void => {
  const recorded = harness.cp.ceo.recordOwnerDecision({
    runId,
    item,
    approved,
    note,
    receipt: ownerDecisionReceipt(harness, runId, item, approved, note),
  });
  if (!recorded.allowed) throw new Error(`${recorded.reasonCode}: ${recorded.message}`);
};

/** The real TTL prune: a later admission past the 24h replay window deletes the earlier ingress rows. */
const pruneIngress = (harness: Harness): void => {
  harness.clock.advance(24 * 60 * 60 * 1000 + 1);
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } });
  expect(guard.admit({ channel: "cli", actor: TEST_OWNER.actor, nonce: "after-the-window", payload: null }).allowed).toBe(true);
  expect(harness.cp.db.get("SELECT 1 FROM inbound_messages WHERE channel = 'cli' AND nonce != 'after-the-window'")).toBeUndefined();
};

/**
 * A reviewed candidate whose every human-gate item the owner approved (by default once each; `approve`
 * records them otherwise), then CEO CONFIRM.
 */
const approvedHumanGatedRun = async (
  options: {
    approve?: (harness: Harness, runId: string, items: readonly string[]) => void;
    prune?: boolean;
    /** FD-R1-RACE — the pinned profile with only its merge strategy moved to squash. */
    squash?: boolean;
  } = {},
) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  if (options.squash) giveOpenedPullItsCommit(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-finalizer-digest",
    humanGate: ITEMS,
    manifestOverrides: {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
      ...(options.squash ? { branchProfile: { ...fixtureManifest("strategy-probe").branchProfile, mergeStrategy: "squash" as const } } : {}),
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
    // Outlives the prune case's 24h aging, which is about ingress rows, not this branch lease.
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  });
  if (!claimed.allowed) throw new Error(claimed.message);

  const gate = harness.cp.ceo.humanGateStatus(driven.runId);
  expect(gate).toMatchObject({ required: true, items: [...ITEMS], satisfied: false });
  if (options.approve) options.approve(harness, driven.runId, gate.items);
  else for (const item of gate.items) recordOwnerDecision(harness, driven.runId, item, true, `approve ${item}`);
  expect(harness.cp.ceo.humanGateStatus(driven.runId).satisfied).toBe(true);
  const binding = harness.cp.ceo.currentHumanGateDecisionDigest(driven.runId);
  if (!binding.allowed) throw new Error(`${binding.reasonCode}: ${binding.message}`);
  if (options.prune) {
    pruneIngress(harness);
    expect(harness.cp.ceo.currentHumanGateDecisionDigest(driven.runId)).toMatchObject({ allowed: true, value: binding.value });
  }

  await approveReviewedCandidateForFinalization(harness, driven);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
  return { github, harness, driven, items: gate.items, binding: binding.value };
};

type Fixture = Awaited<ReturnType<typeof approvedHumanGatedRun>>;

/**
 * Daemon.start resumes the CEO_APPROVED run (one attempt); the explicit call is a second attempt and
 * reports its own decision, a replay once the first completed.
 */
const finalizeThroughDaemon = async (fixture: Fixture) => (await finalizeAttempts(fixture, 1))[0]!;

/** Daemon.start's resumed attempt, then `explicit` further attempts, each reporting its own decision. */
const finalizeAttempts = async (fixture: Fixture, explicit: number) => {
  const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-finalizer-digest-") });
  try {
    const started = await daemon.start();
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    const decisions = [];
    for (let attempt = 0; attempt < explicit; attempt += 1) {
      decisions.push(await daemon.finalizeApprovedRun(fixture.driven.runId));
    }
    return decisions;
  } finally {
    await daemon.stop();
  }
};

/**
 * FD-GATE — the merge the daemon finalizer asks for, requested of the kernel directly with the daemon's
 * own authority, on the run's one PR at the candidate head: the kernel's own answer, whatever the
 * finalizer would have done first.
 */
const directMerge = (fixture: Fixture) =>
  fixture.harness.cp.github.mergeExecute({
    runId: fixture.driven.runId,
    repositoryIdentity: fixture.driven.identity,
    pullNumber: fixture.github.pulls[0]!.number,
    exactHeadSha: fixture.driven.candidateHead,
    expectedBaseSha: fixture.driven.baseHead,
    mergeStrategy: "merge_commit",
    ownerSessionId: fixture.driven.ownerSessionId,
    ownerBindingGeneration: fixture.driven.ownerBindingGeneration,
    daemonFinalizerAuthority: fixture.harness.cp.daemonFinalizationAuthorities().write,
  });

/** Every production-gate check run GitHub holds on the candidate head, in the order it lists them. */
const gatesOnHead = (fixture: Fixture) =>
  fixture.github.checkRuns.filter((check) => check.name === GATE_CHECK_NAME && check.head_sha === fixture.driven.candidateHead);

const failedAttempts = (fixture: Fixture) =>
  fixture.harness.cp.audit.byKind("FINALIZATION_ATTEMPT_FAILED").map((event) => ({
    reasonCode: event.reasonCode,
    suppliedDigest: event.evidence["suppliedDigest"],
    expectedDigest: event.evidence["expectedDigest"],
  }));

const approveAgain = (fixture: Fixture): void =>
  recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[0]!, true, "approved again after publish");

/**
 * Every GitHub write the kernel sent that a merge depends on, in order: each gate publication by the
 * human-gate binding its payload names, and each merge PUT by the head it fences on.
 */
const writeLog = (fixture: Fixture): string[] =>
  fixture.github.calls.flatMap((call) => {
    if (call.method === "POST" && /\/check-runs$/.test(call.path)) {
      const body = call.body as { name?: string; output?: { text?: string } };
      return body.name === GATE_CHECK_NAME ? [`gate ${(JSON.parse(body.output!.text!) as GatePayload).humanGateDigest}`] : [];
    }
    return call.method === "PUT" && /\/pulls\/\d+\/merge$/.test(call.path) ? [`merge ${(call.body as { sha: string }).sha}`] : [];
  });

/** FD-R1-REDECIDE — GitHub lists the head's check runs newest first instead of in creation order. */
const listNewestFirst = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "GET" || !/\/commits\/[^/]+\/check-runs/.test(path)) return response;
    const listed = response as { check_runs?: unknown[] };
    return { ...listed, check_runs: [...(listed.check_runs ?? [])].reverse() } as T;
  };
};

/**
 * FD-R1-RACE — runs `change` once, during the last read the kernel awaits before its first merge PUT
 * could be sent, after the gate was selected and evaluated: the preflight's pull read for a merge
 * commit, the read of the commits a squash message is composed from for a squash.
 */
const duringMergePreparation = (fixture: Fixture, read: "preflight" | "squash commits", change: () => void): void => {
  const { github } = fixture;
  const request = github.request.bind(github);
  let gateSelected = false;
  let fired = false;
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "GET" || fired) return response;
    if (/\/commits\/[^/]+\/check-runs/.test(path) && fixture.harness.cp.runs.require(fixture.driven.runId).state === RunState.MERGING) {
      gateSelected = true;
    } else if (gateSelected && (read === "preflight" ? /\/pulls\/\d+$/ : /\/pulls\/\d+\/commits\?/).test(path)) {
      fired = true;
      change();
    }
    return response;
  };
};

const writes = (github: FakeGitHub) => ({
  gates: github.checkRuns.filter((check) => check.name === GATE_CHECK_NAME).length,
  merges: github.mergeCount,
});

/** Every gate payload the kernel recorded as published for this run, in order. */
const publishedPayloads = (fixture: Fixture): GatePayload[] =>
  fixture.harness.cp.db
    .all<{ response_json: string }>(
      `SELECT response_json FROM github_receipts WHERE operation = 'gate_publish' AND run_id = ? ORDER BY rowid`,
      [fixture.driven.runId],
    )
    .map((row) => (JSON.parse(row.response_json) as { payload: GatePayload }).payload);

/** The binding written out independently: the latest canonical owner decision of each item. */
const expectedBinding = (fixture: Fixture): string => {
  const decisions = fixture.harness.cp.artifacts
    .list<{ kind?: unknown; item?: unknown }>(fixture.driven.runId, ArtifactKind.APPROVAL)
    .filter((artifact) => artifact.content.kind === "OWNER_DECISION" && artifact.producedBy === "production-gate:owner-decision");
  return humanGateBindingOf({
    items: fixture.items,
    candidateSnapshotDigest: fixture.driven.candidateSnapshotDigest,
    decisions: fixture.items.map((item) => ({
      item,
      source: "OWNER_DECISION" as const,
      decision: decisions.filter((artifact) => artifact.content.item === item).at(-1)!.digest,
    })),
  });
};

const COMPLETED_ONCE = {
  allowed: true,
  reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY,
  state: RunState.COMPLETED,
  pulls: 1,
  gates: 1,
  merges: 1,
};

const outcomeOf = async (fixture: Fixture) => {
  const finalized = await finalizeThroughDaemon(fixture);
  return {
    allowed: finalized.allowed,
    reasonCode: finalized.reasonCode,
    state: fixture.harness.cp.runs.require(fixture.driven.runId).state,
    pulls: fixture.github.pulls.length,
    ...writes(fixture.github),
  };
};

describe("FINALIZER-DIGEST: the daemon finalizer and the kernel bind the same human-gate digest", () => {
  it("FINALIZER-DIGEST (a): a run whose owner approved every human-gate item finalizes through the daemon", async () => {
    const fixture = await approvedHumanGatedRun();
    // One binding: the finalizer's value, the kernel's port and the formula written out here.
    expect(fixture.binding).toBe(expectedBinding(fixture));
    expect(fixture.harness.cp.ceo.humanGateBinding(fixture.driven.runId)).toEqual({
      required: true,
      items: [...ITEMS],
      satisfied: true,
      humanGateDigest: fixture.binding,
    });
    expect(await outcomeOf(fixture)).toEqual(COMPLETED_ONCE);
    expect(publishedPayloads(fixture).map((payload) => payload.humanGateDigest)).toEqual([fixture.binding]);
  });

  it("FINALIZER-DIGEST (a): an item approved twice, and approvals whose ingress was pruned, still finalize on the latest canonical decisions", async () => {
    const twice = await approvedHumanGatedRun({
      approve: (harness, runId, items) => {
        recordOwnerDecision(harness, runId, items[0]!, true, "first approval");
        recordOwnerDecision(harness, runId, items[0]!, true, "approved again");
        recordOwnerDecision(harness, runId, items[1]!, true, "approve release");
      },
    });
    expect(twice.binding).toBe(expectedBinding(twice));
    expect(await outcomeOf(twice)).toEqual(COMPLETED_ONCE);

    const pruned = await approvedHumanGatedRun({ prune: true });
    expect(pruned.binding).toBe(expectedBinding(pruned));
    expect(await outcomeOf(pruned)).toEqual(COMPLETED_ONCE);
    expect(publishedPayloads(pruned).map((payload) => payload.humanGateDigest)).toEqual([pruned.binding]);
  });

  it("FINALIZER-DIGEST (b): an exactly bound owner refusal after CONFIRM keeps the run blocked at both layers", async () => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github, items } = fixture;
    // Bound exactly: the admitted receipt names this run, candidate and decision; the recorded
    // decision carries the current gate definition digest and the current candidate.
    recordOwnerDecision(harness, driven.runId, items[1]!, false, "withdraw release approval");
    expect(harness.cp.ceo.humanGateStatus(driven.runId).satisfied).toBe(false);
    expect(harness.cp.ceo.humanGateBinding(driven.runId)).toMatchObject({ satisfied: false, humanGateDigest: null });

    const finalized = await finalizeThroughDaemon(fixture);
    expect(finalized.allowed).toBe(false);
    expect(finalized.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(github.pulls).toHaveLength(0);
    expect(writes(github)).toEqual({ gates: 0, merges: 0 });

    // The kernel refuses on its own the binding that held at CONFIRM, as it would any other.
    const kernel = await harness.cp.github.gatePublish(
      {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        contractDigest: driven.contractDigest,
        verificationDigest: driven.verificationDigest,
        blindReviewDigest: driven.blindReviewDigest,
        humanGateDigest: fixture.binding,
        bindingGeneration: driven.ownerBindingGeneration,
        exactHead: driven.candidateHead,
        timestamp: harness.clock.nowIso(),
      },
      driven.identity,
      harness.cp.daemonFinalizationAuthorities().write,
    );
    expect(kernel.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(writes(github)).toEqual({ gates: 0, merges: 0 });
  });

  it.each([
    ["the canonical no-human-gate digest", () => NO_HUMAN_GATE_DIGEST],
    ["another gate definition's digest", () => digestOf(["some other gate item"])],
    // No fallback to the forms either side named before the correction.
    ["this gate's definition digest (the kernel's former value)", () => digestOf([...ITEMS])],
    ["one approval artifact's digest (the finalizer's former value)", (fixture: Fixture) =>
      fixture.harness.cp.artifacts.list(fixture.driven.runId, ArtifactKind.APPROVAL).map((artifact) => artifact.digest).sort()[0]!],
  ])("FINALIZER-DIGEST (c): the kernel refuses a satisfied run's payload carrying %s", async (_label, wrong) => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github } = fixture;
    // Only the value the finalizer reads is replaced; the owner approvals, the CEO CONFIRM, the
    // finalizer and the kernel are all real.
    vi.spyOn(harness.cp.ceo, "currentHumanGateDecisionDigest").mockReturnValue(allow(ReasonCode.OK, wrong(fixture)));

    const finalized = await finalizeThroughDaemon(fixture);
    expect(finalized.allowed).toBe(false);
    expect(finalized.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(writes(github)).toEqual({ gates: 0, merges: 0 });
  });

  it.each([
    ["the owner approves an item again", approveAgain, (fixture: Fixture): string | null => expectedBinding(fixture)],
    ["the owner refuses an item", (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[1]!, false, "refused after publish"), () => null],
  ])("FINALIZER-DIGEST (d) FD-GATE: a published binding is stale once %s; the merge evaluated with only that stale gate on the head is refused", async (_label, change, current) => {
    const fixture = await approvedHumanGatedRun();
    afterFirstGatePublished(fixture.github, () => change(fixture));
    let gatesWhenEvaluated: number | null = null;
    atMergeAfterGate(fixture.github, 1, () => {
      gatesWhenEvaluated = gatesOnHead(fixture).length;
    });

    // Daemon.start's sweep: the attempt in which the change happened, then the MERGING run's next attempt.
    await finalizeAttempts(fixture, 0);
    const now = current(fixture);
    expect(fixture.harness.cp.ceo.humanGateBinding(fixture.driven.runId).humanGateDigest).toBe(now);
    expect(now).not.toBe(fixture.binding);
    // The gate published before the change named the binding that then held, and it was the only gate on
    // the head when the merge that followed was evaluated; that merge was refused for naming it, against
    // the binding now (none after a refusal), and no merge was sent before another gate was published.
    expect(publishedPayloads(fixture)[0]?.humanGateDigest).toBe(fixture.binding);
    expect(gatesWhenEvaluated).toBe(1);
    expect(failedAttempts(fixture)[0]).toEqual(
      { reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, suppliedDigest: fixture.binding, expectedDigest: now },
    );
    expect(writeLog(fixture).slice(0, 2).filter((entry) => entry.startsWith("merge"))).toEqual([]);
    expect(fixture.github.pulls).toHaveLength(1);
  });

  it("FINALIZER-DIGEST (e): after an attempt that opened the PR and failed at the gate, the resumed finalization reuses that PR and completes", async () => {
    const fixture = await approvedHumanGatedRun();
    // The first attempt (Daemon.start's resume) names the former value, as the daemon before the
    // correction did: it opens the PR and the kernel refuses the gate.
    vi.spyOn(fixture.harness.cp.ceo, "currentHumanGateDecisionDigest").mockReturnValueOnce(allow(ReasonCode.OK, digestOf([...ITEMS])));

    const finalized = await finalizeThroughDaemon(fixture);
    expect({
      allowed: finalized.allowed,
      reasonCode: finalized.reasonCode,
      state: fixture.harness.cp.runs.require(fixture.driven.runId).state,
      pulls: fixture.github.pulls.length,
      opened: fixture.github.calls.filter((call) => call.method === "POST" && /\/pulls$/.test(call.path)).length,
      ...writes(fixture.github),
    }).toEqual({ allowed: true, reasonCode: ReasonCode.OK, state: RunState.COMPLETED, pulls: 1, opened: 1, gates: 1, merges: 1 });
    expect(fixture.harness.cp.audit.byKind("FINALIZATION_ATTEMPT_FAILED").map((event) => event.reasonCode)).toEqual([
      ReasonCode.HUMAN_GATE_UNSATISFIED,
    ]);
    expect(publishedPayloads(fixture).map((payload) => payload.humanGateDigest)).toEqual([fixture.binding]);
  });
});

/** The merge PUTs GitHub received: the PR each names and the head it fences on. */
const mergePuts = (fixture: Fixture) =>
  fixture.github.calls
    .filter((call) => call.method === "PUT" && /\/pulls\/\d+\/merge$/.test(call.path))
    .map((call) => ({ pull: Number(/\/pulls\/(\d+)\/merge$/.exec(call.path)![1]), sha: (call.body as { sha?: unknown }).sha }));

const stale = (fixture: Fixture, now: string | null) =>
  ({ reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, suppliedDigest: fixture.binding, expectedDigest: now });

describe("FD-GATE: after the owner decides again, the kernel merges on the gate that names the current binding, and only on it", () => {
  it.each([
    ["in creation order", (_github: FakeGitHub): void => undefined],
    // FD-R1-REDECIDE: the order-dependence the review reproduced. Before the selection, this order merged
    // and creation order did not.
    ["newest first", listNewestFirst],
  ])("FD-GATE (1): publish, the owner approves again (a new decision identity), a new gate is published, and the same PR and head merge normally, GitHub listing the head's gates %s", async (_order, order) => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github } = fixture;
    order(github);
    afterFirstGatePublished(github, () => approveAgain(fixture));
    let gatesWhenFirstEvaluated: number | null = null;
    atMergeAfterGate(github, 1, () => {
      gatesWhenFirstEvaluated = gatesOnHead(fixture).length;
    });

    const finalized = await finalizeThroughDaemon(fixture);
    const rebound = expectedBinding(fixture);
    expect(rebound).not.toBe(fixture.binding);
    expect({
      allowed: finalized.allowed,
      reasonCode: finalized.reasonCode,
      state: harness.cp.runs.require(driven.runId).state,
      pulls: github.pulls.length,
      opened: github.calls.filter((call) => call.method === "POST" && /\/pulls$/.test(call.path)).length,
      ...writes(github),
    }, JSON.stringify({ finalized, failed: failedAttempts(fixture) })).toEqual({
      allowed: true, reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY, state: RunState.COMPLETED, pulls: 1, opened: 1, gates: 2, merges: 1,
    });
    // Only the stale gate was on the head when the first attempt's merge was evaluated, and that merge was
    // refused; the next attempt published the new binding and merged the same PR at the same head on it.
    expect(gatesWhenFirstEvaluated).toBe(1);
    expect(failedAttempts(fixture)).toEqual([stale(fixture, rebound)]);
    expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`, `gate ${rebound}`, `merge ${driven.candidateHead}`]);
    expect(mergePuts(fixture)).toEqual([{ pull: github.pulls[0]!.number, sha: driven.candidateHead }]);
  });

  it("FD-GATE (2): an attempt that replays the new gate's publication selects that gate, not the stale one, and merges", async () => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github } = fixture;
    afterFirstGatePublished(github, () => approveAgain(fixture));
    // After the second gate is published, its attempt reads the pull once with a moved head: a refusal
    // before any merge, so the next attempt finds that gate's publication recorded and replays it.
    atMergeAfterGate(github, 2, (pull) => ({ ...pull, head: { ...pull.head, sha: "f".repeat(40) } }));

    const finalized = await finalizeThroughDaemon(fixture);
    expect({ allowed: finalized.allowed, reasonCode: finalized.reasonCode }, JSON.stringify({ finalized, failed: failedAttempts(fixture) }))
      .toEqual({ allowed: true, reasonCode: ReasonCode.OK });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(failedAttempts(fixture).map((failure) => failure.reasonCode)).toEqual([
      ReasonCode.HUMAN_GATE_UNSATISFIED,
      ReasonCode.MERGE_HEAD_STALE,
    ]);
    // Two publications, two receipts: the third attempt replayed the second's rather than publishing again.
    expect(publishedPayloads(fixture)).toHaveLength(2);
    expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`, `gate ${expectedBinding(fixture)}`, `merge ${driven.candidateHead}`]);
  });

  it("FD-GATE (3): a re-decision that refuses leaves no current binding: no new gate is published and the kernel does not fall back to the stale one", async () => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github, items } = fixture;
    afterFirstGatePublished(github, () => recordOwnerDecision(harness, driven.runId, items[1]!, false, "refused after publish"));

    const decisions = await finalizeAttempts(fixture, 1);
    expect(decisions.map((decision) => decision.reasonCode)).toEqual([ReasonCode.HUMAN_GATE_UNSATISFIED]);
    expect(failedAttempts(fixture)[0]).toEqual(stale(fixture, null));
    expect(harness.cp.ceo.humanGateBinding(driven.runId)).toMatchObject({ satisfied: false, humanGateDigest: null });
    // Asked directly, with the daemon's authority, on the same PR and head, the kernel refuses the only gate.
    const direct = await directMerge(fixture);
    expect({ allowed: direct.allowed, reasonCode: direct.reasonCode, evidence: direct.evidence })
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, evidence: { suppliedDigest: fixture.binding, expectedDigest: null } });
    expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
    expect(github.pulls).toHaveLength(1);
    expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`]);
  });

  it("FD-GATE (4): a gate that names the current binding but was created by another app is not selected, and neither is the stale gate", async () => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github } = fixture;
    afterFirstGatePublished(github, () => approveAgain(fixture));
    // The daemon's second gate, once published and re-read, is shown as another app's check run: every other
    // field, the recorded check run id and the payload digest included, is unchanged.
    atMergeAfterGate(github, 2, () => {
      gatesOnHead(fixture)[1]!.app = { slug: "candidate-ci" };
    });

    await finalizeAttempts(fixture, 0);
    const rebound = expectedBinding(fixture);
    expect(publishedPayloads(fixture).map((payload) => payload.humanGateDigest)).toEqual([fixture.binding, rebound]);
    expect(failedAttempts(fixture)).toEqual([stale(fixture, rebound), stale(fixture, rebound)]);
    expect(harness.cp.audit.byKind("GATE_REJECTED").some((event) =>
      event.reasonCode === ReasonCode.GATE_CREATOR_UNTRUSTED && event.evidence["creator"] === "candidate-ci")).toBe(true);
    const direct = await directMerge(fixture);
    expect({ allowed: direct.allowed, reasonCode: direct.reasonCode, evidence: direct.evidence })
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, evidence: { suppliedDigest: fixture.binding } });
    expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
    expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`, `gate ${rebound}`]);
  });

  it("FD-GATE (5): a trusted app's gate that names the current binding but whose publication record is another repository's is not selected", async () => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github } = fixture;
    afterFirstGatePublished(github, () => approveAgain(fixture));
    const otherRepository = "github:acme/other-fixture";
    const forgedId = 9_000_001;
    let forgedDigest = "";
    // GitHub now lists, in place of the gate the daemon published for this repository, a check run by the
    // trusted app naming a payload of the current binding, this head and this candidate, whose publication
    // the daemon recorded for another repository.
    atMergeAfterGate(github, 2, () => {
      const genuine = gatesOnHead(fixture)[1]!;
      github.checkRuns.splice(github.checkRuns.indexOf(genuine), 1);
      const payload: GatePayload = { ...publishedPayloads(fixture)[1]!, timestamp: "2026-08-13T00:00:00.000Z" };
      forgedDigest = digestOf(payload);
      const receiptId = `rcp_fd_gate_other_repository_${forgedId}`;
      harness.cp.db.run(
        `INSERT INTO github_receipts
           (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
            preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at,
            reread_at, verified, status)
         VALUES (?, ?, 'gate_publish', ?, ?, 'check_run', ?, 0, NULL, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
        [receiptId, `gate_publish:${otherRepository}:${payload.exactHead}:${forgedDigest}`, driven.runId, otherRepository,
          `acme/other-fixture@${payload.exactHead}/${GATE_CHECK_NAME}`, forgedDigest, harness.clock.nowIso()],
      );
      harness.cp.db.run(
        `UPDATE github_receipts SET status = 'APPLIED', after_state_digest = ?, response_json = ?, reread_at = ?, verified = 1
          WHERE receipt_id = ?`,
        [forgedDigest, JSON.stringify({ checkRunId: forgedId, payload, payloadDigest: forgedDigest }), harness.clock.nowIso(), receiptId],
      );
      github.checkRuns.push({
        ...genuine,
        id: forgedId,
        external_id: gateExternalId(payload.runId, payload.candidateSnapshotDigest, forgedDigest),
        output: { title: "Agent Control Plane production gate", summary: `payloadDigest=${forgedDigest}`, text: JSON.stringify(payload, null, 2) },
      });
    });

    await finalizeAttempts(fixture, 0);
    const rebound = expectedBinding(fixture);
    expect(forgedDigest).not.toBe("");
    expect(harness.cp.ceo.humanGateBinding(driven.runId).humanGateDigest).toBe(rebound);
    expect(failedAttempts(fixture)).toEqual([stale(fixture, rebound), stale(fixture, rebound)]);
    expect(harness.cp.audit.byKind("GATE_REJECTED").some((event) =>
      event.reasonCode === ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID && event.evidence["observedDigest"] === forgedDigest)).toBe(true);
    const direct = await directMerge(fixture);
    expect({ allowed: direct.allowed, reasonCode: direct.reasonCode, evidence: direct.evidence })
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, evidence: { suppliedDigest: fixture.binding } });
    expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
    expect(github.mergeCount).toBe(0);
  });
});

describe("FD-R1-RACE: a change while the kernel awaits its last read before the merge sends no merge on the binding it evaluated", () => {
  const changes = {
    refusal: (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[1]!, false, "refused during merge preparation"),
    "approval again": (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[0]!, true, "approved again during merge preparation"),
    "candidate replacement": (fixture: Fixture) =>
      fixture.harness.cp.runs.promoteCandidate(fixture.driven.runId, digestOf({ replacedDuringMergePreparation: true })),
  } as const;
  const strategies = [
    ["merge commit", false, "preflight"],
    ["squash", true, "squash commits"],
  ] as const;

  it("FD-R1-RACE control: with nothing changed, the squash strategy merges through the daemon as the merge-commit one does", async () => {
    const fixture = await approvedHumanGatedRun({ squash: true });
    expect(await outcomeOf(fixture)).toEqual(COMPLETED_ONCE);
    expect(fixture.github.calls.filter((call) => call.method === "PUT").map((call) => (call.body as { merge_method?: unknown }).merge_method))
      .toEqual(["squash"]);
  });

  it.each(strategies.flatMap(([strategy, squash, read]) =>
    (Object.keys(changes) as Array<keyof typeof changes>).map((change) => [strategy, change, squash, read] as const)))(
    "FD-R1-RACE %s: a %s during the merge's last awaited read sends no PUT for the evaluated binding",
    async (_strategy, change, squash, read) => {
      const fixture = await approvedHumanGatedRun({ squash });
      const { harness, driven, github } = fixture;
      let changed = false;
      duringMergePreparation(fixture, read, () => {
        changes[change](fixture);
        changed = true;
      });

      // Daemon.start's sweep: the attempt that saw the change, then the MERGING run's next attempt.
      await finalizeAttempts(fixture, 0);
      expect(changed).toBe(true);
      const failed = failedAttempts(fixture)[0];
      if (change === "approval again") {
        // The new binding merges, but only through its own gate, published by the next attempt.
        const rebound = expectedBinding(fixture);
        expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`, `gate ${rebound}`, `merge ${driven.candidateHead}`]);
        expect(failed).toEqual(stale(fixture, rebound));
        expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
      } else {
        expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`]);
        if (change === "refusal") expect(failed).toEqual(stale(fixture, null));
        else expect(failed?.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
        expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
      }
      expect(github.mergeCount).toBe(change === "approval again" ? 1 : 0);
    },
  );
});
