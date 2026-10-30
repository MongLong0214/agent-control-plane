import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import type { CommitLoreObservation, CommitLorePort } from "../../src/bootstrap/commitlore-observation.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { RunKind } from "../../src/domain/types.ts";
import { git } from "../../src/git/git.ts";
import { bootstrapOperations, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import {
  type Operation,
  type PreparedBootstrapRun,
  activateAndConfirm,
  noGitHubCall,
  ownerApprovalFor,
  prepareBootstrapRun,
  writesOf,
} from "../helpers/bootstrap-runner.ts";
import { gitCommitAttempt } from "../helpers/commitlore-attempt.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * Issue #246 B3 (CEO c07863f8) — the bootstrap producer enforces the approved manifest's CommitLore mode.
 *
 * - `required`: without a passing CommitLore verification (`commitlore init` + `commitlore doctor --json`
 *   in the checkout at the published head) the gate is refused; with one it passes, and the bootstrap
 *   commit still carries no decision record, because its diff is the reviewed PLAN's files.
 * - `preferred`: not observed, named NOT_OBSERVED, never blocked.
 * - an unsupported value: refused by the manifest contract, and held to `required` anywhere past it.
 * - no downgrade: a required run that is refused stays required; nothing turns it into a preferred one.
 *
 * The port is a double: these witnesses never run the real `commitlore` CLI.
 */

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const pushOperations = (): Operation[] => bootstrapOperations() as Operation[];

const PASS: CommitLoreObservation = {
  outcome: "PASS",
  reportStatus: "ok",
  warnings: [],
  detail: "commitlore doctor passed",
  report: JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] }),
};
const FAIL: CommitLoreObservation = {
  outcome: "FAIL",
  reportStatus: null,
  warnings: [],
  detail: "commitlore init could not be run: spawn commitlore ENOENT",
};

/** A CommitLore double answering the n-th observation (1-based) with `answer(n)`, recording each path. */
class FakeCommitLore implements CommitLorePort {
  readonly paths: string[] = [];
  /** #1268 — the bootstrap's own commits, made by this double with plain git (`gitCommitAttempt`). */
  readonly committed: string[] = [];
  readonly attempt = gitCommitAttempt(this.committed);
  constructor(private readonly answer: (call: number) => CommitLoreObservation = () => PASS) {}
  async observe(checkoutPath: string): Promise<CommitLoreObservation> {
    this.paths.push(checkoutPath);
    return this.answer(this.paths.length);
  }
}

const requiredManifest = (projectId: string): ProjectManifest => cleanTreeManifest(projectId, { commitlore: { mode: "required" } });

const produce = (prepared: PreparedBootstrapRun) =>
  prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });

const storedResult = (prepared: PreparedBootstrapRun): RepoFactoryResult | null =>
  prepared.harness.cp.artifacts.latest<RepoFactoryResult>(prepared.runId, "REPO_FACTORY_RESULT")?.content ?? null;

describe("#246 B3: the bootstrap producer enforces the approved manifest's CommitLore mode", () => {
  it("B3-1a required, no CommitLore observer: refused before anything is consumed, read or written", async () => {
    const prepared = await prepareBootstrapRun("b3-required-unobservable", { manifest: requiredManifest("b3-required-unobservable"), ops: pushOperations() });
    const refused = await produce(prepared);
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "precondition", refusal: "COMMITLORE_REQUIRED_UNOBSERVABLE", commitloreMode: "required" },
    });
    noGitHubCall(prepared);
  });

  it("B3-1b required, CommitLore does not pass: refused before anything is consumed, read or written", async () => {
    const commitlore = new FakeCommitLore(() => FAIL);
    const prepared = await prepareBootstrapRun("b3-required-failing", {
      manifest: requiredManifest("b3-required-failing"),
      ops: pushOperations(),
      commitlore,
    });
    const refused = await produce(prepared);
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "precondition", refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", commitloreMode: "required", observation: FAIL },
    });
    expect(commitlore.paths).toHaveLength(1);
    noGitHubCall(prepared);
  });

  it("B3-1c required, a result with no CommitLore verification at the published head: activation refuses it", async () => {
    const prepared = await prepareBootstrapRun("b3-required-norow", {
      manifest: requiredManifest("b3-required-norow"),
      ops: pushOperations(),
      commitlore: new FakeCommitLore(),
    });
    const first = await produce(prepared);
    expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    const result = storedResult(prepared)!;
    const stripped: RepoFactoryResult = {
      ...result,
      bootstrapVerification: result.bootstrapVerification.filter((row) => row.commandId !== "commitlore:doctor"),
    };
    expect(stripped.bootstrapVerification).toHaveLength(result.bootstrapVerification.length - 1);
    const activated = await prepared.harness.cp.bootstrap.activate({
      runId: prepared.runId,
      candidateSnapshotDigest: prepared.snapshotDigest,
      factoryResult: stripped,
      approvedManifest: prepared.manifest,
      localBindings: result.repositories.map((repository) => ({
        identity: repository.identity,
        checkoutPath: repository.proposedCheckoutPath!,
        repositoryRole: repository.role,
      })),
      projectName: prepared.manifest.projectId,
      handoff: prepared.input.handoff,
    });
    expect(activated, JSON.stringify(activated)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", commitloreMode: "required" },
    });
  });

  it("B3-2 required, CommitLore passes: activates with the verification at the published head and no decision record made up", async () => {
    const commitlore = new FakeCommitLore();
    const prepared = await prepareBootstrapRun("b3-required-pass", {
      manifest: requiredManifest("b3-required-pass"),
      ops: pushOperations(),
      commitlore,
    });
    const { beforeConfirm, final } = await activateAndConfirm(prepared);

    const result = storedResult(prepared)!;
    const identity = result.repositories[0]!.identity;
    const head = result.bootstrapVerification[0]!.exactHead;
    expect(result.bootstrapVerification).toEqual([
      { commandId: "clean-tree", repositoryIdentity: identity, exactHead: head, status: "PASS" },
      { commandId: "commitlore:doctor", repositoryIdentity: identity, exactHead: head, status: "PASS" },
    ]);
    // Observed twice: a probe before anything was consumed or written, then the checkout at the head,
    // after the push (a hook `commitlore init` installs never runs inside the approved push).
    const checkout = result.repositories[0]!.proposedCheckoutPath!;
    expect(commitlore.paths).toHaveLength(2);
    expect(commitlore.paths[0]).not.toBe(checkout);
    expect(commitlore.paths[1]).toBe(checkout);
    expect(writesOf(prepared.github)).toContain("pushBranch");
    // The bootstrap commit carries no decision record: its diff is the reviewed PLAN's files.
    expect((await git(checkout, ["log", "-1", "--format=%B", head])).stdout.trim()).toBe("repo factory bootstrap");

    expect(beforeConfirm["warnings"]).toEqual([]);
    expect(final["warnings"]).toEqual([]);
    expect(final).toMatchObject({ projectId: "b3-required-pass", ceoConfirm: { decision: "CONFIRM" } });
    expect(prepared.harness.cp.projects.activeManifest("b3-required-pass")?.manifest.commitlore.mode).toBe("required");
  });

  it("B3-2b required on a create-only PLAN: the verification names the head GitHub initialized, observed after the create", async () => {
    const commitlore = new FakeCommitLore();
    const base = requiredManifest("b3-required-create-only");
    const manifest = { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
    const ops: Operation[] = [
      {
        operationId: "create-repository:fixture",
        resourceType: "repository",
        resourceIdentity: "github:acme/fixture",
        desiredState: { visibility: "public", autoInit: true },
      },
    ];
    const prepared = await prepareBootstrapRun("b3-required-create-only", { manifest, ops, commitlore });
    const { final } = await activateAndConfirm(prepared);
    expect(writesOf(prepared.github)).toEqual(["createRepository"]);
    const result = storedResult(prepared)!;
    const head = result.bootstrapVerification[0]!.exactHead;
    expect(result.bootstrapVerification.map((row) => [row.commandId, row.exactHead])).toEqual([
      ["clean-tree", head],
      ["commitlore:doctor", head],
    ]);
    const checkout = result.repositories[0]!.proposedCheckoutPath!;
    expect((await git(checkout, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(commitlore.paths).toEqual([expect.not.stringMatching(/^$/), checkout]);
    expect(final["warnings"]).toEqual([]);
  });

  it("B3-3 preferred, nothing observed: activates, named NOT_OBSERVED, and the port is never asked", async () => {
    const commitlore = new FakeCommitLore(() => FAIL);
    const prepared = await prepareBootstrapRun("b3-preferred", {
      manifest: cleanTreeManifest("b3-preferred"),
      ops: pushOperations(),
      commitlore,
    });
    const { beforeConfirm, final } = await activateAndConfirm(prepared);
    expect(beforeConfirm["warnings"]).toEqual([{ commitlore: "NOT_OBSERVED", mode: "preferred" }]);
    expect(final["warnings"]).toEqual([{ commitlore: "NOT_OBSERVED", mode: "preferred" }]);
    expect(storedResult(prepared)!.bootstrapVerification.map((row) => row.commandId)).toEqual(["clean-tree"]);
    expect(commitlore.paths).toEqual([]);
  });

  it("B3-4 an unsupported mode is refused by the manifest contract, and a missing one is the contract's explicit required (#1268)", () => {
    const run = { kind: RunKind.PROJECT_BOOTSTRAP, projectId: null };
    const unsupported = { ...cleanTreeManifest("b3-unsupported"), commitlore: { mode: "mandatory" } } as unknown as ProjectManifest;
    const plan = { ...bootstrapPlan(cleanTreeManifest("b3-unsupported")), projectManifest: unsupported };
    expect(planForSubmission(run, plan), "unsupported").toMatchObject({ allowed: false, evidence: { refusal: "MANIFEST_NOT_PORTABLE" } });

    // Missing: the contract's default fills `required` (#1268) before the digest, so the PLAN that is reviewed
    // and approved states it; nothing is lowered after approval.
    const { commitlore: _omitted, ...missing } = cleanTreeManifest("b3-missing");
    const admitted = planForSubmission(run, {
      ...bootstrapPlan({ ...cleanTreeManifest("b3-missing"), commitlore: { mode: "required" } }),
      projectManifest: missing,
    });
    expect(admitted.allowed).toBe(true);
    if (admitted.allowed) expect((admitted.value["projectManifest"] as ProjectManifest).commitlore).toEqual({ mode: "required" });
  });

  it("B3-5 no downgrade: a required run refused at the published head stays required, frozen, and is refused again on retry", async () => {
    // Every probe passes and every observation at the head does not: the refusal comes after the writes.
    const commitlore = new FakeCommitLore((call) => (call % 2 === 1 ? PASS : FAIL));
    const prepared = await prepareBootstrapRun("b3-no-downgrade", {
      manifest: requiredManifest("b3-no-downgrade"),
      ops: pushOperations(),
      commitlore,
    });
    const confirm = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
    const refused = await prepared.runner.produceAndActivate(confirm);
    expect(refused, JSON.stringify(refused)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { stage: "production", refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", commitloreMode: "required", at: "head" },
    });
    expect(storedResult(prepared)).toBeNull();
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
    // Never a preferred activation with a NOT_OBSERVED warning in its place.
    expect(JSON.stringify(refused)).not.toContain('"commitlore":"NOT_OBSERVED"');
    // The PLAN is frozen with its required manifest: a re-plan that lowers the mode cannot be stored.
    expect(prepared.harness.cp.bootstrapApplications.assertNotFrozen(prepared.runId, "plan_submit")).toMatchObject({
      allowed: false,
      evidence: { refusal: "BOOTSTRAP_APPLICATION_FROZEN" },
    });
    const plan = prepared.harness.cp.artifacts.latest<{ projectManifest: ProjectManifest }>(prepared.runId, "PLAN")!;
    expect(plan.content.projectManifest.commitlore.mode).toBe("required");

    // The same CONFIRM again, CommitLore still failing at the head: a new attempt, refused the same way.
    const again = await prepared.runner.produceAndActivate(confirm);
    expect(again, JSON.stringify(again)).toMatchObject({
      allowed: false,
      evidence: { stage: "production", refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", commitloreMode: "required", at: "head" },
    });
    expect(commitlore.paths).toHaveLength(4);
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
  });
});
