import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { allow, deny } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, Role, RunState, RunKind } from "../../src/domain/types.ts";
import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { idempotentMcpMutation, ok, type McpMutationRequest } from "../../src/mcp/shared.ts";
import { isMcpReservationInFlight } from "../../src/ingress/ingress-guard.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, seedRun, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, bootstrapCtoProvider, dispatchBootstrapRun, makeHarness, reviewerPass, type Harness } from "../helpers/harness.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { genesisPlanFixture } from "../helpers/genesis-github.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";
import { bootstrapCoverageKeys, reviewBootstrapPlan, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());
type Args = Record<string, unknown>;
const contract = { goal: "first", why: "review", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] };
const tasks = [{ key: "a", title: "first task", category: "implementation" as const, dependsOn: [], spec: {} }];
const handoff = { projectStatus: "first", activeManifestDigest: null, recentDecisions: [], openBlockers: [], queuedWork: [], repositoryFacts: [], knownRisks: [], recommendedNextAction: "continue" };

async function hermes(h: Harness, sessionId: string, name: string, args: Args, provenance: Args = {}) {
  const lineage = digestOf("review lineage");
  const server = createHermesServer(createHermesMcpPort(h.cp), () => allow(ReasonCode.OK, {
    actor: sessionId, sessionId, sessionIncarnation: h.cp.sessions.require(sessionId).incarnation,
  }), { provenance: { liveHermesSessionId: "review-head", lineageRootDigest: lineage } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "idem-sibling-review", version: "1" });
  await client.connect(ct);
  try {
    const result = await client.callTool({ name, arguments: args, _meta: {
      [HERMES_PROVENANCE_META_KEY]: { principal: "owner", session_id: "review-head", lineage_root_digest: lineage, cron: false, delegation_depth: 0, ...provenance },
    } });
    return result.structuredContent as Args;
  } finally { await client.close(); await server.close(); }
}

type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const h = makeHarness();
  const run = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath, claim: false });
  const ceo = bindCeo(h);
  const peer = { sessionId: run.sessionId, incarnation: "inc-1" };
  return { h, run, ceo, peer };
}
function value<T>(d: { allowed: boolean; value?: T; message?: string }): T {
  if (!d.allowed) throw new Error(d.message);
  return d.value!;
}
function enqueue(f: Fixture, key: string) {
  const row = value(f.h.cp.outbox.enqueue({ idempotencyKey: key, roleKey: f.run.roleKey,
    bindingGeneration: 1, targetSessionId: f.run.sessionId, runId: f.run.runId,
    kind: MessageKind.RUN_DISPATCH, payload: { runId: f.run.runId } }));
  // A local fixture of a transport-accepted row; no transport is invoked.
  f.h.cp.db.run("UPDATE outbox SET status = 'SENT' WHERE message_id = ?", [row.messageId]);
  return row.messageId;
}

interface Case {
  name: string; server: "cto" | "hermes";
  setup(f: Fixture): { first: Args; changed: Args; spy: ReturnType<typeof vi.spyOn>; check?: () => void } | Promise<{ first: Args; changed: Args; spy: ReturnType<typeof vi.spyOn>; check?: () => void }>;
}

const cases: Case[] = [
  { name: "run_ack", server: "cto", setup(f) {
    const a = enqueue(f, "message-a"), b = enqueue(f, "message-b");
    return { first: { runId: f.run.runId, messageId: a }, changed: { runId: f.run.runId, messageId: b }, spy: vi.spyOn(f.h.cp.outbox, "acknowledge"),
      check: () => expect(f.h.cp.outbox.get(b)?.status).toBe("SENT") };
  } },
  { name: "plan_submit", server: "cto", setup(f) {
    return { first: { runId: f.run.runId, plan: { summary: "first" }, tasks },
      changed: { runId: f.run.runId, plan: { summary: "second" }, tasks: [{ ...tasks[0], title: "second task" }] },
      spy: vi.spyOn(f.h.cp.tasks, "submit"), check: () => expect(f.h.cp.artifacts.latest(f.run.runId, ArtifactKind.PLAN)?.content).toMatchObject({ summary: "first" }) };
  } },
  { name: "resource_claim", server: "cto", setup(f) {
    return { first: { runId: f.run.runId, repositoryIdentity: f.run.identity, declaredPaths: ["first.ts"] },
      changed: { runId: f.run.runId, repositoryIdentity: f.run.identity, declaredPaths: ["second.ts"] }, spy: vi.spyOn(f.h.cp.claims, "acquire"),
      check: () => expect(f.h.cp.claims.heldByRun(f.run.runId).map(c => c.declaredPath)).toEqual(["first.ts"]) };
  } },
  { name: "resource_release", server: "cto", setup(f) {
    const claims = value(f.h.cp.claims.acquire({ runId: f.run.runId, ownerSessionId: f.run.sessionId, ownerBindingGeneration: 1,
      ownerRoleKey: f.run.roleKey, repositoryIdentity: f.run.identity, declaredPaths: ["first.ts", "second.ts"] }));
    return { first: { runId: f.run.runId, claimId: claims[0]!.claimId }, changed: { runId: f.run.runId, claimId: claims[1]!.claimId },
      spy: vi.spyOn(f.h.cp.claims, "release"), check: () => expect(f.h.cp.claims.heldByRun(f.run.runId).map(c => c.declaredPath)).toEqual(["second.ts"]) };
  } },
  // Scripted adapters perform no provider or network I/O.
  { name: "task_receipt_submit", server: "cto", setup(f) {
    const task = value(f.h.cp.tasks.submit(f.run.runId, tasks))[0]!;
    const workerSessionId = bindWorker(f.h, task.taskId);
    const spy = vi.spyOn(f.h.cp.tasks, "startWorkerExecution");
    return { first: { runId: f.run.runId, taskId: task.taskId, phase: "started", workerSessionId },
      changed: { runId: f.run.runId, taskId: task.taskId, phase: "finished", executionId: "different-execution", workerSessionId, status: "FAILED" }, spy,
      check: () => expect(f.h.cp.tasks.executions(f.run.runId)[0]?.status).toBe("RUNNING") };
  } },
  { name: "task_worker_run", server: "cto", setup(f) {
    const spy = vi.spyOn(f.h.cp.workerTurns, "start").mockResolvedValue(allow(ReasonCode.OK, { executionId: "execution-a" }));
    return { first: { runId: f.run.runId, taskId: "task-a", claimId: "claim-a" }, changed: { runId: f.run.runId, taskId: "task-b", claimId: "claim-b" }, spy };
  } },
  { name: "task_worker_provision", server: "cto", setup(f) {
    const [a, b] = value(f.h.cp.tasks.submit(f.run.runId, [tasks[0]!, { ...tasks[0]!, key: "b", title: "second task" }]));
    f.h.cp.providers.registerForRole(new TestProductionAdapter(f.h.clock, "claude"), Role.WORKER);
    const spy = vi.spyOn(f.h.cp.workers, "provision");
    return { first: { runId: f.run.runId, taskId: a!.taskId, provider: "claude" }, changed: { runId: f.run.runId, taskId: b!.taskId, provider: "gpt" }, spy,
      check: () => expect(f.h.cp.bindings.active(`WORKER:${b!.taskId}`)).toBeNull() };
  } },
  { name: "result_submit", server: "cto", async setup(f) {
    const run = value(f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: contract as never }));
    const dispatched = await dispatchBootstrapRun(f.h.cp, f.h.clock, run.runId);
    const session = f.h.cp.sessions.require(dispatched.ownerSessionId!);
    f.peer = { sessionId: session.sessionId, incarnation: session.incarnation };
    await submitBootstrapPlan(f.h, run.runId, genesisPlanFixture().artifact.content);
    f.h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.h, run.runId)) });
    return { first: { runId: run.runId, resultSummary: "first", recommendation: "merge" }, changed: { runId: run.runId, resultSummary: "second", recommendation: "revise" }, spy: vi.spyOn(f.h.cp.pipeline, "submitResult") };
  } },
  { name: "escalation_open", server: "cto", setup(f) {
    const base = { runId: f.run.runId, options: ["yes"], ctoRecommendation: "yes", whyItMatters: "review", blocksCriticalPath: false };
    return { first: { ...base, question: "first?" }, changed: { ...base, question: "second?" }, spy: vi.spyOn(f.h.cp.ceo, "openEscalation") };
  } },
  { name: "handoff_submit", server: "cto", setup(f) {
    const spy = vi.spyOn(f.h.cp.cto, "prepareSwitchover").mockResolvedValue(allow(ReasonCode.OK, { handoffId: "handoff-a", incomingSessionId: "incoming-a" }));
    return { first: { projectId: f.run.projectId, handoff }, changed: { projectId: f.run.projectId, handoff: { ...handoff, projectStatus: "second" } }, spy };
  } },
  { name: "capacity_get", server: "cto", setup(f) {
    return { first: { refresh: false }, changed: { refresh: true }, spy: vi.spyOn(f.h.cp.capacity, "all") };
  } },
  { name: "run_create", server: "hermes", setup(f) {
    return { first: { executionMode: "SIMPLE", contract }, changed: { executionMode: "SIMPLE", contract: { ...contract, goal: "second" } }, spy: vi.spyOn(f.h.cp.runs, "create") };
  } },
  { name: "run_dispatch", server: "hermes", setup(f) {
    bootstrapCtoProvider(f.h.cp, f.h.clock);
    const a = value(f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: contract as never }));
    const b = value(f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: contract as never }));
    return { first: { runId: a.runId }, changed: { runId: b.runId }, spy: vi.spyOn(f.h.cp.runs, "dispatch"),
      check: () => expect(f.h.cp.runs.require(b.runId).state).toBe("QUEUED") };
  } },
  { name: "run_cancel", server: "hermes", setup(f) {
    return { first: { runId: f.run.runId, reason: "first" }, changed: { runId: "run-b", reason: "second" }, spy: vi.spyOn(f.h.cp.runs, "cancel") };
  } },
  { name: "run_priority_set", server: "hermes", setup(f) {
    return { first: { runId: f.run.runId, priority: "LOW" }, changed: { runId: f.run.runId, priority: "CRITICAL" }, spy: vi.spyOn(f.h.cp.runs, "setPriority"),
      check: () => expect(f.h.cp.runs.require(f.run.runId).priority).toBe("LOW") };
  } },
  { name: "cto_start", server: "hermes", setup(f) {
    const spy = vi.spyOn(f.h.cp.cto, "ensurePrimaryCto").mockResolvedValue(allow(ReasonCode.OK, f.h.cp.bindings.active(f.run.roleKey)!));
    return { first: { projectId: f.run.projectId }, changed: { projectId: "project-b" }, spy };
  } },
  { name: "cto_replace", server: "hermes", setup(f) {
    return { first: { projectId: f.run.projectId, reason: "first" }, changed: { projectId: "project-b", reason: "second" }, spy: vi.spyOn(f.h.cp.cto, "requestReplacement") };
  } },
  { name: "cto_suspend", server: "hermes", setup(f) {
    f.h.cp.projects.register({ projectId: "project-a", name: "a" });
    f.h.cp.projects.register({ projectId: "project-b", name: "b" });
    return { first: { projectId: "project-a", reason: "first" }, changed: { projectId: "project-b", reason: "second" }, spy: vi.spyOn(f.h.cp.cto, "suspendProject"),
      check: () => expect(f.h.cp.projects.get("project-b")?.suspended).toBe(false) };
  } },
  { name: "cto_resume", server: "hermes", setup(f) {
    f.h.cp.projects.setSuspended(f.run.projectId, true, true);
    return { first: { projectId: f.run.projectId }, changed: { projectId: "project-b" }, spy: vi.spyOn(f.h.cp.cto, "resumeProject") };
  } },
  { name: "ceo_decision_submit", server: "hermes", async setup(f) {
    const run = value(f.h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: contract as never }));
    await dispatchBootstrapRun(f.h.cp, f.h.clock, run.runId);
    const reviewed = await reviewBootstrapPlan(f.h, run.runId, genesisPlanFixture().artifact.content);
    const base = { runId: run.runId, decision: "FINAL_REVISE", candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId: f.ceo, rationale: "first" };
    const evaluate = vi.spyOn(f.h.cp.continuity, "evaluate");
    const produce = vi.spyOn(f.h.cp.bootstrapProducer, "produceAndActivateApproved");
    return { first: base, changed: { ...base, decision: "CONFIRM", candidateSnapshotDigest: "candidate-b" }, spy: vi.spyOn(f.h.cp.ceo, "submitCeoDecision"),
      check: () => { expect(evaluate).not.toHaveBeenCalled(); expect(produce).not.toHaveBeenCalled(); } };
  } },
  { name: "owner_decision_submit", server: "hermes", setup(f) {
    f.h.cp.runs.promoteCandidate(f.run.runId, digestOf("candidate-a"));
    const base = { runId: f.run.runId, item: "delete data", approved: true, note: "first" };
    return { first: base, changed: { ...base, approved: false, note: "second" }, spy: vi.spyOn(f.h.cp.ceo, "recordOwnerDecision") };
  } },
  { name: "repair_execute", server: "hermes", setup(f) {
    value(f.h.cp.claims.acquire({ runId: f.run.runId, ownerSessionId: f.run.sessionId, ownerBindingGeneration: 1,
      ownerRoleKey: f.run.roleKey, repositoryIdentity: f.run.identity, declaredPaths: ["first.ts"], ttlMs: 1 }));
    f.h.clock.advance(2);
    return { first: { operationId: "expire_stale_claims", authorizedBy: "HERMES", dryRun: true },
      changed: { operationId: "expire_stale_claims", authorizedBy: "HERMES", dryRun: false }, spy: vi.spyOn(f.h.cp.repair, "execute"),
      check: () => expect(f.h.cp.db.get<{ status: string }>("SELECT status FROM resource_claims")?.status).toBe("HELD") };
  } },
];

describe("completed MCP keys bind the parsed request", () => {
  it.each(cases)("$server/$name", async c => {
    const f = fixture();
    try {
      const s = await c.setup(f);
      const key = `review:${c.name}`;
      const call = (args: Args) => c.server === "cto"
        ? callCtoTool(f.h, f.peer, c.name, args)
        : hermes(f.h, f.ceo, c.name, args);
      const first = await call({ ...s.first, idempotencyKey: key });
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
      const stored = f.h.cp.db.get("SELECT * FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [key]);
      const calls = s.spy.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      const replay = await call({ ...s.changed, idempotencyKey: key });
      expect(replay).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(s.spy.mock.calls).toHaveLength(calls);
      expect(f.h.cp.db.get("SELECT * FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [key])).toEqual(stored);
      s.check?.();
    } finally { f.h.cp.close(); }
  });
});

it("run_ack refuses replay after a new generation is bound to the same session", async () => {
  const f = fixture();
  // seedRun intentionally omits credentials. Give its fixture session a test-owned
  // credential before exercising the real socket authenticator.
  const credential = f.h.cp.sessions.create({ provider: "scripted", model: "credential-fixture" });
  f.h.cp.db.run("UPDATE sessions SET session_secret_hash = (SELECT session_secret_hash FROM sessions WHERE session_id = ?) WHERE session_id = ?", [credential.sessionId, f.run.sessionId]);
  const rotated = value(f.h.cp.sessions.rotateSecret(f.run.sessionId, 0));
  const token = "idem-sibling-local-token";
  const listeners = await startLocalMcpListeners(f.h.cp, tempDir("idem-sibling-sockets-"), token);
  const call = (args: Args) => callMcpToolOverSocket(listeners.socketPaths[1]!, {
    token, sessionId: f.run.sessionId, sessionSecret: rotated.sessionSecret,
  }, "run_ack", args);
  try {
    const args = { runId: f.run.runId, messageId: enqueue(f, "generation-message"), idempotencyKey: "generation-key" };
    const first = await call(args);
    expect(first).toMatchObject({ ok: true });
    // Reconnect under the newly current assignment; keep the run pinned to the old generation.
    value(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "generation change fixture"));
    value(f.h.cp.bindings.revoke(f.run.roleKey, "generation change fixture", { allowBlockedRuns: true }));
    const newBinding = f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: f.run.projectId, sessionId: f.run.sessionId });
    expect(newBinding.allowed, JSON.stringify(newBinding)).toBe(true);
    expect(value(newBinding).bindingGeneration).toBe(2);
    const replay = await call(args);
    expect(replay).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    const fresh = await call({ ...args, idempotencyKey: "generation-new-key" });
    expect(fresh).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
  } finally { await listeners.close(); f.h.cp.close(); }
});

it("v52 plan_submit refuses different inline genesis bytes", async () => {
  const h = makeHarness();
  try {
    const run = value(h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: contract as never }));
    const dispatched = await dispatchBootstrapRun(h.cp, h.clock, run.runId);
    const session = h.cp.sessions.require(dispatched.ownerSessionId!);
    const peer = { sessionId: session.sessionId, incarnation: session.incarnation };
    const plan = genesisPlanFixture().artifact.content as { genesis: { productIntent: Record<string, unknown> } };
    const args = { runId: run.runId, idempotencyKey: "genesis-plan", plan, tasks };
    const first = await callCtoTool(h, peer, "plan_submit", args);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const before = h.cp.artifacts.latest(run.runId, ArtifactKind.PLAN)!.digest;
    const changed = { ...plan, summary: "second genesis", genesis: { ...plan.genesis, productIntent: { ...plan.genesis.productIntent, summary: "second product" } } };
    const replay = await callCtoTool(h, peer, "plan_submit", { ...args, plan: changed });
    expect(replay).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(h.cp.artifacts.latest(run.runId, ArtifactKind.PLAN)!.digest).toBe(before);
    expect(h.cp.tasks.list(run.runId)).toHaveLength(1);
  } finally { h.cp.close(); }
});

it("escalation_resolve keeps its durable digest alongside shared replay verification", async () => {
  const f = fixture();
  try {
    const opened = value(f.h.cp.ceo.openEscalation({ runId: f.run.runId, question: "first?", options: ["yes"], ctoRecommendation: "yes",
      whyItMatters: "review", blocksCriticalPath: true, openedBySessionId: f.run.sessionId, openedAt: f.h.clock.nowIso() }));
    const args = { runId: f.run.runId, escalationId: opened.escalationId, resolution: "yes", idempotencyKey: "resolve-key" };
    const first = await hermes(f.h, f.ceo, "escalation_resolve", args);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const replay = await hermes(f.h, f.ceo, "escalation_resolve", { ...args, resolution: "no" });
    expect(replay).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
  } finally { f.h.cp.close(); }
});

it.each(["cto", "hermes"] as const)("%s returns the first success on a legitimate lost-response retry", async server => {
  const f = fixture();
  try {
    const c = cases.find(c => c.server === server && c.name === (server === "cto" ? "run_ack" : "run_create"))!;
    const setup = await c.setup(f);
    const args = { ...setup.first, idempotencyKey: "lost-response" };
    const call = () => server === "cto" ? callCtoTool(f.h, f.peer, c.name, args) : hermes(f.h, f.ceo, c.name, args);
    const first = await call();
    expect(first).toMatchObject({ ok: true });
    const count = setup.spy.mock.calls.length;
    const rows = f.h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'");
    f.h.clock.advance(120_000);
    expect(await call()).toEqual(first);
    expect(setup.spy.mock.calls).toHaveLength(count);
    expect(f.h.cp.db.all("SELECT * FROM inbound_messages WHERE channel = 'mcp'")).toEqual(rows);
    expect(rows).toHaveLength(1);
  } finally { f.h.cp.close(); }
});

const request = (arguments_: Record<string, unknown> = {}): McpMutationRequest => ({
  toolName: "fingerprint-test", arguments: arguments_, authority: () => allow(ReasonCode.OK, {}),
});

it.each([
  ["line\r\nend", "line\nend"], ["line\rend", "line\nend"],
  [" padded ", "padded"], ["é", "e\u0301"],
  [{ a: { idempotencyKey: "nested-a" } }, { a: { idempotencyKey: "nested-b" } }],
  [["a", "b"], ["b", "a"]], [null, "null"], [1, "1"],
])("canonical requests preserve meaningful values: %j vs %j", async (first, changed) => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("first"));
  try {
    await idempotentMcpMutation(h.cp, { actor: "peer" }, "canonical", effect, request({ value: first }));
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    expect((await idempotentMcpMutation(h.cp, { actor: "peer" }, "canonical", effect, request({ value: changed }))).structuredContent)
      .toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { h.cp.close(); }
});

it("canonical requests ignore object order and only the top-level idempotencyKey", async () => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("first"));
  try {
    const first = await idempotentMcpMutation(h.cp, { actor: "peer" }, "order", effect, request({ a: { c: 1, b: " x " }, z: 2, idempotencyKey: "ignored-a" }));
    expect(await idempotentMcpMutation(h.cp, { actor: "peer" }, "order", effect, request({ idempotencyKey: "ignored-b", z: 2, a: { b: " x ", c: 1 } }))).toEqual(first);
    expect(effect).toHaveBeenCalledTimes(1);
  } finally { h.cp.close(); }
});

it.each(["tool", "session", "incarnation", "role", "generation", "provenance"])("fingerprint separates %s", async changed => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("first"));
  const peer = { actor: "peer", sessionId: "s", sessionIncarnation: "i" };
  const original: McpMutationRequest = { ...request(), authority: () => allow(ReasonCode.OK, { roleKey: "r", bindingGeneration: 1 }), provenance: { principal: "owner", lineage: "a" } };
  try {
    await idempotentMcpMutation(h.cp, peer, "principal", effect, original);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    const retry = { ...original };
    const retryPeer = { ...peer };
    if (changed === "tool") retry.toolName = "sibling-tool";
    if (changed === "session") retryPeer.sessionId = "other";
    if (changed === "incarnation") retryPeer.sessionIncarnation = "other";
    if (changed === "role" || changed === "generation") retry.authority = () => allow(ReasonCode.OK, { roleKey: changed === "role" ? "other" : "r", bindingGeneration: changed === "generation" ? 2 : 1 });
    if (changed === "provenance") retry.provenance = { principal: "peer", lineage: "a" };
    expect((await idempotentMcpMutation(h.cp, retryPeer, "principal", effect, retry)).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { h.cp.close(); }
});

it.each([JSON.stringify(ok("legacy")), "", "{}", "invalid json", '{"kind":"mcp-mutation","version":2}'])("completed legacy row is unverifiable and preserved: %s", async resultJson => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("must not run"));
  try {
    h.cp.db.run("INSERT INTO inbound_messages (channel, nonce, actor, received_at, result_json) VALUES ('mcp', 'legacy', 'peer', ?, ?)", [h.clock.nowIso(), resultJson]);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    h.clock.advance(120_000);
    const result = await idempotentMcpMutation(h.cp, { actor: "peer" }, "legacy", effect, request());
    expect(result.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_REPLAY_UNVERIFIABLE, message: "MCP replay has no verifiable request fingerprint" });
    expect(effect).not.toHaveBeenCalled();
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { h.cp.close(); }
});

it.each([0, 60_000, 120_000])("legacy pending rows are unverifiable and unchanged at age %i", async age => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("must not run"));
  try {
    h.cp.db.run("INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('mcp', 'legacy-pending', 'peer', ?)", [h.clock.nowIso()]);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    h.clock.advance(age);
    expect((await idempotentMcpMutation(h.cp, { actor: "peer" }, "legacy-pending", effect, request())).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_REPLAY_UNVERIFIABLE });
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
    expect(effect).not.toHaveBeenCalled();
  } finally { h.cp.close(); }
});

it("new reservations persist their fingerprint before the effect and refuse concurrent/other-peer retries", async () => {
  const h = makeHarness();
  const peer = { actor: "peer" };
  let finish!: () => void;
  const effect = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finish = () => resolve(ok("first")); }));
  const first = idempotentMcpMutation(h.cp, peer, "pending", effect, request({ value: 1 }));
  try {
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    expect(isMcpReservationInFlight(h.cp.db, "pending", "peer")).toBe(true);
    expect(isMcpReservationInFlight(h.cp.db, "pending", "other")).toBe(false);
    expect(JSON.parse((before[0] as { result_json: string }).result_json)).toMatchObject({ kind: "mcp-mutation", version: 1, fingerprint: expect.stringMatching(/^sha256:/), result: null });
    h.clock.advance(120_000);
    expect((await idempotentMcpMutation(h.cp, peer, "pending", effect, request({ value: 1 }))).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED });
    expect((await idempotentMcpMutation(h.cp, { actor: "other" }, "pending", effect, request({ value: 1 }))).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { finish(); await first; }
  try {
    expect(isMcpReservationInFlight(h.cp.db, "pending", "peer")).toBe(false);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    expect((await idempotentMcpMutation(h.cp, { actor: "other" }, "pending", effect, request({ value: 1 }))).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { h.cp.close(); }
});

it("a matching replay must pass the current authority hook without changing the stored success", async () => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("first"));
  let current = true;
  const r: McpMutationRequest = { ...request(), authority: () => current ? allow(ReasonCode.OK, {}) : deny(ReasonCode.BINDING_GENERATION_STALE, "authority lost") };
  try {
    const first = await idempotentMcpMutation(h.cp, { actor: "peer" }, "authority", effect, r);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    current = false;
    expect((await idempotentMcpMutation(h.cp, { actor: "peer" }, "authority", effect, r)).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
    current = true;
    expect(await idempotentMcpMutation(h.cp, { actor: "peer" }, "authority", effect, r)).toEqual(first);
    expect(effect).toHaveBeenCalledTimes(1);
  } finally { h.cp.close(); }
});

it("fingerprinted abandoned reservations refuse unknown outcomes without executing or changing evidence", async () => {
  const h = makeHarness();
  const peer = { actor: "peer" };
  const effect = vi.fn(() => ok("first"));
  try {
    await idempotentMcpMutation(h.cp, peer, "abandoned", effect, request({ value: 1 }));
    const row = h.cp.db.get<{ result_json: string }>("SELECT result_json FROM inbound_messages WHERE nonce = 'abandoned'")!;
    const pending = { ...JSON.parse(row.result_json), result: null };
    h.cp.db.run("UPDATE inbound_messages SET result_json = ? WHERE nonce = 'abandoned'", [JSON.stringify(pending)]);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    h.clock.advance(60_000);
    expect((await idempotentMcpMutation(h.cp, peer, "abandoned", effect, request({ value: 2 }))).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
    expect((await idempotentMcpMutation(h.cp, peer, "abandoned", effect, request({ value: 1 }))).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN });
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toHaveLength(1);
  } finally { h.cp.close(); }
});

it("Hermes provenance separates owner and peer turns sharing a transport principal", async () => {
  const f = fixture();
  const effect = vi.spyOn(f.h.cp.runs, "create");
  try {
    const args = { idempotencyKey: "provenance", executionMode: "SIMPLE", contract };
    const first = await hermes(f.h, f.ceo, "run_create", args);
    expect(first).toMatchObject({ ok: true });
    const before = f.h.cp.db.all("SELECT * FROM inbound_messages");
    expect(await hermes(f.h, f.ceo, "run_create", args, { principal: "peer", peer_grant: digestOf("grant") })).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    expect(await hermes(f.h, f.ceo, "run_create", args, { cron: true })).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_TOOL_PROVENANCE_REFUSED });
    expect(await hermes(f.h, f.ceo, "run_create", args)).toEqual(first);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(f.h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { f.h.cp.close(); }
});

it("handoff_submit rechecks the current project-primary fence before replay", async () => {
  const f = fixture();
  try {
    const setup = await cases.find(c => c.name === "handoff_submit")!.setup(f);
    const args = { ...setup.first, idempotencyKey: "project-authority" };
    expect(await callCtoTool(f.h, f.peer, "handoff_submit", args)).toMatchObject({ ok: true });
    value(f.h.cp.runs.transition(f.run.runId, RunState.BLOCKED, "revoke fixture"));
    value(f.h.cp.bindings.revoke(f.run.roleKey, "revoke fixture", { allowBlockedRuns: true }));
    const before = f.h.cp.db.all("SELECT * FROM inbound_messages");
    expect(await callCtoTool(f.h, f.peer, "handoff_submit", args)).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    expect(setup.spy).toHaveBeenCalledTimes(1);
    expect(f.h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { f.h.cp.close(); }
});

it.each(["cto", "hermes"] as const)("%s authenticates every retry before replay", async kind => {
  const f = fixture();
  let current = true;
  const authenticate = () => current ? allow(ReasonCode.OK, { actor: f.ceo, sessionId: f.ceo, sessionIncarnation: f.h.cp.sessions.require(f.ceo).incarnation, binding: { roleKey: f.run.roleKey, bindingGeneration: 1 } }) : deny<never>(ReasonCode.MCP_PEER_UNAUTHENTICATED, "credential revoked");
  const server = kind === "cto" ? createCtoServer(createCtoMcpPort(f.h.cp), authenticate) : createHermesServer(createHermesMcpPort(f.h.cp), authenticate);
  const name = kind === "cto" ? "capacity_get" : "run_create";
  const args = kind === "cto" ? { idempotencyKey: "auth", refresh: false } : { idempotencyKey: "auth", executionMode: "SIMPLE", contract, repositories: [] };
  const invoke = (server as unknown as { _registeredTools: Record<string, { handler: (args: Args) => Promise<{ structuredContent?: Args }> }> })._registeredTools[name]!.handler;
  try {
    expect((await invoke(args)).structuredContent).toMatchObject({ ok: true });
    const before = f.h.cp.db.all("SELECT * FROM inbound_messages");
    current = false;
    expect((await invoke(args)).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    expect(f.h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { await server.close(); f.h.cp.close(); }
});

it("escalation's durable receipt cannot bypass an unverifiable legacy reservation", async () => {
  const f = fixture();
  try {
    const opened = value(f.h.cp.ceo.openEscalation({ runId: f.run.runId, question: "first?", options: ["yes"], ctoRecommendation: "yes", whyItMatters: "test", blocksCriticalPath: true, openedBySessionId: f.run.sessionId, openedAt: f.h.clock.nowIso() }));
    const args = { runId: f.run.runId, escalationId: opened.escalationId, resolution: "yes", idempotencyKey: "legacy-escalation" };
    const first = await hermes(f.h, f.ceo, "escalation_resolve", args);
    expect(first).toMatchObject({ ok: true });
    f.h.cp.db.run("UPDATE inbound_messages SET result_json = ? WHERE nonce = ?", [JSON.stringify({ structuredContent: first, content: [] }), args.idempotencyKey]);
    const before = f.h.cp.db.all("SELECT * FROM inbound_messages");
    const resolve = vi.spyOn(f.h.cp.ceo, "resolveEscalation");
    expect(await hermes(f.h, f.ceo, "escalation_resolve", args)).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_REPLAY_UNVERIFIABLE });
    expect(resolve).not.toHaveBeenCalled();
    expect(f.h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { f.h.cp.close(); }
});

it("replay rechecks authority after the reservation lookup yields", async () => {
  const h = makeHarness();
  let current = true;
  const effect = vi.fn(() => ok("first"));
  const r: McpMutationRequest = { ...request(), authority: () => current ? allow(ReasonCode.OK, {}) : deny(ReasonCode.BINDING_GENERATION_STALE, "authority lost") };
  try {
    await idempotentMcpMutation(h.cp, { actor: "peer" }, "replay-race", effect, r);
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    const retry = idempotentMcpMutation(h.cp, { actor: "peer" }, "replay-race", effect, r);
    current = false;
    expect((await retry).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { h.cp.close(); }
});

it("response-store failure retains the fingerprint and refuses every uncertain retry", async () => {
  const h = makeHarness();
  const effect = vi.fn(() => ok("first"));
  const original = h.cp.db.run.bind(h.cp.db);
  let failed = false;
  vi.spyOn(h.cp.db, "run").mockImplementation((sql, params) => {
    if (!failed && sql.includes("UPDATE inbound_messages SET result_json")) {
      failed = true;
      throw new Error("response store failed");
    }
    return original(sql, params);
  });
  try {
    await expect(idempotentMcpMutation(h.cp, { actor: "peer" }, "store-failure", effect, request())).rejects.toThrow("response store failed");
    const before = h.cp.db.all("SELECT * FROM inbound_messages");
    expect(before).toHaveLength(1);
    expect(JSON.parse((before[0] as { result_json: string }).result_json)).toMatchObject({ version: 1, result: null });
    expect((await idempotentMcpMutation(h.cp, { actor: "peer" }, "store-failure", effect, request())).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
    h.clock.advance(60_000);
    expect((await idempotentMcpMutation(h.cp, { actor: "peer" }, "store-failure", effect, request())).structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.cp.db.all("SELECT * FROM inbound_messages")).toEqual(before);
  } finally { h.cp.close(); }
});
