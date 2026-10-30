import { isAbsolute } from "node:path";

import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
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
 * #1269 — whether the claim row aliased `c` keeps its target from every other run: while it is HELD, and also once
 * its lease lapsed while its run holds a merge proven but for its CommitLore notes on that repository (MERGING,
 * the merge receipt PENDING, MERGE_NOTES_PENDING recorded). That target stays closed until the run settles, ends,
 * or is resolved. The lapsed claim is not revived: its own run still cannot write under it.
 */
export const standingClaimSql = (c: string): string => `(${c}.status = 'HELD' OR (${c}.status = 'EXPIRED'
  AND EXISTS (SELECT 1 FROM runs sr WHERE sr.run_id = ${c}.run_id AND sr.state = 'MERGING')
  AND EXISTS (SELECT 1 FROM github_receipts sg WHERE sg.run_id = ${c}.run_id AND sg.repository_identity = ${c}.repository_identity
                AND sg.operation = 'merge_execute' AND sg.status = 'PENDING')
  AND EXISTS (SELECT 1 FROM audit_events sa WHERE sa.run_id = ${c}.run_id AND sa.kind = 'MERGE_NOTES_PENDING'
                AND json_extract(sa.evidence_json, '$.repositoryIdentity') = ${c}.repository_identity)))`;

/** What may still write a registered checkout for a run, and why; see `CheckoutWriter`. */
export interface CheckoutWriterFact {
  reason: string;
  evidence: Evidence;
}

/**
 * S2 — what the worker runner knows may still write a registered checkout for a run
 * (`WorkerTurnRunner.checkoutWriter`): null only when nothing a turn of that run started can write it.
 */
export type CheckoutWriter = (runId: string, worktreeId: string) => CheckoutWriterFact | null;

/** A registry with no runner attached cannot tell that a writer is gone, so it never hands a claim over. */
const NO_RUNNER: CheckoutWriterFact = { reason: "no worker runner answers for the checkout", evidence: {} };

/** The run's own HELD worktree claim on a checkout, which a hand-over releases with its acquisition. */
interface EarlierClaim {
  claimId: string;
  /** The rows acquired with it, exactly: the ones a hand-over releases. */
  acquisition: string;
}

/**
 * S2 — a claim names its acquisition and its place in it: `<acquisition>.<index>.<count>`, every row of
 * one acquisition sharing the same acquisition id and count. Rows are never deleted while their run
 * lives, so an acquisition's membership is read from the rows themselves, complete or provably not.
 */
const ACQUIRED_CLAIM_ID = /^(clm_[0-9a-f]{24})\.([1-9][0-9]*)\.([1-9][0-9]*)$/;

export interface AcquisitionRow {
  claim_id: string;
  run_id: string;
  repository_identity: string;
  branch: string | null;
  worktree_id: string | null;
  declared_path: string | null;
  owner_session_id: string;
  owner_binding_generation: number;
  acquired_at: string;
  expires_at: string;
  status: ClaimRecord["status"];
}

/**
 * S2 — every row acquired together with `claimId`, the one authority both the hand-over and a worker
 * turn's claim facts read. PROVEN: the claim carries its acquisition, and each index from 1 to its count
 * is there once, every row of the same run, repository, owner and time. UNPROVEN: it carries one, and
 * the rows do not add up; nothing may be released or run on it. LEGACY: a claim minted before S2, with
 * no acquisition in its id, whose rows are those minted before S2 with its run, repository, owner and
 * acquisition time — a superset when two acquisitions shared a millisecond, so a turn on it can only be
 * refused more, and a hand-over never releases one. null for an unknown claim.
 */
export const claimAcquisition = (
  db: Db,
  claimId: string,
): { membership: "PROVEN" | "UNPROVEN" | "LEGACY"; acquisition: string | null; rows: AcquisitionRow[] } | null => {
  const anchor = db.get<AcquisitionRow>(`SELECT * FROM resource_claims WHERE claim_id = ?`, [claimId]);
  if (!anchor) return null;
  const minted = ACQUIRED_CLAIM_ID.exec(claimId);
  if (!minted) {
    const rows = db.all<AcquisitionRow>(
      `SELECT * FROM resource_claims
        WHERE run_id = ? AND repository_identity = ? AND owner_session_id = ? AND owner_binding_generation = ?
          AND acquired_at = ? AND instr(claim_id, '.') = 0
        ORDER BY claim_id`,
      [anchor.run_id, anchor.repository_identity, anchor.owner_session_id, anchor.owner_binding_generation, anchor.acquired_at],
    );
    return { membership: "LEGACY", acquisition: null, rows };
  }
  const acquisition = minted[1]!;
  const count = Number(minted[3]);
  // Every id of the acquisition sorts between `<acquisition>.` and `<acquisition>/`, on the primary key.
  const rows = db.all<AcquisitionRow>(
    `SELECT * FROM resource_claims WHERE claim_id >= ? AND claim_id < ? ORDER BY claim_id`,
    [`${acquisition}.`, `${acquisition}/`],
  );
  const indices = new Set<number>();
  const consistent = rows.every((row) => {
    const own = ACQUIRED_CLAIM_ID.exec(row.claim_id);
    if (!own || own[1] !== acquisition || Number(own[3]) !== count) return false;
    indices.add(Number(own[2]));
    return row.run_id === anchor.run_id && row.repository_identity === anchor.repository_identity &&
      row.owner_session_id === anchor.owner_session_id && row.owner_binding_generation === anchor.owner_binding_generation &&
      row.acquired_at === anchor.acquired_at;
  });
  const complete = rows.length === count && indices.size === count && [...indices].every((index) => index <= count);
  return { membership: consistent && complete ? "PROVEN" : "UNPROVEN", acquisition, rows };
};

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

  #checkoutWriter: CheckoutWriter | null = null;

  attach(ports: { checkoutWriter: CheckoutWriter }): void {
    this.#checkoutWriter = ports.checkoutWriter;
  }

  /** Every claim read uses the same lease boundary as acquisition. */
  private readAfterExpirySweep<T>(read: () => T): T {
    return this.db.tx(() => {
      this.expireOverdue();
      return read();
    });
  }

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

      // S2 — the run's own earlier claim on this checkout passes to this one, never while anything a
      // turn of the run started may still write the checkout.
      const earlier = canonicalWorktree?.allowed
        ? this.earlierWorktreeClaim(request, canonicalWorktree.value)
        : allow(ReasonCode.OK, null);
      if (!earlier.allowed) return earlier as Decision<ClaimRecord[]>;

      for (const target of wanted) {
        const conflict = this.findConflict(request, target);
        if (conflict) return conflict as Decision<ClaimRecord[]>;
      }

      const now = this.clock.nowIso();
      const expiresAt = isoPlus(now, request.ttlMs ?? DEFAULT_TTL_MS);
      const created: ClaimRecord[] = [];
      if (earlier.value) this.handOver(request, earlier.value, now);

      const acquisition = newClaimId();
      for (const [index, target] of wanted.entries()) {
        const claimId = `${acquisition}.${index + 1}.${wanted.length}`;
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
          ...(earlier.value ? { handedOverFrom: earlier.value.claimId } : {}),
        },
      });
      return allow(ReasonCode.OK, created);
    });
  }

  /**
   * S2 — the run's HELD claim on the checkout this request names, which may pass to it only when the
   * runner answers that nothing a turn of the run started can still write the checkout: no turn or
   * admission in flight there, no git child of one left, every execution there ended with its process
   * confirmed gone. Anything else refuses, the earlier claim untouched.
   */
  private earlierWorktreeClaim(request: ClaimRequest, worktree: string): Decision<EarlierClaim | null> {
    const held = this.db.get<{ claim_id: string }>(
      `SELECT claim_id FROM resource_claims
        WHERE status = 'HELD' AND repository_identity = ? AND worktree_id = ? AND run_id = ?`,
      [request.repositoryIdentity, worktree, request.runId],
    );
    if (!held) return allow(ReasonCode.OK, null);
    const writer = this.#checkoutWriter ? this.#checkoutWriter(request.runId, worktree) : NO_RUNNER;
    if (writer) {
      return deny(
        ReasonCode.CLAIM_WORKTREE_CONFLICT,
        `worktree is still held by this run's claim ${held.claim_id}: ${writer.reason}; ` +
          "it passes to the run's next claim only once nothing of the run can write the checkout",
        {
          repositoryIdentity: request.repositoryIdentity,
          worktree,
          heldByRun: request.runId,
          claimId: held.claim_id,
          writer: writer.evidence,
        },
      );
    }
    const membership = claimAcquisition(this.db, held.claim_id);
    if (membership?.membership !== "PROVEN" || membership.acquisition === null) {
      return deny(
        ReasonCode.CLAIM_WORKTREE_CONFLICT,
        `worktree is still held by this run's claim ${held.claim_id}, and the rows acquired with it cannot be ` +
          "proven complete; nothing is released",
        {
          repositoryIdentity: request.repositoryIdentity,
          worktree,
          heldByRun: request.runId,
          claimId: held.claim_id,
          membership: membership?.membership ?? null,
        },
      );
    }
    return allow(ReasonCode.OK, { claimId: held.claim_id, acquisition: membership.acquisition });
  }

  /**
   * Releases every row of the earlier claim's own acquisition, proven complete (`claimAcquisition`), in
   * the transaction that inserts this claim, so the checkout passes from one claim of the run to the
   * next and is never free to another run in between. A claim acquired apart, even in the same
   * millisecond, is not one of them.
   */
  private handOver(request: ClaimRequest, earlier: EarlierClaim, now: string): void {
    const released = this.db.run(
      `UPDATE resource_claims SET status = 'RELEASED', released_at = ?
        WHERE status = 'HELD' AND run_id = ? AND claim_id >= ? AND claim_id < ?`,
      [now, request.runId, `${earlier.acquisition}.`, `${earlier.acquisition}/`],
    ).changes;
    this.audit.record({
      kind: "CLAIM_RELEASED",
      runId: request.runId,
      sessionId: request.ownerSessionId,
      roleKey: request.ownerRoleKey,
      evidence: { reason: "HANDED_OVER", claimId: earlier.claimId, acquisition: earlier.acquisition, released },
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
      `SELECT c.claim_id, c.run_id, c.owner_session_id FROM resource_claims c
        WHERE ${standingClaimSql("c")} AND c.repository_identity = ? AND c.${column} = ? AND c.run_id <> ?`,
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
      this.expireOverdue();
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

  /**
   * #1269 — a run held for a pending effect on a repository keeps the claims it already holds there until `until`.
   * Only its own HELD, unexpired claims under its current owner generation are extended: none is shortened,
   * revived, moved or created, so the target stays the run's alone while the effect is retried, and nothing more.
   */
  holdThrough(runId: string, repositoryIdentity: string, until: string): number {
    return this.db.run(
      `UPDATE resource_claims SET expires_at = ?
        WHERE run_id = ? AND repository_identity = ? AND status = 'HELD' AND expires_at > ? AND expires_at < ?
          AND owner_binding_generation = (SELECT owner_binding_generation FROM runs WHERE run_id = ?)`,
      [until, runId, repositoryIdentity, this.clock.nowIso(), until, runId],
    ).changes;
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
    return this.readAfterExpirySweep(() => this.db
      .all<RawClaim>(`SELECT * FROM resource_claims WHERE run_id = ? AND status = 'HELD'`, [runId])
      .map(hydrate));
  }

  held(): ClaimRecord[] {
    return this.readAfterExpirySweep(() => this.db
      .all<RawClaim>(`SELECT * FROM resource_claims WHERE status = 'HELD' ORDER BY acquired_at`)
      .map(hydrate));
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
    return this.readAfterExpirySweep(() => {
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
    });
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
