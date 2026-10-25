#!/usr/bin/env node
// Version 1 host boundary. All paths are derived from HOME/ACP_STATE_DIR and a frozen allocation.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, realpathSync, rmSync, symlinkSync, readlinkSync, lstatSync, openSync, fsyncSync, closeSync, accessSync, constants, statSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import Database from 'better-sqlite3';
import { currentCanonicalCeoBuzzRoute, daemonBuzzSigner } from '../src/outbox/ceo-buzz-signer.ts';
import { canonicalJson } from '../src/core/digest.ts';
import { readProcessStartToken } from '../src/core/process-argv.ts';
const home = process.env.HOME;
const state = process.env.ACP_STATE_DIR;
class ProvisionerRefusal extends Error {}
class ProvisionerExecutionFailure extends Error {
  constructor(message, error) {super(message);this.stderr = error.stderr;}
}
let operation = 'unknown';
const check = (ok, why) => { if (!ok) throw new ProvisionerRefusal(why); };
const resolvedBinary = bin => {
  const name = bin.toUpperCase();
  // Match the launcher's nonempty operator pin, then its install-time answer. Never search PATH.
  const value = process.env[`ACP_${name}_BINARY`] || process.env[`ACP_RESOLVED_${name}_BINARY`];
  const why = reason => `${bin} in ${operation}: ${reason}`;
  check(value, why('missing binary variable'));
  check(isAbsolute(value), why('binary path is not absolute'));
  let target;
  try {target = realpathSync(value);} catch (error) {
    throw new ProvisionerRefusal(why(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'binary is missing' : 'binary is not executable'));
  }
  try {check(statSync(target).isFile(), why('binary is not an executable regular file'));accessSync(target,constants.X_OK);} catch (error) {
    if (error instanceof ProvisionerRefusal) throw error;
    throw new ProvisionerRefusal(why('binary is not executable'));
  }
  // Keep the stable install name: provider updaters may repoint it between operations.
  return value;
};
const run = (bin, args, opts = {}) => {
  const pinned = bin === 'buzz' || bin === 'claude';
  const executable = pinned ? resolvedBinary(bin) : bin;
  try {return execFileSync(executable, args, { encoding:'utf8', timeout:30_000, maxBuffer:2_000_000, stdio:['pipe','pipe','pipe'], ...opts });} catch (error) {
    if (!pinned) throw error;
    const reason = Number.isInteger(error.status) ? `non-zero exit with exit code ${error.status}` :
      error.code === 'ENOENT' ? 'binary is missing (ENOENT)' : error.code === 'EACCES' ? 'binary is not executable' :
      error.code === 'ETIMEDOUT' ? 'execution timed out' : 'execution failed';
    throw new ProvisionerExecutionFailure(`${bin} in ${operation}: ${reason}`,error);
  }
};
const json = (bin, args, opts) => JSON.parse(run(bin,args,opts));
const atomic = (path, body, mode = 0o600) => {
  mkdirSync(dirname(path),{recursive:true,mode:0o700}); const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp,'wx',mode);try {writeFileSync(fd,body);fsyncSync(fd);} finally {closeSync(fd);}
  renameSync(tmp,path);const dirfd = openSync(dirname(path),'r');try {fsyncSync(dirfd);} finally {closeSync(dirfd);}
};
const read = p => JSON.parse(readFileSync(p,'utf8'));
const lock = join(state ?? '/invalid','host-provisioner.lock');
let locked = false;
let ownLock = null;
let ceoSigner = false;
try {
  const req = JSON.parse(readFileSync(0,'utf8'));
  operation = req.operation;
  check(req.version === 1 && home && state, 'protocol');
  const a = req.allocation;
  ceoSigner = req.operation === 'ensure-buzz' && a?.mode === 'ceo-route-signer';
  const match = ceoSigner ? null : /^github:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(a.repositoryIdentity);
  const repoName = match?.[2];
  let routeDb = null;
  const currentCeo = () => {
    check(routeDb, 'CEO database unavailable');
    const route = currentCanonicalCeoBuzzRoute({all: (sql, params = []) => routeDb.prepare(sql).all(...params)});
    check(route && canonicalJson(route) === canonicalJson(a.route), 'current canonical CEO binding/room mismatch');
    return route;
  };
  if (ceoSigner) {
    check(process.env.ACP_HOST_DATABASE_PATH, 'CEO database path unavailable');
    routeDb = new Database(process.env.ACP_HOST_DATABASE_PATH, {readonly:true,fileMustExist:true});
    currentCeo();
    check(/^[a-f0-9-]{36}$/.test(a.route.roomId) && /^[a-f0-9]{64}$/.test(a.signer), 'CEO signer identity');
  } else {
    check(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(a.projectId), 'project id');
    check(match && match[2] !== '.' && match[2] !== '..', 'repository identity');
    check(req.operation === 'retire' ? a.clonePath.startsWith(home+'/') && resolve(a.clonePath) === a.clonePath : a.clonePath === join(home,'projects',repoName), 'clone path');
    check(a.privateKeyFile === join(home,'.hermes','bridge','keys',`${a.identityName}.priv`) && a.identityName === `cto-${a.projectId}`, 'key path');
    check(a.bootPacket === join(home,'.claude','watchers','fleet',`${a.fleetName}.boot.txt`) && a.fleetName === `acp-${a.projectId}`, 'fleet path');
    check(a.socketPath === join(state,`cc-session-${a.projectId}.sock`) && a.tmuxName === `acp-${Buffer.from(a.projectId).toString("hex")}`, 'runtime path');
    check(/^[a-f0-9-]{36}$/.test(a.sessionUuid) && /^[a-f0-9-]{36}$/.test(a.roomId) && /^[a-f0-9]{40}$/.test(a.head), 'allocation identity');
  }
  mkdirSync(state,{recursive:true,mode:0o700});
  // The owner record is complete before its symlink is claimed; SIGKILL cannot leave an ownerless lock.
  ownLock = join(state,`.host-provisioner-${process.pid}-${randomUUID()}`);
  mkdirSync(ownLock,{mode:0o700});
  atomic(join(ownLock,'owner.json'),JSON.stringify({pid:process.pid,start:readProcessStartToken(process.pid)}));
  try {symlinkSync(ownLock,lock);} catch {
    const owner = read(join(lock,'owner.json'));
    let dead = false;try {process.kill(owner.pid,0);} catch(e) {dead = e.code === 'ESRCH';}
    const start = readProcessStartToken(owner.pid);
    check(dead || (start !== null && owner.start !== null && start !== owner.start),'provisioner busy');
    check(lstatSync(lock).isSymbolicLink(),'unrecognized provisioner lock');
    rmSync(lock);symlinkSync(ownLock,lock);
  }
  locked = true;
  const origin = ceoSigner ? null : `https://github.com/${match[1]}/${repoName}.git`;
  const identityFile = ceoSigner ? null : join(a.clonePath,'.git','acp-repository.json');
  // Git's own HEAD, never the allocation's: a commit merely present proves nothing about what the CTO's
  // checkout holds. Nothing here ever resets, cleans, stashes or checks out.
  // `bootstrap` — activation's requirement until a resident of this allocation has been observed on
  // it: attached to dev, clean, exactly at the approved genesis head.
  // `development` — once the CTO owns the clone (fleet recovery, and activation passes after that
  // observation): the project's own clone whose HEAD's history contains the approved genesis head, in
  // any working state — uncommitted or untracked edits, any branch, or a detached HEAD (a CTO may
  // detach to bisect or inspect) — all preserved as they are.
  const checkoutRequirement = req.operation === 'ensure-resident' || a.checkoutRequirement === 'development' ? 'development' : 'bootstrap';
  check(a.checkoutRequirement === undefined || a.checkoutRequirement === 'development','checkout requirement');
  const checkout = (requirement) => {
    check(existsSync(identityFile),'clone receipt missing');
    const identity = read(identityFile);
    check(identity.projectId === a.projectId && identity.nodeId === a.repositoryNodeId && identity.origin === origin,'clone identity conflict');
    check(run('git',['remote','get-url','origin'],{cwd:a.clonePath}).trim() === origin,'clone origin conflict');
    check(realpathSync(a.clonePath) === a.clonePath,'clone path alias');
    check(run('git',['cat-file','-t',a.head],{cwd:a.clonePath}).trim() === 'commit','genesis absent');
    const head = run('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:a.clonePath}).trim();
    if (requirement === 'bootstrap') {
      let branch = null;
      try {branch = run('git',['symbolic-ref','--quiet','--short','HEAD'],{cwd:a.clonePath}).trim() || null;} catch(e) {if (e.status !== 1) throw e;}
      check(branch !== null,'clone checkout is detached');
      check(run('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:a.clonePath}).trim() === '','clone checkout has uncommitted changes');
      check(branch === 'dev' && head === a.head,'clone is not on dev at the approved genesis head');
    } else {
      let contains = head === a.head;
      if (!contains) {try {run('git',['merge-base','--is-ancestor',a.head,head],{cwd:a.clonePath});contains = true;} catch(e) {if (e.status !== 1) throw e;}}
      check(contains,'clone checkout does not build on the approved genesis head');
    }
    return {path:a.clonePath,origin,head,repositoryNodeId:a.repositoryNodeId};
  };
  const buzzEnv = () => ({...process.env,BUZZ_IDENTITY:a.identityName,BUZZ_PRIVATE_KEY:readFileSync(a.privateKeyFile,'utf8').trim()});
  const buzz = args => json('buzz',args,{env:buzzEnv()});
  const pub = () => getPublicKey(Buffer.from(readFileSync(a.privateKeyFile,'utf8').trim(),'hex'));
  const pubFile = ceoSigner ? null : a.privateKeyFile.replace(/\.priv$/,'.pub');
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  const ensureRouting = roomId => {
    const pk = pub(); const ceo = readFileSync(join(home,'.hermes','bridge','keys','ceo2.pub'),'utf8').trim();
    const roster = existsSync(rosterFile) ? read(rosterFile) : {version:2,generation:0,channels:{}};
    check(roster.version === 2 && Number.isInteger(roster.generation),'roster v2 required');
    const desired = {relay_name:process.env.ACP_BUZZ_RELAY_NAME ?? 'production',ceo:{pubkey:ceo,handle:process.env.ACP_CEO_BUZZ_HANDLE ?? 'ceo2'},peer:{pubkey:pk,handle:a.identityName},acp_project_id:a.projectId,status:'active',classification:'project'};
    const old = roster.channels[roomId];
    check(!old || (old.acp_project_id === a.projectId && old.peer.pubkey === pk && old.status !== 'retired'),'route conflict');
    if (canonicalJson(old ?? null) !== canonicalJson(desired)) { roster.channels[roomId] = desired; roster.generation++; atomic(rosterFile,JSON.stringify(roster,null,2)+'\n'); }
    return {generation:read(rosterFile).generation,roomId};
  };
  const fleetFile = join(home,'.claude','watchers','fleet','manifest.tsv');
  const sessionFile = join(state,`resident-${a.projectId}.json`);
  const namesSession = command => new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${a.sessionUuid}(?:\\s|$)`).test(command);
  const observeResident = (needsRc = true) => {
    const pane = run('tmux',['display-message','-p','-t',a.tmuxName,'#{pane_pid}']).trim();
    const lines = run('ps',['-axo','pid=,ppid=,lstart=,command=']).split('\n');
    const rows = lines.map(line => /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line)).filter(Boolean);
    const candidates = rows.filter(r => namesSession(r[4]));
    check(candidates.length === 1,'resident process missing or duplicated');
    const r = candidates[0]; let parent = r[1]; const seen = new Set();
    while (parent !== pane && !seen.has(parent)) { seen.add(parent); parent = rows.find(x => x[1] === parent)?.[2]; check(parent,'tmux ancestry missing'); }
    check(parent === pane,'tmux ancestry mismatch');
    const pid = Number(r[1]); process.kill(pid,0);
    const cwd = run('lsof',['-a','-p',String(pid),'-d','cwd','-Fn']).split('\n').find(l => l.startsWith('n'))?.slice(1);
    check(cwd === a.clonePath,'resident cwd mismatch');
    let rc = {}; try {rc = read(join(home,'.claude','sessions',`${pid}.json`));} catch {check(!needsRc,'RC record missing');}
    check((rc.sessionId ?? rc.sessionUuid ?? rc.session_id) === a.sessionUuid && rc.cwd === cwd,'session registry UUID/cwd mismatch');
    if (needsRc) check(typeof rc.bridgeSessionId === 'string' && rc.bridgeSessionId.length > 0,'RC not registered');
    const resident = {pid,startedAt:readProcessStartToken(pid),cwd,sessionUuid:a.sessionUuid,tmuxName:a.tmuxName,tmuxAncestry:true,bridgeSessionId:rc.bridgeSessionId ?? "retirement"};
    check(resident.startedAt,'native process start token unavailable');
    atomic(sessionFile,JSON.stringify(resident)); return resident;
  };
  let result = {};
  switch(req.operation) {
    case 'ensure-checkout': {
      check(run('gh',['api',`repos/${match[1]}/${repoName}`,'--jq','.node_id']).trim() === a.repositoryNodeId,'GitHub repository identity changed');
      if (!existsSync(a.clonePath)) {
        mkdirSync(dirname(a.clonePath),{recursive:true});
        run('git',['clone','--',origin,a.clonePath]);
        atomic(identityFile,JSON.stringify({projectId:a.projectId,nodeId:a.repositoryNodeId,origin}));
      }
      if (!existsSync(identityFile)) {
        check(run('git',['remote','get-url','origin'],{cwd:a.clonePath}).trim() === origin,'unreceipted clone origin conflict');
        check(run('git',['cat-file','-t',a.head],{cwd:a.clonePath}).trim() === 'commit','unreceipted clone genesis mismatch');
        atomic(identityFile,JSON.stringify({projectId:a.projectId,nodeId:a.repositoryNodeId,origin}));
      }
      // No reset, clean or checkout is ever run here, including crash recovery.
      result = {checkout:checkout(checkoutRequirement)}; break;
    }
    case 'ensure-buzz': {
      if (ceoSigner) {
        // Never load a CEO/CTO key. The environment is the daemon's own sending identity.
        const signer = daemonBuzzSigner(process.env.BUZZ_PRIVATE_KEY);
        check(signer, 'daemon signer unavailable');
        check(signer === a.signer, 'daemon sending signer mismatch');
        const route = currentCeo();
        const room = json('buzz',['channels','get','--channel',route.roomId]);
        check(room.channel_id === route.roomId, 'CEO room identity mismatch');
        const members = () => {
          const value = json('buzz',['channels','members','--channel',route.roomId]);
          check(Array.isArray(value) && value.every(m => /^[a-f0-9]{64}$/.test(m.pubkey) && ['owner','admin','member'].includes(m.role)), 'invalid CEO roster');
          check(new Set(value.map(m => m.pubkey)).size === value.length, 'ambiguous CEO roster');
          return value;
        };
        const before = members();
        check(before.some(m => m.pubkey === route.recipient), 'bound CEO absent from room');
        const changed = !before.some(m => m.pubkey === signer);
        currentCeo(); // Revalidate immediately before the only possible write.
        if (changed) run('buzz',['channels','add-member','--channel',route.roomId,'--pubkey',signer,'--role','member']);
        const after = members();
        const old = before.map(canonicalJson).sort();
        const retained = after.filter(m => m.pubkey !== signer || before.some(b => b.pubkey === signer)).map(canonicalJson).sort();
        check(canonicalJson(old) === canonicalJson(retained) && after.length === before.length + Number(changed) &&
          after.some(m => m.pubkey === signer && (!changed || m.role === 'member')), 'CEO roster readback mismatch');
        check(canonicalJson(room) === canonicalJson(json('buzz',['channels','get','--channel',route.roomId])), 'CEO room policy changed');
        currentCeo();
        result = {ceoBuzzSigner:{route,signer,changed,rosterVerified:true}};
        routeDb.close();
        break;
      }
      if (!existsSync(a.privateKeyFile)) atomic(a.privateKeyFile,Buffer.from(generateSecretKey()).toString('hex')+'\n');
      check(lstatSync(a.privateKeyFile).isFile() && !lstatSync(a.privateKeyFile).isSymbolicLink(),'key must be a regular file');
      chmodSync(a.privateKeyFile,0o600); const pk = pub();
      if (existsSync(pubFile)) check(readFileSync(pubFile,'utf8').trim() === pk,'public key conflict'); else atomic(pubFile,pk+'\n');
      chmodSync(pubFile,0o600);
      const admission = process.env.ACP_BUZZ_ADMISSION_COMMAND ? JSON.parse(process.env.ACP_BUZZ_ADMISSION_COMMAND) : [join(home,'.orbstack','bin','docker'),'exec','buzz-prod-relay-1','buzz-admin','add-member'];
      check(Array.isArray(admission) && admission.every(x => typeof x === 'string'),'admission config');
      run(admission[0],[...admission.slice(1),'--pubkey',pk,'--role','member']);
      buzz(['users','set-profile','--name',a.identityName]);
      const profiles = buzz(['users','get','--pubkey',pk]);
      check(Array.isArray(profiles) && profiles.some(p => p.pubkey === pk && (p.name === a.identityName || p.profile?.name === a.identityName || p.display_name === a.identityName)),'profile readback mismatch');
      const intentFile = join(state,`buzz-room-${a.projectId}.json`);
      // The intent predates creation, including when the relay's response is lost.
      const intended = {name:a.roomName ?? a.projectId,pubkey:pk,runId:a.runId};
      if (!existsSync(intentFile)) atomic(intentFile,JSON.stringify(intended));
      const intent = read(intentFile);
      check(intent.name === intended.name && intent.pubkey === pk && intent.runId === a.runId,'room intent conflict');
      const ownedRooms = () => {
        const channels = buzz(['channels','search','--query',intent.name,'--exact']);
        check(Array.isArray(channels),'invalid channel search');
        return channels.filter(c => c.name === intent.name && buzz(['channels','members','--channel',c.channel_id ?? c.id]).some(m => m.pubkey === pk && m.role === 'owner'));
      };
      let owned = ownedRooms();
      check(owned.length <= 1,'ambiguous owned room');
      if (!owned.length) {
        check(!intent.roomId,'persisted room disappeared');
        buzz(['channels','create','--name',intent.name,'--type','stream','--visibility','private']);
        owned = ownedRooms();
      }
      check(owned.length === 1,'room readback missing or ambiguous');
      const room = owned[0]; const roomId = room.channel_id ?? room.id;
      check(/^[a-f0-9-]{36}$/.test(roomId) && (!intent.roomId || intent.roomId === roomId) && room.name === intent.name && room.visibility === 'private' && (room.channel_type ?? room.type) === 'stream','room mismatch');
      atomic(intentFile,JSON.stringify({...intent,roomId}));
      const owner = readFileSync(join(home,'.hermes','bridge','keys','owner.pub'),'utf8').trim();
      const ceo = readFileSync(join(home,'.hermes','bridge','keys','ceo2.pub'),'utf8').trim();
      const expectedMembers = [[pk,'owner'],[owner,'owner'],[ceo,'admin']];
      const before = buzz(['channels','members','--channel',roomId]);
      check(before.every(m => expectedMembers.some(([key,role]) => m.pubkey === key && m.role === role)),'existing room membership roles conflict');
      for (const [key,role] of [[owner,'owner'],[ceo,'admin']]) buzz(['channels','add-member','--channel',roomId,'--pubkey',key,'--role',role]);
      const members = buzz(['channels','members','--channel',roomId]);
      check(members.length === 3 && [[pk,'owner'],[owner,'owner'],[ceo,'admin']].every(([key,role]) => members.some(m => m.pubkey === key && m.role === role)),'room roster mismatch');
      ensureRouting(roomId);
      const nonce = `acp-provision:${a.nonce}`;
      let posts = buzz(['messages','get','--channel',roomId,'--limit','100']);
      if (!posts.some(m => m.content === nonce && m.pubkey === pk)) { run('buzz',['messages','send','--channel',roomId,'--content',nonce],{env:buzzEnv()}); posts = buzz(['messages','get','--channel',roomId,'--limit','100']); }
      const post = posts.find(m => m.content === nonce && m.pubkey === pk); check(post?.id,'nonce unreadable');
      result = {buzz:{pubkey:pk,roomId:roomId,rosterVerified:true,nonceEventId:post.id,nonceReadable:true}}; break;
    }
    case 'ensure-routing': {
      result = {routing:ensureRouting(a.roomId)}; break;
    }
    case 'ensure-resident': {
      // Also the fleet watcher's recovery path after a CTO dies: it relaunches over unfinished work.
      const observedCheckout = checkout(checkoutRequirement);
      run(join(home,'.claude','scripts','claude-trust-dir.sh'),[a.clonePath]);
      const runtimeNode = join(state,'current','dist','bin','node');
      const runtimeCli = join(state,'current','dist','cli','agentctl.js');
      const runtimeUnavailable = 'agentctl runtime unavailable in ensure-resident';
      try {
        check(statSync(runtimeNode).isFile() && statSync(runtimeCli).isFile(),runtimeUnavailable);
        accessSync(runtimeNode,constants.X_OK);
      } catch {throw new ProvisionerRefusal(runtimeUnavailable);}
      const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const mcpMatches = text => text.includes('acp-cto')
        && new RegExp(`(?:^|\\s)${escaped(runtimeNode)}\\s+(?:Args:\\s+)?${escaped(runtimeCli)}\\s+attach\\s+resident-cto(?:\\s|$)`).test(text)
        && new RegExp(`--claimed-session-id\\s+${escaped(a.sessionUuid)}(?:\\s|$)`).test(text)
        && new RegExp(`--project-id\\s+${escaped(a.projectId)}(?:\\s|$)`).test(text);
      let currentMcp = ''; try {currentMcp = run('claude',['mcp','get','acp-cto'],{cwd:a.clonePath});} catch {}
      if (!mcpMatches(currentMcp)) {
        if (currentMcp) run('claude',['mcp','remove','--scope','local','acp-cto'],{cwd:a.clonePath});
        run('claude',['mcp','add','--scope','local','acp-cto','--',runtimeNode,runtimeCli,'attach','resident-cto','--claimed-session-id',a.sessionUuid,'--project-id',a.projectId],{cwd:a.clonePath});
      }
      check(mcpMatches(run('claude',['mcp','get','acp-cto'],{cwd:a.clonePath})),'MCP readback mismatch');
      atomic(join(dirname(a.bootPacket),`${a.fleetName}.resident.json`),JSON.stringify({allocation:a,packet:req.packet}));
      atomic(a.bootPacket,JSON.stringify({schema:"acp.resident-boot.v1",projectId:a.projectId,sessionUuid:a.sessionUuid,roomId:a.roomId,identity:{name:a.identityName,pubkey:pub()},attachment:{stateDir:state,socketPath:a.socketPath},approvedPackage:req.packet},null,2)+'\n');
      const line = [a.fleetName,a.clonePath,`${a.projectId} CTO`,a.bootPacket,a.sessionUuid].join('\t');
      const lines = existsSync(fleetFile) ? readFileSync(fleetFile,'utf8').trimEnd().split('\n').filter(Boolean) : [];
      const existing = lines.find(l => l.split('\t')[0] === a.fleetName); check(!existing || existing === line,'fleet entry conflict');
      if (!existing) atomic(fleetFile,[...lines,line].join('\n')+'\n');
      let alive = false; try { observeResident(); alive = true; } catch { /* A tmux shell alone is never health. */ }
      if (!alive) {
        const marker = join(state,`launched-${a.projectId}`);
        const launcher = join(state,`resident-${a.projectId}.sh`);
        const quote = v => `'${String(v).replaceAll("'", "'\\''")}'`;
        const args = [resolvedBinary('claude'),'--model','opus',(existsSync(sessionFile) || existsSync(join(home,'.claude','projects',a.clonePath.replaceAll('/','-'),`${a.sessionUuid}.jsonl`))) ? '--resume' : '--session-id',a.sessionUuid,'--name',`${a.projectId} CTO`,'--remote-control',`${a.projectId} CTO`,'--messaging-socket-path',a.socketPath,'--permission-mode','bypassPermissions','--dangerously-skip-permissions',`You are ${a.projectId} CTO. Connect to acp-cto, read role_dispatch_pending, and acknowledge the bootstrap handoff with handoff_ack. The handoff contains the approved genesis bytes and product intent.`];
        atomic(launcher,`#!/bin/sh\nunset ACP_OPERATOR_TOKEN ACP_MCP_TOKEN ACP_BUZZ_INGRESS_SECRET GH_TOKEN GITHUB_TOKEN\nexport ACP_STATE_DIR=${quote(state)}\nBUZZ_PRIVATE_KEY=$(cat ${quote(a.privateKeyFile)}) || exit 1\nexport BUZZ_PRIVATE_KEY\ncd ${quote(a.clonePath)} || exit 1\nexec ${args.map(quote).join(' ')}\n`,0o700);
        // Refuse a duplicate Claude even when RC is still registering. Never kill an unverified pane.
        const ps = run('ps',['-axo','command=']); check(!ps.split('\n').some(l => namesSession(l)),'resident awaits RC');
        let hasPane = false;try {run('tmux',['has-session','-t',a.tmuxName]);hasPane = true;} catch(e) {if (!e.status) throw e;}
        if (hasPane) {
          const pane = run('tmux',['display-message','-p','-t',a.tmuxName,'#{pane_current_path}\t#{pane_start_command}']).trim();
          check(pane === `${a.clonePath}\t${launcher}`,'unverified tmux pane cannot be replaced');
          run('tmux',['kill-session','-t',a.tmuxName]);
        }
        atomic(marker,a.sessionUuid); run('tmux',['new-session','-d','-s',a.tmuxName,launcher]);
      }
      result = {fleet:true,checkout:observedCheckout,resident:observeResident()}; break;
    }
    // Activation's readback: the bootstrap requirement holds until the CTO has been observed on the clone.
    case 'observe': result = {checkout:checkout(checkoutRequirement),resident:observeResident()}; break;
    case 'retire': {
      rmSync(join(dirname(a.bootPacket),`${a.fleetName}.resident.json`),{force:true});
      if (existsSync(rosterFile)) { const roster = read(rosterFile); const route = roster.channels[a.roomId]; if (route && route.status !== 'retired') { check(route.acp_project_id === a.projectId,'retirement route conflict'); route.status = 'retired'; roster.generation++; atomic(rosterFile,JSON.stringify(roster,null,2)+'\n'); } }
      if (existsSync(fleetFile)) atomic(fleetFile,readFileSync(fleetFile,'utf8').split('\n').filter(l => {const f=l.split('\t');return f[0] !== a.fleetName && !(f[1] === a.clonePath && f[4] === a.sessionUuid);}).join('\n'));
      // Only a fully verified Claude incarnation may be stopped. A missing process needs no signal.
      let resident;
      if (a.retirementPin) {
        const pin = a.retirementPin;const token = readProcessStartToken(pin.pid);
        if (token === pin.startedAt) {
          const command = run('ps',['-p',String(pin.pid),'-o','command=']);
          const cwd = run('lsof',['-a','-p',String(pin.pid),'-d','cwd','-Fn']).split('\n').find(l => l.startsWith('n'))?.slice(1);
          const rc = read(join(home,'.claude','sessions',`${pin.pid}.json`));
          check(namesSession(command) && cwd === a.clonePath && (rc.sessionId ?? rc.sessionUuid ?? rc.session_id) === a.sessionUuid && rc.cwd === cwd,'retirement process identity mismatch');
          resident={pid:pin.pid,startedAt:pin.startedAt};
        } else if (token !== null) throw new Error('retirement PID was reused');
      }
      try {resident ??= observeResident(false);} catch {
        check(!run('ps',['-axo','command=']).split('\n').some(l => namesSession(l)),'project process exists but retirement cannot verify it');
      }
      if (resident) {
        process.kill(resident.pid,'SIGTERM');
        for (let i = 0;i < 100 && readProcessStartToken(resident.pid) === resident.startedAt;i++) await new Promise(r => setTimeout(r,100));
        check(readProcessStartToken(resident.pid) !== resident.startedAt,'resident did not stop');
      }
      const archive = join(home,'projects','.retired',`${repoName}-${a.projectId}`);
      if (existsSync(a.clonePath)) {
        check(!existsSync(archive),'retirement archive already exists alongside clone');
        const remote = run('git',['remote','get-url','origin'],{cwd:a.clonePath}).trim();
        check([origin,`git@github.com:${match[1]}/${repoName}.git`].includes(remote),'retirement clone origin mismatch');
        mkdirSync(dirname(archive),{recursive:true,mode:0o700});renameSync(a.clonePath,archive);
      }
      result = {retired:true,...(existsSync(archive) ? {retirementArchivePath:archive} : {})}; break;
    }
    default: throw new Error('unknown operation');
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (ceoSigner) {
    let failure = {outcome:'LOST',code:'host_response_unknown',message:error instanceof ProvisionerExecutionFailure ? error.message : 'host provisioning outcome unknown'};
    if (error instanceof ProvisionerRefusal) failure = {outcome:'INVALID',code:'host_verification_failed',message:error.message};
    else {
      try {
        const refusal = JSON.parse(String(error.stderr).trim());
        if (typeof refusal.error === 'string' && typeof refusal.message === 'string' && refusal.retryable === false)
          failure = {outcome:'REFUSED',code:refusal.error,message:refusal.message};
      } catch { /* No precise relay refusal was received. */ }
    }
    process.stderr.write(JSON.stringify({ceoBuzzSignerFailure:failure}));
  } else process.stderr.write(`host project provisioner refused operation${error instanceof ProvisionerRefusal || error instanceof ProvisionerExecutionFailure ? ': '+error.message : ''}\n`);
  process.exitCode = 1;
}
finally {if (locked && readlinkSync(lock) === ownLock) rmSync(lock,{force:true});if (ownLock) rmSync(ownLock,{recursive:true,force:true});}
