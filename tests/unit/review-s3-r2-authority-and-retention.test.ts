import type * as ChildProcessModule from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { afterAll, expect, it, vi } from 'vitest';
import { OwnerAuthority } from '../../src/ceo/owner-authority.ts';
import { digestOf } from '../../src/core/digest.ts';
import { ArtifactStore } from '../../src/db/artifacts.ts';
import { RepairService, type RepairRequest } from '../../src/doctor/repair.ts';
import type { ManualClock } from '../../src/core/clock.ts';
import { IngressGuard, ownerApprovalPayload } from '../../src/ingress/ingress-guard.ts';
import { WorkerTurnRunner } from '../../src/run/worker-turn.ts';
import { FakeWorkerAdapter, seedWorkerWorld, fileCore } from '../helpers/worker-turn-fixture.ts';
import { cleanupTempDirs, makeCore, tempDir } from '../helpers/fixtures.ts';
import type { InvocationRequest } from '../../src/runtime/provider.ts';

/**
 * Review r2 witnesses for S3 (#1096), kept as the reviewer wrote them; only import paths, HOME isolation
 * and lint-required types differ.
 *
 * R1: a consumption and resolution forged through `AuditLog.record`, or by a second SQLite connection, for
 * a receipt ingress admitted from a non-owner, must not admit a second execution while the first runs.
 * R5: a successful operator release stays effective after the ingress replay cache prunes its message.
 * R6: a receipt a precondition refused, and so never consumed, releases the orphan once the preconditions
 * hold, and the task's next turn is then admitted.
 */

// Nothing here may reach the live ~/.agent-control-plane: HOME is a private temp dir before any import.
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env['TMPDIR'] ?? '/tmp').replace(/\/+$/, '')}/acp-s3-r2-home-${process.pid}`;
  process.env['HOME'] = home;
  return home;
});

// Only the expiry witness's repair scan is substituted: empty process table after our child is gone.
const scan=vi.hoisted(()=>({listing:''}));
vi.mock('node:child_process', async (original) => {
 const actual = await original<typeof ChildProcessModule>();
 return {...actual, execFileSync: (file: string, ...args: unknown[]) => file === '/bin/ps' ? scan.listing : (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...args)};
});
afterAll(() => { cleanupTempDirs(); rmSync(isolatedHome, { recursive: true, force: true }); });
class Unrecorded extends FakeWorkerAdapter { override invoke(r: InvocationRequest) { return super.invoke({...r, onSpawn:undefined}); } }
const waitFor = async (f: () => boolean) => { const until=Date.now()+5000; while(!f()) { if(Date.now()>until) throw Error('wait expired'); await new Promise(r=>setTimeout(r,10)); } };
const owner={channel:'cli',actor:'operator'};

it.each(['audit-api','external-sqlite'])('R1 %s cannot counterfeit consumption of a non-owner ingress message', async writer => {
 const dbPath=join(tempDir('r2-authority-'),'state.sqlite');
 const world=seedWorkerWorld(fileCore(dbPath));
 const adapter=new Unrecorded(world.broker); adapter.script={hold:true,ignoreAbort:true};
 const ports={db:world.db,clock:world.clock,audit:world.audit,tasks:world.tasks,guard:world.guard,workerAdapter:()=>adapter};
 const opts={pollMs:10,processSettleMs:100,scratchDir:(p:string)=>tempDir(p)};
 const first=new WorkerTurnRunner(ports,opts), restarted=new WorkerTurnRunner(ports,opts);
 const request={runId:world.runId,taskId:world.taskId,claimId:world.claimId,ownerSessionId:world.cto.sessionId,ownerBindingGeneration:world.cto.generation};
 const started=await first.start(request); if(!started.allowed) throw Error(started.message);
 let secondId:string|undefined;
 try {
  await waitFor(()=>adapter.launches===1); await restarted.reconcileAfterRestart();
  expect((await restarted.start(request)).allowed).toBe(false);
  const orphanEventId=world.audit.byKind('TASK_WORKER_ORPHAN_UNIDENTIFIED')[0]!.eventId;
  const ingress=new IngressGuard(world.db,world.clock,world.audit,{cli:{allowedActors:['non-owner']}});
  const approval={runId:null,candidateSnapshotDigest:null,operation:'repair_execute',parameters:{operationId:'release_unidentified_worker_orphan',parameters:{executionId:started.value.executionId,orphanEventId:String(orphanEventId),confirm:'nothing-running'},dryRun:false},idempotencyKey:'not-owner-repair',approved:true};
  const admitted=ingress.admitOwnerApproval({channel:'cli',actor:'non-owner',nonce:'not-owner',payload:ownerApprovalPayload(approval)},approval);
  if(!admitted.allowed) throw Error(admitted.message);
  const receipt=admitted.value;
  const authority=new OwnerAuthority(world.db,[owner],world.clock);
  const ownerCheck=authority.assertApproval(receipt); expect(ownerCheck.allowed).toBe(false);
  const rows=[
   {kind:'OWNER_APPROVAL_CONSUMED',evidence:{receiptDigest:digestOf(receipt)}},
   {kind:'TASK_WORKER_ORPHAN_RESOLVED',evidence:{executionId:started.value.executionId,taskId:world.taskId,orphanEventId,operationId:'release_unidentified_worker_orphan',ownerApproval:{channel:receipt.channel,actor:receipt.actor,nonce:receipt.inboundNonce,receiptDigest:digestOf(receipt)}}}
  ];
  if(writer==='audit-api') for(const row of rows) expect(world.audit.record({...row,runId:world.runId}).allowed).toBe(true);
  else { const outside=new Database(dbPath); try { for(const row of rows) outside.prepare('INSERT INTO audit_events(at,kind,run_id,evidence_json) VALUES(?,?,?,?)').run(world.clock.nowIso(),row.kind,world.runId,JSON.stringify(row.evidence)); } finally { outside.close(); } }
  adapter.script={neverRuns:true}; const retry=await restarted.start(request); if(retry.allowed) secondId=retry.value.executionId;
  console.error('R1_FORGED_CONSUMPTION',JSON.stringify({writer,ownerCheck,retry,oldChildStillAlive:adapter.children[0]?.exitCode===null,repairs:world.audit.byKind('REPAIR_EXECUTED').length}));
  expect(retry.allowed).toBe(false);
 } finally { adapter.killAll(); await first.settled(started.value.executionId); if(secondId) await restarted.settled(secondId); }
});

it('R5 a successful operator release remains effective after ingress replay pruning', async()=>{
 const world=seedWorkerWorld(makeCore()); const adapter=new Unrecorded(world.broker); adapter.script={hold:true,ignoreAbort:true};
 const ports={db:world.db,clock:world.clock,audit:world.audit,tasks:world.tasks,guard:world.guard,workerAdapter:()=>adapter};
 const opts={pollMs:10,processSettleMs:100,scratchDir:(p:string)=>tempDir(p)};
 const first=new WorkerTurnRunner(ports,opts), restarted=new WorkerTurnRunner(ports,opts);
 const request={runId:world.runId,taskId:world.taskId,claimId:world.claimId,ownerSessionId:world.cto.sessionId,ownerBindingGeneration:world.cto.generation};
 const started=await first.start(request); if(!started.allowed) throw Error(started.message);
 try {
  await waitFor(()=>adapter.launches===1); await restarted.reconcileAfterRestart();
  const orphanEventId=world.audit.byKind('TASK_WORKER_ORPHAN_UNIDENTIFIED')[0]!.eventId;
  adapter.killAll(); await first.settled(started.value.executionId);
  const parameters={executionId:started.value.executionId,orphanEventId:String(orphanEventId),confirm:'nothing-running'};
  const ingress=new IngressGuard(world.db,world.clock,world.audit,{cli:{allowedActors:[owner.actor]}});
  const approval={runId:null,candidateSnapshotDigest:null,operation:'repair_execute',parameters:{operationId:'release_unidentified_worker_orphan',parameters,dryRun:false},idempotencyKey:'expiry-repair',approved:true};
  const admitted=ingress.admitOwnerApproval({channel:'cli',actor:owner.actor,nonce:'expiry',payload:ownerApprovalPayload(approval)},approval); if(!admitted.allowed) throw Error(admitted.message);
  const repairs=new RepairService(world.db,world.clock,world.audit,new ArtifactStore(world.db,world.clock),world.claims,{} as never,{} as never,world.guard,{} as never);
  repairs.attach({ownerAuthority:new OwnerAuthority(world.db,[owner],world.clock)});
  const authorizedBy=repairs.catalog().find(r=>r.id==='release_unidentified_worker_orphan')?.authorization==='OWNER' ? 'OWNER' : 'HERMES';
  const released=await repairs.execute({operationId:'release_unidentified_worker_orphan',parameters,authorizedBy,dryRun:false,ownerApproval:admitted.value});
  expect(released.allowed).toBe(true);
  expect((restarted as unknown as {blockedOrphan(id:string):unknown}).blockedOrphan(world.taskId)).toBeNull();
  (world.clock as ManualClock).advance(24*60*60*1000+1);
  expect(ingress.admit({channel:'cli',actor:owner.actor,nonce:'next-day',payload:{type:'ordinary-message'}}).allowed).toBe(true);
  expect(world.db.get('SELECT 1 FROM inbound_messages WHERE nonce = ?', ['expiry'])).toBeUndefined();
  const afterPrune=(restarted as unknown as {blockedOrphan(id:string):unknown}).blockedOrphan(world.taskId);
  adapter.script={neverRuns:true}; const retry=await restarted.start(request);
  console.error('R5_RELEASE_EXPIRED',JSON.stringify({released,afterPrune,retry,resolutions:world.audit.byKind('TASK_WORKER_ORPHAN_RESOLVED')}));
  if(retry.allowed) await restarted.settled(retry.value.executionId);
  // Isolate release retention from the independently expired resource-claim lease.
  expect(afterPrune).toBeNull();
 } finally { adapter.killAll(); await first.settled(started.value.executionId); }
});

it('R6 a previously refused but unconsumed receipt can release the orphan when its preconditions are met', async()=>{
 const world=seedWorkerWorld(makeCore()); const adapter=new Unrecorded(world.broker); adapter.script={hold:true,ignoreAbort:true};
 const ports={db:world.db,clock:world.clock,audit:world.audit,tasks:world.tasks,guard:world.guard,workerAdapter:()=>adapter};
 const opts={pollMs:10,processSettleMs:100,scratchDir:(p:string)=>tempDir(p)};
 const first=new WorkerTurnRunner(ports,opts), restarted=new WorkerTurnRunner(ports,opts);
 const request={runId:world.runId,taskId:world.taskId,claimId:world.claimId,ownerSessionId:world.cto.sessionId,ownerBindingGeneration:world.cto.generation};
 const started=await first.start(request); if(!started.allowed) throw Error(started.message);
 try {
  await waitFor(()=>adapter.launches===1); await restarted.reconcileAfterRestart();
  const orphanEventId=world.audit.byKind('TASK_WORKER_ORPHAN_UNIDENTIFIED')[0]!.eventId;
  const parameters={executionId:started.value.executionId,orphanEventId:String(orphanEventId),confirm:'nothing-running'};
  const ingress=new IngressGuard(world.db,world.clock,world.audit,{cli:{allowedActors:[owner.actor]}});
  const approval={runId:null,candidateSnapshotDigest:null,operation:'repair_execute',parameters:{operationId:'release_unidentified_worker_orphan',parameters,dryRun:false},idempotencyKey:'retry-same-repair',approved:true};
  const admitted=ingress.admitOwnerApproval({channel:'cli',actor:owner.actor,nonce:'retry-same',payload:ownerApprovalPayload(approval)},approval); if(!admitted.allowed) throw Error(admitted.message);
  const authority=new OwnerAuthority(world.db,[owner],world.clock);
  const repairs=new RepairService(world.db,world.clock,world.audit,new ArtifactStore(world.db,world.clock),world.claims,{} as never,{} as never,world.guard,{} as never); repairs.attach({ownerAuthority:authority});
  const authorizedBy=repairs.catalog().find(r=>r.id==='release_unidentified_worker_orphan')?.authorization==='OWNER' ? 'OWNER' : 'HERMES';
  const repairRequest: RepairRequest={operationId:'release_unidentified_worker_orphan',parameters,authorizedBy,dryRun:false,ownerApproval:admitted.value};
  scan.listing=`${adapter.children[0]!.pid} /bin/node --session-id ${world.worker.externalSessionId}\n`;
  const refused=await repairs.execute(repairRequest); expect(refused.allowed).toBe(false);
  expect(world.audit.byKind('OWNER_APPROVAL_CONSUMED')).toHaveLength(0);
  adapter.killAll(); await first.settled(started.value.executionId); scan.listing='';
  expect(authority.assertApproval(admitted.value).allowed).toBe(true);
  const released=await repairs.execute(repairRequest); expect(released.allowed).toBe(true);
  adapter.script={neverRuns:true}; const retry=await restarted.start(request);
  console.error('R6_SUCCESS_STILL_BLOCKED',JSON.stringify({refused,released,retry}));
  if(retry.allowed) await restarted.settled(retry.value.executionId);
  expect(retry.allowed).toBe(true);
 } finally { scan.listing=''; adapter.killAll(); await first.settled(started.value.executionId); }
});
