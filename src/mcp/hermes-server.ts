import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CapacityMonitor } from "../capacity/capacity-monitor.ts";
import type { RepoFactoryBootstrapRunner } from "../bootstrap/repo-factory-bootstrap-run.ts";
import type { CeoDecisionInput, ProductionGate } from "../ceo/production-gate.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { CtoLifecycle } from "../cto/cto-lifecycle.ts";
import type { Db } from "../db/database.ts";
import type { Doctor } from "../doctor/doctor.ts";
import type { ExecutionMode, RunPriority } from "../domain/types.ts";
import { RunKind, RunState } from "../domain/types.ts";
import type { RepairService } from "../doctor/repair.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { ContinuityKernel } from "../continuity/continuity-kernel.ts";
import {
  admitHermesProvenance,
  HERMES_READ_ONLY_TOOLS,
  type HermesProvenanceAnchor,
} from "./hermes-provenance.ts";
import {
  authenticateMcpPeer,
  createMcpMutationPort,
  guarded,
  ok,
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
    createRun: (input: Parameters<RunEngine["create"]>[0]) => source.runs.create(input),
    dispatchRun: (runId: string) => source.runs.dispatch(runId),
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
    resumeProject: (projectId: string) => source.cto.resumeProject(projectId),
    doctorRun: (...args: Parameters<Doctor["run"]>) => source.doctor.run(...args),
    continuityStatus: () => ({
      mode: source.continuity.mode(),
      plan: source.continuity.computeCoveragePlan(),
      capacity: source.capacity.all(),
    }),
    submitCeoDecision: async (input: CeoDecisionInput): Promise<Decision<{ state: RunState }>> => {
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
      if (decision.allowed && decision.value.state === RunState.CEO_APPROVED && options.onCeoApproved) {
        void Promise.resolve(options.onCeoApproved(input.runId)).catch(() => undefined);
      }
      return decision;
    },
    executeRepair: (input: Parameters<RepairService["execute"]>[0]) => source.repair.execute(input),
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
   * the owner's own top-level, non-scheduled turn in that session and lineage. A refusal happens
   * before the idempotency reservation, so it writes nothing.
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
  admit: (extra: unknown) => ReturnType<typeof admitHermesProvenance>,
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
            const admitted = admit(callArgs[callArgs.length - 1]);
            return admitted.allowed ? callback(...callArgs) : respond(admitted);
          },
    );
  server.registerTool = guardedRegister as McpServer["registerTool"];
};

const requestMeta = (extra: unknown): unknown =>
  typeof extra === "object" && extra !== null ? (extra as { _meta?: unknown })._meta : undefined;

/**
 * This scope deliberately receives only the port. Every registered handler closes over this
 * parameter, so a future Hermes tool cannot recover its construction-time source (#352).
 */
const createHermesServerFromPort = (
  port: HermesMcpPort,
  authenticate: McpPeerAuthenticator,
  options: HermesServerOptions,
): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-hermes", version: "1.3.0" });
  const anchor = options.provenance;
  if (anchor !== undefined) {
    requireToolProvenance(server, (extra) => {
      // The connection's authority first, so a channel whose binding moved is refused as stale
      // rather than as a provenance mismatch; then the one call-level question.
      const peer = authenticateMcpPeer(authenticate);
      if (!peer.allowed) return peer as ReturnType<typeof admitHermesProvenance>;
      return admitHermesProvenance(requestMeta(extra), anchor);
    });
  }
  const read = (execute: () => Promise<ToolResult> | ToolResult) =>
    guarded(() => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? execute() : respond(peer);
    });
  const write = (idempotencyKey: string, execute: () => Promise<ToolResult> | ToolResult) =>
    guarded(async () => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? port.mutation.execute(peer.value, idempotencyKey, execute) : respond(peer);
    });

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
    async (args) => write(args.idempotencyKey, () => respond(port.createRun({
      projectId: args.projectId ?? null,
      kind: (args.kind as RunKind | undefined) ?? RunKind.STANDARD_WORK,
      executionMode: args.executionMode as ExecutionMode,
      contract: args.contract,
      repositories: args.repositories,
    }))),
  );

  server.registerTool(
    "run_dispatch",
    { description: "Admit a queued run.", inputSchema: { ...mutation, runId: z.string() } },
    async (args) => write(args.idempotencyKey, async () => respond(await port.dispatchRun(args.runId))),
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
    async (args) => write(args.idempotencyKey, () => respond(port.cancelRun(args.runId, args.reason))),
  );
  server.registerTool(
    "run_priority_set",
    { description: "Set run priority.", inputSchema: { ...mutation, runId: z.string(), priority: z.enum(["CRITICAL", "NORMAL", "LOW"]) } },
    async (args) => write(args.idempotencyKey, () => respond(port.setRunPriority(args.runId, args.priority as RunPriority))),
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
    async (args) => write(args.idempotencyKey, async () => respond(await port.ensurePrimaryCto(args.projectId))),
  );
  server.registerTool(
    "cto_replace",
    { description: "Request CTO replacement.", inputSchema: { ...mutation, projectId: z.string(), reason: z.string() } },
    async (args) => write(args.idempotencyKey, () => respond(port.requestCtoReplacement(args.projectId, args.reason))),
  );

  server.registerTool(
    "cto_suspend",
    { description: "Owner-only project suspension; Hermes cannot submit owner authority.", inputSchema: { ...mutation, projectId: z.string(), reason: z.string() } },
    async (args) => write(args.idempotencyKey, () => respond(deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      "owner approval must arrive through authenticated owner ingress, not Hermes MCP",
      { projectId: args.projectId, reason: args.reason },
    ))),
  );
  server.registerTool(
    "cto_resume",
    { description: "Resume a suspended project.", inputSchema: { ...mutation, projectId: z.string() } },
    async (args) => write(args.idempotencyKey, () => respond(port.resumeProject(args.projectId))),
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
    async (args) => write(args.idempotencyKey, async () => respond(await port.submitCeoDecision({ runId: args.runId, decision: args.decision, candidateSnapshotDigest: args.candidateSnapshotDigest, ceoSessionId: args.ceoSessionId, rationale: args.rationale }))),
  );

  server.registerTool(
    "owner_decision_submit",
    { description: "Unavailable over Hermes MCP: owner decisions require authenticated owner ingress.", inputSchema: { ...mutation, runId: z.string(), item: z.string(), approved: z.boolean(), note: z.string().default("") } },
    async (args) => write(args.idempotencyKey, () => respond(deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      "Hermes MCP cannot assert an owner decision",
      { runId: args.runId, item: args.item },
    ))),
  );
  server.registerTool(
    "repair_execute",
    {
      description: "Run an allowlisted repair. Owner-authorised repairs require owner ingress.",
      inputSchema: { ...mutation, operationId: z.string(), parameters: z.record(z.string()).default({}), authorizedBy: z.enum(["HERMES", "OWNER"]), dryRun: z.boolean().default(true), runId: z.string().nullable().optional() },
    },
    async (args) => write(args.idempotencyKey, async () => {
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
