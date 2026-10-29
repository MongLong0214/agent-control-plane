import type { ControlPlane } from '../app/control-plane.ts';
import { allow, deny, type Decision } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import { CanonicalSessionRegistry } from './canonical-session-registry.ts';
import { Role, roleKeyFor } from '../domain/types.ts';
import { HostRetirementRefusal } from '../runtime/host-project-provisioner.ts';

/**
 * #1229 — a retirement commits its irreversible rows (the retirement record, which is also negative authority, and the
 * entitlement revocation) only once the host has changed something: after the host retire succeeded, or after it
 * stopped part-way, when the record keeps the project suspended until the daemon's sweep finishes it. Until then the
 * one marker is the project's suspension, which blocks dispatch while runs are cancelled and the host retires, and is
 * taken back on every refusal that leaves the host as it was. Such a refusal leaves no committed change but audit rows
 * and the runs it cancelled: cancellation must precede the host step, which moves the clone their workers use.
 */
export async function retireProject(cp:ControlPlane,projectId:string,reason:string):Promise<Decision<unknown>> {
  const project = cp.projects.get(projectId);
  if (!project) return deny(ReasonCode.NOT_FOUND,'unknown project',{projectId});
  if (project.retiredAt) return allow(ReasonCode.OK,{projectId,retiredAt:project.retiredAt});
  const rerun = `run agentctl project retire ${projectId} again`;
  try {await cp.residentProjects.verifyRetirement(projectId);} catch (error) {
    if (error instanceof HostRetirementRefusal) return deny(ReasonCode.CONFLICT,`host retirement refused: ${error.reason}; nothing was changed`,{projectId,refusal:error.reason,requiredOrder:[...error.requiredOrder]});
    return deny(ReasonCode.CONFLICT,'host retirement could not be verified; nothing was changed',{projectId,requiredOrder:[rerun]});
  }
  const work = cp.db.all<{run_id:string;state:string}>(`SELECT run_id,state FROM runs WHERE (project_id = ? OR run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)) AND state NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY created_at,run_id`,[projectId,projectId]);
  // Confirmed/merged effects must settle through their own finalizer; cancellation never erases them.
  const settling = work.filter(r => ['CEO_APPROVED','FINALIZING','MERGING','POST_MERGE_VERIFYING','BLOCKED_POST_MERGE'].includes(r.state)).map(r => r.run_id);
  if (settling.length > 0) return deny(ReasonCode.CONFLICT,'retirement waits for confirmed external effects to settle; nothing was changed',{projectId,settling,requiredOrder:[`let runs ${settling.join(', ')} finish finalizing`,rerun]});
  // The reversible marker: this call suspends only a project that was not suspended, and takes that back on a refusal.
  const markedHere = !project.suspended;
  if (markedHere) cp.projects.setSuspended(projectId,true,true);
  const unmark = ():void => {if (markedHere) cp.projects.setSuspended(projectId,false,true);};
  const cancelledRuns:string[] = [];
  for (const run of work) {
    const cancelled = cp.runs.cancel(run.run_id,`project retirement: ${reason}`);
    if (!cancelled.allowed) {unmark();return deny(cancelled.reasonCode,`${cancelled.message}; retirement stopped before the host step`,{...cancelled.evidence,projectId,cancelledRuns,requiredOrder:[rerun]});}
    cancelledRuns.push(run.run_id);
  }
  const workers = await cp.workerRetirement.reconcile();
  const projectWorkers = new Set(cp.db.all<{worker_session_id:string}>(`SELECT DISTINCT e.worker_session_id FROM task_executions e JOIN runs r ON r.run_id = e.run_id WHERE r.project_id = ? OR r.run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)`,[projectId,projectId]).map(r => r.worker_session_id));
  if (workers.remaining.some(w => projectWorkers.has(w.sessionId)) || workers.stopFailed.some(id => projectWorkers.has(id)) || cp.db.get(`SELECT 1 FROM assignments a JOIN tasks t ON t.task_id = a.task_id JOIN runs r ON r.run_id = t.run_id WHERE a.role = 'WORKER' AND a.status = 'ACTIVE' AND r.project_id = ?`,[projectId])) {
    unmark();
    return deny(ReasonCode.CONFLICT,'retirement waits for worker processes to settle; it stopped before the host step',{projectId,cancelledRuns,requiredOrder:["let the project's worker processes stop",rerun]});
  }
  const at = cp.clock.nowIso();
  // Once the host has changed something the retirement is committed as pending: its record suppresses the entitlement
  // and keeps the project suspended until the daemon's sweep runs this again.
  const commitPending = ():void => cp.db.tx(() => {
    if (!cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[projectId])) cp.db.run(`INSERT INTO project_retirements(project_id,requested_at,reason) VALUES (?,?,?)`,[projectId,at,reason]);
    new CanonicalSessionRegistry(cp.db).revoke(projectId,at);
  });
  try {await cp.residentProjects.retire(projectId);} catch (error) {
    if (error instanceof HostRetirementRefusal && !error.hostChanged) {
      unmark();
      return deny(ReasonCode.CONFLICT,`host retirement refused: ${error.reason}; the host and the project's retirement state are as they were`,{projectId,refusal:error.reason,requiredOrder:[...error.requiredOrder],cancelledRuns});
    }
    commitPending();
    return deny(ReasonCode.CONFLICT,`host retirement stopped after changing the host${error instanceof HostRetirementRefusal ? `: ${error.reason}` : ''}; project remains suspended and its retirement resumes`,
      {projectId,...(error instanceof HostRetirementRefusal ? {refusal:error.reason,requiredOrder:[...error.requiredOrder]} : {})});
  }
  commitPending();
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
