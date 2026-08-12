import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ControlPlane } from "../app/control-plane.ts";
import { deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ExecutionMode, RunPriority } from "../domain/types.ts";
import { RunKind } from "../domain/types.ts";
import {
  authenticateMcpPeer,
  guarded,
  idempotentMcpMutation,
  ok,
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
 * PRD §28.1 — exactly the Hermes operations, and nothing else. The factory is called
 * only after the local transport has authenticated the peer; identity is not a tool
 * argument, because an MCP caller may assert any string it likes.
 */
export const createHermesServer = (
  cp: ControlPlane,
  authenticate: McpPeerAuthenticator,
): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-hermes", version: "1.3.0" });
  const read = (execute: () => Promise<ToolResult> | ToolResult) =>
    guarded(() => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? execute() : respond(peer);
    });
  const write = (idempotencyKey: string, execute: () => Promise<ToolResult> | ToolResult) =>
    guarded(async () => {
      const peer = authenticateMcpPeer(authenticate);
      return peer.allowed ? idempotentMcpMutation(cp, peer.value, idempotencyKey, execute) : respond(peer);
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
    async (args) => write(args.idempotencyKey, () => respond(cp.runs.create({
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
    async (args) => write(args.idempotencyKey, async () => respond(await cp.runs.dispatch(args.runId))),
  );

  server.registerTool(
    "run_get",
    { description: "Fetch a run with its artifacts, tasks and evidence index.", inputSchema: { runId: z.string() } },
    async (args) => read(() => {
      const run = cp.runs.get(args.runId);
      if (!run) return respond(deny(ReasonCode.NOT_FOUND, "unknown run", { runId: args.runId }));
      return ok({
        run, tasks: cp.tasks.list(args.runId), executions: cp.tasks.executions(args.runId),
        evidence: cp.ceo.evidence(args.runId), claims: cp.claims.heldByRun(args.runId),
        humanGate: cp.ceo.humanGateStatus(args.runId),
      });
    }),
  );

  server.registerTool(
    "run_cancel",
    { description: "Cancel a run and its task graph.", inputSchema: { ...mutation, runId: z.string(), reason: z.string() } },
    async (args) => write(args.idempotencyKey, () => respond(cp.runs.cancel(args.runId, args.reason))),
  );
  server.registerTool(
    "run_priority_set",
    { description: "Set run priority.", inputSchema: { ...mutation, runId: z.string(), priority: z.enum(["CRITICAL", "NORMAL", "LOW"]) } },
    async (args) => write(args.idempotencyKey, () => respond(cp.runs.setPriority(args.runId, args.priority as RunPriority))),
  );
  server.registerTool(
    "project_get",
    { description: "Project identity and active contract.", inputSchema: { projectId: z.string() } },
    async (args) => read(() => {
      const project = cp.projects.get(args.projectId);
      if (!project) return respond(deny(ReasonCode.NOT_FOUND, "unknown project", { projectId: args.projectId }));
      return ok({ project, repositories: cp.repositories.byProject(args.projectId), primaryCto: cp.bindings.activePrimaryCto(args.projectId), runs: cp.runs.list({ projectId: args.projectId }) });
    }),
  );
  server.registerTool(
    "cto_start",
    { description: "Provision a primary CTO for a project if it has none.", inputSchema: { ...mutation, projectId: z.string() } },
    async (args) => write(args.idempotencyKey, async () => respond(await cp.cto.ensurePrimaryCto(args.projectId, "cto_start"))),
  );
  server.registerTool(
    "cto_replace",
    { description: "Request CTO replacement.", inputSchema: { ...mutation, projectId: z.string(), reason: z.string() } },
    async (args) => write(args.idempotencyKey, () => respond(cp.cto.requestReplacement(args.projectId, args.reason))),
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
    async (args) => write(args.idempotencyKey, () => respond(cp.cto.resumeProject(args.projectId))),
  );
  server.registerTool(
    "doctor_run",
    { description: "Run a read-only doctor pass.", inputSchema: { scope: z.enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"]).default("system"), target: z.string().optional() } },
    async (args) => read(async () => ok(await cp.doctor.run(args.scope, args.target))),
  );
  server.registerTool(
    "continuity_status",
    { description: "Current continuity mode and coverage plan.", inputSchema: {} },
    async () => read(() => ok({ mode: cp.continuity.mode(), plan: cp.continuity.computeCoveragePlan(), capacity: cp.capacity.all() })),
  );
  server.registerTool(
    "ceo_decision_submit",
    { description: "Submit the CEO's final decision.", inputSchema: { ...mutation, runId: z.string(), decision: z.enum(["CONFIRM", "FINAL_REVISE", "OWNER_DECISION_REQUIRED"]), candidateSnapshotDigest: z.string(), ceoSessionId: z.string(), rationale: z.string() } },
    async (args) => write(args.idempotencyKey, () => respond(cp.ceo.submitCeoDecision({ runId: args.runId, decision: args.decision, candidateSnapshotDigest: args.candidateSnapshotDigest, ceoSessionId: args.ceoSessionId, rationale: args.rationale }))),
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
      return respond(await cp.repair.execute({
        operationId: args.operationId, parameters: args.parameters, authorizedBy: "HERMES",
        dryRun: args.dryRun, runId: args.runId ?? null,
      }));
    }),
  );

  return server;
};
