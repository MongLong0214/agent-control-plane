#!/usr/bin/env node
// Version 1 host boundary. All paths are derived from HOME/ACP_STATE_DIR and a frozen allocation.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, realpathSync, rmSync, symlinkSync, readlinkSync, lstatSync, openSync, fsyncSync, closeSync, accessSync, constants, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import Database from 'better-sqlite3';
import { currentCanonicalCeoBuzzRoute, daemonBuzzSigner } from '../src/outbox/ceo-buzz-signer.ts';
import { canonicalJson } from '../src/core/digest.ts';
import { readProcessStartToken } from '../src/core/process-argv.ts';
const home = process.env.HOME;
const state = process.env.ACP_STATE_DIR;
class ProvisionerRefusal extends Error {}
/** A retirement that cannot go ahead yet; the caller is told the order that lets it (#1229). */
class RetirementOrderRefusal extends ProvisionerRefusal {
  constructor(message, requiredOrder) {super(message);this.requiredOrder = requiredOrder;}
}
class ProvisionerExecutionFailure extends Error {
  constructor(message, error) {super(message);this.stderr = error.stderr;}
}
let operation = 'unknown';
// #1229 — set just before retire's first host write: a failure before it leaves the host exactly as it was.
let hostChanged = false;
let rerun = 'run agentctl project retire again';
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
    check(['retire','verify-retire'].includes(req.operation) ? a.clonePath.startsWith(home+'/') && resolve(a.clonePath) === a.clonePath : a.clonePath === join(home,'projects',repoName), 'clone path');
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
  const buzzEnv = (keyFile = a.privateKeyFile) => ({...process.env,BUZZ_IDENTITY:a.identityName,BUZZ_PRIVATE_KEY:readFileSync(keyFile,'utf8').trim()});
  const buzz = (args, keyFile) => json('buzz',args,{env:buzzEnv(keyFile)});
  const pub = () => getPublicKey(Buffer.from(readFileSync(a.privateKeyFile,'utf8').trim(),'hex'));
  const pubFile = ceoSigner ? null : a.privateKeyFile.replace(/\.priv$/,'.pub');
  // The active rooms under `name` for which `holds(roomId)`, asked as the key in `keyFile`: this identity's path, or a key
  // of this run moved aside with its records (#1251 C6).
  const roomsUnder = (name, keyFile, holds) => {
    const channels = buzz(['channels','search','--query',name,'--exact'],keyFile);
    check(Array.isArray(channels),'invalid channel search');
    return channels.filter(c => c.name === name && holds(c.channel_id ?? c.id));
  };
  const memberOf = (room, keyFile, member) => buzz(['channels','members','--channel',room],keyFile).some(member);
  // The rooms under `name` that `pk` owns: how ensure-buzz finds the room it created.
  const ownedRooms = (name, pk, keyFile) => roomsUnder(name,keyFile,room => memberOf(room,keyFile,m => m.pubkey === pk && m.role === 'owner'));
  // #1251 C8 — retirement's view of the rooms a key of this run may have left active: the room recorded for it, and every
  // active room under its name that key is in, as owner or any other role. A key that lost ownership proves nothing about
  // the room's archive; only no active room here settles it.
  const activeRooms = (name, pk, keyFile, recorded) => roomsUnder(name,keyFile,room => room === recorded || memberOf(room,keyFile,m => m.pubkey === pk));
  const rosterFile = join(home,'.hermes','bridge','required-mentions.json');
  // Mirror canonical_roster.py's version-specific room rules before publishing a roster.
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validateRoster = roster => {
    const v1 = roster.version === undefined || roster.version === 1;
    const hex64 = value => typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value);
    const handle = value => typeof value === 'string' && value.length > 0 && !/[^A-Za-z0-9_-]/.test(value);
    const identity = value => object(value) && hex64(value.pubkey) && handle(value.handle);
    for (const [roomId, room] of Object.entries(roster.channels)) {
      check(roomId.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(roomId),'invalid roster room UUID');
      check(object(room) && identity(room.ceo) && identity(room.peer) && room.ceo.pubkey !== room.peer.pubkey,'invalid roster identities');
      check(['active','retired'].includes(v1 && room.status === undefined ? 'active' : room.status),'invalid roster status');
      if (!v1) check(room.ceo.handle === 'ceo' && ['relay_name','acp_project_id','classification'].every(key => typeof room[key] === 'string'),'invalid roster v2 room');
    }
    const known = v1 && roster.known_profiles !== undefined ? roster.known_profiles : {};
    check(object(known) && Object.entries(known).every(([name,key]) => handle(name) && hex64(key)),'invalid roster known profiles');
  };
  // The room's CEO is the current canonical CEO binding's Buzz actor, never a key file or handle string.
  const canonicalCeoKey = () => {
    check(process.env.ACP_HOST_DATABASE_PATH, 'CEO database path unavailable');
    const db = new Database(process.env.ACP_HOST_DATABASE_PATH, {readonly:true,fileMustExist:true});
    try {
      const route = currentCanonicalCeoBuzzRoute({all: (sql, params = []) => db.prepare(sql).all(...params)});
      check(route && /^[a-f0-9]{64}$/.test(route.recipient), 'current canonical CEO binding unavailable');
      return route.recipient;
    } finally {db.close();}
  };
  // The policy wrapper's CEO handle in every room; v2 requires it and the live v1 rooms use it.
  const ceoHandle = 'ceo';
  const ensureRouting = (roomId, ceo = canonicalCeoKey()) => {
    const pk = pub();
    const rosterBytes = existsSync(rosterFile) ? readFileSync(rosterFile,'utf8') : null;
    const roster = rosterBytes === null ? {version:2,generation:0,channels:{}} : JSON.parse(rosterBytes);
    check(object(roster) && object(roster.channels),'invalid roster channels');
    const v1 = roster.version === undefined || roster.version === 1;
    check(v1 || (roster.version === 2 && Number.isInteger(roster.generation)),'invalid roster version or generation');
    const desired = {relay_name:process.env.ACP_BUZZ_RELAY_NAME ?? 'production',ceo:{pubkey:ceo,handle:ceoHandle},peer:{pubkey:pk,handle:a.identityName},acp_project_id:a.projectId,status:'active',classification:v1 ? 'current project' : 'project'};
    const old = roster.channels[roomId];
    check(!old || (old.acp_project_id === a.projectId && old.peer?.pubkey === pk && old.status !== 'retired'),'route conflict');
    const changed = canonicalJson(old ?? null) !== canonicalJson(desired);
    if (changed) { roster.channels[roomId] = desired; if (!v1) roster.generation++; }
    validateRoster(roster);
    if (changed) {
      // Other writers hold no shared lock: refuse rather than overwrite a roster that changed since it was read.
      check((existsSync(rosterFile) ? readFileSync(rosterFile,'utf8') : null) === rosterBytes,'roster changed concurrently');
      atomic(rosterFile,JSON.stringify(roster,null,2)+'\n');
    }
    return {...(v1 ? {} : {generation:read(rosterFile).generation}),roomId};
  };
  // #1230 — the CTO's Buzz identity on this host: its key pair, the room intent and the record of the run that minted
  // the key. Moved aside together into a fresh 0700 directory, never deleted and never overwritten.
  const intentFile = ceoSigner ? null : join(state,`buzz-room-${a.projectId}.json`);
  const keyProvenanceFile = ceoSigner ? null : join(state,`buzz-key-${a.projectId}.json`);
  const moveIdentityAside = () => {
    const present = [a.privateKeyFile,pubFile,intentFile,keyProvenanceFile].filter(file => existsSync(file));
    if (!present.length) return null;
    const parent = join(state,'retired-buzz-identities');
    const archive = join(parent,`${a.identityName}.${new Date().toISOString().replace(/[:.]/g,'-')}.${randomUUID().slice(0,8)}`);
    mkdirSync(archive,{recursive:true,mode:0o700});chmodSync(parent,0o700);chmodSync(archive,0o700);
    for (const file of present) renameSync(file,join(archive,basename(file)));
    for (const dir of [archive,...new Set(present.map(dirname))]) {const fd = openSync(dir,'r');try {fsyncSync(fd);} finally {closeSync(fd);}}
    return archive;
  };
  // #1230 — a key at this identity's path is this run's only when its key record or its room intent names this run and
  // this key, or the roster binds it to this project on an active route. ensure-buzz moves any other key aside before
  // it mints; retirement never finds or archives a room with one (#1251 C5-1).
  const keyOfThisRun = pk => {
    const roster = existsSync(rosterFile) ? read(rosterFile) : {channels:{}};
    check(object(roster) && object(roster.channels),'invalid roster channels');
    const names = file => {
      if (!existsSync(file)) return false;
      const record = read(file);
      return object(record) && record.runId === a.runId && record.pubkey === pk;
    };
    return names(keyProvenanceFile) || names(intentFile) ||
      Object.values(roster.channels).some(room => object(room) && room.acp_project_id === a.projectId && room.peer?.pubkey === pk && room.status !== 'retired');
  };
  const fleetFile = join(home,'.claude','watchers','fleet','manifest.tsv');
  const sessionFile = join(state,`resident-${a.projectId}.json`);
  const namesSession = command => new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${a.sessionUuid}(?:\\s|$)`).test(command);
  const observeResident = (needsRc = true, record = true) => {
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
    if (record) atomic(sessionFile,JSON.stringify(resident));
    return resident;
  };
  // #1229 — everything retirement must know before it changes anything: the CTO process, the roster route, the clone
  // and the Buzz room (#1230). Read only. verify-retire asks it alone, before the daemon suspends, records or revokes
  // anything; retire asks it again before its first host write, so a change in between is refused with nothing written.
  // Every refusal here names the order that lets retirement complete; nothing here stops a process it could not verify.
  rerun = `run agentctl project retire ${a.projectId} again`;
  const refuseWithOrder = (why, ...steps) => {throw new RetirementOrderRefusal(why,[...steps,rerun]);};
  // #1251 C-P2 — an `unbound` allocation: ensure-buzz stopped before the daemon recorded the room it verified, so the
  // allocation's room id is a placeholder that names no room. Retirement takes the room ensure-buzz itself would find:
  // this run's room intent, else the one active room under the intended name this run's key is in, as owner or not (C8). With this run's key and no
  // such room there is none: the intent is written before any creation, and only this key creates the room. Once this
  // run's retirement has finished, its identity has been moved aside (retire's last host step), and the room it settled
  // is the one that identity's intent names. `record` is the room id the unfinished intent never received.
  // #1251 C5 — `pk` is this run's key at the path, the only key retirement looks a room up or archives it with. Any
  // other key there is never used (C5-1). Without this run's key, a room intent of this run says a room may exist and
  // `missing` is how to put that key back; with no intent of this run anywhere on the host, this run created no room:
  // ensure-buzz writes that intent, naming this run and its key, before any creation, and nothing deletes one. A run
  // refused before it minted a key is that case, so no key that never existed is ever asked for (C5-2).
  // #1251 C6 — an identity of this run moved aside is found by its own key record or room intent, whether or not its key
  // is still with it; a key there is used only when it is the key those records name. Its intent says a room may exist,
  // and only that key can say none does: with it retirement looks the room up, without it retirement refuses.
  const ofThisRun = (record, pk) => object(record) && record.runId === a.runId && record.pubkey === pk;
  // Every identity of this run moved aside, found by its key record or room intent; `keyFile` only when its key is the one they name.
  const movedOfThisRun = () => {
    const parent = join(state,'retired-buzz-identities');
    const readIn = (dir, file) => {try {return read(join(dir,basename(file)));} catch {return null;}};
    return (existsSync(parent) ? readdirSync(parent) : []).filter(name => name.startsWith(`${a.identityName}.`)).sort().flatMap(name => {
      const dir = join(parent,name);const records = [readIn(dir,keyProvenanceFile),readIn(dir,intentFile)];
      const pubkey = records.find(record => object(record) && record.runId === a.runId && typeof record.pubkey === 'string')?.pubkey;
      if (pubkey === undefined) return [];
      const keyFile = join(dir,basename(a.privateKeyFile));
      let key = null;try {key = getPublicKey(Buffer.from(readFileSync(keyFile,'utf8').trim(),'hex'));} catch { /* Its key is not with it. */ }
      return [{dir,pubkey,intent:ofThisRun(records[1],pubkey) ? records[1] : null,keyFile:key === pubkey ? keyFile : null}];
    });
  };
  // The active rooms of an intent (activeRooms, with its own key); null when that key is not here to look with.
  const roomsOf = m => m.keyFile === null ? null : activeRooms(m.intent.name,m.pubkey,m.keyFile,m.intent.roomId).map(room => room.channel_id ?? room.id);
  // Before retirement settles its own room, each earlier key of this run moved aside with its intent settles the room it
  // may have created: without that key, or with that room still active, retirement refuses before any host write.
  // `settled(m)` holds for the intent whose room retirement settles itself.
  // #1251 C7 — a bound room too: a retry that found this run's key gone moved its identity aside, minted a replacement
  // key and created a second room, which the daemon bound, while the first room may still be active.
  const refuseEarlierRooms = (moved, settled) => {
    for (const m of moved.filter(m => m.intent !== null && !settled(m))) {
      const rooms = roomsOf(m);
      if (rooms === null) refuseWithOrder(`this run's earlier key (pubkey ${m.pubkey}), moved aside to ${m.dir} with the intent of a Buzz room named ${m.intent.name}, is not there to find that room with`,
        `put the key this run minted (pubkey ${m.pubkey}) in ${m.dir} as ${basename(a.privateKeyFile)}; retirement looks for that room with it`);
      if (rooms.length) refuseWithOrder(`this run's earlier key (pubkey ${m.pubkey}), moved aside to ${m.dir}, finds active Buzz room${rooms.length > 1 ? 's' : ''} ${rooms.join(', ')}`,
        ...rooms.map(room => `have an owner archive room ${room} (buzz channels archive --channel ${room})`));
    }
  };
  const unboundRoom = () => {
    const atPath = existsSync(a.privateKeyFile) ? pub() : null;
    const moved = movedOfThisRun();
    if (atPath !== null && keyOfThisRun(atPath)) {
      const pk = atPath;
      refuseEarlierRooms(moved,m => m.pubkey === pk);
      const intent = existsSync(intentFile) ? read(intentFile) : null;
      if (ofThisRun(intent,pk) && typeof intent.roomId === 'string') return {pk,roomId:intent.roomId,record:null};
      const name = ofThisRun(intent,pk) ? intent.name : a.roomName ?? a.projectId;
      const owned = activeRooms(name,pk).map(room => room.channel_id ?? room.id);
      if (owned.length > 1) refuseWithOrder(`the Buzz room of ${a.projectId} was never recorded, and ${a.identityName} (${pk}) is in ${owned.length} active rooms named ${name}: ${owned.join(', ')}`,
        `have an owner archive all but one of rooms ${owned.join(', ')} (buzz channels archive --channel <room>); retirement archives the one left`);
      if (owned.length === 0) return {pk,roomId:null,record:null};
      check(/^[a-f0-9-]{36}$/.test(owned[0]),'unrecorded room identity');
      return {pk,roomId:owned[0],record:{...(ofThisRun(intent,pk) ? intent : {name,pubkey:pk,runId:a.runId}),roomId:owned[0]}};
    }
    const aside = atPath === null ? [] : [`move the key at ${a.privateKeyFile} (pubkey ${atPath}) aside: this run did not mint it and the roster binds it to no active route of ${a.projectId}`];
    // Every room intent of this run on the host, moved aside or in place (`dir` null).
    const live = existsSync(intentFile) ? read(intentFile) : null;
    const intents = [...moved.filter(m => m.intent !== null),...(object(live) && live.runId === a.runId && typeof live.pubkey === 'string' ? [{dir:null,pubkey:live.pubkey,intent:live,keyFile:null}] : [])];
    const steps = m => [...aside,m.dir === null ? `put the key this run minted (pubkey ${m.pubkey}) at ${a.privateKeyFile}` :
      `put this run's identity back from ${m.dir}: its ${m.keyFile === null ? '' : `${basename(a.privateKeyFile)} and `}${basename(pubFile)} in ${dirname(a.privateKeyFile)}, its ${basename(keyProvenanceFile)} and ${basename(intentFile)} in ${state}${m.keyFile === null ? `, and the key this run minted (pubkey ${m.pubkey}), which is not with them, at ${a.privateKeyFile}` : ''}`];
    for (const m of intents.filter(m => typeof m.intent.roomId !== 'string')) {
      const rooms = roomsOf(m);
      if (rooms === null) refuseWithOrder(`the Buzz room of ${a.projectId} was never recorded, and the key this run created it with (pubkey ${m.pubkey}) is not ${m.dir === null ? `at ${a.privateKeyFile}` : `in ${m.dir}`} to find it with`,...steps(m));
      if (rooms.length) refuseWithOrder(`the Buzz room of ${a.projectId} was never recorded, and this run's key moved aside to ${m.dir} (pubkey ${m.pubkey}) finds active room${rooms.length > 1 ? 's' : ''} ${rooms.join(', ')}`,...steps(m));
    }
    const recorded = intents.find(m => typeof m.intent.roomId === 'string');
    if (recorded) return {pk:null,roomId:recorded.intent.roomId,record:null,missing:{pubkey:recorded.pubkey,steps:steps(recorded)}};
    return {pk:null,roomId:null,record:null};
  };
  const retirementPreflight = () => {
    const requiredOrder = pid => [
      `end the CTO session ${a.sessionUuid}${pid ? ` (pid ${pid})` : ''} yourself: exit it in its own terminal`,
      rerun,
    ];
    const sessionRecordNames = pid => {
      try {const rc = read(join(home,'.claude','sessions',`${pid}.json`));return (rc.sessionId ?? rc.sessionUuid ?? rc.session_id) === a.sessionUuid;} catch {return false;}
    };
    let resident = null;
    if (a.retirementPin) {
      // The pin is the session row ACP recorded for this project's PRIMARY_CTO: its pid and start. A row written by the
      // canonical claim holds the native start token; one written through setPid holds ps's lstart text, compared in
      // that form. A match is that exact incarnation, wherever its working directory is, and its argv or Claude's own
      // session record must still name the session. No match means that incarnation has exited.
      const pin = a.retirementPin;const token = readProcessStartToken(pin.pid);
      let same = token !== null && token === pin.startedAt;
      if (!same && token !== null && /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(pin.startedAt)) {
        let lstart = '';try {lstart = run('ps',['-o','lstart=','-p',String(pin.pid)]).trim();} catch { /* An unanswered probe is no match. */ }
        same = lstart === pin.startedAt;
      }
      if (same) {
        if (!namesSession(run('ps',['-p',String(pin.pid),'-o','command='])) && !sessionRecordNames(pin.pid))
          throw new RetirementOrderRefusal(`process ${pin.pid} is the recorded CTO incarnation but no longer names session ${a.sessionUuid}`,requiredOrder(pin.pid));
        resident = {pid:pin.pid,startedAt:token};
      }
    }
    if (!resident) {
      try {resident = observeResident(false,false);} catch {
        if (run('ps',['-axo','command=']).split('\n').some(l => namesSession(l)))
          throw new RetirementOrderRefusal(`a process names CTO session ${a.sessionUuid} and retirement cannot verify it as the incarnation ACP recorded`,requiredOrder(null));
      }
    }
    const unbound = a.roomLifecycle === 'unbound' ? unboundRoom() : null;
    // #1251 C7 — a recorded room: the intent that names it, or the key at the path, is its own; the main path settles it.
    if (!unbound) refuseEarlierRooms(movedOfThisRun(),m => m.intent.roomId === a.roomId || (existsSync(a.privateKeyFile) && m.pubkey === pub()));
    if (unbound?.roomId) a.roomId = unbound.roomId;
    const plannedRoute = existsSync(rosterFile) ? read(rosterFile).channels?.[a.roomId] : undefined;
    if (plannedRoute && plannedRoute.status !== 'retired' && plannedRoute.acp_project_id !== a.projectId)
      refuseWithOrder(`retirement route conflict: the roster routes room ${a.roomId} to project ${plannedRoute.acp_project_id}`,`correct room ${a.roomId}'s entry in ${rosterFile}: it must name project ${a.projectId} or be retired`);
    const archive = join(home,'projects','.retired',`${repoName}-${a.projectId}`);
    if (existsSync(a.clonePath)) {
      if (existsSync(archive)) refuseWithOrder(`retirement archive already exists alongside clone: ${archive}`,`move ${archive} aside`);
      const remote = run('git',['remote','get-url','origin'],{cwd:a.clonePath}).trim();
      if (![origin,`git@github.com:${match[1]}/${repoName}.git`].includes(remote))
        refuseWithOrder(`retirement clone origin mismatch: ${a.clonePath} points at ${remote}`,`point ${a.clonePath}'s origin at ${origin}, or move that clone aside`);
    }
    // #1230 — the room. Missing host artifacts do not prove that a remote room never existed. Only the daemon ledger's
    // never-created state or this host's exact post-archive receipt can settle that boundary without a key. A room that
    // may exist must be archived already or archivable by this identity; anything else refuses before anything moves.
    const intentRoom = existsSync(intentFile) ? read(intentFile).roomId : undefined;
    const roomArchiveFile = join(state,`retired-buzz-room-${a.projectId}.json`);
    const roomArchiveReceipt = (() => {
      try {
        const receipt = read(roomArchiveFile);
        return object(receipt) && receipt.version === 1 && receipt.projectId === a.projectId && receipt.roomId === a.roomId && receipt.archived === true;
      } catch { return false; }
    })();
    // #1251 C-P2 — the placeholder of an unbound allocation is never looked up: it names no room.
    if (unbound && unbound.roomId === null) return {resident,archive,unbound,room:{state:'none'}};
    const pk = unbound ? unbound.pk : existsSync(a.privateKeyFile) ? pub() : null;
    const room = pk === null ? null : buzz(['channels','get','--channel',a.roomId]);
    if (room !== null) check(object(room) && room.channel_id === a.roomId && typeof room.name === 'string' && room.name.length > 0,'retiring Buzz room readback mismatch');
    const recorded = plannedRoute?.acp_project_id === a.projectId || intentRoom === a.roomId;
    if (roomArchiveReceipt) return {resident,archive,unbound,room:{state:'archived',archiveReceipt:roomArchiveFile}};
    if (!recorded && room === null && a.roomLifecycle === 'never-created') return {resident,archive,unbound,room:{state:'none'}};
    const owner = plannedRoute?.peer?.pubkey ?? 'not recorded';
    if (pk === null && unbound) refuseWithOrder(`Buzz room ${a.roomId} of ${a.projectId} cannot be archived: the key this run minted (pubkey ${unbound.missing.pubkey}) is not at ${a.privateKeyFile}`,...unbound.missing.steps);
    if (pk === null) refuseWithOrder(`Buzz room ${a.roomId} cannot be archived: no key for ${a.identityName} at ${a.privateKeyFile}`,
      `put the key of room ${a.roomId}'s owner (pubkey ${owner} per the roster) at ${a.privateKeyFile}; retirement archives the room with it and then moves it aside`);
    if (room === null) refuseWithOrder(`Buzz room ${a.roomId} is not visible to ${a.identityName} (${pk})`,
      `make ${pk} an owner of room ${a.roomId}, or put the key of its owner (pubkey ${owner} per the roster) at ${a.privateKeyFile}`);
    const members = buzz(['channels','members','--channel',a.roomId]);
    check(Array.isArray(members) && members.every(m => object(m) && typeof m.pubkey === 'string' && typeof m.role === 'string'),'invalid Buzz room roster');
    if (roomArchived(room.name)) return {resident,archive,unbound,room:{state:'archived',name:room.name}};
    if (members.some(m => m.pubkey === pk && m.role === 'owner')) return {resident,archive,unbound,room:{state:'archive',name:room.name}};
    const owners = members.filter(m => m.role === 'owner').map(m => m.pubkey);
    refuseWithOrder(`Buzz room ${a.roomId} is owned by ${owners.length ? owners.join(', ') : 'no member visible to this identity'}, and ${a.identityName} (${pk}) is ${members.find(m => m.pubkey === pk)?.role ?? 'not a member'}`,
      `have an owner archive room ${a.roomId} (buzz channels archive --channel ${a.roomId}), or make ${pk} an owner of it`);
  };
  const roomArchived = name => {
    const found = buzz(['channels','search','--query',name,'--exact','--include-archived']);
    check(Array.isArray(found),'invalid channel search');
    return found.some(c => (c.channel_id ?? c.id) === a.roomId && c.archived === true);
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
      // #1230 — a key at this identity's path that is not this run's (keyOfThisRun) — a retired project's identity or a
      // hand-made one under this name — is moved aside and a new key is minted.
      const existingKey = existsSync(a.privateKeyFile) ? pub() : null;
      if (existingKey === null || !keyOfThisRun(existingKey)) moveIdentityAside();
      if (!existsSync(a.privateKeyFile)) {
        const secret = generateSecretKey();
        atomic(a.privateKeyFile,Buffer.from(secret).toString('hex')+'\n');
        atomic(keyProvenanceFile,JSON.stringify({runId:a.runId,pubkey:getPublicKey(secret)}));
      }
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
      // The intent predates creation, including when the relay's response is lost.
      const intended = {name:a.roomName ?? a.projectId,pubkey:pk,runId:a.runId};
      if (!existsSync(intentFile)) atomic(intentFile,JSON.stringify(intended));
      const intent = read(intentFile);
      check(intent.name === intended.name && intent.pubkey === pk && intent.runId === a.runId,'room intent conflict');
      let owned = ownedRooms(intent.name,pk);
      check(owned.length <= 1,'ambiguous owned room');
      if (!owned.length) {
        check(!intent.roomId,'persisted room disappeared');
        buzz(['channels','create','--name',intent.name,'--type','stream','--visibility','private']);
        owned = ownedRooms(intent.name,pk);
      }
      check(owned.length === 1,'room readback missing or ambiguous');
      const room = owned[0]; const roomId = room.channel_id ?? room.id;
      check(/^[a-f0-9-]{36}$/.test(roomId) && (!intent.roomId || intent.roomId === roomId) && room.name === intent.name && room.visibility === 'private' && (room.channel_type ?? room.type) === 'stream','room mismatch');
      atomic(intentFile,JSON.stringify({...intent,roomId}));
      const owner = readFileSync(join(home,'.hermes','bridge','keys','owner.pub'),'utf8').trim();
      const ceo = canonicalCeoKey();
      const expectedMembers = [[pk,'owner'],[owner,'owner'],[ceo,'admin']];
      const before = buzz(['channels','members','--channel',roomId]);
      check(before.every(m => expectedMembers.some(([key,role]) => m.pubkey === key && m.role === role)),'existing room membership roles conflict');
      for (const [key,role] of [[owner,'owner'],[ceo,'admin']]) buzz(['channels','add-member','--channel',roomId,'--pubkey',key,'--role',role]);
      const members = buzz(['channels','members','--channel',roomId]);
      check(members.length === 3 && [[pk,'owner'],[owner,'owner'],[ceo,'admin']].every(([key,role]) => members.some(m => m.pubkey === key && m.role === role)),'room roster mismatch');
      ensureRouting(roomId, ceo);
      // The policy wrapper prefixes the counterpart's mention when it is absent, so the post is stated in that form.
      const nonce = `@${ceoHandle} acp-provision:${a.nonce}`;
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
        atomic(launcher,`#!/bin/sh\nunset ACP_OPERATOR_TOKEN ACP_MCP_TOKEN ACP_BUZZ_INGRESS_SECRET GH_TOKEN GITHUB_TOKEN\nexport ACP_STATE_DIR=${quote(state)}\nBUZZ_PRIVATE_KEY=$(cat ${quote(a.privateKeyFile)}) || exit 1\nexport BUZZ_PRIVATE_KEY\ncd ${quote(a.clonePath)} || exit 1\nexport PATH="$PATH":${quote(join(home,'.local','bin'))}\nexec ${args.map(quote).join(' ')}\n`,0o700);
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
    case 'verify-retire': retirementPreflight(); result = {retirementVerified:true}; break;
    case 'retire': {
      const {resident,archive,room,unbound} = retirementPreflight();
      // #1251 C-P2 — the unfinished ensure-buzz's intent receives the room it created, as ensure-buzz would have written.
      if (unbound?.record) {hostChanged = true;atomic(intentFile,JSON.stringify(unbound.record));}
      // #1230 — the room first: nothing else on the host changes, and nothing moves, until its archive is confirmed.
      if (room.state === 'archive') {
        hostChanged = true; // the archive may land even when its answer is lost
        run('buzz',['channels','archive','--channel',a.roomId],{env:buzzEnv()});
        check(roomArchived(room.name),'Buzz room archive readback mismatch');
      }
      if (room.state !== 'none') {
        hostChanged = true;
        atomic(join(state,`retired-buzz-room-${a.projectId}.json`),JSON.stringify({version:1,projectId:a.projectId,roomId:a.roomId,archived:true})+'\n');
      }
      hostChanged = true;
      rmSync(join(dirname(a.bootPacket),`${a.fleetName}.resident.json`),{force:true});
      if (existsSync(rosterFile)) { const roster = read(rosterFile); const route = roster.channels[a.roomId]; if (route && route.status !== 'retired') { check(route.acp_project_id === a.projectId,'retirement route conflict'); route.status = 'retired'; roster.generation++; atomic(rosterFile,JSON.stringify(roster,null,2)+'\n'); } }
      if (existsSync(fleetFile)) atomic(fleetFile,readFileSync(fleetFile,'utf8').split('\n').filter(l => {const f=l.split('\t');return f[0] !== a.fleetName && !(f[1] === a.clonePath && f[4] === a.sessionUuid);}).join('\n'));
      if (resident) {
        process.kill(resident.pid,'SIGTERM');
        for (let i = 0;i < 100 && readProcessStartToken(resident.pid) === resident.startedAt;i++) await new Promise(r => setTimeout(r,100));
        check(readProcessStartToken(resident.pid) !== resident.startedAt,'resident did not stop');
      }
      if (existsSync(a.clonePath)) {mkdirSync(dirname(archive),{recursive:true,mode:0o700});renameSync(a.clonePath,archive);}
      // #1251 C5-1 — an unbound allocation moves aside only this run's identity; whatever else is at the path stays as it is.
      const identityArchive = unbound && unbound.pk === null ? null : moveIdentityAside();
      result = {retired:true,buzzRoom:room.state === 'none' ? 'none' : 'archived',...(existsSync(archive) ? {retirementArchivePath:archive} : {}),...(identityArchive ? {identityArchivePath:identityArchive} : {})}; break;
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
  } else {
    process.stderr.write(`host project provisioner refused operation${error instanceof ProvisionerRefusal || error instanceof ProvisionerExecutionFailure ? ': '+error.message : ''}\n`);
    // The one structured line the daemon reads back for a retirement: whether the host changed anything before it
    // stopped, the provisioner's own reason and the order that lets retirement complete.
    if (operation === 'retire' || operation === 'verify-retire') process.stderr.write(JSON.stringify({retirementOutcome:{
      hostChanged,
      reason:error instanceof ProvisionerRefusal || error instanceof ProvisionerExecutionFailure ? error.message : 'host step failed',
      requiredOrder:error instanceof RetirementOrderRefusal ? error.requiredOrder : [rerun],
    }})+'\n');
  }
  process.exitCode = 1;
}
finally {if (locked && readlinkSync(lock) === ownLock) rmSync(lock,{force:true});if (ownLock) rmSync(ownLock,{recursive:true,force:true});}
