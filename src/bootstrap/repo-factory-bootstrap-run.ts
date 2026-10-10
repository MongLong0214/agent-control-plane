import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, assertPortableManifest, manifestDigest } from "../contracts/manifest.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { holderProvenGone } from "../daemon/single-instance.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { ArtifactKind, Role, RunKind, RunState, roleKeyFor, type RoleBinding, type RunRow } from "../domain/types.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { ACPBootstrapActivationResult, BootstrapActivation } from "./activation.ts";
import { type GroupMember, ownGroupSubprocesses, processGroupEmpty } from "./attempt-writer-group.ts";
import { type BootstrapWriteRequest, runUnderWriteGuard } from "./bootstrap-write-guard.ts";
import {
  type OwnerApprovalAnchor,
  readApprovalAnchor,
  readWithheldRequest,
  writeApprovalAnchor,
  writeWithheldRequest,
} from "./bootstrap-approval-anchor.ts";
import type {
  AttemptWriter,
  BootstrapApplication,
  BootstrapApplicationReservation,
  BootstrapApplications,
} from "./bootstrap-applications.ts";
import {
  approvedPlanSchema,
  bootstrapActivationHandoff,
  executablePlanOf,
  executableOperationsSchema,
  type PlannedBootstrapOutputs,
  plannedBootstrapOutputs,
} from "./bootstrap-plan.ts";
import type { GitHubWritePort, ObservedRepository } from "./github-write-port.ts";
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
  repositoryCheckoutPath,
  type RepoFactoryPlanFixture,
} from "./repo-factory-producer.ts";
import { type ExternalWriteReceipt, parseRepoFactoryResult, type RepoFactoryResult } from "./repo-factory-result.ts";

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
 * The blind review that state requires happened before the writes. Since issue #246 PR-C slice C2
 * it reviews the run's planned outputs (`plannedBootstrapOutputs`): the files with their exact
 * bytes, the operations, the target, the verification and the handoff, reloaded from the PLAN
 * artifact. The producer writes those files, and the tree at the head it reports must be exactly
 * them (`producedTreeDrift`, BOOTSTRAP_CONTRACT_DRIFT); there is no second model review after the
 * writes, the evidence is that readback.
 *
 * What authorises the write. An owner approval receipt, rather than the run, the CTO or the plan:
 * one minted by admitted ingress (`OwnerAuthority`, PRD §21/§27.2) for the operation
 * `REPO_FACTORY_GITHUB_WRITE_OPERATION`, whose parameter digest binds the owner, the visibility,
 * the approved PLAN artifact's digest and its `githubOperations`. A caller can carry the receipt;
 * it cannot mint one, because `assertApproval` re-reads the ingress admission it came from. The
 * receipt is consumed once for the candidate the CEO confirms and re-admitted from that durable
 * consumption on a retry, so a partial failure can resume without a second approval and the
 * approval cannot be carried to a different candidate. A receipt minted while the run's pointer
 * named a candidate is consumed for that candidate only. One exception to the retry: a receipt
 * that the heads before PR #1050's RF1050-01 consumed with no candidate authorises none, because
 * that record cannot say which candidate it served; the CONFIRM is refused with the remedy
 * NEW_OWNER_DECISION, and under a new owner decision production resumes from the GitHub ledger.
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
 * Everything that can be refused is refused before the first GitHub call: run kind, the PLAN
 * artifact and the manifest against it (`bootstrapPlanPreflight`, inside the planned outputs), the
 * activation preconditions a result cannot change — a passing review of the confirmed candidate
 * bound to that PLAN among them — the approval, and the producer's own pure preflight. A refusal
 * here has made no GitHub read or write.
 *
 * A produced result is stored (REPO_FACTORY_RESULT) inside the producer's cleanup, before
 * activation is attempted. Activation of a fresh bootstrap normally stops once — the incoming CTO
 * has not yet acknowledged its handoff — and the second call, admitted under the same approval,
 * activates that stored result rather than producing again: the producer's checkout now exists.
 * There is no other copy and no shortcut around the approval (PR #1043 review round 3, RF1043-08):
 * a result that could not be stored leaves no checkout, and its retry takes the ordinary path —
 * approval, then the ledger reconciled against GitHub, then the result rebuilt. A checkout left by
 * a run that died is never removed, moved or reused (RF1043-07): each attempt of a bootstrap
 * application creates a checkout of its own, bound to the run and the attempt (#246 C3).
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
 * The durable application record (issue #246 PR-C slice C3, `bootstrap-applications.ts`). Every
 * CONFIRM door reaches this one path, in this order: the pre-write checks — the run project-less at
 * CEO review, its owner pin the ACTIVE BOOTSTRAP_CTO, the CEO admissible, the project not registered
 * (PROJECT_EXISTS), the repository identity not bound (IDENTITY_COLLISION), no other run's
 * reservation, the checkout leaf free, and GitHub, observed only, holding no repository at the
 * target or this run's by the evidence it recorded (RESOURCE_COLLISION) — each refusing with zero
 * writes and the approval unconsumed; then the approval consumed and the reservation inserted, its
 * first attempt recorded, in one transaction; the producer, whose ledger records each external write
 * before it is made; the result and WRITTEN in one transaction; activation; and COMPLETED in the
 * CEO's completion transaction. A recovery is the CEO re-CONFIRMing the same frozen candidate: it
 * records another attempt before its first write, and never recreates a repository because the row
 * says RESERVED nor adopts one because its name matches — a repository is this run's only by the
 * node id its create was answered with, or its creation receipt. Uncertain attribution strands the
 * application, keeping the reservation and the evidence; nothing retries it.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  /**
   * #246 C3 — the session the CONFIRM is made as. It must be admissible as the deciding CEO before
   * anything is consumed or written (`ProductionGate.assertCeoDecisionAdmissible`).
   */
  ceoSessionId: string;
  ownerApproval: RepoFactoryOwnerApproval | null;
  approvedManifest: ProjectManifest;
  projectName: string;
  handoff: HandoffPackage;
}

/** The CEO's CONFIRM of a PROJECT_BOOTSTRAP run, as every CONFIRM door hands it to the runner. */
export interface BootstrapConfirmation {
  runId: string;
  candidateSnapshotDigest: string;
  ceoSessionId: string;
  rationale?: string;
}

export interface RepoFactoryBootstrapRunnerDeps {
  runs: Pick<RunEngine, "get" | "currentCandidate">;
  artifacts: Pick<ArtifactStore, "latest" | "list" | "put">;
  ownerAuthority: Pick<OwnerAuthorityPort, "assertConsumedApproval" | "consumeApproval" | "assertConsumable">;
  bootstrap: Pick<BootstrapActivation, "activate" | "readinessForFactoryResult" | "reviewForConfirmation">;
  /** The production composition passes `createBootstrapGitHubWritePort()`; tests pass a double. */
  githubPort: GitHubWritePort;
  /** Each run produces under `<workRoot>/<runId>`. Null means this deployment never configured one. */
  workRoot: string | null;
  clock: Clock;
  /** #246 C3 — the transaction the approval's consumption, the reservation and its attempt share. */
  db: Pick<Db, "txDecision">;
  /** #246 C3 — the durable application record. */
  applications: BootstrapApplications;
  /** #246 C3 — the CEO admission every CONFIRM door asks, asked again here before anything is consumed. */
  ceo: Pick<ProductionGate, "assertCeoDecisionAdmissible">;
  bindings: Pick<BindingRegistry, "active">;
  projects: Pick<ProjectRegistry, "get">;
  repositories: Pick<RepositoryRegistry, "byIdentity">;
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
  setDefaultBranch: "setting",
  protectBranch: "branch-protection",
} as const satisfies Record<string, PendingWrite["resourceType"]>;

/** The kind of ledger intent a GitHub request at its start belongs to, or null for one that is none. */
const requestKind = (request: BootstrapWriteRequest): PendingWrite["resourceType"] | null => {
  if (request.kind === "git") return request.method === "push" ? "branch" : null;
  if (request.method === "POST") return "repository";
  if (request.method === "PATCH") return "setting";
  if (request.method === "PUT") return "branch-protection";
  return null;
};

/** What a CONFIRM was admitted on, asked again where it is relied on after an await (review 1076-R1-04). */
interface AuthoritySnapshot {
  runId: string;
  candidateSnapshotDigest: string;
  ceoSessionId: string;
  ceoBinding: RoleBinding | null;
  planDigest: string;
  reviewDigest: string;
  /** The owner receipt the execution runs on. */
  executionReceipt: OwnerApprovalReceipt;
  /** The run's work directory once the presented approval is anchored as the identity, else null. */
  anchorWorkDir: string | null;
}

/**
 * Whether two owner receipts carry the same decision: the same run, operation, write scope,
 * candidate and answer. Who sent it, its nonce and its idempotency key are not the decision.
 */
const sameOwnerDecision = (left: OwnerApprovalReceipt, right: OwnerApprovalReceipt): boolean =>
  left.runId === right.runId &&
  left.operation === right.operation &&
  left.parameterDigest === right.parameterDigest &&
  left.candidateSnapshotDigest === right.candidateSnapshotDigest &&
  left.approved === right.approved;

/** The digest of exactly an application's reservation — what its approval anchor is bound to. */
const reservationDigestOf = (reservation: BootstrapApplicationReservation): string =>
  digestOf({
    runId: reservation.runId,
    projectId: reservation.projectId,
    repositoryIdentity: reservation.repositoryIdentity,
    bootstrapOperationId: reservation.bootstrapOperationId,
    planDigest: reservation.planDigest,
    manifestDigest: reservation.manifestDigest,
    plannedOutputsDigest: reservation.plannedOutputsDigest,
    candidateSnapshotDigest: reservation.candidateSnapshotDigest,
    reviewDigest: reservation.reviewDigest,
    approvalDigest: reservation.approvalDigest,
  });

/**
 * What a person does about a STRANDED application. The reservation is never reused and nothing is
 * deleted automatically, so the recovery is a person's: establish what the repository at the target
 * is, then cancel this run and bootstrap again under a new project id and repository identity.
 */
const STRANDED_RECOVERY =
  "a person establishes whether the repository at the target is this run's, by comparing its GitHub node id with the attempt ledger named in the evidence; nothing is created, adopted or deleted automatically, the reservation is kept and never reused, so the run is cancelled and the project is bootstrapped again under a new project id and repository identity";

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

/**
 * #246 C3, CEO decision (c) — the checkout leaf attempt `attempt` of a run creates: a name of its
 * own beside the producer's default leaf, bound to the run (its work directory) and the attempt. No
 * attempt ever reuses, moves or removes another attempt's checkout; an earlier one stays where it is.
 */
export const attemptCheckoutPath = (workDir: string, repositoryRole: string, attempt: number): string =>
  join(dirname(repositoryCheckoutPath(workDir, repositoryRole)), `${repositoryRole}.attempt-${attempt}`);

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
   * The CEO confirm's entry for a PROJECT_BOOTSTRAP run, which every CONFIRM door reaches:
   * `produceAndActivate` over the owner's newest recorded approval of this operation, so a later
   * decline supersedes an earlier approval; with none recorded it refuses as a missing approval,
   * before any GitHub call. A recorded receipt is still only a claim there; it is re-read against
   * the ingress admission behind it before anything is consumed. The CONFIRM's candidate and CEO
   * session are carried through unchanged.
   */
  async produceAndActivateApproved(confirmation: BootstrapConfirmation): Promise<Decision<ACPBootstrapActivationResult>> {
    const { runId } = confirmation;
    const missing = (message: string): Decision<ACPBootstrapActivationResult> =>
      deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, message, { stage: "approval", refusal: "APPROVAL_MISSING", runId });
    const approvals = this.deps.artifacts
      .list<unknown>(runId, ArtifactKind.APPROVAL)
      .filter(
        (artifact) =>
          !artifact.superseded &&
          isRecord(artifact.content) &&
          artifact.content["kind"] === REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND,
      );
    const newest = this.executionsOwnApproval(runId, approvals) ?? approvals.at(-1);
    if (newest === undefined) {
      return missing("a Repo Factory GitHub write needs the owner's approval, and none is recorded for this run");
    }
    const recorded = recordedApprovalSchema.safeParse(newest.content);
    if (!recorded.success) return missing("the owner approval recorded for this run is malformed");
    const manifest = assertPortableManifest(recorded.data.approvedManifest);
    if (!manifest.allowed) return missing("the owner approval recorded for this run carries no usable manifest");
    return this.produceAndActivate({
      runId,
      candidateSnapshotDigest: confirmation.candidateSnapshotDigest,
      ceoSessionId: confirmation.ceoSessionId,
      ownerApproval: { owner: recorded.data.owner, visibility: recorded.data.visibility, receipt: recorded.data.receipt },
      approvedManifest: manifest.value,
      projectName: recorded.data.projectName,
      handoff: bootstrapActivationHandoff(manifest.value),
    });
  }

  /**
   * #246 C3 — the owner approving the same scope again while an execution runs on an anchored
   * approval is not a new decision: the same decision recorded twice must not strand the execution,
   * so the CONFIRM presents the execution's own recorded approval and the duplicate is neither
   * consumed nor admitted. A decline, or a decision of another scope, is the newest decision as ever.
   * Undefined when there is no anchored execution or the newest decision is not a duplicate of it.
   */
  private executionsOwnApproval<T extends { content: unknown }>(runId: string, approvals: readonly T[]): T | undefined {
    const application = this.deps.applications.get(runId);
    const workRoot = this.deps.workRoot;
    const newest = approvals.at(-1);
    if (application === null || workRoot === null || newest === undefined) return undefined;
    const identity = this.anchoredIdentity(application, join(workRoot, runId));
    if (!identity.allowed) return undefined;
    const receiptOf = (artifact: T): OwnerApprovalReceipt | null => {
      const recorded = recordedApprovalSchema.safeParse(artifact.content);
      if (!recorded.success) return null;
      const parsed = ownerApprovalReceiptSchema.safeParse(recorded.data.receipt);
      return parsed.success ? parsed.data : null;
    };
    const newestReceipt = receiptOf(newest);
    if (newestReceipt === null || !sameOwnerDecision(newestReceipt, identity.value.receipt)) return undefined;
    return approvals.findLast((artifact) => {
      const receipt = receiptOf(artifact);
      return receipt !== null && digestOf(receipt) === identity.value.receiptDigest;
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

    // The owner's receipt must name this run, this operation and exactly these parameters, and
    // approve them; and it must be consumable for this candidate, or already consumed for it. Asked
    // without consuming: consumption waits for the last pre-write check (PR #1043 review round 3,
    // RF1043-08 — every call is authorised before anything else it does, a stored result included).
    const receipt = this.approvalReceipt(runId, input.ownerApproval.receipt, {
      owner: authority.owner,
      visibility: authority.visibility,
      planDigest: planArtifact.digest,
      githubOperations: operations,
    });
    if (!receipt.allowed) return atStage(receipt as Decision<ACPBootstrapActivationResult>, "approval");
    // The write scope the owner approved: the digest of exactly these parameters. A recovery may be
    // authorised by a later owner decision of the same scope (RF1050-04), never by another scope.
    // It is what the reservation keeps as `approval_digest`, and it is only ever compared: whether the
    // approval exists is answered just below, by the owner authority, from the receipt itself — its
    // durable consumption for this candidate, or its ingress admission — never by a digest the
    // application row holds (CEO decision (a)).
    const approvalDigest = receipt.value.parameterDigest;
    const presentedReceiptDigest = digestOf(receipt.value);
    /**
     * Whether this CONFIRM consumes the presented receipt: a new execution always does, and an existing
     * one only when its approval identity cannot be proven. A resume of a proven execution runs on the
     * receipt its anchor names, verified and never consumed again (review 1076-R1-02).
     */
    let consumesPresented = existing === null;
    /**
     * Consumes the presented receipt inside the caller's transaction, when this CONFIRM consumes it.
     * Its consumption is re-checked there against live ingress by the owner authority; for an existing
     * execution it becomes the identity the anchor written after the commit will name.
     */
    const consumePresented = (): Decision<void> => {
      if (!consumesPresented) return allow(ReasonCode.OK, undefined);
      const consumed = this.deps.ownerAuthority.consumeApproval(receipt.value, input.candidateSnapshotDigest);
      if (consumed.allowed && existing !== null) this.deps.applications.recordApprovalIdentity(runId, presentedReceiptDigest);
      return consumed;
    };

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
    // #246 C3, the CEO's ruling on inheritance and review 1076-R1-02 — a CONFIRM of an existing
    // application resumes the SAME approved execution. Its basis is the owner receipt named by the
    // approval anchor the runner wrote when it consumed that receipt from live ingress: never consumed,
    // re-issued or admitted again, and no other approval is admitted for the same execution. The
    // OWNER_APPROVAL_CONSUMED row is an ordinary audit row a raw SQL writer can insert, so it is never
    // the authority: without the anchor the identity is unproven, and only a new owner approval —
    // admitted from live ingress and consumed now — continues the execution. A WRITTEN application has
    // nothing left to approve; its identity must be proven. A new run, and any change of target, owner,
    // visibility, PLAN, manifest or write scope, needs a new owner approval too: those are refused
    // above, by the receipt's run and parameters and by the freeze.
    if (existing !== null) {
      const identity = this.anchoredIdentity(existing, join(workRoot, runId));
      if (identity.allowed) {
        if (presentedReceiptDigest !== identity.value.receiptDigest) {
          return refuse(
            ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
            "APPROVAL_NOT_THIS_EXECUTION",
            "this bootstrap application resumes on the owner approval its reservation consumed; another approval is not admitted for the same execution",
            { approvalIdentity: identity.value.receiptDigest, presented: presentedReceiptDigest },
            "approval",
          );
        }
      } else if (existing.phase === "WRITTEN") {
        return atStage(identity as Decision<ACPBootstrapActivationResult>, "approval");
      } else {
        consumesPresented = true;
      }
    }
    if (consumesPresented) {
      // Admitted from live ingress and not yet consumed: a receipt already consumed — for another
      // execution, or on the strength of a row nobody admitted — never starts or continues one.
      const consumable = this.deps.ownerAuthority.assertConsumable(receipt.value, input.candidateSnapshotDigest);
      if (!consumable.allowed) {
        if (existing === null) return atStage(consumable as Decision<ACPBootstrapActivationResult>, "approval");
        // The owner authority's own answer, named: the execution continues only under a new owner
        // approval admitted from live ingress, and an approval already consumed is not taken for it.
        return {
          ...consumable,
          evidence: { stage: "approval", refusal: "NEW_OWNER_APPROVAL_REQUIRED", runId, presented: presentedReceiptDigest, ...consumable.evidence },
        } as Decision<ACPBootstrapActivationResult>;
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
    const authorityHolds = (anchored: boolean): Decision<void> =>
      this.authorityHolds({
        runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        ceoSessionId: input.ceoSessionId,
        ceoBinding,
        planDigest: planArtifact.digest,
        reviewDigest: reviewed.value.digest,
        executionReceipt: receipt.value,
        anchorWorkDir: anchored ? workDir : null,
      });

    // Production is still owed unless the application is WRITTEN. A new attempt starts only once every
    // earlier one is shown to have ended with no writer left (CEO decision (c)); the checkout it will
    // create — its own, bound to the run and the attempt — must be free; and what GitHub holds at the
    // target must be nothing, or this run's by the evidence it recorded, with every request an earlier
    // attempt left pending shown settled (review 1076-R1-03).
    const nextAttempt = (existing?.attempts ?? 0) + 1;
    let pendingAtStart: ReadonlyMap<string, PendingWrite> = new Map();
    if (existing?.phase !== "WRITTEN") {
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
      const attribution = await this.observedTarget(runId, workRoot, executable, execution.value, existing);
      if (!attribution.allowed) return attribution as Decision<ACPBootstrapActivationResult>;
      pendingAtStart = attribution.value;
    }

    // The order of operations: consume the approval and INSERT the reservation, with the first
    // attempt recorded, in one transaction — its UNIQUE constraints close the race the checks above
    // could not, and a refusal there rolls the consumption back with it. A recovery records its
    // attempt the same way, before its first external write. A WRITTEN application has none to make.
    let attempt: number;
    if (existing === null) {
      const reserved = this.deps.db.txDecision(() => {
        const applicable = authorityHolds(false);
        if (!applicable.allowed) return applicable as Decision<BootstrapApplication>;
        const fresh = this.reservationConflicts(reservation, null);
        if (!fresh.allowed) return fresh as Decision<BootstrapApplication>;
        const consumed = consumePresented();
        if (!consumed.allowed) return consumed as Decision<BootstrapApplication>;
        return this.deps.applications.reserve(reservation, {
          approvalReceiptDigest: presentedReceiptDigest,
          writer: this.currentWriter(),
        });
      });
      if (!reserved.allowed) return atStage(reserved as Decision<ACPBootstrapActivationResult>, "approval");
      attempt = reserved.value.attempts;
    } else if (existing.phase === "RESERVED") {
      const recorded = this.deps.db.txDecision(() => {
        const applicable = authorityHolds(!consumesPresented);
        if (!applicable.allowed) return applicable as Decision<BootstrapApplication>;
        const consumed = consumePresented();
        if (!consumed.allowed) return consumed as Decision<BootstrapApplication>;
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
      const written = this.completionChain(existing);
      if (!written.allowed) {
        this.deps.applications.recordRefusal(runId, refusalRecord(written, "precondition"));
        return written as Decision<ACPBootstrapActivationResult>;
      }
      return this.activate(input, written.value);
    }

    // The consumed receipt is anchored as this execution's identity after its consumption committed
    // and before the attempt's first ledger write. If that fails nothing is sent, and the execution
    // continues only under a new owner approval, since its identity cannot then be proven.
    if (consumesPresented) {
      const anchored = writeApprovalAnchor(workDir, {
        runId,
        bootstrapOperationId: reservation.bootstrapOperationId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        reservationDigest: reservationDigestOf(reservation),
        owner: authority.owner,
        visibility: authority.visibility,
        approvedManifest: input.approvedManifest,
        receipt: receipt.value,
        anchoredAt: this.deps.clock.nowIso(),
      });
      if (!anchored.allowed) {
        this.deps.applications.recordRefusal(runId, refusalRecord(anchored, "approval"));
        return atStage(anchored as Decision<ACPBootstrapActivationResult>, "approval");
      }
    }

    // Before every external write the attempt makes: its authority still holds (R1-04), and no request
    // an earlier attempt left pending is sent again (R1-03). The first is asked before the request's
    // pending intent reaches the ledger, so a refusal leaves nothing pending; then again by the
    // guarded port when the method is called, and once more at the moment the request itself starts,
    // after any read the port method awaited first (review 1076-R2). A refusal there leaves an intent
    // in the ledger that was never sent, so it is recorded as withheld: a later attempt may make it.
    // A write already started is recorded when it returns, and is never retried.
    let staleAuthority: Decision<void> | null = null;
    let withheld: Evidence | null = null;
    const knownPending = new Set(pendingAtStart.keys());
    let ledgerPending: readonly PendingWrite[] = [...pendingAtStart.values()];
    const beforeWrite = (kind: PendingWrite["resourceType"] | null): void => {
      const holds = authorityHolds(true);
      if (holds.allowed) return;
      staleAuthority ??= holds;
      const intent = kind === null ? undefined : ledgerPending.find((pending) => pending.resourceType === kind);
      if (intent !== undefined) {
        try {
          writeWithheldRequest(workDir, {
            runId,
            attempt,
            operationId: intent.operationId,
            resourceType: intent.resourceType,
            attemptedAt: intent.attemptedAt,
            withheldAt: this.deps.clock.nowIso(),
            refusal: typeof holds.evidence["refusal"] === "string" ? holds.evidence["refusal"] : "AUTHORITY_LOST",
          });
        } catch {
          // Unrecorded, the intent stays in doubt: nothing is sent either way.
        }
      }
      throw acpError(holds.reasonCode, holds.message, holds.evidence);
    };
    const githubPort = this.guardedPort(pendingAtStart, beforeWrite, (evidence) => {
      withheld ??= evidence;
    });

    // Otherwise the producer, for a first attempt and every recovery alike: it reconciles its ledger
    // against GitHub — a repository is this run's only by the node id its create was answered with,
    // or its creation receipt — performs what is left, and rebuilds the result. It builds that in a
    // checkout of this attempt's own, created exclusively and kept if the attempt fails; nothing an
    // earlier attempt left is reused. The result and WRITTEN are stored in one transaction.
    let ledgerStageRecorded = false;
    const writeGuard = { beforeRequest: (request: BootstrapWriteRequest) => beforeWrite(requestKind(request)) };
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
          const holds = authorityHolds(true);
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
      persist: (result) => {
        const written = this.deps.db.txDecision(() => {
          this.deps.artifacts.put(runId, ArtifactKind.REPO_FACTORY_RESULT, result);
          return this.deps.applications.markWritten(runId);
        });
        if (!written.allowed) throw acpError(written.reasonCode, written.message, written.evidence);
      },
    })).catch((error: unknown): Decision<RepoFactoryResult> => {
      // The attempt stopped itself before a request: answered below, by what stopped it.
      if (staleAuthority === null && withheld === null) throw error;
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
    return this.activate(input, produced.value);
  }

  /**
   * #246 C3, review 1076-R1-02 — the approval identity of an existing application's execution, proven
   * or refused. Proven only by the approval anchor the runner wrote when it consumed that receipt from
   * live ingress: the anchor of the identity the application records, naming this run, operation,
   * candidate, write scope and exactly this reservation, with the receipt's consumption for this
   * candidate recorded beside it. A database row — the recorded identity, the consumption — is never
   * enough on its own; without the anchor the identity is unproven.
   */
  private anchoredIdentity(application: BootstrapApplication, workDir: string): Decision<OwnerApprovalAnchor> {
    const { runId } = application;
    const unproven = (refusal: string, message: string, evidence: Evidence = {}): Decision<OwnerApprovalAnchor> =>
      deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, message, { refusal, runId, ...evidence });
    const identity = this.deps.applications.approvalIdentity(runId);
    if (identity === null) return unproven("APPROVAL_UNANCHORED", "this bootstrap application records no approval identity");
    const read = readApprovalAnchor(workDir, identity);
    if (!read.allowed) return { ...read, evidence: { runId, approvalIdentity: identity, ...read.evidence } } as Decision<OwnerApprovalAnchor>;
    if (read.value === null) {
      return unproven("APPROVAL_UNANCHORED", "the approval this bootstrap application records was never anchored when it was consumed", {
        approvalIdentity: identity,
      });
    }
    const anchor = read.value;
    if (
      anchor.runId !== runId ||
      anchor.receipt.runId !== runId ||
      anchor.bootstrapOperationId !== application.bootstrapOperationId ||
      anchor.candidateSnapshotDigest !== application.candidateSnapshotDigest ||
      anchor.receipt.parameterDigest !== application.approvalDigest ||
      anchor.reservationDigest !== reservationDigestOf(application)
    ) {
      return unproven("APPROVAL_ANCHOR_MISMATCH", "the approval anchor names another run, operation, candidate, write scope or reservation", {
        approvalIdentity: identity,
      });
    }
    const consumed = this.deps.ownerAuthority.assertConsumedApproval(anchor.receipt, application.candidateSnapshotDigest);
    if (!consumed.allowed) {
      return unproven("APPROVAL_ANCHOR_UNCONSUMED", "the anchored approval has no recorded consumption for this candidate", {
        approvalIdentity: identity,
        consumption: refusalRecord(consumed, "approval"),
      });
    }
    return allow(ReasonCode.OK, anchor);
  }

  /**
   * #246 C3, review 1076-R1-02 — the chain a WRITTEN application completes on, the same at every
   * completion entry: the runner's own, the CEO decision that completes the run, and the activation
   * finalizer inside it. The approval anchored as the execution's identity; the planned outputs the
   * application reserved, rebuilt from the run's PLAN and the approved manifest; the owner's current
   * decision, which must still be that approval (review 1076-R2: a decline recorded after the writes
   * completes nothing); and the stored result, attributed to the attempt ledger receipt by receipt.
   */
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
    const identity = this.anchoredIdentity(application, join(workRoot, runId));
    if (!identity.allowed) return atStage(identity as Decision<RepoFactoryResult>, "approval");
    const current = this.currentOwnerDecision(runId, identity.value.receipt);
    if (!current.allowed) return current as Decision<RepoFactoryResult>;
    const manifest = assertPortableManifest(identity.value.approvedManifest);
    if (!manifest.allowed) return atStage(manifest as Decision<RepoFactoryResult>, "approval");
    const outputs = this.reservedOutputs(application, ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, manifest.value);
    if (!outputs.allowed) return atStage(outputs as Decision<RepoFactoryResult>, "precondition");
    const executable = executablePlanOf(outputs.value, application.planDigest);
    const execution = preflightGitHubOperations(executable, {
      owner: identity.value.owner,
      visibility: identity.value.visibility,
      approvedOperations: outputs.value.githubOperations.map(({ operationId, resourceType, resourceIdentity }) => ({
        operationId,
        resourceType,
        resourceIdentity,
      })),
    });
    if (!execution.allowed) return atStage(execution as Decision<RepoFactoryResult>, "precondition");
    return this.writtenChain(application, workRoot, executable, execution.value);
  }

  /**
   * #246 C3, review 1076-R2 — the owner's current decision on the run, which an execution completes
   * on: its newest recorded Repo Factory decision must be the approval the execution runs on, or the
   * same decision recorded again (idempotent). A decline, or a decision of another scope, refuses: an
   * approval the owner has since declined authorises no completion. External writes already made are
   * not undone by this; they stay as the WRITTEN application and its ledger record them.
   */
  private currentOwnerDecision(runId: string, approval: OwnerApprovalReceipt): Decision<void> {
    const newest = this.newestRecordedApproval(runId);
    if (newest === null || newest.digest === digestOf(approval)) return allow(ReasonCode.OK, undefined);
    if (newest.receipt !== null && sameOwnerDecision(newest.receipt, approval)) return allow(ReasonCode.OK, undefined);
    const declined = newest.receipt !== null && newest.receipt.approved === false;
    return deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      declined
        ? "the owner declined after this execution's approval; the writes already made stay as recorded, and nothing is completed on the earlier approval"
        : "the owner's newest decision is not the approval this execution runs on; the writes already made stay as recorded, and nothing is completed",
      {
        stage: "approval",
        refusal: declined ? "APPROVAL_DECLINED" : "APPROVAL_SUPERSEDED",
        runId,
        approval: digestOf(approval),
        newest: newest.digest,
        writtenEffectsKept: true,
      },
    );
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
   * the second refuses rather than admits. No lock file may be left in an earlier checkout's .git,
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
          : current !== null && current.startToken !== null && writer.pid === current.pid && writer.startToken === current.startToken
            ? "THIS_PROCESS"
            : holderProvenGone({ pid: writer.pid, startedAt: writer.startedAt, startToken: writer.startToken, path: "" })
              ? "PROVEN_GONE"
              : "NOT_PROVEN_GONE";
      const group = writer?.processGroup ?? null;
      let subprocesses: (typeof earlier)[number]["subprocesses"];
      let running: GroupMember[] | undefined;
      if (writer === null || group === null) {
        subprocesses = "UNRECORDED";
      } else if (writerEnded === "THIS_PROCESS") {
        // This process's own group: none of its subprocesses may still be running.
        const members = current?.processGroup === group ? ownGroupSubprocesses(group) : null;
        running = members ?? undefined;
        subprocesses = members === null ? "UNREADABLE" : members.length === 0 ? "GONE" : "RUNNING";
      } else if (group !== writer.pid) {
        // A group the writer did not lead holds other processes too; its subprocesses cannot be told apart.
        subprocesses = "NOT_LED_BY_WRITER";
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
    // A decline or a decision of another scope recorded since supersedes the approval; the same
    // decision recorded again does not (it is idempotent, and the execution keeps its own receipt).
    const executionDigest = digestOf(snapshot.executionReceipt);
    const newest = this.newestRecordedApproval(runId);
    if (newest !== null && newest.digest !== executionDigest && (newest.receipt === null || !sameOwnerDecision(newest.receipt, snapshot.executionReceipt))) {
      return lost(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "APPROVAL_SUPERSEDED", "the owner recorded a newer decision than the approval this CONFIRM runs on", {
        executionReceipt: executionDigest,
        newest: newest.digest,
      });
    }
    if (snapshot.anchorWorkDir !== null) {
      const application = this.deps.applications.get(runId);
      const identity = application === null ? null : this.anchoredIdentity(application, snapshot.anchorWorkDir);
      if (identity === null || !identity.allowed || identity.value.receiptDigest !== executionDigest) {
        return lost(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "APPROVAL_IDENTITY_CHANGED", "the approval this CONFIRM runs on is no longer this execution's anchored identity", {
          executionReceipt: executionDigest,
          identity: identity === null ? null : identity.allowed ? identity.value.receiptDigest : refusalRecord(identity, "approval"),
        });
      }
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** The owner's newest recorded Repo Factory decision on the run, if any: its digest, and its receipt when it parses. */
  private newestRecordedApproval(runId: string): { digest: string; receipt: OwnerApprovalReceipt | null } | null {
    const newest = this.deps.artifacts
      .list<unknown>(runId, ArtifactKind.APPROVAL)
      .filter(
        (artifact) =>
          !artifact.superseded && isRecord(artifact.content) && artifact.content["kind"] === REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND,
      )
      .at(-1);
    if (newest === undefined) return null;
    const recorded = recordedApprovalSchema.safeParse(newest.content);
    if (!recorded.success) return { digest: digestOf(newest.content), receipt: null };
    const receipt = ownerApprovalReceiptSchema.safeParse(recorded.data.receipt);
    return { digest: digestOf(recorded.data.receipt), receipt: receipt.success ? receipt.data : null };
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
          const pending = pendingKinds.get(kind);
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
  ): Promise<Decision<ReadonlyMap<string, PendingWrite>>> {
    const ledgerPath = githubLedgerPath(join(workRoot, runId), plan.repositoryRole);
    const ledger = readGitHubLedger(
      ledgerPath,
      { bootstrapOperationId: plan.bootstrapOperationId, requestDigest: plan.requestDigest },
      execution.operations,
    );
    if (!ledger.allowed) {
      if (existing === null) return atStage(ledger as Decision<ReadonlyMap<string, PendingWrite>>, "precondition");
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
      return unanswered as Decision<ReadonlyMap<string, PendingWrite>>;
    }
    const createOperation = execution.operations.find((operation) => operation.resourceType === "repository");
    const receipt = createOperation === undefined ? undefined : ledger.value.receipts.get(createOperation.operationId);
    const pending = createOperation === undefined ? undefined : ledger.value.pending.get(createOperation.operationId);
    // The requests an earlier attempt sent and never receipted. An intent the runner recorded as withheld
    // at the moment its request would have started was never sent (review 1076-R2), so it is not one.
    const pendingAtStart = new Map(
      [...ledger.value.pending].filter(
        ([operationId, intent]) =>
          !ledger.value.receipts.has(operationId) &&
          readWithheldRequest(join(workRoot, runId), operationId, intent.attemptedAt) === null,
      ),
    );
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
        return unconfirmed as Decision<ReadonlyMap<string, PendingWrite>>;
      }
    }
    if (observed === null) return allow(ReasonCode.OK, pendingAtStart);
    const recordedNodeId = receipt?.resourceType === "repository" ? receipt.observed.nodeId : pending?.respondedNodeId ?? null;
    if (recordedNodeId !== null && recordedNodeId === observed.nodeId) return allow(ReasonCode.OK, pendingAtStart);
    const evidence = {
      target: `${execution.target.owner}/${execution.target.name}`,
      observedNodeId: observed.nodeId,
      recordedNodeId,
      createSent: pending !== undefined,
      ledgerPath,
    };
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
   * #246 C3, review 1076-R1-03 — the pending requests main's resume would send again, read from GitHub
   * and never written: a create with no recorded answer and no repository at the target; a push with
   * no branch there; a default-branch change GitHub does not show; a protection GitHub does not show.
   * A read that fails proves nothing, so its request is unsettled too. A pending request whose effect
   * GitHub shows, or that main's resume stops on without sending, is not listed; a protection present
   * but not the approved one is left to the guarded port, which refuses to send it.
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
      let settled: boolean;
      try {
        switch (intent.resourceType) {
          case "repository":
            settled = repository !== null || intent.respondedNodeId !== null;
            break;
          case "branch":
            settled = repository !== null && (await port.observeBranch(execution.target, plan.defaultBranch)) !== null;
            break;
          case "setting": {
            const operation = execution.operations.find((candidate) => candidate.operationId === operationId);
            settled =
              repository !== null &&
              operation?.resourceType === "setting" &&
              repository.defaultBranch === operation.desiredState.defaultBranch;
            break;
          }
          case "branch-protection":
            settled = repository !== null && (await port.observeBranchProtection(execution.target, plan.defaultBranch)) !== null;
            break;
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
    // The manifest the owner approved: the one its approval anchor carries when the caller has it,
    // else one an owner approval recorded on the run carries — either only if it is the reserved one.
    const manifest = [
      ...(approvedManifest === null ? [] : [approvedManifest]),
      ...this.deps.artifacts
      .list<unknown>(runId, ArtifactKind.APPROVAL)
      .map((artifact) => recordedApprovalSchema.safeParse(artifact.content))
      .flatMap((recorded) => (recorded.success ? [assertPortableManifest(recorded.data.approvedManifest)] : []))
      .flatMap((parsed) => (parsed.allowed ? [parsed.value] : [])),
    ].find((candidate) => manifestDigest(candidate) === application.manifestDigest);
    if (manifest === undefined) {
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


  /**
   * The owner's receipt must name this run, this operation and exactly these parameters, and
   * approve them. Pure: whether it may be consumed for the candidate the CEO confirms — once, or
   * re-admitted from that durable consumption on a retry — is asked of the owner authority.
   */
  private approvalReceipt(
    runId: string,
    presented: unknown,
    parameters: Parameters<typeof repoFactoryGitHubWriteParameters>[0],
  ): Decision<OwnerApprovalReceipt> {
    const refuse = (refusal: string, message: string, evidence: Evidence = {}): Decision<OwnerApprovalReceipt> =>
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
    return allow(ReasonCode.OK, receipt);
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
