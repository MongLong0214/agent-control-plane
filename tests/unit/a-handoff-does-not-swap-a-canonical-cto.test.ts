import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { startLocalMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TEST_OWNER, fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { callMcpToolOverSocket, claimLaunchedCredential } from "../helpers/mcp-socket.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 C1-05 — no path swaps a canonical CTO. A canonical CTO is the interactive runtime the
 * canonical self-claim bound; its role recovers only when its own conversation claims it again, so
 * an ordinary handoff — `handoff_submit` preparing a spawned replacement, `handoff_ack` switching to
 * it with `conversation: "REPLACED"` and stopping the original — must refuse it, at preparation,
 * after preparation's await, and at acknowledgement. A provisioned (non-canonical) CTO's handoff is
 * unchanged.
 *
 * Every row goes through `cto.mcp.sock`: the outgoing CTO authenticates with its session credential,
 * the incoming one with the credential its launch channel issued.
 */
const TOKEN = "canonical-handoff-token";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

const HANDOFF: HandoffPackage = {
  projectStatus: "ACTIVE/HEALTHY",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "continue",
};

type Credential = { sessionId: string; sessionSecret: string };

const CONTRACT: TaskContract = {
  goal: "a run for the project's CTO",
  why: "a CTO the handoff left in place must still take work",
  scope: [],
  nonGoals: [],
  acceptance: ["tests pass"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const fixture = async () => {
  const h = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(h);
  // The provider a canonical CTO's dispatch is admitted against; it launched none of them.
  const claude = new TestProductionAdapter(h.clock, "claude");
  h.cp.providers.register(claude);
  const launch = await startSessionLaunchChannel(tempDir("acp-hof-launch-"));
  h.cp.cto.attach({ sessionLaunch: launch });
  // The CEO the Hermes socket authenticates, for cto_replace, run_create and run_dispatch.
  const ceo = h.cp.sessions.create({ provider: "scripted", model: "handoff-ceo" });
  const ceoSecret = ceo.sessionSecret;
  if (!ceoSecret) throw new Error("the CEO session has no credential");
  h.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const boundCeo = h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!boundCeo.allowed) throw new Error(boundCeo.message);
  const listeners = await startLocalMcpListeners(h.cp, tempDir("acp-hof-mcp-"), TOKEN);
  const [hermesSocket, ctoSocket] = listeners.socketPaths;
  if (!hermesSocket || !ctoSocket) throw new Error("the MCP listeners were not started");
  let keys = 0;
  const cto = (credential: Credential, name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(ctoSocket, { token: TOKEN, ...credential }, name, { idempotencyKey: `hof-${++keys}`, ...args });
  const hermes = (name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(
      hermesSocket,
      { token: TOKEN, sessionId: ceo.sessionId, sessionSecret: ceoSecret },
      name,
      { idempotencyKey: `hof-${++keys}`, ...args },
    );
  /** The credential a spawned session's launch channel issued, claimed under its provider id. */
  const launched = (sessionId: string): Promise<Credential> =>
    claimLaunchedCredential(launch.socketPath, h.cp.sessions.require(sessionId).incarnation.split("#", 1)[0]!);
  /** run_create then run_dispatch for the project, over the Hermes socket as the CEO. */
  const dispatchRun = async () => {
    const created = await hermes("run_create", {
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (created["ok"] !== true) throw new Error(`run_create refused: ${JSON.stringify(created)}`);
    const runId = (created["value"] as { runId: string }).runId;
    return { runId, dispatched: await hermes("run_dispatch", { runId }) };
  };
  return {
    h,
    claude,
    projectId,
    cto,
    hermes,
    launched,
    dispatchRun,
    close: async () => {
      await listeners.close();
      await launch.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

const withFixture = async (body: (f: Fixture) => Promise<void>): Promise<void> => {
  const f = await fixture();
  try {
    await body(f);
  } finally {
    await f.close();
  }
};

const liveToken = (): string => {
  const token = readProcessStartToken(process.pid);
  if (token === null) throw new Error("this platform cannot read the test process's own start token");
  return token;
};

/**
 * The project's PRIMARY_CTO bound the way the canonical self-claim binds one: a `claude` /
 * `claude-cli` runtime row carrying this test process's pid and start token, and an actor whose
 * lifetime target is a `SELF_CLAIM_EXECUTOR_KIND` conversation.
 */
const bindCanonical = (h: Harness, projectId: string) => {
  const session = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: liveToken() });
  if (!session.sessionSecret) throw new Error("the canonical session has no credential");
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId,
    sessionId: session.sessionId,
    mode: "PREFERRED",
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "canonical-handoff", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);
  return { binding: bound.value, credential: { sessionId: session.sessionId, sessionSecret: session.sessionSecret } };
};

/** A provisioned PRIMARY_CTO: spawned by the lifecycle, its credential issued through the launch channel. */
const provisionedCto = async (f: Fixture) => {
  const bound = await f.h.cp.cto.ensurePrimaryCto(f.projectId, "handoff fixture");
  if (!bound.allowed) throw new Error(bound.message);
  return { binding: bound.value, credential: await f.launched(bound.value.sessionId) };
};

const actorOf = (h: Harness, assignmentId: string): string | undefined =>
  h.cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`, [assignmentId])?.actor_id;

/**
 * The holder's actor carries a canonical self-claim target from here on, under its current binding
 * and generation. Raw state: it is how a PENDING handoff whose outgoing holder is canonical — what
 * `prepareSwitchover` wrote for a canonical CTO before this guard — is reproduced, since the guarded
 * preparation no longer writes one.
 */
const becomeCanonical = (h: Harness, assignmentId: string): void => {
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`tb_fixture_${assignmentId}`, actorOf(h, assignmentId)!, SELF_CLAIM_EXECUTOR_KIND, CONVERSATION, sha256(CONVERSATION), h.clock.nowIso()],
  );
};

/** Delivers the handoff's envelope the way the outbox worker does: claimed, then marked SENT. */
const deliver = (h: Harness, handoffId: string) => {
  const envelope = h.cp.outbox.byIdempotencyKey(`handoff:${handoffId}`);
  if (!envelope) throw new Error("no handoff envelope");
  const claimed = h.cp.outbox.claimDeliverable().find((message) => message.messageId === envelope.messageId);
  if (!claimed) throw new Error("the handoff envelope was not deliverable");
  expect(h.cp.outbox.markSent(envelope.messageId, claimed.claimToken).allowed).toBe(true);
  return envelope;
};

const handoffCount = (h: Harness): number => h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM handoffs`)?.n ?? -1;
const sessionCount = (h: Harness): number => h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)?.n ?? -1;

describe("C1-05: an ordinary handoff never swaps a canonical CTO", () => {
  it("handoff_submit from a canonical CTO is refused before a replacement is spawned", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = bindCanonical(f.h, f.projectId);
      const actor = actorOf(f.h, binding.assignmentId);
      const sessions = sessionCount(f.h);

      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      expect(submitted).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE,
        evidence: { projectId: f.projectId, sessionId: credential.sessionId, bindingGeneration: binding.bindingGeneration },
      });
      expect(sessionCount(f.h)).toBe(sessions);
      expect(handoffCount(f.h)).toBe(0);
      expect(f.h.cp.sessions.require(credential.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(f.h.cp.bindings.activePrimaryCto(f.projectId)).toMatchObject({
        assignmentId: binding.assignmentId,
        sessionId: credential.sessionId,
        bindingGeneration: binding.bindingGeneration,
      });
      expect(actorOf(f.h, binding.assignmentId)).toBe(actor);
    });
  });

  it("preparation asks again after its await: a holder that became canonical while the replacement spawned is refused, and the replacement stopped", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = await provisionedCto(f);
      const start = f.h.scripted.startSession.bind(f.h.scripted);
      vi.spyOn(f.h.scripted, "startSession").mockImplementationOnce(async (spec) => {
        const handle = await start(spec);
        becomeCanonical(f.h, binding.assignmentId);
        return handle;
      });
      const sessions = sessionCount(f.h);
      const existing = f.h.cp.db.all<{ session_id: string }>(`SELECT session_id FROM sessions`).map((row) => row.session_id);

      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      expect(submitted).toMatchObject({ ok: false, reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE });
      expect(handoffCount(f.h)).toBe(0);
      // The replacement it spawned is stopped, not left running; the holder never drained.
      const incoming = f.h.cp.db.all<{ session_id: string; lifecycle: string }>(
        `SELECT session_id, lifecycle FROM sessions ORDER BY created_at`,
      ).filter((row) => !existing.includes(row.session_id));
      expect(sessionCount(f.h)).toBe(sessions + 1);
      expect(incoming).toEqual([expect.objectContaining({ lifecycle: SessionLifecycle.STOPPED })]);
      expect(f.h.cp.sessions.require(credential.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(f.h.cp.bindings.activePrimaryCto(f.projectId)?.assignmentId).toBe(binding.assignmentId);
    });
  });

  it("handoff_ack is refused when the outgoing holder is canonical: the original session is not STOPPED and the actor is unchanged", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = await provisionedCto(f);
      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      expect(submitted).toMatchObject({ ok: true });
      const { handoffId, incomingSessionId } = submitted["value"] as { handoffId: string; incomingSessionId: string };
      const envelope = deliver(f.h, handoffId);
      becomeCanonical(f.h, binding.assignmentId);
      const actor = actorOf(f.h, binding.assignmentId);

      const acknowledged = await f.cto(await f.launched(incomingSessionId), "handoff_ack", {
        handoffId,
        messageId: envelope.messageId,
        payloadDigest: envelope.payloadDigest,
        bindingGeneration: envelope.bindingGeneration,
      });
      expect(acknowledged).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE,
        evidence: { handoffId, sessionId: credential.sessionId, bindingGeneration: binding.bindingGeneration },
      });
      expect(f.h.cp.sessions.require(credential.sessionId).lifecycle).not.toBe(SessionLifecycle.STOPPED);
      expect(f.h.cp.bindings.activePrimaryCto(f.projectId)).toMatchObject({
        assignmentId: binding.assignmentId,
        sessionId: credential.sessionId,
        bindingGeneration: binding.bindingGeneration,
      });
      expect(actorOf(f.h, binding.assignmentId)).toBe(actor);
      // C1-R1 — and the handoff is not left PENDING for a holder it can never replace.
      expect(f.h.cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [handoffId])?.status).toBe("REJECTED");
    });
  });

  it("a provisioned CTO's handoff still completes: handoff_submit → delivered → handoff_ack switches the role and stops the original", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = await provisionedCto(f);
      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      expect(submitted).toMatchObject({ ok: true });
      const { handoffId, incomingSessionId } = submitted["value"] as { handoffId: string; incomingSessionId: string };
      const envelope = deliver(f.h, handoffId);

      const acknowledged = await f.cto(await f.launched(incomingSessionId), "handoff_ack", {
        handoffId,
        messageId: envelope.messageId,
        payloadDigest: envelope.payloadDigest,
        bindingGeneration: envelope.bindingGeneration,
      });
      expect(acknowledged).toMatchObject({ ok: true, value: { sessionId: incomingSessionId, bindingGeneration: binding.bindingGeneration + 1 } });
      expect(f.h.cp.bindings.activePrimaryCto(f.projectId)?.sessionId).toBe(incomingSessionId);
      expect(f.h.cp.sessions.require(credential.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    });
  });
});

/**
 * A PRIMARY_CTO on a live runtime row (this test process's pid and start token, as a canonical
 * CTO's is) bound without a canonical target: an ordinary holder, so a replacement or handoff is
 * prepared for it, until `becomeCanonical` makes it the canonical CTO.
 */
const liveHolder = (h: Harness, projectId: string) => {
  const session = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: liveToken() });
  if (!session.sessionSecret) throw new Error("the holder session has no credential");
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "fixture holder").allowed).toBe(true);
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId, mode: "PREFERRED" });
  if (!bound.allowed) throw new Error(bound.message);
  return { binding: bound.value, credential: { sessionId: session.sessionId, sessionSecret: session.sessionSecret } };
};

const lifecycleOf = (h: Harness, sessionId: string) => h.cp.sessions.require(sessionId).lifecycle;
const handoffStatus = (h: Harness, handoffId: string) =>
  h.cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [handoffId])?.status;
const outboxCount = (h: Harness): number => h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)?.n ?? -1;

/** Whether the scripted provider still has the session: a stop addressed to its own id removes it. */
const providerHas = async (h: Harness, sessionId: string): Promise<boolean> => {
  const session = h.cp.sessions.require(sessionId);
  return (await h.scripted.probeSession({
    externalSessionId: session.incarnation.split("#", 1)[0]!,
    provider: session.provider,
    model: session.model,
    effort: null,
    pid: null,
  })) !== "UNAVAILABLE";
};

/**
 * A holder that `handoff_submit` drained for a spawned replacement, whose envelope was delivered,
 * and which then became canonical: the PENDING handoff a build before the preparation guard left.
 */
const pendingCanonicalHandoff = async (f: Fixture, options: { deliver?: boolean } = {}) => {
  const holder = liveHolder(f.h, f.projectId);
  const submitted = await f.cto(holder.credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
  expect(submitted).toMatchObject({ ok: true });
  const { handoffId, incomingSessionId } = submitted["value"] as { handoffId: string; incomingSessionId: string };
  const envelope = options.deliver === false ? null : deliver(f.h, handoffId);
  becomeCanonical(f.h, holder.binding.assignmentId);
  expect(lifecycleOf(f.h, holder.credential.sessionId)).toBe(SessionLifecycle.DRAINING);
  expect(lifecycleOf(f.h, incomingSessionId)).toBe(SessionLifecycle.READY);
  return { ...holder, handoffId, incomingSessionId, envelope, actor: actorOf(f.h, holder.binding.assignmentId) };
};

/** The canonical holder kept its role, binding, generation and actor, and takes work again. */
const expectHolderRestored = async (f: Fixture, pending: Awaited<ReturnType<typeof pendingCanonicalHandoff>>) => {
  expect(lifecycleOf(f.h, pending.credential.sessionId)).toBe(SessionLifecycle.READY);
  expect(handoffStatus(f.h, pending.handoffId)).toBe("REJECTED");
  await vi.waitFor(() => expect(lifecycleOf(f.h, pending.incomingSessionId)).toBe(SessionLifecycle.STOPPED), {
    timeout: 10_000,
    interval: 25,
  });
  expect(await providerHas(f.h, pending.incomingSessionId)).toBe(false);
  expect(f.h.cp.bindings.activePrimaryCto(f.projectId)).toMatchObject({
    assignmentId: pending.binding.assignmentId,
    sessionId: pending.credential.sessionId,
    bindingGeneration: pending.binding.bindingGeneration,
  });
  expect(actorOf(f.h, pending.binding.assignmentId)).toBe(pending.actor);
  const { dispatched } = await f.dispatchRun();
  expect(dispatched).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerSessionId: pending.credential.sessionId } });
};

/**
 * #1071 round 2, ACP246-C1-R1 — refusing to swap a canonical CTO must not strand it DRAINING. A
 * replacement request is refused before anything drains or spawns; a handoff left PENDING for a
 * holder that is (or became) canonical — including one a build before the preparation guard left —
 * is withdrawn: the handoff is closed REJECTED, the holder is READY again and the replacement is
 * stopped, by a refused acknowledgement or by the daemon's sweep.
 */
describe("C1-R1: a canonical CTO is never left draining", () => {
  it("cto_replace on a canonical holder is refused before anything drains or spawns, and a run still dispatches to it", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = bindCanonical(f.h, f.projectId);
      const sessions = sessionCount(f.h);
      const outbox = outboxCount(f.h);

      const refused = await f.hermes("cto_replace", { projectId: f.projectId, reason: "replace the canonical CTO" });
      expect(refused).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE,
        evidence: { projectId: f.projectId, sessionId: credential.sessionId, bindingGeneration: binding.bindingGeneration },
      });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.READY);
      expect(sessionCount(f.h)).toBe(sessions);
      expect(outboxCount(f.h)).toBe(outbox);
      expect(f.h.cp.outbox.byIdempotencyKey(`drain:${f.projectId}:${binding.bindingGeneration}`)).toBeNull();
      expect(f.h.cp.audit.byKind("CTO_REPLACEMENT_REQUESTED")).toEqual([]);

      const { dispatched } = await f.dispatchRun();
      expect(dispatched).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerSessionId: credential.sessionId } });
    });
  });

  it("a pending handoff whose holder became canonical: handoff_ack is refused, the handoff REJECTED, the holder READY, the replacement STOPPED, and a run dispatches to the holder", async () => {
    await withFixture(async (f) => {
      const pending = await pendingCanonicalHandoff(f);

      const acknowledged = await f.cto(await f.launched(pending.incomingSessionId), "handoff_ack", {
        handoffId: pending.handoffId,
        messageId: pending.envelope!.messageId,
        payloadDigest: pending.envelope!.payloadDigest,
        bindingGeneration: pending.envelope!.bindingGeneration,
      });
      expect(acknowledged).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE,
        evidence: { handoffId: pending.handoffId, sessionId: pending.credential.sessionId },
      });
      await expectHolderRestored(f, pending);
    });
  });

  /** A daemon on the fixture's control plane; the watchdog interval decides whether its timer runs in the test. */
  const startDaemon = async (f: Fixture, watchdogIntervalMs: number): Promise<Daemon> => {
    // The startup doctor blocks on a missing trusted GitHub credential, which these rows are not about.
    f.h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const daemon = new Daemon(f.h.cp, { stateDir: tempDir("acp-hof-daemon-"), watchdogIntervalMs });
    const started = await daemon.start();
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
    return daemon;
  };

  it("a pending canonical handoff a pre-fix daemon left, nobody acknowledging it, is withdrawn when the daemon starts", async () => {
    await withFixture(async (f) => {
      const pending = await pendingCanonicalHandoff(f);
      // No watchdog tick inside this test: only the startup pass can settle it.
      const daemon = await startDaemon(f, 600_000);
      try {
        expect(handoffStatus(f.h, pending.handoffId)).toBe("REJECTED");
        await expectHolderRestored(f, pending);
      } finally {
        await daemon.stop();
      }
    });
  });

  it("a canonical handoff left pending while the daemon runs is withdrawn by its watchdog sweep", async () => {
    await withFixture(async (f) => {
      const daemon = await startDaemon(f, 50);
      try {
        const pending = await pendingCanonicalHandoff(f, { deliver: false });
        await vi.waitFor(() => expect(handoffStatus(f.h, pending.handoffId)).toBe("REJECTED"), { timeout: 10_000, interval: 25 });
        await expectHolderRestored(f, pending);
      } finally {
        await daemon.stop();
      }
    });
  });

  it("a holder a cto_replace drained, which became canonical with no handoff, is returned to READY by the sweep", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = liveHolder(f.h, f.projectId);
      expect(await f.hermes("cto_replace", { projectId: f.projectId, reason: "replace the CTO" })).toMatchObject({ ok: true });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
      becomeCanonical(f.h, binding.assignmentId);

      const settled = await f.h.cp.cto.settleCanonicalSwitchovers();
      expect(settled).toEqual({
        withdrawn: [{ projectId: f.projectId, handoffIds: [], replacements: [], restored: true }],
        stopFailed: [],
      });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.READY);
      const { dispatched } = await f.dispatchRun();
      expect(dispatched).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerSessionId: credential.sessionId } });
    });
  });

  it("the sweep leaves a suspended project's canonical CTO DRAINING: that drain is the suspension's", async () => {
    await withFixture(async (f) => {
      const { credential } = bindCanonical(f.h, f.projectId);
      // The state a project suspension leaves before its provider stop.
      expect(f.h.cp.projects.setSuspended(f.projectId, true, true).allowed).toBe(true);
      expect(f.h.cp.sessions.transition(credential.sessionId, SessionLifecycle.DRAINING, "project suspended").allowed).toBe(true);

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({ withdrawn: [], stopFailed: [] });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
    });
  });

  it("the withdrawal never marks or stops a replacement that holds a role", async () => {
    await withFixture(async (f) => {
      const pending = await pendingCanonicalHandoff(f);
      // The replacement has taken another project's PRIMARY_CTO since the handoff was prepared.
      const manifest = fixtureManifest("other-project");
      expect(f.h.cp.projects.register({
        projectId: "other-project",
        name: "other-project",
        manifest,
        authorization: f.h.cp.manifestAuthorizationForTests(manifest),
      }).allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "other-project", sessionId: pending.incomingSessionId }).allowed)
        .toBe(true);

      const settled = await f.h.cp.cto.settleCanonicalSwitchovers();
      expect(settled).toEqual({
        withdrawn: [{ projectId: f.projectId, handoffIds: [pending.handoffId], replacements: [], restored: true }],
        stopFailed: [],
      });
      expect(handoffStatus(f.h, pending.handoffId)).toBe("REJECTED");
      expect(lifecycleOf(f.h, pending.incomingSessionId)).toBe(SessionLifecycle.READY);
      expect(await providerHas(f.h, pending.incomingSessionId)).toBe(true);
      expect(f.h.cp.bindings.activePrimaryCto("other-project")?.sessionId).toBe(pending.incomingSessionId);
    });
  });

  it("the sweep leaves a provisioned CTO's pending handoff alone", async () => {
    await withFixture(async (f) => {
      const { credential } = await provisionedCto(f);
      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      const { handoffId, incomingSessionId } = submitted["value"] as { handoffId: string; incomingSessionId: string };

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({ withdrawn: [], stopFailed: [] });
      expect(handoffStatus(f.h, handoffId)).toBe("PENDING");
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
      expect(lifecycleOf(f.h, incomingSessionId)).toBe(SessionLifecycle.READY);
    });
  });

  it("a provisioned CTO's replacement still completes: cto_replace → handoff_submit → delivered → handoff_ack, and a run dispatches to the new CTO", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = await provisionedCto(f);
      expect(await f.hermes("cto_replace", { projectId: f.projectId, reason: "rotate the CTO" }))
        .toMatchObject({ ok: true, value: { draining: true } });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      expect(submitted).toMatchObject({ ok: true });
      const { handoffId, incomingSessionId } = submitted["value"] as { handoffId: string; incomingSessionId: string };
      const envelope = deliver(f.h, handoffId);

      const acknowledged = await f.cto(await f.launched(incomingSessionId), "handoff_ack", {
        handoffId,
        messageId: envelope.messageId,
        payloadDigest: envelope.payloadDigest,
        bindingGeneration: envelope.bindingGeneration,
      });
      expect(acknowledged).toMatchObject({ ok: true, value: { sessionId: incomingSessionId, bindingGeneration: binding.bindingGeneration + 1 } });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.STOPPED);
      expect(handoffStatus(f.h, handoffId)).toBe("ACKED");
      expect(f.h.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: f.projectId }))?.sessionId).toBe(incomingSessionId);
      const { dispatched } = await f.dispatchRun();
      expect(dispatched).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerSessionId: incomingSessionId } });
    });
  });
});

/**
 * #1071 round 3, ACP246-C1-R2 — the settlement withdraws only a drain it can attribute to a
 * switchover: a PENDING handoff from the holder, or a replacement request recorded after the
 * holder's current drain. A suspension's drain — its RECOVERY package is written before the drain
 * and the provider stop — is the suspension's until its shutdown and revocation settle, whatever
 * resume says; so is any drain nothing attributes.
 */
describe("C1-R2: the settlement never clears a drain it cannot attribute to a switchover", () => {
  /** The owner's suspension, started and held at its provider stop until `release`. */
  const heldSuspension = async (f: Fixture) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.spyOn(f.claude, "stopSession").mockImplementationOnce(async () => {
      await held;
    });
    const suspension = f.h.cp.cto.suspendProject(f.projectId, true, "the owner suspends the project", TEST_OWNER);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 10_000, interval: 10 });
    return { suspension, release };
  };

  it("a suspension held at its provider stop, then cto_resume: the settlement leaves the holder DRAINING, dispatch stays QUEUED, and the stop completes with nothing stranded", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = bindCanonical(f.h, f.projectId);
      const { suspension, release } = await heldSuspension(f);
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
      expect(await f.hermes("cto_resume", { projectId: f.projectId })).toMatchObject({ ok: true });

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({ withdrawn: [], stopFailed: [] });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
      const { runId, dispatched } = await f.dispatchRun();
      expect(dispatched).toMatchObject({ ok: false, reasonCode: ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING });
      expect(f.h.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });

      release();
      expect(await suspension).toMatchObject({ allowed: true });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.STOPPED);
      expect(f.h.cp.bindings.active(binding.roleKey)).toBeNull();
      expect(f.h.cp.runs.require(runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    });
  });

  it("a suspension layered on a pending canonical handoff: the handoff is withdrawn and its replacement stopped, but the holder stays DRAINING until the suspension settles", async () => {
    await withFixture(async (f) => {
      const pending = await pendingCanonicalHandoff(f);
      const { suspension, release } = await heldSuspension(f);
      expect(await f.hermes("cto_resume", { projectId: f.projectId })).toMatchObject({ ok: true });

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({
        withdrawn: [{ projectId: f.projectId, handoffIds: [pending.handoffId], replacements: [pending.incomingSessionId], restored: false }],
        stopFailed: [],
      });
      expect(handoffStatus(f.h, pending.handoffId)).toBe("REJECTED");
      expect(lifecycleOf(f.h, pending.incomingSessionId)).toBe(SessionLifecycle.STOPPED);
      expect(lifecycleOf(f.h, pending.credential.sessionId)).toBe(SessionLifecycle.DRAINING);

      release();
      expect(await suspension).toMatchObject({ allowed: true });
      expect(lifecycleOf(f.h, pending.credential.sessionId)).toBe(SessionLifecycle.STOPPED);
      expect(f.h.cp.bindings.active(pending.binding.roleKey)).toBeNull();
    });
  });

  it("a drain no switchover record explains is left alone", async () => {
    await withFixture(async (f) => {
      const { credential } = bindCanonical(f.h, f.projectId);
      // A drain from a writer that left no switchover record.
      expect(f.h.cp.sessions.transition(credential.sessionId, SessionLifecycle.DRAINING, "an unattributed drain").allowed).toBe(true);

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({ withdrawn: [], stopFailed: [] });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
    });
  });

  it("a replacement record older than the holder's current drain does not explain it", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = liveHolder(f.h, f.projectId);
      expect(await f.hermes("cto_replace", { projectId: f.projectId, reason: "replace the CTO" })).toMatchObject({ ok: true });
      becomeCanonical(f.h, binding.assignmentId);
      expect((await f.h.cp.cto.settleCanonicalSwitchovers()).withdrawn).toEqual([
        { projectId: f.projectId, handoffIds: [], replacements: [], restored: true },
      ]);
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.READY);
      // Drained again afterwards, by a writer that left no switchover record.
      expect(f.h.cp.sessions.transition(credential.sessionId, SessionLifecycle.DRAINING, "a later, unattributed drain").allowed).toBe(true);

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({ withdrawn: [], stopFailed: [] });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
    });
  });

  it("a suspended project's flag alone keeps a replacement-drained canonical holder DRAINING", async () => {
    await withFixture(async (f) => {
      const { binding, credential } = liveHolder(f.h, f.projectId);
      expect(await f.hermes("cto_replace", { projectId: f.projectId, reason: "replace the CTO" })).toMatchObject({ ok: true });
      becomeCanonical(f.h, binding.assignmentId);
      expect(f.h.cp.projects.setSuspended(f.projectId, true, true).allowed).toBe(true);

      expect(await f.h.cp.cto.settleCanonicalSwitchovers()).toEqual({ withdrawn: [], stopFailed: [] });
      expect(lifecycleOf(f.h, credential.sessionId)).toBe(SessionLifecycle.DRAINING);
    });
  });
});
