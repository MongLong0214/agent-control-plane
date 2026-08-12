import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ControlPlane } from "../app/control-plane.ts";
import { allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ArtifactKind } from "../domain/types.ts";
import { parseVerificationCommand } from "../contracts/verification-command.ts";
import { guarded, ok, respond } from "./shared.ts";

const identity = {
  runId: z.string(),
  sessionId: z.string(),
  bindingGeneration: z.number().int().positive(),
};

/**
 * PRD §28.2 — exactly the CTO operations.
 *
 * Every mutating call carries the caller's session and binding generation and is
 * authorised against the run's pinned owner, so a superseded CTO cannot act on a run it
 * no longer owns (§11.1, §15.7). `blind_review_request` exists only to return the denial
 * §18.2 requires — the review is the control plane's to invoke.
 */
export const createCtoServer = (cp: ControlPlane): McpServer => {
  const server = new McpServer({ name: "agent-control-plane-cto", version: "1.3.0" });

  server.registerTool(
    "run_ack",
    {
      description: "Acknowledge a dispatched run and its fenced envelope.",
      inputSchema: { ...identity, messageId: z.string() },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);
        return respond(cp.outbox.acknowledge(args.messageId, args.sessionId, args.bindingGeneration));
      }),
  );

  server.registerTool(
    "contract_get",
    {
      description: "The pinned task contract, manifest digest and verification commands for a run.",
      inputSchema: { ...identity },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);
        const run = owner.value;
        const manifest = run.pinnedManifestDigest
          ? cp.projects.manifest(run.pinnedManifestDigest)
          : null;
        return ok({
          run,
          contract: cp.artifacts.latest(args.runId, ArtifactKind.TASK_CONTRACT)?.content ?? null,
          pinnedManifestDigest: run.pinnedManifestDigest,
          verificationCommands: manifest?.verificationCommands ?? [],
          branchProfile: manifest?.branchProfile ?? null,
          repositories: cp.runs.repositoriesOf(args.runId),
        });
      }),
  );

  server.registerTool(
    "plan_submit",
    {
      description:
        "Submit the lean plan and dynamic task graph. Dependencies are validated; cycles are refused.",
      inputSchema: {
        ...identity,
        plan: z.object({
          summary: z.string(),
          dependencies: z.array(z.string()).default([]),
          repositoryIntent: z.array(z.string()).default([]),
          verificationIntent: z.array(z.string()).default([]),
          knownConflicts: z.array(z.string()).default([]),
          risks: z.array(z.string()).default([]),
          removedOverengineering: z.array(z.string()).default([]),
        }),
        tasks: z
          .array(
            z.object({
              key: z.string(),
              title: z.string(),
              category: z.enum([
                "mechanical", "implementation", "investigation", "integration", "test",
                "review", "docs", "migration", "benchmark", "security",
              ]),
              dependsOn: z.array(z.string()).default([]),
              spec: z.record(z.unknown()).default({}),
            }),
          )
          .min(1),
      },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);
        cp.artifacts.put(args.runId, ArtifactKind.PLAN, args.plan);
        return respond(cp.tasks.submit(args.runId, args.tasks));
      }),
  );

  server.registerTool(
    "resource_claim",
    {
      description:
        "Claim a branch, worktree and optional exact write paths. Obvious cross-run collisions are hard rejects.",
      inputSchema: {
        ...identity,
        repositoryIdentity: z.string(),
        branch: z.string().nullable().optional(),
        worktreeId: z.string().nullable().optional(),
        declaredPaths: z.array(z.string()).default([]),
        ttlMs: z.number().int().positive().optional(),
      },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);
        const roleKey = cp.runs.ownerRoleKeyFor(owner.value);
        if (!roleKey) return respond(deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no owner role key", {}));
        const acquired = cp.claims.acquire({
          runId: args.runId,
          ownerSessionId: args.sessionId,
          ownerBindingGeneration: args.bindingGeneration,
          ownerRoleKey: roleKey,
          repositoryIdentity: args.repositoryIdentity,
          branch: args.branch ?? null,
          worktreeId: args.worktreeId ?? null,
          declaredPaths: args.declaredPaths,
          ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {}),
        });
        if (!acquired.allowed) return respond(acquired);
        // §23.2 — semantic overlap is advice for the CTO, never a reject.
        const advisory = cp.claims.advisoryOverlaps(
          args.repositoryIdentity,
          args.runId,
          args.declaredPaths,
        );
        return respond(
          allow(
            advisory.length > 0 ? ReasonCode.SEMANTIC_CONFLICT_ADVISORY : ReasonCode.OK,
            { claims: acquired.value, advisoryOverlaps: advisory },
          ),
        );
      }),
  );

  server.registerTool(
    "resource_release",
    {
      description: "Release a held claim, or every claim held by the run.",
      inputSchema: { ...identity, claimId: z.string().nullable().optional() },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);
        if (args.claimId) return respond(cp.claims.release(args.claimId));
        return ok({ released: cp.claims.releaseRun(args.runId) });
      }),
  );

  server.registerTool(
    "task_receipt_submit",
    {
      description: "Open or close a task execution receipt. Receipts are the doctor's evidence.",
      inputSchema: {
        ...identity,
        taskId: z.string(),
        phase: z.enum(["started", "activity", "finished"]),
        executionId: z.string().nullable().optional(),
        provider: z.string().default("unknown"),
        model: z.string().default("unknown"),
        workerSessionId: z.string().nullable().optional(),
        workerProcessId: z.number().int().nullable().optional(),
        repositoryId: z.string().nullable().optional(),
        worktreeId: z.string().nullable().optional(),
        status: z.enum(["SUCCEEDED", "FAILED", "ABANDONED", "TIMEOUT"]).optional(),
        failureClass: z
          .enum([
            "transient", "repairable", "contract", "security", "policy", "capacity",
            "infrastructure", "unknown_observed",
          ])
          .optional(),
        resultDigest: z.string().nullable().optional(),
      },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);

        if (args.phase === "started") {
          return respond(
            cp.tasks.startExecution({
              runId: args.runId,
              taskId: args.taskId,
              ownerBindingGeneration: args.bindingGeneration,
              workerSessionId: args.workerSessionId ?? null,
              workerProcessId: args.workerProcessId ?? null,
              provider: args.provider,
              model: args.model,
              repositoryId: args.repositoryId ?? null,
              worktreeId: args.worktreeId ?? null,
              concurrencyWidth: cp.tasks.runningWidth(args.runId) + 1,
            }),
          );
        }
        if (!args.executionId) {
          return respond(deny(ReasonCode.INVALID_ARGUMENT, "executionId is required", {}));
        }
        if (args.phase === "activity") {
          cp.tasks.recordActivity(args.executionId);
          return ok({ recorded: true });
        }
        return respond(
          cp.tasks.finishExecution(args.executionId, {
            status: args.status ?? "SUCCEEDED",
            resultDigest: args.resultDigest ?? null,
            failureClass: args.failureClass ?? null,
          }),
        );
      }),
  );

  server.registerTool(
    "result_submit",
    {
      description:
        "Submit the candidate for judgement. The control plane freezes it, verifies it, and then invokes the mandatory blind review automatically.",
      inputSchema: {
        ...identity,
        resultSummary: z.string(),
        recommendation: z.string(),
        residualRisk: z.array(z.string()).default([]),
        projectContext: z.string().optional(),
        runScopedCommands: z.array(z.record(z.unknown())).default([]),
      },
    },
    async (args) =>
      guarded(async () => {
        const commands = args.runScopedCommands.map((c) => parseVerificationCommand(c));
        return respond(
          await cp.pipeline.submitResult({
            runId: args.runId,
            ownerSessionId: args.sessionId,
            ownerBindingGeneration: args.bindingGeneration,
            resultSummary: args.resultSummary,
            recommendation: args.recommendation,
            residualRisk: args.residualRisk,
            ...(commands.length > 0 ? { runScopedCommands: commands } : {}),
            ...(args.projectContext !== undefined ? { projectContext: args.projectContext } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    "escalation_open",
    {
      description:
        "Escalate to the CEO. Non-blocking escalations leave the run ACTIVE; a blocked critical path moves it to BLOCKED.",
      inputSchema: {
        ...identity,
        question: z.string(),
        options: z.array(z.string()).min(1),
        ctoRecommendation: z.string(),
        whyItMatters: z.string(),
        blocksCriticalPath: z.boolean(),
      },
    },
    async (args) =>
      guarded(() => {
        const owner = cp.runs.assertOwner(args.runId, args.sessionId, args.bindingGeneration);
        if (!owner.allowed) return respond(owner);
        return respond(
          cp.ceo.openEscalation({
            runId: args.runId,
            question: args.question,
            options: args.options,
            ctoRecommendation: args.ctoRecommendation,
            whyItMatters: args.whyItMatters,
            blocksCriticalPath: args.blocksCriticalPath,
            openedBySessionId: args.sessionId,
            openedAt: new Date().toISOString(),
          }),
        );
      }),
  );

  server.registerTool(
    "handoff_submit",
    {
      description:
        "Submit the structured handoff package. Refused while the outgoing CTO still owns active runs.",
      inputSchema: {
        projectId: z.string(),
        sessionId: z.string(),
        bindingGeneration: z.number().int().positive(),
        handoff: z.object({
          projectStatus: z.string(),
          activeManifestDigest: z.string().nullable(),
          recentDecisions: z.array(z.string()).default([]),
          openBlockers: z.array(z.string()).default([]),
          queuedWork: z.array(z.string()).default([]),
          repositoryFacts: z
            .array(
              z.object({
                identity: z.string(),
                branch: z.string().nullable(),
                head: z.string().nullable(),
              }),
            )
            .default([]),
          knownRisks: z.array(z.string()).default([]),
          recommendedNextAction: z.string(),
        }),
      },
    },
    async (args) =>
      guarded(async () => {
        if (!cp.bindings.isCurrent(`PRIMARY_CTO:${args.projectId}`, args.bindingGeneration)) {
          return respond(
            deny(ReasonCode.BINDING_GENERATION_STALE, "caller is not the current primary CTO", {
              projectId: args.projectId,
              claimed: args.bindingGeneration,
            }),
          );
        }
        return respond(await cp.cto.prepareSwitchover(args.projectId, args.handoff));
      }),
  );

  server.registerTool(
    "handoff_ack",
    {
      description:
        "Acknowledge a handoff as the incoming CTO. The binding generation switches only after this.",
      inputSchema: { handoffId: z.string(), sessionId: z.string() },
    },
    async (args) => guarded(() => respond(cp.cto.acknowledgeHandoff(args.handoffId, args.sessionId))),
  );

  server.registerTool(
    "capacity_get",
    {
      description:
        "Normalized provider capacity: quota buckets plus independent sensor, runtime and admission state.",
      inputSchema: { refresh: z.boolean().default(false) },
    },
    async (args) =>
      guarded(async () => {
        if (args.refresh) await cp.capacity.refresh("WORKER_FANOUT");
        return ok({ providers: cp.capacity.all(), continuityMode: cp.continuity.mode() });
      }),
  );

  server.registerTool(
    "doctor_run",
    {
      description: "Read-only doctor pass.",
      inputSchema: {
        scope: z
          .enum(["system", "project", "cto", "run", "session", "capacity", "github", "worktree"])
          .default("run"),
        target: z.string().optional(),
      },
    },
    async (args) => guarded(async () => ok(await cp.doctor.run(args.scope, args.target))),
  );

  server.registerTool(
    "blind_review_request",
    {
      description:
        "Not available. The mandatory blind review is invoked by the control plane after verification passes.",
      inputSchema: { runId: z.string(), sessionId: z.string() },
    },
    async (args) => guarded(() => respond(cp.review.manualInvocation(args.sessionId, args.runId))),
  );

  return server;
};
