// Controlled activation witness: local sandbox execution is outside this package-authority test.
vi.mock('../../src/verify/sandbox.ts', async original => ({...await original<typeof Sandbox>(),runSandboxed:vi.fn(async()=>({status:'PASS',exitCode:0,stdout:'',stderr:''}))}));
import type * as Sandbox from '../../src/verify/sandbox.ts';
import { callCtoTool } from '../helpers/cto-tool.ts';
import { GenesisGitHub, genesisPlanFixture } from '../helpers/genesis-github.ts';
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { readProcessStartToken } from '../../src/core/process-argv.ts';
import { CanonicalSelfClaim, hostSessionRegistryAbsent } from '../../src/registry/canonical-self-claim.ts';
import { Daemon } from '../../src/daemon/daemon.ts';
import { reviewBootstrapPlan } from '../helpers/bootstrap-plan.ts';
import { dispatchBootstrapRun, decideThroughHermes } from '../helpers/harness.ts';
import { afterAll, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import type { HostOperation, HostProjectProvisioner, ProjectAllocation, HostObservation } from '../../src/runtime/host-project-provisioner.ts';
import { git } from '../../src/git/git.ts';
import { makeHarness } from '../helpers/harness.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';
import { deny } from '../../src/core/errors.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { RunKind } from '../../src/domain/types.ts';

afterAll(cleanupTempDirs);
const planFixture = genesisPlanFixture;
const contract = {goal:'bootstrap',why:'owner request',scope:[],nonGoals:[],acceptance:['developable'],priority:'NORMAL' as const,humanGate:[],references:[]};
class FakeHost implements HostProjectProvisioner {
  fail:HostOperation|null = null;
  actualRoomId:string|null = null;
  allocations:ProjectAllocation[] = [];
  resources = new Set<string>();
  async invoke(op:HostOperation,a:ProjectAllocation):Promise<HostObservation> {
    this.allocations.push({...a});this.resources.add(op+':'+a.sessionUuid);
    if (op === this.fail) {this.fail = null;throw new Error('crash after effect');}
    if (op === 'ensure-checkout') return {checkout:{path:a.clonePath,origin:'https://github.com/acme/fixture.git',head:a.head,repositoryNodeId:a.repositoryNodeId}};
    if (op === 'ensure-buzz') return {buzz:{pubkey:'a'.repeat(64),roomId:this.actualRoomId ?? a.roomId,rosterVerified:true,nonceEventId:'b'.repeat(64),nonceReadable:true}};
    if (op === 'ensure-routing') return {routing:{generation:1,roomId:a.roomId}};
    if (op === 'ensure-resident' || op === 'observe') return {checkout:{path:a.clonePath,origin:'https://github.com/acme/fixture.git',head:a.head,repositoryNodeId:a.repositoryNodeId},resident:{pid:12345,startedAt:'start',cwd:a.clonePath,sessionUuid:a.sessionUuid,tmuxName:a.tmuxName,tmuxAncestry:true,bridgeSessionId:'rc'}};
    return {retired:true};
  }
}
it.each(['NO_PACKAGE','REJECTED','EXPIRED','STALE_GENERATION','MESSAGE_ID','BINDING_GENERATION','PAYLOAD_DIGEST','OUTBOX_DENIAL','REVOKED_AFTER_READ','IN_BAND_FAILURE'] as const)('closure: %s refuses ACK without changing either row or completing genesis',async broken => {
  const root = realpathSync(tempDir('resident-complete-'));const home = join(root,'home');mkdirSync(home);
  const port = new GenesisGitHub(root);const host = new FakeHost();
  const h = makeHarness({repoFactory:{workRoot:join(root,'factory'),githubPort:port},residentProvisioner:{home,port:host}});
  const doctor = h.cp.doctor.run.bind(h.cp.doctor);
  vi.spyOn(h.cp.doctor,'run').mockImplementation(async (...args) => ({...await doctor(...args),status:'HEALTHY',findings:[]}));
  try {
  const startedAt = readProcessStartToken(process.pid)!;
  const invoke = host.invoke.bind(host);
  host.invoke = async (op,a) => {
    if (op === 'ensure-checkout' && !existsSync(a.clonePath)) {
      mkdirSync(join(home,'projects'),{recursive:true});await git(root,['clone','-b','dev',port.repository('acme','fixture')!.bare,a.clonePath]);await git(a.clonePath,['remote','set-url','origin','https://github.com/acme/fixture.git']);
    }
    const value = await invoke(op,a);
    if (value.resident) {value.resident.pid = process.pid;value.resident.startedAt = startedAt;}
    if (op === 'ensure-resident') {
      mkdirSync(join(home,'.claude','sessions'),{recursive:true});writeFileSync(join(home,'.claude','sessions',`${process.pid}.json`),JSON.stringify({sessionId:a.sessionUuid,cwd:a.clonePath,bridgeSessionId:'rc'}),{mode:0o600});
      if (!h.cp.bindings.activePrimaryCto(a.projectId)) {
        const claim = new CanonicalSelfClaim(h.cp.db,h.clock,h.cp.audit,h.cp.sessions,h.cp.bindings,{isAllowedActor:() => true},async () => ({allowed:true,reasonCode:'OK',evidence:{},value:a.roomId}),{canonicalSessions:[{sessionUuid:a.sessionUuid,projectId:a.projectId,buzzActorId:'a'.repeat(64),buzzAddress:a.roomId}],canonicalBuzzChannelId:a.roomId,expectedPeerProtocolVersion:'test',expectedPeerIdentity:'test'}, {processInspector:{snapshot:pid => pid === 100 ? {pid,ppid:process.pid,argv:['node','mcp'],command:'node mcp',cwd:a.clonePath,cwdProbeFailure:null,startedAt:'peer'} : pid === process.pid ? {pid,ppid:1,argv:['/test/claude','--session-id',a.sessionUuid],command:'claude',cwd:a.clonePath,cwdProbeFailure:null,startedAt} : null},imageInspector:{resolve:() => null},transcriptReader:{locate:() => ({path:'/test/transcript',sizeBytes:10})},hostSessionRegistryReader:{read:() => hostSessionRegistryAbsent('test')},processSignal:() => {}});
        const admitted = await claim.claim({callerPid:100,claimedSessionUuid:a.sessionUuid,projectId:a.projectId,expectedBindingGeneration:1,peerProtocolVersion:'test',peerIdentity:'test',buzzPurpose:'test'});
        expect(admitted.allowed,JSON.stringify(admitted)).toBe(true);
      }
    }
    return value;
  };
  h.cp.residentProjects.attachSubscriber(async () => true);
  h.cp.bootstrapProducer.attachWriterLock(() => true);
  const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract});if (!run.allowed) throw new Error(run.message);
  await dispatchBootstrapRun(h.cp,h.clock,run.value.runId);
  const f = planFixture();const reviewed = await reviewBootstrapPlan(h,run.value.runId,{...f.artifact.content,requestDigest:h.cp.runs.get(run.value.runId)!.contractDigest});
  const refused = await h.cp.bootstrapProducer.produceAndActivateApproved({runId:run.value.runId,candidateSnapshotDigest:'unreviewed-candidate',ceoSessionId:reviewed.ceoSessionId});
  expect(refused.allowed).toBe(false);expect(h.cp.residentProjects.row(run.value.runId)).toBeUndefined();
  const first = await decideThroughHermes(h,{runId:run.value.runId,decision:'CONFIRM',candidateSnapshotDigest:reviewed.snapshotDigest,ceoSessionId:reviewed.ceoSessionId,rationale:'create and activate'});
  expect(first.allowed).toBe(false);
  expect(createCtoMcpPort(h.cp).submitPlan(run.value.runId,{summary:'replace the confirmed plan'}).allowed).toBe(false);
  const pending = h.cp.db.get<{handoff_id:string;to_session_id:string}>(`SELECT handoff_id,to_session_id FROM handoffs WHERE project_id = ? AND status = 'PENDING'`,[f.manifest.projectId]);
  expect(pending,JSON.stringify(first)).toBeTruthy();if (!pending) throw new Error('handoff missing');
  expect(h.cp.bootstrap.acknowledgeActivationHandoff(pending.handoff_id,'wrong-session').allowed).toBe(false);
  const recipient = h.cp.sessions.require(pending.to_session_id);
  const peer = {sessionId:recipient.sessionId,incarnation:recipient.incarnation};
  const oldMessage = h.cp.outbox.byIdempotencyKey(`bootstrap-handoff:${pending.handoff_id}`)!;
  const recovering = ['REJECTED','EXPIRED','STALE_GENERATION'].includes(broken);
  const neverReadable = recovering || broken === 'NO_PACKAGE' || broken === 'IN_BAND_FAILURE';
  let supplied = {messageId:oldMessage.messageId,payloadDigest:oldMessage.payloadDigest,bindingGeneration:oldMessage.bindingGeneration};
  if (!neverReadable) {
    const read = await callCtoTool(h,peer,'role_dispatch_pending');
    const messages = (read.value as {messages:Array<typeof supplied>}).messages;
    const received = messages.find(row => row.messageId === oldMessage.messageId)!;
    expect(received).toMatchObject(supplied);
    supplied = {messageId:received.messageId,payloadDigest:received.payloadDigest,bindingGeneration:received.bindingGeneration};
  }
  if (recovering) {
    // A nonempty historical delivery receipt must survive reissuance too, not only NULL acked_at.
    h.cp.outbox.recordAcceptedSend(oldMessage.messageId,{room:host.allocations[0]!.roomId,recipient:'a'.repeat(64)});
  }
  if (broken === 'NO_PACKAGE') h.cp.db.run('DELETE FROM outbox WHERE message_id = ?',[oldMessage.messageId]);
  if (broken === 'REJECTED' || broken === 'EXPIRED') h.cp.db.run("UPDATE outbox SET status = ?, failure_class = ?, retry_eligible = 0 WHERE message_id = ?",[broken,broken === 'REJECTED' ? 'contract' : null,oldMessage.messageId]);
  if (broken === 'STALE_GENERATION') h.cp.db.run('UPDATE outbox SET binding_generation = binding_generation + 1 WHERE message_id = ?',[oldMessage.messageId]);
  if (broken === 'IN_BAND_FAILURE') h.cp.db.run("UPDATE outbox SET status = 'SENT' WHERE message_id = ?",[oldMessage.messageId]);
  if (broken === 'REVOKED_AFTER_READ') expect(h.cp.bindings.revoke(h.cp.bindings.activePrimaryCto(f.manifest.projectId)!.roleKey,'revoked after MCP read').allowed).toBe(true);
  if (broken === 'MESSAGE_ID') supplied = {...supplied,messageId:'other-package'};
  if (broken === 'BINDING_GENERATION') supplied = {...supplied,bindingGeneration:supplied.bindingGeneration + 1};
  if (broken === 'PAYLOAD_DIGEST') supplied = {...supplied,payloadDigest:'sha256:other-package'};
  const snapshot = () => ({
    handoff:h.cp.db.get('SELECT * FROM handoffs WHERE handoff_id = ?',[pending.handoff_id]),
    outbox:h.cp.db.get('SELECT * FROM outbox WHERE message_id = ?',[oldMessage.messageId]),
    delivery:h.cp.db.get('SELECT status,failure_class,acked_at FROM outbox WHERE message_id = ?',[oldMessage.messageId]),
    receipts:h.cp.db.all('SELECT * FROM outbox_sent_destinations WHERE message_id = ? ORDER BY room,recipient',[oldMessage.messageId]),
  });
  const before = snapshot();
  if (recovering) expect(before.receipts).toHaveLength(1);
  if (neverReadable || broken === 'REVOKED_AFTER_READ') expect(await callCtoTool(h,peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
  const legacyAck = vi.spyOn(h.cp.outbox,'acknowledge');
  const denied = broken === 'OUTBOX_DENIAL' ? vi.spyOn(h.cp.outbox,'acknowledgeHandoffInBand').mockImplementation(() => {
    expect(h.cp.db.inTransaction).toBe(true);
    h.cp.db.run("UPDATE outbox SET status = 'ACKED', acked_at = ? WHERE message_id = ?",[h.clock.nowIso(),oldMessage.messageId]);
    return deny(ReasonCode.HANDOFF_ACK_REQUIRED,'forced in-band outbox denial');
  }) : null;
  expect(await callCtoTool(h,peer,'handoff_ack',{idempotencyKey:'old-package-ack',handoffId:pending.handoff_id,...supplied}))
    .toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
  expect(snapshot().handoff,'denied ACK must preserve the handoff row').toEqual(before.handoff);
  expect(snapshot().outbox,'denied ACK must preserve the outbox row, including absence').toEqual(before.outbox);
  expect(h.cp.runs.get(run.value.runId)?.state,'denied ACK must not complete genesis').not.toBe('COMPLETED');
  expect(snapshot().receipts).toEqual(before.receipts);
  expect(legacyAck,'in-band failure must never enter the legacy Buzz ACK path').not.toHaveBeenCalled();
  if (denied) {expect(denied).toHaveBeenCalledOnce();denied.mockRestore();}
  legacyAck.mockRestore();
  if (broken === 'REVOKED_AFTER_READ') return;
  const daemon = new Daemon(h.cp,{stateDir:join(root,'daemon')});h.cp.bootstrapProducer.attachWriterLock(() => true);
  await daemon.resumeResidentProjects();
  expect(h.cp.runs.get(run.value.runId)?.state).not.toBe('COMPLETED');
  expect(snapshot().handoff).toEqual(before.handoff);
  expect(snapshot().outbox).toEqual(before.outbox);
  expect(snapshot().delivery,'old status, failure_class and ACK receipt must remain unchanged').toEqual(before.delivery);
  expect(snapshot().receipts).toEqual(before.receipts);
  if (!recovering) return;
  const fresh = h.cp.artifacts.latest<{handoffId:string}>(run.value.runId,'HANDOFF')!.content;
  expect(fresh.handoffId).not.toBe(pending.handoff_id);
  const message = h.cp.outbox.byIdempotencyKey(`bootstrap-handoff:${fresh.handoffId}`)!;
  expect(message).toMatchObject({status:'PENDING',targetSessionId:recipient.sessionId});
  await daemon.resumeResidentProjects();
  expect(h.cp.artifacts.latest<{handoffId:string}>(run.value.runId,'HANDOFF')!.content.handoffId).toBe(fresh.handoffId);
  const listed = await callCtoTool(h,peer,'role_dispatch_pending');
  expect(listed).toMatchObject({ok:true,value:{messages:expect.arrayContaining([
    expect.objectContaining({messageId:message.messageId,kind:'HANDOFF_PACKAGE',payload:expect.objectContaining({handoffId:fresh.handoffId})}),
  ])}});
  const received = (listed.value as {messages:Array<{messageId:string;payloadDigest:string;bindingGeneration:number;payload:{handoffId:string}}>}).messages
    .find(row => row.messageId === message.messageId)!;
  expect(h.cp.bootstrap.acknowledgeActivationHandoff(pending.handoff_id,pending.to_session_id,'stale').allowed).toBe(false);
  const acked = await callCtoTool(h,peer,'handoff_ack',{
    idempotencyKey:'resident-bootstrap-ack',handoffId:received.payload.handoffId,messageId:received.messageId,
    payloadDigest:received.payloadDigest,bindingGeneration:received.bindingGeneration,
  });
  expect(acked,JSON.stringify(acked)).toMatchObject({ok:true});
  expect(h.cp.outbox.get(message.messageId)?.status).toBe('ACKED');
  expect(h.cp.db.all('SELECT * FROM outbox_sent_destinations WHERE message_id = ?',[message.messageId])).toEqual([]);

  await daemon.resumeResidentProjects();
  expect(h.cp.runs.get(run.value.runId)?.state).toBe('COMPLETED');
  expect(h.cp.residentProjects.row(run.value.runId)?.status).toBe('COMPLETE');
  expect(h.cp.db.get('SELECT status FROM handoffs WHERE handoff_id = ?',[fresh.handoffId])).toEqual({status:'ACKED'});
  expect(snapshot()).toEqual(before);
  expect(snapshot().delivery,'completion through the new package must preserve old status, failure_class and acked_at').toEqual(before.delivery);
  expect(snapshot().receipts,'completion must preserve the historical delivery receipt').toEqual(before.receipts);
  expect(port.writes.filter(w => w.method === 'pushBranch')).toHaveLength(1);
  expect(h.cp.sessions.get(pending.to_session_id)?.provider).toBe('claude');
  } finally {vi.restoreAllMocks();h.cp.close();}
});
