import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { systemClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import { ExecutionMode, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";

/**
 * End-to-end acceptance on a real pre-existing project, registered by hand with no Repo
 * Factory involvement.
 *
 * What is real here: the repository and its code, the verification command (this
 * project's own typecheck) executed in a seatbelt-confined disposable worktree, the
 * blind reviewer (a fresh headless Claude session invoked over the real CLI), the
 * candidate snapshot, and every gate decision.
 *
 * The CTO's plan is produced by a real session invocation; the worker edit and receipts
 * are driven through the same service calls the CTO MCP surface exposes.
 *
 * Opt-in via ACP_E2E=1 because it spends real provider quota.
 */
const ENABLED = process.env["ACP_E2E"] === "1";
const REAL_PROJECT = resolve(process.env["ACP_E2E_PROJECT"] ?? process.cwd());
const REVIEWER_MODEL = process.env["ACP_E2E_MODEL"] ?? "sonnet";

const CONTRACT: TaskContract = {
  goal: "Add a documented helper that reports the reason-code catalogue size",
  why: "Operators need a machine-readable count of the stable reason codes when auditing denials",
  scope: ["src/core/reason-codes.ts"],
  nonGoals: ["renaming any existing reason code"],
  acceptance: [
    // The criteria name the evidence this run actually produces. The full typecheck
    // needs installed dependencies and so belongs to CI as TRUSTED_CI evidence; stating
    // it here would promise evidence the local verification cannot supply.
    "the reason-code contract check (scripts/verify-reason-codes.mjs) passes at the exact candidate head",
    "no existing reason code string is removed or renamed",
    "nothing outside src/core/reason-codes.ts is modified",
  ],
  priority: "NORMAL",
  humanGate: [],
  references: ["PRD §40 Explainability"],
};

const manifestFor = (projectId: string): ProjectManifest => ({
  schema: PROJECT_MANIFEST_SCHEMA_ID,
  projectId,
  repositories: [{ role: "primary", remote: "github:MongLong0214/agent-control-plane", manifestRoot: "." }],
  branchProfile: {
    longLived: ["main", "dev"],
    defaultBranch: "main",
    updateStrategy: "rebase_before_review",
    mergeStrategy: "merge_commit",
    releaseTagPolicy: "semver",
    releaseBranchCleanup: "keep",
  },
  verificationProfiles: {
    simple: ["reason-codes"],
    standard: ["reason-codes"],
    guarded: ["reason-codes"],
  },
  verificationCommands: [
    {
      id: "reason-codes",
      /**
       * The project's real reason-code contract check. Chosen over `tsc` because
       * verification runs in a disposable worktree with no installed packages and no
       * network (PRD §17.4) — a command that needs `node_modules` cannot execute there.
       * The typecheck is the repository's CI job and reaches the control plane as
       * TRUSTED_CI evidence instead.
       */
      argv: ["node", "scripts/verify-reason-codes.mjs"],
      repositoryRole: "primary",
      cwd: ".",
      timeoutSeconds: 120,
      envAllowlist: ["CI"],
      network: "deny",
      networkAllowlist: [],
      required: true,
      evidenceMode: "LOCAL_COMMAND",
      maxOutputBytes: 1_048_576,
      maxMemoryMb: 2048,
    },
  ],
  postMergeCommands: [],
  ciWorkflows: [{ path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null }],
  commitlore: { mode: "preferred" },
});

describe.runIf(ENABLED)("E2E: real project, real verification, real blind review", () => {
  it(
    "drives User → Hermes → ACP → Primary CTO → workers → verification → fresh blind review → packet → confirm",
    async () => {
      const root = tempDir("acp-e2e-");
      const checkout = join(root, "project");

      // A real, pre-existing project. Cloned so the owner's working tree is untouched;
      // the code, history and verification command are the real ones.
      execFileSync("git", ["clone", "--local", "--quiet", REAL_PROJECT, checkout]);
      // Local-only exclude: the symlink is a convenience for this checkout and must never
      // enter a candidate. Committing a machine-specific absolute symlink is exactly the
      // scope violation an independent reviewer should refuse.
      writeFileSync(join(checkout, ".git", "info", "exclude"), "node_modules\n");
      symlinkSync(join(REAL_PROJECT, "node_modules"), join(checkout, "node_modules"), "dir");
      // The clone already sits on the project's real default branch.
      expect(gitSync(checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");

      const cp = new ControlPlane({
        databasePath: join(root, "state.sqlite"),
        worktreeRoot: join(root, "worktrees"),
        capacityDir: join(root, "capacity"),
        secretsDir: join(root, "secrets"),
        clock: systemClock,
        adapters: [
          new ClaudeCliAdapter({
            clock: systemClock,
            capacityFile: join(root, "capacity", "claude.json"),
          }),
        ],
        ctoPreference: { provider: "claude", model: REVIEWER_MODEL, effort: null },
        reviewer: {
          preferred: { provider: "claude", model: REVIEWER_MODEL, effort: null },
          fallbacks: [],
        },
      });

      // The owner supplies the capacity file; without it the sensor fails closed and
      // dispatch is refused, which is the documented behaviour rather than a guess.
      mkdirSync(join(root, "capacity"), { recursive: true });
      writeFileSync(
        join(root, "capacity", "claude.json"),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          runtimeHealth: "HEALTHY",
          buckets: [
            {
              id: "rolling-5h",
              remainingPercent: 75,
              resetAt: null,
              capabilities: ["ceo", "cto", "blind-review", "worker"],
            },
          ],
        }),
      );

      const evidence: Record<string, unknown> = {};

      // --- manual registration, no Repo Factory ----------------------------
      const projectId = "agent-control-plane";
      const project = cp.projects.register({
        projectId,
        name: "agent-control-plane",
        manifest: manifestFor(projectId),
      });
      expect(project.allowed).toBe(true);
      if (!project.allowed) return;

      const repository = await cp.repositories.register({
        checkoutPath: checkout,
        projectId,
        repositoryRole: "primary",
        activeManifestDigest: project.value.activeManifestDigest,
        identity: "github:MongLong0214/agent-control-plane",
      });
      expect(repository.allowed).toBe(true);
      if (!repository.allowed) return;
      evidence["registration"] = {
        projectId,
        activeManifestDigest: project.value.activeManifestDigest,
        identity: repository.value.identity,
        activityBeforeCto: cp.projects.require(projectId).activity,
      };

      // Hermes is the CEO endpoint; it is a distinct session from the CTO and reviewer.
      const hermes = cp.sessions.create({ provider: "hermes", model: "operator" });
      cp.sessions.transition(hermes.sessionId, SessionLifecycle.READY, "operator endpoint");
      cp.bindings.bind({ roleKey: "CEO", role: "CEO", sessionId: hermes.sessionId });

      // --- DIRECT cannot write --------------------------------------------
      const directAttempt = cp.guard.evaluate({
        operation: "FILE_MUTATION",
        targetPath: join(checkout, "src/core/reason-codes.ts"),
        claimedClassification: "DIRECT",
      });
      expect(directAttempt.allowed).toBe(false);
      expect(directAttempt.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
      evidence["directWriteRefused"] = directAttempt.reasonCode;

      // --- run creation and dispatch --------------------------------------
      const created = cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [
          { repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: "main" },
        ],
      });
      expect(created.allowed).toBe(true);
      if (!created.allowed) return;
      const runId = created.value.runId;

      const dispatched = await cp.runs.dispatch(runId);
      expect(dispatched.allowed).toBe(true);
      if (!dispatched.allowed) return;
      const run = dispatched.value;
      evidence["dispatch"] = {
        runId,
        ownerSessionId: run.ownerSessionId,
        ownerBindingGeneration: run.ownerBindingGeneration,
        pinnedManifestDigest: run.pinnedManifestDigest,
        activityAfterCto: cp.projects.require(projectId).activity,
      };

      // --- the real Primary CTO session produces the lean plan -------------
      const ctoAdapter = cp.providers.require("claude");
      const planning = await ctoAdapter.invoke({
        prompt: [
          "You are the Primary CTO for this run. Remove unnecessary complexity.",
          "",
          `Goal: ${CONTRACT.goal}`,
          `Scope: ${CONTRACT.scope.join(", ")}`,
          `Acceptance: ${CONTRACT.acceptance.join("; ")}`,
          "",
          "Reply with JSON only:",
          '{"summary":"...","tasks":[{"key":"impl","title":"...","category":"implementation"}],"removedOverengineering":["..."]}',
        ].join("\n"),
        workdir: checkout,
        timeoutMs: 5 * 60 * 1000,
        model: REVIEWER_MODEL,
        readOnly: true,
        correlationId: `${runId}:plan`,
      });
      if (!planning.ok) {
        throw new Error(`CTO planning invocation failed: ${planning.error ?? "unknown"}`);
      }
      evidence["ctoPlan"] = {
        provider: planning.provider,
        model: planning.model,
        durationMs: planning.durationMs,
        parsed: planning.json !== null,
      };

      const submitted = cp.tasks.submit(runId, [
        { key: "impl", title: "add the reason-code count helper", category: "implementation" },
        { key: "verify", title: "confirm the typecheck passes", category: "test", dependsOn: ["impl"] },
      ]);
      expect(submitted.allowed).toBe(true);
      if (!submitted.allowed) return;

      cp.artifacts.put(runId, "PLAN", {
        summary: "single-file helper, no new abstraction",
        source: "primary-cto",
        raw: planning.json ?? planning.text.slice(0, 2000),
      });

      // --- claim, then the worker's real repository change ------------------
      const claim = cp.claims.acquire({
        runId,
        ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        ownerRoleKey: run.ownerRoleKey!,
        repositoryIdentity: repository.value.identity,
        branch: "task/E2E-1-reason-code-count",
        declaredPaths: ["src/core/reason-codes.ts"],
      });
      expect(claim.allowed).toBe(true);

      const implTask = cp.tasks.ready(runId)[0]!;
      const implExecution = cp.tasks.startExecution({
        runId,
        taskId: implTask.taskId,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        workerSessionId: run.ownerSessionId,
        workerProcessId: process.pid,
        provider: "claude",
        model: REVIEWER_MODEL,
        repositoryId: repository.value.repositoryId,
        concurrencyWidth: 1,
      });
      expect(implExecution.allowed).toBe(true);
      if (!implExecution.allowed) return;

      gitSync(checkout, ["checkout", "-q", "-b", "task/E2E-1-reason-code-count"]);
      const target = join(checkout, "src/core/reason-codes.ts");
      const addition = [
        "",
        "/** Number of stable reason codes in the catalogue; used when auditing denials. */",
        "export const reasonCodeCount = (): number => ALL.size;",
        "",
      ].join("\n");
      writeFileSync(target, `${readUtf8(target)}${addition}`);
      gitSync(checkout, ["add", "-A"]);
      gitSync(checkout, ["commit", "-q", "-m", "feat(core): expose the reason-code catalogue size"]);
      const candidateHead = gitSync(checkout, ["rev-parse", "HEAD"]);

      cp.tasks.finishExecution(implExecution.value.executionId, {
        status: "SUCCEEDED",
        resultDigest: `sha256:${candidateHead}`,
      });

      const verifyTask = cp.tasks.ready(runId)[0]!;
      const verifyExecution = cp.tasks.startExecution({
        runId,
        taskId: verifyTask.taskId,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        workerSessionId: run.ownerSessionId,
        workerProcessId: process.pid,
        provider: "claude",
        model: REVIEWER_MODEL,
        repositoryId: repository.value.repositoryId,
      });
      if (!verifyExecution.allowed) throw new Error(verifyExecution.message);
      cp.tasks.finishExecution(verifyExecution.value.executionId, { status: "SUCCEEDED" });

      // --- the full candidate path: freeze, verify, review, packet ----------
      const outcome = await cp.pipeline.submitResult({
        runId,
        ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        resultSummary: "added reasonCodeCount() with no change to any existing code string",
        recommendation: "merge",
        residualRisk: [],
      });

      expect(outcome.allowed).toBe(true);
      if (!outcome.allowed) throw new Error(`${outcome.reasonCode}: ${outcome.message}`);
      if (outcome.value.stage !== "COMPLETED_REVIEW") {
        throw new Error(
          `pipeline stopped at ${outcome.value.stage}: ${JSON.stringify(outcome.value, null, 2)}`,
        );
      }

      const packet = outcome.value.packet;
      const snapshotDigest = outcome.value.snapshotDigest;

      expect(packet.verification.status).toBe("PASS");
      expect(packet.verification.observedInputs).toBe(packet.verification.expectedInputs);
      expect(packet.blindReview.verdict).toBe("PASS");
      expect(packet.blindReview.omittedItems).toBe(0);
      expect(packet.changedRepositories[0]?.candidateHead).toBe(candidateHead);

      const reviewPacket = cp.review.latestPacket(runId, snapshotDigest)!;
      // The reviewer is a genuinely different session from every producer.
      expect(cp.bindings.producerSessions(runId).has(reviewPacket.reviewerSessionId)).toBe(false);

      evidence["verification"] = packet.verification;
      evidence["blindReview"] = {
        verdict: reviewPacket.verdict,
        provider: reviewPacket.provider,
        model: reviewPacket.model,
        reviewerSessionId: reviewPacket.reviewerSessionId,
        reviewerGeneration: reviewPacket.reviewerRoleBindingGeneration,
        coveredFiles: reviewPacket.coveredFiles,
        omittedItems: reviewPacket.omittedItems,
        findings: reviewPacket.findings.length,
        withheld: reviewPacket.inputManifest.withheld,
      };
      evidence["candidateSnapshotDigest"] = snapshotDigest;
      expect(candidateSnapshotDigest).toBeTypeOf("function");

      // --- Hermes final confirmation ---------------------------------------
      expect(cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      const notified = cp.audit
        .byKind("CEO_NOTIFICATION")
        .filter((e) => e.evidence["notification"] === "READY_FOR_CEO_REVIEW");
      expect(notified).toHaveLength(1);

      const confirmed = cp.ceo.submitCeoDecision({
        runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: snapshotDigest,
        ceoSessionId: hermes.sessionId,
        rationale: "verification and an independent review both pass at this exact candidate",
      });
      expect(confirmed.allowed).toBe(true);
      expect(cp.runs.require(runId).state).toBe(RunState.COMPLETED);

      evidence["ceoConfirm"] = { state: cp.runs.require(runId).state, sessionId: hermes.sessionId };
      evidence["doctor"] = await cp.doctor.run("project", projectId);
      evidence["telemetry"] = {
        run: cp.telemetry.query("run"),
        task: cp.telemetry.query("task"),
        quality: cp.telemetry.query("quality"),
      };
      evidence["auditTrail"] = cp.audit.forRun(runId).map((e) => ({
        kind: e.kind,
        reasonCode: e.reasonCode,
      }));

      mkdirSync(join(REAL_PROJECT, "evidence"), { recursive: true });
      writeFileSync(
        join(REAL_PROJECT, "evidence", "e2e-real-project.json"),
        JSON.stringify(evidence, null, 2),
      );

      cp.close();
      cleanupTempDirs();
    },
    30 * 60 * 1000,
  );
});

const readUtf8 = (path: string): string => readFileSync(path, "utf8");
