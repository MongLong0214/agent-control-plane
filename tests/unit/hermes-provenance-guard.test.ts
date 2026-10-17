import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { AdoptedCeoAdmission } from "../../src/bootstrap/adopted-ceo-tool-admission.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import {
  admitHermesProvenance,
  HERMES_PEER_DELEGABLE_TOOLS,
  HERMES_PROVENANCE_META_KEY,
  HERMES_READ_ONLY_TOOLS,
} from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { respond } from "../../src/mcp/shared.ts";
import {
  adoptedFixture,
  CEO,
  count,
  DIGEST,
  LIVE,
  OTHER_DIGEST,
  type AdoptedCeoFixture,
} from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The adopted CEO tool channel's caller-provenance guard (#1037), driven through a real MCP client
 * and server over the SDK's in-memory transport, so `params._meta` travels the same request parser
 * a socket connection uses. The channel's authority is a real admission of the adopted Gateway.
 *
 * Every refusal is asserted by its code and by nothing being written: no run, no idempotency
 * reservation, no audit row.
 */

const OWNER_TURN = {
  session_id: LIVE,
  session_key: "agent:main:telegram:dm:1001",
  platform: "telegram",
  chat_id: "1001",
  cron: false,
  parent_chat_id: null,
  principal: "owner",
  lineage_root_digest: DIGEST,
  delegation_depth: 0,
} as const;

const provenance = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  [HERMES_PROVENANCE_META_KEY]: { ...OWNER_TURN, ...overrides },
});

const withoutField = (field: keyof typeof OWNER_TURN): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...OWNER_TURN };
  delete copy[field];
  return { [HERMES_PROVENANCE_META_KEY]: copy };
};

let nextKey = 0;
const runCreate = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  idempotencyKey: `adopted-run-${nextKey++}`,
  projectId: null,
  executionMode: "SIMPLE",
  contract: {
    goal: "start the requested work",
    why: "the owner asked for it",
    scope: [],
    nonGoals: [],
    acceptance: ["a run exists"],
    priority: "NORMAL",
    humanGate: [],
    references: [],
  },
  repositories: [],
  ...extra,
});

interface Channel {
  fixture: AdoptedCeoFixture;
  admitted: AdoptedCeoAdmission;
  client: Client;
  call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<Record<string, unknown>>;
  writes(): { runs: number; reservations: number; audit: number };
}

const open: Array<{ client: Client; fixture: AdoptedCeoFixture }> = [];
afterEach(async () => {
  for (const { client, fixture } of open.splice(0)) {
    await client.close();
    fixture.h.cp.close();
  }
});
afterAll(cleanupTempDirs);

const channel = async (adopted = true, register?: (server: ReturnType<typeof createHermesServer>) => void): Promise<Channel> => {
  const fixture = adoptedFixture();
  const admission = fixture.admission();
  const decision = await fixture.admit();
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  const admitted = decision.value;
  const { h } = fixture;
  // What `startAdoptedCeoToolSocket` builds for an admitted connection; the bootstrapped CEO's
  // server is the same factory with no provenance.
  const server = createHermesServer(
    createHermesMcpPort(h.cp),
    adopted
      ? () => admission.authenticate(admitted)
      : () => allow(ReasonCode.OK, { actor: admitted.sessionId, sessionId: admitted.sessionId }),
    adopted ? { provenance: admitted.provenance } : {},
  );
  register?.(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "hermes-gateway-fixture", version: "1" });
  await client.connect(clientTransport);
  open.push({ client, fixture });
  return {
    fixture,
    admitted,
    client,
    call: async (name, args, meta) => {
      const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      return (result.structuredContent ?? {}) as Record<string, unknown>;
    },
    writes: () => ({
      runs: count(h, "SELECT COUNT(*) AS n FROM runs"),
      reservations: count(h, "SELECT COUNT(*) AS n FROM inbound_messages"),
      audit: count(h, "SELECT COUNT(*) AS n FROM audit_events"),
    }),
  };
};

const expectRefused = async (
  subject: Channel,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
  reasonCode: ReasonCode = ReasonCode.MCP_TOOL_PROVENANCE_REFUSED,
): Promise<void> => {
  const before = subject.writes();
  const body = await subject.call(name, args, meta);
  expect(body).toMatchObject({ ok: false, reasonCode });
  expect(subject.writes()).toEqual(before);
};

describe("the adopted CEO tool channel admits only the owner's own top-level turn", () => {
  it("admits run_create with the Hermes Gateway's provenance for the bound session and lineage", async () => {
    const subject = await channel();
    const before = subject.writes();
    const body = await subject.call("run_create", runCreate(), provenance());
    expect(body).toMatchObject({ ok: true, value: { state: "QUEUED", goal: "start the requested work" } });
    expect(subject.writes().runs).toBe(before.runs + 1);
  });

  it.each([
    ["no _meta at all", undefined],
    ["_meta without the provenance key", { progressToken: 7 }],
    ["provenance that is not an object", { [HERMES_PROVENANCE_META_KEY]: "owner" }],
    ["another chat's Hermes session", provenance({ session_id: "20261002_080000_other_chat" })],
    ["no Hermes session", withoutField("session_id")],
    ["another lineage", provenance({ lineage_root_digest: OTHER_DIGEST })],
    ["a lineage root that is a raw session id, not its digest", provenance({ lineage_root_digest: LIVE })],
    ["no lineage_root_digest", withoutField("lineage_root_digest")],
    ["the pre-release field name lineage_root instead of lineage_root_digest", {
      [HERMES_PROVENANCE_META_KEY]: { ...withoutField("lineage_root_digest")[HERMES_PROVENANCE_META_KEY] as object, lineage_root: DIGEST },
    }],
    ["a scheduled (cron) turn", provenance({ cron: true })],
    ["a cron flag that is not a boolean", provenance({ cron: "false" })],
    ["no cron flag", withoutField("cron")],
    ["a subagent (delegation_depth 1)", provenance({ delegation_depth: 1 })],
    ["a nested subagent (delegation_depth 3)", provenance({ delegation_depth: 3 })],
    ["no delegation_depth", withoutField("delegation_depth")],
    ["a delegation_depth that is not a number", provenance({ delegation_depth: "0" })],
    ["a peer's turn", provenance({ principal: "peer" })],
    ["an unknown principal", provenance({ principal: "admin" })],
    ["no principal", withoutField("principal")],
  ])("refuses run_create, writing nothing, for %s", async (_case, meta) => {
    const subject = await channel();
    await expectRefused(subject, "run_create", runCreate(), meta);
  });

  it("never reads provenance from arguments, however it is spelled there", async () => {
    const subject = await channel();
    // A model writes arguments. A provenance-shaped object there is the caller describing itself.
    await expectRefused(subject, "run_create", runCreate({
      _meta: provenance(),
      [HERMES_PROVENANCE_META_KEY]: OWNER_TURN,
      provenance: OWNER_TURN,
    }));
    // And a forged copy in arguments cannot repair a refused one in `params._meta`.
    await expectRefused(
      subject,
      "run_create",
      runCreate({ _meta: provenance() }),
      provenance({ principal: "peer" }),
    );
  });

  it("refuses a provenance-shaped object in arguments even where the tool's schema keeps it", async () => {
    // A schema that passes unknown keys through, so `_meta` survives into the parsed arguments and
    // only the guard's own choice of where to look stands between it and an admission.
    const subject = await channel(true, (server) => {
      server.registerTool(
        "fixture_passthrough",
        { description: "fixture", inputSchema: z.object({}).passthrough() },
        async () => respond(allow(ReasonCode.OK, { reached: true })),
      );
    });
    await expectRefused(subject, "fixture_passthrough", {
      _meta: provenance(),
      [HERMES_PROVENANCE_META_KEY]: OWNER_TURN,
    });
    expect(await subject.call("fixture_passthrough", {}, provenance())).toMatchObject({ ok: true });
  });

  it("guards every non-read-only tool, including doctor_run and tools registered after construction", async () => {
    const subject = await channel(true, (server) => {
      // Stands in for `cto_binding_bind`, which `agentcpd.ts` registers on the returned server.
      server.registerTool(
        "fixture_registered_later",
        { description: "fixture", inputSchema: { request: z.record(z.unknown()) } },
        async () => respond(allow(ReasonCode.OK, { reached: true })),
      );
    });
    await expectRefused(subject, "doctor_run", { scope: "session" });
    await expectRefused(subject, "fixture_registered_later", { request: {} });
    expect(await subject.call("fixture_registered_later", { request: {} }, provenance()))
      .toMatchObject({ ok: true, value: { reached: true } });
    const listed = (await subject.client.listTools()).tools.map((tool) => tool.name);
    expect(listed.filter((name) => HERMES_READ_ONLY_TOOLS.has(name)).sort())
      .toEqual(["continuity_status", "project_get", "run_get"]);
  });

  it("serves read-only tools without provenance", async () => {
    const subject = await channel();
    expect(await subject.call("run_get", { runId: "run_absent" }))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.NOT_FOUND });
    expect(await subject.call("continuity_status", {})).toMatchObject({ ok: true });
  });

  it("refuses even a valid owner turn once the CEO binding has moved off the admitted runtime", async () => {
    const subject = await channel();
    const { h } = subject.fixture;
    expect(h.cp.bindings.revoke(CEO, "operator re-adoption").allowed).toBe(true);
    const replacement = h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: 1_234_567 });
    expect(h.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: replacement.sessionId }).allowed).toBe(true);
    await expectRefused(subject, "run_create", runCreate(), provenance(), ReasonCode.BINDING_GENERATION_STALE);
  });

  it("leaves a bootstrapped CEO's server as it was: no provenance is asked for", async () => {
    const subject = await channel(false);
    expect(await subject.call("run_create", runCreate())).toMatchObject({ ok: true });
  });
});

describe("admitHermesProvenance, as a pure decision", () => {
  const anchor = { liveHermesSessionId: LIVE, lineageRootDigest: DIGEST };

  it("admits exactly the agreed owner turn and nothing without an anchor", () => {
    expect(admitHermesProvenance(provenance(), anchor).allowed).toBe(true);
    expect(admitHermesProvenance(provenance(), null).allowed).toBe(false);
    expect(admitHermesProvenance(null, anchor).allowed).toBe(false);
    expect(admitHermesProvenance([provenance()], anchor).allowed).toBe(false);
    expect(admitHermesProvenance({ [HERMES_PROVENANCE_META_KEY]: [OWNER_TURN] }, anchor).allowed).toBe(false);
  });

  it("ignores the fields it carries but does not compare", () => {
    expect(admitHermesProvenance(provenance({
      session_key: "anything",
      platform: "cli",
      chat_id: "another",
      parent_chat_id: "a-parent-chat",
    }), anchor).allowed).toBe(true);
  });
});

/**
 * A peer turn of the CEO binding under a Hermes peer grant (CEO ad57675b): the same channel, the
 * same anchor and every owner check, plus a well-formed `peer_grant`, one of four fixed tools, and,
 * for `ceo_decision_submit`, only FINAL_REVISE or CONFIRM. The admitted turn is recorded with the
 * mutation's own audit evidence.
 */
const PEER_GRANT = `sha256:${"c".repeat(64)}`;

const PEER_TURN = { ...OWNER_TURN, principal: "peer", peer_grant: PEER_GRANT } as const;

const peerTurn = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  [HERMES_PROVENANCE_META_KEY]: { ...PEER_TURN, ...overrides },
});

const peerWithout = (field: keyof typeof PEER_TURN): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...PEER_TURN };
  delete copy[field];
  return { [HERMES_PROVENANCE_META_KEY]: copy };
};

const auditEvidence = (subject: Channel, kind: string): Array<Record<string, unknown>> =>
  subject.fixture.h.cp.db
    .all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`, [kind])
    .map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);

/** A QUEUED run the owner created, so a refused peer call has something it would have changed. */
const ownerRun = async (subject: Channel): Promise<string> => {
  const created = await subject.call("run_create", runCreate(), provenance());
  expect(created).toMatchObject({ ok: true });
  return (created["value"] as { runId: string }).runId;
};

const runState = (subject: Channel, runId: string): string => subject.fixture.h.cp.runs.require(runId).state;

describe("a peer turn of the CEO binding, under a Hermes peer grant", () => {
  it("admits run_create and records the peer turn and its grant in RUN_CREATED", async () => {
    const subject = await channel();
    const before = subject.writes();
    const body = await subject.call("run_create", runCreate(), peerTurn());
    expect(body).toMatchObject({ ok: true, value: { state: "QUEUED" } });
    expect(subject.writes().runs).toBe(before.runs + 1);
    expect(auditEvidence(subject, "RUN_CREATED").at(-1)).toMatchObject({ hermesPrincipal: "peer", hermesPeerGrant: PEER_GRANT });
  });

  it("admits run_dispatch and escalation_resolve past provenance, to their own gates", async () => {
    // Admission is not execution: each call reaches, and is refused by, the gate it would meet as the
    // owner — dispatch staffing, then escalation targeting. The end-to-end success is
    // hermes-peer-delegated-escalation.test.ts.
    const subject = await channel();
    const runId = await ownerRun(subject);
    expect(await subject.call("run_dispatch", { idempotencyKey: "peer-dispatch-1", runId }, peerTurn()))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_OWNER_NOT_PINNED });
    expect(await subject.call(
      "escalation_resolve",
      { idempotencyKey: "peer-resolve-1", runId, escalationId: 1, resolution: "use acp-new" },
      peerTurn(),
    )).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { currentEscalationId: null } });
  });

  it("records an owner's turn as the owner's, with no grant, and a bootstrapped CEO's run with neither", async () => {
    const subject = await channel();
    await ownerRun(subject);
    expect(auditEvidence(subject, "RUN_CREATED").at(-1)).toMatchObject({ hermesPrincipal: "owner", hermesPeerGrant: null });
    const bootstrapped = await channel(false);
    expect(await bootstrapped.call("run_create", runCreate())).toMatchObject({ ok: true });
    expect(auditEvidence(bootstrapped, "RUN_CREATED").at(-1)).not.toHaveProperty("hermesPrincipal");
  });

  it.each([
    ["no peer_grant", peerWithout("peer_grant")],
    ["a null peer_grant", peerTurn({ peer_grant: null })],
    ["a peer_grant that is raw hex without its sha256: prefix", peerTurn({ peer_grant: "c".repeat(64) })],
    ["a peer_grant in upper-case hex", peerTurn({ peer_grant: `sha256:${"C".repeat(64)}` })],
    ["a peer_grant one hex digit short", peerTurn({ peer_grant: `sha256:${"c".repeat(63)}` })],
    ["a peer_grant that is not a string", peerTurn({ peer_grant: 7 })],
    ["another chat's Hermes session", peerTurn({ session_id: "20261002_080000_other_chat" })],
    ["another lineage", peerTurn({ lineage_root_digest: OTHER_DIGEST })],
    ["a scheduled (cron) turn", peerTurn({ cron: true })],
    ["a subagent (delegation_depth 1)", peerTurn({ delegation_depth: 1 })],
    ["no _meta at all, with the peer turn copied into arguments", undefined],
  ])("refuses a peer's run_create, writing nothing, for %s", async (_case, meta) => {
    const subject = await channel();
    await expectRefused(subject, "run_create", runCreate({
      _meta: peerTurn(),
      [HERMES_PROVENANCE_META_KEY]: PEER_TURN,
      peer_grant: PEER_GRANT,
    }), meta);
  });

  it("never takes a peer_grant from arguments to complete a peer turn in params._meta", async () => {
    const subject = await channel();
    await expectRefused(subject, "run_create", runCreate({ peer_grant: PEER_GRANT, _meta: peerTurn() }), peerWithout("peer_grant"));
  });

  it.each([
    ["run_cancel", (runId: string) => ({ idempotencyKey: "peer-cancel", runId, reason: "peer asked" })],
    ["run_priority_set", (runId: string) => ({ idempotencyKey: "peer-priority", runId, priority: "CRITICAL" })],
    ["cto_start", () => ({ idempotencyKey: "peer-cto-start", projectId: "proj_absent" })],
    ["cto_replace", () => ({ idempotencyKey: "peer-cto-replace", projectId: "proj_absent", reason: "peer asked" })],
    ["cto_suspend", () => ({ idempotencyKey: "peer-cto-suspend", projectId: "proj_absent", reason: "peer asked" })],
    ["cto_resume", () => ({ idempotencyKey: "peer-cto-resume", projectId: "proj_absent" })],
    ["repair_execute", () => ({ idempotencyKey: "peer-repair", operationId: "noop", authorizedBy: "HERMES", dryRun: false })],
    ["owner_decision_submit", (runId: string) => ({ idempotencyKey: "peer-owner-decision", runId, item: "merge", approved: true })],
    ["doctor_run", () => ({ scope: "system" })],
  ])("refuses a peer's %s, writing nothing", async (tool, args) => {
    const subject = await channel();
    const runId = await ownerRun(subject);
    await expectRefused(subject, tool, args(runId), peerTurn());
    expect(runState(subject, runId)).toBe("QUEUED");
  });

  it("refuses a peer's tool registered after construction, which is not in the fixed peer set", async () => {
    const subject = await channel(true, (server) => {
      server.registerTool(
        "fixture_registered_later",
        { description: "fixture", inputSchema: { request: z.record(z.unknown()) } },
        async () => respond(allow(ReasonCode.OK, { reached: true })),
      );
    });
    await expectRefused(subject, "fixture_registered_later", { request: {} }, peerTurn());
    expect(await subject.call("fixture_registered_later", { request: {} }, provenance())).toMatchObject({ ok: true });
  });

  it("lets a peer submit FINAL_REVISE or CONFIRM to the CEO gate, and refuses OWNER_DECISION_REQUIRED before it", async () => {
    const subject = await channel();
    const runId = await ownerRun(subject);
    const decision = (value: string, key: string) => ({
      idempotencyKey: key,
      runId,
      decision: value,
      candidateSnapshotDigest: DIGEST,
      ceoSessionId: subject.admitted.sessionId,
      rationale: "the review is complete",
    });
    await expectRefused(subject, "ceo_decision_submit", decision("OWNER_DECISION_REQUIRED", "peer-odr"), peerTurn());
    for (const value of ["FINAL_REVISE", "CONFIRM"]) {
      // Past provenance, and refused by the CEO gate itself: a QUEUED run has no candidate to decide.
      expect(await subject.call("ceo_decision_submit", decision(value, `peer-${value}`), peerTurn()))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
      expect(runState(subject, runId)).toBe("QUEUED");
    }
    // The owner's OWNER_DECISION_REQUIRED is unchanged: it reaches the same gate.
    expect(await subject.call("ceo_decision_submit", decision("OWNER_DECISION_REQUIRED", "owner-odr"), provenance()))
      .toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
  });

  it("refuses a valid peer turn once the CEO binding has moved off the admitted runtime", async () => {
    const subject = await channel();
    const { h } = subject.fixture;
    expect(h.cp.bindings.revoke(CEO, "operator re-adoption").allowed).toBe(true);
    const replacement = h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: 1_234_568 });
    expect(h.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: replacement.sessionId }).allowed).toBe(true);
    await expectRefused(subject, "run_create", runCreate(), peerTurn(), ReasonCode.BINDING_GENERATION_STALE);
  });
});

describe("admitHermesProvenance for a peer turn, as a pure decision", () => {
  const anchor = { liveHermesSessionId: LIVE, lineageRootDigest: DIGEST };
  const call = (tool: string, args: unknown = {}) => ({ tool, arguments: args });

  it("names exactly the four delegable tools", () => {
    expect([...HERMES_PEER_DELEGABLE_TOOLS].sort())
      .toEqual(["ceo_decision_submit", "escalation_resolve", "run_create", "run_dispatch"]);
  });

  it("admits a peer for each delegable tool and answers with the turn it admitted", () => {
    for (const tool of ["escalation_resolve", "run_create", "run_dispatch"]) {
      expect(admitHermesProvenance(peerTurn(), anchor, call(tool))).toMatchObject({
        allowed: true,
        value: { principal: "peer", peerGrant: PEER_GRANT },
      });
    }
    for (const decision of ["FINAL_REVISE", "CONFIRM"]) {
      expect(admitHermesProvenance(peerTurn(), anchor, call("ceo_decision_submit", { decision })).allowed).toBe(true);
    }
  });

  it("answers an owner's turn as the owner's, with no grant, whatever the tool", () => {
    expect(admitHermesProvenance(provenance(), anchor)).toMatchObject({ allowed: true, value: { principal: "owner", peerGrant: null } });
    expect(admitHermesProvenance(provenance({ peer_grant: PEER_GRANT }), anchor, call("run_cancel")))
      .toMatchObject({ allowed: true, value: { principal: "owner", peerGrant: null } });
  });

  it("refuses a peer without an anchor, without the call, or outside the fixed set", () => {
    expect(admitHermesProvenance(peerTurn(), null, call("run_create")).allowed).toBe(false);
    expect(admitHermesProvenance(peerTurn(), anchor).allowed).toBe(false);
    for (const tool of ["run_cancel", "run_priority_set", "cto_start", "cto_replace", "repair_execute", "doctor_run", "owner_decision_submit", "run_get"]) {
      expect(admitHermesProvenance(peerTurn(), anchor, call(tool)).allowed).toBe(false);
    }
  });

  it("refuses a peer's ceo_decision_submit for any decision but FINAL_REVISE or CONFIRM", () => {
    for (const args of [{ decision: "OWNER_DECISION_REQUIRED" }, { decision: "confirm" }, { decision: 1 }, {}, undefined, null, ["CONFIRM"]]) {
      expect(admitHermesProvenance(peerTurn(), anchor, call("ceo_decision_submit", args)).allowed).toBe(false);
    }
  });
});
