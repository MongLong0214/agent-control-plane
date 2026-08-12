import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ControlPlane } from "../app/control-plane.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ArtifactKind } from "../domain/types.ts";
import { parseVerificationCommand } from "../contracts/verification-command.ts";
import {
  authenticateMcpPeer,
  guarded,
  idempotentMcpMutation,
  ok,
  type AuthenticatedMcpPeer,
  type McpPeerAuthenticator,
  respond,
  type ToolResult,
} from "./shared.ts";

const mutation = { idempotencyKey: z.string().min(1) };
const runIdentity = { runId: z.string() };

/**
 * Verifies the transport identity against durable session and binding facts. The session
 * tuple comes from the authenticated connection, while the current generation is read
 * from the binding registry; neither can be forged in a tool payload.
 */
export const assertCtoRunPeer = (
  cp: ControlPlane,
  peer: AuthenticatedMcpPeer,
  runId: string,
): Decision<{ sessionId: string; bindingGeneration: number }> => {
  if (!peer.sessionId || !peer.sessionIncarnation) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation");
  }
  const session = cp.sessions.get(peer.sessionId);
  if (!session || session.incarnation !== peer.sessionIncarnation) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current", {
      sessionId: peer.sessionId,
    });
  }
  const run = cp.runs.get(runId);
  if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
  if (run.ownerSessionId !== peer.sessionId || run.ownerSessionIncarnation !== peer.sessionIncarnation || !run.ownerRoleKey) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "authenticated CTO peer does not own this run", { runId });
  }
  const binding = cp.bindings.active(run.ownerRoleKey);
  if (!binding || binding.sessionId !== peer.sessionId || binding.sessionIncarnation !== peer.sessionIncarnation || binding.bindingGeneration !== run.ownerBindingGeneration) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "run owner binding is no longer current", { runId });
  }
  const owner = cp.runs.assertOwner(runId, peer.sessionId, binding.bindingGeneration);
  if (!owner.allowed) return owner as Decision<{ sessionId: string; bindingGeneration: number }>;
  return allow(ReasonCode.OK, { sessionId: peer.sessionId, bindingGeneration: binding.bindingGeneration });
};

/** PRD §28.2 — CTO tools operate only as an authenticated, fenced session peer. */
export const createCtoServer = (
  cp: ControlPlane,
  authenticate: McpPeerAuthenticator,
): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-cto", version: "1.3.0" });
  const read = (execute: (peer: AuthenticatedMcpPeer) => Promise<ToolResult> | ToolResult) =>
    guarded(() => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? execute(peer.value) : respond(peer);
    });
  const write = (
    idempotencyKey: string,
    execute: (peer: AuthenticatedMcpPeer) => Promise<ToolResult> | ToolResult,
  ) => guarded(async () => {
    const peer = authenticateMcpPeer(authenticate);
    return peer.allowed
      ? idempotentMcpMutation(cp, peer.value, idempotencyKey, () => execute(peer.value))
      : respond(peer);
  });
  const owner = (peer: AuthenticatedMcpPeer, runId: string): Decision<{ sessionId: string; bindingGeneration: number }> =>
    assertCtoRunPeer(cp, peer, runId);

  server.registerTool(
    "run_ack",
    { description: "Acknowledge a dispatched run and its fenced envelope.", inputSchema: { ...mutation, ...runIdentity, messageId: z.string() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? respond(cp.outbox.acknowledge(args.messageId, fenced.value.sessionId, fenced.value.bindingGeneration)) : respond(fenced);
    }),
  );
  server.registerTool(
    "contract_get",
    { description: "The pinned task contract and verification contract for a run.", inputSchema: runIdentity },
    async (args) => read((peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      const run = cp.runs.require(args.runId);
      const manifest = run.pinnedManifestDigest ? cp.projects.manifest(run.pinnedManifestDigest) : null;
      return ok({ run, contract: cp.artifacts.latest(args.runId, ArtifactKind.TASK_CONTRACT)?.content ?? null, pinnedManifestDigest: run.pinnedManifestDigest, verificationCommands: manifest?.verificationCommands ?? [], branchProfile: manifest?.branchProfile ?? null, repositories: cp.runs.repositoriesOf(args.runId) });
    }),
  );
  server.registerTool(
    "plan_submit",
    {
      description: "Submit the lean plan and dynamic task graph.",
      inputSchema: {
        ...mutation, ...runIdentity,
        plan: z.object({
          summary: z.string(),
          dependencies: z.array(z.string()).default([]),
          repositoryIntent: z.array(z.string()).default([]),
          verificationIntent: z.array(z.string()).default([]),
          knownConflicts: z.array(z.string()).default([]),
          risks: z.array(z.string()).default([]),
          removedOverengineering: z.array(z.string()).default([]),
          bootstrapOperationId: z.string().min(1).optional(),
          requestDigest: z.string().min(1).optional(),
          projectManifestDigest: z.string().min(1).optional(),
          githubOperations: z.array(z.object({
            operationId: z.string().min(1),
            resourceType: z.string().min(1),
            resourceIdentity: z.string().min(1),
          }).strict()).optional(),
        }),
        tasks: z.array(z.object({ key: z.string(), title: z.string(), category: z.enum(["mechanical", "implementation", "investigation", "integration", "test", "review", "docs", "migration", "benchmark", "security"]), dependsOn: z.array(z.string()).default([]), spec: z.record(z.unknown()).default({}) })).min(1),
      },
    },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      cp.artifacts.put(args.runId, ArtifactKind.PLAN, args.plan);
      return respond(cp.tasks.submit(args.runId, args.tasks));
    }),
  );
  server.registerTool(
    "resource_claim",
    { description: "Claim a branch, worktree and exact write paths.", inputSchema: { ...mutation, ...runIdentity, repositoryIdentity: z.string(), branch: z.string().nullable().optional(), worktreeId: z.string().nullable().optional(), declaredPaths: z.array(z.string()).default([]), ttlMs: z.number().int().positive().optional() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      const roleKey = cp.runs.ownerRoleKeyFor(cp.runs.require(args.runId));
      if (!roleKey) return respond(deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no owner role key", {}));
      const acquired = cp.claims.acquire({ runId: args.runId, ownerSessionId: fenced.value.sessionId, ownerBindingGeneration: fenced.value.bindingGeneration, ownerRoleKey: roleKey, repositoryIdentity: args.repositoryIdentity, branch: args.branch ?? null, worktreeId: args.worktreeId ?? null, declaredPaths: args.declaredPaths, ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }) });
      if (!acquired.allowed) return respond(acquired);
      const advisory = cp.claims.advisoryOverlaps(args.repositoryIdentity, args.runId, args.declaredPaths);
      return respond(allow(advisory.length > 0 ? ReasonCode.SEMANTIC_CONFLICT_ADVISORY : ReasonCode.OK, { claims: acquired.value, advisoryOverlaps: advisory }));
    }),
  );
  server.registerTool(
    "resource_release",
    { description: "Release held claims.", inputSchema: { ...mutation, ...runIdentity, claimId: z.string().nullable().optional() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      return args.claimId ? respond(cp.claims.release(args.claimId, args.runId)) : ok({ released: cp.claims.releaseRun(args.runId) });
    }),
  );
  server.registerTool(
    "task_receipt_submit",
    {
      description: "Open or close a task execution receipt.",
      inputSchema: { ...mutation, ...runIdentity, taskId: z.string(), phase: z.enum(["started", "activity", "finished"]), executionId: z.string().nullable().optional(), provider: z.string().default("unknown"), model: z.string().default("unknown"), workerSessionId: z.string().nullable().optional(), workerProcessId: z.number().int().nullable().optional(), repositoryId: z.string().nullable().optional(), worktreeId: z.string().nullable().optional(), status: z.enum(["SUCCEEDED", "FAILED", "ABANDONED", "TIMEOUT"]).optional(), failureClass: z.enum(["transient", "repairable", "contract", "security", "policy", "capacity", "infrastructure", "unknown_observed"]).optional(), resultDigest: z.string().nullable().optional() },
    },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      if (args.phase === "started") return respond(cp.tasks.startExecution({ runId: args.runId, taskId: args.taskId, ownerBindingGeneration: fenced.value.bindingGeneration, workerSessionId: args.workerSessionId ?? null, workerProcessId: args.workerProcessId ?? null, provider: args.provider, model: args.model, repositoryId: args.repositoryId ?? null, worktreeId: args.worktreeId ?? null, concurrencyWidth: cp.tasks.runningWidth(args.runId) + 1 }));
      if (!args.executionId) return respond(deny(ReasonCode.INVALID_ARGUMENT, "activity and finish need an execution id", { phase: args.phase }));
      return args.phase === "activity"
        ? respond(cp.tasks.recordActivity(args.executionId, args.runId))
        : respond(cp.tasks.finishExecution(args.executionId, { status: args.status ?? "SUCCEEDED", resultDigest: args.resultDigest ?? null, failureClass: args.failureClass ?? null }, args.runId));
    }),
  );
  server.registerTool(
    "result_submit",
    { description: "Submit a candidate for automatic verification and blind review.", inputSchema: { ...mutation, ...runIdentity, resultSummary: z.string(), recommendation: z.string(), residualRisk: z.array(z.string()).default([]), runScopedCommands: z.array(z.record(z.unknown())).default([]) } },
    async (args) => write(args.idempotencyKey, async (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      const commands = args.runScopedCommands.map((command) => parseVerificationCommand(command));
      return respond(await cp.pipeline.submitResult({ runId: args.runId, ownerSessionId: fenced.value.sessionId, ownerBindingGeneration: fenced.value.bindingGeneration, resultSummary: args.resultSummary, recommendation: args.recommendation, residualRisk: args.residualRisk, ...(commands.length === 0 ? {} : { runScopedCommands: commands }) }));
    }),
  );
  server.registerTool(
    "escalation_open",
    { description: "Escalate a decision to the CEO.", inputSchema: { ...mutation, ...runIdentity, question: z.string(), options: z.array(z.string()).min(1), ctoRecommendation: z.string(), whyItMatters: z.string(), blocksCriticalPath: z.boolean() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      return respond(cp.ceo.openEscalation({ runId: args.runId, question: args.question, options: args.options, ctoRecommendation: args.ctoRecommendation, whyItMatters: args.whyItMatters, blocksCriticalPath: args.blocksCriticalPath, openedBySessionId: fenced.value.sessionId, openedAt: new Date().toISOString() }));
    }),
  );
  server.registerTool(
    "handoff_submit",
    { description: "Submit a structured CTO handoff.", inputSchema: { ...mutation, projectId: z.string(), handoff: z.object({ projectStatus: z.string(), activeManifestDigest: z.string().nullable(), recentDecisions: z.array(z.string()).default([]), openBlockers: z.array(z.string()).default([]), queuedWork: z.array(z.string()).default([]), repositoryFacts: z.array(z.object({ identity: z.string(), branch: z.string().nullable(), head: z.string().nullable() })).default([]), knownRisks: z.array(z.string()).default([]), recommendedNextAction: z.string() }) } },
    async (args) => write(args.idempotencyKey, async (peer) => {
      if (!peer.sessionId || !peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation"));
      const binding = cp.bindings.activePrimaryCto(args.projectId);
      if (!binding || binding.sessionId !== peer.sessionId || binding.sessionIncarnation !== peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "authenticated peer is not this project's primary CTO", { projectId: args.projectId }));
      return respond(await cp.cto.prepareSwitchover(args.projectId, args.handoff));
    }),
  );
  server.registerTool(
    "handoff_ack",
    { description: "Acknowledge a handoff as the authenticated incoming CTO.", inputSchema: { ...mutation, handoffId: z.string() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      if (!peer.sessionId || !peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation"));
      const session = cp.sessions.get(peer.sessionId);
      if (!session || session.incarnation !== peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current"));
      const handoff = cp.db.get<{ kind: string }>(`SELECT kind FROM handoffs WHERE handoff_id = ?`, [args.handoffId]);
      if (!handoff) return respond(deny(ReasonCode.NOT_FOUND, "unknown handoff", { handoffId: args.handoffId }));
      return handoff.kind === "BOOTSTRAP"
        ? respond(cp.bootstrap.acknowledgeActivationHandoff(args.handoffId, peer.sessionId))
        : respond(cp.cto.acknowledgeHandoff(args.handoffId, peer.sessionId));
    }),
  );
  server.registerTool(
    "capacity_get",
    { description: "Normalized provider capacity.", inputSchema: { ...mutation, refresh: z.boolean().default(false) } },
    async (args) => write(args.idempotencyKey, async () => {
      if (args.refresh) await cp.capacity.refresh("WORKER_FANOUT");
      return ok({ providers: cp.capacity.all(), continuityMode: cp.continuity.mode() });
    }),
  );
  server.registerTool(
    "doctor_run",
    { description: "Read-only doctor pass.", inputSchema: { scope: z.enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"]).default("run"), target: z.string().optional() } },
    async (args) => read(async () => ok(await cp.doctor.run(args.scope, args.target))),
  );
  server.registerTool(
    "blind_review_request",
    { description: "Not available: blind review is invoked by the control plane.", inputSchema: runIdentity },
    async (args) => read((peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? respond(cp.review.manualInvocation(fenced.value.sessionId, args.runId)) : respond(fenced);
    }),
  );
  return server;
};
