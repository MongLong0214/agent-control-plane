import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { Role, RunKind, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import type { AuthenticatedMcpPeer, ToolResult } from "../../src/mcp/shared.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { openActivationHandoff, producedHandoff } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

type Peer = AuthenticatedMcpPeer & { sessionSecret?: string };
const call = async (h: Harness, peer: Peer, args: Record<string, unknown>, name = "handoff_ack") => {
  const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, peer));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handoff-retry-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
};

const fixture = (canonical: boolean) => {
  const h = makeHarness();
  const { cp } = h;
  const projectId = "ack-replay";
  cp.projects.register({ projectId, name: projectId });
  const session = cp.sessions.create({ provider: "scripted", model: "test", buzzAddress: "buzz:ack-replay" });
  cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "fixture");
  cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: "actor:ack-replay" }, { isAllowedActor: () => true });
  const targetLocator = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator, targetLocatorDigest: sha256(targetLocator) };
  const binding = cp.bindings.bind({
    role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId,
    ...(canonical ? { authenticatedTarget: { claimed, protocolVersion: SELF_CLAIM_PROTOCOL, attestationDigest: digestOf(claimed), verify: () => claimed } } : {}),
  });
  if (!binding.allowed) throw new Error(binding.message);
  const peer: Peer = { actor: `cto:${session.sessionId}`, sessionId: session.sessionId, sessionIncarnation: session.incarnation,
    binding: { roleKey: binding.value.roleKey, bindingGeneration: binding.value.bindingGeneration } };
  const open = () => {
    const run = cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: {
      goal: "bootstrap", why: "replay boundary", scope: [], nonGoals: [], acceptance: ["ready"], priority: "NORMAL", humanGate: [], references: [],
    } });
    if (!run.allowed) throw new Error(run.message);
    const f = { harness: h } as Parameters<typeof producedHandoff>[0];
    const opened = openActivationHandoff(f)(projectId, run.value.runId, session.sessionId, producedHandoff(f, run.value.runId, projectId));
    if (!opened.allowed) throw new Error(opened.message);
    const message = cp.outbox.byIdempotencyKey(`bootstrap-handoff:${opened.value.handoffId}`)!;
    return { handoffId: opened.value.handoffId, messageId: message.messageId, bindingGeneration: message.bindingGeneration, payloadDigest: message.payloadDigest };
  };
  const request = { idempotencyKey: "lost-ack-response", ...open() };
  const deliver = async () => {
    if (canonical) {
      expect(await call(h, peer, {}, "role_dispatch_pending")).toMatchObject({ ok: true, value: { messages: [expect.objectContaining({ messageId: request.messageId })] } });
    } else {
      await h.buzzAdapter.deliverPending();
      expect(cp.outbox.get(request.messageId)?.status).toBe("SENT");
    }
  };
  const snapshot = (includeReservations = true) => Object.fromEntries(
    ["handoffs", "outbox", "audit_events", "assignments", "sessions", ...(includeReservations ? ["inbound_messages"] : [])]
      .map(table => [table, cp.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]),
  );
  return { h, cp, projectId, session, peer, request, open, deliver, snapshot };
};

for (const canonical of [true, false]) {
  const route = canonical ? "in-band" : "Buzz";
  it.each(["IDENTIFIERS", "NEVER_READABLE", "REVOKED_PROJECT"] as const)(`FV52-05 ${route}: cached ACK refuses %s without effects`, async changed => {
    const w = fixture(canonical);
    try {
      await w.deliver();
      expect(await call(w.h, w.peer, w.request)).toMatchObject({ ok: true });
      let retry = { ...w.request };
      if (changed === "IDENTIFIERS") retry = { ...retry, messageId: "different-package", bindingGeneration: 99, payloadDigest: "sha256:different" };
      if (changed === "NEVER_READABLE") {
        retry = { ...retry, ...w.open() };
        w.cp.db.run("UPDATE outbox SET status = 'REJECTED' WHERE message_id = ?", [retry.messageId]);
        expect(await call(w.h, w.peer, {}, "role_dispatch_pending")).toMatchObject({ ok: true, value: { messages: [] } });
      }
      if (changed === "REVOKED_PROJECT") {
        w.cp.projects.register({ projectId: "sibling", name: "sibling" });
        const sibling = w.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "sibling", sessionId: w.session.sessionId });
        if (!sibling.allowed) throw new Error(sibling.message);
        expect(w.cp.bindings.revoke(w.cp.bindings.activePrimaryCto(w.projectId)!.roleKey, "revoked").allowed).toBe(true);
        expect(w.cp.bindings.authenticateBoundSession({ roleKey: sibling.value.roleKey, sessionId: w.session.sessionId, sessionSecret: w.session.sessionSecret!, bindingGeneration: sibling.value.bindingGeneration }).allowed).toBe(true);
      }
      const before = w.snapshot();
      expect(await call(w.h, w.peer, retry)).toMatchObject({ ok: false, reasonCode: changed === "REVOKED_PROJECT" ? "HANDOFF_ACK_REQUIRED" : "CONFLICT" });
      expect(w.snapshot()).toEqual(before);
      const domainBefore = w.snapshot(false);
      expect(await call(w.h, w.peer, { ...retry, idempotencyKey: "fresh-key" })).toMatchObject({ ok: false, reasonCode: "HANDOFF_ACK_REQUIRED" });
      expect(w.snapshot(false)).toEqual(domainBefore);
    } finally { w.cp.close(); }
  });

  it(`${route}: a lost-response retry returns the durable first success with one reservation and no double effect`, async () => {
    const w = fixture(canonical);
    try {
      await w.deliver();
      const first = await call(w.h, w.peer, w.request);
      expect(first).toMatchObject({ ok: true });
      const settled = w.snapshot();
      w.h.clock.advance(1_000);
      expect(await call(w.h, w.peer, w.request)).toEqual(first);
      expect(w.snapshot()).toEqual(settled);
      expect(w.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [w.request.idempotencyKey])).toHaveLength(1);
      expect(w.cp.audit.byKind("HANDOFF_ACK")).toHaveLength(1);
    } finally { w.cp.close(); }
  });

  it(`${route}: another peer cannot reuse a completed key`, async () => {
    const w = fixture(canonical);
    const other = fixture(canonical);
    try {
      await w.deliver();
      expect(await call(w.h, w.peer, w.request)).toMatchObject({ ok: true });
      const before = w.snapshot();
      expect(await call(w.h, other.peer, w.request)).toMatchObject({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      expect(w.snapshot()).toEqual(before);
    } finally { w.cp.close(); other.cp.close(); }
  });
}

it.each(["handoffId", "messageId", "bindingGeneration", "payloadDigest"] as const)("same-key replay binds %s independently", async field => {
  const w = fixture(true);
  try {
    await w.deliver();
    expect(await call(w.h, w.peer, w.request)).toMatchObject({ ok: true });
    const before = w.snapshot();
    expect(await call(w.h, w.peer, { ...w.request, [field]: field === "bindingGeneration" ? 99 : "changed" })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
    expect(w.snapshot()).toEqual(before);
  } finally { w.cp.close(); }
});

it.each(["sessionId", "sessionIncarnation"] as const)("same actor cannot replay under a different %s", async field => {
  const w = fixture(true);
  try {
    expect(await call(w.h, w.peer, w.request)).toMatchObject({ ok: true });
    const before = w.snapshot();
    expect(await call(w.h, { ...w.peer, [field]: "different" }, w.request)).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
    expect(w.snapshot()).toEqual(before);
  } finally { w.cp.close(); }
});

it("a key for package A cannot replay success for an independently ACKED package B", async () => {
  const w = fixture(true);
  try {
    expect(await call(w.h, w.peer, w.request)).toMatchObject({ ok: true });
    const second = w.open();
    expect(await call(w.h, w.peer, { ...second, idempotencyKey: "second-ack" })).toMatchObject({ ok: true });
    const before = w.snapshot();
    expect(await call(w.h, w.peer, { ...second, idempotencyKey: w.request.idempotencyKey })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
    expect(w.snapshot()).toEqual(before);
  } finally { w.cp.close(); }
});

it("an in-flight ACK key is reserved once; a parallel retry cannot execute the ACK", async () => {
  const w = fixture(true);
  const server = createCtoServer(createCtoMcpPort(w.cp), () => allow(ReasonCode.OK, w.peer));
  try {
    // Enter the registered callbacks in the same turn: separate transport handshakes could
    // serialize the calls and exercise completed replay instead of an in-flight reservation.
    const invoke = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: typeof w.request) => Promise<ToolResult> }>;
    })._registeredTools["handoff_ack"]!.handler;
    const results = (await Promise.all([invoke(w.request), invoke(w.request)])).map(result => result.structuredContent);
    expect(results.filter(result => result?.["ok"] === true)).toHaveLength(1);
    expect(results).toContainEqual(expect.objectContaining({ ok: false, reasonCode: "INGRESS_REPLAY_IGNORED" }));
    expect(await call(w.h, w.peer, w.request)).toEqual(results.find(result => result?.["ok"] === true));
    expect(w.cp.audit.byKind("HANDOFF_ACK")).toHaveLength(1);
    expect(w.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [w.request.idempotencyKey])).toHaveLength(1);
  } finally { await server.close(); w.cp.close(); }
});

it("handoff_ack cannot trust another tool's cached success", async () => {
  const w = fixture(true);
  try {
    expect(await call(w.h, w.peer, { idempotencyKey: w.request.idempotencyKey }, "capacity_get")).toMatchObject({ ok: true });
    const before = w.snapshot();
    expect(await call(w.h, w.peer, w.request)).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
    expect(w.snapshot()).toEqual(before);
  } finally { w.cp.close(); }
});

const switchoverFixture = async () => {
  const w = fixture(false);
  // The scripted adapter starts no provider process; the credential checker is a local double.
  w.cp.cto.attach({
    handoffAuthentication: { verifyHandoffAcknowledgement: () => allow(ReasonCode.OK, undefined) },
  });
  const handoff: HandoffPackage = { projectStatus: "ACTIVE", activeManifestDigest: null, recentDecisions: [], openBlockers: [], queuedWork: [], repositoryFacts: [], knownRisks: [], recommendedNextAction: "continue" };
  const prepared = await w.cp.cto.prepareSwitchover(w.projectId, handoff);
  if (!prepared.allowed) throw new Error(prepared.message);
  const incoming = w.cp.sessions.require(prepared.value.incomingSessionId);
  const message = w.cp.outbox.byIdempotencyKey(`handoff:${prepared.value.handoffId}`)!;
  w.cp.db.run("UPDATE outbox SET status = 'SENT' WHERE message_id = ?", [message.messageId]);
  const peer = { actor: `cto:${incoming.sessionId}`, sessionId: incoming.sessionId, sessionIncarnation: incoming.incarnation, sessionSecret: "fixture-credential" };
  const request = { idempotencyKey: "switchover-ack", handoffId: prepared.value.handoffId, messageId: message.messageId, bindingGeneration: message.bindingGeneration, payloadDigest: message.payloadDigest };
  return { ...w, peer, request };
};

it.each(["UNCHANGED", "IDENTIFIERS", "REVOKED_PROJECT", "INCARNATION"] as const)("switchover ACK cached retry: %s", async changed => {
  const w = await switchoverFixture();
  try {
    const first = await call(w.h, w.peer, w.request);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    if (changed === "REVOKED_PROJECT") expect(w.cp.bindings.revoke(w.cp.bindings.activePrimaryCto(w.projectId)!.roleKey, "revoked").allowed).toBe(true);
    const before = w.snapshot();
    const result = await call(w.h, changed === "INCARNATION" ? { ...w.peer, sessionIncarnation: "different" } : w.peer,
      changed === "IDENTIFIERS" ? { ...w.request, payloadDigest: "sha256:different" } : w.request);
    if (changed === "UNCHANGED") expect(result).toEqual(first);
    else expect(result).toMatchObject({ ok: false, reasonCode: changed === "REVOKED_PROJECT" ? "HANDOFF_ACK_REQUIRED" : "CONFLICT" });
    expect(w.snapshot()).toEqual(before);
    expect(w.cp.audit.byKind("HANDOFF_ACK")).toHaveLength(1);
  } finally { w.cp.close(); }
});
