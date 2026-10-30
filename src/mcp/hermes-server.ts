import { frontierReviewPolicy } from "../review/frontier-simplify-policy.ts";
import { attachBootstrapReviewEvidence, reviewEvidenceAttachAccess, reviewEvidenceAttachAuthority, type ReviewEvidenceInput } from "../bootstrap/bootstrap-review-evidence.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  attachBootstrapPlan, bootstrapPlanAttachAccess, bootstrapPlanAttachAuthority, validateBootstrapPlanDigests,
  BOOTSTRAP_PLAN_MAX_BYTES, type BootstrapPlanAttachInput, bootstrapReviewResumeAccess,
  replayBootstrapReviewResume, resumeBootstrapReview, type BootstrapReviewResumeInput,
} from "../bootstrap/bootstrap-plan-artifact.ts";
import { bootstrapApplicationOf, type BootstrapApplicationPhase, type BootstrapApplications } from "../bootstrap/bootstrap-applications.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { acknowledgeCeoNotification, ceoNotificationAckAccess, replayCeoNotificationAck, type CeoNotificationAckInput } from "../outbox/ceo-notification-ack.ts";
import type { CapacityMonitor } from "../capacity/capacity-monitor.ts";
import type { RepoFactoryBootstrapRunner } from "../bootstrap/repo-factory-bootstrap-run.ts";
import {
  type CeoDecisionInput,
  ESCALATION_RESOLUTION_MAX_LENGTH,
  escalationRequestDigestOf,
  type ProductionGate,
} from "../ceo/production-gate.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
import { isReasonCode, ReasonCode } from "../core/reason-codes.ts";
import type { CtoLifecycle } from "../cto/cto-lifecycle.ts";
import type { Db } from "../db/database.ts";
import type { Doctor } from "../doctor/doctor.ts";
import type { ExecutionMode, RunPriority } from "../domain/types.ts";
import { Role, roleKeyFor, RunKind, RunState } from "../domain/types.ts";
import { isTerminal } from "../domain/run-state.ts";
import type { RepairService } from "../doctor/repair.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { ContinuityKernel } from "../continuity/continuity-kernel.ts";
import {
  admitHermesProvenance,
  type HermesAdmittedTurn,
  type HermesProvenanceAnchor,
  HERMES_READ_ONLY_TOOLS,
  type HermesToolCall,
} from "./hermes-provenance.ts";
import {
  type AuthenticatedMcpPeer,
  authenticateMcpPeer,
  createMcpMutationPort,
  guarded,
  ok,
  type McpMutationRequest,
  type McpMutationSource,
  type McpPeerAuthenticator,
  respond,
  type ToolResult,
} from "./shared.ts";

const contractSchema = z.object({
  goal: z.string().min(1),
  why: z.string().min(1),
  scope: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1),
  priority: z.enum(["CRITICAL", "NORMAL", "LOW"]).default("NORMAL"),
  humanGate: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
});

const mutation = { idempotencyKey: z.string().min(1) };

/**
 * Inputs from the composition root are reduced to function-only capabilities before a server
 * is built. Server factories never accept this shape, so a handler cannot receive a fixture or
 * production composition root through a compatibility shortcut (#352).
 */
export interface HermesMcpSource extends McpMutationSource {
  readonly db: Db;
  readonly artifacts: ArtifactStore;
  readonly bootstrapApplications: Pick<BootstrapApplications, "assertNotFrozen">;
  readonly audit: AuditLog;
  readonly outbox: Outbox;
  readonly clock: Clock;
  readonly capacity: CapacityMonitor;
  readonly ceo: ProductionGate;
  readonly claims: ClaimRegistry;
  readonly continuity: ContinuityKernel;
  readonly cto: CtoLifecycle;
  readonly doctor: Doctor;
  readonly projects: ProjectRegistry;
  readonly repair: RepairService;
  readonly repositories: RepositoryRegistry;
  readonly runs: RunEngine;
  readonly tasks: TaskGraph;
  readonly bindings: BindingRegistry;
  readonly bootstrapProducer: Pick<RepoFactoryBootstrapRunner, "produceAndActivateApproved">;
}

/** Only ports constructed below may be attached to an MCP server. */
const HERMES_MCP_PORTS = new WeakSet<object>();

/** The refusal a stored MCP body or a `last_refusal_json` record carries, or null when it carries none. */
const refusalOf = (value: Record<string, unknown> | null | undefined): { reasonCode: ReasonCode; message: string; evidence: Evidence } | null => {
  const reasonCode = value?.["reasonCode"];
  const message = value?.["message"];
  const evidence = value?.["evidence"];
  return typeof reasonCode === "string" && isReasonCode(reasonCode) && typeof message === "string"
    && typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
    ? { reasonCode, message, evidence: evidence as Evidence }
    : null;
};

/** A replay's answer for an application in a terminal phase that is not this CONFIRM's completion. */
const TERMINAL_APPLICATION_REFUSALS: Partial<Record<BootstrapApplicationPhase, { reasonCode: ReasonCode; message: string }>> = {
  STRANDED: {
    reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_STRANDED,
    message: "this bootstrap run's application is STRANDED: what GitHub holds could not be attributed to it, and a person resolves it",
  },
  RELEASED: {
    reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
    message: "this bootstrap run's application is RELEASED: its reservation ended with no external effect, and nothing is applied",
  },
  COMPLETED: {
    reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
    message: "this bootstrap run's application is COMPLETED for another candidate than this CONFIRM's",
  },
};

/**
 * Builds function-only Hermes operations. The returned object deliberately exposes neither a
 * database facade nor a service instance, so an MCP tool handler cannot recover raw SQL from
 * the daemon's composition root (#352).
 */
export const createHermesMcpPort = (
  source: HermesMcpSource,
  options: { onCeoApproved?: (runId: string) => void | Promise<unknown> } = {},
) => {
  const port = Object.freeze({
    mutation: createMcpMutationPort(source),
    ceoNotificationAckAccess: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, messageId: string) =>
      ceoNotificationAckAccess(source, peer, turn, messageId),
    acknowledgeCeoNotification: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: CeoNotificationAckInput, fingerprint: string) =>
      acknowledgeCeoNotification(source, peer, turn, input, fingerprint),
    replayCeoNotificationAck: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: CeoNotificationAckInput, fingerprint: string, reservationVerified: boolean) =>
      replayCeoNotificationAck(source, peer, turn, input, fingerprint, reservationVerified),
    // Authentication owns admission; capture the role that authorized a session-bearing peer.
    peerAuthority: (peer: AuthenticatedMcpPeer): Decision<Record<string, unknown>> => {
      if (!peer.sessionId) return allow(ReasonCode.OK, {});
      const binding = source.bindings.active(roleKeyFor(Role.CEO));
      if (!binding || binding.sessionId !== peer.sessionId || binding.sessionIncarnation !== peer.sessionIncarnation) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "Hermes peer is no longer the current CEO");
      }
      return allow(ReasonCode.OK, { roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration });
    },
    replayBootstrapReviewResume: (peer: AuthenticatedMcpPeer, input: BootstrapReviewResumeInput, fingerprint: string) =>
      replayBootstrapReviewResume(source, peer, input, fingerprint),
    resumeBootstrapReview: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: BootstrapReviewResumeInput, fingerprint: string) =>
      resumeBootstrapReview(source, peer, turn, input, fingerprint),
    bootstrapReviewResumeAccess: (input: BootstrapReviewResumeInput) => bootstrapReviewResumeAccess(source, input),
    attachBootstrapReviewEvidence: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: ReviewEvidenceInput) =>
      attachBootstrapReviewEvidence(source, peer, turn, input),
    reviewEvidenceAttachAccess: (input: ReviewEvidenceInput) => reviewEvidenceAttachAccess(source, input),
    reviewEvidenceAttachAuthority: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined) =>
      reviewEvidenceAttachAuthority(source, peer, turn),
    attachBootstrapPlan: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: BootstrapPlanAttachInput) =>
      attachBootstrapPlan(source, peer, turn, input),
    bootstrapPlanAttachAuthority: (peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined) =>
      bootstrapPlanAttachAuthority(source, peer, turn),
    bootstrapPlanAttachAccess: (input: BootstrapPlanAttachInput) => bootstrapPlanAttachAccess(source, input),
    createRun: (input: Parameters<RunEngine["create"]>[0]) => source.runs.create(input),
    dispatchRun: (runId: string, hermesTurn?: HermesAdmittedTurn) =>
      source.runs.dispatch(runId, hermesTurn === undefined ? {} : { hermesTurn }),
    runView: (runId: string) => {
      const run = source.runs.get(runId);
      return run
        ? {
            run,
            tasks: source.tasks.list(runId),
            executions: source.tasks.executions(runId),
            evidence: source.ceo.evidence(runId),
            claims: source.claims.heldByRun(runId),
            humanGate: source.ceo.humanGateStatus(runId),
            openEscalation: source.ceo.openEscalationOf(runId),
          }
        : null;
    },
    cancelRun: (runId: string, reason: string) => source.runs.cancel(runId, reason),
    setRunPriority: (runId: string, priority: RunPriority) => source.runs.setPriority(runId, priority),
    projectView: (projectId: string) => {
      const project = source.projects.get(projectId);
      return project
        ? {
            project,
            repositories: source.repositories.byProject(projectId),
            primaryCto: source.bindings.activePrimaryCto(projectId),
            runs: source.runs.list({ projectId }),
          }
        : null;
    },
    ensurePrimaryCto: (projectId: string) => source.cto.ensurePrimaryCto(projectId, "cto_start"),
    requestCtoReplacement: (projectId: string, reason: string) => source.cto.requestReplacement(projectId, reason),
    suspendProject: (projectId: string, reason: string, actor: string) =>
      source.cto.suspendProject(projectId, true, reason, undefined, actor),
    recordOwnerDecision: (input: Parameters<ProductionGate["recordOwnerDecision"]>[0], actor: string) =>
      source.ceo.recordOwnerDecision(input, actor),
    resumeProject: (projectId: string) => source.cto.resumeProject(projectId),
    doctorRun: (...args: Parameters<Doctor["run"]>) => source.doctor.run(...args),
    continuityStatus: () => ({
      mode: source.continuity.mode(),
      plan: source.continuity.computeCoveragePlan(),
      capacity: source.capacity.all(),
    }),
    submitCeoDecision: async (input: CeoDecisionInput): Promise<Decision<{ state: RunState }>> => {
      // §15.6 — a CONFIRM is a completion, and the gate admits one only on an evaluation under five
      // minutes old. The gate is synchronous, so this async door refreshes it first, the same
      // `pre-completion` evaluation the candidate pipeline makes before its packet: a daemon restart
      // leaves no evaluation until its first sweep minutes later, and a CONFIRM in that gap was
      // refused on a stale NORMAL. The gate still decides: SURVIVAL refuses, and so does an
      // evaluation that fails, rather than a CONFIRM going ahead on the reading it could not renew.
      if (input.decision === "CONFIRM") {
        try {
          await source.continuity.evaluate("pre-completion");
        } catch {
          // The thrown text is not echoed: this answer is stored as the mutation's durable response.
          return deny(
            ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
            "continuity could not be re-evaluated before the CONFIRM; completion requires a current evaluation",
            { runId: input.runId },
          );
        }
      }
      // Issue #246 — a PROJECT_BOOTSTRAP CONFIRM completes only on a result Repo Factory produced
      // under the owner's approval. The runner runs here, ahead of the decision and outside its
      // transaction, rather than inside submitCeoDecision: the runner awaits GitHub and git, and the
      // decision is one synchronous transaction. It runs only for a decision the gate would admit
      // (a session that does not hold the CEO role sets off no write), and its refusal is the
      // CEO's answer unchanged.
      if (input.decision === "CONFIRM" && source.runs.get(input.runId)?.kind === RunKind.PROJECT_BOOTSTRAP) {
        const admissible = source.ceo.assertCeoDecisionAdmissible(input);
        if (!admissible.allowed) return admissible as Decision<{ state: RunState }>;
        // #246 C3 — the runner's full path: pre-write checks, reservation, an attempt recorded
        // before every external write, WRITTEN with the result, activation. It asks the CEO's
        // admission again itself, so a door that skipped the question above still writes nothing.
        const produced = await source.bootstrapProducer.produceAndActivateApproved({
          runId: input.runId,
          candidateSnapshotDigest: input.candidateSnapshotDigest,
          ceoSessionId: input.ceoSessionId,
          rationale: input.rationale,
        });
        if (!produced.allowed) return produced as Decision<{ state: RunState }>;
      }
      const decision = source.ceo.submitCeoDecision(input);
      // Hermes owns the CEO decision, not GitHub finalization. The daemon supplies this
      // internal callback at composition time so a live daemon begins the durable sequence
      // immediately after confirmation instead of waiting for a restart scan.
      // #246 B2-b — a CONTRACT_CHANGE consumer re-entry answers with the run's finalizing state, and it too
      // starts the daemon's sequence.
      const finalizing = decision.allowed && (decision.value.state === RunState.CEO_APPROVED
        || decision.value.state === RunState.MERGING || decision.value.state === RunState.POST_MERGE_VERIFYING);
      if (finalizing && options.onCeoApproved) {
        void Promise.resolve(options.onCeoApproved(input.runId)).catch(() => undefined);
      }
      return decision;
    },
    /**
     * A same-key replay of a PROJECT_BOOTSTRAP CONFIRM whose stored answer is a resumable refusal. The
     * daemon re-drives that confirmation on its own, so the stored bytes go stale: the replay answers from
     * the run and its application as they stand. It only reads; the runner, GitHub and git are not asked
     * again. Null keeps the stored answer, as for every other replay.
     */
    replayResumableBootstrapConfirm: (
      input: Pick<CeoDecisionInput, "runId" | "decision" | "candidateSnapshotDigest">,
      stored: ToolResult,
    ): ToolResult | null => {
      const body = stored.structuredContent;
      const answered = body?.["ok"] === false ? refusalOf(body) : null;
      if (input.decision !== "CONFIRM" || !answered || answered.evidence["resumable"] !== true) return null;
      const run = source.runs.get(input.runId);
      if (run?.kind !== RunKind.PROJECT_BOOTSTRAP) return null;
      const application = bootstrapApplicationOf(source.db, input.runId);
      if (application === null) return null;
      // The application completes only in the transaction of a CONFIRM of its own candidate.
      if (run.state === RunState.COMPLETED && application.phase === "COMPLETED"
        && application.candidateSnapshotDigest === input.candidateSnapshotDigest) {
        return respond(allow(ReasonCode.OK, { state: RunState.COMPLETED }));
      }
      const status = { phase: application.phase, attempts: application.attempts };
      const latest = application.lastRefusal;
      const terminal = TERMINAL_APPLICATION_REFUSALS[application.phase];
      if (terminal) {
        // A STRANDED or RELEASED row's record is its cause and the recovery a person performs; a COMPLETED
        // row's is the refusal it met before completing, not its answer.
        return respond(deny(terminal.reasonCode, terminal.message, {
          refusal: `BOOTSTRAP_APPLICATION_${application.phase}`,
          runId: input.runId,
          ...(application.phase === "COMPLETED" ? { reserved: application.candidateSnapshotDigest } : latest ?? {}),
          resumable: false,
          application: status,
        }));
      }
      // Every attempt records the refusal it answers with, and only a later record replaces it: it is the
      // newest answer, whichever attempt has started since. A record that is no refusal (a release in
      // doubt) is reported as recorded.
      const recorded = refusalOf(latest);
      const current = recorded !== null
        ? { ...recorded, evidence: { ...(latest?.["stage"] === undefined ? {} : { stage: latest["stage"] }), ...recorded.evidence } }
        : latest !== null
          ? {
              reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
              message: "this bootstrap run's application holds a later record than this CONFIRM's answer, reported as recorded",
              evidence: latest,
            }
          : answered;
      return respond(deny(current.reasonCode, current.message, {
        ...current.evidence,
        // A run that has ended is not re-driven, whatever its last refusal said.
        resumable: !isTerminal(run.state) && current.evidence["resumable"] !== false,
        application: status,
      }));
    },
    executeRepair:(input: Parameters<RepairService["execute"]>[0]) => source.repair.execute(input),
    resolveEscalation: (
      runId: string, escalationId: number, resolution: string, ceoSessionId: string, idempotencyKey: string,
      hermesTurn?: HermesAdmittedTurn,
      mcpFingerprint?: string,
    ) =>
      source.ceo.resolveEscalation(runId, resolution, ceoSessionId, {
        escalationId, idempotencyKey, ...(hermesTurn === undefined ? {} : { hermesTurn }),
        ...(mcpFingerprint === undefined ? {} : { mcpFingerprint }),
      }),
    replayEscalationResolution: (
      idempotencyKey: string,
      request: { runId: string; escalationId: number; resolution: string },
      ceoSessionId: string,
      mcpFingerprint: string,
    ) => source.ceo.escalationResolutionReplay(idempotencyKey, request, ceoSessionId, mcpFingerprint),
  });
  HERMES_MCP_PORTS.add(port);
  return port;
};

export type HermesMcpPort = ReturnType<typeof createHermesMcpPort>;

const assertHermesMcpPort = (port: HermesMcpPort): void => {
  if (!HERMES_MCP_PORTS.has(port)) {
    throw new Error("createHermesServer requires a sealed HermesMcpPort from createHermesMcpPort");
  }
};

/** How one Hermes MCP connection is served; chosen by the transport, never by the peer. */
export interface HermesServerOptions {
  /**
   * The adopted CEO's tool channel (#1037): the bound Hermes session and lineage its admission
   * read. Every tool outside `HERMES_READ_ONLY_TOOLS` — including any the caller registers on the
   * returned server afterwards — is admitted only when the call's `params._meta` provenance names
   * a top-level, non-scheduled turn in that session and lineage: the owner's, or a peer's carrying a
   * well-formed peer grant. A refusal happens before the idempotency
   * reservation, so it writes nothing. The admitted turn reaches the tools' audit evidence.
   */
  provenance?: HermesProvenanceAnchor;
}

type ToolCallbackArgs = readonly unknown[];

/**
 * Wraps every tool registered on `server` from this point on, so the channel's admission is a
 * property of the server object rather than of each handler remembering to ask. That covers the
 * tools `agentcpd.ts` adds to the returned server (`cto_binding_bind`/`cto_binding_release`) and
 * any tool added later, which is guarded until it is named in `HERMES_READ_ONLY_TOOLS`.
 *
 * The SDK calls a tool with `(args, extra)` when it has an input schema and `(extra)` when it has
 * none, so the request context is always the last argument. `extra._meta` is the request's
 * `params._meta`; `args` is never consulted.
 */
const requireToolProvenance = (
  server: McpServer,
  admit: (call: HermesToolCall, extra: unknown) => ReturnType<typeof admitHermesProvenance>,
): void => {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    callback: (...callArgs: ToolCallbackArgs) => unknown,
  ) => ReturnType<McpServer["registerTool"]>;
  const guardedRegister = (
    name: string,
    config: unknown,
    callback: (...callArgs: ToolCallbackArgs) => unknown,
  ): ReturnType<McpServer["registerTool"]> =>
    register(
      name,
      config,
      HERMES_READ_ONLY_TOOLS.has(name)
        ? callback
        : (...callArgs: ToolCallbackArgs) => {
            const extra = callArgs[callArgs.length - 1];
            // The parsed arguments are the very object the callback receives, so a peer's
            // `ceo_decision_submit` is admitted on the decision it then executes.
            const admitted = admit({ tool: name, arguments: callArgs.length > 1 ? callArgs[0] : undefined }, extra);
            if (!admitted.allowed) return respond(admitted);
            rememberAdmittedTurn(extra, admitted.value);
            return callback(...callArgs);
          },
    );
  server.registerTool = guardedRegister as McpServer["registerTool"];
};

const requestMeta = (extra: unknown): unknown =>
  typeof extra === "object" && extra !== null ? (extra as { _meta?: unknown })._meta : undefined;

/**
 * The turn each admitted call was made by, keyed by that call's own request context, so a handler
 * can put it in its mutation's audit evidence without reading `_meta` a second time. A call on a
 * server with no provenance anchor has no entry, and its audit evidence is as it was.
 */
const admittedTurns = new WeakMap<object, HermesAdmittedTurn>();

const rememberAdmittedTurn = (extra: unknown, turn: HermesAdmittedTurn): void => {
  if (typeof extra === "object" && extra !== null) admittedTurns.set(extra, turn);
};

const admittedTurnOf = (extra: unknown): HermesAdmittedTurn | undefined =>
  typeof extra === "object" && extra !== null ? admittedTurns.get(extra) : undefined;

/**
 * This scope deliberately receives only the port. Every registered handler closes over this
 * parameter, so a future Hermes tool cannot recover its construction-time source (#352).
 */
const createHermesServerFromPort = (
  port: HermesMcpPort,
  authenticate: McpPeerAuthenticator,
  options: HermesServerOptions,
): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-hermes", version: "1.3.0" }, { instructions: frontierReviewPolicy() });
  // The adopted-CEO relay forwards this SDK notification unchanged to Hermes's stdio client.
  // connect() precedes initialization; only the client's initialized notification opens this door.
  let toolListAnnounced = false;
  server.server.oninitialized = () => {
    if (toolListAnnounced) return;
    toolListAnnounced = true;
    void server.server.sendToolListChanged().catch(() => {
      process.stderr.write("hermes tool list change notification not sent\n");
    });
  };
  const anchor = options.provenance;
  if (anchor !== undefined) {
    requireToolProvenance(server, (call, extra) => {
      // The connection's authority first, so a channel whose binding moved is refused as stale
      // rather than as a provenance mismatch; then the one call-level question.
      const peer = authenticateMcpPeer(authenticate);
      if (!peer.allowed) return peer as ReturnType<typeof admitHermesProvenance>;
      return admitHermesProvenance(requestMeta(extra), anchor, call);
    });
  }
  const read = (execute: () => Promise<ToolResult> | ToolResult) =>
    guarded(() => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? execute() : respond(peer);
    });
  const write = (
    toolName: string,
    args: Record<string, unknown> & { idempotencyKey: string },
    extra: unknown,
    execute: (fingerprint: string) => Promise<ToolResult> | ToolResult,
    durableReplay?: McpMutationRequest["durableReplay"],
    durableReplaySupersedesStored = false,
  ) => guarded(async () => {
    const peer = authenticateMcpPeer(authenticate);
    if (!peer.allowed) return respond(peer);
    return port.mutation.execute(peer.value, args.idempotencyKey, execute, {
      toolName, arguments: args,
      ...(durableReplay === undefined ? {} : { durableReplay }),
      ...(durableReplaySupersedesStored ? { durableReplaySupersedesStored } : {}),
      authority: () => {
        const current = authenticateMcpPeer(authenticate);
        const authority = current.allowed ? port.peerAuthority(peer.value) : current;
        if (authority.allowed && toolName === "ceo_notification_ack") {
          const access = port.ceoNotificationAckAccess(peer.value, admittedTurnOf(extra), args.messageId as string);
          return access.allowed ? authority : access;
        }
        if (!authority.allowed || (toolName !== "bootstrap_plan_attach" && toolName !== "bootstrap_review_resume" && toolName !== "bootstrap_review_evidence_attach")) return authority;
        const identity = port.bootstrapPlanAttachAuthority(peer.value, admittedTurnOf(extra));
        if (!identity.allowed) return identity;
        if (toolName === "bootstrap_review_evidence_attach") {
          const ceo = port.reviewEvidenceAttachAuthority(peer.value, admittedTurnOf(extra));
          if (!ceo.allowed) return ceo;
          const access = port.reviewEvidenceAttachAccess(args as unknown as ReviewEvidenceInput);
          return access.allowed ? authority : access;
        }
        if (toolName === "bootstrap_review_resume") {
          const access = port.bootstrapReviewResumeAccess(args as unknown as BootstrapReviewResumeInput);
          return access.allowed ? authority : access;
        }
        const digests = validateBootstrapPlanDigests({ contractDigest: args.contractDigest as string,
          expectedSha256: args.expectedSha256 as string, replacesSha256: args.replacesSha256 as string | undefined });
        if (!digests.allowed) return digests;
        const input = port.bootstrapPlanAttachAccess(args as unknown as BootstrapPlanAttachInput);
        return input.allowed ? authority : input;
      },
      provenance: anchor === undefined ? null : { ...anchor, ...admittedTurnOf(extra) },
    });
  });
  const writeAsOwner = (
    toolName: string,
    args: Record<string, unknown> & { idempotencyKey: string },
    extra: unknown,
    refusal: string,
    execute: (actor: string) => Promise<ToolResult> | ToolResult,
  ) => guarded(() => {
    const peer = authenticateMcpPeer(authenticate);
    if (!peer.allowed) return respond(peer);
    // Check before reserving a key or replaying its result: peers share the owner's channel actor.
    if (admittedTurnOf(extra)?.principal !== "owner") {
      return respond(deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, refusal));
    }
    return write(toolName, args, extra, () => execute(peer.value.actor));
  });

  server.registerTool(
    "ceo_notification_ack",
    { description: "Acknowledge receipt and processing of a posted CEO_NOTIFICATION addressed to the current canonical CEO. This is never owner approval, escalation resolution or execution approval.",
      inputSchema: { ...mutation, messageId: z.string().min(1) } },
    async (args, extra) => write("ceo_notification_ack", args, extra, fingerprint => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? respond(port.acknowledgeCeoNotification(peer.value, admittedTurnOf(extra), args, fingerprint)) : respond(peer);
    }, (fingerprint, reservationVerified) => {
      const peer = authenticateMcpPeer(authenticate);
      if (!peer.allowed) return respond(peer);
      const replay = port.replayCeoNotificationAck(peer.value, admittedTurnOf(extra), args, fingerprint, reservationVerified);
      return replay ? respond(replay) : null;
    }),
  );
  server.registerTool(
    "bootstrap_review_resume",
    {
      description: "Tell the current owner of an ACTIVE bootstrap run to resubmit the current attached PLAN by digest for a new blind review. Requires current CEO Hermes owner or delegated peer provenance, contract, attachment digest and exact owner session/incarnation/generation. This is not CONFIRM, genesis or workflow approval, or a review PASS. Same key replays one instruction; different keys enqueue separate instructions even while pending.",
      inputSchema: { ...mutation, runId: z.string(), contractDigest: z.string(), bootstrapPlanDigest: z.string(),
        ownerSessionId: z.string(), ownerSessionIncarnation: z.string(), ownerBindingGeneration: z.number().int() },
    },
    async (args, extra) => write("bootstrap_review_resume", args, extra, fingerprint => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? respond(port.resumeBootstrapReview(peer.value, admittedTurnOf(extra), args, fingerprint)) : respond(peer);
    }, fingerprint => {
      const peer = authenticateMcpPeer(authenticate);
      if (!peer.allowed) return respond(peer);
      const replay = port.replayBootstrapReviewResume(peer.value, args, fingerprint);
      return replay ? respond(replay) : null;
    }),
  );
  server.registerTool(
    "bootstrap_review_evidence_attach",
    { description: "Attach the PRIMARY_CTO's private review evidence bundle by exact run/contract/current bootstrapPlanDigest/stager/digest. Current authenticated CEO owner or peer only. Attachment attributes labelled material; it is not independent verification, a PASS or execution approval. The next PLAN submission freezes it for review.",
      inputSchema: { ...mutation, runId: z.string(), contractDigest: z.string(), bootstrapPlanDigest: z.string(), stagedBy: z.string(), expectedSha256: z.string(), replacesSha256: z.string().optional() } },
    async (args, extra) => write("bootstrap_review_evidence_attach", args, extra, () => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? respond(port.attachBootstrapReviewEvidence(peer.value, admittedTurnOf(extra), args)) : respond(peer);
    }),
  );
  server.registerTool(
    "bootstrap_plan_attach",
    {
      description: `Deliver final exact UTF-8 bootstrap input JSON (runId, plan, tasks), at most ${BOOTSTRAP_PLAN_MAX_BYTES} bytes. Omit planBody and provide stagedBy (PRIMARY_CTO:<projectId>) to explicitly select the non-authoritative upload at exactly (runId, stagedBy, expectedSha256); no cross-slot or latest fallback. Input delivery grants no execution approval. Explicit replacesSha256 invalidates previous evidence. Requires the current CEO identity and authenticated Hermes owner or delegated peer provenance.`,
      // Digest syntax is still strict, but checked after authentication for a structured refusal.
      inputSchema: { ...mutation, runId: z.string(), planBody: z.string().max(BOOTSTRAP_PLAN_MAX_BYTES).optional(), expectedSha256: z.string(),
        contractDigest: z.string(), bootstrapOperationId: z.string().min(1),
        projectId: z.string().min(1), repositoryIdentity: z.string().min(1),
        replacesSha256: z.string().optional(), stagedBy: z.string().optional() },
    },
    async (args, extra) => write("bootstrap_plan_attach", args, extra,
      () => {
        const peer = authenticateMcpPeer(authenticate);
        return peer.allowed ? respond(port.attachBootstrapPlan(peer.value, admittedTurnOf(extra), args)) : respond(peer);
      }),
  );
  server.registerTool(
    "run_create",
    {
      description: "Create an official managed run from a Hermes task contract.",
      inputSchema: {
        ...mutation,
        projectId: z.string().nullable().optional(),
        kind: z.enum(["STANDARD_WORK", "PROJECT_BOOTSTRAP", "CONTRACT_CHANGE"]).optional(),
        executionMode: z.enum(["SIMPLE", "STANDARD", "GUARDED"]),
        contract: contractSchema,
        repositories: z.array(z.object({
          repositoryId: z.string(), repositoryRole: z.string().default("primary"),
          baseBranch: z.string(), mergeOrder: z.number().int().optional(),
        })).default([]),
      },
    },
    async (args, extra) => write("run_create", args, extra, () => respond(port.createRun({
      projectId: args.projectId ?? null,
      kind: (args.kind as RunKind | undefined) ?? RunKind.STANDARD_WORK,
      executionMode: args.executionMode as ExecutionMode,
      contract: args.contract,
      repositories: args.repositories,
      hermesTurn: admittedTurnOf(extra),
    }))),
  );

  server.registerTool(
    "run_dispatch",
    { description: "Admit a queued run.", inputSchema: { ...mutation, runId: z.string() } },
    async (args, extra) => write("run_dispatch", args, extra, async () => respond(await port.dispatchRun(args.runId, admittedTurnOf(extra)))),
  );

  server.registerTool(
    "run_get",
    { description: "Fetch a run with its artifacts, tasks and evidence index.", inputSchema: { runId: z.string() } },
    async (args) => read(() => {
      const view = port.runView(args.runId);
      return view ? ok(view) : respond(deny(ReasonCode.NOT_FOUND, "unknown run", { runId: args.runId }));
    }),
  );

  server.registerTool(
    "run_cancel",
    { description: "Cancel a run and its task graph.", inputSchema: { ...mutation, runId: z.string(), reason: z.string() } },
    async (args, extra) => write("run_cancel", args, extra, () => respond(port.cancelRun(args.runId, args.reason))),
  );
  server.registerTool(
    "run_priority_set",
    { description: "Set run priority.", inputSchema: { ...mutation, runId: z.string(), priority: z.enum(["CRITICAL", "NORMAL", "LOW"]) } },
    async (args, extra) => write("run_priority_set", args, extra, () => respond(port.setRunPriority(args.runId, args.priority as RunPriority))),
  );
  server.registerTool(
    "project_get",
    { description: "Project identity and active contract.", inputSchema: { projectId: z.string() } },
    async (args) => read(() => {
      const view = port.projectView(args.projectId);
      return view ? ok(view) : respond(deny(ReasonCode.NOT_FOUND, "unknown project", { projectId: args.projectId }));
    }),
  );
  server.registerTool(
    "cto_start",
    { description: "Provision a primary CTO for a project if it has none.", inputSchema: { ...mutation, projectId: z.string() } },
    async (args, extra) => write("cto_start", args, extra, async () => respond(await port.ensurePrimaryCto(args.projectId))),
  );
  server.registerTool(
    "cto_replace",
    { description: "Request CTO replacement.", inputSchema: { ...mutation, projectId: z.string(), reason: z.string() } },
    async (args, extra) => write("cto_replace", args, extra, () => respond(port.requestCtoReplacement(args.projectId, args.reason))),
  );

  server.registerTool(
    "cto_suspend",
    { description: "Suspend a project on an authenticated owner turn.", inputSchema: { ...mutation, projectId: z.string(), reason: z.string() } },
    async (args, extra) => writeAsOwner("cto_suspend", args, extra,
      "project suspension requires an authenticated owner turn",
      (actor) => port.suspendProject(args.projectId, args.reason, actor).then(respond)),
  );
  server.registerTool(
    "cto_resume",
    { description: "Resume a suspended project.", inputSchema: { ...mutation, projectId: z.string() } },
    async (args, extra) => write("cto_resume", args, extra, () => respond(port.resumeProject(args.projectId))),
  );
  server.registerTool(
    "doctor_run",
    { description: "Run a read-only doctor pass.", inputSchema: { scope: z.enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"]).default("system"), target: z.string().optional() } },
    async (args) => read(async () => ok(await port.doctorRun(args.scope, args.target))),
  );
  server.registerTool(
    "continuity_status",
    { description: "Current continuity mode and coverage plan.", inputSchema: {} },
    async () => read(() => ok(port.continuityStatus())),
  );
  server.registerTool(
    "ceo_decision_submit",
    { description: "Submit the CEO's final decision.", inputSchema: { ...mutation, runId: z.string(), decision: z.enum(["CONFIRM", "FINAL_REVISE", "OWNER_DECISION_REQUIRED"]), candidateSnapshotDigest: z.string(), ceoSessionId: z.string(), rationale: z.string() } },
    async (args, extra) => write("ceo_decision_submit", args, extra, async () => {
      // #246 B2-b — the door's authenticated session travels with the decision, never an argument, so a
      // CONTRACT_CHANGE grant is issued, or its consumer re-bound, only when it is the CEO session the call
      // names and this mutation is in flight.
      const peer = authenticateMcpPeer(authenticate);
      const ingress = {
        actor: peer.allowed ? peer.value.actor : null,
        sessionId: peer.allowed ? peer.value.sessionId ?? null : null,
        sessionIncarnation: peer.allowed ? peer.value.sessionIncarnation ?? null : null,
        idempotencyKey: args.idempotencyKey,
      };
      return respond(await port.submitCeoDecision({ runId: args.runId, decision: args.decision, candidateSnapshotDigest: args.candidateSnapshotDigest, ceoSessionId: args.ceoSessionId, rationale: args.rationale, ingress, hermesTurn: admittedTurnOf(extra) }));
    },
    // A resumable bootstrap refusal is not this key's last word: its replay, after the same request and
    // current authority passed, answers from durable state. Every other stored answer replays unchanged.
    (_fingerprint, reservationVerified, stored) =>
      reservationVerified && stored !== undefined ? port.replayResumableBootstrapConfirm(args, stored) : null,
    true),
  );

  server.registerTool(
    "escalation_resolve",
    {
      description:
        "Resolve a run's current open CTO escalation, named by its escalationId (run_get openEscalation, or the escalation notification). " +
        `The run must be BLOCKED for a CEO decision. The resolution, non-blank and at most ${ESCALATION_RESOLUTION_MAX_LENGTH} characters, is delivered to the run's owner, and the run becomes ACTIVE.`,
      inputSchema: { ...mutation, runId: z.string(), escalationId: z.number().int().positive(), resolution: z.string() },
    },
    async (args, extra) => guarded(async () => {
      const requestDigest = escalationRequestDigestOf(args.runId, args.escalationId, args.resolution);
      const answer = <T>(decision: Decision<T>) =>
        respond({ ...decision, evidence: { ...decision.evidence, requestDigest } } as Decision<T>);
      const committed = (fingerprint: string): ToolResult | null => {
        const peer = authenticateMcpPeer(authenticate);
        if (!peer.allowed || !peer.value.sessionId) return null;
        const recorded = port.replayEscalationResolution(args.idempotencyKey,
          { runId: args.runId, escalationId: args.escalationId, resolution: args.resolution }, peer.value.sessionId, fingerprint);
        return recorded ? answer(recorded) : null;
      };
      return write("escalation_resolve", args, extra, fingerprint => {
        const peer = authenticateMcpPeer(authenticate);
        if (!peer.allowed) return respond(peer);
        if (!peer.value.sessionId) return respond(deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "Hermes MCP peer has no session"));
        return answer(port.resolveEscalation(args.runId, args.escalationId, args.resolution,
          peer.value.sessionId, args.idempotencyKey, admittedTurnOf(extra), fingerprint));
      }, committed);
    }),
  );

  server.registerTool(
    "owner_decision_submit",
    { description: "Record a decision on an authenticated owner turn.", inputSchema: { ...mutation, runId: z.string(), item: z.string(), approved: z.boolean(), note: z.string().default("") } },
    async (args, extra) => writeAsOwner("owner_decision_submit", args, extra,
      "owner decisions require an authenticated owner turn",
      (actor) => respond(port.recordOwnerDecision(args, actor))),
  );
  server.registerTool(
    "repair_execute",
    {
      description: "Run an allowlisted repair. Owner-authorised repairs require owner ingress.",
      inputSchema: { ...mutation, operationId: z.string(), parameters: z.record(z.string()).default({}), authorizedBy: z.enum(["HERMES", "OWNER"]), dryRun: z.boolean().default(true), runId: z.string().nullable().optional() },
    },
    async (args, extra) => write("repair_execute", args, extra, async () => {
      if (args.authorizedBy === "OWNER") {
        return respond(deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "Hermes MCP cannot assert owner repair authority", { operationId: args.operationId }));
      }
      return respond(await port.executeRepair({
        operationId: args.operationId, parameters: args.parameters, authorizedBy: "HERMES",
        dryRun: args.dryRun, runId: args.runId ?? null,
      }));
    }),
  );

  return server;
};

/**
 * PRD §28.1 — exactly the Hermes operations, and nothing else. The factory is called
 * only after the local transport has authenticated the peer; identity is not a tool
 * argument, because an MCP caller may assert any string it likes.
 */
export const createHermesServer = (
  port: HermesMcpPort,
  authenticate: McpPeerAuthenticator,
  options: HermesServerOptions = {},
): McpServer => {
  assertHermesMcpPort(port);
  return createHermesServerFromPort(port, authenticate, options);
};
