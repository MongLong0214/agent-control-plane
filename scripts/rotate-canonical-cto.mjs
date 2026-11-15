#!/usr/bin/env node
// v58 — moves a project's canonical PRIMARY_CTO to a new Claude conversation as the same actor, with the process
// control the resident path already uses (`claude mcp add --scope local acp-cto`, a launcher shell in tmux, SIGTERM):
//
//   handoff  -> the old CTO's handoff package (PRD §10.2), checked complete before anything moves
//   rotate   -> `agentctl canonical-cto rotate` (owner): the switchover is recorded, the old CTO drains and keeps the role
//   start    -> `claude --session-id <new>` in tmux, its acp-cto relay claiming generation n + 1 (the acknowledgement)
//   verify   -> `agentctl canonical-cto status` until the new session holds n + 1 and Buzz delivers to it
//   stop     -> SIGTERM to the old claude process, verified to be the old conversation's first
//
// The new conversation never claimed by the deadline: the switchover is rolled back (a rotate back to the old
// conversation), the new tmux session is killed and the old acp-cto entry restored; the old CTO keeps its generation.
// It claimed but Buzz does not deliver to it: it may already have acted, so nothing is rolled back or stopped, and
// the launcher exits 3 with what it saw. Secrets are never printed; the new session's shell unsets them.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'usage: rotate-canonical-cto.mjs --project <id> --to <uuid> --expected-generation <n> --cwd <dir> --old-pid <pid> --tmux-session <name> --handoff <package.json> [--timeout-ms <ms>] [--poll-ms <ms>]';
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
const report = (step, fields = {}) => process.stdout.write(`${JSON.stringify({ step, ...fields })}\n`);
const stop = (code, step, fields) => { report(step, fields); process.exit(code); };

const runtimeNode = join(state, 'current', 'dist', 'bin', 'node');
const runtimeCli = join(state, 'current', 'dist', 'cli', 'agentctl.js');
const agentctlArgv = process.env.ACP_AGENTCTL ? [process.env.ACP_AGENTCTL] : [runtimeNode, runtimeCli];
const claude = process.env.CLAUDE_BIN ?? 'claude';
const tmux = process.env.TMUX_BIN ?? 'tmux';
const run = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
/** One agentctl call; its JSON answer, allowed or not. Never its environment. */
const agentctl = (...args) => {
  try { return { ok: true, value: JSON.parse(run(agentctlArgv[0], [...agentctlArgv.slice(1), ...args])) }; }
  catch (error) { try { return { ok: false, value: JSON.parse(String(error.stdout ?? '')) }; } catch { return { ok: false, value: { reasonCode: 'AGENTCTL_FAILED' } }; } }
};
const status = () => agentctl('canonical-cto', 'status', '--project', project);
const commandOf = (pid) => { try { return run('ps', ['-o', 'command=', '-p', String(pid)]).trim(); } catch { return ''; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// handoff — complete before anything moves (the same fields `missingHandoffFields` requires).
let handoff;
try { handoff = JSON.parse(readFileSync(flags.handoff, 'utf8')); } catch { stop(65, 'handoff', { refused: 'the handoff package is not readable JSON' }); }
const missing = ['projectStatus', 'recommendedNextAction'].filter((k) => !handoff[k])
  .concat(['repositoryFacts', 'openBlockers', 'queuedWork', 'knownRisks', 'recentDecisions'].filter((k) => !Array.isArray(handoff[k])));
if (missing.length > 0) stop(65, 'handoff', { refused: 'the handoff package is incomplete', missing });

// The old process must be the old conversation's claude before it may be stopped, so it is checked first.
const before = status();
if (!before.ok) stop(66, 'status', { refused: before.value.reasonCode ?? 'UNKNOWN' });
const old = before.value.holderSessionUuid;
if (before.value.generation !== expected) stop(66, 'status', { refused: 'expected-generation is not the role\'s current generation', generation: before.value.generation });
if (!old || !commandOf(oldPid).includes(old)) stop(66, 'status', { refused: 'old-pid is not the old conversation\'s claude process' });
report('handoff', { project, from: old, to, generation: expected });

// rotate
const rotated = agentctl('canonical-cto', 'rotate', '--project', project, '--to', to, '--expected-generation', String(expected), '--handoff', flags.handoff);
if (!rotated.ok || rotated.value.outcome !== 'SWITCHOVER_PENDING') stop(67, 'rotate', { refused: rotated.value.reasonCode ?? rotated.value.outcome ?? 'UNKNOWN' });
const issued = rotated.value.toGeneration;
report('rotate', { transferId: rotated.value.transferId, toGeneration: issued });

// start — the project's local acp-cto entry names the new conversation and the issued generation.
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
const setMcp = (args) => {
  try { run(claude, ['mcp', 'remove', '--scope', 'local', 'acp-cto'], { cwd: flags.cwd }); } catch { /* absent is fine */ }
  run(claude, ['mcp', 'add', '--scope', 'local', 'acp-cto', '--', ...args], { cwd: flags.cwd });
};
const rollBack = (why) => {
  const back = agentctl('canonical-cto', 'rotate', '--project', project, '--to', old, '--expected-generation', String(expected));
  if (!back.ok || back.value.outcome !== 'ROLLED_BACK') {
    stop(3, 'rollback', { refused: back.value.reasonCode ?? 'UNKNOWN', why, note: 'the new conversation may hold the role; nothing was stopped' });
  }
  try { run(tmux, ['kill-session', '-t', flags['tmux-session']]); } catch { /* the session may never have started */ }
  if (previous) setMcp([previous.command, ...(previous.args ?? [])]);
  stop(2, 'rollback', { why, rolledBack: back.value.transferId, holder: old, generation: expected });
};
try {
  setMcp(relayArgs);
  const quote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  const dir = join(state, 'rotations');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shell = join(dir, `${project}-${to}.sh`);
  const prompt = `You are ${project}'s canonical CTO, continuing from conversation ${old} at generation ${issued}. Read the handoff package at ${flags.handoff}, then connect to acp-cto and continue.`;
  writeFileSync(shell, `#!/bin/sh\nunset ACP_OPERATOR_TOKEN ACP_MCP_TOKEN ACP_BUZZ_INGRESS_SECRET GH_TOKEN GITHUB_TOKEN\ncd ${quote(flags.cwd)} || exit 1\nexec ${[claude, '--session-id', to, '--permission-mode', 'bypassPermissions', prompt].map(quote).join(' ')}\n`, { mode: 0o700 });
  chmodSync(shell, 0o700);
  run(tmux, ['new-session', '-d', '-s', flags['tmux-session'], shell]);
  report('start', { tmuxSession: flags['tmux-session'], session: to });
} catch (error) {
  rollBack(`start failed: ${error.code ?? error.status ?? 'error'}`);
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
if (!seen || seen.generation < issued) rollBack('the new conversation did not claim before the deadline');
if (seen.holderSessionUuid !== to || seen.binding?.generation !== issued || seen.buzz?.verdict !== 'ADMITTED') {
  stop(3, 'verify', { refused: 'the new conversation holds the role but is not verified', binding: seen.binding ?? null, buzz: seen.buzz ?? null,
    note: 'it may already have acted: nothing was rolled back and the old process was not stopped' });
}
report('verify', { session: seen.binding.sessionId, generation: issued, buzz: seen.buzz.verdict });

// stop — the old claude process, still the old conversation's.
if (!alive(oldPid)) stop(0, 'stop', { oldPid, alreadyGone: true });
if (!commandOf(oldPid).includes(old)) stop(4, 'stop', { refused: 'old-pid no longer names the old conversation; not signalled' });
process.kill(oldPid, 'SIGTERM');
for (let i = 0; i < 100 && alive(oldPid); i++) await sleep(100);
if (alive(oldPid)) stop(4, 'stop', { refused: 'the old claude process did not exit on SIGTERM', oldPid });
stop(0, 'stop', { oldPid, stopped: true });
