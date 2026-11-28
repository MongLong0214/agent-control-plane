import { afterAll, afterEach, expect, it, vi } from "vitest";

import { bootstrapActivationHandoff } from "../src/bootstrap/bootstrap-plan.ts";
import type { ProjectManifest } from "../src/contracts/manifest.ts";
import { ReasonCode } from "../src/core/reason-codes.ts";
import { startLocalMcpListeners, wakeRoleHolder } from "../src/daemon/agentcpd.ts";
import { Role, type RoleBinding, SessionLifecycle } from "../src/domain/types.ts";
import { MessageKind } from "../src/outbox/envelope.ts";
import { cleanTreeManifest } from "../tests/helpers/bootstrap-plan.ts";
import { ownerApprovalFor, type PreparedBootstrapRun, prepareBootstrapRun } from "../tests/helpers/bootstrap-runner.ts";
import { cleanupTempDirs, tempDir } from "../tests/helpers/fixtures.ts";
import { bootstrapCtoProvider } from "../tests/helpers/harness.ts";
import { callMcpToolOverSocket } from "../tests/helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #246 C4 — a retried bootstrap activation keeps the PRIMARY_CTO it bound: an adopted canonical holder
 * whose package is PENDING, or REJECTED under a legacy authority refusal, is preserved, never replaced
 * (#1461 deleted the undeliverable-holder replacement).
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
        wakeRoleHolder(cp, roleKey, { kind: "in-band dispatch", ids: ids ?? [] }));
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
