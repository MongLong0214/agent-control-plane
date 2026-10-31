import { afterAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { getPublicKey } from 'nostr-tools';
import Database from 'better-sqlite3';
import { ExecFileHostProjectProvisioner, type HostProjectProvisioner, type ProjectAllocation } from '../../src/runtime/host-project-provisioner.ts';
import { CanonicalSelfClaim, hostSessionRegistryAbsent } from '../../src/registry/canonical-self-claim.ts';
import { CanonicalSessionRegistry } from '../../src/registry/canonical-session-registry.ts';
import { retireProject } from '../../src/registry/project-retirement.ts';
import { readProcessStartToken } from '../../src/core/process-argv.ts';
import { allow } from '../../src/core/errors.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { ExecutionMode, RunKind } from '../../src/domain/types.ts';
import { git } from '../../src/git/git.ts';
import { reviewBootstrapPlan } from '../helpers/bootstrap-plan.ts';
import { GenesisGitHub, genesisPlanFixture } from '../helpers/genesis-github.ts';
import { decideThroughHermes, dispatchBootstrapRun, makeHarness, type Harness } from '../helpers/harness.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';

afterAll(cleanupTempDirs);

/**
 * The relay, GitHub's clone and node-id answers, Claude, tmux, ps, lsof and the relay admission as one double for the
 * packaged host script. Rooms, members, archives and posts live in HOME/fake.json; the allocation being served is the
 * one the daemon just handed the host (HOME/allocation.json). git is the real binary except for a clone from GitHub,
 * which is served from the GitHub double's bare repository at that name.
 */
const fakeHost = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process'), crypto = require('node:crypto');
const home = process.env.HOME, cmd = path.basename(process.argv[1]), args = process.argv.slice(2);
const flag = f => args.includes(f) ? args[args.indexOf(f) + 1] : undefined;
const out = x => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const github = () => JSON.parse(fs.readFileSync(path.join(home, 'github.json'), 'utf8'));
if (cmd === 'git') {
  if (args[0] === 'clone') {
    const [url, dest] = args.slice(args.indexOf('--') + 1);
    const repo = github()[url];
    if (!repo) process.exit(128);
    child.execFileSync(process.env.TEST_REAL_GIT, ['clone', '-q', '-b', 'dev', repo.bare, dest]);
    child.execFileSync(process.env.TEST_REAL_GIT, ['-C', dest, 'remote', 'set-url', 'origin', url]);
    process.exit(0);
  }
  const passed = child.spawnSync(process.env.TEST_REAL_GIT, args, { stdio: 'inherit' });
  process.exit(passed.status === null ? 1 : passed.status);
}
const a = JSON.parse(fs.readFileSync(path.join(home, 'allocation.json'), 'utf8'));
const stateFile = path.join(home, 'fake.json');
const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { rooms: [], profiles: {}, admitted: [], mcp: {}, residents: {}, panes: 0 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const residents = () => Object.values(s.residents).filter(r => alive(r.pid));
const lstart = 'Thu Oct 22 01:00:00 2026';
if (cmd === 'gh') {
  const repo = github()['https://github.com/' + args[1].replace(/^repos\\//, '') + '.git'];
  if (!repo) process.exit(1);
  out(repo.nodeId);
} else if (cmd === 'docker') {
  if (!s.admitted.includes(flag('--pubkey'))) s.admitted.push(flag('--pubkey'));
  out('{}');
} else if (cmd === 'claude') {
  if (args[0] !== 'mcp') process.exit(2);
  if (args[1] === 'add') s.mcp[process.cwd()] = args.slice(args.indexOf('--') + 1);
  else if (args[1] === 'remove') delete s.mcp[process.cwd()];
  else { const c = s.mcp[process.cwd()]; if (!c) process.exit(1); out('acp-cto\\nCommand: ' + c[0] + '\\nArgs: ' + c.slice(1).join(' ')); }
} else if (cmd === 'tmux') {
  const name = flag('-t') ?? flag('-s'), r = s.residents[name];
  if (args[0] === 'has-session') process.exit(r ? 0 : 1);
  else if (args[0] === 'new-session') {
    const pid = Number(process.env.TEST_CLAUDE_PID);
    s.residents[name] = { pid, pane: 900000 + (++s.panes), sessionUuid: a.sessionUuid, cwd: a.clonePath };
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', pid + '.json'), JSON.stringify({ sessionId: a.sessionUuid, cwd: a.clonePath, bridgeSessionId: 'bridge-' + a.projectId }));
  } else if (args[0] === 'display-message') { if (!r) process.exit(1); out(String(r.pane)); }
  else if (args[0] === 'kill-session') delete s.residents[name];
  else process.exit(2);
} else if (cmd === 'ps') {
  if (args[1] === 'pid=,ppid=,lstart=,command=') out(residents().map(r => r.pid + ' ' + r.pane + ' ' + lstart + ' claude --session-id ' + r.sessionUuid + '\\n' + r.pane + ' 1 ' + lstart + ' tmux').join('\\n'));
  else if (args[0] === '-axo') out(residents().map(r => 'claude --session-id ' + r.sessionUuid).join('\\n'));
  else if (args[0] === '-p') { const r = residents().find(r => r.pid === Number(args[1])); out(r ? 'claude --session-id ' + r.sessionUuid : ''); }
} else if (cmd === 'lsof') {
  const r = residents().find(r => r.pid === Number(flag('-p')));
  out(r ? 'n' + r.cwd + '\\n' : '');
} else if (cmd === 'buzz') {
  // The relay knows its caller by the key it signs with.
  const key = process.env.BUZZ_PRIVATE_KEY || '';
  if (!/^[0-9a-f]{64}$/.test(key) || process.env.BUZZ_IDENTITY !== a.identityName) process.exit(7);
  const ecdh = crypto.createECDH('secp256k1'); ecdh.setPrivateKey(Buffer.from(key, 'hex'));
  const pk = ecdh.getPublicKey(null, 'compressed').subarray(1).toString('hex');
  const room = id => s.rooms.find(r => r.channel_id === id);
  const shape = r => ({ channel_id: r.channel_id, name: r.name, channel_type: r.channel_type, visibility: r.visibility, archived: r.archived });
  const owns = r => r && r.members.some(m => m.pubkey === pk && m.role === 'owner');
  const [noun, verb] = args;
  if (noun === 'users' && verb === 'set-profile') { s.profiles[pk] = flag('--name'); out('{}'); }
  else if (noun === 'users' && verb === 'get') out([{ pubkey: flag('--pubkey'), name: s.profiles[flag('--pubkey')] }]);
  else if (noun === 'channels' && verb === 'search') out(s.rooms.filter(r => r.name === flag('--query') && (!r.archived || args.includes('--include-archived'))).map(shape));
  else if (noun === 'channels' && verb === 'get') { const r = room(flag('--channel')); if (!r) process.exit(5); out(shape(r)); }
  else if (noun === 'channels' && verb === 'create') {
    const r = { channel_id: crypto.randomUUID(), name: flag('--name'), channel_type: flag('--type'), visibility: flag('--visibility'), archived: false, members: [{ pubkey: pk, role: 'owner' }], posts: [] };
    s.rooms.push(r); out(shape(r));
  } else if (noun === 'channels' && verb === 'add-member') {
    const r = room(flag('--channel')); if (!owns(r)) process.exit(6);
    r.members = r.members.filter(m => m.pubkey !== flag('--pubkey')).concat([{ pubkey: flag('--pubkey'), role: flag('--role') }]); out('{}');
  } else if (noun === 'channels' && verb === 'members') { const r = room(flag('--channel')); if (!r) process.exit(5); out(r.members); }
  else if (noun === 'channels' && verb === 'archive') { const r = room(flag('--channel')); if (!owns(r) || r.archived) process.exit(6); r.archived = true; out({ accepted: true }); }
  else if (noun === 'messages' && verb === 'send') {
    // The policy wrapper refuses a send to a room the roster does not route.
    const rosterFile = path.join(home, '.hermes', 'bridge', 'required-mentions.json');
    const roster = fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile, 'utf8')) : { channels: {} };
    const r = room(flag('--channel')); if (!r || !roster.channels[r.channel_id]) process.exit(1);
    r.posts.push({ id: crypto.randomBytes(32).toString('hex'), pubkey: pk, content: flag('--content') }); out('{}');
  } else if (noun === 'messages' && verb === 'get') { const r = room(flag('--channel')); if (!r) process.exit(5); out(r.posts); }
  else process.exit(2);
} else process.exit(2);
fs.writeFileSync(stateFile, JSON.stringify(s));
`;

// The tables and columns the host reads the current canonical CEO from, holding one CEO whose Buzz key is 'd'*64.
const writeCeoDatabase = (path:string) => {
  const db = new Database(path);
  db.exec(`CREATE TABLE assignments(assignment_id,binding_generation,actor_id,role_key,role,status);
    CREATE TABLE conversational_actors(actor_id,current_session_id,current_session_incarnation);
    CREATE TABLE sessions(session_id,incarnation,buzz_address,buzz_actor_id,lifecycle);
    CREATE TABLE actor_target_bindings(target_binding_id,target_actor_id,executor_kind);
    CREATE TABLE actor_target_attestations(target_binding_id,assignment_id,binding_generation,executor_session_id,executor_session_incarnation,target_bind_receipt_json,target_bind_executor_runtime_identity);
    INSERT INTO assignments VALUES('asg_ceo',1,'act_ceo','CEO','CEO','ACTIVE');
    INSERT INTO conversational_actors VALUES('act_ceo','ses_ceo','inc_ceo');
    INSERT INTO actor_target_bindings VALUES('tb_ceo','act_ceo','hermes');
    INSERT INTO actor_target_attestations VALUES('tb_ceo','asg_ceo',1,'ses_ceo','inc_ceo','{}','runtime');
    INSERT INTO sessions VALUES('ses_ceo','inc_ceo','ffffffff-ffff-4fff-8fff-ffffffffffff','${'d'.repeat(64)}','READY');`);
  db.close();
};

const standInCto = async () => {
  const child:ChildProcess = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});
  const exit = new Promise<NodeJS.Signals|null>(resolve => child.once('exit',(_code,signal) => resolve(signal)));
  let startedAt:string|null = null;
  for (let i = 0;i < 100 && startedAt === null;i++) {startedAt = readProcessStartToken(child.pid!);if (startedAt === null) await new Promise(r => setTimeout(r,20));}
  if (startedAt === null) throw new Error('stand-in CTO did not start');
  return {pid:child.pid!,exit,stop:() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}};
};

/** The resident's own canonical self-claim, as its acp-cto attach makes it, against the entitlements the daemon holds now. */
const claimAsResident = async (h:Harness, a:ProjectAllocation, pid:number) => {
  if (h.cp.bindings.activePrimaryCto(a.projectId)) return;
  const startedAt = readProcessStartToken(pid)!;
  const entitlements = new CanonicalSessionRegistry(h.cp.db).effective();
  const entry = entitlements.find(e => e.projectId === a.projectId)!;
  const claim = new CanonicalSelfClaim(h.cp.db,h.clock,h.cp.audit,h.cp.sessions,h.cp.bindings,{isAllowedActor:() => true},
    async (_purpose,channelId) => allow(ReasonCode.OK,channelId),
    {canonicalSessions:entitlements,canonicalBuzzChannelId:entry.buzzAddress!,expectedPeerProtocolVersion:'test',expectedPeerIdentity:'test'},
    {processInspector:{snapshot:p => p === 100 ? {pid:p,ppid:pid,argv:['node','mcp'],command:'node mcp',cwd:a.clonePath,cwdProbeFailure:null,startedAt:'peer'}
      : p === pid ? {pid:p,ppid:1,argv:['/test/claude','--session-id',a.sessionUuid],command:'claude',cwd:a.clonePath,cwdProbeFailure:null,startedAt} : null},
    imageInspector:{resolve:() => null},transcriptReader:{locate:() => ({path:'/test/transcript',sizeBytes:10})},
    hostSessionRegistryReader:{read:() => hostSessionRegistryAbsent('test')},processSignal:() => {}});
  const admitted = await claim.claim({callerPid:100,claimedSessionUuid:a.sessionUuid,projectId:a.projectId,expectedBindingGeneration:1,peerProtocolVersion:'test',peerIdentity:'test',buzzPurpose:'test'});
  expect(admitted.allowed,JSON.stringify(admitted)).toBe(true);
};

const contract = {goal:'bootstrap',why:'owner request',scope:[],nonGoals:[],acceptance:['developable'],priority:'NORMAL' as const,humanGate:[],references:[]};
interface FakeRoom {channel_id:string; name:string; archived:boolean; members:Array<{pubkey:string;role:string}>}

it('#1230: retire, then a bootstrap that supersedes the retired project, provisioned at the same repository name: one active room, the old one archived, a new key bound to the new room',async () => {
  const root = realpathSync(tempDir('i1230-supersede-'));
  const home = join(root,'home');const bin = join(home,'bin');const pinned = join(home,'pinned');
  for (const dir of [bin,pinned,join(home,'.hermes','bridge','keys'),join(home,'.claude','scripts'),join(root,'current','dist','bin'),join(root,'current','dist','cli')]) mkdirSync(dir,{recursive:true});
  for (const cmd of ['git','gh','docker','tmux','ps','lsof']) writeFileSync(join(bin,cmd),fakeHost,{mode:0o700});
  for (const cmd of ['buzz','claude']) writeFileSync(join(pinned,cmd),fakeHost,{mode:0o700});
  writeFileSync(join(home,'.hermes','bridge','keys','owner.pub'),'c'.repeat(64));
  writeFileSync(join(home,'.claude','scripts','claude-trust-dir.sh'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  // The ACP runtime the resident's MCP entry names; it never runs here.
  writeFileSync(join(root,'current','dist','bin','node'),'#!/bin/sh\nexit 99\n',{mode:0o700});
  writeFileSync(join(root,'current','dist','cli','agentctl.js'),'throw new Error("runtime must not run in tests");');
  const ceoDatabase = join(root,'ceo-host.sqlite');writeCeoDatabase(ceoDatabase);
  const fake = () => JSON.parse(readFileSync(join(home,'fake.json'),'utf8')) as {rooms:FakeRoom[]};
  const roster = () => JSON.parse(readFileSync(join(home,'.hermes','bridge','required-mentions.json'),'utf8')) as {channels:Record<string,{status:string;acp_project_id:string;peer:{pubkey:string}}>};
  const keyOf = (file:string) => getPublicKey(Buffer.from(readFileSync(file,'utf8').trim(),'hex'));

  const port = new GenesisGitHub(root);
  // The packaged host script, run from source by the daemon's own protocol class; only its environment names the doubles.
  const script = fileURLToPath(new URL('../../scripts/host-project-provisioner.mjs',import.meta.url));
  const real = new ExecFileHostProjectProvisioner(script,home,root,60_000,ceoDatabase);
  const hostEnv = (a:ProjectAllocation):Record<string,string> => ({
    PATH:`${bin}:/usr/bin:/bin:/usr/sbin`,ACP_BUZZ_BINARY:join(pinned,'buzz'),ACP_CLAUDE_BINARY:join(pinned,'claude'),ACP_RESOLVED_BUZZ_BINARY:'',ACP_RESOLVED_CLAUDE_BINARY:'',
    CLAUDE_CONFIG_DIR:join(home,'.claude'),ACP_BUZZ_ADMISSION_COMMAND:JSON.stringify(['docker','exec','buzz-prod-relay-1','buzz-admin','add-member']),
    TEST_REAL_GIT:execFileSync('/bin/sh',['-c','command -v git'],{encoding:'utf8'}).trim(),
    // The old project's CTO is a stand-in process retirement must stop; the new one is this process.
    TEST_CLAUDE_PID:String(a.projectId === 'old' ? old.pid : process.pid),
  });
  const host:HostProjectProvisioner = {
    async invoke(operation,allocation,packet) {
      const a = allocation as ProjectAllocation;
      writeFileSync(join(home,'allocation.json'),JSON.stringify(a));
      const repo = port.repository('acme','fixture');
      writeFileSync(join(home,'github.json'),JSON.stringify(repo ? {'https://github.com/acme/fixture.git':{bare:repo.bare,nodeId:repo.nodeId}} : {}));
      // execFile copies the environment synchronously, so it is set for this one host call and put back before anything else runs.
      const env = hostEnv(a);const saved = Object.fromEntries(Object.keys(env).map(k => [k,process.env[k]]));
      Object.assign(process.env,env);
      let pending;
      try {pending = real.invoke(operation,allocation,packet);} finally {
        for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      const observed = await pending;
      if (operation === 'ensure-resident') await claimAsResident(h,a,observed.resident!.pid);
      return observed;
    },
  };
  const h = makeHarness({root,repoFactory:{workRoot:join(root,'factory'),githubPort:port},residentProvisioner:{home,port:host}});
  h.cp.residentProjects.attachSubscriber(async () => true);
  h.cp.bootstrapProducer.attachWriterLock(() => true);
  const old = await standInCto();
  try {
    // 1. The old project, provisioned as a resident at github:acme/fixture: its own key, room, roster route and CTO.
    const predecessor = await port.seedForeign('acme','fixture');
    const seed = tempDir('i1230-old-seed-');
    await git(seed,['init','-q','-b','dev']);writeFileSync(join(seed,'README.md'),'old project\n');await git(seed,['add','README.md']);
    await git(seed,['-c','user.name=Test','-c','user.email=test@local','commit','-q','-m','old genesis']);
    await git(seed,['push','-q',predecessor.bare,'HEAD:refs/heads/dev']);
    const oldHead = (await git(seed,['rev-parse','HEAD'])).stdout.trim();
    h.cp.projects.register({projectId:'old',name:'old'});
    const oldRun = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:ExecutionMode.STANDARD,contract});if (!oldRun.allowed) throw new Error(oldRun.message);
    h.cp.residentProjects.remember({runId:oldRun.value.runId,candidateSnapshotDigest:'old-candidate',ceoSessionId:'old-ceo'},'old',{});
    const oldEvidence = await h.cp.residentProjects.ensure({runId:oldRun.value.runId,projectId:'old',repositoryIdentity:'github:acme/fixture',repositoryNodeId:predecessor.nodeId,head:oldHead,packet:{}});
    const oldA = oldEvidence.allocation;
    expect((await h.cp.repositories.register({checkoutPath:oldA.clonePath,identity:'github:acme/fixture',projectId:'old',repositoryRole:'primary',activeManifestDigest:null})).allowed).toBe(true);
    const oldRoom = oldA.roomId;const oldKey = readFileSync(oldA.privateKeyFile,'utf8');const oldPub = keyOf(oldA.privateKeyFile);
    expect(oldEvidence.claimSessionId).toBe(h.cp.bindings.activePrimaryCto('old')?.sessionId);
    expect(fake().rooms.map(r => ({id:r.channel_id,archived:r.archived}))).toEqual([{id:oldRoom,archived:false}]);

    // 2. Retire, as agentctl project retire does: the host stops the CTO, archives its room and moves its identity aside.
    expect(await retireProject(h.cp,'old','superseded by resident-test')).toMatchObject({allowed:true});
    expect(await old.exit).toBe('SIGTERM');
    expect(fake().rooms.find(r => r.channel_id === oldRoom)?.archived).toBe(true);
    expect(roster().channels[oldRoom]).toMatchObject({status:'retired',acp_project_id:'old',peer:{pubkey:oldPub}});
    expect(existsSync(oldA.privateKeyFile)).toBe(false);
    expect(existsSync(join(home,'projects','.retired','fixture-old'))).toBe(true);
    const retiredRoute = roster().channels[oldRoom];

    // 3. Supersede: a Repo Factory bootstrap whose PLAN names the retired project, at the same repository, through the
    // CEO's CONFIRM. While the predecessor's repository still exists the CONFIRM is refused; the owner deletes it first.
    const run = h.cp.runs.create({kind:RunKind.PROJECT_BOOTSTRAP,executionMode:ExecutionMode.STANDARD,contract});if (!run.allowed) throw new Error(run.message);
    const runId = run.value.runId;
    await dispatchBootstrapRun(h.cp,h.clock,runId);
    const f = genesisPlanFixture();
    expect(f.manifest.repositories[0]!.remote).toBe('github:acme/fixture');
    const reviewed = await reviewBootstrapPlan(h,runId,{...f.artifact.content,requestDigest:h.cp.runs.get(runId)!.contractDigest,supersedesProjectId:'old'});
    const confirm = {runId,candidateSnapshotDigest:reviewed.snapshotDigest,ceoSessionId:reviewed.ceoSessionId,rationale:'replace the retired project'};
    expect(await decideThroughHermes(h,confirm)).toMatchObject({allowed:false,evidence:{refusal:'PREDECESSOR_REPOSITORY_PRESENT',predecessorProjectId:'old',expectedPredecessorNodeId:predecessor.nodeId}});
    port.remove('acme','fixture');
    // The CONFIRM registers the superseding project and provisions its resident; all it waits for is that CTO's own handoff ACK.
    expect(await decideThroughHermes(h,confirm)).toMatchObject({allowed:false,reasonCode:'BOOTSTRAP_ACTIVATION_INCOMPLETE',
      evidence:{incomplete:['handoffAck'],activation:{projectRegistration:{registered:true,supersedesProjectId:'old'}}}});
    const newProjectId = f.manifest.projectId;
    expect(h.cp.projects.get(newProjectId)?.supersedesProjectId).toBe('old');

    // 4. Provisioned at the same repository name and clone path, under its own identity.
    const newA = h.cp.residentProjects.allocation(runId)!;
    expect(newA).toMatchObject({projectId:newProjectId,repositoryIdentity:oldA.repositoryIdentity,clonePath:oldA.clonePath});
    expect(newA.repositoryNodeId).not.toBe(predecessor.nodeId);
    const newRoom = newA.roomId;const newPub = keyOf(newA.privateKeyFile);

    // One active room, the new one; the old room archived. The relay's own readback.
    const rooms = fake().rooms;
    expect(rooms.filter(r => !r.archived).map(r => r.channel_id)).toEqual([newRoom]);
    expect(rooms.filter(r => r.archived).map(r => r.channel_id)).toEqual([oldRoom]);
    expect(newRoom).not.toBe(oldRoom);
    // The new CTO has a new key: it owns the new room and is no member of the old one, and the old key is in neither.
    expect(readFileSync(newA.privateKeyFile,'utf8')).not.toBe(oldKey);
    expect(newPub).not.toBe(oldPub);
    const members = (id:string) => rooms.find(r => r.channel_id === id)!.members;
    expect(members(newRoom)).toContainEqual({pubkey:newPub,role:'owner'});
    expect(members(newRoom).map(m => m.pubkey)).not.toContain(oldPub);
    expect(members(oldRoom).map(m => m.pubkey)).not.toContain(newPub);

    // The superseding project's binding is the new room and key: roster route, entitlement, project row and its PRIMARY_CTO session.
    expect(roster().channels[newRoom]).toMatchObject({status:'active',acp_project_id:newProjectId,peer:{pubkey:newPub}});
    expect(new CanonicalSessionRegistry(h.cp.db).effective()).toEqual([{sessionUuid:newA.sessionUuid,projectId:newProjectId,buzzActorId:newPub,buzzAddress:newRoom}]);
    expect(h.cp.projects.get(newProjectId)?.buzzAddress).toBe(newRoom);
    const binding = h.cp.bindings.activePrimaryCto(newProjectId)!;
    expect(h.cp.sessions.get(binding.sessionId)).toMatchObject({buzzAddress:newRoom,buzzActorId:newPub});
    expect(h.cp.residentProjects.evidence(runId)).toMatchObject({claimSessionId:binding.sessionId,observations:{buzz:{roomId:newRoom,pubkey:newPub}}});

    // The old project's retired route is not reused: its roster entry is as retirement left it, its entitlement stays
    // revoked, no PRIMARY_CTO holds it, and the daemon no longer recognises its room as a provisioned one.
    expect(roster().channels[oldRoom]).toEqual(retiredRoute);
    expect(h.cp.db.get<{revoked_at:string|null}>(`SELECT revoked_at FROM canonical_session_entitlements WHERE project_id = 'old'`)?.revoked_at).toBeTruthy();
    expect(h.cp.bindings.activePrimaryCto('old')).toBeNull();
    expect(h.cp.projects.get('old')).toMatchObject({buzzAddress:oldRoom});
    expect(h.cp.projects.get('old')?.retiredAt).toBeTruthy();
    expect(existsSync(oldA.privateKeyFile)).toBe(false);
    expect(h.cp.residentProjects.confirmedRoom(oldRoom)).toBe(false);
    expect(h.cp.residentProjects.confirmedRoom(newRoom)).toBe(true);
  } finally {old.stop();h.cp.close();}
},180_000);
