import { acknowledgeBootstrapHandoff } from "../helpers/bootstrap-handoff-ack.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapActivationHandoff } from "../../src/bootstrap/bootstrap-plan.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { Role, type RoleBinding, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { DRIVEN_PRIMARY_CTO_SPAWN_RECORD, drivenModeOf } from "../../src/runtime/provisioned-session-runtime.ts";
import { cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { ownerApprovalFor, type PreparedBootstrapRun, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bootstrapCtoProvider } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #246 C4, live run_7717 — a bootstrap activation provisions its PRIMARY_CTO through the driven door, and
 * the activation retry recovers a project whose PRIMARY_CTO an earlier activation bound interactively:
 *
 * - a fresh activation binds a driven PRIMARY_CTO with its spawn record; its HANDOFF_PACKAGE stays PENDING
 *   in band, never swept to Buzz; the daemon's wake runs a turn whose handoff_ack lands, and the re-CONFIRM
 *   completes;
 * - the live shape (an interactive binding with no Buzz identity, its handoff PENDING, its HANDOFF_PACKAGE
 *   REJECTED undeliverable) is recovered by the CEO's re-CONFIRM alone: the binding is replaced by a driven
 *   one in one switch with its reason, the handoff is reissued once as a new PENDING package, the new
 *   holder's ACK completes it, and GitHub is not called again;
 * - a healthy interactive binding with a Buzz identity is reused, not replaced;
 * - a second retry reissues nothing.
 *
 * The run, its review, the owner's approval and GitHub are the runner fixture's; the CTO socket and the
 * daemon's in-band wake are real, and only the model is scripted: its work turn does what the prompt asks.
 */

const TOKEN = "driven-activation-token";

const createOnlyOperations = (): PreparedBootstrapRun["ops"] => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository",
    resourceIdentity: "github:acme/fixture",
    desiredState: { visibility: "public", autoInit: true },
  },
] as PreparedBootstrapRun["ops"];

const manifestFor = (projectId: string): ProjectManifest => {
  const base = cleanTreeManifest(projectId);
  return { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
};

const world = async (projectId: string) => {
  const manifest = manifestFor(projectId);
  const prepared = await prepareBootstrapRun(projectId, { ops: createOnlyOperations(), manifest });
  const input = { ...prepared.input, handoff: bootstrapActivationHandoff(manifest), ownerApproval: ownerApprovalFor(prepared) };
  const { harness, runId } = prepared;
  const cp = harness.cp;
  const listeners = await startLocalMcpListeners(cp, tempDir("acp-da-mcp-"), TOKEN);
  const ctoSocket = listeners.socketPaths[1]!;
  const claude = bootstrapCtoProvider(cp, harness.clock);

  // The work turn does what its prompt asks: read what is addressed to it in band, accept a
  // HANDOFF_PACKAGE with handoff_ack, acknowledge the row.
  const acks: Array<{ sessionId: string; handoffId: string; ok: unknown }> = [];
  let keys = 0;
  claude.onWorkTurn = async (_request, credential) => {
    if (!credential) return;
    const as = { token: TOKEN, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret };
    const pending = await callMcpToolOverSocket(ctoSocket, as, "role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; kind: string; payload: { handoffId?: string } }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      const row = cp.outbox.get(message.messageId)!;
      if (message.kind === MessageKind.HANDOFF_PACKAGE) {
        const acked = await callMcpToolOverSocket(ctoSocket, as, "handoff_ack", {
          idempotencyKey: `da-handoff-ack-${++keys}`,
          handoffId: message.payload.handoffId,
          messageId: message.messageId,
          payloadDigest: row.payloadDigest,
          bindingGeneration: row.bindingGeneration,
        });
        acks.push({ sessionId: credential.sessionId, handoffId: message.payload.handoffId!, ok: acked["ok"] });
      }
      if (message.kind !== MessageKind.HANDOFF_PACKAGE) {
        await callMcpToolOverSocket(ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId });
      }
    }
  };

  return {
    prepared,
    input,
    cp,
    runId,
    projectId: manifest.projectId,
    acks,
    /** The daemon's in-band wake, attached as the composition root attaches it, and its first pass. */
    wake: async (): Promise<void> => {
      cp.outbox.attachInBandWake((roleKey, ids) =>
        wakeRoleHolder(cp, listeners.ctoConversation, roleKey, { kind: "in-band dispatch", ids: ids ?? [] }));
      await cp.outbox.wakeInBandPending();
    },
    primary: (): RoleBinding => cp.bindings.activePrimaryCto(manifest.projectId)!,
    activate: () => prepared.runner.produceAndActivate(input),
    confirm: async () => {
      await cp.continuity.evaluate("bootstrap confirmation");
      return cp.ceo.submitCeoDecision({
        runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: prepared.snapshotDigest,
        ceoSessionId: prepared.ceoSessionId,
        rationale: "apply the bootstrap",
      });
    },
    handoff: (handoffId: string) =>
      cp.db.get<{ status: string; to_session_id: string }>(`SELECT status, to_session_id FROM handoffs WHERE handoff_id = ?`, [handoffId]),
    message: (handoffId: string) =>
      cp.db.get<{ message_id: string; status: string; failure_class: string | null; retry_eligible: number; attempts: number; binding_generation: number; target_session_id: string }>(
        `SELECT message_id, status, failure_class, retry_eligible, attempts, binding_generation, target_session_id
           FROM outbox WHERE idempotency_key = ?`,
        [`bootstrap-handoff:${handoffId}`],
      ),
    audits: (kind: string) => cp.audit.byKind(kind).filter((row) => row.projectId === manifest.projectId || row.runId === runId),
    github: () => ({
      writes: prepared.github.writes.length,
      reads: prepared.github.reads.length,
      creates: prepared.github.createRequests.length,
    }),
    close: () => listeners.close(),
  };
};

type World = Awaited<ReturnType<typeof world>>;

const withWorld = async (projectId: string, body: (w: World) => Promise<void>): Promise<void> => {
  const w = await world(projectId);
  try {
    await body(w);
  } finally {
    await w.close();
  }
};

/**
 * Live run_7717 reproduced: the first CONFIRM's activation binds the PRIMARY_CTO through the interactive
 * door 51e586fd's activation used; the Buzz sweep then rejects its HANDOFF_PACKAGE, since the session has
 * a Buzz address and no bound Buzz identity. Answers the pending handoff and the binding it went to.
 */
const liveShape = async (w: World): Promise<{ handoffId: string; holder: RoleBinding }> => {
  const { cp } = w;
  vi.spyOn(cp.cto, "ensureDrivenPrimaryCto").mockImplementationOnce((projectId, runId) => cp.cto.ensurePrimaryCto(projectId, runId));
  const first = await w.activate();
  expect(first, JSON.stringify(first)).toMatchObject({
    allowed: false,
    reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
    evidence: { incomplete: ["handoffAck"] },
  });
  const handoffId = first.evidence["pendingHandoffId"] as string;
  const holder = w.primary();
  expect(drivenModeOf(cp.db, holder.sessionId)).toBe("NONE");
  expect(w.audits(DRIVEN_PRIMARY_CTO_SPAWN_RECORD)).toEqual([]);
  expect(w.audits("PRIMARY_CTO_ACTIVATED").map((row) => row.evidence["driven"] ?? null)).toEqual([null]);
  expect(cp.sessions.require(holder.sessionId)).toMatchObject({ buzzActorId: null });
  expect(cp.sessions.require(holder.sessionId).buzzAddress).toBeTruthy();

  await w.prepared.harness.buzzAdapter.deliverPending();
  expect(w.handoff(handoffId)).toEqual({ status: "PENDING", to_session_id: holder.sessionId });
  expect(w.message(handoffId)).toMatchObject({
    status: "REJECTED",
    failure_class: "contract",
    retry_eligible: 0,
    attempts: 1,
    target_session_id: holder.sessionId,
    binding_generation: holder.bindingGeneration,
  });
  expect(w.github().creates).toBe(1);
  return { handoffId, holder };
};

describe("#246 C4: a bootstrap activation provisions a driven PRIMARY_CTO", () => {
  it("a fresh activation binds a driven PRIMARY_CTO with its spawn record; its HANDOFF_PACKAGE stays PENDING in band; the woken turn ACKs it and the re-CONFIRM completes", async () => {
    await withWorld("da-fresh", async (w) => {
      const { cp } = w;
      const first = await w.activate();
      expect(first, JSON.stringify(first)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        evidence: { incomplete: ["handoffAck"] },
      });
      const handoffId = first.evidence["pendingHandoffId"] as string;
      const primary = w.primary();
      expect(primary.sessionId).not.toBe(cp.runs.require(w.runId).ownerSessionId);
      expect(drivenModeOf(cp.db, primary.sessionId)).toBe("DRIVEN");
      expect(w.audits(DRIVEN_PRIMARY_CTO_SPAWN_RECORD).map((row) => [row.sessionId, row.runId])).toEqual([[primary.sessionId, w.runId]]);
      expect(w.audits("PRIMARY_CTO_ACTIVATED").map((row) => row.evidence["driven"])).toEqual([true]);

      // In band: PENDING, and the Buzz sweep neither claims nor rejects it.
      expect(w.handoff(handoffId)).toEqual({ status: "PENDING", to_session_id: primary.sessionId });
      expect(w.message(handoffId)).toMatchObject({ status: "PENDING", attempts: 0, target_session_id: primary.sessionId });
      await w.prepared.harness.buzzAdapter.deliverPending();
      expect(w.message(handoffId)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(w.prepared.harness.buzz.sent.filter((sent) => sent.content.includes(handoffId))).toEqual([]);

      // The wake runs a turn of the driven session's conversation, whose handoff_ack lands.
      await w.wake();
      // The turn's handoff_ack answered: the row is ACKED and the turn read the answer.
      await vi.waitFor(() => {
        expect(w.handoff(handoffId)?.status).toBe("ACKED");
        expect(w.acks).toHaveLength(1);
      }, { timeout: 15_000 });
      expect(w.acks).toEqual([{ sessionId: primary.sessionId, handoffId, ok: true }]);

      const ready = await w.activate();
      expect(ready, JSON.stringify(ready)).toMatchObject({ allowed: true, value: { handoffAck: { handoffId } } });
      expect(await w.confirm()).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
      expect(cp.artifacts.latest(w.runId, "BOOTSTRAP_ACTIVATION_RESULT")?.content).toMatchObject({
        primaryCtoBinding: { sessionId: primary.sessionId },
        handoffAck: { handoffId },
      });
      expect(w.github().creates).toBe(1);
    });
  });
});

describe("#246 C4, live run_7717: the activation retry recovers an undeliverable interactive PRIMARY_CTO", () => {
  it("the re-CONFIRM replaces it with a driven holder in one switch, reissues the handoff once, and completes on the new holder's ACK with no GitHub call", async () => {
    await withWorld("da-live", async (w) => {
      const { cp } = w;
      const { handoffId: stale, holder } = await liveShape(w);
      const github = w.github();

      const retried = await w.activate();
      expect(retried, JSON.stringify(retried)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        evidence: { incomplete: ["handoffAck"] },
      });
      expect(w.github()).toEqual(github);
      const reissued = retried.evidence["pendingHandoffId"] as string;
      expect(reissued).not.toBe(stale);

      // The driven replacement, bound in the switch that revoked the interactive holder with its reason.
      const driven = w.primary();
      expect(driven.sessionId).not.toBe(holder.sessionId);
      expect(driven.bindingGeneration).toBe(holder.bindingGeneration + 1);
      expect(drivenModeOf(cp.db, driven.sessionId)).toBe("DRIVEN");
      expect(w.audits(DRIVEN_PRIMARY_CTO_SPAWN_RECORD).map((row) => [row.sessionId, row.runId])).toEqual([[driven.sessionId, w.runId]]);
      const revoked = cp.db.get<{ status: string; revoked_reason: string }>(
        `SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`,
        [holder.assignmentId],
      );
      expect(revoked?.status).toBe("REVOKED");
      expect(revoked?.revoked_reason).toContain(stale);
      const replaced = w.audits("PRIMARY_CTO_UNDELIVERABLE_REPLACED");
      expect(replaced).toHaveLength(1);
      expect(replaced[0]).toMatchObject({
        sessionId: driven.sessionId,
        runId: w.runId,
        evidence: { handoffId: stale, fromSession: holder.sessionId, fromGeneration: holder.bindingGeneration, toGeneration: driven.bindingGeneration },
      });
      expect(cp.sessions.require(holder.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);

      // The old records are kept; the reissued package is new, PENDING, in band, to the driven holder.
      expect(w.handoff(stale)).toEqual({ status: "PENDING", to_session_id: holder.sessionId });
      expect(w.message(stale)).toMatchObject({ status: "REJECTED", attempts: 1 });
      expect(w.handoff(reissued)).toEqual({ status: "PENDING", to_session_id: driven.sessionId });
      expect(w.message(reissued)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        target_session_id: driven.sessionId,
        binding_generation: driven.bindingGeneration,
      });
      expect(w.audits("HANDOFF_SUBMITTED").map((row) => row.evidence["reissuedFrom"] ?? null)).toEqual([null, stale]);
      await w.prepared.harness.buzzAdapter.deliverPending();
      expect(w.message(reissued)).toMatchObject({ status: "PENDING", attempts: 0 });

      // The previous holder cannot ACK its old package, and nothing completes on it.
      expect(cp.bootstrap.acknowledgeActivationHandoff(stale, holder.sessionId)).toMatchObject({ allowed: false, reasonCode: ReasonCode.HANDOFF_ACK_REQUIRED });
      expect(w.handoff(stale)?.status).toBe("PENDING");
      const refused = await w.confirm();
      expect(refused, JSON.stringify(refused)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        evidence: { incomplete: ["handoffAck"] },
      });
      expect(cp.runs.require(w.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(cp.artifacts.latest(w.runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();

      // The current PRIMARY_CTO's own turn acknowledges the reissued package; the re-CONFIRM completes.
      await w.wake();
      // The turn's handoff_ack answered: the row is ACKED and the turn read the answer.
      await vi.waitFor(() => {
        expect(w.handoff(reissued)?.status).toBe("ACKED");
        expect(w.acks).toHaveLength(1);
      }, { timeout: 15_000 });
      expect(w.acks).toEqual([{ sessionId: driven.sessionId, handoffId: reissued, ok: true }]);
      const ready = await w.activate();
      expect(ready, JSON.stringify(ready)).toMatchObject({
        allowed: true,
        value: { primaryCtoBinding: { sessionId: driven.sessionId }, handoffAck: { handoffId: reissued } },
      });
      expect(await w.confirm()).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
      expect(cp.artifacts.latest(w.runId, "BOOTSTRAP_ACTIVATION_RESULT")?.content).toMatchObject({
        primaryCtoBinding: { sessionId: driven.sessionId, bindingGeneration: driven.bindingGeneration },
        handoffAck: { handoffId: reissued },
      });
      expect(w.github()).toEqual(github);
      expect(cp.bootstrapApplications.get(w.runId)?.phase).toBe("COMPLETED");
    });
  });

  it("a healthy interactive PRIMARY_CTO with a Buzz identity is reused, not replaced", async () => {
    await withWorld("da-healthy", async (w) => {
      const { cp } = w;
      // Bound by whichever door activation asks, as an interactive CTO a Buzz identity was bound to.
      const healthy = async (projectId: string) => {
        const session = cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
        cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "healthy interactive CTO");
        cp.sessions.setBuzzAddress(session.sessionId, "buzz:healthy-cto");
        const actor = cp.sessions.bindBuzzActor(
          { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: "actor:healthy-cto" },
          { isAllowedActor: (channel, candidate) => channel === "buzz" && candidate === "actor:healthy-cto" },
        );
        expect(actor.allowed).toBe(true);
        return cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId });
      };
      vi.spyOn(cp.cto, "ensureDrivenPrimaryCto").mockImplementationOnce(healthy);
      vi.spyOn(cp.cto, "ensurePrimaryCto").mockImplementationOnce(healthy);

      const first = await w.activate();
      expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, evidence: { incomplete: ["handoffAck"] } });
      const handoffId = first.evidence["pendingHandoffId"] as string;
      const holder = w.primary();
      expect(drivenModeOf(cp.db, holder.sessionId)).toBe("NONE");
      await w.prepared.harness.buzzAdapter.deliverPending();
      expect(w.message(handoffId)).toMatchObject({ status: "SENT" });

      const retried = await w.activate();
      expect(retried, JSON.stringify(retried)).toMatchObject({ allowed: false, evidence: { incomplete: ["handoffAck"], pendingHandoffId: handoffId } });
      expect(w.primary()).toMatchObject({ assignmentId: holder.assignmentId, sessionId: holder.sessionId, bindingGeneration: holder.bindingGeneration });
      expect(cp.sessions.require(holder.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(w.audits("PRIMARY_CTO_UNDELIVERABLE_REPLACED")).toEqual([]);
      expect(w.audits("HANDOFF_SUBMITTED")).toHaveLength(1);

      expect(await acknowledgeBootstrapHandoff(w.prepared.harness, handoffId, holder.sessionId)).toMatchObject({ allowed: true });
      expect(await w.activate()).toMatchObject({ allowed: true, value: { handoffAck: { handoffId } } });
      expect(await w.confirm()).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    });
  });

  it("a second retry does not reissue the handoff again, before the new ACK or after it", async () => {
    await withWorld("da-once", async (w) => {
      const { cp } = w;
      const { handoffId: stale } = await liveShape(w);
      const retried = await w.activate();
      const reissued = retried.evidence["pendingHandoffId"] as string;
      expect(reissued).not.toBe(stale);
      const driven = w.primary();
      const handoffsOf = () => cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM handoffs WHERE project_id = ?`, [w.projectId])?.n;
      expect(handoffsOf()).toBe(2);

      const again = await w.activate();
      expect(again, JSON.stringify(again)).toMatchObject({ allowed: false, evidence: { incomplete: ["handoffAck"], pendingHandoffId: reissued } });
      expect(w.primary()).toMatchObject({ assignmentId: driven.assignmentId, bindingGeneration: driven.bindingGeneration });
      expect(handoffsOf()).toBe(2);
      expect(w.audits("PRIMARY_CTO_UNDELIVERABLE_REPLACED")).toHaveLength(1);
      expect(w.audits("HANDOFF_SUBMITTED")).toHaveLength(2);

      await w.wake();
      // The turn's handoff_ack answered: the row is ACKED and the turn read the answer.
      await vi.waitFor(() => {
        expect(w.handoff(reissued)?.status).toBe("ACKED");
        expect(w.acks).toHaveLength(1);
      }, { timeout: 15_000 });
      expect(await w.activate()).toMatchObject({ allowed: true, value: { handoffAck: { handoffId: reissued } } });
      expect(handoffsOf()).toBe(2);
      expect(w.audits("PRIMARY_CTO_UNDELIVERABLE_REPLACED")).toHaveLength(1);
      expect(w.audits("HANDOFF_SUBMITTED")).toHaveLength(2);
      expect(w.acks).toEqual([{ sessionId: driven.sessionId, handoffId: reissued, ok: true }]);
    });
  });
});
