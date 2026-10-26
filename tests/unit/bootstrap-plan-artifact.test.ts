import type { BootstrapReviewContext } from "../../src/review/blind-review.ts";
import type { Decision } from "../../src/core/errors.ts";
import { frozenBootstrapReviewEvidence, type FrozenReviewEvidenceReference } from "../../src/bootstrap/bootstrap-review-evidence.ts";
import { RunEvidenceExporter } from "../../src/export/run-evidence.ts";
import { artifactDigestMatches } from "../../src/db/artifacts.ts";
import { collectBootstrapCeoDecisions } from "../../src/bootstrap/bootstrap-ceo-decisions.ts";
import { recordBootstrapServingRuntime } from "../../src/bootstrap/bootstrap-runtime-observation.ts";
import { currentBootstrapPlan, planForSubmission, deliveredBootstrapHandoff } from "../../src/bootstrap/bootstrap-plan.ts";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Socket } from "node:net";
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
import { authenticateSocket, startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { callMcpToolOverSocket, unicodeEscapedJson } from "../helpers/mcp-socket.ts";
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
      expect(f.h.cp.artifacts.list<{ schema: string }>(f.run.runId, "HANDOFF").filter(a => a.content.schema === "acp.bootstrap-plan-input.v1")).toHaveLength(2);
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
  return { ...f, primary, call, stage, state, attach };
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
      const records = collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: f.run.runId, escalationId: null, resolution: received.payload.directive,
        source: { kind: "ACP_CEO_REVIEW_ENTRY_RELEASE", sessionId: f.ceo,
          decisionEventId: f.h.cp.audit.byKind("CEO_DECISION")[0]!.eventId,
          messageId: instruction.messageId, payloadDigest: instruction.payloadDigest,
          contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest },
      });
      expect(f.h.cp.audit.byKind("OWNER_DECISION")).toEqual([]);
      expect(f.h.cp.audit.byKind("CEO_DECISION").some(a => a.evidence["decision"] === "CONFIRM")).toBe(false);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toEqual(firstCandidate);
      expect(await f.cto("plan_submit", { idempotencyKey: "resume-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      const frozen = f.h.cp.artifacts.latest(f.run.runId, "PLAN")!;
      expect(frozen.content).toMatchObject({ authenticatedCeoDecisions: records });
      const planned = currentBootstrapPlan(f.run.runId, frozen);
      if (!planned.allowed) throw new Error(planned.message);
      expect(planned.value.outputs.handoff.recentDecisions).toContain(JSON.stringify({ authenticatedCeoDecision: records[0] }));
      const instructionText = planned.value.outputs.handoff.recommendedNextAction;
      expect(instructionText).toContain("existing runs and dependencies first");
      expect(instructionText).toContain("rollback-able");
      expect(instructionText).toContain("never create runs mechanically one per issue");
      expect(instructionText).toContain("EVERY seeded issue's acceptance");
      const issues = (f.plan["genesis"] as { issues: Array<{ key: string; title: string; body: string }> }).issues;
      expect(JSON.parse(instructionText.split("ALL seeded issues: ")[1]!)).toEqual(issues.map(issue => ({
        repository: f.attachArgs.repositoryIdentity, key: issue.key, title: issue.title, acceptance: issue.body,
      })));
      // Another genuine release after submission stays outside this PLAN's handoff, and this PLAN is
      // no longer reviewed without it: a fresh-key plan_submit freezes it first (BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN).
      expect(await f.hermes("bootstrap_review_resume", args(f, { idempotencyKey: "later-release" }))).toMatchObject({ ok: true });
      expect(collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId)).toHaveLength(2);
      expect(currentBootstrapPlan(f.run.runId, f.h.cp.artifacts.latest(f.run.runId, "PLAN")))
        .toMatchObject({ allowed: true, value: { outputs: { handoff: planned.value.outputs.handoff } } });
      expect(await f.cto("result_submit", { idempotencyKey: "resume-result-unfrozen", runId: f.run.runId, resultSummary: "resubmitted current PLAN", recommendation: "review" }))
        .toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN" });
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).toEqual(firstCandidate);
      expect(await f.cto("plan_submit", { idempotencyKey: "later-release-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await f.cto("result_submit", { idempotencyKey: "resume-result", runId: f.run.runId, resultSummary: "resubmitted current PLAN", recommendation: "review" })).toMatchObject({ ok: true });
      // The release is newly frozen authority, so the re-review judges a new candidate.
      expect(f.h.cp.runs.currentCandidate(f.run.runId)).not.toEqual(firstCandidate);
      const prompt = f.h.scripted.invocations.filter(i => /Bootstrap plan review/.test(i.prompt)).at(-1)!.prompt;
      expect(prompt).toContain("release of review entry");
      expect(prompt).toContain("distinct from escalation resolutions");
      expect(prompt).toContain(records[0]!.digest);
      const decisionSection = prompt.split("## Authenticated CEO decisions (ACP records)")[1]!.split("```json\n")[1]!.split("\n```")[0]!;
      expect(JSON.parse(decisionSection)).toEqual(collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId));
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
      const beforeAudit = f.h.cp.audit.forRun(f.run.runId);
      const beforeRun = f.h.cp.runs.require(f.run.runId);
      let wroteBeforeRefusing = false;
      if (stage === "enqueue") {
        const enqueue = f.h.cp.outbox.enqueue.bind(f.h.cp.outbox);
        vi.spyOn(f.h.cp.outbox, "enqueue").mockImplementation(input => {
          const queued = enqueue(input);
          expect(queued.allowed).toBe(true);
          expect(instructions(f)).toHaveLength(1);
          wroteBeforeRefusing = true;
          return deny(ReasonCode.CONFLICT, "test refusal after enqueue writes");
        });
      }
      else {
        const record = f.h.cp.audit.record.bind(f.h.cp.audit);
        vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => {
          const recorded = record(input);
          if (input.kind !== "CEO_DECISION") return recorded;
          expect(recorded.allowed).toBe(true);
          expect(instructions(f)).toHaveLength(1);
          expect(f.h.cp.audit.byKind("CEO_DECISION")).toHaveLength(1);
          wroteBeforeRefusing = true;
          return deny(ReasonCode.CONFLICT, "test refusal after audit writes");
        });
      }
      expect(await f.hermes("bootstrap_review_resume", args(f))).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
      expect(wroteBeforeRefusing).toBe(true);
      expect(f.h.cp.outbox.listByRun(f.run.runId)).toEqual(before);
      expect(f.h.cp.audit.forRun(f.run.runId)).toEqual(beforeAudit);
      expect(f.h.cp.runs.require(f.run.runId)).toEqual(beforeRun);
      expect(f.h.cp.audit.byKind("CEO_DECISION")).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await f.close(); }
  });

  it("commits the CEO audit and resume instruction together before waking the owner", async () => {
    const f = await fixture();
    const observer = new Database(f.h.cp.db.raw.name, { readonly: true });
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const visible = () => ({
        instructions: observer.prepare("SELECT message_id FROM outbox WHERE kind = 'RESUME_REVIEW'").all(),
        decisions: observer.prepare("SELECT evidence_json FROM audit_events WHERE kind = 'CEO_DECISION'").all(),
      });
      const phases: string[] = [];
      const enqueue = f.h.cp.outbox.enqueue.bind(f.h.cp.outbox);
      vi.spyOn(f.h.cp.outbox, "enqueue").mockImplementation(input => {
        const queued = enqueue(input);
        expect(queued.allowed).toBe(true);
        expect(instructions(f)).toHaveLength(1);
        expect(visible()).toEqual({ instructions: [], decisions: [] });
        phases.push("enqueue");
        return queued;
      });
      const record = f.h.cp.audit.record.bind(f.h.cp.audit);
      vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => {
        const recorded = record(input);
        if (input.kind === "CEO_DECISION") {
          expect(recorded.allowed).toBe(true);
          expect(f.h.cp.audit.byKind("CEO_DECISION")).toHaveLength(1);
          expect(visible()).toEqual({ instructions: [], decisions: [] });
          phases.push("audit");
        }
        return recorded;
      });
      const observations: ReturnType<typeof visible>[] = [];
      const wake = vi.fn(async () => {
        observations.push(visible());
        phases.push("wake");
        return allow(ReasonCode.OK, undefined);
      });
      f.h.cp.outbox.attachInBandWake(wake);
      const result = await f.hermes("bootstrap_review_resume", args(f));
      expect(result).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
      const messageId = (result.value as Args).messageId;
      expect(phases).toEqual(["enqueue", "audit", "wake"]);
      expect(observations).toEqual([{
        instructions: [{ message_id: messageId }],
        decisions: [{ evidence_json: expect.any(String) }],
      }]);
      expect(JSON.parse((observations[0]!.decisions[0] as { evidence_json: string }).evidence_json))
        .toMatchObject({ instruction: "RESUME_REVIEW", messageId });
      expect(wake).toHaveBeenCalledWith(f.run.ownerRoleKey, [messageId]);
    } finally { observer.close(); vi.restoreAllMocks(); await f.close(); }
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

describe("private bootstrap review originals and serving runtime", () => {
  it("shows ACP deployment observation separately from code guarantees and execution results", async () => {
    const f = await fixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "runtime-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      const reviewed = await f.cto("result_submit", { idempotencyKey: "runtime-review", runId: f.run.runId, resultSummary: "review", recommendation: "review" });
      expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
      const prompt = f.h.scripted.invocations.find(i => /Bootstrap plan review/.test(i.prompt))!.prompt;
      expect(prompt).toContain("## Observed serving daemon (ACP record)");
      expect(prompt).toContain("No ACP startup observation for this process");
      expect(prompt).toContain("## Individual gate execution records");
      expect(prompt).toContain("Code guarantees are not individual gate execution results");
    } finally { await f.close(); }
  });

  it.each(["wrong run", "file digest", "duplicate path", "forged verification", "author reasoning", "CTO reasoning", "worker reasoning", "chat history", "missing excerpt sections", "oversized"])(
    "refuses %s evidence before an immutable upload exists", async fault => {
      const f = await stagingFixture();
      try {
        expect(await f.attach()).toMatchObject({ ok: true });
        const text = "failure\nfix\nresult\n";
        const file: Args = { path: "original.log", origin: "execution stdout", grade: "execution-log", sha256: sha256(text), bodyBase64: Buffer.from(text).toString("base64") };
        if (fault === "file digest") file.sha256 = sha256("other");
        if (fault === "forged verification") file.verification = "ACP-verified";
        if (["author reasoning", "CTO reasoning", "worker reasoning", "chat history"].includes(fault)) file.grade = fault;
        if (fault === "missing excerpt sections") file.excerpt = { originalSha256: sha256("original"), omitted: true, ranges: [{ section: "result", startLine: 20, endLine: 22 }] };
        if (fault === "oversized") file.origin = "x".repeat(512 * 1024);
        const body = JSON.stringify({ runId: fault === "wrong run" ? "run_other" : f.run.runId, contractDigest: f.run.contractDigest,
          files: fault === "duplicate path" ? [file, file] : [file], missing: ["#58 raw RED/GREEN", "#60 raw RED/GREEN", "#59 raw output"] });
        const before = f.h.cp.artifacts.list(f.run.runId);
        expect(await f.call("bootstrap_review_evidence_stage", { idempotencyKey: "invalid-evidence", runId: f.run.runId,
          contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest, evidenceBody: body, expectedSha256: sha256(body) })).toMatchObject({ ok: false });
        expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(before);
      } finally { await f.close(); }
    });

  it.each([512 * 1024, 512 * 1024 + 1])("bounds review evidence by UTF-8 bytes at %i", async size => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const base = JSON.stringify({ runId: f.run.runId, contractDigest: f.run.contractDigest, files: [], missing: [""] });
      const padding = size - Buffer.byteLength(base);
      const body = JSON.stringify({ runId: f.run.runId, contractDigest: f.run.contractDigest, files: [],
        missing: ["é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2)] });
      expect(Buffer.byteLength(body)).toBe(size);
      expect(body.length).toBeLessThan(size);
      const before = f.h.cp.artifacts.list(f.run.runId);
      const result = await f.call("bootstrap_review_evidence_stage", { idempotencyKey: "byte-boundary", runId: f.run.runId,
        contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest, evidenceBody: body, expectedSha256: sha256(body) });
      expect(result).toMatchObject(size === 512 * 1024 ? { ok: true } : { ok: false, reasonCode: "INVALID_ARGUMENT" });
      if (size > 512 * 1024) expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(before);
    } finally { await f.close(); }
  });

  it.each([{ padding: "é", extra: 0 }, { padding: "x", extra: 0 }, { padding: "é", extra: 1 }])(
    "bounds Unicode-escaped evidence in a complete daemon frame ($padding, extra=$extra)", async ({ padding, extra }) => {
      const f = await stagingFixture();
      const socket = new Socket();
      socket.on("error", () => {});
      const replies = new Map<number, { result?: { structuredContent?: Args } }>();
      // Capture transport output while driving each entire input frame in one data event.
      socket._write = (chunk: Buffer, _encoding, callback) => {
        const reply = JSON.parse(chunk.toString("utf8"));
        replies.set(reply.id, reply);
        callback();
      };
      const session = f.h.cp.sessions.require(f.primary.sessionId);
      const server = createCtoServer(createCtoMcpPort(f.h.cp), () => allow(ReasonCode.OK, { actor: session.sessionId,
        sessionId: session.sessionId, sessionIncarnation: session.incarnation,
        binding: { roleKey: f.primary.roleKey, bindingGeneration: f.primary.generation } }));
      const errors: Error[] = [];
      server.server.onerror = error => errors.push(error);
      try {
        expect(await f.attach()).toMatchObject({ ok: true });
        const opening = authenticateSocket(socket, "fixture-token", 1000);
        socket.emit("data", Buffer.from(JSON.stringify({ token: "fixture-token", sessionId: session.sessionId, sessionSecret: "fixture-secret" }) + "\n"));
        const accepted = await opening;
        expect(accepted).not.toBeNull();
        await server.connect(accepted!.transport);
        socket.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "unicode-frames", version: "1" } } }) + "\n"));
        await vi.waitFor(() => expect(replies.has(1)).toBe(true));
        const bundle = { runId: f.run.runId, contractDigest: f.run.contractDigest, files: [], missing: [""] };
        const remaining = 512 * 1024 + extra - Buffer.byteLength(JSON.stringify(bundle));
        bundle.missing[0] = padding.repeat(Math.floor(remaining / Buffer.byteLength(padding))) + "x".repeat(remaining % Buffer.byteLength(padding));
        const evidenceBody = JSON.stringify(bundle);
        expect(Buffer.byteLength(evidenceBody)).toBe(512 * 1024 + extra);
        const frame = unicodeEscapedJson({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "bootstrap_review_evidence_stage", arguments: { idempotencyKey: "complete-unicode-frame", runId: f.run.runId,
            contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest, evidenceBody, expectedSha256: sha256(evidenceBody) } } });
        expect(Buffer.byteLength(frame)).toBeGreaterThan(1024 * 1024 + 1024);
        socket.emit("data", Buffer.from(frame + "\n"));
        await vi.waitFor(() => {
          expect(errors).toEqual([]);
          expect(replies.get(2)?.result?.structuredContent).toMatchObject(extra === 0
            ? { ok: true, value: { digest: sha256(evidenceBody) } } : { ok: false, reasonCode: "INVALID_ARGUMENT" });
        });
        const candidate = f.h.cp.artifacts.list<{ schema: string; bodyBase64: string }>(f.run.runId, "HANDOFF")
          .find(a => a.content.schema === "acp.bootstrap-review-evidence-candidate.v1");
        if (extra === 0) expect(Buffer.from(candidate!.content.bodyBase64, "base64").equals(Buffer.from(evidenceBody))).toBe(true);
        else expect(candidate).toBeUndefined();
      } finally { await server.close(); socket.destroy(); await f.close(); }
    });

  it("keeps the PLAN byte limit at 128 KiB plus one on staging and attachment", async () => {
    const f = await stagingFixture();
    try {
      const value = JSON.parse(f.body);
      const padding = 128 * 1024 + 1 - Buffer.byteLength(JSON.stringify(value));
      value.plan.summary += "é".repeat(Math.floor(padding / 2)) + " ".repeat(padding % 2);
      const planBody = JSON.stringify(value);
      expect(Buffer.byteLength(planBody)).toBe(128 * 1024 + 1);
      const args = { planBody, expectedSha256: sha256(planBody) };
      expect(await f.stage(args)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
      expect(await f.attach(args)).toMatchObject({ ok: false, reasonCode: "INVALID_ARGUMENT" });
    } finally { await f.close(); }
  });

  it("delivers large original files whole through staging, attachment, freeze and the actual reviewer packet", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const originals = ["correction.log", "review.txt", "deployment.log"].map(path => ({ path,
        text: `${path}: failure\n` + "é original result\n".repeat(4000) + `${path}: fix and result END\n` }));
      const bundle = { runId: f.run.runId, contractDigest: f.run.contractDigest, missing: [], files: originals.map(({ path, text }) => ({
        path, origin: "original records", grade: "execution-log", sha256: sha256(text), bodyBase64: Buffer.from(text).toString("base64") })) };
      const evidenceBody = JSON.stringify(bundle);
      expect(Buffer.byteLength(evidenceBody)).toBeGreaterThan(128 * 1024);
      expect(Buffer.byteLength(evidenceBody)).toBeLessThanOrEqual(512 * 1024);
      const args = { runId: f.run.runId, contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest, expectedSha256: sha256(evidenceBody) };
      expect(await f.call("bootstrap_review_evidence_stage", { ...args, idempotencyKey: "large-originals", evidenceBody })).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_evidence_attach", { ...args, idempotencyKey: "attach-large-originals", stagedBy: f.primary.roleKey })).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "freeze-large-originals", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      const plan = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
      expect(frozenBootstrapReviewEvidence(f.h.cp, f.run.runId, plan.content)?.bundle).toEqual(bundle);
      const verify = vi.fn(async (file: { path: string }) => ({ status: "ACP-verified" as const, reason: "fixture observation",
        facts: [{ path: file.path, response: `${file.path}:` + "f".repeat(180 * 1024) + ":FACT-END" }] }));
      f.h.cp.review.attach({ verifyOriginalRecord: verify });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await f.cto("result_submit", { idempotencyKey: "review-large-originals", runId: f.run.runId,
        resultSummary: "review", recommendation: "review" })).toMatchObject({ ok: true });
      const prompt = f.h.scripted.invocations.find(i => /Bootstrap plan review/.test(i.prompt))!.prompt;
      for (const original of originals) expect(prompt.includes(original.text), original.path).toBe(true);
      for (const original of originals.slice(0, 2)) expect(prompt.includes(`${original.path}:` + "f".repeat(180 * 1024) + ":FACT-END")).toBe(true);
      expect(prompt).toContain("ACP API facts exceed the 512 KiB review evidence observation bound");
      expect(verify).toHaveBeenCalledTimes(3);
    } finally { await f.close(); }
  });

  it("admits only current PRIMARY_CTO staging and CEO selection; freezes the selected originals", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const text = "failure: original failed\nfix: original fix\nresult: original passed\n";
      const originalSha256 = sha256("full original file retained by collector");
      const bundle = { runId: f.run.runId, contractDigest: f.run.contractDigest, files: [{ path: "execution.log", sha256: sha256(text),
        origin: "original execution stdout; explicit excerpt", grade: "execution-log", bodyBase64: Buffer.from(text).toString("base64"),
        excerpt: { originalSha256, omitted: true, ranges: [{ section: "failure", startLine: 2, endLine: 4 },
          { section: "fix", startLine: 20, endLine: 25 }, { section: "result", startLine: 40, endLine: 42 }] } }],
        missing: ["#58 raw RED/GREEN", "#60 raw RED/GREEN", "#59 raw output"] };
      const body = JSON.stringify(bundle);
      const args = { idempotencyKey: "originals", runId: f.run.runId, contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest, evidenceBody: body, expectedSha256: sha256(body) };
      expect(await f.cto("bootstrap_review_evidence_stage", args)).toMatchObject({ ok: false });
      const stale = await f.connect("cto", f.primary.sessionId, true, "complete", f.h.cp, { roleKey: f.primary.roleKey, bindingGeneration: f.primary.generation + 1 });
      expect(await stale("bootstrap_review_evidence_stage", args)).toMatchObject({ ok: false });
      expect(await f.call("bootstrap_review_evidence_stage", args)).toMatchObject({ ok: true });
      expect(await f.call("bootstrap_review_evidence_stage", args)).toMatchObject({ ok: true });
      const select = { ...args, idempotencyKey: "select-originals", evidenceBody: undefined, stagedBy: f.primary.roleKey };
      const notCeo = await f.connect("hermes", f.primary.sessionId);
      expect(await notCeo("bootstrap_review_evidence_attach", select)).toMatchObject({ ok: false });
      expect(await f.hermes("bootstrap_review_evidence_attach", { ...select, idempotencyKey: "wrong-slot", stagedBy: "PRIMARY_CTO:other" })).toMatchObject({ ok: false });
      expect(await f.hermes("bootstrap_review_evidence_attach", { ...select, idempotencyKey: "wrong-digest", expectedSha256: sha256("other") })).toMatchObject({ ok: false });
      const attached = await f.hermes("bootstrap_review_evidence_attach", select);
      expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "frozen-originals", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
      const frozen = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
      expect(frozen.content.reviewEvidence).toMatchObject({ source: { bootstrapPlanDigest: f.digest, stagedBy: f.primary.roleKey, attachedBySessionId: f.ceo } });
      expect(frozen.content.reviewEvidence).not.toHaveProperty("bundle");
      const privateCandidate = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")
        .find(a => a.digest === (frozen.content.reviewEvidence as FrozenReviewEvidenceReference).source.candidateDigest)!;
      expect(JSON.parse(Buffer.from(privateCandidate.content.bodyBase64 as string, "base64").toString("utf8"))).toEqual(bundle);
      const nextBody = JSON.stringify({ ...bundle, missing: [...bundle.missing, "later missing item"] });
      expect(await f.call("bootstrap_review_evidence_stage", { ...args, idempotencyKey: "later-originals", evidenceBody: nextBody, expectedSha256: sha256(nextBody) })).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_evidence_attach", { ...select, idempotencyKey: "later-attach", expectedSha256: sha256(nextBody), replacesSha256: sha256(body) })).toMatchObject({ ok: true });
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toEqual(frozen);
      const privateSource = { artifacts: f.h.cp.artifacts, audit: f.h.cp.audit };
      // Later CEO selection cannot change the originals addressed by the submitted PLAN.
      expect(frozenBootstrapReviewEvidence(privateSource, f.run.runId, frozen.content)?.bundle).toEqual(bundle);
      const reference = frozen.content.reviewEvidence as FrozenReviewEvidenceReference;
      expect(() => frozenBootstrapReviewEvidence(privateSource, f.run.runId, { ...frozen.content,
        reviewEvidence: { ...reference, source: { ...reference.source, candidateDigest: sha256("forged private reference") } } })).toThrow();
    } finally { await f.close(); }
  });

  describe("#1204 R2 boundary witnesses", () => {
    const evidenceFixture = async () => {
      const f = await stagingFixture();
      expect(await f.attach()).toMatchObject({ ok: true });
      const text = "original execution result\n";
      const bundle = { runId: f.run.runId, contractDigest: f.run.contractDigest, files: [{ path: "execution.log", sha256: sha256(text),
        origin: "execution stdout", grade: "execution-log", bodyBase64: Buffer.from(text).toString("base64") }], missing: [] };
      const body = JSON.stringify(bundle);
      const upload = { idempotencyKey: "boundary-stage", runId: f.run.runId, contractDigest: f.run.contractDigest,
        bootstrapPlanDigest: f.digest, evidenceBody: body, expectedSha256: sha256(body) };
      const select = { idempotencyKey: "boundary-attach", runId: f.run.runId, contractDigest: f.run.contractDigest,
        bootstrapPlanDigest: f.digest, stagedBy: f.primary.roleKey, expectedSha256: sha256(body) };
      const stageEvidence = (overrides: Args = {}) => f.call("bootstrap_review_evidence_stage", { ...upload, ...overrides });
      const attachEvidence = (overrides: Args = {}) => f.hermes("bootstrap_review_evidence_attach", { ...select, ...overrides });
      const effects = () => ({ artifacts: f.h.cp.artifacts.list(f.run.runId), run: f.h.cp.runs.require(f.run.runId),
        attached: f.h.cp.audit.forRun(f.run.runId).filter(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED") });
      return { ...f, bundle, bundleBody: body, upload, select, stageEvidence, attachEvidence, effects };
    };

    it("rolls back review evidence attachment and audit on denial, preserving the current selection and retry", async () => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        expect(await f.attachEvidence()).toMatchObject({ ok: true });
        const bodyB = JSON.stringify({ ...f.bundle, missing: ["replacement evidence"] });
        expect(await f.stageEvidence({ idempotencyKey: "rollback-stage-B", evidenceBody: bodyB, expectedSha256: sha256(bodyB) })).toMatchObject({ ok: true });
        const selectB = { idempotencyKey: "rollback-attach-B", expectedSha256: sha256(bodyB), replacesSha256: f.select.expectedSha256 };
        const before = f.effects();
        const auditBefore = f.h.cp.audit.forRun(f.run.runId);
        const record = f.h.cp.audit.record.bind(f.h.cp.audit);
        const refused = vi.spyOn(f.h.cp.audit, "record").mockImplementation(input => {
          const recorded = record(input);
          return input.kind === "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED"
            ? deny(ReasonCode.CONFLICT, "test denial after attachment and audit writes") : recorded;
        });
        try {
          expect(await f.attachEvidence(selectB)).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
          expect(f.effects()).toEqual(before);
          expect(f.h.cp.audit.forRun(f.run.runId)).toEqual(auditBefore);
        } finally { refused.mockRestore(); }
        expect(await f.attachEvidence({ ...selectB, idempotencyKey: "rollback-attach-B-retry" })).toMatchObject({ ok: true });
        const current = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")
          .filter(a => a.content.schema === "acp.bootstrap-review-evidence-attached.v1" && !a.superseded);
        expect(current).toHaveLength(1);
        expect(current[0]!.content.sha256).toBe(sha256(bodyB));
      } finally { await f.close(); }
    });

    it("ACP1204-R1-02 refuses A→B→A atomically and preserves current-B retries and submission", async () => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        expect(await f.attachEvidence()).toMatchObject({ ok: true });
        const bodyB = JSON.stringify({ ...f.bundle, missing: ["B: raw output unavailable"] });
        expect(await f.stageEvidence({ idempotencyKey: "stage-B", evidenceBody: bodyB, expectedSha256: sha256(bodyB) })).toMatchObject({ ok: true });
        const selectB = { idempotencyKey: "attach-B", expectedSha256: sha256(bodyB), replacesSha256: f.select.expectedSha256 };
        const attachedB = await f.attachEvidence(selectB);
        expect(attachedB).toMatchObject({ ok: true });
        const state = () => ({ ...f.effects(), audit: f.h.cp.audit.forRun(f.run.runId),
          messages: f.h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'"), outbox: f.h.cp.outbox.listByRun(f.run.runId) });
        const before = state();
        expect(await f.attachEvidence({ idempotencyKey: "reselect-A", replacesSha256: sha256(bodyB) })).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
        // Even the original cached A selection must not conceal its superseded status.
        expect(await f.attachEvidence()).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
        expect(state()).toEqual(before);
        const current = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF")
          .filter(a => a.content.schema === "acp.bootstrap-review-evidence-attached.v1" && !a.superseded);
        expect(current).toHaveLength(1);
        expect(current[0]!.content.sha256).toBe(sha256(bodyB));
        expect(await f.attachEvidence(selectB)).toEqual(attachedB);
        expect(state()).toEqual(before);
        expect(await f.attachEvidence({ ...selectB, idempotencyKey: "same-B-fresh-key" })).toMatchObject({ ok: true });
        expect(await f.cto("plan_submit", { idempotencyKey: "after-refused-reselection", runId: f.run.runId,
          bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
        expect(f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!.content.reviewEvidence).toMatchObject({ source: { bundleSha256: sha256(bodyB) } });
      } finally { await f.close(); }
    });

    it.each(["run", "baseline"])("ACP1204-R1-01 keeps private originals out of %s export and available to the reviewer", async kind => {
      const f = await evidenceFixture();
      try {
        const permitted = "PRIVATE_PERMITTED_EXECUTION_ORIGINAL: failure\nfix\nresult\n";
        const reasoning = "WITHHELD_AUTHOR_AND_CTO_REASONING: private implementer report\n";
        const bundle = { ...f.bundle, files: [
          { path: "execution.log", origin: "PRIVATE_EXECUTION_ORIGIN", grade: "execution-log", sha256: sha256(permitted), bodyBase64: Buffer.from(permitted).toString("base64") },
          { path: "WITHHELD_REASONING_PATH.txt", origin: "WITHHELD_REASONING_ORIGIN", grade: "implementer-final-report", sha256: sha256(reasoning), bodyBase64: Buffer.from(reasoning).toString("base64") },
        ] };
        const evidenceBody = JSON.stringify(bundle);
        expect(await f.stageEvidence({ evidenceBody, expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: true });
        expect(await f.attachEvidence({ expectedSha256: sha256(evidenceBody) })).toMatchObject({ ok: true });
        expect(await f.cto("plan_submit", { idempotencyKey: "export-private-plan", runId: f.run.runId, bootstrapPlanDigest: f.digest })).toMatchObject({ ok: true });
        const plan = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
        f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
        expect(await f.cto("result_submit", { idempotencyKey: "export-private-review", runId: f.run.runId,
          resultSummary: "review", recommendation: "review" })).toMatchObject({ ok: true });
        const prompt = f.h.scripted.invocations.find(i => /Bootstrap plan review/.test(i.prompt))!.prompt;
        expect(prompt).toContain(permitted.trim());
        expect(prompt).not.toContain(reasoning.trim());
        expect(prompt).not.toContain(Buffer.from(reasoning).toString("base64"));
        if (kind === "baseline") {
          // Export fixture only: baseline windows select completed runs. No activation is claimed.
          expect(f.h.cp.runs.transition(f.run.runId, RunState.COMPLETED, "baseline export fixture", {},
            f.h.cp.completionAuthoritiesForTests().bootstrapActivation).allowed).toBe(true);
        }
        const artifactsBefore = f.h.cp.artifacts.list(f.run.runId);
        const exporter = new RunEvidenceExporter(f.h.cp.db, f.h.cp.artifacts, f.h.clock, f.h.cp.audit);
        const result = kind === "run" ? exporter.exportRun(f.run.runId)
          : exporter.exportBaseline({ from: f.run.createdAt, to: f.h.clock.nowIso() });
        if (!result.allowed) throw new Error(result.message);
        const exported = "runs" in result.value ? result.value.runs.find(r => r.run.runId === f.run.runId)! : result.value;
        expect(exported).toBeDefined();
        const serialized = JSON.stringify(result.value);
        for (const text of [permitted, reasoning]) {
          expect(serialized).not.toContain(text.trim());
          expect(serialized).not.toContain(Buffer.from(text).toString("base64"));
        }
        for (const metadata of ["PRIVATE_EXECUTION_ORIGIN", "WITHHELD_REASONING_PATH", "WITHHELD_REASONING_ORIGIN"]) expect(serialized).not.toContain(metadata);
        const exportedPlan = exported.artifactManifest.artifacts.find(a => a.artifactId === plan.artifactId)!;
        // The exporter carries the certified PLAN unchanged, never a scrubbed replacement.
        expect(exportedPlan.digest).toBe(plan.digest);
        expect(exportedPlan.content).toEqual(plan.content);
        expect(artifactDigestMatches(plan)).toBe(true);
        expect(f.h.cp.artifacts.list(f.run.runId)).toEqual(artifactsBefore);
        // Pre-fix inline PLANs are immutable too: omit their whole content, never scrub it.
        const legacy = f.h.cp.artifacts.put(f.run.runId, "PLAN", { ...plan.content,
          reviewEvidence: frozenBootstrapReviewEvidence({ artifacts: f.h.cp.artifacts, audit: f.h.cp.audit }, f.run.runId, plan.content) });
        const legacyResult = kind === "run" ? exporter.exportRun(f.run.runId)
          : exporter.exportBaseline({ from: f.run.createdAt, to: f.h.clock.nowIso() });
        if (!legacyResult.allowed) throw new Error(legacyResult.message);
        const legacyRun = "runs" in legacyResult.value ? legacyResult.value.runs.find(r => r.run.runId === f.run.runId)! : legacyResult.value;
        expect(JSON.stringify(legacyResult.value)).not.toContain(Buffer.from(reasoning).toString("base64"));
        expect(JSON.stringify(legacyResult.value)).not.toContain(Buffer.from(permitted).toString("base64"));
        expect(legacyRun.artifactManifest.artifacts.find(a => a.artifactId === legacy.artifactId)).toMatchObject({ digest: legacy.digest });
        expect(legacyRun.artifactManifest.artifacts.find(a => a.artifactId === legacy.artifactId)).not.toHaveProperty("content");
        expect(legacyRun.artifactManifest.omittedFields).toContainEqual({ subject: "artifact", subjectId: legacy.artifactId,
          field: "content", reason: "PRIVATE_BULK_CONTENT", sourceDigest: legacy.digest });
        expect(f.h.cp.artifacts.list(f.run.runId).find(a => a.artifactId === legacy.artifactId)).toEqual(legacy);
      } finally { await f.close(); }
    });

    it("refuses staging against another attachment and another contract", async () => {
      const f = await evidenceFixture();
      try {
        for (const field of ["bootstrapPlanDigest", "contractDigest"]) {
          const before = f.effects();
          expect(await f.stageEvidence({ idempotencyKey: `wrong-${field}`, [field]: sha256("another binding") })).toMatchObject({ ok: false });
          expect(f.effects()).toEqual(before);
        }
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        for (const field of ["bootstrapPlanDigest", "contractDigest"]) {
          const before = f.effects();
          expect(await f.attachEvidence({ idempotencyKey: `attach-wrong-${field}`, [field]: sha256("another binding") })).toMatchObject({ ok: false });
          expect(f.effects()).toEqual(before);
        }
        expect(await f.attachEvidence()).toMatchObject({ ok: true });
      } finally { await f.close(); }
    });

    it.each([false, true])("refuses a replaced attachment on fresh and cached CEO attach (already attached=%s)", async alreadyAttached => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        if (alreadyAttached) expect(await f.attachEvidence()).toMatchObject({ ok: true });
        const replacement = JSON.parse(f.body); replacement.plan.summary = "replacement v5 attachment";
        const planBody = JSON.stringify(replacement);
        expect(await f.attach({ idempotencyKey: "replace-v5", planBody, expectedSha256: sha256(planBody), replacesSha256: f.digest })).toMatchObject({ ok: true });
        const before = f.effects();
        expect(await f.attachEvidence()).toMatchObject({ ok: false });
        expect(await f.attachEvidence({ idempotencyKey: "old-bundle-current-v5", bootstrapPlanDigest: sha256(planBody) })).toMatchObject({ ok: false });
        expect(f.effects()).toEqual(before);
        if (alreadyAttached) {
          expect(await f.cto("plan_submit", { idempotencyKey: "replaced-evidence-plan", runId: f.run.runId,
            bootstrapPlanDigest: sha256(planBody) })).toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
          expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toBeNull();
        }
        // An explicit new stage binds the same originals to the new attachment; there is no fallback.
        expect(await f.stageEvidence({ idempotencyKey: "new-v5-stage", bootstrapPlanDigest: sha256(planBody) })).toMatchObject({ ok: true });
        expect(await f.attachEvidence({ idempotencyKey: "new-v5-attach", bootstrapPlanDigest: sha256(planBody),
          ...(alreadyAttached ? { replacesSha256: f.select.expectedSha256 } : {}) })).toMatchObject({ ok: true });
        expect(await f.cto("plan_submit", { idempotencyKey: "rebound-evidence-plan", runId: f.run.runId,
          bootstrapPlanDigest: sha256(planBody) })).toMatchObject({ ok: true });
        expect(f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!.content.reviewEvidence).toMatchObject({
          source: { bootstrapPlanDigest: sha256(planBody) } });
      } finally { await f.close(); }
    });

    it("never selects a staged bundle from another run, even with its real digest and stager", async () => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        const created = f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: {
          goal: "another bootstrap", why: "run isolation", scope: [], nonGoals: [], priority: "NORMAL", humanGate: [], references: [], acceptance: ["isolated"] } });
        if (!created.allowed) throw new Error(created.message);
        const other = await dispatchBootstrapRun(f.h.cp, f.h.clock, created.value.runId);
        const input = JSON.parse(f.body); input.runId = other.runId;
        const planBody = JSON.stringify(input);
        expect(await f.attach({ idempotencyKey: "other-plan", runId: other.runId, contractDigest: other.contractDigest,
          planBody, expectedSha256: sha256(planBody) })).toMatchObject({ ok: true });
        const before = f.h.cp.artifacts.list(other.runId);
        expect(await f.attachEvidence({ idempotencyKey: "other-run-bundle", runId: other.runId, contractDigest: other.contractDigest,
          bootstrapPlanDigest: sha256(planBody) })).toMatchObject({ ok: false });
        expect(f.h.cp.artifacts.list(other.runId)).toEqual(before);
      } finally { await f.close(); }
    });

    it.each([false, true])("rejects changed staged bytes on fresh and cached CEO attach (already attached=%s)", async alreadyAttached => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        if (alreadyAttached) expect(await f.attachEvidence()).toMatchObject({ ok: true });
        const candidate = f.h.cp.artifacts.list<Args>(f.run.runId, "HANDOFF").find(a => a.content.schema === "acp.bootstrap-review-evidence-candidate.v1")!;
        const raw = new Database(f.h.cp.db.raw.name);
        try {
          raw.function("acp_evidence_write_authorized", () => 0);
          raw.exec("DROP TRIGGER run_artifacts_content_immutable");
          raw.prepare("UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?")
            .run(JSON.stringify({ ...candidate.content, bodyBase64: Buffer.from(f.bundleBody + "changed after staging").toString("base64") }), candidate.artifactId);
        } finally { raw.close(); }
        const before = f.effects();
        expect(await f.attachEvidence()).toMatchObject({ ok: false });
        expect(await f.attachEvidence({ idempotencyKey: "tampered-fresh-key" })).toMatchObject({ ok: false });
        expect(f.effects()).toEqual(before);
      } finally { await f.close(); }
    });

    it.each([false, true])("refuses stale owner authority at fresh and cached attach (already attached=%s)", async alreadyAttached => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        if (alreadyAttached) expect(await f.attachEvidence()).toMatchObject({ ok: true });
        expect(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "owner-generation witness").allowed).toBe(true);
        expect(f.h.cp.bindings.revoke(f.run.ownerRoleKey!, "owner-generation witness", { allowBlockedRuns: true }).allowed).toBe(true);
        expect(f.h.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: f.run.runId, sessionId: f.run.ownerSessionId! }).allowed).toBe(true);
        const before = f.effects();
        expect(await f.attachEvidence()).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
        expect(await f.attachEvidence({ idempotencyKey: "stale-owner-fresh" })).toMatchObject({ ok: false, reasonCode: "BINDING_GENERATION_STALE" });
        expect(f.effects()).toEqual(before);
      } finally { await f.close(); }
    });

    it.each(["replaced session", "revoked", "same session older generation"])("refuses %s CEO authority on fresh and cached attach", async scenario => {
      const f = await evidenceFixture();
      try {
        expect(await f.stageEvidence()).toMatchObject({ ok: true });
        const ceo = f.h.cp.bindings.active("CEO")!;
        const old = await f.connect("hermes", f.ceo, true, "complete", f.h.cp, { roleKey: "CEO", bindingGeneration: ceo.bindingGeneration });
        expect(await old("bootstrap_review_evidence_attach", f.select)).toMatchObject({ ok: true });
        expect(f.h.cp.bindings.revoke("CEO", "CEO authority witness").allowed).toBe(true);
        if (scenario !== "revoked") {
          const successor = scenario === "replaced session" ? f.h.cp.sessions.create({ provider: "scripted", model: "successor CEO" }).sessionId : f.ceo;
          if (successor !== f.ceo) f.h.cp.sessions.transition(successor, SessionLifecycle.READY, "successor CEO");
          expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: successor }).allowed).toBe(true);
        }
        const before = f.effects();
        expect(await old("bootstrap_review_evidence_attach", f.select)).toMatchObject({ ok: false });
        expect(await old("bootstrap_review_evidence_attach", { ...f.select, idempotencyKey: "stale-ceo-fresh" })).toMatchObject({ ok: false });
        expect(f.effects()).toEqual(before);
      } finally { await f.close(); }
    });
  });

  it("renders the actual reviewer packet and activation handoff with seven acceptance links", async () => {
    const f = await stagingFixture();
    try {
      const files = [
        { path: "rf/ci.json", grade: "github-api-original", origin: "GitHub Actions run 40079328307 JSON via gh api", text: '{"conclusion":"success","id":40079328307}\n' },
        { path: "rf/review.txt", grade: "review-original", origin: "codex review output", text: "REVISE: original independent review verdict\n" },
        { path: "rf/bridge.log", grade: "execution-log", origin: "bridge compile stdout and stderr", text: "failure: old binding\nfix: run-bound binding\nresult: compiled\n" },
        { path: "WITHHELD_AUTHOR_REASONING_PATH.txt", grade: "implementer-final-report", origin: "WITHHELD_CTO_REASONING_IN_METADATA", text: "WITHHELD_PRODUCER_SELF_ASSESSMENT\nWITHHELD_AUTHOR_REASONING\nWITHHELD_CTO_REASONING\n" },
      ];
      const bundle = { runId: f.run.runId, contractDigest: f.run.contractDigest,
        files: files.map(({ text, ...entry }) => ({ ...entry, sha256: sha256(text), bodyBase64: Buffer.from(text).toString("base64") })),
        missing: ["#58 raw RED/GREEN", "#60 raw RED/GREEN", "#59 raw output"] };
      const body = JSON.stringify(bundle);
      const input = JSON.parse(f.body);
      input.plan.genesis.issues = Array.from({ length: 7 }, (_, i) => ({ ...input.plan.genesis.issues[0],
        key: `i${i + 1}`, title: `Seeded issue ${i + 1}`, body: `Acceptance for issue ${i + 1}: https://example.test/issues/${i + 1}` }));
      delete input.plan.githubOperations;
      const normalized = planForSubmission(f.run, input.plan);
      if (!normalized.allowed) throw new Error(normalized.message);
      const planBody = JSON.stringify({ ...input, plan: normalized.value });
      const planDigest = sha256(planBody);
      f.h.cp.review.attach({ servingRuntimeEventId: recordBootstrapServingRuntime(f.h.cp.audit,
        new URL("../../src/daemon/agentcpd.ts", import.meta.url).href) });
      // The normal PLAN/RESUME/result doors render what the real blind reviewer receives.
      expect(await f.attach({ planBody, expectedSha256: planDigest })).toMatchObject({ ok: true });
      expect(await f.call("bootstrap_review_evidence_stage", { idempotencyKey: "evidence-stage", runId: f.run.runId,
        contractDigest: f.run.contractDigest, bootstrapPlanDigest: planDigest, evidenceBody: body, expectedSha256: sha256(body) })).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_evidence_attach", { idempotencyKey: "evidence-attach", runId: f.run.runId,
        contractDigest: f.run.contractDigest, bootstrapPlanDigest: planDigest, stagedBy: f.primary.roleKey, expectedSha256: sha256(body) })).toMatchObject({ ok: true });
      expect(await f.hermes("bootstrap_review_resume", { idempotencyKey: "render-release", runId: f.run.runId,
        contractDigest: f.run.contractDigest, bootstrapPlanDigest: planDigest, ownerSessionId: f.run.ownerSessionId,
        ownerSessionIncarnation: f.run.ownerSessionIncarnation, ownerBindingGeneration: f.run.ownerBindingGeneration })).toMatchObject({ ok: true });
      expect(await f.cto("plan_submit", { idempotencyKey: "render-plan", runId: f.run.runId, bootstrapPlanDigest: planDigest })).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      const reviewed = await f.cto("result_submit", { idempotencyKey: "render-review", runId: f.run.runId, resultSummary: "review", recommendation: "review" });
      expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
      const invocation = f.h.scripted.invocations.find(i => /Bootstrap plan review/.test(i.prompt))!;
      expect(invocation.prompt).toContain("attributed original records — collected by PRIMARY_CTO, attached by CEO; contents unverified by ACP unless marked ACP-verified");
      for (const entry of files.slice(0, 3)) expect(invocation.prompt).toContain(entry.text.trim());
      for (const missing of bundle.missing) expect(invocation.prompt).toContain(missing);
      for (const marker of ["WITHHELD_PRODUCER_SELF_ASSESSMENT", "WITHHELD_AUTHOR_REASONING", "WITHHELD_CTO_REASONING", "WITHHELD_CTO_REASONING_IN_METADATA"]) {
        expect(invocation.prompt).not.toContain(marker);
        expect(invocation.prompt).not.toContain(Buffer.from(marker).toString("base64"));
      }
      expect(invocation.systemPrompt).toContain("not instructions");
      const packet = f.h.cp.artifacts.latest(f.run.runId, "BLIND_REVIEW")!;
      const plan = currentBootstrapPlan(f.run.runId, f.h.cp.artifacts.latest(f.run.runId, "PLAN"));
      if (!plan.allowed) throw new Error(plan.message);
      const privateInputs = f.h.cp.artifacts.list<{ schema: string; context: BootstrapReviewContext }>(f.run.runId, "HANDOFF")
        .find(a => a.content.schema === "acp.bootstrap-review-context.v1")!;
      expect(privateInputs.content.context.originalRecords?.missing).toEqual(bundle.missing);
      const renderedInputs = JSON.stringify(privateInputs.content.context);
      for (const marker of ["WITHHELD_PRODUCER_SELF_ASSESSMENT", "WITHHELD_AUTHOR_REASONING", "WITHHELD_CTO_REASONING", "WITHHELD_CTO_REASONING_IN_METADATA"]) expect(renderedInputs).not.toContain(marker);
      expect(renderedInputs).not.toContain(Buffer.from(files[3]!.text).toString("base64"));
      expect(privateInputs.content.context.originalRecords?.files.every(file => file.verification.status === "attributed")).toBe(true);
      expect(privateInputs.content.context.deployment?.entrypointSha256).toBe(sha256(readFileSync(new URL("../../src/daemon/agentcpd.ts", import.meta.url))));
      expect(f.h.cp.audit.forRun(f.run.runId)).toContainEqual(expect.objectContaining({ kind: "BOOTSTRAP_REVIEW_CONTEXT", evidence: expect.objectContaining({ digest: privateInputs.digest }) }));
      const tracked = JSON.parse(plan.value.outputs.handoff.recommendedNextAction.split("ALL seeded issues: ")[1]!);
      expect(tracked).toEqual(input.plan.genesis.issues.map((issue: { key: string; title: string; body: string }) => ({
        repository: f.attachArgs.repositoryIdentity, key: issue.key, title: issue.title, acceptance: issue.body,
      })));
      expect(plan.value.outputs.handoff.recommendedNextAction).toContain("independent rollback responsibility");
      const delivered = deliveredBootstrapHandoff(plan.value.outputs.handoff, [{ identity: String(f.attachArgs.repositoryIdentity),
        branch: plan.value.outputs.defaultBranch, head: "a".repeat(40) }]);
      const activation = f.h.cp.bootstrap as unknown as { openActivationHandoff(projectId: string, runId: string, toSessionId: string,
        handoff: typeof delivered): Decision<{ handoffId: string }> };
      const opened = activation.openActivationHandoff(f.primary.projectId, f.run.runId, f.primary.sessionId, delivered);
      if (!opened.allowed) throw new Error(opened.message);
      const actual = f.h.cp.artifacts.list<{ handoffId: string; handoff: typeof delivered }>(f.run.runId, "HANDOFF")
        .find(a => a.content.handoffId === opened.value.handoffId)!.content.handoff;
      // Compare the actual activation payload with the reviewer-visible planned responsibility.
      expect(actual.recommendedNextAction).toBe(plan.value.outputs.handoff.recommendedNextAction);
      expect(actual.recentDecisions).toEqual(plan.value.outputs.handoff.recentDecisions);
      const renderDir = process.env["ACP_REVIEW_RENDER_DIR"];
      if (renderDir) {
        mkdirSync(renderDir, { recursive: true });
        writeFileSync(join(renderDir, "plan-review.txt"), invocation.systemPrompt + "\n\n" + invocation.prompt);
        writeFileSync(join(renderDir, "packet.json"), JSON.stringify({ verdictPacket: packet.content, privateInputs: privateInputs.content }, null, 2));
        writeFileSync(join(renderDir, "activation-handoff.json"), JSON.stringify(actual, null, 2));
        expect(readFileSync(join(renderDir, "activation-handoff.json"), "utf8")).toContain("EVERY seeded issue's acceptance");
      }
    } finally { await f.close(); }
  });
});

describe("live run_3884d4fc: a bootstrap PLAN is reviewed only while it carries the run's attached evidence and admitted CEO decisions", () => {
  type Staged = Awaited<ReturnType<typeof stagingFixture>>;
  const evidence = (f: Staged, label: string) => {
    const text = `failure: ${label} original\nfix: ${label} fix\nresult: ${label} passed\n`;
    const bundle = { runId: f.run.runId, contractDigest: f.run.contractDigest, missing: [`${label} missing item`],
      files: [{ path: `${label}/execution.log`, origin: `${label} execution stdout`, grade: "execution-log",
        sha256: sha256(text), bodyBase64: Buffer.from(text).toString("base64") }] };
    const body = JSON.stringify(bundle);
    return { text, bundle, body, sha: sha256(body) };
  };
  const stageAndAttach = async (f: Staged, e: ReturnType<typeof evidence>, key: string, replacesSha256?: string) => {
    const args = { runId: f.run.runId, contractDigest: f.run.contractDigest, bootstrapPlanDigest: f.digest, expectedSha256: e.sha };
    expect(await f.call("bootstrap_review_evidence_stage", { ...args, idempotencyKey: `${key}-stage`, evidenceBody: e.body })).toMatchObject({ ok: true });
    expect(await f.hermes("bootstrap_review_evidence_attach", { ...args, idempotencyKey: `${key}-attach`, stagedBy: f.primary.roleKey,
      ...(replacesSha256 === undefined ? {} : { replacesSha256 }) })).toMatchObject({ ok: true });
  };
  const planSubmit = (f: Staged, idempotencyKey: string) => f.cto("plan_submit", { idempotencyKey, runId: f.run.runId, bootstrapPlanDigest: f.digest });
  const resultSubmit = (f: Staged, idempotencyKey: string) => f.cto("result_submit", { idempotencyKey, runId: f.run.runId, resultSummary: "review", recommendation: "review" });
  const resolveEscalation = async (f: Staged, resolution: string) => {
    expect(await f.cto("escalation_open", { idempotencyKey: `open-${resolution.length}`, runId: f.run.runId, question: "Which records does the reviewer judge?",
      options: ["attach originals"], ctoRecommendation: "attach originals", whyItMatters: "reviewer provenance", blocksCriticalPath: true })).toMatchObject({ ok: true });
    expect(await f.hermes("escalation_resolve", { idempotencyKey: `resolve-${resolution.length}`, runId: f.run.runId,
      escalationId: f.h.cp.ceo.openEscalationOf(f.run.runId)!.escalationId, resolution })).toMatchObject({ ok: true });
    expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
  };
  const reviews = (f: Staged) => f.h.scripted.invocations.filter(i => /Bootstrap plan review/.test(i.prompt));
  // What a refusal must leave untouched: nothing frozen, promoted or reviewed.
  const effects = (f: Staged) => ({ plans: f.h.cp.artifacts.list(f.run.runId, "PLAN"), candidate: f.h.cp.runs.currentCandidate(f.run.runId),
    snapshots: f.h.cp.artifacts.list(f.run.runId, "CANDIDATE_SNAPSHOT"), blindReviews: f.h.cp.artifacts.list(f.run.runId, "BLIND_REVIEW"),
    frozen: f.h.cp.audit.forRun(f.run.runId).filter(a => a.kind === "CANDIDATE_FROZEN"), tasks: f.h.cp.tasks.list(f.run.runId),
    run: f.h.cp.runs.require(f.run.runId), invocations: reviews(f).length });
  const decisionSection = (prompt: string) =>
    JSON.parse(prompt.split("## Authenticated CEO decisions (ACP records)")[1]!.split("```json\n")[1]!.split("\n```")[0]!) as unknown;

  it("admits review unchanged when the run holds no attachment and no decision its PLAN lacks", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await planSubmit(f, "plain-plan")).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await resultSubmit(f, "plain-result")).toMatchObject({ ok: true });
      expect(reviews(f)).toHaveLength(1);
      expect(f.h.cp.artifacts.latest<Args>(f.run.runId, "BLIND_REVIEW")?.content).toMatchObject({ verdict: "PASS" });
    } finally { await f.close(); }
  });

  it("refuses the PLAN submitted before evidence and an escalation resolution, keeps a same-key replay refused, and reviews a fresh-key PLAN with both", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const first = await planSubmit(f, "plan-before-evidence");
      expect(first).toMatchObject({ ok: true });
      const earlier = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
      expect(earlier.content).not.toHaveProperty("reviewEvidence");
      expect(earlier.content).not.toHaveProperty("authenticatedCeoDecisions");
      // After the PLAN: the CEO resolves a blocking escalation, attaches review evidence and releases review.
      const resolution = "Attach the original review records; the reviewer judges the originals, not a summary.";
      await resolveEscalation(f, resolution);
      const e = evidence(f, "attached-after-plan");
      await stageAndAttach(f, e, "late");
      expect(await f.hermes("bootstrap_review_resume", { idempotencyKey: "resume", runId: f.run.runId, contractDigest: f.run.contractDigest,
        bootstrapPlanDigest: f.digest, ownerSessionId: f.run.ownerSessionId, ownerSessionIncarnation: f.run.ownerSessionIncarnation,
        ownerBindingGeneration: f.run.ownerBindingGeneration })).toMatchObject({ ok: true });
      const release = f.h.cp.outbox.listByRun(f.run.runId).find(m => m.kind === "RESUME_REVIEW")!;
      expect(String((release.payload as Args)["directive"])).toContain("plan_submit with a NEW idempotencyKey");
      const decisions = collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId);
      expect(decisions.map(d => d.source.kind)).toEqual(["ACP_CEO_ESCALATION_REPLY", "ACP_CEO_REVIEW_ENTRY_RELEASE"]);
      const escalation = decisions[0]!;
      expect(escalation.resolution).toBe(resolution);

      // The CTO resubmits under its first key: the cached result replays, no PLAN and no task graph is written.
      const graphs = () => f.h.cp.audit.forRun(f.run.runId).filter(a => a.kind === "TASK_GRAPH_SUBMITTED").length;
      const graphsBefore = graphs();
      expect(await planSubmit(f, "plan-before-evidence")).toEqual(first);
      expect(f.h.cp.artifacts.latest(f.run.runId, "PLAN")).toEqual(earlier);
      expect(graphs()).toBe(graphsBefore);
      const before = effects(f);
      const refused = await resultSubmit(f, "result-after-replay");
      expect(refused).toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN", evidence: {
        refusal: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN", planDigest: earlier.digest, bootstrapPlanDigest: f.digest,
        unfrozenReviewEvidenceAttachment: expect.stringMatching(/^sha256:/),
        unfrozenCeoDecisionEvents: decisions.map(d => d.source.decisionEventId) } });
      expect(refused["message"]).toContain("plan_submit again with the same bootstrapPlanDigest and a NEW idempotencyKey");
      expect(refused["message"]).toContain("then result_submit");
      expect(effects(f)).toEqual(before);
      expect(reviews(f)).toHaveLength(0);

      // A fresh key freezes the attachment and every admitted decision, and only then is the PLAN reviewed.
      expect(await planSubmit(f, "plan-fresh-key")).toMatchObject({ ok: true, value: { digest: f.digest } });
      const fresh = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
      expect(fresh.digest).not.toBe(earlier.digest);
      expect(fresh.content["authenticatedCeoDecisions"]).toEqual(decisions);
      expect(frozenBootstrapReviewEvidence(f.h.cp, f.run.runId, fresh.content)?.bundle).toEqual(e.bundle);
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      const reviewed = await resultSubmit(f, "result-fresh-key");
      expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
      expect(reviews(f)).toHaveLength(1);
      const prompt = reviews(f)[0]!.prompt;
      expect(prompt).toContain(e.text.trim());
      expect(prompt).toContain(e.bundle.files[0]!.path);
      expect(prompt).toContain(e.bundle.files[0]!.origin);
      expect(prompt).toContain(resolution);
      expect(decisionSection(prompt)).toEqual(decisions);
      const privateInputs = f.h.cp.artifacts.list<{ schema: string; context: BootstrapReviewContext }>(f.run.runId, "HANDOFF")
        .find(a => a.content.schema === "acp.bootstrap-review-context.v1")!;
      expect(privateInputs.content.context.originalRecords?.files).toEqual([expect.objectContaining({
        path: e.bundle.files[0]!.path, origin: e.bundle.files[0]!.origin, sha256: e.bundle.files[0]!.sha256 })]);
      expect(privateInputs.content.context.originalRecords?.missing).toEqual(e.bundle.missing);

      // The resident CTO's activation handoff carries the decision admitted after the first PLAN.
      const plan = currentBootstrapPlan(f.run.runId, f.h.cp.artifacts.latest(f.run.runId, "PLAN"));
      if (!plan.allowed) throw new Error(plan.message);
      const delivered = deliveredBootstrapHandoff(plan.value.outputs.handoff, [{ identity: String(f.attachArgs.repositoryIdentity),
        branch: plan.value.outputs.defaultBranch, head: "a".repeat(40) }]);
      const activation = f.h.cp.bootstrap as unknown as { openActivationHandoff(projectId: string, runId: string, toSessionId: string,
        handoff: typeof delivered): Decision<{ handoffId: string }> };
      const opened = activation.openActivationHandoff(f.primary.projectId, f.run.runId, f.primary.sessionId, delivered);
      if (!opened.allowed) throw new Error(opened.message);
      const actual = f.h.cp.artifacts.list<{ handoffId: string; handoff: typeof delivered }>(f.run.runId, "HANDOFF")
        .find(a => a.content.handoffId === opened.value.handoffId)!.content.handoff;
      expect(actual.recentDecisions).toContain(JSON.stringify({ authenticatedCeoDecision: escalation }));
      expect(actual.recentDecisions.filter(d => d.includes(resolution))).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("refuses a PLAN that lacks only a CEO decision admitted after it, until a fresh-key plan_submit freezes it", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await planSubmit(f, "decision-plan")).toMatchObject({ ok: true });
      const resolution = "Keep the single repository create; nothing else changes.";
      await resolveEscalation(f, resolution);
      const [decision] = collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId);
      const before = effects(f);
      expect(await resultSubmit(f, "decision-result-refused")).toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN",
        evidence: { unfrozenReviewEvidenceAttachment: null, unfrozenCeoDecisionEvents: [decision!.source.decisionEventId] } });
      expect(effects(f)).toEqual(before);
      expect(await planSubmit(f, "decision-plan-fresh")).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await resultSubmit(f, "decision-result")).toMatchObject({ ok: true });
      expect(decisionSection(reviews(f)[0]!.prompt)).toEqual([decision]);
      const plan = currentBootstrapPlan(f.run.runId, f.h.cp.artifacts.latest(f.run.runId, "PLAN"));
      if (!plan.allowed) throw new Error(plan.message);
      expect(plan.value.outputs.handoff.recentDecisions).toContain(JSON.stringify({ authenticatedCeoDecision: decision }));
    } finally { await f.close(); }
  });

  it("refuses a PLAN that froze evidence the CEO has since replaced, and reviews only the replacement after a fresh-key plan_submit", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      const a = evidence(f, "selection-A");
      await stageAndAttach(f, a, "A");
      expect(await planSubmit(f, "plan-A")).toMatchObject({ ok: true });
      const planA = f.h.cp.artifacts.latest<Args>(f.run.runId, "PLAN")!;
      expect(frozenBootstrapReviewEvidence(f.h.cp, f.run.runId, planA.content)?.bundle).toEqual(a.bundle);
      const b = evidence(f, "selection-B");
      await stageAndAttach(f, b, "B", a.sha);
      expect(collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId)).toEqual([]);
      const before = effects(f);
      expect(await resultSubmit(f, "result-A")).toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN",
        evidence: { planDigest: planA.digest, unfrozenReviewEvidenceAttachment: expect.stringMatching(/^sha256:/), unfrozenCeoDecisionEvents: [] } });
      expect(effects(f)).toEqual(before);
      expect(await planSubmit(f, "plan-B")).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await resultSubmit(f, "result-B")).toMatchObject({ ok: true });
      const prompt = reviews(f)[0]!.prompt;
      expect(prompt).toContain(b.text.trim());
      expect(prompt).not.toContain(a.text.trim());
    } finally { await f.close(); }
  });

  it("still refuses evidence that names a replaced PLAN input, with nothing frozen or reviewed", async () => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      await stageAndAttach(f, evidence(f, "first-input"), "first-input");
      expect(await planSubmit(f, "plan-first-input")).toMatchObject({ ok: true });
      const replacement = JSON.parse(f.body); replacement.plan.summary = "replacement PLAN input";
      const planBody = JSON.stringify(replacement);
      expect(await f.attach({ idempotencyKey: "replace-input", planBody, expectedSha256: sha256(planBody), replacesSha256: f.digest })).toMatchObject({ ok: true });
      const before = effects(f);
      expect(await f.cto("plan_submit", { idempotencyKey: "plan-replaced-input", runId: f.run.runId, bootstrapPlanDigest: sha256(planBody) }))
        .toMatchObject({ ok: false, reasonCode: "SNAPSHOT_DIGEST_MISMATCH" });
      expect(await resultSubmit(f, "result-replaced-input")).toMatchObject({ ok: false });
      expect(effects(f)).toEqual(before);
      expect(reviews(f)).toHaveLength(0);
    } finally { await f.close(); }
  });

  // Review of 51a21441 — authority that arrives while the reviewer is answering. Holds the next
  // bootstrap-plan reviewer invocation until released; the answer is the scripted one, only its timing is the test's.
  const holdNextReview = (f: Staged) => {
    const scripted = f.h.scripted;
    const original = scripted.invoke.bind(scripted);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let held = false;
    vi.spyOn(scripted, "invoke").mockImplementation(async request => {
      if (!held && /Bootstrap plan review/.test(request.prompt)) { held = true; enter(); await released; }
      return original(request);
    });
    return { entered, release };
  };

  it.each(["PASS", "REVISE"] as const)("makes a %s stale when evidence is attached and an escalation resolved while the reviewer is answering", async verdict => {
    const f = await stagingFixture();
    try {
      expect(await f.attach()).toMatchObject({ ok: true });
      expect(await planSubmit(f, "mid-review-plan")).toMatchObject({ ok: true });
      const keys = bootstrapCoverageKeys(f.h, f.run.runId);
      f.h.scripted.script({ match: /Bootstrap plan review/, text: verdict === "PASS" ? reviewerPass(keys) : reviewerRevise(keys, "judged without the attached records") });
      const held = holdNextReview(f);
      const pending = resultSubmit(f, "mid-review-result");
      await held.entered;
      const candidate = f.h.cp.runs.currentCandidate(f.run.runId);
      expect(candidate).not.toBeNull();
      // While the reviewer answers: the CEO resolves a blocking escalation and attaches review evidence, over MCP.
      const resolution = "Judge the attached originals before anything else.";
      await resolveEscalation(f, resolution);
      const e = evidence(f, "attached-mid-review");
      await stageAndAttach(f, e, "mid-review");
      held.release();
      const submitted = await pending;
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true,
        value: { stage: "CANDIDATE_STALE", reasonCode: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN", snapshotDigest: candidate } });
      // Review of 2bf6f98c — the same answer carries what to do next, and which authority is unfrozen.
      const detail = (submitted["value"] as { detail?: { message: string; evidence: Args } }).detail;
      expect(detail?.message).toContain("plan_submit again with the same bootstrapPlanDigest and a NEW idempotencyKey");
      expect(detail?.message).toContain("then result_submit");
      expect(detail?.evidence).toMatchObject({ refusal: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN", bootstrapPlanDigest: f.digest,
        unfrozenReviewEvidenceAttachment: expect.stringMatching(/^sha256:/),
        unfrozenCeoDecisionEvents: collectBootstrapCeoDecisions(f.h.cp.db, f.run.runId).map(d => d.source.decisionEventId) });
      const judged = reviews(f)[0]!.prompt;
      expect(judged).not.toContain(e.text.trim());
      expect(judged).not.toContain(resolution);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("ACTIVE");
      expect(f.h.cp.artifacts.list(f.run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
      expect(f.h.cp.outbox.listByRun(f.run.runId).filter(m => m.kind === "REVISION_REQUEST")).toEqual([]);
      expect(f.h.cp.audit.forRun(f.run.runId).filter(a => a.kind === "BLIND_REVIEW_UNAVAILABLE")).toEqual([]);
      // The next result_submit is refused at entry with the instruction; a fresh-key PLAN is reviewed with both.
      expect(await resultSubmit(f, "mid-review-result-again")).toMatchObject({ ok: false, reasonCode: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN" });
      expect(await planSubmit(f, "mid-review-plan-fresh")).toMatchObject({ ok: true });
      f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, f.run.runId)) });
      expect(await resultSubmit(f, "mid-review-result-fresh")).toMatchObject({ ok: true });
      const fresh = reviews(f).at(-1)!.prompt;
      expect(fresh).toContain(e.text.trim());
      expect(fresh).toContain(resolution);
      expect(f.h.cp.runs.require(f.run.runId).state).toBe("READY_FOR_CEO_REVIEW");
    } finally { vi.restoreAllMocks(); await f.close(); }
  });
});
