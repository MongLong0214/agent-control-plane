import type * as ChildProcessModule from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type * as ProcessArgvModule from '../../src/core/process-argv.ts';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { Clock } from '../../src/core/clock.ts';
import { ClaudeCliAdapter, __testing } from '../../src/runtime/cli-adapters.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';

/**
 * Review R1 witness R4 for S3 (#1104), kept as the reviewer wrote it; only import paths, lint-required
 * types and the HOME isolation below differ. A turn whose holder could not establish cleanup ownership
 * sends no signal, and is not reported as a completed turn.
 *
 * HOME points at a private directory before anything is imported, so the scratch root and the profile
 * follow it and the live daemon's state is never touched.
 */
const isolatedHome = vi.hoisted(() => {
 const home = `${(process.env['TMPDIR'] ?? '/tmp').replace(/\/+$/, '')}/acp-review-r4-home-${process.pid}`;
 process.env['HOME'] = home;
 return home;
});

// This is a cleanup witness, not a confinement test. Execute only our inert fixture through the
// holder directly because this host refuses Seatbelt. No provider binary, credentials or network.
const state=vi.hoisted(()=>({realToken:null as unknown as (pid:number)=>string|null, leaders:[] as Array<{child:ChildProcess;token:string|null}>}));
vi.mock('../../src/core/process-argv.ts',async(importOriginal)=>{
 const original=await importOriginal<typeof ProcessArgvModule>();state.realToken=original.readProcessStartToken;
 return {...original,readProcessStartToken:()=>null};
});
vi.mock('node:child_process',async(importOriginal)=>{
 const original=await importOriginal<typeof ChildProcessModule>();
 return {...original,spawn:(file:string,args:string[],options:SpawnOptions)=>{
  if(file!=='/usr/bin/sandbox-exec'||args[0]!=='-p'||args[2]!=='/bin/ksh') throw Error('unexpected execution');
  const command=args.slice(3);const script=command.findIndex(arg=>arg.endsWith('/fixture.cjs'));
  if(script<0)throw Error('fixture not named');command.splice(script,0,process.execPath);
  const child=original.spawn(args[2],command,{...options,env:{...options.env,PATH:process.env.PATH}});
  state.leaders.push({child,token:state.realToken(child.pid!)});return child;
 }};
});
afterAll(() => { cleanupTempDirs(); rmSync(isolatedHome, { recursive: true, force: true }); });
it.each(['invoke','session'])('R4 %s cannot report success after its holder could not establish cleanup ownership',async(kind)=>{
 const dir=tempDir('unconfirmed-turn-');const binary=join(dir,'fixture.cjs');
 writeFileSync(binary,`#!${process.execPath}\nconst {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore'});child.unref();process.stdout.write(JSON.stringify({result:JSON.stringify({helper:child.pid}),session_id:'review-session'}),()=>process.exit(0));\n`);chmodSync(binary,0o700);
 const adapter=new ClaudeCliAdapter({clock:{nowIso:()=>new Date().toISOString()} as unknown as Clock,capacityFile:join(dir,'capacity'),binary});
 let observedGroup:unknown;
 __testing.setRunCli(async(file,args,options)=>{const result=await __testing.productionRunCli(file,args,options);observedGroup=result.processGroup;return result;});
 let helper:number|undefined;let token:string|null=null;
 try {
  const result=kind==='invoke'
   ?await adapter.invoke({prompt:'x',workdir:dir,timeoutMs:2000,readOnly:true,correlationId:'review',externalSessionId:'review-session'})
   :await adapter.runSessionTurn({handle:{provider:'claude',model:'opus',effort:null,pid:null,externalSessionId:'review-session',workdir:dir},conversation:'new',prompt:'x',timeoutMs:2000,correlationId:'review',relay:null});
  console.error('R4_ADAPTER_RESULT',JSON.stringify({kind,result}));
  helper=(JSON.parse(result.text) as {helper:number}).helper;token=state.realToken(helper);let helperAlive=false;try{process.kill(helper,0);helperAlive=true;}catch{/* gone */}
  console.error('R4_RESULT',JSON.stringify({kind,helperAlive,helperToken:token,observedGroup,result}));
  expect(helperAlive).toBe(true);
  expect(result.ok).toBe(false);
 } finally {
  __testing.setRunCli(null);
  if(helper&&token!==null&&state.realToken(helper)===token)process.kill(helper,'SIGKILL');
  for(const {child,token:leaderToken} of state.leaders.splice(0)) if(child.exitCode===null&&child.signalCode===null&&leaderToken!==null&&state.realToken(child.pid!)===leaderToken)child.kill('SIGKILL');
 }
});
