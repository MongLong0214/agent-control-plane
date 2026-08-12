import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ControlPlane } from "../app/control-plane.ts";
import { deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ExecutionMode, RunPriority } from "../domain/types.ts";
import { RunKind } from "../domain/types.ts";
import { guarded, ok, respond } from "./shared.ts";

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

/**
 * PRD §28.1 — exactly the Hermes operations, and nothing else.
 *
 * Note what is absent by construction: there is no way to request a blind review, skip
 * one, publish a production gate or merge. Those are control-plane authority (§18.2,
 * CP-HI-02, CP-HI-05), so they have no surface here at all.
 */
export const createHermesServer = (cp: ControlPlane): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-hermes", version: "1.3.0" });

  server.registerTool(
    "run_create",
    {
      description: "Create an official managed run from a Hermes task contract.",
      inputSchema: {
        projectId: z.string().nullable().optional(),
        kind: z.enum(["STANDARD_WORK", "PROJECT_BOOTSTRAP", "CONTRACT_CHANGE"]).optional(),
        executionMode: z.enum(["SIMPLE", "STANDARD", "GUARDED"]),
        contract: contractSchema,
        repositories: z
          .array(
            z.object({
              repositoryId: z.string(),
              repositoryRole: z.string().default("primary"),
              baseBranch: z.string(),
              mergeOrder: z.number().int().optional(),
            }),
          )
          .default([]),
      },
    },
    async (args) =>
      guarded(() =>
        respond(
          cp.runs.create({
            projectId: args.projectId ?? null,
            kind: (args.kind as RunKind | undefined) ?? RunKind.STANDARD_WORK,
            executionMode: args.executionMode as ExecutionMode,
            contract: args.contract,
            repositories: args.repositories,
          }),
        ),
      ),
  );

  server.registerTool(
    "run_dispatch",
    {
      description:
        "Admit a queued run: refresh capacity, ensure a primary CTO exists, pin the run owner.",
      inputSchema: { runId: z.string() },
    },
    async (args) => guarded(async () => respond(await cp.runs.dispatch(args.runId))),
  );

  server.registerTool(
    "run_get",
    {
      description: "Fetch a run with its artifacts, tasks and evidence index.",
      inputSchema: { runId: z.string() },
    },
    async (args) =>
      guarded(() => {
        const run = cp.runs.get(args.runId);
        if (!run) return respond(deny(ReasonCode.NOT_FOUND, "unknown run", { runId: args.runId }));
        return ok({
          run,
          tasks: cp.tasks.list(args.runId),
          executions: cp.tasks.executions(args.runId),
          evidence: cp.ceo.evidence(args.runId),
          claims: cp.claims.heldByRun(args.runId),
          humanGate: cp.ceo.humanGateStatus(args.runId),
        });
      }),
  );

  server.registerTool(
    "run_cancel",
    { description: "Cancel a run and its task graph.", inputSchema: { runId: z.string(), reason: z.string() } },
    async (args) => guarded(() => respond(cp.runs.cancel(args.runId, args.reason))),
  );

  server.registerTool(
    "run_priority_set",
    {
      description: "Set run priority. The CTO still decides actual preemption and parallel order.",
      inputSchema: { runId: z.string(), priority: z.enum(["CRITICAL", "NORMAL", "LOW"]) },
    },
    async (args) =>
      guarded(() => respond(cp.runs.setPriority(args.runId, args.priority as RunPriority))),
  );

  server.registerTool(
    "project_get",
    {
      description: "Project identity, derived activity, availability and active manifest digest.",
      inputSchema: { projectId: z.string() },
    },
    async (args) =>
      guarded(() => {
        const project = cp.projects.get(args.projectId);
        if (!project) {
          return respond(deny(ReasonCode.NOT_FOUND, "unknown project", { projectId: args.projectId }));
        }
        return ok({
          project,
          repositories: cp.repositories.byProject(args.projectId),
          primaryCto: cp.bindings.activePrimaryCto(args.projectId),
          runs: cp.runs.list({ projectId: args.projectId }),
        });
      }),
  );

  server.registerTool(
    "cto_start",
    {
      description: "Provision a primary CTO for a project if it has none.",
      inputSchema: { projectId: z.string() },
    },
    async (args) =>
      guarded(async () => respond(await cp.cto.ensurePrimaryCto(args.projectId, "cto_start"))),
  );

  server.registerTool(
    "cto_replace",
    {
      description:
        "Request CTO replacement. The switchover happens only once the outgoing CTO owns zero active runs.",
      inputSchema: { projectId: z.string(), reason: z.string() },
    },
    async (args) => guarded(() => respond(cp.cto.requestReplacement(args.projectId, args.reason))),
  );

  server.registerTool(
    "cto_suspend",
    {
      description:
        "Capacity-driven project suspend. Requires explicit owner approval; Hermes cannot self-approve it.",
      inputSchema: { projectId: z.string(), reason: z.string(), ownerApproved: z.boolean() },
    },
    async (args) =>
      guarded(async () =>
        respond(await cp.cto.suspendProject(args.projectId, args.ownerApproved, args.reason)),
      ),
  );

  server.registerTool(
    "cto_resume",
    { description: "Resume a suspended project.", inputSchema: { projectId: z.string() } },
    async (args) => guarded(() => respond(cp.cto.resumeProject(args.projectId))),
  );

  server.registerTool(
    "doctor_run",
    {
      description: "Run a read-only doctor pass at the requested scope.",
      inputSchema: {
        scope: z
          .enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"])
          .default("system"),
        target: z.string().optional(),
      },
    },
    async (args) => guarded(async () => ok(await cp.doctor.run(args.scope, args.target))),
  );

  server.registerTool(
    "continuity_status",
    { description: "Current continuity mode and the role coverage plan.", inputSchema: {} },
    async () =>
      guarded(() =>
        ok({ mode: cp.continuity.mode(), plan: cp.continuity.computeCoveragePlan(), capacity: cp.capacity.all() }),
      ),
  );

  server.registerTool(
    "ceo_decision_submit",
    {
      description:
        "Submit the CEO's final decision. Bound to an exact candidate snapshot; a changed candidate voids it.",
      inputSchema: {
        runId: z.string(),
        decision: z.enum(["CONFIRM", "FINAL_REVISE", "OWNER_DECISION_REQUIRED"]),
        candidateSnapshotDigest: z.string(),
        ceoSessionId: z.string(),
        rationale: z.string(),
      },
    },
    async (args) => guarded(() => respond(cp.ceo.submitCeoDecision(args))),
  );

  server.registerTool(
    "owner_decision_submit",
    {
      description: "Record an owner decision against a specific human-gate item.",
      inputSchema: {
        runId: z.string(),
        item: z.string(),
        approved: z.boolean(),
        note: z.string().default(""),
        // The MCP peer is Hermes, not the owner: the owner identity is named explicitly
        // and must be one the deployment allowlisted (§21).
        ownerChannel: z.string(),
        ownerActor: z.string(),
      },
    },
    async (args) =>
      guarded(() =>
        respond(
          cp.ceo.recordOwnerDecision({
            runId: args.runId,
            item: args.item,
            approved: args.approved,
            note: args.note,
            owner: { channel: args.ownerChannel, actor: args.ownerActor },
          }),
        ),
      ),
  );

  server.registerTool(
    "repair_execute",
    {
      description:
        "Run an allowlisted repair operation. Data-loss risk requires owner authorization; dry run is always available.",
      inputSchema: {
        operationId: z.string(),
        parameters: z.record(z.string()).default({}),
        authorizedBy: z.enum(["HERMES", "OWNER"]),
        dryRun: z.boolean().default(true),
        runId: z.string().nullable().optional(),
      },
    },
    async (args) =>
      guarded(async () =>
        respond(
          await cp.repair.execute({
            operationId: args.operationId,
            parameters: args.parameters,
            authorizedBy: args.authorizedBy,
            dryRun: args.dryRun,
            runId: args.runId ?? null,
          }),
        ),
      ),
  );

  return server;
};
