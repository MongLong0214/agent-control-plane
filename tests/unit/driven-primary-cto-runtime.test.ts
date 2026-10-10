import { afterAll, describe, expect, it, vi } from "vitest";

import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { ExecutionMode, Role, RunKind, SessionLifecycle, roleKeyFor, type RoleBinding } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { DRIVEN_PRIMARY_CTO_SPAWN_RECORD, type SpawnAttestation } from "../../src/runtime/provisioned-session-runtime.ts";
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

interface MarkerRow {
  run_id: string | null;
  project_id: string | null;
  role_key: string | null;
  creation_generation: number | null;
}

const markersFor = (f: BootstrapRuntimeFixture, sessionId: string): MarkerRow[] =>
  f.harness.cp.db.all(
    `SELECT run_id, project_id, role_key,
            json_extract(evidence_json, '$.creationGeneration') AS creation_generation
       FROM audit_events WHERE kind = ? AND session_id = ?`,
    [DRIVEN_PRIMARY_CTO_SPAWN_RECORD, sessionId],
  );

/** A project with a manifest and no repository: enough for its PRIMARY_CTO to be provisioned. */
const registerBareProject = (f: BootstrapRuntimeFixture, projectId: string): void => {
  const manifest = fixtureManifest(projectId);
  const project = f.harness.cp.projects.register({
    projectId,
    name: projectId,
    manifest,
    authorization: f.harness.cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(project.message);
};

/** The work turn the prompt asks for: read what is addressed in band, accept a handoff, acknowledge. */
const actOnWorkTurns = (f: BootstrapRuntimeFixture, sessionId: string): void => {
  let keys = 0;
  f.claude.onWorkTurn = async (_request, credential) => {
    if (!credential || credential.sessionId !== sessionId) return;
    const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
    const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; kind: string; payload: { handoffId?: string } }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      const row = f.harness.cp.outbox.get(message.messageId)!;
      if (message.kind === MessageKind.HANDOFF_PACKAGE) {
        await callMcpToolOverSocket(f.ctoSocket, as, "handoff_ack", {
          idempotencyKey: `stale-ready-ack-${++keys}`,
          handoffId: message.payload.handoffId,
          messageId: message.messageId,
          payloadDigest: row.payloadDigest,
          bindingGeneration: row.bindingGeneration,
        });
      }
      await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId });
    }
  };
};

/** Work turns (relay, no challenge) of one session's conversation. */
const workTurnsOf = (f: BootstrapRuntimeFixture, sessionId: string): number => {
  const external = f.harness.cp.sessions.require(sessionId).incarnation.split("#")[0];
  return f.claude.turns.filter((turn) =>
    turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
};

/** The provider's own conversation id for a session row. */
const externalOfRow = (f: BootstrapRuntimeFixture, sessionId: string): string =>
  f.harness.cp.sessions.require(sessionId).incarnation.split("#")[0]!;

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
      // Attributed to its project, role key, session and creation generation; the creation
      // assignment that generation names was granted to this session, and carries the actor.
      expect(markersFor(f, binding.sessionId)).toEqual([{
        run_id: bootstrap.runId,
        project_id: "driven-project",
        role_key: binding.roleKey,
        creation_generation: 1,
      }]);
      const holder = cp.db.get<{ actor_id: string }>(
        `SELECT a.actor_id FROM assignments a
           JOIN conversational_actors c ON c.actor_id = a.actor_id AND c.current_session_id = ?
          WHERE a.assignment_id = ?`,
        [binding.sessionId, binding.assignmentId],
      )!;
      expect(cp.db.get(
        `SELECT session_id, project_id, actor_id FROM assignments WHERE role_key = ? AND binding_generation = 1`,
        [binding.roleKey],
      )).toEqual({ session_id: binding.sessionId, project_id: "driven-project", actor_id: holder.actor_id });
      expect(cp.outbox.drivenModeOf(binding.sessionId)).toBe("DRIVEN");
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

  it("fails closed on a missing or contradicted spawn record, and keeps its record across an epoch change", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "marker-project");
      registerBareProject(f, "other-session-project");
      registerBareProject(f, "other-generation-project");
      const otherSession = await cp.cto.ensurePrimaryCto("other-session-project", "cto_start");
      const otherGeneration = await cp.cto.ensurePrimaryCto("other-generation-project", "cto_start");
      if (!otherSession.allowed || !otherGeneration.allowed) throw new Error("interactive primary CTOs were refused");

      // Missing: an interactive session has no record, so nothing drives it — custody is refused.
      const missing = otherSession.value.sessionId;
      expect(cp.sessionRuntime.drivesSession(missing, Role.PRIMARY_CTO)).toBe(false);
      expect(cp.sessionRuntime.adopt(missing, Role.PRIMARY_CTO, "not-its-credential", 0)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_RUNTIME_UNAVAILABLE,
      });

      // Contradicted: a record on a session naming another session's creation (the driven project's
      // generation 1), and one naming a generation its own role key never granted.
      cp.audit.record({
        kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
        projectId: "marker-project",
        roleKey: binding.roleKey,
        sessionId: otherSession.value.sessionId,
        evidence: { creationGeneration: 1 },
      });
      cp.audit.record({
        kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
        projectId: "other-generation-project",
        roleKey: otherGeneration.value.roleKey,
        sessionId: otherGeneration.value.sessionId,
        evidence: { creationGeneration: 2 },
      });
      const probedAsInteractive = vi.spyOn(f.harness.scripted, "probeSession");
      for (const contradicted of [otherSession.value, otherGeneration.value]) {
        expect(cp.sessionRuntime.drivesSession(contradicted.sessionId, Role.PRIMARY_CTO)).toBe(false);
        expect(cp.sessionRuntime.adopt(contradicted.sessionId, Role.PRIMARY_CTO, "not-its-credential", 0).allowed).toBe(false);
        expect(cp.outbox.drivenModeOf(contradicted.sessionId)).toBe("CONTRADICTED");
        // Neither driven nor taken for interactive: refused, left READY and bound, nothing spawned.
        const refused = await cp.cto.ensurePrimaryCto(contradicted.projectId!, "cto_start");
        expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
        expect(await cp.cto.probeRoleSession(contradicted.sessionId, Role.PRIMARY_CTO)).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CONFLICT,
        });
        expect(cp.sessions.require(contradicted.sessionId).lifecycle).toBe(SessionLifecycle.READY);
        expect(cp.bindings.active(contradicted.roleKey)).toMatchObject({ sessionId: contradicted.sessionId, bindingGeneration: 1 });
        // Its rows are neither in band nor sent.
        const row = cp.outbox.enqueue({
          idempotencyKey: `handoff:contradicted-${contradicted.sessionId}`,
          roleKey: contradicted.roleKey,
          bindingGeneration: contradicted.bindingGeneration,
          targetSessionId: contradicted.sessionId,
          runId: null,
          kind: MessageKind.HANDOFF_PACKAGE,
          payload: { handoffId: "hof_contradicted", projectId: contradicted.projectId, handoff: HANDOFF },
        });
        if (!row.allowed) throw new Error(row.message);
        expect(cp.outbox.claimDeliverable(50).map((claimed) => claimed.messageId)).not.toContain(row.value.messageId);
        expect(cp.outbox.pendingInBandFor(contradicted.sessionId, contradicted.sessionIncarnation)).toEqual([]);
      }
      expect(probedAsInteractive).not.toHaveBeenCalled();
      // The record on another session took nothing from the session whose creation it names.
      expect(cp.outbox.drivenModeOf(binding.sessionId)).toBe("DRIVEN");

      // An epoch change keeps the same session, incarnation, actor and binding, so the record still
      // applies; the new credential is not attested until a turn presents it.
      const before = cp.sessions.require(binding.sessionId);
      const rotated = cp.sessions.rotateSecret(binding.sessionId, before.credentialEpoch);
      if (!rotated.allowed) throw new Error(rotated.message);
      expect(cp.sessionRuntime.adopt(binding.sessionId, Role.PRIMARY_CTO, rotated.value.sessionSecret, rotated.value.session.credentialEpoch).allowed).toBe(true);
      expect(rotated.value.session).toMatchObject({ incarnation: before.incarnation, credentialEpoch: before.credentialEpoch + 1 });
      expect(cp.outbox.drivenModeOf(binding.sessionId)).toBe("DRIVEN");
      expect(cp.sessionRuntime.drivesSession(binding.sessionId, Role.PRIMARY_CTO)).toBe(true);
      expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "after-rotation", kind: "test" }])).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_NOT_READY,
      });
      const reattested = await cp.cto.ensurePrimaryCto("marker-project", "cto_start");
      expect(reattested).toMatchObject({ allowed: true, value: { sessionId: binding.sessionId, bindingGeneration: 1 } });

      // A second record on the driven session itself, even one naming the same creation, is not one
      // record: the session's mode is contradicted and it fails closed like the others.
      cp.audit.record({
        kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
        projectId: "marker-project",
        roleKey: binding.roleKey,
        sessionId: binding.sessionId,
        evidence: { creationGeneration: 1 },
      });
      expect(cp.sessionRuntime.drivesSession(binding.sessionId, Role.PRIMARY_CTO)).toBe(false);
      expect(cp.outbox.drivenModeOf(binding.sessionId)).toBe("CONTRADICTED");
      expect(await cp.cto.ensurePrimaryCto("marker-project", "cto_start")).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.CONFLICT,
      });
      expect(cp.bindings.active(binding.roleKey)).toMatchObject({ sessionId: binding.sessionId, bindingGeneration: 1 });
      expect(probedAsInteractive).not.toHaveBeenCalled();
    });
  });

  it("runs no work on a stale READY after its attestation failed, and runs it once one succeeds", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { bootstrap, binding } = await drivenPrimary(f, "stale-project");
      actOnWorkTurns(f, binding.sessionId);

      // The relay still takes the credential, but the model never answers the challenge.
      f.claude.presentAttestation = false;
      const refused = await cp.cto.ensurePrimaryCto("stale-project", "cto_start");
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
      expect(cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);

      // The activation's handoff arrives: its wake is refused and no turn runs on the stale READY.
      const opened = openActivationHandoff(f)("stale-project", bootstrap.runId, binding.sessionId, HANDOFF);
      if (!opened.allowed) throw new Error(opened.message);
      const messageId = cp.db.get<{ message_id: string }>(
        `SELECT message_id FROM outbox WHERE idempotency_key = ?`,
        [`bootstrap-handoff:${opened.value.handoffId}`],
      )!.message_id;
      await vi.waitFor(() => expect(cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OUTBOX_IN_BAND_WAKE_FAILED' AND role_key = ?`,
        [binding.roleKey],
      )?.n).toBe(1), { timeout: 10_000 });
      const conversation = { wake: async () => allow(ReasonCode.OK, undefined) };
      expect(await wakeRoleHolder(cp, conversation, binding.roleKey, { kind: "in-band dispatch", ids: [messageId] })).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_NOT_READY,
      });
      expect(workTurnsOf(f, binding.sessionId)).toBe(0);
      expect(cp.outbox.get(messageId)?.status).toBe("PENDING");
      expect(cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [opened.value.handoffId])?.status)
        .toBe("PENDING");

      // A current attestation reopens the boundary; the outbox's re-wake then runs the turn once.
      f.claude.presentAttestation = true;
      const reattested = await cp.cto.ensurePrimaryCto("stale-project", "cto_start");
      expect(reattested.allowed).toBe(true);
      f.harness.clock.advance(10 * 60_000);
      const turnsBefore = f.finishedTurns(binding.sessionId);
      await cp.outbox.wakeInBandPending();
      await vi.waitFor(() => expect(f.finishedTurns(binding.sessionId)).toBe(turnsBefore + 1), { timeout: 10_000 });
      expect(workTurnsOf(f, binding.sessionId)).toBe(1);
      expect(cp.outbox.get(messageId)?.status).toBe("ACKED");
      expect(cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [opened.value.handoffId])?.status)
        .toBe("ACKED");

      // An attestation whose turn fails outright closes the boundary the same way.
      vi.spyOn(f.claude, "runSessionTurn").mockResolvedValueOnce({
        ok: false,
        text: "",
        exitCode: 1,
        error: "transient CLI failure",
        providerSessionId: null,
        durationMs: 1,
      });
      expect(await cp.cto.ensurePrimaryCto("stale-project", "cto_start")).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_NOT_READY,
      });
      expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "after-a-failed-attestation-turn", kind: "test" }])).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_NOT_READY,
      });
      expect(workTurnsOf(f, binding.sessionId)).toBe(1);
    });
  });

  describe("the bind re-checks the spawn record against the binding it grants", () => {
    /**
     * Provisions a driven PRIMARY_CTO, and while its spawn waits on the session's readiness — after
     * the spawn record named its creation generation and before the bind — runs `interpose`, which
     * makes the role's generations move under it. Nothing is timed: readiness is the spawn's last
     * await before the bind transaction.
     */
    const provisionAround = async (
      f: BootstrapRuntimeFixture,
      projectId: string,
      interpose: (sessionId: string) => void,
    ) => {
      const cp = f.harness.cp;
      cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
      await registerFixtureProject(f.harness, projectId);
      const bootstrap = await f.dispatchBootstrap();
      const readiness = cp.doctor.sessionReadiness.bind(cp.doctor);
      vi.spyOn(cp.doctor, "sessionReadiness").mockImplementationOnce(async (sessionId: string) => {
        interpose(sessionId);
        return readiness(sessionId);
      });
      const startedBefore = f.claude.started.length;
      const refused = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
      const sessionId = cp.db.get<{ session_id: string }>(
        `SELECT session_id FROM audit_events WHERE kind = ? AND project_id = ? ORDER BY event_id DESC LIMIT 1`,
        [DRIVEN_PRIMARY_CTO_SPAWN_RECORD, projectId],
      )!.session_id;
      expect(f.claude.started.length).toBe(startedBefore + 1);
      return { refused, sessionId, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }) };
    };

    /** Refused, rolled back, and nothing left that could run: no binding, custody, attestation or turn. */
    const expectNothingUsable = (f: BootstrapRuntimeFixture, refused: Decision<RoleBinding>, sessionId: string, roleKey: string) => {
      const cp = f.harness.cp;
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
      expect(cp.bindings.active(roleKey)).toBeNull();
      expect(cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
        [roleKey],
      )?.n).toBe(0);
      expect(cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM assignments WHERE role_key = ? AND binding_generation = 2`,
        [roleKey],
      )?.n).toBe(0);
      expect(cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(cp.sessionRuntime.holds(sessionId)).toBe(false);
      expect(cp.sessionRuntime.drivesSession(sessionId, Role.PRIMARY_CTO)).toBe(false);
      expect(cp.sessionRuntime.wake(roleKey, [{ id: "after-a-refused-bind", kind: "test" }])).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_RUNTIME_UNAVAILABLE,
      });
      expect(workTurnsOf(f, sessionId)).toBe(0);
    };

    it("refuses when the generation the record names went to another session", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const other = cp.sessions.create({ provider: "scripted", model: "other-cto" });
        cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "fixture: another session");
        const { refused, sessionId, roleKey } = await provisionAround(f, "generation-project", () => {
          const taken = cp.bindings.bind({
            roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: "generation-project" }),
            role: Role.PRIMARY_CTO,
            sessionId: other.sessionId,
            projectId: "generation-project",
            mode: "PREFERRED",
          });
          if (!taken.allowed) throw new Error(taken.message);
          const revoked = cp.bindings.revoke(taken.value.roleKey, "fixture: generation 1 went elsewhere");
          if (!revoked.allowed) throw new Error(revoked.message);
        });
        // The record names generation 1; generation 1 is the other session's, revoked.
        expect(markersFor(f, sessionId)).toMatchObject([{ creation_generation: 1 }]);
        expect(cp.db.get(
          `SELECT session_id, status FROM assignments WHERE role_key = ? AND binding_generation = 1`,
          [roleKey],
        )).toEqual({ session_id: other.sessionId, status: "REVOKED" });
        expectNothingUsable(f, refused, sessionId, roleKey);
      });
    });

    it("refuses when the assignment the record names is its own but revoked, held by another actor", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        let creationActor: string | null = null;
        const { refused, sessionId, roleKey } = await provisionAround(f, "actor-project", (spawned) => {
          const own = cp.bindings.bind({
            roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: "actor-project" }),
            role: Role.PRIMARY_CTO,
            sessionId: spawned,
            projectId: "actor-project",
            mode: "PREFERRED",
          });
          if (!own.allowed) throw new Error(own.message);
          creationActor = cp.db.get<{ actor_id: string }>(
            `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
            [own.value.assignmentId],
          )!.actor_id;
          const revoked = cp.bindings.revoke(own.value.roleKey, "fixture: the creation assignment is revoked");
          if (!revoked.allowed) throw new Error(revoked.message);
        });
        // Session, project, role key and generation all match the record; the creation assignment
        // is REVOKED, and the bind would have minted another actor at generation 2.
        expect(markersFor(f, sessionId)).toMatchObject([{ project_id: "actor-project", role_key: roleKey, creation_generation: 1 }]);
        expect(cp.db.get(
          `SELECT session_id, actor_id, status FROM assignments WHERE role_key = ? AND binding_generation = 1`,
          [roleKey],
        )).toEqual({ session_id: sessionId, actor_id: creationActor, status: "REVOKED" });
        // The rolled-back bind left no second actor behind on the session.
        expect(cp.db.all<{ actor_id: string }>(
          `SELECT actor_id FROM conversational_actors WHERE current_session_id = ?`,
          [sessionId],
        ).map((row) => row.actor_id)).toEqual([creationActor]);
        expectNothingUsable(f, refused, sessionId, roleKey);
      });
    });
  });

  describe("the execution boundary reads eligibility immediately before the provider call", () => {
    const externalOf = (f: BootstrapRuntimeFixture, sessionId: string): string =>
      f.harness.cp.sessions.require(sessionId).incarnation.split("#")[0]!;

    /** Turns this session ran to completion, by purpose: the runtime records each one it executed. */
    const executed = (f: BootstrapRuntimeFixture, sessionId: string, purpose: string): number =>
      f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events
          WHERE kind = 'SESSION_TURN' AND session_id = ? AND json_extract(evidence_json, '$.purpose') = ?`,
        [sessionId, purpose],
      )?.n ?? 0;

    /** Turns refused at the boundary, by purpose: none of them reached the provider. */
    const refusedTurns = (f: BootstrapRuntimeFixture, sessionId: string, purpose: string): number =>
      f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events
          WHERE kind = 'SESSION_TURN_REFUSED' AND session_id = ? AND json_extract(evidence_json, '$.purpose') = ?`,
        [sessionId, purpose],
      )?.n ?? 0;

    /** Provider calls of this session's conversation, by kind of prompt. */
    const providerCalls = (f: BootstrapRuntimeFixture, sessionId: string): { attestation: number; other: number } => {
      const external = externalOf(f, sessionId);
      const mine = f.claude.turns.filter((turn) => turn.handle.externalSessionId === external);
      const attestation = mine.filter((turn) => /session_attest/.test(turn.prompt)).length;
      return { attestation, other: mine.length - attestation };
    };

    /** Holds this session's next attestation turn inside the provider until `release`. */
    const holdNextAttestation = (f: BootstrapRuntimeFixture, sessionId: string) => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let entered = false;
      const original = f.claude.runSessionTurn.bind(f.claude);
      f.claude.runSessionTurn = async (request) => {
        if (!entered && request.handle.externalSessionId === externalOf(f, sessionId) && /session_attest/.test(request.prompt)) {
          entered = true;
          await barrier;
        }
        return original(request);
      };
      return { release: () => release(), entered: () => entered };
    };

    /** The activation's handoff envelope, PENDING, with nothing woken for it yet. */
    const pendingHandoff = (f: BootstrapRuntimeFixture, projectId: string, runId: string, sessionId: string): string => {
      f.harness.cp.outbox.attachInBandWake(async () => allow(ReasonCode.OK, undefined));
      const opened = openActivationHandoff(f)(projectId, runId, sessionId, HANDOFF);
      if (!opened.allowed) throw new Error(opened.message);
      return f.harness.cp.outbox.byIdempotencyKey(`bootstrap-handoff:${opened.value.handoffId}`)!.messageId;
    };

    /** A refused work turn reached no provider, executed nothing and settled nothing. */
    const expectRefusedWork = (f: BootstrapRuntimeFixture, sessionId: string, messageId: string, otherCallsBefore: number) => {
      const cp = f.harness.cp;
      expect(providerCalls(f, sessionId).other).toBe(otherCallsBefore);
      expect(executed(f, sessionId, "work")).toBe(0);
      expect(refusedTurns(f, sessionId, "work")).toBe(1);
      expect(cp.outbox.get(messageId)?.status).not.toBe("ACKED");
      expect(countAudit(f, "OUTBOX_ACKED_IN_BAND", sessionId)).toBe(0);
      expect(countAudit(f, "HANDOFF_ACK", sessionId)).toBe(0);
    };

    it("refuses a queued turn whose spawn record became contradicted, and refuses the attestation it waited behind", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { bootstrap, binding } = await drivenPrimary(f, "queued-contradicted");
        actOnWorkTurns(f, binding.sessionId);
        const messageId = pendingHandoff(f, "queued-contradicted", bootstrap.runId, binding.sessionId);
        const held = holdNextAttestation(f, binding.sessionId);
        const reattest = cp.cto.ensurePrimaryCto("queued-contradicted", "cto_start");
        await vi.waitFor(() => expect(held.entered()).toBe(true));
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: messageId, kind: "in-band dispatch" }])).toMatchObject({
          allowed: true,
          value: "COALESCED",
        });
        cp.audit.record({
          kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
          projectId: "queued-contradicted",
          roleKey: binding.roleKey,
          sessionId: binding.sessionId,
          evidence: { creationGeneration: 1 },
        });
        const before = providerCalls(f, binding.sessionId).other;
        held.release();
        // The attestation ran while the record was still one; it is not counted once it is two.
        expect(await reattest).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
        await vi.waitFor(() => expect(refusedTurns(f, binding.sessionId, "work")).toBe(1));
        expectRefusedWork(f, binding.sessionId, messageId, before);
        expect(cp.outbox.get(messageId)?.status).toBe("PENDING");
      });
    });

    it("refuses a turn whose binding was revoked after the wake admitted it", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { bootstrap, binding } = await drivenPrimary(f, "queued-revoked");
        actOnWorkTurns(f, binding.sessionId);
        const messageId = pendingHandoff(f, "queued-revoked", bootstrap.runId, binding.sessionId);
        const before = providerCalls(f, binding.sessionId).other;
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: messageId, kind: "in-band dispatch" }])).toMatchObject({
          allowed: true,
          value: "STARTED",
        });
        expect(cp.bindings.revoke(binding.roleKey, "fixture: revoked between wake and turn").allowed).toBe(true);
        await vi.waitFor(() => expect(refusedTurns(f, binding.sessionId, "work")).toBe(1));
        expectRefusedWork(f, binding.sessionId, messageId, before);
      });
    });

    it("refuses a queued turn whose session went ERROR, and refuses a wake for an ERROR session at admission", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { bootstrap, binding } = await drivenPrimary(f, "queued-error");
        actOnWorkTurns(f, binding.sessionId);
        const messageId = pendingHandoff(f, "queued-error", bootstrap.runId, binding.sessionId);
        const held = holdNextAttestation(f, binding.sessionId);
        const reattest = cp.cto.ensurePrimaryCto("queued-error", "cto_start");
        await vi.waitFor(() => expect(held.entered()).toBe(true));
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: messageId, kind: "in-band dispatch" }])).toMatchObject({
          allowed: true,
          value: "COALESCED",
        });
        expect(cp.sessions.transition(binding.sessionId, SessionLifecycle.ERROR, "fixture: runtime failure").allowed).toBe(true);
        const before = providerCalls(f, binding.sessionId).other;
        held.release();
        expect((await reattest).allowed).toBe(false);
        await vi.waitFor(() => expect(refusedTurns(f, binding.sessionId, "work")).toBe(1));
        // The envelope is the outbox's to retire (its target is no longer live); no turn settled it.
        expectRefusedWork(f, binding.sessionId, messageId, before);
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "after-error", kind: "test" }])).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.SESSION_NOT_READY,
        });
        expect(providerCalls(f, binding.sessionId).other).toBe(before);
      });
    });

    it("refuses a direct probe and attestation of a session whose spawn record is contradicted", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { binding } = await drivenPrimary(f, "direct-contradicted");
        cp.audit.record({
          kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
          projectId: "direct-contradicted",
          roleKey: binding.roleKey,
          sessionId: binding.sessionId,
          evidence: { creationGeneration: 1 },
        });
        const before = f.claude.turns.length;
        expect(await cp.sessionRuntime.probe(binding.sessionId)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
        expect(await cp.sessionRuntime.attest(binding.sessionId, "resume")).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CONFLICT,
        });
        expect(f.claude.turns.length).toBe(before);
      });
    });

    it("refuses a turn that became ineligible while its credential delivery was being prepared", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { binding } = await drivenPrimary(f, "prepared-then-refused");
        let armed = true;
        const withdrawn: boolean[] = [];
        let provisioned = 0;
        cp.sessionRuntime.attach({
          delivery: {
            prepare: async () => {
              const prepared = await f.launch.prepare();
              if (armed) {
                armed = false;
                cp.sessions.transition(binding.sessionId, SessionLifecycle.ERROR, "fixture: failed during preparation");
              }
              return prepared;
            },
            provision: async (credential) => {
              provisioned += 1;
              return f.launch.provision(credential);
            },
            withdraw: (externalSessionId) => {
              const untaken = f.launch.withdraw(externalSessionId);
              if (provisioned > 0) withdrawn.push(untaken);
              return untaken;
            },
          },
        });
        const before = providerCalls(f, binding.sessionId).other;
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "prepared-then-refused", kind: "test" }])).toMatchObject({
          allowed: true,
          value: "STARTED",
        });
        await vi.waitFor(() => expect(refusedTurns(f, binding.sessionId, "work")).toBe(1));
        expect(providerCalls(f, binding.sessionId).other).toBe(before);
        expect(executed(f, binding.sessionId, "work")).toBe(0);
        // The credential offered for the turn was taken back untouched.
        expect(provisioned).toBe(1);
        expect(withdrawn).toEqual([true]);
      });
    });
  });

  describe("a session not yet bound runs only its own spawn's attestation", () => {
    const ticketOf = (f: BootstrapRuntimeFixture, sessionId: string, creationGeneration = 1): SpawnAttestation => {
      const session = f.harness.cp.sessions.require(sessionId);
      return { incarnation: session.incarnation, credentialEpoch: session.credentialEpoch, creationGeneration };
    };

    it("refuses work, a probe and any other attestation on the spawn's own pending session, and the spawn still binds", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
        await registerFixtureProject(f.harness, "pending-misuse");
        const bootstrap = await f.dispatchBootstrap();
        const seen: Record<string, unknown> = {};
        // While the spawn's own attestation runs: STARTING, PENDING, holding the exact ticket.
        const original = f.claude.runSessionTurn.bind(f.claude);
        let inside = false;
        f.claude.runSessionTurn = async (request) => {
          const marker = cp.db.get<{ session_id: string }>(
            `SELECT session_id FROM audit_events WHERE kind = ? AND project_id = 'pending-misuse'`,
            [DRIVEN_PRIMARY_CTO_SPAWN_RECORD],
          );
          if (!inside && marker && request.handle.externalSessionId === externalOfRow(f, marker.session_id)) {
            inside = true;
            const ticket = ticketOf(f, marker.session_id);
            seen["mode"] = cp.outbox.drivenModeOf(marker.session_id);
            seen["own"] = cp.sessionRuntime.turnEligibility(marker.session_id, "attestation", "new", ticket).allowed;
            seen["work"] = cp.sessionRuntime.turnEligibility(marker.session_id, "work", "new", ticket).reasonCode;
            seen["probe"] = cp.sessionRuntime.turnEligibility(marker.session_id, "probe", "new", ticket).reasonCode;
            seen["resume"] = cp.sessionRuntime.turnEligibility(marker.session_id, "attestation", "resume", ticket).reasonCode;
            seen["noTicket"] = cp.sessionRuntime.turnEligibility(marker.session_id, "attestation", "new", null).reasonCode;
          }
          return original(request);
        };
        // After it: READY, still PENDING, before the bind. Each misuse is refused with no provider call.
        const readiness = cp.doctor.sessionReadiness.bind(cp.doctor);
        vi.spyOn(cp.doctor, "sessionReadiness").mockImplementationOnce(async (sessionId: string) => {
          const before = f.claude.turns.length;
          seen["readyMode"] = cp.outbox.drivenModeOf(sessionId);
          seen["probeRun"] = (await cp.sessionRuntime.probe(sessionId)).reasonCode;
          seen["attestRun"] = (await cp.sessionRuntime.attest(sessionId, "new")).reasonCode;
          seen["replayRun"] = (await cp.sessionRuntime.attest(sessionId, "new", ticketOf(f, sessionId))).reasonCode;
          seen["calls"] = f.claude.turns.length - before;
          return readiness(sessionId);
        });
        const bound = await cp.cto.ensureDrivenPrimaryCto("pending-misuse", bootstrap.runId);
        if (!bound.allowed) throw new Error(`the spawn was refused: ${bound.reasonCode}`);
        expect(seen).toEqual({
          mode: "PENDING",
          own: true,
          work: ReasonCode.CONFLICT,
          probe: ReasonCode.CONFLICT,
          resume: ReasonCode.CONFLICT,
          noTicket: ReasonCode.CONFLICT,
          readyMode: "PENDING",
          probeRun: ReasonCode.CONFLICT,
          attestRun: ReasonCode.CONFLICT,
          replayRun: ReasonCode.CONFLICT,
          calls: 0,
        });
        // The misuse took nothing from the spawn: it bound driven, and its own attestation still stands.
        expect(cp.outbox.drivenModeOf(bound.value.sessionId)).toBe("DRIVEN");
        expect(cp.sessionRuntime.wake(bound.value.roleKey, [{ id: "after-the-misuse", kind: "test" }]).allowed).toBe(true);
      });
    });

    it("refuses another session's use of the exception, for each field of the ticket", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { binding } = await drivenPrimary(f, "pending-spawned");
        registerBareProject(f, "pending-other");
        const other = cp.sessions.create({ provider: "claude", model: "opus" });
        cp.audit.record({
          kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
          projectId: "pending-other",
          roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: "pending-other" }),
          sessionId: other.sessionId,
          evidence: { creationGeneration: 1 },
        });
        expect(cp.outbox.drivenModeOf(other.sessionId)).toBe("PENDING");
        expect(cp.sessionRuntime.adopt(other.sessionId, Role.PRIMARY_CTO, other.sessionSecret!, other.credentialEpoch).allowed).toBe(true);
        const exact = ticketOf(f, other.sessionId);
        const spawned = cp.sessions.require(binding.sessionId);
        const before = f.claude.turns.length;
        for (const ticket of [
          null,
          { ...exact, incarnation: spawned.incarnation },
          { ...exact, credentialEpoch: exact.credentialEpoch + 1 },
          { ...exact, creationGeneration: 2 },
        ]) {
          expect(await cp.sessionRuntime.attest(other.sessionId, "new", ticket)).toMatchObject({
            allowed: false,
            reasonCode: ReasonCode.CONFLICT,
          });
        }
        expect(await cp.sessionRuntime.probe(other.sessionId)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
        expect(f.claude.turns.length).toBe(before);
        // The one ticket that matches every field is the only one the exception would take.
        expect(cp.sessionRuntime.turnEligibility(other.sessionId, "attestation", "new", exact).allowed).toBe(true);
      });
    });
  });

  describe("each protection the first review found unwitnessed", () => {
    it("does not let a replacement actor on the same session inherit DRIVEN from the creation assignment", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { binding } = await drivenPrimary(f, "actor-rebind");
        const first = cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`, [binding.assignmentId])!;
        expect(cp.bindings.revoke(binding.roleKey, "fixture: rebind with a fresh actor").allowed).toBe(true);
        const rebound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "actor-rebind", sessionId: binding.sessionId });
        if (!rebound.allowed) throw new Error(rebound.message);
        const second = cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`, [rebound.value.assignmentId])!;
        expect(second.actor_id).not.toBe(first.actor_id);
        expect(cp.outbox.drivenModeOf(binding.sessionId)).toBe("CONTRADICTED");
        expect(cp.sessionRuntime.drivesSession(binding.sessionId, Role.PRIMARY_CTO)).toBe(false);
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "fresh-actor-work", kind: "test" }]).allowed).toBe(false);
      });
    });

    it("rolls the bind back when its spawn record is contradicted inside the bind transaction", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
        registerBareProject(f, "bind-rollback");
        const bootstrap = await f.dispatchBootstrap();
        const actorsBefore = cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversational_actors`)!.n;
        const bind = cp.bindings.bind.bind(cp.bindings);
        vi.spyOn(cp.bindings, "bind").mockImplementation((input) => {
          const granted = bind(input);
          if (input.projectId === "bind-rollback") {
            cp.audit.record({
              kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
              projectId: input.projectId,
              roleKey: input.roleKey,
              sessionId: input.sessionId,
              evidence: { creationGeneration: 1 },
            });
          }
          return granted;
        });
        expect(await cp.cto.ensureDrivenPrimaryCto("bind-rollback", bootstrap.runId)).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CONFLICT,
        });
        expect(cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: "bind-rollback" }))).toBeNull();
        expect(cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversational_actors`)!.n).toBe(actorsBefore);
        expect(cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE project_id = ?`, ["bind-rollback"])!.n).toBe(0);
      });
    });

    it("does not run work queued behind a resume attestation that failed", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { binding } = await drivenPrimary(f, "queued-failed-attestation");
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        let entered = false;
        const external = cp.sessions.require(binding.sessionId).incarnation.split("#")[0];
        const original = f.claude.runSessionTurn.bind(f.claude);
        f.claude.runSessionTurn = async (request) => {
          if (!entered && request.handle.externalSessionId === external && /session_attest/.test(request.prompt)) {
            entered = true;
            await barrier;
          }
          return original(request);
        };
        f.claude.presentAttestation = false;
        const reattest = cp.cto.ensurePrimaryCto("queued-failed-attestation", "cto_start");
        await vi.waitFor(() => expect(entered).toBe(true));
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "queued-during-failed-resume", kind: "test" }])).toMatchObject({
          allowed: true,
          value: "COALESCED",
        });
        release();
        expect(await reattest).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_NOT_READY });
        await vi.waitFor(() => expect(cp.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN_REFUSED' AND session_id = ?`,
          [binding.sessionId],
        )?.n).toBe(1));
        expect(workTurnsOf(f, binding.sessionId)).toBe(0);
      });
    });

    it("withholds a pending driven handoff from the delivery sweep", async () => {
      await withBootstrapRuntime(async (f) => {
        const cp = f.harness.cp;
        const { bootstrap, binding } = await drivenPrimary(f, "pending-handoff-sweep");
        cp.outbox.attachInBandWake(async () => allow(ReasonCode.OK, undefined));
        const opened = openActivationHandoff(f)("pending-handoff-sweep", bootstrap.runId, binding.sessionId, HANDOFF);
        if (!opened.allowed) throw new Error(opened.message);
        const messageId = cp.outbox.byIdempotencyKey(`bootstrap-handoff:${opened.value.handoffId}`)!.messageId;
        expect(cp.outbox.get(messageId)?.status).toBe("PENDING");
        expect(cp.outbox.claimDeliverable(50).map((row) => row.messageId)).not.toContain(messageId);
        expect(cp.outbox.get(messageId)?.status).toBe("PENDING");
      });
    });
  });
});
