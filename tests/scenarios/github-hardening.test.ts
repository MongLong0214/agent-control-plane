import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, SessionLifecycle } from "../../src/domain/types.ts";
import { TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { GATE_CHECK_NAME, NO_HUMAN_GATE_DIGEST, type GatePayload } from "../../src/github/github-kernel.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import {
  approveReviewedCandidateForFinalization,
  type Harness,
  driveToReviewedCandidate,
  installDaemonFinalizerGitHubFixture,
  makeHarness,
  ownerDecisionReceipt,
  registerFixtureProject,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CI_WORKFLOWS = [
  { path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null },
];

interface Fixture {
  harness: Harness;
  github: FakeGitHub;
  runId: string;
  identity: string;
  caller: { ownerSessionId: string; ownerBindingGeneration: number };
  head: string;
  base: string;
  workBranch: string;
  payload: GatePayload;
}

interface OwnerAuthorityFixture {
  harness: Harness;
  github: FakeGitHub;
  runId: string;
  identity: string;
  caller: { ownerSessionId: string; ownerBindingGeneration: number };
}

const OWNER_AUTHORITY_CONTRACT: TaskContract = {
  goal: "owner-authority regression",
  why: "exercise owner fencing before GitHub effects",
  scope: [],
  nonGoals: [],
  acceptance: ["owner check runs"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** Model GitHub's post-merge pull re-read: its target ref advances to the merge SHA. */
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
    const merge = response as { merged?: unknown; sha?: unknown };
    const pullNumber = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === pullNumber);
    if (merge.merged !== true || typeof merge.sha !== "string" || !pull) return response;
    pull.base.sha = merge.sha;
    (pull as typeof pull & { merge_commit_sha?: string }).merge_commit_sha = merge.sha;
    github.setBranch(pull.base.ref, merge.sha);
    return response;
  };
};

const setup = async (options: {
  declareChecks?: boolean;
  humanGate?: readonly string[];
  allowUnsatisfiedHumanGate?: boolean;
} = {}): Promise<Fixture> => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });

  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-thing",
    humanGate: options.humanGate,
    manifestOverrides: options.declareChecks === false ? {} : { ciWorkflows: CI_WORKFLOWS },
  });

  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "c".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);

  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);

  if (!options.allowUnsatisfiedHumanGate) {
    for (const item of options.humanGate ?? []) {
      const decision = harness.cp.ceo.recordOwnerDecision({
        runId: driven.runId,
        item,
        approved: true,
        note: `approve ${item}`,
        receipt: ownerDecisionReceipt(harness, driven.runId, item, true, `approve ${item}`),
      });
      if (!decision.allowed) throw new Error(`${decision.reasonCode}: ${decision.message}`);
    }
  }
  await approveReviewedCandidateForFinalization(harness, driven, {
    bypassCeoConfirmation: options.allowUnsatisfiedHumanGate,
  });
  installDaemonFinalizerGitHubFixture(harness);
  const humanGateStatus = harness.cp.ceo.humanGateStatus(driven.runId);
  const humanGateDigest = humanGateStatus.required
    ? digestOf(humanGateStatus.items)
    : NO_HUMAN_GATE_DIGEST;

  return {
    harness,
    github,
    runId: driven.runId,
    identity: driven.identity,
    caller: {
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
    },
    head: driven.candidateHead,
    base: driven.baseHead,
    workBranch: driven.workBranch,
    payload: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      contractDigest: driven.contractDigest,
      verificationDigest: driven.verificationDigest,
      blindReviewDigest: driven.blindReviewDigest,
      humanGateDigest,
      bindingGeneration: driven.ownerBindingGeneration,
      exactHead: driven.candidateHead,
      timestamp: "2026-08-12T00:00:00.000Z",
    },
  };
};

/**
 * Post-merge trust verifies the workflow file at the merged SHA. Point the fake merge at
 * the candidate's real local commit so that read is an actual git proof rather than a mock
 * return value, while retaining the fake's first-parent API proof.
 */
const reflectMergeToCandidate = (github: FakeGitHub, candidateHead: string, evaluatedBase: string): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") {
      return response;
    }
    const merge = response as { merged?: unknown };
    const pullNumber = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === pullNumber);
    if (merge.merged !== true || !pull) return response;
    pull.base.sha = candidateHead;
    (pull as typeof pull & { merge_commit_sha?: string }).merge_commit_sha = candidateHead;
    github.commitParents.set(candidateHead, [evaluatedBase, candidateHead]);
    github.setBranch(pull.base.ref, candidateHead);
    return { ...(response as object), sha: candidateHead } as T;
  };
};

const setupTrustedPostMergeFixture = async (): Promise<Fixture> => {
  const workflow = "name: project-ci\non: [push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { ".github/workflows/ci.yml": workflow });
  commitAll(harness.repoPath, "add approved CI workflow");

  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-thing",
    manifestOverrides: {
      ciWorkflows: [{ path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: sha256(workflow) }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "c".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  reflectMergeToCandidate(github, driven.candidateHead, driven.baseHead);

  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);

  await approveReviewedCandidateForFinalization(harness, driven);
  installDaemonFinalizerGitHubFixture(harness);
  const humanGateDigest = harness.cp.ceo.currentHumanGateDecisionDigest(driven.runId);
  if (!humanGateDigest.allowed) throw new Error(`${humanGateDigest.reasonCode}: ${humanGateDigest.message}`);

  return {
    harness,
    github,
    runId: driven.runId,
    identity: driven.identity,
    caller: {
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
    },
    head: driven.candidateHead,
    base: driven.baseHead,
    workBranch: driven.workBranch,
    payload: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      contractDigest: driven.contractDigest,
      verificationDigest: driven.verificationDigest,
      blindReviewDigest: driven.blindReviewDigest,
      humanGateDigest: humanGateDigest.value,
      bindingGeneration: driven.ownerBindingGeneration,
      exactHead: driven.candidateHead,
      timestamp: "2026-08-12T00:00:00.000Z",
    },
  };
};

/**
 * Ownership is checked before any candidate or GitHub predicate. Keeping this fixture small
 * means the regression proves that exact check rather than accidentally relying on unrelated
 * verification setup.
 */
const setupOwnerAuthorisedRun = async (): Promise<OwnerAuthorityFixture> => {
  const github = new FakeGitHub();
  const harness = makeHarness({ githubClient: github });
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "owner-authority");
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: OWNER_AUTHORITY_CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return {
    harness,
    github,
    runId: dispatched.value.runId,
    identity,
    caller: {
      ownerSessionId: dispatched.value.ownerSessionId!,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    },
  };
};

const openPull = async (fixture: Fixture, head = fixture.workBranch, exactHeadSha = fixture.head) => {
  const prepared = await fixture.harness.cp.github.prPrepare({
    runId: fixture.runId,
    repositoryIdentity: fixture.identity,
    head,
    base: "dev",
    title: "candidate",
    body: "",
    ownerSessionId: fixture.caller.ownerSessionId,
    ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
    exactHeadSha,
  });
  if (!prepared.allowed) throw new Error(`${prepared.reasonCode}: ${prepared.message}`);
  return prepared.value.pullNumber;
};

/** Publishes the gate, opens the PR and returns its number. */
const openPullWithGate = async (fixture: Fixture) => {
  const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
  if (!published.allowed) throw new Error(published.message);
  return openPull(fixture);
};

/** Performs the run's real merge and returns the merge commit, for post-merge tests. */
const mergeForReal = async (fixture: Fixture) => {
  const pullNumber = await openPullWithGate(fixture);
  const merged = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
  if (!merged.allowed) throw new Error(`${merged.reasonCode}: ${merged.message}`);
  return merged.value.mergeCommitSha;
};

const mergeInput = (fixture: Fixture, pullNumber: number) => ({
  runId: fixture.runId,
  repositoryIdentity: fixture.identity,
  pullNumber,
  exactHeadSha: fixture.head,
  expectedBaseSha: fixture.base,
  mergeStrategy: "merge_commit" as const,
  ownerSessionId: fixture.caller.ownerSessionId,
  ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
});

/**
 * Model the durable artifact that the owner-decision writer persists after ingress
 * admitted an exact decision. The kernel must reject an identical-looking row if its
 * candidate binding or receipt is missing, because APPROVAL is not an evidence kind.
 */
const putOwnerDecision = (
  fixture: Fixture,
  items: readonly string[],
  input: { item: string; approved: boolean; note: string; candidateSnapshotDigest?: string; receipt?: boolean },
): string => {
  const receipt = ownerDecisionReceipt(
    fixture.harness,
    fixture.runId,
    input.item,
    input.approved,
    input.note,
  );
  return fixture.harness.cp.artifacts.put(
    fixture.runId,
    "APPROVAL",
    {
      kind: "OWNER_DECISION",
      item: input.item,
      approved: input.approved,
      note: input.note,
      humanGateDigest: digestOf(items),
      candidateSnapshotDigest: input.candidateSnapshotDigest ?? fixture.payload.candidateSnapshotDigest,
      ...(input.receipt === false ? {} : { receipt }),
    },
    input.candidateSnapshotDigest ?? fixture.payload.candidateSnapshotDigest,
  ).digest;
};

/** Go through the only owner-decision ingress that ProductionGate is allowed to count. */
const recordOwnerDecision = (
  fixture: Fixture,
  input: { item: string; approved: boolean; note: string },
): void => {
  const receipt = ownerDecisionReceipt(
    fixture.harness,
    fixture.runId,
    input.item,
    input.approved,
    input.note,
  );
  const recorded = fixture.harness.cp.ceo.recordOwnerDecision({
    runId: fixture.runId,
    ...input,
    receipt,
  });
  if (!recorded.allowed) throw new Error(`${recorded.reasonCode}: ${recorded.message}`);
};

/** A live, unrelated identity makes an ownership denial prove the owner check actually ran. */
const unrelatedCaller = (fixture: Pick<OwnerAuthorityFixture, "harness" | "caller">) => {
  const session = fixture.harness.cp.sessions.create({ provider: "scripted", model: "unrelated-github-caller" });
  const ready = fixture.harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "ownership regression");
  if (!ready.allowed) throw new Error(ready.message);
  return {
    ownerSessionId: session.sessionId,
    ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
  };
};

describe("a production gate asserts evidence that exists (§24.4, CP-HI-06)", () => {
  it("refuses a payload whose verification digest resolves to nothing", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, verificationDigest: `sha256:${"9".repeat(64)}` },
      fixture.identity,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_EVIDENCE_NOT_BACKED);
    expect(fixture.github.checkRuns).toHaveLength(0);
  });

  it("refuses a payload that names the verification report as its blind review", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, blindReviewDigest: fixture.payload.verificationDigest },
      fixture.identity,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_EVIDENCE_NOT_BACKED);
  });

  it("refuses a payload bound to a candidate that is no longer current", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, candidateSnapshotDigest: `sha256:${"1".repeat(64)}` },
      fixture.identity,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
  });

  it("refuses a payload pinning a different contract", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, contractDigest: `sha256:${"2".repeat(64)}` },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.CONTRACT_DIGEST_MISMATCH);
  });

  it("refuses a made-up human gate digest on a run that needs no owner decision", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf({ humanGate: "whatever" }) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.GATE_EVIDENCE_NOT_BACKED);
  });

  it("refuses a payload for a head that is not the candidate head", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, exactHead: "e".repeat(40) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_HEAD_STALE);
  });

  it("refuses a payload for a repository that does not participate in the run", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.gatePublish(fixture.payload, "github:acme/elsewhere");
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });

  it("accepts the payload the evidence actually supports", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    expect(published.allowed).toBe(true);
  });
});

describe("the GitHub merge boundary re-checks the durable human gate (CP-HI-07, #381)", () => {
  it("refuses a two-item gate after only one current item is approved", async () => {
    const items = ["irreversible production action", "undelegated public release"] as const;
    const fixture = await setup({ humanGate: items, allowUnsatisfiedHumanGate: true });
    recordOwnerDecision(fixture, {
      item: items[0],
      approved: true,
      note: "approve production action",
    });
    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(fixture.github.checkRuns).toHaveLength(0);
  });

  it("refuses merge after a later owner rejection revokes a published gate", async () => {
    const items = ["irreversible production action", "undelegated public release"] as const;
    const fixture = await setup({ humanGate: items, allowUnsatisfiedHumanGate: true });
    recordOwnerDecision(fixture, {
      item: items[0],
      approved: true,
      note: "approve production action",
    });
    recordOwnerDecision(fixture, {
      item: items[1],
      approved: true,
      note: "approve release",
    });
    const published = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    if (!published.allowed) throw new Error(`${published.reasonCode}: ${published.message}`);
    const pullNumber = await openPull(fixture);

    // Later decisions win. The gate check remains a historical projection, but merge must
    // refuse once an authenticated owner withdraws one of the approvals.
    recordOwnerDecision(fixture, {
      item: items[1],
      approved: false,
      note: "withdraw release approval",
    });
    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("refuses an approval artifact bound to a different candidate", async () => {
    const items = ["undelegated public release"] as const;
    const fixture = await setup({ humanGate: items, allowUnsatisfiedHumanGate: true });
    putOwnerDecision(fixture, items, {
      item: items[0],
      approved: true,
      note: "approval for a prior candidate",
      candidateSnapshotDigest: `sha256:${"a".repeat(64)}`,
    });

    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(fixture.github.checkRuns).toHaveLength(0);
  });

  it("refuses an approval-shaped artifact a caller inserted directly", async () => {
    const items = ["undelegated public release"] as const;
    const fixture = await setup({ humanGate: items, allowUnsatisfiedHumanGate: true });
    putOwnerDecision(fixture, items, {
      item: items[0],
      approved: true,
      note: "bare direct artifact",
      receipt: false,
    });

    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(fixture.github.checkRuns).toHaveLength(0);
  });

  it("refuses an approval whose retained ingress receipt is not exact", async () => {
    const items = ["undelegated public release"] as const;
    const fixture = await setup({ humanGate: items, allowUnsatisfiedHumanGate: true });
    const receipt = ownerDecisionReceipt(
      fixture.harness,
      fixture.runId,
      items[0],
      true,
      "the receipt's note",
    );
    fixture.harness.cp.artifacts.put(
      fixture.runId,
      "APPROVAL",
      {
        kind: "OWNER_DECISION",
        item: items[0],
        approved: true,
        note: "a substituted note",
        humanGateDigest: digestOf(items),
        candidateSnapshotDigest: fixture.payload.candidateSnapshotDigest,
        receipt,
      },
      fixture.payload.candidateSnapshotDigest,
    );

    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(fixture.github.checkRuns).toHaveLength(0);
  });

  it("uses the attached ProductionGate status port instead of rereading approval artifacts", async () => {
    const items = ["undelegated public release"] as const;
    const fixture = await setup({ humanGate: items });
    recordOwnerDecision(fixture, { item: items[0], approved: true, note: "approved" });
    fixture.harness.cp.github.attach({
      humanGateStatus: {
        humanGateStatus: () => ({
          required: true,
          items,
          satisfied: false,
          humanGateDigest: digestOf(items),
        }),
      },
    });

    const refused = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(fixture.github.checkRuns).toHaveLength(0);
  });

  it("re-reads the attached ProductionGate status port at merge evaluation", async () => {
    const items = ["undelegated public release"] as const;
    const fixture = await setup({ humanGate: items });
    recordOwnerDecision(fixture, { item: items[0], approved: true, note: "approved" });
    const published = await fixture.harness.cp.github.gatePublish(
      { ...fixture.payload, humanGateDigest: digestOf(items) },
      fixture.identity,
    );
    if (!published.allowed) throw new Error(`${published.reasonCode}: ${published.message}`);
    const pullNumber = await openPull(fixture);
    fixture.harness.cp.github.attach({
      humanGateStatus: {
        humanGateStatus: () => ({
          required: true,
          items,
          satisfied: false,
          humanGateDigest: digestOf(items),
        }),
      },
    });

    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
  });
});

describe("a gate is only an approval when GitHub says it passed (§24.5)", () => {
  const publishedFixture = async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pullNumber = await openPull(fixture);
    return { fixture, pullNumber };
  };

  it("refuses a gate check that has not completed", async () => {
    const { fixture, pullNumber } = await publishedFixture();
    const check = fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!;
    check.status = "in_progress";
    check.conclusion = null;

    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID);
    expect(
      fixture.harness.cp.audit
        .byKind("GATE_REJECTED")
        .some((e) => e.reasonCode === ReasonCode.MERGE_GATE_MISSING),
    ).toBe(true);
  });

  it("refuses a gate check that concluded in failure", async () => {
    const { fixture, pullNumber } = await publishedFixture();
    fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!.conclusion = "failure";
    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
  });

  it("refuses a gate check with no creator evidence at all", async () => {
    const { fixture, pullNumber } = await publishedFixture();
    fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!.app = null;
    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(
      fixture.harness.cp.audit
        .byKind("GATE_REJECTED")
        .some((e) => e.reasonCode === ReasonCode.GATE_CREATOR_UNTRUSTED),
    ).toBe(true);
  });

  it("refuses a replacement check run that reuses the published summary", async () => {
    const { fixture, pullNumber } = await publishedFixture();
    const published = fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!;
    // A second check run, same name, same summary, same creator — different id.
    fixture.github.checkRuns.push({ ...published, id: published.id + 1000 });
    fixture.github.checkRuns.splice(fixture.github.checkRuns.indexOf(published), 1);

    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID);
  });
});

describe("a merge needs a live claim (§24.3, CP-HI-01)", () => {
  it("refuses a PR when nothing claims the head branch", async () => {
    const fixture = await setup();
    fixture.harness.cp.claims.releaseRun(fixture.runId);
    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.caller.ownerSessionId,
      ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_CLAIM_INVALID);
    expect(fixture.github.pulls).toHaveLength(0);
  });

  it("refuses a merge once the claim has expired", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pullNumber = await openPull(fixture);

    fixture.harness.cp.db.run(
      `UPDATE resource_claims SET expires_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ?`,
      [fixture.runId],
    );

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_CLAIM_INVALID);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("refuses a merge when the claim was taken under a superseded generation", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pullNumber = await openPull(fixture);

    fixture.harness.cp.db.run(
      `UPDATE resource_claims SET owner_binding_generation = owner_binding_generation - 1 WHERE run_id = ?`,
      [fixture.runId],
    );

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_CLAIM_INVALID);
  });

  it("refuses a merge when the only claim is on a different branch", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pullNumber = await openPull(fixture);

    fixture.harness.cp.db.run(`UPDATE resource_claims SET branch = 'feature/other' WHERE run_id = ? AND branch IS NOT NULL`, [
      fixture.runId,
    ]);

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_CLAIM_INVALID);
  });
});

describe("the merge must land on the evaluated base (§24.6)", () => {
  const readyToMerge = async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pullNumber = await openPull(fixture);
    return { fixture, pullNumber };
  };

  it("refuses when the base moves between evaluation and execution", async () => {
    const { fixture, pullNumber } = await readyToMerge();
    // The evaluation sees the recorded base; the pull's base then advances.
    const pull = fixture.github.pulls.find((p) => p.number === pullNumber)!;
    const evaluated = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(evaluated.allowed).toBe(true);
    pull.base.sha = "9".repeat(40);

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("reports a merge that landed on a base the evidence does not describe", async () => {
    const { fixture, pullNumber } = await readyToMerge();
    // GitHub accepts the merge but the resulting commit's first parent is not the base the
    // run evaluated — the race the API cannot close for us.
    fixture.github.driftBaseTo = "7".repeat(40);

    const drifted = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(drifted.allowed).toBe(false);
    expect(drifted.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.harness.cp.audit.byKind("MERGE_BASE_DRIFT")).toHaveLength(1);

    const repository = fixture.harness.cp.runs
      .repositoriesOf(fixture.runId)
      .find((r) => r.identity === fixture.identity)!;
    expect(repository.mergeState).toBe("FAILED");
  });

  it("keeps the repository pending until exact post-merge verification completes", async () => {
    const { fixture, pullNumber } = await readyToMerge();
    const merged = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(merged.allowed).toBe(true);
    const repository = fixture.harness.cp.runs
      .repositoriesOf(fixture.runId)
      .find((r) => r.identity === fixture.identity)!;
    expect(repository.mergeState).toBe("PENDING");
  });
});

describe("post-merge verification cannot be made vacuous (§24.7)", () => {
  it("refuses check names the pinned manifest does not declare", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      "9".repeat(40),
      ["whatever-i-like"],
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED);
  });

  it("refuses an empty required set instead of passing every commit", async () => {
    const fixture = await setup({ declareChecks: false });
    const refused = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      "9".repeat(40),
      [],
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED);
  });

  it("uses the manifest's declared checks when the caller names none", async () => {
    const fixture = await setup();
    const mergeSha = await mergeForReal(fixture);
    const refused = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      mergeSha,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);
    expect(refused.evidence["failed"]).toEqual([{ name: "project-ci", conclusion: "missing" }]);
  });

  it("treats a check that has not completed as a failure", async () => {
    const fixture = await setup();
    const mergeSha = await mergeForReal(fixture);
    fixture.github.checkRuns.push({
      id: 9001,
      name: "project-ci",
      head_sha: mergeSha,
      conclusion: null,
      status: "in_progress",
      app: { slug: "github-actions" },
      completed_at: null,
    });
    const refused = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      mergeSha,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["failed"]).toEqual([
      { name: "project-ci", conclusion: "incomplete:in_progress" },
    ]);
  });

  it("#387/#388: paginates flooded gate and post-merge lists, then accepts a fully proven Actions workflow", async () => {
    const fixture = await setupTrustedPostMergeFixture();
    const pages: string[] = [];
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ) => {
      if (method === "GET" && /\/check-suites\/71$/.test(path)) {
        return { head_sha: fixture.head, app: { slug: "github-actions" } } as T;
      }
      if (method === "GET" && /\/actions\/runs\/81$/.test(path)) {
        return {
          head_sha: fixture.head,
          path: ".github/workflows/ci.yml",
          status: "completed",
          conclusion: "success",
        } as T;
      }
      if (method === "GET" && /\/commits\/[^/]+\/check-runs/.test(path)) {
        pages.push(path);
        const head = /\/commits\/([^/]+)\/check-runs/.exec(path)?.[1]!;
        const page = Number(new URL(path, "https://github.test").searchParams.get("page") ?? "1");
        // Deliberately model a provider that gives the complete commit list despite a
        // check_name filter. Client-side paging and filtering must still find the trusted
        // result, not make a first page of unrelated checks a denial-of-service switch.
        const all = fixture.github.checkRuns.filter((check) => check.head_sha === head);
        return { check_runs: all.slice((page - 1) * 100, page * 100) } as T;
      }
      return request<T>(method, path, body);
    };

    for (let index = 0; index < 100; index += 1) {
      fixture.github.checkRuns.push({
        id: 10_000 + index,
        name: `unrelated-${index}`,
        head_sha: fixture.head,
        conclusion: "success",
        status: "completed",
        app: { slug: "github-actions" },
        completed_at: "2026-08-12T00:00:00.000Z",
      });
    }

    const gate = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!gate.allowed) throw new Error(`${gate.reasonCode}: ${gate.message}`);
    const pullNumber = await openPull(fixture);
    const merged = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    if (!merged.allowed) throw new Error(`${merged.reasonCode}: ${merged.message}`);
    expect(merged.value.mergeCommitSha).toBe(fixture.head);

    fixture.github.checkRuns.push({
      id: 20_001,
      name: "project-ci",
      head_sha: merged.value.mergeCommitSha,
      conclusion: "success",
      status: "completed",
      app: { slug: "github-actions" },
      check_suite: { id: 71 },
      details_url: "https://github.test/acme/fixture/actions/runs/81/job/9",
      completed_at: "2026-08-12T00:00:00.000Z",
    } as never);

    const verified = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      merged.value.mergeCommitSha,
    );
    expect(verified).toMatchObject({ allowed: true, value: { checks: [{ name: "project-ci", conclusion: "success" }] } });
    expect(pages.some((path) => new URL(path, "https://github.test").searchParams.get("page") === "2")).toBe(true);
  });
});

describe("release tags and issue projection are owner-authorised (CP-HI-01)", () => {
  it("refuses an issue projection from a session that does not own the run", async () => {
    const fixture = await setupOwnerAuthorisedRun();
    const caller = unrelatedCaller(fixture);
    const refused = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      [{ id: "T001", title: "first", body: "body" }],
      caller,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(fixture.github.issues).toHaveLength(0);
  });

  it("refuses an issue projection into a repository outside the run", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      "github:acme/elsewhere",
      [{ id: "T001", title: "first", body: "body" }],
      fixture.caller,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });

  it("refuses a release tag from a session that does not own the run", async () => {
    const fixture = await setupOwnerAuthorisedRun();
    const caller = unrelatedCaller(fixture);
    const refused = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      "1".repeat(40),
      caller,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(fixture.github.tags.size).toBe(0);
  });
});

describe("the trusted credential has no read surface (CP-HI-05)", () => {
  it("exposes only the fixed credential-store API", () => {
    const store = new TrustedCredentialStore(tempDir("credential-surface-"));
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual([
      "assertInstallTarget",
      "available",
      "constructor",
      "creatorIdentity",
      "githubApi",
      "install",
      "load",
      "metadataOk",
      "permissionsOk",
    ]);
  });
});

describe("merge order and dependents are enforced by the kernel (§24.7)", () => {
  it("refuses a dependent PR that was added after the run's candidate was frozen", async () => {
    const fixture = await setup();

    // A second repository in the same run, declared to merge after the primary.
    const secondPath = makeRepo({ "docs/readme.md": "# docs\n" });
    const second = await fixture.harness.cp.repositories.register({
      checkoutPath: secondPath,
      projectId: "fixture-project",
      repositoryRole: "docs",
      identity: "github:acme/docs",
    });
    if (!second.allowed) throw new Error(second.message);
    const attached = fixture.harness.cp.runs.attachRepository(fixture.runId, {
      repositoryId: second.value.repositoryId,
      repositoryRole: "docs",
      baseBranch: "dev",
      mergeOrder: 1,
      ownerSessionId: fixture.caller.ownerSessionId,
      ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
    });
    expect(attached.allowed).toBe(false);
    expect(attached.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("refuses a merge after any repository in the run failed post-merge verification", async () => {
    const fixture = await setup();
    const pullNumber = await openPullWithGate(fixture);
    const merged = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    if (!merged.allowed) throw new Error(merged.message);

    // A failed post-merge check on this run blocks anything that follows it.
    fixture.github.setPostMergeCheck(merged.value.mergeCommitSha, "project-ci", "failure");
    const verified = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      merged.value.mergeCommitSha,
    );
    expect(verified.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);

    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.DEPENDENT_MERGE_BLOCKED);
  });
});

describe("round-2 review: post-merge coverage and receipts", () => {
  it("requires every declared check, not the subset the caller names (github#5)", async () => {
    const github = new FakeGitHub();
    reflectMergedBase(github);
    const harness = makeHarness({ githubClient: github });
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
    const driven = await driveToReviewedCandidate(harness, {
      workBranch: "feature/F1-thing",
      manifestOverrides: {
        ciWorkflows: [
          { path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null },
          { path: ".github/workflows/sec.yml", checkName: "security", approvedDigest: null },
        ],
      },
    });
    github.setBranch("dev", driven.baseHead);
    github.setBranch(driven.workBranch, driven.candidateHead);
    const claimed = harness.cp.claims.acquire({
      runId: driven.runId,
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
      ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
      repositoryIdentity: driven.identity,
      branch: driven.workBranch,
    });
    if (!claimed.allowed) throw new Error(claimed.message);
    await approveReviewedCandidateForFinalization(harness, driven);
    installDaemonFinalizerGitHubFixture(harness);

    const fixture: Fixture = {
      harness,
      github,
      runId: driven.runId,
      identity: driven.identity,
      caller: {
        ownerSessionId: driven.ownerSessionId,
        ownerBindingGeneration: driven.ownerBindingGeneration,
      },
      head: driven.candidateHead,
      base: driven.baseHead,
      workBranch: driven.workBranch,
      payload: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        contractDigest: driven.contractDigest,
        verificationDigest: driven.verificationDigest,
        blindReviewDigest: driven.blindReviewDigest,
        humanGateDigest: NO_HUMAN_GATE_DIGEST,
        bindingGeneration: driven.ownerBindingGeneration,
        exactHead: driven.candidateHead,
        timestamp: "2026-08-12T00:00:00.000Z",
      },
    };

    const mergeSha = await mergeForReal(fixture);
    // Only the check the caller named is green; the other declared check is missing.
    github.setPostMergeCheck(mergeSha, "project-ci", "success");

    const narrowed = await harness.cp.github.postMergeVerify(
      driven.runId,
      driven.identity,
      mergeSha,
      ["project-ci"],
    );
    expect(narrowed.allowed).toBe(false);
    expect(narrowed.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);
    expect(narrowed.evidence["failed"]).toEqual([
      { name: "project-ci", conclusion: "untrusted" },
      { name: "security", conclusion: "missing" },
    ]);
  });

  it("refuses a post-merge result for a commit this run never merged (github#6)", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      "a".repeat(40),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("writes no receipt when GitHub refuses the merge (github#10)", async () => {
    const fixture = await setup();
    const pullNumber = await openPullWithGate(fixture);
    // The head moves after the gate and the PR read, so GitHub declines the merge.
    const pull = fixture.github.pulls.find((p) => p.number === pullNumber)!;
    const input = mergeInput(fixture, pullNumber);
    pull.head.sha = "f".repeat(40);
    fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!.head_sha = "f".repeat(40);

    const refused = await fixture.harness.cp.github.mergeExecute({
      ...input,
      exactHeadSha: "f".repeat(40),
    });
    expect(refused.allowed).toBe(false);
    const receipts = fixture.harness.cp.github.receipts(fixture.runId);
    expect(receipts.some((r) => r.operation === "merge_execute")).toBe(false);
  });
});
