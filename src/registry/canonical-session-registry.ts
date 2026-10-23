import { canonicalJson } from '../core/digest.ts';
import type { Db } from '../db/database.ts';
import type { CanonicalAdoptableSession } from './canonical-self-claim.ts';

/** DB tombstones take precedence over legacy environment configuration. */
export class CanonicalSessionRegistry {
  constructor(private readonly db: Db) {}
  effective(environment: readonly CanonicalAdoptableSession[] = []): CanonicalAdoptableSession[] {
    const rows = this.db.all<{session_uuid:string; project_id:string; buzz_actor_id:string; buzz_address:string; revoked_at:string|null}>(`SELECT * FROM canonical_session_entitlements ORDER BY project_id`);
    const retired = new Set(this.db.all<{project_id:string}>(`SELECT project_id FROM projects WHERE retired_at IS NOT NULL UNION SELECT project_id FROM project_retirements`).map(r => r.project_id));
    const tombstones = rows.filter(r => r.revoked_at !== null);
    const entries = environment.filter(e => !retired.has(e.projectId) && !tombstones.some(r => r.project_id === e.projectId || r.session_uuid === e.sessionUuid));
    for (const row of rows.filter(r => r.revoked_at === null && !retired.has(r.project_id))) {
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
    const old = this.db.get<{revoked_at:string|null}>(`SELECT revoked_at FROM canonical_session_entitlements WHERE session_uuid = ? OR project_id = ?`, [entry.sessionUuid, entry.projectId]);
    if (old) {
      if (old.revoked_at !== null || !this.effective().some(e => canonicalJson(e) === canonicalJson(entry))) throw new Error('canonical entitlement conflicts with allocation or tombstone');
      return;
    }
    this.db.run(`INSERT INTO canonical_session_entitlements(session_uuid,project_id,buzz_actor_id,buzz_address,provisioning_run_id) VALUES (?,?,?,?,?)`, [entry.sessionUuid,entry.projectId,entry.buzzActorId,entry.buzzAddress,runId]);
  }
  revoke(projectId: string, at: string): void {
    this.db.run(`UPDATE canonical_session_entitlements SET revoked_at = ?, revision = revision + 1 WHERE project_id = ? AND revoked_at IS NULL`, [at,projectId]);
  }
  fingerprint(): string { return canonicalJson({entitlements:this.db.all(`SELECT * FROM canonical_session_entitlements ORDER BY project_id`),retirements:this.db.all(`SELECT * FROM project_retirements ORDER BY project_id`)}); }
}
