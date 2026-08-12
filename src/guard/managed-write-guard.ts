import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, RunState } from "../domain/types.ts";
import { type WorkspaceProbe, isWithin } from "./workspace-probe.ts";

/**
 * Operations that mutate project-natured state. PRD §4 CP-HI-01 enumerates these
 * exactly: git file mutation, commit/branch/tag, GitHub PR/issue/release/ruleset write,
 * manifest/verification-contract change, programmatic merge.
 */
export const WriteOperation = {
  FILE_MUTATION: "FILE_MUTATION",
  GIT_COMMIT: "GIT_COMMIT",
  GIT_BRANCH: "GIT_BRANCH",
  GIT_TAG: "GIT_TAG",
  GITHUB_PR: "GITHUB_PR",
  GITHUB_ISSUE: "GITHUB_ISSUE",
  GITHUB_RELEASE: "GITHUB_RELEASE",
  GITHUB_RULESET: "GITHUB_RULESET",
  MANIFEST_CHANGE: "MANIFEST_CHANGE",
  VERIFICATION_CONTRACT_CHANGE: "VERIFICATION_CONTRACT_CHANGE",
  PROGRAMMATIC_MERGE: "PROGRAMMATIC_MERGE",
} as const;
export type WriteOperation = (typeof WriteOperation)[keyof typeof WriteOperation];

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
  [WriteOperation.GITHUB_PR]: "REMOTE",
  [WriteOperation.GITHUB_ISSUE]: "REMOTE",
  [WriteOperation.GITHUB_RELEASE]: "REMOTE",
  [WriteOperation.GITHUB_RULESET]: "REMOTE",
  [WriteOperation.PROGRAMMATIC_MERGE]: "REMOTE",
};

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

export interface GuardRequest {
  operation: GuardOperation;
  /** Absolute filesystem target. Relative paths are refused — see `decide`. */
  targetPath?: string | null;
  /** Normalized remote identity, required for every remote operation. */
  repositoryIdentity?: string | null;
  /** Managed run identity claimed by the caller. */
  runId?: string | null;
  sessionId?: string | null;
  bindingGeneration?: number | null;
  /** Free-form classification supplied by Hermes; recorded, never trusted (§4 CP-HI-01). */
  claimedClassification?: "DIRECT" | "MANAGED" | null;
  actor?: string | null;
}

export interface GuardGrant {
  grantId: string;
  classification: "DIRECT" | "MANAGED";
  operation: GuardOperation;
  runId: string | null;
  roleKey: string | null;
  bindingGeneration: number | null;
  repositoryIdentity: string | null;
  resolvedPath: string | null;
  issuedAt: string;
  expiresAt: string;
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
  work_branch: string | null;
  worktree_id: string | null;
}

/** A grant is short-lived and single use; see `consume`. */
const GRANT_TTL_MS = 60_000;

/**
 * CP-HI-01 Managed Write Guard.
 *
 * The guard inspects the operation and the resolved target itself. Hermes' own
 * DIRECT/MANAGED judgement arrives as `claimedClassification`, is written to the audit
 * record, and never influences the decision.
 *
 * Authorisation is deliberately two-phase. `evaluate` decides; `consume` re-decides
 * immediately before the side effect and burns the grant. A decision that is merely
 * *held* is worthless, because a binding can be revoked or a run can leave ACTIVE in the
 * window between deciding and writing (§15.7).
 */
export class ManagedWriteGuard {
  readonly #grants = new Map<
    string,
    { grant: GuardGrant; request: GuardRequest; consumed: boolean }
  >();

  constructor(
    private readonly db: Db,
    private readonly probe: WorkspaceProbe,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  evaluate(request: GuardRequest): Decision<GuardGrant> {
    const decision = this.decide(request);
    if (decision.allowed && decision.value.classification === "MANAGED") {
      this.#grants.set(decision.value.grantId, { grant: decision.value, request, consumed: false });
    }
    this.audit.record({
      kind: "MANAGED_WRITE_GUARD",
      reasonCode: decision.reasonCode,
      runId: request.runId ?? null,
      sessionId: request.sessionId ?? null,
      actor: request.actor ?? null,
      evidence: {
        operation: request.operation,
        targetPath: request.targetPath ?? null,
        repositoryIdentity: request.repositoryIdentity ?? null,
        claimedClassification: request.claimedClassification ?? null,
        allowed: decision.allowed,
        grantId: decision.allowed ? decision.value.grantId : null,
        ...decision.evidence,
      },
    });
    return decision;
  }

  /**
   * Re-validates a grant and burns it. The caller must invoke this immediately before the
   * write; a grant that is expired, already used, or no longer authorised is refused.
   */
  consume(grantId: string): Decision<GuardGrant> {
    const held = this.#grants.get(grantId);
    if (!held) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "unknown or already-expired grant", {
        grantId,
      });
    }
    if (held.consumed) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "grant has already been consumed", {
        grantId,
      });
    }
    if (this.clock.nowIso() >= held.grant.expiresAt) {
      this.#grants.delete(grantId);
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "grant expired before the write", {
        grantId,
        expiresAt: held.grant.expiresAt,
      });
    }

    // The authority may have moved since the grant was issued.
    const fresh = this.decide(held.request);
    if (!fresh.allowed) {
      this.#grants.delete(grantId);
      this.audit.record({
        kind: "MANAGED_WRITE_GUARD_REVOKED",
        reasonCode: fresh.reasonCode,
        runId: held.request.runId ?? null,
        sessionId: held.request.sessionId ?? null,
        evidence: { grantId, ...fresh.evidence },
      });
      return fresh;
    }
    if (fresh.value.bindingGeneration !== held.grant.bindingGeneration) {
      this.#grants.delete(grantId);
      return deny(
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
        "binding generation changed between authorisation and write",
        {
          grantId,
          authorised: held.grant.bindingGeneration,
          current: fresh.value.bindingGeneration,
        },
      );
    }

    held.consumed = true;
    this.#grants.delete(grantId);
    this.audit.record({
      kind: "MANAGED_WRITE_GUARD_CONSUMED",
      reasonCode: ReasonCode.WRITE_ALLOWED,
      runId: held.grant.runId,
      roleKey: held.grant.roleKey,
      evidence: {
        grantId,
        operation: held.grant.operation,
        repositoryIdentity: held.grant.repositoryIdentity,
        resolvedPath: held.grant.resolvedPath,
      },
    });
    return allow(ReasonCode.WRITE_ALLOWED, held.grant);
  }

  /** Drops grants past their expiry. Called by the watchdog and on each evaluate. */
  expireGrants(): number {
    const now = this.clock.nowIso();
    let dropped = 0;
    for (const [id, held] of this.#grants) {
      if (now >= held.grant.expiresAt) {
        this.#grants.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  // -------------------------------------------------------------------------

  private decide(request: GuardRequest): Decision<GuardGrant> {
    this.expireGrants();

    if (READ_OPERATIONS.has(request.operation)) {
      // §6.1 — read-only repository analysis stays DIRECT.
      return this.direct(request, ReasonCode.DIRECT_READ_ONLY_ALLOWED, null, null);
    }

    const operation = request.operation as WriteOperation;
    const operationClass = OPERATION_CLASS[operation];

    // --- argument validation, per operation class --------------------------
    if (request.targetPath != null && !isAbsolute(request.targetPath)) {
      // A relative path would be resolved against the daemon's cwd, not the cwd the tool
      // actually writes in, so the guard could authorise a different file than the one
      // mutated.
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "target path must be absolute; a relative path cannot be authorised reliably",
        { operation, targetPath: request.targetPath },
      );
    }
    if (operationClass === "FILESYSTEM" && !request.targetPath) {
      return deny(ReasonCode.INVALID_ARGUMENT, `${operation} requires a target path`, { operation });
    }
    if (operationClass === "REMOTE" && !request.repositoryIdentity) {
      return deny(ReasonCode.INVALID_ARGUMENT, `${operation} requires a repository identity`, {
        operation,
      });
    }
    if (operationClass === "GIT_LOCAL" && !request.targetPath && !request.repositoryIdentity) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        `${operation} requires a target path or a repository identity`,
        { operation },
      );
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

    // A filesystem write is project-natured when it lands in a git work tree *or* inside
    // a registered checkout. Git detection alone is not the classifier: a registered
    // repository whose git metadata is unreadable is still a managed project.
    const projectNatured =
      operationClass !== "FILESYSTEM" || toplevel !== null || registered !== null;

    if (!projectNatured) {
      // §6.1 — independent artifacts outside any managed repository remain DIRECT.
      return this.direct(request, ReasonCode.DIRECT_READ_ONLY_ALLOWED, resolvedPath, null, {
        projectNatured: false,
      });
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
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "run does not exist", {
        runId: request.runId,
      });
    }
    if (run.state !== RunState.ACTIVE) {
      return deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, `run is ${run.state}, not ACTIVE`, {
        runId: run.run_id,
        state: run.state,
      });
    }

    const identity = this.authorizeSession(run, request);
    if (!identity.allowed) return identity as Decision<GuardGrant>;

    const target = this.authorizeTarget({
      run,
      request,
      operation,
      operationClass,
      resolvedPath,
      toplevel,
    });
    if (!target.allowed) return target as Decision<GuardGrant>;

    const conflict = this.claimConflict(run.run_id, target.value, resolvedPath, toplevel);
    if (conflict) return conflict as Decision<GuardGrant>;

    const issuedAt = this.clock.nowIso();
    return allow(
      ReasonCode.WRITE_ALLOWED,
      {
        grantId: `grant_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        classification: "MANAGED" as const,
        operation,
        runId: run.run_id,
        roleKey: identity.value.roleKey,
        bindingGeneration: identity.value.generation,
        repositoryIdentity: target.value.identity,
        resolvedPath,
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
        classification: "DIRECT" as const,
        operation: request.operation,
        runId: null,
        roleKey: null,
        bindingGeneration: null,
        repositoryIdentity,
        resolvedPath,
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
    if (!run.owner_session_id) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner binding", {
        runId: run.run_id,
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

    const matching = bindings.find((b) => b.binding_generation === request.bindingGeneration);
    if (!matching) {
      return deny(
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
        "claimed binding generation does not match any binding for this session",
        {
          runId: run.run_id,
          claimed: request.bindingGeneration,
          known: bindings.map((b) => b.binding_generation),
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
      // A reviewer that can edit the candidate is not an independent reviewer.
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

  /**
   * Binds the operation to exactly one repository participating in the run.
   *
   * A filesystem target is matched against the *git toplevel*, not against any enclosing
   * participant checkout, so a nested or vendored repository cannot be written under its
   * parent's authority. A remote operation always validates its own repository identity,
   * even when a path was also supplied.
   */
  private authorizeTarget(input: {
    run: RunAuthRow;
    request: GuardRequest;
    operation: WriteOperation;
    operationClass: OperationClass;
    resolvedPath: string | null;
    toplevel: string | null;
  }): Decision<ParticipantRow> {
    const participants = this.db
      .all<ParticipantRow>(
        `SELECT r.identity, r.checkout_path, rr.work_branch, rr.worktree_id
           FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
          WHERE rr.run_id = ?`,
        [input.run.run_id],
      )
      .map((p) => ({ ...p, checkout_path: this.probe.canonical(p.checkout_path) }));

    const byIdentity = input.request.repositoryIdentity
      ? (participants.find((p) => p.identity === input.request.repositoryIdentity) ?? null)
      : null;

    if (input.request.repositoryIdentity && !byIdentity) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "declared repository does not participate in this run",
        {
          runId: input.run.run_id,
          identity: input.request.repositoryIdentity,
          participants: participants.map((p) => p.identity),
        },
      );
    }

    if (!input.resolvedPath) {
      // Remote or git operation identified purely by repository.
      if (!byIdentity) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "no repository target resolved", {
          runId: input.run.run_id,
          operation: input.operation,
        });
      }
      return allow(ReasonCode.OK, byIdentity);
    }

    // The authoritative local repository is the work tree the path actually belongs to.
    const owner = input.toplevel
      ? (participants.find((p) => p.checkout_path === input.toplevel) ?? null)
      : (participants.find((p) => isWithin(p.checkout_path, input.resolvedPath!)) ?? null);

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
          participants: participants.map((p) => p.checkout_path),
        },
      );
    }

    // Both were supplied: they must agree, or the declared target is not what is written.
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

  /**
   * §23.2 hard rejects. A write is refused when another run currently holds the worktree,
   * the branch, or the exact declared path this operation would touch.
   */
  private claimConflict(
    runId: string,
    participant: ParticipantRow,
    resolvedPath: string | null,
    toplevel: string | null,
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
        WHERE status = 'HELD' AND repository_identity = ? AND run_id <> ? AND expires_at > ?`,
      [participant.identity, runId, this.clock.nowIso()],
    );
    if (held.length === 0) return null;

    const relative =
      resolvedPath && isWithin(participant.checkout_path, resolvedPath)
        ? resolvedPath.slice(participant.checkout_path.length + 1)
        : null;

    // Which branch and worktree this write actually touches. The run's own declaration is
    // authoritative when it made one; otherwise fall back to what the checkout says, so a
    // run that simply never declared a branch cannot slip past another run's claim.
    const branchTouched =
      participant.work_branch ?? (toplevel ? this.probe.currentBranch(toplevel) : null);
    // Managed verification worktrees are created under a root and named by their id, so a
    // resolved toplevel's basename is the worktree id when the write lands in one.
    const worktreeTouched = participant.worktree_id ?? (toplevel ? basename(toplevel) : null);

    for (const claim of held) {
      if (claim.worktree_id && worktreeTouched && claim.worktree_id === worktreeTouched) {
        return deny(ReasonCode.CLAIM_WORKTREE_CONFLICT, "worktree is claimed by another run", {
          worktreeId: claim.worktree_id,
          heldBy: claim.run_id,
          claimId: claim.claim_id,
          source: participant.worktree_id ? "run declaration" : "resolved work tree",
        });
      }
      if (claim.branch && branchTouched && claim.branch === branchTouched) {
        return deny(ReasonCode.CLAIM_BRANCH_CONFLICT, "branch is claimed by another run", {
          branch: claim.branch,
          heldBy: claim.run_id,
          claimId: claim.claim_id,
          source: participant.work_branch ? "run declaration" : "checked-out branch",
        });
      }
      if (relative && claim.declared_path === relative) {
        return deny(ReasonCode.WRITE_PATH_NOT_CLAIMED, "exact path is claimed by another run", {
          path: relative,
          heldBy: claim.run_id,
          claimId: claim.claim_id,
        });
      }
    }
    return null;
  }

  /** Registered checkouts are managed regardless of what the git probe can see. */
  private registeredContaining(resolvedPath: string): string | null {
    const rows = this.db.all<{ identity: string; checkout_path: string }>(
      `SELECT identity, checkout_path FROM repositories`,
    );
    const match = rows
      .map((r) => ({ ...r, checkout_path: this.probe.canonical(r.checkout_path) }))
      .filter((r) => isWithin(r.checkout_path, resolvedPath))
      .sort((a, b) => b.checkout_path.length - a.checkout_path.length)[0];
    return match?.identity ?? null;
  }
}
