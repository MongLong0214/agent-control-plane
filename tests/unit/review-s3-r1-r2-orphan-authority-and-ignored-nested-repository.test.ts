import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { WorkerTurnRunner } from '../../src/run/worker-turn.ts';
import { ignoredPathState, ignoredPathsChanged, pinRepository, headOf } from '../../src/run/worker-git.ts';
import { cleanupTempDirs, gitSync, makeCore, makeRepo, tempDir } from '../helpers/fixtures.ts';
import { FakeWorkerAdapter, recordSeededTarget, seedWorkerWorld } from '../helpers/worker-turn-fixture.ts';
import type { InvocationRequest } from '../../src/runtime/provider.ts';
import Database from 'better-sqlite3';
import { fileCore } from '../helpers/worker-turn-fixture.ts';

/**
 * Review R1 witnesses for S3 (#1096, #1097), kept as the reviewer wrote them; only import paths and
 * lint-required types differ.
 *
 * R1: a resolution row written through `AuditLog.record`, or by a second SQLite connection, without the
 * operator repair, must not admit a second execution while the first worker still runs.
 * R2: a change to an existing file inside an ignored nested repository is named, both by the scanner
 * and in a whole worker turn's success receipt and failed-turn diagnostics.
 */

afterAll(cleanupTempDirs);
const waitFor = async (f: () => boolean) => { const until = Date.now()+5000; while (!f()) { if (Date.now()>until) throw Error('wait expired'); await new Promise(r=>setTimeout(r,10)); } };
class Unrecorded extends FakeWorkerAdapter { override invoke(request: InvocationRequest) { return super.invoke({...request,onSpawn:undefined}); } }

it.each(['audit-api','external-sqlite'])('R1 %s cannot release a live unidentified orphan without the operator repair', async (writer) => {
 const dbPath=join(tempDir('orphan-db-'),'state.sqlite');
 const world=seedWorkerWorld(fileCore(dbPath));
 const adapter=new Unrecorded(world.broker); adapter.script={hold:true,ignoreAbort:true};
 const ports={db:world.db,clock:world.clock,audit:world.audit,tasks:world.tasks,guard:world.guard,workerAdapter:()=>adapter};
 const options={pollMs:10,processSettleMs:100,scratchDir:(p:string)=>tempDir(p)};
 const first=new WorkerTurnRunner(ports,options); const restarted=new WorkerTurnRunner(ports,options);
 const request={runId:world.runId,taskId:world.taskId,claimId:world.claimId,ownerSessionId:world.cto.sessionId,ownerBindingGeneration:world.cto.generation};
 let secondId:string|undefined;
 const started=await first.start(request); if(!started.allowed) throw Error(started.message);
 try {
  await waitFor(()=>adapter.launches===1);
  await restarted.reconcileAfterRestart();
  expect((await restarted.start(request)).allowed).toBe(false);
  const evidence={executionId:started.value.executionId,taskId:world.taskId};
  if(writer==='audit-api') {
   const inserted=world.audit.record({kind:'TASK_WORKER_ORPHAN_RESOLVED',runId:world.runId,evidence});
   expect(inserted.allowed).toBe(true);
  } else {
   const outside=new Database(dbPath);
   try { outside.prepare('INSERT INTO audit_events (at,kind,run_id,evidence_json) VALUES (?,?,?,?)').run(world.clock.nowIso(),'TASK_WORKER_ORPHAN_RESOLVED',world.runId,JSON.stringify(evidence)); }
   finally { outside.close(); }
  }
  adapter.script={neverRuns:true};
  const retry=await restarted.start(request); if(retry.allowed) secondId=retry.value.executionId;
  console.error('R1_RESULT',JSON.stringify({writer,retry,oldChildStillAlive:adapter.children[0]?.exitCode===null,resolutions:world.audit.byKind('TASK_WORKER_ORPHAN_RESOLVED')}));
  expect(retry.allowed).toBe(false);
 } finally { adapter.killAll(); await first.settled(started.value.executionId); if(secondId) await restarted.settled(secondId); }
});

it.each(['success','failure'])('R2 an entire worker %s result names an ignored nested-repository edit', async (outcome)=>{
 const world=seedWorkerWorld(makeCore());
 writeFileSync(join(world.repoPath,'.gitignore'),'build/\n');
 gitSync(world.repoPath,['add','.gitignore']);gitSync(world.repoPath,['commit','-qm','ignore build']);
 recordSeededTarget(world); // #512 S-TB: that commit is the task branch's recorded base
 const nested=join(world.repoPath,'build','cache');mkdirSync(nested,{recursive:true});gitSync(nested,['init','-q']);
 writeFileSync(join(nested,'result.txt'),'before');
 const adapter=new FakeWorkerAdapter(world.broker);
 adapter.script={writes:{'src/app.js':'module.exports = () => 2;\n','build/cache/result.txt':'after!',...(outcome==='failure'?{'README.md':'# outside claim\n'}:{})}};
 const runner=new WorkerTurnRunner({db:world.db,clock:world.clock,audit:world.audit,tasks:world.tasks,guard:world.guard,workerAdapter:()=>adapter},{pollMs:10,scratchDir:p=>tempDir(p)});
 const started=await runner.start({runId:world.runId,taskId:world.taskId,claimId:world.claimId,ownerSessionId:world.cto.sessionId,ownerBindingGeneration:world.cto.generation});
 if(!started.allowed) throw Error(started.message);
 await runner.settled(started.value.executionId);
 const view=runner.describe(started.value.executionId,world.runId); if(!view.allowed) throw Error(view.message);
 const receipt=(outcome==='success'?view.value.success?.inputs:view.value.diagnostics?.evidence) as Record<string, unknown> | undefined;
 console.error('R2_TURN_RESULT',JSON.stringify({outcome,status:view.value.execution.status,receipt}));
 expect(view.value.execution.status).toBe(outcome==='success'?'SUCCEEDED':'FAILED');
 expect(receipt?.['ignoredChanges']).toMatchObject({paths:['build/cache/result.txt'],total:1,error:null});
});

it('R2 ignored nested repositories report changes to existing files', async () => {
 const workTree=makeRepo({'base':'base','.gitignore':'build/\n'});
 const nested=join(workTree,'build','cache'); mkdirSync(nested,{recursive:true});
 gitSync(nested,['init','-q']); writeFileSync(join(nested,'result.txt'),'before');
 const pinned=pinRepository(workTree,tempDir('ignored-state-')); if(!pinned.allowed) throw Error(pinned.message); const repo=pinned.value;
 const {head}=await headOf(repo); if(head===null) throw Error('no head');
 try {
  const before=await ignoredPathState(repo,head,'before');
  writeFileSync(join(nested,'result.txt'),'after!');
  const after=await ignoredPathState(repo,head,'after');
  const changed=ignoredPathsChanged(before,after);
  console.error('R2_RESULT',JSON.stringify({before:[...before],after:[...after],changed}));
  expect(changed).toContain('build/cache/result.txt');
 } finally { await repo.children.close(500); }
});
