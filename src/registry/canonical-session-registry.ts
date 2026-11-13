import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../core/digest.ts';
import { type Decision, allow, deny } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import type { Db } from '../db/database.ts';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DB tombstones take precedence over legacy environment configuration. */
export class CanonicalSessionRegistry {
  constructor(private readonly db: Db) {}
  effective(environment: readonly CanonicalAdoptableSession[] = []): CanonicalAdoptableSession[] {
    const rows = this.db.all<{session_uuid:string; project_id:string; buzz_actor_id:string; buzz_address:string; revoked_at:string|null}>(`SELECT * FROM canonical_session_entitlements ORDER BY project_id`);
    // v57: a project's unrevoked transfer is its entitlement; the rows it superseded stay tombstones.
    const transferred = this.db.all<{session_uuid:string; project_id:string; buzz_actor_id:string; buzz_address:string; revoked_at:string|null}>(`SELECT to_session_uuid AS session_uuid, project_id, buzz_actor_id, buzz_address, revoked_at FROM canonical_entitlement_transfers WHERE revoked_at IS NULL ORDER BY project_id`);
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
  grant(entry: Required<CanonicalAdoptableSession>, runId: string | null): void {
    if (this.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[entry.projectId])) throw new Error('retired project cannot receive entitlement');
    // v57: a conversation a transfer named is granted only as its project's current transfer, which already holds it.
    const transfer = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE to_session_uuid = ? OR from_session_uuid = ?`, [entry.sessionUuid, entry.sessionUuid]);
    if (transfer) {
      if (transfer.revoked_at !== null || transfer.to_session_uuid !== entry.sessionUuid || canonicalJson({sessionUuid:transfer.to_session_uuid,projectId:transfer.project_id,buzzActorId:transfer.buzz_actor_id,buzzAddress:transfer.buzz_address}) !== canonicalJson(entry)) throw new Error('canonical entitlement conflicts with allocation or tombstone');
      return;
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
   * v57 — moves `projectId`'s canonical entitlement from exactly `fromSessionUuid` to `toSessionUuid`, in the
   * caller's transaction: the predecessor (the project's entitlement row, or its current transfer) is revoked
   * and stays its tombstone, and a transfer row carrying its Buzz actor, room and provisioning run becomes the
   * project's one entitlement. `grant` is neither used nor weakened. Refused unless the project is registered
   * and unretired, `fromSessionUuid` is its current holder, the role's highest generation is exactly
   * `expectedBindingGeneration`, no earlier transfer of it is still unclaimed, `toSessionUuid` was never
   * entitled anywhere, and no execution or pipeline attempt of the project's runs is RUNNING.
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
      return deny(ReasonCode.CONFLICT, "an earlier transfer of this project still waits for its conversation's claim", { projectId, pendingTransferId: pending.transfer_id });
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
    if (this.db.get(`SELECT 1 FROM canonical_session_entitlements WHERE session_uuid = ? UNION ALL SELECT 1 FROM canonical_entitlement_transfers WHERE to_session_uuid = ? OR from_session_uuid = ?`, [toSessionUuid, toSessionUuid, toSessionUuid])) {
      return deny(ReasonCode.CONFLICT, 'toSessionUuid is or was entitled to a canonical role', { toSessionUuid });
    }
    const running = this.db.get<{what:string; run_id:string}>(
      `SELECT 'a RUNNING task execution' AS what, e.run_id FROM task_executions e JOIN runs r ON r.run_id = e.run_id
        WHERE r.project_id = ? AND e.status = 'RUNNING'
       UNION ALL
       SELECT 'a RUNNING candidate pipeline attempt', a.run_id FROM candidate_pipeline_attempts a JOIN runs r ON r.run_id = a.run_id
        WHERE r.project_id = ? AND a.state = 'RUNNING'
       LIMIT 1`, [projectId, projectId]);
    if (running) {
      return deny(ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT, `the project has ${running.what}; the transfer waits for it to end`, { projectId, runId: running.run_id });
    }
    if (holder.transferId === null) {
      this.db.run(`UPDATE canonical_session_entitlements SET revoked_at = ?, revision = revision + 1 WHERE session_uuid = ? AND revoked_at IS NULL`, [at, fromSessionUuid]);
    } else {
      this.db.run(`UPDATE canonical_entitlement_transfers SET revoked_at = ?, revision = revision + 1 WHERE transfer_id = ? AND revoked_at IS NULL`, [at, holder.transferId]);
    }
    const transferId = `entitlement-transfer-${randomUUID()}`;
    this.db.run(
      `INSERT INTO canonical_entitlement_transfers (transfer_id, project_id, from_session_uuid, to_session_uuid, buzz_actor_id, buzz_address, provisioning_run_id, expected_binding_generation, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transferId, projectId, fromSessionUuid, toSessionUuid, holder.buzzActorId, holder.buzzAddress, holder.provisioningRunId, expectedBindingGeneration, requestedBy, at],
    );
    return allow(ReasonCode.OK, this.transferById(transferId)!);
  }
  /** The project's one unrevoked entitlement in the database: its own row, or the transfer that superseded it. */
  holder(projectId: string): { sessionUuid: string; buzzActorId: string; buzzAddress: string; provisioningRunId: string | null; transferId: string | null } | null {
    const transfer = this.db.get<TransferRow>(`SELECT * FROM canonical_entitlement_transfers WHERE project_id = ? AND revoked_at IS NULL`, [projectId]);
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
  /** Records the self-claim that consumed `transferId`, once, in the caller's transaction. */
  markClaimed(transferId: string, bindingGeneration: number, at: string): boolean {
    return this.db.run(`UPDATE canonical_entitlement_transfers SET claimed_at = ?, claimed_binding_generation = ?, revision = revision + 1 WHERE transfer_id = ? AND claimed_at IS NULL AND revoked_at IS NULL`, [at, bindingGeneration, transferId]).changes === 1;
  }
  fingerprint(): string { return canonicalJson({entitlements:this.db.all(`SELECT * FROM canonical_session_entitlements ORDER BY project_id`),retirements:this.db.all(`SELECT * FROM project_retirements ORDER BY project_id`),transfers:this.db.all(`SELECT * FROM canonical_entitlement_transfers ORDER BY transfer_id`)}); }
}
