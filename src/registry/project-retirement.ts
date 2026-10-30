import type { ControlPlane } from '../app/control-plane.ts';
import { allow, deny, type Decision } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import { CanonicalSessionRegistry } from './canonical-session-registry.ts';
import { Role, roleKeyFor } from '../domain/types.ts';
import { HostRetirementRefusal } from '../runtime/host-project-provisioner.ts';
import { retirementWaitsForSettlement } from '../ceo/ownerless-stalls.ts';

/**
 * #1251 C-P1 — the retirement's intent, committed in the transaction that suspends the project: its reason and whether
 * this retirement took the suspension. A daemon that exits anywhere after that suspension and before the committed
 * rows leaves the intent open, and the daemon's sweep resumes it. `HOST` marks the host step as begun: from then on
 * the host may have changed something even when no answer came back, so a resumed retirement commits its pending
 * record first and never takes the suspension back. A proven no-write refusal of an attempt that had not begun the
 * host step before it closes the intent and takes the suspension back with it.
 * Append-only audit records rather than a new table or column: the schema is not changed for this.
 */
const INTENT = 'PROJECT_RETIREMENT_INTENT';
const WITHDRAWN = 'PROJECT_RETIREMENT_WITHDRAWN';
interface RetirementIntent {reason:string; phase:'SUSPENDED'|'HOST'; suspendedHere:boolean}
const openIntent = (cp:ControlPlane,projectId:string):RetirementIntent|null => {
  const last = cp.db.get<{kind:string;evidence_json:string}>(`SELECT kind,evidence_json FROM audit_events WHERE kind IN (?,?) AND project_id = ? ORDER BY event_id DESC LIMIT 1`,[INTENT,WITHDRAWN,projectId]);
  if (last?.kind !== INTENT) return null;
  const evidence = JSON.parse(last.evidence_json) as Partial<RetirementIntent>;
  return {reason:typeof evidence.reason === 'string' ? evidence.reason : 'resumed retirement',phase:evidence.phase === 'HOST' ? 'HOST' : 'SUSPENDED',suspendedHere:evidence.suspendedHere === true};
};
const recordIntent = (cp:ControlPlane,projectId:string,kind:string,evidence:Record<string,unknown>):void => {
  if (!cp.audit.record({kind,projectId,evidence}).allowed) throw new Error('retirement intent could not be recorded');
};

/** The daemon's sweep: pending retirements, then the intents a daemon exit left open. */
export async function resumeRetirements(cp:ControlPlane):Promise<void> {
  const pending = cp.db.all<{project_id:string;reason:string}>(`SELECT project_id,reason FROM project_retirements WHERE completed_at IS NULL ORDER BY requested_at,project_id`);
  const intents = cp.db.all<{project_id:string}>(`SELECT DISTINCT e.project_id FROM audit_events e JOIN projects p ON p.project_id = e.project_id WHERE e.kind = ? AND p.retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM project_retirements r WHERE r.project_id = e.project_id) ORDER BY e.project_id`,[INTENT]);
  for (const row of pending) await retireProject(cp,row.project_id,row.reason);
  for (const {project_id} of intents) {const intent = openIntent(cp,project_id);if (intent) await retireProject(cp,project_id,intent.reason);}
}

/** One retirement of a project at a time in this daemon: the sweep never resumes an intent whose attempt is still running. */
const retiring = new WeakMap<ControlPlane,Set<string>>();

/**
 * #1229 — a retirement commits its irreversible rows (the retirement record, which is also negative authority, and the
 * entitlement revocation) only once the host has changed something: after the host retire succeeded, or after it
 * stopped part-way, when the record keeps the project suspended until the daemon's sweep finishes it. Until then the
 * markers are the project's suspension, which blocks dispatch while runs are cancelled and the host retires, and the
 * intent recorded with it; both are taken back on every refusal that leaves the host as it was. Such a refusal leaves
 * no committed change but audit rows and the runs it cancelled: cancellation must precede the host step, which moves
 * the clone their workers use.
 */
export async function retireProject(cp:ControlPlane,projectId:string,reason:string):Promise<Decision<unknown>> {
  const project = cp.projects.get(projectId);
  if (!project) return deny(ReasonCode.NOT_FOUND,'unknown project',{projectId});
  if (project.retiredAt) return allow(ReasonCode.OK,{projectId,retiredAt:project.retiredAt});
  const running = retiring.get(cp) ?? new Set<string>();
  retiring.set(cp,running);
  if (running.has(projectId)) return deny(ReasonCode.CONFLICT,'a retirement of this project is already in progress',{projectId});
  running.add(projectId);
  try {return await retire(cp,projectId,project.suspended,reason);} finally {running.delete(projectId);}
}

async function retire(cp:ControlPlane,projectId:string,suspended:boolean,reason:string):Promise<Decision<unknown>> {
  const rerun = `run agentctl project retire ${projectId} again`;
  const at = cp.clock.nowIso();
  const pending = ():boolean => Boolean(cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[projectId]));
  // Once the host has changed something the retirement is committed as pending: its record suppresses the entitlement
  // and keeps the project suspended until the daemon's sweep runs this again.
  const commitPending = ():void => cp.db.tx(() => {
    if (!pending()) cp.db.run(`INSERT INTO project_retirements(project_id,requested_at,reason) VALUES (?,?,?)`,[projectId,at,reason]);
    new CanonicalSessionRegistry(cp.db).revoke(projectId,at);
  });
  let intent = pending() ? null : openIntent(cp,projectId);
  // An earlier attempt began the host step and its outcome is unknown: nothing proves the host as it was.
  if (intent?.phase === 'HOST') {commitPending();intent = null;}
  // The reversible markers: the suspension this retirement took and its open intent, taken back together.
  const unmark = ():void => {
    const taken = intent;
    if (!taken) return;
    cp.db.tx(() => {
      if (taken.suspendedHere) cp.projects.setSuspended(projectId,false,true);
      recordIntent(cp,projectId,WITHDRAWN,{reason:taken.reason});
    });
    intent = null;
  };
  // What a refusal before the host step leaves: nothing, or a retirement already pending from an earlier attempt.
  const unchanged = ():string => pending() ? 'project remains suspended and its retirement resumes' : 'nothing was changed';
  try {await cp.residentProjects.verifyRetirement(projectId);} catch (error) {
    unmark();
    if (error instanceof HostRetirementRefusal) return deny(ReasonCode.CONFLICT,`host retirement refused: ${error.reason}; ${unchanged()}`,{projectId,refusal:error.reason,requiredOrder:[...error.requiredOrder]});
    return deny(ReasonCode.CONFLICT,`host retirement could not be verified; ${unchanged()}`,{projectId,requiredOrder:[rerun]});
  }
  const work = cp.db.all<{run_id:string;state:string}>(`SELECT run_id,state FROM runs WHERE (project_id = ? OR run_id IN (SELECT run_id FROM bootstrap_applications WHERE project_id = ?)) AND state NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY created_at,run_id`,[projectId,projectId]);
  // Confirmed/merged effects must settle through their own finalizer; cancellation never erases them.
  const settling = work.filter(r => ['CEO_APPROVED','FINALIZING','MERGING','POST_MERGE_VERIFYING','BLOCKED_POST_MERGE'].includes(r.state));
  if (settling.length > 0) {
    unmark();
    // A terminal BLOCKED_POST_MERGE run never settles; its held retirement reaches the CEO as its own incident.
    const held = retirementWaitsForSettlement(cp,projectId,settling);
    const ids = settling.map(r => r.run_id);
    return deny(ReasonCode.CONFLICT,`retirement waits for confirmed external effects to settle; ${unchanged()}`,{...held.evidence,projectId,settling:ids,requiredOrder:[`let runs ${ids.join(', ')} finish finalizing`,rerun]});
  }
  if (pending()) {
    if (!suspended) cp.projects.setSuspended(projectId,true,true);
  } else if (!intent) {
    // This call suspends only a project that was not suspended; the intent and the suspension commit together.
    const taken:RetirementIntent = {reason,phase:'SUSPENDED',suspendedHere:!suspended};
    cp.db.tx(() => {
      if (taken.suspendedHere) cp.projects.setSuspended(projectId,true,true);
      recordIntent(cp,projectId,INTENT,{...taken});
    });
    intent = taken;
  }
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
  // The host step begins: a restart from here on cannot tell whether the host changed anything.
  if (intent) {
    const begun:RetirementIntent = {...intent,phase:'HOST'};
    cp.db.tx(() => recordIntent(cp,projectId,INTENT,{...begun}));
    intent = begun;
  }
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
