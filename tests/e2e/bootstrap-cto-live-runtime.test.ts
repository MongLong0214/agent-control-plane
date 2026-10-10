import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
import type { UsageCollector } from "../../src/capacity/usage-collectors.ts";
import { systemClock } from "../../src/core/clock.ts";
import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { startDaemonMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { claudeTranscriptDirectory } from "../../src/runtime/cli-adapters.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);

/**
 * Issue #246 PR-C slice C1b — the closing evidence, live: a project-less bootstrap run's
 * BOOTSTRAP_CTO staffed on the real `ClaudeCliAdapter`, which spawns the real `claude` binary under
 * the runtime seatbelt, whose only MCP server is the real acp-cto relay (`src/cli/session-relay.ts`),
 * which takes the session credential from the daemon's real take-once launch channel and
 * authenticates on the daemon's real `cto.mcp.sock`. The composition is the daemon's own: a
 * `ControlPlane` on `defaultConfig` in a temporary state root, `startSessionLaunchChannel` with the
 * MCP token, `startDaemonMcpListeners` (which routes in-band wakes to the runtime), and a `Daemon` for
 * the continuity reconcile. Nothing about the CTO is scripted; the model is Claude Opus, the role's
 * fixed runtime, which nothing in the fixed-runtime check lets a test override.
 *
 * The one stand-in is capacity: each adapter's usage collector answers from a value this test sets,
 * so a Claude outage and its return can be produced on demand instead of waited for.
 *
 * Gated: it spends real model turns. Run with `ACP_LIVE_CLAUDE=1`. When `ACP_LIVE_REAL_HOME` is also
 * set, start the process with `HOME` at a temporary directory: the product's per-turn scratch root
 * is fixed from `HOME` when its module loads, so it lands under that temporary home, and the CLI is
 * then handed `ACP_LIVE_REAL_HOME` as its `HOME`, which is where it authenticates and keeps its
 * transcripts.
 */
const LIVE = process.env["ACP_LIVE_CLAUDE"] === "1";
const TOKEN = "live-c1b-mcp-token-not-a-deployment-secret";

const reading = (provider: string, healthy: boolean): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: healthy ? "HEALTHY" : "UNAVAILABLE",
  observedAt: systemClock.nowIso(),
  source: "live-c1b-capacity-switch",
  buckets: healthy
    ? [{ id: "five_hour", remainingPercent: 90, resetAt: null, capabilities: ["ceo", "cto", "blind-review", "worker"] }]
    : [],
});

const turnsOf = (cp: ControlPlane, sessionId: string) =>
  cp.db.all<{ evidence_json: string; reason_code: string }>(
    `SELECT evidence_json, reason_code FROM audit_events WHERE kind = 'SESSION_TURN' AND session_id = ? ORDER BY event_id`,
    [sessionId],
  ).map((row): Record<string, unknown> => ({ ...(JSON.parse(row.evidence_json) as Record<string, unknown>), reasonCode: row.reason_code }));

describe.skipIf(!LIVE)("C1b live: a real headless BOOTSTRAP_CTO", () => {
  it("attests, plans over its own authenticated socket, keeps one conversation, and is recovered on its own session after an outage", async () => {
    const realHome = process.env["ACP_LIVE_REAL_HOME"];
    if (realHome) process.env["HOME"] = realHome;
    const claudeUp = { value: true };
    const collectors: Record<string, UsageCollector> = {
      claude: { collect: async () => reading("claude", claudeUp.value) },
      gpt: { collect: async () => reading("gpt", false) },
      grok: { collect: async () => reading("grok", false) },
    };
    const root = realpathSync(tempDir("acp-c1b-live-"));
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const base = defaultConfig(stateDir);
    const cp = new ControlPlane({
      ...base,
      ownerIdentities: [],
      adapterOptions: {
        claude: { usageCollector: collectors["claude"]!, binary: process.env["ACP_CLAUDE_BINARY"] ?? "claude" },
        gpt: { usageCollector: collectors["gpt"]!, binary: "/nonexistent/codex" },
        grok: { usageCollector: collectors["grok"]!, binary: "/nonexistent/grok" },
      },
    });
    const launch = await startSessionLaunchChannel(stateDir, { mcpToken: TOKEN });
    const daemon = cp.createDaemon({ stateDir });
    const listeners = await startDaemonMcpListeners(cp, stateDir, TOKEN, daemon);
    cp.sessionRuntime.attach({
      delivery: launch,
      route: { launchSocketPath: launch.socketPath, mcpSocketPath: join(stateDir, "cto.mcp.sock") },
    });
    try {
      const ceo = cp.sessions.create({ provider: "scripted", model: "live-ceo" });
      cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "live CEO");
      expect(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
      let keys = 0;
      const hermes = (name: string, args: Record<string, unknown>) => callMcpToolOverSocket(
        join(stateDir, "hermes.mcp.sock"),
        { token: TOKEN, sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret! },
        name,
        { idempotencyKey: `live-${++keys}`, ...args },
      );

      const created = await hermes("run_create", {
        kind: RunKind.PROJECT_BOOTSTRAP,
        executionMode: ExecutionMode.STANDARD,
        contract: {
          goal:
            "Control-plane runtime check, not a real project. For this run, call the tool mcp__acp-cto__plan_submit once " +
            "with idempotencyKey \"live-plan-1\", the run's runId, plan.summary \"live headless runtime plan\", and exactly " +
            "one task {key: \"live\", title: \"live runtime check\", category: \"docs\"}. Then acknowledge the dispatch.",
          why: "proves the bootstrap CTO's real runtime acts over its own authenticated connection",
          scope: [],
          nonGoals: ["any repository or GitHub work"],
          acceptance: ["a PLAN exists for the run"],
          priority: "NORMAL",
          humanGate: [],
          references: [],
        },
      });
      expect(created).toMatchObject({ ok: true });
      const runId = (created["value"] as { runId: string }).runId;
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });

      // Spawn: the attestation turn opens the conversation; only then READY, bind, pin, RUN_DISPATCH.
      const dispatched = await hermes("run_dispatch", { runId });
      expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ ok: true, value: { state: RunState.ACTIVE } });
      const run = cp.runs.require(runId);
      const sessionId = run.ownerSessionId!;
      const session = cp.sessions.require(sessionId);
      const conversation = session.incarnation.split("#", 1)[0]!;
      expect(session).toMatchObject({ provider: "claude", model: "opus", lifecycle: SessionLifecycle.READY });

      // The RUN_DISPATCH wake runs the second turn, which plans over the session's own socket.
      await vi.waitFor(() => expect(turnsOf(cp, sessionId)).toHaveLength(2), { timeout: 15 * 60_000, interval: 2_000 });
      const plan = cp.artifacts.latest<{ summary: string }>(runId, "PLAN");
      expect(plan?.content.summary).toBe("live headless runtime plan");
      expect(cp.tasks.list(runId).map((task) => task.title)).toEqual(["live runtime check"]);

      // Outage, then the restore pass recovers the same session.
      claudeUp.value = false;
      await daemon.reconcileContinuity("live: claude coverage lost");
      expect(cp.bindings.active(roleKey)).toBeNull();
      expect(cp.runs.require(runId).state).toBe(RunState.BLOCKED);
      claudeUp.value = true;
      const restored = await daemon.reconcileContinuity("live: claude coverage returned");
      expect(restored?.restored, JSON.stringify(restored?.restorationDeferred)).toContain(roleKey);
      await vi.waitFor(() => expect(turnsOf(cp, sessionId)).toHaveLength(5), { timeout: 15 * 60_000, interval: 2_000 });

      const after = cp.sessions.require(sessionId);
      const turns = turnsOf(cp, sessionId);
      const transcripts = claudeTranscriptDirectory(realpathSync(after.workdir!))!;
      const summary = {
        runId,
        sessionId,
        conversation,
        workdir: after.workdir,
        scratchRoot: ACP_SCRATCH_ROOT,
        credentialEpoch: { before: session.credentialEpoch, after: after.credentialEpoch },
        bindings: cp.bindings.history(roleKey).map((held) => ({
          generation: held.bindingGeneration,
          status: held.status,
          sessionId: held.boundSessionId,
        })),
        run: cp.runs.require(runId).state,
        ownerGeneration: cp.runs.require(runId).ownerBindingGeneration,
        turns,
        plan: plan?.content.summary,
        tasks: cp.tasks.list(runId).length,
        transcriptFiles: existsSync(transcripts) ? readdirSync(transcripts) : [],
        attestations: cp.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_ATTESTED' AND session_id = ?`, [sessionId],
        )?.n,
        recovered: cp.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'BOOTSTRAP_CTO_RECOVERED' AND session_id = ?`, [sessionId],
        )?.n,
      };
      process.stdout.write(`C1B-LIVE-SUMMARY ${JSON.stringify(summary)}\n`);

      expect(after).toMatchObject({ lifecycle: SessionLifecycle.READY, incarnation: session.incarnation, credentialEpoch: 1 });
      expect(summary.bindings).toEqual([
        { generation: 1, status: "REVOKED", sessionId },
        { generation: 2, status: "ACTIVE", sessionId },
      ]);
      expect(cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, ownerBindingGeneration: 2 });
      expect(turns.map((turn) => [turn["purpose"], turn["step"], turn["sameConversationId"], turn["reasonCode"]])).toEqual([
        ["attestation", "new", true, "OK"],
        ["work", "resume", true, "OK"],
        ["probe", "resume", true, "OK"],
        ["attestation", "resume", true, "OK"],
        ["work", "resume", true, "OK"],
      ]);
      // One conversation, one transcript, in the session's own fixed workdir.
      expect(summary.transcriptFiles).toEqual([`${conversation}.jsonl`]);
      expect(summary.attestations).toBe(2);
      expect(summary.recovered).toBe(1);
    } finally {
      await listeners.close();
      await launch.close();
      cp.close();
    }
  }, 40 * 60_000);
});
