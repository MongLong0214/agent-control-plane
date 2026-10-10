import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, assertPortableManifest, manifestDigest } from "../contracts/manifest.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { RollbackFilesystem } from "../db/fd-vfs.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { ArtifactKind, Role, RunKind, RunState, roleKeyFor, type RunRow } from "../domain/types.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { ACPBootstrapActivationResult, BootstrapActivation } from "./activation.ts";
import type {
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
} from "./repo-factory-github.ts";
import {
  assertParentChainNotAttackerWritable,
  checkoutMarkerOf,
  ensureDirectoryLevel,
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
  /** The production composition passes `createGhCliGitHubWritePort()`; tests pass a double. */
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

/**
 * What a person does about a STRANDED application. The reservation is never reused and nothing is
 * deleted automatically, so the recovery is a person's: establish what the repository at the target
 * is, then cancel this run and bootstrap again under a new project id and repository identity.
 */
const STRANDED_RECOVERY =
  "a person establishes whether the repository at the target is this run's, by comparing its GitHub node id with the attempt ledger named in the evidence; nothing is created, adopted or deleted automatically, the reservation is kept and never reused, so the run is cancelled and the project is bootstrapped again under a new project id and repository identity";

/**
 * #246 C3, CEO decision (c) — the preconditions of the official recovery of a checkout an
 * interrupted application left behind, in the order the repair catalog lists them. Each must be
 * verified; one that cannot be is unmet, and nothing moves.
 */
export const INTERRUPTED_CHECKOUT_PRECONDITIONS = [
  "the run is a project-less PROJECT_BOOTSTRAP run at CEO review whose application is RESERVED with an attempt recorded",
  "the checkout is the one the application's reserved PLAN places, a directory of this account under a private parent chain, whose marker names the application's bootstrap operation",
  "no application attempt of the run is in flight, this process holds the control plane's single-writer lock, and no git lock file is held in the checkout",
  "the preservation location is free",
] as const;

/** The checkout an application's reserved PLAN places, as `placedCheckout` verified it. */
interface PlacedCheckout {
  workDir: string;
  checkoutPath: string;
  repositoryRole: string;
  /** Exact (dev, ino) of the checkout, its parent and the work directory, as decimal text. */
  checkoutDevice: string;
  checkoutInode: string;
  checkoutParentDevice: string;
  checkoutParentInode: string;
  workDirDevice: string;
  workDirInode: string;
}

/** Where preserved checkouts are kept: beside the run's checkouts, in the run's own work directory. */
const PRESERVED_DIRECTORY = "preserved";

/** One precondition as a repair receipt keeps it. */
export interface CheckoutRecoveryPrecondition {
  precondition: string;
  satisfied: boolean;
  evidence: unknown;
}

/** What preserving an interrupted checkout moved, from where to where, and whose it was. */
export interface InterruptedCheckoutPreservation {
  runId: string;
  bootstrapOperationId: string;
  attempts: number;
  candidateSnapshotDigest: string;
  originalPath: string;
  preservedPath: string;
  /**
   * The verified objects, by exact (dev, ino) as decimal text: the checkout, the directory holding it,
   * and the run's work directory. The move acts only through descriptors held on these, re-verified.
   */
  checkoutDevice: string;
  checkoutInode: string;
  checkoutParentDevice: string;
  checkoutParentInode: string;
  workDirDevice: string;
  workDirInode: string;
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
  "the attempt ledger, which records every GitHub request before it is sent, shows none was ever sent: it is absent, or this operation's own with no receipt and no pending request",
  "the last attempt's own outcome is recorded: it ended in a production refusal that names this ledger and no request issued or completed",
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
  /** Whether the ledger file exists at all; when it does, it holds no receipt and no pending request. */
  ledgerPresent: boolean;
  /** The last attempt's recorded outcome, as the application row keeps it. */
  lastAttemptOutcome: { attempt: number; refusal: string | null; reasonCode: string | null };
}

export interface ReservationReleaseInspection {
  preconditions: CheckoutRecoveryPrecondition[];
  /** Why the external effect cannot be proven absent, when it cannot: the reservation is then kept, in doubt. */
  inDoubt: Record<string, unknown> | null;
  release: ReservationRelease | null;
}


export interface InterruptedCheckoutInspection {
  preconditions: CheckoutRecoveryPrecondition[];
  /** The move every precondition allows; null unless all of them hold. */
  move: InterruptedCheckoutPreservation | null;
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

export class RepoFactoryBootstrapRunner {
  /** #246 C3 — the runs with an application attempt in flight in this process. */
  readonly #applying = new Set<string>();
  /** #246 C3 — whether this process holds the control plane's single-writer lock; see `attachWriterLock`. */
  #writerLockHeld: (() => boolean) | null = null;

  constructor(private readonly deps: RepoFactoryBootstrapRunnerDeps) {}

  /**
   * #246 C3 — the daemon attaches its single-instance lock once it holds it. While it is held no
   * other control-plane process runs, so an application attempt not in flight in this one has
   * ended. Never attached, that cannot be shown, and the interrupted-checkout recovery refuses.
   */
  attachWriterLock(held: () => boolean): void {
    this.#writerLockHeld = held;
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
      candidateSnapshotDigest: confirmation.candidateSnapshotDigest,
      ceoSessionId: confirmation.ceoSessionId,
      ownerApproval: { owner: recorded.data.owner, visibility: recorded.data.visibility, receipt: recorded.data.receipt },
      approvedManifest: manifest.value,
      projectName: recorded.data.projectName,
      handoff: bootstrapActivationHandoff(manifest.value),
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
    const retainedApproval = this.deps.ownerAuthority.assertConsumedApproval(receipt.value, input.candidateSnapshotDigest);
    if (!retainedApproval.allowed) {
      // A receipt not yet consumed must be consumable for this candidate; a receipt minted for
      // another candidate, or consumed with none by an earlier head (RF1050-03/-04), is refused here.
      const consumable = this.deps.ownerAuthority.assertConsumable(receipt.value, input.candidateSnapshotDigest);
      if (!consumable.allowed) return atStage(consumable as Decision<ACPBootstrapActivationResult>, "approval");
    }
    /** Consumes the receipt inside the caller's transaction unless it was already consumed for this candidate. */
    const consumeIfNew = (): Decision<void> =>
      retainedApproval.allowed
        ? allow(ReasonCode.OK, undefined)
        : this.deps.ownerAuthority.consumeApproval(receipt.value, input.candidateSnapshotDigest);

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

    // Production is still owed unless the application is WRITTEN: the leaf it creates must be free,
    // and what GitHub holds at the target must be nothing, or this run's by the evidence it recorded.
    if (existing?.phase !== "WRITTEN") {
      const occupied = occupiedCheckoutLeaf(join(workRoot, runId), executable);
      if (occupied !== null) {
        if (existing !== null) this.deps.applications.recordRefusal(runId, refusalRecord(occupied, "precondition"));
        return atStage(occupied as Decision<ACPBootstrapActivationResult>, "precondition");
      }
      const attribution = await this.observedTarget(runId, workRoot, executable, execution.value, existing);
      if (!attribution.allowed) return attribution as Decision<ACPBootstrapActivationResult>;
    }

    // The order of operations: consume the approval and INSERT the reservation, with the first
    // attempt recorded, in one transaction — its UNIQUE constraints close the race the checks above
    // could not, and a refusal there rolls the consumption back with it. A recovery records its
    // attempt the same way, before its first external write. A WRITTEN application has none to make.
    if (existing === null) {
      const reserved = this.deps.db.txDecision(() => {
        const applicable = this.stillApplicable(runId);
        if (!applicable.allowed) return applicable as Decision<BootstrapApplication>;
        const fresh = this.reservationConflicts(reservation, null);
        if (!fresh.allowed) return fresh as Decision<BootstrapApplication>;
        const consumed = consumeIfNew();
        if (!consumed.allowed) return consumed as Decision<BootstrapApplication>;
        return this.deps.applications.reserve(reservation);
      });
      if (!reserved.allowed) return atStage(reserved as Decision<ACPBootstrapActivationResult>, "approval");
    } else if (existing.phase === "RESERVED") {
      const attempt = this.deps.db.txDecision(() => {
        const applicable = this.stillApplicable(runId);
        if (!applicable.allowed) return applicable as Decision<BootstrapApplication>;
        const consumed = consumeIfNew();
        if (!consumed.allowed) return consumed as Decision<BootstrapApplication>;
        return this.deps.applications.recordAttempt(runId, existing.attempts);
      });
      if (!attempt.allowed) return atStage(attempt as Decision<ACPBootstrapActivationResult>, "precondition");
    } else {
      // A WRITTEN application activates the result its own attempt stored, on the call after a
      // handoff is acknowledged or after a primary CTO could not be provisioned. That result is
      // proved to be the attempt's own before the approval is consumed or anything is activated
      // (CEO decision (d)): a WRITTEN row and a stored result are database rows, and a database
      // writer can write both.
      const written = this.writtenChain(existing, workRoot, executable, execution.value);
      if (!written.allowed) return written as Decision<ACPBootstrapActivationResult>;
      const consumed = this.deps.db.txDecision(consumeIfNew);
      if (!consumed.allowed) return atStage(consumed as Decision<ACPBootstrapActivationResult>, "approval");
      return this.activate(input, written.value);
    }

    // Otherwise the producer, for a first attempt and every recovery alike: it reconciles its ledger
    // against GitHub — a repository is this run's only by the node id its create was answered with,
    // or its creation receipt — performs what is left, and rebuilds the result. The result and
    // WRITTEN are stored in one transaction, inside the producer's cleanup, so a result that could
    // not be stored leaves no checkout and the next attempt takes this same path.
    const produced = await produceRepoFactoryResult({
      plan: executable,
      workDir: join(workRoot, runId),
      clock: this.deps.clock,
      github: { port: this.deps.githubPort, authority },
      // The reviewed files, and the tree the producer reports must be exactly these (#246 C2).
      approvedFiles: outputs.files,
      persist: (result) => {
        const written = this.deps.db.txDecision(() => {
          this.deps.artifacts.put(runId, ArtifactKind.REPO_FACTORY_RESULT, result);
          return this.deps.applications.markWritten(runId);
        });
        if (!written.allowed) throw acpError(written.reasonCode, written.message, written.evidence);
      },
    });
    if (!produced.allowed) {
      const refusal = produced.evidence["refusal"];
      // The repository at the target cannot be attributed to this run: someone else's, a name
      // reused, a create whose answer was never recorded, or a ledger that cannot be read. After an
      // attempt, that is STRANDED — never a recreate, never an adoption by name.
      if (produced.reasonCode === ReasonCode.RESOURCE_COLLISION || (typeof refusal === "string" && LEDGER_REFUSALS.has(refusal))) {
        return this.strand(runId, "ATTRIBUTION_UNCERTAIN", {
          production: refusalRecord(produced, "production"),
          ledgerPath: githubLedgerPath(join(workRoot, runId), executable.repositoryRole),
        });
      }
      this.deps.applications.recordRefusal(runId, refusalRecord(produced, "production"));
      return atStage(produced as Decision<ACPBootstrapActivationResult>, "production");
    }
    return this.activate(input, produced.value);
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
    if (digestOf(inOrder(result.externalWriteReceipts)) !== digestOf(expected)) {
      return unattributed("the stored result's write receipts are not the ones the attempt ledger holds", { ledgerPath });
    }
    const checkoutPath = repositoryCheckoutPath(workDir, plan.repositoryRole);
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
   * The run checks again, synchronously, inside the transaction that consumes the approval or
   * records an attempt: GitHub was awaited since they were first made.
   */
  private stillApplicable(runId: string): Decision<void> {
    const run = this.deps.runs.get(runId);
    if (run === null || run.projectId !== null || run.state !== RunState.READY_FOR_CEO_REVIEW) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "the bootstrap run left CEO review before its application was recorded", {
        stage: "precondition",
        refusal: "RUN_NOT_AT_CEO_REVIEW",
        runId,
        state: run?.state ?? null,
      });
    }
    return this.assertOwnerPin(run);
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
  ): Promise<Decision<void>> {
    const ledgerPath = githubLedgerPath(join(workRoot, runId), plan.repositoryRole);
    const ledger = readGitHubLedger(
      ledgerPath,
      { bootstrapOperationId: plan.bootstrapOperationId, requestDigest: plan.requestDigest },
      execution.operations,
    );
    if (!ledger.allowed) {
      if (existing === null) return atStage(ledger as Decision<void>, "precondition");
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
      return unanswered;
    }
    if (observed === null) return allow(ReasonCode.OK, undefined);
    const createOperation = execution.operations.find((operation) => operation.resourceType === "repository");
    const receipt = createOperation === undefined ? undefined : ledger.value.receipts.get(createOperation.operationId);
    const pending = createOperation === undefined ? undefined : ledger.value.pending.get(createOperation.operationId);
    const recordedNodeId = receipt?.resourceType === "repository" ? receipt.observed.nodeId : pending?.respondedNodeId ?? null;
    if (recordedNodeId !== null && recordedNodeId === observed.nodeId) return allow(ReasonCode.OK, undefined);
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
   * #246 C3, CEO decision (c) — whether the checkout an interrupted application attempt left behind
   * can be preserved, asked without changing anything. A process that died mid-attempt leaves its
   * checkout, and every later CONFIRM is refused INTERRUPTED_RUN_CHECKOUT (fail-closed, and kept so).
   * The official recovery moves that checkout aside, and only after each precondition is verified:
   * the run and its RESERVED application; the checkout is exactly the one that application's
   * reserved PLAN places and carries its marker; no attempt of the run is in flight here, and this
   * process is the only control-plane writer, so the attempt that left it has ended; no git lock
   * file is held in it; and the preservation location is free. Whatever cannot be verified is unmet.
   */
  inspectInterruptedCheckout(runId: string | null): InterruptedCheckoutInspection {
    const preconditions: CheckoutRecoveryPrecondition[] = [];
    const met = (satisfied: boolean, evidence: unknown): boolean => {
      preconditions.push({ precondition: INTERRUPTED_CHECKOUT_PRECONDITIONS[preconditions.length]!, satisfied, evidence });
      return satisfied;
    };
    const unmetFromHere = (): InterruptedCheckoutInspection => {
      for (const precondition of INTERRUPTED_CHECKOUT_PRECONDITIONS.slice(preconditions.length)) {
        preconditions.push({ precondition, satisfied: false, evidence: { notChecked: "an earlier precondition is unmet" } });
      }
      return { preconditions, move: null };
    };

    const run = runId === null ? null : this.deps.runs.get(runId);
    const application = runId === null ? null : this.deps.applications.get(runId);
    if (
      !met(
        runId !== null &&
          run !== null &&
          run.kind === RunKind.PROJECT_BOOTSTRAP &&
          run.projectId === null &&
          run.state === RunState.READY_FOR_CEO_REVIEW &&
          application !== null &&
          application.phase === "RESERVED" &&
          application.attempts >= 1,
        {
          runId,
          kind: run?.kind ?? null,
          projectId: run?.projectId ?? null,
          state: run?.state ?? null,
          phase: application?.phase ?? null,
          attempts: application?.attempts ?? null,
        },
      ) ||
      runId === null ||
      application === null
    ) {
      return unmetFromHere();
    }

    const placed = this.placedCheckout(application);
    if (!met(placed.allowed, placed.allowed ? placed.value : { message: placed.message, ...placed.evidence }) || !placed.allowed) {
      return unmetFromHere();
    }
    const { workDir, checkoutPath, repositoryRole } = placed.value;

    const attemptInFlight = this.#applying.has(runId);
    const writerLockHeld = this.#writerLockHeld?.() === true;
    const locks = gitLockFiles(checkoutPath);
    if (
      !met(!attemptInFlight && writerLockHeld && locks !== null && locks.length === 0, {
        attemptInFlight,
        writerLockHeld,
        gitLockFiles: locks ?? "the checkout's git directory could not be read in full",
      })
    ) {
      return unmetFromHere();
    }

    const preservedName = `${repositoryRole}-attempt-${application.attempts}`;
    const preservedPath = join(workDir, PRESERVED_DIRECTORY, preservedName);
    const occupied = pathOccupied(preservedPath);
    if (!met(!occupied, { preservedPath, occupied })) return unmetFromHere();

    return {
      preconditions,
      move: {
        runId,
        bootstrapOperationId: application.bootstrapOperationId,
        attempts: application.attempts,
        candidateSnapshotDigest: application.candidateSnapshotDigest,
        originalPath: checkoutPath,
        preservedPath,
        checkoutDevice: placed.value.checkoutDevice,
        checkoutInode: placed.value.checkoutInode,
        checkoutParentDevice: placed.value.checkoutParentDevice,
        checkoutParentInode: placed.value.checkoutParentInode,
        workDirDevice: placed.value.workDirDevice,
        workDirInode: placed.value.workDirInode,
      },
    };
  }

  /**
   * #246 C3, CEO decision (c) — the official recovery of an interrupted application's checkout. It
   * is verified again here, synchronously, and refused unless it is still exactly what the repair's
   * plan verified (`planned`). Then it is moved — never deleted — to
   * `<work dir>/preserved/<role>-attempt-<n>`, and only through held descriptors: the work directory,
   * the directory holding the checkout and the preservation directory are each opened no-follow and
   * required to be the very objects verified, by (dev, ino); the checkout is then required, through
   * its held parent and without following a symlink, to be the verified directory; and the rename
   * is made between the held descriptors with RENAME_EXCL, so it cannot be steered through a swapped
   * parent or symlink, and cannot land on anything already there. Any difference refuses before
   * anything moves. Nothing is restored and no other path is touched on any refusal.
   *
   * One window stays open, and is stated rather than hidden: between the identity check through
   * the held parent and the rename itself, another process of this account could replace the
   * checkout's entry inside the run's private work directory. macOS has no rename that is
   * conditional on the identity of what it moves, so no primitive here closes it; the identity is
   * read again through the held preservation directory right after, and a mismatch is refused and
   * left exactly where the rename put it.
   *
   * It authorises nothing. No approval is consumed or re-admitted, no attempt is recorded and no
   * phase moves: the application resumes only through a new CEO CONFIRM, which passes every check
   * again — the official receipt against the current write scope among them. A git lock file in the
   * checkout is never removed: it keeps the recovery refused until it is gone.
   */
  preserveInterruptedCheckout(
    runId: string | null,
    planned: InterruptedCheckoutPreservation | null = null,
  ): Decision<InterruptedCheckoutPreservation> {
    const refuse = (refusal: string, message: string, evidence: Evidence): Decision<InterruptedCheckoutPreservation> =>
      deny(ReasonCode.BOOTSTRAP_CHECKOUT_NOT_PRESERVED, message, { refusal, runId, ...evidence });
    const inspected = this.inspectInterruptedCheckout(runId);
    const move = inspected.move;
    if (move === null) {
      return refuse("PRECONDITION_UNMET", "the interrupted checkout's recovery preconditions do not hold; nothing is moved", {
        preconditions: inspected.preconditions,
      });
    }
    if (planned !== null && digestOf(planned) !== digestOf(move)) {
      return refuse("PLAN_CHANGED", "what is there now is not what the repair's plan verified; nothing is moved", {
        planned,
        current: move,
      });
    }
    const ensured = ensureDirectoryLevel(dirname(move.preservedPath));
    if (!ensured.allowed) {
      return refuse("PRESERVATION_LOCATION_UNSAFE", ensured.message, { ...move, ...ensured.evidence });
    }
    let files: RollbackFilesystem;
    try {
      files = RollbackFilesystem.load();
    } catch (error) {
      return refuse("ANCHOR_UNAVAILABLE", "the held-descriptor file operations are unavailable; nothing is moved", {
        ...move,
        error: (error as Error).message.slice(0, 300),
      });
    }
    try {
      const moved = this.anchoredMove(files, move);
      if (!moved.allowed) return refuse(String(moved.evidence["refusal"]), moved.message, { ...move, ...moved.evidence });
    } finally {
      files.dispose();
    }
    this.deps.applications.recordCheckoutPreserved(move);
    return allow(ReasonCode.OK, move);
  }

  /** The move itself, through held descriptors only; see `preserveInterruptedCheckout`. */
  private anchoredMove(files: RollbackFilesystem, move: InterruptedCheckoutPreservation): Decision<void> {
    const stop = (refusal: string, message: string, evidence: Evidence = {}): Decision<void> =>
      deny(ReasonCode.BOOTSTRAP_CHECKOUT_NOT_PRESERVED, message, { refusal, ...evidence });
    const is = (entry: { dev: bigint; ino: bigint } | null, dev: string, ino: string): boolean =>
      entry !== null && entry.dev === BigInt(dev) && entry.ino === BigInt(ino);
    const parentPath = dirname(move.originalPath);
    const workDir = dirname(parentPath);
    const parentName = basename(parentPath);
    const leafName = basename(move.originalPath);
    const preservedRootName = basename(dirname(move.preservedPath));
    const preservedName = basename(move.preservedPath);
    if (dirname(dirname(move.preservedPath)) !== workDir) {
      return stop("ANCHOR_MISMATCH", "the preservation location is not in the run's work directory; nothing is moved");
    }
    let work: ReturnType<RollbackFilesystem["openParent"]>;
    let parent: ReturnType<RollbackFilesystem["openParent"]>;
    let preserved: ReturnType<RollbackFilesystem["openParent"]>;
    let leaf: ReturnType<RollbackFilesystem["stat"]>;
    try {
      work = files.openParent(workDir);
      if (!is(work, move.workDirDevice, move.workDirInode)) {
        return stop("ANCHOR_MISMATCH", "the run's work directory is not the one that was verified; nothing is moved");
      }
      parent = files.openParent(parentPath);
      if (!is(parent, move.checkoutParentDevice, move.checkoutParentInode) || !is(files.stat(work, parentName), move.checkoutParentDevice, move.checkoutParentInode)) {
        return stop("ANCHOR_MISMATCH", "the directory holding the checkout is not the one that was verified; nothing is moved");
      }
      preserved = files.openParent(dirname(move.preservedPath));
      const preservedEntry = files.stat(work, preservedRootName);
      if (preservedEntry === null || preservedEntry.type !== "dir" || preservedEntry.dev !== preserved.dev || preservedEntry.ino !== preserved.ino) {
        return stop("ANCHOR_MISMATCH", "the preservation directory is not the one in the run's work directory; nothing is moved");
      }
      leaf = files.stat(parent, leafName);
      if (leaf === null || leaf.type !== "dir" || !is(leaf, move.checkoutDevice, move.checkoutInode)) {
        return stop("CHECKOUT_CHANGED", "the checkout is no longer the directory that was verified; nothing is moved", {
          found: leaf === null ? null : { type: leaf.type, dev: String(leaf.dev), ino: String(leaf.ino) },
        });
      }
      if (files.stat(preserved, preservedName) !== null) {
        return stop("PRESERVATION_TARGET_EXISTS", "the preservation location is already taken; nothing is moved");
      }
    } catch (error) {
      return stop("ANCHOR_FAILED", "a held descriptor could not be taken on a verified directory, without following a symlink; nothing is moved", {
        error: (error as Error).message.slice(0, 300),
        reason: isAcpError(error) ? error.evidence["reason"] ?? null : null,
      });
    }
    try {
      files.renameExclusive(parent, leafName, preserved, preservedName);
    } catch (error) {
      return stop("MOVE_FAILED", "the checkout could not be moved to its preservation location; it is left where it was", {
        error: (error as Error).message.slice(0, 300),
        errno: isAcpError(error) ? error.evidence["errno"] ?? null : null,
      });
    }
    let arrived: ReturnType<RollbackFilesystem["stat"]> = null;
    try {
      arrived = files.stat(preserved, preservedName);
    } catch {
      // Unreadable is not the verified directory; refused below, and nothing is restored.
    }
    if (arrived === null || arrived.type !== "dir" || !is(arrived, move.checkoutDevice, move.checkoutInode)) {
      return stop(
        "MOVED_OBJECT_MISMATCH",
        "what the rename moved is not the verified checkout: another process replaced it between the check and the rename; it is left where the rename put it, and no other path is touched",
        { arrived: arrived === null ? null : { type: arrived.type, dev: String(arrived.dev), ino: String(arrived.ino) } },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The checkout the application's reserved PLAN places, verified against the reservation by digest:
   * the PLAN artifact is the reserved one, the manifest is one an owner approval of this run carried
   * whose digest is the reserved one, and the planned outputs they give are the reserved ones. Then
   * the leaf itself: a real directory of this account, under a parent chain no other account can
   * write, whose marker names the application's bootstrap operation.
   */
  /**
   * #246 C3, CEO decision (b) as corrected twice — whether a cancelled run's reservation can be
   * released, asked without changing anything. Released only on positive proof that the application
   * had no external effect: no attempt in flight here and this process the only control-plane
   * writer; the attempt ledger — written and synced before every GitHub request is sent — showing
   * that none was ever sent; and the last attempt's own recorded outcome agreeing. A pending request
   * (sent, and its outcome never recorded), a ledger that cannot be read as this operation's, or an
   * attempt whose outcome was never recorded — a daemon that died mid-attempt — cannot be proven to
   * have had no effect: `inDoubt` says why, and nothing is released. GitHub is not read: that a
   * repository is absent now does not prove a request sent earlier will not land.
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

  /**
   * CEO decision (b): a release refused because no effect can be proven keeps the reservation, marked
   * so. The last attempt's own outcome is kept inside the mark (`attemptOutcome`), so a doubt that
   * later clears does not erase the record a later release needs.
   */
  recordReleaseInDoubt(runId: string, inDoubt: Record<string, unknown>): void {
    const last = this.deps.applications.get(runId)?.lastRefusal ?? null;
    const attemptOutcome = last?.["stage"] === "release" ? (last["attemptOutcome"] ?? null) : last;
    this.deps.applications.recordRefusal(runId, { stage: "release", refusal: "RELEASE_IN_DOUBT", ...inDoubt, attemptOutcome });
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
    if (!met(receipted.length === 0, { cause: receipted.length === 0 ? null : "WRITE_LANDED", ledgerPath, receipted })) {
      return unmet({ cause: "WRITE_LANDED", receipted });
    }
    const ledgerPresent = pathOccupied(ledgerPath);

    // The last attempt's own outcome: recorded by the attempt itself when it returned. An attempt
    // whose outcome was never recorded — its daemon died — proves nothing about what it sent.
    const last = application.lastRefusal;
    const outcome = (last?.["stage"] === "release" ? (last["attemptOutcome"] ?? null) : last) as Record<string, unknown> | null;
    const evidence = (outcome?.["evidence"] ?? null) as Record<string, unknown> | null;
    const listed = (key: string): unknown[] | null => {
      const value = evidence?.[key];
      return Array.isArray(value) ? value : null;
    };
    const recordedLedger = evidence?.["ledgerPath"];
    const ended =
      outcome !== null &&
      outcome["stage"] === "production" &&
      outcome["attempt"] === application.attempts &&
      (recordedLedger === undefined || recordedLedger === ledgerPath) &&
      (listed("pendingOperationIds") ?? []).length === 0 &&
      (listed("completedOperationIds") ?? []).length === 0;
    const lastAttemptOutcome = {
      attempt: application.attempts,
      refusal: typeof outcome?.["refusal"] === "string" ? outcome["refusal"] : typeof evidence?.["refusal"] === "string" ? evidence["refusal"] : null,
      reasonCode: typeof outcome?.["reasonCode"] === "string" ? outcome["reasonCode"] : null,
    };
    if (!ended) {
      return inDoubt("ATTEMPT_OUTCOME_UNRECORDED", {
        attempts: application.attempts,
        recorded: outcome === null ? null : { stage: outcome["stage"] ?? null, attempt: outcome["attempt"] ?? null },
      });
    }
    met(true, { lastAttemptOutcome });
    return allow(ReasonCode.OK, {
      runId: application.runId,
      projectId: application.projectId,
      repositoryIdentity: application.repositoryIdentity,
      bootstrapOperationId: application.bootstrapOperationId,
      attempts: application.attempts,
      approvalDigest: application.approvalDigest,
      ledgerPath,
      ledgerPresent,
      lastAttemptOutcome,
    });
  }

  /**
   * The planned outputs an application reserved, derived again from the run's PLAN artifact and the
   * manifest an owner approval of the run carried, and matched to the reservation by digest — the
   * PLAN, the manifest and the outputs — so a record's own claims decide nothing.
   */
  private reservedOutputs(application: BootstrapApplication, reasonCode: ReasonCode): Decision<PlannedBootstrapOutputs> {
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
    const manifest = this.deps.artifacts
      .list<unknown>(runId, ArtifactKind.APPROVAL)
      .map((artifact) => recordedApprovalSchema.safeParse(artifact.content))
      .flatMap((recorded) => (recorded.success ? [assertPortableManifest(recorded.data.approvedManifest)] : []))
      .flatMap((parsed) => (parsed.allowed ? [parsed.value] : []))
      .find((candidate) => manifestDigest(candidate) === application.manifestDigest);
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

  private placedCheckout(application: BootstrapApplication): Decision<PlacedCheckout> {
    const { runId } = application;
    const refuse = (refusal: string, message: string, evidence: Evidence = {}) =>
      deny(ReasonCode.BOOTSTRAP_CHECKOUT_NOT_PRESERVED, message, { refusal, runId, ...evidence }) as Decision<PlacedCheckout>;
    const workRoot = this.deps.workRoot;
    if (workRoot === null) return refuse("WORK_ROOT_UNCONFIGURED", "this deployment has no Repo Factory work root");
    if (!PATH_SAFE_RUN_ID.test(runId)) return refuse("RUN_ID_NOT_PATH_SAFE", "the run id cannot name a work directory");
    if (!pathOccupied(workRoot)) return refuse("WORK_ROOT_ABSENT", "the Repo Factory work root does not exist", { workRoot });
    try {
      ensurePrivateDirectory(workRoot);
    } catch (error) {
      if (!isAcpError(error)) throw error;
      return refuse("WORK_ROOT_INSECURE", error.message, error.evidence);
    }
    const reserved = this.reservedOutputs(application, ReasonCode.BOOTSTRAP_CHECKOUT_NOT_PRESERVED);
    if (!reserved.allowed) return reserved as Decision<PlacedCheckout>;
    const outputs = reserved.value;
    const workDir = join(workRoot, runId);
    const checkoutPath = repositoryCheckoutPath(workDir, outputs.target.repositoryRole);
    let leaf;
    let parentOf;
    let work;
    try {
      leaf = lstatSync(checkoutPath, { bigint: true });
      parentOf = lstatSync(dirname(checkoutPath), { bigint: true });
      work = lstatSync(workDir, { bigint: true });
    } catch (error) {
      return refuse(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "CHECKOUT_ABSENT" : "CHECKOUT_UNREADABLE",
        "there is no readable checkout of this application to preserve",
        { checkoutPath },
      );
    }
    if (!leaf.isDirectory()) return refuse("CHECKOUT_NOT_A_DIRECTORY", "the checkout leaf is not a directory", { checkoutPath });
    if (typeof process.getuid !== "function" || leaf.uid !== BigInt(process.getuid())) {
      return refuse("CHECKOUT_FOREIGN_OWNER", "the checkout is not this account's", { checkoutPath, uid: String(leaf.uid) });
    }
    const chain = assertParentChainNotAttackerWritable(workDir, checkoutPath);
    if (!chain.allowed) return refuse("CHECKOUT_PARENT_UNSAFE", chain.message, { checkoutPath, ...chain.evidence });
    const marker = checkoutMarkerOf(checkoutPath);
    if (marker !== application.bootstrapOperationId) {
      return refuse("CHECKOUT_NOT_THIS_APPLICATION", "the checkout's marker does not name this application's bootstrap operation", {
        checkoutPath,
        marker,
        bootstrapOperationId: application.bootstrapOperationId,
      });
    }
    if (!parentOf.isDirectory() || !work.isDirectory()) {
      return refuse("CHECKOUT_PARENT_UNSAFE", "the checkout's parent or the work directory is not a directory", { checkoutPath });
    }
    return allow(ReasonCode.OK, {
      workDir,
      checkoutPath,
      repositoryRole: outputs.target.repositoryRole,
      checkoutDevice: String(leaf.dev),
      checkoutInode: String(leaf.ino),
      checkoutParentDevice: String(parentOf.dev),
      checkoutParentInode: String(parentOf.ino),
      workDirDevice: String(work.dev),
      workDirInode: String(work.ino),
    });
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
