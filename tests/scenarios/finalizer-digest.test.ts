import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { GATE_CHECK_NAME, GitHubAppClient, type GatePayload, gateExternalId, NO_HUMAN_GATE_DIGEST } from "../../src/github/github-kernel.ts";
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

  // The (d) case keeps its round-1 name as the describe, so the selector `FINALIZER-DIGEST \(d\):` still
  // collects these witnesses, and `FINALIZER-DIGEST \(d\) FD-GATE` (their FD-GATE name) does too.
  describe("FINALIZER-DIGEST (d): a published binding is stale once the owner decides again", () => {
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

/**
 * FD-R2 (FD-R1-RACE, ROUND1-ESCAPE-PUBLISH) — the production transport between the kernel and GitHub:
 * the real TrustedCredentialStore and GitHubAppClient, wired into the kernel in place of the test
 * client, with GitHub answering behind a fake fetch, the HTTP boundary (FakeGitHub supplies the
 * answers). The store awaits its installation token after the kernel's own last check, so a decision
 * or a candidate can land during that await.
 *
 * `events` records, in order: each token refresh, each answer of the check the transport runs before
 * a dispatch ("verified" or "refused <reason>"), and each gate POST and merge PUT dispatched.
 * `staleWrites` records each of those writes whose payload no longer names the current binding and
 * candidate when it is dispatched.
 */
const realTransport = async (fixture: Fixture) => {
  const { harness, driven, github } = fixture;
  const root = tempDir("acp-fd-r2-transport-");
  const credentialDir = join(root, "credentials");
  mkdirSync(credentialDir, { mode: 0o700 });
  const keyPath = join(credentialDir, "github-app.private-key.pem");
  writeFileSync(keyPath, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  const envFile = join(credentialDir, "github-app.env");
  writeFileSync(envFile, `GITHUB_APP_ID=4586878\nGITHUB_APP_INSTALLATION_ID=153553922\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\n`, { mode: 0o600 });
  let now = Date.parse("2026-08-14T00:00:00.000Z");
  let duringRefresh: (() => void | Promise<void>) | null = null;
  const atRequest: Array<{ method: string; path: RegExp; run: () => void }> = [];
  const unanswered = new Set<string>();
  const events: string[] = [];
  const staleWrites: Array<Record<string, unknown>> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/app") {
      const change = duringRefresh;
      duringRefresh = null;
      if (change) {
        events.push("token refresh");
        await Promise.resolve();
        await change();
      }
      return new Response(JSON.stringify({ slug: "acp-trusted-app", permissions: {
        checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write",
      } }), { status: 200 });
    }
    if (url.pathname.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "fd-r2-installation-token", expires_at: new Date(now + 3_600_000).toISOString() }), { status: 201 });
    }
    const method = (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    const write = method === "PUT" && /\/pulls\/\d+\/merge$/.test(url.pathname) ? "merge PUT"
      : method === "POST" && /\/check-runs$/.test(url.pathname) && (body as { name?: unknown }).name === GATE_CHECK_NAME ? "gate POST"
        : null;
    if (write) {
      events.push(write);
      // What the write rests on: the payload it publishes, or, for the merge, the last one published.
      const payload = write === "gate POST"
        ? JSON.parse((body as { output: { text: string } }).output.text) as GatePayload
        : publishedPayloads(fixture).at(-1)!;
      const current = {
        binding: harness.cp.ceo.humanGateBinding(driven.runId).humanGateDigest,
        candidate: harness.cp.runs.currentCandidate(driven.runId),
      };
      if (payload.humanGateDigest !== current.binding || payload.candidateSnapshotDigest !== current.candidate) {
        staleWrites.push({ write, payloadBinding: payload.humanGateDigest, payloadCandidate: payload.candidateSnapshotDigest, ...current });
      }
      if (unanswered.delete(write)) throw new TypeError("fetch failed: the connection closed before GitHub answered");
    }
    const response = await github.request(method, url.pathname + url.search, body);
    return new Response(JSON.stringify(response), { status: method === "POST" ? 201 : 200 });
  };
  const store = new TrustedCredentialStore(join(root, "secrets"), { appEnvFile: envFile, fetch, now: () => now });
  expect((await store.authenticate()).allowed).toBe(true);
  const githubApi = store.githubApi.bind(store);
  store.githubApi = (options) => {
    const armed = atRequest.findIndex((entry) => entry.method === options.method && entry.path.test(options.path));
    if (armed >= 0) atRequest.splice(armed, 1)[0]!.run();
    return githubApi(options.beforeDispatch === undefined ? options : {
    ...options,
    beforeDispatch: () => {
      const verified = options.beforeDispatch!();
      events.push(verified.allowed ? "verified" : `refused ${verified.reasonCode}`);
      return verified;
    },
    });
  };
  Object.assign(harness.cp.github, { credentials: store, client: new GitHubAppClient(store) });
  return {
    events,
    staleWrites,
    /** The token expires now; `change` lands while the store mints the next one, after the kernel's last check. */
    expireTokenThen: (change: () => void | Promise<void>): void => {
      now += 2 * 3_600_000;
      duringRefresh = change;
    },
    /** `run` runs once, when the kernel hands the transport its next request with this method and path. */
    atNextRequest: (method: "POST" | "PUT", path: RegExp, run: () => void): void => {
      atRequest.push({ method, path, run });
    },
    /** The next dispatched write of this kind reaches nothing and is not answered, as a dropped connection. */
    dropNext: (write: "gate POST" | "merge PUT"): void => {
      unanswered.add(write);
    },
  };
};

/** The events other than the transport's checks: what the first process did before it stopped. */
const withoutChecks = (events: readonly string[]): string[] =>
  events.filter((event) => event !== "verified" && !event.startsWith("refused "));

/** Each gate POST and merge PUT dispatched, named with the event right before it. */
const dispatchedAfter = (events: readonly string[]): string[] =>
  events.flatMap((event, index) => (event === "gate POST" || event === "merge PUT" ? [`${events[index - 1]} -> ${event}`] : []));

/** Runs `change` once, right after the kernel's first payload check returns: the gate publication's own. */
const afterPublicationCheck = (fixture: Fixture, change: () => void): void => {
  const kernel = fixture.harness.cp.github as unknown as { assertGatePayloadBacked: (...args: unknown[]) => unknown };
  const check = kernel.assertGatePayloadBacked.bind(kernel);
  let fired = false;
  kernel.assertGatePayloadBacked = (...args: unknown[]) => {
    const result = check(...args);
    if (!fired) {
      fired = true;
      change();
    }
    return result;
  };
};

describe("FD-R2: the transport checks the gate payload again once it holds its installation token, immediately before it sends", () => {
  const changes = {
    refusal: (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[1]!, false, "refused during the token refresh"),
    "approval again": (fixture: Fixture) =>
      recordOwnerDecision(fixture.harness, fixture.driven.runId, fixture.items[0]!, true, "approved again during the token refresh"),
    "candidate replacement": (fixture: Fixture) =>
      fixture.harness.cp.runs.promoteCandidate(fixture.driven.runId, digestOf({ replacedDuringTokenRefresh: true })),
  } as const;
  const refusedFor = {
    refusal: ReasonCode.HUMAN_GATE_UNSATISFIED,
    "approval again": ReasonCode.HUMAN_GATE_UNSATISFIED,
    "candidate replacement": ReasonCode.SNAPSHOT_STALE,
  } as const;
  const strategies = [
    ["merge commit", false, "preflight"],
    ["squash", true, "squash commits"],
  ] as const;

  it.each(strategies)(
    "FD-R2 control %s: the token expires during the merge's last awaited read and nothing changes; the run merges once",
    async (_strategy, squash, read) => {
      const fixture = await approvedHumanGatedRun({ squash });
      const transport = await realTransport(fixture);
      duringMergePreparation(fixture, read, () => transport.expireTokenThen(() => undefined));

      expect(await outcomeOf(fixture)).toEqual(COMPLETED_ONCE);
      expect(transport.events).toContain("token refresh");
      expect(transport.staleWrites).toEqual([]);
    },
  );

  it.each(strategies)(
    "FD-R2 every send %s: each gate POST and merge PUT leaves right after the transport's check of its payload, the refreshed token's PUT included",
    async (_strategy, squash, read) => {
      const fixture = await approvedHumanGatedRun({ squash });
      const transport = await realTransport(fixture);
      duringMergePreparation(fixture, read, () => transport.expireTokenThen(() => undefined));

      expect(await outcomeOf(fixture)).toEqual(COMPLETED_ONCE);
      expect(dispatchedAfter(transport.events)).toEqual(["verified -> gate POST", "verified -> merge PUT"]);
      expect(transport.events.slice(-3)).toEqual(["token refresh", "verified", "merge PUT"]);
    },
  );

  it.each(strategies.flatMap(([strategy, squash, read]) =>
    (Object.keys(changes) as Array<keyof typeof changes>).map((change) => [strategy, change, squash, read] as const)))(
    "FD-R2 %s: a %s while the transport refreshes its token after the kernel's last check sends no PUT for the evaluated binding",
    async (_strategy, change, squash, read) => {
      const fixture = await approvedHumanGatedRun({ squash });
      const { harness, driven, github } = fixture;
      const transport = await realTransport(fixture);
      let changed = false;
      duringMergePreparation(fixture, read, () => transport.expireTokenThen(() => {
        changes[change](fixture);
        changed = true;
      }));

      // Daemon.start's sweep: the attempt whose PUT waited on the token, then the MERGING run's next attempt.
      await finalizeAttempts(fixture, 0);
      expect(changed).toBe(true);
      expect(transport.staleWrites).toEqual([]);
      // The change landed during the refresh; the check the transport ran once it held the token refused,
      // and that attempt sent nothing.
      const refresh = transport.events.indexOf("token refresh");
      expect(transport.events.slice(refresh, refresh + 2)).toEqual(["token refresh", `refused ${refusedFor[change]}`]);
      const failed = failedAttempts(fixture)[0];
      if (change === "approval again") {
        // The legitimate next attempt publishes the new binding and merges on it, each write checked as it leaves.
        const rebound = expectedBinding(fixture);
        expect(writeLog(fixture)).toEqual([`gate ${fixture.binding}`, `gate ${rebound}`, `merge ${driven.candidateHead}`]);
        expect(dispatchedAfter(transport.events)).toEqual(["verified -> gate POST", "verified -> gate POST", "verified -> merge PUT"]);
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

  const publicationWindows = [
    // The review's witness: the store answers from its cached token, and that await is the window.
    ["while the store awaits its cached token", (_transport: Awaited<ReturnType<typeof realTransport>>, change: () => void) => queueMicrotask(change)],
    ["while the store refreshes its token", (transport: Awaited<ReturnType<typeof realTransport>>, change: () => void) => transport.expireTokenThen(change)],
  ] as const;

  it.each(publicationWindows)(
    "FD-R2 publication control: nothing changes %s after the kernel's publication check; the gate is published and the run merges once",
    async (_window, arrange) => {
      const fixture = await approvedHumanGatedRun();
      const transport = await realTransport(fixture);
      let ran = false;
      afterPublicationCheck(fixture, () => arrange(transport, () => {
        ran = true;
      }));

      expect(await outcomeOf(fixture)).toEqual(COMPLETED_ONCE);
      expect(ran).toBe(true);
      expect(transport.staleWrites).toEqual([]);
    },
  );

  it.each(publicationWindows)(
    "FD-R2 publication: an owner refusal %s after the kernel's publication check sends no gate POST",
    async (_window, arrange) => {
      const fixture = await approvedHumanGatedRun();
      const { harness, driven, github } = fixture;
      const transport = await realTransport(fixture);
      let changed = false;
      afterPublicationCheck(fixture, () => arrange(transport, () => {
        recordOwnerDecision(harness, driven.runId, fixture.items[0]!, false, "refused after the publication check");
        changed = true;
      }));

      await finalizeAttempts(fixture, 0);
      expect(changed).toBe(true);
      expect(transport.staleWrites).toEqual([]);
      expect(transport.events).toContain(`refused ${ReasonCode.HUMAN_GATE_UNSATISFIED}`);
      expect(writes(github)).toEqual({ gates: 0, merges: 0 });
      expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
    },
  );

  /** This run's receipts of one GitHub operation, in order. */
  const receiptsOf = (fixture: Fixture, operation: "gate_publish" | "merge_execute") =>
    fixture.harness.cp.db.all<{ status: string; request_digest: string }>(
      "SELECT status, request_digest FROM github_receipts WHERE operation = ? AND run_id = ? ORDER BY rowid",
      [operation, fixture.driven.runId],
    );

  /**
   * The same database opened by a new process, with the real transport: a write the first process left
   * PENDING is reconciled there and, when GitHub shows it never arrived, sent again from the same call
   * site. `leaseExpired` moves the clock past the finalization lease of an attempt that never returned.
   */
  const restart = async (fixture: Fixture, leaseExpired: boolean) => {
    fixture.harness.cp.db.close();
    // FINALIZATION_LEASE_TTL_MS is 30 minutes.
    if (leaseExpired) fixture.harness.clock.advance(31 * 60_000);
    const harness = makeHarness({
      root: fixture.harness.root,
      githubClient: fixture.github,
      clock: fixture.harness.clock,
      repoPath: fixture.harness.repoPath,
    });
    const restarted: Fixture = { ...fixture, harness };
    return { restarted, transport: await realTransport(restarted) };
  };

  it.each(["nothing changes", "the owner refuses during its token refresh"] as const)(
    "FD-R2 re-send gate POST: a gate POST that GitHub never answered is sent again by the next process only through the transport's check (%s)",
    async (change) => {
      const fixture = await approvedHumanGatedRun();
      const first = await realTransport(fixture);
      first.dropNext("gate POST");
      await finalizeAttempts(fixture, 0);
      expect(withoutChecks(first.events)).toEqual(["gate POST"]);
      const dropped = receiptsOf(fixture, "gate_publish");
      expect(dropped).toMatchObject([{ status: "PENDING" }]);
      expect(writes(fixture.github)).toEqual({ gates: 0, merges: 0 });

      const { restarted, transport } = await restart(fixture, false);
      const { harness, driven } = restarted;
      if (change === "the owner refuses during its token refresh") {
        transport.atNextRequest("POST", /\/check-runs$/, () => transport.expireTokenThen(() =>
          recordOwnerDecision(harness, driven.runId, fixture.items[0]!, false, "refused while the re-sent gate POST waited")));
      }
      await finalizeAttempts(restarted, 0);
      expect(transport.staleWrites).toEqual([]);
      if (change === "the owner refuses during its token refresh") {
        expect(transport.events).toEqual(["token refresh", `refused ${ReasonCode.HUMAN_GATE_UNSATISFIED}`]);
        expect(writes(fixture.github)).toEqual({ gates: 0, merges: 0 });
        // Nothing was sent, so the reservation the re-send made is released, not left PENDING.
        expect(receiptsOf(restarted, "gate_publish")).toEqual([]);
        expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
      } else {
        // The dropped request itself, sent again: the same payload digest, now published and recorded.
        expect(receiptsOf(restarted, "gate_publish")).toEqual([{ status: "APPLIED", request_digest: dropped[0]!.request_digest }]);
        expect(dispatchedAfter(transport.events)).toEqual(["verified -> gate POST", "verified -> merge PUT"]);
        expect(writes(fixture.github)).toEqual({ gates: 1, merges: 1 });
        expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
      }
    },
  );

  it.each(["nothing changes", "the owner refuses during its token refresh"] as const)(
    "FD-R2 re-send merge PUT: a PUT whose process stopped while the transport awaited its token is sent again by the next process only through the transport's check (%s)",
    async (change) => {
      const fixture = await approvedHumanGatedRun();
      const first = await realTransport(fixture);
      let stopped!: () => void;
      const stop = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      // The first process stops while its PUT waits for a token: that attempt never resumes.
      first.atNextRequest("PUT", /\/merge$/, () => first.expireTokenThen(() => {
        stopped();
        return new Promise<void>(() => undefined);
      }));
      void new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-finalizer-digest-") }).start();
      await stop;
      expect(withoutChecks(first.events)).toEqual(["gate POST", "token refresh"]);
      expect(receiptsOf(fixture, "merge_execute")).toMatchObject([{ status: "PENDING" }]);

      const { restarted, transport } = await restart(fixture, true);
      const { harness, driven } = restarted;
      if (change === "the owner refuses during its token refresh") {
        transport.atNextRequest("PUT", /\/merge$/, () => transport.expireTokenThen(() =>
          recordOwnerDecision(harness, driven.runId, fixture.items[0]!, false, "refused while the re-sent PUT waited")));
      }
      await finalizeAttempts(restarted, 0);
      expect(transport.staleWrites).toEqual([]);
      if (change === "the owner refuses during its token refresh") {
        expect(transport.events.slice(-2)).toEqual(["token refresh", `refused ${ReasonCode.HUMAN_GATE_UNSATISFIED}`]);
        expect(fixture.github.mergeCount).toBe(0);
        expect(receiptsOf(restarted, "merge_execute")).toEqual([]);
        expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
      } else {
        expect(dispatchedAfter(transport.events).at(-1)).toBe("verified -> merge PUT");
        expect(receiptsOf(restarted, "merge_execute")).toMatchObject([{ status: "APPLIED" }]);
        expect(fixture.github.mergeCount).toBe(1);
        expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
      }
    },
  );

  it("FD-R2 throw: a payload check that throws as the PUT leaves sends nothing, releases the reservation, and the next attempt merges", async () => {
    const fixture = await approvedHumanGatedRun();
    const { harness, driven, github } = fixture;
    const transport = await realTransport(fixture);
    const kernel = harness.cp.github as unknown as { assertGatePayloadBacked: (...args: unknown[]) => unknown };
    const check = kernel.assertGatePayloadBacked.bind(kernel);
    let throwNext = false;
    kernel.assertGatePayloadBacked = (...args: unknown[]) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("the payload check failed");
      }
      return check(...args);
    };
    transport.atNextRequest("PUT", /\/merge$/, () => {
      throwNext = true;
    });

    // Daemon.start's sweep: the attempt whose check threw, then the MERGING run's next attempt.
    await finalizeAttempts(fixture, 0);
    expect(failedAttempts(fixture)[0]?.reasonCode).toBe(ReasonCode.INTERNAL_ERROR);
    expect(transport.events).toEqual(["verified", "gate POST", `refused ${ReasonCode.INTERNAL_ERROR}`, "verified", "merge PUT"]);
    expect(mergePuts(fixture)).toEqual([{ pull: github.pulls[0]!.number, sha: driven.candidateHead }]);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
  });
});

/**
 * FIX-FD-REDIRECT (review r3 of #1145) — the production transport over a real HTTP server and the
 * runtime's own fetch, so what happens to a redirect is fetch's behaviour, not a double's. The server
 * answers the App's authentication itself and forwards every other request to FakeGitHub. When
 * `redirect` names a write, the server answers its first send with a same-origin 307, after running
 * `beforeRedirect` with that write (so a case can apply it at GitHub before the 307); a request that
 * then arrives at the redirect target is forwarded too, and counted.
 *
 * `sends` lists every gate POST and merge PUT that reached the server, `redirected` the ones that
 * reached the redirect target, and `refusals` every denial the store returned with `redirect: true`.
 */
const REDIRECTED = "/redirected";

const nativeTransport = async (
  fixture: Fixture,
  options: {
    redirect?: "gate POST" | "merge PUT";
    beforeRedirect?: (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", target: string, body: unknown) => Promise<void> | void;
  } = {},
) => {
  const root = tempDir("acp-fd-redirect-");
  const credentialDir = join(root, "credentials");
  mkdirSync(credentialDir, { mode: 0o700 });
  const keyPath = join(credentialDir, "github-app.private-key.pem");
  writeFileSync(keyPath, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  const envFile = join(credentialDir, "github-app.env");
  writeFileSync(envFile, `GITHUB_APP_ID=4586878\nGITHUB_APP_INSTALLATION_ID=153553922\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\n`, { mode: 0o600 });
  const sends: string[] = [];
  const redirected: string[] = [];
  const refusals: Array<{ reasonCode: string; evidence: Record<string, unknown> }> = [];
  let answeredWithRedirect = false;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) as unknown : undefined;
      const method = req.method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      const path = req.url!;
      res.setHeader("Content-Type", "application/json");
      if (path === "/app") {
        res.end(JSON.stringify({ slug: "acp-trusted-app", permissions: {
          checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write",
        } }));
        return;
      }
      if (path.endsWith("/access_tokens")) {
        res.statusCode = 201;
        res.end(JSON.stringify({ token: "fd-redirect-installation-token", expires_at: "2026-08-15T00:00:00.000Z" }));
        return;
      }
      const followed = path.startsWith(REDIRECTED);
      const target = followed ? path.slice(REDIRECTED.length) : path;
      const write = method === "PUT" && /\/pulls\/\d+\/merge$/.test(target) ? "merge PUT"
        : method === "POST" && /\/check-runs$/.test(target) && (body as { name?: unknown }).name === GATE_CHECK_NAME ? "gate POST"
          : null;
      if (write) (followed ? redirected : sends).push(write);
      if (write && write === options.redirect && !followed && !answeredWithRedirect) {
        answeredWithRedirect = true;
        await options.beforeRedirect?.(method, target, body);
        res.writeHead(307, { Location: `${REDIRECTED}${path}` });
        res.end("{}");
        return;
      }
      try {
        const response = await fixture.github.request(method, target, body);
        res.statusCode = method === "POST" ? 201 : 200;
        res.end(JSON.stringify(response));
      } catch {
        res.statusCode = 500;
        res.end("{}");
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const store = new TrustedCredentialStore(join(root, "secrets"), {
    appEnvFile: envFile,
    apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    now: () => Date.parse("2026-08-14T00:00:00.000Z"),
  });
  expect((await store.authenticate()).allowed).toBe(true);
  const githubApi = store.githubApi.bind(store);
  store.githubApi = async (options) => {
    const result = await githubApi(options);
    if (!result.allowed && result.evidence["redirect"] === true) {
      refusals.push({ reasonCode: result.reasonCode, evidence: result.evidence });
    }
    return result;
  };
  Object.assign(fixture.harness.cp.github, { credentials: store, client: new GitHubAppClient(store) });
  return {
    sends,
    redirected,
    refusals,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe("FIX-FD-REDIRECT: the transport sends each gate POST and merge PUT once and follows no redirect", () => {
  const sites = [
    ["gate POST", "gate POST", false],
    ["merge commit PUT", "merge PUT", false],
    ["squash PUT", "merge PUT", true],
  ] as const;

  it("FIX-FD-REDIRECT control: GitHub answers 2xx over the native transport; each write is sent once and the run merges once", async () => {
    const fixture = await approvedHumanGatedRun();
    const transport = await nativeTransport(fixture);
    try {
      expect(await outcomeOf(fixture)).toEqual(COMPLETED_ONCE);
      expect(transport.sends).toEqual(["gate POST", "merge PUT"]);
      expect(transport.redirected).toEqual([]);
      expect(transport.refusals).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it.each(sites)(
    "FIX-FD-REDIRECT %s: an authenticated owner refusal, then a same-origin 307 answer: the write was sent once, nothing is sent to the redirect target, and the run does not complete",
    async (_site, write, squash) => {
      const fixture = await approvedHumanGatedRun({ squash });
      const { harness, driven, github } = fixture;
      let changed = false;
      const transport = await nativeTransport(fixture, {
        redirect: write,
        beforeRedirect: () => {
          recordOwnerDecision(harness, driven.runId, fixture.items[0]!, false, "refused before the redirect answer");
          changed = true;
        },
      });
      try {
        await finalizeAttempts(fixture, 1);
        expect(changed).toBe(true);
        // The first send left once and was answered with the redirect; it is not sent again anywhere.
        expect(transport.sends.filter((sent) => sent === write)).toEqual([write]);
        expect(transport.redirected).toEqual([]);
        expect(transport.refusals[0]).toEqual({
          reasonCode: ReasonCode.PROBE_FAILED,
          evidence: { operation: write === "gate POST" ? "POST" : "PUT", status: 307, redirect: true },
        });
        expect(github.mergeCount).toBe(0);
        if (write === "gate POST") expect(writes(github).gates).toBe(0);
        expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
      } finally {
        await transport.close();
      }
    },
  );

  it.each(sites)(
    "FIX-FD-REDIRECT %s with nothing changed: a 307 answer is still not followed, and the run fails closed instead of completing",
    async (_site, write, squash) => {
      const fixture = await approvedHumanGatedRun({ squash });
      const { harness, driven, github } = fixture;
      const transport = await nativeTransport(fixture, { redirect: write });
      try {
        await finalizeAttempts(fixture, 1);
        expect(transport.sends.filter((sent) => sent === write)).toEqual([write]);
        expect(transport.redirected).toEqual([]);
        expect(transport.refusals.length).toBeGreaterThan(0);
        expect(github.mergeCount).toBe(0);
        expect(harness.cp.runs.require(driven.runId).state).not.toBe(RunState.COMPLETED);
      } finally {
        await transport.close();
      }
    },
  );

  it("FIX-FD-REDIRECT effect before the 307: GitHub applied the gate POST and then answered it with a 307; the next process reuses that gate, which names the current binding, sends no second gate POST, and merges once", async () => {
    const fixture = await approvedHumanGatedRun();
    const first = await nativeTransport(fixture, {
      redirect: "gate POST",
      // GitHub creates the gate, then answers the POST that created it with the redirect.
      beforeRedirect: async (method, target, body) => {
        await fixture.github.request(method, target, body);
      },
    });
    try {
      await finalizeAttempts(fixture, 0);
      expect(first.sends).toEqual(["gate POST"]);
      expect(first.redirected).toEqual([]);
      expect(first.refusals[0]).toEqual({
        reasonCode: ReasonCode.PROBE_FAILED,
        evidence: { operation: "POST", status: 307, redirect: true },
      });
    } finally {
      await first.close();
    }
    expect(writes(fixture.github)).toEqual({ gates: 1, merges: 0 });
    const published = gatesOnHead(fixture).map((check) => check.id);
    expect(published).toHaveLength(1);
    expect(fixture.harness.cp.runs.require(fixture.driven.runId).state).not.toBe(RunState.COMPLETED);

    // The same database opened by a new process: GitHub already holds the gate the refused POST created.
    fixture.harness.cp.db.close();
    const harness = makeHarness({
      root: fixture.harness.root,
      githubClient: fixture.github,
      clock: fixture.harness.clock,
      repoPath: fixture.harness.repoPath,
    });
    const restarted: Fixture = { ...fixture, harness };
    const next = await nativeTransport(restarted);
    try {
      await finalizeAttempts(restarted, 0);
      expect(next.sends).toEqual(["merge PUT"]);
      expect(next.redirected).toEqual([]);
      expect(next.refusals).toEqual([]);
      // The merge stood on the gate the first process's POST created: still the only gate on the head,
      // naming the binding that holds now.
      expect(gatesOnHead(restarted).map((check) => check.id)).toEqual(published);
      expect(harness.cp.ceo.humanGateBinding(fixture.driven.runId)).toMatchObject({ satisfied: true, humanGateDigest: fixture.binding });
      expect(expectedBinding(restarted)).toBe(fixture.binding);
      expect(writeLog(restarted)).toEqual([`gate ${fixture.binding}`, `merge ${fixture.driven.candidateHead}`]);
      expect(writes(fixture.github)).toEqual({ gates: 1, merges: 1 });
      expect(harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.COMPLETED);
    } finally {
      await next.close();
    }
  });

  it("FIX-FD-REDIRECT recovery: a gate POST answered with a 307 stays PENDING, and the next process publishes it as a new send and merges once", async () => {
    const fixture = await approvedHumanGatedRun();
    const first = await nativeTransport(fixture, { redirect: "gate POST" });
    try {
      await finalizeAttempts(fixture, 0);
      expect(first.sends).toEqual(["gate POST"]);
      expect(first.redirected).toEqual([]);
    } finally {
      await first.close();
    }
    const pending = (harness: Harness) =>
      harness.cp.db.all<{ status: string }>(
        "SELECT status FROM github_receipts WHERE operation = 'gate_publish' AND run_id = ? ORDER BY rowid",
        [fixture.driven.runId],
      );
    expect(pending(fixture.harness)).toEqual([{ status: "PENDING" }]);
    expect(writes(fixture.github)).toEqual({ gates: 0, merges: 0 });

    // The same database opened by a new process: GitHub shows no gate, so the reservation is released
    // and the gate is published again from its call site, through the transport's check.
    fixture.harness.cp.db.close();
    const harness = makeHarness({
      root: fixture.harness.root,
      githubClient: fixture.github,
      clock: fixture.harness.clock,
      repoPath: fixture.harness.repoPath,
    });
    const restarted: Fixture = { ...fixture, harness };
    const next = await nativeTransport(restarted);
    try {
      await finalizeAttempts(restarted, 0);
      expect(next.sends).toEqual(["gate POST", "merge PUT"]);
      expect(next.redirected).toEqual([]);
      expect(pending(harness)).toEqual([{ status: "APPLIED" }]);
      expect(writes(fixture.github)).toEqual({ gates: 1, merges: 1 });
      expect(harness.cp.runs.require(fixture.driven.runId).state).toBe(RunState.COMPLETED);
    } finally {
      await next.close();
    }
  });
});
