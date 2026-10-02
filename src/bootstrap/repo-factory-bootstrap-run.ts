import { join } from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, manifestDigest } from "../contracts/manifest.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import { ArtifactKind, RunKind } from "../domain/types.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { ACPBootstrapActivationResult, BootstrapActivation } from "./activation.ts";
import type { GitHubWritePort } from "./github-write-port.ts";
import { preflightGitHubOperations, type GitHubWriteAuthority } from "./repo-factory-github.ts";
import { produceRepoFactoryResult, repoFactoryPlanFixtureSchema } from "./repo-factory-producer.ts";
import { parseRepoFactoryResult, type RepoFactoryResult } from "./repo-factory-result.ts";

/**
 * Issue #246 — the PROJECT_BOOTSTRAP run path that performs a Repo Factory plan's GitHub writes
 * and hands the produced result to `BootstrapActivation.activate`.
 *
 * Where in the run lifecycle. A PROJECT_BOOTSTRAP run has no CEO_APPROVED stage: it goes from
 * READY_FOR_CEO_REVIEW straight to COMPLETED through the CEO confirm transaction
 * (`RunEngine` refuses any other completion edge for this kind), and `activate` refuses any state
 * but READY_FOR_CEO_REVIEW. So this runs there — after the blind review passed, before the CEO
 * confirms — rather than after a CEO approval this run kind never has: READY_FOR_CEO_REVIEW is
 * the only state in which its output can be activated at all.
 *
 * The blind review that state requires happened before the writes, so it covered the run's
 * candidate, not the commit the producer pushes. Today that commit carries no authored content
 * (a fixed bootstrap file); a factory that renders templates into it needs the review after
 * production instead.
 *
 * What authorises the write. An owner approval receipt, rather than the run, the CTO or the plan:
 * one minted by admitted ingress (`OwnerAuthority`, PRD §21/§27.2) for the operation
 * `REPO_FACTORY_GITHUB_WRITE_OPERATION`, whose parameter digest binds the owner, the visibility,
 * the approved PLAN artifact's digest and its `githubOperations`. A caller can carry the receipt;
 * it cannot mint one, because `assertApproval` re-reads the ingress admission it came from. The
 * receipt is consumed once for the run's current candidate and re-admitted from that durable
 * consumption on a retry, so a partial failure can resume without a second approval and the
 * approval cannot be carried to a different candidate.
 *
 * Everything that can be refused is refused before the first GitHub call: run kind and state,
 * the activation preconditions a result cannot change, the executable plan against the approved
 * PLAN artifact, the manifest against both, the approval, and the producer's own pure
 * preflight. A refusal here has made no GitHub read or write.
 *
 * A produced result is retained (REPO_FACTORY_RESULT) before activation is attempted. Activation
 * of a fresh bootstrap normally stops once — the incoming CTO has not yet acknowledged its
 * handoff — and the second call must activate the result already produced rather than produce
 * again: the producer's checkout now exists, and a second production would be refused as a
 * collision.
 *
 * Who calls this is not decided here. No transport invokes it — as none invokes `activate` — and
 * no ingress path mints a receipt for `REPO_FACTORY_GITHUB_WRITE_OPERATION` yet; until both exist,
 * every production call is refused at the approval, before any GitHub call.
 */

export const REPO_FACTORY_GITHUB_WRITE_OPERATION = "repo_factory_github_write";

/**
 * The parameters an owner approves for `REPO_FACTORY_GITHUB_WRITE_OPERATION`. An ingress path
 * that mints the receipt must digest exactly this object (`ownerApprovalPayload` digests
 * `parameters`); anything else is a different approval.
 */
export const repoFactoryGitHubWriteParameters = (input: {
  owner: string;
  visibility: "public" | "private";
  planDigest: string;
  githubOperations: ReadonlyArray<{ operationId: string; resourceType: string; resourceIdentity: string }>;
}): Record<string, unknown> => ({
  owner: input.owner,
  visibility: input.visibility,
  planDigest: input.planDigest,
  githubOperations: input.githubOperations.map((operation) => ({
    operationId: operation.operationId,
    resourceType: operation.resourceType,
    resourceIdentity: operation.resourceIdentity,
  })),
});

/** The approved PLAN artifact's shape, as `BootstrapActivation` already requires it. */
const approvedPlanSchema = z.object({
  bootstrapOperationId: z.string().min(1),
  requestDigest: z.string().min(1),
  projectManifestDigest: z.string().min(1),
  githubOperations: z.array(
    z.object({
      operationId: z.string().min(1),
      resourceType: z.string().min(1),
      resourceIdentity: z.string().min(1),
    }),
  ),
});

const ownerApprovalReceiptSchema = z
  .object({
    channel: z.string().min(1),
    actor: z.string().min(1),
    inboundNonce: z.string().min(1),
    runId: z.string().nullable(),
    candidateSnapshotDigest: z.string().nullable(),
    operation: z.string().min(1),
    parameterDigest: z.string().min(1),
    idempotencyKey: z.string().min(1),
    approved: z.boolean(),
  })
  .strict();

/** `runId` becomes a directory name under the work root; it may not carry a path. */
const PATH_SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

export interface RepoFactoryOwnerApproval {
  owner: string;
  visibility: "public" | "private";
  /** The admitted ingress receipt. Its parameter digest is what binds the two fields above. */
  receipt: unknown;
}

export interface ProduceAndActivateInput {
  runId: string;
  /** The executable plan: the approved PLAN artifact's operations, each with its desired state. */
  plan: unknown;
  ownerApproval: RepoFactoryOwnerApproval | null;
  approvedManifest: ProjectManifest;
  projectName: string;
  handoff: HandoffPackage;
}

export interface RepoFactoryBootstrapRunnerDeps {
  runs: Pick<RunEngine, "get" | "currentCandidate">;
  artifacts: Pick<ArtifactStore, "latest" | "put">;
  ownerAuthority: Pick<OwnerAuthorityPort, "assertConsumedApproval" | "consumeApproval">;
  bootstrap: Pick<BootstrapActivation, "activate" | "readinessForFactoryResult">;
  /** The production composition passes `createGhCliGitHubWritePort()`; tests pass a double. */
  githubPort: GitHubWritePort;
  /** Each run produces under `<workRoot>/<runId>`. Null means this deployment never configured one. */
  workRoot: string | null;
  clock: Clock;
}

type Stage = "precondition" | "approval" | "production" | "activation";

const atStage = <T>(decision: Decision<T>, stage: Stage): Decision<T> =>
  decision.allowed ? decision : { ...decision, evidence: { stage, ...decision.evidence } };

export class RepoFactoryBootstrapRunner {
  constructor(private readonly deps: RepoFactoryBootstrapRunnerDeps) {}

  async produceAndActivate(input: ProduceAndActivateInput): Promise<Decision<ACPBootstrapActivationResult>> {
    const { runId } = input;
    const refuse = (
      reasonCode: ReasonCode,
      refusal: string,
      message: string,
      evidence: Evidence = {},
      stage: Stage = "precondition",
    ): Decision<ACPBootstrapActivationResult> => deny(reasonCode, message, { stage, refusal, runId, ...evidence });

    const run = this.deps.runs.get(runId);
    if (run === null) return refuse(ReasonCode.NOT_FOUND, "RUN_UNKNOWN", "unknown run");
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "RUN_NOT_BOOTSTRAP", "a Repo Factory run needs a PROJECT_BOOTSTRAP run", {
        kind: run.kind,
      });
    }
    const ready = this.deps.bootstrap.readinessForFactoryResult(runId, input.handoff);
    if (!ready.allowed) return atStage(ready as Decision<ACPBootstrapActivationResult>, "precondition");

    const planArtifact = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    const approvedPlan = approvedPlanSchema.safeParse(planArtifact?.content);
    if (planArtifact === null) {
      return refuse(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "PLAN_MISSING", "the run has no approved PLAN artifact");
    }
    if (!approvedPlan.success) {
      return refuse(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "PLAN_MISSING",
        "the run's PLAN artifact carries no bootstrap operation provenance",
      );
    }
    const plan = approvedPlan.data;

    const retained = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.REPO_FACTORY_RESULT);
    if (retained !== null) {
      const parsed = parseRepoFactoryResult(retained.content);
      if (!parsed.allowed) return atStage(parsed as Decision<ACPBootstrapActivationResult>, "activation");
      return this.activate(input, parsed.value);
    }

    const fixture = repoFactoryPlanFixtureSchema.safeParse(input.plan);
    if (!fixture.success) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "PLAN_INVALID", "the executable plan failed validation", {
        issues: fixture.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const executable = fixture.data;

    // The executable plan is the approved PLAN artifact with each operation's desired state
    // filled in. Every identity field must be the approved one; the operations themselves are
    // compared by `preflightGitHubOperations` below against the artifact's own triples.
    const planMismatch = (field: string, approved: string, planned: string): Decision<ACPBootstrapActivationResult> =>
      refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "PLAN_MISMATCH",
        `the executable plan's ${field} is not the approved PLAN artifact's`,
        { field, approved, planned },
      );
    if (executable.runId !== runId) return planMismatch("runId", runId, executable.runId);
    if (executable.planDigest !== planArtifact.digest) {
      return planMismatch("planDigest", planArtifact.digest, executable.planDigest);
    }
    if (executable.bootstrapOperationId !== plan.bootstrapOperationId) {
      return planMismatch("bootstrapOperationId", plan.bootstrapOperationId, executable.bootstrapOperationId);
    }
    if (executable.requestDigest !== plan.requestDigest) {
      return planMismatch("requestDigest", plan.requestDigest, executable.requestDigest);
    }
    if (executable.projectManifestDigest !== plan.projectManifestDigest) {
      return planMismatch("projectManifestDigest", plan.projectManifestDigest, executable.projectManifestDigest);
    }
    if (executable.githubOperations.length === 0) {
      // A local-only result names its repository `local:<role>`, which no portable manifest
      // remote can equal; producing one here would write a checkout activation must refuse.
      return refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "GITHUB_PLAN_REQUIRED",
        "an activatable bootstrap names a GitHub repository; this plan has no GitHub operation",
      );
    }

    const manifestMismatch = (message: string, evidence: Evidence): Decision<ACPBootstrapActivationResult> =>
      refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "MANIFEST_MISMATCH", message, evidence);
    const approvedManifestDigest = manifestDigest(input.approvedManifest);
    if (approvedManifestDigest !== plan.projectManifestDigest) {
      return manifestMismatch("the manifest supplied is not the one the PLAN artifact approved", {
        supplied: approvedManifestDigest,
        approved: plan.projectManifestDigest,
      });
    }

    if (input.ownerApproval === null) {
      return refuse(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "APPROVAL_MISSING",
        "a Repo Factory GitHub write needs the owner's approval, and none was supplied",
        {},
        "approval",
      );
    }
    const authority: GitHubWriteAuthority = {
      owner: input.ownerApproval.owner,
      visibility: input.ownerApproval.visibility,
      approvedOperations: plan.githubOperations,
    };
    // The producer's own pure preflight, run here so a plan it would refuse never consumes the
    // owner's approval. It runs again inside the producer; that second run is a no-op check.
    const execution = preflightGitHubOperations(executable, authority);
    if (!execution.allowed) return atStage(execution as Decision<ACPBootstrapActivationResult>, "precondition");

    // Activation matches the result to the manifest by role and identity, and requires every
    // required command's verification. Either mismatch would be found only after the writes.
    const repositories = input.approvedManifest.repositories;
    const declared = repositories.find((repository) => repository.role === executable.repositoryRole);
    if (repositories.length !== 1) {
      return manifestMismatch("this producer creates exactly one repository and the manifest declares a different count", {
        declared: repositories.length,
      });
    }
    if (declared === undefined) {
      return manifestMismatch("the manifest declares no repository for the plan's role", {
        role: executable.repositoryRole,
      });
    }
    if (declared.remote !== execution.value.repositoryIdentity) {
      return manifestMismatch("the manifest's remote is not the repository the plan creates", {
        manifestRemote: declared.remote,
        planned: execution.value.repositoryIdentity,
      });
    }
    const unverifiable = input.approvedManifest.verificationCommands
      .filter((command) => command.required)
      .filter((command) => command.id !== executable.verificationCommandId)
      .map((command) => command.id);
    if (unverifiable.length > 0) {
      return manifestMismatch("the manifest requires verification the plan does not produce", {
        unverifiable,
        produced: executable.verificationCommandId,
      });
    }

    const workRoot = this.deps.workRoot;
    if (workRoot === null) {
      return refuse(
        ReasonCode.INVALID_ARGUMENT,
        "WORK_ROOT_UNCONFIGURED",
        "this deployment has no Repo Factory work root; nothing is produced without one",
      );
    }
    if (!PATH_SAFE_RUN_ID.test(runId)) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "RUN_ID_NOT_PATH_SAFE", "the run id cannot name a work directory");
    }

    const approval = this.admitApproval(runId, input.ownerApproval.receipt, {
      owner: authority.owner,
      visibility: authority.visibility,
      planDigest: planArtifact.digest,
      githubOperations: plan.githubOperations,
    });
    if (!approval.allowed) return atStage(approval as Decision<ACPBootstrapActivationResult>, "approval");

    const produced = await produceRepoFactoryResult({
      plan: executable,
      workDir: join(workRoot, runId),
      clock: this.deps.clock,
      github: { port: this.deps.githubPort, authority },
    });
    if (!produced.allowed) return atStage(produced as Decision<ACPBootstrapActivationResult>, "production");
    this.deps.artifacts.put(runId, ArtifactKind.REPO_FACTORY_RESULT, produced.value);
    return this.activate(input, produced.value);
  }

  /**
   * The owner's receipt must name this run, this operation and exactly these parameters, and
   * approve them. It is consumed once for the run's current candidate; a retry for the same
   * candidate is re-admitted from that durable consumption rather than from the ingress replay
   * cache, which expires.
   */
  private admitApproval(
    runId: string,
    presented: unknown,
    parameters: Parameters<typeof repoFactoryGitHubWriteParameters>[0],
  ): Decision<void> {
    const refuse = (refusal: string, message: string, evidence: Evidence = {}): Decision<void> =>
      deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, message, { refusal, runId, ...evidence });
    const parsed = ownerApprovalReceiptSchema.safeParse(presented);
    if (!parsed.success) {
      return refuse("APPROVAL_MISSING", "the owner approval is not an admitted ingress receipt");
    }
    const receipt: OwnerApprovalReceipt = parsed.data;
    if (receipt.runId !== runId) {
      return refuse("APPROVAL_MISMATCH", "the owner approval names a different run", { approvedRunId: receipt.runId });
    }
    if (receipt.operation !== REPO_FACTORY_GITHUB_WRITE_OPERATION) {
      return refuse("APPROVAL_MISMATCH", "the owner approval is for a different operation", {
        operation: receipt.operation,
      });
    }
    const expected = digestOf(repoFactoryGitHubWriteParameters(parameters));
    if (receipt.parameterDigest !== expected) {
      return refuse(
        "APPROVAL_MISMATCH",
        "the owner approved different parameters — owner, visibility, plan or operations — than these",
        { approvedParameterDigest: receipt.parameterDigest, parameterDigest: expected },
      );
    }
    if (!receipt.approved) return refuse("APPROVAL_DECLINED", "the owner declined this GitHub write");

    // Bound to the run's current candidate when it has one, as every other owner decision is; a
    // bootstrap run whose candidate was never promoted consumes it as a non-candidate operation.
    // `assertApproval` (inside `consumeApproval`) already refuses a receipt minted for any other.
    const candidate = this.deps.runs.currentCandidate(runId);
    const retained = this.deps.ownerAuthority.assertConsumedApproval(receipt, candidate);
    if (retained.allowed) return retained;
    return this.deps.ownerAuthority.consumeApproval(receipt, candidate);
  }

  private async activate(
    input: ProduceAndActivateInput,
    result: RepoFactoryResult,
  ): Promise<Decision<ACPBootstrapActivationResult>> {
    const localBindings: Array<{ identity: string; checkoutPath: string; repositoryRole: string }> = [];
    for (const repository of result.repositories) {
      if (repository.proposedCheckoutPath === null) {
        return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "the produced repository proposes no checkout to bind", {
          stage: "activation",
          runId: input.runId,
          repository: repository.identity,
        });
      }
      localBindings.push({
        identity: repository.identity,
        checkoutPath: repository.proposedCheckoutPath,
        repositoryRole: repository.role,
      });
    }
    // Repo Factory only proposes a local binding (Integration §13); accepting the proposal is
    // the control plane's act, and it is this one.
    const activated = await this.deps.bootstrap.activate({
      runId: input.runId,
      factoryResult: result,
      approvedManifest: input.approvedManifest,
      localBindings,
      projectName: input.projectName,
      handoff: input.handoff,
    });
    return atStage(activated, "activation");
  }
}
