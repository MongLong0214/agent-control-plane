#!/usr/bin/env node
// v58 — moves a project's canonical PRIMARY_CTO to a new Claude conversation as the same actor, with the process
// control the resident path already uses (`claude mcp add --scope local acp-cto`, a launcher shell in tmux, SIGTERM):
//
//   handoff  -> the old CTO's handoff package (PRD §10.2), checked complete before anything moves
//   rotate   -> `agentctl canonical-cto rotate` (owner): the switchover is recorded and the old CTO is fenced at ACP
//               (DRAINING: its runs queue and it is handed no new message; its conversation never claims again)
//   boundary -> `agentctl canonical-cto status`: the old binding drains and owns no live run
//   stop     -> SIGTERM to the old claude process only, then its exit AND the exit of every process of its tree (its
//               children and theirs, and the members of any process group one of them leads) is confirmed from the
//               process table; nothing else is signalled. The processes still awaited (pid and start time) and every
//               process group and session of the tree are kept in rotations/<project>-<uuid>.stop.json, so a resumed
//               run awaits them again: a group is gone only on ESRCH from kill(-pgid, 0) with no member in the table
//   start    -> only then `claude --session-id <new>` in tmux, its acp-cto relay claiming generation n + 1 (the ack)
//   verify   -> the new session holds n + 1, and the daemon's own Buzz subscriber connection for its identity is
//               live and delivering to it and the ingress is listening (registry eligibility alone proves nothing)
//
// Owned work at the boundary, or an old process tree whose exit is not confirmed in time: the new conversation is
// never started (exit 4). Nothing ever goes back to the old conversation or its generation: a new conversation that
// never claims by the deadline is fenced (its tmux session, which this run started, is killed and the exit of its
// process tree confirmed) and the switchover stays pending for it (exit 2); running this launcher again with the same
// arguments resumes that switchover. One that claimed but is not verified on Buzz may already have acted, so it is
// left as it is (exit 3). Going back is a new forward rotation from the new holder. Secrets are never printed; the new
// session's shell unsets them.
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'usage: rotate-canonical-cto.mjs --project <id> --to <uuid> --expected-generation <n> --cwd <dir> --old-pid <pid> --tmux-session <name> --handoff <package.json> [--timeout-ms <ms>] [--poll-ms <ms>] [--stop-timeout-ms <ms>]';
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith('--') || argv[i + 1] === undefined) { process.stderr.write(`${usage}\n`); process.exit(64); }
  flags[argv[i].slice(2)] = argv[i + 1];
}
for (const name of ['project', 'to', 'expected-generation', 'cwd', 'old-pid', 'tmux-session', 'handoff']) {
  if (!flags[name]) { process.stderr.write(`${usage}\n`); process.exit(64); }
}
const state = process.env.ACP_STATE_DIR;
if (!state) { process.stderr.write('ACP_STATE_DIR is required\n'); process.exit(64); }
const project = flags.project;
const to = flags.to;
const expected = Number(flags['expected-generation']);
const oldPid = Number(flags['old-pid']);
const timeoutMs = Number(flags['timeout-ms'] ?? 180_000);
const pollMs = Number(flags['poll-ms'] ?? 2_000);
const stopTimeoutMs = Number(flags['stop-timeout-ms'] ?? 60_000);
const report = (step, fields = {}) => process.stdout.write(`${JSON.stringify({ step, ...fields })}\n`);
const stop = (code, step, fields) => { report(step, fields); process.exit(code); };

const runtimeNode = join(state, 'current', 'dist', 'bin', 'node');
const runtimeCli = join(state, 'current', 'dist', 'cli', 'agentctl.js');
const agentctlArgv = process.env.ACP_AGENTCTL ? [process.env.ACP_AGENTCTL] : [runtimeNode, runtimeCli];
const claude = process.env.CLAUDE_BIN ?? 'claude';
const tmux = process.env.TMUX_BIN ?? 'tmux';
const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
/** One agentctl call; its JSON answer, allowed or not. Never its environment. */
const agentctl = (...args) => {
  try { return { ok: true, value: JSON.parse(run(agentctlArgv[0], [...agentctlArgv.slice(1), ...args])) }; }
  catch (error) { try { return { ok: false, value: JSON.parse(String(error.stdout ?? '')) }; } catch { return { ok: false, value: { reasonCode: 'AGENTCTL_FAILED' } }; } }
};
const status = () => agentctl('canonical-cto', 'status', '--project', project);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The process table, read whole each time (C locale, so the start time parses; unlimited width, so no command is cut
// short): pid, parent, process group, session (0 where the system does not report one, as macOS does not), state,
// start time (which tells a reused pid apart) and command. A zombie has exited and can write nothing, so it is not
// counted as a process; its group still answers kill(-pgid, 0) until it is reaped.
const processTable = () => run('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,sess=,stat=,lstart=,command='], { env: { ...process.env, LC_ALL: 'C' } }).split('\n').map((line) => {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s?(.*)$/.exec(line);
  return m && { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), sess: Number(m[4]), zombie: m[5].startsWith('Z'), start: m[6], command: m[7] };
}).filter((row) => row && !row.zombie);
// This launcher's own group and session: never awaited, so a tree that shares one with it is refused, not awaited.
const selfRow = processTable().find((row) => row.pid === process.pid) ?? null;
const namesConversation = (command, uuid) => new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${uuid}(?:\\s|$)`).test(command);
/**
 * A process tree whose exit is awaited: the seeded processes, every process ever seen as a child of a tracked one,
 * and every member of a process group or session a tracked one was ever in (and of the ones a resumed run was
 * handed). A process is kept by pid AND start time, so it stays tracked after its parent dies and it is reparented,
 * and a reused pid is never mistaken for it. A group is gone only when kill(-pgid, 0) answers ESRCH and the process
 * table holds no member of it; any other answer keeps it alive. Never this launcher.
 */
const processTree = (seeds, seedGroups = [], seedSessions = []) => {
  const tracked = new Map();
  const groups = new Set(seedGroups);
  const sessions = new Set(seedSessions);
  const self = new Set([process.pid, process.ppid]);
  const ownGroup = selfRow?.pgid ?? null;
  const ownSession = selfRow && selfRow.sess > 0 ? selfRow.sess : null;
  const refresh = () => {
    const rows = processTable();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    // A seed is a pid, or a pid with the start time it was recorded at, which must still be the one running.
    for (const seed of seeds.splice(0)) {
      const { pid, start } = typeof seed === 'number' ? { pid: seed, start: null } : seed;
      const row = byPid.get(pid);
      if (row && (start === null || row.start === start)) tracked.set(row.pid, row.start);
    }
    for (const [pid, start] of tracked) if (byPid.get(pid)?.start !== start) tracked.delete(pid);
    for (let grew = true; grew;) {
      grew = false;
      for (const pid of tracked.keys()) {
        const row = byPid.get(pid);
        if (row && row.pgid > 1 && row.pgid !== ownGroup) groups.add(row.pgid);
        if (row && row.sess > 0 && row.sess !== ownSession) sessions.add(row.sess);
      }
      for (const row of rows) {
        if (tracked.has(row.pid) || self.has(row.pid)) continue;
        if (tracked.has(row.ppid) || groups.has(row.pgid) || sessions.has(row.sess)) { tracked.set(row.pid, row.start); grew = true; }
      }
    }
    const liveGroups = [...groups].filter((pgid) => {
      if (rows.some((row) => row.pgid === pgid)) return true;
      try { process.kill(-pgid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    });
    const liveSessions = [...sessions].filter((sess) => rows.some((row) => row.sess === sess));
    refresh.alive = { groups: liveGroups.sort((a, b) => a - b), sessions: liveSessions.sort((a, b) => a - b) };
    return [...tracked.keys()].sort((a, b) => a - b);
  };
  refresh.alive = { groups: [], sessions: [] };
  /** The processes still awaited, by pid and start time, and every group and session of the tree: what a later run must find gone. */
  refresh.identities = () => [...tracked].map(([pid, start]) => ({ pid, start })).sort((a, b) => a.pid - b.pid);
  refresh.groups = () => [...groups].sort((a, b) => a - b);
  refresh.sessions = () => [...sessions].sort((a, b) => a - b);
  return refresh;
};
/** Waits for every process, group and session of `refresh`'s tree to be gone; what still runs at the deadline. */
const exitOf = async (refresh, deadlineMs, observed = () => {}) => {
  const deadline = Date.now() + deadlineMs;
  const left = () => ({ remaining: refresh(), ...refresh.alive });
  const settled = (now) => now.remaining.length === 0 && now.groups.length === 0 && now.sessions.length === 0;
  let now = left();
  observed();
  while (!settled(now) && Date.now() < deadline) { await sleep(Math.min(pollMs, 100)); now = left(); observed(); }
  return { ...now, settled: settled(now) };
};

// One launcher per project at a time: a second one would stop, start or fence what the first one owns.
const dir = join(state, 'rotations');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const lockFile = join(dir, `${project}.lock`);
const holdsLock = (() => {
  try { const fd = openSync(lockFile, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); return true; } catch { /* held, or left behind */ }
  const holder = Number(readFileSync(lockFile, 'utf8'));
  try { process.kill(holder, 0); return false; } catch { writeFileSync(lockFile, String(process.pid), { mode: 0o600 }); return true; }
})();
if (!holdsLock) stop(75, 'lock', { refused: 'another rotation launcher is running for this project' });
process.on('exit', () => { try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) rmSync(lockFile); } catch { /* gone */ } });

// handoff — complete before anything moves (the same fields `missingHandoffFields` requires).
let handoff;
try { handoff = JSON.parse(readFileSync(flags.handoff, 'utf8')); } catch { stop(65, 'handoff', { refused: 'the handoff package is not readable JSON' }); }
const missing = ['projectStatus', 'recommendedNextAction'].filter((k) => !handoff[k])
  .concat(['repositoryFacts', 'openBlockers', 'queuedWork', 'knownRisks', 'recentDecisions'].filter((k) => !Array.isArray(handoff[k])));
if (missing.length > 0) stop(65, 'handoff', { refused: 'the handoff package is incomplete', missing });

// A switchover an earlier run of this launcher recorded to exactly this conversation is resumed, never recorded twice.
const before = status();
if (!before.ok) stop(66, 'status', { refused: before.value.reasonCode ?? 'UNKNOWN' });
const old = before.value.holderSessionUuid;
const resumed = (before.value.rotations ?? []).find((rotation) => rotation.state === 'PENDING') ?? null;
if (resumed && (resumed.toSessionUuid !== to || resumed.fromGeneration !== expected || resumed.fromSessionUuid !== old)) {
  stop(66, 'status', { refused: 'another switchover of this project is pending', pending: { to: resumed.toSessionUuid, fromGeneration: resumed.fromGeneration } });
}
if (before.value.generation !== expected) stop(66, 'status', { refused: 'expected-generation is not the role\'s current generation', generation: before.value.generation });
const table = processTable();
const oldRow = old ? table.find((row) => row.pid === oldPid && row.command.includes(old)) ?? null : null;
if (!old || (!oldRow && !resumed)) stop(66, 'status', { refused: 'old-pid is not the old conversation\'s claude process' });
// The launcher must not be part of what it stops: it would wait for itself, or die with it.
for (let row = table.find((entry) => entry.pid === process.pid), hops = 0; oldRow && row && hops < 64; hops++) {
  if (row.ppid === oldRow.pid) stop(66, 'status', { refused: 'the launcher runs inside the old conversation\'s process tree; run it outside it (in its own tmux session)' });
  const parent = row.ppid;
  row = table.find((entry) => entry.pid === parent);
}
if (oldRow && selfRow && (oldRow.pgid === selfRow.pgid || (oldRow.sess > 0 && oldRow.sess === selfRow.sess))) {
  stop(66, 'status', { refused: 'the launcher shares the old conversation\'s process group or session, so it cannot tell that tree\'s exit from its own; run it in its own session (e.g. in its own tmux session)' });
}
report('handoff', { project, from: old, to, generation: expected, ...(resumed ? { resumed: resumed.transferId } : {}) });

// rotate — the old holder is fenced at ACP before its process is touched.
let issued = resumed?.toGeneration;
if (!resumed) {
  const rotated = agentctl('canonical-cto', 'rotate', '--project', project, '--to', to, '--expected-generation', String(expected), '--handoff', flags.handoff);
  if (!rotated.ok || rotated.value.outcome !== 'SWITCHOVER_PENDING') stop(67, 'rotate', { refused: rotated.value.reasonCode ?? rotated.value.outcome ?? 'UNKNOWN' });
  issued = rotated.value.toGeneration;
  report('rotate', { transferId: rotated.value.transferId, toGeneration: issued });
}

// boundary — the old binding drains and owns no live run; anything else keeps the new holder from starting.
const atBoundary = status();
const binding = atBoundary.ok ? atBoundary.value.binding : null;
if (!binding || binding.generation !== expected || binding.lifecycle !== 'DRAINING' || !Array.isArray(binding.liveRuns) || binding.liveRuns.length > 0) {
  stop(4, 'boundary', { refused: 'the old holder is not at a safe boundary; it was not stopped and the new conversation was not started',
    binding: binding ?? null, liveRuns: binding?.liveRuns ?? null });
}

// stop — SIGTERM to the old claude process only; then its whole tree's exit, from the process table. What is still
// awaited is written down as it changes, before the signal too, so a run that stops early (a timeout, a crash) leaves
// a resumed run exactly the processes whose exit it must still establish. A resumed run whose old process is gone and
// that finds no such record cannot establish that exit, so it refuses.
const stopRecord = join(dir, `${project}-${to}.stop.json`);
const recorded = (() => {
  try {
    const value = JSON.parse(readFileSync(stopRecord, 'utf8'));
    const ids = (list) => Array.isArray(list) && list.every((one) => Number.isSafeInteger(one) && one > 1);
    return value.from === old && value.fromGeneration === expected && Array.isArray(value.outstanding) &&
      value.outstanding.every((one) => Number.isSafeInteger(one?.pid) && typeof one.start === 'string') &&
      ids(value.groups) && ids(value.sessions) ? value : null;
  } catch { return null; }
})();
if (!oldRow && recorded === null) {
  stop(4, 'stop', { refused: 'no record of the earlier run\'s stop: the exit of the old conversation\'s processes cannot be established; the new conversation was not started' });
}
const refresh = processTree([...(oldRow ? [{ pid: oldRow.pid, start: oldRow.start }] : []), ...(recorded?.outstanding ?? [])],
  recorded?.groups ?? [], recorded?.sessions ?? []);
let written = null;
const keep = () => {
  const outstanding = refresh.identities();
  const exited = outstanding.length === 0 && refresh.alive.groups.length === 0 && refresh.alive.sessions.length === 0;
  const body = JSON.stringify({ project, from: old, to, fromGeneration: expected, oldPid, outstanding,
    groups: refresh.groups(), sessions: refresh.sessions(), exited });
  if (body === written) return;
  const tmp = `${stopRecord}.${process.pid}.tmp`;
  writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
  renameSync(tmp, stopRecord);
  written = body;
};
refresh();
keep();
if (oldRow) {
  try { process.kill(oldRow.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') stop(4, 'stop', { refused: 'the old claude process could not be signalled', oldPid }); }
}
const left = await exitOf(refresh, stopTimeoutMs, keep);
if (!left.settled) {
  stop(4, 'stop', { refused: 'the old conversation\'s processes, process groups or sessions are not all gone; the new conversation was not started and nothing else was signalled',
    oldPid, remaining: left.remaining, groups: left.groups, sessions: left.sessions });
}
// Nothing may still name the old conversation either, tracked or not.
const named = processTable().filter((row) => namesConversation(row.command, old)).map((row) => row.pid);
if (named.length > 0) stop(4, 'stop', { refused: 'a process still names the old conversation; the new conversation was not started', remaining: named });
report('stop', oldRow ? { oldPid, stopped: true } : { oldPid, alreadyGone: true });

// start — the project's local acp-cto entry names the new conversation. It is never restored to the old conversation:
// the switchover record names the new one, and nothing goes back. Its generation is `auto`, not the issued number: the
// entry outlives this rotation, and a number pinned in it is refused on every relaunch once the role has moved past it.
// The first claim still lands on exactly `issued` — auto reads the role's highest + 1, and the transfer refuses any other.
const config = (() => { try { return JSON.parse(readFileSync(join(process.env.HOME ?? homedir(), '.claude.json'), 'utf8')); } catch { return {}; } })();
const previous = config.projects?.[flags.cwd]?.mcpServers?.['acp-cto'] ?? null;
const relayArgs = (() => {
  if (!previous) return [runtimeNode, runtimeCli, 'attach', 'canonical-cto', '--claimed-session-id', to, '--project-id', project, '--expected-binding-generation', 'auto'];
  const args = [previous.command, ...(previous.args ?? [])];
  const set = (flag, value) => { const at = args.indexOf(flag); if (at !== -1) args[at + 1] = value; };
  set('--claimed-session-id', to);
  set('--expected-binding-generation', 'auto');
  return args;
})();
let started = false;
/** The new conversation did not claim: fence it (this run's tmux session and its process tree) and say so. */
const fenceNew = async (why) => {
  const refresh = processTree(processTable().filter((row) => namesConversation(row.command, to)).map((row) => row.pid));
  refresh();
  if (started) { try { run(tmux, ['kill-session', '-t', flags['tmux-session']]); } catch { /* already gone */ } }
  const left = await exitOf(refresh, stopTimeoutMs);
  if (!left.settled) stop(3, 'start', { refused: 'the new conversation\'s processes did not exit; nothing was rolled back', why, remaining: left.remaining, groups: left.groups });
  const now = status();
  if (now.ok && now.value.holderSessionUuid === to) {
    stop(3, 'start', { refused: 'the new conversation claimed after the deadline and may have acted; it was stopped, nothing was rolled back', why });
  }
  stop(2, 'start', { why, pending: { to, generation: issued },
    note: 'the old conversation is stopped and fenced; run this launcher again with the same arguments to start the new one' });
};
try {
  try { run(claude, ['mcp', 'remove', '--scope', 'local', 'acp-cto'], { cwd: flags.cwd }); } catch { /* absent is fine */ }
  run(claude, ['mcp', 'add', '--scope', 'local', 'acp-cto', '--', ...relayArgs], { cwd: flags.cwd });
  const quote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  // The wake endpoint must sit directly in the state dir (role_wake_endpoint_register refuses /tmp/cc-socks); a stale file
  // from a dead holder is left to the CLI, as the resident provisioner leaves it.
  const shell = join(dir, `${project}-${to}.sh`);
  const prompt = `You are ${project}'s canonical CTO, continuing from conversation ${old} at generation ${issued}. Read the handoff package at ${flags.handoff}, then connect to acp-cto and continue. `
    + 'A message handed to you marked previousHolderInFlight was handed to your previous conversation and never completed: check what was already done before acting on it, then complete it if it is done, reject it if it must not run, and act on it only if it is safe to do again.';
  writeFileSync(shell, `#!/bin/sh\nunset ACP_OPERATOR_TOKEN ACP_MCP_TOKEN ACP_BUZZ_INGRESS_SECRET GH_TOKEN GITHUB_TOKEN\ncd ${quote(flags.cwd)} || exit 1\nexec ${[claude, '--session-id', to, '--messaging-socket-path', join(state, `cc-session-canonical-cto-${project}.sock`), '--permission-mode', 'bypassPermissions', prompt].map(quote).join(' ')}\n`, { mode: 0o700 });
  chmodSync(shell, 0o700);
  run(tmux, ['new-session', '-d', '-s', flags['tmux-session'], shell]);
  started = true;
  report('start', { tmuxSession: flags['tmux-session'], session: to });
} catch (error) {
  await fenceNew(`start failed: ${error.code ?? error.status ?? 'error'}`);
}

// verify — attach (the new session holds the issued generation) and Buzz receive: the registry's verdict, and the
// daemon's own receivers for the holder's identity — its subscriber connection authenticated and subscribed on a
// live socket, LIVE, delivering to the holder's role — and the ingress listening. Closed reception is not verified.
const received = (seenNow) => {
  const buzz = seenNow.buzz;
  return buzz?.verdict === 'ADMITTED' && buzz.sessionId === seenNow.binding?.sessionId &&
    buzz.reception?.subscriber?.connected === true && buzz.reception.subscriber.liveness === 'LIVE' &&
    buzz.reception.subscriber.delivering === true && buzz.reception.ingress?.listening === true;
};
const deadline = Date.now() + timeoutMs;
let seen = null;
while (Date.now() < deadline) {
  const now = status();
  seen = now.ok ? now.value : seen;
  if (seen && seen.holderSessionUuid === to && seen.binding?.generation === issued && received(seen)) break;
  await sleep(pollMs);
}
if (!seen || seen.holderSessionUuid !== to) await fenceNew('the new conversation did not claim before the deadline');
if (seen.binding?.generation !== issued || !received(seen)) {
  stop(3, 'verify', { refused: 'the new conversation holds the role but is not verified', binding: seen.binding ?? null, buzz: seen.buzz ?? null,
    note: 'it may already have acted: nothing was rolled back' });
}
stop(0, 'verify', { session: seen.binding.sessionId, generation: issued, buzz: seen.buzz.verdict, reception: seen.buzz.reception });
