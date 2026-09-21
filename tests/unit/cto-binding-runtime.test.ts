import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as daemon from "../../src/daemon/agentcpd.ts";
import { createCtoBindingRuntime, daemonCtoBindingRuntime } from "../../src/daemon/cto-binding-runtime.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sha256 } from "../../src/core/digest.ts";
import { defaultProcessAncestryInspector, defaultExecutingImageInspector, defaultTranscriptReader } from "../../src/registry/canonical-self-claim.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER, type Harness } from "../helpers/harness.ts";

const value = <T>(d: Decision<T>): T => { if (!d.allowed) throw new Error(JSON.stringify(d)); return d.value; };
let h: Harness | undefined;
const sockets: Socket[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const close of closers.splice(0).reverse()) await close();
  h?.cp.db.close(); h = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupTempDirs();
});
async function operator(path: string, token: string, method: string, params: unknown) {
  const socket = createConnection(path); sockets.push(socket);
  socket.setTimeout(5000, () => socket.destroy(new Error("fixture timeout")));
  let text = ""; socket.on("data", (c) => { text += c.toString(); });
  const end = once(socket, "end"); socket.end(JSON.stringify({ token, method, params }) + "\n");
  await end; return JSON.parse(text);
}
async function mcp(path: string, credential: unknown, rawResponse = false) {
  const socket = createConnection(path); sockets.push(socket);
  socket.setTimeout(5000, () => socket.destroy(new Error("fixture timeout")));
  let text = ""; let id = 0;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  socket.on("data", (chunk) => { text += chunk.toString();
    while (text.includes("\n")) { const index = text.indexOf("\n"); const line = text.slice(0, index); text = text.slice(index + 1);
      const response = JSON.parse(line); if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id); }
    }
  });
  const call = (method: string, params: unknown): Promise<Record<string, unknown>> => new Promise((resolveCall) => {
    const next = ++id; pending.set(next, resolveCall);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
  });
  socket.write(JSON.stringify(credential) + "\n");
  await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  socket.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return async (args: unknown) => {
    const response = await call("tools/call", { name: "cto_binding_bind", arguments: args });
    if (rawResponse) return response;
    return (response.result as { structuredContent?: Record<string, unknown> })?.structuredContent;
  };
}

it.each(["success", "external-nesting", "reentrant-target", "after-commit-fault", "capacity-boundary", "denied-flood", "non-owner-flood", "wrong-pid", "wrong-native-uuid", "wrong-attestation", "stale-start", "stale-after-transcript"])("Claude target pins use the canonical verifier without canonical owner approval: %s", async (mode) => {
  h = makeHarness(); const { cp, root } = h; await registerFixtureProject(h, "project-a");
  const ceo = cp.sessions.create({ provider: "scripted", model: "ceo", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const target = cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid });
  value(cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
  const nativeUuid = "11111111-1111-4111-8111-111111111111";
  // Only OS observation seams are synthetic. Config, verifier, delegation and writer are production.
  const snapshot = { pid: process.pid, ppid: 1, command: "diagnostic only", cwd: root,
    cwdProbeFailure: null, startedAt: target.osProcessStartedAt,
    argv: ["/fixture/claude", "--session-id", nativeUuid] };
  if (mode === "wrong-pid") snapshot.pid = 1;
  if (mode === "wrong-native-uuid") snapshot.argv[2] = "22222222-2222-4222-8222-222222222222";
  if (mode === "stale-start") snapshot.startedAt = "stale";
  vi.spyOn(defaultProcessAncestryInspector, "snapshot").mockImplementation(() => ({ ...snapshot }));
  vi.spyOn(defaultExecutingImageInspector, "resolve").mockReturnValue({ imagePath: "/fixture/claude",
    version: "0.0.0-fixture", sha256: "sha256:" + (mode === "wrong-attestation" ? "0" : "1").repeat(64) });
  let reenter: (() => void) | undefined;
  vi.spyOn(defaultTranscriptReader, "locate").mockImplementation(() => {
    reenter?.();
    if (mode === "stale-after-transcript") snapshot.startedAt = "reused";
    return { path: join(root, "fixture.jsonl"), sizeBytes: 42 };
  });
  const runtime = createCtoBindingRuntime(cp, JSON.stringify([{ provider: "claude", sessionId: target.sessionId,
    incarnation: target.incarnation, nativeSessionUuid: nativeUuid, requiredExecutorVersion: "0.0.0-fixture",
    expectedExecutorRealpath: "/fixture/claude", expectedExecutorSha256: "sha256:" + "1".repeat(64), expectedCwd: root }]));
  // Nothing is minted before the bind. The runtime exposes `bind` and nothing else, and the only
  // credential in play is the CEO's own session secret against its own live binding.
  expect(Object.keys(runtime)).toEqual(["bind", "release"]);
  const consumed = vi.spyOn(cp.ownerAuthority, "consumeApproval");
  const principal = { sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret! };
  const request = { requestId: randomUUID(), projectId: "project-a", role: "PRIMARY_CTO",
    action: "bind-or-rebind", targetSessionId: target.sessionId, expectedBindingGeneration: 1 };
  const beforeSessions = cp.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")!.n;
  if (mode === "external-nesting") cp.db.tx(() => {
    const before = cp.audit.all();
    expect(runtime.bind(principal, request).allowed).toBe(false);
    expect(cp.db.inTransaction).toBe(true);
    expect(cp.audit.all()).toEqual(before);
    expect(cp.bindings.activePrimaryCto("project-a")).toBeNull();
  });
  if (mode === "reentrant-target") reenter = () => {
    reenter = undefined;
    expect(runtime.bind(principal, { ...request, requestId: "reentrant" }).allowed).toBe(false);
    expect(cp.bindings.activePrimaryCto("project-a")).toBeNull();
  };
  if (mode === "after-commit-fault") {
    const afterCommit = cp.db.afterCommit.bind(cp.db);
    const fault = vi.spyOn(cp.db, "afterCommit").mockImplementationOnce(() => {
      afterCommit(() => { throw new Error("fixture callback fault"); });
    });
    try { expect(() => runtime.bind(principal, request)).toThrow("fixture callback fault"); }
    finally { fault.mockRestore(); }
    expect(cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(1);
    expect(cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(2);
    value(cp.bindings.revoke("PRIMARY_CTO:project-a", "fixture callback boundary"));
    let lastAllowed = false;
    for (let generation = 2; generation <= 1025; generation++) {
      lastAllowed = runtime.bind(principal, { ...request, requestId: `after-fault-${generation}`,
        expectedBindingGeneration: generation }).allowed;
      if (lastAllowed) value(cp.bindings.revoke("PRIMARY_CTO:project-a", "fixture callback boundary"));
    }
    expect(lastAllowed, "generation 1025 must never be admitted after callback failure").toBe(false);
    // Post-commit uncertainty poisons this runtime, not merely the overflowing request.
    expect(cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(1);
    expect(cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(2);
    expect(runtime.bind(principal, { ...request, expectedBindingGeneration: 2 }).allowed).toBe(false);
    return;
  }
  if (mode === "capacity-boundary") {
    for (let generation = 1; generation <= 1023; generation++) {
      value(runtime.bind(principal, { ...request, requestId: `admitted-${generation}`, expectedBindingGeneration: generation }));
      value(cp.bindings.revoke("PRIMARY_CTO:project-a", "fixture capacity boundary"));
    }
    request.expectedBindingGeneration = 1024;
    snapshot.pid = 1;
    for (let i = 0; i < 1025; i++) {
      expect(runtime.bind(principal, { ...request, requestId: `denied-${i}` }).allowed).toBe(false);
    }
    snapshot.pid = process.pid;
    // Denied traffic must not evict the earliest admitted identity or take the last slot.
    expect(runtime.bind(principal, { ...request, requestId: "admitted-1" }).allowed).toBe(false);
    value(runtime.bind(principal, request));
    value(cp.bindings.revoke("PRIMARY_CTO:project-a", "fixture capacity boundary"));
    expect(runtime.bind(principal, { ...request, requestId: "over-capacity", expectedBindingGeneration: 1025 }).allowed).toBe(false);
    expect(cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(1024);
    return;
  }
  if (mode === "denied-flood" || mode === "non-owner-flood") {
    const caller = mode === "non-owner-flood"
      ? { sessionId: target.sessionId, sessionSecret: target.sessionSecret! } : principal;
    snapshot.pid = 1; // Deny at the real pinned-target verifier, after delegation authorization.
    for (let i = 0; i < 1025; i++) {
      expect(runtime.bind(caller, { ...request, requestId: `denied-${i}` }).allowed).toBe(false);
      if (i === 1022 || i === 1023 || i === 1024) {
        expect(cp.bindings.activePrimaryCto("project-a")).toBeNull();
        expect(cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")!.n).toBe(0);
      }
    }
    expect(cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(0);
    snapshot.pid = process.pid;
  }
  const result = runtime.bind(principal, request);
  expect(consumed).not.toHaveBeenCalled();
  expect(cp.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")!.n).toBe(beforeSessions);
  if (!["success", "external-nesting", "reentrant-target", "denied-flood", "non-owner-flood"].includes(mode)) {
    expect(result.allowed).toBe(false);
    expect(cp.bindings.activePrimaryCto("project-a")).toBeNull();
    expect(cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")!.n).toBe(0);
    return;
  }
  expect(result).toMatchObject({ allowed: true, value: { status: "ACTIVE", sessionId: target.sessionId } });
  expect(cp.bindings.activePrimaryCto("project-a")).toMatchObject({ status: "ACTIVE", sessionId: target.sessionId });
  expect(cp.db.get<{ executor_kind: string; target_locator: string }>("SELECT executor_kind, target_locator FROM actor_target_bindings")).toMatchObject({ executor_kind: "claude-cli", target_locator: nativeUuid });
  expect(cp.db.get<{ protocol_version: string }>("SELECT protocol_version FROM actor_target_attestations")?.protocol_version).toBe("acp.canonical-self-claim/v1");
  expect(consumed).not.toHaveBeenCalled();
  expect(runtime.bind(principal, request).allowed).toBe(false);
});

it.each(["authentication", "binding"])("authenticated MCP callback never serializes a private exception: %s", async (seam) => {
  h = makeHarness(); const { cp, root } = h;
  const ceo = cp.sessions.create({ provider: "scripted", model: "fixture", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const listeners = await daemon.startDaemonMcpListeners(cp, root, "isolated-mcp-token", { finalizeApprovedRun: () => {} });
  closers.push(() => listeners.close());
  const call = await mcp(join(root, "hermes.mcp.sock"), {
    token: "isolated-mcp-token", sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret,
  }, true);
  const fail = () => { throw new Error("SYNTHETIC_PRIVATE_ERROR /private/fixture-secret-path"); };
  const fault = seam === "authentication"
    ? vi.spyOn(cp.sessions, "verifySecret").mockImplementation(fail)
    : vi.spyOn(cp.db, "txDecision").mockImplementation(fail);
  let wire: Record<string, unknown> | undefined;
  try {
    wire = await call({ request: { requestId: "fixture-request",
      projectId: "fixture-project", role: "PRIMARY_CTO", action: "bind-or-rebind",
      targetSessionId: ceo.sessionId, expectedBindingGeneration: 1 } });
    expect(fault).toHaveBeenCalled();
  } finally { fault.mockRestore(); }
  expect(JSON.stringify(wire)).not.toContain("SYNTHETIC_PRIVATE_ERROR");
  expect(JSON.stringify(wire)).not.toContain("/private/fixture-secret-path");
  const body = { ok: false, reasonCode: ReasonCode.INTERNAL_ERROR,
    message: "CTO binding request failed", evidence: {} };
  expect(wire?.result).toEqual({ isError: true, structuredContent: body,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }] });
});

it.each([
  ["direct", "internal"], ["wire", "internal"], ["direct", "domain"], ["wire", "domain"],
])("nested target denial stays closed at the MCP publication boundary: %s/%s", async (surface, failure) => {
  h = makeHarness(); const { cp, root } = h; await registerFixtureProject(h, "project-a");
  const ceo = cp.sessions.create({ provider: "scripted", model: "fixture", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const target = cp.sessions.create({ provider: "claude", model: "fixture", osPid: process.pid });
  value(cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
  const nativeUuid = "11111111-1111-4111-8111-111111111111";
  vi.spyOn(defaultProcessAncestryInspector, "snapshot").mockImplementation(() => ({
    pid: process.pid, ppid: 1, command: "fixture", cwd: root, cwdProbeFailure: null,
    startedAt: target.osProcessStartedAt, argv: ["/fixture/claude", "--session-id", nativeUuid],
  }));
  vi.spyOn(defaultExecutingImageInspector, "resolve").mockReturnValue({ imagePath: "/fixture/claude",
    version: "0.0.0-fixture", sha256: "sha256:" + "1".repeat(64) });
  const transcript = vi.spyOn(defaultTranscriptReader, "locate").mockImplementation(() => {
    if (failure === "internal") throw new Error("SYNTHETIC_PRIVATE_ERROR /private/fixture-secret-path");
    return null;
  });
  vi.stubEnv("ACP_CTO_BINDING_TARGETS_JSON", JSON.stringify([{ provider: "claude", sessionId: target.sessionId,
    incarnation: target.incarnation, nativeSessionUuid: nativeUuid, requiredExecutorVersion: "0.0.0-fixture",
    expectedExecutorRealpath: "/fixture/claude", expectedExecutorSha256: "sha256:" + "1".repeat(64), expectedCwd: root }]));
  daemonCtoBindingRuntime(cp);
  const registered = vi.spyOn(McpServer.prototype, "registerTool");
  const listeners = await daemon.startDaemonMcpListeners(cp, root, "isolated-mcp-token", { finalizeApprovedRun: () => {} });
  closers.push(() => listeners.close());
  const call = await mcp(join(root, "hermes.mcp.sock"), {
    token: "isolated-mcp-token", sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret,
  }, true);
  const callback = (registered.mock.calls as unknown as unknown[][]).find(([name]) => name === "cto_binding_bind")?.[2] as
    (args: { request: Record<string, unknown> }) => Promise<unknown>;
  expect(callback).toBeTypeOf("function");
  const request = { requestId: randomUUID(), projectId: "project-a",
    role: "PRIMARY_CTO", action: "bind-or-rebind", targetSessionId: target.sessionId, expectedBindingGeneration: 1 };
  const result = surface === "direct" ? await callback({ request }) : await call({ request });
  expect(transcript).toHaveBeenCalledExactlyOnceWith(nativeUuid);
  expect(cp.bindings.activePrimaryCto("project-a")).toBeNull();
  expect(cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")!.n).toBe(0);
  expect.soft(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_ERROR");
  expect.soft(JSON.stringify(result)).not.toContain("/private/fixture-secret-path");
  const body = failure === "internal"
    ? { ok: false, reasonCode: ReasonCode.INTERNAL_ERROR, message: "CTO binding request failed", evidence: {} }
    : { ok: false, reasonCode: ReasonCode.CONFLICT, message: "authenticated target did not confirm the claimed target",
      evidence: { claimed: { executorKind: "claude-cli", targetLocator: nativeUuid, targetLocatorDigest: sha256(nativeUuid) }, authenticated: null } };
  const expected = { isError: true, structuredContent: body, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  expect(surface === "direct" ? result : (result as Record<string, unknown>).result).toEqual(expected);
});

it("daemon exposes the existing authenticated operator composition", () => {
  expect(Reflect.get(daemon, "startDaemonOperatorSocket")).toBeTypeOf("function");
});

it.each(["success", "wrong-receipt", "missing-target"])("hermes target bind reaches CEO MCP with child producer: %s", async (mode) => {
  h = makeHarness(); const { cp, root } = h; await registerFixtureProject(h, "project-a");
  const ceo = cp.sessions.create({ provider: "scripted", model: "ceo", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY)); value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const target = cp.sessions.create({ provider: "hermes", model: "cto", osPid: process.pid });
  value(cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
  // A real child protocol producer, not a production-injected verify callback. This remains a fixture executor.
  symlinkSync(process.execPath, join(root, "node"));
  writeFileSync(join(root, "producer.mjs"), `import {createHash} from 'node:crypto'; import {writeFileSync} from 'node:fs';
let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
const q=JSON.parse(input); writeFileSync(process.env.HERMES_HOME+'/request.json',input);
const body={domain:q.domain,version:q.version,actor_id:q.actor_id,binding_generation:q.binding_generation,executor_runtime_identity:q.executor_runtime_identity,requested_session_id:q.session_id,lineage_root_digest:q.expected_lineage_root_digest};
const sorted=Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b)));
process.stdout.write(JSON.stringify({...body,receipt_digest:${JSON.stringify(mode)}==='wrong-receipt'?'sha256:'+'0'.repeat(64):'sha256:'+createHash('sha256').update(JSON.stringify(sorted)).digest('hex')})); });`);
  vi.stubEnv("ACP_CTO_BINDING_TARGETS_JSON", JSON.stringify([{ sessionId: target.sessionId, incarnation: target.incarnation,
    hermesExecutable: resolve("tests/fixtures/hermes-target-bind-producer.sh"), hermesProfile: "fixture",
    hermesHome: root, requestedSessionId: "fixture-cto", expectedLineageRootDigest: "sha256:" + "1".repeat(64), executorRuntimeIdentity: "fixture-runtime" }]));
  let held = true;
  // `ctoBinding.delegate` was this socket's method and is gone with the grant. `bootstrap.hermes`
  // is now the only operator method that reads object params, so it is what carries the
  // token/lock/params triple this test has always asserted over the real operator listener.
  const ownerSocket = await daemon.startDaemonOperatorSocket(cp,
    { lock: { held: () => held }, handleOperatorRequest: async () => allow(ReasonCode.OK, {}) } as unknown as Parameters<typeof daemon.startOperatorSocket>[0],
    root, { token: "isolated-owner-token", peerId: "fixture-owner", actor: TEST_OWNER.actor },
    { bootstrapHermes: (params) => Promise.resolve(allow(ReasonCode.OK, params)) });
  closers.push(() => ownerSocket.close());
  const listeners = await daemon.startDaemonMcpListeners(cp, root, "isolated-mcp-token", { finalizeApprovedRun: () => {} });
  closers.push(() => listeners.close());
  const params = { profile: "fixture" };
  expect((await operator(ownerSocket.socketPath, "wrong", "bootstrap.hermes", params)).allowed).toBe(false);
  held = false;
  expect((await operator(ownerSocket.socketPath, "isolated-owner-token", "bootstrap.hermes", params)).allowed).toBe(false);
  held = true;
  expect(value(await operator(ownerSocket.socketPath, "isolated-owner-token", "bootstrap.hermes", params))).toEqual(params);
  const bind = await mcp(join(root, "hermes.mcp.sock"), { token: "isolated-mcp-token", sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret });
  const request = { requestId: randomUUID(), projectId: "project-a", role: "PRIMARY_CTO", action: "bind-or-rebind", targetSessionId: mode === "missing-target" ? ceo.sessionId : target.sessionId, expectedBindingGeneration: 1 };
  const result = await bind({ request });
  if (!["success", "denied-flood", "non-owner-flood"].includes(mode)) {
    expect(result).toMatchObject({ ok: false });
    expect(cp.bindings.activePrimaryCto("project-a")).toBeNull();
    expect(cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")?.n).toBe(0);
    return;
  }
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(cp.bindings.activePrimaryCto("project-a")).toMatchObject({ status: "ACTIVE", sessionId: target.sessionId });
  const record = cp.db.get<{ protocol_version: string; target_bind_receipt_json: string }>("SELECT protocol_version, target_bind_receipt_json FROM actor_target_attestations");
  expect(record?.protocol_version).toBe("hermes.target-bind/v1");
  expect(JSON.parse(record!.target_bind_receipt_json)).toMatchObject({ binding_generation: 1, requested_session_id: "fixture-cto", executor_runtime_identity: "fixture-runtime" });
  expect(JSON.parse(readFileSync(join(root, "request.json"), "utf8"))).toMatchObject({ binding_generation: 1, session_id: "fixture-cto" });
  expect((await bind({ request }))?.ok).toBe(false); // explicit restart/replay limitation, not fabricated durable idempotency
  value(cp.bindings.revoke(Role.CEO, "fixture loss"));
  expect((await bind({ request }))?.ok).toBe(false);
}, 15000);
