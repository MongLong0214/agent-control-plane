import type { ControlPlane } from '../app/control-plane.ts';
import { allow, deny, type Decision } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import { CanonicalSessionRegistry } from './canonical-session-registry.ts';
import { Role, roleKeyFor } from '../domain/types.ts';
import { openPostMergeResponsibility } from '../daemon/post-merge-follow-up.ts';

/** Suspension commits first. Failure leaves a resumable, non-dispatching project with its history intact. */
export async function retireProject(cp:ControlPlane,projectId:string,reason:string):Promise<Decision<unknown>> {
  const project = cp.projects.get(projectId);
  if (!project) return deny(ReasonCode.NOT_FOUND,'unknown project',{projectId});
  if (project.retiredAt) return allow(ReasonCode.OK,{projectId,retiredAt:project.retiredAt});
  cp.projects.setSuspended(projectId,true,true);
  if (!cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[projectId])) cp.db.run(`INSERT INTO project_retirements(project_id,requested_at,reason) VALUES (?,?,?)`,[projectId,cp.clock.nowIso(),reason]);
  const work = cp.db.all<{run_id:string;state:string}>(`SELECT run_id,state FROM runs WHERE (project_id = ? OR run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)) AND state NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY created_at,run_id`,[projectId,projectId]);
  // Confirmed/merged effects must settle through their own finalizer; cancellation never erases them.
  // #1189 A10 (CEO ruling 3) — a BLOCKED_POST_MERGE run holds retirement while it holds open recovery responsibility, named in the refusal. With no recovery handover record in this code, that is every one of them; one that settled would be kept as it is, never cancelled.
  // A run still in a finalizing state always holds it, and the refusal names what it holds open from evidence, not from its state name: a CEO_APPROVED run blocked for recovery (B15) is not an ordinary finalization in flight.
  const waitingOn = work.flatMap(r => r.state === 'BLOCKED_POST_MERGE' ? ((open: string[]) => open.length > 0 ? [{runId:r.run_id,state:r.state,open}] : [])(openPostMergeResponsibility(cp.db,r.run_id)) : ['CEO_APPROVED','FINALIZING','MERGING','POST_MERGE_VERIFYING'].includes(r.state) ? ((open: string[]) => [{runId:r.run_id,state:r.state,...(open.length > 0 ? {open} : {})}])(openPostMergeResponsibility(cp.db,r.run_id)) : []);
  if (waitingOn.length > 0) return deny(ReasonCode.CONFLICT,'retirement waits for confirmed external effects to settle',{projectId,waitingOn});
  for (const run of work) {if (run.state === 'BLOCKED_POST_MERGE') continue;const cancelled = cp.runs.cancel(run.run_id,`project retirement: ${reason}`);if (!cancelled.allowed) return cancelled;}
  const workers = await cp.workerRetirement.reconcile();
  const projectWorkers = new Set(cp.db.all<{worker_session_id:string}>(`SELECT DISTINCT e.worker_session_id FROM task_executions e JOIN runs r ON r.run_id = e.run_id WHERE r.project_id = ? OR r.run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)`,[projectId,projectId]).map(r => r.worker_session_id));
  if (workers.remaining.some(w => projectWorkers.has(w.sessionId)) || workers.stopFailed.some(id => projectWorkers.has(id)) || cp.db.get(`SELECT 1 FROM assignments a JOIN tasks t ON t.task_id = a.task_id JOIN runs r ON r.run_id = t.run_id WHERE a.role = 'WORKER' AND a.status = 'ACTIVE' AND r.project_id = ?`,[projectId])) return deny(ReasonCode.CONFLICT,'retirement waits for worker processes to settle',{projectId});
  const at = cp.clock.nowIso();
  new CanonicalSessionRegistry(cp.db).revoke(projectId,at);
  try {await cp.residentProjects.retire(projectId);} catch {return deny(ReasonCode.CONFLICT,'host retirement pending; project remains suspended',{projectId});}
  return cp.db.txDecision(() => {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO,{projectId});
    if (cp.bindings.active(roleKey)) {const revoked = cp.bindings.revoke(roleKey,reason,{allowBlockedRuns:true,allowHeldRuns:true});if (!revoked.allowed) return revoked;}
    cp.db.run(`UPDATE projects SET retired_at = ?, suspended = 1 WHERE project_id = ?`,[at,projectId]);
    cp.db.run(`UPDATE repositories SET retired_at = ? WHERE project_id = ? AND retired_at IS NULL`,[at,projectId]);
    cp.db.run(`UPDATE bootstrap_applications SET retired_at = ? WHERE project_id = ? AND retired_at IS NULL`,[at,projectId]);
    cp.db.run(`UPDATE project_retirements SET completed_at = ? WHERE project_id = ?`,[at,projectId]);
    cp.audit.record({kind:'PROJECT_RETIRED',projectId,evidence:{reason,retiredAt:at}});
    return allow(ReasonCode.OK,{projectId,retiredAt:at});
  });
}
