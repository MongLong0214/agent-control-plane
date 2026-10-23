import { readFileSync } from 'node:fs';
import { readProcessStartToken } from '../core/process-argv.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '../core/digest.ts';
import type { Db } from '../db/database.ts';
import type { Clock } from '../core/clock.ts';
import { CanonicalSessionRegistry } from '../registry/canonical-session-registry.ts';
import type { HostProjectProvisioner, ProjectAllocation, HostObservation, HostOperation } from '../runtime/host-project-provisioner.ts';
import type { BootstrapConfirmation } from './repo-factory-bootstrap-run.ts';

interface ProvisioningRow {run_id:string; project_id:string; binding_json:string; allocation_json:string; confirmation_json:string; steps_json:string; status:string; last_error:string|null}
export interface ProvisioningEvidence {runId:string; allocation:ProjectAllocation; observations:HostObservation; claimSessionId:string|null; subscriberReady:boolean; observedAt:string; complete:boolean}
export class ResidentProjectProvisioning {
  readonly #running = new Set<string>();
  #subscriberConfigured = false;
  #subscriberReady: ((allocation:ProjectAllocation,pubkey:string) => boolean) | null = null;
  #reconcile: (allocation: ProjectAllocation, pubkey: string) => Promise<boolean> = async () => false;
  constructor(private readonly db:Db, private readonly clock:Clock, private readonly host:HostProjectProvisioner | null, private readonly home:string, private readonly stateDir:string) {}
  attachSubscriber(reconcile: (allocation:ProjectAllocation,pubkey:string) => Promise<boolean>, current?: (allocation:ProjectAllocation,pubkey:string) => boolean): void { this.#reconcile = reconcile;this.#subscriberReady = current ?? null;this.#subscriberConfigured = true; }
  configured(): boolean {return this.host !== null && this.#subscriberConfigured;}
  remember(confirmation:BootstrapConfirmation, projectId:string, binding:unknown): void {
    const old = this.row(confirmation.runId);
    if (old) {
      if (old.project_id !== projectId || old.binding_json !== canonicalJson(binding) || canonicalJson(JSON.parse(old.confirmation_json)) !== canonicalJson(confirmation)) throw new Error('provisioning confirmation/binding conflict');
      return;
    }
    this.db.run(`INSERT INTO resident_project_provisioning(run_id,project_id,binding_json,allocation_json,confirmation_json,updated_at) VALUES (?,?,?,'{}',?,?)`, [confirmation.runId,projectId,canonicalJson(binding),JSON.stringify(confirmation),this.clock.nowIso()]);
  }
  /** The host read this private room as its CTO identity before launch; the daemon's global key is not a room member. */
  confirmedRoom(roomId:string): boolean {
    const row = this.db.get<ProvisioningRow>(`SELECT * FROM resident_project_provisioning WHERE status IN ('PENDING','COMPLETE') AND COALESCE(json_extract(steps_json,'$.roomBinding.roomId'),json_extract(allocation_json,'$.roomId')) = ?`,[roomId]);
    if (!row) return false;
    const steps = JSON.parse(row.steps_json) as Record<string,{observed?:HostObservation}>;
    const buzz = steps['ensure-buzz']?.observed?.buzz;
    return Boolean(buzz?.roomId === roomId && buzz.rosterVerified && buzz.nonceReadable && buzz.nonceEventId && this.db.get(`SELECT 1 FROM canonical_session_entitlements WHERE provisioning_run_id = ? AND buzz_address = ? AND buzz_actor_id = ? AND revoked_at IS NULL`,[row.run_id,roomId,buzz.pubkey]));
  }
  pending(): BootstrapConfirmation[] { return this.db.all<{confirmation_json:string}>(`SELECT confirmation_json FROM resident_project_provisioning WHERE status = 'PENDING' ORDER BY run_id`).map(r => JSON.parse(r.confirmation_json) as BootstrapConfirmation); }
  row(runId:string): ProvisioningRow | undefined { return this.db.get<ProvisioningRow>(`SELECT * FROM resident_project_provisioning WHERE run_id = ?`,[runId]); }
  allocation(runId:string): ProjectAllocation | null {
    const row=this.row(runId);if (!row) return null;
    const value=JSON.parse(row.allocation_json) as Partial<ProjectAllocation>;
    const binding=(JSON.parse(row.steps_json) as {roomBinding?:{roomId:string}}).roomBinding;
    return value.sessionUuid ? {...value,...(binding ? {roomId:binding.roomId} : {})} as ProjectAllocation : null;
  }
  async ensure(input:{runId:string;projectId:string;repositoryIdentity:string;repositoryNodeId:string;head:string;packet:unknown}):Promise<ProvisioningEvidence> {
    if (this.#running.has(input.runId)) throw new Error('provisioning already in progress');
    if (!this.host) throw new Error('resident host provisioner is not configured');
    this.#running.add(input.runId);
    try {
      const row = this.row(input.runId);
      if (!row || row.status === 'RETIRED' || row.status === 'RETIRING') throw new Error('no active confirmed provisioning intent');
      let a = this.allocation(input.runId);
      if (!a) {
        const repoName = input.repositoryIdentity.split('/')[1]!;
        a = {projectId:input.projectId,runId:input.runId,repositoryIdentity:input.repositoryIdentity,repositoryNodeId:input.repositoryNodeId,head:input.head,
          sessionUuid:randomUUID(),roomId:randomUUID(),roomName:input.projectId,clonePath:join(this.home,'projects',repoName),tmuxName:`acp-${Buffer.from(input.projectId).toString("hex")}`,socketPath:join(this.stateDir,`cc-session-${input.projectId}.sock`),
          fleetName:`acp-${input.projectId}`,identityName:`cto-${input.projectId}`,privateKeyFile:join(this.home,'.hermes','bridge','keys',`cto-${input.projectId}.priv`),bootPacket:join(this.home,'.claude','watchers','fleet',`acp-${input.projectId}.boot.txt`),nonce:randomUUID()};
        this.db.run(`UPDATE resident_project_provisioning SET allocation_json = ? WHERE run_id = ? AND allocation_json = '{}'`,[JSON.stringify(a),input.runId]);
        a = this.allocation(input.runId)!;
      }
      if (a.projectId !== input.projectId || a.repositoryIdentity !== input.repositoryIdentity || a.repositoryNodeId !== input.repositoryNodeId || a.head !== input.head) throw new Error('provisioning resource conflict');
      const observations:HostObservation = {};
      // Every retry inspects the same allocation. Volatile observations never survive as readiness.
      // Review V52-R1-03 — the host reports Git's own HEAD and never resets the clone. Until a resident
      // of this allocation has been observed on it, activation needs it attached to dev, clean and
      // exactly at the approved head (the host checks branch and cleanliness, this the head).
      // Review V52-R2-01 — once that observation is recorded the clone is the CTO's workspace: a later
      // activation pass (after the handoff ACK) asks only that it is the project's clone with history
      // built on the approved head, the rule fleet recovery uses, so unfinished work never blocks it.
      const recorded = JSON.parse(this.row(input.runId)!.steps_json) as {checkoutHandedOver?:unknown;observe?:{state?:string;observed?:HostObservation}};
      const prior = recorded.observe?.state === 'OBSERVED' ? recorded.observe.observed : undefined;
      const strictObserve = prior?.checkout?.head === a.head && prior.checkout.path === a.clonePath && prior.resident?.sessionUuid === a.sessionUuid && prior.resident.cwd === a.clonePath && prior.resident.tmuxAncestry === true && Boolean(prior.resident.bridgeSessionId);
      let handedOver = recorded.checkoutHandedOver !== undefined || strictObserve;
      if (handedOver && recorded.checkoutHandedOver === undefined) this.save(input.runId,'checkoutHandedOver',{head:a.head,at:this.clock.nowIso()});
      const checkoutHost = ():ProjectAllocation => handedOver ? Object.assign({},a!,{checkoutRequirement:'development' as const}) : a!;
      const bootstrapCheckout = (observed:HostObservation, step:HostOperation):void => {
        const checkout = observed.checkout;
        if (!checkout || checkout.path !== a!.clonePath || checkout.repositoryNodeId !== a!.repositoryNodeId || (!handedOver && checkout.head !== a!.head)) throw new Error(`${step} checkout readback is not the approved genesis head`);
      };
      const checkedOut = await this.step('ensure-checkout',checkoutHost(),input.packet);
      bootstrapCheckout(checkedOut,'ensure-checkout');
      Object.assign(observations,checkedOut);
      Object.assign(observations,await this.step('ensure-buzz',a,input.packet));
      if (!observations.buzz) throw new Error('dedicated Buzz room not verified');
      const binding = (JSON.parse(this.row(input.runId)!.steps_json) as {roomBinding?:{roomId:string}}).roomBinding;
      if (binding && binding.roomId !== observations.buzz.roomId) throw new Error('Buzz room identity drift');
      if (!binding) this.save(input.runId,'roomBinding',{roomId:observations.buzz.roomId});
      a = this.allocation(input.runId)!;
      Object.assign(observations,await this.step('ensure-routing',a,input.packet));
      if (!observations.buzz || observations.buzz.roomId !== a.roomId) throw new Error('dedicated Buzz room not verified');
      const pk = observations.buzz.pubkey;
      new CanonicalSessionRegistry(this.db).grant({sessionUuid:a.sessionUuid,projectId:a.projectId,buzzActorId:pk,buzzAddress:a.roomId},a.runId);
      this.db.run(`UPDATE projects SET buzz_address = ? WHERE project_id = ? AND retired_at IS NULL`,[a.roomId,a.projectId]);
      if (!this.#subscriberConfigured) throw new Error("subscriber and canonical tools are not configured yet");
      await this.#reconcile(a,pk); // configure before launch; admission waits for the canonical claim
      const launched = await this.step('ensure-resident',a,input.packet);
      bootstrapCheckout(launched,'ensure-resident');
      Object.assign(observations,launched);
      const latest = await this.step('observe',checkoutHost());
      bootstrapCheckout(latest,'observe');
      delete observations.resident; delete observations.checkout;
      Object.assign(observations,latest);
      const resident = latest.resident;
      const checkout = latest.checkout;
      if (!resident || !checkout || resident.cwd !== a.clonePath || resident.sessionUuid !== a.sessionUuid || !resident.tmuxAncestry || !resident.bridgeSessionId || checkout.repositoryNodeId !== a.repositoryNodeId) throw new Error('resident/checkout readbacks mismatch');
      // The resident is verified on the approved checkout: from here on the clone is the CTO's workspace.
      if (!handedOver) {handedOver = true;this.save(input.runId,'checkoutHandedOver',{head:a.head,at:this.clock.nowIso()});}
      const claim = this.db.get<{session_id:string}>(`SELECT s.session_id FROM sessions s JOIN conversational_actors c ON c.current_session_id = s.session_id JOIN assignments b ON b.actor_id = c.actor_id AND b.status = 'ACTIVE' JOIN actor_target_bindings tb ON tb.target_actor_id = b.actor_id WHERE b.project_id = ? AND b.role = 'PRIMARY_CTO' AND tb.target_locator = ? AND s.os_pid = ? AND s.os_process_started_at = ? AND s.workdir = ? AND s.buzz_actor_id = ? AND s.buzz_address = ? AND EXISTS (SELECT 1 FROM audit_events e WHERE e.kind = 'CANONICAL_SELF_CLAIM_ADMITTED' AND e.session_id = s.session_id AND json_extract(e.evidence_json,'$.identity') = ?)`,[a.projectId,a.sessionUuid,resident.pid,resident.startedAt,a.clonePath,pk,a.roomId,a.sessionUuid]);
      const subscriberReady = await this.#reconcile(a,pk);
      const evidence = {runId:a.runId,allocation:a,observations,claimSessionId:claim?.session_id ?? null,subscriberReady,observedAt:this.clock.nowIso(),complete:false};
      this.save(a.runId,'readbacks',evidence);
      return evidence;
    } catch {
      this.db.run(`UPDATE resident_project_provisioning SET last_error = 'provisioning readback pending or refused', updated_at = ? WHERE run_id = ?`,[this.clock.nowIso(),input.runId]);
      throw new Error('resident provisioning pending or refused; inspect provisioning ledger');
    } finally {this.#running.delete(input.runId);}
  }
  evidence(runId:string): ProvisioningEvidence | null {
    const row = this.row(runId); if (!row) return null;
    return (JSON.parse(row.steps_json) as {readbacks?:ProvisioningEvidence}).readbacks ?? null;
  }
  ready(runId:string,sessionId:string): boolean {
    const row = this.row(runId);
    if (!row || !["PENDING","COMPLETE"].includes(row.status) || this.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[row.project_id]) || !this.db.get(`SELECT 1 FROM canonical_session_entitlements e JOIN projects p ON p.project_id = e.project_id WHERE e.provisioning_run_id = ? AND e.revoked_at IS NULL AND p.retired_at IS NULL AND p.suspended = 0`,[runId])) return false;
    const evidence = this.evidence(runId);
    if (!evidence?.subscriberReady || evidence.claimSessionId !== sessionId || !evidence.observations.resident) return false;
    const {allocation:a,observations:{resident:r}} = evidence;
    if (this.#subscriberReady && !this.#subscriberReady(a,evidence.observations.buzz!.pubkey)) return false;
    if (Date.parse(this.clock.nowIso()) - Date.parse(evidence.observedAt) > 30_000 || readProcessStartToken(r.pid) !== r.startedAt) return false;
    try {
      const rc = JSON.parse(readFileSync(join(this.home,'.claude','sessions',`${r.pid}.json`),'utf8')) as {sessionId?:string;sessionUuid?:string;session_id?:string;cwd?:string;bridgeSessionId?:string};
      if ((rc.sessionId ?? rc.sessionUuid ?? rc.session_id) !== a.sessionUuid || rc.cwd !== a.clonePath || !rc.bridgeSessionId || rc.bridgeSessionId !== r.bridgeSessionId) return false;
    } catch {return false;}
    return Boolean(this.db.get(`SELECT 1 FROM assignments b JOIN conversational_actors c ON c.actor_id = b.actor_id JOIN sessions s ON s.session_id = c.current_session_id JOIN actor_target_bindings tb ON tb.target_actor_id = b.actor_id WHERE b.project_id = ? AND b.status = 'ACTIVE' AND b.role = 'PRIMARY_CTO' AND s.session_id = ? AND s.os_pid = ? AND s.os_process_started_at = ? AND s.buzz_address = ? AND tb.target_locator = ?`,[a.projectId,sessionId,r.pid,r.startedAt,a.roomId,a.sessionUuid]));
  }
  complete(runId:string): void {this.db.run(`UPDATE resident_project_provisioning SET status = 'COMPLETE', last_error = NULL, updated_at = ? WHERE run_id = ? AND status = 'PENDING'`,[this.clock.nowIso(),runId]);}
  private save(runId:string,step:string,value:unknown):void {
    const row = this.row(runId)!; const steps = JSON.parse(row.steps_json) as Record<string,unknown>; steps[step] = value;
    this.db.run(`UPDATE resident_project_provisioning SET steps_json = ?, updated_at = ? WHERE run_id = ?`,[JSON.stringify(steps),this.clock.nowIso(),runId]);
  }
  private async step(operation:HostOperation,a:ProjectAllocation,packet?:unknown):Promise<HostObservation> {
    const current = this.row(a.runId)!;
    if (current.status !== 'PENDING' && current.status !== 'COMPLETE') throw new Error('provisioning has been retired');
    const steps = JSON.parse(current.steps_json) as Record<string,{attempts?:number}>;
    this.save(a.runId,operation,{state:'INTENT',attempts:(steps[operation]?.attempts ?? 0)+1});
    const observed = await this.host!.invoke(operation,a,packet);
    this.save(a.runId,operation,{state:'OBSERVED',attempts:(steps[operation]?.attempts ?? 0)+1,observed});
    return observed;
  }
  async retire(projectId:string):Promise<void> {
    const row = this.db.get<ProvisioningRow>(`SELECT * FROM resident_project_provisioning WHERE project_id = ?`,[projectId]);
    if (!row) {
      const legacy = this.db.get<{session_uuid:string;buzz_address:string;identity:string;checkout_path:string;last_observed_head:string|null;os_pid:number|null;os_process_started_at:string|null}>(`SELECT e.session_uuid,e.buzz_address,r.identity,r.checkout_path,r.last_observed_head,s.os_pid,s.os_process_started_at FROM canonical_session_entitlements e JOIN repositories r ON r.project_id = e.project_id AND r.retired_at IS NULL LEFT JOIN assignments b ON b.project_id = e.project_id AND b.role = 'PRIMARY_CTO' AND b.status = 'ACTIVE' LEFT JOIN conversational_actors c ON c.actor_id = b.actor_id LEFT JOIN sessions s ON s.session_id = c.current_session_id WHERE e.project_id = ? ORDER BY r.repository_id LIMIT 1`,[projectId]);
      if (!legacy) return;
      if (!this.host) throw new Error('legacy retirement host unavailable');
      const allocation:ProjectAllocation = {projectId,runId:`legacy-retire:${projectId}`,repositoryIdentity:legacy.identity,repositoryNodeId:'legacy-history',head:legacy.last_observed_head ?? '0'.repeat(40),sessionUuid:legacy.session_uuid,roomId:legacy.buzz_address,clonePath:legacy.checkout_path,tmuxName:`acp-${Buffer.from(projectId).toString("hex")}`,socketPath:join(this.stateDir,`cc-session-${projectId}.sock`),fleetName:`acp-${projectId}`,identityName:`cto-${projectId}`,privateKeyFile:join(this.home,'.hermes','bridge','keys',`cto-${projectId}.priv`),bootPacket:join(this.home,'.claude','watchers','fleet',`acp-${projectId}.boot.txt`),nonce:'retirement',...(legacy.os_pid && legacy.os_process_started_at ? {retirementPin:{pid:legacy.os_pid,startedAt:legacy.os_process_started_at}} : {})};
      if (!(await this.host.invoke('retire',allocation)).retired) throw new Error('legacy retirement incomplete');
      await this.#reconcile(allocation,'');
      return;
    }
    if (row.status === 'RETIRED') return;
    this.db.run(`UPDATE resident_project_provisioning SET status = 'RETIRING' WHERE run_id = ?`,[row.run_id]);
    const a = this.allocation(row.run_id);
    if (a) {
      if (!this.host) throw new Error('retirement host unavailable');
      const observation = await this.host.invoke('retire',a);
      if (!observation.retired) throw new Error('retirement not verified');
      this.save(row.run_id,'retire',observation);
      await this.#reconcile(a,'');
    }
    this.db.run(`UPDATE resident_project_provisioning SET status = 'RETIRED' WHERE run_id = ?`,[row.run_id]);
  }
}
