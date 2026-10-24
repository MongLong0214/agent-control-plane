import { collectBootstrapCeoDecisions } from "../../src/bootstrap/bootstrap-ceo-decisions.ts";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { allow, deny } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { BootstrapPlanStageInput } from "../../src/bootstrap/bootstrap-plan-artifact.ts";
import { Role, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import type { InBandWake } from "../../src/outbox/outbox.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { cleanupTempDirs, seedRun, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, dispatchBootstrapRun, makeHarness, reviewerPass, reviewerRevise } from "../helpers/harness.ts";
import { openActivationHandoff, producedHandoff } from "../helpers/driven-primary-cto.ts";
import { bootstrapCoverageKeys } from "../helpers/bootstrap-plan.ts";
import { genesisFile, genesisPlanFixture } from "../helpers/genesis-github.ts";

afterAll(cleanupTempDirs);
type Args = Record<string, unknown>;
async function fixture(principal: "owner" | "peer" = "owner") {
  const h = makeHarness();
  const ceo = bindCeo(h);
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD",
    contract: { goal: "Create a runnable product", why: "genesis", scope: [], nonGoals: [], priority: "NORMAL", humanGate: [], references: [], acceptance: ["CI at the genesis PR head passes"] } });
  if (!created.allowed) throw new Error(created.message);
  const run = await dispatchBootstrapRun(h.cp, h.clock, created.value.runId);
  const plan: Args = { ...genesisPlanFixture().artifact.content, requestDigest: run.contractDigest };
  // Real inline genesis content, rather than padding outside the PLAN.
  const genesis = plan["genesis"] as { files: unknown[] };
  genesis.files.push(genesisFile("docs/product.md", "# Product\n" + "Implement the agreed product and retain its owner instructions.\n".repeat(290)));
  const body = JSON.stringify({ runId: run.runId, plan, tasks: [{ key: "create", title: "Create repository", category: "implementation" }] }, null, 2) + "\r\n";
  const digest = sha256(body);
  const lineage = digestOf("bootstrap plan approval lineage");
  const anchor = { liveHermesSessionId: "approved-ceo-head", lineageRootDigest: lineage };
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal, ...(principal === "peer" ? { peer_grant: digestOf("grant") } : {}), session_id: anchor.liveHermesSessionId,
    lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const servers: Array<{ close(): Promise<void> }> = [];
  async function connect(kind: "cto" | "hermes", sessionId: string, provenance = true,
    identity: "complete" | "actor-only" | "session-only" | "incarnation-only" | "unauthenticated" = "complete", plane = h.cp,
    binding?: { roleKey: string; bindingGeneration: number }) {
    const session = plane.sessions.require(sessionId);
    const auth = () => identity === "unauthenticated" ? deny<never>(ReasonCode.MCP_PEER_UNAUTHENTICATED, "fixture unauthenticated connection") : allow(ReasonCode.OK, { actor: sessionId,
      ...(binding ? { binding } : {}),
      ...(identity === "complete" || identity === "session-only" ? { sessionId } : {}),
      ...(identity === "complete" || identity === "incarnation-only" ? { sessionIncarnation: session.incarnation } : {}) });
    const server = kind === "cto" ? createCtoServer(createCtoMcpPort(plane), auth)
      : createHermesServer(createHermesMcpPort(plane), auth, provenance ? { provenance: anchor } : {});
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "bootstrap-plan-artifact", version: "1" });
    await client.connect(ct);
    servers.push(server, client);
    const call = async (name: string, args: Args, callMeta: Args = meta): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: callMeta });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
    return Object.assign(call, { listTools: () => client.listTools() });
  }
  const hermes = await connect("hermes", ceo);
  const cto = await connect("cto", run.ownerSessionId!);
  const attachArgs = {
    idempotencyKey: "attach", runId: run.runId, planBody: body, expectedSha256: digest,
    contractDigest: run.contractDigest, bootstrapOperationId: plan.bootstrapOperationId,
    projectId: (plan.projectManifest as Args).projectId,
    repositoryIdentity: ((plan.projectManifest as Args).repositories as Args[])[0]!.remote,
  };
  const attach = (overrides: Args = {}) => hermes("bootstrap_plan_attach", { ...attachArgs, ...overrides });
  return { h, ceo, run, plan, body, digest, connect, hermes, cto, attach, attachArgs,
    close: async () => { for (const s of servers.reverse()) await s.close(); h.cp.close(); } };
}

describe("CEO-approved bootstrap PLAN input over real Hermes and CTO MCP servers", () => {
  it.each((["hermes", "cto"] as const).flatMap(kind =>
    (["actor-only", "session-only", "incarnation-only"] as const).map(identity => ({ kind, identity }))))(
    "authenticates an incomplete $kind $identity peer before inspecting digest shape", async ({ kind, identity }) => {
      const f = await fixture();
      try {
        const call = await f.connect(kind, kind === "hermes" ? f.ceo : f.run.ownerSessionId!, true, identity);
        const tool = kind === "hermes" ? "bootstrap_plan_attach" : "plan_submit";
        const args = kind === "hermes" ? f.attachArgs
          : { idempotencyKey: "incomplete", runId: f.run.runId, bootstrapPlanDigest: f.digest };
        const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
        f.h.cp.outbox.attachInBandWake(wake);
        const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), plan: f.h.cp.artifacts.latest(f.run.runId, "PLAN"),
          run: f.h.cp.runs.require(f.run.runId), candidate: f.h.cp.runs.currentCandidate(f.run.runId),
          application: f.h.cp.bootstrapApplications.get(f.run.runId), audit: f.h.cp.audit.forRun(f.run.runId),
          outbox: f.h.cp.outbox.listByRun(f.run.runId),
          mcpReceipts: f.h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'") });
        const before = state();
        const baseline = await call(tool, args);
        expect(baseline).toMatchObject({ ok: false, reasonCode: kind === "hermes" && identity === "session-only"
          ? "BINDING_GENERATION_STALE" : "MCP_PEER_UNAUTHENTICATED" });
        expect(state()).toEqual(before);
        for (const field of kind === "hermes" ? ["contractDigest", "expectedSha256", "replacesSha256"] : ["bootstrapPlanDigest"]) {
          for (const [index, value] of [f.digest, `${f.digest}\rid`, `${f.digest}\r\nid`, `${f.digest}\x00id`, `${f.digest}\x7fid`, "not-a-digest"].entries()) {
            expect(await call(tool, { ...args, idempotencyKey: `${field}-${index}`, [field]: value })).toEqual(baseline);
            expect(state()).toEqual(before);
            expect(wake).not.toHaveBeenCalled();
          }
        }
      } finally { await f.close(); }
    });

  it.each(["owner", "peer"] as const)("round-trips a realistic PLAN larger than 22 KB byte for byte on a %s turn, wakes the owner, and submits by approved digest", async principal => {
    const f = await fixture(principal);
    try {
      expect(Buffer.byteLength(f.body)).toBeGreaterThan(22_000);
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      expect(await f.attach()).toMatchObject({ ok: true, value: { digest: f.digest } });
      await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(f.run.ownerRoleKey, expect.any(Array)));
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
      expect(f.h.cp.outbox.pendingInBandFor(f.run.ownerSessionId!, f.run.ownerSessionIncarnation!)).toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ bootstrapPlanDigest: f.digest }) }),
      ]));
      expect(await f.cto("plan_submit", { idempotencyKey: "submit", runId: f.run.runId, bootstrapPlanDigest: f.digest }))
        .toMatchObject({ ok: true, value: { digest: f.digest } });
      const afterSubmit = f.h.cp.artifacts.list(f.run.runId);
      expect(await f.attach()).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.attach({ idempotencyKey: "retry-after-submit" })).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(afterSubmit);
      expect(await f.cto("plan_submit", { idempotencyKey: "submit", runId: f.run.runId, bootstrapPlanDigest: sha256("changed reference") }))
        .toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      const storedPlan = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
      expect(storedPlan.content).toMatchObject({ bootstrapPlanDigest: f.digest });
      expect(storedPlan.digest).toBe(digestOf(storedPlan.content));
      expect(storedPlan.digest).not.toBe(f.digest);
      expect(sha256(f.body)).not.toBe(digestOf(JSON.parse(f.body)));
      expect(f.h.cp.tasks.list(f.run.runId)).toHaveLength(1);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(f.h.cp.audit.byKind("BOOTSTRAP_PLAN_ATTACHED")).toHaveLength(1);
      expect(JSON.stringify(f.h.cp.audit.all())).not.toContain("Implement the agreed product");
      expect(f.h.cp.artifacts.latest(f.run.runId, "BLIND_REVIEW")).toBeNull();
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await f.cto("result_submit", { idempotencyKey: "review", runId: f.run.runId,
        resultSummary: "compiled bootstrap inputs", recommendation: "review" })).toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.latest<Args>(f.run.runId, "BLIND_REVIEW")?.content).toMatchObject({ verdict: "PASS" });
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("READY_FOR_CEO_REVIEW");
    } finally { await f.close(); }
  });

  it.each(["\r", "\r\n"])("preserves body string values containing %j through attach, read, submit and retry", async (control) => {
    const f = await fixture();
    try {
      const input = JSON.parse(f.body);
      input.plan.summary = `First line${control}Second line`;
      const body = JSON.stringify(input, null, 2).replace(/\n/g, "\r\n") + "\r\n";
      const digest = sha256(body);
      const args = { planBody: body, expectedSha256: digest };
      expect(JSON.parse(body).plan.summary).toBe(input.plan.summary);
      expect(await f.attach(args)).toMatchObject({ ok: true, value: { digest } });
      const attachment = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")[0]!;
      expect(Buffer.from(attachment.content.bodyBase64 as string, "base64")).toEqual(Buffer.from(body, "utf8"));
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest, planBody: body } });
      expect(await f.cto("plan_submit", { idempotencyKey: "body-controls-submit", runId: f.run.runId, bootstrapPlanDigest: digest }))
        .toMatchObject({ ok: true, value: { digest } });
      const artifacts = f.h.cp.artifacts.list(f.run.runId);
      expect(await f.attach(args)).toMatchObject({ ok: true, value: { digest } });
      expect(await f.attach({ ...args, idempotencyKey: "body-controls-retry" })).toMatchObject({ ok: true, value: { digest } });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(artifacts);
    } finally { await f.close(); }
  });

  it.each(["\r", "\r\n", "malformed"])("returns a fixed MCP refusal for an invalid submit digest (%j) without writes", async (value) => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), audit: f.h.cp.audit.forRun(f.run.runId),
        outbox: f.h.cp.outbox.listByRun(f.run.runId), run: f.h.cp.runs.require(f.run.runId) });
      const before = state();
      expect(await f.cto("plan_submit", { idempotencyKey: "invalid-submit-digest", runId: f.run.runId,
        bootstrapPlanDigest: value === "malformed" ? "not-a-digest" : `${f.digest}${value}id` }))
        .toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT", evidence: {
          refusal: value === "malformed" ? "BOOTSTRAP_PLAN_DIGEST_INVALID" : "BOOTSTRAP_PLAN_BINDING_INVALID",
        } });
      expect(state()).toEqual(before);
    } finally { await f.close(); }
  });

  it("rolls back attachment artifacts, audit and wake when enqueue or audit refuses", async () => {
    for (const stage of ["enqueue", "audit"]) {
      const f = await fixture();
      try {
        const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
        f.h.cp.outbox.attachInBandWake(wake);
        const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), audit: f.h.cp.audit.forRun(f.run.runId),
          outbox: f.h.cp.outbox.listByRun(f.run.runId), run: f.h.cp.runs.require(f.run.runId) });
        const before = state();
        if (stage === "enqueue") vi.spyOn(f.h.cp.outbox, "enqueue").mockReturnValue(deny(ReasonCode.CONFLICT, "test refused enqueue"));
        else {
          const record = f.h.cp.audit.record.bind(f.h.cp.audit);
          vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => input.kind === "BOOTSTRAP_PLAN_ATTACHED"
            ? deny(ReasonCode.CONFLICT, "test refused audit") : record(input));
        }
        expect(await f.attach()).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
        expect(state()).toEqual(before);
        expect(wake).not.toHaveBeenCalled();
      } finally { await f.close(); }
    }
  });

  it("refuses the wrong exact-byte digest without writing or echoing the body", async () => {
    const f = await fixture();
    try {
      const result = await f.attach({ expectedSha256: sha256(f.body.trim()) });
      expect(result).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(JSON.stringify(result)).not.toContain("Product");
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("requires current CEO identity and authenticated owner-or-peer Hermes provenance", async () => {
    const f = await fixture();
    try {
      const other = await f.connect("hermes", f.run.ownerSessionId!);
      expect(await other("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "other", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest })).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      const bare = await f.connect("hermes", f.ceo, false);
      expect(await bare("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "bare", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest })).toMatchObject({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "missing-meta", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest }, {})).toMatchObject({ ok: false, reasonCode: "MCP_TOOL_PROVENANCE_REFUSED" });
      const peerMeta = { [HERMES_PROVENANCE_META_KEY]: { principal: "peer", session_id: "approved-ceo-head",
        lineage_root_digest: digestOf("bootstrap plan approval lineage"), cron: false, delegation_depth: 0, peer_grant: digestOf("grant") } };
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "peer-turn", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest }, peerMeta))
        .toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("fences reads and submission against other sessions and stale binding generations", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const other = await f.connect("cto", f.ceo);
      expect(await other("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: false });
      expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "stale generation fixture").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.run.ownerRoleKey!, "stale generation fixture", { allowBlockedRuns: true }).allowed).toBe(true);
      const rebound = f.h.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId, sessionId: f.run.ownerSessionId! });
      expect(rebound.allowed).toBe(true);
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(await f.cto("plan_submit", { idempotencyKey: "stale-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false });
    } finally { await f.close(); }
  });

  it("stores one immutable artifact on identical retries and refuses a second digest or changed fingerprint", async () => {
    const f = await fixture();
    try {
      const first = await f.attach();
      expect(first).toMatchObject({ ok: true });
      expect(await f.attach()).toEqual(first);
      expect(await f.attach({ idempotencyKey: "retry" })).toEqual(first);
      expect(await f.attach({ contractDigest: sha256("changed metadata") })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      const changed = f.body + " ";
      expect(await f.attach({ planBody: changed, expectedSha256: sha256(changed) })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.attach({ idempotencyKey: "changed", planBody: changed, expectedSha256: sha256(changed) })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(1);
      expect(f.h.cp.audit.byKind("BOOTSTRAP_PLAN_ATTACHED")).toHaveLength(1);
      expect(() => f.h.cp.db.run("UPDATE run_artifacts SET content_json = '{}' WHERE run_id = ? AND kind = 'HANDOFF'", [f.run.runId])).toThrow();
    } finally { await f.close(); }
  });

  it("refuses body/task substitution and wrong references once a digest is approved", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const input = JSON.parse(f.body) as Args;
      expect(await f.cto("plan_submit", { idempotencyKey: "body-bypass", ...input })).toMatchObject({ ok: false });
      expect(await f.cto("plan_submit", { idempotencyKey: "wrong-ref", runId: f.run.runId, bootstrapPlanDigest: sha256("wrong") })).toMatchObject({ ok: false });
      expect(await f.cto("plan_submit", { idempotencyKey: "task-bypass", ...input, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false });
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toBeNull();
    } finally { await f.close(); }
  });

  it("reads and submits through the authenticated CTO Unix socket, while its Hermes socket refuses missing provenance", async () => {
    const f = await fixture();
    const token = "bootstrap-plan-socket-token";
    const listeners = await startLocalMcpListeners(f.h.cp, tempDir("bp-sock-"), token);
    const credential = f.h.cp.sessions.rotateSecret(f.run.ownerSessionId!, 0);
    if (!credential.allowed) throw new Error(credential.message);
    const ceoCredential = f.h.cp.sessions.rotateSecret(f.ceo, 0);
    if (!ceoCredential.allowed) throw new Error(ceoCredential.message);
    const call = (name: string, args: Args) => callMcpToolOverSocket(listeners.socketPaths[1]!, {
      token, sessionId: f.run.ownerSessionId!, sessionSecret: credential.value.sessionSecret,
    }, name, args);
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await call("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
      expect(await call("plan_submit", { idempotencyKey: "socket-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await callMcpToolOverSocket(listeners.socketPaths[0]!, { token, sessionId: f.ceo, sessionSecret: ceoCredential.value.sessionSecret },
        "bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "socket-attach", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest })).toMatchObject({ ok: false });
    } finally { await listeners.close(); await f.close(); }
  });

  it("attaches and reads while BLOCKED, but requires the existing CEO escalation resolution before submitting", async () => {
    const f = await fixture();
    try {
      expect(await f.cto("escalation_open", { idempotencyKey: "open", runId: f.run.runId, question: "Need compiled PLAN",
        options: ["attach"], ctoRecommendation: "attach", whyItMatters: "input channel", blocksCriticalPath: true })).toMatchObject({ ok: true });
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("BLOCKED");
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true });
      expect(await f.cto("contract_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { bootstrapPlanDigest: f.digest } });
      expect(await f.cto("plan_submit", { idempotencyKey: "blocked-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest }))
        .toMatchObject({ ok: false, reasonCode: "RUN_TRANSITION_ILLEGAL" });
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("BLOCKED");
      expect(await f.hermes("escalation_resolve", { idempotencyKey: "resolve", runId: f.run.runId,
        escalationId: f.h.cp.ceo.openEscalationOf(f.run.runId)!.escalationId,
        resolution: "Read bootstrap_plan_get and submit its approved digest." })).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "resolved-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("refuses non-bootstrap runs and a former CEO's replay", async () => {
    const f = await fixture();
    try {
      const standard = seedRun({ db: f.h.cp.db, clock: f.h.clock, repoPath: f.h.repoPath, claim: false });
      expect(await f.attach({ idempotencyKey: "standard", runId: standard.runId })).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(f.h.cp.bindings.revoke("CEO", "new CEO fixture").allowed).toBe(true);
      bindCeo(f.h);
      expect(await f.attach()).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
    } finally { await f.close(); }
  });

  it("allows attachment after run_create before dispatch, and advertises its digest to the newly bound owner", async () => {
    const f = await fixture();
    try {
      const created = f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD",
        contract: { goal: "Queued bootstrap", why: "compile after create", scope: [], nonGoals: [], priority: "NORMAL", humanGate: [], references: [], acceptance: ["ready"] } });
      if (!created.allowed) throw new Error(created.message);
      const input = JSON.parse(f.body);
      input.runId = created.value.runId;
      input.plan.requestDigest = created.value.contractDigest;
      const body = JSON.stringify(input);
      const digest = sha256(body);
      expect(await f.attach({ idempotencyKey: "queued-attach", runId: created.value.runId, contractDigest: created.value.contractDigest, planBody: body, expectedSha256: digest })).toMatchObject({ ok: true });
      const run = await dispatchBootstrapRun(f.h.cp, f.h.clock, created.value.runId);
      const owner = await f.connect("cto", run.ownerSessionId!);
      expect(await owner("contract_get", { runId: run.runId })).toMatchObject({ ok: true, value: { bootstrapPlanDigest: digest } });
      expect(await owner("plan_submit", { idempotencyKey: "queued-submit", runId: run.runId, bootstrapPlanDigest: digest })).toMatchObject({ ok: true, value: { digest } });
    } finally { await f.close(); }
  });

  it("preserves legacy submission without an attachment, then refuses attaching over its PLAN", async () => {
    const f = await fixture();
    try {
      expect(await f.cto("plan_submit", { idempotencyKey: "legacy", ...JSON.parse(f.body) })).toMatchObject({ ok: true });
      const plan = f.h.cp.artifacts.latest(f.run.runId, "PLAN");
      expect(await f.attach()).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toEqual(plan);
    } finally { await f.close(); }
  });

  it.each(["manifest", "secret"])("keeps %s screening on referenced submission, with no PLAN or tasks on refusal", async (kind) => {
    const f = await fixture();
    try {
      const input = JSON.parse(f.body);
      if (kind === "manifest") input.plan.projectManifestDigest = sha256("wrong manifest");
      else input.plan.genesis.files.push(genesisFile("config.js", 'const password = "test-secret-value";\n'));
      const body = JSON.stringify(input);
      const digest = sha256(body);
      expect(await f.attach({ planBody: body, expectedSha256: digest })).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "invalid-manifest", runId: f.run.runId, bootstrapPlanDigest: digest }))
        .toMatchObject({ ok: false, reasonCode: kind === "manifest" ? "BOOTSTRAP_CONTRACT_DRIFT" : "INVALID_ARGUMENT" });
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toBeNull();
      expect(f.h.cp.tasks.list(f.run.runId)).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("delivers input only: expectedSha256 or an approvedDigest argument creates no owner approval or execution authority", async () => {
    const f = await fixture();
    try {
      const approve = vi.spyOn(f.h.cp.ceo, "recordOwnerDecision");
      const execute = vi.spyOn(f.h.cp.bootstrapProducer, "produceAndActivateApproved");
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, expectedSha256: undefined, approvedDigest: f.digest })).toMatchObject({ ok: false });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(0);
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.list(f.run.runId, "APPROVAL")).toHaveLength(0);
      expect(f.h.cp.bootstrapApplications.get(f.run.runId)).toBeNull();
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(approve).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["owner", "peer"] as const)("directly refuses a different run even when the CEO supplies an otherwise valid attachment on a %s turn", async principal => {
    const f = await fixture(principal);
    try {
      const input = JSON.parse(f.body);
      input.runId = "run_wrong";
      input.plan.requestDigest = sha256("Repo Factory compile request");
      const body = JSON.stringify(input);
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), run: f.h.cp.runs.require(f.run.runId),
        audit: f.h.cp.audit.forRun(f.run.runId), outbox: f.h.cp.outbox.listByRun(f.run.runId) });
      const before = state();
      expect(await f.attach({ planBody: body, expectedSha256: sha256(body) })).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(state()).toEqual(before);
      expect(wake).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each((["owner", "peer"] as const).flatMap(principal => ["contractDigest", "bootstrapOperationId", "projectId", "repositoryIdentity"].map(field => ({ principal, field }))))(
    "binds attachment metadata to $field on a $principal turn", async ({ field, principal }) => {
    const f = await fixture(principal);
    try {
      const input = JSON.parse(f.body);
      input.plan.requestDigest = sha256("Repo Factory compile request");
      const body = JSON.stringify(input);
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), run: f.h.cp.runs.require(f.run.runId),
        audit: f.h.cp.audit.forRun(f.run.runId), outbox: f.h.cp.outbox.listByRun(f.run.runId) });
      const before = state();
      expect(await f.attach({ planBody: body, expectedSha256: sha256(body),
        [field]: field === "contractDigest" ? sha256("another contract") : "different-target" }))
        .toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_CONTRACT_DRIFT" });
      expect(state()).toEqual(before);
      expect(wake).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("round-trips an RF request digest independent of the ACP contract and submits only the exact attached input", async () => {
    const f = await fixture();
    try {
      const input = JSON.parse(f.body);
      const requestDigest = sha256("Repo Factory compile request");
      expect(requestDigest).not.toBe(f.run.contractDigest);
      input.plan.requestDigest = requestDigest;
      const body = JSON.stringify(input, null, 2) + "\r\n";
      const digest = sha256(body);
      expect(await f.attach({ planBody: body, expectedSha256: digest })).toMatchObject({ ok: true, value: { digest } });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest, planBody: body } });
      expect((await f.cto("contract_get", { runId: f.run.runId })).value).toMatchObject({ bootstrapPlanGuide: {
        planFields: expect.arrayContaining([{ field: "requestDigest",
          carries: "the digest of the Repo Factory compile request; independent of ACP's run contractDigest" }]),
      } });
      const attachment = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")[0]!;
      expect(Buffer.from(attachment.content.bodyBase64 as string, "base64")).toEqual(Buffer.from(body));
      const before = f.h.cp.artifacts.list(f.run.runId);
      // The same JSON with different whitespace still names different attached bytes.
      expect(await f.cto("plan_submit", { idempotencyKey: "rf-wrong-bytes", runId: f.run.runId, bootstrapPlanDigest: sha256(body + " ") }))
        .toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(await f.cto("plan_submit", { idempotencyKey: "rf-body-bypass", ...input, bootstrapPlanDigest: digest }))
        .toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(before);
      expect(f.h.cp.tasks.list(f.run.runId)).toHaveLength(0);
      expect(await f.cto("plan_submit", { idempotencyKey: "rf-submit", runId: f.run.runId, bootstrapPlanDigest: digest }))
        .toMatchObject({ ok: true, value: { digest } });
      expect(f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")?.content).toMatchObject({ requestDigest, bootstrapPlanDigest: digest });
      expect(await f.attach({ idempotencyKey: "rf-retry", planBody: body, expectedSha256: digest })).toMatchObject({ ok: true, value: { digest } });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["owner", "peer"] as const)("checks owner generation separately from CEO authority on a %s turn, including a cached attach retry", async principal => {
    const f = await fixture(principal);
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "generation fixture").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.run.ownerRoleKey!, "generation fixture", { allowBlockedRuns: true }).allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId, sessionId: f.run.ownerSessionId! }).allowed).toBe(true);
      expect(await f.attach()).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(await f.attach({ idempotencyKey: "stale-new-key" })).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("refuses cancelled runs on read, submit and identical attach replay", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "terminal-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      expect(f.h.cp.runs.cancel(f.run.runId, "cancel fixture").allowed).toBe(true);
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: false });
      expect(await f.cto("plan_submit", { idempotencyKey: "terminal-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false });
      expect(await f.attach()).toMatchObject({ ok: false });
    } finally { await f.close(); }
  });

  it.each(["body", "schema"])("refuses stored %s tampering on read, fresh submit and cached submit replay", async (kind) => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "tamper-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      const artifact = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")[0]!;
      // Simulate offline corruption in this test's database, beyond the normal immutability guard.
      const raw = new Database(f.h.cp.db.raw.name);
      try {
        raw.function("acp_evidence_write_authorized", () => 0);
        raw.exec("DROP TRIGGER run_artifacts_content_immutable");
        const corrupted = kind === "body"
          ? { ...artifact.content, bodyBase64: Buffer.from(f.body + " ").toString("base64") }
          : { ...artifact.content, schema: "corrupted-input-type" };
        raw.prepare("UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?")
          .run(JSON.stringify(corrupted), artifact.artifactId);
      } finally { raw.close(); }
      expect(await f.cto("plan_submit", { idempotencyKey: "tamper-body-bypass", ...JSON.parse(f.body) })).toMatchObject({ ok: false });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(await f.cto("plan_submit", { idempotencyKey: "tamper-fresh", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(await f.cto("plan_submit", { idempotencyKey: "tamper-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
    } finally { await f.close(); }
  });

  it("explicitly replaces input through candidate invalidation, with no carryover of the earlier review or submission", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "old-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await f.cto("result_submit", { idempotencyKey: "old-review", runId: f.run.runId, resultSummary: "ready", recommendation: "review" })).toMatchObject({ ok: true });
      const oldCandidate = f.h.cp.runs.currentCandidate(f.run.runId)!;
      const oldReview = f.h.cp.artifacts.latest<Args>(f.run.runId, "BLIND_REVIEW")!;
      const input = JSON.parse(f.body);
      input.plan.summary = "Corrected final input";
      const body = JSON.stringify(input, null, 2) + "\r\n";
      const digest = sha256(body);
      expect(await f.attach({ idempotencyKey: "replace", planBody: body, expectedSha256: digest, replacesSha256: f.digest }))
        .toMatchObject({ ok: true, value: { digest } });
      expect(await f.attach({ idempotencyKey: "replace", planBody: body, expectedSha256: digest, replacesSha256: f.digest }))
        .toMatchObject({ ok: true, value: { digest } });
      expect(await f.attach()).toMatchObject({ ok: false });
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toBeNull();
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toBeNull();
      expect(f.h.cp.artifacts.latest(f.run.runId, "BLIND_REVIEW")).toBeNull();
      expect(f.h.cp.artifacts.byDigest(oldReview.digest)?.superseded).toBe(true);
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest, planBody: body } });
      expect(await f.cto("plan_submit", { idempotencyKey: "old-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false });
      expect(await f.cto("result_submit", { idempotencyKey: "old-review", runId: f.run.runId, resultSummary: "ready", recommendation: "review" })).toMatchObject({ ok: false });
      expect(await f.hermes("ceo_decision_submit", { idempotencyKey: "old-confirm", runId: f.run.runId, decision: "CONFIRM", candidateSnapshotDigest: oldCandidate, ceoSessionId: f.ceo, rationale: "old candidate" })).toMatchObject({ ok: false });
      expect(await f.cto("plan_submit", { idempotencyKey: "new-submit", runId: f.run.runId, bootstrapPlanDigest: digest })).toMatchObject({ ok: true });
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(await f.cto("result_submit", { idempotencyKey: "old-review", runId: f.run.runId, resultSummary: "ready", recommendation: "review" })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.h.cp.artifacts.latest(f.run.runId, "BLIND_REVIEW")).toBeNull();
      expect(f.h.cp.artifacts.list(f.run.runId, "APPROVAL").filter(a => !a.superseded)).toHaveLength(0);
      expect(f.h.cp.bootstrapApplications.get(f.run.runId)).toBeNull();
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(["bootstrapOperationId", "projectId", "repositoryIdentity", "contractDigest"].flatMap(field =>
    ["\r", "\r\n"].map(control => ({ field, control }))))(
    "ACP1195-R1-01: atomically rejects $field containing $control", async ({ field, control }) => {
      const f = await fixture();
      try {
        const input = JSON.parse(f.body);
        const value = `${f.attachArgs[field as keyof typeof f.attachArgs]}${control}id`;
        if (field === "bootstrapOperationId") input.plan.bootstrapOperationId = value;
        if (field === "projectId") input.plan.projectManifest.projectId = value;
        if (field === "contractDigest") input.plan.requestDigest = value;
        if (field === "repositoryIdentity") {
          const previous = input.plan.projectManifest.repositories[0].remote;
          input.plan.projectManifest.repositories[0].remote = value;
          for (const operation of input.plan.githubOperations) operation.resourceIdentity = operation.resourceIdentity.replace(previous, value);
        }
        const body = JSON.stringify(input, null, 2) + "\r\n";
        const args = { ...f.attachArgs, [field]: value, planBody: body, expectedSha256: sha256(body) };
        const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
        f.h.cp.outbox.attachInBandWake(wake);
        const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId),
          plan: f.h.cp.artifacts.latest(f.run.runId, "PLAN"), run: f.h.cp.runs.require(f.run.runId),
          candidate: f.h.cp.runs.currentCandidate(f.run.runId), application: f.h.cp.bootstrapApplications.get(f.run.runId),
          audit: f.h.cp.audit.forRun(f.run.runId), outbox: f.h.cp.outbox.listByRun(f.run.runId) });
        // Both the sealed port and MCP caller must receive the fixed refusal before writes.
        const rejectWithoutChanges = async (rejected: typeof args & { replacesSha256?: string }) => {
          const before = state();
          expect(createHermesMcpPort(f.h.cp).attachBootstrapPlan({ actor: f.ceo, sessionId: f.ceo,
            sessionIncarnation: f.h.cp.sessions.require(f.ceo).incarnation }, { principal: "owner", peerGrant: null }, rejected as Parameters<ReturnType<typeof createHermesMcpPort>["attachBootstrapPlan"]>[2]))
            .toMatchObject({ allowed: false, reasonCode: "INVALID_ARGUMENT", evidence: { refusal: "BOOTSTRAP_PLAN_BINDING_INVALID" } });
          expect(await f.attach(rejected)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT",
            evidence: { refusal: "BOOTSTRAP_PLAN_BINDING_INVALID" } });
          expect(state()).toEqual(before);
          expect(wake).not.toHaveBeenCalled();
        };
        await rejectWithoutChanges(args);
        // A rejected correction must also leave an existing PLAN and approval intact.
        expect(await f.attach({ idempotencyKey: "valid-input" })).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(wake).toHaveBeenCalled());
        expect(await f.cto("plan_submit", { idempotencyKey: "valid-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
        f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
        expect(await f.cto("result_submit", { idempotencyKey: "valid-review", runId: f.run.runId, resultSummary: "ready", recommendation: "review" })).toMatchObject({ ok: true });
        expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).not.toBeNull();
        expect(f.h.cp.artifacts.latest(f.run.runId, "APPROVAL")).not.toBeNull();
        wake.mockClear();
        await rejectWithoutChanges({ ...args, idempotencyKey: "invalid-correction", replacesSha256: f.digest });
      } finally { await f.close(); }
    });

  it("bounds bytes and refuses malformed JSON, a different run, and terminal runs", async () => {
    const f = await fixture();
    try {
      for (const [key, body] of [["size", "x".repeat(1_048_577)], ["json", "{private-invalid-json"], ["run", f.body.replace(f.run.runId, "run_other")]]) {
        expect(await f.attach({ idempotencyKey: key, planBody: body, expectedSha256: sha256(body!) })).toMatchObject(key === "size" ? { ok: false } : { ok: false, reasonCode: "INVALID_ARGUMENT" });
      }
      expect(f.h.cp.runs.cancel(f.run.runId, "finished test").allowed).toBe(true);
      expect(await f.attach()).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(0);
    } finally { await f.close(); }
  });
});

async function stagingFixture(principal: "owner" | "peer" = "owner") {
  const f = await fixture(principal);
  const primary = seedRun({ db: f.h.cp.db, clock: f.h.clock, repoPath: f.h.repoPath, claim: false });
  const call = await f.connect("cto", primary.sessionId, true, "complete", f.h.cp,
    { roleKey: primary.roleKey, bindingGeneration: primary.generation });
  const stage = (overrides: Args = {}) => call("bootstrap_plan_stage", { ...f.attachArgs, idempotencyKey: "stage", ...overrides });
  const state = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), run: f.h.cp.runs.require(f.run.runId),
    candidate: f.h.cp.runs.currentCandidate(f.run.runId), application: f.h.cp.bootstrapApplications.get(f.run.runId),
    audit: f.h.cp.audit.forRun(f.run.runId), outbox: f.h.cp.outbox.listByRun(f.run.runId),
    receipts: f.h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'") });
  const attach = (overrides: Args = {}) => f.attach({ stagedBy: primary.roleKey, ...overrides });
  return { ...f, primary, stage, state, attach };
}

describe("bounded PRIMARY_CTO bootstrap candidate staging", () => {
  it.each(["owner", "peer"] as const)("stages and %s-attaches a replacement after submission and review, then submits its exact bytes", async principal => {
    const f = await stagingFixture(principal);
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "submit-A", runId: f.run.runId, bootstrapPlanDigest: f.digest }))
        .toMatchObject({ ok: true, value: { digest: f.digest } });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await f.cto("result_submit", { idempotencyKey: "review-A", runId: f.run.runId, resultSummary: "ready", recommendation: "review" }))
        .toMatchObject({ ok: true });
      const oldReview = f.h.cp.artifacts.latest(f.run.runId, "BLIND_REVIEW")!;
      const input = JSON.parse(f.body);
      input.plan.summary = "Corrected staged replacement";
      const body = JSON.stringify(input, null, 2) + "\r\n";
      const digest = sha256(body);
      const beforeStage = f.state();
      expect(await f.stage({ idempotencyKey: "stage-B", planBody: body, expectedSha256: digest }))
        .toMatchObject({ ok: true, value: { digest, stagedBy: f.primary.roleKey } });
      expect(f.h.cp.runs.require(f.run.runId)).toEqual(beforeStage.run);
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toEqual(beforeStage.candidate);
      expect(f.h.cp.artifacts.latest(f.run.runId, "BLIND_REVIEW")).toEqual(oldReview);
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN"))
        .toEqual(beforeStage.artifacts.find(a => a.kind === "PLAN" && !a.superseded));
      expect(f.h.cp.outbox.listByRun(f.run.runId)).toEqual(beforeStage.outbox);
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId }))
        .toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
      expect(await f.attach({ idempotencyKey: "attach-B", planBody: undefined, expectedSha256: digest, replacesSha256: f.digest }))
        .toMatchObject({ ok: true, value: { digest } });
      expect(f.h.cp.artifacts.byDigest(oldReview.digest)?.superseded).toBe(true);
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toBeNull();
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toBeNull();
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId }))
        .toMatchObject({ ok: true, value: { digest, planBody: body } });
      expect(await f.cto("plan_submit", { idempotencyKey: "submit-B", runId: f.run.runId, bootstrapPlanDigest: digest }))
        .toMatchObject({ ok: true, value: { digest } });
    } finally { await f.close(); }
  });

  it("keeps one unattached candidate, retries B once, and permits C only after B is attached", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      const body = f.body + " ";
      const digest = sha256(body);
      const args = { idempotencyKey: "stage-B", planBody: body, expectedSha256: digest };
      const a = f.h.cp.artifacts.list(f.run.runId, "HANDOFF");
      expect(await f.stage(args)).toMatchObject({ ok: true, value: { digest } });
      const before = f.state();
      expect(await f.stage(args)).toMatchObject({ ok: true, value: { digest } });
      expect(await f.stage({ ...args, idempotencyKey: "retry-B" })).toMatchObject({ ok: true, value: { digest } });
      expect(await f.stage({ ...args, idempotencyKey: "same-sha-different-bytes", planBody: body + " " }))
        .toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(before.artifacts);
      expect(f.h.cp.audit.forRun(f.run.runId)).toEqual(before.audit);
      expect(before.artifacts.filter(a => a.content && (a.content as Args).sha256 === digest)).toHaveLength(1);
      expect(before.audit.filter(e => e.kind === "BOOTSTRAP_PLAN_STAGED" && e.evidence.payloadDigest === digest)).toHaveLength(1);
      const c = { idempotencyKey: "stage-C", planBody: body + " ", expectedSha256: sha256(body + " ") };
      expect(await f.stage(c)).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.attach({ idempotencyKey: "missing-replaces", planBody: undefined, expectedSha256: digest }))
        .toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(before.artifacts);
      expect(await f.attach({ idempotencyKey: "attach-B", planBody: undefined, expectedSha256: digest, replacesSha256: f.digest }))
        .toMatchObject({ ok: true });
      expect(await f.attach({ idempotencyKey: "revive-A", planBody: undefined, replacesSha256: digest }))
        .toMatchObject({ ok: false, reasonCode: "CONFLICT", message: "a superseded input cannot be made current again" });
      expect(await f.stage(c)).toMatchObject({ ok: true });
      const candidates = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").filter(a => a.content.stagedBy);
      expect(candidates).toHaveLength(3);
      expect(candidates.every(a => !a.superseded)).toBe(true);
      expect(candidates[0]).toEqual(a[0]);
      expect(f.h.cp.audit.byKind("BOOTSTRAP_PLAN_STAGED")).toHaveLength(3);
    } finally { await f.close(); }
  });

  it.each([false, true])("overlapping MCP stages leave one unattached candidate and one CONFLICT (replacement=%s)", async replacement => {
    const f = await stagingFixture();
    try {
      if (replacement) {
        expect(await f.stage()).toMatchObject({ ok: true });
        expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      }
      const second = await f.connect("cto", f.primary.sessionId, true, "complete", f.h.cp,
        { roleKey: f.primary.roleKey, bindingGeneration: f.primary.generation });
      const before = f.state();
      const bodies = [f.body + " ", f.body + "\n"];
      const answers = await Promise.all([
        f.stage({ idempotencyKey: "concurrent-B", planBody: bodies[0], expectedSha256: sha256(bodies[0]!) }),
        second("bootstrap_plan_stage", { ...f.attachArgs, idempotencyKey: "concurrent-C", planBody: bodies[1], expectedSha256: sha256(bodies[1]!) }),
      ]);
      expect(answers.filter(a => a.ok === true)).toHaveLength(1);
      expect(answers.filter(a => a.ok !== true)).toEqual([expect.objectContaining({ ok: false, reasonCode: "CONFLICT" })]);
      const appended = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")
        .filter(a => !before.artifacts.some(old => old.artifactId === a.artifactId));
      expect(appended).toHaveLength(1);
      expect(appended[0]!.content).toMatchObject({ stagedBy: f.primary.roleKey, sha256: (answers.find(a => a.ok === true)!.value as Args).digest });
      expect(f.h.cp.audit.forRun(f.run.runId).filter(e => e.kind === "BOOTSTRAP_PLAN_STAGED"))
        .toHaveLength(before.audit.filter(e => e.kind === "BOOTSTRAP_PLAN_STAGED").length + 1);
      expect(f.h.cp.runs.require(f.run.runId)).toEqual(before.run);
      expect(f.h.cp.outbox.listByRun(f.run.runId)).toEqual(before.outbox);
    } finally { await f.close(); }
  });

  it.each([false, true])("rechecks admission when a competing stage commits as its transaction opens (replacement=%s)", async replacement => {
    const f = await stagingFixture();
    try {
      if (replacement) {
        expect(await f.stage()).toMatchObject({ ok: true });
        expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      }
      const port = createCtoMcpPort(f.h.cp);
      const peer = { actor: f.primary.sessionId, sessionId: f.primary.sessionId,
        sessionIncarnation: f.h.cp.sessions.require(f.primary.sessionId).incarnation,
        binding: { roleKey: f.primary.roleKey, bindingGeneration: f.primary.generation } };
      const inputs = [f.body + " ", f.body + "\n"].map(planBody => ({ ...f.attachArgs, planBody, expectedSha256: sha256(planBody) }) as BootstrapPlanStageInput);
      // Both requests pass the MCP preflight before either appends anything.
      for (const input of inputs) expect(port.bootstrapPlanStageAuthority(peer, input).allowed).toBe(true);
      const before = f.state();
      const txDecision = f.h.cp.db.txDecision.bind(f.h.cp.db);
      const frozen = f.h.cp.bootstrapApplications.assertNotFrozen.bind(f.h.cp.bootstrapApplications);
      vi.spyOn(f.h.cp.bootstrapApplications, "assertNotFrozen").mockImplementation((...args) => {
        expect(f.h.cp.db.inTransaction).toBe(true);
        return frozen(...args);
      });
      let competing: ReturnType<typeof port.stageBootstrapPlan> | undefined;
      let interleaved = false;
      vi.spyOn(f.h.cp.db, "txDecision").mockImplementation(body => {
        if (!interleaved) {
          // The competing request commits after preflight, just before the first transaction opens.
          interleaved = true;
          expect(f.h.cp.db.inTransaction).toBe(false);
          competing = port.stageBootstrapPlan(peer, inputs[1]!);
        }
        return txDecision(body);
      });
      const first = port.stageBootstrapPlan(peer, inputs[0]!);
      expect(interleaved).toBe(true);
      expect(competing).toMatchObject({ allowed: true, value: { digest: inputs[1]!.expectedSha256 } });
      expect(first).toMatchObject({ allowed: false, reasonCode: "CONFLICT" });
      const appended = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")
        .filter(a => !before.artifacts.some(old => old.artifactId === a.artifactId));
      expect(appended).toHaveLength(1);
      expect(appended[0]!.content).toMatchObject({ stagedBy: f.primary.roleKey, sha256: inputs[1]!.expectedSha256 });
      expect(f.h.cp.audit.forRun(f.run.runId).filter(e => e.kind === "BOOTSTRAP_PLAN_STAGED"))
        .toHaveLength(before.audit.filter(e => e.kind === "BOOTSTRAP_PLAN_STAGED").length + 1);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("still refuses initial staging after a PLAN without an attachment", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.cto("plan_submit", { idempotencyKey: "legacy-submit", ...JSON.parse(f.body) })).toMatchObject({ ok: true });
      const before = f.state();
      expect(await f.stage()).toMatchObject({ ok: false, reasonCode: "CONFLICT", message: "this run no longer accepts initial PLAN staging" });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });

  it("stages a replacement after an inline attachment and PLAN, even without an earlier candidate", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "inline-submit", runId: f.run.runId, bootstrapPlanDigest: f.digest }))
        .toMatchObject({ ok: true });
      const body = f.body + " ";
      const digest = sha256(body);
      expect(await f.stage({ idempotencyKey: "first-candidate-is-replacement", planBody: body, expectedSha256: digest }))
        .toMatchObject({ ok: true, value: { digest } });
      expect(await f.attach({ idempotencyKey: "attach-first-candidate", planBody: undefined, expectedSha256: digest, replacesSha256: f.digest }))
        .toMatchObject({ ok: true, value: { digest } });
    } finally { await f.close(); }
  });

  it.each([RunState.ACTIVE, RunState.BLOCKED, RunState.REVISION_REQUIRED, RunState.AWAITING_HUMAN])(
    "uses attach's replacement admission in %s, including the frozen check", async state => {
      const f = await stagingFixture();
      try {
        expect(await f.stage()).toMatchObject({ ok: true });
        expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
        if (state === RunState.REVISION_REQUIRED) {
          expect(await f.cto("plan_submit", { idempotencyKey: "revision-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
          f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
          expect(await f.cto("result_submit", { idempotencyKey: "revision-review", runId: f.run.runId, resultSummary: "ready", recommendation: "review" }))
            .toMatchObject({ ok: true });
        }
        if (state !== RunState.ACTIVE) expect(f.h.cp.runs.transition(f.run.runId, state, "replacement state fixture").allowed).toBe(true);
        const args = { idempotencyKey: "replacement", planBody: f.body + " ", expectedSha256: sha256(f.body + " ") };
        const before = f.state();
        const frozen = vi.spyOn(f.h.cp.bootstrapApplications, "assertNotFrozen")
          .mockReturnValue(deny(ReasonCode.CONFLICT, "frozen fixture"));
        expect(await f.stage(args)).toMatchObject({ ok: false, message: "frozen fixture" });
        expect(f.state()).toEqual(before);
        frozen.mockRestore();
        expect(await f.stage(args)).toMatchObject({ ok: true });
        expect(await f.attach({ ...args, idempotencyKey: "replace", planBody: undefined, replacesSha256: f.digest }))
          .toMatchObject({ ok: true });
      } finally { await f.close(); }
    });

  it("rechecks replacement contract and current PRIMARY_CTO generation before writing", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      const args = { idempotencyKey: "replacement", planBody: f.body + " ", expectedSha256: sha256(f.body + " ") };
      const before = f.state();
      expect(await f.stage({ ...args, contractDigest: sha256("drift") }))
        .toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_CONTRACT_DRIFT" });
      expect(f.state()).toEqual(before);
      expect(f.h.cp.runs.transition(f.primary.runId, RunState.BLOCKED, "renew primary").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.primary.roleKey, "renew primary", { allowBlockedRuns: true }).allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: f.primary.projectId, sessionId: f.primary.sessionId }).allowed).toBe(true);
      const renewed = f.state();
      expect(await f.stage(args)).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(f.state()).toEqual(renewed);
    } finally { await f.close(); }
  });

  it.each(["receipt", "artifact", "bytes", "binding", "duplicate"])("selects by digest with two candidates and isolates damaged %s", async damage => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      const body = f.body + " ";
      const digest = sha256(body);
      expect(await f.stage({ idempotencyKey: "stage-B", planBody: body, expectedSha256: digest })).toMatchObject({ ok: true });
      // Both digest selections work before corrupting just A in this test's read view.
      expect(await f.attach({ idempotencyKey: "read-A", planBody: undefined })).toMatchObject({ ok: true });
      if (damage === "receipt") {
        const read = f.h.cp.audit.forRun.bind(f.h.cp.audit);
        vi.spyOn(f.h.cp.audit, "forRun").mockImplementation(runId => read(runId)
          .filter(e => e.kind !== "BOOTSTRAP_PLAN_STAGED" || e.evidence.payloadDigest !== f.digest));
      } else {
        const read = f.h.cp.artifacts.list.bind(f.h.cp.artifacts);
        vi.spyOn(f.h.cp.artifacts, "list").mockImplementation((runId, kind) => {
          const rows = read<Args>(runId, kind);
          const a = rows.find(a => a.content.stagedBy && a.content.sha256 === f.digest);
          if (!a) return rows;
          if (damage === "duplicate") return [...rows, a];
          return rows.map(row => row !== a ? row : {
            ...a, ...(damage === "artifact" ? { digest: sha256("damaged artifact") } : {}),
            content: { ...a.content, ...(damage === "bytes" ? { bodyBase64: Buffer.from(body).toString("base64") } : {}),
              ...(damage === "binding" ? { contractDigest: sha256("damaged binding") } : {}) },
          });
        });
      }
      expect(await f.attach({ idempotencyKey: "damaged-A", planBody: undefined }))
        .toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(await f.attach({ idempotencyKey: "good-B", planBody: undefined, expectedSha256: digest, replacesSha256: f.digest }))
        .toMatchObject({ ok: true, value: { digest } });
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("stages as the exact CTO socket binding when project and assignment enumeration orders differ", async () => {
    const f = await fixture();
    // Projects sort first by creation time, then id; assignments sort by assignment id.
    const projectId = "prj_a_socket_stager";
    const firstProjectId = "prj_z_socket_stager";
    expect(f.h.cp.projects.register({ projectId: firstProjectId, name: "first stager" }).allowed).toBe(true);
    expect(f.h.cp.projects.register({ projectId, name: "socket stager" }).allowed).toBe(true);
    const session = f.h.cp.sessions.create({ provider: "claude", model: "opus" });
    expect(f.h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    const bound = f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: firstProjectId, sessionId: session.sessionId });
    if (!bound.allowed) throw new Error(bound.message);
    const first = bound.value;
    const roleKey = `PRIMARY_CTO:${projectId}`;
    f.h.cp.db.run(`INSERT INTO assignments
      (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
       binding_generation, mode, status, created_at)
      SELECT ?, ?, 'PRIMARY_CTO', ?, actor_id, session_id, session_incarnation,
             binding_generation, mode, status, created_at FROM assignments WHERE assignment_id = ?`,
    [first.assignmentId + "z", roleKey, projectId, first.assignmentId]);
    expect(f.h.cp.projects.list().map(p => p.projectId)).toEqual([projectId, firstProjectId]);
    expect(f.h.cp.bindings.activePrimaryCtos().map(b => b.roleKey)).toEqual([first.roleKey, roleKey]);
    const binding = f.h.cp.bindings.require(roleKey);
    expect(binding).toMatchObject({ role: Role.PRIMARY_CTO, sessionId: first.sessionId,
      sessionIncarnation: first.sessionIncarnation, bindingGeneration: 1 });
    const token = "bootstrap-stage-socket-token";
    const listeners = await startLocalMcpListeners(f.h.cp, tempDir("bp-stage-"), token);
    try {
      if (!session.sessionSecret) throw new Error("missing socket credential");
      const call = () => callMcpToolOverSocket(listeners.socketPaths[1]!, {
        token, sessionId: first.sessionId, sessionSecret: session.sessionSecret!,
      }, "bootstrap_plan_stage", { ...f.attachArgs, idempotencyKey: "stage-socket" });
      const staged = await call();
      expect(staged).toMatchObject({ ok: true, value: { digest: f.digest, stagedBy: roleKey } });
      expect(await call()).toEqual(staged);
      expect(f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").map(a => a.content.stagedBy)).toEqual([roleKey]);
      expect(f.h.cp.audit.byKind("BOOTSTRAP_PLAN_STAGED")).toMatchObject([{ roleKey, sessionId: first.sessionId }]);
      expect(await f.attach({ planBody: undefined, stagedBy: roleKey })).toMatchObject({ ok: true, value: { digest: f.digest } });
    } finally { await listeners.close(); await f.close(); }
  });

  it("refuses binding-free compatibility peers instead of selecting a PRIMARY_CTO role", async () => {
    const f = await stagingFixture();
    try {
      const call = await f.connect("cto", f.primary.sessionId);
      const before = f.state();
      expect(await call("bootstrap_plan_stage", f.attachArgs)).toMatchObject({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });

  it.each(["owner", "peer"] as const)("stages inert exact bytes once, then %s-attaches, reads and submits by digest", async principal => {
    const f = await stagingFixture(principal);
    try {
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      const before = f.state();
      expect(await f.stage()).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.stage()).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.stage({ idempotencyKey: "stage-again" })).toMatchObject({ ok: true });
      const staged = f.state();
      expect(staged.artifacts).toHaveLength(before.artifacts.length + 1);
      expect(staged.audit.filter(e => e.kind === "BOOTSTRAP_PLAN_STAGED")).toHaveLength(1);
      expect(staged.run).toEqual(before.run);
      expect(staged.candidate).toEqual(before.candidate);
      expect(staged.application).toEqual(before.application);
      expect(staged.outbox).toEqual(before.outbox);
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toBeNull();
      expect(f.h.cp.artifacts.latest(f.run.runId, "APPROVAL")).toBeNull();
      expect(wake).not.toHaveBeenCalled();
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
      expect(await f.cto("plan_submit", { idempotencyKey: "premature", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: false });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true, value: { digest: f.digest } });
      await vi.waitFor(() => expect(wake).toHaveBeenCalled());
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
      expect(await f.cto("plan_submit", { idempotencyKey: "submit-staged", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true, value: { digest: f.digest } });
      const submitted = f.h.cp.artifacts.list(f.run.runId);
      expect(await f.stage()).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.stage({ idempotencyKey: "same-candidate-after-submit" })).toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(submitted);
      expect(JSON.stringify(f.h.cp.audit.all())).not.toContain("Implement the agreed product");
    } finally { await f.close(); }
  });

  it.each([
    { contractDigest: sha256("other contract") }, { bootstrapOperationId: "wrong" }, { projectId: "wrong" },
    { repositoryIdentity: "github:other/repo" }, { expectedSha256: sha256("wrong bytes") },
    { planBody: "x".repeat(128 * 1024 + 1) }, { planBody: "{private-invalid-json" }, { planBody: "é".repeat(64 * 1024 + 1) }, { planBody: "\ud800" },
    ...["idempotencyKey", "runId", "contractDigest", "expectedSha256", "bootstrapOperationId", "projectId", "repositoryIdentity"].flatMap(field =>
      ["\r", "\n", "\x00", "\x7f"].map(control => ({ [field]: `bad${control}id` }))),
  ])("refuses invalid stage without writes, case %#", async overrides => {
    const f = await stagingFixture();
    try {
      const before = f.state();
      expect(await f.stage(overrides)).toMatchObject({ ok: false });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });

  it("refuses other roles, stale primary generations and unrelated run kinds without writes", async () => {
    const f = await stagingFixture();
    try {
      const before = f.state();
      expect(await f.cto("bootstrap_plan_stage", f.attachArgs)).toMatchObject({ ok: false });
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, planBody: undefined, stagedBy: f.primary.roleKey })).toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
      expect(await f.stage({ runId: f.primary.runId })).toMatchObject({ ok: false });
      expect(f.state()).toEqual(before);
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(f.h.cp.runs.transition(f.primary.runId, RunState.BLOCKED, "revoke primary").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.primary.roleKey, "revoke primary", { allowBlockedRuns: true }).allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: f.primary.projectId, sessionId: f.primary.sessionId }).allowed).toBe(true);
      const stale = f.state();
      expect(await f.stage()).toMatchObject({ ok: false });
      expect(await f.stage({ idempotencyKey: "stale-fresh-key" })).toMatchObject({ ok: false });
      expect(f.state()).toEqual(stale);
    } finally { await f.close(); }
  });

  it("never overwrites a candidate, even with a new key", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      const before = f.state();
      const body = f.body + " ";
      expect(await f.stage({ idempotencyKey: "different", planBody: body, expectedSha256: sha256(body) })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });

  it.each(["contractDigest", "bootstrapOperationId", "projectId", "repositoryIdentity"])("revalidates staged %s on owner attach", async field => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      const before = f.state();
      expect(await f.attach({ planBody: undefined, [field]: field === "contractDigest" ? sha256("changed") : "changed" })).toMatchObject({ ok: false });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });
});


describe("staged bootstrap PLAN boundaries and inline parity", () => {
  it("produces byte-identical attachment content, audit evidence and dispatch payload to inline attach", async () => {
    const f = await stagingFixture();
    const cloneRoot = tempDir("bootstrap-parity-");
    const raw = new Database(join(f.h.root, "state.sqlite"));
    await raw.backup(join(cloneRoot, "state.sqlite"));
    raw.close();
    chmodSync(join(cloneRoot, "state.sqlite"), 0o600);
    const inline = makeHarness({ root: cloneRoot, repoPath: f.h.repoPath });
    try {
      const inlineCall = await f.connect("hermes", f.ceo, true, "complete", inline.cp);
      const stagedWake = vi.fn<InBandWake>(async () => allow(ReasonCode.OK, undefined));
      const inlineWake = vi.fn<InBandWake>(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(stagedWake);
      inline.cp.outbox.attachInBandWake(inlineWake);
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(stagedWake).not.toHaveBeenCalled();
      expect(await inlineCall("bootstrap_plan_attach", f.attachArgs)).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      await vi.waitFor(() => { expect(stagedWake).toHaveBeenCalled(); expect(inlineWake).toHaveBeenCalled(); });
      const attachment = (cp: typeof inline.cp) => cp.artifacts.list<Args>(f.run.runId, "HANDOFF")
        .find(a => a.content.schema === "acp.bootstrap-plan-input.v1")!;
      const staged = attachment(f.h.cp);
      const direct = attachment(inline.cp);
      const { artifactId: _stagedArtifactId, ...stagedArtifact } = staged;
      const { artifactId: _directArtifactId, ...directArtifact } = direct;
      expect(stagedArtifact).toEqual(directArtifact);
      expect(staged.digest).toBe(direct.digest);
      expect(Buffer.from(JSON.stringify(staged.content))).toEqual(Buffer.from(JSON.stringify(direct.content)));
      expect(Buffer.from(staged.content.bodyBase64 as string, "base64")).toEqual(Buffer.from(f.body));
      const audit = (cp: typeof inline.cp) => cp.audit.forRun(f.run.runId).find(e => e.kind === "BOOTSTRAP_PLAN_ATTACHED")!;
      // Row ids differ; all attachment audit fields and evidence are identical.
      const { eventId: _stagedId, ...stagedAudit } = audit(f.h.cp);
      const { eventId: _inlineId, ...inlineAudit } = audit(inline.cp);
      expect(Buffer.from(JSON.stringify(stagedAudit))).toEqual(Buffer.from(JSON.stringify(inlineAudit)));
      const dispatch = (cp: typeof inline.cp) => cp.outbox.listByRun(f.run.runId).find(m => (m.payload as Args).bootstrapPlanDigest === f.digest)!;
      const a = dispatch(f.h.cp), b = dispatch(inline.cp);
      expect(Buffer.from(JSON.stringify(a.payload))).toEqual(Buffer.from(JSON.stringify(b.payload)));
      expect([a.roleKey, a.bindingGeneration, a.targetSessionId, a.kind, a.runId, a.idempotencyKey])
        .toEqual([b.roleKey, b.bindingGeneration, b.targetSessionId, b.kind, b.runId, b.idempotencyKey]);
      expect(stagedWake).toHaveBeenCalledWith(f.run.ownerRoleKey, expect.any(Array));
      expect(inlineWake).toHaveBeenCalledWith(f.run.ownerRoleKey, expect.any(Array));
      expect(stagedWake).toHaveBeenCalledTimes(inlineWake.mock.calls.length);
      const wakes = (wake: typeof stagedWake, messageId: string) => wake.mock.calls.map(([role, ids]) =>
        [role, ids?.map(id => id === messageId ? "attachment-dispatch-id" : id)]);
      expect(wakes(stagedWake, a.messageId)).toEqual(wakes(inlineWake, b.messageId));
    } finally { await f.close(); inline.cp.close(); }
  });

  it("does not resolve a different run's same-digest candidate and admits a valid peer attach", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      const created = f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD",
        contract: { goal: "another bootstrap", why: "test", scope: [], nonGoals: [], priority: "NORMAL", humanGate: [], references: [], acceptance: ["test"] } });
      if (!created.allowed) throw new Error(created.message);
      const other = await dispatchBootstrapRun(f.h.cp, f.h.clock, created.value.runId);
      const before = f.state();
      expect(await f.attach({ planBody: undefined, runId: other.runId, contractDigest: other.contractDigest }))
        .toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
      expect(f.h.cp.artifacts.list(other.runId, "HANDOFF")).toHaveLength(0);
      expect(f.state()).toEqual(before);
      const peerMeta = { [HERMES_PROVENANCE_META_KEY]: { principal: "peer", session_id: "approved-ceo-head",
        lineage_root_digest: digestOf("bootstrap plan approval lineage"), cron: false, delegation_depth: 0, peer_grant: digestOf("grant") } };
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, planBody: undefined, stagedBy: f.primary.roleKey }, peerMeta))
        .toMatchObject({ ok: true, value: { digest: f.digest } });
    } finally { await f.close(); }
  });

  it("refuses stale owner pins on stage replay and digest-only attach", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "owner stale").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.run.ownerRoleKey!, "owner stale", { allowBlockedRuns: true }).allowed).toBe(true);
      const before = f.state();
      expect(await f.stage()).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });

  it("attaches a staged candidate after a same-session owner renewal and re-stages identical bytes idempotently", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "renew owner").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.run.ownerRoleKey!, "renew owner", { allowBlockedRuns: true }).allowed).toBe(true);
      const renewed = f.h.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId, sessionId: f.run.ownerSessionId! });
      if (!renewed.allowed) throw new Error(renewed.message);
      expect(f.h.cp.runs.restoreRecoveredBootstrapOwner(f.run.runId, renewed.value, f.run.ownerBindingGeneration!).allowed).toBe(true);
      const before = f.h.cp.artifacts.list(f.run.runId);
      expect(await f.stage()).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.stage({ idempotencyKey: "restage-after-renewal" })).toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(before);
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
    } finally { await f.close(); }
  });

  it("rolls back staged artifact and audit when staging audit refuses", async () => {
    const f = await stagingFixture();
    try {
      const record = f.h.cp.audit.record.bind(f.h.cp.audit);
      vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => input.kind === "BOOTSTRAP_PLAN_STAGED"
        ? deny(ReasonCode.CONFLICT, "test refused staging audit") : record(input));
      const before = f.state();
      expect(await f.stage()).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      const { receipts: _beforeReceipts, ...beforeDomain } = before;
      const { receipts: _afterReceipts, ...afterDomain } = f.state();
      expect(afterDomain).toEqual(beforeDomain);
    } finally { await f.close(); }
  });
});


describe("B1 delegated bootstrap PLAN admission", () => {
  const meta = (principal: "owner" | "peer", overrides: Args = {}) => ({ [HERMES_PROVENANCE_META_KEY]: {
    principal, session_id: "approved-ceo-head", lineage_root_digest: digestOf("bootstrap plan approval lineage"),
    cron: false, delegation_depth: 0, ...(principal === "peer" ? { peer_grant: digestOf("grant") } : {}), ...overrides,
  } });
  it.each(["owner", "peer"] as const)("preserves complete CEO authentication before digests for %s calls, with no writes", async principal => {
    const f = await stagingFixture(principal);
    try {
      const before = f.state();
      for (const identity of ["unauthenticated", "actor-only", "session-only", "incarnation-only"] as const) {
        const call = await f.connect("hermes", f.ceo, true, identity);
        for (const expectedSha256 of [f.digest, "bad-digest", "bad\rid"]) {
          expect(await call("bootstrap_plan_attach", { ...f.attachArgs, expectedSha256 }, meta(principal)))
            .toMatchObject({ ok: false, reasonCode: identity === "session-only" ? "BINDING_GENERATION_STALE" : "MCP_PEER_UNAUTHENTICATED" });
          expect(f.state()).toEqual(before);
        }
      }
      const other = await f.connect("hermes", f.run.ownerSessionId!);
      expect(await other("bootstrap_plan_attach", f.attachArgs, meta(principal))).toMatchObject({ ok: false });
      expect(await f.attach({ runId: f.primary.runId })).toMatchObject({ ok: false });
      expect(await f.attach({ runId: "run_other" })).toMatchObject({ ok: false });
      expect(f.state()).toEqual(before);
      expect(f.h.cp.bindings.revoke("CEO", "stale CEO").allowed).toBe(true);
      const stale = f.state();
      expect(await f.attach()).toMatchObject({ ok: false });
      expect(f.state()).toEqual(stale);
    } finally { await f.close(); }
  });

  it.each([
    { cron: true }, { delegation_depth: 1 }, { lineage_root_digest: digestOf("wrong lineage") },
    { session_id: "wrong-session" }, { peer_grant: undefined }, { principal: "admin" },
  ])("refuses bad peer provenance case %# without writes", async overrides => {
    const f = await stagingFixture();
    try {
      const before = f.state();
      expect(await f.hermes("bootstrap_plan_attach", f.attachArgs, meta("peer", overrides)))
        .toMatchObject({ ok: false, reasonCode: "MCP_TOOL_PROVENANCE_REFUSED" });
      expect(await f.hermes("bootstrap_plan_attach", f.attachArgs, {}))
        .toMatchObject({ ok: false, reasonCode: "MCP_TOOL_PROVENANCE_REFUSED" });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });

  it("records the peer grant, fences its replay fingerprint, and keeps owner decisions and suspension owner-only", async () => {
    const f = await stagingFixture("peer");
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(f.h.cp.audit.byKind("BOOTSTRAP_PLAN_ATTACHED")[0]?.evidence)
        .toMatchObject({ hermesPrincipal: "peer", hermesPeerGrant: digestOf("grant") });
      const before = f.state();
      expect(await f.hermes("bootstrap_plan_attach", f.attachArgs, meta("peer", { peer_grant: digestOf("other grant") })))
        .toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(await f.hermes("owner_decision_submit", { idempotencyKey: "peer-decision", runId: f.run.runId,
        item: "bootstrap", approved: true }, meta("peer"))).toMatchObject({ ok: false, reasonCode: "OWNER_AUTHORITY_NOT_DELEGABLE" });
      expect(await f.hermes("cto_suspend", { idempotencyKey: "peer-suspend", projectId: f.primary.projectId,
        reason: "peer request" }, meta("peer"))).toMatchObject({ ok: false, reasonCode: "OWNER_AUTHORITY_NOT_DELEGABLE" });
      expect(f.state()).toEqual(before);
    } finally { await f.close(); }
  });
});


async function anotherStager(f: Awaited<ReturnType<typeof stagingFixture>>, canonical = false) {
  const projectId = "prj_other_stager";
  const project = f.h.cp.projects.register({ projectId, name: "another stager" });
  if (!project.allowed) throw new Error(project.message);
  const session = f.h.cp.sessions.create({ provider: "claude", model: "opus" });
  f.h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "another stager");
  const targetLocator = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator, targetLocatorDigest: sha256(targetLocator) };
  const binding = f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId,
    ...(canonical ? { authenticatedTarget: { claimed, protocolVersion: SELF_CLAIM_PROTOCOL, attestationDigest: digestOf(claimed), verify: () => claimed } } : {}) });
  if (!binding.allowed) throw new Error(binding.message);
  const call = await f.connect("cto", session.sessionId, true, "complete", f.h.cp,
    { roleKey: binding.value.roleKey, bindingGeneration: binding.value.bindingGeneration });
  const body = f.body + " ";
  const digest = sha256(body);
  const stage = (overrides: Args = {}) => call("bootstrap_plan_stage", { ...f.attachArgs, idempotencyKey: "other-stage",
    planBody: body, expectedSha256: digest, ...overrides });
  return { call, stage, body, digest, roleKey: binding.value.roleKey, projectId, sessionId: session.sessionId };
}

describe("B2 candidates are non-authoritative uploads selected by run, stager and digest", () => {
  it("counts only the authenticated stager's history when another stager has attached or pending candidates", async () => {
    const f = await stagingFixture();
    try {
      const other = await anotherStager(f);
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await other.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined, stagedBy: other.roleKey, expectedSha256: other.digest }))
        .toMatchObject({ ok: true });
      const body = f.body + "\n";
      const replacement = { idempotencyKey: "own-replacement", planBody: body, expectedSha256: sha256(body) };
      const before = f.state();
      // The other stager's attached candidate does not consume this stager's pending upload.
      expect(await f.stage({ ...replacement, stagedBy: other.roleKey }))
        .toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.state()).toEqual(before);
      expect(await f.attach({ idempotencyKey: "consume-own", planBody: undefined, replacesSha256: other.digest }))
        .toMatchObject({ ok: true });
      const otherBody = f.body + "\t";
      expect(await other.stage({ idempotencyKey: "other-pending", planBody: otherBody, expectedSha256: sha256(otherBody) }))
        .toMatchObject({ ok: true });
      // Conversely, the other stager's pending candidate cannot block this consumed history.
      expect(await f.stage(replacement)).toMatchObject({ ok: true, value: { digest: sha256(body), stagedBy: f.primary.roleKey } });
      const candidates = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").filter(a => a.content.stagedBy);
      expect(candidates.filter(a => a.content.stagedBy === f.primary.roleKey).map(a => a.content.sha256)).toEqual([f.digest, sha256(body)]);
      expect(candidates.filter(a => a.content.stagedBy === other.roleKey).map(a => a.content.sha256)).toEqual([other.digest, sha256(otherBody)]);
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId }))
        .toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
    } finally { await f.close(); }
  });

  it("selects an older exact candidate without falling back to a newer candidate or another stager", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      const body = f.body + "\n";
      const digest = sha256(body);
      expect(await f.stage({ idempotencyKey: "own-newer", planBody: body, expectedSha256: digest })).toMatchObject({ ok: true });
      const other = await anotherStager(f);
      expect(await other.stage()).toMatchObject({ ok: true });
      const before = f.state();
      for (const selection of [
        { stagedBy: f.primary.roleKey, expectedSha256: other.digest },
        { stagedBy: other.roleKey, expectedSha256: digest },
        { stagedBy: f.primary.roleKey, expectedSha256: sha256("absent candidate") },
      ]) {
        expect(await f.attach({ idempotencyKey: "no-fallback", planBody: undefined, replacesSha256: f.digest, ...selection }))
          .toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
        expect(f.state()).toEqual(before);
      }
      // A remains selectable even though B and the other stager's upload are newer.
      expect(await f.attach({ idempotencyKey: "select-older-A", planBody: undefined }))
        .toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId }))
        .toMatchObject({ ok: true, value: { digest: f.digest, planBody: f.body } });
    } finally { await f.close(); }
  });

  it("keeps stager slots independent and derives identity from authentication even when arguments name another role", async () => {
    const f = await stagingFixture();
    try {
      const other = await anotherStager(f);
      expect(await other.stage()).toMatchObject({ ok: true, value: { digest: other.digest, stagedBy: other.roleKey } });
      expect(await f.stage({ stagedBy: other.roleKey, roleKey: other.roleKey }))
        .toMatchObject({ ok: true, value: { digest: f.digest, stagedBy: f.primary.roleKey } });
      const candidates = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF");
      expect(candidates).toHaveLength(2);
      expect(candidates.map(a => a.content.stagedBy).sort()).toEqual([f.primary.roleKey, other.roleKey].sort());
      expect(candidates.every(a => !("ownerPin" in a.content))).toBe(true);
      const before = f.state();
      // Forging the other identity never writes that slot, nor returns its bytes.
      expect(await f.stage({ idempotencyKey: "forged-overwrite", stagedBy: other.roleKey,
        planBody: other.body, expectedSha256: other.digest })).toMatchObject({ ok: false });
      expect(await other.call("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: false });
      expect(f.state()).toEqual(before);
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true, value: { digest: f.digest } });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId })).toMatchObject({ ok: true, value: { planBody: f.body } });
    } finally { await f.close(); }
  });

  it("lets the CEO explicitly select another stager's candidate without a latest or cross-slot fallback", async () => {
    const f = await stagingFixture();
    try {
      const other = await anotherStager(f);
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await other.stage()).toMatchObject({ ok: true });
      const before = f.state();
      for (const selection of [
        { stagedBy: undefined }, { stagedBy: "BOOTSTRAP_CTO:wrong" }, { stagedBy: "PRIMARY_CTO:" },
        { stagedBy: "PRIMARY_CTO:missing" }, { stagedBy: `PRIMARY_CTO:bad\rkey` },
        { stagedBy: f.primary.roleKey, expectedSha256: other.digest },
        { stagedBy: other.roleKey, expectedSha256: f.digest },
      ]) {
        expect(await f.attach({ planBody: undefined, ...selection })).toMatchObject({ ok: false });
        expect(f.state()).toEqual(before);
      }
      expect(await f.attach({ planBody: undefined, stagedBy: other.roleKey, expectedSha256: other.digest }))
        .toMatchObject({ ok: true, value: { digest: other.digest } });
      expect(await f.cto("bootstrap_plan_get", { runId: f.run.runId }))
        .toMatchObject({ ok: true, value: { digest: other.digest, planBody: other.body } });
      expect(await f.cto("plan_submit", { idempotencyKey: "selected-other", runId: f.run.runId, bootstrapPlanDigest: other.digest }))
        .toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it("never treats staged candidates or attached PLAN input as an activation or resident handoff package", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.stage()).toMatchObject({ ok: true });
      expect(await f.attach({ planBody: undefined })).toMatchObject({ ok: true });
      const recipient = await anotherStager(f, true);
      const fixture = { harness: f.h } as Parameters<typeof producedHandoff>[0];
      const handoff = producedHandoff(fixture, f.run.runId, recipient.projectId);
      const open = openActivationHandoff(fixture);
      const opened = open(recipient.projectId, f.run.runId, recipient.sessionId, handoff);
      expect(opened).toMatchObject({ allowed: true });
      if (!opened.allowed) throw new Error(opened.message);
      // A second candidate is newer than the real handoff and must never hide it.
      const replacementBody = f.body + " ";
      expect(await f.stage({ idempotencyKey: "handoff-stage-B", planBody: replacementBody, expectedSha256: sha256(replacementBody) }))
        .toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").filter(a => a.content.stagedBy)).toHaveLength(2);
      expect(open(recipient.projectId, f.run.runId, recipient.sessionId, handoff))
        .toMatchObject({ allowed: true, value: { handoffId: opened.value.handoffId } });
      const reader = f.h.cp.bootstrap as unknown as { activationHandoff(runId: string): { content: Args } | null };
      expect(reader.activationHandoff(f.run.runId)?.content.handoffId).toBe(opened.value.handoffId);
      const message = f.h.cp.outbox.byIdempotencyKey(`bootstrap-handoff:${opened.value.handoffId}`)!;
      expect(await recipient.call("role_dispatch_pending", {})).toMatchObject({ ok: true,
        value: { messages: [expect.objectContaining({ messageId: message.messageId, kind: "HANDOFF_PACKAGE" })] } });
      expect(await recipient.call("handoff_ack", { idempotencyKey: "real-handoff-ack", handoffId: opened.value.handoffId,
        messageId: message.messageId, bindingGeneration: message.bindingGeneration, payloadDigest: message.payloadDigest }))
        .toMatchObject({ ok: true });
      expect(f.h.cp.outbox.get(message.messageId)?.status).toBe("ACKED");
      const port = createCtoMcpPort(f.h.cp);
      for (const input of f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").filter(a => a.content.schema)) {
        expect(port.handoffKind(input.artifactId)).toBeNull();
        expect(port.handoffKind(input.digest)).toBeNull();
        expect(await f.cto("handoff_ack", { idempotencyKey: `input-not-handoff-${input.artifactId}`,
          handoffId: input.artifactId, messageId: "missing", payloadDigest: input.digest, bindingGeneration: 1 }))
          .toMatchObject({ ok: false, reasonCode: "NOT_FOUND" });
      }
    } finally { await f.close(); }
  });
});


// CEO 26c72ba9: one digest-bound instruction to the ACTIVE run's current owner.
describe("bootstrap_review_resume", () => {
  const args = (f: Awaited<ReturnType<typeof fixture>>, overrides: Args = {}) => ({
    idempotencyKey: "resume-review", runId: f.run.runId, contractDigest: f.run.contractDigest,
    bootstrapPlanDigest: f.digest, ownerSessionId: f.run.ownerSessionId,
    ownerSessionIncarnation: f.run.ownerSessionIncarnation, ownerBindingGeneration: f.run.ownerBindingGeneration,
    ...overrides,
  });
  const instructions = (f: Awaited<ReturnType<typeof fixture>>) => f.h.cp.outbox.listByRun(f.run.runId)
    .filter(m => m.kind === "RESUME_REVIEW");

  it("lists and calls as the authenticated CEO, wakes once, and the owner resubmits the same digest for a new blind review", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "first-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(bootstrapCoverageKeys(f.h, f.run.runId), "review again on CEO instruction") });
      expect(await f.cto("result_submit", { idempotencyKey: "first-review", runId: f.run.runId, resultSummary: "compiled PLAN", recommendation: "review" }))
        .toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
      const firstCandidate = f.h.cp.runs.currentCandidate(f.run.runId);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(f.h.cp.outbox.listByRun(f.run.runId).some(m => m.kind === "REVISION_REQUEST" && m.status === "PENDING")).toBe(true);
      const listed = (await f.hermes.listTools()).tools.find(t => t.name === "bootstrap_review_resume");
      expect(listed?.description).toContain("new blind review");
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      const first = await f.hermes("bootstrap_review_resume", args(f));
      expect(first).toMatchObject({ ok: true, value: { runId: f.run.runId, bootstrapPlanDigest: f.digest, messageId: expect.any(String) } });
      expect(await f.hermes("bootstrap_review_resume", args(f))).toEqual(first);
      expect(instructions(f)).toHaveLength(1);
      const instruction = instructions(f)[0]!;
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
      expect(wake).toHaveBeenCalledWith(f.run.ownerRoleKey, [instruction.messageId]);
      const inbox = await f.cto("role_dispatch_pending", {});
      expect(inbox).toMatchObject({ ok: true });
      const received = ((inbox.value as Args).messages as Array<{ messageId: string; payload: Args }>)
        .find(m => m.messageId === instruction.messageId)!;
      expect(received.payload).toMatchObject({ runId: f.run.runId, bootstrapPlanDigest: f.digest, intent: "RESUME_REVIEW" });
      expect(JSON.stringify(received.payload)).toContain("not CONFIRM");
      expect(JSON.stringify(received.payload)).toContain("not genesis or workflow approval");
      expect(JSON.stringify(received.payload)).toContain("not a review PASS");
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toHaveLength(1);
      expect(f.h.cp.audit.byKind("CEO_DECISION")[0]!.evidence).toMatchObject({ instruction: "RESUME_REVIEW", messageId: instruction.messageId });
      expect(f.h.cp.artifacts.list(f.run.runId, "APPROVAL")).toEqual([]);
      expect(f.h.cp.bootstrapApplications.get(f.run.runId)).toBeNull();
      expect(collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId)).toEqual([]);
      expect(f.h.cp.audit.byKind("OWNER_DECISION")).toEqual([]);
      expect(f.h.cp.audit.byKind("CEO_DECISION").some(a => a.evidence["decision"] === "CONFIRM")).toBe(false);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toEqual(firstCandidate);
      expect(await f.cto("plan_submit", { idempotencyKey: "resume-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await f.cto("result_submit", { idempotencyKey: "resume-result", runId: f.run.runId, resultSummary: "resubmitted current PLAN", recommendation: "review" })).toMatchObject({ ok: true });
      // Snapshot identity is content-based: a second freeze of these same bytes keeps the digest.
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toEqual(firstCandidate);
      const freezes = f.h.cp.audit.forRun(f.run.runId).filter(a => a.kind === "CANDIDATE_FROZEN");
      expect(freezes).toHaveLength(2);
      expect(freezes[0]!.evidence["attemptId"]).not.toEqual(freezes[1]!.evidence["attemptId"]);
      expect(f.h.scripted.invocations.filter(i => /Bootstrap plan review/.test(i.prompt))).toHaveLength(2);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("READY_FOR_CEO_REVIEW");
      expect(await f.cto("run_ack", { idempotencyKey: "resume-ack", runId: f.run.runId, messageId: instruction.messageId,
        bindingGeneration: instruction.bindingGeneration })).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  it.each([
    ["wrong run", { runId: "run_missing" }, "NOT_FOUND"],
    ["wrong contract", { contractDigest: sha256("other") }, "BOOTSTRAP_CONTRACT_DRIFT"],
    ["wrong attachment", { bootstrapPlanDigest: sha256("other") }, "SNAPSHOT_DIGEST_MISMATCH"],
    ["stale generation", { ownerBindingGeneration: 0 }, "BINDING_GENERATION_STALE"],
    ["stale session", { ownerSessionId: "ses_other" }, "BINDING_GENERATION_STALE"],
    ["stale incarnation", { ownerSessionIncarnation: "other" }, "BINDING_GENERATION_STALE"],
  ])("refuses %s without an instruction or CEO decision", async (_name, overrides, reasonCode) => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_resume", args(f, overrides as Args))).toMatchObject({ ok: false, reasonCode });
      expect(instructions(f)).toEqual([]);
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toEqual([]);
    } finally { await f.close(); }
  });

  it("keeps different keys as separate pending instructions, and replays one key without a second audit", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const first = await f.hermes("bootstrap_review_resume", args(f));
      expect(first).toMatchObject({ ok: true });

      expect(await f.hermes("bootstrap_review_resume", args(f))).toEqual(first);
      const second = await f.hermes("bootstrap_review_resume", args(f, { idempotencyKey: "another-review" }));
      expect(second).toMatchObject({ ok: true });
      expect(second).not.toEqual(first);
      expect(instructions(f)).toHaveLength(2);
      expect(instructions(f).every(m => m.status === "PENDING")).toBe(true);
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toHaveLength(2);
      expect(await f.hermes("bootstrap_review_resume", args(f, { contractDigest: sha256("changed request") })))
        .toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_CONTRACT_DRIFT" });
      expect(instructions(f)).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("recovers the same committed instruction after a response-store failure, without another audit or wake", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      const original = f.h.cp.db.run.bind(f.h.cp.db);
      let injected = false;
      vi.spyOn(f.h.cp.db, "run").mockImplementation((sql, params) => {
        if (!injected && sql.includes("UPDATE inbound_messages SET result_json") && params?.[1] === "resume-review") {
          injected = true;
          throw new Error("fixture response-store loss after commit");
        }
        return original(sql, params);
      });
      await f.hermes("bootstrap_review_resume", args(f));
      expect(injected).toBe(true);
      expect(instructions(f)).toHaveLength(1);
      const messageId = instructions(f)[0]!.messageId;
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: true, value: { messageId } });
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: true, value: { messageId } });
      expect(instructions(f)).toHaveLength(1);
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toHaveLength(1);
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it.each(["enqueue", "audit"])("rolls back instruction, audit and wake when %s refuses", async stage => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
      f.h.cp.outbox.attachInBandWake(wake);
      const before = f.h.cp.outbox.listByRun(f.run.runId);
      if (stage === "enqueue") vi.spyOn(f.h.cp.outbox, "enqueue").mockReturnValue(deny(ReasonCode.CONFLICT, "test refusal"));
      else {
        const record = f.h.cp.audit.record.bind(f.h.cp.audit);
        vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => input.kind === "CEO_DECISION"
          ? deny(ReasonCode.CONFLICT, "test refusal") : record(input));
      }
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(f.h.cp.outbox.listByRun(f.run.runId)).toEqual(before);
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it.each(["receipt", "claim", "ack"])("voids a replaced attachment on %s with SNAPSHOT_DIGEST_MISMATCH", async door => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: true });
      const message = instructions(f)[0]!;
      const input = JSON.parse(f.body);
      input.plan.summary = "explicit replacement";
      const body = JSON.stringify(input);
      expect(await f.attach({ idempotencyKey: "replace-after-enqueue", replacesSha256: f.digest, expectedSha256: sha256(body), planBody: body }))
        .toMatchObject({ ok: true });
      if (door === "receipt") {
        const inbox = await f.cto("role_dispatch_pending", {});
        expect(inbox).toMatchObject({ ok: true });
        expect(((inbox.value as Args).messages as Args[]).some(m => m.messageId === message.messageId)).toBe(false);
      } else if (door === "claim") {
        // Handover must void the instruction before the successor can claim or read it.
        const next = f.h.cp.sessions.create({ provider: "scripted", model: "claim-successor" });
        f.h.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "fixture");
        expect(f.h.cp.bindings.switchTo({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId,
          sessionId: next.sessionId, conversation: "REPLACED", reason: "fixture takeover", takeover: true }).allowed).toBe(true);
        expect(f.h.cp.outbox.claimDeliverable().some(m => m.messageId === message.messageId)).toBe(false);
      } else {
        expect(await f.cto("run_ack", { idempotencyKey: "void-ack", runId: f.run.runId, messageId: message.messageId }))
          .toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      }
      expect(f.h.cp.outbox.get(message.messageId)?.status).toBe("REJECTED");
      expect(f.h.cp.db.get("SELECT reason_code FROM outbox WHERE message_id = ?", [message.messageId]))
        .toEqual({ reason_code: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(f.h.cp.audit.byKind("OUTBOX_INSTRUCTION_SUPERSEDED").find(a => a.evidence["messageId"] === message.messageId)?.evidence)
        .toMatchObject({ reason: "BOOTSTRAP_PLAN_CHANGED" });
    } finally { await f.close(); }
  });

  it("voids attached body corruption after enqueue and refuses corruption before enqueue", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: true });
      const message = instructions(f)[0]!;
      const attachment = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")[0]!;
      const raw = new Database(f.h.cp.db.raw.name);
      try {
        raw.function("acp_evidence_write_authorized", () => 0);
        raw.exec("DROP TRIGGER run_artifacts_content_immutable");
        raw.prepare("UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?")
          .run(JSON.stringify({ ...attachment.content, bodyBase64: Buffer.from(f.body + " ").toString("base64") }), attachment.artifactId);
      } finally { raw.close(); }
      expect(await f.hermes("bootstrap_review_resume", args(f, { idempotencyKey: "damaged-input" })))
        .toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      const inbox = await f.cto("role_dispatch_pending", {});
      expect(((inbox.value as Args).messages as Args[]).some(m => m.messageId === message.messageId)).toBe(false);
      expect(f.h.cp.db.get("SELECT status, reason_code FROM outbox WHERE message_id = ?", [message.messageId]))
        .toEqual({ status: "REJECTED", reason_code: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(instructions(f)).toHaveLength(1);
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("carries the same instruction through authenticated takeover and revoke/rebind, withholding it from the stale owner", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: true });
      const message = instructions(f)[0]!;
      const next = f.h.cp.sessions.create({ provider: "scripted", model: "resume-successor" });
      f.h.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "fixture");
      expect(f.h.cp.bindings.switchTo({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId,
        sessionId: next.sessionId, conversation: "REPLACED", reason: "fixture takeover", takeover: true }).allowed).toBe(true);
      const carried = f.h.cp.outbox.get(message.messageId)!;
      expect(carried).toMatchObject({ messageId: message.messageId, targetSessionId: next.sessionId,
        bindingGeneration: message.bindingGeneration + 1, status: "PENDING", payload: message.payload });
      const oldInbox = await f.cto("role_dispatch_pending", {});
      expect(((oldInbox.value as Args).messages as Args[]).some(m => m.messageId === message.messageId)).toBe(false);
      expect(f.h.cp.outbox.acknowledge(message.messageId, f.run.ownerSessionId!, message.bindingGeneration, f.run.ownerSessionIncarnation!).allowed).toBe(false);
      expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "fixture hold").allowed).toBe(true);
      expect(f.h.cp.bindings.revoke(f.run.ownerRoleKey!, "fixture revoke", { allowBlockedRuns: true }).allowed).toBe(true);
      expect(f.h.cp.outbox.claimDeliverable().some(m => m.messageId === message.messageId)).toBe(false);
      expect(f.h.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId, sessionId: next.sessionId }).allowed).toBe(true);
      expect(f.h.cp.outbox.get(message.messageId)).toMatchObject({ messageId: message.messageId,
        targetSessionId: next.sessionId, bindingGeneration: message.bindingGeneration + 2, status: "PENDING", payload: message.payload });
      const successor = await f.connect("cto", next.sessionId);
      const inbox = await successor("role_dispatch_pending", {});
      expect(((inbox.value as Args).messages as Args[]).filter(m => m.messageId === message.messageId)).toHaveLength(1);
      expect(f.h.cp.outbox.claimDeliverable().some(m => m.messageId === message.messageId)).toBe(false);
      expect(instructions(f)).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["owner", "peer"] as const)("requires complete CEO identity and valid provenance before digest validation on a %s turn", async principal => {
    const f = await fixture(principal);
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const incomplete = await f.connect("hermes", f.ceo, true, "actor-only");
      expect(await incomplete("bootstrap_review_resume", args(f, { bootstrapPlanDigest: "not-a-digest" })))
        .toMatchObject({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      expect(await f.hermes("bootstrap_review_resume", args(f), {})).toMatchObject({ ok: false, reasonCode: "MCP_TOOL_PROVENANCE_REFUSED" });
      expect(await f.hermes("bootstrap_review_resume", args(f, { bootstrapPlanDigest: "not-a-digest" })))
        .toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT", evidence: { refusal: "BOOTSTRAP_PLAN_DIGEST_INVALID" } });
      expect(instructions(f)).toEqual([]);
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: true });
      expect(f.h.cp.audit.byKind("CEO_DECISION")[0]!.evidence).toMatchObject({ hermesPrincipal: principal });
    } finally { await f.close(); }
  });

  it("refuses BLOCKED and unrelated runs", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "fixture hold").allowed).toBe(true);
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: false, reasonCode: "RUN_TRANSITION_ILLEGAL" });
      const other = seedRun({ db: f.h.cp.db, clock: f.h.clock, repoPath: f.h.repoPath });
      expect(await f.hermes("bootstrap_review_resume", args(f, { runId: other.runId }))).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(instructions(f)).toEqual([]);
    } finally { await f.close(); }
  });

  it("refuses a terminal run and a non-CEO", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const stranger = await f.connect("hermes", f.run.ownerSessionId!);
      expect(await stranger("bootstrap_review_resume", args(f))).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      expect(f.h.cp.runs.cancel(f.run.runId, "finished").allowed).toBe(true);
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: false, reasonCode: "RUN_ALREADY_TERMINAL" });
      expect(instructions(f)).toEqual([]);
    } finally { await f.close(); }
  });
});
