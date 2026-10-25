import { afterAll, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, statSync, symlinkSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import type { ProjectAllocation } from '../../src/runtime/host-project-provisioner.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';

afterAll(cleanupTempDirs);
const fixture = () => {
  const home = realpathSync(tempDir('resident-host-home-'));const state = join(home,'acp');const bin = join(home,'bin');mkdirSync(bin);const resolvedBin = join(home,'resolved');mkdirSync(resolvedBin);
  const a:ProjectAllocation = {projectId:'test',runId:'run_test',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'a'.repeat(40),sessionUuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',roomId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',roomName:'test',clonePath:join(home,'projects','fixture'),tmuxName:'acp-74657374',socketPath:join(state,'cc-session-test.sock'),fleetName:'acp-test',identityName:'cto-test',privateKeyFile:join(home,'.hermes','bridge','keys','cto-test.priv'),bootPacket:join(home,'.claude','watchers','fleet','acp-test.boot.txt'),nonce:'nonce'};
  mkdirSync(join(home,'.hermes','bridge','keys'),{recursive:true});
  writeFileSync(join(home,'.hermes','bridge','keys','owner.pub'),'c'.repeat(64));writeFileSync(join(home,'.hermes','bridge','keys','ceo2.pub'),'d'.repeat(64));
  mkdirSync(join(home,'.claude','scripts'),{recursive:true});writeFileSync(join(home,'.claude','scripts','claude-trust-dir.sh'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.HOME, cmd = path.basename(process.argv[1]), args = process.argv.slice(2), stateFile = path.join(root,'fake.json');
const a = JSON.parse(fs.readFileSync(path.join(root,'allocation.json'),'utf8'));
if(fs.existsSync(path.join(root,'fail-'+cmd))) {process.stdout.write('SECRET-STDOUT');process.stderr.write('SECRET-STDERR');process.exit(23);}
const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : {members:[],posts:[],creates:0,launches:0};
const out = x => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const save = () => fs.writeFileSync(stateFile,JSON.stringify(s));
const value = f => args[args.indexOf(f)+1];
if(cmd === 'gh') out('R_node');
else if(cmd === 'git') { if(args[0] === 'clone') fs.mkdirSync(path.join(a.clonePath,'.git'),{recursive:true}); else if(args[0] === 'remote') out(s.badOrigin ? 'https://github.com/other/repo.git' : 'https://github.com/acme/fixture.git'); else if(args[0] === 'cat-file') out('commit'); else if(args[0] === 'rev-parse') out(a.head); else if(args[0] === 'symbolic-ref') out('dev'); else if(args[0] === 'status') out(fs.existsSync(path.join(a.clonePath,'dirty.txt')) ? '?? dirty.txt\\n' : ''); else process.exit(2); }
else if(cmd === 'docker') {s.admitted=s.admitted||[];if(!s.admitted.includes(value('--pubkey'))) {s.admitted.push(value('--pubkey'));s.admissions=(s.admissions||0)+1;}out('{}');}
else if(cmd === 'claude') {if(args[0] !== 'mcp') process.exit(2);if(args[1] === 'add') {s.mcp=true;s.mcpUuid=a.sessionUuid;} else if(args[1] === 'remove') {s.mcp=false;s.mcpRemovals=(s.mcpRemovals||0)+1;} else if(!s.mcp) process.exit(1);else out('acp-cto agentctl attach resident-cto --claimed-session-id '+s.mcpUuid+' --project-id test');}
else if(cmd === 'tmux') {
 if(args[0] === 'has-session') process.exit(s.launched || s.pane ? 0 : 1);
 if(args[0] === 'new-session') {s.launched=true;s.pane=true;s.launches++;fs.mkdirSync(path.join(root,'.claude','sessions'),{recursive:true});fs.writeFileSync(path.join(root,'.claude','sessions',process.env.TEST_CLAUDE_PID+'.json'),JSON.stringify({sessionId:a.sessionUuid,cwd:a.clonePath,bridgeSessionId:'bridge'}));}
 else if(args[0] === 'display-message') {if(args.at(-1).includes('pane_current_path')) out(a.clonePath+'\\t'+path.join(process.env.ACP_STATE_DIR,'resident-test.sh'));else {if(!s.launched) process.exit(1);out('999999');}} else if(args[0] === 'kill-session') {s.pane=false;} else process.exit(2);
}
else if(cmd === 'ps') {if(s.launched) {if(args.includes('command=')) out('claude --session-id '+a.sessionUuid);else out(process.env.TEST_CLAUDE_PID+' 999999 Thu Oct 22 01:00:00 2026 claude --session-id '+a.sessionUuid+'\\n999999 1 Thu Oct 22 01:00:00 2026 tmux');}}
else if(cmd === 'lsof') out('n'+a.clonePath+'\\n');
else if(cmd === 'buzz') {
 const pk = fs.readFileSync(a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
 if(args[0] === 'users') out([{pubkey:pk,name:a.identityName}]);
 else if(args[0] === 'channels' && args[1] === 'search') out(s.room ? (s.ambiguous ? [s.room,{...s.room,channel_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}] : [s.room]) : []);
 else if(args[0] === 'channels' && args[1] === 'create') {if(args.includes('--id') || !process.env.BUZZ_PRIVATE_KEY || process.env.BUZZ_IDENTITY !== a.identityName) process.exit(3);const intent=JSON.parse(fs.readFileSync(path.join(process.env.ACP_STATE_DIR,'buzz-room-test.json'),'utf8'));if(intent.name!==value('--name') || intent.pubkey!==pk) process.exit(4);s.creates++;s.room={channel_id:'ffffffff-ffff-4fff-8fff-ffffffffffff',name:value('--name'),channel_type:value('--type'),visibility:value('--visibility')};s.members=[{pubkey:pk,role:'owner'}];save();if(s.loseCreate) {s.loseCreate=false;save();process.exit(1);}out(s.room);}
 else if(args[0] === 'channels' && args[1] === 'add-member') {const pubkey=value('--pubkey');s.members=s.members.filter(m=>m.pubkey!==pubkey);s.members.push({pubkey,role:value('--role')});out({});}
 else if(args[0] === 'channels' && args[1] === 'members') out(s.members);
 else if(args[0] === 'messages' && args[1] === 'send') {s.posts.push({id:'e'.repeat(64),pubkey:pk,content:value('--content')});out({});}
 else if(args[0] === 'messages' && args[1] === 'get') out(s.posts);
 else process.exit(2);
} else process.exit(2);
save();
`;
  for (const cmd of ['git','gh','docker','buzz','claude','tmux','ps','lsof']) writeFileSync(join(['buzz','claude'].includes(cmd) ? resolvedBin : bin,cmd),fake,{mode:0o700});
  writeFileSync(join(home,'allocation.json'),JSON.stringify(a));
  const script = fileURLToPath(new URL('../../dist/host/host-project-provisioner.mjs',import.meta.url));
  const env = {...process.env,HOME:home,ACP_STATE_DIR:state,PATH:bin+':/usr/bin:/bin:/usr/sbin',ACP_BUZZ_BINARY:join(resolvedBin,'buzz'),ACP_CLAUDE_BINARY:join(resolvedBin,'claude'),ACP_RESOLVED_BUZZ_BINARY:join(home,'wrong-buzz'),ACP_RESOLVED_CLAUDE_BINARY:join(home,'wrong-claude'),CLAUDE_CONFIG_DIR:join(home,'.claude'),ACP_BUZZ_ADMISSION_COMMAND:JSON.stringify(['docker','exec','buzz-prod-relay-1','buzz-admin','add-member']),TEST_CLAUDE_PID:String(process.pid)};
  const invoke = async (operation:string, overrides:NodeJS.ProcessEnv = {}) => {
    const child = execFile(process.execPath,[script],{env:{...env,...overrides},timeout:30_000,maxBuffer:1_000_000});
    child.stdin!.end(JSON.stringify({version:1,operation,allocation:a,packet:{productIntent:'bytes'}}));
    const stdout = await new Promise<string>((resolve,reject) => {let data='';let err='';child.stdout!.on('data',x=>data+=String(x));child.stderr!.on('data',x=>err+=String(x));child.on('error',reject);child.on('close',code=>code===0 ? resolve(data) : reject(new Error(operation+": "+err)));});
    return JSON.parse(stdout) as Record<string,unknown>;
  };
  return {home,state,bin,resolvedBin,a,script,env,invoke};
};
it.each(['normal','lost-response-after-create','ambiguity'])('runs packaged host provisioner with %s Buzz recovery in temp HOME',async recovery => {
  const {home,state,a,script,env,invoke} = fixture();
  await invoke('ensure-checkout');
  // A dirty checkout is never ready, and is never reset: the edits stay until a person settles them.
  writeFileSync(join(a.clonePath,'dirty.txt'),'owner edits');await expect(invoke('ensure-checkout')).rejects.toThrow('uncommitted changes');expect(readFileSync(join(a.clonePath,'dirty.txt'),'utf8')).toBe('owner edits');
  rmSync(join(a.clonePath,'dirty.txt'));await invoke('ensure-checkout');
  const initial = JSON.parse(readFileSync(join(home,'fake.json'),'utf8'));initial.badOrigin=true;writeFileSync(join(home,'fake.json'),JSON.stringify(initial));await expect(invoke('ensure-checkout')).rejects.toThrow();initial.badOrigin=false;writeFileSync(join(home,'fake.json'),JSON.stringify(initial));
  let retryKey:string|undefined;let retryIntent:Record<string,unknown>|undefined;
  if(recovery === 'lost-response-after-create') {
    const saved=JSON.parse(readFileSync(join(home,'fake.json'),'utf8'));saved.loseCreate=true;writeFileSync(join(home,'fake.json'),JSON.stringify(saved));
    await expect(invoke('ensure-buzz')).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).creates).toBe(1);
    retryKey=readFileSync(a.privateKeyFile,'utf8');retryIntent=JSON.parse(readFileSync(join(state,'buzz-room-test.json'),'utf8'));
    expect(retryIntent).toMatchObject({name:'test',runId:a.runId});
  }
  const buzz=await invoke('ensure-buzz');a.roomId=(buzz.buzz as {roomId:string}).roomId;expect(a.roomId).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff');writeFileSync(join(home,'allocation.json'),JSON.stringify(a));
  if(retryKey && retryIntent) {expect(readFileSync(a.privateKeyFile,'utf8')).toBe(retryKey);expect(JSON.parse(readFileSync(join(state,'buzz-room-test.json'),'utf8'))).toMatchObject(retryIntent);}
  expect(readdirSync(state).filter(name=>name.startsWith('buzz-room-'))).toEqual(['buzz-room-test.json']);
  if(recovery === 'ambiguity') {
    const saved=JSON.parse(readFileSync(join(home,'fake.json'),'utf8'));saved.ambiguous=true;writeFileSync(join(home,'fake.json'),JSON.stringify(saved));
    await expect(invoke('ensure-buzz')).rejects.toThrow('ambiguous owned room');
    expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).creates).toBe(1);
    saved.ambiguous=false;writeFileSync(join(home,'fake.json'),JSON.stringify(saved));
  }
  await invoke('ensure-routing');
  const staleMcp = JSON.parse(readFileSync(join(home,'fake.json'),'utf8'));staleMcp.mcp=true;staleMcp.mcpUuid='cccccccc-cccc-4ccc-8ccc-cccccccccccc';writeFileSync(join(home,'fake.json'),JSON.stringify(staleMcp));
  await invoke('ensure-resident');expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).mcpRemovals).toBe(1);
  expect(statSync(a.privateKeyFile).mode & 0o777).toBe(0o600);expect(statSync(a.privateKeyFile.replace('.priv','.pub')).mode & 0o777).toBe(0o600);
  const launcher = readFileSync(join(state,'resident-test.sh'),'utf8');expect(launcher).toContain("exec '"+env.ACP_CLAUDE_BINARY+"'");for (const flag of ['--session-id','--model','opus','--remote-control','--name','--messaging-socket-path','--permission-mode','bypassPermissions','--dangerously-skip-permissions']) expect(launcher).toContain(flag);
  const rcPath = join(home,'.claude','sessions',`${process.pid}.json`);const rc = readFileSync(rcPath,'utf8');writeFileSync(rcPath,JSON.stringify({sessionId:a.sessionUuid,cwd:a.clonePath,bridgeSessionId:null}));await expect(invoke('observe')).rejects.toThrow();await expect(invoke('ensure-resident')).rejects.toThrow();writeFileSync(rcPath,rc);
  const intentPath = join(state,'buzz-room-test.json');const intent = readFileSync(intentPath,'utf8');const admitted = JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).admitted;
  const key = readFileSync(a.privateKeyFile,'utf8');const roster = readFileSync(join(home,'.hermes','bridge','required-mentions.json'),'utf8');const fleet = readFileSync(join(home,'.claude','watchers','fleet','manifest.tsv'),'utf8');
  await invoke('ensure-buzz');await invoke('ensure-routing');await invoke('ensure-resident');
  expect((await invoke('observe'))['resident']).toMatchObject({pid:process.pid,sessionUuid:a.sessionUuid,bridgeSessionId:'bridge',tmuxAncestry:true});
  expect(readFileSync(intentPath,'utf8')).toBe(intent);expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8'))).toMatchObject({admitted,admissions:1,creates:1});
  expect(readFileSync(a.privateKeyFile,'utf8')).toBe(key);expect(readFileSync(join(home,'.hermes','bridge','required-mentions.json'),'utf8')).toBe(roster);expect(readFileSync(join(home,'.claude','watchers','fleet','manifest.tsv'),'utf8')).toBe(fleet);
  const effects = JSON.parse(readFileSync(join(home,'fake.json'),'utf8')) as {creates:number;launches:number;launched:boolean;pane:boolean};expect(effects.creates).toBe(1);expect(effects.launches).toBe(1);
  effects.launched=false;effects.pane=true;writeFileSync(join(home,'fake.json'),JSON.stringify(effects));
  // The watcher recovery entry uses exactly the same resident launcher and preserves its UUID.
  const recoveryScript = fileURLToPath(new URL('../../dist/host/resident-fleet-up.mjs',import.meta.url));
  await new Promise<void>((resolve,reject) => {execFile(process.execPath,[recoveryScript],{env:{...env,ACP_HOST_PROJECT_PROVISIONER:script},timeout:30_000},error=>error ? reject(error) : resolve());});
  expect(readFileSync(join(state,'resident-test.sh'),'utf8')).toContain('--resume');
  const recovered = JSON.parse(readFileSync(join(home,'fake.json'),'utf8'));expect(recovered.launches).toBe(2);recovered.launched=false;recovered.pane=false;writeFileSync(join(home,'fake.json'),JSON.stringify(recovered));
  writeFileSync(join(a.clonePath,'dirty.txt'),'owner edits');
  expect(await invoke('retire')).toMatchObject({retired:true,retirementArchivePath:join(home,'projects','.retired','fixture-test')});
  expect(readFileSync(join(home,'projects','.retired','fixture-test','dirty.txt'),'utf8')).toBe('owner edits');
  expect(JSON.parse(readFileSync(join(home,'.hermes','bridge','required-mentions.json'),'utf8')).channels[a.roomId].status).toBe('retired');
  expect(readFileSync(join(home,'.claude','watchers','fleet','manifest.tsv'),'utf8')).not.toContain(a.fleetName);
  // Protocol refuses path escape before invoking any binary.
  const invalid = execFile(process.execPath,[script],{env:{...process.env,HOME:home,ACP_STATE_DIR:state},timeout:10_000});invalid.stdin!.end(JSON.stringify({version:1,operation:'ensure-checkout',allocation:{...a,clonePath:'/tmp/escape'}}));
  await new Promise<void>(resolve => invalid.on('close',code=>{expect(code).toBe(1);resolve();}));
});

const binaries = ['buzz','claude'] as const;
const binaryCases = binaries.flatMap(binary =>
  ['missing','empty','relative','absent-file','directory','not-executable','broken-symlink'].map(reason => ({binary,reason})),
);
it.each(binaryCases)('refuses $binary in its step for $reason without searching PATH',async ({binary,reason}) => {
  const {home,bin,resolvedBin,invoke} = fixture();
  await invoke('ensure-checkout');
  if(binary === 'claude') await invoke('ensure-buzz');
  const trap = join(home,'path-was-used');
  for(const name of binaries) writeFileSync(join(bin,name),`#!/bin/sh\ntouch '${trap}'\nexit 99\n`,{mode:0o700});
  let value:string|undefined;
  let expected:string;
  switch(reason) {
    case 'missing': value=undefined;expected='missing binary variable';break;
    case 'empty': value='';expected='missing binary variable';break;
    case 'relative': value='relative/'+binary;expected='binary path is not absolute';break;
    case 'absent-file': value=join(home,'absent');expected='binary is missing';break;
    case 'directory': value=resolvedBin;expected='binary is not an executable regular file';break;
    case 'not-executable': value=join(home,'disabled');writeFileSync(value,'SECRET-FILE');chmodSync(value,0o600);expected='binary is not executable';break;
    default: value=join(home,'broken');symlinkSync(join(home,'absent'),value);expected='binary is missing';
  }
  const operation = binary === 'buzz' ? 'ensure-buzz' : 'ensure-resident';
  // An invalid nonempty operator pin must not fall back to a valid install pin either.
  const fallback = reason === 'missing' || reason === 'empty' ? '' : join(resolvedBin,binary);
  await expect(invoke(operation,{[`ACP_${binary.toUpperCase()}_BINARY`]:value,[`ACP_RESOLVED_${binary.toUpperCase()}_BINARY`]:fallback})).rejects.toThrow(`${binary} in ${operation}: ${expected}`);
  expect(existsSync(trap)).toBe(false);
});

it.each(binaries)('uses the install-time %s pin when the primary variable is empty',async binary => {
  const {resolvedBin,invoke} = fixture();
  await invoke('ensure-checkout');
  if(binary === 'claude') await invoke('ensure-buzz');
  await invoke(binary === 'buzz' ? 'ensure-buzz' : 'ensure-resident',{
    [`ACP_${binary.toUpperCase()}_BINARY`]:'',
    [`ACP_RESOLVED_${binary.toUpperCase()}_BINARY`]:join(resolvedBin,binary),
  });
});

it('accepts a stable Claude symlink to an executable regular file',async () => {
  const {home,state,resolvedBin,invoke} = fixture();
  const link = join(home,'.local','bin','claude');mkdirSync(join(home,'.local','bin'),{recursive:true});
  symlinkSync(join(resolvedBin,'claude'),link);
  await invoke('ensure-checkout');await invoke('ensure-buzz');
  await invoke('ensure-resident',{ACP_CLAUDE_BINARY:link});
  expect(readFileSync(join(state,'resident-test.sh'),'utf8')).toContain(`exec '${link}'`);
});

it.each(binaries)('reports the %s step and non-zero exit code without subprocess output',async binary => {
  const {home,invoke} = fixture();
  await invoke('ensure-checkout');
  if(binary === 'claude') await invoke('ensure-buzz');
  writeFileSync(join(home,'fail-'+binary),'');
  const operation = binary === 'buzz' ? 'ensure-buzz' : 'ensure-resident';
  const failure = await invoke(operation).then(() => 'unexpected success',error => String(error));
  expect(failure).toBe(`Error: ${operation}: host project provisioner refused operation: ${binary} in ${operation}: non-zero exit with exit code 23\n`);
});
