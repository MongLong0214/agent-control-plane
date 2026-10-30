import type { ResidentProjectProvisioning } from './resident-project-provisioning.ts';
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { attemptCheckoutPath } from "../core/repo-factory-paths.ts";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, manifestDigest } from "../contracts/manifest.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { holderProvenGone } from "../daemon/single-instance.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { ArtifactKind, Role, RunKind, RunState, roleKeyFor, type RoleBinding, type RunRow } from "../domain/types.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { ACPBootstrapActivationResult, BootstrapActivation } from "./activation.ts";
import { type GroupMember, processGroupEmpty, processGroupMembership } from "./attempt-writer-group.ts";
import { type BootstrapWriteRequest, runUnderWriteGuard } from "./bootstrap-write-guard.ts";
import { type CommitLorePort, commitloreRequired, probeCommitLore, verifyCommitLoreBinding } from "./commitlore-observation.ts";
import {
  consumeWithheldExemption,
  readWithheldIntent,
  withheldIntentDirectory,
  withheldUnsent,
  writeWithheldRequest,
} from "./bootstrap-approval-anchor.ts";
import type {
  AttemptWriter,
  BootstrapApplication,
  BootstrapApplicationReservation,
  BootstrapApplications,
} from "./bootstrap-applications.ts";
import { currentBootstrapPlan, executablePlanOf, factsTargetOf, handoffFactsAre, observedRepositoryFacts, type PlannedBootstrapOutputs, plannedBootstrapOutputs } from "./bootstrap-plan.ts";
import { type GitHubWritePort, type ObservedRepository, parseGitHubIdentity } from "./github-write-port.ts";
import {
  githubLedgerPath,
  preflightGitHubOperations,
  readGitHubLedger,
  toExternalWriteReceipt,
  type GitHubExecutionPlan,
  type GitHubOperation,
  type GitHubWriteAuthority,
  type PendingWrite,
} from "./repo-factory-github.ts";
import {
  checkoutMarkerOf,
  occupiedCheckoutLeaf,
  produceRepoFactoryResult,
  type RepoFactoryPlanFixture,
} from "./repo-factory-producer.ts";
import { type ExternalWriteReceipt, parseRepoFactoryResult, type RepoFactoryResult } from "./repo-factory-result.ts";

/** GitHub write scope recorded in the recovery ledger. */
export const REPO_FACTORY_GITHUB_WRITE_OPERATION = "repo_factory_github_write";

/**
 * The write scope retained in the recovery ledger's legacy approval_digest column.
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
 * Historical approval artifact kind. Bootstrap no longer consults these records.
 */
export const REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND = "REPO_FACTORY_GITHUB_WRITE";

/**
 * #246 — everything an owner approval of this run's GitHub writes binds, computed from the run's own
 * PLAN artifact alone (`approvalScopeOf`). The CLI names owner and visibility and is checked against
 * the PLAN at execution; this scope takes them from the PLAN's first operation, the repository create,
 * which is what that execution check compares them with. Nothing in it comes from a caller.
 */
export interface RepoFactoryApprovalScope {
  runId: string;
  operation: typeof REPO_FACTORY_GITHUB_WRITE_OPERATION;
  planDigest: string;
  /** The PLAN's operations as execution performs them, desired state included. */
  githubOperations: GitHubOperation[];
  operationsDigest: string;
  /** `github:<owner>/<name>`, as the repository create names it. */
  repositoryIdentity: string;
  owner: string;
  visibility: "public" | "private";
  /** `repoFactoryGitHubWriteParameters` over the above: what a receipt's `parameterDigest` digests. */
  parameters: Record<string, unknown>;
  parameterDigest: string;
  candidateSnapshotDigest: string | null;
  approvedManifest: ProjectManifest;
  projectName: string;
}

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
   * else this call does that matters.
   */
  candidateSnapshotDigest: string;
  /**
   * #246 C3 — the session the CONFIRM is made as. It must be admissible as the deciding CEO before
   * anything is consumed or written (`ProductionGate.assertCeoDecisionAdmissible`).
   */
  ceoSessionId: string;
  /** Legacy caller input, ignored: the current PLAN determines the write scope. */
  ownerApproval?: RepoFactoryOwnerApproval | null;
  approvedManifest: ProjectManifest;
  projectName: string;
  handoff: HandoffPackage;
  /**
   * #1231 C-2 — records a genesis CONFIRM for resume (`ResidentProjectProvisioning.remember`). Called only once every
   * pre-write check has passed, inside the transaction that reserves the application or records the attempt, so a
   * refused CONFIRM leaves no confirmation a resume could act on and freezes no PLAN.
   */
  rememberConfirmation?: () => Decision<void>;
}

/** The CEO's CONFIRM of a PROJECT_BOOTSTRAP run, as every CONFIRM door hands it to the runner. */
export interface BootstrapConfirmation {
  runId: string;
  candidateSnapshotDigest: string;
  ceoSessionId: string;
  rationale?: string;
}

export interface RepoFactoryBootstrapRunnerDeps {
  residentProjects?: ResidentProjectProvisioning;
  runs: Pick<RunEngine, "get" | "currentCandidate">;
  artifacts: Pick<ArtifactStore, "latest" | "list" | "put">;
  bootstrap: Pick<BootstrapActivation, "activate" | "readinessForFactoryResult" | "reviewForConfirmation" | "residentGenesisRequired">;
  /** The production composition passes `createBootstrapGitHubWritePort()`; tests pass a double. */
  githubPort: GitHubWritePort;
  /** Each run produces under `<workRoot>/<runId>`. Null means this deployment never configured one. */
  workRoot: string | null;
  clock: Clock;
  /**
   * The reservation and its attempt share one transaction.
   */
  db: Pick<Db, "txDecision" | "get">;
  /** #246 C3 — the durable application record. */
  applications: BootstrapApplications;
  /** #246 C3 — the CEO admission every CONFIRM door asks, asked again here before anything is consumed. */
  ceo: Pick<ProductionGate, "assertCeoDecisionAdmissible">;
  bindings: Pick<BindingRegistry, "active">;
  projects: Pick<ProjectRegistry, "get">;
  repositories: Pick<RepositoryRegistry, "byIdentity">;
  /**
   * #246 B3 — what observes CommitLore for a manifest that requires it. The production composition passes
   * `createCommitLoreCliPort()`; tests pass a double. Absent, a manifest that requires CommitLore is
   * refused before anything is consumed or written, and one that prefers it or turns it off is unaffected.
   */
  commitlore?: CommitLorePort | null;
}

type Stage = "precondition" | "approval" | "production" | "activation";

const atStage = <T>(decision: Decision<T>, stage: Stage): Decision<T> =>
  decision.allowed ? decision : { ...decision, evidence: { stage, ...decision.evidence } };

/** A refusal as a STRANDED row or a `last_refusal_json` keeps it. */
const refusalRecord = (decision: Decision<unknown>, stage: Stage): Record<string, unknown> =>
  decision.allowed
    ? {}
    : { stage, reasonCode: decision.reasonCode, message: decision.message, evidence: decision.evidence };

/** Refusals of the GitHub ledger: the evidence that would attribute a repository cannot be read. */
const LEDGER_REFUSALS = new Set(["LEDGER_CORRUPT", "LEDGER_FOREIGN", "LEDGER_UNSAFE"]);

/** The kind of GitHub request each write method of the port sends. */
const WRITE_REQUEST_KIND = {
  createRepository: "repository",
  pushBranch: "branch",
  createBranch: "branch",
  ensureGenesisResources: "genesis-resources",
  setDefaultBranch: "setting",
  protectBranch: "branch-protection",
  openGenesisPull: "genesis-bootstrap",
  mergeGenesisPull: "genesis-bootstrap",
} as const satisfies Record<string, PendingWrite["resourceType"]>;

/** The kind of ledger intent a GitHub request at its start belongs to, or null for one that is none. */
const requestKind = (request: BootstrapWriteRequest): PendingWrite["resourceType"] | null => {
  if (request.kind === "git") return request.method === "push" ? "branch" : null;
  if (/\/git\/refs(?:$|\/)/.test(request.target)) return "branch";
  if (/\/(?:labels|milestones|issues)(?:[?\/]|$)/.test(request.target)) return "genesis-resources";
  // The genesis PR's open (POST) and merge (PUT) are genesis-bootstrap writes, not a create or a protection.
  if (/\/pulls(?:[?\/]|$)/.test(request.target)) return "genesis-bootstrap";
  if (request.method === "POST") return "repository";
  if (request.method === "PATCH") return "setting";
  if (request.method === "PUT") return "branch-protection";
  return null;
};

/** #1231 — a retired predecessor recorded at the repository identity a supersede creates, and its node id if known. */
interface SameNamedPredecessor {
  projectId: string;
  nodeId: string | null;
}

/**
 * The intents an earlier attempt left pending in the ledger, as a new attempt finds them: requests that
 * may have been sent, which are never sent again, and requests proven withheld and never sent, whose
 * exemption the attempt may use once (review 1076-R3).
 */
interface PendingAtStart {
  pending: ReadonlyMap<string, PendingWrite>;
  exempt: ReadonlyMap<string, PendingWrite>;
}

/** What a CONFIRM was admitted on, asked again where it is relied on after an await (review 1076-R1-04). */
interface AuthoritySnapshot {
  runId: string;
  candidateSnapshotDigest: string;
  ceoSessionId: string;
  ceoBinding: RoleBinding | null;
  planDigest: string;
  reviewDigest: string;
}

/**
 * The recovery of a STRANDED application, as the paths that exist allow it. The reservation is never
 * reused and nothing is deleted automatically. No edge cancels this run: it is at CEO review, which no
 * cancel edge leaves, and its reserved application refuses FINAL_REVISE. So the supported path is a new
 * bootstrap under a new project id and repository identity, and the daemon routes the stall to the CEO.
 */
const STRANDED_RECOVERY =
  "the CEO is notified (CRITICAL_SYSTEM_FAILURE); whether the repository at the target is this run's is read by comparing its GitHub node id with the attempt ledger named in the evidence; nothing is created, adopted, deleted or released automatically, and the reservation is kept and never reused; the supported recovery is a new bootstrap under a new project id and repository identity (run_create, run_dispatch), while this run stays at CEO review: no cancel edge leaves it and its reserved application refuses FINAL_REVISE, so an exit for it is a pending transition";

/** One precondition as a repair receipt keeps it. */
export interface CheckoutRecoveryPrecondition {
  precondition: string;
  satisfied: boolean;
  evidence: unknown;
}

/**
 * #246 C3, CEO decision (b) as corrected twice — the preconditions of releasing a cancelled run's
 * reservation, in the order the repair catalog lists them. Release needs positive proof that the
 * application had no external effect; GitHub's present state is not that proof, because a
 * repository absent now says nothing about a create request that may still land. Each precondition
 * must be verified; one that cannot be is unmet, and nothing is released.
 */
export const RESERVATION_RELEASE_PRECONDITIONS = [
  "the run is a cancelled PROJECT_BOOTSTRAP run, so the approval its reservation consumed, which names that run, can never be presented again; and its application is RESERVED",
  "no application attempt of the run is in flight, and this process holds the control plane's single-writer lock",
  "no request was ever sent: no attempt durably reached the stage that precedes the attempt ledger's first write and no ledger exists, or the ledger those attempts wrote holds no receipt and no pending request",
] as const;

/** A reservation release, with the evidence that its application had no external effect. */
export interface ReservationRelease {
  runId: string;
  projectId: string;
  repositoryIdentity: string;
  bootstrapOperationId: string;
  attempts: number;
  approvalDigest: string;
  ledgerPath: string;
  /** Whether the ledger file exists; when it does, it holds no receipt and no pending request. */
  ledgerPresent: boolean;
  /** The attempts durably recorded as having reached their first ledger write. */
  ledgerStageAttempts: number[];
}

export interface ReservationReleaseInspection {
  preconditions: CheckoutRecoveryPrecondition[];
  /** Why the external effect cannot be proven absent, when it cannot: the reservation is then kept, in doubt. */
  inDoubt: Record<string, unknown> | null;
  release: ReservationRelease | null;
}

/** Whether anything at all is at `path`. An answer that cannot be read is taken as occupied. */
const pathOccupied = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
};

/**
 * The git lock files held in a checkout, relative to it: a git process mid-write holds one, and one a
 * killed git left behind cannot be told from it. Null when the checkout's git directory cannot be
 * read in full, or is not a directory (a gitdir pointer names metadata elsewhere), so nothing is
 * concluded from what was not seen. Object files are not walked: no git write locks inside them.
 */
const gitLockFiles = (checkoutPath: string): string[] | null => {
  const gitDir = join(checkoutPath, ".git");
  try {
    if (!lstatSync(gitDir).isDirectory()) return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const found: string[] = [];
  const walk = (dir: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name.endsWith(".lock")) found.push(relative(checkoutPath, path));
      if (entry.isDirectory() && !(depth === 0 && entry.name === "objects")) {
        if (depth >= 16 || !walk(path, depth + 1)) return false;
      }
    }
    return true;
  };
  return walk(gitDir, 0) ? found.sort() : null;
};

export { attemptCheckoutPath };

export class RepoFactoryBootstrapRunner {
  /** #246 C3 — the runs with an application attempt in flight in this process. */
  readonly #applying = new Set<string>();
  /** #246 C3 — whether this process holds the control plane's single-writer lock; see `attachWriterLock`. */
  #writerLockHeld: (() => boolean) | null = null;
  /** #246 C3 — the identity of the daemon process holding that lock; see `attachWriterLock`. */
  #writerIdentity: (() => AttemptWriter | null) | null = null;

  constructor(private readonly deps: RepoFactoryBootstrapRunnerDeps) {}

  /**
   * #246 C3 — the daemon attaches its single-instance lock once it holds it. While it is held no
   * other control-plane process runs, so an application attempt not in flight in this one has
   * ended. Never attached, that cannot be shown: a new attempt after an earlier one, and a release,
   * are refused.
   */
  attachWriterLock(held: () => boolean, identity: (() => AttemptWriter | null) | null = null): void {
    this.#writerLockHeld = held;
    this.#writerIdentity = identity;
  }

  /**
   * The daemon process this attempt runs in, as its lock holder record names it, recorded with the
   * attempt so a later one can prove it has ended. Null when no identity is attached.
   */
  private currentWriter(): AttemptWriter | null {
    return this.#writerIdentity?.() ?? null;
  }

  /**
   * #246 — the scope an owner approval of this run's GitHub writes binds, from the run's own PLAN
   * artifact and nothing else: its digest, its operations as execution performs them, the repository
   * the first one creates and that create's visibility, the parameters a receipt digests, the run's
   * candidate, and the manifest the PLAN carries. Reads only. A prompt shows it and an answer is
   * minted only while it is still exactly this.
   */
  approvalScopeOf(runId: string): Decision<RepoFactoryApprovalScope> {
    const refuse = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Evidence = {}): Decision<RepoFactoryApprovalScope> =>
      deny(reasonCode, message, { refusal, runId, ...evidence });
    const run = this.deps.runs.get(runId);
    if (run === null) return refuse(ReasonCode.NOT_FOUND, "RUN_UNKNOWN", "unknown run");
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "RUN_NOT_BOOTSTRAP", "a Repo Factory write needs a PROJECT_BOOTSTRAP run", {
        kind: run.kind,
      });
    }
    const planArtifact = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    const current = currentBootstrapPlan(runId, planArtifact);
    if (!current.allowed || planArtifact === null) return current as Decision<RepoFactoryApprovalScope>;
    const { outputs, manifest } = current.value;
    const repository = parseGitHubIdentity(outputs.target.repositoryIdentity);
    if (repository === null || repository.ref !== null) {
      return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "PLAN_NOT_EXECUTABLE", "the PLAN's repository is not github:<owner>/<name>", {
        repositoryIdentity: outputs.target.repositoryIdentity,
      });
    }
    const parameters = repoFactoryGitHubWriteParameters({
      owner: repository.owner,
      visibility: outputs.target.visibility,
      planDigest: planArtifact.digest,
      githubOperations: outputs.githubOperations,
    });
    return allow(ReasonCode.OK, {
      runId,
      operation: REPO_FACTORY_GITHUB_WRITE_OPERATION,
      planDigest: planArtifact.digest,
      githubOperations: outputs.githubOperations,
      operationsDigest: digestOf(outputs.githubOperations),
      repositoryIdentity: outputs.target.repositoryIdentity,
      owner: repository.owner,
      visibility: outputs.target.visibility,
      parameters,
      parameterDigest: digestOf(parameters),
      candidateSnapshotDigest: this.deps.runs.currentCandidate(runId),
      approvedManifest: manifest,
      projectName: manifest.projectId,
    });
  }

  /** Execute the current PLAN after the CEO's confirmation has been admitted. */
  async produceAndActivateApproved(confirmation: BootstrapConfirmation): Promise<Decision<ACPBootstrapActivationResult>> {
    const scope = this.approvalScopeOf(confirmation.runId);
    if (!scope.allowed) return scope as Decision<ACPBootstrapActivationResult>;
    const admissible = this.deps.ceo.assertCeoDecisionAdmissible({...confirmation,decision:"CONFIRM",rationale:confirmation.rationale ?? ""});
    if (!admissible.allowed) return admissible as Decision<ACPBootstrapActivationResult>;
    const current = currentBootstrapPlan(confirmation.runId,this.deps.artifacts.latest<unknown>(confirmation.runId,ArtifactKind.PLAN));
    if (!current.allowed) return current as Decision<ACPBootstrapActivationResult>;
    if (current.value.outputs.supersedesProjectId !== undefined) {
      const ready = this.deps.bootstrap.readinessForFactoryResult(confirmation.runId, current.value.outputs.handoff, confirmation.candidateSnapshotDigest);
      if (!ready.allowed) return ready;
    }
    if (this.deps.bootstrap.residentGenesisRequired && !current.value.outputs.genesis) return deny(ReasonCode.INVALID_ARGUMENT,"bootstrap requires an inline genesis bundle and resident CTO",{});
    if (current.value.outputs.genesis) {
      if (!this.deps.residentProjects?.configured()) return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,"resident host provisioner/subscriber is not configured",{});
      const reviewed = this.deps.bootstrap.reviewForConfirmation(confirmation.runId,confirmation.candidateSnapshotDigest);
      if (!reviewed.allowed) return reviewed as Decision<ACPBootstrapActivationResult>;
    }
    const projectId = current.value.manifest.projectId;
    const binding = {...current.value.binding,candidateSnapshotDigest:confirmation.candidateSnapshotDigest};
    return this.produceAndActivate({
      ...confirmation,
      approvedManifest: scope.value.approvedManifest,
      projectName: scope.value.projectName,
      handoff: current.value.outputs.handoff,
      ...(current.value.outputs.genesis ? {rememberConfirmation: (): Decision<void> => {
        try {this.deps.residentProjects?.remember(confirmation,projectId,binding);return allow(ReasonCode.OK,undefined);}
        catch {return deny(ReasonCode.CONFLICT,"confirmed provisioning intent conflicts with stored tuple",{});}
      }} : {}),
    });
  }

  /**
   * One application attempt of a run at a time in this process (#246 C3): a CONFIRM that arrives
   * while another of the same run is in flight — two re-CONFIRMs racing — consumes nothing, writes
   * nothing and is told so. The attempt record's compare-and-set states the same rule in the
   * database, for a writer this process does not see.
   */
  async produceAndActivate(input: ProduceAndActivateInput): Promise<Decision<ACPBootstrapActivationResult>> {
    if (this.#applying.has(input.runId)) {
      return deny(
        ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
        "an application attempt of this bootstrap run is already in flight; this CONFIRM writes and consumes nothing",
        { stage: "precondition", refusal: "APPLICATION_IN_PROGRESS", runId: input.runId },
      );
    }
    this.#applying.add(input.runId);
    try {
      return await this.apply(input);
    } finally {
      this.#applying.delete(input.runId);
    }
  }

  private async apply(input: ProduceAndActivateInput): Promise<Decision<ACPBootstrapActivationResult>> {
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
    // #246 C3 — the pre-write checks. Every one runs before the owner's approval is consumed, and a
    // refusal among them writes nothing, consumes nothing and creates no application row. First, the
    // run: project-less, at CEO review.
    if (run.projectId !== null) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "RUN_NOT_PROJECTLESS", "a bootstrap application needs a project-less PROJECT_BOOTSTRAP run", {
        projectId: run.projectId,
      });
    }
    if (run.state !== RunState.READY_FOR_CEO_REVIEW) {
      return refuse(ReasonCode.RUN_TRANSITION_ILLEGAL, "RUN_NOT_AT_CEO_REVIEW", "a bootstrap application needs the run at CEO review", {
        state: run.state,
      });
    }
    // A STRANDED application keeps its reservation and evidence for a person; no CONFIRM retries it.
    const existing = this.deps.applications.get(runId);
    if (existing?.phase === "STRANDED") {
      return refuse(
        ReasonCode.BOOTSTRAP_APPLICATION_STRANDED,
        "BOOTSTRAP_APPLICATION_STRANDED",
        "this bootstrap run's application is STRANDED: what GitHub holds could not be attributed to it, and a person resolves it",
        { stranded: existing.lastRefusal, projectId: existing.projectId, repositoryIdentity: existing.repositoryIdentity },
      );
    }
    // A COMPLETED application belongs to a COMPLETED run, so one beside a run still at CEO review was
    // not written by this path. Only RESERVED and WRITTEN are resumed; any other phase is refused
    // here, before an approval is asked, rather than taken for a phase it is not (CEO decision (d):
    // a row's phase never stands in for the reservation and the attempt record this path writes).
    if (existing !== null && existing.phase !== "RESERVED" && existing.phase !== "WRITTEN") {
      return refuse(
        ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
        "APPLICATION_PHASE_INCONSISTENT",
        "this bootstrap run's application is in a phase its run at CEO review cannot have; nothing is applied on its strength",
        { phase: existing.phase, attempts: existing.attempts },
      );
    }

    // #246 C2 — the PLAN artifact and the manifest first: `bootstrapPlanPreflight`, the pure checks
    // this runner used to make inline (same refusals, same evidence), then the GitHub shape and the
    // manifest's remote, all inside `plannedBootstrapOutputs`. They are judged ahead of the review
    // because a plan they refuse can have no reviewed outputs at all, and their refusal names the
    // actual defect. What runs below is the approved outputs: the producer writes their files and is
    // refused unless the tree it produces is exactly those.
    const planArtifact = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    const planned = plannedBootstrapOutputs({ runId, planArtifact }, input.approvedManifest);
    if (!planned.allowed || planArtifact === null) return planned as Decision<ACPBootstrapActivationResult>;
    const outputs = planned.value;
    const operations = outputs.githubOperations;
    const executable = executablePlanOf(outputs, planArtifact.digest);
    // #246 B3 — the approved manifest's CommitLore mode, as the PLAN carries it, and what observes it.
    const commitlore = { mode: input.approvedManifest.commitlore.mode, port: this.deps.commitlore ?? null };

    // Readiness is asked about the candidate the CEO confirms: a passing review of that candidate,
    // bound to the run's current PLAN, manifest and planned outputs (#246 C2).
    const ready = this.deps.bootstrap.readinessForFactoryResult(runId, input.handoff, input.candidateSnapshotDigest);
    if (!ready.allowed) return atStage(ready as Decision<ACPBootstrapActivationResult>, "precondition");
    // RF1050-01 — the candidate the CEO confirms must carry a passing review now, before the
    // approval is consumed or GitHub is written, not only at finalization, which cannot undo a
    // write. The check is finalization's own `reviewForConfirmation` rather than a copy of it.
    const reviewed = this.deps.bootstrap.reviewForConfirmation(runId, input.candidateSnapshotDigest);
    if (!reviewed.allowed) return atStage(reviewed as Decision<ACPBootstrapActivationResult>, "precondition");

    // #246 C3 — the run's owner pin is its ACTIVE BOOTSTRAP_CTO, and the CONFIRM is the CEO's.
    const pinned = this.assertOwnerPin(run);
    if (!pinned.allowed) return atStage(pinned as Decision<ACPBootstrapActivationResult>, "precondition");
    const ceo = this.deps.ceo.assertCeoDecisionAdmissible({
      runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      ceoSessionId: input.ceoSessionId,
      rationale: "bootstrap application",
    });
    if (!ceo.allowed) return atStage(ceo as Decision<ACPBootstrapActivationResult>, "precondition");
    // The CEO binding this admission found: a replacement, a revocation or a new generation before an
    // approval is consumed or a write is sent refuses the CONFIRM (review 1076-R1-04).
    const ceoBinding = this.deps.bindings.active(roleKeyFor(Role.CEO));

    const repository = parseGitHubIdentity(outputs.target.repositoryIdentity)!;
    const authority: GitHubWriteAuthority = {
      owner: repository.owner,
      visibility: outputs.target.visibility,
      approvedOperations: operations.map(({ operationId, resourceType, resourceIdentity }) => ({
        operationId,
        resourceType,
        resourceIdentity,
      })),
    };
    // Validate the executable plan before any external write.
    // The manifest's remote was matched to the repository the plan creates in the planned outputs;
    // this preflight creates that same repository, so it is not asked again.
    const execution = preflightGitHubOperations(executable, authority);
    if (!execution.allowed) return atStage(execution as Decision<ACPBootstrapActivationResult>, "precondition");

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

    // The legacy approval_digest column retains the write scope for recovery conflict checks.
    const approvalDigest = digestOf(repoFactoryGitHubWriteParameters({
      owner: authority.owner,
      visibility: authority.visibility,
      planDigest: planArtifact.digest,
      githubOperations: operations,
    }));

    // What this CONFIRM would reserve: the manifest's project id and the repository it creates,
    // under the digests of what was confirmed and approved.
    const reservation: BootstrapApplicationReservation = {
      runId,
      projectId: input.approvedManifest.projectId,
      repositoryIdentity: outputs.target.repositoryIdentity,
      bootstrapOperationId: outputs.bootstrapOperationId,
      planDigest: planArtifact.digest,
      manifestDigest: manifestDigest(input.approvedManifest),
      plannedOutputsDigest: digestOf(outputs),
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      reviewDigest: reviewed.value.digest,
      approvalDigest,
    };
    // Recovery re-applies the frozen candidate under the approval it consumed, and nothing else: no
    // new write scope is approved by a re-CONFIRM.
    if (existing !== null) {
      const drift = (Object.keys(reservation) as Array<keyof BootstrapApplicationReservation>)
        .filter((field) => existing[field] !== reservation[field]);
      if (drift.length > 0) {
        return refuse(
          ReasonCode.BOOTSTRAP_APPLICATION_FROZEN,
          "BOOTSTRAP_APPLICATION_FROZEN",
          "this bootstrap run's application is frozen on the candidate and approval it reserved; a CONFIRM can only re-apply those",
          { drift, reserved: { ...existing, lastRefusal: undefined }, confirmed: reservation },
        );
      }
    }
    const held = this.reservationConflicts(reservation, existing);
    if (!held.allowed) return held as Decision<ACPBootstrapActivationResult>;

    // Review 1076-R1-04 — what was admitted above is admitted again, synchronously, wherever it is
    // relied on after an await: inside the transaction that consumes the approval or records an
    // attempt, and before every external write. The deciding CEO must still be admitted on the same
    // CEO binding and generation, the run, its owner pin, PLAN and review must be the ones checked, and
    // the approval must still be the owner's newest — anchored as this execution's identity once it is.
    const workDir = join(workRoot, runId);
    const authorityHolds = (): Decision<void> =>
      this.authorityHolds({
        runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        ceoSessionId: input.ceoSessionId,
        ceoBinding,
        planDigest: planArtifact.digest,
        reviewDigest: reviewed.value.digest,
      });

    // Production is still owed unless the application is WRITTEN. A new attempt starts only once every
    // earlier one is shown to have ended with no writer left (CEO decision (c)); the checkout it will
    // create — its own, bound to the run and the attempt — must be free; and what GitHub holds at the
    // target must be nothing, or this run's by the evidence it recorded, with every request an earlier
    // attempt left pending shown settled (review 1076-R1-03).
    const nextAttempt = (existing?.attempts ?? 0) + 1;
    let pendingAtStart: ReadonlyMap<string, PendingWrite> = new Map();
    let exemptAtStart: ReadonlyMap<string, PendingWrite> = new Map();
    if (existing?.phase !== "WRITTEN") {
      // #246 B3 — a manifest that requires CommitLore needs CommitLore observable on this host before the
      // owner's approval is consumed or GitHub is read or written: no observer, or a probe that does not
      // pass, refuses here, and a new run reserves nothing. The PLAN stays as approved; nothing lowers its
      // mode. The observation the result reports is made again in the checkout, at the published head.
      if (commitloreRequired(commitlore.mode)) {
        const probed = await probeCommitLore(commitlore.port);
        if (!probed.allowed) {
          if (existing !== null) this.deps.applications.recordRefusal(runId, refusalRecord(probed, "precondition"));
          return atStage(probed as Decision<ACPBootstrapActivationResult>, "precondition");
        }
      }
      if (existing !== null) {
        const ended = this.earlierAttemptsEnded(existing, workDir, executable.repositoryRole);
        if (!ended.allowed) {
          this.deps.applications.recordRefusal(runId, refusalRecord(ended, "precondition"));
          return atStage(ended as Decision<ACPBootstrapActivationResult>, "precondition");
        }
      }
      const occupied = occupiedCheckoutLeaf(workDir, executable, attemptCheckoutPath(workDir, executable.repositoryRole, nextAttempt));
      if (occupied !== null) {
        if (existing !== null) this.deps.applications.recordRefusal(runId, refusalRecord(occupied, "precondition"));
        return atStage(occupied as Decision<ACPBootstrapActivationResult>, "precondition");
      }
      const attribution = await this.observedTarget(runId, workRoot, executable, execution.value, existing,
        this.sameNamedPredecessor(outputs.supersedesProjectId, outputs.target.repositoryIdentity));
      if (!attribution.allowed) return attribution as Decision<ACPBootstrapActivationResult>;
      pendingAtStart = attribution.value.pending;
      exemptAtStart = attribution.value.exempt;
    }

    // The order of operations: consume the approval and INSERT the reservation, with the first
    // attempt recorded, in one transaction — its UNIQUE constraints close the race the checks above
    // could not, and a refusal there rolls the consumption back with it. A recovery records its
    // attempt the same way, before its first external write. A WRITTEN application has none to make.
    // #1231 C-2 — a genesis CONFIRM is remembered for resume here, with the reservation or the attempt, never before
    // the checks above: a CONFIRM they refuse leaves nothing a resume could act on.
    const remember = (): Decision<void> => input.rememberConfirmation?.() ?? allow(ReasonCode.OK, undefined);
    let attempt: number;
    if (existing === null) {
      const reserved = this.deps.db.txDecision(() => {
        const applicable = authorityHolds();
        if (!applicable.allowed) return applicable as Decision<BootstrapApplication>;
        const fresh = this.reservationConflicts(reservation, null);
        if (!fresh.allowed) return fresh as Decision<BootstrapApplication>;
        const remembered = remember();
        if (!remembered.allowed) return remembered as Decision<BootstrapApplication>;
        return this.deps.applications.reserve(reservation, {
          writer: this.currentWriter(),
        });
      });
      if (!reserved.allowed) return atStage(reserved as Decision<ACPBootstrapActivationResult>, "approval");
      attempt = reserved.value.attempts;
    } else if (existing.phase === "RESERVED") {
      const recorded = this.deps.db.txDecision(() => {
        const applicable = authorityHolds();
        if (!applicable.allowed) return applicable as Decision<BootstrapApplication>;
        const remembered = remember();
        if (!remembered.allowed) return remembered as Decision<BootstrapApplication>;
        return this.deps.applications.recordAttempt(runId, existing.attempts, this.currentWriter());
      });
      if (!recorded.allowed) return atStage(recorded as Decision<ACPBootstrapActivationResult>, "precondition");
      attempt = recorded.value.attempts;
    } else {
      // A WRITTEN application activates the result its own attempt stored, on the call after a
      // handoff is acknowledged or after a primary CTO could not be provisioned. Its approval was
      // proven above to be the identity anchored for it, and its result is proved here to be the
      // attempt's own, before anything is activated (CEO decision (d), review 1076-R1-02): a WRITTEN
      // row and a stored result are database rows, and a database writer can write both. That is
      // the chain the completion entries ask for, the owner's current decision included. Nothing is
      // consumed. A refusal leaves the application WRITTEN with its writes as recorded.
      const remembered = remember();
      if (!remembered.allowed) return remembered as Decision<ACPBootstrapActivationResult>;
      const written = this.completionChain(existing);
      if (!written.allowed) {
        this.deps.applications.recordRefusal(runId, refusalRecord(written, "precondition"));
        return written as Decision<ACPBootstrapActivationResult>;
      }
      return this.activate(input, written.value);
    }

    // Before every external write the attempt makes: its authority still holds (R1-04), and no request
    // an earlier attempt left pending is sent again (R1-03). The first is asked before the request's
    // pending intent reaches the ledger, so a refusal leaves nothing pending; then again by the
    // guarded port when the method is called, and once more at the moment the request itself starts,
    // after any read the port method awaited first (review 1076-R2). A refusal there leaves an intent
    // in the ledger that was never sent, so it is recorded as withheld, for that exact intent and this
    // attempt's generation: a later attempt may make it. Once authority is lost in an attempt, nothing
    // further is sent in it. A write already started is recorded when it returns, and is never retried.
    // Review 1076-R3 — an intent this attempt found exempt, as withheld, is made at most once: the
    // exemption is consumed durably before its request can start, and if that cannot be recorded the
    // request is not sent. A request that then starts and is never answered is in doubt for every
    // later attempt, and a crash after the consumption leaves it so too.
    let staleAuthority: Decision<void> | null = null;
    let withheld: Evidence | null = null;
    let exemptionUnconsumed: Evidence | null = null;
    const knownPending = new Set(pendingAtStart.keys());
    let ledgerPending: readonly PendingWrite[] = [...pendingAtStart.values(), ...exemptAtStart.values()];
    // Port calls made, and requests let start at the transport, in this attempt, by kind: a request is
    // recorded as withheld only where none of its kind can have started in this attempt.
    const called = new Map<PendingWrite["resourceType"], number>();
    const started = new Set<PendingWrite["resourceType"]>();
    const consumed = new Set<string>();
    const beforeWrite = (kind: PendingWrite["resourceType"] | null, at: "call" | "request"): void => {
      const holds = staleAuthority ?? authorityHolds();
      if (!holds.allowed) {
        staleAuthority ??= holds;
        const intent = kind === null ? undefined : ledgerPending.find((pending) => pending.resourceType === kind);
        const unsent = kind !== null && (at === "call" ? !called.has(kind) : called.get(kind) === 1 && !started.has(kind));
        if (intent !== undefined && unsent) {
          try {
            writeWithheldRequest(workDir, {
              runId,
              operationId: intent.operationId,
              resourceType: intent.resourceType,
              intentDigest: digestOf(intent),
              attemptedAt: intent.attemptedAt,
              attempt,
              withheldAt: this.deps.clock.nowIso(),
              refusal: typeof holds.evidence["refusal"] === "string" ? holds.evidence["refusal"] : "AUTHORITY_LOST",
            });
          } catch {
            // Unrecorded, the intent stays in doubt: nothing is sent either way.
          }
        }
        throw acpError(holds.reasonCode, holds.message, holds.evidence);
      }
      if (kind === null) return;
      const exemption = [...exemptAtStart.values()].find((intent) => intent.resourceType === kind);
      if (exemption !== undefined && !consumed.has(exemption.operationId)) {
        const evidence = { operationId: exemption.operationId, resourceType: kind, intentDigest: digestOf(exemption), attempt };
        try {
          consumeWithheldExemption(workDir, { runId, ...evidence, consumedAt: this.deps.clock.nowIso() });
        } catch (error) {
          exemptionUnconsumed ??= { ...evidence, message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
          throw acpError(
            ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
            "the exemption of a withheld request could not be recorded as consumed, so the request is not sent",
            exemptionUnconsumed,
          );
        }
        consumed.add(exemption.operationId);
      }
      if (at === "call") called.set(kind, (called.get(kind) ?? 0) + 1);
      else started.add(kind);
    };
    const githubPort = this.guardedPort(pendingAtStart, (kind) => beforeWrite(kind, "call"), (evidence) => {
      withheld ??= evidence;
    });

    // Otherwise the producer, for a first attempt and every recovery alike: it reconciles its ledger
    // against GitHub — a repository is this run's only by the node id its create was answered with,
    // or its creation receipt — performs what is left, and rebuilds the result. It builds that in a
    // checkout of this attempt's own, created exclusively and kept if the attempt fails; nothing an
    // earlier attempt left is reused. The result and WRITTEN are stored in one transaction.
    let ledgerStageRecorded = false;
    const writeGuard = { beforeRequest: (request: BootstrapWriteRequest) => beforeWrite(requestKind(request), "request") };
    const produced = await runUnderWriteGuard(writeGuard, () => produceRepoFactoryResult({
      plan: executable,
      workDir,
      checkoutPath: attemptCheckoutPath(workDir, executable.repositoryRole, attempt),
      keepCheckoutOnFailure: true,
      // CEO decision (b): durably, before the attempt's first ledger write and so before any request.
      // And every completed write keeps the attempt that first recorded it: a receipt an earlier
      // attempt recorded is only referred to by this one, never recorded as its own.
      beforeLedgerWrite: (state) => {
        if (!ledgerStageRecorded) {
          this.deps.applications.recordLedgerStage(runId, attempt);
          ledgerStageRecorded = true;
        }
        const attributed = this.deps.applications.receiptAttribution(runId);
        for (const written of state.receipts) {
          if (!attributed.has(written.operationId)) {
            this.deps.applications.recordReceiptAttribution(runId, attempt, written.operationId, digestOf(written));
          }
        }
        // A pending intent this attempt has not recorded before is a request about to be sent.
        const intents = state.pending.filter((intent) => !knownPending.has(intent.operationId));
        if (intents.length > 0) {
          const holds = authorityHolds();
          if (!holds.allowed) {
            staleAuthority ??= holds;
            throw acpError(holds.reasonCode, holds.message, holds.evidence);
          }
          for (const intent of intents) knownPending.add(intent.operationId);
        }
        ledgerPending = state.pending;
      },
      clock: this.deps.clock,
      github: { port: githubPort, authority },
      // The reviewed files, and the tree the producer reports must be exactly these (#246 C2).
      approvedFiles: outputs.files,
      commitlore,
      persist: (result) => {
        const written = this.deps.db.txDecision(() => {
          this.deps.artifacts.put(runId, ArtifactKind.REPO_FACTORY_RESULT, result);
          return this.deps.applications.markWritten(runId);
        });
        if (!written.allowed) throw acpError(written.reasonCode, written.message, written.evidence);
      },
    })).catch((error: unknown): Decision<RepoFactoryResult> => {
      // The attempt stopped itself before a request: answered below, by what stopped it.
      if (staleAuthority === null && withheld === null && exemptionUnconsumed === null) throw error;
      return deny(ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS, "the attempt stopped before its next request", { stage: "production" });
    });
    if (!produced.allowed) {
      // Authority lost mid-attempt: what was written is in the ledger, and nothing further was sent.
      if (staleAuthority !== null) {
        const stale = staleAuthority as Decision<void>;
        const lost = (stale.allowed ? stale : { ...stale, evidence: { ...stale.evidence, stage: "production" } }) as Decision<ACPBootstrapActivationResult>;
        this.deps.applications.recordRefusal(runId, refusalRecord(lost, "production"));
        return lost;
      }
      if (exemptionUnconsumed !== null) {
        const unconsumed = deny(
          ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
          "the exemption of a request an earlier attempt withheld could not be recorded as consumed, so the request was not sent",
          { stage: "production", refusal: "WITHHELD_EXEMPTION_UNCONSUMED", runId, ...(exemptionUnconsumed as Evidence) },
        );
        this.deps.applications.recordRefusal(runId, refusalRecord(unconsumed, "production"));
        return unconsumed as Decision<ACPBootstrapActivationResult>;
      }
      if (withheld !== null) {
        const inDoubt = deny(
          ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
          "a request an earlier attempt left pending is not shown settled, so it is not sent again; the application stays in doubt",
          { stage: "production", refusal: "UNCONFIRMED_PENDING_REQUEST", runId, ...(withheld as Evidence) },
        );
        this.deps.applications.recordRefusal(runId, refusalRecord(inDoubt, "production"));
        return inDoubt as Decision<ACPBootstrapActivationResult>;
      }
      const refusal = produced.evidence["refusal"];
      // The repository at the target cannot be attributed to this run: someone else's, a name
      // reused, a create whose answer was never recorded, or a ledger that cannot be read. After an
      // attempt, that is STRANDED — never a recreate, never an adoption by name.
      if (produced.reasonCode === ReasonCode.RESOURCE_COLLISION || (typeof refusal === "string" && LEDGER_REFUSALS.has(refusal))) {
        return this.strand(runId, "ATTRIBUTION_UNCERTAIN", {
          production: refusalRecord(produced, "production"),
          ledgerPath: githubLedgerPath(workDir, executable.repositoryRole),
        });
      }
      this.deps.applications.recordRefusal(runId, refusalRecord(produced, "production"));
      return atStage(produced as Decision<ACPBootstrapActivationResult>, "production");
    }
    // Review S11-R1-03 — activation asks the binding the completion chain asks on a WRITTEN retry and at
    // every CONFIRM, of the result this attempt just produced, at the head it published.
    const producedFacts = observedRepositoryFacts(produced.value, factsTargetOf(outputs));
    const commitloreBound = verifyCommitLoreBinding({
      mode: commitlore.mode,
      result: produced.value,
      workDir,
      expected: {
        runId,
        bootstrapOperationId: executable.bootstrapOperationId,
        checkoutPath: attemptCheckoutPath(workDir, executable.repositoryRole, attempt),
        repositoryIdentity: outputs.target.repositoryIdentity,
        head: producedFacts.allowed && producedFacts.value.length === 1 ? producedFacts.value[0]!.head : null,
      },
    });
    if (!commitloreBound.allowed) {
      this.deps.applications.recordRefusal(runId, refusalRecord(commitloreBound, "activation"));
      return atStage(commitloreBound as Decision<ACPBootstrapActivationResult>, "activation");
    }
    return this.activate(input, produced.value);
  }

  /** Rebuild the reserved result from its PLAN and operation recovery ledger. */
  private completionChain(application: BootstrapApplication): Decision<RepoFactoryResult> {
    const { runId } = application;
    const workRoot = this.deps.workRoot;
    if (workRoot === null) {
      return deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, "this deployment has no Repo Factory work root", {
        stage: "precondition",
        refusal: "WORK_ROOT_UNCONFIGURED",
        runId,
      });
    }
    const current = currentBootstrapPlan(runId, this.deps.artifacts.latest(runId, ArtifactKind.PLAN));
    if (!current.allowed) return current as Decision<RepoFactoryResult>;
    const manifest = current.value.manifest;
    const outputs = this.reservedOutputs(application, ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, manifest);
    if (!outputs.allowed) return atStage(outputs as Decision<RepoFactoryResult>, "precondition");
    const executable = executablePlanOf(outputs.value, application.planDigest);
    const execution = preflightGitHubOperations(executable, {
      owner: parseGitHubIdentity(outputs.value.target.repositoryIdentity)!.owner,
      visibility: outputs.value.target.visibility,
      approvedOperations: outputs.value.githubOperations.map(({ operationId, resourceType, resourceIdentity }) => ({
        operationId,
        resourceType,
        resourceIdentity,
      })),
    });
    if (!execution.allowed) return atStage(execution as Decision<RepoFactoryResult>, "precondition");
    return this.writtenChain(application, workRoot, executable, execution.value, manifest.commitlore.mode);
  }

  /**
   * #246 C3, review 1076-R1-02 — asked by every completion entry outside the runner: the CEO decision
   * that completes a bootstrap run and the activation finalizer it calls. A WRITTEN application of
   * this candidate, completed only on the chain the runner itself requires.
   */
  verifyCompletionChain(runId: string, candidateSnapshotDigest: string): Decision<void> {
    const application = this.deps.applications.get(runId);
    if (application === null || application.phase !== "WRITTEN" || application.candidateSnapshotDigest !== candidateSnapshotDigest) {
      return deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, "a bootstrap completes only on its WRITTEN application of this candidate", {
        refusal: "APPLICATION_NOT_WRITTEN",
        runId,
        phase: application?.phase ?? null,
        candidateSnapshotDigest,
      });
    }
    const chain = this.completionChain(application);
    return chain.allowed ? allow(ReasonCode.OK, undefined) : (chain as Decision<void>);
  }

  /**
   * #246 C3, CEO decision (c), tightened — whether every earlier attempt of this application, and the
   * process that wrote for it, is proven to have ended, asked before a new attempt starts. Nothing is
   * inferred: each earlier attempt's writer — the daemon process recorded with it, by pid and OS start
   * token — must be this very process, in which the run's in-process slot this CONFIRM holds shows the
   * attempt has returned, or a process proven gone: no process at that pid, or one with another start
   * token. That needs this process to hold the single-writer lock and to know its own identity.
   * Only the daemon writes an attempt's checkout: a provisioned BOOTSTRAP_CTO's turns run restricted
   * and sandboxed, with the deployment's state root denied to them. The holder gone is not its
   * subprocesses gone (review 1076-R2): its git and gh subprocesses run in the process group recorded
   * with the attempt, and each must be shown gone through it — for a writer that has exited, a group
   * it led with no member left; for this process, no subprocess of its own left in its group. A
   * subprocess that left the group, or a group id reused by another process, is not seen through it;
   * the second refuses rather than admits. Review 1076-R3: the group is attributed first, for every
   * writer, the live one included — it must be the group the writer led, by the pid and start token
   * recorded with it — and its emptiness is asked by membership, never by ancestry: a subprocess whose
   * parent exited stays in the group. An exited writer's group must have no member at all; this
   * process's own group, no member but this process. The question is asked while this CONFIRM holds
   * the run's in-process slot, so the earlier attempt's call has returned and has no code path left
   * to start a subprocess from; an exited writer has none at all, and a group with no member gains
   * one only through a member. It is a snapshot of the group, not a proof that nothing joins it
   * later: a process that leaves the group, or a reused group id, is outside it, as stated above.
   * No lock file may be left in an earlier checkout's .git,
   * and the checkouts directory and every earlier checkout must be plain directories. An attempt with
   * no recorded writer or group, a writer or subprocess still running, or anything unreadable is
   * IN_DOUBT, and no new attempt executes. Nothing here signals a process or touches an earlier
   * checkout.
   */
  private earlierAttemptsEnded(application: BootstrapApplication, workDir: string, repositoryRole: string): Decision<void> {
    const writerLockHeld = this.#writerLockHeld?.() === true;
    const current = this.currentWriter();
    const writers = this.deps.applications.attemptWriters(application.runId);
    // The directory every attempt's checkout is in: absent, or a real directory, never a symlink.
    const checkoutsDir = dirname(attemptCheckoutPath(workDir, repositoryRole, 1));
    let checkoutsDirKind: string;
    try {
      const stat = lstatSync(checkoutsDir);
      checkoutsDirKind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other";
    } catch (error) {
      checkoutsDirKind = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
    }
    const earlier: Array<{
      attempt: number;
      path: string;
      kind: string;
      gitLockFiles: string[] | null;
      writer: AttemptWriter | null;
      writerEnded: "THIS_PROCESS" | "PROVEN_GONE" | "NOT_PROVEN_GONE" | "UNRECORDED";
      subprocesses: "GONE" | "RUNNING" | "NOT_LED_BY_WRITER" | "UNRECORDED" | "UNREADABLE";
      running?: GroupMember[];
    }> = [];
    for (let attempt = 1; attempt <= application.attempts; attempt += 1) {
      const path = attemptCheckoutPath(workDir, repositoryRole, attempt);
      let kind: string;
      try {
        const stat = lstatSync(path);
        kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other";
      } catch (error) {
        kind = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
      }
      const locks = kind === "directory" ? gitLockFiles(path) : kind === "absent" ? [] : null;
      const writer = writers.get(attempt) ?? null;
      const writerEnded =
        writer === null
          ? "UNRECORDED"
          : current !== null &&
              current.startToken !== null &&
              current.pid === process.pid &&
              writer.pid === current.pid &&
              writer.startToken === current.startToken
            ? "THIS_PROCESS"
            : holderProvenGone({ pid: writer.pid, startedAt: writer.startedAt, startToken: writer.startToken, path: "" })
              ? "PROVEN_GONE"
              : "NOT_PROVEN_GONE";
      const group = writer?.processGroup ?? null;
      let subprocesses: (typeof earlier)[number]["subprocesses"];
      let running: GroupMember[] | undefined;
      if (writer === null || group === null) {
        subprocesses = "UNRECORDED";
      } else if (group !== writer.pid) {
        // Asked first, of the live writer too (review 1076-R3): a group the writer did not lead holds
        // other processes as well, and its subprocesses cannot be told apart from them.
        subprocesses = "NOT_LED_BY_WRITER";
      } else if (writerEnded === "THIS_PROCESS") {
        // The group this process leads: no member but this process, by membership — a subprocess
        // orphaned from a parent that exited is still a member. Anything else running in it, the
        // daemon's own unrelated subprocesses included, keeps the attempt waiting.
        const membership = processGroupMembership(group);
        running = membership?.others;
        subprocesses =
          membership === null
            ? "UNREADABLE"
            : !membership.includesThisProcess
              ? "NOT_LED_BY_WRITER"
              : membership.others.length === 0
                ? "GONE"
                : "RUNNING";
      } else {
        const empty = processGroupEmpty(group);
        subprocesses = empty === null ? "UNREADABLE" : empty ? "GONE" : "RUNNING";
      }
      earlier.push({ attempt, path, kind, gitLockFiles: locks, writer, writerEnded, subprocesses, ...(running?.length ? { running } : {}) });
    }
    if (
      writerLockHeld &&
      current !== null &&
      current.startToken !== null &&
      (checkoutsDirKind === "directory" || checkoutsDirKind === "absent") &&
      earlier.every(
        (entry) =>
          entry.gitLockFiles !== null &&
          entry.gitLockFiles.length === 0 &&
          (entry.writerEnded === "THIS_PROCESS" || entry.writerEnded === "PROVEN_GONE") &&
          entry.subprocesses === "GONE",
      )
    ) {
      return allow(ReasonCode.OK, undefined);
    }
    return deny(
      ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
      "an earlier attempt of this bootstrap run, or the process that wrote for it, cannot be shown to have ended, so no new attempt starts; it stays in doubt",
      { refusal: "EARLIER_ATTEMPT_IN_DOUBT", runId: application.runId, writerLockHeld, current, checkoutsDir, checkoutsDirKind, earlier },
    );
  }

  /**
   * #246 C3, CEO decision (d) — the chain a WRITTEN application is activated on, verified at the
   * execution boundary: reservation, attempt, the writes that attempt actually made, and the result
   * it stored. The row and the stored result are database rows a raw SQL writer can write, so neither
   * is taken as evidence of the other. The writes are evidenced outside the database, by the
   * attempt ledger the producer keeps in the run's work directory (each write recorded before it is
   * made and receipted with GitHub's readback after it), and the stored result must be exactly what
   * the producer derives from that ledger: this run, operation, PLAN and manifest; a receipt for
   * every planned write and none pending; its write receipts equal to the ledger's as the producer
   * states them; and its checkout this run's own leaf, carrying this operation's marker. A result
   * that is not is refused before any approval is consumed and before anything is activated.
   */
  private writtenChain(
    application: BootstrapApplication,
    workRoot: string,
    plan: RepoFactoryPlanFixture,
    execution: GitHubExecutionPlan,
    commitloreMode: unknown,
  ): Decision<RepoFactoryResult> {
    const { runId } = application;
    const unattributed = (message: string, evidence: Evidence = {}): Decision<RepoFactoryResult> =>
      deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, message, {
        stage: "precondition",
        refusal: "WRITTEN_RESULT_UNATTRIBUTED",
        runId,
        ...evidence,
      });
    const retained = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.REPO_FACTORY_RESULT);
    if (retained === null) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "the bootstrap application is WRITTEN and its stored result is missing", {
        stage: "activation",
        refusal: "WRITTEN_RESULT_MISSING",
        runId,
      });
    }
    const parsed = parseRepoFactoryResult(retained.content);
    if (!parsed.allowed) return atStage(parsed, "activation");
    const result = parsed.value;
    if (
      result.runId !== runId ||
      result.bootstrapOperationId !== application.bootstrapOperationId ||
      result.planDigest !== application.planDigest ||
      result.projectManifestDigest !== application.manifestDigest
    ) {
      return unattributed("the stored result names another run, operation, PLAN or manifest than the application it is activated for", {
        result: {
          runId: result.runId,
          bootstrapOperationId: result.bootstrapOperationId,
          planDigest: result.planDigest,
          projectManifestDigest: result.projectManifestDigest,
        },
      });
    }
    const workDir = join(workRoot, runId);
    const ledgerPath = githubLedgerPath(workDir, plan.repositoryRole);
    const owner = { bootstrapOperationId: plan.bootstrapOperationId, requestDigest: plan.requestDigest };
    const ledger = readGitHubLedger(ledgerPath, owner, execution.operations);
    if (!ledger.allowed) {
      return unattributed("the attempt ledger cannot be read as this operation's own", {
        ledgerPath,
        ledger: refusalRecord(ledger, "precondition"),
      });
    }
    const receipts = execution.operations.map((operation) => ledger.value.receipts.get(operation.operationId));
    if (ledger.value.pending.size > 0 || receipts.some((receipt) => receipt === undefined)) {
      return unattributed("the attempt ledger does not hold a receipt for every planned write", {
        ledgerPath,
        receipted: [...ledger.value.receipts.keys()],
        pending: [...ledger.value.pending.keys()],
      });
    }
    const inOrder = (list: readonly ExternalWriteReceipt[]): ExternalWriteReceipt[] =>
      [...list].sort((left, right) => left.operationId.localeCompare(right.operationId));
    const expected = inOrder(receipts.map((receipt) => toExternalWriteReceipt(receipt!, owner)));
    // Review 1076-R1-01 — each receipt's effect and attribution are compared exactly: operation,
    // resource, the states before and after, when it was made, whose operation and request it was.
    // `rereadAt` is only when the effect was last observed: a resume observes it again and the result
    // carries that time, while the ledger keeps the first, so it is the one field not compared.
    const effectOf = (receipt: ExternalWriteReceipt): Omit<ExternalWriteReceipt, "rereadAt"> => {
      const { rereadAt: _observedAt, ...effect } = receipt;
      return effect;
    };
    if (digestOf(inOrder(result.externalWriteReceipts).map(effectOf)) !== digestOf(expected.map(effectOf))) {
      return unattributed("the stored result's write receipts are not the ones the attempt ledger holds", { ledgerPath });
    }
    // The checkout the attempt that wrote it created: the application's last attempt.
    const checkoutPath = attemptCheckoutPath(workDir, plan.repositoryRole, application.attempts);
    const repositories = result.repositories;
    if (
      repositories.length !== 1 ||
      repositories[0]!.proposedCheckoutPath !== checkoutPath ||
      repositories[0]!.identity !== application.repositoryIdentity ||
      checkoutMarkerOf(checkoutPath) !== application.bootstrapOperationId
    ) {
      return unattributed("the stored result's checkout is not this run's own, carrying this operation's marker", {
        checkoutPath,
        proposed: repositories.map((repository) => repository.proposedCheckoutPath),
      });
    }
    // PR #1122 R1 (BCG-R1-02) — the repository facts the handoff delivers, selected from the stored result
    // bound to the PLAN's target and required verification, must be this execution's own readback as its
    // ledger receipted it: a create-only create's reported default branch and initialized parentless head,
    // or a push's branch and published head. Conflicting verification rows are refused in the selection.
    const facts = observedRepositoryFacts(result, {
      repositoryIdentity: application.repositoryIdentity,
      defaultBranch: plan.defaultBranch,
      verificationCommandId: plan.verificationCommandId,
    });
    const created = receipts.find((receipt) => receipt!.resourceType === "repository");
    const pushed = receipts.filter((receipt) => receipt!.resourceType === "branch").at(-1);
    const readback = execution.createOnly
      ? created?.resourceType === "repository"
        ? { branch: created.observed.defaultBranch ?? null, head: created.observed.initializedHead ?? null }
        : null
      : pushed?.resourceType === "branch"
        ? { branch: pushed.observed.name, head: pushed.observed.headSha }
        : null;
    if (!facts.allowed || readback === null || !handoffFactsAre({ repositoryFacts: facts.value }, [{ identity: application.repositoryIdentity, ...readback }])) {
      return unattributed("the stored result's repository facts are not this execution's readback in the attempt ledger", {
        ledgerPath,
        facts: facts.allowed ? facts.value : facts.evidence,
        readback,
      });
    }
    // Review S11-R1-03 — a CommitLore verification the stored result carries, bound to the record the
    // producer made beside this attempt at the head the ledger reads back: a row a database writer put
    // there after a refused observation, or one from another attempt or head, completes nothing.
    const commitlore = verifyCommitLoreBinding({
      mode: commitloreMode,
      result,
      workDir,
      expected: {
        runId,
        bootstrapOperationId: application.bootstrapOperationId,
        checkoutPath,
        repositoryIdentity: application.repositoryIdentity,
        head: readback.head,
      },
    });
    if (!commitlore.allowed) return atStage(commitlore as Decision<RepoFactoryResult>, "precondition");
    return allow(ReasonCode.OK, result);
  }

  /**
   * #246 C3, review 1076-R1-04 — everything a CONFIRM was admitted on, asked again synchronously where
   * it is relied on after an await: inside the transaction that consumes the approval or records an
   * attempt, and before each external write. The run is still at CEO review, project-less and pinned
   * to its BOOTSTRAP_CTO; the deciding CEO is still admitted, on the CEO binding and generation it was
   * admitted on; the PLAN and the review are the ones checked; the presented approval is still the
   * owner's newest; and, once anchored, it is still this execution's anchored identity.
   */
  private authorityHolds(snapshot: AuthoritySnapshot): Decision<void> {
    const { runId } = snapshot;
    const lost = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Evidence = {}): Decision<void> =>
      deny(reasonCode, message, { stage: "precondition", refusal, runId, ...evidence });
    const run = this.deps.runs.get(runId);
    if (run === null || run.projectId !== null || run.state !== RunState.READY_FOR_CEO_REVIEW) {
      return lost(ReasonCode.RUN_TRANSITION_ILLEGAL, "RUN_NOT_AT_CEO_REVIEW", "the bootstrap run left CEO review before its application was recorded", {
        state: run?.state ?? null,
      });
    }
    const pinned = this.assertOwnerPin(run);
    if (!pinned.allowed) return pinned;
    const admitted = this.deps.ceo.assertCeoDecisionAdmissible({
      runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: snapshot.candidateSnapshotDigest,
      ceoSessionId: snapshot.ceoSessionId,
      rationale: "bootstrap application",
    });
    if (!admitted.allowed) {
      return lost(admitted.reasonCode, "CEO_ADMISSION_LOST", "the deciding CEO is no longer admitted for this CONFIRM", {
        admission: refusalRecord(admitted, "precondition"),
      });
    }
    const binding = this.deps.bindings.active(roleKeyFor(Role.CEO));
    const admittedOn = snapshot.ceoBinding;
    if (
      binding === null ||
      admittedOn === null ||
      binding.status !== "ACTIVE" ||
      binding.assignmentId !== admittedOn.assignmentId ||
      binding.boundSessionId !== admittedOn.boundSessionId ||
      binding.bindingGeneration !== admittedOn.bindingGeneration
    ) {
      return lost(ReasonCode.GATE_AUTHORITY_DENIED, "CEO_BINDING_CHANGED", "the CEO binding this CONFIRM was admitted on was replaced, revoked or moved to another generation", {
        admittedOn: admittedOn === null ? null : { assignmentId: admittedOn.assignmentId, boundSessionId: admittedOn.boundSessionId, bindingGeneration: admittedOn.bindingGeneration },
        current: binding === null ? null : { assignmentId: binding.assignmentId, boundSessionId: binding.boundSessionId, bindingGeneration: binding.bindingGeneration, status: binding.status },
      });
    }
    const plan = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    if (plan?.digest !== snapshot.planDigest) {
      return lost(ReasonCode.EVIDENCE_STALE, "PLAN_CHANGED", "the run's PLAN is no longer the one this CONFIRM was checked against", {
        planDigest: plan?.digest ?? null,
        checked: snapshot.planDigest,
      });
    }
    const reviewed = this.deps.bootstrap.reviewForConfirmation(runId, snapshot.candidateSnapshotDigest);
    if (!reviewed.allowed || reviewed.value.digest !== snapshot.reviewDigest) {
      return lost(ReasonCode.EVIDENCE_STALE, "REVIEW_CHANGED", "the blind review is no longer the one this CONFIRM was checked against", {
        reviewDigest: reviewed.allowed ? reviewed.value.digest : null,
        checked: snapshot.reviewDigest,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * #246 C3, reviews 1076-R1-03 and -R1-04 — the GitHub port an attempt writes through. Reads pass
   * through. A write is refused before it is sent when its kind of request was left pending by an
   * earlier attempt — main's resume would send it again when GitHub does not show it, and a request
   * that may still land is never sent twice — or when the CONFIRM's authority no longer holds.
   */
  private guardedPort(
    pendingAtStart: ReadonlyMap<string, PendingWrite>,
    beforeWrite: (kind: PendingWrite["resourceType"]) => void,
    onWithheld: (evidence: Evidence) => void,
  ): GitHubWritePort {
    const port = this.deps.githubPort;
    const pendingKinds = new Map([...pendingAtStart.values()].map((intent) => [intent.resourceType, intent] as const));
    return new Proxy(port, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const kind = typeof property === "string" && Object.hasOwn(WRITE_REQUEST_KIND, property)
          ? WRITE_REQUEST_KIND[property as keyof typeof WRITE_REQUEST_KIND]
          : null;
        if (kind === null) return (value as (...args: unknown[]) => unknown).bind(target);
        return async (...args: unknown[]) => {
          // A merge call for a PR GitHub already shows merged sends no merge: the kernel only reads it back.
          if (property === "mergeGenesisPull" && (args[1] as { merged?: unknown } | undefined)?.merged === true) {
            return (value as (...args: unknown[]) => Promise<unknown>).apply(target, args);
          }
          const branch = (property === "createBranch" || property === "pushBranch" || property === "protectBranch") && typeof args[1] === "string" ? args[1] : null;
          const step = property === "openGenesisPull" ? "genesis-open" : property === "mergeGenesisPull" ? "genesis-merge" : null;
          const pending = kind === "genesis-resources" ? undefined
            : step !== null ? [...pendingAtStart.values()].find(p => p.resourceType === kind && p.resourceIdentity.endsWith(`#${step}`))
            : branch === null ? pendingKinds.get(kind) : [...pendingAtStart.values()].find(p => p.resourceType === kind && p.resourceIdentity.endsWith(`#${branch}`));
          if (pending !== undefined) {
            const evidence = { operationId: pending.operationId, resourceType: kind, attemptedAt: pending.attemptedAt };
            onWithheld(evidence);
            throw acpError(ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS, "a request an earlier attempt left pending is not sent again", evidence);
          }
          beforeWrite(kind);
          return (value as (...args: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });
  }

  /** #246 C3 — the run's owner pin is its ACTIVE BOOTSTRAP_CTO, at the pinned generation. */
  private assertOwnerPin(run: RunRow): Decision<void> {
    const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId });
    if (run.ownerSessionId === null || run.ownerBindingGeneration === null || run.ownerRoleKey !== roleKey) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "the bootstrap run's owner is not pinned to its BOOTSTRAP_CTO", {
        refusal: "OWNER_PIN_NOT_BOOTSTRAP_CTO",
        runId: run.runId,
        ownerRoleKey: run.ownerRoleKey,
      });
    }
    const active = this.deps.bindings.active(roleKey);
    if (active === null || active.status !== "ACTIVE" || active.boundSessionId !== run.ownerSessionId) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "the bootstrap run's pinned owner is not its ACTIVE BOOTSTRAP_CTO", {
        refusal: "OWNER_PIN_NOT_ACTIVE",
        runId: run.runId,
        ownerSessionId: run.ownerSessionId,
        activeSessionId: active?.boundSessionId ?? null,
      });
    }
    if (active.bindingGeneration !== run.ownerBindingGeneration) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "the bootstrap run's owner pin names a superseded BOOTSTRAP_CTO generation", {
        refusal: "OWNER_PIN_STALE",
        runId: run.runId,
        pinned: run.ownerBindingGeneration,
        current: active.bindingGeneration,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * #246 C3 — the project id and repository identity this run would reserve: held by no other run,
   * no such project registered, no such identity bound. A WRITTEN application's own activation may
   * already have registered both, and only its own: the registries refuse an id or identity another
   * run reserved. Synchronous, so the reservation transaction asks it again.
   */
  private reservationConflicts(
    reservation: BootstrapApplicationReservation,
    existing: BootstrapApplication | null,
  ): Decision<void> {
    const { runId, projectId, repositoryIdentity } = reservation;
    const others = this.deps.applications.heldByOthers(runId, { projectId, repositoryIdentity });
    if (others.length > 0) {
      return deny(
        ReasonCode.BOOTSTRAP_APPLICATION_RESERVED,
        "another bootstrap run holds the reservation for this project id or repository identity",
        {
          stage: "precondition",
          refusal: "BOOTSTRAP_APPLICATION_RESERVED",
          runId,
          projectId,
          repositoryIdentity,
          heldBy: others.map((other) => ({ runId: other.runId, phase: other.phase })),
        },
      );
    }
    const ownActivation = existing?.phase === "WRITTEN";
    if (this.deps.projects.get(projectId) !== null && !ownActivation) {
      return deny(ReasonCode.PROJECT_EXISTS, "the project the manifest names is already registered", {
        stage: "precondition",
        refusal: "PROJECT_EXISTS",
        runId,
        projectId,
      });
    }
    const bound = this.deps.repositories.byIdentity(repositoryIdentity);
    if (bound !== null && !(ownActivation && bound.projectId === projectId)) {
      return deny(ReasonCode.IDENTITY_COLLISION, "the repository identity this bootstrap creates is already bound", {
        stage: "precondition",
        refusal: "IDENTITY_COLLISION",
        runId,
        repositoryIdentity,
        boundTo: bound.projectId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * #246 C3 — GitHub, observed and never written: the target holds no repository, or one this run
   * created by the evidence it recorded — the node id its create was answered with in the attempt
   * ledger, or its creation receipt. A name match is never evidence. Before any reservation a
   * repository with no such evidence is a RESOURCE_COLLISION and nothing is consumed; after an
   * attempt was recorded its attribution is uncertain, and the application is STRANDED with no
   * create.
   */
  private async observedTarget(
    runId: string,
    workRoot: string,
    plan: RepoFactoryPlanFixture,
    execution: GitHubExecutionPlan,
    existing: BootstrapApplication | null,
    predecessor: SameNamedPredecessor | null = null,
  ): Promise<Decision<PendingAtStart>> {
    const ledgerPath = githubLedgerPath(join(workRoot, runId), plan.repositoryRole);
    const ledger = readGitHubLedger(
      ledgerPath,
      { bootstrapOperationId: plan.bootstrapOperationId, requestDigest: plan.requestDigest },
      execution.operations,
    );
    if (!ledger.allowed) {
      if (existing === null) return atStage(ledger as Decision<PendingAtStart>, "precondition");
      return this.strand(runId, "ATTRIBUTION_UNCERTAIN", { ledger: refusalRecord(ledger, "precondition"), ledgerPath });
    }
    let observed: ObservedRepository | null;
    try {
      observed = await this.deps.githubPort.observeRepository(execution.target);
    } catch (error) {
      const unanswered = deny(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "GitHub did not answer the read that tells whether the target is free; nothing is consumed or written",
        {
          stage: "precondition",
          refusal: "REMOTE_REFUSED",
          runId,
          target: `${execution.target.owner}/${execution.target.name}`,
          remote: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
          resumable: true,
        },
      );
      if (existing !== null) this.deps.applications.recordRefusal(runId, refusalRecord(unanswered, "precondition"));
      return unanswered as Decision<PendingAtStart>;
    }
    const createOperation = execution.operations.find((operation) => operation.resourceType === "repository");
    const receipt = createOperation === undefined ? undefined : ledger.value.receipts.get(createOperation.operationId);
    const pending = createOperation === undefined ? undefined : ledger.value.pending.get(createOperation.operationId);
    // The requests an earlier attempt sent and never receipted. An intent the runner recorded as withheld
    // at the moment its request would have started was never sent (review 1076-R2), so it is not one —
    // while its records prove that of this exact intent: withheld, with every generation that consumed
    // the exemption since having withheld it again (review 1076-R3). Such an intent is exempt, once.
    const pendingAtStart = new Map<string, PendingWrite>();
    const exemptAtStart = new Map<string, PendingWrite>();
    const unreadable: Array<{ operationId: string; resourceType: PendingWrite["resourceType"]; recordDirectory: string }> = [];
    for (const [operationId, intent] of ledger.value.pending) {
      if (ledger.value.receipts.has(operationId)) continue;
      const key = { operationId, intentDigest: digestOf(intent) };
      const records = readWithheldIntent(join(workRoot, runId), key);
      if (records === null) {
        unreadable.push({ operationId, resourceType: intent.resourceType, recordDirectory: withheldIntentDirectory(join(workRoot, runId), key) });
      }
      (withheldUnsent(records) ? exemptAtStart : pendingAtStart).set(operationId, intent);
    }
    // Review 1076-R4 — a withheld or consumption record of a pending intent that cannot be read, a
    // record cut short by a write that stopped included, is neither a proof that the request was
    // never sent nor an exemption still unused. It is kept where it is, and the attempt is refused by
    // name, with nothing sent, whatever GitHub shows; a person resolves it.
    if (existing !== null && unreadable.length > 0) {
      const refused = deny(
        ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
        "a record of whether a pending request was sent cannot be read; it is kept, nothing is sent, and the application stays in doubt",
        { stage: "precondition", refusal: "WITHHELD_RECORD_UNREADABLE", runId, operationId: unreadable[0]!.operationId, unreadable },
      );
      this.deps.applications.recordRefusal(runId, refusalRecord(refused, "precondition"));
      return refused as Decision<PendingAtStart>;
    }
    // #246 C3, review 1076-R1-03 — a request an earlier attempt sent and never saw answered may still
    // land: a client that gave up proves nothing about the server. Unless GitHub now shows its effect,
    // or main's resume would stop on it without sending, it is not sent again, and the application
    // stays IN_DOUBT with no request made. Something at the target that this run cannot attribute
    // strands below.
    if (existing !== null && pendingAtStart.size > 0) {
      const unsettled = await this.unsettledRequests(pendingAtStart, observed, plan, execution);
      if (unsettled.length > 0) {
        const unconfirmed = deny(
          ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
          "a request this run sent was never answered and GitHub does not show it settled; it is not sent again, and the application stays in doubt",
          {
            stage: "precondition",
            refusal: "UNCONFIRMED_PENDING_REQUEST",
            runId,
            target: `${execution.target.owner}/${execution.target.name}`,
            operationId: unsettled[0]!.operationId,
            unsettled,
            ledgerPath,
          },
        );
        this.deps.applications.recordRefusal(runId, refusalRecord(unconfirmed, "precondition"));
        return unconfirmed as Decision<PendingAtStart>;
      }
    }
    if (observed === null) return allow(ReasonCode.OK, { pending: pendingAtStart, exempt: exemptAtStart });
    const recordedNodeId = receipt?.resourceType === "repository" ? receipt.observed.nodeId : pending?.respondedNodeId ?? null;
    if (recordedNodeId !== null && recordedNodeId === observed.nodeId) {
      return allow(ReasonCode.OK, { pending: pendingAtStart, exempt: exemptAtStart });
    }
    const evidence = {
      target: `${execution.target.owner}/${execution.target.name}`,
      observedNodeId: observed.nodeId,
      recordedNodeId,
      createSent: pending !== undefined,
      ledgerPath,
    };
    // #1231 — a supersede whose retired predecessor has this same repository name: the predecessor's repository is
    // deleted outside ACP, before the create. While the name still resolves to a repository this run never sent a
    // create for, the CONFIRM is refused before anything is consumed, retryably, naming the predecessor's node id; a
    // CONFIRM after the deletion finds the name free and proceeds. A run that sent a create keeps the rules below.
    if (predecessor !== null && receipt === undefined && pending === undefined) {
      const target = `${execution.target.owner}/${execution.target.name}`;
      const refused = deny<PendingAtStart>(
        ReasonCode.RESOURCE_COLLISION,
        `${target} still holds a repository, and this supersede of ${predecessor.projectId} creates that name: delete the predecessor's repository, then CONFIRM again; nothing is consumed, remembered or sent to GitHub`,
        {
          stage: "precondition",
          refusal: "PREDECESSOR_REPOSITORY_PRESENT",
          runId,
          ...evidence,
          predecessorProjectId: predecessor.projectId,
          expectedPredecessorNodeId: predecessor.nodeId,
          observedIsPredecessor: predecessor.nodeId === null ? null : predecessor.nodeId === observed.nodeId,
          resumable: true,
          requiredOrder: [
            predecessor.nodeId === null || predecessor.nodeId === observed.nodeId
              ? `delete ${target} (node id ${observed.nodeId}), the repository of retired predecessor ${predecessor.projectId}`
              : `free ${target}: it resolves to node id ${observed.nodeId}, not ${predecessor.nodeId}, the repository predecessor ${predecessor.projectId} recorded`,
            "CONFIRM this run again",
          ],
        },
      );
      if (existing !== null) this.deps.applications.recordRefusal(runId, refusalRecord(refused, "precondition"));
      return refused;
    }
    if (existing === null) {
      return deny(
        ReasonCode.RESOURCE_COLLISION,
        "GitHub already holds a repository at the target, and nothing this run recorded attributes it to this run; it is not adopted, and nothing is consumed or written",
        { stage: "precondition", refusal: "RESOURCE_COLLISION", runId, ...evidence },
      );
    }
    return this.strand(runId, "ATTRIBUTION_UNCERTAIN", evidence);
  }

  /**
   * #1231 — the retired predecessor this PLAN supersedes, when ACP recorded it at this same repository identity, with
   * the node id of its repository if a resident provisioning of that project recorded one. Read only.
   */
  private sameNamedPredecessor(supersedesProjectId: string | undefined, repositoryIdentity: string): SameNamedPredecessor | null {
    if (supersedesProjectId === undefined) return null;
    const sameName = this.deps.db.get<{ found: number }>(
      `SELECT 1 AS found FROM repositories WHERE project_id = ? AND lower(identity) = lower(?) LIMIT 1`,
      [supersedesProjectId, repositoryIdentity],
    );
    if (sameName === undefined) return null;
    const recorded = this.deps.db.get<{ nodeId: unknown }>(
      `SELECT json_extract(allocation_json, '$.repositoryNodeId') AS nodeId FROM resident_project_provisioning WHERE project_id = ?`,
      [supersedesProjectId],
    );
    return { projectId: supersedesProjectId, nodeId: typeof recorded?.nodeId === "string" && recorded.nodeId.length > 0 ? recorded.nodeId : null };
  }

  /**
   * #246 C3, review 1076-R1-03 — the pending requests main's resume would send again, read from GitHub
   * and never written: a create with no recorded answer and no repository at the target; a push with
   * no branch there; a default-branch change GitHub does not show; a protection GitHub does not show.
   * A read that fails proves nothing, so its request is unsettled too. A pending request whose effect
   * GitHub shows, or that main's resume stops on without sending, is not listed; a protection present
   * but not the approved one is left to the guarded port, which refuses to send it.
   *
   * Review V52-R1-01 — each request is read back at its own target: a push or a protection at the
   * branch its operation names (`genesis`, `main` or `dev`), not the plan's default branch; the genesis
   * PR open by the marker its intent recorded; the genesis merge by that PR showing merged. The genesis
   * verification sends nothing — local commands and CI reads — so it repeats safely and is never in
   * doubt. A merge GitHub does not show, or an open with no PR to show for it, stays unsettled.
   */
  private async unsettledRequests(
    pendingAtStart: ReadonlyMap<string, PendingWrite>,
    repository: ObservedRepository | null,
    plan: RepoFactoryPlanFixture,
    execution: GitHubExecutionPlan,
  ): Promise<Array<{ operationId: string; resourceType: PendingWrite["resourceType"]; attemptedAt: string }>> {
    const port = this.deps.githubPort;
    const unsettled: Array<{ operationId: string; resourceType: PendingWrite["resourceType"]; attemptedAt: string }> = [];
    for (const [operationId, intent] of pendingAtStart) {
      const operation = execution.operations.find((candidate) => candidate.operationId === operationId);
      // The branch the operation itself names; a plan whose identity names none targets its default branch.
      const branchOf = (): string =>
        parseGitHubIdentity(operation?.resourceIdentity ?? intent.resourceIdentity)?.ref ?? plan.defaultBranch;
      let settled = false;
      try {
        switch (intent.resourceType) {
          case "genesis-resources": {
            settled = repository !== null && operation?.resourceType === "genesis-resources" && typeof port.ensureGenesisResources === "function"; // The port reads each stable key/marker before creating the remaining resources.
            break;
          }
          case "repository":
            settled = repository !== null || intent.respondedNodeId !== null;
            break;
          case "branch":
            settled = repository !== null && operation?.resourceType === "branch" && (await port.observeBranch(execution.target, branchOf())) !== null;
            break;
          case "setting": {
            settled =
              repository !== null &&
              operation?.resourceType === "setting" &&
              repository.defaultBranch === operation.desiredState.defaultBranch;
            break;
          }
          case "branch-protection":
            settled = repository !== null && operation?.resourceType === "branch-protection" && (await port.observeBranchProtection(execution.target, branchOf())) !== null;
            break;
          case "genesis-bootstrap": {
            if (repository === null || operation?.resourceType !== "genesis-bootstrap") break;
            const action = operation.desiredState.action;
            if (action === "verify") {
              settled = true;
              break;
            }
            if (intent.marker === null || typeof port.observeGenesisPull !== "function") break;
            const pull = await port.observeGenesisPull(execution.target, intent.marker);
            settled = action === "open" ? pull !== null : pull?.merged === true && pull.mergeCommitSha !== null;
            break;
          }
        }
      } catch {
        settled = false;
      }
      if (!settled) unsettled.push({ operationId, resourceType: intent.resourceType, attemptedAt: intent.attemptedAt });
    }
    return unsettled;
  }

  /**
   * STRANDED: the reservation and the evidence are kept, nothing is created, adopted, retried or
   * deleted, and the answer names the cause and the recovery a person performs.
   */
  private strand<T>(runId: string, cause: string, evidence: Evidence): Decision<T> {
    const stranded = { cause, requiredRecovery: STRANDED_RECOVERY, evidence };
    const marked = this.deps.applications.markStranded(runId, stranded);
    return deny(
      ReasonCode.BOOTSTRAP_APPLICATION_STRANDED,
      "what GitHub holds at this bootstrap's target cannot be attributed to this run; the application is STRANDED and a person resolves it",
      {
        stage: "precondition",
        refusal: "BOOTSTRAP_APPLICATION_STRANDED",
        runId,
        ...stranded,
        recorded: marked.allowed,
      },
    );
  }

  /**
   * #246 C3, CEO decision (b) as corrected — whether a cancelled run's reservation can be released,
   * asked without changing anything. Released only on positive proof that the application had no
   * external effect: no attempt in flight here and this process the only control-plane writer; and
   * either no attempt durably reached the stage that precedes the attempt ledger's first write (and
   * no ledger exists), or the ledger those attempts wrote — synced before every GitHub request is
   * sent — holds no receipt and no pending request. A missing ledger is not that proof: after an
   * attempt reached it, a missing or unreadable ledger is a doubt, as is a pending request or a
   * ledger nothing explains, and `inDoubt` says which; nothing is released. GitHub is not read.
   */
  inspectReservationRelease(runId: string | null): ReservationReleaseInspection {
    const preconditions: CheckoutRecoveryPrecondition[] = [];
    const proven = this.releaseProof(runId, preconditions);
    if (proven.allowed) return { preconditions, inDoubt: null, release: proven.value };
    for (const precondition of RESERVATION_RELEASE_PRECONDITIONS.slice(preconditions.length)) {
      preconditions.push({ precondition, satisfied: false, evidence: { notChecked: "an earlier precondition is unmet" } });
    }
    return {
      preconditions,
      inDoubt: proven.evidence["inDoubt"] === true ? { ...proven.evidence } : null,
      release: null,
    };
  }

  /**
   * The release itself: the proof taken again, synchronously, and refused unless it is still what
   * the repair's plan found (`planned`); then the row becomes RELEASED with the release record.
   * Nothing is deleted, no approval is consumed or re-admitted, and the cancelled run can never be
   * confirmed again.
   */
  releaseReservation(runId: string | null, planned: ReservationRelease | null): Decision<ReservationRelease> {
    const refuse = (refusal: string, message: string, evidence: Evidence): Decision<ReservationRelease> =>
      deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, message, { refusal, runId, ...evidence });
    const preconditions: CheckoutRecoveryPrecondition[] = [];
    const proven = this.releaseProof(runId, preconditions);
    if (!proven.allowed || planned === null) {
      return refuse("RELEASE_PRECONDITION_UNMET", "the reservation's release preconditions do not hold; nothing is released", {
        preconditions,
      });
    }
    if (digestOf(proven.value) !== digestOf(planned)) {
      return refuse("RELEASE_PLAN_CHANGED", "the reservation changed since the release was planned; nothing is released", {
        planned,
        current: proven.value,
      });
    }
    const released = this.deps.applications.markReleased(proven.value.runId, {
      cause: "RELEASED",
      requiredRecovery: "none: a new run reserves the project id and repository identity again under its own owner approval",
      evidence: { ...proven.value, releasedAt: this.deps.clock.nowIso() },
    });
    if (!released.allowed) return released as Decision<ReservationRelease>;
    return allow(ReasonCode.OK, proven.value);
  }

  /** CEO decision (b): a release refused because no effect can be proven keeps the reservation, marked so. */
  recordReleaseInDoubt(runId: string, inDoubt: Record<string, unknown>): void {
    this.deps.applications.recordRefusal(runId, { stage: "release", refusal: "RELEASE_IN_DOUBT", ...inDoubt });
  }

  /** The release preconditions, appended to `preconditions` as they are checked. */
  private releaseProof(runId: string | null, preconditions: CheckoutRecoveryPrecondition[]): Decision<ReservationRelease> {
    const met = (satisfied: boolean, evidence: unknown): boolean => {
      preconditions.push({ precondition: RESERVATION_RELEASE_PRECONDITIONS[preconditions.length]!, satisfied, evidence });
      return satisfied;
    };
    const unmet = (evidence: Evidence = {}): Decision<ReservationRelease> =>
      deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, "a release precondition is unmet", { runId, ...evidence });
    const inDoubt = (cause: string, evidence: Evidence): Decision<ReservationRelease> => {
      met(false, { cause, ...evidence });
      return unmet({ inDoubt: true, cause, ...evidence });
    };
    const run = runId === null ? null : this.deps.runs.get(runId);
    const application = runId === null ? null : this.deps.applications.get(runId);
    if (
      !met(
        run !== null && run.kind === RunKind.PROJECT_BOOTSTRAP && run.state === RunState.CANCELLED &&
          application !== null && application.phase === "RESERVED",
        { runId, kind: run?.kind ?? null, state: run?.state ?? null, phase: application?.phase ?? null },
      ) ||
      runId === null ||
      application === null
    ) {
      return unmet();
    }
    const attemptInFlight = this.#applying.has(runId);
    const writerLockHeld = this.#writerLockHeld?.() === true;
    if (!met(!attemptInFlight && writerLockHeld, { attemptInFlight, writerLockHeld })) return unmet();

    // Which ledger the attempts wrote, from what the application reserved; if that cannot be said,
    // neither can what they sent.
    const outputs = this.reservedOutputs(application, ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE);
    if (!outputs.allowed) return inDoubt("RESERVED_PLAN_UNREADABLE", { plan: outputs.evidence });
    const workRoot = this.deps.workRoot;
    if (workRoot === null || !PATH_SAFE_RUN_ID.test(runId)) return inDoubt("WORK_ROOT_UNCONFIGURED", { workRoot });
    const ledgerPath = githubLedgerPath(join(workRoot, runId), outputs.value.target.repositoryRole);
    const ledgerPresent = pathOccupied(ledgerPath);
    // Every attempt records, durably, that it reached its first ledger write before it writes the
    // ledger, and the ledger is written before every GitHub request. So an attempt with no such
    // record never sent anything; one with it is judged by the ledger, which must then be there.
    const ledgerStageAttempts = this.deps.applications.ledgerStageAttempts(runId);
    if (ledgerStageAttempts.length === 0) {
      // No attempt reached the ledger: nothing was sent. A ledger nothing explains is a doubt.
      if (ledgerPresent) return inDoubt("LEDGER_UNEXPLAINED", { ledgerPath, ledgerStageAttempts });
      met(true, { ledgerPath, ledgerPresent, ledgerStageAttempts });
    } else {
      // An attempt reached the ledger: a missing ledger proves nothing, it is a doubt.
      if (!ledgerPresent) return inDoubt("LEDGER_MISSING", { ledgerPath, ledgerStageAttempts });
      const ledger = readGitHubLedger(
        ledgerPath,
        { bootstrapOperationId: outputs.value.bootstrapOperationId, requestDigest: outputs.value.requestDigest },
        outputs.value.githubOperations,
      );
      if (!ledger.allowed) return inDoubt("LEDGER_UNREADABLE", { ledgerPath, ledger: refusalRecord(ledger, "precondition") });
      const receipted = [...ledger.value.receipts.keys()].sort();
      const pending = [...ledger.value.pending.keys()].sort();
      // A pending request was sent and its outcome never recorded: whatever GitHub shows now, it may
      // still land. That is a doubt, not a release.
      if (pending.length > 0) return inDoubt("UNRESOLVED_REQUEST", { ledgerPath, pending, receipted });
      // A receipt is a write that landed: an external effect, not a doubt. The reservation is kept.
      if (!met(receipted.length === 0, { cause: receipted.length === 0 ? null : "WRITE_LANDED", ledgerPath, receipted, ledgerStageAttempts })) {
        return unmet({ cause: "WRITE_LANDED", receipted });
      }
    }
    return allow(ReasonCode.OK, {
      runId: application.runId,
      projectId: application.projectId,
      repositoryIdentity: application.repositoryIdentity,
      bootstrapOperationId: application.bootstrapOperationId,
      attempts: application.attempts,
      approvalDigest: application.approvalDigest,
      ledgerPath,
      ledgerPresent,
      ledgerStageAttempts,
    });
  }

  /**
   * The planned outputs an application reserved, derived again from the run's PLAN artifact and the
   * manifest an owner approval of the run carried, and matched to the reservation by digest — the
   * PLAN, the manifest and the outputs — so a record's own claims decide nothing.
   */
  private reservedOutputs(
    application: BootstrapApplication,
    reasonCode: ReasonCode,
    approvedManifest: ProjectManifest | null = null,
  ): Decision<PlannedBootstrapOutputs> {
    const { runId } = application;
    const refuse = (refusal: string, message: string, evidence: Evidence = {}) =>
      deny(reasonCode, message, { refusal, runId, ...evidence }) as Decision<PlannedBootstrapOutputs>;
    const planArtifact = this.deps.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    if (planArtifact === null || planArtifact.digest !== application.planDigest) {
      return refuse("PLAN_NOT_RESERVED", "the run's PLAN artifact is not the one its application reserved", {
        planDigest: planArtifact?.digest ?? null,
        reserved: application.planDigest,
      });
    }
    const carried = currentBootstrapPlan(runId, planArtifact);
    const manifest = approvedManifest ?? (carried.allowed ? carried.value.manifest : undefined);
    if (manifest === undefined || manifestDigest(manifest) !== application.manifestDigest) {
      return refuse("MANIFEST_NOT_RESERVED", "no owner approval of this run carries the manifest its application reserved", {
        reserved: application.manifestDigest,
      });
    }
    const planned = plannedBootstrapOutputs({ runId, planArtifact }, manifest);
    if (!planned.allowed) return refuse("PLAN_NOT_EXECUTABLE", planned.message, planned.evidence);
    const outputs = planned.value;
    if (
      digestOf(outputs) !== application.plannedOutputsDigest ||
      outputs.bootstrapOperationId !== application.bootstrapOperationId ||
      outputs.target.repositoryIdentity !== application.repositoryIdentity
    ) {
      return refuse("OUTPUTS_NOT_RESERVED", "the planned outputs are not the ones the application reserved", {
        bootstrapOperationId: outputs.bootstrapOperationId,
        reserved: application.bootstrapOperationId,
      });
    }
    return allow(ReasonCode.OK, outputs);
  }

  private async activate(
    input: ProduceAndActivateInput,
    result: RepoFactoryResult,
  ): Promise<Decision<ACPBootstrapActivationResult>> {
    const current = currentBootstrapPlan(input.runId, this.deps.artifacts.latest(input.runId, ArtifactKind.PLAN));
    if (!current.allowed) return current as Decision<ACPBootstrapActivationResult>;
    if (current.value.outputs.genesis) {
      // WRITTEN retries skip production. They must still observe the exact published merge head,
      // its approved Actions checks and main's currency before delivering/activating the handoff.
      const outputs = current.value.outputs;
      const target = parseGitHubIdentity(outputs.target.repositoryIdentity);
      const facts = observedRepositoryFacts(result, factsTargetOf(outputs));
      const head = facts.allowed ? facts.value[0]?.head : null;
      const workflows = outputs.ciWorkflows;
      const port = this.deps.githubPort;
      const refuse = (refusal: string): Decision<ACPBootstrapActivationResult> => {
        const decision = deny<ACPBootstrapActivationResult>(ReasonCode.VERIFICATION_GAP, "merged-main activation verification refused", {stage:"activation",refusal,runId:input.runId});
        this.deps.applications.recordRefusal(input.runId, refusalRecord(decision, "activation"));
        return decision;
      };
      if (!target || !head || !workflows?.length || !port.observeGenesisPostMergeCi) return refuse("GENESIS_POST_MERGE_CI_REFUSED");
      try {
        const checkNames = [...new Set([...workflows.map(w=>w.checkName),...(outputs.postMergeCommands ?? [])])];
        const main = await port.observeBranch(target,"main");
        if (main?.headSha !== head) return refuse("GENESIS_MERGE_DRIFT");
        const ci = await port.observeGenesisPostMergeCi(target,head,workflows,checkNames);
        if (ci.state !== "success") return refuse(ci.state === "pending" ? "GENESIS_POST_MERGE_CI_PENDING" : "GENESIS_POST_MERGE_CI_REFUSED");
        if ((await port.observeBranch(target,"main"))?.headSha !== head) return refuse("GENESIS_MERGE_DRIFT");
      } catch { return refuse("GENESIS_POST_MERGE_CI_REFUSED"); }
    }
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
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      factoryResult: result,
      approvedManifest: input.approvedManifest,
      localBindings,
      projectName: input.projectName,
      handoff: input.handoff,
    });
    // The WRITTEN application keeps the last refusal activation met — a primary CTO that could not
    // be provisioned, a handoff not yet acknowledged — and the next CONFIRM activates it again.
    if (!activated.allowed) this.deps.applications.recordRefusal(input.runId, refusalRecord(activated, "activation"));
    return atStage(activated, "activation");
  }
}
