import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CapacityReading, SessionHandle, SessionSpec } from "../../src/runtime/provider.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { bindWorkerForTask, fixtureManifest, makeHarness, type Harness } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { HeadlessRuntimeDouble } from "../helpers/headless-runtime.ts";
import type { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 PR-C slice C1 — a project-less PROJECT_BOOTSTRAP run's `BOOTSTRAP_CTO(run)` is staffed
 * by its dispatch (RF PRD:156, :360; ACP PRD §9.5): capacity, a fresh Claude Opus session (launch
 * credential → Buzz → probe → READY → readiness), then bind at generation 1, pin and RUN_DISPATCH
 * in one transaction. The role holds its session alone, is never promoted, and is reclaimed when
 * the run ends.
 *
 * Every row that can goes through the real sockets: run_create, run_dispatch and run_cancel over
 * `hermes.mcp.sock` as the CEO, and plan_submit over `cto.mcp.sock` as the bootstrap CTO,
 * authenticated with the credential its launch channel issued. The Claude provider is a scripted
 * double registered for the BOOTSTRAP_CTO role; only the model runtime is scripted.
 */
const TOKEN = "bootstrap-cto-token";

const CONTRACT: TaskContract = {
  goal: "bootstrap a new project",
  why: "the owner asked for a repository that does not exist yet",
  scope: [],
  nonGoals: [],
  acceptance: ["the project exists and its CTO is bound"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

type DefaultModels = { cto: string; reviewer: string; worker: string; ceo: string };

/**
 * A provider double that records what was started and stopped. It answers with the shipped
 * adapter's default models, so a continuity path that falls back to an adapter's default meets the
 * model production would give it — for Claude, Opus for a CTO and Sonnet for a worker. A row may
 * override a default, to make a fallback to it visible where the shipped one would hide it.
 */
class ProviderDouble extends HeadlessRuntimeDouble {
  readonly started: SessionSpec[] = [];
  readonly stopped: string[] = [];

  constructor(clock: Harness["clock"], provider: "claude" | "gpt", defaults: Partial<DefaultModels> = {}) {
    super(clock, provider);
    Object.defineProperty(this, "defaultModels", {
      value: Object.freeze({
        ...(provider === "claude"
          ? { cto: "opus", reviewer: "opus", worker: "sonnet", ceo: "opus" }
          : { cto: "gpt-5.6-sol", reviewer: "gpt-5.6-sol", worker: "gpt-5.6-luna-max", ceo: "gpt-5.6-sol" }),
        ...defaults,
      }),
    });
  }

  override async startSession(spec: SessionSpec): Promise<SessionHandle> {
    this.started.push(spec);
    return super.startSession(spec);
  }

  override async stopSession(handle?: SessionHandle): Promise<void> {
    if (handle) this.stopped.push(handle.externalSessionId);
    return super.stopSession(handle);
  }
}

interface FixtureOptions {
  /** Defaults the Claude double answers with in place of the shipped adapter's. */
  claudeDefaults?: Partial<DefaultModels>;
}

const bootstrapFixture = async (options: FixtureOptions = {}) => {
  const harness = makeHarness();
  const launch = await startSessionLaunchChannel(tempDir("acp-bcto-launch-"), { mcpToken: TOKEN });
  harness.cp.cto.attach({ sessionLaunch: launch });
  const claude = new ProviderDouble(harness.clock, "claude", options.claudeDefaults);
  harness.cp.providers.registerForRole(claude, Role.BOOTSTRAP_CTO);

  // The creation response is the only place a session secret exists, so the CEO the Hermes
  // socket authenticates is created here.
  const ceo = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap-cto-ceo" });
  const ceoSecret = ceo.sessionSecret;
  if (!ceoSecret) throw new Error("the CEO session has no secret");
  harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const boundCeo = harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!boundCeo.allowed) throw new Error(boundCeo.message);

  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-bcto-mcp-"), TOKEN);
  const [hermesSocket, ctoSocket] = listeners.socketPaths;
  if (!hermesSocket || !ctoSocket) throw new Error("the MCP listeners were not started");
  // C1b: the bootstrap CTO's runtime reaches the daemon over these two sockets.
  harness.cp.sessionRuntime.attach({
    delivery: launch,
    route: { launchSocketPath: launch.socketPath, mcpSocketPath: ctoSocket },
  });
  let keys = 0;
  const hermes = (name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(
      hermesSocket,
      { token: TOKEN, sessionId: ceo.sessionId, sessionSecret: ceoSecret },
      name,
      { idempotencyKey: `bcto-${++keys}`, ...args },
    );
  // C1b: the credential is the one the session's runtime took from the launch channel during its
  // attestation turn; a row acts as that runtime by presenting it, as the runtime's relay would.
  const cto = async (sessionId: string, name: string, args: Record<string, unknown>) => {
    const credential = claude.credentials.get(sessionId);
    if (!credential) throw new Error("the session's runtime never took its credential");
    return callMcpToolOverSocket(
      ctoSocket,
      { token: TOKEN, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
      name,
      { idempotencyKey: `bcto-${++keys}`, ...args },
    );
  };
  const createBootstrap = async (): Promise<string> => {
    const created = await hermes("run_create", {
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
    });
    if (created["ok"] !== true) throw new Error(`run_create refused: ${JSON.stringify(created)}`);
    return (created["value"] as { runId: string }).runId;
  };
  const dispatchBootstrap = async (): Promise<{ runId: string; ownerSessionId: string }> => {
    const runId = await createBootstrap();
    const dispatched = await hermes("run_dispatch", { runId });
    if (dispatched["ok"] !== true) throw new Error(`run_dispatch refused: ${JSON.stringify(dispatched)}`);
    return { runId, ownerSessionId: harness.cp.runs.require(runId).ownerSessionId! };
  };
  return {
    harness,
    claude,
    ceoSessionId: ceo.sessionId,
    hermes,
    cto,
    createBootstrap,
    dispatchBootstrap,
    close: async () => {
      await listeners.close();
      await launch.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof bootstrapFixture>>;

const withFixture = async (body: (f: Fixture) => Promise<void>, options: FixtureOptions = {}): Promise<void> => {
  const f = await bootstrapFixture(options);
  try {
    await body(f);
  } finally {
    await f.close();
  }
};

/** A fresh READY session nothing has bound, as a caller of `bind`/`switchTo` would name. */
const readySession = (f: Fixture, model: string): string => {
  const session = f.harness.cp.sessions.create({ provider: "scripted", model });
  f.harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "fixture session");
  return session.sessionId;
};

const registerProject = (f: Fixture, projectId: string): void => {
  const manifest = fixtureManifest(projectId);
  const registered = f.harness.cp.projects.register({
    projectId,
    name: projectId,
    manifest,
    authorization: f.harness.cp.manifestAuthorizationForTests(manifest),
  });
  if (!registered.allowed) throw new Error(registered.message);
};

/** A QUEUED project-less bootstrap run, created through the run engine. */
const queuedBootstrapRun = (f: Fixture): string => {
  const created = f.harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  return created.value.runId;
};

/**
 * A dispatched bootstrap run sent back for revision by the CEO's FINAL_REVISE over the Hermes
 * socket, so `run_dispatch` may dispatch it again.
 */
const revisedBootstrap = async (f: Fixture): Promise<{ runId: string; ownerSessionId: string }> => {
  const dispatched = await f.dispatchBootstrap();
  // TODO(C2): the bootstrap review gate moves the run to CEO review; this transition stands in.
  expect(f.harness.cp.runs.transition(dispatched.runId, RunState.READY_FOR_CEO_REVIEW, "reviewed").allowed).toBe(true);
  const revised = await f.hermes("ceo_decision_submit", {
    runId: dispatched.runId,
    decision: "FINAL_REVISE",
    candidateSnapshotDigest: "sha256:bootstrap-candidate",
    ceoSessionId: f.ceoSessionId,
    rationale: "revise the plan",
  });
  expect(revised).toMatchObject({ ok: true, value: { state: RunState.REVISION_REQUIRED } });
  return dispatched;
};

const claudeSessions = (f: Fixture) =>
  f.harness.cp.db.all<{ session_id: string; lifecycle: string }>(
    `SELECT session_id, lifecycle FROM sessions WHERE provider = 'claude' ORDER BY created_at, session_id`,
  );

const assignmentCount = (f: Fixture): number =>
  f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments`)?.n ?? -1;

describe("W1 (C1): a project-less PROJECT_BOOTSTRAP dispatch staffs its BOOTSTRAP_CTO", () => {
  it("run_create (no project) → run_dispatch spawns a Claude Opus BOOTSTRAP_CTO, binds it at generation 1 and pins it → plan_submit from that session over cto.mcp.sock is accepted", async () => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, projectId: null, ownerSessionId: null });

      const dispatched = await f.hermes("run_dispatch", { runId });
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      expect(dispatched).toMatchObject({
        ok: true,
        value: { state: RunState.ACTIVE, ownerRoleKey: roleKey, ownerBindingGeneration: 1 },
      });

      const run = f.harness.cp.runs.require(runId);
      const binding = f.harness.cp.bindings.active(roleKey);
      expect(binding).toMatchObject({
        role: Role.BOOTSTRAP_CTO,
        runId,
        projectId: null,
        bindingGeneration: 1,
        sessionId: run.ownerSessionId,
        sessionIncarnation: run.ownerSessionIncarnation,
      });
      expect(f.harness.cp.bindings.history(roleKey)).toHaveLength(1);
      // Its own fresh session, on the fixed provider and model, and holding nothing else.
      const session = f.harness.cp.sessions.require(run.ownerSessionId!);
      expect(session).toMatchObject({ provider: "claude", model: "opus", lifecycle: SessionLifecycle.READY });
      expect(f.claude.started).toEqual([expect.objectContaining({ model: "opus", purpose: "bootstrap-cto" })]);
      expect(f.harness.cp.bindings.bySession(session.sessionId).map((held) => held.roleKey)).toEqual([roleKey]);
      // RUN_DISPATCH is addressed to that binding, in the dispatch transaction.
      expect(f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "RUN_DISPATCH")).toEqual([
        expect.objectContaining({ roleKey, bindingGeneration: 1, targetSessionId: session.sessionId }),
      ]);

      const submitted = await f.cto(session.sessionId, "plan_submit", {
        runId,
        plan: { summary: "bootstrap the requested repository" },
        tasks: [{ key: "bootstrap", title: "bootstrap the repository", category: "implementation" }],
      });
      expect(submitted).toMatchObject({ ok: true });
      expect(f.harness.cp.artifacts.latest<{ summary: string }>(runId, "PLAN")?.content.summary)
        .toBe("bootstrap the requested repository");
      expect(f.harness.cp.tasks.list(runId)).toHaveLength(1);
    });
  });

  it("re-dispatch reuses the live binding — no new session, no new actor, still generation 1", async () => {
    await withFixture(async (f) => {
      const { runId, ownerSessionId } = await revisedBootstrap(f);
      const actorsBefore = f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversational_actors`)?.n;

      const again = await f.hermes("run_dispatch", { runId });
      expect(again).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerSessionId, ownerBindingGeneration: 1 } });
      expect(f.claude.started).toHaveLength(1);
      expect(f.harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toHaveLength(1);
      expect(f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversational_actors`)?.n).toBe(actorsBefore);
    });
  });

  it("re-dispatch probes the live binding: a session the provider no longer has is refused, not replaced", async () => {
    await withFixture(async (f) => {
      const { runId, ownerSessionId } = await revisedBootstrap(f);
      const session = f.harness.cp.sessions.require(ownerSessionId);
      // The provider forgets the session; the row still says READY.
      await f.claude.stopSession({
        externalSessionId: session.incarnation.split("#", 1)[0]!,
        provider: "claude",
        model: "opus",
        effort: null,
        pid: null,
      });
      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      expect(f.claude.started).toHaveLength(1);
      expect(f.harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toHaveLength(1);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.REVISION_REQUIRED, ownerSessionId });
    });
  });

  it("a fresh session the provider cannot vouch for is refused, and stopped rather than left running", async () => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      f.claude.setNextSessionHealth("UNAVAILABLE");
      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      expect(f.claude.started).toHaveLength(1);
      expect(f.claude.stopped).toHaveLength(1);
      expect(claudeSessions(f).map((row) => row.lifecycle)).toEqual([SessionLifecycle.STOPPED]);
      expect(f.harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toEqual([]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    });
  });

  it("a dispatch that finds the role bound while it spawned is refused BINDING_ALREADY_ACTIVE and stops its own session", async () => {
    await withFixture(async (f) => {
      const runId = queuedBootstrapRun(f);
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      const raced = readySession(f, "raced-bootstrap-cto");
      const lifecycle = f.harness.cp.cto;
      const spawn = lifecycle.spawnBootstrapCto.bind(lifecycle);
      vi.spyOn(lifecycle, "spawnBootstrapCto").mockImplementationOnce(async (spawnRunId, runtime) => {
        const spawned = await spawn(spawnRunId, runtime);
        expect(f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId: raced }).allowed).toBe(true);
        return spawned;
      });
      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE });
      expect(f.claude.stopped).toHaveLength(1);
      expect(claudeSessions(f).map((row) => row.lifecycle)).toEqual([SessionLifecycle.STOPPED]);
      expect(f.harness.cp.bindings.active(roleKey)?.sessionId).toBe(raced);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    });
  });

  it("a re-dispatch whose binding moved while it was probed is refused BINDING_GENERATION_STALE", async () => {
    await withFixture(async (f) => {
      const { runId, ownerSessionId } = await revisedBootstrap(f);
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      const replacement = readySession(f, "replacement-bootstrap-cto");
      const lifecycle = f.harness.cp.cto;
      const probe = lifecycle.probeRoleSession.bind(lifecycle);
      vi.spyOn(lifecycle, "probeRoleSession").mockImplementationOnce(async (sessionId, role) => {
        const live = await probe(sessionId, role);
        // A continuity replacement lands during the probe, repointing the run to generation 2.
        expect(f.harness.cp.bindings.switchTo({
          role: Role.BOOTSTRAP_CTO, runId, sessionId: replacement, reason: "row", conversation: "REPLACED", takeover: true,
        }).allowed).toBe(true);
        return live;
      });
      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({
        state: RunState.REVISION_REQUIRED,
        ownerSessionId: replacement,
        ownerBindingGeneration: 2,
      });
      expect(f.harness.cp.bindings.active(roleKey)?.bindingGeneration).toBe(2);
      // The probed session is the earlier generation's, not one this dispatch spawned: left alone.
      expect(f.claude.stopped).toEqual([]);
      expect(f.harness.cp.sessions.require(ownerSessionId).lifecycle).toBe(SessionLifecycle.READY);
    });
  });

  it("a role with history and no live binding is refused BINDING_REVOKED before capacity; nothing is spawned", async () => {
    await withFixture(async (f) => {
      const runId = queuedBootstrapRun(f);
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      const earlier = readySession(f, "earlier-bootstrap-cto");
      expect(f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId: earlier }).allowed).toBe(true);
      expect(f.harness.cp.bindings.revoke(roleKey, "an earlier holder").allowed).toBe(true);
      const refresh = vi.spyOn(f.harness.cp.capacity, "refreshForDispatch");

      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BINDING_REVOKED });
      expect(refresh).not.toHaveBeenCalled();
      expect(f.claude.started).toEqual([]);
      expect(f.harness.cp.bindings.history(roleKey)).toHaveLength(1);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    });
  });

  it("a dispatch refused after the spawn stops the session it spawned; no READY session is left behind", async () => {
    await withFixture(async (f) => {
      const runId = queuedBootstrapRun(f);
      // The run is cancelled while its bootstrap CTO is being spawned, so the dispatch transaction
      // that would bind and pin it is refused.
      const lifecycle = f.harness.cp.cto;
      const spawn = lifecycle.spawnBootstrapCto.bind(lifecycle);
      vi.spyOn(lifecycle, "spawnBootstrapCto").mockImplementationOnce(async (spawnRunId, runtime) => {
        const spawned = await spawn(spawnRunId, runtime);
        f.harness.cp.runs.cancel(runId, "withdrawn while its bootstrap CTO was spawned");
        return spawned;
      });
      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_ALREADY_TERMINAL });
      expect(f.claude.started).toHaveLength(1);
      expect(f.claude.stopped).toHaveLength(1);
      const spawned = f.harness.cp.db.all<{ lifecycle: string }>(`SELECT lifecycle FROM sessions WHERE provider = 'claude'`);
      expect(spawned).toEqual([{ lifecycle: SessionLifecycle.STOPPED }]);
      expect(f.harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toEqual([]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.CANCELLED, ownerSessionId: null });
    });
  });
});

/**
 * A READY session a provider double really started, recorded the way a spawn records one (the
 * provider's own id as the incarnation prefix), so the provider vouches for it when probed.
 */
const providerSession = async (f: Fixture, adapter: TestProductionAdapter, model: string): Promise<string> => {
  const handle = await adapter.startSession({ model, effort: null, workdir: tempDir("acp-bcto-held-"), purpose: "fixture" });
  const session = f.harness.cp.sessions.create({
    provider: handle.provider,
    model,
    incarnation: `${handle.externalSessionId}#${f.harness.clock.nowIso()}`,
  });
  f.harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "provider session verified");
  // C1b: a spawn hands the new credential to the headless runtime's custody; so does this.
  f.harness.cp.sessionRuntime.adopt(session.sessionId, Role.BOOTSTRAP_CTO, session.sessionSecret!, 0);
  return session.sessionId;
};

/**
 * `bind` with the exclusive-role rule stood down for this one call: the state the base's
 * `bindBootstrapCto` allowed (a run's bootstrap CTO on a session holding another role), replayed,
 * then the rule restored before anything under test runs.
 */
const bindWithoutSeparation = (f: Fixture, input: Parameters<Fixture["harness"]["cp"]["bindings"]["bind"]>[0]) => {
  const separation = vi
    .spyOn(BindingRegistry.prototype as unknown as { assertExclusiveRoleSeparation: () => Decision<void> }, "assertExclusiveRoleSeparation")
    .mockReturnValueOnce(allow(ReasonCode.OK, undefined));
  try {
    const bound = f.harness.cp.bindings.bind(input);
    if (!bound.allowed) throw new Error(bound.message);
    return bound.value;
  } finally {
    separation.mockRestore();
  }
};

const actorOf = (f: Fixture, assignmentId: string): string | undefined =>
  f.harness.cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`, [assignmentId])?.actor_id;

const runDispatchMessages = (f: Fixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "RUN_DISPATCH");

/**
 * #246 C1-01 — a re-dispatch that reuses the run's BOOTSTRAP_CTO binding admits it as a fresh bind
 * is admitted: on the fixed runtime (Claude Opus) and alone on its session. A persisted binding that
 * is neither is refused at `run_dispatch` over the Hermes socket — never reused, never replaced, and
 * nothing it shares a session with is touched. Each row seeds a binding state the base allowed.
 */
describe("C1-01: a reused BOOTSTRAP_CTO binding is admitted as a fresh one would be", () => {
  it.each([
    { provider: "claude", model: "sonnet" },
    { provider: "scripted", model: "scripted-cto" },
  ] as const)("a bootstrap CTO bound on $provider/$model is refused at run_dispatch; it is neither reused nor replaced", async ({ provider, model }) => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      // A session its provider vouches for, so only its runtime is wrong.
      const sessionId = await providerSession(f, provider === "claude" ? f.claude : (f.harness.scripted as TestProductionAdapter), model);
      // The registry has no runtime rule for a BOOTSTRAP_CTO: the state an earlier build could persist.
      const seeded = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId });
      if (!seeded.allowed) throw new Error(seeded.message);
      const startedBefore = f.claude.started.length;
      // Refused at admission: before capacity is asked and before the provider is.
      const refresh = vi.spyOn(f.harness.cp.capacity, "refreshForDispatch");
      const probe = vi.spyOn(f.harness.cp.cto, "probeRoleSession");

      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED,
        evidence: { roleKey, sessionId, provider, model, fixedProvider: "claude", fixedModel: "opus" },
      });
      expect(refresh).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(f.claude.started).toHaveLength(startedBefore);
      expect(f.claude.stopped).toEqual([]);
      expect(f.harness.cp.bindings.history(roleKey)).toEqual([
        expect.objectContaining({ status: "ACTIVE", sessionId, bindingGeneration: 1, assignmentId: seeded.value.assignmentId }),
      ]);
      expect(f.harness.cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
      expect(runDispatchMessages(f, runId)).toEqual([]);
    });
  });

  it("a bootstrap CTO whose Claude Opus session also holds a PRIMARY_CTO is refused at run_dispatch; neither binding nor actor is touched", async () => {
    await withFixture(async (f) => {
      registerProject(f, "shared-project");
      const runId = await f.createBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      const sessionId = await providerSession(f, f.claude, "opus");
      const primary = f.harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "shared-project", sessionId });
      if (!primary.allowed) throw new Error(primary.message);
      const bootstrap = bindWithoutSeparation(f, { role: Role.BOOTSTRAP_CTO, runId, sessionId });
      const primaryActor = actorOf(f, primary.value.assignmentId);
      const bootstrapActor = actorOf(f, bootstrap.assignmentId);
      const startedBefore = f.claude.started.length;
      // Refused at admission: before capacity is asked and before the provider is.
      const refresh = vi.spyOn(f.harness.cp.capacity, "refreshForDispatch");
      const probe = vi.spyOn(f.harness.cp.cto, "probeRoleSession");

      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT });
      // The PRIMARY_CTO it shares a session with keeps its binding, generation and actor.
      expect(f.harness.cp.bindings.activePrimaryCto("shared-project")).toMatchObject({
        assignmentId: primary.value.assignmentId,
        sessionId,
        bindingGeneration: 1,
      });
      expect(actorOf(f, primary.value.assignmentId)).toBe(primaryActor);
      // The invalid binding is refused, not replaced.
      expect(f.harness.cp.bindings.history(roleKey)).toEqual([
        expect.objectContaining({ assignmentId: bootstrap.assignmentId, status: "ACTIVE", bindingGeneration: 1 }),
      ]);
      expect(actorOf(f, bootstrap.assignmentId)).toBe(bootstrapActor);
      expect(f.harness.cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(refresh).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(f.claude.started).toHaveLength(startedBefore);
      expect(f.claude.stopped).toEqual([]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
      expect(runDispatchMessages(f, runId)).toEqual([]);
    });
  });

  it("the dispatch transaction asks again: a reused binding that lost its independence while it was probed is refused", async () => {
    await withFixture(async (f) => {
      registerProject(f, "late-project");
      const runId = await f.createBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      // A valid live binding: Claude Opus, alone on its session.
      const sessionId = await providerSession(f, f.claude, "opus");
      const bound = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      const lifecycle = f.harness.cp.cto;
      const probe = lifecycle.probeRoleSession.bind(lifecycle);
      let shared: string | null = null;
      vi.spyOn(lifecycle, "probeRoleSession").mockImplementationOnce(async (probed, role) => {
        const live = await probe(probed, role);
        // While dispatch awaits the provider, the session takes a PRIMARY_CTO as the base allowed.
        shared = bindWithoutSeparation(f, { role: Role.PRIMARY_CTO, projectId: "late-project", sessionId }).assignmentId;
        return live;
      });

      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT });
      expect(shared).not.toBeNull();
      expect(f.harness.cp.bindings.activePrimaryCto("late-project")?.assignmentId).toBe(shared);
      expect(f.harness.cp.bindings.history(roleKey)).toEqual([
        expect.objectContaining({ assignmentId: bound.value.assignmentId, status: "ACTIVE", bindingGeneration: 1 }),
      ]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
      expect(runDispatchMessages(f, runId)).toEqual([]);
    });
  });
});

describe("W4 (C1): a BOOTSTRAP_CTO holds its session alone, in both directions", () => {
  /** A bootstrap run whose BOOTSTRAP_CTO is bound on a fresh session, the way staffing binds it. */
  const boundBootstrapCto = (f: Fixture): { runId: string; sessionId: string } => {
    const runId = queuedBootstrapRun(f);
    const sessionId = readySession(f, "bootstrap-cto");
    const bound = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId });
    if (!bound.allowed) throw new Error(bound.message);
    return { runId, sessionId };
  };

  it.each(["bind", "switchTo"] as const)("%s refuses a PRIMARY_CTO onto a bootstrap CTO's session (no promotion)", async (method) => {
    await withFixture(async (f) => {
      const { sessionId } = boundBootstrapCto(f);
      registerProject(f, "promotion-target");
      const before = assignmentCount(f);
      const input = { role: Role.PRIMARY_CTO, projectId: "promotion-target", sessionId };
      const refused = method === "bind"
        ? f.harness.cp.bindings.bind(input)
        : f.harness.cp.bindings.switchTo({ ...input, reason: "row", conversation: "REPLACED" });
      expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
      expect(assignmentCount(f)).toBe(before);
      expect(f.harness.cp.bindings.activePrimaryCto("promotion-target")).toBeNull();
    });
  });

  it("refuses the CEO and another run's blind reviewer onto a bootstrap CTO's session", async () => {
    await withFixture(async (f) => {
      const { sessionId } = boundBootstrapCto(f);
      // A dispatched run, so its producer set is known and reviewer independence alone admits.
      const { runId: otherRun } = await f.dispatchBootstrap();
      const before = assignmentCount(f);
      const ceo = f.harness.cp.bindings.switchTo({ role: Role.CEO, sessionId, reason: "row", conversation: "REPLACED" });
      expect(ceo.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
      const reviewer = f.harness.cp.bindings.bind({ role: Role.BLIND_REVIEWER, runId: otherRun, sessionId });
      expect(reviewer.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
      expect(assignmentCount(f)).toBe(before);
      expect(f.harness.cp.bindings.active(roleKeyFor(Role.CEO))?.sessionId).toBe(f.ceoSessionId);
    });
  });

  it.each(["bind", "switchTo"] as const)("%s refuses a BOOTSTRAP_CTO onto a session holding a PRIMARY_CTO", async (method) => {
    await withFixture(async (f) => {
      registerProject(f, "held-project");
      const cto = readySession(f, "primary-cto");
      expect(f.harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "held-project", sessionId: cto }).allowed).toBe(true);
      const runId = queuedBootstrapRun(f);
      const before = assignmentCount(f);
      const input = { role: Role.BOOTSTRAP_CTO, runId, sessionId: cto };
      const refused = method === "bind"
        ? f.harness.cp.bindings.bind(input)
        : f.harness.cp.bindings.switchTo({ ...input, reason: "row", conversation: "REPLACED" });
      expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
      expect(assignmentCount(f)).toBe(before);
    });
  });

  it("refuses a BOOTSTRAP_CTO onto the CEO's session", async () => {
    await withFixture(async (f) => {
      const runId = queuedBootstrapRun(f);
      const before = assignmentCount(f);
      const refused = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId, sessionId: f.ceoSessionId });
      expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
      expect(assignmentCount(f)).toBe(before);
    });
  });

  it("refuses a BOOTSTRAP_CTO onto a session that still owns another run after its binding was revoked", async () => {
    await withFixture(async (f) => {
      registerProject(f, "owned-project");
      const cto = readySession(f, "former-owner");
      const bound = f.harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "owned-project", sessionId: cto });
      if (!bound.allowed) throw new Error(bound.message);
      const owned = f.harness.cp.runs.create({ projectId: "owned-project", executionMode: ExecutionMode.STANDARD, contract: CONTRACT });
      if (!owned.allowed) throw new Error(owned.message);
      expect(f.harness.cp.runs.reassignOwner(owned.value.runId, bound.value, "fixture owner").allowed).toBe(true);
      expect(f.harness.cp.runs.cancel(owned.value.runId, "row").allowed).toBe(true);
      expect(f.harness.cp.bindings.revoke(bound.value.roleKey, "row").allowed).toBe(true);
      expect(f.harness.cp.bindings.bySession(cto).filter((held) => held.status === "ACTIVE")).toEqual([]);

      const refused = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: queuedBootstrapRun(f), sessionId: cto });
      expect(refused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
    });
  });

  it("a session that served a run's bootstrap CTO, its binding since revoked, is never given another role", async () => {
    await withFixture(async (f) => {
      const { runId, sessionId } = boundBootstrapCto(f);
      expect(f.harness.cp.runs.cancel(runId, "row").allowed).toBe(true);
      expect(f.harness.cp.bindings.active(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toBeNull();
      registerProject(f, "after-revoke");
      const promoted = f.harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "after-revoke", sessionId });
      expect(promoted.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_INELIGIBLE_FOR_PROMOTION);
      const reused = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: queuedBootstrapRun(f), sessionId });
      expect(reused.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
      expect(f.harness.cp.bindings.activePrimaryCto("after-revoke")).toBeNull();
    });
  });

  it("two runs get two sessions, and the second run's role cannot land on the first run's session", async () => {
    await withFixture(async (f) => {
      const first = await f.dispatchBootstrap();
      const second = await f.dispatchBootstrap();
      expect(second.ownerSessionId).not.toBe(first.ownerSessionId);
      expect(f.claude.started).toHaveLength(2);
      for (const { runId, ownerSessionId } of [first, second]) {
        expect(f.harness.cp.bindings.active(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toMatchObject({
          sessionId: ownerSessionId,
          bindingGeneration: 1,
        });
        expect(f.harness.cp.bindings.bySession(ownerSessionId)).toHaveLength(1);
      }
      const third = queuedBootstrapRun(f);
      const shared = f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: third, sessionId: first.ownerSessionId });
      expect(shared.reasonCode).toBe(ReasonCode.BOOTSTRAP_CTO_SESSION_NOT_INDEPENDENT);
    });
  });
});

describe("W4 (C1): the BOOTSTRAP_CTO is reclaimed when its run ends", () => {
  it("run_cancel revokes the binding in the cancelling transaction, and the daemon's sweep stops the session", async () => {
    await withFixture(async (f) => {
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      // The startup doctor blocks on a missing trusted GitHub credential, which this row is not about.
      f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const daemon = new Daemon(f.harness.cp, { stateDir: tempDir("acp-bcto-daemon-"), watchdogIntervalMs: 50 });
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
      try {
        // The live run's bootstrap CTO is untouched by the sweep.
        expect(f.harness.cp.sessions.require(ownerSessionId).lifecycle).toBe(SessionLifecycle.READY);

        const cancelled = await f.hermes("run_cancel", { runId, reason: "the owner withdrew the request" });
        expect(cancelled).toMatchObject({ ok: true, value: { state: RunState.CANCELLED } });
        expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
        expect(f.harness.cp.bindings.history(roleKey)).toEqual([expect.objectContaining({ status: "REVOKED" })]);

        await vi.waitFor(
          () => expect(f.harness.cp.sessions.require(ownerSessionId).lifecycle).toBe(SessionLifecycle.STOPPED),
          { timeout: 10_000, interval: 25 },
        );
        const external = f.harness.cp.sessions.require(ownerSessionId).incarnation.split("#", 1)[0]!;
        expect(f.claude.stopped).toEqual([external]);
      } finally {
        await daemon.stop();
      }
    });
  });

  it("the sweep revokes a bootstrap CTO still bound to an ended run, and leaves a live run's alone", async () => {
    await withFixture(async (f) => {
      const live = await f.dispatchBootstrap();
      // An ended run whose bootstrap CTO is bound after the end: the state the in-transaction
      // revocation exists to prevent, which the sweep has to catch whatever produced it.
      const ended = queuedBootstrapRun(f);
      expect(f.harness.cp.runs.cancel(ended, "row").allowed).toBe(true);
      const stray = readySession(f, "stray-bootstrap-cto");
      expect(f.harness.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: ended, sessionId: stray }).allowed).toBe(true);

      const reclaimed = await f.harness.cp.bootstrapCtos.reclaim();
      expect(reclaimed.revoked).toEqual([roleKeyFor(Role.BOOTSTRAP_CTO, { runId: ended })]);
      expect(reclaimed.stopped).toEqual([stray]);
      expect(f.harness.cp.sessions.require(stray).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(f.harness.cp.bindings.active(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: live.runId }))).not.toBeNull();
      expect(f.harness.cp.sessions.require(live.ownerSessionId).lifecycle).toBe(SessionLifecycle.READY);
    });
  });
});

/**
 * #246 C1-04 — a session spawned for a run's BOOTSTRAP_CTO that never got bound, and whose provider
 * stop failed, is not lost: its spawn is recorded for the run before anything can refuse it, and the
 * daemon's reclaim sweep asks the provider to stop it again. A session that holds a role, or one a
 * dispatch for a live run is still staffing, is never stopped.
 */
describe("C1-04: an unbound spawn whose provider stop failed is stopped by the sweep", () => {
  const externalId = (f: Fixture, sessionId: string): string =>
    f.harness.cp.sessions.require(sessionId).incarnation.split("#", 1)[0]!;

  /** The provider refuses the next stop, once, as a timed-out stop would. */
  const failNextStop = (f: Fixture) =>
    vi.spyOn(f.claude, "stopSession").mockRejectedValueOnce(new Error("provider stop timed out"));

  it("probe fails and the first stop fails → run_cancel → the daemon's sweep stops the session", async () => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      f.claude.setNextSessionHealth("UNAVAILABLE");
      const stop = failNextStop(f);

      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      expect(stop).toHaveBeenCalledTimes(1);
      const [spawned] = claudeSessions(f);
      expect(spawned).toMatchObject({ lifecycle: SessionLifecycle.ERROR });
      expect(f.claude.stopped).toEqual([]);
      expect(f.harness.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toEqual([]);

      expect(await f.hermes("run_cancel", { runId, reason: "the owner withdrew the request" }))
        .toMatchObject({ ok: true, value: { state: RunState.CANCELLED } });
      // The startup doctor blocks on a missing trusted GitHub credential, which this row is not about.
      f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const daemon = new Daemon(f.harness.cp, { stateDir: tempDir("acp-bcto-sweep-"), watchdogIntervalMs: 50 });
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
      try {
        await vi.waitFor(
          () => expect(f.harness.cp.sessions.require(spawned!.session_id).lifecycle).toBe(SessionLifecycle.STOPPED),
          { timeout: 10_000, interval: 25 },
        );
        expect(f.claude.stopped).toEqual([externalId(f, spawned!.session_id)]);
      } finally {
        await daemon.stop();
      }
    });
  });

  it("probe fails and the first stop fails while the run is still QUEUED → the sweep stops the session it can never bind", async () => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      f.claude.setNextSessionHealth("UNAVAILABLE");
      failNextStop(f);
      expect(await f.hermes("run_dispatch", { runId })).toMatchObject({ ok: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      const [spawned] = claudeSessions(f);
      expect(spawned).toMatchObject({ lifecycle: SessionLifecycle.ERROR });

      const reclaimed = await f.harness.cp.bootstrapCtos.reclaim();
      expect(reclaimed).toMatchObject({ stopped: [spawned!.session_id], stopFailed: [] });
      expect(f.harness.cp.sessions.require(spawned!.session_id).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(f.claude.stopped).toEqual([externalId(f, spawned!.session_id)]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    });
  });

  it("a spawn the dispatch discarded, whose stop failed, is stopped by the sweep", async () => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      const lifecycle = f.harness.cp.cto;
      const spawn = lifecycle.spawnBootstrapCto.bind(lifecycle);
      vi.spyOn(lifecycle, "spawnBootstrapCto").mockImplementationOnce(async (spawnRunId, runtime) => {
        const spawned = await spawn(spawnRunId, runtime);
        // The run is withdrawn while its bootstrap CTO is spawned, so the dispatch refuses and discards it.
        expect(f.harness.cp.runs.cancel(runId, "withdrawn while its bootstrap CTO was spawned").allowed).toBe(true);
        return spawned;
      });
      failNextStop(f);

      const refused = await f.hermes("run_dispatch", { runId });
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_ALREADY_TERMINAL });
      const [spawned] = claudeSessions(f);
      expect(spawned).toMatchObject({ lifecycle: SessionLifecycle.ERROR });
      expect(f.claude.stopped).toEqual([]);

      const reclaimed = await f.harness.cp.bootstrapCtos.reclaim();
      expect(reclaimed).toMatchObject({ stopped: [spawned!.session_id], stopFailed: [] });
      expect(f.harness.cp.sessions.require(spawned!.session_id).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(f.claude.stopped).toEqual([externalId(f, spawned!.session_id)]);
    });
  });

  it("the sweep leaves alone a session a live run's dispatch is still staffing", async () => {
    await withFixture(async (f) => {
      const runId = await f.createBootstrap();
      const lifecycle = f.harness.cp.cto;
      const spawn = lifecycle.spawnBootstrapCto.bind(lifecycle);
      let swept: Awaited<ReturnType<typeof f.harness.cp.bootstrapCtos.reclaim>> | null = null;
      vi.spyOn(lifecycle, "spawnBootstrapCto").mockImplementationOnce(async (spawnRunId, runtime) => {
        const spawned = await spawn(spawnRunId, runtime);
        // A sweep between the spawn and the bind: READY, unbound, its run QUEUED.
        swept = await f.harness.cp.bootstrapCtos.reclaim();
        return spawned;
      });

      const dispatched = await f.hermes("run_dispatch", { runId });
      expect(dispatched).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerBindingGeneration: 1 } });
      expect(swept).toEqual({ revoked: [], stopped: [], stopFailed: [] });
      expect(f.claude.stopped).toEqual([]);
      const ownerSessionId = f.harness.cp.runs.require(runId).ownerSessionId!;
      expect(f.harness.cp.sessions.require(ownerSessionId).lifecycle).toBe(SessionLifecycle.READY);
    });
  });

  it("the sweep never stops a spawned session that holds a role, whatever its run did", async () => {
    await withFixture(async (f) => {
      registerProject(f, "held-elsewhere");
      const runId = await f.createBootstrap();
      const lifecycle = f.harness.cp.cto;
      const spawn = lifecycle.spawnBootstrapCto.bind(lifecycle);
      vi.spyOn(lifecycle, "spawnBootstrapCto").mockImplementationOnce(async (spawnRunId, runtime) => {
        const spawned = await spawn(spawnRunId, runtime);
        if (!spawned.allowed) return spawned;
        // The unbound spawn is given another role, then its run is withdrawn.
        expect(f.harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "held-elsewhere", sessionId: spawned.value }).allowed).toBe(true);
        expect(f.harness.cp.runs.cancel(runId, "withdrawn while its bootstrap CTO was spawned").allowed).toBe(true);
        return spawned;
      });

      expect(await f.hermes("run_dispatch", { runId })).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_ALREADY_TERMINAL });
      const [spawned] = claudeSessions(f);
      expect(spawned).toMatchObject({ lifecycle: SessionLifecycle.READY });

      const reclaimed = await f.harness.cp.bootstrapCtos.reclaim();
      expect(reclaimed).toEqual({ revoked: [], stopped: [], stopFailed: [] });
      expect(f.harness.cp.sessions.require(spawned!.session_id).lifecycle).toBe(SessionLifecycle.READY);
      expect(f.claude.stopped).toEqual([]);
      expect(f.harness.cp.bindings.activePrimaryCto("held-elsewhere")?.sessionId).toBe(spawned!.session_id);
    });
  });
});

describe("run_create (C1): a PROJECT_BOOTSTRAP run names no project and joins no repository", () => {
  it("refuses a projectId before anything is stored", async () => {
    await withFixture(async (f) => {
      registerProject(f, "existing-project");
      const refused = await f.hermes("run_create", {
        kind: RunKind.PROJECT_BOOTSTRAP,
        executionMode: ExecutionMode.STANDARD,
        projectId: "existing-project",
        contract: CONTRACT,
      });
      expect(refused).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
        evidence: { refusal: "BOOTSTRAP_PROJECT_SUPPLIED" },
      });
      expect(f.harness.cp.runs.list()).toEqual([]);
      expect(f.harness.cp.audit.byKind("RUN_CREATED")).toEqual([]);
    });
  });

  it("refuses repositories before anything is stored", async () => {
    await withFixture(async (f) => {
      const repository = await f.harness.cp.repositories.registerTemporary(makeRepo(), "some-run");
      if (!repository.allowed) throw new Error(repository.message);
      const refused = await f.hermes("run_create", {
        kind: RunKind.PROJECT_BOOTSTRAP,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      expect(refused).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
        evidence: { refusal: "BOOTSTRAP_REPOSITORIES_SUPPLIED" },
      });
      expect(f.harness.cp.runs.list()).toEqual([]);
      expect(f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_repositories`)?.n).toBe(0);
    });
  });
});

/**
 * #246 C1 — "Claude Opus, never substituted" holds after dispatch too. A BOOTSTRAP_CTO and a WORKER
 * have a fixed runtime; continuity may move one to another Claude Opus session, never to another
 * provider or model. When Claude cannot cover it, the role is uncovered and the daemon's existing
 * pause path pauses its run; the binding is not replaced. Driven through the daemon's own
 * reconciliation, with a GPT provider that could cover the role standing by.
 */
describe("C1: continuity never substitutes a fixed role runtime", () => {
  const healthyGpt = (f: Fixture): CapacityReading => ({
    provider: "gpt",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: f.harness.clock.nowIso(),
    source: "fixed-runtime-fixture",
    buckets: [{ id: "gpt-window", remainingPercent: 90, resetAt: null, capabilities: ["ceo", "cto", "blind-review", "worker"] }],
  });

  /**
   * A GPT provider able to cover both fixed roles, registered the way the shipped composition
   * registers Codex (one adapter for every role), and a daemon to reconcile.
   */
  const standby = (f: Fixture) => {
    const gpt = new ProviderDouble(f.harness.clock, "gpt");
    gpt.setCapacity(healthyGpt(f));
    f.harness.cp.providers.register(gpt);
    f.harness.cp.providers.registerForRole(f.claude, Role.WORKER);
    const daemon = new Daemon(f.harness.cp, { stateDir: tempDir("acp-bcto-continuity-") });
    return { gpt, daemon };
  };

  const loseClaude = (f: Fixture): void => {
    f.claude.setCapacity({
      provider: "claude",
      sensorHealth: "HEALTHY",
      runtimeHealth: "UNAVAILABLE",
      observedAt: f.harness.clock.nowIso(),
      source: "fixed-runtime-fixture",
      buckets: [],
    });
  };

  /** A Claude reading of one five-hour window, `minutesAgo` old, covering every Claude capability. */
  const claudeReading = (f: Fixture, remainingPercent: number, minutesAgo = 0): CapacityReading => {
    const now = f.harness.clock.now().getTime();
    return {
      provider: "claude",
      sensorHealth: "HEALTHY",
      runtimeHealth: "HEALTHY",
      observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
      source: "fixed-runtime-fixture",
      buckets: [{
        id: "five_hour",
        remainingPercent,
        resetAt: new Date(now + 2 * 60 * 60_000).toISOString(),
        capabilities: ["ceo", "cto", "blind-review", "worker"],
      }],
    };
  };

  /**
   * The WORKER role's burn comes only from readings taken through its own probe (#512), and a
   * Claude WORKER allocation is refused CONSERVE until one has been taken: one earlier reading.
   */
  const primeClaudeWorkerBurn = async (f: Fixture): Promise<void> => {
    f.claude.setCapacity(claudeReading(f, 81, 3));
    await f.harness.cp.capacity.refreshForRole("claude", Role.WORKER);
    f.claude.setCapacity(claudeReading(f, 80));
  };

  /** Every session that ever held the role, by its binding-time runtime. */
  const holders = (f: Fixture, roleKey: string) =>
    f.harness.cp.bindings.history(roleKey).map((held) => {
      const session = f.harness.cp.sessions.require(held.boundSessionId);
      return { generation: held.bindingGeneration, provider: session.provider, model: session.model, status: held.status };
    });

  /** A RUNNING execution on a Claude Opus worker, as task_worker_provision would leave it. */
  const runningWorker = (f: Fixture, runId: string, ownerBindingGeneration: number) => {
    const submitted = f.harness.cp.tasks.submit(runId, [{ key: "impl", title: "implement", category: "implementation" }]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const taskId = submitted.value[0]!.taskId;
    const workerSessionId = bindWorkerForTask(f.harness.cp, taskId, { provider: "claude", model: "opus" });
    const started = f.harness.cp.tasks.startExecution({
      runId, taskId, ownerBindingGeneration, workerSessionId, provider: "claude", model: "opus",
    });
    if (!started.allowed) throw new Error(started.message);
    return { taskId, workerSessionId, roleKey: roleKeyFor(Role.WORKER, { taskId }) };
  };

  it("BOOTSTRAP_CTO, Claude coverage lost: no GPT substitution; the role is uncovered, the run paused, the binding not replaced", async () => {
    await withFixture(async (f) => {
      const { gpt, daemon } = standby(f);
      const { runId } = await f.dispatchBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      loseClaude(f);

      const report = await daemon.reconcileContinuity("claude coverage lost");
      expect(gpt.started).toEqual([]);
      expect(holders(f, roleKey)).toEqual([{ generation: 1, provider: "claude", model: "opus", status: "REVOKED" }]);
      expect(report?.plan.uncovered).toContain(roleKey);
      expect(report?.pausedRuns).toContainEqual(expect.objectContaining({ runId, roleKey }));
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
    });
  });

  it("WORKER, Claude coverage lost: no GPT substitution; the role is uncovered, the run paused, the binding not replaced", async () => {
    await withFixture(async (f) => {
      const { gpt, daemon } = standby(f);
      const { runId } = await f.dispatchBootstrap();
      const worker = runningWorker(f, runId, 1);
      loseClaude(f);

      const report = await daemon.reconcileContinuity("claude coverage lost");
      expect(gpt.started).toEqual([]);
      expect(holders(f, worker.roleKey)).toEqual([{ generation: 1, provider: "claude", model: "opus", status: "REVOKED" }]);
      expect(report?.plan.uncovered).toContain(worker.roleKey);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
    });
  });

  // C1b (C1-02): a BOOTSTRAP_CTO has no Claude-to-Claude replacement to keep on Opus — continuity
  // constitutes none for it (see the C1-02 row below) — so only the WORKER row remains here.
  it.each([Role.WORKER] as const)(
    "%s, Claude to Claude: the replacement stays on Claude Opus, never the adapter's default model",
    async (role) => {
      // The adapter's default for the role must not be Opus, or a replacement that fell back to it
      // would pass too. Claude's shipped WORKER default is Sonnet already.
      await withFixture(async (f) => {
        expect(f.claude.defaultModels.worker).not.toBe("opus");
        const { gpt, daemon } = standby(f);
        const { runId } = await f.dispatchBootstrap();
        const worker = runningWorker(f, runId, 1);
        await primeClaudeWorkerBurn(f);
        const roleKey = worker.roleKey;
        expect(roleKey).toBe(roleKeyFor(role, { taskId: worker.taskId }));
        // The incumbent's runtime is gone; Claude still covers the role.
        f.harness.cp.sessions.transition(worker.workerSessionId, SessionLifecycle.ERROR, "process gone");

        const report = await daemon.reconcileContinuity("incumbent runtime gone");
        expect(report?.reassigned).toContainEqual(expect.objectContaining({ roleKey, provider: "claude", toGeneration: 2 }));
        expect(holders(f, roleKey)).toEqual([
          { generation: 1, provider: "claude", model: "opus", status: "REVOKED" },
          { generation: 2, provider: "claude", model: "opus", status: "ACTIVE" },
        ]);
        expect(gpt.started).toEqual([]);
        expect(f.claude.started.at(-1)).toMatchObject({ model: "opus" });
      });
    },
  );

  it("a plan that named another provider anyway is refused before anything starts, and the run is paused", async () => {
    await withFixture(async (f) => {
      const { gpt, daemon } = standby(f);
      const { runId } = await f.dispatchBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      loseClaude(f);
      // The planner's own restriction stood down for this pass: it hands the role to GPT.
      const plan = f.harness.cp.continuity.computeCoveragePlan.bind(f.harness.cp.continuity);
      vi.spyOn(f.harness.cp.continuity, "computeCoveragePlan").mockImplementation(() => {
        const computed = plan();
        return {
          ...computed,
          uncovered: computed.uncovered.filter((key) => key !== roleKey),
          assignments: [
            ...computed.assignments.filter((assignment) => assignment.roleKey !== roleKey),
            { roleKey, provider: "gpt", reason: "fallback" },
          ],
        };
      });

      const report = await daemon.reconcileContinuity("claude coverage lost");
      // C1b (C1-02): refused before any provider is even considered — a bootstrap CTO is never
      // replaced, by another provider or by its own.
      expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.BOOTSTRAP_CTO_NOT_REPLACEABLE });
      expect(gpt.started).toEqual([]);
      expect(holders(f, roleKey)).toEqual([{ generation: 1, provider: "claude", model: "opus", status: "REVOKED" }]);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
    });
  });

  it("C1-02: a BOOTSTRAP_CTO whose runtime is gone is never replaced, by Claude or anything else: revoked, run paused, no new session", async () => {
    await withFixture(async (f) => {
      const { gpt, daemon } = standby(f);
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      const actor = actorOf(f, f.harness.cp.bindings.active(roleKey)!.assignmentId);
      const spawned = f.claude.started.length;
      // The incumbent's row is not READY; Claude still covers the role. Before C1b this failed the
      // role over to a fresh Claude session that could never authenticate (C1-02).
      f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.ERROR, "process gone");

      const report = await daemon.reconcileContinuity("incumbent runtime gone");
      expect(report?.reassigned).toEqual([]);
      expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.BOOTSTRAP_CTO_NOT_REPLACEABLE });
      expect(f.claude.started).toHaveLength(spawned);
      expect(gpt.started).toEqual([]);
      expect(holders(f, roleKey)).toEqual([{ generation: 1, provider: "claude", model: "opus", status: "REVOKED" }]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, ownerSessionId, ownerBindingGeneration: 1 });
      // The actor is not retired: the role's conversation is still the one that may come back.
      expect(f.harness.cp.db.get<{ retired_at: string | null }>(
        `SELECT retired_at FROM conversational_actors WHERE actor_id = ?`, [actor!],
      )?.retired_at).toBeNull();
    });
  });

  it("C1-02: a Claude outage revokes and pauses but never marks the bootstrap CTO's session ERROR; its row, actor and conversation stay", async () => {
    await withFixture(async (f) => {
      const { daemon } = standby(f);
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
      const before = f.harness.cp.sessions.require(ownerSessionId);
      loseClaude(f);

      await daemon.reconcileContinuity("claude coverage lost");
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.BLOCKED);
      expect(f.harness.cp.sessions.require(ownerSessionId)).toMatchObject({
        lifecycle: SessionLifecycle.READY,
        incarnation: before.incarnation,
        workdir: before.workdir,
      });
      // Nothing was recorded as owed to a claim: no claim can create a bootstrap CTO.
      expect(f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?`, [roleKey],
      )?.n).toBe(0);
    });
  });
});
