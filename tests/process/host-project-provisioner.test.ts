import { afterAll, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, statSync, symlinkSync, chmodSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { getPublicKey } from 'nostr-tools';
import type { ProjectAllocation } from '../../src/runtime/host-project-provisioner.ts';
import { ExecFileHostProjectProvisioner, HostRetirementRefusal, hostObservationSchema } from '../../src/runtime/host-project-provisioner.ts';
import { readProcessStartToken } from '../../src/core/process-argv.ts';
import { makeHarness } from '../helpers/harness.ts';
import { retireProject } from '../../src/registry/project-retirement.ts';
import { CanonicalSessionRegistry } from '../../src/registry/canonical-session-registry.ts';
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from '../../src/registry/canonical-self-claim.ts';
import { ExecutionMode, Role, RunKind, SessionLifecycle } from '../../src/domain/types.ts';
import { digestOf, sha256 } from '../../src/core/digest.ts';
import Database from 'better-sqlite3';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';

// Only the tables and columns currentCanonicalCeoBuzzRoute reads, with one current canonical CEO.
const writeCeoDatabase = (path:string, recipient:string) => {
  const db = new Database(path);
  db.exec(`CREATE TABLE assignments(assignment_id,binding_generation,actor_id,role_key,role,status);
    CREATE TABLE conversational_actors(actor_id,current_session_id,current_session_incarnation);
    CREATE TABLE sessions(session_id,incarnation,buzz_address,buzz_actor_id,lifecycle);
    CREATE TABLE actor_target_bindings(target_binding_id,target_actor_id,executor_kind);
    CREATE TABLE actor_target_attestations(target_binding_id,assignment_id,binding_generation,executor_session_id,executor_session_incarnation,target_bind_receipt_json,target_bind_executor_runtime_identity);
    INSERT INTO assignments VALUES('asg_ceo',1,'act_ceo','CEO','CEO','ACTIVE');
    INSERT INTO conversational_actors VALUES('act_ceo','ses_ceo','inc_ceo');
    INSERT INTO actor_target_bindings VALUES('tb_ceo','act_ceo','hermes');
    INSERT INTO actor_target_attestations VALUES('tb_ceo','asg_ceo',1,'ses_ceo','inc_ceo','{}','runtime');`);
  db.prepare(`INSERT INTO sessions VALUES('ses_ceo','inc_ceo','ffffffff-ffff-4fff-8fff-ffffffffffff',?,'READY')`).run(recipient);
  db.close();
};
const setCeoRecipient = (path:string, recipient:string|null) => {
  const db = new Database(path);
  if (recipient === null) db.exec(`DELETE FROM sessions`); else db.prepare(`UPDATE sessions SET buzz_actor_id = ?`).run(recipient);
  db.close();
};

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
  writeFileSync(join(home,'.hermes','bridge','keys','owner.pub'),'c'.repeat(64));
  const database = join(home,'state.sqlite');writeCeoDatabase(database,'d'.repeat(64));
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
else if(cmd === 'ps') {if(args[0] === '-p') out(s.pinCommand || '');else if(args[0] === '-o' && args[1] === 'lstart=') out(s.lstart || '');else if(s.launched) {if(args.includes('command=')) out('claude --session-id '+a.sessionUuid);else out(process.env.TEST_CLAUDE_PID+' 999999 Thu Oct 22 01:00:00 2026 claude --session-id '+a.sessionUuid+'\\n999999 1 Thu Oct 22 01:00:00 2026 tmux');}}
else if(cmd === 'lsof') out('n'+(s.cwd || a.clonePath)+'\\n');
else if(cmd === 'buzz') {
 // Buzz knows its caller by the key it signs with, which need not be the one at the identity's path.
 const key = process.env.BUZZ_PRIVATE_KEY || '', ecdh = require('node:crypto').createECDH('secp256k1');
 const pk = /^[0-9a-f]{64}$/.test(key) ? (ecdh.setPrivateKey(Buffer.from(key,'hex')),ecdh.getPublicKey(null,'compressed').subarray(1).toString('hex')) : fs.readFileSync(a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
 const archived = s.archivedRooms || [];
 // With keepRooms a second create leaves the earlier room active with its own members (s.otherRooms).
 const others = s.otherRooms || [], other = others.find(o => o.room.channel_id === value('--channel'));
 if(args[0] === 'users') out([{pubkey:pk,...${JSON.stringify(profileReadback)}}]);
 else if(args[0] === 'channels' && args[1] === 'search') out([...(s.room ? (s.ambiguous ? [s.room,{...s.room,channel_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}] : [s.room]) : []),...others.map(o => o.room),...(args.includes('--include-archived') ? archived : [])]);
 else if(args[0] === 'channels' && args[1] === 'get') {const room=[s.room,...archived,...others.map(o => o.room)].find(r => r && r.channel_id === value('--channel'));if(!room) process.exit(5);out({channel_id:room.channel_id,name:room.name,description:null,created_at:0,pubkey:pk});}
 else if(args[0] === 'channels' && args[1] === 'archive') {if(!process.env.BUZZ_PRIVATE_KEY || process.env.BUZZ_IDENTITY !== a.identityName || !s.room || s.room.channel_id !== value('--channel') || !s.members.some(m => m.pubkey === pk && m.role === 'owner')) process.exit(6);s.archivedRooms=[...archived,{...s.room,archived:true}];s.room=null;s.members=[];out({event_id:'a'.repeat(64),accepted:true,message:''});}
 else if(args[0] === 'channels' && args[1] === 'create') {if(args.includes('--id') || !process.env.BUZZ_PRIVATE_KEY || process.env.BUZZ_IDENTITY !== a.identityName) process.exit(3);const intent=JSON.parse(fs.readFileSync(path.join(process.env.ACP_STATE_DIR,'buzz-room-test.json'),'utf8'));if(intent.name!==value('--name') || intent.pubkey!==pk) process.exit(4);if(s.refuseCreate) {s.refuseCreate=false;save();process.exit(1);}if(s.keepRooms && s.room) s.otherRooms=[...others,{room:s.room,members:s.members}];s.creates++;s.room={channel_id:s.creates === 1 ? 'ffffffff-ffff-4fff-8fff-ffffffffffff' : '99999999-9999-4999-8999-999999999999',name:value('--name'),channel_type:value('--type'),visibility:value('--visibility')};s.members=[{pubkey:pk,role:'owner'}];save();if(s.loseCreate) {s.loseCreate=false;save();process.exit(1);}out(s.room);}
 else if(args[0] === 'channels' && args[1] === 'add-member') {const pubkey=value('--pubkey');s.members=s.members.filter(m=>m.pubkey!==pubkey);s.members.push({pubkey,role:value('--role')});out({});}
 else if(args[0] === 'channels' && args[1] === 'members') out(other ? other.members : s.members);
 else if(args[0] === 'messages' && args[1] === 'send') {
  const rosterFile=path.join(root,'.hermes','bridge','required-mentions.json');
  const roster=fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile,'utf8')) : {channels:{}};
  if(!roster.channels[value('--channel')]) {s.refusedSends=(s.refusedSends||0)+1;save();process.stderr.write('unregistered channel');process.exit(1);}
  const content=value('--content');s.posts.push({id:'e'.repeat(64),pubkey:pk,content:/(^|\\s)@ceo(\\s|$)/.test(content) ? content : '@ceo '+content});out({});
 }
 else if(args[0] === 'messages' && args[1] === 'get') out(s.posts);
 else process.exit(2);
} else process.exit(2);
save();
`;
  for (const cmd of ['git','gh','docker','buzz','claude','tmux','ps','lsof']) writeFileSync(join(['buzz','claude'].includes(cmd) ? resolvedBin : bin,cmd),fake,{mode:0o700});
  writeFileSync(join(home,'allocation.json'),JSON.stringify(a));
  const script = fileURLToPath(new URL('../../dist/host/host-project-provisioner.mjs',import.meta.url));
  const env = {...process.env,HOME:home,ACP_STATE_DIR:state,ACP_HOST_DATABASE_PATH:database,PATH:bin+':/usr/bin:/bin:/usr/sbin',ACP_BUZZ_BINARY:join(resolvedBin,'buzz'),ACP_CLAUDE_BINARY:join(resolvedBin,'claude'),ACP_RESOLVED_BUZZ_BINARY:join(home,'wrong-buzz'),ACP_RESOLVED_CLAUDE_BINARY:join(home,'wrong-claude'),CLAUDE_CONFIG_DIR:join(home,'.claude'),ACP_BUZZ_ADMISSION_COMMAND:JSON.stringify(['docker','exec','buzz-prod-relay-1','buzz-admin','add-member']),TEST_CLAUDE_PID:String(process.pid)};
  const invoke = async (operation:string, overrides:NodeJS.ProcessEnv = {}) => {
    const child = execFile(process.execPath,[script],{env:{...env,...overrides},timeout:30_000,maxBuffer:1_000_000});
    child.stdin!.end(JSON.stringify({version:1,operation,allocation:a,packet:{productIntent:'bytes'}}));
    const stdout = await new Promise<string>((resolve,reject) => {let data='';let err='';child.stdout!.on('data',x=>data+=String(x));child.stderr!.on('data',x=>err+=String(x));child.on('error',reject);child.on('close',code=>code===0 ? resolve(data) : reject(new Error(operation+": "+err)));});
    return JSON.parse(stdout) as Record<string,unknown>;
  };
  return {home,state,bin,resolvedBin,runtimeNode,runtimeCli,a,database,script,env,invoke};
};
const runtimeCommand = (f:ReturnType<typeof fixture>) => [f.runtimeNode,f.runtimeCli,'attach','resident-cto','--claimed-session-id',f.a.sessionUuid,'--project-id',f.a.projectId];

const liveV1Roster = (version:1|undefined) => ({
  ...(version === undefined ? {} : {version}),
  relay:'wss://relay.invalid',
  channels:Object.fromEntries(['a','b','c'].map((key,index) => [`${key.repeat(8)}-${key.repeat(4)}-4${key.repeat(3)}-8${key.repeat(3)}-${key.repeat(12)}`,{
    relay_name:'production',ceo:{pubkey:'d'.repeat(64),handle:'ceo2'},
    peer:{pubkey:String(index+1).repeat(64),handle:`cto-existing-${index}`},
    classification:'current project',acp_project_id:`existing-${index}`,extra:{preserved:true},
  }])),
  known_profiles:{ceo2:'d'.repeat(64),owner:'c'.repeat(64)},
});

it.each([1,undefined] as const)('registers the live v1 roster (version %s) before the nonce and preserves it on retries',async version => {
  const {home,a,invoke} = fixture();
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  const original = liveV1Roster(version);
  writeFileSync(rosterFile,JSON.stringify(original,null,2)+'\n');
  const result = await invoke('ensure-buzz');
  const roomId = (result.buzz as {roomId:string}).roomId;
  const pk = readFileSync(a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
  const bytes = readFileSync(rosterFile,'utf8');
  const before = statSync(rosterFile);
  expect(JSON.parse(bytes)).toEqual({...original,channels:{...original.channels,[roomId]:{
    relay_name:'production',ceo:{pubkey:'d'.repeat(64),handle:'ceo'},peer:{pubkey:pk,handle:a.identityName},
    acp_project_id:a.projectId,classification:'current project',status:'active',
  }}});
  expect(JSON.parse(bytes)).not.toHaveProperty('generation');
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).posts).toHaveLength(1);
  await invoke('ensure-buzz');
  a.roomId = roomId;
  expect(hostObservationSchema.parse(await invoke('ensure-routing'))).toEqual({routing:{roomId}});
  expect(readFileSync(rosterFile,'utf8')).toBe(bytes);
  expect(statSync(rosterFile)).toMatchObject({ino:before.ino,mtimeMs:before.mtimeMs});
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).posts).toHaveLength(1);
});

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
    relay_name:'production',ceo:{pubkey:'d'.repeat(64),handle:'ceo'},peer:{pubkey:pk,handle:a.identityName},
    acp_project_id:a.projectId,status:'active',classification:'project',
  }}});
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8'))).toMatchObject({posts:[{content:`@ceo acp-provision:${a.nonce}`,pubkey:pk}]});
  a.roomId = buzz.roomId;
  expect(await invoke('ensure-routing')).toEqual({routing:{generation:1,roomId:buzz.roomId}});
  expect(readFileSync(rosterFile,'utf8')).toBe(roster);
  expect(statSync(rosterFile)).toMatchObject({ino:before.ino,mtimeMs:before.mtimeMs});
  await invoke('ensure-buzz');
  expect(readFileSync(rosterFile,'utf8')).toBe(roster);
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).posts).toHaveLength(1);
});

it.each([1,2].flatMap(version => ['ensure-buzz','ensure-routing'].flatMap(operation => ['project','peer','retired'].map(conflict => ({version,operation,conflict})))))(
  'refuses a v$version $conflict route conflict in $operation without posting a nonce or changing the roster',async ({version,operation,conflict}) => {
  const {home,a,invoke} = fixture();
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  const roomId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  writeFileSync(a.privateKeyFile,'1'.repeat(64)+'\n');
  const pk = getPublicKey(Buffer.from('1'.repeat(64),'hex'));
  const roster = JSON.stringify({version,...(version === 2 ? {generation:7} : {}),channels:{[roomId]:{
    acp_project_id:conflict === 'project' ? 'other' : a.projectId,peer:{pubkey:conflict === 'peer' ? '0'.repeat(64) : pk},status:conflict === 'retired' ? 'retired' : 'active',
  }}})+'\n';
  writeFileSync(rosterFile,roster);
  const before = statSync(rosterFile);
  // ensure-routing needs a key, while ensure-buzz must discover the actual room id itself.
  if(operation === 'ensure-routing') a.roomId = roomId;
  await expect(invoke(operation)).rejects.toThrow('route conflict');
  expect(readFileSync(rosterFile,'utf8')).toBe(roster);
  expect(statSync(rosterFile)).toMatchObject({ino:before.ino,mtimeMs:before.mtimeMs});
  if(operation === 'ensure-buzz') {
    expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8'))).toMatchObject({creates:1,posts:[]});
  }
});

it.each([1,2].flatMap(version => ['ceo-key','peer-key','array-key','same-key','invalid-handle','empty-handle','newline-handle','newline-key','room-uuid','newline-uuid','status',
  ...(version === 1 ? ['known-profile-handle','known-profile-key','known-profiles-type','known-profiles-null'] : []),
  ...(version === 2 ? ['ceo-handle','missing-status','missing-relay_name','missing-acp_project_id','missing-classification'] : []),
].map(problem => ({version,problem}))))('refuses a v$version roster with invalid $problem without writing',async ({version,problem}) => {
  const {home,a,invoke} = fixture();
  writeFileSync(a.privateKeyFile,'1'.repeat(64)+'\n');
  const room:Record<string,unknown> = {
    ceo:{pubkey:'d'.repeat(64),handle:'ceo'},peer:{pubkey:'c'.repeat(64),handle:'cto-existing'},
    status:'active',relay_name:'production',acp_project_id:'existing',classification:'current project',
  };
  if(problem === 'ceo-key') room.ceo = {pubkey:'z'.repeat(64),handle:'ceo'};
  if(problem === 'peer-key') room.peer = {pubkey:'c'.repeat(63),handle:'cto-existing'};
  if(problem === 'array-key') room.peer = {pubkey:['c'.repeat(64)],handle:'cto-existing'};
  if(problem === 'same-key') room.peer = {pubkey:'d'.repeat(64),handle:'cto-existing'};
  if(problem === 'invalid-handle') room.peer = {pubkey:'c'.repeat(64),handle:'cto existing'};
  if(problem === 'newline-handle') room.peer = {pubkey:'c'.repeat(64),handle:'cto-existing\n'};
  if(problem === 'newline-key') room.peer = {pubkey:'c'.repeat(64)+'\n',handle:'cto-existing'};
  if(problem === 'empty-handle') room.peer = {pubkey:'c'.repeat(64),handle:''};
  if(problem === 'ceo-handle') room.ceo = {pubkey:'d'.repeat(64),handle:'ceo2'};
  if(problem === 'status') room.status = 'unknown';
  if(problem.startsWith('missing-')) delete room[problem.slice('missing-'.length)];
  const roomId = problem === 'room-uuid' ? '-'.repeat(36) : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'+(problem === 'newline-uuid' ? '\n' : '');
  const knownProfiles = problem === 'known-profile-handle' ? {'bad handle':'c'.repeat(64)} :
    problem === 'known-profile-key' ? {owner:'invalid'} : problem === 'known-profiles-type' ? [] : problem === 'known-profiles-null' ? null : {owner:'c'.repeat(64)};
  const bytes = JSON.stringify({version,...(version === 2 ? {generation:7} : {}),channels:{[roomId]:room},known_profiles:knownProfiles})+'\n';
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  writeFileSync(rosterFile,bytes);
  const before = statSync(rosterFile);
  await expect(invoke('ensure-routing')).rejects.toThrow('invalid roster');
  expect(readFileSync(rosterFile,'utf8')).toBe(bytes);
  expect(statSync(rosterFile)).toMatchObject({ino:before.ino,mtimeMs:before.mtimeMs});
});

it.each([['no-ceo-binding','current canonical CEO binding unavailable'],['ceo-key','current canonical CEO binding unavailable'],
  ['same-key','invalid roster'],['room-uuid','invalid roster']])('validates the proposed route with %s before writing',async (problem,refusal) => {
  const {home,a,database,invoke} = fixture();
  writeFileSync(a.privateKeyFile,'1'.repeat(64)+'\n');
  if(problem === 'no-ceo-binding') setCeoRecipient(database,null);
  if(problem === 'ceo-key') setCeoRecipient(database,'invalid');
  if(problem === 'same-key') setCeoRecipient(database,getPublicKey(Buffer.from('1'.repeat(64),'hex')));
  if(problem === 'room-uuid') a.roomId = '-'.repeat(36);
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  await expect(invoke('ensure-routing')).rejects.toThrow(refusal);
  expect(existsSync(rosterFile)).toBe(false);
});

it('takes the room CEO from the current canonical CEO binding, for both the room roster and the route',async () => {
  const {home,database,invoke} = fixture();
  const ceo = 'f'.repeat(64);setCeoRecipient(database,ceo);
  const result = await invoke('ensure-buzz');
  const roomId = (result.buzz as {roomId:string}).roomId;
  expect(JSON.parse(readFileSync(join(home,'fake.json'),'utf8')).members).toContainEqual({pubkey:ceo,role:'admin'});
  expect(JSON.parse(readFileSync(join(home,'.hermes','bridge','required-mentions.json'),'utf8')).channels[roomId].ceo).toEqual({pubkey:ceo,handle:'ceo'});
});

it('bumps an existing v2 generation once while preserving other rooms and ignoring known_profiles',async () => {
  const {home,a,invoke} = fixture();
  writeFileSync(a.privateKeyFile,'1'.repeat(64)+'\n');
  const existing = {ceo:{pubkey:'d'.repeat(64),handle:'ceo'},peer:{pubkey:'c'.repeat(64),handle:'cto-existing'},
    status:'retired',relay_name:'production',acp_project_id:'existing',classification:'project'};
  const original = {version:2,generation:7,channels:{'cccccccc-cccc-4ccc-8ccc-cccccccccccc':existing},known_profiles:{ignored:true}};
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  writeFileSync(rosterFile,JSON.stringify(original));
  expect(await invoke('ensure-routing')).toEqual({routing:{generation:8,roomId:a.roomId}});
  const bytes = readFileSync(rosterFile,'utf8');
  expect(JSON.parse(bytes)).toMatchObject({...original,generation:8});
  expect(Object.keys(JSON.parse(bytes).channels)).toHaveLength(2);
  expect(await invoke('ensure-routing')).toEqual({routing:{generation:8,roomId:a.roomId}});
  expect(readFileSync(rosterFile,'utf8')).toBe(bytes);
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

it("the launcher's PATH line appends $HOME/.local/bin without shadowing the daemon's own earlier entries",async () => {
  const {home,state,bin,env,invoke} = fixture();
  await invoke('ensure-checkout');await invoke('ensure-buzz');await invoke('ensure-resident');
  const launcher = readFileSync(join(state,'resident-test.sh'),'utf8');
  const pathLine = launcher.split('\n').find(line => line.startsWith('export PATH='));
  expect(pathLine).toBeDefined();
  const localBin = join(home,'.local','bin');mkdirSync(localBin,{recursive:true});
  // (1) A tool that exists only under $HOME/.local/bin must still resolve: the daemon PATH
  // (like this fixture's own PATH) never includes it, so only the launcher's export line can add it.
  writeFileSync(join(localBin,'probe-tool'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  // (2) $HOME/.local/bin also carries node/npm/npx/buzz/claude. `bin` sits earlier on the inherited
  // PATH than anything the export line adds (standing in for the daemon's own runtime bin dir), so
  // a bare `node` must still resolve to `bin`'s copy, never to $HOME/.local/bin's — append, not prepend.
  writeFileSync(join(bin,'node'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  writeFileSync(join(localBin,'node'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const resolve = (tool:string) => new Promise<string>((res,rej) => {
    execFile('/bin/sh',['-c',`${pathLine}; command -v ${tool}`],{env,timeout:10_000},(error,stdout) => error ? rej(error) : res(stdout.trim()));
  });
  expect(await resolve('probe-tool')).toBe(join(localBin,'probe-tool'));
  expect(await resolve('node')).toBe(join(bin,'node'));
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

const saveAllocation = (f:ReturnType<typeof fixture>) => writeFileSync(join(f.home,'allocation.json'),JSON.stringify(f.a));
const saveArchivedRoomReceipt = (f:ReturnType<typeof fixture>) => writeFileSync(
  join(f.state,`retired-buzz-room-${f.a.projectId}.json`),
  JSON.stringify({version:1,projectId:f.a.projectId,roomId:f.a.roomId,archived:true})+'\n',
);
const fakeState = (f:ReturnType<typeof fixture>) => JSON.parse(readFileSync(join(f.home,'fake.json'),'utf8')) as Record<string,unknown>;
const patchFake = (f:ReturnType<typeof fixture>, patch:Record<string,unknown>) => writeFileSync(join(f.home,'fake.json'),JSON.stringify({...fakeState(f),...patch}));
/** A process this test starts and owns, standing in for a CTO incarnation; only its exact PID is ever signalled. */
const standInCto = async (args:string[] = []) => {
  const child:ChildProcess = spawn(process.execPath,['-e','setInterval(() => {}, 1000)','--',...args],{stdio:'ignore'});
  const exit = new Promise<NodeJS.Signals|null>(resolve => child.once('exit',(_code,signal) => resolve(signal)));
  let startedAt:string|null = null;
  for (let i = 0;i < 100 && startedAt === null;i++) {startedAt = readProcessStartToken(child.pid!);if (startedAt === null) await new Promise(r => setTimeout(r,20));}
  if (startedAt === null) throw new Error('stand-in CTO did not start');
  return {pid:child.pid!,startedAt,exit,stop:() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}};
};
const sessionRecord = (f:ReturnType<typeof fixture>, pid:number, record:Record<string,unknown>) => {
  mkdirSync(join(f.home,'.claude','sessions'),{recursive:true});
  writeFileSync(join(f.home,'.claude','sessions',`${pid}.json`),JSON.stringify(record));
};

it('#1229: retires the recorded CTO incarnation, identified by its session row pid and start token, while its cwd is outside the clone',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  saveArchivedRoomReceipt(f);
  const cto = await standInCto();
  try {
    // The CTO session runs from the home directory, not the clone; its argv and Claude's session record name the session.
    sessionRecord(f,cto.pid,{sessionId:f.a.sessionUuid,cwd:f.home});
    patchFake(f,{pinCommand:`claude --resume ${f.a.sessionUuid}`,cwd:f.home});
    f.a.retirementPin = {pid:cto.pid,startedAt:cto.startedAt};saveAllocation(f);
    expect(await f.invoke('retire')).toMatchObject({retired:true,retirementArchivePath:join(f.home,'projects','.retired','fixture-test')});
    expect(await cto.exit).toBe('SIGTERM');
  } finally {cto.stop();}
});

it('#1229: refuses with the required order, before any host change, when the recorded incarnation no longer names its session',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  const buzz = await f.invoke('ensure-buzz');f.a.roomId = (buzz.buzz as {roomId:string}).roomId;saveAllocation(f);
  await f.invoke('ensure-routing');
  const fleetDir = join(f.home,'.claude','watchers','fleet');mkdirSync(fleetDir,{recursive:true});
  writeFileSync(join(fleetDir,'manifest.tsv'),[f.a.fleetName,f.a.clonePath,'test CTO',f.a.bootPacket,f.a.sessionUuid].join('\t')+'\n');
  writeFileSync(join(fleetDir,`${f.a.fleetName}.resident.json`),'{}');
  // Its argv names no session and Claude's own record now names another one: it cannot be verified, so it is not stopped.
  const cto = await standInCto();
  try {
    sessionRecord(f,cto.pid,{sessionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',cwd:f.a.clonePath});
    f.a.retirementPin = {pid:cto.pid,startedAt:cto.startedAt};saveAllocation(f);
    const snapshot = () => [join(f.home,'.hermes','bridge','required-mentions.json'),join(fleetDir,'manifest.tsv'),join(fleetDir,`${f.a.fleetName}.resident.json`),f.a.privateKeyFile,join(f.state,'buzz-room-test.json')]
      .map(file => existsSync(file) ? readFileSync(file,'utf8') : null).concat([String(existsSync(f.a.clonePath))]);
    const before = snapshot();
    // The daemon's own protocol class against the packaged script: real ps reads the stand-in's argv.
    const refused = await new ExecFileHostProjectProvisioner(f.script,f.home,f.state,30_000,f.database).invoke('retire',f.a).then(() => null,(error:unknown) => error);
    expect(refused).toBeInstanceOf(HostRetirementRefusal);
    expect((refused as HostRetirementRefusal).requiredOrder).toEqual([
      `end the CTO session ${f.a.sessionUuid} (pid ${cto.pid}) yourself: exit it in its own terminal`,
      `run agentctl project retire ${f.a.projectId} again`,
    ]);
    expect(snapshot()).toEqual(before);
    expect(readProcessStartToken(cto.pid)).toBe(cto.startedAt);
  } finally {cto.stop();}
});

it('#1230: retire archives the room and moves the key and room intent aside; a same-named provisioning mints a new key and leaves one active room',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  const first = await f.invoke('ensure-buzz');const oldRoom = (first.buzz as {roomId:string}).roomId;
  f.a.roomId = oldRoom;saveAllocation(f);await f.invoke('ensure-routing');
  const oldKey = readFileSync(f.a.privateKeyFile,'utf8');const oldIntent = readFileSync(join(f.state,'buzz-room-test.json'),'utf8');
  const retired = await f.invoke('retire');
  expect(retired).toMatchObject({retired:true,buzzRoom:'archived'});
  expect(JSON.parse(readFileSync(join(f.state,'retired-buzz-room-test.json'),'utf8'))).toEqual({
    version:1,projectId:'test',roomId:oldRoom,archived:true,
  });
  const archive = retired['identityArchivePath'] as string;
  expect(archive.startsWith(join(f.state,'retired-buzz-identities','cto-test.'))).toBe(true);
  expect(statSync(archive).mode & 0o777).toBe(0o700);expect(statSync(join(f.state,'retired-buzz-identities')).mode & 0o777).toBe(0o700);
  expect(readdirSync(archive).sort()).toEqual(['buzz-key-test.json','buzz-room-test.json','cto-test.priv','cto-test.pub']);
  expect(readFileSync(join(archive,'cto-test.priv'),'utf8')).toBe(oldKey);
  expect(readFileSync(join(archive,'buzz-room-test.json'),'utf8')).toBe(oldIntent);
  expect(existsSync(f.a.privateKeyFile)).toBe(false);expect(existsSync(join(f.state,'buzz-room-test.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.home,'.hermes','bridge','required-mentions.json'),'utf8')).channels[oldRoom].status).toBe('retired');
  // A new project provisioned under the same identity name: a new run, session and nonce.
  Object.assign(f.a,{runId:'run_next',sessionUuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',nonce:'next-nonce',roomId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});saveAllocation(f);
  const next = await f.invoke('ensure-buzz');
  const newKey = readFileSync(f.a.privateKeyFile,'utf8');
  expect(newKey).not.toBe(oldKey);
  expect(next.buzz).toMatchObject({pubkey:getPublicKey(Buffer.from(newKey.trim(),'hex')),roomId:'99999999-9999-4999-8999-999999999999'});
  const fake = fakeState(f) as {room:{channel_id:string}|null;archivedRooms:Array<{channel_id:string;archived:boolean}>;creates:number};
  expect(fake.room?.channel_id).toBe('99999999-9999-4999-8999-999999999999');
  expect(fake.archivedRooms).toEqual([expect.objectContaining({channel_id:oldRoom,archived:true})]);
  expect(fake.creates).toBe(2);
});

it.each(['hand-made','bound'] as const)('#1230: ensure-buzz uses an existing key only when this run minted it or the roster binds it (%s)',async kind => {
  const f = fixture();
  const handMade = '1'.repeat(64);const pk = getPublicKey(Buffer.from(handMade,'hex'));
  writeFileSync(f.a.privateKeyFile,handMade+'\n');writeFileSync(f.a.privateKeyFile.replace('.priv','.pub'),pk+'\n');
  if (kind === 'hand-made') {
    // Left by a hand-made setup under this identity name, with its own room intent from another run.
    mkdirSync(f.state,{recursive:true});writeFileSync(join(f.state,'buzz-room-test.json'),JSON.stringify({name:'test',pubkey:pk,runId:'run_old',roomId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}));
  } else {
    writeFileSync(join(f.home,'.hermes','bridge','required-mentions.json'),JSON.stringify({version:2,generation:3,channels:{'ffffffff-ffff-4fff-8fff-ffffffffffff':{
      relay_name:'production',ceo:{pubkey:'d'.repeat(64),handle:'ceo'},peer:{pubkey:pk,handle:'cto-test'},acp_project_id:'test',status:'active',classification:'project'}}}));
  }
  const result = await f.invoke('ensure-buzz');
  const key = readFileSync(f.a.privateKeyFile,'utf8').trim();
  const archives = existsSync(join(f.state,'retired-buzz-identities')) ? readdirSync(join(f.state,'retired-buzz-identities')) : [];
  if (kind === 'bound') {
    expect(key).toBe(handMade);expect(archives).toEqual([]);
    expect(result.buzz).toMatchObject({pubkey:pk});
  } else {
    expect(key).not.toBe(handMade);expect(archives).toHaveLength(1);
    const archive = join(f.state,'retired-buzz-identities',archives[0]!);
    expect(statSync(archive).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(archive,'cto-test.priv'),'utf8')).toBe(handMade+'\n');
    expect(JSON.parse(readFileSync(join(archive,'buzz-room-test.json'),'utf8'))).toMatchObject({runId:'run_old'});
    expect(result.buzz).toMatchObject({pubkey:getPublicKey(Buffer.from(key,'hex'))});
    expect(JSON.parse(readFileSync(join(f.state,'buzz-key-test.json'),'utf8'))).toEqual({runId:f.a.runId,pubkey:getPublicKey(Buffer.from(key,'hex'))});
  }
});

it('#1229 C-1: a session row holding ps lstart text still pins the CTO; it is stopped, never skipped as exited',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  saveArchivedRoomReceipt(f);
  const cto = await standInCto();
  try {
    // Its argv names no session; Claude's own record does. The row's start is in setPid's lstart form, not the native token.
    sessionRecord(f,cto.pid,{sessionId:f.a.sessionUuid,cwd:f.home});
    const lstart = 'Mon Oct 26 01:00:00 2026';
    patchFake(f,{pinCommand:'claude',lstart});
    f.a.retirementPin = {pid:cto.pid,startedAt:lstart};saveAllocation(f);
    expect(await f.invoke('retire')).toMatchObject({retired:true,buzzRoom:'archived'});
    expect(await Promise.race([cto.exit,new Promise(resolve => setTimeout(() => resolve('still running'),5_000))])).toBe('SIGTERM');
  } finally {cto.stop();}
});

/**
 * A legacy project retired through the daemon's own path and the packaged host script: its PRIMARY_CTO bound and pinned
 * to a stand-in process, its entitlement granted, its roster route, fleet entry and files under a temporary home.
 */
const legacyRetirement = async (options:{key:boolean;clone:boolean;roster:boolean}) => {
  const home = realpathSync(tempDir('retire-verify-home-'));
  const script = fileURLToPath(new URL('../../dist/host/host-project-provisioner.mjs',import.meta.url));
  const h = makeHarness({residentProvisioner:{home,script}});
  const cto = await standInCto();
  const entry = {sessionUuid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectId:'resident',buzzActorId:'a'.repeat(64),buzzAddress:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  h.cp.projects.register({projectId:entry.projectId,name:entry.projectId});
  const session = h.cp.sessions.create({provider:'claude',model:'claude-cli',buzzAddress:entry.buzzAddress});
  expect(h.cp.sessions.transition(session.sessionId,SessionLifecycle.READY,'fixture').allowed).toBe(true);
  expect(h.cp.sessions.bindBuzzActor({sessionId:session.sessionId,sessionSecret:session.sessionSecret!,buzzActorId:entry.buzzActorId},{isAllowedActor:() => true}).allowed).toBe(true);
  const claimed = {executorKind:SELF_CLAIM_EXECUTOR_KIND,targetLocator:entry.sessionUuid,targetLocatorDigest:sha256(entry.sessionUuid)};
  const bound = h.cp.bindings.bind({role:Role.PRIMARY_CTO,projectId:entry.projectId,sessionId:session.sessionId,
    authenticatedTarget:{claimed,protocolVersion:SELF_CLAIM_PROTOCOL,attestationDigest:digestOf({fixture:entry}),verify:() => claimed}});
  if (!bound.allowed) throw new Error(bound.message);
  h.cp.db.run(`UPDATE sessions SET os_pid = ?, os_process_started_at = ? WHERE session_id = ?`,[cto.pid,cto.startedAt,session.sessionId]);
  new CanonicalSessionRegistry(h.cp.db).grant(entry,null);
  const clone = join(home,'projects','fixture');
  if (options.clone) {mkdirSync(clone,{recursive:true});writeFileSync(join(clone,'work.txt'),'unfinished');}
  h.cp.db.run(`INSERT INTO repositories(repository_id,identity,checkout_path,project_id,created_at) VALUES ('resident-repo','github:acme/fixture',?,'resident',?)`,[clone,h.clock.nowIso()]);
  const sessionRecord = (sessionId:string) => {
    mkdirSync(join(home,'.claude','sessions'),{recursive:true});
    writeFileSync(join(home,'.claude','sessions',`${cto.pid}.json`),JSON.stringify({sessionId,cwd:clone}));
  };
  const fleetDir = join(home,'.claude','watchers','fleet');mkdirSync(fleetDir,{recursive:true});
  const keys = join(home,'.hermes','bridge','keys');mkdirSync(keys,{recursive:true});
  const files = {
    roster:join(home,'.hermes','bridge','required-mentions.json'),fleet:join(fleetDir,'manifest.tsv'),resident:join(fleetDir,'acp-resident.resident.json'),
    key:join(keys,'cto-resident.priv'),intent:join(h.root,'buzz-room-resident.json'),work:join(clone,'work.txt'),
  };
  if (options.roster) writeFileSync(files.roster,JSON.stringify({version:2,generation:4,channels:{[entry.buzzAddress]:{relay_name:'production',ceo:{pubkey:'d'.repeat(64),handle:'ceo'},peer:{pubkey:entry.buzzActorId,handle:'cto-resident'},acp_project_id:'resident',status:'active',classification:'project'}}}));
  writeFileSync(files.fleet,['acp-resident',clone,'resident CTO',join(fleetDir,'acp-resident.boot.txt'),entry.sessionUuid].join('\t')+'\n');
  writeFileSync(files.resident,'{}');
  if (options.key) {writeFileSync(files.key,'not a real key\n');writeFileSync(files.intent,'{}');}
  const tables = (except:string[] = []) => h.cp.db.all<{name:string}>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .filter(({name}) => !except.includes(name)).map(({name}) => [name,h.cp.db.all(`SELECT * FROM "${name.replaceAll('"','""')}"`)]);
  const host = () => ({...Object.fromEntries(Object.entries(files).map(([name,file]) => [name,existsSync(file) ? readFileSync(file,'utf8') : null])),retired:existsSync(join(home,'projects','.retired'))});
  return {h,cto,entry,session,sessionRecord,tables,host};
};

it('#1229 C-1: a refused retirement changes no database row and no host file',async () => {
  const r = await legacyRetirement({key:true,clone:true,roster:true});
  try {
    // The session row pins the stand-in CTO, which now names another session: it cannot be verified.
    r.sessionRecord('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const before = {database:r.tables(),host:r.host()};
    const refused = await retireProject(r.h.cp,r.entry.projectId,'operator retirement');
    expect(refused).toMatchObject({allowed:false,evidence:{projectId:'resident',requiredOrder:[
      `end the CTO session ${r.entry.sessionUuid} (pid ${r.cto.pid}) yourself: exit it in its own terminal`,'run agentctl project retire resident again']}});
    expect({database:r.tables(),host:r.host()}).toEqual(before);
    expect(readProcessStartToken(r.cto.pid)).toBe(r.cto.startedAt);
  } finally {r.cto.stop();r.h.cp.close();}
});

it('#1229 C-3: when the CTO changes between verification and the host step, the refusal commits nothing irreversible',async () => {
  // The exact host receipt proves the room was archived already; the CTO is the only unsettled boundary.
  const r = await legacyRetirement({key:false,clone:false,roster:false});
  try {
    writeFileSync(join(r.h.root,'retired-buzz-room-resident.json'),JSON.stringify({
      version:1,projectId:r.entry.projectId,roomId:r.entry.buzzAddress,archived:true,
    })+'\n');
    r.sessionRecord(r.entry.sessionUuid);
    const verify = r.h.cp.residentProjects.verifyRetirement.bind(r.h.cp.residentProjects);
    vi.spyOn(r.h.cp.residentProjects,'verifyRetirement').mockImplementation(async projectId => {
      await verify(projectId);
      // Verified; then, before the host step, the incarnation's session record names another session.
      r.sessionRecord('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    });
    // Audit rows are the one committed change a refusal may leave; sqlite_sequence counts them.
    const before = {database:r.tables(['audit_events','sqlite_sequence']),host:r.host()};
    const refused = await retireProject(r.h.cp,r.entry.projectId,'operator retirement');
    expect(refused).toMatchObject({allowed:false,evidence:{projectId:'resident',requiredOrder:[
      `end the CTO session ${r.entry.sessionUuid} (pid ${r.cto.pid}) yourself: exit it in its own terminal`,'run agentctl project retire resident again']}});
    expect(r.h.cp.projects.get('resident')).toMatchObject({suspended:false,retiredAt:null});
    expect(r.h.cp.db.get(`SELECT 1 FROM project_retirements WHERE project_id = 'resident'`)).toBeUndefined();
    expect(new CanonicalSessionRegistry(r.h.cp.db).effective()).toEqual([r.entry]);
    expect({database:r.tables(['audit_events','sqlite_sequence']),host:r.host()}).toEqual(before);
    expect(readProcessStartToken(r.cto.pid)).toBe(r.cto.startedAt);
  } finally {r.cto.stop();r.h.cp.close();}
});

it.each(['member','no-key'] as const)('#1230 C-4: retire refuses, moving nothing, while the room cannot be archived (%s)',async problem => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  const first = await f.invoke('ensure-buzz');const roomId = (first.buzz as {roomId:string}).roomId;
  f.a.roomId = roomId;saveAllocation(f);await f.invoke('ensure-routing');
  const pk = readFileSync(f.a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
  if (problem === 'member') {
    // The CTO identity was demoted: only the owner's key still owns the room.
    const state = fakeState(f) as {members:Array<{pubkey:string;role:string}>};
    patchFake(f,{members:state.members.map(m => m.pubkey === pk ? {...m,role:'member'} : m)});
  } else {
    // The room's owner key is not at this identity's path (a hand-made identity under another name).
    for (const ext of ['priv','pub']) renameSync(f.a.privateKeyFile.replace('.priv',`.${ext}`),join(dirname(f.a.privateKeyFile),`cto-other.${ext}`));
  }
  const rosterFile = join(f.home,'.hermes','bridge','required-mentions.json');
  const snapshot = () => ({
    fake:fakeState(f).room,archived:fakeState(f).archivedRooms ?? [],roster:readFileSync(rosterFile,'utf8'),
    key:existsSync(f.a.privateKeyFile) ? readFileSync(f.a.privateKeyFile,'utf8') : null,intent:readFileSync(join(f.state,'buzz-room-test.json'),'utf8'),
    clone:existsSync(f.a.clonePath),identities:existsSync(join(f.state,'retired-buzz-identities')),
  });
  const before = snapshot();
  const order = problem === 'member'
    ? [`have an owner archive room ${roomId} (buzz channels archive --channel ${roomId}), or make ${pk} an owner of it`,'run agentctl project retire test again']
    : [`put the key of room ${roomId}'s owner (pubkey ${pk} per the roster) at ${f.a.privateKeyFile}; retirement archives the room with it and then moves it aside`,'run agentctl project retire test again'];
  for (const operation of ['retire','verify-retire']) {
    const failure = await f.invoke(operation).then(result => `unexpected success ${JSON.stringify(result)}`,(error:unknown) => String(error));
    expect(failure).not.toContain('unexpected success');
    const outcome = JSON.parse(failure.trim().split('\n').at(-1)!) as {retirementOutcome:{hostChanged:boolean;reason:string;requiredOrder:string[]}};
    expect(outcome.retirementOutcome).toMatchObject({hostChanged:false,requiredOrder:order});
    expect(outcome.retirementOutcome.reason).toContain(roomId);
    if (problem === 'member') expect(outcome.retirementOutcome.reason).toContain(`owned by ${'c'.repeat(64)}`);
    expect(snapshot()).toEqual(before);
  }
});

it('#1230 C-4: a retired local route alone does not prove the external room was archived',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  const first = await f.invoke('ensure-buzz');const roomId = (first.buzz as {roomId:string}).roomId;
  f.a.roomId = roomId;saveAllocation(f);await f.invoke('ensure-routing');
  const pk = readFileSync(f.a.privateKeyFile.replace('.priv','.pub'),'utf8').trim();
  for (const ext of ['priv','pub']) renameSync(f.a.privateKeyFile.replace('.priv',`.${ext}`),join(dirname(f.a.privateKeyFile),`cto-lost.${ext}`));
  rmSync(join(f.state,'buzz-room-test.json'),{force:true});
  const rosterFile = join(f.home,'.hermes','bridge','required-mentions.json');
  const roster = JSON.parse(readFileSync(rosterFile,'utf8')) as {channels:Record<string,{status:string}>};
  roster.channels[roomId]!.status = 'retired';
  writeFileSync(rosterFile,JSON.stringify(roster,null,2)+'\n');
  const snapshot = () => ({
    fake:fakeState(f).room,
    archived:fakeState(f).archivedRooms ?? [],
    roster:readFileSync(rosterFile,'utf8'),
    clone:existsSync(f.a.clonePath),
    marker:existsSync(join(f.state,'retired-buzz-room-test.json')),
  });
  const before = snapshot();
  for (const operation of ['retire','verify-retire']) {
    const failure = await f.invoke(operation).then(result => `unexpected success ${JSON.stringify(result)}`,(error:unknown) => String(error));
    expect(failure).not.toContain('unexpected success');
    const outcome = JSON.parse(failure.trim().split('\n').at(-1)!) as {retirementOutcome:{hostChanged:boolean;reason:string;requiredOrder:string[]}};
    expect(outcome.retirementOutcome).toMatchObject({
      hostChanged:false,
      reason:expect.stringContaining(`no key for cto-test`),
      requiredOrder:[
        `put the key of room ${roomId}'s owner (pubkey ${pk} per the roster) at ${f.a.privateKeyFile}; retirement archives the room with it and then moves it aside`,
        'run agentctl project retire test again',
      ],
    });
    expect(snapshot()).toEqual(before);
  }
});

/**
 * #1251 C-P2 — the daemon's own ledger and protocol class against the packaged script. The wrapper hands the script
 * the fixture's binaries and writes the allocation the fakes read; the daemon supplies the state directory.
 */
const daemonHost = (f:ReturnType<typeof fixture>) => {
  const wrapper = join(f.home,'host-wrapper.cjs');
  const env = Object.fromEntries((['HOME','PATH','ACP_HOST_DATABASE_PATH','ACP_BUZZ_BINARY','ACP_CLAUDE_BINARY','ACP_RESOLVED_BUZZ_BINARY','ACP_RESOLVED_CLAUDE_BINARY','CLAUDE_CONFIG_DIR','ACP_BUZZ_ADMISSION_COMMAND','TEST_CLAUDE_PID'] as const).map(key => [key,f.env[key]]));
  writeFileSync(wrapper,`const {spawnSync} = require('node:child_process'), fs = require('node:fs');
const input = fs.readFileSync(0,'utf8');
fs.writeFileSync(${JSON.stringify(join(f.home,'allocation.json'))},JSON.stringify(JSON.parse(input).allocation));
const child = spawnSync(process.execPath,[${JSON.stringify(f.script)}],{input,encoding:'utf8',timeout:30000,env:{...${JSON.stringify(env)},ACP_STATE_DIR:process.env.ACP_STATE_DIR}});
process.stdout.write(child.stdout ?? '');process.stderr.write(child.stderr ?? '');process.exit(child.status ?? 1);
`);
  return wrapper;
};

it.each(['profile','create','refused-create'] as const)('#1251 C-P2: retirement settles the room of an ensure-buzz that stopped before the daemon recorded it (%s)',async failure => {
  const f = fixture();
  const root = realpathSync(tempDir('retire-unbound-'));
  const wrapper = daemonHost(f);
  const h = makeHarness({root,residentProvisioner:{home:f.home,script:wrapper}});
  try {
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:ExecutionMode.STANDARD,
      contract:{goal:'bootstrap',why:'owner request',scope:[],nonGoals:[],acceptance:['developable'],priority:'NORMAL',humanGate:[],references:[]}});
    if (!run.allowed) throw new Error(run.message);
    const runId = run.value.runId;
    h.cp.projects.register({projectId:'test',name:'test'});
    h.cp.residentProjects.attachSubscriber(async () => false);
    h.cp.residentProjects.remember({runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'},'test',{});
    // Buzz fails at profile setup, after this run's key was minted; or it creates the room and its answer is lost; or,
    // after the room intent was written, it refuses the create and no room exists.
    if (failure === 'profile') writeFileSync(join(f.home,'fail-buzz'),'');
    else writeFileSync(join(f.home,'fake.json'),JSON.stringify({members:[],posts:[],creates:0,launches:0,...(failure === 'create' ? {loseCreate:true} : {refuseCreate:true})}));
    await expect(h.cp.residentProjects.ensure({runId,projectId:'test',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'a'.repeat(40),packet:{}})).rejects.toThrow();
    rmSync(join(f.home,'fail-buzz'),{force:true});
    const allocation = h.cp.residentProjects.allocation(runId)!;
    expect(existsSync(f.a.privateKeyFile)).toBe(true);
    const retired = await retireProject(h.cp,'test','operator retirement');
    expect(retired,JSON.stringify(retired)).toMatchObject({allowed:true});
    expect(allocation.roomLifecycle).toBe('unbound');
    const created = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const settled = () => ({creates:fakeState(f).creates,archived:fakeState(f).archivedRooms ?? []});
    expect(settled()).toEqual(failure === 'create' ? {creates:1,archived:[expect.objectContaining({channel_id:created,archived:true})]} : {creates:0,archived:[]});
    expect(h.cp.residentProjects.row(runId)?.status).toBe('RETIRED');
    expect(existsSync(f.a.privateKeyFile)).toBe(false);
    expect(existsSync(f.a.clonePath)).toBe(false);
    if (failure === 'create') expect(JSON.parse(readFileSync(join(root,'retired-buzz-room-test.json'),'utf8'))).toEqual({version:1,projectId:'test',roomId:created,archived:true});
    // A daemon exit after the host step and before its ledger recorded it: the host retire runs again, changing nothing.
    // After a refused create, the moved-aside intent is looked up again with the key moved aside with it (#1251 C6).
    const before = settled();
    const again = await new ExecFileHostProjectProvisioner(wrapper,f.home,root,30_000,join(root,'state.sqlite')).invoke('retire',allocation);
    expect(again).toMatchObject({retired:true,buzzRoom:failure === 'create' ? 'archived' : 'none'});
    expect(settled()).toEqual(before);
  } finally {h.cp.close();}
});

/** #1251 C5 — a bootstrap run through the daemon's ledger whose ensure-buzz the host lock refuses before any key step. */
const lockRefusedEnsureBuzz = async (f:ReturnType<typeof fixture>, root:string) => {
  const h = makeHarness({root,residentProvisioner:{home:f.home,script:daemonHost(f)}});
  const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:ExecutionMode.STANDARD,
    contract:{goal:'bootstrap',why:'owner request',scope:[],nonGoals:[],acceptance:['developable'],priority:'NORMAL',humanGate:[],references:[]}});
  if (!run.allowed) throw new Error(run.message);
  const runId = run.value.runId;
  h.cp.projects.register({projectId:'test',name:'test'});
  h.cp.residentProjects.attachSubscriber(async () => false);
  h.cp.residentProjects.remember({runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'},'test',{});
  // Another provisioner, alive (this test process), holds the host lock while ensure-buzz runs.
  const busy = join(f.home,'busy-provisioner');mkdirSync(busy);
  writeFileSync(join(busy,'owner.json'),JSON.stringify({pid:process.pid,start:readProcessStartToken(process.pid)}));
  const host = h.cp.hostProjectProvisioner!;const invoke = host.invoke.bind(host);
  const lock = join(root,'host-provisioner.lock');
  const refusals:string[] = [];
  vi.spyOn(host,'invoke').mockImplementation(async (operation,allocation,packet) => {
    if (operation !== 'ensure-buzz') return invoke(operation,allocation,packet);
    symlinkSync(busy,lock);
    try {return await invoke(operation,allocation,packet);} catch (error) {refusals.push(String(error));throw error;} finally {rmSync(lock);}
  });
  await expect(h.cp.residentProjects.ensure({runId,projectId:'test',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'a'.repeat(40),packet:{}})).rejects.toThrow();
  expect(refusals).toHaveLength(1);
  vi.mocked(host.invoke).mockRestore();
  const allocation = h.cp.residentProjects.allocation(runId)!;
  expect(allocation.roomLifecycle).toBe('unbound');
  return {h,runId,allocation};
};

it.each(['older-identity','no-key'] as const)('#1251 C5: retirement after ensure-buzz was refused at the host lock settles no room and needs no key (%s)',async left => {
  const f = fixture();
  const root = realpathSync(tempDir('retire-lock-refused-'));
  const olderRoom = '12345678-1234-4123-8123-123456789abc';
  const olderKey = '2'.repeat(64);const olderPk = getPublicKey(Buffer.from(olderKey,'hex'));
  const identity = [f.a.privateKeyFile,f.a.privateKeyFile.replace('.priv','.pub'),join(root,'buzz-key-test.json'),join(root,'buzz-room-test.json')];
  if (left === 'older-identity') {
    // C5-1: an older run's key, its records and its same-named room, which that key owns. No roster route binds it here.
    mkdirSync(root,{recursive:true});
    writeFileSync(identity[0]!,olderKey+'\n');writeFileSync(identity[1]!,olderPk+'\n');
    writeFileSync(identity[2]!,JSON.stringify({runId:'run_old',pubkey:olderPk}));
    writeFileSync(identity[3]!,JSON.stringify({name:'test',pubkey:olderPk,runId:'run_old',roomId:olderRoom}));
    writeFileSync(join(f.home,'fake.json'),JSON.stringify({members:[{pubkey:olderPk,role:'owner'}],posts:[],creates:0,launches:0,
      room:{channel_id:olderRoom,name:'test',channel_type:'stream',visibility:'private'}}));
  }
  const files = () => identity.map(file => existsSync(file) ? readFileSync(file,'utf8') : null);
  const before = files();
  const {h,runId,allocation} = await lockRefusedEnsureBuzz(f,root);
  try {
    // The refused ensure-buzz rotated nothing and minted nothing.
    expect(files()).toEqual(before);
    const retired = await retireProject(h.cp,'test','operator retirement');
    expect(retired,JSON.stringify(retired)).toMatchObject({allowed:true});
    expect(h.cp.residentProjects.row(runId)?.status).toBe('RETIRED');
    expect((JSON.parse(h.cp.residentProjects.row(runId)!.steps_json) as {retire:{buzzRoom:string}}).retire.buzzRoom).toBe('none');
    const settled = () => ({room:fakeState(f).room ?? null,archived:fakeState(f).archivedRooms ?? [],creates:fakeState(f).creates,
      receipt:existsSync(join(root,'retired-buzz-room-test.json')),identities:existsSync(join(root,'retired-buzz-identities')),files:files()});
    // The older run's room stays active and its identity stays where it was; this run had no room and no key.
    expect(settled()).toEqual({room:left === 'older-identity' ? expect.objectContaining({channel_id:olderRoom}) : null,archived:[],creates:0,receipt:false,identities:false,files:before});
    expect(existsSync(f.a.clonePath)).toBe(false);
    // A daemon exit after the host step and before its ledger recorded it: the host retire runs again, changing nothing.
    const again = settled();
    expect(await new ExecFileHostProjectProvisioner(daemonHost(f),f.home,root,30_000,join(root,'state.sqlite')).invoke('retire',allocation)).toMatchObject({retired:true,buzzRoom:'none'});
    expect(settled()).toEqual(again);
  } finally {h.cp.close();}
});

it('#1251 C5-1: a key that replaced the one this run created its room with is never used; retirement names the key it needs',async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  // This run's ensure-buzz created its room and lost the answer: the room intent names this run's key and no room yet.
  patchFake(f,{loseCreate:true});
  await expect(f.invoke('ensure-buzz')).rejects.toThrow();
  const pubFile = f.a.privateKeyFile.replace('.priv','.pub');
  const ownKey = readFileSync(f.a.privateKeyFile,'utf8');const ownPk = readFileSync(pubFile,'utf8').trim();
  const room = (fakeState(f).room as {channel_id:string}).channel_id;
  // Another identity under this name is put at the path: this run did not mint it and no route binds it.
  const otherKey = '3'.repeat(64);const otherPk = getPublicKey(Buffer.from(otherKey,'hex'));
  writeFileSync(f.a.privateKeyFile,otherKey+'\n');writeFileSync(pubFile,otherPk+'\n');
  f.a.roomLifecycle = 'unbound';saveAllocation(f);
  const snapshot = () => ({room:fakeState(f).room,archived:fakeState(f).archivedRooms ?? [],
    files:[f.a.privateKeyFile,pubFile,join(f.state,'buzz-room-test.json'),join(f.state,'buzz-key-test.json')].map(file => existsSync(file) ? readFileSync(file,'utf8') : null),clone:existsSync(f.a.clonePath)});
  const before = snapshot();
  const order = [
    `move the key at ${f.a.privateKeyFile} (pubkey ${otherPk}) aside: this run did not mint it and the roster binds it to no active route of test`,
    `put the key this run minted (pubkey ${ownPk}) at ${f.a.privateKeyFile}`,
    'run agentctl project retire test again',
  ];
  const host = new ExecFileHostProjectProvisioner(daemonHost(f),f.home,f.state,30_000,f.database);
  for (const operation of ['verify-retire','retire'] as const) {
    const refused = await host.invoke(operation,f.a).then(() => null,(error:unknown) => error);
    expect(refused).toBeInstanceOf(HostRetirementRefusal);
    expect(refused,String(refused)).toMatchObject({hostChanged:false,requiredOrder:order});
    expect(snapshot()).toEqual(before);
  }
  // The order is executable: with this run's key back, retirement archives the room it created.
  renameSync(f.a.privateKeyFile,join(f.home,'other.priv'));renameSync(pubFile,join(f.home,'other.pub'));
  writeFileSync(f.a.privateKeyFile,ownKey);writeFileSync(pubFile,ownPk+'\n');
  expect(await host.invoke('retire',f.a)).toMatchObject({retired:true,buzzRoom:'archived'});
  expect(fakeState(f).archivedRooms).toEqual([expect.objectContaining({channel_id:room,archived:true})]);
});

/** #1251 C6 — this run's ensure-buzz created its room and lost the answer: its intent names this run's key and no room. */
const lostCreate = async () => {
  const f = fixture();
  await f.invoke('ensure-checkout');
  patchFake(f,{loseCreate:true});
  await expect(f.invoke('ensure-buzz')).rejects.toThrow();
  const pubFile = f.a.privateKeyFile.replace('.priv','.pub');
  const room = (fakeState(f).room as {channel_id:string}).channel_id;
  return {f,pubFile,room,ownPk:readFileSync(pubFile,'utf8').trim(),retiredDir:join(f.state,'retired-buzz-identities'),
    identity:[pubFile,join(f.state,'buzz-room-test.json'),join(f.state,'buzz-key-test.json')]};
};
const refusesUnchanged = async (f:ReturnType<typeof fixture>, order:string[], snapshot:() => unknown) => {
  const host = new ExecFileHostProjectProvisioner(daemonHost(f),f.home,f.state,30_000,f.database);
  const before = snapshot();
  for (const operation of ['verify-retire','retire'] as const) {
    const refused = await host.invoke(operation,f.a).then(result => result,(error:unknown) => error);
    expect(refused).toBeInstanceOf(HostRetirementRefusal);
    expect(refused,String(refused)).toMatchObject({hostChanged:false,requiredOrder:[...order,'run agentctl project retire test again']});
    expect(snapshot()).toEqual(before);
  }
  return host;
};

it.each(['interrupted','replaced'] as const)('#1251 C6: an intent of this run moved aside without its key keeps retirement from settling no room (%s)',async variant => {
  const {f,room,ownPk,retiredDir,identity} = await lostCreate();
  // The key is moved away. An ensure-buzz retry moves this run's surviving identity aside and is interrupted before it
  // mints a replacement key (the state its moveIdentityAside leaves), or mints one and stops at the profile step.
  renameSync(f.a.privateKeyFile,join(f.home,'lost.priv'));
  if (variant === 'interrupted') {
    const moved = join(retiredDir,'cto-test.2026-10-30T00-00-00-000Z.c6c6c6c6');mkdirSync(moved,{recursive:true,mode:0o700});
    for (const file of identity) renameSync(file,join(moved,basename(file)));
  } else {
    writeFileSync(join(f.home,'fail-buzz'),'');
    await expect(f.invoke('ensure-buzz')).rejects.toThrow();
    rmSync(join(f.home,'fail-buzz'));
  }
  expect(readdirSync(retiredDir)).toHaveLength(1);
  const dir = join(retiredDir,readdirSync(retiredDir)[0]!);
  expect(readdirSync(dir).sort()).toEqual(['buzz-key-test.json','buzz-room-test.json','cto-test.pub']);
  f.a.roomLifecycle = 'unbound';saveAllocation(f);
  const snapshot = () => ({room:fakeState(f).room,archived:fakeState(f).archivedRooms ?? [],clone:existsSync(f.a.clonePath),moved:readdirSync(dir).sort(),
    files:[f.a.privateKeyFile,...identity,join(f.state,'retired-buzz-room-test.json')].map(file => existsSync(file) ? readFileSync(file,'utf8') : null)});
  const host = await refusesUnchanged(f,variant === 'interrupted'
    ? [`put this run's identity back from ${dir}: its cto-test.pub in ${dirname(f.a.privateKeyFile)}, its buzz-key-test.json and buzz-room-test.json in ${f.state}, and the key this run minted (pubkey ${ownPk}), which is not with them, at ${f.a.privateKeyFile}`]
    : [`put the key this run minted (pubkey ${ownPk}) in ${dir} as cto-test.priv; retirement looks for that room with it`],snapshot);
  expect(fakeState(f).room).toMatchObject({channel_id:room});
  // The order is executable, and retirement leaves no room of this run active.
  if (variant === 'interrupted') {
    for (const file of identity) renameSync(join(dir,basename(file)),file);
    renameSync(join(f.home,'lost.priv'),f.a.privateKeyFile);
    expect(await host.invoke('retire',f.a)).toMatchObject({retired:true,buzzRoom:'archived'});
  } else {
    renameSync(join(f.home,'lost.priv'),join(dir,'cto-test.priv'));
    await refusesUnchanged(f,[`have an owner archive room ${room} (buzz channels archive --channel ${room})`],snapshot);
    const active = fakeState(f).room as Record<string,unknown>;
    patchFake(f,{room:null,members:[],archivedRooms:[{...active,archived:true}]});
    expect(await host.invoke('retire',f.a)).toMatchObject({retired:true});
  }
  expect(fakeState(f)).toMatchObject({room:null,archivedRooms:[expect.objectContaining({channel_id:room,archived:true})]});
});

it('#1251 C6: an intent of this run moved aside with its key is looked up with that key before retirement settles no room',async () => {
  const {f,pubFile,room,ownPk,retiredDir,identity} = await lostCreate();
  // A later run's ensure-buzz under the same identity name moves this run's whole identity aside, key included, and
  // stops at the profile step: its own key, which no route binds, is left at the path.
  f.a.runId = 'run_next';writeFileSync(join(f.home,'fail-buzz'),'');
  await expect(f.invoke('ensure-buzz')).rejects.toThrow();
  rmSync(join(f.home,'fail-buzz'));
  f.a.runId = 'run_test';f.a.roomLifecycle = 'unbound';saveAllocation(f);
  const dir = join(retiredDir,readdirSync(retiredDir)[0]!);
  expect(readdirSync(dir).sort()).toEqual(['buzz-key-test.json','buzz-room-test.json','cto-test.priv','cto-test.pub']);
  const nextPk = readFileSync(pubFile,'utf8').trim();
  const snapshot = () => ({room:fakeState(f).room,archived:fakeState(f).archivedRooms ?? [],clone:existsSync(f.a.clonePath),moved:readdirSync(dir).sort(),
    files:[f.a.privateKeyFile,...identity].map(file => existsSync(file) ? readFileSync(file,'utf8') : null)});
  const host = await refusesUnchanged(f,[
    `move the key at ${f.a.privateKeyFile} (pubkey ${nextPk}) aside: this run did not mint it and the roster binds it to no active route of test`,
    `put this run's identity back from ${dir}: its cto-test.priv and cto-test.pub in ${dirname(f.a.privateKeyFile)}, its buzz-key-test.json and buzz-room-test.json in ${f.state}`,
  ],snapshot);
  expect(fakeState(f).room).toMatchObject({channel_id:room});
  // The order is executable: with this run's identity back, retirement archives the room it created.
  renameSync(f.a.privateKeyFile,join(f.home,'next.priv'));renameSync(pubFile,join(f.home,'next.pub'));
  for (const file of [f.a.privateKeyFile,...identity]) renameSync(join(dir,basename(file)),file);
  expect(readFileSync(pubFile,'utf8').trim()).toBe(ownPk);
  expect(await host.invoke('retire',f.a)).toMatchObject({retired:true,buzzRoom:'archived'});
  expect(fakeState(f)).toMatchObject({room:null,archivedRooms:[expect.objectContaining({channel_id:room,archived:true})]});
});

it('#1251 C7: a room this run created before a retry bound its replacement keeps retirement from archiving only the replacement',async () => {
  const f = fixture();
  const root = realpathSync(tempDir('retire-replaced-'));
  const h = makeHarness({root,residentProvisioner:{home:f.home,script:daemonHost(f)}});
  try {
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:ExecutionMode.STANDARD,
      contract:{goal:'bootstrap',why:'owner request',scope:[],nonGoals:[],acceptance:['developable'],priority:'NORMAL',humanGate:[],references:[]}});
    if (!run.allowed) throw new Error(run.message);
    const runId = run.value.runId;
    h.cp.projects.register({projectId:'test',name:'test'});
    h.cp.residentProjects.attachSubscriber(async () => false);
    h.cp.residentProjects.remember({runId,candidateSnapshotDigest:'candidate',ceoSessionId:'ceo'},'test',{});
    const ensure = () => h.cp.residentProjects.ensure({runId,projectId:'test',repositoryIdentity:'github:acme/fixture',repositoryNodeId:'R_node',head:'a'.repeat(40),packet:{}});
    // The first create lands and its answer is lost; its key is then moved away. The retry moves this run's identity
    // aside, mints a replacement key and creates a second room, which the daemon binds; the relay keeps both rooms.
    writeFileSync(join(f.home,'fake.json'),JSON.stringify({members:[],posts:[],creates:0,launches:0,loseCreate:true,keepRooms:true}));
    await expect(ensure()).rejects.toThrow();
    const pubFile = f.a.privateKeyFile.replace('.priv','.pub');const firstPk = readFileSync(pubFile,'utf8').trim();
    renameSync(f.a.privateKeyFile,join(f.home,'lost.priv'));
    await expect(ensure()).rejects.toThrow();
    const first = 'ffffffff-ffff-4fff-8fff-ffffffffffff';const replacement = '99999999-9999-4999-8999-999999999999';
    const allocation = h.cp.residentProjects.allocation(runId)!;
    expect(allocation).toMatchObject({roomLifecycle:'created-or-unknown',roomId:replacement});
    expect(fakeState(f)).toMatchObject({creates:2,room:{channel_id:replacement},otherRooms:[{room:{channel_id:first},members:[{pubkey:firstPk,role:'owner'}]}]});
    expect(fakeState(f).launched).toBeUndefined();
    const retiredDir = join(root,'retired-buzz-identities');
    expect(readdirSync(retiredDir)).toHaveLength(1);
    const dir = join(retiredDir,readdirSync(retiredDir)[0]!);
    expect(readdirSync(dir).sort()).toEqual(['buzz-key-test.json','buzz-room-test.json','cto-test.pub']);
    const snapshot = () => ({room:fakeState(f).room,others:fakeState(f).otherRooms,archived:fakeState(f).archivedRooms ?? [],clone:existsSync(f.a.clonePath),
      moved:readdirSync(dir).sort(),status:h.cp.residentProjects.row(runId)?.status,
      files:[f.a.privateKeyFile,pubFile,join(root,'buzz-room-test.json'),join(root,'buzz-key-test.json'),join(root,'retired-buzz-room-test.json')].map(file => existsSync(file) ? readFileSync(file,'utf8') : null)});
    const refuses = async (order:string[]) => {
      const before = snapshot();
      const refused = await retireProject(h.cp,'test','operator retirement');
      expect(refused,JSON.stringify(refused)).toMatchObject({allowed:false,evidence:{projectId:'test',requiredOrder:[...order,'run agentctl project retire test again']}});
      expect(snapshot()).toEqual(before);
    };
    // The earlier room's key is not there to look with: refused before any host write.
    await refuses([`put the key this run minted (pubkey ${firstPk}) in ${dir} as cto-test.priv; retirement looks for that room with it`]);
    // With that key back it finds the earlier room still active: refused, naming the owner archive step.
    renameSync(join(f.home,'lost.priv'),join(dir,'cto-test.priv'));
    await refuses([`have an owner archive room ${first} (buzz channels archive --channel ${first})`]);
    // Once an owner archives it, retirement archives the replacement room and leaves no room of this run active.
    const kept = (fakeState(f).otherRooms as {room:Record<string,unknown>}[])[0]!.room;
    patchFake(f,{otherRooms:[],archivedRooms:[{...kept,archived:true}]});
    const retired = await retireProject(h.cp,'test','operator retirement');
    expect(retired,JSON.stringify(retired)).toMatchObject({allowed:true});
    expect(h.cp.residentProjects.row(runId)?.status).toBe('RETIRED');
    expect(fakeState(f)).toMatchObject({room:null,otherRooms:[],archivedRooms:[expect.objectContaining({channel_id:first}),expect.objectContaining({channel_id:replacement})]});
    expect(existsSync(f.a.clonePath)).toBe(false);
    // A daemon exit after the host step and before its ledger recorded it: the host retire runs again, changing nothing.
    const settled = () => ({fake:fakeState(f),identities:readdirSync(retiredDir).sort()});
    const before = settled();
    expect(await new ExecFileHostProjectProvisioner(daemonHost(f),f.home,root,30_000,join(root,'state.sqlite')).invoke('retire',allocation)).toMatchObject({retired:true,buzzRoom:'archived'});
    expect(settled()).toEqual(before);
  } finally {h.cp.close();}
});
