import type { ControlPlane } from '../app/control-plane.ts';
import { allow, deny, type Decision } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import { CanonicalSessionRegistry } from './canonical-session-registry.ts';
import { Role, roleKeyFor } from '../domain/types.ts';
import { HostRetirementRefusal } from '../runtime/host-project-provisioner.ts';

/** Suspension commits first. Failure leaves a resumable, non-dispatching project with its history intact. */
export async function retireProject(cp:ControlPlane,projectId:string,reason:string):Promise<Decision<unknown>> {
  const project = cp.projects.get(projectId);
  if (!project) return deny(ReasonCode.NOT_FOUND,'unknown project',{projectId});
  if (project.retiredAt) return allow(ReasonCode.OK,{projectId,retiredAt:project.retiredAt});
  cp.projects.setSuspended(projectId,true,true);
  if (!cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[projectId])) cp.db.run(`INSERT INTO project_retirements(project_id,requested_at,reason) VALUES (?,?,?)`,[projectId,cp.clock.nowIso(),reason]);
  const work = cp.db.all<{run_id:string;state:string}>(`SELECT run_id,state FROM runs WHERE (project_id = ? OR run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)) AND state NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY created_at,run_id`,[projectId,projectId]);
  // Confirmed/merged effects must settle through their own finalizer; cancellation never erases them.
  if (work.some(r => ['CEO_APPROVED','FINALIZING','MERGING','POST_MERGE_VERIFYING','BLOCKED_POST_MERGE'].includes(r.state))) return deny(ReasonCode.CONFLICT,'retirement waits for confirmed external effects to settle',{projectId});
  for (const run of work) {const cancelled = cp.runs.cancel(run.run_id,`project retirement: ${reason}`);if (!cancelled.allowed) return cancelled;}
  const workers = await cp.workerRetirement.reconcile();
  const projectWorkers = new Set(cp.db.all<{worker_session_id:string}>(`SELECT DISTINCT e.worker_session_id FROM task_executions e JOIN runs r ON r.run_id = e.run_id WHERE r.project_id = ? OR r.run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)`,[projectId,projectId]).map(r => r.worker_session_id));
  if (workers.remaining.some(w => projectWorkers.has(w.sessionId)) || workers.stopFailed.some(id => projectWorkers.has(id)) || cp.db.get(`SELECT 1 FROM assignments a JOIN tasks t ON t.task_id = a.task_id JOIN runs r ON r.run_id = t.run_id WHERE a.role = 'WORKER' AND a.status = 'ACTIVE' AND r.project_id = ?`,[projectId])) return deny(ReasonCode.CONFLICT,'retirement waits for worker processes to settle',{projectId});
  const at = cp.clock.nowIso();
  new CanonicalSessionRegistry(cp.db).revoke(projectId,at);
  try {await cp.residentProjects.retire(projectId);} catch (error) {
    // #1229 — a host refusal that names its order is reported with it; the host changed nothing before refusing.
    if (error instanceof HostRetirementRefusal) return deny(ReasonCode.CONFLICT,`host retirement refused: ${error.reason}; project remains suspended`,{projectId,refusal:error.reason,requiredOrder:[...error.requiredOrder]});
    return deny(ReasonCode.CONFLICT,'host retirement pending; project remains suspended',{projectId});
  }
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
