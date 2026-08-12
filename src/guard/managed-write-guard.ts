import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { RunState } from "../domain/types.ts";
import { type WorkspaceProbe, isWithin } from "./workspace-probe.ts";

/**
 * Operations that mutate project-natured state. PRD §4 CP-HI-01 enumerates these
 * exactly: git file mutation, commit/branch/tag, GitHub PR/issue/release/ruleset
 * write, manifest/verification-contract change, programmatic merge.
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

/** Operations that are project-natured regardless of any local path. */
const ALWAYS_MANAGED: ReadonlySet<string> = new Set<string>([
  WriteOperation.GIT_COMMIT,
  WriteOperation.GIT_BRANCH,
  WriteOperation.GIT_TAG,
  WriteOperation.GITHUB_PR,
  WriteOperation.GITHUB_ISSUE,
  WriteOperation.GITHUB_RELEASE,
  WriteOperation.GITHUB_RULESET,
  WriteOperation.MANIFEST_CHANGE,
  WriteOperation.VERIFICATION_CONTRACT_CHANGE,
  WriteOperation.PROGRAMMATIC_MERGE,
]);

export interface GuardRequest {
  operation: GuardOperation;
  /** Absolute or relative filesystem target, when the operation has one. */
  targetPath?: string | null;
  /** Normalized remote identity, for GitHub-side operations. */
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
  classification: "DIRECT" | "MANAGED";
  runId: string | null;
  repositoryIdentity: string | null;
  resolvedPath: string | null;
}

interface RunAuthRow {
  run_id: string;
  state: string;
  owner_session_id: string | null;
  owner_binding_generation: number | null;
  owner_role_key: string | null;
}

/**
 * CP-HI-01 Managed Write Guard.
 *
 * The guard inspects the operation and the target path itself. Hermes' own
 * DIRECT/MANAGED judgement arrives as `claimedClassification` and is written to the
 * audit record, but it never influences the decision — a DIRECT-labelled request that
 * targets a git work tree is still denied without a valid managed run identity.
 */
export class ManagedWriteGuard {
  constructor(
    private readonly db: Db,
    private readonly probe: WorkspaceProbe,
    private readonly audit: AuditLog,
  ) {}

  evaluate(request: GuardRequest): Decision<GuardGrant> {
    const decision = this.decide(request);
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
        ...decision.evidence,
      },
    });
    return decision;
  }

  private decide(request: GuardRequest): Decision<GuardGrant> {
    if (READ_OPERATIONS.has(request.operation)) {
      // §6.1 — read-only repository analysis stays DIRECT.
      return allow(ReasonCode.DIRECT_READ_ONLY_ALLOWED, {
        classification: "DIRECT" as const,
        runId: request.runId ?? null,
        repositoryIdentity: request.repositoryIdentity ?? null,
        resolvedPath: request.targetPath ? this.probe.canonical(request.targetPath) : null,
      });
    }

    const resolvedPath = request.targetPath ? this.probe.canonical(request.targetPath) : null;
    const worktree = resolvedPath ? this.probe.gitToplevel(resolvedPath) : null;
    const projectNatured = ALWAYS_MANAGED.has(request.operation) || worktree !== null;

    if (!projectNatured) {
      // §6.1 — independent artifacts outside any managed repository remain DIRECT.
      return allow(
        ReasonCode.DIRECT_READ_ONLY_ALLOWED,
        {
          classification: "DIRECT" as const,
          runId: null,
          repositoryIdentity: null,
          resolvedPath,
        },
        { projectNatured: false },
      );
    }

    if (!request.runId || !request.sessionId || request.bindingGeneration == null) {
      return deny(
        ReasonCode.WRITE_REQUIRES_MANAGED_RUN,
        "project-natured write requires a managed run identity",
        { projectNatured: true, worktree, operation: request.operation },
      );
    }

    const run = this.db.get<RunAuthRow>(
      `SELECT run_id, state, owner_session_id, owner_binding_generation, owner_role_key
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

    const scope = this.authorizeTarget(run.run_id, resolvedPath, worktree, request);
    if (!scope.allowed) return scope;

    return allow(ReasonCode.WRITE_ALLOWED, scope.value, {
      projectNatured: true,
      roleKey: identity.value,
    });
  }

  /**
   * The writing session must hold a *current* binding that belongs to this run:
   * either the pinned run owner, or a worker/reviewer bound to one of its tasks.
   * A revoked or superseded generation is refused (§15.7 message fencing).
   */
  private authorizeSession(run: RunAuthRow, request: GuardRequest): Decision<string> {
    if (!run.owner_session_id) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner binding", {
        runId: run.run_id,
      });
    }

    const bindings = this.db.all<{ role_key: string; binding_generation: number; status: string }>(
      `SELECT role_key, binding_generation, status
         FROM assignments
        WHERE session_id = ?
          AND (run_id = ? OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?)
               OR (role = 'PRIMARY_CTO' AND project_id = (SELECT project_id FROM runs WHERE run_id = ?)))`,
      [request.sessionId, run.run_id, run.run_id, run.run_id],
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

    // Guard against a stale generation that is still marked ACTIVE nowhere else.
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

    return allow(ReasonCode.OK, matching.role_key);
  }

  /**
   * The write must land inside a repository that participates in this run, and must
   * not collide with an exact declared path another run is holding (§23.2).
   */
  private authorizeTarget(
    runId: string,
    resolvedPath: string | null,
    worktree: string | null,
    request: GuardRequest,
  ): Decision<GuardGrant> {
    const participants = this.db.all<{ identity: string; checkout_path: string }>(
      `SELECT r.identity, r.checkout_path
         FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
        WHERE rr.run_id = ?`,
      [runId],
    );

    if (ALWAYS_MANAGED.has(request.operation) && !resolvedPath) {
      const identity = request.repositoryIdentity ?? null;
      if (!identity) {
        return deny(
          ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
          "operation requires a repository identity",
          { operation: request.operation },
        );
      }
      if (!participants.some((p) => p.identity === identity)) {
        return deny(
          ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
          "repository does not participate in this run",
          { runId, identity, participants: participants.map((p) => p.identity) },
        );
      }
      return allow(ReasonCode.WRITE_ALLOWED, {
        classification: "MANAGED" as const,
        runId,
        repositoryIdentity: identity,
        resolvedPath: null,
      });
    }

    if (!resolvedPath) {
      return deny(ReasonCode.INVALID_ARGUMENT, "write operation requires a target path", {
        operation: request.operation,
      });
    }

    const owner = participants.find((p) =>
      isWithin(this.probe.canonical(p.checkout_path), resolvedPath),
    );
    if (!owner) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "target path is not inside any repository participating in this run",
        { runId, resolvedPath, worktree, participants: participants.map((p) => p.checkout_path) },
      );
    }

    const relative = resolvedPath.slice(this.probe.canonical(owner.checkout_path).length + 1);
    const conflicting = this.db.get<{ claim_id: string; run_id: string }>(
      `SELECT claim_id, run_id FROM resource_claims
        WHERE status = 'HELD' AND repository_identity = ? AND declared_path = ? AND run_id <> ?`,
      [owner.identity, relative, runId],
    );
    if (conflicting) {
      return deny(ReasonCode.WRITE_PATH_NOT_CLAIMED, "exact path is claimed by another run", {
        path: relative,
        heldBy: conflicting.run_id,
        claimId: conflicting.claim_id,
      });
    }

    return allow(ReasonCode.WRITE_ALLOWED, {
      classification: "MANAGED" as const,
      runId,
      repositoryIdentity: owner.identity,
      resolvedPath,
    });
  }
}
