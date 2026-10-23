import { afterAll, expect, it, vi } from 'vitest';
import { digestOf, sha256 } from '../../src/core/digest.ts';
import { deny } from '../../src/core/errors.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { Role, RunKind, SessionLifecycle } from '../../src/domain/types.ts';
import { MessageKind } from '../../src/outbox/envelope.ts';
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from '../../src/registry/canonical-self-claim.ts';
import { callCtoTool } from '../helpers/cto-tool.ts';
import { openActivationHandoff, producedHandoff } from '../helpers/driven-primary-cto.ts';
import { cleanupTempDirs } from '../helpers/fixtures.ts';
import { makeHarness } from '../helpers/harness.ts';

afterAll(cleanupTempDirs);

const world = (canonical = true) => {
  const h = makeHarness();
  const cp = h.cp;
  const projectId = 'package-authority';
  cp.projects.register({projectId,name:projectId});
  const session = cp.sessions.create({provider:'scripted',model:'test',buzzAddress:'buzz:package-authority'});
  cp.sessions.transition(session.sessionId,SessionLifecycle.READY,'fixture');
  cp.sessions.bindBuzzActor({sessionId:session.sessionId,sessionSecret:session.sessionSecret!,buzzActorId:'actor:package-authority'}, {isAllowedActor:()=>true});
  const targetLocator = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const claimed = {executorKind:SELF_CLAIM_EXECUTOR_KIND,targetLocator,targetLocatorDigest:sha256(targetLocator)};
  const binding = cp.bindings.bind({role:Role.PRIMARY_CTO,projectId,sessionId:session.sessionId,
    ...(canonical ? {authenticatedTarget:{claimed,protocolVersion:SELF_CLAIM_PROTOCOL,attestationDigest:digestOf(claimed),verify:()=>claimed}} : {})});
  expect(binding.allowed).toBe(true);
  const run = cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:'STANDARD',contract:{goal:'bootstrap',why:'test',scope:[],nonGoals:[],acceptance:['ready'],priority:'NORMAL',humanGate:[],references:[]}});
  if (!run.allowed) throw new Error(run.message);
  // These helpers only read the harness; no provider or socket is started by this fixture.
  const fixture = {harness:h} as Parameters<typeof producedHandoff>[0];
  const handoff = producedHandoff(fixture,run.value.runId,projectId);
  const open = () => openActivationHandoff(fixture)(projectId,run.value.runId,session.sessionId,handoff);
  const opened = open();
  if (!opened.allowed) throw new Error(opened.message);
  const handoffId = opened.value.handoffId;
  const message = cp.outbox.byIdempotencyKey(`bootstrap-handoff:${handoffId}`)!;
  const peer = {sessionId:session.sessionId,incarnation:session.incarnation};
  const receipt = {messageId:message.messageId,payloadDigest:message.payloadDigest,bindingGeneration:message.bindingGeneration};
  const state = () => ({handoff:cp.db.get('SELECT * FROM handoffs WHERE handoff_id = ?',[handoffId]),outbox:cp.db.get('SELECT * FROM outbox WHERE message_id = ?',[message.messageId])});
  let key = 0;
  const ack = (overrides = {}, as = peer) => callCtoTool(h,as,'handoff_ack',{idempotencyKey:`package-ack-${++key}`,handoffId,...receipt,...overrides});
  return {h,cp,session,projectId,runId:run.value.runId,handoffId,message,peer,receipt,state,ack,open};
};

it('FV52-04 / CEO B: MCP read then handoff ACK settles both records; generic ACK refuses; same-session re-ACK is idempotent',async () => {
  const w = world();
  try {
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[expect.objectContaining(w.receipt)]}});
    const before = w.state();
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_ack',{messageId:w.message.messageId})).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(before);
    expect(await w.ack()).toMatchObject({ok:true});
    expect(w.state()).toMatchObject({handoff:{status:'ACKED'},outbox:{status:'ACKED'}});
    const settled = w.state();
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
    const effects = () => ({handoff:w.cp.audit.byKind('HANDOFF_ACK'),outbox:w.cp.audit.byKind('OUTBOX_ACKED_IN_BAND')});
    const firstEffects = effects();
    w.h.clock.advance(1000);
    expect(await w.ack()).toMatchObject({ok:true});
    expect(w.state()).toEqual(settled);
    expect(effects()).toEqual(firstEffects);
    expect(await w.ack({}, {...w.peer,incarnation:'other-incarnation'})).toMatchObject({ok:false});
    const other = w.cp.sessions.create({provider:'scripted',model:'test'});
    expect(w.cp.bootstrap.acknowledgeActivationHandoff(w.handoffId,other.sessionId,other.incarnation,w.receipt).allowed).toBe(false);
    expect(w.cp.bootstrap.acknowledgeActivationHandoff(w.handoffId,w.session.sessionId,'other-incarnation',w.receipt).allowed).toBe(false);
    expect(w.state()).toEqual(settled);
  } finally {w.cp.close();}
});

it('closure 1: the package lookup and outbox transition share the ACK transaction',async () => {
  const w = world();
  const lookup = w.cp.outbox.byIdempotencyKey.bind(w.cp.outbox);
  const settle = w.cp.outbox.acknowledgeHandoffInBand.bind(w.cp.outbox);
  const observations: boolean[] = [];
  const read = vi.spyOn(w.cp.outbox,'byIdempotencyKey').mockImplementation(key => {
    if (key === `bootstrap-handoff:${w.handoffId}`) observations.push(w.cp.db.inTransaction);
    return lookup(key);
  });
  const ack = vi.spyOn(w.cp.outbox,'acknowledgeHandoffInBand').mockImplementation((...args) => {
    observations.push(w.cp.db.inTransaction);
    return settle(...args);
  });
  try {
    expect(await w.ack()).toMatchObject({ok:true});
    expect(read).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(observations).toEqual([true,true]);
  } finally {read.mockRestore();ack.mockRestore();w.cp.close();}
});

it.each(['DIGEST','GENERATION'] as const)('closure 3: re-ACK refuses a changed %s even when the message ID is reused',async changed => {
  const w = world();
  try {
    expect(await w.ack()).toMatchObject({ok:true});
    let receipt = w.receipt;
    if (changed === 'DIGEST') {
      const payload = w.message.payload as {handoffId:string;projectId:string;handoff:Record<string,unknown>};
      const handoff = {...payload.handoff,recentDecisions:['changed after the successful ACK']};
      const replacement = {...payload,handoff};
      receipt = {...receipt,payloadDigest:digestOf(replacement)};
      w.cp.db.run('UPDATE handoffs SET package_json = ?, digest = ? WHERE handoff_id = ?',[JSON.stringify(handoff),digestOf(handoff),w.handoffId]);
      w.cp.db.run('UPDATE outbox SET payload_json = ?, payload_digest = ? WHERE message_id = ?',[JSON.stringify(replacement),receipt.payloadDigest,w.message.messageId]);
    } else {
      const holder = w.cp.bindings.activePrimaryCto(w.projectId)!;
      expect(w.cp.bindings.revoke(holder.roleKey,'new generation').allowed).toBe(true);
      const bound = w.cp.bindings.bind({role:Role.PRIMARY_CTO,projectId:w.projectId,sessionId:w.session.sessionId});
      if (!bound.allowed) throw new Error(bound.message);
      receipt = {...receipt,bindingGeneration:bound.value.bindingGeneration};
      w.cp.db.run('UPDATE outbox SET binding_generation = ? WHERE message_id = ?',[receipt.bindingGeneration,w.message.messageId]);
    }
    const before = w.state();
    expect(await w.ack(receipt)).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(before);
  } finally {w.cp.close();}
});

it.each(['REJECTED','EXPIRED','STALE_GENERATION'] as const)('closure 3: a never-readable %s package cannot be mistaken for an idempotent re-ACK',async broken => {
  const w = world();
  try {
    if (broken === 'STALE_GENERATION') w.cp.db.run('UPDATE outbox SET binding_generation = binding_generation + 1 WHERE message_id = ?',[w.message.messageId]);
    else w.cp.db.run('UPDATE outbox SET status = ? WHERE message_id = ?',[broken,w.message.messageId]);
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
    const before = w.state();
    expect(await w.ack()).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(before);
  } finally {w.cp.close();}
});

it('FV52-04: missing read identifiers or a revoked holder cannot settle the package',async () => {
  const w = world();
  try {
    const before = w.state();
    expect(w.cp.bootstrap.acknowledgeActivationHandoff(w.handoffId,w.session.sessionId,w.session.incarnation))
      .toMatchObject({allowed:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(before);
    const binding = w.cp.bindings.activePrimaryCto(w.projectId)!;
    expect(w.cp.bindings.revoke(binding.roleKey,'retired holder').allowed).toBe(true);
    const revoked = w.state();
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
    expect(await w.ack()).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(revoked);
  } finally {w.cp.close();}
});

it.each([{messageId:'other-package'},{payloadDigest:'sha256:other'},{bindingGeneration:99}])('FV52-04: MCP binds the ACK to the read identifiers %j',async wrong => {
  const w = world();
  try {
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[expect.objectContaining(w.receipt)]}});
    const before = w.state();
    expect(await w.ack(wrong)).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(before);
  } finally {w.cp.close();}
});

it('FV52-04 / CEO B: a denial inside the outbox ACK rolls back both records, including a write before the denial',() => {
  const w = world();
  try {
    const before = w.state();
    const step = vi.spyOn(w.cp.outbox,'acknowledgeHandoffInBand').mockImplementation(() => {
      w.cp.db.run("UPDATE outbox SET status = 'ACKED' WHERE message_id = ?",[w.message.messageId]);
      return deny(ReasonCode.HANDOFF_ACK_REQUIRED,'forced in-band ACK denial');
    });
    expect(w.cp.bootstrap.acknowledgeActivationHandoff(w.handoffId,w.session.sessionId,w.session.incarnation,w.receipt)).toMatchObject({allowed:false});
    expect(step).toHaveBeenCalledOnce();
    expect(w.state()).toEqual(before);
    step.mockRestore();
  } finally {w.cp.close();}
});

it.each(['REJECTED','EXPIRED','STALE_GENERATION'] as const)('FV52-04: retry reissues an unreadable %s package to the same adopted holder exactly once',async broken => {
  const w = world();
  try {
    if (broken === 'STALE_GENERATION') w.cp.db.run('UPDATE outbox SET binding_generation = binding_generation + 1 WHERE message_id = ?',[w.message.messageId]);
    else w.cp.db.run('UPDATE outbox SET status = ? WHERE message_id = ?',[broken,w.message.messageId]);
    const before = w.state();
    expect(await w.ack()).toMatchObject({ok:false});
    const reopened = w.open();
    if (!reopened.allowed) throw new Error(reopened.message);
    expect(reopened.value.handoffId).not.toBe(w.handoffId);
    expect(w.open()).toMatchObject({allowed:true,value:reopened.value});
    expect(w.state()).toEqual(before);
    const listed = await callCtoTool(w.h,w.peer,'role_dispatch_pending');
    const messages = (listed.value as {messages:Array<{messageId:string;bindingGeneration:number;payloadDigest:string;payload:{handoffId:string}}>}).messages;
    expect(messages).toHaveLength(1);
    const fresh = messages[0]!;
    expect(fresh.payload.handoffId).toBe(reopened.value.handoffId);
    expect(await callCtoTool(w.h,w.peer,'handoff_ack',{...fresh,handoffId:fresh.payload.handoffId,idempotencyKey:'fresh-ack'})).toMatchObject({ok:true});
    expect(w.cp.outbox.get(fresh.messageId)?.status).toBe('ACKED');
    expect(w.cp.db.get('SELECT status FROM handoffs WHERE handoff_id = ?',[reopened.value.handoffId])).toEqual({status:'ACKED'});
    expect(w.state()).toEqual(before);
  } finally {w.cp.close();}
});

it.each(['PENDING','REJECTED','EXPIRED','WRONG_DIGEST','SENT'] as const)('FV52-04: legacy interactive Buzz package ACK is bound to delivery: %s',async status => {
  const w = world(false);
  try {
    expect(await callCtoTool(w.h,w.peer,'role_dispatch_pending')).toMatchObject({ok:true,value:{messages:[]}});
    if (status !== 'PENDING') {
      await w.h.buzzAdapter.deliverPending();
      expect(w.cp.outbox.get(w.message.messageId)?.status).toBe('SENT');
      if (status === 'REJECTED' || status === 'EXPIRED') w.cp.db.run('UPDATE outbox SET status = ? WHERE message_id = ?',[status,w.message.messageId]);
    }
    const before = w.state();
    const answer = await w.ack(status === 'WRONG_DIGEST' ? {payloadDigest:'sha256:wrong'} : {});
    if (status === 'SENT') {
      expect(answer).toMatchObject({ok:true});
      expect(w.state()).toMatchObject({handoff:{status:'ACKED'},outbox:{status:'ACKED'}});
      expect(await w.ack()).toMatchObject({ok:true});
    } else {
      expect(answer).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
      expect(w.state()).toEqual(before);
    }
  } finally {w.cp.close();}
});

it.each(['ROLE','PROJECT','TARGET','KIND','PAYLOAD'] as const)('FV52-04: package authority does not widen to another %s',async wrong => {
  const w = world();
  try {
    const column = {ROLE:'role_key',PROJECT:'role_key',TARGET:'target_session_id',KIND:'kind',PAYLOAD:'payload_json'}[wrong];
    const value = {ROLE:'CEO',PROJECT:'PRIMARY_CTO:elsewhere',TARGET:w.cp.sessions.create({provider:'scripted',model:'test'}).sessionId,KIND:MessageKind.RUN_DISPATCH,PAYLOAD:JSON.stringify({handoffId:'other'})}[wrong];
    w.cp.db.run(`UPDATE outbox SET ${column} = ? WHERE message_id = ?`,[value,w.message.messageId]);
    const before = w.state();
    expect(await w.ack()).toMatchObject({ok:false,reasonCode:'HANDOFF_ACK_REQUIRED'});
    expect(w.state()).toEqual(before);
  } finally {w.cp.close();}
});
