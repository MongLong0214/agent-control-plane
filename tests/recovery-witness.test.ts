import { afterAll, afterEach, expect, it, vi } from "vitest";

import { bootstrapActivationHandoff } from "../src/bootstrap/bootstrap-plan.ts";
import type { ProjectManifest } from "../src/contracts/manifest.ts";
import { ReasonCode } from "../src/core/reason-codes.ts";
import { startLocalMcpListeners, wakeRoleHolder } from "../src/daemon/agentcpd.ts";
import { Role, type RoleBinding, RunState, SessionLifecycle } from "../src/domain/types.ts";
import { MessageKind } from "../src/outbox/envelope.ts";
import { DRIVEN_PRIMARY_CTO_SPAWN_RECORD, drivenModeOf } from "../src/runtime/provisioned-session-runtime.ts";
import { cleanTreeManifest } from "../tests/helpers/bootstrap-plan.ts";
import { ownerApprovalFor, type PreparedBootstrapRun, prepareBootstrapRun } from "../tests/helpers/bootstrap-runner.ts";
import { cleanupTempDirs, tempDir } from "../tests/helpers/fixtures.ts";
import { bootstrapCtoProvider } from "../tests/helpers/harness.ts";
import { callMcpToolOverSocket } from "../tests/helpers/mcp-socket.ts";

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

import { createHermesMcpPort } from "../src/mcp/hermes-server.ts";
import { registerFixtureProject } from "../tests/helpers/harness.ts";

it("official CEO re-CONFIRM recovers and completes only after the driven ACK", async () => {
  await withWorld("review-official", async (w) => {
    const { cp } = w;
    const stale = await liveShape(w);
    const github = w.github();
    const port = createHermesMcpPort({ ...cp, bootstrapProducer: w.prepared.runner });
    const confirm = () => port.submitCeoDecision({
      runId: w.runId, decision: "CONFIRM", candidateSnapshotDigest: w.prepared.snapshotDigest,
      ceoSessionId: w.prepared.ceoSessionId, rationale: "recover bootstrap",
    });
    await cp.continuity.evaluate("bootstrap confirmation");
    const retry = await confirm();
    expect(retry, JSON.stringify(retry)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect(w.primary().sessionId).not.toBe(stale.holder.sessionId);
    const reissued = retry.evidence["pendingHandoffId"] as string;
    expect(reissued).not.toBe(stale.handoffId);
    expect(w.github()).toEqual(github);
    expect(cp.runs.require(w.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    await w.wake();
    await vi.waitFor(() => expect(w.acks).toHaveLength(1), { timeout: 15_000 });
    await cp.continuity.evaluate("bootstrap confirmation");
    expect(await confirm()).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    expect(w.github()).toEqual(github);
  });
});

it("replacement does not stop the old session while another project still holds it", async () => {
  await withWorld("review-shared", async (w) => {
    const { cp } = w;
    const { holder } = await liveShape(w);
    const otherProject = "review-other";
    await registerFixtureProject(w.prepared.harness, otherProject, {}, { identity: "github:acme/other" });
    const other = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: otherProject, sessionId: holder.sessionId });
    expect(other.allowed, JSON.stringify(other)).toBe(true);
    const retry = await w.activate();
    expect(retry, JSON.stringify(retry)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    expect(w.primary().sessionId).not.toBe(holder.sessionId);
    expect(cp.bindings.activePrimaryCto(otherProject)?.sessionId).toBe(holder.sessionId);
    expect(cp.sessions.require(holder.sessionId).lifecycle).toBe(SessionLifecycle.READY);
  });
});

it("replacement fences the retired session before an awaited provider stop permits readoption", async () => {
  await withWorld("review-readopt", async (w) => {
    const { cp } = w;
    const { holder } = await liveShape(w);
    const stop = w.prepared.harness.scripted.stopSession.bind(w.prepared.harness.scripted);
    let rebind: unknown;
    vi.spyOn(w.prepared.harness.scripted, "stopSession").mockImplementationOnce(async (handle) => {
      // Recovery has switched the role, but its old session is still READY until the provider answers.
      const current = w.primary();
      expect(current.sessionId).not.toBe(holder.sessionId);
      const switched = cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: w.projectId,
        sessionId: holder.sessionId, reason: "concurrent adoption", conversation: "REPLACED" });
      rebind = switched.allowed;
      await stop(handle);
    });
    await w.activate();
    expect(rebind).toBe(false);
    expect(cp.sessions.require(w.primary().sessionId).lifecycle).toBe(SessionLifecycle.READY);
  });
});

import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../src/registry/canonical-self-claim.ts";
import { digestOf, sha256 } from "../src/core/digest.ts";

it.each(["PENDING", "REJECTED"] as const)("an adopted canonical CTO with a %s package is preserved", async (status) => {
  await withWorld("review-canonical", async (w) => {
    const { cp } = w;
    vi.spyOn(cp.cto, "ensureDrivenPrimaryCto").mockImplementationOnce(async (projectId) => {
      const session = cp.sessions.create({ provider: "claude", model: "claude-cli" });
      expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "canonical test holder").allowed).toBe(true);
      const locator = "33333333-3333-4333-8333-333333333333";
      const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: locator, targetLocatorDigest: sha256(locator) };
      return cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId,
        mode: "PREFERRED", authenticatedTarget: { claimed, protocolVersion: SELF_CLAIM_PROTOCOL,
          attestationDigest: digestOf({ test: "canonical activation", sessionId: session.sessionId }), verify: () => claimed } });
    });
    const first = await w.activate();
    expect(first).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    const handoffId = first.evidence["pendingHandoffId"] as string;
    const holder = w.primary();
    if (status === "REJECTED") {
      // A legacy authority refusal remains refused. Construct that historical row explicitly:
      // canonical bootstrap packages now stay in band and cannot acquire it through the sweep.
      cp.db.run(`UPDATE outbox SET status = 'REJECTED', failure_class = 'contract', retry_eligible = 0,
        attempts = 1 WHERE idempotency_key = ?`, [`bootstrap-handoff:${handoffId}`]);
    }
    await w.prepared.harness.buzzAdapter.deliverPending();
    expect(w.message(handoffId)).toMatchObject({ status, failure_class: status === "REJECTED" ? "contract" : null });
    const original = w.message(handoffId);
    const retry = await w.activate();
    expect(retry.allowed).toBe(false);
    const currentHandoffId = retry.evidence["pendingHandoffId"] as string;
    if (status === "REJECTED") {
      expect(currentHandoffId).not.toBe(handoffId);
      expect(w.message(currentHandoffId)).toMatchObject({status:"PENDING",target_session_id:holder.sessionId});
      expect(w.message(handoffId)).toEqual(original);
    } else expect(currentHandoffId).toBe(handoffId);
    expect(await w.activate()).toMatchObject({allowed:false,evidence:{pendingHandoffId:currentHandoffId}});
    expect(w.primary().assignmentId).toBe(holder.assignmentId);
    expect(cp.sessions.require(holder.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(w.audits("PRIMARY_CTO_UNDELIVERABLE_REPLACED")).toHaveLength(0);
  });
});

it("a recipient that acquires Buzz identity during replacement spawn is preserved", async () => {
  await withWorld("review-buzz-race", async (w) => {
    const { cp } = w;
    const { holder } = await liveShape(w);
    const readiness = cp.doctor.sessionReadiness.bind(cp.doctor);
    vi.spyOn(cp.doctor, "sessionReadiness").mockImplementationOnce(async (sessionId) => {
      const old = cp.sessions.require(holder.sessionId);
      const rotated = cp.sessions.rotateSecret(holder.sessionId, old.credentialEpoch);
      if (!rotated.allowed) throw new Error(rotated.message);
      const bound = cp.sessions.bindBuzzActor({ sessionId: holder.sessionId,
        sessionSecret: rotated.value.sessionSecret, buzzActorId: "review:healthy" },
        { isAllowedActor: (channel, actor) => channel === "buzz" && actor === "review:healthy" });
      expect(bound.allowed).toBe(true);
      return readiness(sessionId);
    });
    const retry = await w.activate();
    expect(retry).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT,
      evidence: { refusal: "UNDELIVERABLE_REPLACEMENT_REFUSED" } });
    expect(w.primary().assignmentId).toBe(holder.assignmentId);
    expect(cp.sessions.require(holder.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(w.audits("PRIMARY_CTO_UNDELIVERABLE_REPLACED")).toHaveLength(0);
    expect(w.audits("HANDOFF_SUBMITTED")).toHaveLength(1);
  });
});
