import { afterAll, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Daemon } from '../../src/daemon/daemon.ts';
import { buzzMentionSubscriberRegistry } from '../../src/daemon/agentcpd.ts';
import { CanonicalSessionRegistry } from '../../src/registry/canonical-session-registry.ts';
import { retireProject } from '../../src/registry/project-retirement.ts';
import { HostRetirementRefusal } from '../../src/runtime/host-project-provisioner.ts';
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from '../../src/registry/canonical-self-claim.ts';
import { Role, SessionLifecycle } from '../../src/domain/types.ts';
import { digestOf, sha256 } from '../../src/core/digest.ts';
import { allow } from '../../src/core/errors.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { MessageKind } from '../../src/outbox/envelope.ts';
import { callCtoTool } from '../helpers/cto-tool.ts';
import { makeHarness, type Harness } from '../helpers/harness.ts';
import { channelKey, steppedClock, storingRelay, writeSubscriberConfig } from '../helpers/buzz-mention-relay.ts';
import { startBuzzMentionSubscriberFromStateDir } from '../../src/buzz/buzz-mention-subscriber.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';

afterAll(cleanupTempDirs);

const entry = {
  sessionUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'resident',
  buzzActorId: 'a'.repeat(64), buzzAddress: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const bind = (h: Harness, identity = entry) => {
  h.cp.projects.register({projectId:identity.projectId,name:identity.projectId});
  const session = h.cp.sessions.create({provider:'claude',model:'claude-cli',buzzAddress:identity.buzzAddress});
  expect(h.cp.sessions.transition(session.sessionId,SessionLifecycle.READY,'fixture').allowed).toBe(true);
  expect(h.cp.sessions.bindBuzzActor({sessionId:session.sessionId,sessionSecret:session.sessionSecret!,buzzActorId:identity.buzzActorId}, {isAllowedActor:()=>true}).allowed).toBe(true);
  const claimed = {executorKind:SELF_CLAIM_EXECUTOR_KIND,targetLocator:identity.sessionUuid,targetLocatorDigest:sha256(identity.sessionUuid)};
  const bound = h.cp.bindings.bind({role:Role.PRIMARY_CTO,projectId:identity.projectId,sessionId:session.sessionId,
    authenticatedTarget:{claimed,protocolVersion:SELF_CLAIM_PROTOCOL,attestationDigest:digestOf({fixture:identity}),verify:()=>claimed}});
  if (!bound.allowed) throw new Error(bound.message);
  return {session,binding:bound.value};
};

it.each([false,true])('FV52-01: host retirement failure excludes the revoked entitlement, legacy env=%s',async legacy => {
  const h = makeHarness();
  const stderr = vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
  try {
    const {session} = bind(h);
    const registry = new CanonicalSessionRegistry(h.cp.db);
    registry.grant(entry,null);
    const subject = buzzMentionSubscriberRegistry(h.cp,legacy ? {sessions:[entry]} : null);
    expect(subject.judgeIdentity!(entry.buzzActorId).verdict).toBe('ADMITTED');
    vi.spyOn(h.cp.residentProjects,'retire').mockRejectedValue(new Error('host unavailable'));
    expect((await retireProject(h.cp,entry.projectId,'retire')).allowed).toBe(false);
    expect(registry.effective([entry])).toEqual([]);
    expect(h.cp.bindings.activePrimaryCto(entry.projectId)?.sessionId).toBe(session.sessionId);
    expect(subject.judgeIdentity!(entry.buzzActorId)).toEqual({verdict:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
    expect(subject.primaryCtoBindingFor!(entry.buzzActorId)).toBeNull();
    // CEO c8eeff10 A: a second failed host retirement must retain negative authority too.
    expect((await retireProject(h.cp,entry.projectId,'retry retirement')).allowed).toBe(false);
    expect(subject.judgeIdentity!(entry.buzzActorId)).toEqual({verdict:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
    expect(subject.primaryCtoBindingFor!(entry.buzzActorId)).toBeNull();
    expect(buzzMentionSubscriberRegistry(h.cp,legacy ? {sessions:[entry]} : null).judgeIdentity!(entry.buzzActorId))
      .toEqual({verdict:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
    expect(stderr.mock.calls.flat().join('')).toContain('CANONICAL_ENTITLEMENT_REVOKED');
  } finally {stderr.mockRestore();h.cp.close();}
});

it.each([false,true])('#1229: a host retirement refusal reaches the retire result with its order; host changed: %s',async hostChanged => {
  const h = makeHarness();
  try {
    bind(h);
    const registry = new CanonicalSessionRegistry(h.cp.db);
    registry.grant(entry,null);
    const order = [`end the CTO session ${entry.sessionUuid} (pid 4242) yourself: exit it in its own terminal`,`run agentctl project retire ${entry.projectId} again`];
    vi.spyOn(h.cp.residentProjects,'retire').mockRejectedValue(new HostRetirementRefusal('process 4242 is the recorded CTO incarnation but no longer names session',order,hostChanged));
    expect(await retireProject(h.cp,entry.projectId,'retire')).toMatchObject({allowed:false,reasonCode:ReasonCode.CONFLICT,
      evidence:{projectId:entry.projectId,refusal:'process 4242 is the recorded CTO incarnation but no longer names session',requiredOrder:order}});
    expect(h.cp.projects.get(entry.projectId)?.retiredAt).toBeNull();
    // C-3: a refusal that left the host as it was takes its marker back and commits nothing irreversible; one that
    // changed the host is committed as a pending retirement, suspended and tombstoned until the sweep finishes it.
    expect(h.cp.projects.get(entry.projectId)?.suspended).toBe(hostChanged);
    expect(Boolean(h.cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[entry.projectId]))).toBe(hostChanged);
    expect(registry.effective()).toEqual(hostChanged ? [] : [entry]);
  } finally {h.cp.close();}
});

/** #1251 C-P1 — a daemon that exits while its retirement is awaited; the restart reopens the same database. */
const retiring = () => {const h = makeHarness();bind(h);new CanonicalSessionRegistry(h.cp.db).grant(entry,null);return h;};
const restart = (h: Harness) => {h.cp.close();return makeHarness({root:h.root});};
const sweep = (h: Harness) => new Daemon(h.cp,{stateDir:join(h.root,'daemon')}).resumeResidentProjects();
const unanswered = () => new Promise<never>(() => {});
const refusalOrder = [`end the CTO session ${entry.sessionUuid} yourself: exit it in its own terminal`,`run agentctl project retire ${entry.projectId} again`];

it('#1251 C-P1: a daemon exit while the host retire is awaited resumes the retirement exactly once after the restart',async () => {
  const h = retiring();
  const first = vi.spyOn(h.cp.residentProjects,'retire').mockImplementation(unanswered);
  void retireProject(h.cp,entry.projectId,'operator retirement');
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
  // This daemon's own sweep never starts a second retirement while the first one awaits the host.
  await sweep(h);
  expect(first).toHaveBeenCalledOnce();
  expect(h.cp.projects.get(entry.projectId)).toMatchObject({suspended:true,retiredAt:null});
  const r = restart(h);
  try {
    const resumed = vi.spyOn(r.cp.residentProjects,'retire').mockResolvedValue(undefined);
    await sweep(r);
    expect(resumed).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledWith(entry.projectId);
    expect(r.cp.projects.get(entry.projectId)).toMatchObject({suspended:true,retiredAt:expect.any(String)});
    expect(r.cp.db.get(`SELECT reason,completed_at FROM project_retirements WHERE project_id = ?`,[entry.projectId])).toEqual({reason:'operator retirement',completed_at:expect.any(String)});
    expect(new CanonicalSessionRegistry(r.cp.db).effective()).toEqual([]);
    await sweep(r);
    expect(resumed).toHaveBeenCalledOnce();
  } finally {r.cp.close();}
});

it('#1251 C-P1: a resumed retirement whose host step had begun keeps the project suspended and pending on a no-write refusal',async () => {
  const h = retiring();
  const first = vi.spyOn(h.cp.residentProjects,'retire').mockImplementation(unanswered);
  void retireProject(h.cp,entry.projectId,'operator retirement');
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
  const r = restart(h);
  try {
    // The resumed attempt wrote nothing, but the first one may have changed the host before the exit.
    const resumed = vi.spyOn(r.cp.residentProjects,'retire').mockRejectedValue(new HostRetirementRefusal('the CTO session is running',refusalOrder,false));
    await sweep(r);
    expect(resumed).toHaveBeenCalledOnce();
    expect(r.cp.projects.get(entry.projectId)).toMatchObject({suspended:true,retiredAt:null});
    expect(r.cp.db.get(`SELECT completed_at FROM project_retirements WHERE project_id = ?`,[entry.projectId])).toEqual({completed_at:null});
    expect(new CanonicalSessionRegistry(r.cp.db).effective()).toEqual([]);
    resumed.mockResolvedValue(undefined);
    await sweep(r);
    expect(resumed).toHaveBeenCalledTimes(2);
    expect(r.cp.projects.get(entry.projectId)?.retiredAt).toEqual(expect.any(String));
  } finally {r.cp.close();}
});

it('#1251 C-P1: a resumed retirement that had not begun the host step takes its suspension back on a no-write refusal',async () => {
  const h = retiring();
  // The daemon exits while the project's workers settle, after the suspension and before the host step.
  const settle = vi.spyOn(h.cp.workerRetirement,'reconcile').mockImplementation(unanswered);
  const first = vi.spyOn(h.cp.residentProjects,'retire');
  void retireProject(h.cp,entry.projectId,'operator retirement');
  await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
  expect(first).not.toHaveBeenCalled();
  const r = restart(h);
  try {
    expect(r.cp.projects.get(entry.projectId)?.suspended).toBe(true);
    const resumed = vi.spyOn(r.cp.residentProjects,'retire').mockRejectedValue(new HostRetirementRefusal('the CTO session is running',refusalOrder,false));
    await sweep(r);
    expect(resumed).toHaveBeenCalledOnce();
    expect(r.cp.projects.get(entry.projectId)).toMatchObject({suspended:false,retiredAt:null});
    expect(r.cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = ?`,[entry.projectId])).toBeUndefined();
    expect(new CanonicalSessionRegistry(r.cp.db).effective()).toEqual([entry]);
    // The refusal closed the intent with the suspension: nothing is left for the sweep to resume.
    await sweep(r);
    expect(resumed).toHaveBeenCalledOnce();
  } finally {r.cp.close();}
});

it('FV52-01: a tombstoned conversation cannot regain admission under a different pubkey or env project',() => {
  const h = makeHarness();
  try {
    bind(h);
    const registry = new CanonicalSessionRegistry(h.cp.db);
    registry.grant({...entry,buzzActorId:'c'.repeat(64)},null);
    registry.revoke(entry.projectId,h.clock.nowIso());
    // No environment entry: the runtime's authenticated canonical target still names the tombstone.
    expect(buzzMentionSubscriberRegistry(h.cp,null).judgeIdentity!(entry.buzzActorId)).toEqual({verdict:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
    const replacement = {...entry,projectId:'env-replacement',sessionUuid:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',buzzActorId:'c'.repeat(64)};
    const other = bind(h,replacement);
    expect(buzzMentionSubscriberRegistry(h.cp,{sessions:[replacement]}).judgeIdentity!(replacement.buzzActorId)).toEqual({verdict:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
    expect(h.cp.bindings.activePrimaryCto(replacement.projectId)?.sessionId).toBe(other.session.sessionId);
  } finally {h.cp.close();}
});

it('FV52-01: an unrevoked legacy env entry retains canonical checks and admission',() => {
  const h = makeHarness();
  try {
    const {session} = bind(h);
    const subject = buzzMentionSubscriberRegistry(h.cp,{sessions:[entry]});
    expect(subject.judgeIdentity!(entry.buzzActorId)).toMatchObject({verdict:'ADMITTED',binding:{sessionId:session.sessionId}});
    expect(buzzMentionSubscriberRegistry(h.cp,{sessions:[{...entry,projectId:'wrong-project'}]}).judgeIdentity!(entry.buzzActorId)).toEqual({verdict:'EXCLUDED',reason:'PROJECT_MISMATCH'});
  } finally {h.cp.close();}
});

it('FV52-03: the holder receives its bootstrap handoff in band, past TTL, with one wake and no Buzz send',async () => {
  const send = vi.fn(async()=>{throw new Error('mention_policy: signer not registered for channel');});
  const h = makeHarness({buzzTransport:{available:async()=>true,openChannel:async()=>entry.buzzAddress,send}});
  try {
    const {session,binding} = bind(h);
    const other = bind(h,{...entry,projectId:'other',sessionUuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',buzzActorId:'d'.repeat(64)});
    const wake = vi.fn(async()=>allow(ReasonCode.OK,undefined));
    h.cp.outbox.attachInBandWake(wake);
    const queued = h.cp.outbox.enqueue({idempotencyKey:'bootstrap-handoff:fixture',roleKey:binding.roleKey,
      bindingGeneration:binding.bindingGeneration,targetSessionId:session.sessionId,kind:MessageKind.HANDOFF_PACKAGE,
      ttlMs:1,payload:{handoffId:'fixture',projectId:entry.projectId,handoff:{approvedBytes:'content'}}});
    if (!queued.allowed) throw new Error(queued.message);
    await new Promise(resolve=>setImmediate(resolve));
    expect(wake).toHaveBeenCalledWith(binding.roleKey,[queued.value.messageId]);
    h.clock.advance(60_000);
    expect(h.cp.outbox.expireOverdue()).toBe(0);
    await h.buzzAdapter.deliverPending();
    expect(h.cp.outbox.claimDeliverable()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(h.cp.outbox.get(queued.value.messageId)).toMatchObject({status:'PENDING',attempts:0});
    const listed = await callCtoTool(h,{sessionId:session.sessionId,incarnation:session.incarnation},'role_dispatch_pending');
    expect(listed).toMatchObject({ok:true,value:{messages:[expect.objectContaining({messageId:queued.value.messageId,kind:'HANDOFF_PACKAGE'})]}});
    expect(await callCtoTool(h,{sessionId:session.sessionId,incarnation:session.incarnation},'role_dispatch_ack',{messageId:queued.value.messageId})).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(h.cp.outbox.get(queued.value.messageId)?.status).toBe('PENDING');
    expect(await callCtoTool(h,{sessionId:other.session.sessionId,incarnation:other.session.incarnation},'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
    expect(await callCtoTool(h,{sessionId:session.sessionId,incarnation:'stale'},'role_dispatch_pending')).toMatchObject({ok:false});
    expect(h.cp.outbox.acknowledgeInBand(queued.value.messageId,other.session.sessionId,other.session.incarnation).allowed).toBe(false);
    expect(h.cp.outbox.acknowledgeInBand(queued.value.messageId,session.sessionId,'stale').allowed).toBe(false);
    expect(h.cp.db.all('SELECT * FROM outbox_sent_destinations WHERE message_id = ?',[queued.value.messageId])).toEqual([]);
    // A revoked holder keeps its authenticated identity but can no longer read or settle the row.
    expect(h.cp.bindings.revoke(binding.roleKey,'fixture revoke').allowed).toBe(true);
    expect(await callCtoTool(h,{sessionId:session.sessionId,incarnation:session.incarnation},'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
    expect(h.cp.outbox.acknowledgeInBand(queued.value.messageId,session.sessionId,session.incarnation).allowed).toBe(false);
  } finally {h.cp.close();}
});

it('FV52-01: subscriber health and admission reports retain the tombstone refusal on re-judgement',async () => {
  const h = makeHarness();
  const dir = tempDir('v52-health-');
  const key = channelKey(dir,'cto.key');
  const identity = {...entry,buzzActorId:key.pubkey};
  const relay = storingRelay();
  const clock = steppedClock();
  const report = vi.fn();
  let subscriber: ReturnType<typeof startBuzzMentionSubscriberFromStateDir> | undefined;
  try {
    bind(h,identity);
    new CanonicalSessionRegistry(h.cp.db).grant(identity,null);
    writeSubscriberConfig(dir,[{keyFile:key.keyFile,rooms:[identity.buzzAddress]}]);
    subscriber = startBuzzMentionSubscriberFromStateDir(dir,{
      registry:buzzMentionSubscriberRegistry(h.cp,{sessions:[identity]}),sink:{admit:async()=> 'DURABLE' as const},
      openSocket:relay.factory,scheduler:clock.scheduler,reportAdmission:report,
    });
    await relay.drain(subscriber);
    expect(subscriber.admission().identities[0]?.state).toBe('ADMITTED');
    vi.spyOn(h.cp.residentProjects,'retire').mockRejectedValue(new Error('host unavailable'));
    await retireProject(h.cp,identity.projectId,'retire');
    subscriber.rejudge();
    await relay.drain(subscriber);
    expect(subscriber.admission().identities[0]).toMatchObject({state:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({state:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'}));
    expect(relay.openFor(key.pubkey)).toEqual([]);
  } finally {subscriber?.close();h.cp.close();}
});

it('FV52-01: a pending retirement cannot erase a legacy entitlement into ordinary admission',() => {
  const h = makeHarness();
  try {
    bind(h);
    h.cp.db.run('INSERT INTO project_retirements(project_id,requested_at,reason) VALUES (?,?,?)',[entry.projectId,h.clock.nowIso(),'pending']);
    expect(new CanonicalSessionRegistry(h.cp.db).effective([entry])).toEqual([]);
    expect(buzzMentionSubscriberRegistry(h.cp,{sessions:[entry]}).judgeIdentity!(entry.buzzActorId)).toEqual({verdict:'EXCLUDED',reason:'CANONICAL_ENTITLEMENT_REVOKED'});
  } finally {h.cp.close();}
});

it('FV52-03: a switchover recipient holding another project keeps its existing Buzz route',async () => {
  const send = vi.fn(async (_room: string, _content: string, recipients: readonly string[]) => ({eventId:'switch-event',mentionPubkeys:[...recipients]}));
  const h = makeHarness({buzzTransport:{available:async()=>true,openChannel:async()=>entry.buzzAddress,send}});
  try {
    const {session,binding} = bind(h);
    const incoming = bind(h,{...entry,projectId:'incoming-project',sessionUuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',buzzActorId:'d'.repeat(64)});
    h.cp.db.run(`INSERT INTO handoffs(handoff_id,project_id,kind,from_session_id,from_generation,to_session_id,package_json,digest,status,created_at)
      VALUES ('switch',?,'HANDOFF',?,?,?,'{}','sha256:test','PENDING',?)`,
    [entry.projectId,session.sessionId,binding.bindingGeneration,incoming.session.sessionId,h.clock.nowIso()]);
    const wake = vi.fn(async()=>allow(ReasonCode.OK,undefined));
    h.cp.outbox.attachInBandWake(wake);
    const queued = h.cp.outbox.enqueue({idempotencyKey:'handoff:switch',roleKey:binding.roleKey,bindingGeneration:binding.bindingGeneration,
      targetSessionId:incoming.session.sessionId,kind:MessageKind.HANDOFF_PACKAGE,payload:{handoffId:'switch'}});
    if (!queued.allowed) throw new Error(queued.message);
    expect(h.cp.outbox.pendingInBandFor(incoming.session.sessionId,incoming.session.incarnation)).toEqual([]);
    expect(h.cp.outbox.acknowledgeInBand(queued.value.messageId,incoming.session.sessionId,incoming.session.incarnation).allowed).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    await h.buzzAdapter.deliverPending();
    expect(send).toHaveBeenCalledOnce();
    expect(h.cp.outbox.get(queued.value.messageId)?.status).toBe('SENT');
  } finally {h.cp.close();}
});
