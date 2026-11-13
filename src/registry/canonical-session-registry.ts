import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../core/digest.ts';
import { type Decision, allow, deny } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import type { Db } from '../db/database.ts';
import { TERMINAL_RUN_STATES } from '../domain/run-state.ts';
import type { CanonicalAdoptableSession } from './canonical-self-claim.ts';

/** One row of `canonical_entitlement_transfers` (v57). */
export interface CanonicalEntitlementTransfer {
  transferId: string; projectId: string; fromSessionUuid: string; toSessionUuid: string;
  buzzActorId: string; buzzAddress: string; provisioningRunId: string | null;
  expectedBindingGeneration: number; requestedBy: string; createdAt: string;
  claimedAt: string | null; claimedBindingGeneration: number | null; revokedAt: string | null;
}
interface TransferRow {
  transfer_id: string; project_id: string; from_session_uuid: string; to_session_uuid: string; buzz_actor_id: string;
  buzz_address: string; provisioning_run_id: string | null; expected_binding_generation: number; requested_by: string;
  created_at: string; claimed_at: string | null; claimed_binding_generation: number | null; revoked_at: string | null;
}
const transferOf = (r: TransferRow): CanonicalEntitlementTransfer => ({
  transferId: r.transfer_id, projectId: r.project_id, fromSessionUuid: r.from_session_uuid, toSessionUuid: r.to_session_uuid,
  buzzActorId: r.buzz_actor_id, buzzAddress: r.buzz_address, provisioningRunId: r.provisioning_run_id,
  expectedBindingGeneration: r.expected_binding_generation, requestedBy: r.requested_by, createdAt: r.created_at,
  claimedAt: r.claimed_at, claimedBindingGeneration: r.claimed_binding_generation, revokedAt: r.revoked_at,
});

export interface CanonicalEntitlementTransferRequest {
  projectId: string; fromSessionUuid: string; toSessionUuid: string; expectedBindingGeneration: number;
}

const bootstrapBlocks = (projectId: string, runId: string): Decision<never> =>
  deny(ReasonCode.CONFLICT, 'an adopted bootstrap of the project has no first manifest yet; it finishes or is cancelled before a transfer', {
    refusal: 'TRANSFER_BLOCKED_BY_ADOPTED_BOOTSTRAP', projectId, runId,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DB tombstones take precedence over legacy environment configuration. */
export class CanonicalSessionRegistry {
  constructor(private readonly db: Db) {}
  effective(environment: readonly CanonicalAdoptableSession[] = []): CanonicalAdoptableSession[] {
    const rows = this.db.all<{session_uuid:string; project_id:string; buzz_actor_id:string; buzz_address:string; revoked_at:string|null}>(`SELECT * FROM canonical_session_entitlements ORDER BY project_id`);
    // v57: a project's claimed, unrevoked transfer is its entitlement; the rows it superseded stay tombstones. A
    // pending transfer is not: until its conversation claims, the predecessor stays the project's entitlement.
    const transferred = this.db.all<{session_uuid:string; project_id:string; buzz_actor_id:string; buzz_address:string; revoked_at:string|null}>(`SELECT to_session_uuid AS session_uuid, project_id, buzz_actor_id, buzz_address, revoked_at FROM canonical_entitlement_transfers WHERE claimed_at IS NOT NULL AND revoked_at IS NULL ORDER BY project_id`);
    const retired = new Set(this.db.all<{project_id:string}>(`SELECT project_id FROM projects WHERE retired_at IS NOT NULL UNION SELECT project_id FROM project_retirements`).map(r => r.project_id));
    const tombstones = rows.filter(r => r.revoked_at !== null);
    const entries = environment.filter(e => !retired.has(e.projectId) && !tombstones.some(r => r.project_id === e.projectId || r.session_uuid === e.sessionUuid));
    for (const row of [...rows.filter(r => r.revoked_at === null), ...transferred].filter(r => !retired.has(r.project_id))) {
      const entry = {sessionUuid:row.session_uuid, projectId:row.project_id, buzzActorId:row.buzz_actor_id, buzzAddress:row.buzz_address};
      const conflicts = entries.filter(e => e.sessionUuid === entry.sessionUuid || e.projectId === entry.projectId || e.buzzActorId === entry.buzzActorId);
      if (conflicts.some(e => e.sessionUuid !== entry.sessionUuid || e.projectId !== entry.projectId || e.buzzActorId !== entry.buzzActorId || (e.buzzAddress !== undefined && e.buzzAddress !== entry.buzzAddress))) throw new Error('canonical environment/DB entitlement conflict');
      for (const e of conflicts) entries.splice(entries.indexOf(e), 1);
      entries.push(entry);
    }
    return entries;
  }
  /**
   * The entries one self-claim may be admitted on: `effective`, except that the conversation a pending transfer
   * names, when it is the one claiming, stands in for its project's entry (the transfer's predecessor). Only that
   * claim sees it; every other reader, and every other conversation, still finds the predecessor.
   */
  effectiveFor(environment: readonly CanonicalAdoptableSession[], claimedSessionUuid: string): CanonicalAdoptableSession[] {
    const entries = this.effective(environment);
    const pending = this.pendingTransferTo(claimedSessionUuid);
    if (!pending) return entries;
    const at = entries.findIndex(e => e.projectId === pending.projectId && e.sessionUuid === pending.fromSessionUuid);
    if (at === -1) return entries;
    entries[at] = {sessionUuid:pending.toSessionUuid, projectId:pending.projectId, buzzActorId:pending.buzzActorId, buzzAddress:pending.buzzAddress};
    return entries;
  }
  grant(entry: Required<CanonicalAdoptableSession>, runId: string | null): void {
    if (this.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[entry.projectId])) throw new Error('retired project cannot receive entitlement');
    // v57: the conversation a claimed transfer holds is granted only as exactly that transfer, which already holds
    // it; a conversation a pending transfer names, or one a claimed transfer superseded, is never granted.
    const held = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE to_session_uuid = ? AND claimed_at IS NOT NULL AND revoked_at IS NULL`, [entry.sessionUuid]);
    if (held) {
      if (canonicalJson({sessionUuid:held.to_session_uuid,projectId:held.project_id,buzzActorId:held.buzz_actor_id,buzzAddress:held.buzz_address}) !== canonicalJson(entry)) throw new Error('canonical entitlement conflicts with allocation or tombstone');
      return;
    }
    if (this.db.get(`SELECT 1 FROM canonical_entitlement_transfers WHERE (to_session_uuid = ? AND (claimed_at IS NOT NULL OR revoked_at IS NULL)) OR (from_session_uuid = ? AND claimed_at IS NOT NULL)`, [entry.sessionUuid, entry.sessionUuid])) {
      throw new Error('canonical entitlement conflicts with allocation or tombstone');
    }
    const old = this.db.get<{revoked_at:string|null}>(`SELECT revoked_at FROM canonical_session_entitlements WHERE session_uuid = ? OR project_id = ?`, [entry.sessionUuid, entry.projectId]);
    if (old) {
      if (old.revoked_at !== null || !this.effective().some(e => canonicalJson(e) === canonicalJson(entry))) throw new Error('canonical entitlement conflicts with allocation or tombstone');
      return;
    }
    this.db.run(`INSERT INTO canonical_session_entitlements(session_uuid,project_id,buzz_actor_id,buzz_address,provisioning_run_id) VALUES (?,?,?,?,?)`, [entry.sessionUuid,entry.projectId,entry.buzzActorId,entry.buzzAddress,runId]);
  }
  revoke(projectId: string, at: string): void {
    this.db.run(`UPDATE canonical_session_entitlements SET revoked_at = ?, revision = revision + 1 WHERE project_id = ? AND revoked_at IS NULL`, [at,projectId]);
    this.db.run(`UPDATE canonical_entitlement_transfers SET revoked_at = ?, revision = revision + 1 WHERE project_id = ? AND revoked_at IS NULL`, [at,projectId]);
  }
  /**
   * v57 — records a PENDING transfer of `projectId`'s canonical entitlement from exactly `fromSessionUuid` to
   * `toSessionUuid`, in the caller's transaction. Nothing else moves: the predecessor stays the project's
   * effective entitlement, with its conversation, Buzz identity and inbound path, until `toSessionUuid`'s
   * self-claim (`claim`). `grant` is neither used nor weakened. Refused unless the project is registered and
   * unretired, `fromSessionUuid` is its current holder, the role's highest generation is exactly
   * `expectedBindingGeneration`, no other transfer of it is pending, `toSessionUuid` was never entitled, and no
   * execution or unexpired pipeline attempt of a run of the project, or owned in its PRIMARY_CTO role (an adopted
   * bootstrap's run has no project_id), is RUNNING.
   */
  transfer(request: CanonicalEntitlementTransferRequest, requestedBy: string, at: string): Decision<CanonicalEntitlementTransfer> {
    if (!this.db.inTransaction) return deny(ReasonCode.CONFLICT, "a canonical entitlement transfer requires the caller's transaction", {});
    const { projectId, fromSessionUuid, toSessionUuid, expectedBindingGeneration } = request;
    if (!UUID.test(fromSessionUuid) || !UUID.test(toSessionUuid) || fromSessionUuid === toSessionUuid) {
      return deny(ReasonCode.INVALID_ARGUMENT, 'fromSessionUuid and toSessionUuid must be two different UUIDs', {});
    }
    if (!Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, 'expectedBindingGeneration must be a non-negative safe integer', {});
    }
    const project = this.db.get<{retired_at:string|null}>(`SELECT retired_at FROM projects WHERE project_id = ?`, [projectId]);
    if (!project) return deny(ReasonCode.NOT_FOUND, 'unknown project', { projectId });
    if (project.retired_at !== null || this.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`, [projectId])) {
      return deny(ReasonCode.CONFLICT, "a retired project's canonical entitlement is not transferred", { projectId });
    }
    const pending = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE project_id = ? AND revoked_at IS NULL AND claimed_at IS NULL`, [projectId]);
    if (pending) {
      return deny(ReasonCode.CONFLICT, "another transfer of this project is pending; cancel it first", { projectId, pendingTransferId: pending.transfer_id });
    }
    const holder = this.holder(projectId);
    if (!holder) return deny(ReasonCode.NOT_FOUND, 'the project has no canonical entitlement to transfer', { projectId });
    if (holder.sessionUuid !== fromSessionUuid) {
      return deny(ReasonCode.CONFLICT, "fromSessionUuid is not the project's current canonical conversation", { projectId, fromSessionUuid });
    }
    const roleKey = `PRIMARY_CTO:${projectId}`;
    const generation = this.db.get<{maximum:number|null}>(`SELECT MAX(binding_generation) AS maximum FROM assignments WHERE role_key = ?`, [roleKey])?.maximum ?? 0;
    if (generation !== expectedBindingGeneration) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "expectedBindingGeneration is not the role's current generation", { roleKey, expected: expectedBindingGeneration, actual: generation });
    }
    if (this.db.get(`SELECT 1 FROM canonical_session_entitlements WHERE session_uuid = ? UNION ALL SELECT 1 FROM canonical_entitlement_transfers WHERE (to_session_uuid = ? AND (claimed_at IS NOT NULL OR revoked_at IS NULL)) OR (from_session_uuid = ? AND claimed_at IS NOT NULL)`, [toSessionUuid, toSessionUuid, toSessionUuid])) {
      return deny(ReasonCode.CONFLICT, 'toSessionUuid is or was entitled to a canonical role', { toSessionUuid });
    }
    const running = this.runningWork(projectId, at);
    if (running) {
      return deny(ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT, `the project has ${running.what}; the transfer waits for it to end`, { projectId, runId: running.run_id });
    }
    const bootstrap = this.adoptedBootstrapBeforeFirstManifest(projectId);
    if (bootstrap) return bootstrapBlocks(projectId, bootstrap);
    const transferId = `entitlement-transfer-${randomUUID()}`;
    this.db.run(
      `INSERT INTO canonical_entitlement_transfers (transfer_id, project_id, from_session_uuid, to_session_uuid, buzz_actor_id, buzz_address, provisioning_run_id, expected_binding_generation, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transferId, projectId, fromSessionUuid, toSessionUuid, holder.buzzActorId, holder.buzzAddress, holder.provisioningRunId, expectedBindingGeneration, requestedBy, at],
    );
    return allow(ReasonCode.OK, this.transferById(transferId)!);
  }
  /**
   * A RUNNING task execution, or a RUNNING and unexpired candidate pipeline attempt, of a run of `projectId` or of
   * a run owned in its PRIMARY_CTO role, whichever carries the project. The transfer and its claim both wait for it.
   */
  runningWork(projectId: string, at: string): { what: string; run_id: string } | null {
    return this.db.get<{what:string; run_id:string}>(
      `WITH owned AS (SELECT run_id FROM runs WHERE project_id = ? OR owner_role_key = ?)
       SELECT 'a RUNNING task execution' AS what, run_id FROM task_executions
        WHERE status = 'RUNNING' AND run_id IN (SELECT run_id FROM owned)
       UNION ALL
       SELECT 'a RUNNING candidate pipeline attempt', run_id FROM candidate_pipeline_attempts
        WHERE state = 'RUNNING' AND deadline_at > ? AND run_id IN (SELECT run_id FROM owned)
       LIMIT 1`, [projectId, `PRIMARY_CTO:${projectId}`, at]) ?? null;
  }
  /**
   * An unfinished PROJECT_BOOTSTRAP run that adopted `projectId`'s canonical CTO while the project has no first
   * manifest yet. v56's pointer guard activates it only on the entitlement it was created on, so a transfer (and
   * its claim) waits until that run finishes or is cancelled.
   */
  adoptedBootstrapBeforeFirstManifest(projectId: string): string | null {
    return this.db.get<{run_id:string}>(
      `SELECT r.run_id FROM runs r
        WHERE EXISTS (SELECT 1 FROM projects p WHERE p.project_id = ? AND p.active_manifest_digest IS NULL)
          AND r.kind = 'PROJECT_BOOTSTRAP' AND r.project_id IS NULL
          AND r.state NOT IN (${TERMINAL_RUN_STATES.map(() => '?').join(',')})
          AND (r.owner_role_key = ? OR EXISTS (
            SELECT 1 FROM audit_events e WHERE e.run_id = r.run_id AND e.kind = 'RUN_CREATED'
              AND CASE WHEN json_valid(e.evidence_json) THEN json_extract(e.evidence_json, '$.adoptCanonicalCto.projectId') IS ? ELSE 0 END))
        ORDER BY r.run_id LIMIT 1`,
      [projectId, ...TERMINAL_RUN_STATES, `PRIMARY_CTO:${projectId}`, projectId])?.run_id ?? null;
  }
  /** Cancels `transferId`, a PENDING transfer of `projectId`, by revoking it unclaimed; nothing else changes. */
  cancel(projectId: string, transferId: string, at: string): Decision<CanonicalEntitlementTransfer> {
    const row = this.transferById(transferId);
    if (!row || row.projectId !== projectId) return deny(ReasonCode.NOT_FOUND, 'no such transfer of this project', { projectId, transferId });
    if (row.claimedAt !== null || row.revokedAt !== null) {
      return deny(ReasonCode.CONFLICT, 'only a pending transfer is cancelled', { projectId, transferId, claimed: row.claimedAt !== null, revoked: row.revokedAt !== null });
    }
    this.db.run(`UPDATE canonical_entitlement_transfers SET revoked_at = ?, revision = revision + 1 WHERE transfer_id = ? AND claimed_at IS NULL AND revoked_at IS NULL`, [at, transferId]);
    return allow(ReasonCode.OK, this.transferById(transferId)!);
  }
  /**
   * The claim half, inside the successor's self-claim transaction: the pending transfer's predecessor (still
   * the project's holder) is revoked and stays its tombstone, and the transfer is claimed at `bindingGeneration`,
   * becoming the project's entitlement. Refused, with nothing written, unless both still hold.
   */
  claim(transferId: string, bindingGeneration: number, at: string): Decision<CanonicalEntitlementTransfer> {
    const row = this.transferById(transferId);
    if (!row || row.claimedAt !== null || row.revokedAt !== null) {
      return deny(ReasonCode.CONFLICT, 'the entitlement transfer is no longer pending', { transferId });
    }
    const holder = this.holder(row.projectId);
    if (!holder || holder.sessionUuid !== row.fromSessionUuid) {
      return deny(ReasonCode.CONFLICT, "the transfer's predecessor no longer holds the project", { transferId, projectId: row.projectId });
    }
    // The CEO authorized the move from the role at exactly `expectedBindingGeneration`; a claim at any generation
    // but the next one means the role moved since (the old conversation recovered into a later one), and the
    // transfer is stale: the CEO cancels it and issues it again.
    if (bindingGeneration !== row.expectedBindingGeneration + 1) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, 'the entitlement transfer is stale: the role moved since it was authorized', {
        refusal: 'TRANSFER_GENERATION_STALE', transferId, expectedBindingGeneration: row.expectedBindingGeneration, claimedGeneration: bindingGeneration,
      });
    }
    const bootstrap = this.adoptedBootstrapBeforeFirstManifest(row.projectId);
    if (bootstrap) return bootstrapBlocks(row.projectId, bootstrap);
    if (holder.transferId === null) {
      this.db.run(`UPDATE canonical_session_entitlements SET revoked_at = ?, revision = revision + 1 WHERE session_uuid = ? AND revoked_at IS NULL`, [at, row.fromSessionUuid]);
    } else {
      this.db.run(`UPDATE canonical_entitlement_transfers SET revoked_at = ?, revision = revision + 1 WHERE transfer_id = ? AND revoked_at IS NULL`, [at, holder.transferId]);
    }
    this.db.run(`UPDATE canonical_entitlement_transfers SET claimed_at = ?, claimed_binding_generation = ?, revision = revision + 1 WHERE transfer_id = ? AND claimed_at IS NULL AND revoked_at IS NULL`, [at, bindingGeneration, transferId]);
    return allow(ReasonCode.OK, this.transferById(transferId)!);
  }
  /** The project's one entitlement in the database: its own unrevoked row, or the claimed transfer that superseded it. */
  holder(projectId: string): { sessionUuid: string; buzzActorId: string; buzzAddress: string; provisioningRunId: string | null; transferId: string | null } | null {
    const transfer = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE project_id = ? AND claimed_at IS NOT NULL AND revoked_at IS NULL`, [projectId]);
    if (transfer) return { sessionUuid: transfer.to_session_uuid, buzzActorId: transfer.buzz_actor_id, buzzAddress: transfer.buzz_address, provisioningRunId: transfer.provisioning_run_id, transferId: transfer.transfer_id };
    const row = this.db.get<{session_uuid:string; buzz_actor_id:string; buzz_address:string; provisioning_run_id:string|null}>(`SELECT * FROM canonical_session_entitlements WHERE project_id = ? AND revoked_at IS NULL`, [projectId]);
    return row ? { sessionUuid: row.session_uuid, buzzActorId: row.buzz_actor_id, buzzAddress: row.buzz_address, provisioningRunId: row.provisioning_run_id, transferId: null } : null;
  }
  transferById(transferId: string): CanonicalEntitlementTransfer | null {
    const row = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE transfer_id = ?`, [transferId]);
    return row ? transferOf(row) : null;
  }
  /** The unrevoked, still unclaimed transfer naming `sessionUuid`, which that conversation's first self-claim consumes. */
  pendingTransferTo(sessionUuid: string): CanonicalEntitlementTransfer | null {
    const row = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE to_session_uuid = ? AND revoked_at IS NULL AND claimed_at IS NULL`, [sessionUuid]);
    return row ? transferOf(row) : null;
  }
  fingerprint(): string { return canonicalJson({entitlements:this.db.all(`SELECT * FROM canonical_session_entitlements ORDER BY project_id`),retirements:this.db.all(`SELECT * FROM project_retirements ORDER BY project_id`),transfers:this.db.all(`SELECT * FROM canonical_entitlement_transfers ORDER BY transfer_id`)}); }
}
