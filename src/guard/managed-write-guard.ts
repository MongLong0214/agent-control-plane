import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, RunState } from "../domain/types.ts";
import { type WorkspaceProbe, isWithin } from "./workspace-probe.ts";

/**
 * Operations that mutate project-natured state. PRD §4 CP-HI-01 enumerates these
 * exactly: git file mutation, commit/branch/tag/worktree, GitHub PR/issue/release/ruleset write,
 * manifest/verification-contract change, programmatic merge.
 */
export const WriteOperation = {
  FILE_MUTATION: "FILE_MUTATION",
  GIT_COMMIT: "GIT_COMMIT",
  GIT_BRANCH: "GIT_BRANCH",
  GIT_TAG: "GIT_TAG",
  /** Local Git worktree add/remove/prune and the managed path cleanup around it. */
  GIT_WORKTREE: "GIT_WORKTREE",
  GITHUB_PR: "GITHUB_PR",
  GITHUB_ISSUE: "GITHUB_ISSUE",
  GITHUB_RELEASE: "GITHUB_RELEASE",
  GITHUB_RULESET: "GITHUB_RULESET",
  /** Check-run write. The production gate is published this way (§24.4). */
  GITHUB_CHECK_RUN: "GITHUB_CHECK_RUN",
  MANIFEST_CHANGE: "MANIFEST_CHANGE",
  VERIFICATION_CONTRACT_CHANGE: "VERIFICATION_CONTRACT_CHANGE",
  PROGRAMMATIC_MERGE: "PROGRAMMATIC_MERGE",
} as const;
export type WriteOperation = (typeof WriteOperation)[keyof typeof WriteOperation];

/** The concrete effect in a disposable-worktree lifecycle. */
export const WorktreeAction = {
  ADD: "ADD",
  REMOVE: "REMOVE",
  PRUNE: "PRUNE",
  CLEANUP: "CLEANUP",
} as const;
export type WorktreeAction = (typeof WorktreeAction)[keyof typeof WorktreeAction];

const WORKTREE_ACTIONS: ReadonlySet<WorktreeAction> = new Set(Object.values(WorktreeAction));

export const ReadOperation = {
  FILE_READ: "FILE_READ",
  GIT_READ: "GIT_READ",
  SEARCH: "SEARCH",
  NON_MUTATING_COMMAND: "NON_MUTATING_COMMAND",
} as const;
export type ReadOperation = (typeof ReadOperation)[keyof typeof ReadOperation];

export type GuardOperation = WriteOperation | ReadOperation;

const READ_OPERATIONS: ReadonlySet<string> = new Set(Object.values(ReadOperation));

/**
 * How each write operation's target is identified, and therefore what must be validated.
 * Keyed by operation so a new operation cannot be added without deciding its class.
 */
type OperationClass = "FILESYSTEM" | "GIT_LOCAL" | "REMOTE";

const OPERATION_CLASS: Readonly<Record<WriteOperation, OperationClass>> = {
  [WriteOperation.FILE_MUTATION]: "FILESYSTEM",
  [WriteOperation.MANIFEST_CHANGE]: "FILESYSTEM",
  [WriteOperation.VERIFICATION_CONTRACT_CHANGE]: "FILESYSTEM",
  [WriteOperation.GIT_COMMIT]: "GIT_LOCAL",
  [WriteOperation.GIT_BRANCH]: "GIT_LOCAL",
  [WriteOperation.GIT_TAG]: "GIT_LOCAL",
  [WriteOperation.GIT_WORKTREE]: "GIT_LOCAL",
  [WriteOperation.GITHUB_PR]: "REMOTE",
  [WriteOperation.GITHUB_ISSUE]: "REMOTE",
  [WriteOperation.GITHUB_RELEASE]: "REMOTE",
  [WriteOperation.GITHUB_RULESET]: "REMOTE",
  [WriteOperation.GITHUB_CHECK_RUN]: "REMOTE",
  [WriteOperation.PROGRAMMATIC_MERGE]: "REMOTE",
};

/** Source mutations must not race a final candidate freshness read (§16.2). */
const SOURCE_MUTATIONS: ReadonlySet<WriteOperation> = new Set([
  WriteOperation.FILE_MUTATION,
  WriteOperation.GIT_COMMIT,
  WriteOperation.GIT_BRANCH,
  WriteOperation.GIT_TAG,
  WriteOperation.GIT_WORKTREE,
  WriteOperation.GITHUB_RELEASE,
  WriteOperation.MANIFEST_CHANGE,
  WriteOperation.VERIFICATION_CONTRACT_CHANGE,
  WriteOperation.PROGRAMMATIC_MERGE,
]);

/**
 * These are source-side mutations. A remote GitHub operation is deliberately absent: its
 * admissible window is the daemon finalization state, never ACTIVE. `GITHUB_RELEASE` and
 * `PROGRAMMATIC_MERGE` remain in SOURCE_MUTATIONS for conservative source-lease collision
 * detection, but neither is admitted as a source write below.
 */
const ACTIVE_SOURCE_OPERATIONS: ReadonlySet<WriteOperation> = new Set([
  WriteOperation.FILE_MUTATION,
  WriteOperation.GIT_COMMIT,
  WriteOperation.GIT_BRANCH,
  WriteOperation.GIT_TAG,
  WriteOperation.GIT_WORKTREE,
  WriteOperation.MANIFEST_CHANGE,
  WriteOperation.VERIFICATION_CONTRACT_CHANGE,
]);

/**
 * Roles that may produce a candidate. CP-HI-04 puts the blind reviewer outside the
 * producer set, so a reviewer session holding a binding on the run must not be able to
 * mutate the very candidate it is judging.
 */
const WRITER_ROLES: ReadonlySet<string> = new Set<string>([
  Role.PRIMARY_CTO,
  Role.BOOTSTRAP_CTO,
  Role.WORKER,
]);

/**
 * The GitHub finalization capability is not a caller-provided actor label. It is minted
 * exactly once by the guard and retained by the daemon composition path, so an MCP/CLI
 * caller cannot turn a post-approval run into a generic writable run by spelling an actor
 * string. The guard still rechecks the pinned owner, generation, target and claims below.
 */
const DAEMON_FINALIZER_MINT = Symbol("acp.daemon-finalizer-write-authority");
const REPAIR_WORKTREE_MINT = Symbol("acp.repair-worktree-write-authority");
const BOOTSTRAP_MANIFEST_MINT = Symbol("acp.bootstrap-manifest-write-authority");

class DaemonFinalizerAuthorityToken {
  readonly #mint: symbol;
  readonly #guard: ManagedWriteGuard;

  constructor(mint: symbol, guard: ManagedWriteGuard) {
    if (mint !== DAEMON_FINALIZER_MINT) {
      fail(ReasonCode.MERGE_AUTHORITY_DENIED, "daemon finalizer authority cannot be constructed externally", {});
    }
    this.#mint = mint;
    this.#guard = guard;
  }

  static belongsTo(value: unknown, guard: ManagedWriteGuard): value is DaemonFinalizerAuthority {
    return value instanceof DaemonFinalizerAuthorityToken && value.#mint === DAEMON_FINALIZER_MINT && value.#guard === guard;
  }
}

/** Opaque capability accepted only for the fenced post-approval GitHub write set. */
export type DaemonFinalizerAuthority = DaemonFinalizerAuthorityToken;

/** Opaque capability held only by the doctor repair composition path. */
class RepairWorktreeAuthorityToken {
  readonly #mint: symbol;
  readonly #guard: ManagedWriteGuard;

  constructor(mint: symbol, guard: ManagedWriteGuard) {
    if (mint !== REPAIR_WORKTREE_MINT) {
      fail(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "repair worktree authority cannot be constructed externally", {});
    }
    this.#mint = mint;
    this.#guard = guard;
  }

  static belongsTo(value: unknown, guard: ManagedWriteGuard): value is RepairWorktreeAuthority {
    return value instanceof RepairWorktreeAuthorityToken && value.#mint === REPAIR_WORKTREE_MINT && value.#guard === guard;
  }
}

export type RepairWorktreeAuthority = RepairWorktreeAuthorityToken;

/** Opaque bootstrap-only capability for registering a manifest before a run exists. */
class BootstrapManifestAuthorityToken {
  readonly #mint: symbol;
  readonly #guard: ManagedWriteGuard;

  constructor(mint: symbol, guard: ManagedWriteGuard) {
    if (mint !== BOOTSTRAP_MANIFEST_MINT) {
      fail(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "bootstrap manifest authority cannot be constructed externally", {});
    }
    this.#mint = mint;
    this.#guard = guard;
  }

  static belongsTo(value: unknown, guard: ManagedWriteGuard): value is BootstrapManifestAuthority {
    return value instanceof BootstrapManifestAuthorityToken && value.#mint === BOOTSTRAP_MANIFEST_MINT && value.#guard === guard;
  }
}

export type BootstrapManifestAuthority = BootstrapManifestAuthorityToken;

export interface GuardRequest {
  operation: GuardOperation;
  /** Absolute filesystem target. Relative paths are refused — see `decide`. */
  targetPath?: string | null;
  /** Normalized remote identity, required for every remote operation. */
  repositoryIdentity?: string | null;
  /**
   * The branch or stable remote ref this operation mutates. GIT_BRANCH and every
   * remote write must always name one: the checkout branch says nothing about the
   * ref a command or GitHub request will change.
   */
  targetBranch?: string | null;
  /**
   * Absolute canonical worktree identity. For GIT_WORKTREE this is the disposable tree
   * being created or removed; other local writes use the registered checkout identity.
   */
  targetWorktreeId?: string | null;
  /**
   * The lifecycle effect for a disposable worktree. Only a tracked PRUNE may execute
   * from the registered source checkout rather than the disposable tree itself.
   */
  worktreeAction?: WorktreeAction | null;
  /** Project identity for a manifest mutation, which has no filesystem target. */
  projectId?: string | null;
  /** Managed run identity claimed by the caller. */
  runId?: string | null;
  sessionId?: string | null;
  bindingGeneration?: number | null;
  /** Worker task identity required by the local runtime write boundary. */
  taskId?: string | null;
  /** Durable task_executions receipt for the worker attempt. */
  taskReceiptId?: string | null;
  /** Canonical worktree bound to that receipt. */
  assignedWorktreeId?: string | null;
  /** Free-form classification supplied by Hermes; recorded, never trusted (§4 CP-HI-01). */
  claimedClassification?: "DIRECT" | "MANAGED" | null;
  actor?: string | null;
  /** Opaque daemon-held capability; ignored unless the run is in a finalization state. */
  daemonFinalizerAuthority?: DaemonFinalizerAuthority | null;
  /** Only the composition root may authorize a runless initial manifest registration. */
  bootstrapManifestAuthority?: BootstrapManifestAuthority | null;
  /** Only the doctor repair path may destroy a stranded worktree outside a run. */
  repairWorktreeAuthority?: RepairWorktreeAuthority | null;
}

export interface GuardGrant {
  grantId: string;
  classification: "DIRECT" | "MANAGED";
  operation: GuardOperation;
  runId: string | null;
  sessionId: string | null;
  roleKey: string | null;
  bindingGeneration: number | null;
  repositoryIdentity: string | null;
  resolvedPath: string | null;
  targetBranch: string | null;
  targetWorktreeId: string | null;
  worktreeAction: WorktreeAction | null;
  taskId: string | null;
  taskReceiptId: string | null;
  assignedWorktreeId: string | null;
  projectId: string | null;
  issuedAt: string;
  expiresAt: string;
}

/** The effect is invoked only after the grant has been revalidated and fenced. */
export type GuardEffect<T> = (context: { readonly grant: GuardGrant }) => T | Promise<T>;

export interface ManagedWriteGuardOptions {
  /** Explicit independent-artifact roots. An empty list permits no DIRECT mutations. */
  directWriteRoots?: readonly string[];
}

interface RunAuthRow {
  run_id: string;
  state: string;
  project_id: string | null;
  owner_session_id: string | null;
  owner_binding_generation: number | null;
  owner_role_key: string | null;
}

interface ParticipantRow {
  identity: string;
  checkout_path: string;
}

interface TargetResource {
  branch: string | null;
  /** A detached worktree add/remove does not mutate or select a branch. */
  branchIsRelevant: boolean;
  /** Registered checkout used for claim containment and repository-relative paths. */
  checkoutWorktreeId: string;
  /** Canonical filesystem path the concrete effect reaches. */
  effectPath: string | null;
  /** Filesystem target that claims protect; PRUNE retains its disposable-tree target. */
  claimPath: string | null;
  worktreeId: string | null;
  worktreeAction: WorktreeAction | null;
  /** A remote write does not reach a local checkout, so it cannot name one. */
  worktreeIsRelevant: boolean;
  relativePath: string | null;
}

interface TaskReceiptRow {
  execution_id: string;
  run_id: string;
  task_id: string;
  owner_binding_generation: number;
  worker_session_id: string;
  status: string;
  worktree_id: string | null;
  repository_identity: string | null;
  repository_checkout_path: string | null;
}

interface HeldGrant {
  facts: Readonly<GuardGrant>;
  request: Readonly<GuardRequest>;
}

interface ClaimRow {
  claim_id: string;
  expires_at: string;
}

interface NodeIdentity {
  dev: number;
  ino: number;
}

interface FilesystemFence {
  requestedPath: string;
  requestedParent: string;
  resolvedPath: string;
  parentFd: number;
  parent: NodeIdentity;
  toplevel: string | null;
  toplevelFd: number | null;
  toplevelIdentity: NodeIdentity | null;
  targetFd: number | null;
  targetIdentity: NodeIdentity | null;
  targetExisted: boolean;
}

/** Canonical repository-relative paths for the concrete effect fence. */
const normalizeRelativePath = (value: string): string => {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || ".";
};

const relativePathContains = (parent: string, child: string): boolean =>
  parent === "." || child === parent || child.startsWith(`${parent}/`);

const relativePathOverlap = (
  declared: string,
  target: string,
): "exact" | "target-under-claim" | "claim-under-target" | null => {
  const claim = normalizeRelativePath(declared);
  const touched = normalizeRelativePath(target);
  if (claim === touched) return "exact";
  if (relativePathContains(claim, touched)) return "target-under-claim";
  if (relativePathContains(touched, claim)) return "claim-under-target";
  return null;
};

interface SourceReadLease {
  leaseId: string;
  runId: string;
  repositoryIdentities: readonly string[];
  expiresAt: string;
}

/** A grant is short-lived and single use; see `consume`. */
const CLAIM_LEASE_EXTENSION_MS = 5 * 60 * 1000;
const GRANT_TTL_MS = 60_000;

/** The states in which a gate may hold a source freeze; see `acquireSourceReadLease`. */
const LEASEABLE_RUN_STATES: ReadonlySet<string> = new Set<string>([
  RunState.ACTIVE,
  RunState.READY_FOR_CEO_REVIEW,
  RunState.AWAITING_HUMAN,
]);
/** No source mutation may pass these states; only this explicit external write set may. */
const DAEMON_FINALIZATION_STATES: ReadonlySet<string> = new Set<string>([
  RunState.CEO_APPROVED,
  RunState.MERGING,
  RunState.POST_MERGE_VERIFYING,
]);
const DAEMON_FINALIZATION_OPERATIONS: ReadonlySet<WriteOperation> = new Set<WriteOperation>([
  WriteOperation.GITHUB_PR,
  WriteOperation.GITHUB_CHECK_RUN,
  WriteOperation.PROGRAMMATIC_MERGE,
  WriteOperation.GITHUB_RELEASE,
  WriteOperation.GITHUB_ISSUE,
]);
const SOURCE_READ_LEASE_TTL_MS = 60_000;
const NO_FOLLOW_READ = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

/**
 * CP-HI-01 Managed Write Guard.
 *
 * The guard inspects the operation and its applicable resolved target or project identity.
 * Hermes' own DIRECT/MANAGED judgement arrives as `claimedClassification`, is written to
 * the audit record, and never influences the decision. Agent source-file syscalls are not
 * individually routed through this API; their boundary is the assigned worktree, claim,
 * session/task receipt, and runtime adapter.
 */
export class ManagedWriteGuard {
  readonly #grants = new Map<string, HeldGrant>();
  readonly #inFlight = new Map<string, HeldGrant>();
  readonly #inFlightByTarget = new Map<string, string>();
  readonly #sourceReadLeases = new Map<string, SourceReadLease>();
  readonly #sourceReadLeasesByRepository = new Map<string, Set<string>>();
  readonly #directWriteRoots: readonly string[];
  #daemonFinalizerAuthorityClaimed = false;
  #repairWorktreeAuthorityClaimed = false;
  #bootstrapManifestAuthorityClaimed = false;

  constructor(
    private readonly db: Db,
    private readonly probe: WorkspaceProbe,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    options: ManagedWriteGuardOptions = {},
  ) {
    const roots = options.directWriteRoots ?? [];
    if (roots.some((root) => !isAbsolute(root))) {
      throw new Error("direct write roots must be absolute paths");
    }
    this.#directWriteRoots = Object.freeze([...new Set(roots.map((root) => this.probe.canonical(root)))]);
  }

  /** Claimed once by the composition root before it exposes any request-facing ports. */
  claimDaemonFinalizerAuthority(): DaemonFinalizerAuthority {
    if (this.#daemonFinalizerAuthorityClaimed) {
      fail(
        ReasonCode.MERGE_AUTHORITY_DENIED,
        "daemon finalizer authority was already issued for this guard",
        {},
      );
    }
    this.#daemonFinalizerAuthorityClaimed = true;
    return new DaemonFinalizerAuthorityToken(DAEMON_FINALIZER_MINT, this);
  }

  /**
   * Internal composition boundary for GitHub reads which nevertheless advance durable
   * finalization state (notably exact post-merge verification). This exposes no minting
   * path: callers can only prove possession of the one daemon capability.
   */
  hasDaemonFinalizerAuthority(value: unknown): value is DaemonFinalizerAuthority {
    return DaemonFinalizerAuthorityToken.belongsTo(value, this);
  }

  claimRepairWorktreeAuthority(): RepairWorktreeAuthority {
    if (this.#repairWorktreeAuthorityClaimed) {
      fail(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "repair worktree authority was already issued for this guard", {});
    }
    this.#repairWorktreeAuthorityClaimed = true;
    return new RepairWorktreeAuthorityToken(REPAIR_WORKTREE_MINT, this);
  }

  claimBootstrapManifestAuthority(): BootstrapManifestAuthority {
    if (this.#bootstrapManifestAuthorityClaimed) {
      fail(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "bootstrap manifest authority was already issued for this guard", {});
    }
    this.#bootstrapManifestAuthorityClaimed = true;
    return new BootstrapManifestAuthorityToken(BOOTSTRAP_MANIFEST_MINT, this);
  }

  evaluate(request: GuardRequest): Decision<GuardGrant> {
    const decision = this.decide(request);
    const exposed = decision.allowed
      ? this.holdOrExpose(request, decision)
      : decision;

    this.audit.record({
      kind: "MANAGED_WRITE_GUARD",
      reasonCode: exposed.reasonCode,
      runId: request.runId ?? null,
      sessionId: request.sessionId ?? null,
      actor: request.actor ?? null,
      evidence: {
        operation: request.operation,
        targetPath: request.targetPath ?? null,
        repositoryIdentity: request.repositoryIdentity ?? null,
        targetBranch: request.targetBranch ?? null,
        targetWorktreeId: request.targetWorktreeId ?? null,
        worktreeAction: request.worktreeAction ?? null,
        taskId: request.taskId ?? null,
        taskReceiptId: request.taskReceiptId ?? null,
        assignedWorktreeId: request.assignedWorktreeId ?? null,
        projectId: request.projectId ?? null,
        claimedClassification: request.claimedClassification ?? null,
        allowed: exposed.allowed,
        grantId: exposed.allowed ? exposed.value.grantId : null,
        ...exposed.evidence,
      },
    });
    return exposed;
  }

  /**
   * Legacy two-phase API. New side-effecting adapters should use `authorize`, which keeps
   * the grant in-flight until the effect has settled.
   */
  consume(grantId: string): Decision<GuardGrant> {
    const active = this.activate(grantId);
    if (!active.allowed) return active as Decision<GuardGrant>;

    this.auditConsumed(active.value.facts);
    return allow(ReasonCode.WRITE_ALLOWED, this.publicGrant(active.value.facts));
  }

  /**
   * Performs the side effect inside the authorisation lifecycle. Both authority and the
   * filesystem identity are checked immediately before and after the effect, so a racing
   * revocation or ancestor replacement is a refusal rather than a successful write.
   */
  async authorize<T>(request: GuardRequest, effect: GuardEffect<T>): Promise<Decision<T>> {
    const granted = this.evaluate(request);
    if (!granted.allowed) return granted as Decision<T>;

    const active = this.activate(granted.value.grantId);
    if (!active.allowed) return active as Decision<T>;

    const held = active.value;
    const targetKey = this.inFlightTargetKey(held.facts);
    if (targetKey) {
      const existingGrantId = this.#inFlightByTarget.get(targetKey);
      if (existingGrantId) {
        const collision = deny(
          ReasonCode.RESOURCE_COLLISION,
          "the target already has an in-flight managed write",
          {
            grantId: held.facts.grantId,
            operation: held.facts.operation,
            repositoryIdentity: held.facts.repositoryIdentity,
            resolvedPath: held.facts.resolvedPath,
          },
        );
        this.recordRevocation(held, held.facts.grantId, collision, "before effect");
        return collision as Decision<T>;
      }
    }
    const prepared = this.captureFilesystemFence(held);
    if (!prepared.allowed) {
      this.recordRevocation(held, granted.value.grantId, prepared, "before effect");
      return prepared as Decision<T>;
    }

    const fence = prepared.value;
    this.#inFlight.set(held.facts.grantId, held);
    if (targetKey) this.#inFlightByTarget.set(targetKey, held.facts.grantId);
    const immediatelyBeforeEffect = this.verifyFilesystemFence(held, fence);
    if (!immediatelyBeforeEffect.allowed) {
      this.clearInFlight(held.facts.grantId, targetKey);
      this.releaseFilesystemFence(fence);
      this.recordRevocation(held, held.facts.grantId, immediatelyBeforeEffect, "before effect");
      return immediatelyBeforeEffect as Decision<T>;
    }

    let result: T | undefined;
    let effectError: unknown;
    let settled: Decision<void>;
    try {
      result = await effect({ grant: this.publicGrant(held.facts) });
    } catch (error) {
      effectError = error;
    } finally {
      settled = this.settle(held, fence);
      this.clearInFlight(held.facts.grantId, targetKey);
      this.releaseFilesystemFence(fence);
    }

    if (!settled.allowed) {
      this.recordRevocation(held, held.facts.grantId, settled, "after effect");
      return deny(settled.reasonCode, settled.message, { ...settled.evidence, effectInvoked: true });
    }
    if (effectError) {
      return deny(ReasonCode.INTERNAL_ERROR, "authorised write effect failed", {
        grantId: held.facts.grantId,
        operation: held.facts.operation,
        effectInvoked: true,
      });
    }

    this.auditConsumed(held.facts);
    return allow(ReasonCode.WRITE_ALLOWED, result as T);
  }

  /**
   * Holds the participating source identities stable from the final freshness read
   * through packet publication. Source writes consult this lease before a grant exists.
   */
  /** Drops grants past their expiry. Called by the watchdog and on each evaluate. */
  expireGrants(): number {
    const now = this.clock.nowIso();
    let dropped = 0;
    for (const [id, held] of this.#grants) {
      if (now >= held.facts.expiresAt) {
        this.#grants.delete(id);
        dropped += 1;
      }
    }
    for (const lease of [...this.#sourceReadLeases.values()]) {
      if (now >= lease.expiresAt) this.releaseSourceReadLease(lease, "expired");
    }
    return dropped;
  }

  /**
   * Freezes managed source identities while a gate re-reads evidence and publishes its
   * decision. A writer that already holds a grant blocks acquisition; a later writer is
   * refused by `decide`, so no source mutation can cross this observation window.
   */
  acquireSourceReadLease(
    runId: string,
    repositoryIdentities: readonly string[],
  ): Decision<{ leaseId: string; release(): void }> {
    this.expireGrants();

    const run = this.db.get<{ state: string }>(`SELECT state FROM runs WHERE run_id = ?`, [runId]);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run for source-read lease", { runId });
    // A freeze is legitimate exactly while a gate is deciding on this run's candidate: the
    // pipeline holds one across verification → review → packet (ACTIVE), and the CEO gate
    // holds one across its own re-read and confirmation (READY_FOR_CEO_REVIEW, and
    // AWAITING_HUMAN while an owner clears a gate item). A run that is queued, revising or
    // terminal has no candidate to publish, so freezing source in its name is refused.
    if (!LEASEABLE_RUN_STATES.has(run.state)) {
      return deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "source-read lease requires a run that is deciding on a candidate", {
        runId,
        state: run.state,
      });
    }

    const identities = [...new Set(repositoryIdentities)];
    if (identities.some((identity) => !identity.trim())) {
      return deny(ReasonCode.INVALID_ARGUMENT, "source-read lease contains an empty repository identity", {
        runId,
        repositoryIdentities,
      });
    }

    const participating = new Set(
      this.db
        .all<{ identity: string }>(
          `SELECT r.identity FROM run_repositories rr
             JOIN repositories r ON r.repository_id = rr.repository_id
            WHERE rr.run_id = ?`,
          [runId],
        )
        .map((row) => row.identity),
    );
    const outsideScope = identities.filter((identity) => !participating.has(identity));
    if (outsideScope.length > 0) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "source-read lease includes a repository outside the run", {
        runId,
        outsideScope,
      });
    }

    const requested = new Set(identities);
    const now = this.clock.nowIso();
    const conflicting = [...this.#grants.values(), ...this.#inFlight.values()].find(
      (held) =>
        SOURCE_MUTATIONS.has(held.facts.operation as WriteOperation) &&
        // An effect already running cannot be cancelled when its admission TTL ends;
        // keep its source fenced until settle, while abandoned grants expire normally.
        (this.#inFlight.has(held.facts.grantId) || now < held.facts.expiresAt) &&
        held.facts.repositoryIdentity !== null &&
        requested.has(held.facts.repositoryIdentity),
    );
    if (conflicting) {
      return deny(ReasonCode.SOURCE_READ_LEASE_HELD, "a managed source write is already authorised", {
        runId,
        repositoryIdentity: conflicting.facts.repositoryIdentity,
        grantId: conflicting.facts.grantId,
      });
    }
    const leaseId = `source_read_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const lease: SourceReadLease = Object.freeze({
      leaseId,
      runId,
      repositoryIdentities: Object.freeze(identities),
      expiresAt: isoPlus(now, SOURCE_READ_LEASE_TTL_MS),
    });
    this.#sourceReadLeases.set(leaseId, lease);
    // Indexed by repository as well, so `decide` can answer "is this identity frozen?"
    // without walking every live lease on the write path.
    for (const identity of identities) {
      const held = this.#sourceReadLeasesByRepository.get(identity) ?? new Set<string>();
      held.add(leaseId);
      this.#sourceReadLeasesByRepository.set(identity, held);
    }
    this.audit.record({
      kind: "SOURCE_READ_LEASE_ACQUIRED",
      reasonCode: ReasonCode.OK,
      runId,
      evidence: {
        operationId: leaseId,
        repositories: identities,
        expiresAt: lease.expiresAt,
      },
    });
    let released = false;
    return allow(ReasonCode.OK, Object.freeze({
      leaseId,
      release: () => {
        if (released) return;
        released = true;
        this.releaseSourceReadLease(lease);
      },
    }));
  }

  assertSourceReadLease(
    runId: string,
    leaseId: string,
    repositoryIdentities: readonly string[],
  ): Decision<void> {
    this.expireGrants();
    const lease = this.#sourceReadLeases.get(leaseId);
    if (!lease || lease.runId !== runId) {
      return deny(ReasonCode.SOURCE_READ_LEASE_REQUIRED, "source-read lease is not held for this run", {
        runId,
        leaseId,
      });
    }
    const required = [...new Set(repositoryIdentities)];
    if (required.some((identity) => !identity.trim())) {
      return deny(ReasonCode.SOURCE_READ_LEASE_REQUIRED, "source-read lease contains an empty repository identity", {
        runId,
        leaseId,
      });
    }
    const run = this.db.get<{ state: string }>(`SELECT state FROM runs WHERE run_id = ?`, [runId]);
    // Same window as acquisition: a freeze stays valid while the run is deciding on its
    // candidate, which includes the CEO-review states the gate re-reads evidence in.
    if (!run || !LEASEABLE_RUN_STATES.has(run.state)) {
      return deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "source-read lease requires a run that is deciding on a candidate", {
        runId,
        state: run?.state ?? null,
      });
    }
    const uncovered = required.filter((identity) => !lease.repositoryIdentities.includes(identity));
    if (uncovered.length > 0) {
      return deny(ReasonCode.SOURCE_READ_LEASE_REQUIRED, "source-read lease does not cover every required repository", {
        runId,
        leaseId,
        uncovered,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  // -------------------------------------------------------------------------

  private holdOrExpose(request: GuardRequest, decision: Decision<GuardGrant>): Decision<GuardGrant> {
    if (!decision.allowed) return decision;
    if (READ_OPERATIONS.has(decision.value.operation)) {
      return allow(decision.reasonCode, this.publicGrant(decision.value), decision.evidence);
    }

    const facts = this.freezeGrant(decision.value);
    const snapshot = Object.freeze({
      operation: facts.operation,
      targetPath: request.targetPath ?? null,
      repositoryIdentity: facts.repositoryIdentity,
      targetBranch: facts.targetBranch,
      targetWorktreeId: facts.targetWorktreeId,
      worktreeAction: facts.worktreeAction,
      taskId: facts.taskId,
      taskReceiptId: facts.taskReceiptId,
      assignedWorktreeId: facts.assignedWorktreeId,
      projectId: facts.projectId,
      runId: facts.runId,
      sessionId: facts.sessionId,
      bindingGeneration: facts.bindingGeneration,
      claimedClassification: request.claimedClassification ?? null,
      actor: request.actor ?? null,
      // Retain the opaque daemon capability for the pre/post-effect revalidation. Dropping
      // it here would let the first guard pass but make the fenced settle phase deny after
      // GitHub had already accepted the write.
      daemonFinalizerAuthority: request.daemonFinalizerAuthority ?? null,
      bootstrapManifestAuthority: request.bootstrapManifestAuthority ?? null,
      repairWorktreeAuthority: request.repairWorktreeAuthority ?? null,
    });
    this.#grants.set(facts.grantId, { facts, request: snapshot });
    return allow(decision.reasonCode, this.publicGrant(facts), decision.evidence);
  }

  private releaseSourceReadLease(lease: SourceReadLease, action: "released" | "expired" = "released"): void {
    if (this.#sourceReadLeases.get(lease.leaseId) !== lease) return;
    this.#sourceReadLeases.delete(lease.leaseId);
    for (const identity of lease.repositoryIdentities) {
      const held = this.#sourceReadLeasesByRepository.get(identity);
      if (!held) continue;
      held.delete(lease.leaseId);
      if (held.size === 0) this.#sourceReadLeasesByRepository.delete(identity);
    }
    this.audit.record({
      kind: "SOURCE_READ_LEASE_RELEASED",
      reasonCode: ReasonCode.OK,
      runId: lease.runId,
      evidence: {
        action,
        operationId: lease.leaseId,
        repositories: lease.repositoryIdentities,
        expiresAt: lease.expiresAt,
      },
    });
  }

  private sourceReadLeaseConflict(operation: WriteOperation, repositoryIdentity: string): Decision<never> | null {
    if (!SOURCE_MUTATIONS.has(operation)) return null;
    const leaseIds = this.#sourceReadLeasesByRepository.get(repositoryIdentity);
    if (!leaseIds || leaseIds.size === 0) return null;
    const leases = [...leaseIds]
      .map((leaseId) => this.#sourceReadLeases.get(leaseId))
      .filter((lease): lease is SourceReadLease => lease !== undefined);
    if (leases.length === 0) return null;
    return deny(
      ReasonCode.SOURCE_READ_LEASE_CONFLICT,
      "a final candidate source-read lease prevents source mutation",
      {
        operation,
        repositoryIdentity,
        leaseIds: leases.map((lease) => lease.leaseId),
        leaseRunIds: leases.map((lease) => lease.runId),
      },
    );
  }

  private activate(grantId: string): Decision<HeldGrant> {
    const held = this.#grants.get(grantId);
    if (!held) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "unknown or already-expired grant", { grantId });
    }
    if (this.clock.nowIso() >= held.facts.expiresAt) {
      this.#grants.delete(grantId);
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "grant expired before the write", {
        grantId,
        expiresAt: held.facts.expiresAt,
      });
    }

    const revalidated = this.revalidate(held);
    if (!revalidated.allowed) {
      this.#grants.delete(grantId);
      this.recordRevocation(held, grantId, revalidated, "before effect");
      return revalidated as Decision<HeldGrant>;
    }
    this.#grants.delete(grantId);
    return allow(ReasonCode.WRITE_ALLOWED, held);
  }

  private settle(held: HeldGrant, fence: FilesystemFence | null): Decision<void> {
    if (this.#inFlight.get(held.facts.grantId) !== held) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "in-flight write authorisation was not retained", {
        grantId: held.facts.grantId,
      });
    }
    const filesystem = this.verifyFilesystemFence(held, fence, "after effect");
    if (!filesystem.allowed) return filesystem;
    return this.revalidate(held);
  }

  private revalidate(held: HeldGrant): Decision<void> {
    const fresh = this.decide(held.request);
    if (!fresh.allowed) return fresh as Decision<void>;
    if (!this.sameAuthorisationFacts(held.facts, fresh.value)) {
      return deny(
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
        "authorisation facts changed between evaluation and the write",
        {
          grantId: held.facts.grantId,
          authorised: this.authorisationFacts(held.facts),
          current: this.authorisationFacts(fresh.value),
        },
      );
    }
    return this.renewRequiredClaims(held.facts);
  }

  private sameAuthorisationFacts(left: GuardGrant, right: GuardGrant): boolean {
    const a = this.authorisationFacts(left);
    const b = this.authorisationFacts(right);
    return Object.entries(a).every(([key, value]) => b[key] === value);
  }

  private authorisationFacts(grant: GuardGrant): Record<string, string | number | null> {
    return {
      runId: grant.runId,
      sessionId: grant.sessionId,
      roleKey: grant.roleKey,
      bindingGeneration: grant.bindingGeneration,
      operation: grant.operation,
      repositoryIdentity: grant.repositoryIdentity,
      resolvedPath: grant.resolvedPath,
      targetBranch: grant.targetBranch,
      targetWorktreeId: grant.targetWorktreeId,
      worktreeAction: grant.worktreeAction,
      taskId: grant.taskId,
      taskReceiptId: grant.taskReceiptId,
      assignedWorktreeId: grant.assignedWorktreeId,
      projectId: grant.projectId,
    };
  }

  private renewRequiredClaims(grant: GuardGrant): Decision<void> {
    if (!grant.repositoryIdentity || !grant.runId) return allow(ReasonCode.OK, undefined);

    // #664 — deliberately plain `tx()`, not `txDecision`, same reasoning as
    // github-kernel.ts's assertClaim: the expiry sweep below is unconditional
    // housekeeping a later denial must not undo.
    return this.db.tx(() => {
      // The partial unique indexes define a HELD row as occupied. Sweep before reading so
      // the guard never treats an expired row as absent while SQLite still reserves it.
      this.expireOverdueClaims();
      const rows = this.requiredClaims(grant);
      if (!rows.allowed) return rows as Decision<void>;
      const required = rows.value;
      if (required.length === 0) {
        return deny(
          ReasonCode.WRITE_PATH_NOT_CLAIMED,
          "the run holds no live claim on this repository, so the write cannot be fenced",
          { grantId: grant.grantId, runId: grant.runId, repositoryIdentity: grant.repositoryIdentity },
        );
      }

      const deadline = isoPlus(this.clock.nowIso(), CLAIM_LEASE_EXTENSION_MS);
      for (const claim of required) {
        const updated = this.db.run(
          `UPDATE resource_claims
              SET expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE ? END
            WHERE claim_id = ? AND status = 'HELD'`,
          [deadline, deadline, claim.claim_id],
        );
        if (updated.changes !== 1) {
          return deny(
            ReasonCode.WRITE_PATH_NOT_CLAIMED,
            "a required claim changed while the write was being fenced",
            { grantId: grant.grantId, claimId: claim.claim_id },
          );
        }
      }
      return allow(ReasonCode.OK, undefined);
    });
  }

  private requiredClaims(grant: GuardGrant): Decision<ClaimRow[]> {
    const common = [grant.runId, grant.repositoryIdentity];
    const query = (where: string, params: unknown[]): ClaimRow[] =>
      this.db.all<ClaimRow>(
        `SELECT c.claim_id, c.expires_at FROM resource_claims c
           JOIN runs r ON r.run_id = c.run_id
          WHERE c.run_id = ? AND c.repository_identity = ? AND c.status = 'HELD'
            AND c.owner_binding_generation = r.owner_binding_generation
            AND ${where}`,
        [...common, ...params],
      );

    const required: ClaimRow[] = [];
    if (grant.operation === WriteOperation.GIT_WORKTREE) {
      const repository = query("1 = 1", []);
      const identity = grant.repositoryIdentity;
      if (repository.length === 0 || !identity) return this.claimMissing(grant, "repository", identity ?? "");
      return allow(ReasonCode.OK, repository);
    }
    if (grant.targetBranch) {
      const branch = query("c.branch = ?", [grant.targetBranch]);
      if (branch.length === 0) return this.claimMissing(grant, "branch", grant.targetBranch);
      required.push(...branch);
    }
    if (grant.targetWorktreeId && !grant.assignedWorktreeId) {
      const worktree = query("c.worktree_id = ?", [grant.targetWorktreeId]);
      if (worktree.length === 0) return this.claimMissing(grant, "worktree", grant.targetWorktreeId);
      required.push(...worktree);
    }
    if (required.length === 0 && grant.resolvedPath) {
      const relative = this.relativePath(grant);
      if (!relative) return this.claimMissing(grant, "path", grant.resolvedPath);
      const path = query("c.declared_path = ? OR c.declared_path = '.'", [relative]);
      if (path.length === 0) return this.claimMissing(grant, "path", relative);
      required.push(...path);
    }
    if (required.length === 0) {
      // A local git operation can name only a registered repository; remote writes are
      // refused earlier unless they name a branch/ref.
      const repository = query("1 = 1", []);
      const identity = grant.repositoryIdentity;
      if (repository.length === 0 || !identity) return this.claimMissing(grant, "repository", identity ?? "");
      required.push(repository[0]!);
    }

    return allow(
      ReasonCode.OK,
      [...new Map(required.map((claim) => [claim.claim_id, claim])).values()],
    );
  }

  private claimMissing(
    grant: GuardGrant,
    resource: "branch" | "worktree" | "path" | "repository",
    value: string,
  ): Decision<ClaimRow[]> {
    return deny(
      ReasonCode.WRITE_PATH_NOT_CLAIMED,
      `the run holds no live claim covering the target ${resource}`,
      {
        grantId: grant.grantId,
        runId: grant.runId,
        repositoryIdentity: grant.repositoryIdentity,
        [resource]: value,
      },
    );
  }

  private relativePath(grant: GuardGrant): string | null {
    if (!grant.resolvedPath || !grant.repositoryIdentity) return null;
    const repository = this.db.get<{ checkout_path: string }>(
      `SELECT checkout_path FROM repositories WHERE identity = ?`,
      [grant.repositoryIdentity],
    );
    if (!repository) return null;
    const checkout = grant.assignedWorktreeId
      ? this.probe.canonical(grant.assignedWorktreeId)
      : this.probe.canonical(repository.checkout_path);
    return isWithin(checkout, grant.resolvedPath)
      ? grant.resolvedPath.slice(checkout.length + 1) || "."
      : null;
  }

  private captureFilesystemFence(held: HeldGrant): Decision<FilesystemFence | null> {
    const operation = held.facts.operation as WriteOperation;
    if (
      READ_OPERATIONS.has(operation) ||
      operation === WriteOperation.MANIFEST_CHANGE ||
      (OPERATION_CLASS[operation] !== "FILESYSTEM" && operation !== WriteOperation.GIT_WORKTREE)
    ) {
      return allow(ReasonCode.OK, null);
    }
    if (!held.request.targetPath || !held.facts.resolvedPath) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "filesystem grant lost its target path", {
        grantId: held.facts.grantId,
      });
    }

    let parentFd: number | null = null;
    let toplevelFd: number | null = null;
    let targetFd: number | null = null;
    try {
      const requestedParent = dirname(held.request.targetPath);
      const canonicalParent = this.nearestExistingDirectory(requestedParent);
      parentFd = openSync(canonicalParent, "r");
      const parentStat = fstatSync(parentFd);
      if (!parentStat.isDirectory()) {
        closeSync(parentFd);
        return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "write parent is not a directory", {
          grantId: held.facts.grantId,
          parent: canonicalParent,
        });
      }

      let toplevelIdentity: NodeIdentity | null = null;
      const probed = this.probe.probeWorktree(held.facts.resolvedPath);
      if (probed.status === "ERROR") {
        closeSync(parentFd);
        return deny(ReasonCode.PROBE_FAILED, "could not determine the worktree for the write fence", {
          grantId: held.facts.grantId,
          reason: probed.reason,
        });
      }
      const toplevel = probed.status === "INSIDE" ? this.probe.canonical(probed.toplevel) : null;
      if (toplevel) {
        toplevelFd = openSync(toplevel, "r");
        toplevelIdentity = this.nodeIdentity(fstatSync(toplevelFd));
      }

      let targetIdentity: NodeIdentity | null = null;
      let targetExisted = false;
      try {
        targetFd = openSync(held.facts.resolvedPath, NO_FOLLOW_READ);
        targetIdentity = this.nodeIdentity(fstatSync(targetFd));
        targetExisted = true;
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }

      return allow(ReasonCode.OK, {
        requestedPath: held.request.targetPath,
        requestedParent: canonicalParent,
        resolvedPath: held.facts.resolvedPath,
        parentFd,
        parent: this.nodeIdentity(parentStat),
        toplevel,
        toplevelFd,
        toplevelIdentity,
        targetFd,
        targetIdentity,
        targetExisted,
      });
    } catch (error) {
      if (targetFd != null) closeSync(targetFd);
      if (toplevelFd != null) closeSync(toplevelFd);
      if (parentFd != null) closeSync(parentFd);
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "could not hold a stable filesystem fence", {
        grantId: held.facts.grantId,
        reason: error instanceof Error ? error.message : "unknown filesystem error",
      });
    }
  }

  private verifyFilesystemFence(
    held: HeldGrant,
    fence: FilesystemFence | null,
    phase: "before effect" | "after effect" = "before effect",
  ): Decision<void> {
    if (!fence) return allow(ReasonCode.OK, undefined);
    const operation = held.facts.operation as WriteOperation;
    try {
      if (!this.sameNode(this.nodeIdentity(fstatSync(fence.parentFd)), fence.parent)) {
        return this.fenceLost(held, "the held parent directory changed");
      }
      if (!this.sameNode(this.nodeIdentity(statSync(fence.requestedParent)), fence.parent)) {
        return this.fenceLost(held, "the path to the parent directory changed");
      }
      if (this.probe.canonical(fence.requestedPath) !== fence.resolvedPath) {
        return this.fenceLost(held, "the canonical target changed during the effect");
      }
      if (fence.targetExisted && fence.targetFd != null && fence.targetIdentity) {
        if (!this.sameNode(this.nodeIdentity(fstatSync(fence.targetFd)), fence.targetIdentity)) {
          return this.fenceLost(held, "the held target inode changed");
        }
        let currentTargetFd: number | null = null;
        try {
          currentTargetFd = openSync(fence.resolvedPath, NO_FOLLOW_READ);
          if (!this.sameNode(this.nodeIdentity(fstatSync(currentTargetFd)), fence.targetIdentity)) {
            return this.fenceLost(held, "the target inode changed during the effect");
          }
        } catch (error) {
          if (isMissingPath(error)) {
            // Only a remove/cleanup grant for its own disposable tree may intentionally
            // leave the target absent. A prune-shaped checkout grant must never turn an
            // unrelated deletion into success merely because the target disappeared.
            const disposesOwnTarget =
              operation === WriteOperation.GIT_WORKTREE &&
              phase === "after effect" &&
              (held.request.worktreeAction === WorktreeAction.REMOVE ||
                held.request.worktreeAction === WorktreeAction.CLEANUP) &&
              held.facts.targetWorktreeId === held.facts.resolvedPath;
            const repairDisposal =
              operation === WriteOperation.GIT_WORKTREE &&
              phase === "after effect" &&
              RepairWorktreeAuthorityToken.belongsTo(held.request.repairWorktreeAuthority, this);
            if (disposesOwnTarget || repairDisposal) {
              return allow(ReasonCode.OK, undefined);
            }
            return this.fenceLost(held, "the fenced target was removed");
          }
          throw error;
        } finally {
          if (currentTargetFd != null) closeSync(currentTargetFd);
        }
      } else {
        let currentTargetFd: number | null = null;
        try {
          currentTargetFd = openSync(fence.resolvedPath, NO_FOLLOW_READ);
          if (phase === "before effect") {
            return this.fenceLost(held, "a target appeared before the filesystem effect");
          }
        } catch (error) {
          if (!isMissingPath(error)) throw error;
        } finally {
          if (currentTargetFd != null) closeSync(currentTargetFd);
        }
      }
      if (fence.toplevel && fence.toplevelFd != null && fence.toplevelIdentity) {
        if (!this.sameNode(this.nodeIdentity(fstatSync(fence.toplevelFd)), fence.toplevelIdentity)) {
          return this.fenceLost(held, "the held git worktree changed");
        }
        const probed = this.probe.probeWorktree(fence.resolvedPath);
        if (
          probed.status !== "INSIDE" ||
          this.probe.canonical(probed.toplevel) !== fence.toplevel ||
          !this.sameNode(this.nodeIdentity(statSync(fence.toplevel)), fence.toplevelIdentity)
        ) {
          return this.fenceLost(held, "the git worktree identity changed during the effect");
        }
      }
      return allow(ReasonCode.OK, undefined);
    } catch (error) {
      return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "could not reverify the filesystem fence", {
        grantId: held.facts.grantId,
        reason: error instanceof Error ? error.message : "unknown filesystem error",
      });
    }
  }

  private releaseFilesystemFence(fence: FilesystemFence | null): void {
    if (!fence) return;
    if (fence.targetFd != null) closeSync(fence.targetFd);
    if (fence.toplevelFd != null) closeSync(fence.toplevelFd);
    closeSync(fence.parentFd);
  }

  private nearestExistingDirectory(path: string): string {
    let cursor = this.probe.canonical(path);
    for (let hops = 0; hops < 64; hops += 1) {
      try {
        if (statSync(cursor).isDirectory()) return cursor;
        cursor = dirname(cursor);
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        const parent = dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
      }
    }
    throw new Error("could not find an existing directory for the filesystem fence");
  }

  private inFlightTargetKey(grant: GuardGrant): string | null {
    if (!grant.repositoryIdentity) return null;
    const operation = grant.operation as WriteOperation;
    if (OPERATION_CLASS[operation] === "REMOTE") {
      // Remote writes have no local path to fence. Their stable branch/ref is therefore
      // the serialization key; validation refuses a remote grant without one (#356).
      return grant.targetBranch
        ? JSON.stringify([grant.repositoryIdentity, operation, grant.targetBranch])
        : null;
    }
    if (operation === WriteOperation.GIT_WORKTREE && grant.targetWorktreeId) {
      // `prune` executes from the repository checkout, but it belongs to the lifecycle of
      // one disposable tree. Keying it by that tree preserves both exact-tree exclusion
      // and independent verification worktrees' concurrency.
      return JSON.stringify([grant.repositoryIdentity, grant.targetWorktreeId]);
    }
    if (!grant.resolvedPath) return null;
    return JSON.stringify([grant.repositoryIdentity, grant.resolvedPath]);
  }

  private clearInFlight(grantId: string, targetKey: string | null): void {
    this.#inFlight.delete(grantId);
    if (targetKey && this.#inFlightByTarget.get(targetKey) === grantId) {
      this.#inFlightByTarget.delete(targetKey);
    }
  }

  private fenceLost(held: HeldGrant, message: string): Decision<void> {
    return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, message, {
      grantId: held.facts.grantId,
      targetPath: held.facts.resolvedPath,
      repositoryIdentity: held.facts.repositoryIdentity,
    });
  }

  private nodeIdentity(stat: Stats): NodeIdentity {
    return { dev: stat.dev, ino: stat.ino };
  }

  private sameNode(left: NodeIdentity, right: NodeIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private auditConsumed(grant: GuardGrant): void {
    this.audit.record({
      kind: "MANAGED_WRITE_GUARD_CONSUMED",
      reasonCode: ReasonCode.WRITE_ALLOWED,
      runId: grant.runId,
      sessionId: grant.sessionId,
      roleKey: grant.roleKey,
      evidence: {
        grantId: grant.grantId,
        operation: grant.operation,
        repositoryIdentity: grant.repositoryIdentity,
        resolvedPath: grant.resolvedPath,
        targetBranch: grant.targetBranch,
        targetWorktreeId: grant.targetWorktreeId,
        worktreeAction: grant.worktreeAction,
        taskId: grant.taskId,
        taskReceiptId: grant.taskReceiptId,
        assignedWorktreeId: grant.assignedWorktreeId,
        projectId: grant.projectId,
      },
    });
  }

  private recordRevocation(
    held: HeldGrant,
    grantId: string,
    decision: Decision<unknown>,
    phase: "before effect" | "after effect",
  ): void {
    this.audit.record({
      kind: "MANAGED_WRITE_GUARD_REVOKED",
      reasonCode: decision.reasonCode,
      runId: held.facts.runId,
      sessionId: held.facts.sessionId,
      roleKey: held.facts.roleKey,
      evidence: {
        grantId,
        phase,
        ...decision.evidence,
      },
    });
  }

  private freezeGrant(grant: GuardGrant): Readonly<GuardGrant> {
    return Object.freeze({ ...grant });
  }

  private publicGrant(grant: GuardGrant): GuardGrant {
    return Object.freeze({ ...grant });
  }

  private decide(request: GuardRequest): Decision<GuardGrant> {
    this.expireGrants();

    if (READ_OPERATIONS.has(request.operation)) {
      // §6.1 — read-only repository analysis stays DIRECT.
      return this.direct(request, ReasonCode.DIRECT_READ_ONLY_ALLOWED, null, null);
    }

    // `HELD` is what the partial unique indexes enforce. Expire stale leases in the
    // same immediate transaction that reads claims, so a lease is never ignored by the
    // guard while it still occupies the database coordination slot (#358).
    return this.db.tx(() => this.decideWrite(request));
  }

  private decideWrite(request: GuardRequest): Decision<GuardGrant> {
    this.expireOverdueClaims();

    const operation = request.operation as WriteOperation;
    const operationClass = OPERATION_CLASS[operation];
    if (!operationClass) {
      return deny(ReasonCode.INVALID_ARGUMENT, "unknown guard operation", { operation: request.operation });
    }

    // --- argument validation, per operation class --------------------------
    if (request.targetPath != null && !isAbsolute(request.targetPath)) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "target path must be absolute; a relative path cannot be authorised reliably",
        { operation, targetPath: request.targetPath },
      );
    }
    if (request.targetBranch !== undefined && request.targetBranch !== null && !request.targetBranch.trim()) {
      return deny(ReasonCode.INVALID_ARGUMENT, "target branch must not be empty", { operation });
    }
    if (
      request.targetWorktreeId !== undefined &&
      request.targetWorktreeId !== null &&
      !request.targetWorktreeId.trim()
    ) {
      return deny(ReasonCode.INVALID_ARGUMENT, "target worktree id must not be empty", { operation });
    }
    if (request.targetWorktreeId && !isAbsolute(request.targetWorktreeId)) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "target worktree id must be an absolute canonical worktree path",
        { operation, targetWorktreeId: request.targetWorktreeId },
      );
    }
    if (
      request.worktreeAction !== undefined &&
      request.worktreeAction !== null &&
      !WORKTREE_ACTIONS.has(request.worktreeAction)
    ) {
      return deny(ReasonCode.INVALID_ARGUMENT, "unknown GIT_WORKTREE lifecycle action", {
        operation,
        worktreeAction: request.worktreeAction,
      });
    }
    if (
      request.assignedWorktreeId !== undefined &&
      request.assignedWorktreeId !== null &&
      !request.assignedWorktreeId.trim()
    ) {
      return deny(ReasonCode.INVALID_ARGUMENT, "assigned worktree id must not be empty", { operation });
    }
    if (request.assignedWorktreeId && !isAbsolute(request.assignedWorktreeId)) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "assigned worktree id must be an absolute canonical worktree path",
        { operation, assignedWorktreeId: request.assignedWorktreeId },
      );
    }
    const taskBoundRuntimeWrite =
      operation === WriteOperation.FILE_MUTATION &&
      (request.actor === "runtime-cli" ||
        request.taskId != null ||
        request.taskReceiptId != null ||
        request.assignedWorktreeId != null);
    if (taskBoundRuntimeWrite) {
      const missing = [
        ["taskId", request.taskId],
        ["taskReceiptId", request.taskReceiptId],
        ["assignedWorktreeId", request.assignedWorktreeId],
      ].filter(([, value]) => typeof value !== "string" || value.trim().length === 0).map(([name]) => name);
      if (missing.length > 0) {
        return deny(
          ReasonCode.WRITE_REQUIRES_MANAGED_RUN,
          "runtime file mutation must name its task receipt and assigned worktree",
          { operation, missing },
        );
      }
    }
    if (operationClass === "FILESYSTEM" && operation !== WriteOperation.MANIFEST_CHANGE && !request.targetPath) {
      return deny(ReasonCode.INVALID_ARGUMENT, `${operation} requires a target path`, { operation });
    }
    if (
      operation === WriteOperation.MANIFEST_CHANGE &&
      !request.projectId &&
      (request.runId != null || request.sessionId != null || request.bindingGeneration != null)
    ) {
      return deny(ReasonCode.INVALID_ARGUMENT, "MANIFEST_CHANGE requires a project identity", { operation });
    }
    if (operation === WriteOperation.GIT_WORKTREE) {
      if (!request.targetPath || !request.repositoryIdentity || !request.targetWorktreeId || !request.worktreeAction) {
        return deny(
          ReasonCode.INVALID_ARGUMENT,
          "GIT_WORKTREE requires a target path, repository identity, disposable tree and lifecycle action",
          { operation },
        );
      }
    }
    if (operationClass === "REMOTE" && !request.repositoryIdentity) {
      return deny(ReasonCode.INVALID_ARGUMENT, `${operation} requires a repository identity`, { operation });
    }
    if (operationClass === "REMOTE" && !request.targetBranch) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        `${operation} requires the branch or remote ref it will mutate`,
        { operation },
      );
    }
    if (operationClass === "GIT_LOCAL" && !request.targetPath && !request.repositoryIdentity) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        `${operation} requires a target path or a repository identity`,
        { operation },
      );
    }
    if (operation === WriteOperation.GIT_BRANCH && !request.targetBranch) {
      return deny(ReasonCode.INVALID_ARGUMENT, "GIT_BRANCH requires the branch it will mutate", {
        operation,
      });
    }

    // --- resolve the filesystem context ------------------------------------
    let resolvedPath: string | null = null;
    let toplevel: string | null = null;
    if (request.targetPath) {
      resolvedPath = this.probe.canonical(request.targetPath);
      const probed = this.probe.probeWorktree(resolvedPath);
      if (probed.status === "ERROR") {
        // CP-HI-08 — an unanswerable probe is not evidence of being outside a repository.
        return deny(
          ReasonCode.PROBE_FAILED,
          "could not determine whether the target is inside a repository",
          { operation, resolvedPath, reason: probed.reason },
        );
      }
      toplevel = probed.status === "INSIDE" ? this.probe.canonical(probed.toplevel) : null;
    }

    const registered = resolvedPath ? this.registeredContaining(resolvedPath) : null;
    const contractWrite =
      operation === WriteOperation.MANIFEST_CHANGE ||
      operation === WriteOperation.VERIFICATION_CONTRACT_CHANGE;
    const projectNatured =
      operationClass !== "FILESYSTEM" ||
      contractWrite ||
      request.runId != null ||
      toplevel !== null ||
      registered !== null;

    if (!projectNatured) {
      if (!resolvedPath || !this.isDirectArtifactPath(resolvedPath)) {
        return deny(
          ReasonCode.DIRECT_WRITE_ROOT_REQUIRED,
          "DIRECT mutation needs an explicitly configured independent-artifact root",
          { operation, resolvedPath, directWriteRoots: this.#directWriteRoots },
        );
      }
      return this.direct(request, ReasonCode.DIRECT_READ_ONLY_ALLOWED, resolvedPath, null, {
        projectNatured: false,
        directWriteRoot: this.#directWriteRoots.find((root) => isWithin(root, resolvedPath)) ?? null,
      });
    }

    const runlessBootstrapManifest =
      operation === WriteOperation.MANIFEST_CHANGE &&
      !request.runId &&
      !request.sessionId &&
      request.bindingGeneration == null &&
      BootstrapManifestAuthorityToken.belongsTo(request.bootstrapManifestAuthority, this);
    if (runlessBootstrapManifest) {
      if (!request.projectId) {
        return deny(ReasonCode.INVALID_ARGUMENT, "MANIFEST_CHANGE requires a project identity", { operation });
      }
      const issuedAt = this.clock.nowIso();
      return allow(ReasonCode.WRITE_ALLOWED, {
        grantId: `grant_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        classification: "MANAGED",
        operation,
        runId: null,
        sessionId: null,
        roleKey: null,
        bindingGeneration: null,
        repositoryIdentity: null,
        resolvedPath: null,
        targetBranch: null,
        targetWorktreeId: null,
        worktreeAction: null,
        taskId: null,
        taskReceiptId: null,
        assignedWorktreeId: null,
        projectId: request.projectId ?? null,
        issuedAt,
        expiresAt: isoPlus(issuedAt, GRANT_TTL_MS),
      }, { projectNatured: true, bootstrap: true });
    }

    const runlessRepairWorktree =
      operation === WriteOperation.GIT_WORKTREE &&
      !request.runId &&
      !request.sessionId &&
      request.bindingGeneration == null &&
      RepairWorktreeAuthorityToken.belongsTo(request.repairWorktreeAuthority, this);
    if (runlessRepairWorktree) {
      const repository = request.repositoryIdentity
        ? this.db.get<{ checkout_path: string }>(
            `SELECT checkout_path FROM repositories WHERE identity = ?`,
            [request.repositoryIdentity],
          )
        : null;
      if (!repository || !request.targetWorktreeId || this.probe.canonical(request.targetWorktreeId) !== this.probe.canonical(repository.checkout_path)) {
        return deny(
          ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
          "repair worktree authority must name a registered repository checkout",
          {
            repositoryIdentity: request.repositoryIdentity ?? null,
            targetWorktreeId: request.targetWorktreeId ?? null,
          },
        );
      }
      const lease = this.sourceReadLeaseConflict(operation, request.repositoryIdentity!);
      if (lease) return lease as Decision<GuardGrant>;
      const issuedAt = this.clock.nowIso();
      return allow(ReasonCode.WRITE_ALLOWED, {
        grantId: `grant_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        classification: "MANAGED",
        operation,
        runId: null,
        sessionId: null,
        roleKey: null,
        bindingGeneration: null,
        repositoryIdentity: request.repositoryIdentity ?? null,
        resolvedPath,
        targetBranch: request.targetBranch ?? null,
        targetWorktreeId: this.probe.canonical(request.targetWorktreeId),
        worktreeAction: request.worktreeAction ?? null,
        taskId: null,
        taskReceiptId: null,
        assignedWorktreeId: null,
        projectId: null,
        issuedAt,
        expiresAt: isoPlus(issuedAt, GRANT_TTL_MS),
      }, { projectNatured: true, repair: true });
    }

    if (!request.runId || !request.sessionId || request.bindingGeneration == null) {
      return deny(
        ReasonCode.WRITE_REQUIRES_MANAGED_RUN,
        "project-natured write requires a managed run identity",
        { projectNatured: true, operation, resolvedPath, toplevel },
      );
    }

    const run = this.db.get<RunAuthRow>(
      `SELECT run_id, state, project_id, owner_session_id, owner_binding_generation, owner_role_key
         FROM runs WHERE run_id = ?`,
      [request.runId],
    );
    if (!run) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "run does not exist", { runId: request.runId });
    }

    const taskReceipt = taskBoundRuntimeWrite
      ? this.authorizeTaskReceipt(run, request, resolvedPath)
      : allow(ReasonCode.OK, null);
    if (!taskReceipt.allowed) return taskReceipt as Decision<GuardGrant>;

    if (operation === WriteOperation.MANIFEST_CHANGE) {
      const project = this.authorizeManifestProject(run, request.projectId!);
      if (!project.allowed) return project as Decision<GuardGrant>;
      if (
        run.state !== RunState.ACTIVE &&
        run.state !== RunState.READY_FOR_CEO_REVIEW &&
        run.state !== RunState.COMPLETED
      ) {
        return deny(
          ReasonCode.WRITE_RUN_NOT_ACTIVE,
          `MANIFEST_CHANGE is not admitted while ${run.state}`,
          { runId: run.run_id, state: run.state, operation },
        );
      }
      const identity = this.authorizeSession(run, request);
      if (!identity.allowed) return identity as Decision<GuardGrant>;
      const issuedAt = this.clock.nowIso();
      return allow(ReasonCode.WRITE_ALLOWED, {
        grantId: `grant_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        classification: "MANAGED",
        operation,
        runId: run.run_id,
        sessionId: request.sessionId!,
        roleKey: identity.value.roleKey,
        bindingGeneration: identity.value.generation,
        repositoryIdentity: null,
        resolvedPath: null,
        targetBranch: null,
        targetWorktreeId: null,
        worktreeAction: null,
        taskId: null,
        taskReceiptId: null,
        assignedWorktreeId: null,
        projectId: request.projectId!,
        issuedAt,
        expiresAt: isoPlus(issuedAt, GRANT_TTL_MS),
      }, { projectNatured: true, role: identity.value.role });
    }
    // Validate the concrete repository/path before state admission. A closed run must not
    // turn an out-of-scope remote target into an apparently well-formed request merely
    // because the state refusal happens first.
    const target = this.authorizeTarget({
      run,
      request,
      operation,
      resolvedPath,
      toplevel,
      taskReceipt: taskReceipt.value,
    });
    if (!target.allowed) return target as Decision<GuardGrant>;
    const daemonFinalizationWrite =
      DAEMON_FINALIZATION_OPERATIONS.has(operation) &&
      DaemonFinalizerAuthorityToken.belongsTo(request.daemonFinalizerAuthority, this);
    if (run.state === RunState.ACTIVE) {
      if (!ACTIVE_SOURCE_OPERATIONS.has(operation)) {
        return deny(
          ReasonCode.WRITE_RUN_NOT_ACTIVE,
          `${operation} is not a source write admitted while ACTIVE`,
          { runId: run.run_id, state: run.state, operation },
        );
      }
    } else if (DAEMON_FINALIZATION_STATES.has(run.state)) {
      if (!DAEMON_FINALIZATION_OPERATIONS.has(operation)) {
        return deny(
          ReasonCode.WRITE_RUN_NOT_ACTIVE,
          `${operation} is not a daemon finalization operation in ${run.state}`,
          { runId: run.run_id, state: run.state, operation },
        );
      }
      if (!daemonFinalizationWrite) {
        return deny(
          ReasonCode.MERGE_AUTHORITY_DENIED,
          "post-approval GitHub writes require the daemon finalizer capability",
          { runId: run.run_id, state: run.state, operation },
        );
      }
    } else {
      return deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, `run is ${run.state}, not writable`, {
        runId: run.run_id,
        state: run.state,
        operation,
      });
    }

    const identity = this.authorizeSession(run, request);
    if (!identity.allowed) return identity as Decision<GuardGrant>;

    const resources = this.authorizeResources({
      request,
      operation,
      operationClass,
      participant: target.value,
      resolvedPath,
      toplevel,
    });
    if (!resources.allowed) return resources as Decision<GuardGrant>;

    const sourceReadLease = this.sourceReadLeaseConflict(operation, target.value.identity);
    if (sourceReadLease) return sourceReadLease as Decision<GuardGrant>;

    const conflict = this.claimConflict(run.run_id, target.value, resources.value);
    if (conflict) return conflict as Decision<GuardGrant>;

    const issuedAt = this.clock.nowIso();
    return allow(
      ReasonCode.WRITE_ALLOWED,
      {
        grantId: `grant_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        classification: "MANAGED",
        operation,
        runId: run.run_id,
        sessionId: request.sessionId,
        roleKey: identity.value.roleKey,
        bindingGeneration: identity.value.generation,
        repositoryIdentity: target.value.identity,
        resolvedPath,
        targetBranch: resources.value.branch,
        targetWorktreeId: resources.value.worktreeId,
        worktreeAction: resources.value.worktreeAction,
        taskId: request.taskId ?? null,
        taskReceiptId: request.taskReceiptId ?? null,
        assignedWorktreeId: request.assignedWorktreeId
          ? this.probe.canonical(request.assignedWorktreeId)
          : null,
        projectId: null,
        issuedAt,
        expiresAt: isoPlus(issuedAt, GRANT_TTL_MS),
      },
      { projectNatured: true, role: identity.value.role },
    );
  }

  private direct(
    request: GuardRequest,
    reasonCode: ReasonCode,
    resolvedPath: string | null,
    repositoryIdentity: string | null,
    evidence: Record<string, unknown> = {},
  ): Decision<GuardGrant> {
    const issuedAt = this.clock.nowIso();
    return allow(
      reasonCode,
      {
        grantId: `direct_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        classification: "DIRECT",
        operation: request.operation,
        runId: null,
        sessionId: null,
        roleKey: null,
        bindingGeneration: null,
        repositoryIdentity,
        resolvedPath,
        targetBranch: null,
        targetWorktreeId: null,
        worktreeAction: null,
        taskId: null,
        taskReceiptId: null,
        assignedWorktreeId: null,
        projectId: null,
        issuedAt,
        expiresAt: isoPlus(issuedAt, GRANT_TTL_MS),
      },
      evidence,
    );
  }

  /**
   * The writing session must hold a *current* binding on this run, in a role that is
   * allowed to produce. A revoked or superseded generation is refused (§15.7), and a
   * blind reviewer is refused outright (CP-HI-04).
   */
  private authorizeSession(
    run: RunAuthRow,
    request: GuardRequest,
  ): Decision<{ roleKey: string; role: string; generation: number }> {
    if (!run.owner_session_id || run.owner_binding_generation == null || !run.owner_role_key) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner binding", {
        runId: run.run_id,
      });
    }

    const ownerCurrent = this.db.get<{ binding_generation: number }>(
      `SELECT binding_generation FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
      [run.owner_role_key],
    );
    if (!ownerCurrent || ownerCurrent.binding_generation !== run.owner_binding_generation) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "the run's pinned owner generation is revoked", {
        runId: run.run_id,
        ownerRoleKey: run.owner_role_key,
        pinned: run.owner_binding_generation,
        current: ownerCurrent?.binding_generation ?? null,
      });
    }

    const bindings = this.db.all<{
      role_key: string;
      role: string;
      binding_generation: number;
      status: string;
    }>(
      `SELECT role_key, role, binding_generation, status
         FROM assignments
        WHERE session_id = ?
          AND (run_id = ?
               OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?)
               OR (role = 'PRIMARY_CTO' AND project_id IS NOT NULL AND project_id = ?))`,
      [request.sessionId, run.run_id, run.run_id, run.project_id],
    );

    if (bindings.length === 0) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "session holds no binding attached to this run",
        { runId: run.run_id, sessionId: request.sessionId },
      );
    }

    const matching = bindings.find((binding) => binding.binding_generation === request.bindingGeneration);
    if (!matching) {
      return deny(
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
        "claimed binding generation does not match any binding for this session",
        {
          runId: run.run_id,
          claimed: request.bindingGeneration,
          known: bindings.map((binding) => binding.binding_generation),
        },
      );
    }
    if (matching.status !== "ACTIVE") {
      return deny(ReasonCode.BINDING_REVOKED, "binding generation has been revoked", {
        runId: run.run_id,
        roleKey: matching.role_key,
        generation: matching.binding_generation,
      });
    }
    if (!WRITER_ROLES.has(matching.role)) {
      return deny(
        ReasonCode.REVIEWER_SESSION_IS_PRODUCER,
        `role ${matching.role} may not perform project writes`,
        { runId: run.run_id, role: matching.role, roleKey: matching.role_key },
      );
    }

    const current = this.db.get<{ binding_generation: number }>(
      `SELECT binding_generation FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
      [matching.role_key],
    );
    if (!current || current.binding_generation !== matching.binding_generation) {
      return deny(ReasonCode.WRITE_BINDING_GENERATION_STALE, "binding generation is superseded", {
        roleKey: matching.role_key,
        claimed: matching.binding_generation,
        current: current?.binding_generation ?? null,
      });
    }

    return allow(ReasonCode.OK, {
      roleKey: matching.role_key,
      role: matching.role,
      generation: matching.binding_generation,
    });
  }

  private authorizeManifestProject(run: RunAuthRow, projectId: string): Decision<void> {
    if (!projectId.trim()) {
      return deny(ReasonCode.INVALID_ARGUMENT, "manifest project identity must not be empty", { runId: run.run_id });
    }
    if (run.project_id !== null && run.project_id !== projectId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "manifest project is outside the run scope", {
        runId: run.run_id,
        runProjectId: run.project_id,
        projectId,
      });
    }
    // Bootstrap runs intentionally have no project_id until activation. The managed
    // manifest proof still names the exact project; the bootstrap run is not itself the
    // authority, only the bound session/generation tuple is.
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * A provider write is bound to one durable worker attempt, not merely to a session and
   * an arbitrary path. The receipt's worktree is checked again on every guard evaluation,
   * including the post-effect revalidation.
   */
  private authorizeTaskReceipt(
    run: RunAuthRow,
    request: GuardRequest,
    resolvedPath: string | null,
  ): Decision<TaskReceiptRow> {
    if (!request.taskId || !request.taskReceiptId || !request.assignedWorktreeId) {
      return deny(
        ReasonCode.WRITE_REQUIRES_MANAGED_RUN,
        "runtime file mutation must name a task receipt and assigned worktree",
        { runId: run.run_id, taskId: request.taskId ?? null, taskReceiptId: request.taskReceiptId ?? null },
      );
    }
    const receipt = this.db.get<TaskReceiptRow>(
      `SELECT e.execution_id, e.run_id, e.task_id, e.owner_binding_generation,
              e.worker_session_id, e.status, e.worktree_id,
              r.identity AS repository_identity, r.checkout_path AS repository_checkout_path
         FROM task_executions e
         LEFT JOIN repositories r ON r.repository_id = e.repository_id
        WHERE e.execution_id = ? AND e.run_id = ? AND e.task_id = ?`,
      [request.taskReceiptId, run.run_id, request.taskId],
    );
    if (!receipt) {
      return deny(ReasonCode.TASK_RECEIPT_MISSING, "task execution receipt is not attached to this run and task", {
        runId: run.run_id,
        taskId: request.taskId,
        taskReceiptId: request.taskReceiptId,
      });
    }
    if (receipt.status !== "RUNNING") {
      return deny(ReasonCode.TASK_RECEIPT_MISSING, "task execution receipt is not live", {
        taskReceiptId: receipt.execution_id,
        status: receipt.status,
      });
    }
    if (
      receipt.worker_session_id !== request.sessionId ||
      receipt.owner_binding_generation !== run.owner_binding_generation ||
      receipt.owner_binding_generation !== request.bindingGeneration
    ) {
      return deny(ReasonCode.WRITE_BINDING_GENERATION_STALE, "task receipt is bound to a stale worker generation", {
        taskReceiptId: receipt.execution_id,
        receiptSessionId: receipt.worker_session_id,
        requestSessionId: request.sessionId,
        receiptGeneration: receipt.owner_binding_generation,
        runOwnerGeneration: run.owner_binding_generation,
        requestGeneration: request.bindingGeneration,
      });
    }
    const workerBinding = this.db.get<{ binding_generation: number }>(
      `SELECT binding_generation FROM assignments
        WHERE run_id = ? AND task_id = ? AND session_id = ? AND role = 'WORKER' AND status = 'ACTIVE'`,
      [run.run_id, request.taskId, request.sessionId],
    );
    if (!workerBinding || workerBinding.binding_generation !== request.bindingGeneration) {
      return deny(ReasonCode.BINDING_REVOKED, "task receipt's worker binding is not active", {
        runId: run.run_id,
        taskId: request.taskId,
        sessionId: request.sessionId,
        requestGeneration: request.bindingGeneration,
        currentGeneration: workerBinding?.binding_generation ?? null,
      });
    }
    if (!receipt.worktree_id || !receipt.repository_identity || !receipt.repository_checkout_path) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "task receipt has no repository worktree binding", {
        taskReceiptId: receipt.execution_id,
      });
    }

    const assigned = this.probe.canonical(request.assignedWorktreeId);
    const receiptWorktree = this.probe.canonical(receipt.worktree_id);
    if (assigned !== receiptWorktree) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "request worktree differs from the task receipt binding", {
        taskReceiptId: receipt.execution_id,
        requestedWorktree: assigned,
        receiptWorktree,
      });
    }
    if (request.targetWorktreeId && this.probe.canonical(request.targetWorktreeId) !== assigned) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "request target worktree differs from its assigned worktree", {
        taskReceiptId: receipt.execution_id,
        targetWorktreeId: request.targetWorktreeId,
        assignedWorktreeId: assigned,
      });
    }
    const worktree = this.probe.probeWorktree(assigned);
    if (worktree.status === "ERROR") {
      return deny(ReasonCode.PROBE_FAILED, "could not verify the task's assigned worktree", {
        taskReceiptId: receipt.execution_id,
        assignedWorktreeId: assigned,
        reason: worktree.reason,
      });
    }
    if (worktree.status !== "INSIDE" || this.probe.canonical(worktree.toplevel) !== assigned) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "task receipt is not bound to a live Git worktree", {
        taskReceiptId: receipt.execution_id,
        assignedWorktreeId: assigned,
        observedWorktree: worktree.status === "INSIDE" ? this.probe.canonical(worktree.toplevel) : null,
      });
    }
    if (!resolvedPath || !isWithin(assigned, resolvedPath)) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "write target is outside the task's assigned worktree", {
        taskReceiptId: receipt.execution_id,
        assignedWorktreeId: assigned,
        resolvedPath,
      });
    }
    if (request.repositoryIdentity && request.repositoryIdentity !== receipt.repository_identity) {
      return deny(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, "task receipt repository differs from the request", {
        taskReceiptId: receipt.execution_id,
        requestedRepository: request.repositoryIdentity,
        receiptRepository: receipt.repository_identity,
      });
    }
    return allow(ReasonCode.OK, receipt);
  }

  /** Binds the operation to exactly one repository participating in the run. */
  private authorizeTarget(input: {
    run: RunAuthRow;
    request: GuardRequest;
    operation: WriteOperation;
    resolvedPath: string | null;
    toplevel: string | null;
    taskReceipt: TaskReceiptRow | null;
  }): Decision<ParticipantRow> {
    const participants = this.db
      .all<ParticipantRow & { work_branch: string | null; worktree_id: string | null }>(
        `SELECT r.identity, r.checkout_path, rr.work_branch, rr.worktree_id
           FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
          WHERE rr.run_id = ?`,
        [input.run.run_id],
      )
      .map(({ identity, checkout_path }) => ({ identity, checkout_path: this.probe.canonical(checkout_path) }));

    const byIdentity = input.request.repositoryIdentity
      ? (participants.find((participant) => participant.identity === input.request.repositoryIdentity) ?? null)
      : null;
    if (input.request.repositoryIdentity && !byIdentity) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "declared repository does not participate in this run",
        {
          runId: input.run.run_id,
          identity: input.request.repositoryIdentity,
          participants: participants.map((participant) => participant.identity),
        },
      );
    }

    if (input.operation === WriteOperation.FILE_MUTATION && input.taskReceipt) {
      const receiptParticipant = participants.find(
        (participant) => participant.identity === input.taskReceipt!.repository_identity,
      );
      if (!receiptParticipant) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "task receipt repository does not participate in this run", {
          runId: input.run.run_id,
          repositoryIdentity: input.taskReceipt.repository_identity,
        });
      }
      const assigned = this.probe.canonical(input.request.assignedWorktreeId!);
      if (input.toplevel !== assigned || !input.resolvedPath || !isWithin(assigned, input.resolvedPath)) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "file mutation target is outside its assigned worktree", {
          runId: input.run.run_id,
          assignedWorktreeId: assigned,
          resolvedPath: input.resolvedPath,
          observedWorktree: input.toplevel,
        });
      }
      if (byIdentity && byIdentity.identity !== receiptParticipant.identity) {
        return deny(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, "request repository differs from task receipt repository", {
          requestedRepository: byIdentity.identity,
          receiptRepository: receiptParticipant.identity,
        });
      }
      return allow(ReasonCode.OK, receiptParticipant);
    }

    if (input.operation === WriteOperation.GIT_WORKTREE) {
      if (!byIdentity) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "GIT_WORKTREE must name a participating repository", {
          runId: input.run.run_id,
          identity: input.request.repositoryIdentity ?? null,
        });
      }
      const targetWorktree = input.request.targetWorktreeId
        ? this.probe.canonical(input.request.targetWorktreeId)
        : null;
      const action = input.request.worktreeAction;
      // Add/remove/cleanup name the disposable tree itself. Prune runs from the registered
      // checkout, but only for a durable verification tree owned by this same run. This
      // keeps the repository checkout and disposable tree as separate facts rather than
      // letting an arbitrary tree identity borrow checkout authority.
      const expectedEffectPath = action === WorktreeAction.PRUNE
        ? byIdentity.checkout_path
        : targetWorktree;
      if (
        !targetWorktree ||
        !input.resolvedPath ||
        !action ||
        input.resolvedPath !== expectedEffectPath
      ) {
        return deny(
          ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
          "GIT_WORKTREE effect does not match its disposable-tree lifecycle action",
          {
            runId: input.run.run_id,
            identity: byIdentity.identity,
            targetPath: input.resolvedPath,
            targetWorktreeId: input.request.targetWorktreeId ?? null,
            worktreeAction: action ?? null,
            repositoryCheckoutPath: byIdentity.checkout_path,
          },
        );
      }
      if (
        action === WorktreeAction.PRUNE &&
        !this.ownsVerificationWorktree(input.run.run_id, byIdentity, targetWorktree)
      ) {
        return deny(
          ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
          "GIT_WORKTREE prune must name this run's live disposable verification tree",
          {
            runId: input.run.run_id,
            repositoryIdentity: byIdentity.identity,
            repositoryCheckoutPath: byIdentity.checkout_path,
            targetWorktreeId: targetWorktree,
          },
        );
      }
      // A disposable verification worktree is intentionally not itself registered. If
      // the requested effect instead resolves inside a *different* registered checkout,
      // repository identity cannot be borrowed to reach it.
      if (
        input.toplevel &&
        participants.some((participant) => participant.checkout_path === input.toplevel) &&
        input.toplevel !== byIdentity.checkout_path
      ) {
        return deny(
          ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
          "GIT_WORKTREE target belongs to another registered repository",
          {
            runId: input.run.run_id,
            identity: byIdentity.identity,
            targetWorktree: input.toplevel,
          },
        );
      }
      return allow(ReasonCode.OK, byIdentity);
    }

    if (!input.resolvedPath) {
      if (!byIdentity) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "no repository target resolved", {
          runId: input.run.run_id,
          operation: input.operation,
        });
      }
      return allow(ReasonCode.OK, byIdentity);
    }

    const owner = input.toplevel
      ? (participants.find((participant) => participant.checkout_path === input.toplevel) ?? null)
      : (participants.find((participant) => isWithin(participant.checkout_path, input.resolvedPath!)) ?? null);
    if (!owner) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        input.toplevel
          ? "the work tree containing this path is not a repository participating in this run"
          : "target path is not inside any repository participating in this run",
        {
          runId: input.run.run_id,
          resolvedPath: input.resolvedPath,
          worktree: input.toplevel,
          participants: participants.map((participant) => participant.checkout_path),
        },
      );
    }
    if (byIdentity && byIdentity.identity !== owner.identity) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "declared repository identity does not match the repository containing the target path",
        {
          runId: input.run.run_id,
          declared: byIdentity.identity,
          resolved: owner.identity,
          resolvedPath: input.resolvedPath,
        },
      );
    }
    return allow(ReasonCode.OK, owner);
  }

  /** A source-checkout prune may only service a tree durably attributed to this run. */
  private ownsVerificationWorktree(
    runId: string,
    participant: ParticipantRow,
    targetWorktreeId: string,
  ): boolean {
    const rows = this.db.all<{
      repository_checkout_path: string;
      worktree_path: string;
    }>(
      `SELECT repository_checkout_path, worktree_path
         FROM verification_worktrees
        WHERE run_id = ?
          AND repository_identity = ?
          AND state IN ('CREATING', 'ACTIVE', 'DESTROYING')`,
      [runId, participant.identity],
    );
    return rows.some(
      (row) =>
        this.probe.canonical(row.repository_checkout_path) === participant.checkout_path &&
        this.probe.canonical(row.worktree_path) === targetWorktreeId,
    );
  }

  private authorizeResources(input: {
    request: GuardRequest;
    operation: WriteOperation;
    operationClass: OperationClass;
    participant: ParticipantRow;
    resolvedPath: string | null;
    toplevel: string | null;
  }): Decision<TargetResource> {
    const checkout = input.toplevel ?? input.participant.checkout_path;
    const canReadLocalBranch = input.operationClass !== "REMOTE" && input.operation !== WriteOperation.GIT_WORKTREE;
    const observedBranch = canReadLocalBranch ? this.probe.currentBranch(checkout) : null;
    const branchMustBeDeclared = input.operation === WriteOperation.GIT_BRANCH;
    if (branchMustBeDeclared && !input.request.targetBranch) {
      return deny(ReasonCode.INVALID_ARGUMENT, "GIT_BRANCH requires targetBranch", {
        operation: input.operation,
      });
    }
    if (
      input.request.targetBranch &&
      canReadLocalBranch &&
      input.operation !== WriteOperation.GIT_BRANCH &&
      observedBranch !== input.request.targetBranch
    ) {
      return deny(
        ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
        "declared branch does not match the branch Git reports for the target work tree",
        {
          declaredBranch: input.request.targetBranch,
          observedBranch,
          checkout,
        },
      );
    }

    const branch = input.request.targetBranch ?? observedBranch;
    // `git worktree add --detach <sha>` materialises an exact commit without selecting
    // or changing a branch. A source-branch label is provenance for the candidate, not
    // the resource this mutation reaches, so it must not collide with branch claims.
    const branchIsRelevant = input.operation !== WriteOperation.GIT_WORKTREE;
    // The registered checkout remains a separate filesystem fact for §23.2 containment.
    // A GIT_WORKTREE's resource identity is instead the disposable tree, so separate
    // verification trees can coexist even when their source checkout is claimed.
    const assignedWorktree = input.request.assignedWorktreeId
      ? this.probe.canonical(input.request.assignedWorktreeId)
      : null;
    const declaredWorktree = input.request.targetWorktreeId
      ? this.probe.canonical(input.request.targetWorktreeId)
      : null;
    const actualWorktree =
      input.operation === WriteOperation.GIT_WORKTREE
        ? declaredWorktree
        : assignedWorktree ?? (input.toplevel ? input.participant.checkout_path : null);
    if (
      input.operation !== WriteOperation.GIT_WORKTREE &&
      declaredWorktree &&
      input.toplevel &&
      declaredWorktree !== actualWorktree
    ) {
      return deny(
        ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
        "declared worktree does not match the resolved target work tree",
        {
          declaredWorktreeId: declaredWorktree,
          observedWorktreeId: actualWorktree,
          toplevel: input.toplevel,
        },
      );
    }

    // Remote writes mutate a GitHub ref rather than a local checkout. They must name the
    // ref, but a separate run's local worktree claim must not make different refs collide.
    const worktreeIsRelevant = input.operationClass !== "REMOTE";
    const needsWorktree = worktreeIsRelevant && this.hasHeldWorktreeClaim(input.participant.identity);
    const worktreeId = declaredWorktree ?? (needsWorktree ? actualWorktree : null);
    if (needsWorktree && !worktreeId) {
      return deny(
        ReasonCode.CLAIM_WORKTREE_CONFLICT,
        "a worktree is claimed and the target worktree cannot be determined",
        { repositoryIdentity: input.participant.identity },
      );
    }

    const relativeRoot = input.operation === WriteOperation.GIT_WORKTREE
      ? input.participant.checkout_path
      : assignedWorktree ?? input.participant.checkout_path;
    const claimPath = input.operation === WriteOperation.GIT_WORKTREE
      ? declaredWorktree
      : input.resolvedPath;
    const relativePath =
      claimPath && isWithin(relativeRoot, claimPath)
        ? claimPath.slice(relativeRoot.length + 1) || "."
        : null;
    return allow(ReasonCode.OK, {
      branch,
      branchIsRelevant,
      checkoutWorktreeId: input.participant.checkout_path,
      effectPath: input.resolvedPath,
      claimPath,
      worktreeId,
      worktreeAction: input.operation === WriteOperation.GIT_WORKTREE
        ? input.request.worktreeAction ?? null
        : null,
      worktreeIsRelevant,
      relativePath,
    });
  }

  /** §23.2 hard rejects against the resource this operation actually names or reaches. */
  private claimConflict(
    runId: string,
    participant: ParticipantRow,
    resource: TargetResource,
  ): Decision<never> | null {
    const held = this.db.all<{
      claim_id: string;
      run_id: string;
      branch: string | null;
      worktree_id: string | null;
      declared_path: string | null;
    }>(
      `SELECT claim_id, run_id, branch, worktree_id, declared_path
         FROM resource_claims
        WHERE status = 'HELD' AND repository_identity = ? AND run_id <> ?`,
      [participant.identity, runId],
    );
    if (held.length === 0) return null;

    const undeterminable = held.filter(
      (claim) =>
        (resource.branchIsRelevant && claim.branch !== null && resource.branch === null) ||
        (resource.worktreeIsRelevant && claim.worktree_id !== null && resource.worktreeId === null),
    );
    if (undeterminable.length > 0) {
      return deny(
        ReasonCode.CLAIM_BRANCH_CONFLICT,
        "another run holds a branch or worktree claim and the touched resource cannot be determined",
        {
          repositoryIdentity: participant.identity,
          heldBy: undeterminable.map((claim) => claim.run_id),
          branchTouched: resource.branch,
          worktreeTouched: resource.worktreeId,
        },
      );
    }

    for (const claim of held) {
      const worktreeOverlap = claim.worktree_id && resource.claimPath
        ? this.worktreePathOverlap(claim.worktree_id, resource.claimPath)
        : null;
      if (worktreeOverlap) {
        return deny(ReasonCode.CLAIM_WORKTREE_CONFLICT, "target overlaps a worktree claimed by another run", {
          worktreeId: this.probe.canonical(claim.worktree_id!),
          targetPath: resource.claimPath,
          overlap: worktreeOverlap,
          heldBy: claim.run_id,
          claimId: claim.claim_id,
          source: "canonical claimed-worktree containment",
        });
      }
      if (resource.branchIsRelevant && claim.branch && resource.branch === claim.branch) {
        return deny(ReasonCode.CLAIM_BRANCH_CONFLICT, "branch is claimed by another run", {
          branch: claim.branch,
          heldBy: claim.run_id,
          claimId: claim.claim_id,
          source: "declared or Git-resolved target branch",
        });
      }
      const canonicalClaimPath = claim.declared_path
        ? this.canonicalRelativeClaimPath(resource.checkoutWorktreeId, claim.declared_path)
        : null;
      const overlap = resource.relativePath && canonicalClaimPath
        ? relativePathOverlap(canonicalClaimPath, resource.relativePath)
        : null;
      if (overlap) {
        return deny(ReasonCode.WRITE_PATH_NOT_CLAIMED, "target path overlaps a path claimed by another run", {
          path: resource.relativePath,
          claimedPath: canonicalClaimPath,
          overlap,
          heldBy: claim.run_id,
          claimId: claim.claim_id,
        });
      }
    }
    return null;
  }

  /** Exact and enclosing checkout collisions are hard §23.2 conflicts in either direction. */
  private worktreePathOverlap(claimedWorktree: string, effectPath: string):
    | "exact"
    | "target-within-claimed-worktree"
    | "claimed-worktree-within-target"
    | null {
    const claimed = this.probe.canonical(claimedWorktree);
    const target = this.probe.canonical(effectPath);
    if (claimed === target) return "exact";
    if (isWithin(claimed, target)) return "target-within-claimed-worktree";
    if (isWithin(target, claimed)) return "claimed-worktree-within-target";
    return null;
  }

  private canonicalRelativeClaimPath(checkoutPath: string, declaredPath: string): string {
    const checkout = this.probe.canonical(checkoutPath);
    const resolved = this.probe.canonical(join(checkout, declaredPath));
    return isWithin(checkout, resolved)
      ? resolved.slice(checkout.length + 1) || "."
      : normalizeRelativePath(declaredPath);
  }

  private hasHeldWorktreeClaim(repositoryIdentity: string): boolean {
    return !!this.db.get<{ claim_id: string }>(
      `SELECT claim_id FROM resource_claims
        WHERE repository_identity = ? AND status = 'HELD' AND worktree_id IS NOT NULL`,
      [repositoryIdentity],
    );
  }

  /** Keep guard reads aligned with the partial indexes, which reserve every HELD row. */
  private expireOverdueClaims(): number {
    return this.db.run(
      `UPDATE resource_claims SET status = 'EXPIRED' WHERE status = 'HELD' AND expires_at <= ?`,
      [this.clock.nowIso()],
    ).changes;
  }

  private isDirectArtifactPath(resolvedPath: string): boolean {
    return this.#directWriteRoots.some((root) => isWithin(root, resolvedPath));
  }

  /** Registered checkouts are managed regardless of what the git probe can see. */
  private registeredContaining(resolvedPath: string): string | null {
    const rows = this.db.all<{ identity: string; checkout_path: string }>(
      `SELECT identity, checkout_path FROM repositories`,
    );
    const match = rows
      .map((row) => ({ ...row, checkout_path: this.probe.canonical(row.checkout_path) }))
      .filter((row) => isWithin(row.checkout_path, resolvedPath))
      .sort((a, b) => b.checkout_path.length - a.checkout_path.length)[0];
    return match?.identity ?? null;
  }
}
