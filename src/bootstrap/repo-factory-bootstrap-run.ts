import { join } from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, assertPortableManifest, manifestDigest } from "../contracts/manifest.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { ArtifactKind, RunKind } from "../domain/types.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { ACPBootstrapActivationResult, BootstrapActivation } from "./activation.ts";
import { parseGitHubIdentity, type GitHubWritePort } from "./github-write-port.ts";
import {
  githubOperationSchema,
  preflightGitHubOperations,
  type GitHubOperation,
  type GitHubWriteAuthority,
} from "./repo-factory-github.ts";
import {
  produceRepoFactoryResult,
  verificationKindRunning,
  type RepoFactoryPlanFixture,
} from "./repo-factory-producer.ts";
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
 * receipt is consumed once for the candidate the CEO confirms and re-admitted from that durable
 * consumption on a retry, so a partial failure can resume without a second approval and the
 * approval cannot be carried to a different candidate.
 *
 * What is executed. The approved PLAN artifact's own operations, desired state included, rather
 * than an executable plan a caller supplies, which the reviewed head checked only by its digest
 * and operation identities while executing whatever desired state it carried. The owner's approval binds that artifact's digest and its
 * operations in full, so a protection weakened after approval is a different digest and a
 * different approval, not the same one executing different parameters (PR #1043 review,
 * RF1043-01). Every other field the producer needs is derived from the artifact and the approved
 * manifest: the repository role from the manifest's one repository, the default branch from the
 * push the plan makes, and the verification from the manifest's one command — which must be the
 * invocation the producer actually runs, because a PASS recorded under a command id is a claim
 * that command ran (RF1043-03). A manifest the producer cannot honestly evidence — any other
 * command, or any required CI workflow — is refused before the first write, not found by
 * activation after it. The CTO's `plan_submit` tool still accepts operation identities only;
 * until it carries desired state, a PLAN submitted through it is refused here as not executable.
 *
 * Everything that can be refused is refused before the first GitHub call: run kind and state,
 * the activation preconditions a result cannot change, the PLAN artifact, the manifest against
 * it, the approval, and the producer's own pure preflight. A refusal here has made no GitHub
 * read or write.
 *
 * A produced result is stored (REPO_FACTORY_RESULT) inside the producer's cleanup, before
 * activation is attempted. Activation of a fresh bootstrap normally stops once — the incoming CTO
 * has not yet acknowledged its handoff — and the second call, admitted under the same approval,
 * activates that stored result rather than producing again: the producer's checkout now exists.
 * There is no other copy and no shortcut around the approval (PR #1043 review round 3, RF1043-08):
 * a result that could not be stored leaves no checkout, and its retry takes the ordinary path —
 * approval, then the ledger reconciled against GitHub, then the result rebuilt. A checkout left by
 * a run that died is refused by name and kept for a person (RF1043-07).
 *
 * Who calls this. The owner mints the receipt through the operator socket's
 * `repoFactory.githubWrite.approve` (the owner token; `approvalBinding` computes what it binds), and
 * the receipt is kept on the run (`recordOwnerApproval`). A PROJECT_BOOTSTRAP run's CEO CONFIRM
 * then calls `produceAndActivateApproved` before the CEO decision, outside its transaction: this
 * path awaits GitHub and git, and the confirm transaction is synchronous. A refusal here is the
 * CEO's answer, so the decision never runs on a result that was not produced. A fresh bootstrap's
 * first CONFIRM performs the writes and is refused BOOTSTRAP_ACTIVATION_INCOMPLETE until the
 * primary CTO acknowledges its handoff; the CEO then confirms again, under a new idempotency key.
 *
 * What production supplies. `defaultConfig()` sets the work root to `<state root>/repo-factory`,
 * and the CTO's `plan_submit` takes each operation in `githubOperationSchema` — the shape this
 * runner executes — so a PLAN submitted over MCP with desired state is executable. A PLAN whose
 * operations carry identities only is still accepted there and refused as PLAN_NOT_EXECUTABLE,
 * at the owner's approval as well as here.
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
  /** The PLAN artifact's operations in full — desired state included, not just their identities. */
  githubOperations: readonly GitHubOperation[];
}): Record<string, unknown> => ({
  owner: input.owner,
  visibility: input.visibility,
  planDigest: input.planDigest,
  githubOperations: input.githubOperations,
});

/**
 * The APPROVAL artifact `kind` an owner approval of `REPO_FACTORY_GITHUB_WRITE_OPERATION` is kept
 * under on its run. The human-gate readers select `OWNER_DECISION` and pass over this one.
 */
export const REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND = "REPO_FACTORY_GITHUB_WRITE";

/** What the owner names when approving the write. */
export interface RepoFactoryApprovalRequest {
  owner: string;
  visibility: "public" | "private";
  /** The PLAN artifact digest the owner reviewed; refused unless it is the run's current PLAN. */
  planDigest: string;
  /** The manifest the PLAN names by digest. The receipt cannot carry it, so it is kept beside it. */
  manifest: unknown;
}

export interface RepoFactoryApprovalBinding {
  /** `repoFactoryGitHubWriteParameters` over the run's PLAN — exactly what the receipt digests. */
  parameters: Record<string, unknown>;
  /** The run's current candidate, which the minted receipt names. */
  candidateSnapshotDigest: string | null;
  approvedManifest: ProjectManifest;
}

/** A recorded approval as `recordOwnerApproval` writes it. The receipt in it is still only a claim. */
const recordedApprovalSchema = z
  .object({
    kind: z.literal(REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND),
    owner: z.string().min(1),
    visibility: z.enum(["public", "private"]),
    planDigest: z.string().min(1),
    approvedManifest: z.unknown(),
    projectName: z.string().min(1),
    receipt: z.unknown(),
  })
  .strict();

/**
 * The activation handoff a CEO-confirmed bootstrap delivers to the project's primary CTO. Nothing
 * on this path supplies one, so it is derived from the approved manifest alone — and is therefore
 * the same package on every call, which `activate` requires of a retry.
 */
export const bootstrapActivationHandoff = (manifest: ProjectManifest): HandoffPackage => ({
  projectStatus: "BOOTSTRAPPED",
  activeManifestDigest: manifestDigest(manifest),
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: manifest.repositories.map((repository) => ({
    identity: repository.remote,
    branch: null,
    head: null,
  })),
  knownRisks: [],
  recommendedNextAction: "acknowledge this handoff; the project's first work arrives as a run",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The approved PLAN artifact's provenance, as `BootstrapActivation` already requires it. */
const approvedPlanSchema = z.object({
  bootstrapOperationId: z.string().min(1),
  requestDigest: z.string().min(1),
  projectManifestDigest: z.string().min(1),
  githubOperations: z.array(z.unknown()),
});

/** Its operations as this producer executes them: each with the state it asks for. */
const executableOperationsSchema = z.array(githubOperationSchema).min(1);

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
  /**
   * The candidate the CEO's CONFIRM names. Its passing blind review is required before anything
   * else this call does that matters, and the owner approval is consumed for it (RF1050-01).
   */
  candidateSnapshotDigest: string;
  ownerApproval: RepoFactoryOwnerApproval | null;
  approvedManifest: ProjectManifest;
  projectName: string;
  handoff: HandoffPackage;
}

export interface RepoFactoryBootstrapRunnerDeps {
  runs: Pick<RunEngine, "get" | "currentCandidate">;
  artifacts: Pick<ArtifactStore, "latest" | "list" | "put">;
  ownerAuthority: Pick<OwnerAuthorityPort, "assertConsumedApproval" | "consumeApproval">;
  bootstrap: Pick<BootstrapActivation, "activate" | "readinessForFactoryResult" | "reviewForConfirmation">;
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

  /**
   * What an owner approval of this operation must bind, computed from the run's own PLAN artifact
   * as `produceAndActivate` recomputes it at execution. Only owner and visibility come from the
   * request; the operations are the PLAN's, so an approval cannot name operations the PLAN does
   * not hold. The PLAN must be the one the owner named, and the manifest the one the PLAN names.
   * Reads only — it is asked before anything is minted.
   */
  approvalBinding(runId: string, request: RepoFactoryApprovalRequest): Decision<RepoFactoryApprovalBinding> {
    const refuse = (
      reasonCode: ReasonCode,
      refusal: string,
      message: string,
      evidence: Evidence = {},
    ): Decision<RepoFactoryApprovalBinding> => deny(reasonCode, message, { refusal, runId, ...evidence });
    const run = this.deps.runs.get(runId);
    if (run === null) return refuse(ReasonCode.NOT_FOUND, "RUN_UNKNOWN", "unknown run");
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "RUN_NOT_BOOTSTRAP", "a Repo Factory write needs a PROJECT_BOOTSTRAP run", {
        kind: run.kind,
      });
    }
    const planArtifact = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    if (planArtifact === null) {
      return refuse(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "PLAN_MISSING", "the run has no PLAN artifact to approve");
    }
    if (planArtifact.digest !== request.planDigest) {
      return refuse(ReasonCode.EVIDENCE_STALE, "PLAN_NOT_CURRENT", "the PLAN named is not the run's current PLAN artifact", {
        namedPlanDigest: request.planDigest,
        currentPlanDigest: planArtifact.digest,
      });
    }
    const plan = approvedPlanSchema.safeParse(planArtifact.content);
    if (!plan.success) {
      return refuse(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "PLAN_MISSING",
        "the run's PLAN artifact carries no bootstrap operation provenance",
      );
    }
    const operations = executableOperationsSchema.safeParse(plan.data.githubOperations);
    if (!operations.success) {
      return refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "PLAN_NOT_EXECUTABLE",
        "the PLAN artifact's GitHub operations do not carry the state each asks for, so there is nothing to approve",
      );
    }
    const manifest = assertPortableManifest(request.manifest);
    if (!manifest.allowed) {
      return refuse(manifest.reasonCode, "MANIFEST_INVALID", manifest.message, manifest.evidence);
    }
    const supplied = manifestDigest(manifest.value);
    if (supplied !== plan.data.projectManifestDigest) {
      return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "MANIFEST_MISMATCH", "the manifest supplied is not the one the PLAN artifact names", {
        supplied,
        approved: plan.data.projectManifestDigest,
      });
    }
    return allow(ReasonCode.OK, {
      parameters: repoFactoryGitHubWriteParameters({
        owner: request.owner,
        visibility: request.visibility,
        planDigest: planArtifact.digest,
        githubOperations: operations.data,
      }),
      candidateSnapshotDigest: this.deps.runs.currentCandidate(runId),
      approvedManifest: manifest.value,
    });
  }

  /** Keeps a minted receipt on its run, beside what the receipt binds only by digest. */
  recordOwnerApproval(
    runId: string,
    record: {
      owner: string;
      visibility: "public" | "private";
      planDigest: string;
      approvedManifest: ProjectManifest;
      projectName: string;
      receipt: OwnerApprovalReceipt;
    },
  ): Decision<{ approvalDigest: string; receipt: OwnerApprovalReceipt }> {
    const stored = this.deps.artifacts.put(
      runId,
      ArtifactKind.APPROVAL,
      { kind: REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND, ...record },
      record.receipt.candidateSnapshotDigest,
    );
    return allow(ReasonCode.OK, { approvalDigest: stored.digest, receipt: record.receipt });
  }

  /**
   * The CEO confirm's entry for a PROJECT_BOOTSTRAP run: `produceAndActivate` over the owner's
   * newest recorded approval of this operation, so a later decline supersedes an earlier approval.
   * With none recorded it refuses as a missing approval, before any GitHub call. A recorded
   * receipt is still only a claim here; `admitApproval` re-reads the ingress admission behind it.
   * `candidateSnapshotDigest` is the CONFIRM's own candidate, carried through unchanged.
   */
  async produceAndActivateApproved(
    runId: string,
    candidateSnapshotDigest: string,
  ): Promise<Decision<ACPBootstrapActivationResult>> {
    const missing = (message: string): Decision<ACPBootstrapActivationResult> =>
      deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, message, { stage: "approval", refusal: "APPROVAL_MISSING", runId });
    const newest = this.deps.artifacts
      .list<unknown>(runId, ArtifactKind.APPROVAL)
      .filter(
        (artifact) =>
          !artifact.superseded &&
          isRecord(artifact.content) &&
          artifact.content["kind"] === REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND,
      )
      .at(-1);
    if (newest === undefined) {
      return missing("a Repo Factory GitHub write needs the owner's approval, and none is recorded for this run");
    }
    const recorded = recordedApprovalSchema.safeParse(newest.content);
    if (!recorded.success) return missing("the owner approval recorded for this run is malformed");
    const manifest = assertPortableManifest(recorded.data.approvedManifest);
    if (!manifest.allowed) return missing("the owner approval recorded for this run carries no usable manifest");
    return this.produceAndActivate({
      runId,
      candidateSnapshotDigest,
      ownerApproval: { owner: recorded.data.owner, visibility: recorded.data.visibility, receipt: recorded.data.receipt },
      approvedManifest: manifest.value,
      projectName: recorded.data.projectName,
      handoff: bootstrapActivationHandoff(manifest.value),
    });
  }

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
    // RF1050-01 — the candidate the CEO confirms must carry a passing review now, before the
    // approval is consumed or GitHub is written, not only at finalization, which cannot undo a
    // write. The check is finalization's own `reviewForConfirmation` rather than a copy of it.
    const reviewed = this.deps.bootstrap.reviewForConfirmation(runId, input.candidateSnapshotDigest);
    if (!reviewed.allowed) return atStage(reviewed as Decision<ACPBootstrapActivationResult>, "precondition");

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

    // What executes is the artifact's own operations (RF1043-01). An artifact that names its
    // operations without the state each asks for approved nothing that could be executed.
    const executableOperations = executableOperationsSchema.safeParse(plan.githubOperations);
    if (!executableOperations.success) {
      return refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "PLAN_NOT_EXECUTABLE",
        "the approved PLAN artifact's GitHub operations do not carry the state each asks for, so there is nothing approved to execute",
        { issues: executableOperations.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      );
    }
    const operations = executableOperations.data;

    const manifestMismatch = (message: string, evidence: Evidence): Decision<ACPBootstrapActivationResult> =>
      refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "MANIFEST_MISMATCH", message, evidence);
    const manifest = input.approvedManifest;
    const approvedManifestDigest = manifestDigest(manifest);
    if (approvedManifestDigest !== plan.projectManifestDigest) {
      return manifestMismatch("the manifest supplied is not the one the PLAN artifact approved", {
        supplied: approvedManifestDigest,
        approved: plan.projectManifestDigest,
      });
    }
    const declared = manifest.repositories[0];
    if (manifest.repositories.length !== 1) {
      return manifestMismatch("this producer creates exactly one repository and the manifest declares a different count", {
        declared: manifest.repositories.length,
      });
    }
    if (declared === undefined) return manifestMismatch("the manifest declares no repository", {});

    // RF1043-03 — a PASS is recorded under a manifest command id, so it must be the command the
    // producer runs. Anything else the manifest requires would be missing or misreported, and
    // activation would find that only after the repository already existed.
    const unsupported = (message: string, evidence: Evidence): Decision<ACPBootstrapActivationResult> =>
      refuse(ReasonCode.VERIFICATION_GAP, "UNSUPPORTED_VERIFICATION", message, evidence);
    if (manifest.ciWorkflows.length > 0) {
      return unsupported("the manifest requires CI evidence, and this producer produces none", {
        ciWorkflows: manifest.ciWorkflows.map((workflow) => workflow.checkName),
      });
    }
    const command = manifest.verificationCommands[0];
    if (manifest.verificationCommands.length !== 1) {
      return unsupported("this producer runs exactly one verification, and the manifest requires a different count", {
        commands: manifest.verificationCommands.map((candidate) => candidate.id),
      });
    }
    if (command === undefined) return unsupported("the manifest requires no verification command", {});
    const verificationKind = verificationKindRunning(command.argv);
    if (verificationKind === null) {
      return unsupported(`the manifest's command ${command.id} is not an invocation this producer runs`, {
        commandId: command.id,
        argv: command.argv,
      });
    }
    if (command.cwd !== ".") {
      return unsupported(`the manifest runs ${command.id} outside the repository root, where this producer runs it`, {
        commandId: command.id,
        cwd: command.cwd,
      });
    }
    if (command.repositoryRole !== declared.role) {
      return unsupported(`the manifest runs ${command.id} in another repository`, { commandId: command.id });
    }
    if (command.evidenceMode !== "LOCAL_COMMAND") {
      return unsupported(`the manifest requires ${command.id} as ${command.evidenceMode} evidence, and this producer records a local run`, {
        commandId: command.id,
        evidenceMode: command.evidenceMode,
      });
    }

    const push = operations.find((operation) => operation.resourceType === "branch");
    const pushed = push === undefined ? null : parseGitHubIdentity(push.resourceIdentity);
    const defaultBranch = pushed === null ? null : pushed.ref;
    if (defaultBranch === null) {
      return refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "PLAN_NOT_EXECUTABLE",
        "the approved PLAN artifact pushes no branch, so a produced repository would have no verified head",
      );
    }
    const executable: RepoFactoryPlanFixture = {
      runId,
      bootstrapOperationId: plan.bootstrapOperationId,
      requestDigest: plan.requestDigest,
      planDigest: planArtifact.digest,
      projectManifestDigest: plan.projectManifestDigest,
      repositoryRole: declared.role,
      defaultBranch,
      verificationCommandId: command.id,
      verificationKind,
      githubOperations: operations,
    };

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
      approvedOperations: operations.map(({ operationId, resourceType, resourceIdentity }) => ({
        operationId,
        resourceType,
        resourceIdentity,
      })),
    };
    // The producer's own pure preflight, run here so a plan it would refuse never consumes the
    // owner's approval. It runs again inside the producer; that second run is a no-op check.
    const execution = preflightGitHubOperations(executable, authority);
    if (!execution.allowed) return atStage(execution as Decision<ACPBootstrapActivationResult>, "precondition");
    if (declared.remote !== execution.value.repositoryIdentity) {
      return manifestMismatch("the manifest's remote is not the repository the plan creates", {
        manifestRemote: declared.remote,
        planned: execution.value.repositoryIdentity,
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
    // The work root is state — it holds the checkout and the GitHub ledger a retry resumes from —
    // so the state-path rule applies: created 0700 when absent, refused when it is reached through
    // a symlink, owned by another account, or not exactly 0700, and never repaired. It is checked
    // here, before the approval is consumed or GitHub is called, rather than at construction, so an
    // insecure work root refuses Repo Factory runs and does not stop the daemon.
    try {
      ensurePrivateDirectory(workRoot);
    } catch (error) {
      if (!isAcpError(error)) throw error;
      return refuse(error.reasonCode, "WORK_ROOT_INSECURE", error.message, error.evidence);
    }
    // Every call is authorised before anything else it does: the approval is admitted through
    // ingress and consumed, or re-admitted from that durable consumption on a later call
    // (PR #1043 review round 3, RF1043-08 — the previous head activated a stored result first).
    const approval = this.admitApproval(runId, input.candidateSnapshotDigest, input.ownerApproval.receipt, {
      owner: authority.owner,
      visibility: authority.visibility,
      planDigest: planArtifact.digest,
      githubOperations: operations,
    });
    if (!approval.allowed) return atStage(approval as Decision<ACPBootstrapActivationResult>, "approval");

    // The result this runner stored after producing it, under this same approval, in the control
    // plane's own artifact store — nothing a caller or a file supplies. Activation follows it on
    // the call after a handoff is acknowledged, and re-validates it like any other.
    const retained = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.REPO_FACTORY_RESULT);
    if (retained !== null) {
      const parsed = parseRepoFactoryResult(retained.content);
      if (!parsed.allowed) return atStage(parsed as Decision<ACPBootstrapActivationResult>, "activation");
      return this.activate(input, parsed.value);
    }

    // Otherwise the ordinary path, for a first call and for every retry alike: the producer
    // reconciles its ledger against GitHub, performs what is left, and rebuilds the result. A
    // result that cannot be stored leaves no checkout behind (`persist` runs inside the
    // producer's cleanup), so the retry takes this same path.
    const produced = await produceRepoFactoryResult({
      plan: executable,
      workDir: join(workRoot, runId),
      clock: this.deps.clock,
      github: { port: this.deps.githubPort, authority },
      persist: (result) => {
        this.deps.artifacts.put(runId, ArtifactKind.REPO_FACTORY_RESULT, result);
      },
    });
    if (!produced.allowed) return atStage(produced as Decision<ACPBootstrapActivationResult>, "production");
    return this.activate(input, produced.value);
  }

  /**
   * The owner's receipt must name this run, this operation and exactly these parameters, and
   * approve them. It is consumed once for the candidate the CEO confirms; a retry for the same
   * candidate is re-admitted from that durable consumption rather than from the ingress replay
   * cache, which expires, and a CONFIRM naming another candidate is refused.
   */
  private admitApproval(
    runId: string,
    candidateSnapshotDigest: string,
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

    // Consumed for the candidate the CEO confirms rather than the run's candidate pointer, which
    // an unpromoted bootstrap leaves null and which would let one approval serve two confirmations.
    // `assertApproval` (inside `consumeApproval`) still refuses a receipt minted while the run's
    // pointer named a different candidate.
    const retained = this.deps.ownerAuthority.assertConsumedApproval(receipt, candidateSnapshotDigest);
    if (retained.allowed) return retained;
    return this.deps.ownerAuthority.consumeApproval(receipt, candidateSnapshotDigest);
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
