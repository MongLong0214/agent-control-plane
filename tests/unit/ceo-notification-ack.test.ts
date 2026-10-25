import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { DIGEST, LIVE } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs, seedRun } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness } from "../helpers/harness.ts";

const grant = `sha256:${"d".repeat(64)}`;
const owner = { session_id: LIVE, lineage_root_digest: DIGEST, principal: "owner", cron: false,
  delegation_depth: 0, session_key: "owner", platform: "telegram", chat_id: "1001", parent_chat_id: null };
const open: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of open.splice(0)) await close(); });
afterAll(cleanupTempDirs);

const fixture = async () => {
  const h = makeHarness();
  const ceo = bindCeo(h);
  const binding = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const peer = { actor: ceo, sessionId: ceo, sessionIncarnation: h.cp.sessions.require(ceo).incarnation };
  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, peer),
    { provenance: { liveHermesSessionId: LIVE, lineageRootDigest: DIGEST } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ceo-notification-ack-test", version: "1" });
  await client.connect(clientTransport);
  open.push(async () => { await client.close(); await server.close(); h.cp.close(); });
  const queued = h.cp.outbox.enqueue({ idempotencyKey: "notification", roleKey: binding.roleKey,
    targetSessionId: ceo, bindingGeneration: binding.bindingGeneration,
    kind: MessageKind.CEO_NOTIFICATION, payload: { intent: "receipt test" } });
  if (!queued.allowed) throw new Error(queued.message);
  const messageId = queued.value.messageId;
  // A posted delivery; keep the sending path outside this receipt-only test.
  h.cp.db.run("UPDATE outbox SET status = 'SENT', sent_at = ? WHERE message_id = ?", [h.clock.nowIso(), messageId]);
  const call = async (args: Record<string, unknown> = {}, turn: Record<string, unknown> | null = owner) => {
    const result = await client.callTool({ name: "ceo_notification_ack", arguments: { idempotencyKey: "ack", messageId, ...args },
      ...(turn === null ? {} : { _meta: { [HERMES_PROVENANCE_META_KEY]: turn } }) });
    return result.structuredContent;
  };
  const state = () => ({ outbox: h.cp.db.all("SELECT * FROM outbox"), audit: h.cp.db.all("SELECT * FROM audit_events"),
    runs: h.cp.db.all("SELECT * FROM runs") });
  return { h, ceo, binding, peer, server, client, messageId, call, state };
};

it.each(["owner", "peer"])("ACKs a SENT notification under the same ID on a %s turn, with one attributed audit", async principal => {
  const f = await fixture();
  const run = seedRun({ db: f.h.cp.db, clock: f.h.clock, repoPath: f.h.repoPath, claim: false });
  f.h.cp.db.run("UPDATE outbox SET run_id = ? WHERE message_id = ?", [run.runId, f.messageId]);
  const beforeRuns = f.h.cp.db.all("SELECT * FROM runs");
  const result = await f.call({}, principal === "owner" ? owner : { ...owner, principal, peer_grant: grant });
  expect(result).toMatchObject({ ok: true, value: { messageId: f.messageId } });
  expect(f.h.cp.db.get("SELECT status, acked_at FROM outbox WHERE message_id = ?", [f.messageId]))
    .toEqual({ status: "ACKED", acked_at: f.h.clock.nowIso() });
  const audits = f.h.cp.audit.forRun(run.runId).filter(a => a.kind === "CEO_NOTIFICATION_ACKED");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ runId: run.runId, sessionId: f.ceo, roleKey: "CEO", evidence: {
    messageId: f.messageId, sessionId: f.ceo, bindingGeneration: f.binding.bindingGeneration,
    hermesPrincipal: principal, hermesPeerGrant: principal === "peer" ? grant : null,
  } });
  expect(f.h.cp.db.all("SELECT * FROM runs")).toEqual(beforeRuns);
});

it("repeats idempotently through MCP and domain receipt checks without a second audit", async () => {
  const f = await fixture();
  const first = await f.call();
  expect(first).toMatchObject({ ok: true });
  const before = f.state();
  expect(await f.call()).toEqual(first);
  expect(await f.call({ idempotencyKey: "domain-repeat" })).toEqual(first);
  expect(f.state()).toEqual(before);
});

it("binds a fresh domain-repeat key before it can be reused for another message", async () => {
  const f = await fixture();
  expect(await f.call()).toMatchObject({ ok: true });
  expect(await f.call({ idempotencyKey: "domain-repeat" })).toMatchObject({ ok: true });
  const queued = f.h.cp.outbox.enqueue({ idempotencyKey: "another-notification", roleKey: "CEO",
    targetSessionId: f.ceo, bindingGeneration: f.binding.bindingGeneration,
    kind: MessageKind.CEO_NOTIFICATION, payload: {} });
  if (!queued.allowed) throw new Error(queued.message);
  f.h.cp.db.run("UPDATE outbox SET status = 'SENT', sent_at = ? WHERE message_id = ?", [f.h.clock.nowIso(), queued.value.messageId]);
  const before = f.state();
  expect(await f.call({ idempotencyKey: "domain-repeat", messageId: queued.value.messageId }))
    .toMatchObject({ ok: false, reasonCode: "CONFLICT" });
  expect(f.state()).toEqual(before);
});

it("replays a receipt when the audit clock advances after the ACK timestamp", async () => {
  const f = await fixture();
  const record = f.h.cp.audit.record.bind(f.h.cp.audit);
  vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => {
    f.h.clock.advance(1);
    return record(input);
  });
  const first = await f.call();
  expect(first).toMatchObject({ ok: true });
  const before = f.state();
  expect(await f.call()).toEqual(first);
  expect(f.state()).toEqual(before);
});

it.each([
  ["wrong target", "target_session_id = 'another-session'", "OUTBOX_STALE_GENERATION_REJECTED"],
  ["stale generation", "binding_generation = binding_generation + 1", "OUTBOX_STALE_GENERATION_REJECTED"],
  ["other binding", "role_key = 'PRIMARY_CTO:other'", "OUTBOX_STALE_GENERATION_REJECTED"],
  ["PENDING", "status = 'PENDING', sent_at = NULL", "INVALID_ARGUMENT"],
  ["EXPIRED", "status = 'EXPIRED'", "OUTBOX_EXPIRED"],
  ["REJECTED", "status = 'REJECTED'", "OUTBOX_STALE_GENERATION_REJECTED"],
  ["expired SENT", "expires_at = created_at", "OUTBOX_EXPIRED"],
  ["other kind", "kind = 'ESCALATION_REPLY'", "INVALID_ARGUMENT"],
  ["unproven ACKED", "status = 'ACKED', acked_at = sent_at", "CONFLICT"],
])("refuses %s with the row, audit and run unchanged", async (_label, change, reasonCode) => {
  const f = await fixture();
  f.h.cp.db.run(`UPDATE outbox SET ${change} WHERE message_id = ?`, [f.messageId]);
  const before = f.state();
  expect(await f.call()).toMatchObject({ ok: false, reasonCode });
  expect(f.state()).toEqual(before);
});

it("refuses an unknown ID with no domain state change", async () => {
  const f = await fixture();
  const before = f.state();
  expect(await f.call({ messageId: "unknown" })).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
  expect(f.state()).toEqual(before);
});

it("refuses missing provenance and incomplete identity before reserving an MCP key", async () => {
  const f = await fixture();
  const before = f.state();
  const reservations = f.h.cp.db.all("SELECT * FROM inbound_messages");
  expect(await f.call({}, null)).toMatchObject({ ok: false, reasonCode: "MCP_TOOL_PROVENANCE_REFUSED" });
  f.peer.sessionIncarnation = "wrong-incarnation";
  expect(await f.call()).toMatchObject({ ok: false });
  expect(f.state()).toEqual(before);
  expect(f.h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(reservations);
});

it.each(["target", "generation", "binding", "PENDING"])("rechecks %s before replaying a stored success", async changed => {
  const f = await fixture();
  expect(await f.call()).toMatchObject({ ok: true });
  if (changed === "binding") {
    expect(f.h.cp.bindings.revoke("CEO", "binding replaced").allowed).toBe(true);
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.ceo }).allowed).toBe(true);
  } else {
    const sql = changed === "target" ? "target_session_id = 'another-session'" : changed === "generation"
      ? "binding_generation = binding_generation + 1" : "status = 'PENDING'";
    f.h.cp.db.run(`UPDATE outbox SET ${sql} WHERE message_id = ?`, [f.messageId]);
  }
  const before = f.state();
  expect(await f.call()).toMatchObject({ ok: false });
  expect(f.state()).toEqual(before);
});

it("recovers the exact ACK after response storage fails, refusing changed arguments or principal", async () => {
  const f = await fixture();
  const original = f.h.cp.db.run.bind(f.h.cp.db);
  const store = vi.spyOn(f.h.cp.db, "run").mockImplementation((sql, params) => {
    if (sql.includes("UPDATE inbound_messages SET result_json")) throw new Error("response store failed");
    return original(sql, params);
  });
  await f.call();
  store.mockRestore();
  expect(f.h.cp.outbox.get(f.messageId)?.status).toBe("ACKED");
  const before = f.state();
  expect(await f.call({ messageId: "unknown" })).toMatchObject({ ok: false });
  expect(await f.call({}, { ...owner, principal: "peer", peer_grant: grant })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
  expect(await f.call()).toMatchObject({ ok: true });
  expect(f.state()).toEqual(before);
});

it("rolls back notification ACK and audit on audit denial", async () => {
  const f = await fixture();
  const before = f.state();
  const record = f.h.cp.audit.record.bind(f.h.cp.audit);
  vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => {
    const result = record(input);
    return input.kind === "CEO_NOTIFICATION_ACKED" ? deny(ReasonCode.CONFLICT, "audit refused after write") : result;
  });
  expect(await f.call()).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
  expect(f.state()).toEqual(before);
});

it("lists the receipt-only tool on Hermes CEO and excludes it from CTO", async () => {
  const f = await fixture();
  const tool = (await f.client.listTools()).tools.find(t => t.name === "ceo_notification_ack");
  expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["messageId", "idempotencyKey"]));
  expect(tool?.inputSchema.properties).not.toHaveProperty("runId");
  expect(tool?.description).toContain("receipt and processing");
  expect(tool?.description).toContain("never owner approval, escalation resolution or execution approval");
  const server = createCtoServer(createCtoMcpPort(f.h.cp), () => allow(ReasonCode.OK, f.peer));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "cto-list-test", version: "1" });
  await client.connect(ct);
  try { expect((await client.listTools()).tools.map(t => t.name)).not.toContain("ceo_notification_ack"); }
  finally { await client.close(); await server.close(); }
});
