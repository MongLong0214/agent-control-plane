import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { passBootstrapPlanReviews } from "../helpers/bootstrap-result.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { RUN_DISPATCH_DIRECTIVE, scriptBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The live stall (CEO 1792116612, option A): a project-less PROJECT_BOOTSTRAP run's driven
 * BOOTSTRAP_CTO read its one RUN_DISPATCH, acknowledged it, and ended its turn without a PLAN —
 * and a driven session is woken only by what is addressed to it, so nothing ever ran it again.
 *
 * Both rows go through the real sockets, the real launch channel, the in-band wake and a started
 * daemon with its watchdog; only the model is scripted (`scriptBootstrapOwner`), and it does only
 * what the turn's prompt tells it to. They import nothing the fix added, so they run unchanged
 * against the base and fail there on behaviour.
 *
 * Since the result stage (CEO 1792120507) the prompt also has an owner whose PLAN is accepted submit
 * the run's result in the same turn, so the reviewer is scripted too, and the run that proceeds
 * reaches CEO review with its task still READY.
 */

const runDispatches = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId)
    .filter((message) => message.kind === MessageKind.RUN_DISPATCH)
    .map((message) => ({ generation: message.bindingGeneration, status: message.status }));

const planOf = (f: BootstrapRuntimeFixture, runId: string) => f.harness.cp.artifacts.latest(runId, "PLAN");

const recoveryWakes = (f: BootstrapRuntimeFixture, runId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'BOOTSTRAP_PLAN_RECOVERY_WAKE' AND run_id = ?`,
    [runId],
  )?.n ?? 0;

/** A daemon started over the fixture's control plane, its watchdog ticking every 50 ms. */
const startDaemon = async (f: BootstrapRuntimeFixture): Promise<Daemon> => {
  // The startup doctor blocks on a missing trusted GitHub credential, which these rows are not about.
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir("acp-bpstall-daemon-"), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};

const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the ack-only stall: a driven bootstrap owner that acknowledges its RUN_DISPATCH and plans nothing", () => {
  it("is left with no PLAN and no pending work; the daemon wakes it exactly once more, and the PLAN it then builds from contract_get's guide is accepted", async () => {
    await withBootstrapRuntime(async (f) => {
      passBootstrapPlanReviews(f);
      const owner = scriptBootstrapOwner(f, { onDispatch: "ack-only", onRecovery: "follow-prompt" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      // The attestation, then the RUN_DISPATCH's work turn, which only acknowledged.
      await f.awaitFinishedTurns(ownerSessionId, 1);
      expect(owner.acknowledged).toEqual([expect.objectContaining({ kind: MessageKind.RUN_DISPATCH, ok: true })]);
      expect(runDispatches(f, runId)).toEqual([{ generation: 1, status: "ACKED" }]);
      expect(planOf(f, runId)).toBeNull();
      // Nothing addressed to it is pending, so the outbox's own re-wake has nothing to wake it for.
      await f.harness.cp.outbox.wakeInBandPending();
      await ticks(50);
      expect(f.finishedTurns(ownerSessionId)).toBe(1);

      const daemon = await startDaemon(f);
      try {
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2), { timeout: 10_000, interval: 25 });
        // Several more watchdog ticks: the owner is never woken a second time.
        await ticks(400);
        expect(f.finishedTurns(ownerSessionId)).toBe(2);
      } finally {
        await daemon.stop();
      }
      expect(recoveryWakes(f, runId)).toBe(1);

      // The wake says why, and carries the planning directive.
      const woken = owner.prompts.at(-1)!;
      expect(woken).toContain(`plan recovery: run ${runId} has no PLAN`);
      expect(woken).toContain("mcp__acp-cto__contract_get");
      expect(woken).toContain("mcp__acp-cto__plan_submit");
      expect(woken).toMatch(/at most \d+ plan_submit calls for that run in this turn/);

      // The owner read the guide, named a digest it could not compute, took the refusal's
      // `supplied`, and the second submission was accepted.
      expect(owner.contracts).toHaveLength(1);
      expect(owner.contracts[0]).toHaveProperty("bootstrapPlanGuide");
      expect(owner.submissions.map(({ ok, refusal }) => ({ ok, refusal }))).toEqual([
        { ok: false, refusal: "MANIFEST_MISMATCH" },
        { ok: true, refusal: null },
      ]);
      const plan = planOf(f, runId);
      expect(plan).not.toBeNull();
      expect((plan!.content as Record<string, unknown>)["projectManifestDigest"]).toBe(owner.submissions[0]!.supplied);
      // The run proceeds: the same turn submitted its result, which the review passed to CEO review.
      // The PLAN's task stays READY until CEO CONFIRM settles it from the create receipt.
      expect(f.harness.cp.tasks.ready(runId)).toHaveLength(1);
      expect(f.harness.cp.runs.require(runId).state).toBe("READY_FOR_CEO_REVIEW");
    });
  });

  it("an owner that follows the RUN_DISPATCH prompt plans in that very turn, and then nothing wakes it again", async () => {
    await withBootstrapRuntime(async (f) => {
      passBootstrapPlanReviews(f);
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onRecovery: "follow-prompt" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      // That turn now also submits the result, which runs the review: waited for, however long it takes under load.
      await f.awaitFinishedTurns(ownerSessionId, 1);
      // The RUN_DISPATCH's own turn carries the directive, and the ack rule is still there.
      const prompt = owner.prompts[0]!;
      expect(prompt).toContain(RUN_DISPATCH_DIRECTIVE);
      expect(prompt).toContain("then acknowledge the RUN_DISPATCH with mcp__acp-cto__run_ack");
      expect(prompt).toContain("Act on each message as its kind requires");
      expect(planOf(f, runId)).not.toBeNull();
      expect(runDispatches(f, runId)).toEqual([{ generation: 1, status: "ACKED" }]);

      const daemon = await startDaemon(f);
      try {
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(1);
      expect(recoveryWakes(f, runId)).toBe(0);
    });
  });
});
