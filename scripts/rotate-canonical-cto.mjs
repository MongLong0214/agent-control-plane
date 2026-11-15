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
//               process table; nothing else is signalled
//   start    -> only then `claude --session-id <new>` in tmux, its acp-cto relay claiming generation n + 1 (the ack)
//   verify   -> `agentctl canonical-cto status` until the new session holds n + 1 and Buzz delivers to it
//
// Owned work at the boundary, or an old process tree whose exit is not confirmed in time: the new conversation is
// never started (exit 4). Nothing ever goes back to the old conversation or its generation: a new conversation that
// never claims by the deadline is fenced (its tmux session, which this run started, is killed and the exit of its
// process tree confirmed) and the switchover stays pending for it (exit 2); running this launcher again with the same
// arguments resumes that switchover. One that claimed but is not verified on Buzz may already have acted, so it is
// left as it is (exit 3). Going back is a new forward rotation from the new holder. Secrets are never printed; the new
// session's shell unsets them.
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// short): pid, parent, group, state, start time
// (which tells a reused pid apart) and command. A zombie has exited and can write nothing, so it is not counted.
const processTable = () => run('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,command='], { env: { ...process.env, LC_ALL: 'C' } }).split('\n').map((line) => {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s?(.*)$/.exec(line);
  return m && { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4].startsWith('Z'), start: m[5], command: m[6] };
}).filter((row) => row && !row.zombie);
const namesConversation = (command, uuid) => new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${uuid}(?:\\s|$)`).test(command);
/**
 * A process tree whose exit is awaited: the seeded processes, every process ever seen as a child of a tracked one,
 * and every member of a process group a tracked one leads. A process is kept by pid AND start time, so it stays
 * tracked after its parent dies and it is reparented, and a reused pid is never mistaken for it. Never this launcher.
 */
const processTree = (seeds) => {
  const tracked = new Map();
  const groups = new Set();
  const self = new Set([process.pid, process.ppid]);
  return () => {
    const rows = processTable();
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    for (const seed of seeds.splice(0)) { const row = byPid.get(seed); if (row) tracked.set(row.pid, row.start); }
    for (const [pid, start] of tracked) if (byPid.get(pid)?.start !== start) tracked.delete(pid);
    for (let grew = true; grew;) {
      grew = false;
      for (const pid of tracked.keys()) if (byPid.get(pid)?.pgid === pid) groups.add(pid);
      for (const row of rows) {
        if (tracked.has(row.pid) || self.has(row.pid)) continue;
        if (tracked.has(row.ppid) || groups.has(row.pgid)) { tracked.set(row.pid, row.start); grew = true; }
      }
    }
    return [...tracked.keys()].sort((a, b) => a - b);
  };
};
/** Waits for every process of `refresh`'s tree to have exited; the ones still running at the deadline, or none. */
const exitOf = async (refresh, deadlineMs) => {
  const deadline = Date.now() + deadlineMs;
  let remaining = refresh();
  while (remaining.length > 0 && Date.now() < deadline) { await sleep(Math.min(pollMs, 100)); remaining = refresh(); }
  return remaining;
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

// stop — SIGTERM to the old claude process only; then its whole tree's exit, from the process table.
if (oldRow) {
  const refresh = processTree([oldRow.pid]);
  refresh();
  try { process.kill(oldRow.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') stop(4, 'stop', { refused: 'the old claude process could not be signalled', oldPid }); }
  const remaining = await exitOf(refresh, stopTimeoutMs);
  if (remaining.length > 0) {
    stop(4, 'stop', { refused: 'the old conversation\'s processes did not all exit; the new conversation was not started and nothing else was signalled',
      oldPid, remaining });
  }
  report('stop', { oldPid, stopped: true });
} else {
  // Resumed after an earlier run stopped it: nothing may still name the old conversation.
  const named = processTable().filter((row) => namesConversation(row.command, old)).map((row) => row.pid);
  if (named.length > 0) stop(4, 'stop', { refused: 'a process still names the old conversation; the new conversation was not started', remaining: named });
  report('stop', { oldPid, alreadyGone: true });
}

// start — the project's local acp-cto entry names the new conversation and the issued generation. It is never
// restored to the old conversation: the switchover record names the new one, and nothing goes back.
const config = (() => { try { return JSON.parse(readFileSync(join(process.env.HOME ?? homedir(), '.claude.json'), 'utf8')); } catch { return {}; } })();
const previous = config.projects?.[flags.cwd]?.mcpServers?.['acp-cto'] ?? null;
const relayArgs = (() => {
  if (!previous) return [runtimeNode, runtimeCli, 'attach', 'canonical-cto', '--claimed-session-id', to, '--project-id', project, '--expected-binding-generation', String(issued)];
  const args = [previous.command, ...(previous.args ?? [])];
  const set = (flag, value) => { const at = args.indexOf(flag); if (at !== -1) args[at + 1] = value; };
  set('--claimed-session-id', to);
  set('--expected-binding-generation', String(issued));
  return args;
})();
let started = false;
/** The new conversation did not claim: fence it (this run's tmux session and its process tree) and say so. */
const fenceNew = async (why) => {
  const refresh = processTree(processTable().filter((row) => namesConversation(row.command, to)).map((row) => row.pid));
  refresh();
  if (started) { try { run(tmux, ['kill-session', '-t', flags['tmux-session']]); } catch { /* already gone */ } }
  const remaining = await exitOf(refresh, stopTimeoutMs);
  if (remaining.length > 0) stop(3, 'start', { refused: 'the new conversation\'s processes did not exit; nothing was rolled back', why, remaining });
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
  const shell = join(dir, `${project}-${to}.sh`);
  const prompt = `You are ${project}'s canonical CTO, continuing from conversation ${old} at generation ${issued}. Read the handoff package at ${flags.handoff}, then connect to acp-cto and continue. `
    + 'A message handed to you marked previousHolderInFlight was handed to your previous conversation and never completed: check what was already done before acting on it, then complete it if it is done, reject it if it must not run, and act on it only if it is safe to do again.';
  writeFileSync(shell, `#!/bin/sh\nunset ACP_OPERATOR_TOKEN ACP_MCP_TOKEN ACP_BUZZ_INGRESS_SECRET GH_TOKEN GITHUB_TOKEN\ncd ${quote(flags.cwd)} || exit 1\nexec ${[claude, '--session-id', to, '--permission-mode', 'bypassPermissions', prompt].map(quote).join(' ')}\n`, { mode: 0o700 });
  chmodSync(shell, 0o700);
  run(tmux, ['new-session', '-d', '-s', flags['tmux-session'], shell]);
  started = true;
  report('start', { tmuxSession: flags['tmux-session'], session: to });
} catch (error) {
  await fenceNew(`start failed: ${error.code ?? error.status ?? 'error'}`);
}

// verify — attach (the new session holds the issued generation) and Buzz receive (the subscriber delivers to it).
const deadline = Date.now() + timeoutMs;
let seen = null;
while (Date.now() < deadline) {
  const now = status();
  seen = now.ok ? now.value : seen;
  if (seen && seen.holderSessionUuid === to && seen.binding?.generation === issued &&
      seen.buzz?.verdict === 'ADMITTED' && seen.buzz.sessionId === seen.binding.sessionId) break;
  await sleep(pollMs);
}
if (!seen || seen.holderSessionUuid !== to) await fenceNew('the new conversation did not claim before the deadline');
if (seen.binding?.generation !== issued || seen.buzz?.verdict !== 'ADMITTED') {
  stop(3, 'verify', { refused: 'the new conversation holds the role but is not verified', binding: seen.binding ?? null, buzz: seen.buzz ?? null,
    note: 'it may already have acted: nothing was rolled back' });
}
stop(0, 'verify', { session: seen.binding.sessionId, generation: issued, buzz: seen.buzz.verdict });
