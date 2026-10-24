import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { allow, deny } from "../../src/core/errors.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunKind, RunState } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { cleanupTempDirs, seedRun, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, dispatchBootstrapRun, makeHarness, reviewerPass } from "../helpers/harness.ts";
import { bootstrapCoverageKeys } from "../helpers/bootstrap-plan.ts";
import { genesisFile, genesisPlanFixture } from "../helpers/genesis-github.ts";

afterAll(cleanupTempDirs);
type Args = Record<string, unknown>;
async function fixture() {
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
  const meta = { [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: anchor.liveHermesSessionId,
    lineage_root_digest: lineage, cron: false, delegation_depth: 0 } };
  const servers: Array<{ close(): Promise<void> }> = [];
  async function connect(kind: "cto" | "hermes", sessionId: string, provenance = true,
    identity: "complete" | "actor-only" | "session-only" | "incarnation-only" = "complete") {
    const session = h.cp.sessions.require(sessionId);
    const auth = () => allow(ReasonCode.OK, { actor: sessionId,
      ...(identity === "complete" || identity === "session-only" ? { sessionId } : {}),
      ...(identity === "complete" || identity === "incarnation-only" ? { sessionIncarnation: session.incarnation } : {}) });
    const server = kind === "cto" ? createCtoServer(createCtoMcpPort(h.cp), auth)
      : createHermesServer(createHermesMcpPort(h.cp), auth, provenance ? { provenance: anchor } : {});
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "bootstrap-plan-artifact", version: "1" });
    await client.connect(ct);
    servers.push(server, client);
    return async (name: string, args: Args, callMeta: Args = meta): Promise<Args> => {
      const result = await client.callTool({ name, arguments: args, _meta: callMeta });
      return (result.structuredContent ?? { ok: false, rpcError: result.content }) as Args;
    };
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

  it("round-trips a realistic PLAN larger than 22 KB byte for byte, wakes the owner, and submits by approved digest", async () => {
    const f = await fixture();
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

  it("requires current CEO identity and authenticated owner-turn Hermes provenance", async () => {
    const f = await fixture();
    try {
      const other = await f.connect("hermes", f.run.ownerSessionId!);
      expect(await other("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "other", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest })).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
      const bare = await f.connect("hermes", f.ceo, false);
      expect(await bare("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "bare", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest })).toMatchObject({ ok: false, reasonCode: "OWNER_AUTHORITY_NOT_DELEGABLE" });
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "missing-meta", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest }, {})).toMatchObject({ ok: false, reasonCode: "MCP_TOOL_PROVENANCE_REFUSED" });
      const peerMeta = { [HERMES_PROVENANCE_META_KEY]: { principal: "peer", session_id: "approved-ceo-head",
        lineage_root_digest: digestOf("bootstrap plan approval lineage"), cron: false, delegation_depth: 0, peer_grant: digestOf("grant") } };
      expect(await f.hermes("bootstrap_plan_attach", { ...f.attachArgs, idempotencyKey: "peer-turn", runId: f.run.runId, planBody: f.body, expectedSha256: f.digest }, peerMeta))
        .toMatchObject({ ok: false, reasonCode: "OWNER_AUTHORITY_NOT_DELEGABLE" });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(0);
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

  it("directly refuses a different run even when the CEO supplies an otherwise valid attachment", async () => {
    const f = await fixture();
    try {
      const body = f.body.replace(f.run.runId, "run_wrong");
      expect(await f.attach({ planBody: body, expectedSha256: sha256(body) })).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(0);
    } finally { await f.close(); }
  });

  it.each(["contractDigest", "bootstrapOperationId", "projectId", "repositoryIdentity"])("binds attachment metadata to %s", async (field) => {
    const f = await fixture();
    try {
      expect(await f.attach({ [field]: field === "contractDigest" ? sha256("another contract") : "different-target" }))
        .toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_CONTRACT_DRIFT" });
      expect(f.h.cp.artifacts.list(f.run.runId, "HANDOFF")).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("requires the body's requestDigest to match the run contract", async () => {
    const f = await fixture();
    try {
      const input = JSON.parse(f.body);
      input.plan.requestDigest = sha256("different request");
      const body = JSON.stringify(input);
      expect(await f.attach({ planBody: body, expectedSha256: sha256(body) })).toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_CONTRACT_DRIFT" });
    } finally { await f.close(); }
  });

  it("checks owner generation separately from CEO authority, including a cached attach retry", async () => {
    const f = await fixture();
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
