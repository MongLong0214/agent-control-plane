import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { canonicalJson, digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git, tryRevParse } from "../git/git.ts";
import {
  parseGitHubIdentity,
  sameGitHubName,
  type BranchProtectionState,
  type GitHubRepositoryTarget,
  type GitHubVisibility,
  type GitHubWritePort,
  type ObservedRepository,
} from "./github-write-port.ts";
import type { ExternalWriteReceipt } from "./repo-factory-result.ts";

/**
 * Issue #246 — the repo factory producer's GitHub half: which planned operations may run, in
 * what order, how each is judged after it runs, and what is left behind when one fails.
 *
 * Receipts are GitHub's answers, never the plan's. Every receipt below is built from a read
 * taken *after* the write (`observe*`), and the result contract's `afterStateDigest` is the
 * digest of exactly that read. The one field copied from the plan is `resourceIdentity`, and
 * only because activation matches receipts to planned operations by it; the readback is what
 * establishes that the identity is true — a repository whose `full_name` is not the planned
 * one is refused, not receipted. A receipt that restated the plan would verify that the plan
 * agrees with itself, which `verified: true` must never mean (Integration §16.2).
 *
 * Partial failure: no rollback. Every write that succeeded before the failure is in the
 * ledger with its readback, the failure is reported with exactly those receipts, and a retry
 * resumes from the ledger. Rolling back was rejected on three grounds: deleting a repository
 * needs a broader credential (`delete_repo`) than creating one, so the rollback would hold
 * more authority than the operation it undoes; a public repository is observable — cloned,
 * indexed, forked — the moment it exists, so deleting it does not restore the prior state, it
 * adds a second fact; and a rollback can itself fail halfway, leaving a state no receipt
 * describes. Integration §16.4 says the same thing from the other side: report what finished,
 * what failed and where to resume, and never claim an atomicity that was not had.
 *
 * Resume is by node id, not by name. A same-named repository is ours only if the ledger
 * holds a receipt for this operation whose recorded node id equals the one GitHub reports
 * now. Absent a receipt it is someone else's (`WRONG_TARGET`), and with a receipt whose node
 * id differs the name was reused (`WRONG_TARGET` again) — either way nothing is written.
 *
 * This file avoids `&&`/`||` on purpose: every refusal is its own branch with its own
 * evidence, so a reader — and `verify-refusal-operands-are-watched.mjs` — sees one decision
 * per condition rather than a chain whose failing link the evidence cannot name.
 */

export const GITHUB_LEDGER_SCHEMA_ID = "acp.repo-factory.github-ledger.v1";

const branchProtectionStateSchema = z
  .object({
    requiredStatusChecks: z.array(z.string().min(1)),
    enforceAdmins: z.boolean(),
    requiredApprovingReviewCount: z.number().int().min(0).max(6).nullable(),
    allowForcePushes: z.boolean(),
    allowDeletions: z.boolean(),
  })
  .strict();

const operationIdentity = {
  operationId: z.string().min(1),
  resourceIdentity: z.string().min(1),
};

/**
 * The operations this producer can perform *and verify*. A resource type outside this union
 * fails the plan schema before anything runs: an operation nobody implements is not a plan
 * that ran, and receipting it would be a fabricated write.
 */
export const githubOperationSchema = z.discriminatedUnion("resourceType", [
  z
    .object({
      ...operationIdentity,
      resourceType: z.literal("repository"),
      desiredState: z.object({ visibility: z.enum(["public", "private"]) }).strict(),
    })
    .strict(),
  /** Pushes the bootstrap commit this producer made to `<identity>#<defaultBranch>`. */
  z.object({ ...operationIdentity, resourceType: z.literal("branch") }).strict(),
  /** `<identity>#default-branch` — the repository's default branch setting. */
  z
    .object({
      ...operationIdentity,
      resourceType: z.literal("setting"),
      desiredState: z.object({ defaultBranch: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      ...operationIdentity,
      resourceType: z.literal("branch-protection"),
      desiredState: branchProtectionStateSchema,
    })
    .strict(),
]);

export type GitHubOperation = z.infer<typeof githubOperationSchema>;

/**
 * What the owner approved, supplied by the caller rather than read from the plan. A plan that
 * asserted its own approval would be indistinguishable from one that approved itself.
 * `approvedOperations` is the approved PLAN artifact's own `githubOperations` — the exact
 * triples `BootstrapActivation` later matches receipts against — so the producer refuses to
 * perform anything activation would refuse to accept.
 */
export const githubWriteAuthoritySchema = z
  .object({
    owner: z.string().min(1),
    visibility: z.enum(["public", "private"]),
    approvedOperations: z.array(
      z
        .object({
          operationId: z.string().min(1),
          resourceType: z.string().min(1),
          resourceIdentity: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type GitHubWriteAuthority = z.infer<typeof githubWriteAuthoritySchema>;

export interface GitHubExecutionPlan {
  target: GitHubRepositoryTarget;
  /** `github:<owner>/<name>` exactly as planned — the identity activation matches on. */
  repositoryIdentity: string;
  visibility: GitHubVisibility;
  operations: GitHubOperation[];
  pushOperationId: string;
}

const refuse = <T>(reasonCode: ReasonCode, refusal: string, message: string, evidence: Evidence = {}): Decision<T> =>
  deny(reasonCode, message, { refusal, ...evidence });

/**
 * Every check that needs no GitHub call, run before the first one. A refusal here has made no
 * read and no write, local or remote.
 */
export const preflightGitHubOperations = (
  plan: { defaultBranch: string; githubOperations: readonly GitHubOperation[] },
  authorityInput: unknown,
): Decision<GitHubExecutionPlan> => {
  const parsedAuthority = githubWriteAuthoritySchema.safeParse(authorityInput);
  if (!parsedAuthority.success) {
    return deny(ReasonCode.INVALID_ARGUMENT, "GitHub write authority failed validation", {
      issues: parsedAuthority.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const authority = parsedAuthority.data;
  const operations = [...plan.githubOperations];

  const operationIds = new Set<string>();
  const resources = new Set<string>();
  for (const operation of operations) {
    const resource = `${operation.resourceType} ${operation.resourceIdentity}`;
    if (operationIds.has(operation.operationId)) {
      return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "DUPLICATE_OPERATION", "the plan names one operation id twice", {
        operationId: operation.operationId,
      });
    }
    if (resources.has(resource)) {
      return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "DUPLICATE_OPERATION", "the plan writes one resource twice", {
        operationId: operation.operationId,
        resource,
      });
    }
    operationIds.add(operation.operationId);
    resources.add(resource);
  }

  // Both directions. An operation the approval does not cover is a write nobody approved; an
  // approved operation the plan never performs leaves activation a planned operation with no
  // receipt (`COVERAGE_INCOMPLETE`), so refusing it here costs nothing that was not lost anyway.
  const approvedIds = new Set<string>();
  for (const approved of authority.approvedOperations) {
    if (approvedIds.has(approved.operationId)) {
      return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "DUPLICATE_OPERATION", "the approval names one operation id twice", {
        operationId: approved.operationId,
      });
    }
    approvedIds.add(approved.operationId);
  }
  for (const operation of operations) {
    const approved = authority.approvedOperations.find((candidate) => candidate.operationId === operation.operationId);
    const notInPlan = (detail: string): Decision<GitHubExecutionPlan> =>
      refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "OPERATION_NOT_IN_PLAN",
        `${operation.operationId} is not an operation of the approved plan: ${detail}`,
        { operationId: operation.operationId, planned: operation.resourceType + " " + operation.resourceIdentity },
      );
    if (approved === undefined) return notInPlan("no approved operation has this id");
    if (approved.resourceType !== operation.resourceType) return notInPlan(`approved as ${approved.resourceType}`);
    if (approved.resourceIdentity !== operation.resourceIdentity) {
      return notInPlan(`approved for ${approved.resourceIdentity}`);
    }
  }
  for (const approved of authority.approvedOperations) {
    if (!operationIds.has(approved.operationId)) {
      return refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "APPROVED_OPERATION_NOT_PLANNED",
        `${approved.operationId} is approved and the plan would never perform it`,
        { operationId: approved.operationId },
      );
    }
  }

  const shape = (message: string, evidence: Evidence = {}): Decision<GitHubExecutionPlan> =>
    refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "UNSUPPORTED_PLAN_SHAPE", message, evidence);

  const first = operations[0];
  if (first === undefined) return shape("a GitHub plan with no operation has nothing to perform");
  if (first.resourceType !== "repository") {
    return shape("the first GitHub operation must create the repository every later operation targets", {
      operationId: first.operationId,
    });
  }
  const repository = parseGitHubIdentity(first.resourceIdentity);
  if (repository === null) {
    return shape("the repository identity is not github:<owner>/<name>", { resourceIdentity: first.resourceIdentity });
  }
  if (repository.ref !== null) {
    return shape("the repository identity names a ref", { resourceIdentity: first.resourceIdentity });
  }
  const ownerMismatch = (operationId: string, plannedOwner: string): Decision<GitHubExecutionPlan> =>
    refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "OWNER_MISMATCH",
      `${operationId} targets owner ${plannedOwner}, and the approval covers ${authority.owner}`,
      { operationId, plannedOwner, approvedOwner: authority.owner },
    );
  if (!sameGitHubName(repository.owner, authority.owner)) return ownerMismatch(first.operationId, repository.owner);
  if (first.desiredState.visibility !== authority.visibility) {
    return refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "VISIBILITY_MISMATCH",
      `the plan would create a ${first.desiredState.visibility} repository, and the approval covers ${authority.visibility}`,
      { operationId: first.operationId, planned: first.desiredState.visibility, approved: authority.visibility },
    );
  }

  let pushIndex = -1;
  let pushOperationId: string | null = null;
  for (const [index, operation] of operations.entries()) {
    if (index === 0) continue;
    const parsed = parseGitHubIdentity(operation.resourceIdentity);
    if (parsed === null) {
      return shape("an operation identity is not github:<owner>/<name>#<ref>", { operationId: operation.operationId });
    }
    if (!sameGitHubName(parsed.owner, authority.owner)) return ownerMismatch(operation.operationId, parsed.owner);
    if (`github:${parsed.owner}/${parsed.name}` !== first.resourceIdentity) {
      return refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "REPOSITORY_MISMATCH",
        `${operation.operationId} targets a repository other than the one this plan creates`,
        { operationId: operation.operationId, repository: first.resourceIdentity },
      );
    }
    if (operation.resourceType === "repository") {
      return shape("a plan creates exactly one repository", { operationId: operation.operationId });
    }
    if (operation.resourceType === "branch") {
      if (pushOperationId !== null) {
        return shape("a plan pushes the bootstrap commit once", { operationId: operation.operationId });
      }
      if (parsed.ref !== plan.defaultBranch) {
        return shape("the bootstrap commit is pushed to the plan's default branch only", {
          operationId: operation.operationId,
          ref: parsed.ref,
          defaultBranch: plan.defaultBranch,
        });
      }
      pushIndex = index;
      pushOperationId = operation.operationId;
      continue;
    }
    if (operation.resourceType === "setting") {
      if (parsed.ref !== "default-branch") {
        return shape("the only setting this producer writes is default-branch", { operationId: operation.operationId });
      }
      if (operation.desiredState.defaultBranch !== plan.defaultBranch) {
        return shape("the default-branch setting must name the plan's default branch", {
          operationId: operation.operationId,
        });
      }
      if (pushIndex === -1) {
        return shape("a default branch can only be set after the branch exists", { operationId: operation.operationId });
      }
      continue;
    }
    // branch-protection — the last member of the union.
    if (parsed.ref !== plan.defaultBranch) {
      return shape("branch protection is applied to the plan's default branch only", {
        operationId: operation.operationId,
      });
    }
    if (pushIndex === -1) {
      return shape("a branch can only be protected after it exists", { operationId: operation.operationId });
    }
  }
  // A repository with no pushed commit would make the result report a verified exact head in
  // `github:<owner>/<name>` that GitHub does not have.
  if (pushOperationId === null) {
    return shape("a GitHub-provisioned repository must receive the bootstrap commit", {
      repository: first.resourceIdentity,
    });
  }

  return allow(ReasonCode.OK, {
    target: { owner: repository.owner, name: repository.name },
    repositoryIdentity: first.resourceIdentity,
    visibility: authority.visibility,
    operations,
    pushOperationId,
  });
};

const receiptCommon = {
  operationId: z.string().min(1),
  resourceIdentity: z.string().min(1),
  /** The repository's node id when this receipt was last verified — what resume compares. */
  repositoryNodeId: z.string().min(1),
  preexisting: z.boolean(),
  beforeStateDigest: z.string().nullable(),
  createdAt: z.string().min(1),
  rereadAt: z.string().min(1),
};

/** A receipt in the ledger: the readback GitHub gave, in full, not a digest of it. */
export const githubOperationReceiptSchema = z.discriminatedUnion("resourceType", [
  z
    .object({
      ...receiptCommon,
      resourceType: z.literal("repository"),
      observed: z
        .object({ nodeId: z.string().min(1), fullName: z.string().min(1), visibility: z.string().min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...receiptCommon,
      resourceType: z.literal("branch"),
      observed: z.object({ name: z.string().min(1), headSha: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      ...receiptCommon,
      resourceType: z.literal("setting"),
      observed: z.object({ defaultBranch: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({ ...receiptCommon, resourceType: z.literal("branch-protection"), observed: branchProtectionStateSchema })
    .strict(),
]);

export type GitHubOperationReceipt = z.infer<typeof githubOperationReceiptSchema>;

const ledgerSchema = z
  .object({
    schema: z.literal(GITHUB_LEDGER_SCHEMA_ID),
    bootstrapOperationId: z.string().min(1),
    requestDigest: z.string().min(1),
    receipts: z.array(githubOperationReceiptSchema),
  })
  .strict();

export type GitHubLedger = z.infer<typeof ledgerSchema>;

export interface LedgerOwner {
  bootstrapOperationId: string;
  requestDigest: string;
}

/**
 * Beside the checkout, never inside it. The checkout is disposable — a failed run removes it
 * so the same operation can retry — and the ledger is the one thing a retry must find.
 */
export const githubLedgerPath = (workDir: string, repositoryRole: string): string =>
  join(resolve(workDir), "github-ledger", `${repositoryRole}.json`);

const unsafeLedger = (path: string, message: string): Decision<Map<string, GitHubOperationReceipt>> =>
  refuse(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "LEDGER_UNSAFE", message, { ledgerPath: path });

const corruptLedger = (path: string, message: string, evidence: Evidence = {}): Decision<Map<string, GitHubOperationReceipt>> =>
  refuse(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "LEDGER_CORRUPT", message, { ledgerPath: path, ...evidence });

/**
 * Reads the receipts a previous attempt left. Absent is empty; anything else that cannot be
 * proven to be this operation's own record is a refusal, because resuming from it would treat
 * someone else's writes — or a forged line — as ours.
 */
export const readGitHubLedger = (
  path: string,
  owner: LedgerOwner,
  operations: readonly GitHubOperation[],
): Decision<Map<string, GitHubOperationReceipt>> => {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return allow(ReasonCode.OK, new Map());
    return corruptLedger(path, "the GitHub receipt ledger could not be inspected", { message: (error as Error).message });
  }
  if (stat.isSymbolicLink()) return unsafeLedger(path, "the GitHub receipt ledger is a symlink");
  if (!stat.isFile()) return unsafeLedger(path, "the GitHub receipt ledger is not a regular file");
  if (typeof process.getuid !== "function") {
    return unsafeLedger(path, "ownership verification is not supported on this platform");
  }
  if (stat.uid !== process.getuid()) return unsafeLedger(path, "the GitHub receipt ledger is owned by another account");
  if ((stat.mode & 0o022) !== 0) return unsafeLedger(path, "the GitHub receipt ledger is writable by another user or group");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return corruptLedger(path, "the GitHub receipt ledger is not readable JSON", { message: (error as Error).message });
  }
  const parsed = ledgerSchema.safeParse(raw);
  if (!parsed.success) {
    return corruptLedger(path, "the GitHub receipt ledger failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const ledger = parsed.data;
  const foreign = (field: string): Decision<Map<string, GitHubOperationReceipt>> =>
    refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "LEDGER_FOREIGN",
      `the GitHub receipt ledger belongs to a different ${field}; resuming from it would adopt another operation's writes`,
      { ledgerPath: path, field },
    );
  if (ledger.bootstrapOperationId !== owner.bootstrapOperationId) return foreign("bootstrap operation");
  if (ledger.requestDigest !== owner.requestDigest) return foreign("request");

  const receipts = new Map<string, GitHubOperationReceipt>();
  for (const receipt of ledger.receipts) {
    if (receipts.has(receipt.operationId)) {
      return corruptLedger(path, "the GitHub receipt ledger holds two receipts for one operation", {
        operationId: receipt.operationId,
      });
    }
    const planned = operations.find((operation) => operation.operationId === receipt.operationId);
    const notInPlan = (): Decision<Map<string, GitHubOperationReceipt>> =>
      refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "OPERATION_NOT_IN_PLAN",
        `the GitHub receipt ledger receipts ${receipt.operationId}, which this plan does not contain as written`,
        { ledgerPath: path, operationId: receipt.operationId },
      );
    if (planned === undefined) return notInPlan();
    if (planned.resourceType !== receipt.resourceType) return notInPlan();
    if (planned.resourceIdentity !== receipt.resourceIdentity) return notInPlan();
    receipts.set(receipt.operationId, receipt);
  }
  return allow(ReasonCode.OK, receipts);
};

/**
 * Atomic and durable: write a scratch file, fsync it, rename it over the ledger, fsync the
 * directory. A crash mid-write leaves the previous ledger whole, so the resume point the
 * ledger exists to keep is never the thing a crash destroys.
 */
export const writeGitHubLedger = (path: string, ledger: GitHubLedger): void => {
  const scratch = `${path}.partial`;
  const descriptor = openSync(scratch, "w", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(ledger, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(scratch, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

/** The result contract's view of a ledger receipt: identity fields plus the readback's digest. */
export const toExternalWriteReceipt = (receipt: GitHubOperationReceipt, owner: LedgerOwner): ExternalWriteReceipt => ({
  bootstrapOperationId: owner.bootstrapOperationId,
  requestDigest: owner.requestDigest,
  operationId: receipt.operationId,
  resourceType: receipt.resourceType,
  resourceIdentity: receipt.resourceIdentity,
  preexisting: receipt.preexisting,
  beforeStateDigest: receipt.beforeStateDigest,
  afterStateDigest: digestOf(receipt.observed),
  createdAt: receipt.createdAt,
  rereadAt: receipt.rereadAt,
  verified: true,
});

export interface ApplyGitHubOperationsInput {
  execution: GitHubExecutionPlan;
  port: GitHubWritePort;
  checkoutPath: string;
  defaultBranch: string;
  prior: ReadonlyMap<string, GitHubOperationReceipt>;
  /** Persists the full receipt set; called after every verified write, before the next one. */
  record: (receipts: readonly GitHubOperationReceipt[]) => void;
  ledgerPath: string;
  clock: Clock;
}

export interface AppliedGitHubOperations {
  /** This attempt's receipts, in plan order — written now or resumed from the ledger. */
  receipts: GitHubOperationReceipt[];
  written: string[];
  resumed: string[];
}

type Step = { receipt: GitHubOperationReceipt; wrote: boolean };

const sortedProtection = (state: BranchProtectionState): BranchProtectionState => ({
  requiredStatusChecks: [...state.requiredStatusChecks].sort(),
  enforceAdmins: state.enforceAdmins,
  requiredApprovingReviewCount: state.requiredApprovingReviewCount,
  allowForcePushes: state.allowForcePushes,
  allowDeletions: state.allowDeletions,
});

const sameProtection = (left: BranchProtectionState, right: BranchProtectionState): boolean =>
  canonicalJson(sortedProtection(left)) === canonicalJson(sortedProtection(right));

const describeFailure = (error: unknown): Evidence => {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  if (!isAcpError(error)) return { message };
  const status = (error.evidence as { status?: unknown }).status;
  return typeof status === "number" ? { message, status } : { message };
};

export const applyGitHubOperations = async (
  input: ApplyGitHubOperationsInput,
): Promise<Decision<AppliedGitHubOperations>> => {
  const { execution, port, clock } = input;
  const target = execution.target;
  const ledger = new Map(input.prior);
  const completed: GitHubOperationReceipt[] = [];
  const written: string[] = [];
  const resumed: string[] = [];
  let repositoryNodeId: string | null = null;

  /**
   * Every failure stops here, carrying exactly what this attempt completed. `resumable` says
   * whether retrying the same operation can make progress without a person: a remote that
   * refused or did not answer can be retried; a wrong target or a drifted resource cannot.
   */
  const stop = <T>(
    reasonCode: ReasonCode,
    refusal: string,
    message: string,
    failedOperationId: string | null,
    evidence: Evidence,
    resumable: boolean,
  ): Decision<T> =>
    deny(reasonCode, message, {
      refusal,
      failedOperationId,
      completedOperationIds: completed.map((receipt) => receipt.operationId),
      completedReceipts: [...completed],
      ledgerPath: input.ledgerPath,
      rollback: "none",
      resumable,
      ...evidence,
    });

  const remote = async <T>(operationId: string | null, call: () => Promise<T>): Promise<Decision<T>> => {
    try {
      return allow(ReasonCode.OK, await call());
    } catch (error) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REMOTE_REFUSED",
        `${operationId ?? "the final readback"} was refused by GitHub or did not answer`,
        operationId,
        { remote: describeFailure(error) },
        true,
      );
    }
  };

  const readbackOf = (observed: ObservedRepository) => ({
    nodeId: observed.nodeId,
    fullName: observed.fullName,
    visibility: observed.visibility,
  });

  /** The repository GitHub reports must be the planned one, at the approved visibility. */
  const judgeRepository = (observed: ObservedRepository, operationId: string | null): Decision<void> => {
    if (!sameGitHubName(observed.fullName, `${target.owner}/${target.name}`)) {
      return stop(
        ReasonCode.RESOURCE_COLLISION,
        "WRONG_TARGET",
        `GitHub reports ${observed.fullName}, and the plan targets ${target.owner}/${target.name}`,
        operationId,
        { observed: readbackOf(observed) },
        false,
      );
    }
    if (observed.visibility !== execution.visibility) {
      return stop(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "VISIBILITY_MISMATCH",
        `GitHub reports ${observed.fullName} as ${observed.visibility}, and the approval covers ${execution.visibility}`,
        operationId,
        { observed: readbackOf(observed) },
        false,
      );
    }
    return allow(ReasonCode.OK, undefined);
  };

  /** Before any later operation: the repository at this name is still the one we receipted. */
  const confirmRepository = async (operationId: string | null): Promise<Decision<ObservedRepository>> => {
    const observed = await remote(operationId, () => port.observeRepository(target));
    if (!observed.allowed) return observed;
    if (observed.value === null) {
      return stop(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "RESUMED_RESOURCE_ABSENT",
        `${target.owner}/${target.name} has a verified receipt and is absent from GitHub`,
        operationId,
        { recordedNodeId: repositoryNodeId },
        false,
      );
    }
    if (observed.value.nodeId !== repositoryNodeId) {
      return stop(
        ReasonCode.RESOURCE_COLLISION,
        "WRONG_TARGET",
        `${target.owner}/${target.name} is not the repository this operation created; the name was reused`,
        operationId,
        { recordedNodeId: repositoryNodeId, observedNodeId: observed.value.nodeId },
        false,
      );
    }
    const judged = judgeRepository(observed.value, operationId);
    if (!judged.allowed) return judged as Decision<ObservedRepository>;
    return allow(ReasonCode.OK, observed.value);
  };

  const corruptPrior = (operationId: string): Decision<Step> =>
    stop(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "LEDGER_CORRUPT",
      `the ledger's receipt for ${operationId} is not of the planned resource type`,
      operationId,
      {},
      false,
    );

  const repositoryStep = async (operation: Extract<GitHubOperation, { resourceType: "repository" }>): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const prior = input.prior.get(id);
    const observed = await remote(id, () => port.observeRepository(target));
    if (!observed.allowed) return observed as Decision<Step>;
    if (prior !== undefined) {
      if (prior.resourceType !== "repository") return corruptPrior(id);
      if (observed.value === null) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_ABSENT",
          `${target.owner}/${target.name} has a verified receipt and is absent from GitHub; it is not recreated under a name that was ours`,
          id,
          { recordedNodeId: prior.observed.nodeId },
          false,
        );
      }
      if (observed.value.nodeId !== prior.observed.nodeId) {
        return stop(
          ReasonCode.RESOURCE_COLLISION,
          "WRONG_TARGET",
          `${target.owner}/${target.name} exists but is not the repository this operation created; the name was reused`,
          id,
          { recordedNodeId: prior.observed.nodeId, observedNodeId: observed.value.nodeId },
          false,
        );
      }
      const judged = judgeRepository(observed.value, id);
      if (!judged.allowed) return judged as Decision<Step>;
      return allow(ReasonCode.OK, {
        receipt: { ...prior, observed: readbackOf(observed.value), rereadAt: clock.nowIso() },
        wrote: false,
      });
    }
    if (observed.value !== null) {
      return stop(
        ReasonCode.RESOURCE_COLLISION,
        "WRONG_TARGET",
        `${target.owner}/${target.name} already exists and carries no receipt from this bootstrap operation; it is not adopted, overwritten or renamed`,
        id,
        { observedNodeId: observed.value.nodeId, observed: readbackOf(observed.value) },
        false,
      );
    }
    const createdAt = clock.nowIso();
    const created = await remote(id, () => port.createRepository(target, execution.visibility));
    if (!created.allowed) return created as Decision<Step>;
    const createdJudged = judgeRepository(created.value, id);
    if (!createdJudged.allowed) return createdJudged as Decision<Step>;
    const reread = await remote(id, () => port.observeRepository(target));
    if (!reread.allowed) return reread as Decision<Step>;
    if (reread.value === null) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REREAD_MISMATCH",
        `${target.owner}/${target.name} is absent when re-read after a create GitHub accepted`,
        id,
        { created: readbackOf(created.value) },
        false,
      );
    }
    if (reread.value.nodeId !== created.value.nodeId) {
      return stop(
        ReasonCode.RESOURCE_COLLISION,
        "WRONG_TARGET",
        "the repository re-read after the create is not the one the create returned",
        id,
        { createdNodeId: created.value.nodeId, observedNodeId: reread.value.nodeId },
        false,
      );
    }
    const rereadJudged = judgeRepository(reread.value, id);
    if (!rereadJudged.allowed) return rereadJudged as Decision<Step>;
    return allow(ReasonCode.OK, {
      receipt: {
        operationId: id,
        resourceType: "repository",
        resourceIdentity: operation.resourceIdentity,
        repositoryNodeId: reread.value.nodeId,
        preexisting: false,
        beforeStateDigest: null,
        observed: readbackOf(reread.value),
        createdAt,
        rereadAt: clock.nowIso(),
      },
      wrote: true,
    });
  };

  const branchStep = async (operation: Extract<GitHubOperation, { resourceType: "branch" }>): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const branch = input.defaultBranch;
    const repository = await confirmRepository(id);
    if (!repository.allowed) return repository as Decision<Step>;
    const prior = input.prior.get(id);
    const observed = await remote(id, () => port.observeBranch(target, branch));
    if (!observed.allowed) return observed as Decision<Step>;
    const localFailure = (message: string, evidence: Evidence): Decision<Step> =>
      stop(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "LOCAL_CHECKOUT_FAILED", message, id, evidence, true);
    if (prior !== undefined) {
      if (prior.resourceType !== "branch") return corruptPrior(id);
      if (observed.value === null) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_ABSENT",
          `${branch} has a verified push receipt and is absent from GitHub`,
          id,
          { recordedHead: prior.observed.headSha },
          false,
        );
      }
      if (observed.value.headSha !== prior.observed.headSha) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_DRIFTED",
          `${branch} has moved since this operation pushed it`,
          id,
          { recordedHead: prior.observed.headSha, observedHead: observed.value.headSha },
          false,
        );
      }
      // The checkout is fresh on every attempt; the commit GitHub already holds is brought into
      // it rather than recommitted, so the head this run verifies is the head GitHub has.
      const fetched = await remote(id, () => port.fetchBranch(target, branch, input.checkoutPath));
      if (!fetched.allowed) return fetched as Decision<Step>;
      const reset = await git(input.checkoutPath, ["reset", "-q", "--hard", prior.observed.headSha], {
        allowFailure: true,
      });
      if (reset.exitCode !== 0) {
        return localFailure("the pushed commit could not be checked out locally", { stderr: reset.stderr });
      }
      const head = await tryRevParse(input.checkoutPath, "HEAD");
      if (head !== prior.observed.headSha) {
        return localFailure("the local checkout is not at the pushed commit after resume", {
          head,
          pushed: prior.observed.headSha,
        });
      }
      return allow(ReasonCode.OK, {
        receipt: {
          ...prior,
          repositoryNodeId: repository.value.nodeId,
          observed: { name: observed.value.name, headSha: observed.value.headSha },
          rereadAt: clock.nowIso(),
        },
        wrote: false,
      });
    }
    if (observed.value !== null) {
      return stop(
        ReasonCode.RESOURCE_COLLISION,
        "UNRECEIPTED_RESOURCE",
        `${branch} already exists on ${target.owner}/${target.name} and carries no receipt from this bootstrap operation`,
        id,
        { observedHead: observed.value.headSha },
        false,
      );
    }
    const localHead = await tryRevParse(input.checkoutPath, "HEAD");
    if (localHead === null) return localFailure("the local checkout has no commit to push", {});
    const createdAt = clock.nowIso();
    const pushed = await remote(id, () => port.pushBranch(target, branch, input.checkoutPath, localHead));
    if (!pushed.allowed) return pushed as Decision<Step>;
    const reread = await remote(id, () => port.observeBranch(target, branch));
    if (!reread.allowed) return reread as Decision<Step>;
    if (reread.value === null) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REREAD_MISMATCH",
        `${branch} is absent when re-read after a push git accepted`,
        id,
        { pushed: localHead },
        true,
      );
    }
    if (reread.value.headSha !== localHead) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REREAD_MISMATCH",
        `GitHub reports ${branch} at a different commit than the one pushed`,
        id,
        { pushed: localHead, observedHead: reread.value.headSha },
        false,
      );
    }
    return allow(ReasonCode.OK, {
      receipt: {
        operationId: id,
        resourceType: "branch",
        resourceIdentity: operation.resourceIdentity,
        repositoryNodeId: repository.value.nodeId,
        preexisting: false,
        beforeStateDigest: null,
        observed: { name: reread.value.name, headSha: reread.value.headSha },
        createdAt,
        rereadAt: clock.nowIso(),
      },
      wrote: true,
    });
  };

  const settingStep = async (operation: Extract<GitHubOperation, { resourceType: "setting" }>): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const desired = operation.desiredState.defaultBranch;
    const repository = await confirmRepository(id);
    if (!repository.allowed) return repository as Decision<Step>;
    const prior = input.prior.get(id);
    if (prior !== undefined) {
      if (prior.resourceType !== "setting") return corruptPrior(id);
      if (repository.value.defaultBranch !== desired) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_DRIFTED",
          `the default branch is no longer ${desired}`,
          id,
          { observed: repository.value.defaultBranch },
          false,
        );
      }
      return allow(ReasonCode.OK, {
        receipt: { ...prior, observed: { defaultBranch: desired }, rereadAt: clock.nowIso() },
        wrote: false,
      });
    }
    const before = { defaultBranch: repository.value.defaultBranch };
    const createdAt = clock.nowIso();
    const set = await remote(id, () => port.setDefaultBranch(target, desired));
    if (!set.allowed) return set as Decision<Step>;
    const reread = await confirmRepository(id);
    if (!reread.allowed) return reread as Decision<Step>;
    const observedDefault = reread.value.defaultBranch;
    if (observedDefault !== desired) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REREAD_MISMATCH",
        `GitHub reports the default branch as ${observedDefault ?? "unset"} after setting it to ${desired}`,
        id,
        { requested: desired, observed: observedDefault },
        false,
      );
    }
    return allow(ReasonCode.OK, {
      receipt: {
        operationId: id,
        resourceType: "setting",
        resourceIdentity: operation.resourceIdentity,
        repositoryNodeId: reread.value.nodeId,
        preexisting: true,
        beforeStateDigest: digestOf(before),
        observed: { defaultBranch: observedDefault },
        createdAt,
        rereadAt: clock.nowIso(),
      },
      wrote: true,
    });
  };

  const protectionStep = async (
    operation: Extract<GitHubOperation, { resourceType: "branch-protection" }>,
  ): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const branch = input.defaultBranch;
    const desired = operation.desiredState;
    const repository = await confirmRepository(id);
    if (!repository.allowed) return repository as Decision<Step>;
    const prior = input.prior.get(id);
    const current = await remote(id, () => port.observeBranchProtection(target, branch));
    if (!current.allowed) return current as Decision<Step>;
    if (prior !== undefined) {
      if (prior.resourceType !== "branch-protection") return corruptPrior(id);
      if (current.value === null) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_ABSENT",
          `${branch} has a verified protection receipt and is unprotected on GitHub`,
          id,
          {},
          false,
        );
      }
      if (!sameProtection(current.value, desired)) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_DRIFTED",
          `${branch}'s protection is no longer the approved one`,
          id,
          { requested: sortedProtection(desired), observed: sortedProtection(current.value) },
          false,
        );
      }
      return allow(ReasonCode.OK, {
        receipt: { ...prior, observed: sortedProtection(current.value), rereadAt: clock.nowIso() },
        wrote: false,
      });
    }
    const before = current.value;
    const createdAt = clock.nowIso();
    const protectedNow = await remote(id, () => port.protectBranch(target, branch, desired));
    if (!protectedNow.allowed) return protectedNow as Decision<Step>;
    const reread = await remote(id, () => port.observeBranchProtection(target, branch));
    if (!reread.allowed) return reread as Decision<Step>;
    if (reread.value === null) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REREAD_MISMATCH",
        `${branch} is unprotected when re-read after a protection GitHub accepted`,
        id,
        {},
        true,
      );
    }
    if (!sameProtection(reread.value, desired)) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "REREAD_MISMATCH",
        `GitHub holds a different protection on ${branch} than the one requested`,
        id,
        { requested: sortedProtection(desired), observed: sortedProtection(reread.value) },
        false,
      );
    }
    return allow(ReasonCode.OK, {
      receipt: {
        operationId: id,
        resourceType: "branch-protection",
        resourceIdentity: operation.resourceIdentity,
        repositoryNodeId: repository.value.nodeId,
        preexisting: before !== null,
        beforeStateDigest: before === null ? null : digestOf(sortedProtection(before)),
        observed: sortedProtection(reread.value),
        createdAt,
        rereadAt: clock.nowIso(),
      },
      wrote: true,
    });
  };

  for (const operation of execution.operations) {
    const step: Decision<Step> =
      operation.resourceType === "repository"
        ? await repositoryStep(operation)
        : operation.resourceType === "branch"
          ? await branchStep(operation)
          : operation.resourceType === "setting"
            ? await settingStep(operation)
            : await protectionStep(operation);
    if (!step.allowed) return step as Decision<AppliedGitHubOperations>;
    const { receipt, wrote } = step.value;
    if (receipt.resourceType === "repository") repositoryNodeId = receipt.observed.nodeId;
    completed.push(receipt);
    if (wrote) {
      ledger.set(receipt.operationId, receipt);
      input.record([...ledger.values()]);
      written.push(receipt.operationId);
    } else {
      resumed.push(receipt.operationId);
    }
  }

  // The result states a default branch; it is stated only after GitHub says so. With no
  // `setting` operation planned, nothing above has read it — GitHub's own first-push default is
  // a behaviour, not a receipt.
  const final = await confirmRepository(null);
  if (!final.allowed) return final as Decision<AppliedGitHubOperations>;
  if (final.value.defaultBranch !== input.defaultBranch) {
    return stop(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "REREAD_MISMATCH",
      `GitHub reports the default branch as ${final.value.defaultBranch ?? "unset"}, and the result would report ${input.defaultBranch}`,
      null,
      { observed: final.value.defaultBranch, reported: input.defaultBranch },
      false,
    );
  }
  return allow(ReasonCode.OK, { receipts: completed, written, resumed });
};
