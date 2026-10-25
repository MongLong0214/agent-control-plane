import { afterAll, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, statSync, symlinkSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import type { ProjectAllocation } from '../../src/runtime/host-project-provisioner.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';

afterAll(cleanupTempDirs);
const fixture = (profileReadback:Record<string,unknown> = {name:'cto-test'}) => {
  const home = realpathSync(tempDir('resident-host-home-'));const state = join(home,'acp');const bin = join(home,'bin');mkdirSync(bin);const resolvedBin = join(home,'resolved');mkdirSync(resolvedBin);
  const runtimeNode = join(state,'current','dist','bin','node');const runtimeCli = join(state,'current','dist','cli','agentctl.js');
  const generation = join(state,'generations','fixture');
  mkdirSync(join(generation,'dist','bin'),{recursive:true});mkdirSync(join(generation,'dist','cli'),{recursive:true});
  writeFileSync(join(generation,'dist','bin','node'),'#!/bin/sh\nexit 99\n',{mode:0o700});
  writeFileSync(join(generation,'dist','cli','agentctl.js'),'throw new Error("runtime must not run in tests");');
  symlinkSync(generation,join(state,'current'));
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
else if(cmd === 'claude') {if(args[0] !== 'mcp') process.exit(2);if(args[1] === 'add') {s.mcp=true;s.mcpUuid=a.sessionUuid;s.mcpCommand=args.slice(args.indexOf('--')+1);s.mcpAdds=(s.mcpAdds||[]).concat([args]);} else if(args[1] === 'remove') {s.mcp=false;s.mcpRemovals=(s.mcpRemovals||0)+1;} else if(!s.mcp) process.exit(1);else {const command=s.mcpCommand||['agentctl','attach','resident-cto','--claimed-session-id',s.mcpUuid,'--project-id','test'];out('acp-cto\\nCommand: '+command[0]+'\\nArgs: '+command.slice(1).join(' '));}}
else if(cmd === 'tmux') {
 if(args[0] === 'has-session') process.exit(s.launched || s.pane ? 0 : 1);
 if(args[0] === 'new-session') {s.launched=true;s.pane=true;s.launches++;fs.mkdirSync(path.join(root,'.claude','sessions'),{recursive:true});fs.writeFileSync(path.join(root,'.claude','sessions',process.env.TEST_CLAUDE_PID+'.json'),JSON.stringify({sessionId:a.sessionUuid,cwd:a.clonePath,bridgeSessionId:'bridge'}));}
 else if(args[0] === 'display-message') {if(args.at(-1).includes('pane_current_path')) out(a.clonePath+'\\t'+path.join(process.env.ACP_STATE_DIR,'resident-test.sh'));else {if(!s.launched) process.exit(1);out('999999');}} else if(args[0] === 'kill-session') {s.pane=false;} else process.exit(2);
}
else if(cmd === 'ps') {if(s.launched) {if(args.includes('command=')) out('claude --session-id '+a.sessionUuid);else out(process.env.TEST_CLAUDE_PID+' 999999 Thu Oct 22 01:00:00 2026 claude --session-id '+a.sessionUuid+'\\n999999 1 Thu Oct 22 01:00:00 2026 tmux');}}
else if(cmd === 'lsof') out('n'+a.clonePath+'\\n');
else if(cmd === 'buzz') {
 const pk = fs.readFileSync(a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
 if(args[0] === 'users') out([{pubkey:pk,...${JSON.stringify(profileReadback)}}]);
 else if(args[0] === 'channels' && args[1] === 'search') out(s.room ? (s.ambiguous ? [s.room,{...s.room,channel_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}] : [s.room]) : []);
 else if(args[0] === 'channels' && args[1] === 'create') {if(args.includes('--id') || !process.env.BUZZ_PRIVATE_KEY || process.env.BUZZ_IDENTITY !== a.identityName) process.exit(3);const intent=JSON.parse(fs.readFileSync(path.join(process.env.ACP_STATE_DIR,'buzz-room-test.json'),'utf8'));if(intent.name!==value('--name') || intent.pubkey!==pk) process.exit(4);s.creates++;s.room={channel_id:'ffffffff-ffff-4fff-8fff-ffffffffffff',name:value('--name'),channel_type:value('--type'),visibility:value('--visibility')};s.members=[{pubkey:pk,role:'owner'}];save();if(s.loseCreate) {s.loseCreate=false;save();process.exit(1);}out(s.room);}
 else if(args[0] === 'channels' && args[1] === 'add-member') {const pubkey=value('--pubkey');s.members=s.members.filter(m=>m.pubkey!==pubkey);s.members.push({pubkey,role:value('--role')});out({});}
 else if(args[0] === 'channels' && args[1] === 'members') out(s.members);
 else if(args[0] === 'messages' && args[1] === 'send') {
  const rosterFile=path.join(root,'.hermes','bridge','required-mentions.json');
  const roster=fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile,'utf8')) : {channels:{}};
  if(!roster.channels[value('--channel')]) {s.refusedSends=(s.refusedSends||0)+1;save();process.stderr.write('unregistered channel');process.exit(1);}
  s.posts.push({id:'e'.repeat(64),pubkey:pk,content:value('--content')});out({});
 }
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
  return {home,state,bin,resolvedBin,runtimeNode,runtimeCli,a,script,env,invoke};
};
const runtimeCommand = (f:ReturnType<typeof fixture>) => [f.runtimeNode,f.runtimeCli,'attach','resident-cto','--claimed-session-id',f.a.sessionUuid,'--project-id',f.a.projectId];

it('registers the verified room before the policy-enforced nonce send and leaves ensure-routing unchanged',async () => {
  const {home,a,invoke} = fixture();
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  expect(existsSync(rosterFile)).toBe(false);
  const result = await invoke('ensure-buzz');
  const buzz = result.buzz as {roomId:string;nonceEventId:string;nonceReadable:boolean};
  expect(buzz).toMatchObject({roomId:'ffffffff-ffff-4fff-8fff-ffffffffffff',nonceEventId:'e'.repeat(64),nonceReadable:true});
  const pk = readFileSync(a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
  const roster = readFileSync(rosterFile,'utf8');
  const before = statSync(rosterFile);
  expect(JSON.parse(roster)).toEqual({version:2,generation:1,channels:{[buzz.roomId]:{
    relay_name:'production',ceo:{pubkey:'d'.repeat(64),handle:'ceo2'},peer:{pubkey:pk,handle:a.identityName},
    acp_project_id:a.projectId,status:'active',classification:'project',
  }}});
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8'))).toMatchObject({posts:[{content:`acp-provision:${a.nonce}`,pubkey:pk}]});
  a.roomId = buzz.roomId;
  expect(await invoke('ensure-routing')).toEqual({routing:{generation:1,roomId:buzz.roomId}});
  expect(readFileSync(rosterFile,'utf8')).toBe(roster);
  expect(statSync(rosterFile)).toMatchObject({ino:before.ino,mtimeMs:before.mtimeMs});
  await invoke('ensure-buzz');
  expect(readFileSync(rosterFile,'utf8')).toBe(roster);
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).posts).toHaveLength(1);
});

it.each(['ensure-buzz','ensure-routing'])('refuses a route conflict in %s without posting a nonce or changing the roster',async operation => {
  const {home,a,invoke} = fixture();
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  const roomId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const roster = JSON.stringify({version:2,generation:7,channels:{[roomId]:{
    acp_project_id:'other',peer:{pubkey:'0'.repeat(64)},status:'active',
  }}})+'\n';
  writeFileSync(rosterFile,roster);
  // ensure-routing needs a key, while ensure-buzz must discover the actual room id itself.
  writeFileSync(a.privateKeyFile,'1'.repeat(64)+'\n');
  if(operation === 'ensure-routing') a.roomId = roomId;
  await expect(invoke(operation)).rejects.toThrow('route conflict');
  expect(readFileSync(rosterFile,'utf8')).toBe(roster);
  if(operation === 'ensure-buzz') {
    expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8'))).toMatchObject({creates:1,posts:[]});
  }
});

it('registers acp-cto through the ACP current runtime',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');await f.invoke('ensure-buzz');
  await f.invoke('ensure-resident');
  const saved = JSON.parse(readFileSync(join(f.home,'fake.json'),'utf8'));
  expect(saved.mcpAdds).toEqual([['mcp','add','--scope','local','acp-cto','--',...runtimeCommand(f)]]);
  expect(saved.mcpRemovals ?? 0).toBe(0);
});

it.each(['bare-agentctl','wrong-node','wrong-cli','wrong-role','wrong-session','wrong-project','session-suffix','project-suffix','matching-runtime'])('reconciles a pre-existing %s acp-cto entry',async entry => {
  const f = fixture();
  await f.invoke('ensure-checkout');await f.invoke('ensure-buzz');
  const command = runtimeCommand(f);
  switch(entry) {
    case 'bare-agentctl': command.splice(0,2,'agentctl');break;
    case 'wrong-node': command[0] = process.execPath;break;
    case 'wrong-cli': command[1] = join(f.state,'agentctl.js');break;
    case 'wrong-role': command[3] = 'cto';break;
    case 'wrong-session': command[5] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';break;
    case 'wrong-project': command[7] = 'other';break;
    case 'session-suffix': command[5] += '-other';break;
    case 'project-suffix': command[7] += '-other';break;
  }
  const stateFile = join(f.home,'fake.json');
  const saved = JSON.parse(readFileSync(stateFile,'utf8'));
  writeFileSync(stateFile,JSON.stringify({...saved,mcp:true,mcpCommand:command}));
  await f.invoke('ensure-resident');
  const after = JSON.parse(readFileSync(stateFile,'utf8'));
  const matching = entry === 'matching-runtime';
  expect(after.mcpRemovals ?? 0).toBe(matching ? 0 : 1);
  expect(after.mcpAdds ?? []).toEqual(matching ? [] : [['mcp','add','--scope','local','acp-cto','--',...runtimeCommand(f)]]);
});

it.each(['missing-node','missing-cli','node-directory','cli-directory','nonexecutable-node'])('refuses %s in the agentctl runtime with a path-free reason',async problem => {
  const f = fixture();
  await f.invoke('ensure-checkout');await f.invoke('ensure-buzz');
  const target = problem.includes('cli') ? f.runtimeCli : f.runtimeNode;
  if(problem === 'nonexecutable-node') chmodSync(target,0o600);
  else {rmSync(target);if(problem.endsWith('directory')) mkdirSync(target);}
  const failure = await f.invoke('ensure-resident').then(() => 'unexpected success',error => String(error));
  expect(failure).toBe('Error: ensure-resident: host project provisioner refused operation: agentctl runtime unavailable in ensure-resident\n');
  const saved = JSON.parse(readFileSync(join(f.home,'fake.json'),'utf8'));
  expect(saved.mcpAdds ?? []).toEqual([]);expect(saved.launches).toBe(0);
});

it.each([
  ['name',{name:'cto-test'}],
  ['profile.name',{profile:{name:'cto-test'}}],
  // The CLI's compact users get response contains only pubkey and display_name.
  ['display_name',{display_name:'cto-test'}],
] as const)('accepts the Buzz profile readback with %s and the expected pubkey',async (_field,profile) => {
  const {a,invoke} = fixture(profile);
  const result = await invoke('ensure-buzz');
  expect(result.buzz).toMatchObject({pubkey:readFileSync(a.privateKeyFile.replace('.priv','.pub'),'utf8').trim(),rosterVerified:true,nonceReadable:true});
});

it.each([
  ['different display_name',{display_name:'cto-other'}],
  ['different pubkey',{display_name:'cto-test',pubkey:'0'.repeat(64)}],
  ['unsupported field',{displayName:'cto-test'}],
] as const)('refuses the Buzz profile readback with %s',async (_reason,profile) => {
  const {home,state,invoke} = fixture(profile);
  await expect(invoke('ensure-buzz')).rejects.toThrow('profile readback mismatch');
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).creates).toBe(0);
  expect(existsSync(join(state,'buzz-room-test.json'))).toBe(false);
});

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
