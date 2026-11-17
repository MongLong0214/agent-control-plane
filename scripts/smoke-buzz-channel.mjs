#!/usr/bin/env node
/**
 * End-to-end smoke for a CTO session's Buzz channel, against the real Claude Code binary.
 *
 * It starts an INTERACTIVE Claude Code session in a throwaway tmux server (the host the resident CTOs
 * run in), loaded with this repository's `src/cli/buzz-channel.ts` through `--mcp-config` and
 * `--dangerously-load-development-channels server:acp-buzz-channel`, pointed at a local TLS relay this
 * script runs, and proves two things:
 *
 *   1. a mention signed by the "CEO" key reaches the session as a channel message
 *      (the `Channels (experimental)` notice appears and the message is shown), and
 *   2. the session answers it with the `reply` tool, and the relay receives a kind-9 signed by the
 *      CTO key, in the room, threaded under the mention.
 *
 * Why it cannot be headless: Claude Code ignores `--dangerously-load-development-channels` under
 * `-p`/the Agent SDK, and in an interactive session it shows a full-screen warning that needs a person
 * to confirm ("I am using this for local development"). This script presses that confirmation only
 * when it is run with `--accept-dev-channels-dialog`, because that is a person's consent being given
 * on their behalf. Without the flag it stops at the dialog and exits 77 (not run). It needs a logged-in
 * claude.ai or Console session and network access to Anthropic: channel delivery is gated on a
 * server-side flag the client fetches (`allow_channels`), and there is no offline mode.
 *
 * It never touches ACP state, the real relay or any real key: keys are generated here, the relay is
 * local, the state directory is a temp directory. One model turn is spent (a small model).
 *
 * Usage: node scripts/smoke-buzz-channel.mjs --accept-dev-channels-dialog [--keep] [--timeout-ms 240000] [--model haiku]
 * Exit: 0 passed, 1 failed, 77 not run (precondition missing).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';

const NOT_RUN = 77;
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const timeoutMs = Number(option('--timeout-ms', '240000'));
const model = option('--model', 'haiku');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const say = (line) => process.stdout.write(`smoke-buzz-channel: ${line}\n`);
const bail = (code, line) => { say(line); process.exit(code); };

const have = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore' }); return true; } catch { return false; } };
for (const [bin, args] of [['tmux', ['-V']], ['openssl', ['version']], ['claude', ['--version']]]) {
  if (!have(bin, args)) bail(NOT_RUN, `not run: ${bin} is not available`);
}
try {
  const auth = JSON.parse(execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 }));
  if (!auth.loggedIn || auth.apiProvider !== 'firstParty') bail(NOT_RUN, 'not run: Claude Code is not logged in to a first-party account (channels require claude.ai or a Console API key)');
} catch { bail(NOT_RUN, 'not run: could not read `claude auth status`'); }
const trust = join(homedir(), '.claude', 'scripts', 'claude-trust-dir.sh');
if (!existsSync(trust)) bail(NOT_RUN, `not run: ${trust} is required to pre-register the throwaway directory as trusted`);

const work = mkdtempSync(join(tmpdir(), 'acp-channel-smoke-'));
const cwd = join(work, 'project');
const state = join(work, 'state');
mkdirSync(cwd); mkdirSync(state, { recursive: true });
const tmuxSocket = `acp-smoke-${process.pid}`;
const tmux = (...args) => spawnSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' });
let relayServer = null;
const cleanup = () => {
  tmux('kill-server');
  try { relayServer?.close(); } catch { /* closing */ }
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// Identities: generated here, never real ones.
const cto = generateSecretKey(); const ctoPub = getPublicKey(cto);
const ceo = generateSecretKey(); const ceoPub = getPublicKey(ceo);
const keyFile = join(work, 'cto.priv');
writeFileSync(keyFile, Buffer.from(cto).toString('hex') + '\n', { mode: 0o600 }); chmodSync(keyFile, 0o600);
const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nonce = randomBytes(4).toString('hex');
const mention = finalizeEvent({ kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [['h', ROOM], ['p', ctoPub]],
  content: `Smoke test ${nonce}. Reply to this message with the reply tool, with the text "ack-${nonce}".` }, ceo);

// A self-signed certificate for the local relay; the channel server trusts it through NODE_EXTRA_CA_CERTS.
const certKey = join(work, 'relay.key'); const certPem = join(work, 'relay.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', certKey, '-out', certPem, '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });

// ---- the relay: NIP-42 AUTH, one REQ answered with the mention, and the publishes it is sent ------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const frame = (text) => {
  const body = Buffer.from(text); const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, body]);
};
const received = { reqs: 0, publishes: [] };
relayServer = createServer({ key: readFileSync(certKey), cert: readFileSync(certPem) }, (_req, res) => { res.writeHead(426); res.end(); });
relayServer.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (value) => socket.write(frame(JSON.stringify(value)));
  let buffer = Buffer.alloc(0);
  const onText = (text) => {
    let message; try { message = JSON.parse(text); } catch { return; }
    if (message[0] === 'AUTH') send(['OK', message[1].id, true, '']);
    else if (message[0] === 'REQ') {
      received.reqs += 1;
      const filters = message.slice(2);
      if (filters.some((f) => Array.isArray(f['#p']) && f['#p'].includes(ctoPub))) send(['EVENT', message[1], mention]);
      send(['EOSE', message[1]]);
    } else if (message[0] === 'EVENT') { received.publishes.push(message[1]); send(['OK', message[1].id, true, '']); }
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const op = buffer[0] & 15; let len = buffer[1] & 127; let at = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); at = 10; }
      const masked = (buffer[1] & 128) !== 0; const need = at + (masked ? 4 : 0) + len;
      if (buffer.length < need) return;
      const mask = masked ? buffer.subarray(at, at + 4) : null; const payload = Buffer.from(buffer.subarray(at + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(need);
      if (op === 1) onText(payload.toString('utf8')); else if (op === 8) { socket.end(); return; } else if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
    }
  });
  socket.on('error', () => undefined);
});
await new Promise((ok) => relayServer.listen(0, '127.0.0.1', ok));
const relayUrl = `wss://localhost:${relayServer.address().port}`;
say(`local relay at ${relayUrl}`);

// ---- the session ---------------------------------------------------------------------------------
const mcpConfig = JSON.stringify({ mcpServers: { 'acp-buzz-channel': { command: process.execPath, env: { NODE_EXTRA_CA_CERTS: certPem },
  args: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', join(root, 'src', 'cli', 'buzz-channel.ts'), '--project-id', 'smoke', '--key-file', keyFile, '--room', ROOM, '--state-dir', state, '--relay-url', relayUrl, '--ceo-pubkey', ceoPub] } } });
try { execFileSync(trust, [cwd], { stdio: 'ignore' }); } catch { bail(NOT_RUN, 'not run: the throwaway directory could not be pre-registered as trusted'); }
const started = tmux('new-session', '-d', '-x', '200', '-y', '50', '-s', 'smoke', '-c', cwd,
  'claude', '--strict-mcp-config', '--mcp-config', mcpConfig, '--dangerously-load-development-channels', 'server:acp-buzz-channel',
  '--model', model, '--allowedTools', 'mcp__acp-buzz-channel__reply');
if (started.status !== 0) bail(1, `failed: tmux could not start the session: ${started.stderr}`);
const screen = () => tmux('capture-pane', '-p', '-t', 'smoke', '-S', '-200').stdout ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (name, predicate) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(500); }
  say(`--- screen at timeout (${name}) ---\n${screen().split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`);
  bail(1, `failed: timed out waiting for ${name}`);
};

await until('the development-channels warning or the session', () => /Loading development channels|inject directly/u.test(screen()));
if (/Loading development channels/u.test(screen())) {
  const listed = screen().split('\n').find((l) => l.includes('Channels:'));
  if (listed) say(`the warning lists: ${listed.trim()}`);
  if (!flag('--accept-dev-channels-dialog')) bail(NOT_RUN, 'not run: Claude Code is showing its development-channels warning, which needs a person to confirm; re-run with --accept-dev-channels-dialog to confirm it for this throwaway session');
  say('confirming the development-channels warning for the throwaway session (--accept-dev-channels-dialog)');
  tmux('send-keys', '-t', 'smoke', 'Enter');
}
await until('the channel to register', () => /inject directly in this session/u.test(screen()));
say('channel registered: "Channels (experimental) ... inject directly in this session"');
await until('the relay to be asked for this CTO\'s mentions', () => received.reqs > 0);
await until('the mention to appear in the session', () => screen().includes(`ack-${nonce}`) || screen().includes(`Smoke test ${nonce}`));
say('the mention reached the session as a channel message');
await until('the CTO reply to reach the relay', () => received.publishes.some((e) => e.pubkey === ctoPub));
const reply = received.publishes.find((e) => e.pubkey === ctoPub);
const fail = (why) => bail(1, `failed: ${why}`);
if (!verifyEvent(reply)) fail('the reply is not validly signed');
if (reply.kind !== 9) fail('the reply is not a kind-9');
if (!reply.tags.some((t) => t[0] === 'h' && t[1] === ROOM)) fail('the reply is not in the room');
if (!reply.tags.some((t) => t[0] === 'e' && t[1] === mention.id && t[3] === 'reply')) fail('the reply is not threaded under the mention');
if (!reply.tags.some((t) => t[0] === 'p' && t[1] === ceoPub)) fail('the reply does not address the mention\'s author');
if (received.publishes.some((e) => e.pubkey !== ctoPub)) fail('something other than the CTO signed a publish');
say(`PASS: mention delivered once as a channel message; reply ${reply.id.slice(0, 12)}… signed by the CTO key, in the room, threaded under the mention`);
process.exit(0);
