import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BootstrapActivation } from "../bootstrap/activation.ts";
import type { CapacityMonitor } from "../capacity/capacity-monitor.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { Clock } from "../core/clock.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { parseVerificationCommand } from "../contracts/verification-command.ts";
import type { CtoLifecycle } from "../cto/cto-lifecycle.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import type { Doctor } from "../doctor/doctor.ts";
import { ArtifactKind } from "../domain/types.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { BlindReviewGate } from "../review/blind-review.ts";
import type { CandidatePipeline } from "../run/candidate-pipeline.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { ContinuityKernel } from "../continuity/continuity-kernel.ts";
import {
  authenticateMcpPeer,
  createMcpMutationPort,
  guarded,
  ok,
  type AuthenticatedMcpPeer,
  type McpMutationSource,
  type McpPeerAuthenticator,
  respond,
  type ToolResult,
} from "./shared.ts";

const mutation = { idempotencyKey: z.string().min(1) };
const runIdentity = { runId: z.string() };

/**
 * Composition inputs are accepted only while the daemon constructs a sealed port. Server
 * factories never accept this shape, so a handler cannot be handed a raw database executor or
 * the control plane as a convenience shortcut (#352).
 */
export interface CtoMcpSource extends McpMutationSource {
  readonly db: Db;
  readonly clock: Clock;
  readonly artifacts: ArtifactStore;
  readonly bootstrap: BootstrapActivation;
  readonly capacity: CapacityMonitor;
  readonly ceo: ProductionGate;
  readonly claims: ClaimRegistry;
  readonly continuity: ContinuityKernel;
  readonly cto: CtoLifecycle;
  readonly doctor: Doctor;
  readonly outbox: Outbox;
  readonly pipeline: CandidatePipeline;
  readonly projects: ProjectRegistry;
  readonly review: BlindReviewGate;
  readonly runs: RunEngine;
  readonly sessions: SessionRegistry;
  readonly bindings: BindingRegistry;
  readonly tasks: TaskGraph;
}

/** Only ports constructed below may be attached to an MCP server. */
const CTO_MCP_PORTS = new WeakSet<object>();

/**
 * Verifies the transport identity against durable session and binding facts. The session
 * tuple comes from the authenticated connection, while the current generation is read
 * from the binding registry; neither can be forged in a tool payload.
 */
const assertCtoRunPeerFromSource = (
  source: CtoMcpSource,
  peer: AuthenticatedMcpPeer,
  runId: string,
): Decision<{ sessionId: string; bindingGeneration: number }> => {
  if (!peer.sessionId || !peer.sessionIncarnation) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation");
  }
  const session = source.sessions.get(peer.sessionId);
  if (!session || session.incarnation !== peer.sessionIncarnation) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current", {
      sessionId: peer.sessionId,
    });
  }
  const run = source.runs.get(runId);
  if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
  if (run.ownerSessionId !== peer.sessionId || run.ownerSessionIncarnation !== peer.sessionIncarnation || !run.ownerRoleKey) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "authenticated CTO peer does not own this run", { runId });
  }
  const binding = source.bindings.active(run.ownerRoleKey);
  if (!binding || binding.sessionId !== peer.sessionId || binding.sessionIncarnation !== peer.sessionIncarnation || binding.bindingGeneration !== run.ownerBindingGeneration) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "run owner binding is no longer current", { runId });
  }
  const owner = source.runs.assertOwner(runId, peer.sessionId, binding.bindingGeneration);
  if (!owner.allowed) return owner as Decision<{ sessionId: string; bindingGeneration: number }>;
  return allow(ReasonCode.OK, { sessionId: peer.sessionId, bindingGeneration: binding.bindingGeneration });
};

/**
 * Builds function-only capabilities for CTO tools. No service instance, `Db`, or composition
 * root is reachable from the resulting object, so adding a tool cannot accidentally inherit
 * a database executor from the daemon (#352).
 */
export const createCtoMcpPort = (source: CtoMcpSource) => {
  const port = Object.freeze({
    mutation: createMcpMutationPort(source),
    assertRunPeer: (peer: AuthenticatedMcpPeer, runId: string) => assertCtoRunPeerFromSource(source, peer, runId),
    sessionIsCurrent: (sessionId: string, incarnation: string) => {
      const session = source.sessions.get(sessionId);
      return Boolean(session && session.incarnation === incarnation);
    },
    acknowledge: (messageId: string, sessionId: string, bindingGeneration: number) =>
      source.outbox.acknowledge(messageId, sessionId, bindingGeneration),
    contractForRun: (runId: string) => {
      const run = source.runs.require(runId);
      const manifest = run.pinnedManifestDigest ? source.projects.manifest(run.pinnedManifestDigest) : null;
      return {
        run,
        contract: source.artifacts.latest(runId, ArtifactKind.TASK_CONTRACT)?.content ?? null,
        pinnedManifestDigest: run.pinnedManifestDigest,
        verificationCommands: manifest?.verificationCommands ?? [],
        branchProfile: manifest?.branchProfile ?? null,
        repositories: source.runs.repositoriesOf(runId),
      };
    },
    putPlan: (runId: string, plan: unknown) => source.artifacts.put(runId, ArtifactKind.PLAN, plan),
    submitTasks: (runId: string, tasks: Parameters<TaskGraph["submit"]>[1]) => source.tasks.submit(runId, tasks),
    ownerRoleKeyForRun: (runId: string) => source.runs.ownerRoleKeyFor(source.runs.require(runId)),
    acquireClaims: (input: Parameters<ClaimRegistry["acquire"]>[0]) => source.claims.acquire(input),
    advisoryOverlaps: (repositoryIdentity: string, runId: string, declaredPaths: readonly string[]) =>
      source.claims.advisoryOverlaps(repositoryIdentity, runId, declaredPaths),
    releaseClaim: (claimId: string, runId: string) => source.claims.release(claimId, runId),
    releaseRunClaims: (runId: string) => source.claims.releaseRun(runId),
    // Worker start goes through the admission-bearing entry point: `startExecution` alone does
    // not ask capacity whether this allocation is permitted, which is what #55/#182 was about.
    startTaskExecution: (input: Parameters<TaskGraph["startWorkerExecution"]>[0]) =>
      source.tasks.startWorkerExecution(input),
    taskRunningWidth: (runId: string) => source.tasks.runningWidth(runId),
    recordTaskActivity: (executionId: string, runId: string) => source.tasks.recordActivity(executionId, runId),
    finishTaskExecution: (
      executionId: string,
      outcome: Parameters<TaskGraph["finishExecution"]>[1],
      runId: string,
    ) => source.tasks.finishExecution(executionId, outcome, runId),
    submitResult: (input: Parameters<CandidatePipeline["submitResult"]>[0]) => source.pipeline.submitResult(input),
    openEscalation: (input: Parameters<ProductionGate["openEscalation"]>[0]) => source.ceo.openEscalation(input),
    activePrimaryCto: (projectId: string) => source.bindings.activePrimaryCto(projectId),
    prepareSwitchover: (...args: Parameters<CtoLifecycle["prepareSwitchover"]>) => source.cto.prepareSwitchover(...args),
    handoffKind: (handoffId: string) => source.db.get<{ kind: string }>(`SELECT kind FROM handoffs WHERE handoff_id = ?`, [handoffId])?.kind ?? null,
    acknowledgeBootstrap: (handoffId: string, sessionId: string) => source.bootstrap.acknowledgeActivationHandoff(handoffId, sessionId),
    acknowledgeCto: (handoffId: string, sessionId: string) => source.cto.acknowledgeHandoff(handoffId, sessionId),
    // A read an operator asked for is a capacity *report*, not evidence that a worker
    // allocation was admitted — `startWorkerExecution` owns the WORKER_FANOUT trigger.
    refreshCapacity: () => source.capacity.refresh("DOCTOR_CAPACITY_REPORT"),
    capacity: () => source.capacity.all(),
    continuityMode: () => source.continuity.mode(),
    doctorRun: (...args: Parameters<Doctor["run"]>) => source.doctor.run(...args),
    manualReview: (sessionId: string, runId: string) => source.review.manualInvocation(sessionId, runId),
  });
  CTO_MCP_PORTS.add(port);
  return port;
};

export type CtoMcpPort = ReturnType<typeof createCtoMcpPort>;

const assertCtoMcpPort = (port: CtoMcpPort): void => {
  if (!CTO_MCP_PORTS.has(port)) {
    throw new Error("createCtoServer requires a sealed CtoMcpPort from createCtoMcpPort");
  }
};

/** PRD §28.2 — CTO tools operate only as an authenticated, fenced session peer. */
export const assertCtoRunPeer = (
  port: CtoMcpPort,
  peer: AuthenticatedMcpPeer,
  runId: string,
): Decision<{ sessionId: string; bindingGeneration: number }> => port.assertRunPeer(peer, runId);

/**
 * This scope deliberately receives only the port. Every registered handler closes over this
 * parameter, so even a future tool cannot reach a construction-time source by accident (#352).
 */
const createCtoServerFromPort = (
  port: CtoMcpPort,
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
      ? port.mutation.execute(peer.value, idempotencyKey, () => execute(peer.value))
      : respond(peer);
  });
  const owner = (peer: AuthenticatedMcpPeer, runId: string): Decision<{ sessionId: string; bindingGeneration: number }> =>
    assertCtoRunPeer(port, peer, runId);

  server.registerTool(
    "run_ack",
    { description: "Acknowledge a dispatched run and its fenced envelope.", inputSchema: { ...mutation, ...runIdentity, messageId: z.string() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? respond(port.acknowledge(args.messageId, fenced.value.sessionId, fenced.value.bindingGeneration)) : respond(fenced);
    }),
  );
  server.registerTool(
    "contract_get",
    { description: "The pinned task contract and verification contract for a run.", inputSchema: runIdentity },
    async (args) => read((peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? ok(port.contractForRun(args.runId)) : respond(fenced);
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
      port.putPlan(args.runId, args.plan);
      return respond(port.submitTasks(args.runId, args.tasks));
    }),
  );
  server.registerTool(
    "resource_claim",
    { description: "Claim a branch, worktree and exact write paths.", inputSchema: { ...mutation, ...runIdentity, repositoryIdentity: z.string(), branch: z.string().nullable().optional(), worktreeId: z.string().nullable().optional(), declaredPaths: z.array(z.string()).default([]), ttlMs: z.number().int().positive().optional() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      const roleKey = port.ownerRoleKeyForRun(args.runId);
      if (!roleKey) return respond(deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no owner role key", {}));
      const acquired = port.acquireClaims({ runId: args.runId, ownerSessionId: fenced.value.sessionId, ownerBindingGeneration: fenced.value.bindingGeneration, ownerRoleKey: roleKey, repositoryIdentity: args.repositoryIdentity, branch: args.branch ?? null, worktreeId: args.worktreeId ?? null, declaredPaths: args.declaredPaths, ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }) });
      if (!acquired.allowed) return respond(acquired);
      const advisory = port.advisoryOverlaps(args.repositoryIdentity, args.runId, args.declaredPaths);
      return respond(allow(advisory.length > 0 ? ReasonCode.SEMANTIC_CONFLICT_ADVISORY : ReasonCode.OK, { claims: acquired.value, advisoryOverlaps: advisory }));
    }),
  );
  server.registerTool(
    "resource_release",
    { description: "Release held claims.", inputSchema: { ...mutation, ...runIdentity, claimId: z.string().nullable().optional() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      return args.claimId ? respond(port.releaseClaim(args.claimId, args.runId)) : ok({ released: port.releaseRunClaims(args.runId) });
    }),
  );
  server.registerTool(
    "task_receipt_submit",
    {
      description: "Open or close a task execution receipt.",
      inputSchema: { ...mutation, ...runIdentity, taskId: z.string(), phase: z.enum(["started", "activity", "finished"]), executionId: z.string().nullable().optional(), provider: z.string().default("unknown"), model: z.string().default("unknown"), workerSessionId: z.string().nullable().optional(), workerProcessId: z.number().int().nullable().optional(), repositoryId: z.string().nullable().optional(), worktreeId: z.string().nullable().optional(), status: z.enum(["SUCCEEDED", "FAILED", "ABANDONED", "TIMEOUT"]).optional(), failureClass: z.enum(["transient", "repairable", "contract", "security", "policy", "capacity", "infrastructure", "unknown_observed"]).optional(), resultDigest: z.string().nullable().optional() },
    },
    async (args) => write(args.idempotencyKey, async (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      if (args.phase === "started") {
        return respond(
          await port.startTaskExecution({
            runId: args.runId,
            taskId: args.taskId,
            ownerBindingGeneration: fenced.value.bindingGeneration,
            workerSessionId: args.workerSessionId ?? null,
            workerProcessId: args.workerProcessId ?? null,
            provider: args.provider,
            model: args.model,
            repositoryId: args.repositoryId ?? null,
            worktreeId: args.worktreeId ?? null,
            concurrencyWidth: port.taskRunningWidth(args.runId) + 1,
          }),
        );
      }
      if (!args.executionId) return respond(deny(ReasonCode.INVALID_ARGUMENT, "activity and finish need an execution id", { phase: args.phase }));
      return args.phase === "activity"
        ? respond(port.recordTaskActivity(args.executionId, args.runId))
        : respond(port.finishTaskExecution(args.executionId, { status: args.status ?? "SUCCEEDED", resultDigest: args.resultDigest ?? null, failureClass: args.failureClass ?? null }, args.runId));
    }),
  );
  server.registerTool(
    "result_submit",
    { description: "Submit a candidate for automatic verification and blind review.", inputSchema: { ...mutation, ...runIdentity, resultSummary: z.string(), recommendation: z.string(), residualRisk: z.array(z.string()).default([]), runScopedCommands: z.array(z.record(z.unknown())).default([]) } },
    async (args) => write(args.idempotencyKey, async (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      const commands = args.runScopedCommands.map((command) => parseVerificationCommand(command));
      return respond(await port.submitResult({ runId: args.runId, ownerSessionId: fenced.value.sessionId, ownerBindingGeneration: fenced.value.bindingGeneration, resultSummary: args.resultSummary, recommendation: args.recommendation, residualRisk: args.residualRisk, ...(commands.length === 0 ? {} : { runScopedCommands: commands }) }));
    }),
  );
  server.registerTool(
    "escalation_open",
    { description: "Escalate a decision to the CEO.", inputSchema: { ...mutation, ...runIdentity, question: z.string(), options: z.array(z.string()).min(1), ctoRecommendation: z.string(), whyItMatters: z.string(), blocksCriticalPath: z.boolean() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      const fenced = owner(peer, args.runId);
      if (!fenced.allowed) return respond(fenced);
      return respond(port.openEscalation({ runId: args.runId, question: args.question, options: args.options, ctoRecommendation: args.ctoRecommendation, whyItMatters: args.whyItMatters, blocksCriticalPath: args.blocksCriticalPath, openedBySessionId: fenced.value.sessionId, openedAt: new Date().toISOString() }));
    }),
  );
  server.registerTool(
    "handoff_submit",
    { description: "Submit a structured CTO handoff.", inputSchema: { ...mutation, projectId: z.string(), handoff: z.object({ projectStatus: z.string(), activeManifestDigest: z.string().nullable(), recentDecisions: z.array(z.string()).default([]), openBlockers: z.array(z.string()).default([]), queuedWork: z.array(z.string()).default([]), repositoryFacts: z.array(z.object({ identity: z.string(), branch: z.string().nullable(), head: z.string().nullable() })).default([]), knownRisks: z.array(z.string()).default([]), recommendedNextAction: z.string() }) } },
    async (args) => write(args.idempotencyKey, async (peer) => {
      if (!peer.sessionId || !peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation"));
      const binding = port.activePrimaryCto(args.projectId);
      if (!binding || binding.sessionId !== peer.sessionId || binding.sessionIncarnation !== peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "authenticated peer is not this project's primary CTO", { projectId: args.projectId }));
      return respond(await port.prepareSwitchover(args.projectId, args.handoff));
    }),
  );
  server.registerTool(
    "handoff_ack",
    { description: "Acknowledge a handoff as the authenticated incoming CTO.", inputSchema: { ...mutation, handoffId: z.string() } },
    async (args) => write(args.idempotencyKey, (peer) => {
      if (!peer.sessionId || !peer.sessionIncarnation) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation"));
      if (!port.sessionIsCurrent(peer.sessionId, peer.sessionIncarnation)) {
        return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current"));
      }
      const kind = port.handoffKind(args.handoffId);
      if (!kind) return respond(deny(ReasonCode.NOT_FOUND, "unknown handoff", { handoffId: args.handoffId }));
      return kind === "BOOTSTRAP"
        ? respond(port.acknowledgeBootstrap(args.handoffId, peer.sessionId))
        : respond(port.acknowledgeCto(args.handoffId, peer.sessionId));
    }),
  );
  server.registerTool(
    "capacity_get",
    { description: "Normalized provider capacity.", inputSchema: { ...mutation, refresh: z.boolean().default(false) } },
    async (args) => write(args.idempotencyKey, async () => {
      if (args.refresh) await port.refreshCapacity();
      return ok({ providers: port.capacity(), continuityMode: port.continuityMode() });
    }),
  );
  server.registerTool(
    "doctor_run",
    { description: "Read-only doctor pass.", inputSchema: { scope: z.enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"]).default("run"), target: z.string().optional() } },
    async (args) => read(async () => ok(await port.doctorRun(args.scope, args.target))),
  );
  server.registerTool(
    "blind_review_request",
    { description: "Not available: blind review is invoked by the control plane.", inputSchema: runIdentity },
    async (args) => read((peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? respond(port.manualReview(fenced.value.sessionId, args.runId)) : respond(fenced);
    }),
  );
  return server;
};

/** PRD §28.2 — CTO tools operate only as an authenticated, fenced session peer. */
export const createCtoServer = (
  port: CtoMcpPort,
  authenticate: McpPeerAuthenticator,
): McpServer => {
  assertCtoMcpPort(port);
  return createCtoServerFromPort(port, authenticate);
};
