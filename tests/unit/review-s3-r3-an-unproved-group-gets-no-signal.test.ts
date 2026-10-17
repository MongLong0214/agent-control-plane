import type * as ChildProcessModule from 'node:child_process';
import type * as ProcessArgvModule from '../../src/core/process-argv.ts';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterAll, expect, it, vi } from 'vitest';
import { __testing } from '../../src/runtime/cli-adapters.ts';

/**
 * Review R1 witness R3 for S3 (#1104), kept as the reviewer wrote it; only import paths, lint-required
 * types and the HOME isolation below differ. A cleanup of an invocation without a holder sends no signal
 * at all when the leader's start token is no longer the one read at spawn, or cannot be read.
 *
 * HOME points at a private directory before anything is imported, so the scratch root follows it and
 * the live daemon's state is never touched. Nothing here starts a real process: `spawn` is a fake.
 */
const isolatedHome = vi.hoisted(() => {
 const home = `${(process.env['TMPDIR'] ?? '/tmp').replace(/\/+$/, '')}/acp-review-r3-home-${process.pid}`;
 process.env['HOME'] = home;
 return home;
});
afterAll(() => rmSync(isolatedHome, { recursive: true, force: true }));

type FakeChild = EventEmitter & {
 pid: number; exitCode: number | null; signalCode: string | null;
 stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; stdio: PassThrough[];
 kill: (signal: string) => boolean;
};
const state=vi.hoisted(()=>({token:'start-A' as string|null,signals:[] as string[], child:null as FakeChild|null}));
vi.mock('../../src/core/process-argv.ts',async (importOriginal)=>({...(await importOriginal<typeof ProcessArgvModule>()),readProcessStartToken:()=>state.token}));
vi.mock('node:child_process', async(importOriginal)=>{
 const original=await importOriginal<typeof ChildProcessModule>();
 return {...original,spawn:(..._args:unknown[])=>{
  const child=new EventEmitter() as FakeChild;
  Object.assign(child,{pid:494949,exitCode:null,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  child.stdio=[child.stdin,child.stdout,child.stderr];
  child.kill=(signal:string)=>{state.signals.push(`leader:${signal}`); child.signalCode=signal; child.emit('exit',null,signal); child.stdout.end();child.stderr.end();child.emit('close',null,signal);return true;};
  state.child=child; return child;
 }};
});

it.each(['start-B',null])('R3 a non-holder cleanup sends no signal when the current incarnation is %s',async(current)=>{
 state.token='start-A';state.signals=[];
 const kill=vi.spyOn(process,'kill').mockImplementation(((pid:number,signal?:string|number)=>{
  if(signal!==0) {state.signals.push(`group:${pid}:${signal}`);state.child!.signalCode=String(signal);state.child!.emit('exit',null,signal);state.child!.emit('close',null,signal);}
  return true;
 }) as typeof process.kill);
 try {
  const pending=__testing.productionRunCli('/bin/echo',[],{cwd:undefined,timeoutMs:10,onSpawn:()=>{state.token=current;}});
  await new Promise(r=>setTimeout(r,50));
  if(state.child!.signalCode===null) {state.child!.exitCode=0;state.child!.emit('exit',0,null);state.child!.emit('close',0,null);}
  const result=await pending;
  console.error('R3_RESULT',JSON.stringify({signals:state.signals,result}));
  expect(state.signals).toEqual([]);
 } finally {kill.mockRestore();}
});

// Added beside the reviewer's witness: the refusal is bounded. A leader that is never signalled and
// never closes its pipes does not hold the answer: it comes within the settle bound, names the group
// left unended, and still nothing at all was signalled.
it('R3 an unproved group that never closes is answered within the bound, named, with no signal', async () => {
 state.token='start-A';state.signals=[];
 const kill=vi.spyOn(process,'kill').mockImplementation(((pid:number,signal?:string|number)=>{
  if(signal!==0) state.signals.push(`group:${pid}:${signal}`);
  return true;
 }) as typeof process.kill);
 try {
  const started=performance.now();
  const result=await __testing.productionRunCli('/bin/echo',[],{cwd:undefined,timeoutMs:10,onSpawn:()=>{state.token='start-B';}});
  const tookMs=performance.now()-started;
  console.error('R3_BOUNDED',JSON.stringify({signals:state.signals,tookMs,result}));
  expect(state.signals).toEqual([]);
  expect(tookMs).toBeLessThan(10_000);
  expect(result.exitCode).toBeNull();
  expect(result.processGroup).toMatchObject({pgid:494949,reaped:false,signalled:false,delivered:0,ownership:'UNVERIFIABLE'});
  expect(result.processGroup?.detail).toMatch(/process group 494949 was not signalled/);
  expect(state.child!.stdout.destroyed).toBe(true);
 } finally {kill.mockRestore();}
});
