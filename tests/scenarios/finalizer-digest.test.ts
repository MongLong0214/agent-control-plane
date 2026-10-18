import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { GATE_CHECK_NAME, type GatePayload, NO_HUMAN_GATE_DIGEST } from "../../src/github/github-kernel.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { humanGateBindingOf } from "../helpers/human-gate-binding.ts";
import {
  approveReviewedCandidateForFinalization,
  driveToReviewedCandidate,
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
  options: { approve?: (harness: Harness, runId: string, items: readonly string[]) => void; prune?: boolean } = {},
) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-finalizer-digest",
    humanGate: ITEMS,
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
const finalizeThroughDaemon = async (fixture: Fixture) => {
  const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-finalizer-digest-") });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  const finalized = await daemon.finalizeApprovedRun(fixture.driven.runId);
  await daemon.stop();
  return finalized;
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
    ["the owner approves an item again", (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[0]!, true, "approved again after publish")],
    ["the owner refuses an item", (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[1]!, false, "refused after publish")],
  ])("FINALIZER-DIGEST (d): a published binding is stale once %s, and the kernel merges nothing", async (_label, change) => {
    const fixture = await approvedHumanGatedRun();
    afterFirstGatePublished(fixture.github, () => change(fixture));

    const finalized = await finalizeThroughDaemon(fixture);
    expect(finalized.allowed).toBe(false);
    expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).not.toBe(RunState.COMPLETED);
    expect(fixture.github.mergeCount).toBe(0);
    // The gate published before the change named the binding that then held; the merge that followed was
    // refused for naming it, and every attempt reused the one PR.
    expect(publishedPayloads(fixture)[0]?.humanGateDigest).toBe(fixture.binding);
    expect(fixture.harness.cp.ceo.currentHumanGateDecisionDigest(fixture.driven.runId)).not.toMatchObject({ value: fixture.binding });
    expect(fixture.harness.cp.audit.byKind("FINALIZATION_ATTEMPT_FAILED")[0]).toMatchObject({
      reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED,
      evidence: { suppliedDigest: fixture.binding },
    });
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
