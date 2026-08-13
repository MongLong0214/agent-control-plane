import { isAbsolute } from "node:path";

import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { newClaimId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { canonical } from "../guard/workspace-probe.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";

export interface ClaimRequest {
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  ownerRoleKey: string;
  repositoryIdentity: string;
  branch?: string | null;
  /**
   * Canonical registered checkout path. This is deliberately not an opaque caller-chosen
   * label: §23.2's worktree fence has to name the directory being protected.
   */
  worktreeId?: string | null;
  /** Repository-relative exact paths the holder intends to write. Optional (§23.2). */
  declaredPaths?: readonly string[];
  ttlMs?: number;
}

export interface ClaimRecord {
  claimId: string;
  repositoryIdentity: string;
  branch: string | null;
  worktreeId: string | null;
  declaredPath: string | null;
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  acquiredAt: string;
  expiresAt: string;
  status: "HELD" | "RELEASED" | "EXPIRED";
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * PRD §23 — a *minimal* coordination registry, not a scheduler.
 *
 * It rejects only the four mechanically obvious collisions (same worktree, same branch,
 * exact declared path overlap, revoked owner generation). Semantic conflicts stay with
 * the CTO, because the control plane has no way to judge them and pretending otherwise
 * would turn a coordination hint into a false authority.
 */
export class ClaimRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly bindings: BindingRegistry,
  ) {}

  acquire(request: ClaimRequest): Decision<ClaimRecord[]> {
    return this.db.tx(() => {
      this.expireOverdue();

      if (!this.bindings.isCurrent(request.ownerRoleKey, request.ownerBindingGeneration)) {
        return deny(
          ReasonCode.CLAIM_OWNER_GENERATION_REVOKED,
          "claim requested under a superseded binding generation",
          {
            roleKey: request.ownerRoleKey,
            requested: request.ownerBindingGeneration,
            current: this.bindings.active(request.ownerRoleKey)?.bindingGeneration ?? null,
          },
        );
      }

      const authorized = this.db.get<{ run_id: string; checkout_path: string }>(
        `SELECT r.run_id, repo.checkout_path
           FROM runs r
           JOIN assignments a ON a.role_key = r.owner_role_key
                             AND a.session_id = r.owner_session_id
                             AND a.binding_generation = r.owner_binding_generation
                             AND a.status = 'ACTIVE'
           JOIN run_repositories rr ON rr.run_id = r.run_id
           JOIN repositories repo ON repo.repository_id = rr.repository_id
          WHERE r.run_id = ?
            AND r.state = 'ACTIVE'
            AND r.owner_role_key = ?
            AND r.owner_session_id = ?
            AND r.owner_binding_generation = ?
            AND a.role_key = ?
            AND a.session_id = ?
            AND a.binding_generation = ?
            AND repo.identity = ?`,
        [
          request.runId,
          request.ownerRoleKey,
          request.ownerSessionId,
          request.ownerBindingGeneration,
          request.ownerRoleKey,
          request.ownerSessionId,
          request.ownerBindingGeneration,
          request.repositoryIdentity,
        ],
      );
      if (!authorized) {
        return deny(
          ReasonCode.CLAIM_OWNER_NOT_RUN_OWNER,
          "claim owner, active run, and participating repository must be one exact tuple",
          {
            runId: request.runId,
            ownerRoleKey: request.ownerRoleKey,
            ownerSessionId: request.ownerSessionId,
            ownerBindingGeneration: request.ownerBindingGeneration,
            repositoryIdentity: request.repositoryIdentity,
          },
        );
      }

      if (request.worktreeId !== undefined && request.worktreeId !== null && !request.worktreeId.trim()) {
        return deny(ReasonCode.INVALID_ARGUMENT, "worktree claim must not be empty", {
          repositoryIdentity: request.repositoryIdentity,
        });
      }
      const canonicalWorktree = request.worktreeId
        ? this.canonicalWorktree(request.worktreeId, authorized.checkout_path, request.repositoryIdentity)
        : null;
      if (canonicalWorktree && !canonicalWorktree.allowed) return canonicalWorktree as Decision<ClaimRecord[]>;

      const wanted: Array<Pick<ClaimRecord, "branch" | "worktreeId" | "declaredPath">> = [];
      if (canonicalWorktree?.allowed) {
        wanted.push({ branch: null, worktreeId: canonicalWorktree.value, declaredPath: null });
      }
      if (request.branch) wanted.push({ branch: request.branch, worktreeId: null, declaredPath: null });
      for (const path of request.declaredPaths ?? []) {
        const normalized = normalizePath(path);
        if (!normalized) {
          return deny(ReasonCode.INVALID_ARGUMENT, "declared path is not repository-relative", {
            runId: request.runId,
            path,
          });
        }
        if (!wanted.some((target) => target.declaredPath === normalized)) {
          wanted.push({ branch: null, worktreeId: null, declaredPath: normalized });
        }
      }
      if (wanted.length === 0) {
        return deny(ReasonCode.INVALID_ARGUMENT, "a claim needs a branch, worktree or path", {
          runId: request.runId,
        });
      }

      for (const target of wanted) {
        const conflict = this.findConflict(request, target);
        if (conflict) return conflict as Decision<ClaimRecord[]>;
      }

      const now = this.clock.nowIso();
      const expiresAt = isoPlus(now, request.ttlMs ?? DEFAULT_TTL_MS);
      const created: ClaimRecord[] = [];

      for (const target of wanted) {
        const claimId = newClaimId();
        this.db.run(
          `INSERT INTO resource_claims (claim_id, repository_identity, branch, worktree_id,
                                        declared_path, run_id, owner_session_id,
                                        owner_binding_generation, acquired_at, expires_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HELD')`,
          [
            claimId, request.repositoryIdentity, target.branch, target.worktreeId,
            target.declaredPath, request.runId, request.ownerSessionId,
            request.ownerBindingGeneration, now, expiresAt,
          ],
        );
        created.push({
          claimId,
          repositoryIdentity: request.repositoryIdentity,
          ...target,
          runId: request.runId,
          ownerSessionId: request.ownerSessionId,
          ownerBindingGeneration: request.ownerBindingGeneration,
          acquiredAt: now,
          expiresAt,
          status: "HELD",
        });
      }

      this.audit.record({
        kind: "CLAIM_ACQUIRED",
        runId: request.runId,
        sessionId: request.ownerSessionId,
        roleKey: request.ownerRoleKey,
        evidence: {
          repositoryIdentity: request.repositoryIdentity,
          branch: request.branch ?? null,
          worktreeId: canonicalWorktree?.allowed ? canonicalWorktree.value : null,
          paths: request.declaredPaths ?? [],
          expiresAt,
        },
      });
      return allow(ReasonCode.OK, created);
    });
  }

  /**
   * `repositories.checkout_path` is registered from a real worktree probe and is unique
   * machine-local state. Accepting an opaque ID here would make the unique worktree index
   * protect a string rather than a directory (#357).
   */
  private canonicalWorktree(
    requestedWorktreeId: string,
    checkoutPath: string,
    repositoryIdentity: string,
  ): Decision<string> {
    const expected = canonical(checkoutPath);
    if (!isAbsolute(requestedWorktreeId)) {
      return deny(
        ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
        "worktree claim must name an absolute registered checkout path",
        { repositoryIdentity, declaredWorktreeId: requestedWorktreeId, registeredWorktreeId: expected },
      );
    }
    const requested = canonical(requestedWorktreeId);
    if (requested !== expected) {
      return deny(
        ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH,
        "worktree claim must name the repository's canonical registered checkout path",
        {
          repositoryIdentity,
          declaredWorktreeId: requestedWorktreeId,
          canonicalDeclaredWorktreeId: requested,
          registeredWorktreeId: expected,
        },
      );
    }
    return allow(ReasonCode.OK, expected);
  }

  private findConflict(
    request: ClaimRequest,
    target: Pick<ClaimRecord, "branch" | "worktreeId" | "declaredPath">,
  ): Decision<never> | null {
    const [column, value, code, label] = target.worktreeId
      ? (["worktree_id", target.worktreeId, ReasonCode.CLAIM_WORKTREE_CONFLICT, "worktree"] as const)
      : target.branch
        ? (["branch", target.branch, ReasonCode.CLAIM_BRANCH_CONFLICT, "branch"] as const)
        : (["declared_path", target.declaredPath!, ReasonCode.CLAIM_PATH_CONFLICT, "path"] as const);

    const held = this.db.get<{ claim_id: string; run_id: string; owner_session_id: string }>(
      `SELECT claim_id, run_id, owner_session_id FROM resource_claims
        WHERE status = 'HELD' AND repository_identity = ? AND ${column} = ? AND run_id <> ?`,
      [request.repositoryIdentity, value, request.runId],
    );
    if (!held) return null;

    return deny(code, `${label} is already claimed by another run`, {
      repositoryIdentity: request.repositoryIdentity,
      [label]: value,
      heldByRun: held.run_id,
      heldBySession: held.owner_session_id,
      claimId: held.claim_id,
    });
  }

  /**
   * §23.2 — releasing is a write on another run's coordination state when the claim is not
   * yours, so a caller acting for a run must say which run it is acting for.
   */
  release(claimId: string, runId: string): Decision<void> {
    // One transaction: read, authorise, update, record. §30.3 — a release that is decided
    // on one snapshot and applied to another can free a claim another writer just took.
    return this.db.tx(() => {
      const row = this.db.get<{ status: string; run_id: string }>(
        `SELECT status, run_id FROM resource_claims WHERE claim_id = ?`,
        [claimId],
      );
      if (!row) return deny(ReasonCode.NOT_FOUND, "unknown claim", { claimId });
      // The run is mandatory: a claim is another run's coordination state, and freeing it
      // lets that run's resource be taken while it is still working.
      if (row.run_id !== runId) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "claim belongs to another run", {
          claimId,
          claimRunId: row.run_id,
          requestedRunId: runId,
        });
      }
      if (row.status !== "HELD") {
        return deny(ReasonCode.CLAIM_NOT_HELD, "claim is not held", { claimId });
      }

      this.db.run(
        `UPDATE resource_claims SET status = 'RELEASED', released_at = ? WHERE claim_id = ? AND status = 'HELD'`,
        [this.clock.nowIso(), claimId],
      );
      this.audit.record({ kind: "CLAIM_RELEASED", runId: row.run_id, evidence: { claimId } });
      return allow(ReasonCode.OK, undefined);
    });
  }

  releaseRun(runId: string): number {
    const changes = this.db.run(
      `UPDATE resource_claims SET status = 'RELEASED', released_at = ?
        WHERE run_id = ? AND status = 'HELD'`,
      [this.clock.nowIso(), runId],
    ).changes;
    if (changes > 0) {
      this.audit.record({ kind: "CLAIM_RELEASED", runId, evidence: { released: changes } });
    }
    return changes;
  }

  /**
   * Claims are short leases, not ownership. An expired lease is reclaimable so a dead
   * session cannot block a repository forever (§23.3).
   */
  expireOverdue(): number {
    return this.db.run(
      `UPDATE resource_claims SET status = 'EXPIRED' WHERE status = 'HELD' AND expires_at <= ?`,
      [this.clock.nowIso()],
    ).changes;
  }

  heldByRun(runId: string): ClaimRecord[] {
    return this.db
      .all<RawClaim>(`SELECT * FROM resource_claims WHERE run_id = ? AND status = 'HELD'`, [runId])
      .map(hydrate);
  }

  held(): ClaimRecord[] {
    return this.db
      .all<RawClaim>(`SELECT * FROM resource_claims WHERE status = 'HELD' ORDER BY acquired_at`)
      .map(hydrate);
  }

  overdue(): ClaimRecord[] {
    return this.db
      .all<RawClaim>(
        `SELECT * FROM resource_claims WHERE status = 'HELD' AND expires_at <= ? ORDER BY expires_at`,
        [this.clock.nowIso()],
      )
      .map(hydrate);
  }

  /**
   * §23.2 — semantic overlap between two runs touching related-but-not-identical paths
   * is surfaced as advice for the CTO, never as a hard reject.
   */
  advisoryOverlaps(
    repositoryIdentity: string,
    runId: string,
    paths: readonly string[],
  ): Array<{ path: string; otherRun: string; otherPath: string }> {
    const others = this.db.all<{ run_id: string; declared_path: string }>(
      `SELECT run_id, declared_path FROM resource_claims
        WHERE status = 'HELD' AND repository_identity = ? AND run_id <> ? AND declared_path IS NOT NULL`,
      [repositoryIdentity, runId],
    );
    const overlaps: Array<{ path: string; otherRun: string; otherPath: string }> = [];
    for (const path of paths.map(normalizePath)) {
      if (!path) continue;
      for (const other of others) {
        if (other.declared_path === path) continue; // that is a hard reject, not advice
        if (sharesDirectory(path, other.declared_path)) {
          overlaps.push({ path, otherRun: other.run_id, otherPath: other.declared_path });
        }
      }
    }
    return overlaps;
  }
}

const normalizePath = (path: string): string | null => {
  const separatorsNormalized = path.replaceAll("\\", "/");
  if (
    separatorsNormalized.length === 0 ||
    separatorsNormalized.includes("\0") ||
    separatorsNormalized.startsWith("/") ||
    /^[A-Za-z]:($|\/)/.test(separatorsNormalized)
  ) {
    return null;
  }
  const segments = separatorsNormalized.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
};

const sharesDirectory = (a: string, b: string): boolean => {
  const da = a.slice(0, a.lastIndexOf("/") + 1);
  const db = b.slice(0, b.lastIndexOf("/") + 1);
  return da.length > 0 && da === db;
};

interface RawClaim {
  claim_id: string;
  repository_identity: string;
  branch: string | null;
  worktree_id: string | null;
  declared_path: string | null;
  run_id: string;
  owner_session_id: string;
  owner_binding_generation: number;
  acquired_at: string;
  expires_at: string;
  status: ClaimRecord["status"];
}

const hydrate = (row: RawClaim): ClaimRecord => ({
  claimId: row.claim_id,
  repositoryIdentity: row.repository_identity,
  branch: row.branch,
  worktreeId: row.worktree_id,
  declaredPath: row.declared_path,
  runId: row.run_id,
  ownerSessionId: row.owner_session_id,
  ownerBindingGeneration: row.owner_binding_generation,
  acquiredAt: row.acquired_at,
  expiresAt: row.expires_at,
  status: row.status,
});
