import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { submittedPlanSchema, submittedTasksSchema } from "../bootstrap/plan-input-schema.ts";
import { readBootstrapPlanAttachment, resolveBootstrapPlanInput, bootstrapInputMutationAuthority, validateBootstrapPlanDigests } from "../bootstrap/bootstrap-plan-artifact.ts";
import type { BootstrapActivation, BootstrapHandoffReceipt } from "../bootstrap/activation.ts";
import type { BootstrapApplications } from "../bootstrap/bootstrap-applications.ts";
import { bootstrapPlanGuide, isProjectlessBootstrap, planForSubmission } from "../bootstrap/bootstrap-plan.ts";
import type { CapacityMonitor } from "../capacity/capacity-monitor.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { Clock } from "../core/clock.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { parseVerificationCommand } from "../contracts/verification-command.ts";
import type { CtoLifecycle, HandoffAcknowledgement } from "../cto/cto-lifecycle.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { Doctor } from "../doctor/doctor.ts";
import { ArtifactKind, Role, RunKind, roleKeyFor } from "../domain/types.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { contractChangePlanForSubmission, isContractChangeRun } from "../registry/contract-change-plan.ts";
import { firstActivationFactsOf } from "../registry/manifest-activation-grants.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { BlindReviewGate } from "../review/blind-review.ts";
import type { CandidatePipeline } from "../run/candidate-pipeline.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import { TaskWriteTargets } from "../run/task-write-target.ts";
import { WORKER_TURN_MAX_TIMEOUT_MS, type WorkerTurnRequest, type WorkerTurnRunner } from "../run/worker-turn.ts";
import type { WorkerProvisionRequest, WorkerStaffing } from "../run/worker-staffing.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { AttestingPeer, SessionAttestations } from "../session/session-attestations.ts";
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
  readonly audit: AuditLog;
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
  readonly sessionAttestations: SessionAttestations;
  readonly bootstrapApplications: Pick<BootstrapApplications, "assertNotFrozen">;
  readonly bindings: BindingRegistry;
  readonly tasks: TaskGraph;
  readonly workerTurns: WorkerTurnRunner;
  readonly workers: WorkerStaffing;
}

/** Only ports constructed below may be attached to an MCP server. */
const CTO_MCP_PORTS = new WeakSet<object>();

/**
 * #512 — what `contract_get` tells a STANDARD_WORK run's owner about the run's tasks, read from the
 * task graph, the WORKER bindings and the executions: each task's id, title, category, state, spec
 * (where its PLAN put the task's write target) and dependencies; its newest WORKER binding (session,
 * generation, binding status and the session's lifecycle) or null when none was ever bound; and its
 * executions (id, state, attempt, start and end). Identities and states only: no credential, secret
 * or process detail is read here.
 */
const standardWorkTasks = (source: CtoMcpSource, runId: string) => {
  const executions = source.tasks.executions(runId);
  return source.tasks.list(runId).map((task) => {
    const worker = source.bindings.history(roleKeyFor(Role.WORKER, { taskId: task.taskId })).at(-1) ?? null;
    return {
      taskId: task.taskId,
      title: task.title,
      category: task.category,
      state: task.state,
      spec: task.spec,
      dependsOn: task.dependsOn,
      worker: worker === null
        ? null
        : {
            sessionId: worker.sessionId,
            generation: worker.bindingGeneration,
            state: worker.status,
            sessionLifecycle: source.sessions.get(worker.sessionId)?.lifecycle ?? null,
          },
      executions: executions
        .filter((execution) => execution.taskId === task.taskId)
        .map((execution) => ({
          executionId: execution.executionId,
          state: execution.status,
          attempt: execution.attempt,
          startedAt: execution.startedAt,
          endedAt: execution.endedAt,
        })),
    };
  });
};

/**
 * Verifies the transport identity against durable session and binding facts. The session
 * tuple comes from the authenticated connection, while the current generation is read
 * from the binding registry; neither can be forged in a tool payload.
 */
const assertCtoRunPeerFromSource = (
  source: CtoMcpSource,
  peer: AuthenticatedMcpPeer,
  runId: string,
): Decision<{ sessionId: string; bindingGeneration: number; roleKey: string }> => {
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
  if (!owner.allowed) return owner as Decision<{ sessionId: string; bindingGeneration: number; roleKey: string }>;
  return allow(ReasonCode.OK, { sessionId: peer.sessionId, bindingGeneration: binding.bindingGeneration, roleKey: binding.roleKey });
};

/**
 * Builds function-only capabilities for CTO tools. No service instance, `Db`, or composition
 * root is reachable from the resulting object, so adding a tool cannot accidentally inherit
 * a database executor from the daemon (#352).
 */
export const createCtoMcpPort = (source: CtoMcpSource) => {
  const writeTargets = new TaskWriteTargets({ db: source.db, clock: source.clock, audit: source.audit });
  const port = Object.freeze({
    mutation: createMcpMutationPort(source),
    assertRunPeer: (peer: AuthenticatedMcpPeer, runId: string) => assertCtoRunPeerFromSource(source, peer, runId),
    sessionIsCurrent: (sessionId: string, incarnation: string) => {
      const session = source.sessions.get(sessionId);
      return Boolean(session && session.incarnation === incarnation);
    },
    acknowledge: (messageId: string, sessionId: string, bindingGeneration: number, sessionIncarnation: string) =>
      source.outbox.acknowledge(messageId, sessionId, bindingGeneration, sessionIncarnation),
    // Read-only: the caller's own in-band rows, fenced by the incarnation its connection presented.
    pendingInBandDispatch: (sessionId: string, sessionIncarnation: string) =>
      source.outbox.pendingInBandFor(sessionId, sessionIncarnation),
    // The same authority `run_ack` reaches for an in-band row, without a run.
    acknowledgeInBand: (messageId: string, sessionId: string, sessionIncarnation: string) =>
      source.outbox.acknowledgeInBand(messageId, sessionId, sessionIncarnation),
    // The connection authenticates as its own current session.
    attestSession: (peer: AttestingPeer) => source.sessionAttestations.attest(peer),
    contractForRun: (runId: string) => {
      const run = source.runs.require(runId);
      const manifest = run.pinnedManifestDigest ? source.projects.manifest(run.pinnedManifestDigest) : null;
      const plan = source.artifacts.latest(runId, ArtifactKind.PLAN);
      const input = run.kind === RunKind.PROJECT_BOOTSTRAP ? readBootstrapPlanAttachment(source, runId) : null;
      const contract = {
        run,
        ...(input?.allowed ? { bootstrapPlanDigest: input.value.digest } : {}),
        contract: source.artifacts.latest(runId, ArtifactKind.TASK_CONTRACT)?.content ?? null,
        ...(plan ? { plan: plan.content, tasks: standardWorkTasks(source, runId) } : {}),
        pinnedManifestDigest: run.pinnedManifestDigest,
        verificationCommands: manifest?.verificationCommands ?? [],
        branchProfile: manifest?.branchProfile ?? null,
        repositories: source.runs.repositoriesOf(runId),
      };
      // A project-less bootstrap run's owner also reads what its PLAN must carry: it has no tool that
      // runs code, and nothing else it can read says.
      if (isProjectlessBootstrap(run)) return { ...contract, bootstrapPlanGuide: bootstrapPlanGuide() };
      // #512 (CEO e64aa10b) — a STANDARD_WORK run's owner also reads the run's tasks, each with its
      // worker and its executions, so a turn that resumes after an interruption goes by the record
      // rather than by what its conversation kept. Answered only through `contract_get`, after its
      // owner fence admitted the caller as this run's current owner; identities and states only, never
      // a credential. A stored PLAN also exposes its tasks for outcome reconciliation.
      return run.kind === RunKind.STANDARD_WORK && !plan ? { ...contract, tasks: standardWorkTasks(source, runId) } : contract;
    },
    bootstrapInputMutationAuthority: (runId: string, result: boolean) => bootstrapInputMutationAuthority(source, runId, result),
    bootstrapPlanForRun: (runId: string) => readBootstrapPlanAttachment(source, runId),
    resolvePlanInput: (runId: string, input: { bootstrapPlanDigest?: string; plan?: Record<string, unknown>; tasks?: z.infer<typeof submittedTasksSchema> }) =>
      resolveBootstrapPlanInput(source, runId, input),
    // #246 C2 — a project-less bootstrap run's PLAN carries its manifest in full, checked portable
    // and against the digest the PLAN names before anything is stored. #246 B2-a — so does a
    // CONTRACT_CHANGE run's, checked against the run's pinned manifest as well. Any other run's is
    // stored exactly as before.
    submitPlan: (runId: string, plan: Record<string, unknown>, bootstrapPlanDigest?: string): Decision<{ digest: string }> => {
      // #246 C3 — the contract freeze: once an external write of a bootstrap run's application may
      // have happened, its PLAN is never replaced, so a recovery can only re-apply what was frozen.
      const frozen = source.bootstrapApplications.assertNotFrozen(runId, "plan_submit");
      if (!frozen.allowed) return frozen as Decision<{ digest: string }>;
      const run = source.runs.require(runId);
      if (isProjectlessBootstrap(run) && source.bootstrap.residentGenesisRequired && plan["genesis"] === undefined) return deny(ReasonCode.INVALID_ARGUMENT,"bootstrap PLAN requires inline genesis bytes",{refusal:"GENESIS_MISSING"});
      const admitted = isContractChangeRun(run)
        ? contractChangePlanForSubmission(run, plan, (digest) => source.projects.manifest(digest), firstActivationFactsOf(source.db, run))
        : planForSubmission(run, plan);
      if (!admitted.allowed) return admitted as Decision<{ digest: string }>;
      const stored = isProjectlessBootstrap(run) && admitted.value["genesis"] !== undefined
        ? {...admitted.value,originatingContract:source.artifacts.latest<unknown>(runId,ArtifactKind.TASK_CONTRACT)?.content ?? null}
        : admitted.value;
      return allow(ReasonCode.OK, { digest: source.artifacts.put(runId, ArtifactKind.PLAN, bootstrapPlanDigest ? { ...stored, bootstrapPlanDigest } : stored).digest });
    },
    submitTasks: (runId: string, tasks: Parameters<TaskGraph["submit"]>[1]) => source.tasks.submit(runId, tasks),
    isProjectlessBootstrapRun: (runId: string) => isProjectlessBootstrap(source.runs.require(runId)),
    // PR #1114 BOOT-02 — a project-less bootstrap's re-plan is all or nothing: the PLAN write, the
    // supersession of the earlier PLAN's tasks, the one new task and its BOOTSTRAP_PLAN_TASKS binding
    // commit in one transaction, and any refusal rolls every one of them back. BOOT-01 — the graph is
    // one task with no dependency: the repository create that CEO CONFIRM settles from its receipt.
    submitBootstrapPlan: (runId: string, plan: Record<string, unknown>, tasks: Parameters<TaskGraph["submit"]>[1], bootstrapPlanDigest?: string) =>
      source.db.txDecision((): Decision<unknown> => {
        const stored = port.submitPlan(runId, plan, bootstrapPlanDigest);
        if (!stored.allowed) return stored;
        // ROUND1-ESCAPE-01 — the artifact store hands back an identical earlier PLAN without making it
        // current, so a re-plan to it would leave the newer PLAN current behind its tasks. It is refused
        // with both digests, and nothing is changed; re-submitting the current PLAN is accepted as before.
        const current = source.artifacts.latest(runId, ArtifactKind.PLAN)?.digest ?? null;
        if (current !== stored.value.digest) {
          return deny(
            ReasonCode.CONFLICT,
            "this PLAN is an earlier one the run already stored, not its current PLAN; change the PLAN and submit it again",
            { runId, refusal: "BOOTSTRAP_PLAN_RESUBMITTED_NOT_CURRENT", currentPlanDigest: current, resubmittedPlanDigest: stored.value.digest },
          );
        }
        if (tasks.length !== 1 || (tasks[0]!.dependsOn ?? []).length > 0) {
          return deny(
            ReasonCode.INVALID_ARGUMENT,
            "a project-less bootstrap PLAN carries exactly one task, with no dependency: the repository create its CEO CONFIRM settles",
            { runId, refusal: "BOOTSTRAP_PLAN_TASK_COUNT", tasks: tasks.length },
          );
        }
        const submitted = port.submitTasks(runId, tasks);
        return submitted.allowed && bootstrapPlanDigest
          ? allow(ReasonCode.OK, { digest: bootstrapPlanDigest, planDigest: current, tasks: submitted.value })
          : submitted;
      }),
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
    // #512 — the runtime launches and owns a worker turn; the CTO names run, task and claim only.
    startWorkerTurn: (input: WorkerTurnRequest) => source.workerTurns.start(input),
    workerExecution: (executionId: string, runId: string) => source.workerTurns.describe(executionId, runId),
    executionIsRuntimeManaged: (executionId: string) => source.tasks.execution(executionId)?.runtimeManaged === true,
    taskIsRuntimeManaged: (taskId: string) =>
      Boolean(source.db.get<{ n: number }>(
        `SELECT 1 AS n FROM task_executions WHERE task_id = ? AND runtime_managed = 1 LIMIT 1`,
        [taskId],
      )),
    // #512 — mints a task's first WORKER binding on a session the control plane constitutes.
    // #512 S-TB (CEO 0a16329c) — a STANDARD_WORK task's write target is recorded when its first worker
    // is provisioned: the control plane derives what the PLAN left out (never the prompt), writes it
    // into the task's spec, which contract_get answers, and returns it here. A target it cannot derive
    // is refused by name in `writeTargetRefused`; the worker stays staffed, and a claim has nothing to
    // take until the CTO escalates. Any other run kind is answered exactly as before.
    provisionWorker: async (request: WorkerProvisionRequest) => {
      const provisioned = await source.workers.provision(request);
      if (!provisioned.allowed) return provisioned;
      const fence = () => {
        const fenced = request.fence();
        return fenced.allowed && fenced.value.bindingGeneration !== request.ownerBindingGeneration
          ? deny(ReasonCode.BINDING_GENERATION_STALE, "the run's owner generation changed while its worker was provisioned", { runId: request.runId })
          : fenced;
      };
      let target: Decision<unknown>;
      try {
        target = await writeTargets.ensure(request.runId, request.taskId, fence);
      } catch (error) {
        target = deny(ReasonCode.INTERNAL_ERROR, "the task's write target could not be recorded", {
          taskId: request.taskId,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
      if (target.allowed && target.value === null) return provisioned;
      return allow(provisioned.reasonCode, target.allowed
        ? { ...provisioned.value, writeTarget: target.value }
        : {
            ...provisioned.value,
            writeTarget: null,
            writeTargetRefused: { reasonCode: target.reasonCode, message: target.message, evidence: target.evidence },
          });
    },
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
    handoffAuthority: (messageId: string) => {
      const message = source.outbox.get(messageId);
      return { roleKey: message?.roleKey ?? null, bindingGeneration: message?.bindingGeneration ?? null };
    },
    handoffKind: (handoffId: string) => source.db.get<{ kind: string }>(`SELECT kind FROM handoffs WHERE handoff_id = ?`, [handoffId])?.kind ?? null,
    acknowledgeBootstrap: (handoffId: string, sessionId: string, sessionIncarnation: string, receipt: BootstrapHandoffReceipt, replayOnly = false) =>
      source.db.txDecision(() => {
        // Cache validation may only re-ACK a settled package, never execute a new ACK.
        if (replayOnly && source.db.get<{ status: string }>("SELECT status FROM handoffs WHERE handoff_id = ?", [handoffId])?.status !== "ACKED") {
          return deny(ReasonCode.HANDOFF_ACK_REQUIRED, "cached ACK requires an acknowledged handoff");
        }
        return source.bootstrap.acknowledgeActivationHandoff(handoffId, sessionId, sessionIncarnation, receipt);
      }),
    acknowledgeCto: (handoffId: string, acknowledgement: HandoffAcknowledgement) =>
      source.cto.acknowledgeHandoff(handoffId, acknowledgement),
    reacknowledgeCto: (handoffId: string, acknowledgement: HandoffAcknowledgement) =>
      source.cto.reacknowledgeHandoff(handoffId, acknowledgement),
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

/**
 * The daemon supplies this only for an unbound recipient of a current normal handoff. The
 * sealed port still owns all lifecycle calls; this context merely narrows which registered
 * operation the transport-authenticated connection may reach.
 */
export interface CtoMcpAccess {
  pendingHandoffId?: string;

}

interface SessionSecretPeer extends AuthenticatedMcpPeer {
  sessionSecret?: string;
}

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
): Decision<{ sessionId: string; bindingGeneration: number; roleKey: string }> => port.assertRunPeer(peer, runId);

/**
 * This scope deliberately receives only the port. Every registered handler closes over this
 * parameter, so even a future tool cannot reach a construction-time source by accident (#352).
 */
const createCtoServerFromPort = (
  port: CtoMcpPort,
  authenticate: McpPeerAuthenticator,
  access: CtoMcpAccess = {},
): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-cto", version: "1.3.0" });
  const peerFor = (toolName: string): Decision<AuthenticatedMcpPeer> => {
    const peer = authenticateMcpPeer(authenticate);
    if (!peer.allowed) return peer;
    if (access.pendingHandoffId && toolName !== "handoff_ack") {
      return deny(
        ReasonCode.MCP_PEER_UNAUTHENTICATED,
        "an unbound handoff recipient may only acknowledge its pending handoff",
        { handoffId: access.pendingHandoffId, toolName },
      );
    }
    return peer;
  };
  const read = (
    toolName: string,
    execute: (peer: AuthenticatedMcpPeer) => Promise<ToolResult> | ToolResult,
  ) =>
    guarded(() => {
      const peer = peerFor(toolName);
      return peer.allowed ? execute(peer.value) : respond(peer);
    });
  const write = (
    toolName: string,
    args: Record<string, unknown> & { idempotencyKey: string },
    execute: (peer: AuthenticatedMcpPeer) => Promise<ToolResult> | ToolResult,
    authority: (peer: AuthenticatedMcpPeer) => Decision<Record<string, unknown>> = () => allow(ReasonCode.OK, {}),
  ) => guarded(async () => {
    const peer = peerFor(toolName);
    return peer.allowed
      ? port.mutation.execute(peer.value, args.idempotencyKey, () => execute(peer.value), {
          toolName, arguments: args, authority: () => {
            const current = peerFor(toolName);
            return current.allowed ? authority(current.value) : current;
          },
        })
      : respond(peer);
  });
  const owner = (peer: AuthenticatedMcpPeer, runId: string): Decision<{ sessionId: string; bindingGeneration: number; roleKey: string }> =>
    assertCtoRunPeer(port, peer, runId);
  const writeOwned = (
    toolName: string,
    args: Record<string, unknown> & { idempotencyKey: string; runId: string },
    execute: (peer: AuthenticatedMcpPeer, owner: { sessionId: string; bindingGeneration: number; roleKey: string }) => Promise<ToolResult> | ToolResult,
  ) => {
    let current!: { sessionId: string; bindingGeneration: number; roleKey: string };
    return write(toolName, args, peer => execute(peer, current), peer => {
      const fenced = owner(peer, args.runId);
      if (fenced.allowed) {
        current = fenced.value;
        if (toolName === "plan_submit") {
          const digests = validateBootstrapPlanDigests({ bootstrapPlanDigest: args.bootstrapPlanDigest as string | undefined });
          if (!digests.allowed) return digests;
        }
        if (toolName === "plan_submit" || toolName === "result_submit") {
          const input = port.bootstrapInputMutationAuthority(args.runId, toolName === "result_submit");
          return input.allowed ? allow(ReasonCode.OK, { ...fenced.value, ...input.value }) : input;
        }
      }
      return fenced;
    });
  };
  const primary = (peer: AuthenticatedMcpPeer, projectId: string): Decision<Record<string, unknown>> => {
    if (!peer.sessionId || !peer.sessionIncarnation) return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation");
    const binding = port.activePrimaryCto(projectId);
    if (!binding || binding.sessionId !== peer.sessionId || binding.sessionIncarnation !== peer.sessionIncarnation
        || !port.sessionIsCurrent(peer.sessionId, peer.sessionIncarnation)) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "authenticated peer is not this project's primary CTO", { projectId });
    }
    return allow(ReasonCode.OK, { roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration });
  };

  server.registerTool(
    "run_ack",
    { description: "Acknowledge a dispatched run and its fenced envelope.", inputSchema: { ...mutation, ...runIdentity, messageId: z.string() } },
    async (args) => writeOwned("run_ack", args, (peer, fenced) => {
      // The run fence passed, so the peer carries an incarnation; an in-band row is then settled by
      // the same authority `role_dispatch_ack` uses (`Outbox.acknowledge` routes it there).
      return respond(port.acknowledge(args.messageId, fenced.sessionId, fenced.bindingGeneration, peer.sessionIncarnation ?? ""));
    }),
  );
  server.registerTool(
    "role_dispatch_pending",
    {
      description:
        "The pending control-plane messages (dispatch, revision, escalation reply, drain, cancel, bootstrap handoff) addressed in band to this exact session at its active generation. Acknowledge a HANDOFF_PACKAGE with handoff_ack; other messages use role_dispatch_ack (or run_ack, for a row that names a run this session owns).",
      inputSchema: {},
    },
    async () => read("role_dispatch_pending", (peer) => {
      // The session is the authenticated connection's, never an argument: there is no input
      // through which one session could ask for another's rows. The incarnation is checked here
      // and again inside the read, which matches rows only to the current holder of their own
      // role generation down to that incarnation.
      if (!peer.sessionId || !peer.sessionIncarnation) {
        return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation"));
      }
      if (!port.sessionIsCurrent(peer.sessionId, peer.sessionIncarnation)) {
        return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current", {
          sessionId: peer.sessionId,
        }));
      }
      return ok({ messages: port.pendingInBandDispatch(peer.sessionId, peer.sessionIncarnation) });
    }),
  );
  server.registerTool(
    "role_dispatch_ack",
    {
      description:
        "Acknowledge one message role_dispatch_pending listed for this session. Needs no run: a drain request carries none.",
      inputSchema: { messageId: z.string().min(1) },
    },
    // Authenticated exactly as role_dispatch_pending is. No idempotency key, like the role_owner_message
    // tools: the write is a compare-and-set on PENDING, so a retry is answered by the row's own state.
    async (args) => guarded(() => {
      const peer = peerFor("role_dispatch_ack");
      if (!peer.allowed) return respond(peer);
      const { sessionId, sessionIncarnation } = peer.value;
      if (!sessionId || !sessionIncarnation) {
        return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation"));
      }
      if (!port.sessionIsCurrent(sessionId, sessionIncarnation)) {
        return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current", { sessionId }));
      }
      return respond(port.acknowledgeInBand(args.messageId, sessionId, sessionIncarnation));
    }),
  );
  server.registerTool(
    "session_attest",
    {
      description:
        "Confirm this connection authenticates with the session's current credential. No readiness challenge is required.",
      inputSchema: {},
    },
    // The session, incarnation and secret are the authenticated connection's, never arguments; the
    // registry verifies its current credential and incarnation.
    async () => guarded(() => {
      const peer = peerFor("session_attest");
      if (!peer.allowed) return respond(peer);
      const { sessionId, sessionIncarnation } = peer.value;
      const sessionSecret = (peer.value as SessionSecretPeer).sessionSecret;
      if (!sessionId || !sessionIncarnation || !sessionSecret) {
        return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "only a connection authenticated with a session credential can attest"));
      }
      return respond(port.attestSession({ sessionId, sessionIncarnation, sessionSecret }));
    }),
  );
  server.registerTool(
    "contract_get",
    { description: "The pinned task contract and verification contract for a run.", inputSchema: runIdentity },
    async (args) => read("contract_get", (peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? ok(port.contractForRun(args.runId)) : respond(fenced);
    }),
  );
  server.registerTool(
    "bootstrap_plan_get",
    { description: "Read this run's CEO-delivered bootstrap PLAN input and exact-byte digest.", inputSchema: runIdentity },
    async (args) => read("bootstrap_plan_get", (peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? respond(port.bootstrapPlanForRun(args.runId)) : respond(fenced);
    }),
  );
  server.registerTool(
    "plan_submit",
    {
      description: "Submit the lean plan and dynamic task graph.",
      inputSchema: {
        ...mutation, ...runIdentity,
        bootstrapPlanDigest: z.string().optional(),
        plan: submittedPlanSchema.optional(),
        tasks: submittedTasksSchema.optional(),
      },
    },
    async (args) => writeOwned("plan_submit", args, () => {
      const resolved = port.resolvePlanInput(args.runId, args);
      if (!resolved.allowed) return respond(resolved);
      const { plan, tasks, bootstrapPlanDigest } = resolved.value;
      if (port.isProjectlessBootstrapRun(args.runId)) return respond(port.submitBootstrapPlan(args.runId, plan, tasks, bootstrapPlanDigest));
      const stored = port.submitPlan(args.runId, plan, bootstrapPlanDigest);
      if (!stored.allowed) return respond(stored);
      return respond(port.submitTasks(args.runId, tasks));
    }),
  );
  server.registerTool(
    "resource_claim",
    { description: "Claim a branch, worktree and exact write paths.", inputSchema: { ...mutation, ...runIdentity, repositoryIdentity: z.string(), branch: z.string().nullable().optional(), worktreeId: z.string().nullable().optional(), declaredPaths: z.array(z.string()).default([]), ttlMs: z.number().int().positive().optional() } },
    async (args) => writeOwned("resource_claim", args, (peer, fenced) => {
      const roleKey = port.ownerRoleKeyForRun(args.runId);
      if (!roleKey) return respond(deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no owner role key", {}));
      const acquired = port.acquireClaims({ runId: args.runId, ownerSessionId: fenced.sessionId, ownerBindingGeneration: fenced.bindingGeneration, ownerRoleKey: roleKey, repositoryIdentity: args.repositoryIdentity, branch: args.branch ?? null, worktreeId: args.worktreeId ?? null, declaredPaths: args.declaredPaths, ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }) });
      if (!acquired.allowed) return respond(acquired);
      const advisory = port.advisoryOverlaps(args.repositoryIdentity, args.runId, args.declaredPaths);
      return respond(allow(advisory.length > 0 ? ReasonCode.SEMANTIC_CONFLICT_ADVISORY : ReasonCode.OK, { claims: acquired.value, advisoryOverlaps: advisory }));
    }),
  );
  server.registerTool(
    "resource_release",
    { description: "Release held claims.", inputSchema: { ...mutation, ...runIdentity, claimId: z.string().nullable().optional() } },
    async (args) => writeOwned("resource_release", args, () => {
      return args.claimId ? respond(port.releaseClaim(args.claimId, args.runId)) : ok({ released: port.releaseRunClaims(args.runId) });
    }),
  );
  server.registerTool(
    "task_receipt_submit",
    {
      description:
        "Open or close a task execution receipt. A started receipt runs under its worker session's own provider and model: omit them, or state the session's.",
      inputSchema: { ...mutation, ...runIdentity, taskId: z.string(), phase: z.enum(["started", "activity", "finished"]), executionId: z.string().nullable().optional(), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), workerSessionId: z.string(), workerProcessId: z.number().int().nullable().optional(), repositoryId: z.string().nullable().optional(), worktreeId: z.string().nullable().optional(), status: z.enum(["SUCCEEDED", "FAILED", "ABANDONED", "TIMEOUT"]).optional(), failureClass: z.enum(["transient", "repairable", "contract", "security", "policy", "capacity", "infrastructure", "unknown_observed"]).optional(), resultDigest: z.string().nullable().optional() },
    },
    async (args) => writeOwned("task_receipt_submit", args, async (peer, fenced) => {
      // #512 — a runtime-managed execution's started and finished receipts are the control plane's.
      // The CTO may not open one for a task the runtime runs, nor close one with a status of its choosing.
      if (
        (args.phase === "started" &&
          (port.taskIsRuntimeManaged(args.taskId) || (args.executionId != null && port.executionIsRuntimeManaged(args.executionId)))) ||
        (args.phase === "finished" && args.executionId != null && port.executionIsRuntimeManaged(args.executionId))
      ) {
        return respond(deny(
          ReasonCode.COMPLETION_AUTHORITY_DENIED,
          "the control plane owns this runtime-managed execution's receipts; task_receipt_submit may not open or finish it",
          { taskId: args.taskId, executionId: args.executionId ?? null, phase: args.phase },
        ));
      }
      if (args.phase === "started") {
        return respond(
          await port.startTaskExecution({
            runId: args.runId,
            taskId: args.taskId,
            ownerBindingGeneration: fenced.bindingGeneration,
            workerSessionId: args.workerSessionId,
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
    "task_worker_run",
    {
      description:
        "Run one worker turn for a task: the control plane launches the task's WORKER session in the claimed worktree, verifies and commits its change, and owns the receipts. Returns the execution id at once; read it with task_execution_get.",
      inputSchema: {
        ...mutation,
        ...runIdentity,
        taskId: z.string().min(1),
        claimId: z.string().min(1),
        timeoutMs: z.number().int().positive().max(WORKER_TURN_MAX_TIMEOUT_MS).optional(),
      },
    },
    async (args) => writeOwned("task_worker_run", args, async (peer, fenced) => {
      return respond(await port.startWorkerTurn({
        runId: args.runId,
        taskId: args.taskId,
        claimId: args.claimId,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ownerSessionId: fenced.sessionId,
        ownerBindingGeneration: fenced.bindingGeneration,
      }));
    }),
  );
  server.registerTool(
    "task_worker_provision",
    {
      description:
        "Staff a READY task of an ACTIVE run you own with its first worker: a fresh session the control plane constitutes, admits capacity for, and binds as the task's WORKER. Returns the worker session id to name in task_receipt_submit.",
      inputSchema: {
        ...mutation, ...runIdentity,
        taskId: z.string().min(1),
        // Required, never defaulted: the control plane does not choose a provider for the CTO.
        provider: z.string().min(1),
        model: z.string().min(1).optional(),
      },
    },
    async (args) => writeOwned("task_worker_provision", args, async (peer, fenced) => {
      return respond(await port.provisionWorker({
        runId: args.runId,
        taskId: args.taskId,
        provider: args.provider,
        model: args.model,
        ownerBindingGeneration: fenced.bindingGeneration,
        // The same fence, asked again after the capacity await and inside the bind transaction.
        fence: () => owner(peer, args.runId),
      }));
    }),
  );
  server.registerTool(
    "task_execution_get",
    {
      description:
        "Read one task execution of a run you own: its state, and either its success digest with the inputs it was computed from or its failure diagnostics.",
      inputSchema: { ...runIdentity, executionId: z.string().min(1) },
    },
    async (args) => read("task_execution_get", (peer) => {
      const fenced = owner(peer, args.runId);
      return fenced.allowed ? respond(port.workerExecution(args.executionId, args.runId)) : respond(fenced);
    }),
  );
  server.registerTool(
    "result_submit",
    { description: "Submit a candidate for automatic verification and blind review.", inputSchema: { ...mutation, ...runIdentity, resultSummary: z.string(), recommendation: z.string(), residualRisk: z.array(z.string()).default([]), runScopedCommands: z.array(z.record(z.unknown())).default([]) } },
    async (args) => writeOwned("result_submit", args, async (peer, fenced) => {
      const commands = args.runScopedCommands.map((command) => parseVerificationCommand(command));
      return respond(await port.submitResult({ runId: args.runId, ownerSessionId: fenced.sessionId, ownerBindingGeneration: fenced.bindingGeneration, resultSummary: args.resultSummary, recommendation: args.recommendation, residualRisk: args.residualRisk, ...(commands.length === 0 ? {} : { runScopedCommands: commands }) }));
    }),
  );
  server.registerTool(
    "escalation_open",
    { description: "Escalate a decision to the CEO.", inputSchema: { ...mutation, ...runIdentity, question: z.string(), options: z.array(z.string()).min(1), ctoRecommendation: z.string(), whyItMatters: z.string(), blocksCriticalPath: z.boolean() } },
    async (args) => writeOwned("escalation_open", args, (peer, fenced) => {
      return respond(port.openEscalation({ runId: args.runId, question: args.question, options: args.options, ctoRecommendation: args.ctoRecommendation, whyItMatters: args.whyItMatters, blocksCriticalPath: args.blocksCriticalPath, openedBySessionId: fenced.sessionId, openedAt: new Date().toISOString() }));
    }),
  );
  server.registerTool(
    "handoff_submit",
    { description: "Submit a structured CTO handoff.", inputSchema: { ...mutation, projectId: z.string(), handoff: z.object({ projectStatus: z.string(), activeManifestDigest: z.string().nullable(), recentDecisions: z.array(z.string()).default([]), openBlockers: z.array(z.string()).default([]), queuedWork: z.array(z.string()).default([]), repositoryFacts: z.array(z.object({ identity: z.string(), branch: z.string().nullable(), head: z.string().nullable() })).default([]), knownRisks: z.array(z.string()).default([]), recommendedNextAction: z.string() }) } },
    async (args) => write("handoff_submit", args,
      async () => respond(await port.prepareSwitchover(args.projectId, args.handoff)),
      peer => primary(peer, args.projectId)),
  );
  server.registerTool(
    "handoff_ack",
    {
      description: "Acknowledge a handoff as the authenticated incoming CTO.",
      inputSchema: {
        ...mutation,
        handoffId: z.string(),
        messageId: z.string().min(1),
        payloadDigest: z.string().min(1),
        bindingGeneration: z.number().int().positive(),
      },
    },
    async (args) => guarded(async () => {
      const authenticated = peerFor("handoff_ack");
      if (!authenticated.allowed) return respond(authenticated);
      const peer = authenticated.value;
      const acknowledge = (replayOnly = false): Decision<unknown> => {
        if (!peer.sessionId || !peer.sessionIncarnation) return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP peer is missing a session incarnation");
        if (!port.sessionIsCurrent(peer.sessionId, peer.sessionIncarnation)) {
          return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "CTO MCP session incarnation is not current");
        }
        if (access.pendingHandoffId && access.pendingHandoffId !== args.handoffId) {
          return deny(
            ReasonCode.HANDOFF_ACK_REQUIRED,
            "pending handoff recipient may acknowledge only its delivered handoff",
            { expected: access.pendingHandoffId, got: args.handoffId },
          );
        }
        const kind = port.handoffKind(args.handoffId);
        if (!kind) return deny(ReasonCode.NOT_FOUND, "unknown handoff", { handoffId: args.handoffId });
        if (kind === "BOOTSTRAP") return port.acknowledgeBootstrap(args.handoffId, peer.sessionId, peer.sessionIncarnation, {
          messageId: args.messageId, bindingGeneration: args.bindingGeneration, payloadDigest: args.payloadDigest,
        }, replayOnly);
        const sessionSecret = (peer as SessionSecretPeer).sessionSecret;
        if (!sessionSecret) {
          return deny(
            ReasonCode.MCP_PEER_UNAUTHENTICATED,
            "CTO MCP peer has no session credential for a normal handoff acknowledgement",
            { handoffId: args.handoffId },
          );
        }
        return (replayOnly ? port.reacknowledgeCto : port.acknowledgeCto)(args.handoffId, {
          sessionId: peer.sessionId,
          sessionIncarnation: peer.sessionIncarnation,
          sessionSecret,
          messageId: args.messageId,
          payloadDigest: args.payloadDigest,
          bindingGeneration: args.bindingGeneration,
        });
      };
      return port.mutation.execute(peer, args.idempotencyKey, () => respond(acknowledge()), {
        toolName: "handoff_ack", arguments: args,
        // Domain re-ACK validates the package's current role/generation, including switchover
        // recipients that were unbound at the first ACK. It must remain a replay-only check.
        authority: () => {
          const current = peerFor("handoff_ack");
          return current.allowed ? allow(ReasonCode.OK, port.handoffAuthority(args.messageId)) : current;
        },
        replayAuthority: () => {
          const decision = acknowledge(true);
          return decision.allowed ? decision : deny(ReasonCode.HANDOFF_ACK_REQUIRED,
            "cached ACK requires the same package, principal and current authority");
        },
      });
    }),
  );
  server.registerTool(
    "capacity_get",
    { description: "Normalized provider capacity.", inputSchema: { ...mutation, refresh: z.boolean().default(false) } },
    async (args) => write("capacity_get", args, async () => {
      if (args.refresh) await port.refreshCapacity();
      return ok({ providers: port.capacity(), continuityMode: port.continuityMode() });
    }, peer => peer.binding
      ? allow(ReasonCode.OK, { ...peer.binding })
      : deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "capacity_get requires current socket binding authority")),
  );
  server.registerTool(
    "doctor_run",
    { description: "Read-only doctor pass.", inputSchema: { scope: z.enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"]).default("run"), target: z.string().optional() } },
    async (args) => read("doctor_run", async () => ok(await port.doctorRun(args.scope, args.target))),
  );
  server.registerTool(
    "blind_review_request",
    { description: "Not available: blind review is invoked by the control plane.", inputSchema: runIdentity },
    async (args) => read("blind_review_request", (peer) => {
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
  access: CtoMcpAccess = {},
): McpServer => {
  assertCtoMcpPort(port);
  return createCtoServerFromPort(port, authenticate, access);
};
