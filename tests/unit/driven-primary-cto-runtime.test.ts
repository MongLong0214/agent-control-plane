import { afterAll, describe, expect, it, vi } from "vitest";

import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { ExecutionMode, Role, RunKind, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { DRIVEN_PRIMARY_CTO_SPAWN_RECORD } from "../../src/runtime/provisioned-session-runtime.ts";
import type { SessionHandle, SessionTurnRequest, SessionTurnResult } from "../../src/runtime/provider.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);

/**
 * #246 PR-C C4-R1 — the PRIMARY_CTO a bootstrap activation provisions is driven on the headless
 * runtime the run's BOOTSTRAP_CTO ran on, and only that one:
 *
 * - its spawn records it driven with its session row, gives it a workdir of its own and Claude Opus,
 *   and every interactive PRIMARY_CTO keeps the CTO preference, the shared root and its wake port;
 * - the activation's HANDOFF_PACKAGE reaches it in band as a wake turn, and a duplicate delivery
 *   has one effect;
 * - an existing driven binding is asked by an attestation turn that resumes its conversation, never
 *   by opening its id again (`--session-id`), and is refused rather than taken over when it fails.
 *
 * Over the real sockets: `cto.mcp.sock` and the take-once launch channel. Only the model is scripted
 * (`HeadlessRuntimeDouble`); its work turn does what the work prompt asks, over the connection its
 * relay authenticated for that turn.
 */
const HANDOFF: HandoffPackage = {
  projectStatus: "new",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "verify",
};

const CONTRACT = {
  goal: "a standard run",
  why: "it is not a bootstrap",
  scope: [],
  nonGoals: [],
  acceptance: ["verify"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

/** Activation's own recording and enqueue of its handoff (`BootstrapActivation.openActivationHandoff`). */
type OpenActivationHandoff = (
  projectId: string,
  runId: string,
  toSessionId: string,
  handoff: HandoffPackage,
) => Decision<{ handoffId: string }>;

const openActivationHandoff = (f: BootstrapRuntimeFixture): OpenActivationHandoff => {
  const bootstrap = f.harness.cp.bootstrap as unknown as { openActivationHandoff: OpenActivationHandoff };
  return bootstrap.openActivationHandoff.bind(bootstrap);
};

/** A bootstrap run, dispatched, and a driven PRIMARY_CTO provisioned for the project it activates. */
const drivenPrimary = async (f: BootstrapRuntimeFixture, projectId: string) => {
  f.harness.cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId);
  const bootstrap = await f.dispatchBootstrap();
  const bound = await f.harness.cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  return { bootstrap, binding: bound.value };
};

const markersFor = (f: BootstrapRuntimeFixture, sessionId: string): Array<{ run_id: string | null; project_id: string | null }> =>
  f.harness.cp.db.all(
    `SELECT run_id, project_id FROM audit_events WHERE kind = ? AND session_id = ?`,
    [DRIVEN_PRIMARY_CTO_SPAWN_RECORD, sessionId],
  );

const attestationTurns = (f: BootstrapRuntimeFixture, sessionId: string): SessionTurnRequest[] => {
  const external = f.harness.cp.sessions.require(sessionId).incarnation.split("#")[0];
  return f.claude.turns.filter((turn) => turn.handle.externalSessionId === external && /session_attest/.test(turn.prompt));
};

const countAudit = (f: BootstrapRuntimeFixture, kind: string, sessionId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND session_id = ?`,
    [kind, sessionId],
  )?.n ?? 0;

/**
 * The real Claude CLI refuses `--session-id` for a conversation it already has ("already in use");
 * only a turn's own existence check (`runSessionTurn`) may ask the double about the session. Every
 * `--session-id` probe is recorded and refused, as the provider refuses it.
 */
const refuseReopenedConversations = (f: BootstrapRuntimeFixture): string[] => {
  const reopened: string[] = [];
  let inTurn = 0;
  const runTurn = f.claude.runSessionTurn.bind(f.claude);
  const probe = f.claude.probeSession.bind(f.claude);
  f.claude.runSessionTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
    inTurn += 1;
    try {
      return await runTurn(request);
    } finally {
      inTurn -= 1;
    }
  };
  f.claude.probeSession = async (handle: SessionHandle) => {
    if (inTurn > 0) return probe(handle);
    reopened.push(handle.externalSessionId);
    return "UNAVAILABLE";
  };
  return reopened;
};

describe("#246 C4-R1 — a driven PRIMARY_CTO", () => {
  it("is recorded driven at spawn, on its own session, workdir and Claude Opus; an interactive PRIMARY_CTO keeps its path", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { bootstrap, binding } = await drivenPrimary(f, "driven-project");

      // The fact is the session's own spawn record, written once, under the activating run.
      expect(markersFor(f, binding.sessionId)).toEqual([{ run_id: bootstrap.runId, project_id: "driven-project" }]);
      const session = cp.sessions.require(binding.sessionId);
      expect(session).toMatchObject({ provider: "claude", model: "opus", lifecycle: SessionLifecycle.READY });
      expect(binding).toMatchObject({ role: Role.PRIMARY_CTO, bindingGeneration: 1 });
      // A fresh session: never the run's BOOTSTRAP_CTO, and a workdir of its own.
      expect(binding.sessionId).not.toBe(bootstrap.ownerSessionId);
      const bootstrapWorkdir = cp.sessions.require(bootstrap.ownerSessionId).workdir;
      expect(session.workdir).toMatch(/\/sessions\/[0-9a-f-]{36}(\/|$)/);
      expect(session.workdir).not.toBe(bootstrapWorkdir);
      // Driven: the daemon holds its credential, and its readiness was an attestation that opened
      // its conversation.
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
      expect(cp.sessionRuntime.drivesSession(binding.sessionId, Role.PRIMARY_CTO)).toBe(true);
      expect(attestationTurns(f, binding.sessionId).map((turn) => turn.conversation)).toEqual(["new"]);

      // Only a bootstrap activation asks for one: a standard run is refused before anything starts.
      const manifest = fixtureManifest("standard-project");
      const project = cp.projects.register({
        projectId: "standard-project",
        name: "standard",
        manifest,
        authorization: cp.manifestAuthorizationForTests(manifest),
      });
      if (!project.allowed) throw new Error(project.message);
      const standard = cp.runs.create({
        projectId: "standard-project",
        kind: RunKind.STANDARD_WORK,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
      });
      if (!standard.allowed) throw new Error(standard.message);
      const startedBefore = f.claude.started.length;
      const refused = await cp.cto.ensureDrivenPrimaryCto("standard-project", standard.value.runId);
      expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
      expect(f.claude.started.length).toBe(startedBefore);
      expect(cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: "standard-project" }))).toBeNull();

      // Interactive: the CTO preference, the shared managed root, no record, no custody, and woken
      // through the conversation port, never the runtime.
      const interactive = await cp.cto.ensurePrimaryCto("standard-project", "cto_start");
      if (!interactive.allowed) throw new Error(interactive.message);
      const interactiveSession = cp.sessions.require(interactive.value.sessionId);
      expect(interactiveSession).toMatchObject({ provider: "scripted", model: "scripted-cto" });
      expect(interactiveSession.workdir).not.toMatch(/\/sessions\//);
      expect(markersFor(f, interactive.value.sessionId)).toEqual([]);
      expect(cp.sessionRuntime.holds(interactive.value.sessionId)).toBe(false);
      expect(cp.sessionRuntime.drivesSession(interactive.value.sessionId, Role.PRIMARY_CTO)).toBe(false);
      const knocked: string[] = [];
      const conversation = {
        wake: async (roleKey: string) => {
          knocked.push(roleKey);
          return allow(ReasonCode.OK, undefined);
        },
      };
      const turnsBefore = f.claude.turns.length;
      const woke = await wakeRoleHolder(cp, conversation, interactive.value.roleKey, { kind: "owner message", ids: [] });
      expect(woke.allowed).toBe(true);
      expect(knocked).toEqual([interactive.value.roleKey]);
      expect(f.claude.turns.length).toBe(turnsBefore);
      // An interactive recipient's HANDOFF_PACKAGE is not held back in band: the delivery sweep takes it.
      const sent = cp.outbox.enqueue({
        idempotencyKey: "handoff:interactive-regression",
        roleKey: interactive.value.roleKey,
        bindingGeneration: interactive.value.bindingGeneration,
        targetSessionId: interactive.value.sessionId,
        runId: null,
        kind: MessageKind.HANDOFF_PACKAGE,
        payload: { handoffId: "hof_interactive", projectId: "standard-project", handoff: HANDOFF },
      });
      if (!sent.allowed) throw new Error(sent.message);
      expect(cp.outbox.pendingInBandFor(interactive.value.sessionId, interactiveSession.incarnation)).toEqual([]);
      expect(cp.outbox.claimDeliverable(10).map((row) => row.messageId)).toContain(sent.value.messageId);
    });
  });

  it("is woken in band by the activation's HANDOFF_PACKAGE, and a duplicate delivery has one effect", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { bootstrap, binding } = await drivenPrimary(f, "handoff-project");
      const handled: Array<{ kind: string; handoffAck: unknown; dispatchAck: unknown }> = [];
      let keys = 0;
      // The work turn does what its prompt asks — read what is addressed to it, accept a handoff,
      // acknowledge each row — and, as a model retrying its own tool calls would, does it twice.
      f.claude.onWorkTurn = async (_request, credential) => {
        // The run's BOOTSTRAP_CTO shares this double; only the driven PRIMARY_CTO's turns act here.
        if (!credential || credential.sessionId !== binding.sessionId) return;
        const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
          const messages = (pending["value"] as { messages?: Array<{ messageId: string; kind: string; payload: { handoffId?: string } }> } | undefined)
            ?.messages ?? [];
          for (const message of messages) {
            const row = cp.outbox.get(message.messageId)!;
            const handoffAck = message.kind === MessageKind.HANDOFF_PACKAGE
              ? (await callMcpToolOverSocket(f.ctoSocket, as, "handoff_ack", {
                  idempotencyKey: `driven-handoff-ack-${++keys}`,
                  handoffId: message.payload.handoffId,
                  messageId: message.messageId,
                  payloadDigest: row.payloadDigest,
                  bindingGeneration: row.bindingGeneration,
                }))["ok"]
              : null;
            const dispatchAck = (await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId }))["ok"];
            handled.push({ kind: message.kind, handoffAck, dispatchAck });
          }
        }
      };

      const turnsBeforeHandoff = f.finishedTurns(binding.sessionId);
      const opened = openActivationHandoff(f)("handoff-project", bootstrap.runId, binding.sessionId, HANDOFF);
      if (!opened.allowed) throw new Error(opened.message);
      const handoffId = opened.value.handoffId;
      const row = cp.db.get<{ message_id: string }>(
        `SELECT message_id FROM outbox WHERE idempotency_key = ?`,
        [`bootstrap-handoff:${handoffId}`],
      )!;
      // The enqueue's own wake ran a turn of the driven session's conversation, which settled it.
      await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(turnsBeforeHandoff + 1), { timeout: 10_000 });
      expect(cp.outbox.get(row.message_id)?.status).toBe("ACKED");
      expect(handled).toEqual([{ kind: MessageKind.HANDOFF_PACKAGE, handoffAck: true, dispatchAck: true }]);
      // The turn's prompt tells a real model how a HANDOFF_PACKAGE is accepted.
      const external = cp.sessions.require(binding.sessionId).incarnation.split("#")[0];
      const handoffTurn = f.claude.turns.filter((turn) => turn.handle.externalSessionId === external).at(-1)!;
      expect(handoffTurn).toMatchObject({ conversation: "resume" });
      expect(handoffTurn.prompt).toMatch(/HANDOFF_PACKAGE is accepted with mcp__acp-cto__handoff_ack/);
      expect(cp.db.get<{ status: string; ack_by_session_id: string }>(
        `SELECT status, ack_by_session_id FROM handoffs WHERE handoff_id = ?`,
        [handoffId],
      )).toEqual({ status: "ACKED", ack_by_session_id: binding.sessionId });

      // Duplicate delivery: the activation retried, the same envelope enqueued again, the role woken
      // again by name and by the outbox's re-wake. One row, no second turn, one effect.
      const workTurns = (): number =>
        f.claude.turns.filter((turn) =>
          turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
      const turnsAfterFirst = workTurns();
      expect(openActivationHandoff(f)("handoff-project", bootstrap.runId, binding.sessionId, HANDOFF)).toMatchObject({
        allowed: true,
        value: { handoffId },
      });
      const again = cp.outbox.enqueue({
        idempotencyKey: `bootstrap-handoff:${handoffId}`,
        roleKey: binding.roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        runId: bootstrap.runId,
        kind: MessageKind.HANDOFF_PACKAGE,
        payload: { handoffId, projectId: "handoff-project", handoff: HANDOFF },
      });
      expect(again.reasonCode).toBe(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED);
      const conversation = { wake: async () => allow(ReasonCode.OK, undefined) };
      const rewoken = await wakeRoleHolder(cp, conversation, binding.roleKey, { kind: "in-band dispatch", ids: [row.message_id] });
      expect(rewoken.reasonCode).toBe(ReasonCode.SESSION_TURN_DUPLICATE);
      f.harness.clock.advance(10 * 60_000);
      await cp.outbox.wakeInBandPending();
      expect(workTurns()).toBe(turnsAfterFirst);
      expect(cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM outbox WHERE idempotency_key = ?`,
        [`bootstrap-handoff:${handoffId}`],
      )?.n).toBe(1);
      expect(countAudit(f, "HANDOFF_ACK", binding.sessionId)).toBe(1);
      expect(countAudit(f, "OUTBOX_ACKED_IN_BAND", binding.sessionId)).toBe(1);
    });
  });

  it("is probed on an existing binding by an attestation that resumes its conversation, and refused rather than replaced", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "probe-project");
      const reopened = refuseReopenedConversations(f);
      const startedBefore = f.claude.started.length;

      // A later run reaches the bound role (`ensurePrimaryCto`, as dispatch and cto_start ask it).
      const reused = await cp.cto.ensurePrimaryCto("probe-project", "cto_start");
      if (!reused.allowed) throw new Error(`an attested driven binding was refused: ${reused.reasonCode}`);
      expect(reused.value).toMatchObject({ sessionId: binding.sessionId, bindingGeneration: 1 });
      expect(reopened).toEqual([]);
      expect(attestationTurns(f, binding.sessionId).map((turn) => turn.conversation)).toEqual(["new", "resume"]);
      expect(f.claude.started.length).toBe(startedBefore);

      // A daemon that no longer holds its credential cannot prove it: refused, left READY and bound,
      // and no other session is spawned or bound in its place.
      cp.sessionRuntime.release(binding.sessionId);
      const refused = await cp.cto.ensurePrimaryCto("probe-project", "cto_start");
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
      expect(reopened).toEqual([]);
      expect(cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(cp.bindings.active(binding.roleKey)).toMatchObject({ sessionId: binding.sessionId, bindingGeneration: 1 });
      expect(f.claude.started.length).toBe(startedBefore);
      expect(countAudit(f, "CTO_SESSION_PROBE_FAILED", binding.sessionId)).toBe(1);
    });
  });
});
