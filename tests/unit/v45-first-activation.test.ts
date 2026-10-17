import { execFileSync } from "node:child_process";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { RunKind, RunState, roleKeyFor, Role } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { ContractChangeRefusal } from "../../src/registry/contract-change-plan.ts";
import { WORKFLOW, WORKFLOW_PATH } from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  createRun,
  firstManifest,
  firstPlan,
  operatorRegisteredProject,
  revisionsFor,
} from "../helpers/first-activation.ts";
import { GitObjectGitHub } from "../helpers/git-object-github.ts";
import { decideThroughHermes, makeHarness, reviewerPass, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #512 (v45) — first manifest activation, end to end through the production path: plan_submit through
 * the CTO MCP port, the candidate pipeline and blind review, the CEO CONFIRM through the Hermes door
 * (which issues the first-activation grant), and the daemon finalizer, which reads every bound workflow
 * revision at its exact commit at PRE_MERGE and again at ACTIVATION and consumes the grant in the one
 * transaction that moves the pointer NULL → M1 and completes the run.
 *
 * RED at A0's head: plan_submit refuses CONTRACT_CHANGE_BASE_UNAVAILABLE (trace P3).
 */

interface Ready {
  h: Harness;
  github: GitObjectGitHub;
  projectId: string;
  registrationEventId: number;
  runId: string;
  m1: ProjectManifest;
  bound: string;
  candidate: string;
}

const requestsOf = (github: GitObjectGitHub): string[] => github.requests;

/**
 * An operator-registered NULL project whose checkout carries the approved workflow at `bound`, a
 * dispatched first-activation CONTRACT_CHANGE with its PLAN binding that commit, reviewed (PASS) and
 * published: READY_FOR_CEO_REVIEW, nobody having decided.
 */
const readyFirstActivation = async (
  projectId: string,
  options: {
    manifest?: (projectId: string) => ProjectManifest;
    revisions?: (manifest: ProjectManifest, bound: string, h: Harness) => unknown;
    workflowContent?: string;
  } = {},
): Promise<Ready> => {
  const repoPath = makeRepo({ "README.md": "# fixture\n", "verify.js": "console.log('ok')\n", [WORKFLOW_PATH]: options.workflowContent ?? WORKFLOW }, "dev");
  const github = new GitObjectGitHub(repoPath);
  const h = makeHarness({ githubClient: github, repoPath });
  const project = await operatorRegisteredProject(h, projectId);
  const bound = gitSync(repoPath, ["rev-parse", "HEAD"]);
  const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const m1 = (options.manifest ?? firstManifest)(projectId);
  const submitted = createCtoMcpPort(h.cp).submitPlan(run.runId, firstPlan(m1, (options.revisions ?? ((manifest, sha) => revisionsFor(manifest, sha)))(m1, bound, h)));
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message} ${JSON.stringify(submitted.evidence)}`);
  h.scripted.script({ match: /Contract change review/, text: reviewerPass([`${projectId}:#manifest/${manifestDigest(m1)}`]) });
  await h.cp.continuity.evaluate("first activation candidate");
  const result = await h.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "the project's first manifest",
    recommendation: "activate it",
    residualRisk: [],
  });
  if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message} ${JSON.stringify(result.evidence)}`);
  expect(h.cp.runs.require(run.runId).state, JSON.stringify(result)).toBe(RunState.READY_FOR_CEO_REVIEW);
  return { h, github, projectId, registrationEventId: project.registrationEventId, runId: run.runId, m1, bound, candidate: h.cp.runs.currentCandidate(run.runId)! };
};

const confirm = async (r: Ready, runId = r.runId, candidate = r.candidate) => {
  await r.h.cp.continuity.evaluate("confirm the first activation");
  return decideThroughHermes(r.h, { runId, decision: "CONFIRM", candidateSnapshotDigest: candidate, rationale: "first activation witness" });
};

const runDaemon = async (h: Harness): Promise<void> => {
  const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-v45-daemon-") });
  const started = await daemon.start();
  expect(started.allowed, JSON.stringify(started)).toBe(true);
  await daemon.stop();
};

const firstGrantRow = (h: Harness, runId: string) =>
  h.cp.db.get<Record<string, unknown>>(`SELECT * FROM manifest_first_activation_grants WHERE run_id = ?`, [runId]) ?? null;

const active = (h: Harness, projectId: string) => h.cp.projects.require(projectId).activeManifestDigest;

const lastFailure = (h: Harness, runId: string) =>
  h.cp.audit.forRun(runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_FAILED").at(-1) ?? null;

describe("A1: an operator-registered NULL project's first activation, end to end", () => {
  it("COMPLETED, active = M1, the grant consumed, the audit names from:null, the bound revision and reachability; only GET was sent", async () => {
    const r = await readyFirstActivation("v45-a1");
    expect(active(r.h, r.projectId)).toBeNull();
    const confirmed = await confirm(r);
    expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });
    const issued = r.h.cp.manifestGrants.getFirst(r.runId)!;
    expect(issued).toMatchObject({
      projectId: r.projectId,
      registrationEventId: r.registrationEventId,
      manifestDigest: manifestDigest(r.m1),
      candidateSnapshotDigest: r.candidate,
      workflowRevisions: revisionsFor(r.m1, r.bound),
      consumedAt: null,
    });
    expect(r.h.cp.manifestGrants.get(r.runId)).toBeNull();
    const decision = r.h.cp.audit.forRun(r.runId).find((entry) => entry.kind === "CEO_DECISION")!;
    expect(decision.evidence).toMatchObject({ manifestActivationGrantDigest: issued.grantDigest, manifestActivation: "FIRST" });

    await runDaemon(r.h);
    expect(r.h.cp.runs.require(r.runId).state, JSON.stringify(lastFailure(r.h, r.runId))).toBe(RunState.COMPLETED);
    const m1 = manifestDigest(r.m1);
    expect(active(r.h, r.projectId)).toBe(m1);
    const consumed = firstGrantRow(r.h, r.runId)!;
    expect(consumed["consumed_at"]).not.toBeNull();
    const activation = r.h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED");
    expect(activation).toHaveLength(1);
    expect(activation[0]!.evidence).toMatchObject({
      from: null,
      to: m1,
      activation: "FIRST",
      registrationEventId: r.registrationEventId,
      grantId: issued.grantId,
      grantDigest: issued.grantDigest,
      workflowRevisionsDigest: issued.workflowRevisionsDigest,
      workflows: [{
        path: WORKFLOW_PATH,
        evidence: "READ",
        revision: r.bound,
        commitSha: r.bound,
        objectType: "commit",
        observedDigest: sha256(WORKFLOW),
        readVia: "LOCAL",
        reachable: "REACHABLE",
        defaultBranchHead: r.bound,
      }],
    });
    const completed = r.h.cp.audit.forRun(r.runId).find((entry) => entry.kind === "RUN_TRANSITION" && entry.evidence["to"] === RunState.COMPLETED)!;
    expect(completed.evidence["manifestActivation"]).toEqual({ from: null, to: m1, grantId: issued.grantId });
    expect(requestsOf(r.github).length).toBeGreaterThan(0);
    expect(requestsOf(r.github).filter((request) => !request.startsWith("GET "))).toEqual([]);
    // The next run of the project pins M1.
    const next = await createRun(r.h, r.projectId, RunKind.STANDARD_WORK);
    expect(next.pinnedManifestDigest).toBe(m1);
  });
});

describe("D2 at PRE_MERGE and ACTIVATION: the bound commit, read as itself, or nothing moves", () => {
  it("D2-a: a tree id bound as the commit is refused at PRE_MERGE before anything is written; the pointer stays NULL", async () => {
    const r = await readyFirstActivation("v45-d2a", {
      revisions: (manifest, bound, h) => revisionsFor(manifest, gitSync(h.repoPath, ["rev-parse", `${bound}^{tree}`])),
    });
    expect((await confirm(r)).allowed).toBe(true);
    const refused = await new ApprovedRunFinalizer(r.h.cp, "v45-d2a").finalizeApprovedRun(r.runId);
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED",
      evidence: { activation: "FIRST", cause: { evidence: { refusal: "EXACT_READ_OBJECT_NOT_COMMIT", objectType: "tree" } } },
    });
    expect(r.h.cp.runs.require(r.runId).state).toBe(RunState.CEO_APPROVED);
    expect(active(r.h, r.projectId)).toBeNull();
    expect(firstGrantRow(r.h, r.runId)!["consumed_at"]).toBeNull();
    expect(requestsOf(r.github).some((request) => /git\/(commits|trees|blobs)/.test(request))).toBe(false);
  });

  it("D2-e: a bound commit replaced by one with the approved bytes is read as the original; digest mismatch refuses activation", async () => {
    const alternate = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo not approved\n";
    const r = await readyFirstActivation("v45-d2e", { workflowContent: alternate });
    // The approved bytes on another commit, put in place of the bound one by a replace ref.
    writeFiles(r.h.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
    const approved = commitAll(r.h.repoPath, "approved bytes elsewhere");
    gitSync(r.h.repoPath, ["update-ref", `refs/replace/${r.bound}`, approved]);
    expect((await confirm(r)).allowed).toBe(true);
    const refused = await new ApprovedRunFinalizer(r.h.cp, "v45-d2e").finalizeApprovedRun(r.runId);
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: "MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED",
      evidence: { revision: r.bound, observedDigest: sha256(alternate), readVia: "LOCAL" },
    });
    expect(active(r.h, r.projectId)).toBeNull();
  });

  it("D2-c: a newer default head with identical bytes is never substituted; the activation records the bound commit and the head as evidence", async () => {
    const r = await readyFirstActivation("v45-d2c");
    writeFiles(r.h.repoPath, { "README.md": "# a newer head, the same workflow\n" });
    const head = commitAll(r.h.repoPath, "newer head");
    expect((await confirm(r)).allowed).toBe(true);
    await runDaemon(r.h);
    expect(r.h.cp.runs.require(r.runId).state).toBe(RunState.COMPLETED);
    expect(r.h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED")[0]!.evidence["workflows"]).toEqual([
      expect.objectContaining({ revision: r.bound, commitSha: r.bound, defaultBranchHead: head, reachable: "REACHABLE" }),
    ]);
  });

  it("a bound commit only GitHub holds is read by object id from GitHub, and activation completes", async () => {
    const remote = makeRepo({ "README.md": "# remote\n", "verify.js": "console.log('ok')\n", [WORKFLOW_PATH]: WORKFLOW }, "dev");
    const local = `${tempDir("acp-v45-remote-")}/checkout`;
    gitSync(remote, ["rev-parse", "HEAD"]);
    execClone(remote, local);
    gitSync(local, ["remote", "set-url", "origin", "https://github.com/acme/fixture.git"]);
    writeFiles(remote, { "README.md": "# only on GitHub\n" });
    const onlyRemote = commitAll(remote, "only on GitHub");
    const github = new GitObjectGitHub(remote);
    const h = makeHarness({ githubClient: github, repoPath: local });
    const project = await operatorRegisteredProject(h, "v45-remote");
    const run = await createRun(h, project.projectId, RunKind.CONTRACT_CHANGE);
    const m1 = firstManifest(project.projectId);
    expect(createCtoMcpPort(h.cp).submitPlan(run.runId, firstPlan(m1, revisionsFor(m1, onlyRemote))).allowed).toBe(true);
    h.scripted.script({ match: /Contract change review/, text: reviewerPass([`${project.projectId}:#manifest/${manifestDigest(m1)}`]) });
    await h.cp.continuity.evaluate("remote");
    const submitted = await h.cp.pipeline.submitResult({
      runId: run.runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "s", recommendation: "r", residualRisk: [],
    });
    expect(submitted.allowed, JSON.stringify(submitted)).toBe(true);
    await h.cp.continuity.evaluate("confirm");
    expect((await decideThroughHermes(h, { runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest: h.cp.runs.currentCandidate(run.runId)! })).allowed).toBe(true);
    await runDaemon(h);
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.COMPLETED);
    expect(h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED")[0]!.evidence["workflows"]).toEqual([
      expect.objectContaining({ revision: onlyRemote, readVia: "GITHUB", observedDigest: sha256(WORKFLOW) }),
    ]);
    expect(github.requests.some((request) => request.includes("/contents/"))).toBe(false);
    expect(github.requests.filter((request) => !request.startsWith("GET "))).toEqual([]);
  });
});

describe("D1-a at activation: a first grant's coverage is never ([], [])", () => {
  it("activateManifest with no workflows read is refused for a first grant; the grant stays unconsumed and the pointer NULL", async () => {
    const r = await readyFirstActivation("v45-d1a-activate");
    expect((await confirm(r)).allowed).toBe(true);
    for (const state of [RunState.MERGING, RunState.POST_MERGE_VERIFYING]) {
      expect(r.h.cp.runs.transition(r.runId, state, "toward activation", {}).allowed).toBe(true);
    }
    r.h.cp.db.run(
      `INSERT INTO finalization_attempts (run_id, attempt_id, lease_owner, candidate_digest, state, started_at, deadline_at, last_step)
       VALUES (?, 'attempt-d1a', 'witness', ?, 'RUNNING', ?, ?, 'ACTIVATE')`,
      [r.runId, r.candidate, r.h.clock.nowIso(), new Date(r.h.clock.now().getTime() + 600_000).toISOString()],
    );
    const refused = r.h.cp.projects.activateManifest(r.runId, {
      completion: r.h.cp.completionAuthoritiesForTests().daemonFinalizer,
      attemptId: "attempt-d1a",
      workflows: [],
      consumer: r.h.cp.manifestGrants.consumerOf(r.runId),
    });
    expect(refused).toMatchObject({ allowed: false, reasonCode: "MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED", evidence: { activation: "FIRST" } });
    expect(firstGrantRow(r.h, r.runId)!["consumed_at"]).toBeNull();
    expect(active(r.h, r.projectId)).toBeNull();
  });
});

describe("A2–A7: who may activate, against what, and only once", () => {
  it("A2: a project a bootstrap application names is not operator-registered; its first-activation PLAN is refused", async () => {
    const repoPath = makeRepo({ "README.md": "# x\n" }, "dev");
    const h = makeHarness({ repoPath });
    const project = await operatorRegisteredProject(h, "v45-a2");
    const other = await createRun(h, project.projectId, RunKind.STANDARD_WORK, { dispatch: false });
    h.cp.db.run(
      `INSERT INTO bootstrap_applications (run_id, project_id, repository_identity, bootstrap_operation_id, plan_digest, manifest_digest,
         planned_outputs_digest, candidate_snapshot_digest, review_digest, approval_digest, phase, attempts, reserved_at)
       VALUES (?, ?, 'github:acme/bootstrapped', 'op', 'p', 'm', 'o', 'c', 'r', 'a', 'RESERVED', 0, 't')`,
      [other.runId, project.projectId],
    );
    const run = await createRun(h, project.projectId, RunKind.CONTRACT_CHANGE);
    const m1 = firstManifest(project.projectId);
    expect(createCtoMcpPort(h.cp).submitPlan(run.runId, firstPlan(m1, revisionsFor(m1, "1".repeat(40))))).toMatchObject({
      allowed: false,
      evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_NOT_OPERATOR_REGISTERED },
    });
  });

  it("A3: activating one NULL project leaves another NULL; its grant moves only its own project", async () => {
    const r = await readyFirstActivation("v45-a3");
    const other = await operatorRegisteredProject(r.h, "v45-a3-other", { identity: "github:acme/other", checkoutPath: makeRepo() });
    expect((await confirm(r)).allowed).toBe(true);
    await runDaemon(r.h);
    expect(active(r.h, r.projectId)).toBe(manifestDigest(r.m1));
    expect(active(r.h, other.projectId)).toBeNull();
    expect(() => r.h.cp.db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [manifestDigest(r.m1), other.projectId]))
      .toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
  });

  it("A4 / A5: two first activations on one NULL project are both confirmed; one activates, the other is refused on E2 and cannot consume", async () => {
    const r = await readyFirstActivation("v45-a5");
    // A second first-activation run of the same project, reviewed and ready, on the same commit.
    const second = await createRun(r.h, r.projectId, RunKind.CONTRACT_CHANGE);
    const m1b = firstManifest(r.projectId, undefined, { postMergeCommands: ["verify"] });
    expect(createCtoMcpPort(r.h.cp).submitPlan(second.runId, firstPlan(m1b, revisionsFor(m1b, r.bound))).allowed).toBe(true);
    r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([`${r.projectId}:#manifest/${manifestDigest(m1b)}`]) });
    await r.h.cp.continuity.evaluate("second");
    expect((await r.h.cp.pipeline.submitResult({
      runId: second.runId, ownerSessionId: second.ownerSessionId!, ownerBindingGeneration: second.ownerBindingGeneration!,
      resultSummary: "s", recommendation: "r", residualRisk: [],
    })).allowed).toBe(true);
    const secondCandidate = r.h.cp.runs.currentCandidate(second.runId)!;
    expect((await confirm(r)).allowed).toBe(true);
    expect((await confirm(r, second.runId, secondCandidate)).allowed).toBe(true);
    expect(r.h.cp.manifestGrants.getFirst(second.runId)).not.toBeNull();

    const [a, b] = await Promise.all([
      new ApprovedRunFinalizer(r.h.cp, "v45-a5-a").finalizeApprovedRun(r.runId),
      new ApprovedRunFinalizer(r.h.cp, "v45-a5-b").finalizeApprovedRun(second.runId),
    ]);
    expect(a.allowed, JSON.stringify(a)).toBe(true);
    expect(b).toMatchObject({ allowed: false, reasonCode: "CONTRACT_CHANGE_FINALIZATION_OVERLAP" });
    expect(active(r.h, r.projectId)).toBe(manifestDigest(r.m1));
    const later = await new ApprovedRunFinalizer(r.h.cp, "v45-a5-b-later").finalizeApprovedRun(second.runId);
    expect(later).toMatchObject({ allowed: false, reasonCode: "MANIFEST_PIN_SUPERSEDED", evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_PROJECT_NOT_NULL } });
    expect(r.h.cp.runs.require(second.runId).state).toBe(RunState.CEO_APPROVED);
    expect(firstGrantRow(r.h, second.runId)!["consumed_at"]).toBeNull();
    expect(() => r.h.cp.db.run(`UPDATE manifest_first_activation_grants SET consumed_at = 't', consumed_attempt_id = 'raw' WHERE run_id = ?`, [second.runId]))
      .toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
    // A4: the consumed grant replays nothing: finalizing again is the idempotent replay, one activation.
    const replay = await new ApprovedRunFinalizer(r.h.cp, "v45-a4-replay").finalizeApprovedRun(r.runId);
    expect(replay).toMatchObject({ allowed: true, reasonCode: "MERGE_IDEMPOTENT_REPLAY" });
    expect(r.h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED")).toHaveLength(1);
  });

  it("A4: a first-activation run reviewed before the project activated is refused at CONFIRM afterwards, with no grant", async () => {
    const r = await readyFirstActivation("v45-a4-confirm");
    const second = await createRun(r.h, r.projectId, RunKind.CONTRACT_CHANGE);
    const m1b = firstManifest(r.projectId, undefined, { postMergeCommands: ["verify"] });
    expect(createCtoMcpPort(r.h.cp).submitPlan(second.runId, firstPlan(m1b, revisionsFor(m1b, r.bound))).allowed).toBe(true);
    r.h.scripted.script({ match: /Contract change review/, text: reviewerPass([`${r.projectId}:#manifest/${manifestDigest(m1b)}`]) });
    await r.h.cp.continuity.evaluate("second");
    expect((await r.h.cp.pipeline.submitResult({
      runId: second.runId, ownerSessionId: second.ownerSessionId!, ownerBindingGeneration: second.ownerBindingGeneration!,
      resultSummary: "s", recommendation: "r", residualRisk: [],
    })).allowed).toBe(true);
    expect((await confirm(r)).allowed).toBe(true);
    await runDaemon(r.h);
    expect(active(r.h, r.projectId)).toBe(manifestDigest(r.m1));
    const refused = await confirm(r, second.runId, r.h.cp.runs.currentCandidate(second.runId)!);
    expect(refused).toMatchObject({ allowed: false, reasonCode: "MANIFEST_PIN_SUPERSEDED" });
    expect(r.h.cp.runs.require(second.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(firstGrantRow(r.h, second.runId)).toBeNull();
  });

  it("A6: a repository added to the project after CONFIRM refuses at PRE_MERGE; a role changed during PRE_MERGE refuses at ACTIVATION; the pointer stays NULL", async () => {
    {
      const r = await readyFirstActivation("v45-a6-added");
      expect((await confirm(r)).allowed).toBe(true);
      const added = await r.h.cp.repositories.register({ checkoutPath: makeRepo(), projectId: r.projectId, repositoryRole: "secondary", identity: "github:acme/added" });
      expect(added.allowed).toBe(true);
      const refused = await new ApprovedRunFinalizer(r.h.cp, "v45-a6-added").finalizeApprovedRun(r.runId);
      expect(refused).toMatchObject({ allowed: false, reasonCode: "REPOSITORY_IDENTITY_MISMATCH", evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_REPOSITORIES_MISMATCH } });
      expect(active(r.h, r.projectId)).toBeNull();
    }
    {
      const r = await readyFirstActivation("v45-a6-role");
      expect((await confirm(r)).allowed).toBe(true);
      // Between the PRE_MERGE read and ACTIVATION: the read of the default head is the PRE_MERGE one's last step.
      let changed = false;
      r.github.overrides.set("/repos/acme/fixture/git/ref/heads/dev", () => {
        if (!changed) {
          changed = true;
          r.h.cp.db.run(`UPDATE repositories SET repository_role = 'secondary' WHERE project_id = ?`, [r.projectId]);
        }
        return { object: { sha: r.bound } };
      });
      const refused = await new ApprovedRunFinalizer(r.h.cp, "v45-a6-role").finalizeApprovedRun(r.runId);
      expect(changed).toBe(true);
      expect(refused).toMatchObject({ allowed: false });
      expect(refused).toMatchObject({
        reasonCode: "MANIFEST_ACTIVATION_REFUSED",
        evidence: { refusal: { reasonCode: "REPOSITORY_IDENTITY_MISMATCH", evidence: { phase: "ACTIVATION", refusal: ContractChangeRefusal.FIRST_ACTIVATION_REPOSITORIES_MISMATCH } } },
      });
      expect(active(r.h, r.projectId)).toBeNull();
      expect(firstGrantRow(r.h, r.runId)!["consumed_at"]).toBeNull();
    }
  });

  it("A7: binding drift refuses — the PLAN replaced after review, the review replaced, the CEO not live, no ingress, a participating repository", async () => {
    {
      const r = await readyFirstActivation("v45-a7-plan");
      expect((await confirm(r)).allowed).toBe(true);
      expect(createCtoMcpPort(r.h.cp).submitPlan(r.runId, firstPlan(r.m1, revisionsFor(r.m1, "3".repeat(40)))).allowed).toBe(true);
      expect(await new ApprovedRunFinalizer(r.h.cp, "v45-a7-plan").finalizeApprovedRun(r.runId)).toMatchObject({
        allowed: false,
        reasonCode: "MANIFEST_ACTIVATION_TARGET_STALE",
      });
      expect(active(r.h, r.projectId)).toBeNull();
    }
    {
      const r = await readyFirstActivation("v45-a7-review");
      expect((await confirm(r)).allowed).toBe(true);
      const review = r.h.cp.artifacts.latestForSnapshot<Record<string, unknown>>(r.runId, "BLIND_REVIEW", r.candidate)!;
      r.h.clock.advance(1000);
      r.h.cp.artifacts.putEvidence(r.h.cp.evidenceWritersForTests().BLIND_REVIEW, r.runId, "BLIND_REVIEW", { ...review.content, verdict: "REVISE", createdAt: r.h.clock.nowIso() }, r.candidate);
      expect(await new ApprovedRunFinalizer(r.h.cp, "v45-a7-review").finalizeApprovedRun(r.runId)).toMatchObject({
        allowed: false,
        reasonCode: "MANIFEST_ACTIVATION_TARGET_STALE",
      });
      expect(active(r.h, r.projectId)).toBeNull();
    }
    {
      // The review replaced by a REVISE before CONFIRM: nothing is confirmed or granted.
      const r = await readyFirstActivation("v45-a7-review-before");
      const review = r.h.cp.artifacts.latestForSnapshot<Record<string, unknown>>(r.runId, "BLIND_REVIEW", r.candidate)!;
      r.h.clock.advance(1000);
      r.h.cp.artifacts.putEvidence(r.h.cp.evidenceWritersForTests().BLIND_REVIEW, r.runId, "BLIND_REVIEW", { ...review.content, verdict: "REVISE", createdAt: r.h.clock.nowIso() }, r.candidate);
      expect((await confirm(r)).allowed).toBe(false);
      expect(firstGrantRow(r.h, r.runId)).toBeNull();
      expect(r.h.cp.runs.require(r.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    }
    {
      const r = await readyFirstActivation("v45-a7-ceo");
      expect((await confirm(r)).allowed).toBe(true);
      const ceo = r.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      r.h.cp.db.run(`UPDATE conversational_actors SET retired_at = ?, retired_reason = 'v45 witness' WHERE current_session_id = ?`, [r.h.clock.nowIso(), ceo.sessionId]);
      expect(await new ApprovedRunFinalizer(r.h.cp, "v45-a7-ceo").finalizeApprovedRun(r.runId)).toMatchObject({
        allowed: false,
        reasonCode: "MANIFEST_ACTIVATION_AUTHORITY_STALE",
      });
      expect(active(r.h, r.projectId)).toBeNull();
    }
    {
      const r = await readyFirstActivation("v45-a7-ingress");
      await r.h.cp.continuity.evaluate("no ingress");
      const result = r.h.cp.ceo.submitCeoDecision({
        runId: r.runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: r.candidate,
        ceoSessionId: r.h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId,
        rationale: "an internal caller with no door",
      });
      expect(result.allowed).toBe(false);
      expect(r.h.cp.runs.require(r.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(firstGrantRow(r.h, r.runId)).toBeNull();
    }
    {
      const repoPath = makeRepo({ "README.md": "# x\n" }, "dev");
      const h = makeHarness({ repoPath });
      const project = await operatorRegisteredProject(h, "v45-a7-participants");
      const created = h.cp.runs.create({
        projectId: project.projectId,
        kind: RunKind.CONTRACT_CHANGE,
        executionMode: "STANDARD",
        contract: { goal: "g", why: "w", scope: [], nonGoals: [], acceptance: [], priority: "NORMAL", humanGate: [], references: [] },
        repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      } as Parameters<typeof h.cp.runs.create>[0]);
      expect(created.allowed, JSON.stringify(created)).toBe(true);
      if (!created.allowed) return;
      const m1 = firstManifest(project.projectId);
      expect(createCtoMcpPort(h.cp).submitPlan(created.value.runId, firstPlan(m1, revisionsFor(m1, "1".repeat(40))))).toMatchObject({
        allowed: false,
        evidence: { refusal: ContractChangeRefusal.FIRST_ACTIVATION_RUN_HAS_REPOSITORIES },
      });
    }
  });
});

const execClone = (from: string, to: string): void => {
  execFileSync("git", ["clone", "-q", from, to], { timeout: 30_000 });
};
