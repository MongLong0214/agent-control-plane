import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { allow } from '../../src/core/errors.ts';
import { ReasonCode } from '../../src/core/reason-codes.ts';
import { ArtifactKind, Role, RunState } from '../../src/domain/types.ts';
import { idempotentMcpMutation, ok, type ToolResult } from '../../src/mcp/shared.ts';
import { makeHarness } from '../helpers/harness.ts';
import { cleanupTempDirs, seedRun, tempDir } from '../helpers/fixtures.ts';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../../src/db/database.ts';
import { digestOf } from '../../src/core/digest.ts';
import { runMcpReservedMutation } from '../../src/ingress/ingress-guard.ts';
import { bootstrapPlanGuide } from '../../src/bootstrap/bootstrap-plan.ts';
import { callCtoTool } from '../helpers/cto-tool.ts';
import { startLocalMcpListeners } from '../../src/daemon/agentcpd.ts';
import { callMcpToolOverSocket } from '../helpers/mcp-socket.ts';
afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());
it.each([0, 60_000])('R1: a legacy NULL reservation at age %i is refused and unchanged', async age => {
 const h = makeHarness();
 try {
  h.cp.db.run("INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('mcp', 'legacy-null', 'peer', ?)", [h.clock.nowIso()]);
  const before = h.cp.db.all('SELECT * FROM inbound_messages');
  h.clock.advance(age);
  const effect = vi.fn(() => ok('new effect'));
  const result = await idempotentMcpMutation(h.cp, { actor: 'peer' }, 'legacy-null', effect, {
   toolName: 'run_create', arguments: { goal: 'new request' }, authority: () => allow(ReasonCode.OK, {}),
  });
  expect.soft(result.structuredContent).toMatchObject({ ok: false, reasonCode: 'MCP_REPLAY_UNVERIFIABLE' });
  expect.soft(effect).not.toHaveBeenCalled();
  expect(h.cp.db.all('SELECT * FROM inbound_messages')).toEqual(before);
 } finally { h.cp.close(); }
});
it('R2: capacity_get must separate the same session at generation 2 on the real MCP socket', async () => {
 const h = makeHarness();
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const credential = h.cp.sessions.create({ provider: 'scripted', model: 'credential-fixture' });
 h.cp.db.run('UPDATE sessions SET session_secret_hash = (SELECT session_secret_hash FROM sessions WHERE session_id = ?) WHERE session_id = ?', [credential.sessionId, run.sessionId]);
 const rotated = h.cp.sessions.rotateSecret(run.sessionId, 0);
 if (!rotated.allowed) throw new Error(rotated.message);
 const token = 'review-generation-token';
 const listeners = await startLocalMcpListeners(h.cp, tempDir('review1193-sockets-'), token);
 const call = () => callMcpToolOverSocket(listeners.socketPaths[1]!, { token, sessionId: run.sessionId, sessionSecret: rotated.value.sessionSecret }, 'capacity_get', { idempotencyKey: 'capacity-generation', refresh: false });
 try {
  const first = await call();
  expect(first).toMatchObject({ ok: true });
  expect(await call()).toEqual(first);
  const before = h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'");
  const effect = vi.spyOn(h.cp.capacity, 'all');
  expect(h.cp.runs.transition(run.runId, RunState.BLOCKED, 'review').allowed).toBe(true);
  expect(h.cp.bindings.revoke(run.roleKey, 'review', { allowBlockedRuns: true }).allowed).toBe(true);
  const rebound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: run.projectId, sessionId: run.sessionId });
  expect(rebound).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
  const replay = await call();
  expect.soft(replay).toMatchObject({ ok: false, reasonCode: 'CONFLICT' });
  expect(effect).not.toHaveBeenCalled();
  expect(h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'")).toEqual(before);
 } finally { await listeners.close(); h.cp.close(); }
});

it('R1: a pre-upgrade lost run_create response cannot create a second run for changed arguments', async () => {
 const { bindCeo } = await import('../helpers/harness.ts');
 const { createHermesMcpPort, createHermesServer } = await import('../../src/mcp/hermes-server.ts');
 const h = makeHarness(); const ceo = bindCeo(h);
 const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: ceo, sessionId: ceo, sessionIncarnation: h.cp.sessions.require(ceo).incarnation }));
 const invoke = (server as unknown as { _registeredTools: { run_create: { handler: (input: Record<string, unknown>) => Promise<ToolResult> } } })._registeredTools.run_create.handler;
 const args = { idempotencyKey: 'legacy-create', executionMode: 'SIMPLE', repositories: [], contract: { goal: 'first', why: 'review', scope: [], nonGoals: [], acceptance: ['done'], priority: 'NORMAL', humanGate: [], references: [] } };
 try {
  expect((await invoke(args)).structuredContent).toMatchObject({ ok: true });
  // Legacy protocol's durable state after effect completion, before its response store.
  h.cp.db.run("UPDATE inbound_messages SET result_json = NULL WHERE channel = 'mcp' AND nonce = 'legacy-create'");
  const before = h.cp.db.all('SELECT run_id FROM runs');
  h.clock.advance(60_000);
  const result = await invoke({ ...args, contract: { ...args.contract, goal: 'second' } });
  expect.soft(result.structuredContent).toMatchObject({ ok: false, reasonCode: 'MCP_REPLAY_UNVERIFIABLE' });
  expect(h.cp.db.all('SELECT run_id FROM runs')).toEqual(before);
 } finally { await server.close(); h.cp.close(); }
});

it('R3: escalation durable recovery must not conflate CRLF/LF keys and resolution bytes', async () => {
 const { bindCeo } = await import('../helpers/harness.ts');
 const { createHermesMcpPort, createHermesServer } = await import('../../src/mcp/hermes-server.ts');
 const h = makeHarness(); const ceo = bindCeo(h);
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: ceo, sessionId: ceo, sessionIncarnation: h.cp.sessions.require(ceo).incarnation }));
 const invoke = (server as unknown as { _registeredTools: { escalation_resolve: { handler: (input: Record<string, unknown>) => Promise<ToolResult> } } })._registeredTools.escalation_resolve.handler;
 try {
  const opened = h.cp.ceo.openEscalation({ runId: run.runId, question: 'question', options: ['one'], ctoRecommendation: 'one', whyItMatters: 'review', blocksCriticalPath: true, openedBySessionId: run.sessionId, openedAt: h.clock.nowIso() });
  if (!opened.allowed) throw new Error(opened.message);
  const firstArgs = { runId: run.runId, escalationId: opened.value.escalationId, idempotencyKey: 'resolve\r\nkey', resolution: 'use\r\none' };
  const first = await invoke(firstArgs);
  expect(first.structuredContent).toMatchObject({ ok: true });
  const retryArgs = { ...firstArgs, idempotencyKey: 'resolve\nkey', resolution: 'use\none' };
  const retry = await invoke(retryArgs);
  expect(retry.structuredContent).toMatchObject({ ok: false, reasonCode: 'CONFLICT' });
 } finally { await server.close(); h.cp.close(); }
});


it.each(['legacy', 'fingerprinted'] as const)('R1: restart after %s effect commit and failed response storage never repeats the file effect', async kind => {
 const h = makeHarness();
 const root = h.root, repoPath = h.repoPath, clock = h.clock;
 const effectPath = join(root, 'effect.txt');
 const request = { toolName: 'effect', arguments: {}, authority: () => allow(ReasonCode.OK, {}) };
 const original = h.cp.db.run.bind(h.cp.db);
 vi.spyOn(h.cp.db, 'run').mockImplementation((sql, params) => {
  if (sql.includes('UPDATE inbound_messages SET result_json')) throw new Error('store failed');
  return original(sql, params);
 });
 const commitEffect = () => { appendFileSync(effectPath, 'first\n'); return ok('first'); };
 const first = kind === 'legacy'
  // The pre-upgrade protocol inserted NULL before the handler and stored the response afterwards.
  ? runMcpReservedMutation(h.cp.db, 'peer', 'restart', clock.nowIso(), commitEffect, null, () => { throw new Error('store failed'); })
  : idempotentMcpMutation(h.cp, { actor: 'peer' }, 'restart', commitEffect, request);
 await expect(first).rejects.toThrow('store failed');
 expect(readFileSync(effectPath, 'utf8')).toBe('first\n');
 const before = h.cp.db.all('SELECT * FROM inbound_messages');
 h.cp.close(); vi.restoreAllMocks(); clock.advance(120_000);
 const reopened = makeHarness({ root, repoPath, clock });
 try {
  const result = await idempotentMcpMutation(reopened.cp, { actor: 'peer' }, 'restart', () => {
   appendFileSync(effectPath, 'second\n'); return ok('second');
  }, request);
  expect.soft(result.structuredContent).toMatchObject({ ok: false, reasonCode: kind === 'legacy' ? 'MCP_REPLAY_UNVERIFIABLE' : 'MCP_MUTATION_OUTCOME_UNKNOWN' });
  expect.soft(readFileSync(effectPath, 'utf8')).toBe('first\n');
  expect(reopened.cp.db.all('SELECT * FROM inbound_messages')).toEqual(before);
 } finally { reopened.cp.close(); }
});

it.each(['legacy', 'fingerprinted'] as const)('R1: a second Db never re-enters a live %s reservation or duplicates its late file effect', async kind => {
 const h = makeHarness();
 const other = new Db(join(h.root, 'state.sqlite'));
 const effectPath = join(h.root, 'late-effect.txt');
 const request = { toolName: 'effect', arguments: {}, authority: () => allow(ReasonCode.OK, {}) };
 let finish!: () => void;
 const execute = () => new Promise<ReturnType<typeof ok>>(resolve => { finish = () => {
  appendFileSync(effectPath, 'original\n'); resolve(ok('original'));
 }; });
 const original = kind === 'legacy'
  ? runMcpReservedMutation(h.cp.db, 'peer', 'two-handles', h.clock.nowIso(), execute, null, result => {
    h.cp.db.run("UPDATE inbound_messages SET result_json = ? WHERE channel = 'mcp' AND nonce = 'two-handles' AND actor = 'peer' AND result_json IS NULL", [JSON.stringify(result)]);
   }).then(result => { if (result.kind !== 'executed') throw new Error('legacy original did not reserve'); return result.result; })
  : idempotentMcpMutation(h.cp, { actor: 'peer' }, 'two-handles', execute, request);
 let finished = false;
 const complete = () => { if (!finished) { finished = true; finish(); } };
 const retryEffect = () => { appendFileSync(effectPath, 'retry\n'); return ok('retry'); };
 try {
  const before = h.cp.db.all('SELECT * FROM inbound_messages');
  h.clock.advance(120_000);
  const retry = await idempotentMcpMutation({ db: other, clock: h.clock }, { actor: 'peer' }, 'two-handles', retryEffect, request);
  expect.soft(retry.structuredContent).toMatchObject({ ok: false, reasonCode: kind === 'legacy' ? 'MCP_REPLAY_UNVERIFIABLE' : 'MCP_MUTATION_OUTCOME_UNKNOWN' });
  expect.soft(other.all('SELECT * FROM inbound_messages')).toEqual(before);
  // The retry must not apply an effect while the original is still waiting to commit its own.
  expect.soft(existsSync(effectPath)).toBe(false);
  complete(); const result = await original;
  expect.soft(readFileSync(effectPath, 'utf8')).toBe('original\n');
  if (kind === 'fingerprinted') {
   expect(await idempotentMcpMutation({ db: other, clock: h.clock }, { actor: 'peer' }, 'two-handles', retryEffect, request)).toEqual(result);
  } else {
   expect(JSON.parse(other.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'two-handles'")!.result_json)).toEqual(result);
  }
  expect(readFileSync(effectPath, 'utf8')).toBe('original\n');
 } finally { complete(); await original; other.close(); h.cp.close(); }
});

it('R1: valid late original ownership still stores its result and its one file effect', async () => {
 const h = makeHarness();
 const other = new Db(join(h.root, 'state.sqlite'));
 const effectPath = join(h.root, 'valid-late-effect.txt');
 const request = { toolName: 'effect', arguments: {}, authority: () => allow(ReasonCode.OK, {}) };
 let finish!: () => void;
 const original = idempotentMcpMutation(h.cp, { actor: 'peer' }, 'valid-late', () =>
  new Promise<ReturnType<typeof ok>>(resolve => { finish = () => {
   appendFileSync(effectPath, 'original\n'); resolve(ok('late original'));
  }; }), request);
 let finished = false;
 const complete = () => { if (!finished) { finished = true; finish(); } };
 try {
  const pending = other.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'valid-late'")!.result_json;
  const token = JSON.parse(pending).reservationToken as unknown;
  h.clock.advance(120_000);
  expect(other.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'valid-late'")!.result_json).toBe(pending);
  expect(existsSync(effectPath)).toBe(false);
  complete();
  const result = await original;
  const stored = JSON.parse(other.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'valid-late'")!.result_json) as { reservationToken?: unknown; result: unknown };
  expect(stored.reservationToken).toBe(token);
  expect(stored.result).toEqual(result);
  expect(readFileSync(effectPath, 'utf8')).toBe('original\n');
 } finally { complete(); await original; other.close(); h.cp.close(); }
});

it.each(['legacy', 'pending'])('R4: following the guide recovers a completed %s PLAN without duplicating tasks', async kind => {
 const h = makeHarness();
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const peer = { sessionId: run.sessionId, incarnation: h.cp.sessions.require(run.sessionId).incarnation };
 const args = { runId: run.runId, idempotencyKey: 'plan-lost', plan: { summary: 'first', dependencies: [], repositoryIntent: [], verificationIntent: [], knownConflicts: [], risks: [], removedOverengineering: [] }, tasks: [{ key: 'a', title: 'one task', category: 'implementation', dependsOn: [], spec: {} }] };
 try {
  expect(await callCtoTool(h, peer, 'plan_submit', args)).toMatchObject({ ok: true });
  const row = h.cp.db.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'plan-lost'")!;
  h.cp.db.run("UPDATE inbound_messages SET result_json = ? WHERE nonce = 'plan-lost'", [kind === 'legacy' ? null : JSON.stringify({ ...JSON.parse(row.result_json), result: null })]);
  h.clock.advance(60_000);
  const refusal = await callCtoTool(h, peer, 'plan_submit', args);
  expect.soft(refusal).toMatchObject({ ok: false, reasonCode: kind === 'legacy' ? 'MCP_REPLAY_UNVERIFIABLE' : 'MCP_MUTATION_OUTCOME_UNKNOWN' });
  const instruction = bootstrapPlanGuide().submit.join(' ');
  expect.soft(instruction).toContain('recover a completed effect from durable state');
  expect.soft(instruction).toContain('proof of non-execution');
  expect.soft(instruction).toContain('no automatic new key');
  // Follow the emitted instruction: reconcile the PLAN and tasks through contract_get.
  // The old blanket new-key instruction instead creates a second task.
  if (instruction.includes('Use a new idempotencyKey for every call')) {
   await callCtoTool(h, peer, 'plan_submit', { ...args, idempotencyKey: 'fresh-plan' });
  } else {
   const durable = await callCtoTool(h, peer, 'contract_get', { runId: run.runId });
   expect(durable).toMatchObject({ ok: true, value: { plan: { summary: 'first' } } });
   expect(h.cp.artifacts.latest(run.runId, ArtifactKind.PLAN)?.digest).toBe(digestOf(args.plan));
  }
  expect(h.cp.tasks.list(run.runId)).toHaveLength(1);
 } finally { h.cp.close(); }
});

it('R1: a certified pre-effect failure releases its own reservation; an ordinary throw preserves uncertainty', async () => {
 const { McpMutationNotExecuted } = await import('../../src/ingress/ingress-guard.ts');
 const h = makeHarness();
 const request = { toolName: 'effect', arguments: {}, authority: () => allow(ReasonCode.OK, {}) };
 const effect = vi.fn(() => ok('effect'));
 try {
  // Proof is this trusted validation path: it throws before invoking any effect.
  await expect(idempotentMcpMutation(h.cp, { actor: 'peer' }, 'pre-effect', () => {
   throw new McpMutationNotExecuted('validation failed before any effect was attempted');
  }, request)).rejects.toThrow('validation failed');
  expect(h.cp.db.get("SELECT nonce FROM inbound_messages WHERE nonce = 'pre-effect'")).toBeUndefined();
  expect((await idempotentMcpMutation(h.cp, { actor: 'peer' }, 'pre-effect', effect, request)).structuredContent).toMatchObject({ ok: true });
  await expect(idempotentMcpMutation(h.cp, { actor: 'peer' }, 'after-effect', () => {
   effect(); throw new Error('failed after effect');
  }, request)).rejects.toThrow('failed after effect');
  const before = h.cp.db.all('SELECT * FROM inbound_messages');
  expect((await idempotentMcpMutation(h.cp, { actor: 'peer' }, 'after-effect', effect, request)).structuredContent).toMatchObject({ ok: false, reasonCode: 'MCP_MUTATION_OUTCOME_UNKNOWN' });
  expect(effect).toHaveBeenCalledTimes(2);
  expect(h.cp.db.all('SELECT * FROM inbound_messages')).toEqual(before);
 } finally { h.cp.close(); }
});

it.each(['pending', 'completed'] as const)('R1: late result storage cannot overwrite a %s reservation with a different token', async state => {
 const h = makeHarness();
 const request = { toolName: 'effect', arguments: {}, authority: () => allow(ReasonCode.OK, {}) };
 let finish!: () => void;
 const original = idempotentMcpMutation(h.cp, { actor: 'peer' }, 'store-fence', () =>
  new Promise<ReturnType<typeof ok>>(resolve => { finish = () => resolve(ok('late')); }), request);
 try {
  const row = h.cp.db.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'store-fence'")!;
  // Fault injection simulates loss of ownership; the helper never takes over a pending row.
  const replacement = JSON.stringify({ ...JSON.parse(row.result_json), reservationToken: 'different', result: state === 'pending' ? null : ok('preserve') });
  h.cp.db.run("UPDATE inbound_messages SET result_json = ? WHERE nonce = 'store-fence'", [replacement]);
  finish();
  await expect(original).rejects.toMatchObject({ reasonCode: 'MCP_MUTATION_OUTCOME_UNKNOWN' });
  expect(h.cp.db.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'store-fence'")!.result_json).toBe(replacement);
 } finally { finish(); h.cp.close(); }
});

it('R3: an older durable receipt without byte identity is refused and preserved without a new reservation', async () => {
 const { digestOf } = await import('../../src/core/digest.ts');
 const { bindCeo } = await import('../helpers/harness.ts');
 const { createHermesMcpPort, createHermesServer } = await import('../../src/mcp/hermes-server.ts');
 const h = makeHarness(), ceo = bindCeo(h);
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const args = { runId: run.runId, escalationId: 1, resolution: 'same', idempotencyKey: 'old-receipt' };
 h.cp.audit.record({ kind: 'CEO_DECISION', runId: run.runId, sessionId: ceo, evidence: {
  escalation: true, escalationId: args.escalationId, messageId: 'old',
  idempotencyKeyDigest: digestOf({ door: 'escalation_resolve', idempotencyKey: args.idempotencyKey }),
  requestDigest: digestOf({ runId: args.runId, escalationId: args.escalationId, resolution: digestOf(args.resolution) }),
 } });
 const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: ceo, sessionId: ceo, sessionIncarnation: h.cp.sessions.require(ceo).incarnation }));
 const invoke = (server as unknown as { _registeredTools: { escalation_resolve: { handler: (input: typeof args) => Promise<{ structuredContent?: unknown }> } } })._registeredTools.escalation_resolve.handler;
 const before = h.cp.db.all('SELECT * FROM audit_events');
 const effect = vi.spyOn(h.cp.ceo, 'resolveEscalation');
 try {
  expect((await invoke(args)).structuredContent).toMatchObject({ ok: false, reasonCode: 'MCP_REPLAY_UNVERIFIABLE' });
  expect(effect).not.toHaveBeenCalled();
  expect(h.cp.db.all('SELECT * FROM audit_events')).toEqual(before);
  expect(h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'")).toEqual([]);
 } finally { await server.close(); h.cp.close(); }
});

it.each(['identical', 'key', 'resolution'] as const)('R3: durable fallback with no MCP row verifies %s bytes without minting a fingerprint', async changed => {
 const { bindCeo } = await import('../helpers/harness.ts');
 const { createHermesMcpPort, createHermesServer } = await import('../../src/mcp/hermes-server.ts');
 const h = makeHarness(), ceo = bindCeo(h);
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const opened = h.cp.ceo.openEscalation({ runId: run.runId, question: 'question', options: ['one'], ctoRecommendation: 'one', whyItMatters: 'test', blocksCriticalPath: true, openedBySessionId: run.sessionId, openedAt: h.clock.nowIso() });
 if (!opened.allowed) throw new Error(opened.message);
 if (opened.value.escalationId === null) throw new Error('missing escalation identity');
 const args = { runId: run.runId, escalationId: opened.value.escalationId, resolution: 'use\r\none', idempotencyKey: 'key\r\none' };
 expect(h.cp.ceo.resolveEscalation(args.runId, args.resolution, ceo, { escalationId: args.escalationId, idempotencyKey: args.idempotencyKey }).allowed).toBe(true);
 const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: ceo, sessionId: ceo, sessionIncarnation: h.cp.sessions.require(ceo).incarnation }));
 const invoke = (server as unknown as { _registeredTools: { escalation_resolve: { handler: (input: typeof args) => Promise<ToolResult> } } })._registeredTools.escalation_resolve.handler;
 const before = h.cp.db.all('SELECT * FROM audit_events');
 const effect = vi.spyOn(h.cp.ceo, 'resolveEscalation');
 try {
  const first = await invoke(args);
  expect(first.structuredContent).toMatchObject({ ok: false, reasonCode: 'MCP_REPLAY_UNVERIFIABLE' });
  expect(h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'")).toEqual([]);
  const retry = await invoke({ ...args, ...(changed === 'key' ? { idempotencyKey: 'key\none' } : changed === 'resolution' ? { resolution: 'use\none' } : {}) });
  if (changed === 'identical') {
   expect(retry).toEqual(first);
   expect(effect).not.toHaveBeenCalled();
   expect(h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'")).toEqual([]);
  } else {
   expect(retry.structuredContent).toMatchObject({ ok: false, reasonCode: 'CONFLICT' });
  }
  expect(h.cp.db.all('SELECT * FROM audit_events')).toEqual(before);
 } finally { await server.close(); h.cp.close(); }
});

it('R3: a durable receipt replays only its shared fingerprint and never creates a replacement reservation', async () => {
 const { bindCeo } = await import('../helpers/harness.ts');
 const { respond } = await import('../../src/mcp/shared.ts');
 const h = makeHarness(), ceo = bindCeo(h);
 const reservationDb = new Db(':memory:');
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const opened = h.cp.ceo.openEscalation({ runId: run.runId, question: 'question', options: ['one'], ctoRecommendation: 'one', whyItMatters: 'test', blocksCriticalPath: true, openedBySessionId: run.sessionId, openedAt: h.clock.nowIso() });
 if (!opened.allowed || opened.value.escalationId === null) throw new Error('missing escalation');
 const args = { runId: run.runId, escalationId: opened.value.escalationId, resolution: 'use\r\none', idempotencyKey: 'durable-key' };
 const peer = { actor: ceo, sessionId: ceo, sessionIncarnation: h.cp.sessions.require(ceo).incarnation };
 const request = {
  toolName: 'escalation_resolve', arguments: args, authority: () => allow(ReasonCode.OK, { roleKey: 'CEO', bindingGeneration: 1 }),
  durableReplay: (fingerprint: string) => {
   const receipt = h.cp.ceo.escalationResolutionReplay(args.idempotencyKey, args, ceo, fingerprint);
   return receipt ? respond(receipt) : null;
  },
 };
 try {
  // Independent reservation storage models a lost MCP cache while retaining the domain receipt.
  const first = await idempotentMcpMutation({ db: reservationDb, clock: h.clock }, peer, args.idempotencyKey,
   fingerprint => respond(h.cp.ceo.resolveEscalation(args.runId, args.resolution, ceo, { escalationId: args.escalationId, idempotencyKey: args.idempotencyKey, mcpFingerprint: fingerprint })), request);
  expect(first.structuredContent).toMatchObject({ ok: true });
  const before = h.cp.db.all('SELECT * FROM audit_events');
  const effect = vi.fn(() => ok('must not run'));
  expect(await idempotentMcpMutation(h.cp, peer, args.idempotencyKey, effect, request)).toEqual(first);
  expect((await idempotentMcpMutation(h.cp, { ...peer, sessionIncarnation: 'other' }, args.idempotencyKey, effect, request)).structuredContent).toMatchObject({ ok: false, reasonCode: 'CONFLICT' });
  expect(effect).not.toHaveBeenCalled();
  expect(h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'")).toEqual([]);
  expect(h.cp.db.all('SELECT * FROM audit_events')).toEqual(before);
 } finally { reservationDb.close(); h.cp.close(); }
});


it.each(['matching', 'PLAN mismatch', 'task mismatch'] as const)('R4: matching durable effect, %s, is the only completion of THIS request', async scenario => {
 const h = makeHarness();
 const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
 const peer = { sessionId: run.sessionId, incarnation: h.cp.sessions.require(run.sessionId).incarnation };
 const plan = { summary: 'wanted PLAN', dependencies: [], repositoryIntent: [], verificationIntent: [], knownConflicts: [], risks: [], removedOverengineering: [] };
 const tasks = [{ key: 'a', title: 'wanted task', category: 'implementation', dependsOn: [], spec: {} }];
 const request = { runId: run.runId, idempotencyKey: 'unclear-plan', plan, tasks };
 try {
  const prior = { ...request, idempotencyKey: 'durable-plan', plan: { ...plan, summary: scenario === 'PLAN mismatch' ? 'another request' : plan.summary }, tasks: scenario === 'task mismatch' ? [{ ...tasks[0]!, title: 'another request task' }] : tasks };
  expect(await callCtoTool(h, peer, 'plan_submit', prior)).toMatchObject({ ok: true });
  h.cp.db.run("INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('mcp', ?, ?, ?)", [request.idempotencyKey, `cto:${peer.sessionId}`, h.clock.nowIso()]);
  const before = h.cp.db.all('SELECT * FROM inbound_messages');
  const beforeTasks = h.cp.tasks.list(run.runId);
  const beforePlan = h.cp.artifacts.latest(run.runId, ArtifactKind.PLAN)!;
  const refusal = await callCtoTool(h, peer, 'plan_submit', request);
  expect.soft(refusal).toMatchObject({ ok: false, reasonCode: 'MCP_REPLAY_UNVERIFIABLE' });
  const instruction = bootstrapPlanGuide().submit.join(' ');
  expect.soft(instruction).toContain('only when the durable effect matches THIS request');
  expect.soft(instruction).toContain('stored PLAN digest equals the digest of the PLAN this request would submit');
  expect.soft(instruction).toContain('an unclear refusal never authorizes resubmitting under a new key');
  const durable = await callCtoTool(h, peer, 'contract_get', { runId: run.runId });
  expect(durable).toMatchObject({ ok: true });
  // Follow the emitted rule against the actual durable effect. The old wording accepts any PLAN.
  const storedPlan = (durable.value as { plan?: Record<string, unknown> }).plan ?? beforePlan.content;
  const storedTasks = (durable.value as { tasks: Array<{ title: string; category: string; dependsOn: string[]; spec: Record<string, unknown> }> }).tasks;
  const completed = instruction.includes('only when the durable effect matches THIS request')
   ? digestOf(storedPlan) === digestOf(request.plan)
     && digestOf(storedTasks.map(({ title, category, dependsOn, spec }) => ({ title, category, dependsOn, spec })))
       === digestOf(request.tasks.map(({ title, category, dependsOn, spec }) => ({ title, category, dependsOn, spec })))
   : Boolean(storedPlan);
  expect.soft(completed).toBe(scenario === 'matching');
  if (instruction.includes('Use a new idempotencyKey for every call')) {
   await callCtoTool(h, peer, 'plan_submit', { ...request, idempotencyKey: 'unsafe-new-key' });
  }
  // A mismatching effect is neither completion nor permission to run the uncertain request.
  expect.soft(h.cp.tasks.list(run.runId)).toEqual(beforeTasks);
  expect(h.cp.db.all('SELECT * FROM inbound_messages')).toEqual(before);
  expect(h.cp.artifacts.latest(run.runId, ArtifactKind.PLAN)?.digest).toBe(beforePlan.digest);
 } finally { h.cp.close(); }
});
