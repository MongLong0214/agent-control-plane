import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
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
  isGitHubNodeId,
  parseGitHubIdentity,
  sameGitHubName,
  type BranchProtectionState,
  type GitHubRepositoryTarget,
  type GitHubVisibility,
  type GitHubWritePort,
  UNOBSERVED,
  type ObservedBranchProtection,
  type ObservedRepository,
} from "./github-write-port.ts";
import type { ExternalWriteReceipt } from "./repo-factory-result.ts";
import { frameRecord, writeWholeSync } from "./whole-write.ts";

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
 * A write GitHub accepted but whose answer was lost is not a write that never happened (PR #1043
 * review, RF1043-02). So every write is recorded twice outside the verified receipts: as a
 * pending intent before the call — carrying what will identify it afterwards — and, where GitHub
 * answers with an identity, again with that answer. A retry reconciles a pending write against
 * GitHub before anything else: a create by the node id its response named; a push by the commit
 * it pushed; a setting or protection by whether GitHub already holds the requested state. A
 * pending write that GitHub shows no trace of is sent again only on C3's proof that it never was
 * (#246 C5, review C5I-R1-02); without it, it stays in doubt. One whose outcome the ledger cannot
 * settle — a create whose response never arrived, with a repository now at the name — is refused
 * with `indeterminate: true`, rather than adopted by the marker the create put in the repository's
 * description: that marker is public once the repository exists, so a replacement can carry it
 * (PR #1043 review round 2, RF1043-06). It is reported as advisory evidence only. Nothing here
 * weakens the wrong-target refusal: adoption needs a GitHub node id or commit this operation
 * itself recorded.
 *
 * This file avoids `&&`/`||` on purpose: every refusal is its own branch with its own
 * evidence, so a reader — and `verify-refusal-operands-are-watched.mjs` — sees one decision
 * per condition rather than a chain whose failing link the evidence cannot name.
 */

export const GITHUB_LEDGER_SCHEMA_ID = "acp.repo-factory.github-ledger.v2";

const branchProtectionStateSchema = z
  .object({
    /** `strict` is requested, so it is read back and compared (RF1043-04); `null` is no checks. */
    requiredStatusChecks: z
      .object({ strict: z.boolean(), contexts: z.array(z.string().min(1)).min(1) })
      .strict()
      .nullable(),
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
      desiredState: z
        .object({
          visibility: z.enum(["public", "private"]),
          /**
           * #246 C5 — `true` makes the plan create-only: the create asks GitHub to initialize the
           * repository, the initialized default branch and its head are read back, and nothing is
           * pushed. Absent or `false`, the create asks for no initialization and the plan must push
           * the bootstrap commit. Optional with no default, so a plan without it keeps its digest.
           */
          autoInit: z.boolean().optional(),
        })
        .strict(),
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
 * #246 C5 — whether a plan's create is create-only (`autoInit: true`): GitHub makes the default
 * branch's first commit, and the plan pushes nothing. Only the approved plan's own create says so;
 * every relaxation of the pushed-head checks below is gated on it, and on nothing else.
 */
export const isCreateOnlyPlan = (operations: readonly GitHubOperation[]): boolean =>
  operations.some((operation) => (operation.resourceType === "repository" ? operation.desiredState.autoInit === true : false));

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
  /** #246 C5 — GitHub initializes the default branch; nothing is pushed (`isCreateOnlyPlan`). */
  createOnly: boolean;
  /** The push of the bootstrap commit; null exactly when the plan is create-only. */
  pushOperationId: string | null;
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

  // #246 C5 — a create-only create leaves the default branch existing, at the commit GitHub made;
  // otherwise the branch exists only once the plan's push has run.
  const createOnly = first.desiredState.autoInit === true;
  let pushIndex = createOnly ? 0 : -1;
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
      if (createOnly) {
        return shape(
          "a create-only plan pushes nothing: its default branch is the one GitHub initialized, and a push to it would be a direct push to the default branch",
          { operationId: operation.operationId },
        );
      }
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
  // `github:<owner>/<name>` that GitHub does not have — unless GitHub made that commit itself, which a
  // create-only create reads back before anything is reported (`applyGitHubOperations`).
  if (pushOperationId === null) {
    if (!createOnly) {
      return shape("a GitHub-provisioned repository must receive the bootstrap commit", {
        repository: first.resourceIdentity,
      });
    }
  }

  return allow(ReasonCode.OK, {
    target: { owner: repository.owner, name: repository.name },
    repositoryIdentity: first.resourceIdentity,
    visibility: authority.visibility,
    operations,
    createOnly,
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

/** Protection as GitHub answered it: a flag its answer did not carry is `null`, never a default. */
const observedProtectionSchema = z
  .object({
    requiredStatusChecks: z
      .object({ strict: z.boolean().nullable(), contexts: z.array(z.string()).nullable() })
      .strict()
      .nullable(),
    enforceAdmins: z.boolean().nullable(),
    requiredApprovingReviewCount: z.union([z.number().int(), z.null(), z.literal(UNOBSERVED)]),
    allowForcePushes: z.boolean().nullable(),
    allowDeletions: z.boolean().nullable(),
  })
  .strict();

/** A receipt in the ledger: the readback GitHub gave, in full, not a digest of it. */
export const githubOperationReceiptSchema = z.discriminatedUnion("resourceType", [
  z
    .object({
      ...receiptCommon,
      resourceType: z.literal("repository"),
      observed: z
        .object({
          nodeId: z.string().min(1),
          fullName: z.string().min(1),
          visibility: z.string().min(1),
          /**
           * #246 C5 — a create-only create's receipt only: the default branch GitHub initialized and
           * that branch's head, as read back after the create. Absent from every other receipt, so the
           * digest of a push-mode receipt is what it was.
           */
          defaultBranch: z.string().min(1).optional(),
          initializedHead: z.string().min(1).optional(),
        })
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
    .object({ ...receiptCommon, resourceType: z.literal("branch-protection"), observed: observedProtectionSchema })
    .strict(),
]);

export type GitHubOperationReceipt = z.infer<typeof githubOperationReceiptSchema>;

/**
 * A write started and not yet receipted (RF1043-02). Recorded before the call, and again with
 * GitHub's answer when one arrives, so a retry can tell its own write from someone else's.
 */
export const pendingWriteSchema = z
  .object({
    operationId: z.string().min(1),
    resourceType: z.enum(["repository", "branch", "setting", "branch-protection"]),
    resourceIdentity: z.string().min(1),
    /** When the write was first attempted — the receipt's `createdAt` if it is adopted. */
    attemptedAt: z.string().min(1),
    preexisting: z.boolean(),
    beforeStateDigest: z.string().nullable(),
    /** repository: the description its create request carried. */
    marker: z.string().min(1).nullable(),
    /** repository: the node id GitHub's create response named, once one arrived. */
    respondedNodeId: z.string().min(1).nullable(),
    /** branch: the commit the push sent. */
    pushedHead: z.string().min(1).nullable(),
  })
  .strict();

export type PendingWrite = z.infer<typeof pendingWriteSchema>;

const ledgerSchema = z
  .object({
    schema: z.literal(GITHUB_LEDGER_SCHEMA_ID),
    bootstrapOperationId: z.string().min(1),
    requestDigest: z.string().min(1),
    receipts: z.array(githubOperationReceiptSchema),
    pending: z.array(pendingWriteSchema),
  })
  .strict();

export type GitHubLedger = z.infer<typeof ledgerSchema>;

export interface LedgerOwner {
  bootstrapOperationId: string;
  requestDigest: string;
}

export interface LedgerState {
  receipts: ReadonlyMap<string, GitHubOperationReceipt>;
  pending: ReadonlyMap<string, PendingWrite>;
}

/**
 * Beside the checkout, never inside it. The checkout is disposable — a failed run removes it
 * so the same operation can retry — and the ledger is the one thing a retry must find.
 */
export const githubLedgerPath = (workDir: string, repositoryRole: string): string =>
  join(resolve(workDir), "github-ledger", `${repositoryRole}.json`);

const unsafeFile = <T>(path: string, message: string): Decision<T> =>
  refuse(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "LEDGER_UNSAFE", message, { ledgerPath: path });

const corruptFile = <T>(path: string, message: string, evidence: Evidence = {}): Decision<T> =>
  refuse(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "LEDGER_CORRUPT", message, { ledgerPath: path, ...evidence });

/**
 * Reads the ledger file: absent is `null`; a symlink, a non-file, another account's file or one
 * writable by others is a refusal, because acting on it would treat someone else's record as
 * ours. Ownership is not provenance: every ledger entry is re-checked against GitHub before it is
 * acted on, which is why the ledger, unlike a stored result, can be trusted this far.
 */
const readOwnFile = (path: string): Decision<unknown> => {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return allow(ReasonCode.OK, null);
    return corruptFile(path, "a GitHub ledger file could not be inspected", { message: (error as Error).message });
  }
  if (stat.isSymbolicLink()) return unsafeFile(path, "a GitHub ledger file is a symlink");
  if (!stat.isFile()) return unsafeFile(path, "a GitHub ledger file is not a regular file");
  if (typeof process.getuid !== "function") {
    return unsafeFile(path, "ownership verification is not supported on this platform");
  }
  if (stat.uid !== process.getuid()) return unsafeFile(path, "a GitHub ledger file is owned by another account");
  if ((stat.mode & 0o022) !== 0) return unsafeFile(path, "a GitHub ledger file is writable by another user or group");
  try {
    return allow(ReasonCode.OK, JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return corruptFile(path, "a GitHub ledger file is not readable JSON", { message: (error as Error).message });
  }
};

/**
 * Reads the receipts and pending writes a previous attempt left. Anything that cannot be proven
 * to be this operation's own record is a refusal.
 */
export const readGitHubLedger = (
  path: string,
  owner: LedgerOwner,
  operations: readonly GitHubOperation[],
): Decision<LedgerState> => {
  const raw = readOwnFile(path);
  if (!raw.allowed) return raw as Decision<LedgerState>;
  if (raw.value === null) return allow(ReasonCode.OK, { receipts: new Map(), pending: new Map() });
  const parsed = ledgerSchema.safeParse(raw.value);
  if (!parsed.success) {
    return corruptFile(path, "the GitHub receipt ledger failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const ledger = parsed.data;
  const foreign = (field: string): Decision<LedgerState> =>
    refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "LEDGER_FOREIGN",
      `the GitHub receipt ledger belongs to a different ${field}; resuming from it would adopt another operation's writes`,
      { ledgerPath: path, field },
    );
  if (ledger.bootstrapOperationId !== owner.bootstrapOperationId) return foreign("bootstrap operation");
  if (ledger.requestDigest !== owner.requestDigest) return foreign("request");

  const planned = (entry: { operationId: string; resourceType: string; resourceIdentity: string }): Decision<void> => {
    const operation = operations.find((candidate) => candidate.operationId === entry.operationId);
    const notInPlan = (): Decision<void> =>
      refuse(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "OPERATION_NOT_IN_PLAN",
        `the GitHub receipt ledger records ${entry.operationId}, which this plan does not contain as written`,
        { ledgerPath: path, operationId: entry.operationId },
      );
    if (operation === undefined) return notInPlan();
    if (operation.resourceType !== entry.resourceType) return notInPlan();
    if (operation.resourceIdentity !== entry.resourceIdentity) return notInPlan();
    return allow(ReasonCode.OK, undefined);
  };
  const receipts = new Map<string, GitHubOperationReceipt>();
  for (const receipt of ledger.receipts) {
    if (receipts.has(receipt.operationId)) {
      return corruptFile(path, "the GitHub receipt ledger holds two receipts for one operation", {
        operationId: receipt.operationId,
      });
    }
    const inPlan = planned(receipt);
    if (!inPlan.allowed) return inPlan as Decision<LedgerState>;
    receipts.set(receipt.operationId, receipt);
  }
  const pending = new Map<string, PendingWrite>();
  for (const entry of ledger.pending) {
    // A receipt and its pending write are replaced in one atomic ledger write; both at once is
    // a ledger this producer did not write.
    if (receipts.has(entry.operationId)) {
      return corruptFile(path, "the GitHub receipt ledger holds a receipt and a pending write for one operation", {
        operationId: entry.operationId,
      });
    }
    if (pending.has(entry.operationId)) {
      return corruptFile(path, "the GitHub receipt ledger holds two pending writes for one operation", {
        operationId: entry.operationId,
      });
    }
    const inPlan = planned(entry);
    if (!inPlan.allowed) return inPlan as Decision<LedgerState>;
    pending.set(entry.operationId, entry);
  }
  return allow(ReasonCode.OK, { receipts, pending });
};

/**
 * Atomic and durable: write a scratch file, fsync it, rename it over the target, fsync the
 * directory. A crash mid-write leaves the previous version whole, so the resume point the
 * ledger exists to keep is never the thing a crash destroys. The scratch file is written whole or
 * not renamed at all (#246 C3, review 1076-R4): a short write throws before the rename, and the
 * request the ledger was being written for is not sent.
 */
const writeOwnFile = (path: string, content: unknown): void => {
  const scratch = `${path}.partial`;
  const descriptor = openSync(scratch, "w", 0o600);
  try {
    writeWholeSync(descriptor, frameRecord(content));
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

export const writeGitHubLedger = (path: string, ledger: GitHubLedger): void => writeOwnFile(path, ledger);

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
  prior: LedgerState;
  /** Persists receipts and pending writes together; called before and after every write. */
  record: (state: { receipts: GitHubOperationReceipt[]; pending: PendingWrite[] }) => void;
  ledgerPath: string;
  clock: Clock;
  /** Mints the marker a create puts in the repository's description. */
  newMarker?: () => string;
  /**
   * #246 C5, review C5I-R1-02 — whether a pending intent GitHub does not show settled is proven never
   * sent: C3's withheld records of exactly that intent (`withheldUnsent` over `readWithheldIntent`).
   * Without that proof the request stays in doubt and is not sent again, whichever step made it
   * (`unresolvedPending`).
   */
  provenUnsent: (intent: PendingWrite) => boolean;
  /**
   * Records, durably, that the exemption `provenUnsent` found has been used, before the request it
   * allows can start; throws when it cannot, and then nothing is sent. C3's one-time consumption: a
   * request sent on the exemption that goes unanswered is in doubt from then on.
   */
  consumeExemption: (intent: PendingWrite) => void;
  /**
   * Issue #246 C2, review round 1 (RF-REVIEW-01) — whether the tree at `head` is exactly the approved
   * files. The commit this run makes is asked before this function is called at all, so a first push
   * sends only an approved tree. A head GitHub already holds — a resumed push's receipted head, or a
   * lost push's recorded one — was not, so it is asked once it is checked out, before any later
   * operation writes on its strength.
   */
  approvedTree: (head: string) => Promise<Decision<void>>;
  /**
   * Review round 3 (RF-REVIEW-01) — the commit this run made and checked with `approvedTree` before
   * calling this function: the only commit a first push sends, by its id. The checkout's HEAD is never
   * read back to choose what to push: every GitHub call before the push is awaited, and anything
   * that moves HEAD meanwhile would otherwise be pushed unchecked. Null exactly for a create-only
   * plan (#246 C5), which makes no commit: its head is the one GitHub initialized, read back by the
   * create's own step.
   */
  validatedHead: string | null;
}

export interface AppliedGitHubOperations {
  /** This attempt's receipts, in plan order — written now, adopted from a pending write, or resumed. */
  receipts: GitHubOperationReceipt[];
  written: string[];
  adopted: string[];
  resumed: string[];
  /**
   * The head GitHub holds once the push step is done, as its receipt read it back: `validatedHead`
   * when this attempt pushed it, or the receipted or recorded head a retry fetched and checked. For a
   * create-only plan, the initialized head the create's receipt read back and this run checked out.
   */
  publishedHead: string;
}

type Step = { receipt: GitHubOperationReceipt; outcome: "written" | "adopted" | "resumed" };

type ComparableProtection = BranchProtectionState | ObservedBranchProtection;

/** Order-free over contexts, and nothing else: every requested field takes part. */
const normalizedProtection = (state: ComparableProtection): ObservedBranchProtection => ({
  requiredStatusChecks:
    state.requiredStatusChecks === null
      ? null
      : {
          strict: state.requiredStatusChecks.strict,
          contexts: state.requiredStatusChecks.contexts === null ? null : [...state.requiredStatusChecks.contexts].sort(),
        },
  enforceAdmins: state.enforceAdmins,
  requiredApprovingReviewCount: state.requiredApprovingReviewCount,
  allowForcePushes: state.allowForcePushes,
  allowDeletions: state.allowDeletions,
});

const sameProtection = (observed: ObservedBranchProtection, desired: BranchProtectionState): boolean =>
  canonicalJson(normalizedProtection(observed)) === canonicalJson(normalizedProtection(desired));

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
  const newMarker = input.newMarker ?? (() => `repo-factory:${randomUUID()}`);
  const receipts = new Map(input.prior.receipts);
  const pending = new Map(input.prior.pending);
  const completed: GitHubOperationReceipt[] = [];
  const written: string[] = [];
  const adopted: string[] = [];
  const resumed: string[] = [];
  let repositoryNodeId: string | null = null;
  // Every successful attempt has exactly one branch receipt (`preflightGitHubOperations` requires the
  // push), which sets this to the head GitHub holds — or, create-only, exactly one repository receipt
  // carrying the initialized head, which sets it instead.
  let publishedHead = input.validatedHead;

  const persist = (): void => input.record({ receipts: [...receipts.values()], pending: [...pending.values()] });
  /** Before a write, and again with GitHub's answer: what a retry reconciles against. */
  const begin = (entry: PendingWrite): void => {
    pending.set(entry.operationId, entry);
    persist();
  };

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
      pendingOperationIds: [...pending.keys()],
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

  /**
   * #246 C5, review C5I-R1-02 — the one pending judgement every step makes before it would send a
   * request again, the same one the runner makes before any attempt (review 1076-R1-03). A request an
   * earlier call began and never saw answered may still land: a client that gave up proves nothing
   * about the server, and GitHub not showing its effect now proves nothing about a request still in
   * flight. A step adopts an effect GitHub does show; anything else is sent again only on C3's proof
   * that exactly this intent was never sent (`provenUnsent`), and then as a new request, under a new
   * begin time for a create or a push, under the same intent for a setting or a protection. The proof is
   * used once: its consumption is recorded before the request can start (`consumeExemption`), so a
   * request sent on it that goes unanswered is in doubt from then on, even one begun at the same time.
   * Without the proof it stays in doubt: null when the step may send, the refusal otherwise.
   */
  const unresolvedPending = (pendingWrite: PendingWrite | undefined): Decision<Step> | null => {
    if (pendingWrite === undefined) return null;
    if (input.provenUnsent(pendingWrite)) {
      try {
        input.consumeExemption(pendingWrite);
      } catch (error) {
        return stop(
          ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
          "WITHHELD_EXEMPTION_UNCONSUMED",
          `the exemption of ${pendingWrite.operationId}'s withheld request could not be recorded as consumed, so the request is not sent`,
          pendingWrite.operationId,
          { indeterminate: true, resourceType: pendingWrite.resourceType, remote: describeFailure(error) },
          false,
        );
      }
      return null;
    }
    return stop(
      ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
      "UNCONFIRMED_PENDING_REQUEST",
      `${pendingWrite.operationId}'s ${pendingWrite.resourceType} request was sent and never answered, and nothing proves it was not; it is not sent again, and the operation stays in doubt`,
      pendingWrite.operationId,
      { indeterminate: true, resourceType: pendingWrite.resourceType, attemptedAt: pendingWrite.attemptedAt },
      false,
    );
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

  /** A branch answer must describe the branch asked about; the port never fills the name in. */
  const sameBranch = (observedName: string, branch: string, operationId: string): Decision<void> =>
    observedName === branch
      ? allow(ReasonCode.OK, undefined)
      : stop(
          ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
          "REREAD_MISMATCH",
          `GitHub answered for branch ${observedName} when asked about ${branch}`,
          operationId,
          { observedName, branch },
          false,
        );

  const repositoryStep = async (operation: Extract<GitHubOperation, { resourceType: "repository" }>): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const prior = input.prior.receipts.get(id);
    const pendingWrite = pending.get(id);
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
        outcome: "resumed",
      });
    }

    if (observed.value !== null) {
      // Ours only by a GitHub identity this operation persisted before this read: the node id
      // GitHub's create response named. The marker cannot stand in for it (PR #1043 review round
      // 2, RF1043-06): it lives in the repository's public description, so a replacement created
      // after ours can carry it too.
      if (pendingWrite === undefined) {
        return stop(
          ReasonCode.RESOURCE_COLLISION,
          "WRONG_TARGET",
          `${target.owner}/${target.name} already exists and carries no receipt from this bootstrap operation; it is not adopted, overwritten or renamed`,
          id,
          { observedNodeId: observed.value.nodeId, observed: readbackOf(observed.value) },
          false,
        );
      }
      if (pendingWrite.respondedNodeId === null) {
        // The create was sent and its answer never recorded: it may have landed, and the repository
        // at this name may be it or a later one. That is reported, not resolved.
        return stop(
          ReasonCode.RESOURCE_COLLISION,
          "WRONG_TARGET",
          `${target.owner}/${target.name} exists, and this operation's create recorded no GitHub identity to tell whether it is that create; it is not adopted on the strength of a public description`,
          id,
          {
            indeterminate: true,
            observedNodeId: observed.value.nodeId,
            observed: readbackOf(observed.value),
            // Advisory, for whoever resolves this by hand — never authority.
            markerMatches: observed.value.description === pendingWrite.marker,
          },
          false,
        );
      }
      if (observed.value.nodeId !== pendingWrite.respondedNodeId) {
        return stop(
          ReasonCode.RESOURCE_COLLISION,
          "WRONG_TARGET",
          `${target.owner}/${target.name} is not the repository this operation's create was answered with`,
          id,
          {
            indeterminate: false,
            recordedNodeId: pendingWrite.respondedNodeId,
            observedNodeId: observed.value.nodeId,
            observed: readbackOf(observed.value),
          },
          false,
        );
      }
      const judged = judgeRepository(observed.value, id);
      if (!judged.allowed) return judged as Decision<Step>;
      return allow(ReasonCode.OK, {
        receipt: {
          operationId: id,
          resourceType: "repository",
          resourceIdentity: operation.resourceIdentity,
          repositoryNodeId: observed.value.nodeId,
          preexisting: false,
          beforeStateDigest: null,
          observed: readbackOf(observed.value),
          createdAt: pendingWrite.attemptedAt,
          rereadAt: clock.nowIso(),
        },
        outcome: "adopted",
      });
    }
    if (pendingWrite === undefined ? false : pendingWrite.respondedNodeId !== null) {
      return stop(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "RESUMED_RESOURCE_ABSENT",
        `GitHub answered this operation's create and ${target.owner}/${target.name} is now absent; it is not created again under a name that was ours`,
        id,
        { recordedNodeId: pendingWrite?.respondedNodeId ?? null },
        false,
      );
    }
    // A create sent and never answered, with no repository at the name: in doubt unless proven unsent.
    const createInDoubt = unresolvedPending(pendingWrite);
    if (createInDoubt !== null) return createInDoubt;

    const createdAt = clock.nowIso();
    const marker = pendingWrite?.marker ?? newMarker();
    const intent: PendingWrite = {
      operationId: id,
      resourceType: "repository",
      resourceIdentity: operation.resourceIdentity,
      attemptedAt: createdAt,
      preexisting: false,
      beforeStateDigest: null,
      marker,
      respondedNodeId: null,
      pushedHead: null,
    };
    begin(intent);
    // The initialization option is always stated, never left to the port's default (#246 C5).
    const created = await remote(id, () => port.createRepository(target, execution.visibility, marker, execution.createOnly));
    if (!created.allowed) return created as Decision<Step>;
    // Review C5I-R1-03 — an answer that names no valid repository identity is not an answer: the create
    // may still have landed, so it is neither recorded as the create's identity nor accepted, and the
    // intent stays pending with no answer, in doubt, never sent again.
    if (!isGitHubNodeId(created.value.nodeId)) {
      return stop(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "UNIDENTIFIED_CREATE_ANSWER",
        `GitHub's answer to ${id}'s create names no valid repository identity; the create may have landed, and it is not accepted or sent again`,
        id,
        { indeterminate: true },
        false,
      );
    }
    begin({ ...intent, respondedNodeId: created.value.nodeId });
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
      outcome: "written",
    });
  };

  /**
   * #246 C5 — a create-only create's step: the create judged exactly as `repositoryStep` judges any
   * create (written, adopted only by the node id its own response named, or resumed from its receipt
   * by node id), then its initialized default branch and head read back and added to the receipt.
   *
   * The head is never assumed from the plan or from GitHub's documented behaviour. The repository
   * must still be the one this operation created, by node id; it must report the plan's default
   * branch; that branch must exist; its head is fetched into this run's checkout and must be a commit
   * with no parent — the commit GitHub's initialization made, not one pushed on top of it; and on a
   * resume it must still be the head the receipt recorded. This is the one place a head this producer
   * did not make is accepted, and only for a plan whose approved create asked for the initialization.
   *
   * Limit (review C5I-R1-01): a same-account forged bootstrap ledger can make a preexisting repository
   * pass the create-only readback. A resumed receipt is a ledger file, and the ledger's ownership and
   * mode checks say only that this account wrote it, not that this operation's create made what it
   * names; a receipt naming a preexisting repository's node id and head reads back as this one.
   */
  const initializedRepositoryStep = async (
    operation: Extract<GitHubOperation, { resourceType: "repository" }>,
  ): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const branch = input.defaultBranch;
    const created = await repositoryStep(operation);
    if (!created.allowed) return created;
    const { receipt, outcome } = created.value;
    if (receipt.resourceType !== "repository") return corruptPrior(id);
    let receiptedHead: string | null = null;
    if (outcome === "resumed") {
      const prior = input.prior.receipts.get(id);
      const recorded = prior?.resourceType === "repository" ? prior.observed.initializedHead : undefined;
      if (recorded === undefined) {
        return stop(
          ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
          "LEDGER_CORRUPT",
          `the ledger's receipt for ${id} records no initialized head, and this plan's create asked for one`,
          id,
          {},
          false,
        );
      }
      receiptedHead = recorded;
    }
    const unobserved = (message: string, evidence: Evidence): Decision<Step> =>
      stop(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "INITIALIZED_HEAD_UNOBSERVED", message, id, evidence, true);
    const localFailure = (message: string, evidence: Evidence): Decision<Step> =>
      stop(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "LOCAL_CHECKOUT_FAILED", message, id, evidence, true);

    const observed = await remote(id, () => port.observeRepository(target));
    if (!observed.allowed) return observed as Decision<Step>;
    if (observed.value === null) {
      return stop(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "RESUMED_RESOURCE_ABSENT",
        `${target.owner}/${target.name} is absent from GitHub after this operation's create`,
        id,
        { recordedNodeId: receipt.observed.nodeId },
        false,
      );
    }
    if (observed.value.nodeId !== receipt.observed.nodeId) {
      return stop(
        ReasonCode.RESOURCE_COLLISION,
        "WRONG_TARGET",
        `${target.owner}/${target.name} is not the repository this operation created; the name was reused`,
        id,
        { recordedNodeId: receipt.observed.nodeId, observedNodeId: observed.value.nodeId },
        false,
      );
    }
    const judged = judgeRepository(observed.value, id);
    if (!judged.allowed) return judged as Decision<Step>;
    const reportedDefault = observed.value.defaultBranch;
    if (reportedDefault === null) {
      return unobserved(`GitHub reports no default branch for ${target.owner}/${target.name} after a create that asked it to initialize one`, {
        planned: branch,
      });
    }
    if (reportedDefault !== branch) {
      return stop(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "INITIALIZED_BRANCH_MISMATCH",
        `GitHub initialized ${reportedDefault} as the default branch, and the plan's default branch is ${branch}`,
        id,
        { observed: reportedDefault, planned: branch },
        false,
      );
    }
    const head = await remote(id, () => port.observeBranch(target, branch));
    if (!head.allowed) return head as Decision<Step>;
    if (head.value === null) {
      return unobserved(`${branch} is absent from ${target.owner}/${target.name}, which GitHub reports as its default branch`, { branch });
    }
    const named = sameBranch(head.value.name, branch, id);
    if (!named.allowed) return named as Decision<Step>;
    const initializedHead = head.value.headSha;
    if (receiptedHead !== null) {
      if (initializedHead !== receiptedHead) {
        return stop(
          ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
          "RESUMED_RESOURCE_DRIFTED",
          `${branch} has moved since this operation's create initialized it`,
          id,
          { recordedHead: receiptedHead, observedHead: initializedHead },
          false,
        );
      }
    }

    // The checkout is fresh on every attempt; the commit GitHub made is brought into it.
    const fetched = await remote(id, () => port.fetchBranch(target, branch, input.checkoutPath));
    if (!fetched.allowed) return fetched as Decision<Step>;
    const reset = await git(input.checkoutPath, ["reset", "-q", "--hard", initializedHead], { allowFailure: true });
    if (reset.exitCode !== 0) {
      return localFailure("the initialized commit could not be checked out locally", { stderr: reset.stderr });
    }
    const local = await tryRevParse(input.checkoutPath, "HEAD");
    if (local !== initializedHead) {
      return localFailure("the local checkout is not at the initialized commit", { head: local, initialized: initializedHead });
    }
    // Read unreplaced, as `producedTreeDrift` reads a tree: a replacement ref changes what a local read
    // of a commit returns and nothing GitHub holds.
    const listed = await git(input.checkoutPath, ["--no-replace-objects", "rev-list", "--max-count=1", "--parents", initializedHead], {
      allowFailure: true,
    });
    if (listed.exitCode !== 0) {
      return localFailure("the initialized commit's parents could not be read", { stderr: listed.stderr });
    }
    const parents = listed.stdout.trim().split(/\s+/).slice(1);
    if (parents.length > 0) {
      return stop(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "INITIALIZED_HEAD_HAS_PARENT",
        `${branch}'s head has a parent, so it is not the commit GitHub's initialization made`,
        id,
        { head: initializedHead, parents },
        false,
      );
    }
    return allow(ReasonCode.OK, {
      receipt: { ...receipt, observed: { ...readbackOf(observed.value), defaultBranch: branch, initializedHead } },
      outcome,
    });
  };

  const branchStep = async (operation: Extract<GitHubOperation, { resourceType: "branch" }>): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const branch = input.defaultBranch;
    const repository = await confirmRepository(id);
    if (!repository.allowed) return repository as Decision<Step>;
    const prior = input.prior.receipts.get(id);
    const pendingWrite = pending.get(id);
    const observed = await remote(id, () => port.observeBranch(target, branch));
    if (!observed.allowed) return observed as Decision<Step>;
    const localFailure = (message: string, evidence: Evidence): Decision<Step> =>
      stop(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "LOCAL_CHECKOUT_FAILED", message, id, evidence, true);
    /** The checkout is fresh on every attempt; the commit GitHub already holds is brought into it. */
    const checkOut = async (head: string): Promise<Decision<void>> => {
      const fetched = await remote(id, () => port.fetchBranch(target, branch, input.checkoutPath));
      if (!fetched.allowed) return fetched as Decision<void>;
      const reset = await git(input.checkoutPath, ["reset", "-q", "--hard", head], { allowFailure: true });
      if (reset.exitCode !== 0) {
        return localFailure("the pushed commit could not be checked out locally", { stderr: reset.stderr }) as Decision<void>;
      }
      const local = await tryRevParse(input.checkoutPath, "HEAD");
      if (local !== head) {
        return localFailure("the local checkout is not at the pushed commit", { head: local, pushed: head }) as Decision<void>;
      }
      // The pushed head is what the setting and the protection after it are applied to, and what the
      // result reports; one that is not the approved files stops here, before either is written
      // (RF-REVIEW-01). The tree check's own evidence — its refusal and the differing paths — is kept.
      const approved = await input.approvedTree(head);
      if (!approved.allowed) {
        return stop(approved.reasonCode, "PUSHED_HEAD_NOT_APPROVED", approved.message, id, approved.evidence, false);
      }
      return allow(ReasonCode.OK, undefined);
    };
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
      const named = sameBranch(observed.value.name, branch, id);
      if (!named.allowed) return named as Decision<Step>;
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
      const checkedOut = await checkOut(prior.observed.headSha);
      if (!checkedOut.allowed) return checkedOut as Decision<Step>;
      return allow(ReasonCode.OK, {
        receipt: {
          ...prior,
          repositoryNodeId: repository.value.nodeId,
          observed: { name: observed.value.name, headSha: observed.value.headSha },
          rereadAt: clock.nowIso(),
        },
        outcome: "resumed",
      });
    }
    if (observed.value !== null) {
      const named = sameBranch(observed.value.name, branch, id);
      if (!named.allowed) return named as Decision<Step>;
      const recordedHead = pendingWrite === undefined ? null : pendingWrite.pushedHead;
      if (recordedHead !== observed.value.headSha) {
        return stop(
          ReasonCode.RESOURCE_COLLISION,
          "UNRECEIPTED_RESOURCE",
          `${branch} already exists on ${target.owner}/${target.name} at a commit this bootstrap operation did not push`,
          id,
          { observedHead: observed.value.headSha, recordedHead },
          false,
        );
      }
      // The commit this operation recorded before its push is the one GitHub holds: the push
      // landed and only its answer was lost.
      const checkedOut = await checkOut(recordedHead);
      if (!checkedOut.allowed) return checkedOut as Decision<Step>;
      return allow(ReasonCode.OK, {
        receipt: {
          operationId: id,
          resourceType: "branch",
          resourceIdentity: operation.resourceIdentity,
          repositoryNodeId: repository.value.nodeId,
          preexisting: false,
          beforeStateDigest: null,
          observed: { name: observed.value.name, headSha: observed.value.headSha },
          createdAt: pendingWrite?.attemptedAt ?? clock.nowIso(),
          rereadAt: clock.nowIso(),
        },
        outcome: "adopted",
      });
    }
    // A push sent and never answered, with no branch on GitHub: in doubt unless proven unsent.
    const pushInDoubt = unresolvedPending(pendingWrite);
    if (pushInDoubt !== null) return pushInDoubt;
    // The checked commit, by its id — not a HEAD read now, after the awaited calls above (RF-REVIEW-01).
    const localHead = input.validatedHead;
    if (localHead === null) {
      // A create-only plan makes no commit, and `preflightGitHubOperations` refuses its push.
      return localFailure("a push needs the commit this run made and checked, and this run made none", {});
    }
    const createdAt = clock.nowIso();
    begin({
      operationId: id,
      resourceType: "branch",
      resourceIdentity: operation.resourceIdentity,
      attemptedAt: createdAt,
      preexisting: false,
      beforeStateDigest: null,
      marker: null,
      respondedNodeId: null,
      pushedHead: localHead,
    });
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
    const named = sameBranch(reread.value.name, branch, id);
    if (!named.allowed) return named as Decision<Step>;
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
      outcome: "written",
    });
  };

  const settingStep = async (operation: Extract<GitHubOperation, { resourceType: "setting" }>): Promise<Decision<Step>> => {
    const id = operation.operationId;
    const desired = operation.desiredState.defaultBranch;
    const repository = await confirmRepository(id);
    if (!repository.allowed) return repository as Decision<Step>;
    const prior = input.prior.receipts.get(id);
    const pendingWrite = pending.get(id);
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
        outcome: "resumed",
      });
    }
    if (pendingWrite !== undefined) {
      // A setting this operation already sent: if GitHub holds it, the write landed and only the
      // read after it was lost. On the repository its node id proves ours, that is the receipt.
      if (repository.value.defaultBranch === desired) {
        return allow(ReasonCode.OK, {
          receipt: {
            operationId: id,
            resourceType: "setting",
            resourceIdentity: operation.resourceIdentity,
            repositoryNodeId: repository.value.nodeId,
            preexisting: pendingWrite.preexisting,
            beforeStateDigest: pendingWrite.beforeStateDigest,
            observed: { defaultBranch: desired },
            createdAt: pendingWrite.attemptedAt,
            rereadAt: clock.nowIso(),
          },
          outcome: "adopted",
        });
      }
    }
    // A setting sent and never answered, which GitHub does not show: in doubt unless proven unsent.
    const settingInDoubt = unresolvedPending(pendingWrite);
    if (settingInDoubt !== null) return settingInDoubt;
    const createdAt = pendingWrite?.attemptedAt ?? clock.nowIso();
    const intent: PendingWrite = pendingWrite ?? {
      operationId: id,
      resourceType: "setting",
      resourceIdentity: operation.resourceIdentity,
      attemptedAt: createdAt,
      preexisting: true,
      beforeStateDigest: digestOf({ defaultBranch: repository.value.defaultBranch }),
      marker: null,
      respondedNodeId: null,
      pushedHead: null,
    };
    begin(intent);
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
        preexisting: intent.preexisting,
        beforeStateDigest: intent.beforeStateDigest,
        observed: { defaultBranch: observedDefault },
        createdAt,
        rereadAt: clock.nowIso(),
      },
      outcome: "written",
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
    const prior = input.prior.receipts.get(id);
    const pendingWrite = pending.get(id);
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
          { requested: normalizedProtection(desired), observed: normalizedProtection(current.value) },
          false,
        );
      }
      return allow(ReasonCode.OK, {
        receipt: { ...prior, observed: normalizedProtection(current.value), rereadAt: clock.nowIso() },
        outcome: "resumed",
      });
    }
    if (pendingWrite !== undefined) {
      if (current.value === null ? false : sameProtection(current.value, desired)) {
        return allow(ReasonCode.OK, {
          receipt: {
            operationId: id,
            resourceType: "branch-protection",
            resourceIdentity: operation.resourceIdentity,
            repositoryNodeId: repository.value.nodeId,
            preexisting: pendingWrite.preexisting,
            beforeStateDigest: pendingWrite.beforeStateDigest,
            observed: normalizedProtection(current.value ?? desired),
            createdAt: pendingWrite.attemptedAt,
            rereadAt: clock.nowIso(),
          },
          outcome: "adopted",
        });
      }
    }
    // A protection sent and never answered, which GitHub does not show as approved: in doubt unless
    // proven unsent.
    const protectionInDoubt = unresolvedPending(pendingWrite);
    if (protectionInDoubt !== null) return protectionInDoubt;
    const before = current.value;
    const intent: PendingWrite = pendingWrite ?? {
      operationId: id,
      resourceType: "branch-protection",
      resourceIdentity: operation.resourceIdentity,
      attemptedAt: clock.nowIso(),
      preexisting: before !== null,
      beforeStateDigest: before === null ? null : digestOf(normalizedProtection(before)),
      marker: null,
      respondedNodeId: null,
      pushedHead: null,
    };
    begin(intent);
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
        { requested: normalizedProtection(desired), observed: normalizedProtection(reread.value) },
        false,
      );
    }
    return allow(ReasonCode.OK, {
      receipt: {
        operationId: id,
        resourceType: "branch-protection",
        resourceIdentity: operation.resourceIdentity,
        repositoryNodeId: repository.value.nodeId,
        preexisting: intent.preexisting,
        beforeStateDigest: intent.beforeStateDigest,
        observed: normalizedProtection(reread.value),
        createdAt: intent.attemptedAt,
        rereadAt: clock.nowIso(),
      },
      outcome: "written",
    });
  };

  for (const operation of execution.operations) {
    const step: Decision<Step> =
      operation.resourceType === "repository"
        ? execution.createOnly
          ? await initializedRepositoryStep(operation)
          : await repositoryStep(operation)
        : operation.resourceType === "branch"
          ? await branchStep(operation)
          : operation.resourceType === "setting"
            ? await settingStep(operation)
            : await protectionStep(operation);
    if (!step.allowed) return step as Decision<AppliedGitHubOperations>;
    const { receipt, outcome } = step.value;
    if (receipt.resourceType === "repository") {
      repositoryNodeId = receipt.observed.nodeId;
      if (execution.createOnly) publishedHead = receipt.observed.initializedHead ?? null;
    }
    if (receipt.resourceType === "branch") publishedHead = receipt.observed.headSha;
    completed.push(receipt);
    if (outcome === "resumed") {
      resumed.push(receipt.operationId);
      continue;
    }
    // The receipt replaces its pending write in one atomic ledger write.
    pending.delete(receipt.operationId);
    receipts.set(receipt.operationId, receipt);
    persist();
    if (outcome === "written") written.push(receipt.operationId);
    else adopted.push(receipt.operationId);
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
  if (publishedHead === null) {
    // Neither a push nor an initialization receipted a head: there is nothing to report.
    return stop(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "INITIALIZED_HEAD_UNOBSERVED",
      "no head was pushed or read back, so the result would report one GitHub was never shown to hold",
      null,
      {},
      false,
    );
  }
  return allow(ReasonCode.OK, { receipts: completed, written, adopted, resumed, publishedHead });
};
