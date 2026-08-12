import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { GATE_CHECK_NAME, NO_HUMAN_GATE_DIGEST, type GatePayload } from "../../src/github/github-kernel.ts";
import { cleanupTempDirs, makeRepo } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { type Harness, driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";

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

const setup = async (options: { declareChecks?: boolean } = {}): Promise<Fixture> => {
  const github = new FakeGitHub();
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });

  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-thing",
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
      humanGateDigest: NO_HUMAN_GATE_DIGEST,
      bindingGeneration: driven.ownerBindingGeneration,
      exactHead: driven.candidateHead,
      timestamp: "2026-08-12T00:00:00.000Z",
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

    fixture.harness.cp.db.run(`UPDATE resource_claims SET branch = 'feature/other' WHERE run_id = ?`, [
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

  it("records MERGED when the merge commit's first parent is the evaluated base", async () => {
    const { fixture, pullNumber } = await readyToMerge();
    const merged = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(merged.allowed).toBe(true);
    const repository = fixture.harness.cp.runs
      .repositoriesOf(fixture.runId)
      .find((r) => r.identity === fixture.identity)!;
    expect(repository.mergeState).toBe("MERGED");
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
    const refused = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      "9".repeat(40),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);
    expect(refused.evidence["failed"]).toEqual([{ name: "project-ci", conclusion: "missing" }]);
  });

  it("treats a check that has not completed as a failure", async () => {
    const fixture = await setup();
    const mergeSha = "9".repeat(40);
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
});

describe("release tags and issue projection are owner-authorised (CP-HI-01)", () => {
  it("refuses an issue projection from a session that does not own the run", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      [{ id: "T001", title: "first", body: "body" }],
      { ownerSessionId: "ses_someone_else", ownerBindingGeneration: 1 },
    );
    expect(refused.allowed).toBe(false);
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
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      "1".repeat(40),
      { ownerSessionId: "ses_someone_else", ownerBindingGeneration: 1 },
    );
    expect(refused.allowed).toBe(false);
    expect(fixture.github.tags.size).toBe(0);
  });
});

describe("the trusted credential has no read surface (CP-HI-05)", () => {
  it("offers no way to obtain the token in-process", async () => {
    const fixture = await setup();
    const store = fixture.harness.cp.credentials as unknown as Record<string, unknown>;
    expect(typeof store["withToken"]).toBe("undefined");
    expect(JSON.stringify(store)).not.toContain("test-token");
  });

  it("injects the credential into the child process and writes its stdin", async () => {
    const fixture = await setup();
    // A stand-in for `gh api --input -`: it must receive both the environment variable and
    // the request body, and it must not hang waiting for stdin to close.
    const result = await fixture.harness.cp.credentials.run({
      file: process.execPath,
      args: [
        "-e",
        "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>console.log(JSON.stringify({token:process.env.GH_TOKEN,body:b})))",
      ],
      tokenEnvVar: "GH_TOKEN",
      env: { PATH: process.env["PATH"] ?? "" },
      input: JSON.stringify({ merge_method: "merge" }),
      timeoutMs: 30_000,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.exitCode).toBe(0);
    const observed = JSON.parse(result.value.stdout) as { token: string; body: string };
    expect(observed.token).toBe("test-token");
    expect(JSON.parse(observed.body)).toEqual({ merge_method: "merge" });
  });
});

describe("merge order and dependents are enforced by the kernel (§24.7)", () => {
  it("refuses a merge while an earlier repository in the run is still pending", async () => {
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
    });
    expect(attached.allowed).toBe(true);

    const docsHead = "d2".padEnd(40, "0");
    fixture.github.setBranch("feature/F2-docs", docsHead);
    const claimed = fixture.harness.cp.claims.acquire({
      runId: fixture.runId,
      ownerSessionId: fixture.caller.ownerSessionId,
      ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
      ownerRoleKey: fixture.harness.cp.runs.require(fixture.runId).ownerRoleKey!,
      repositoryIdentity: "github:acme/docs",
      branch: "feature/F2-docs",
    });
    if (!claimed.allowed) throw new Error(claimed.message);

    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: "github:acme/docs",
      head: "feature/F2-docs",
      base: "dev",
      title: "docs",
      body: "",
      ownerSessionId: fixture.caller.ownerSessionId,
      ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
      exactHeadSha: docsHead,
    });
    if (!prepared.allowed) throw new Error(`${prepared.reasonCode}: ${prepared.message}`);

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: "github:acme/docs",
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: docsHead,
      expectedBaseSha: fixture.github.headShaFor("dev"),
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.caller.ownerSessionId,
      ownerBindingGeneration: fixture.caller.ownerBindingGeneration,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_ORDER_VIOLATION);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("refuses a merge after any repository in the run failed post-merge verification", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pullNumber = await openPull(fixture);

    // A failed post-merge check on this run blocks anything that follows it.
    const mergeSha = "8".repeat(40);
    fixture.github.setPostMergeCheck(mergeSha, "project-ci", "failure");
    const verified = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      mergeSha,
    );
    expect(verified.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.DEPENDENT_MERGE_BLOCKED);
    expect(fixture.github.mergeCount).toBe(0);
  });
});
