import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { startLocalMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { callMcpToolOverSocket, claimLaunchedCredential } from "../helpers/mcp-socket.ts";

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

const fixture = async () => {
  const h = makeHarness();
  const { projectId } = await registerFixtureProject(h);
  const launch = await startSessionLaunchChannel(tempDir("acp-hof-launch-"));
  h.cp.cto.attach({ sessionLaunch: launch });
  const listeners = await startLocalMcpListeners(h.cp, tempDir("acp-hof-mcp-"), TOKEN);
  const ctoSocket = listeners.socketPaths[1];
  if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
  let keys = 0;
  const cto = (credential: Credential, name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(ctoSocket, { token: TOKEN, ...credential }, name, { idempotencyKey: `hof-${++keys}`, ...args });
  /** The credential a spawned session's launch channel issued, claimed under its provider id. */
  const launched = (sessionId: string): Promise<Credential> =>
    claimLaunchedCredential(launch.socketPath, h.cp.sessions.require(sessionId).incarnation.split("#", 1)[0]!);
  return {
    h,
    projectId,
    cto,
    launched,
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

      const submitted = await f.cto(credential, "handoff_submit", { projectId: f.projectId, handoff: HANDOFF });
      expect(submitted).toMatchObject({ ok: false, reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE });
      expect(handoffCount(f.h)).toBe(0);
      // The replacement it spawned is stopped, not left running; the holder never drained.
      const incoming = f.h.cp.db.all<{ session_id: string; lifecycle: string }>(
        `SELECT session_id, lifecycle FROM sessions WHERE session_id <> ? ORDER BY created_at`,
        [credential.sessionId],
      );
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
      expect(f.h.cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [handoffId])?.status).toBe("PENDING");
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
