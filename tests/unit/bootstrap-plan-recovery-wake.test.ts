import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_PLAN_GUIDE_PLACEHOLDERS,
  BOOTSTRAP_PLAN_GUIDE_SCHEMA_ID,
  bootstrapPlanGuide,
  currentBootstrapPlan,
  minimalBootstrapManifest,
  planForSubmission,
} from "../../src/bootstrap/bootstrap-plan.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, assertPortableManifest, manifestDigest } from "../../src/contracts/manifest.ts";
import { canonicalJson, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  BOOTSTRAP_PLAN_RECOVERY_WAKE,
  PLAN_SUBMISSIONS_PER_TURN,
  type SessionWakeTrigger,
  planRecoveryTriggerId,
  planRecoveryTriggerKind,
} from "../../src/runtime/provisioned-session-runtime.ts";
import { bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { passBootstrapPlanReviews } from "../helpers/bootstrap-result.ts";
import { FakeGitHub as FakeGitHubClient } from "../helpers/fake-github.ts";
import { FakeGitHub as FakeGitHubWritePort } from "../helpers/fake-github-write-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import {
  SCRIPTED_CONTRACT_VALUES,
  type ScriptedBootstrapOwner,
  scriptBootstrapOwner,
} from "../helpers/scripted-bootstrap-owner.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The guarded bootstrap PLAN recovery wake (`Daemon.wakeBootstrapPlanRecovery`), the planning
 * directive a driven owner's prompt carries, and the `bootstrapPlanGuide` `contract_get` hands a
 * project-less bootstrap's owner. Every row drives the real sockets, launch channel and in-band
 * wake; only the model is scripted, and it does what its prompt says.
 */

const runDispatches = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.db.all<{ message_id: string; binding_generation: number; status: string }>(
    `SELECT message_id, binding_generation, status FROM outbox WHERE run_id = ? AND kind = ? ORDER BY created_at, rowid`,
    [runId, MessageKind.RUN_DISPATCH],
  );

const markers = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.audit.byKind(BOOTSTRAP_PLAN_RECOVERY_WAKE)
    .filter((row) => row.runId === runId)
    .map((row) => row.evidence);

const planOf = (f: BootstrapRuntimeFixture, runId: string) => f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN);

const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run whose owner's RUN_DISPATCH turn acknowledged it and planned nothing, with its turn ended. */
const stalled = async (
  f: BootstrapRuntimeFixture,
  onRecovery: ScriptedBootstrapOwner["onRecovery"],
  // These rows are about the PLAN stage; the result stage has its own (bootstrap-result-*.test.ts).
  onResult: ScriptedBootstrapOwner["onResult"] = "ignore",
) => {
  const owner = scriptBootstrapOwner(f, { onDispatch: "ack-only", onRecovery, onResult });
  const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
  await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
  await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
  const [dispatch] = runDispatches(f, runId);
  expect(dispatch).toMatchObject({ binding_generation: 1, status: "ACKED" });
  expect(planOf(f, runId)).toBeNull();
  return { owner, runId, ownerSessionId, roleKey, messageId: dispatch!.message_id };
};

const startDaemon = async (f: BootstrapRuntimeFixture, name: string): Promise<Daemon> => {
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir(`acp-bpr-${name}-`), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};

/** What a daemon process that starts again no longer has: the runtime's memory of its turns. Its credential is delivered again. */
const forgetRuntimeMemory = (f: BootstrapRuntimeFixture, sessionId: string): void => {
  const credential = f.claude.credentials.get(sessionId);
  if (!credential) throw new Error("the session's runtime never took its credential");
  const epoch = f.harness.cp.sessions.require(sessionId).credentialEpoch;
  f.harness.cp.sessionRuntime.release(sessionId);
  expect(f.harness.cp.sessionRuntime.adopt(sessionId, Role.BOOTSTRAP_CTO, credential.sessionSecret, epoch).allowed).toBe(true);
};

describe("the recovery wake: once per (run, owner generation, acknowledged RUN_DISPATCH)", () => {
  it("wakes the stalled owner once, with a trigger that says why; a second pass (the next watchdog tick) wakes nothing, and nothing follows up an owner that does not answer", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, ownerSessionId, roleKey, messageId } = await stalled(f, "ignore");
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [{ runId, roleKey, bindingGeneration: 1, messageId }] });
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3));
      expect(owner.prompts.at(-1)).toContain(`The control plane woke you for: ${planRecoveryTriggerKind(runId)}.`);
      // The owner did not answer; still no PLAN, and every later pass leaves it alone.
      expect(planOf(f, runId)).toBeNull();
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      await ticks(50);
      expect(f.finishedTurns(ownerSessionId)).toBe(3);
      const triggerId = planRecoveryTriggerId(runId, 1, messageId);
      expect(markers(f, runId)).toEqual([{ bindingGeneration: 1, messageId, triggerId }]);
      // The runtime's own duplicate refusal applies to the same trigger as well.
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: triggerId, kind: planRecoveryTriggerKind(runId) }]))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_TURN_DUPLICATE });
    });
  });

  it("a run that already has a PLAN is not woken", async () => {
    await withBootstrapRuntime(async (f) => {
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onResult: "ignore" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
      expect(runDispatches(f, runId)).toEqual([expect.objectContaining({ status: "ACKED" })]);
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(markers(f, runId)).toEqual([]);
    });
  });

  it("an owner with a turn running, or one queued behind it, is not woken; once it is idle it is, once", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, ownerSessionId, roleKey } = await stalled(f, "ignore");
      const runtime = f.harness.cp.sessionRuntime;
      const release = owner.hold();
      expect(runtime.wake(roleKey, [{ id: "busy-1", kind: "test" }])).toMatchObject({ allowed: true, value: "STARTED" });
      await vi.waitFor(() => expect(owner.prompts).toHaveLength(2));
      expect(runtime.turnInProgress(ownerSessionId)).toBe(true);
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(runtime.wake(roleKey, [{ id: "busy-2", kind: "test" }])).toMatchObject({ allowed: true, value: "COALESCED" });
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(markers(f, runId)).toEqual([]);
      release();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(4));
      await vi.waitFor(() => expect(runtime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(5));
      expect(markers(f, runId)).toHaveLength(1);
    });
  });

  it("an owner whose session is not READY is not woken", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await stalled(f, "ignore");
      expect(f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.DRAINING, "test: draining").allowed).toBe(true);
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(f.harness.cp.sessions.transition(ownerSessionId, SessionLifecycle.READY, "test: ready again").allowed).toBe(true);
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(1);
      expect(markers(f, runId)).toHaveLength(1);
    });
  });

  it("an owner whose binding was revoked, or superseded by a later generation, is not woken", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await stalled(f, "ignore");
      const session = f.harness.cp.sessions.require(ownerSessionId);
      // Continuity revokes the binding of a session whose credential the daemon lost, and pauses the run.
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      await f.daemon.reconcileContinuity("first tick after a restart");
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      forgetRuntimeMemory(f, ownerSessionId);
      // The run made ACTIVE again with its owner's binding still revoked: only the binding is stale.
      expect(f.harness.cp.runs.transition(runId, RunState.ACTIVE, "test: active with a revoked owner").allowed).toBe(true);
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      // A later generation on the same session, while the run is still pinned to the first.
      const renewed = f.harness.cp.bindings.renewSameSession({
        roleKey,
        expectedGeneration: 1,
        sessionId: ownerSessionId,
        sessionIncarnation: session.incarnation,
        reason: "test: superseded",
      });
      expect(renewed).toMatchObject({ allowed: true, value: { bindingGeneration: 2 } });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, ownerBindingGeneration: 1 });
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
      expect(markers(f, runId)).toEqual([]);
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
    });
  });

  it("a second daemon start for the same tuple wakes nothing, though the runtime's own memory of the wake is gone", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey, messageId } = await stalled(f, "ignore");
      const first = await startDaemon(f, "first");
      try {
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3), { timeout: 10_000, interval: 25 });
      } finally {
        await first.stop();
      }
      forgetRuntimeMemory(f, ownerSessionId);
      const second = await startDaemon(f, "second");
      try {
        await ticks(400);
      } finally {
        await second.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(3);
      expect(markers(f, runId)).toHaveLength(1);
      // Only the recorded wake held the second daemon back: the runtime itself would take the trigger again.
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{
        id: planRecoveryTriggerId(runId, 1, messageId),
        kind: planRecoveryTriggerKind(runId),
      }])).toMatchObject({ allowed: true, value: "STARTED" });
    });
  });
});

/**
 * Holds the next launch preparation — the first await of a relayed turn, between the wake that
 * admitted it and its provider call — until `release`, so a row can change what made it eligible.
 */
const holdLaunchPreparation = (f: BootstrapRuntimeFixture) => {
  let release!: () => void;
  let entered = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = f.launch.prepare.bind(f.launch);
  vi.spyOn(f.launch, "prepare").mockImplementationOnce(async () => {
    entered = true;
    await barrier;
    return prepare();
  });
  return { entered: () => entered, release: () => release() };
};

const turnsRefused = (f: BootstrapRuntimeFixture, sessionId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN_REFUSED' AND session_id = ?`,
    [sessionId],
  )?.n ?? 0;

const plannedElsewhere = (f: BootstrapRuntimeFixture, runId: string, ownerSessionId: string) =>
  f.cto(ownerSessionId, "plan_submit", {
    runId,
    plan: bootstrapPlan(cleanTreeManifest("already-planned"), { requestDigest: f.harness.cp.runs.require(runId).contractDigest }),
    tasks: [{ key: "bootstrap", title: "create the repository", category: "implementation" }],
  });

describe("R1-01: the recovery wake's eligibility is asked again immediately before the provider call", () => {
  it("(a) an owner whose run was held and whose binding was revoked while launch preparation awaited is never contacted; the wake stays spent", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await stalled(f, "follow-prompt");
      const cp = f.harness.cp;
      const providerTurns = f.claude.turns.length;
      const held = holdLaunchPreparation(f);
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(held.entered()).toBe(true));
      expect(cp.runs.transition(runId, RunState.BLOCKED, "test: held while the wake prepares").allowed).toBe(true);
      expect(cp.bindings.revoke(roleKey, "test: revoked while the wake prepares", { allowBlockedRuns: true }).allowed).toBe(true);
      held.release();
      await vi.waitFor(() => expect(turnsRefused(f, ownerSessionId)).toBe(1));
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.claude.turns.length).toBe(providerTurns);
      expect(markers(f, runId)).toHaveLength(1);
    });
  });

  it("(b) a PLAN the current owner submitted while launch preparation awaited suppresses the recovery turn, and is not replaced", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await stalled(f, "follow-prompt");
      const cp = f.harness.cp;
      const providerTurns = f.claude.turns.length;
      const held = holdLaunchPreparation(f);
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(held.entered()).toBe(true));
      expect(await plannedElsewhere(f, runId, ownerSessionId)).toMatchObject({ ok: true });
      const original = planOf(f, runId)!;
      held.release();
      await vi.waitFor(() => expect(turnsRefused(f, ownerSessionId)).toBe(1));
      await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(f.claude.turns.length).toBe(providerTurns);
      expect(planOf(f, runId)!.digest).toBe(original.digest);
      expect(markers(f, runId)).toHaveLength(1);
      expect(f.daemon.wakeBootstrapPlanRecovery()).toEqual({ woken: [] });
    });
  });

  it("(c) coalesced with another trigger, a recovery that no longer holds is dropped: the turn runs for the other, and its prompt names no recovery", async () => {
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, ownerSessionId, roleKey } = await stalled(f, "follow-prompt");
      const runtime = f.harness.cp.sessionRuntime;
      // The trigger exactly as the daemon builds it, kept rather than run, so it can be coalesced.
      let recovery: readonly SessionWakeTrigger[] = [];
      const wake = vi.spyOn(runtime, "wake").mockImplementationOnce((_roleKey, triggers) => {
        recovery = triggers;
        return allow(ReasonCode.OK, "STARTED" as const);
      });
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(1);
      wake.mockRestore();
      expect(recovery).toEqual([expect.objectContaining({ kind: planRecoveryTriggerKind(runId) })]);
      // A turn runs; the recovery and an ordinary trigger coalesce behind it into one follow-up.
      const release = owner.hold();
      expect(runtime.wake(roleKey, [{ id: "busy", kind: "test" }])).toMatchObject({ allowed: true, value: "STARTED" });
      await vi.waitFor(() => expect(owner.prompts).toHaveLength(2));
      expect(runtime.wake(roleKey, [...recovery])).toMatchObject({ allowed: true, value: "COALESCED" });
      expect(runtime.wake(roleKey, [{ id: "other", kind: "ordinary work" }])).toMatchObject({ allowed: true, value: "COALESCED" });
      // Meanwhile the owner plans the run itself, so the recovery no longer holds.
      expect(await plannedElsewhere(f, runId, ownerSessionId)).toMatchObject({ ok: true });
      const original = planOf(f, runId)!;
      release();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(4));
      await vi.waitFor(() => expect(runtime.turnInProgress(ownerSessionId)).toBe(false));
      expect(owner.prompts).toHaveLength(3);
      const followUp = owner.prompts.at(-1)!;
      expect(followUp).toContain("The control plane woke you for: ordinary work.");
      expect(followUp).not.toContain("plan recovery");
      expect(followUp).not.toContain('A wake for "');
      expect(planOf(f, runId)!.digest).toBe(original.digest);
      expect(turnsRefused(f, ownerSessionId)).toBe(0);
    });
  });
});

describe("restart: the renewed owner's run gets its one recovery wake and proceeds", () => {
  it("after a restart that loses the credential, the renewed generation's RUN_DISPATCH is acknowledged with no PLAN; the daemon wakes that owner once and the run proceeds", async () => {
    await withBootstrapRuntime(async (f) => {
      // The owner that plans also submits its result, as the prompt now says; the review passes it.
      passBootstrapPlanReviews(f);
      const { owner, runId, ownerSessionId, roleKey } = await stalled(f, "follow-prompt", "follow-prompt");
      // The restart: the plaintext credential is gone. Continuity pauses the run and revokes the
      // binding; the next tick recovers the same session at the next generation and redispatches.
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      await f.daemon.reconcileContinuity("first tick after a restart");
      await f.daemon.reconcileContinuity("recovery tick");
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 2, sessionId: ownerSessionId });
      // The renewed generation's RUN_DISPATCH turn only acknowledges too.
      await vi.waitFor(() => expect(runDispatches(f, runId).map((row) => [row.binding_generation, row.status]))
        .toEqual([[1, "ACKED"], [2, "ACKED"]]));
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(planOf(f, runId)).toBeNull();
      const turnsBefore = f.finishedTurns(ownerSessionId);

      const daemon = await startDaemon(f, "restart");
      try {
        await vi.waitFor(() => expect(planOf(f, runId)).not.toBeNull(), { timeout: 10_000, interval: 25 });
        await vi.waitFor(() => expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW), {
          timeout: 10_000,
          interval: 25,
        });
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(turnsBefore + 1);
      const second = runDispatches(f, runId)[1]!;
      expect(markers(f, runId)).toEqual([{
        bindingGeneration: 2,
        messageId: second.message_id,
        triggerId: planRecoveryTriggerId(runId, 2, second.message_id),
      }]);
      expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
      // The same turn submitted the result; the review passed it to CEO review. The task stays READY:
      // it is settled only at CEO CONFIRM from the create receipt (CEO 1792120507).
      expect(owner.results).toEqual([{ runId, ok: true, stage: "COMPLETED_REVIEW" }]);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.READY_FOR_CEO_REVIEW, ownerBindingGeneration: 2 });
      expect(f.harness.cp.tasks.ready(runId)).toHaveLength(1);
    });
  });
});

describe("separation: an accepted PLAN is not an approval and writes nothing to GitHub", () => {
  it("the recovered owner's PLAN is accepted with zero GitHub calls, no owner approval, no CEO decision and no confirmation", async () => {
    const client = new FakeGitHubClient();
    const writePort = new FakeGitHubWritePort(tempDir("acp-bpr-github-"));
    await withBootstrapRuntime(async (f) => {
      const { owner, runId, ownerSessionId } = await stalled(f, "follow-prompt");
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(1);
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3));
      expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
      expect(planOf(f, runId)).not.toBeNull();

      expect(client.calls).toEqual([]);
      expect(writePort.writes).toEqual([]);
      expect(writePort.reads).toEqual([]);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
      const approvalKinds = [
        "CEO_DECISION", "OWNER_DECISION", "OWNER_APPROVAL_INGRESS", "OWNER_APPROVAL_CONSUMED",
        "BOOTSTRAP_APPLICATION_APPROVAL", "BOOTSTRAP_ACTIVATION_READY_FOR_CONFIRM", "BUZZ_OWNER_APPROVAL_PROMPTED",
      ];
      expect(f.harness.cp.audit.all().filter((row) => approvalKinds.includes(row.kind))).toEqual([]);
      for (const kind of [
        ArtifactKind.APPROVAL, ArtifactKind.CANDIDATE_SNAPSHOT, ArtifactKind.BLIND_REVIEW,
        ArtifactKind.REPO_FACTORY_RESULT, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT,
      ]) {
        expect(f.harness.cp.artifacts.latest(runId, kind)).toBeNull();
      }
      expect(f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bootstrap_applications`)?.n).toBe(0);
      expect(f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM github_receipts`)?.n).toBe(0);
    }, { githubClient: client, repoFactory: { workRoot: tempDir("acp-bpr-factory-"), githubPort: writePort } });
  });
});

describe("the prompt: the RUN_DISPATCH planning directive, and the recovery wake's own line", () => {
  it("every work prompt keeps its instructions and the ack rule, and adds a generic directive with its bound; only a recovery wake's prompt carries the recovery line", async () => {
    await withBootstrapRuntime(async (f) => {
      const first = await stalled(f, "ignore");
      const second = await stalled(f, "ignore");
      expect(f.daemon.wakeBootstrapPlanRecovery().woken).toHaveLength(2);
      await vi.waitFor(() => expect(f.finishedTurns(first.ownerSessionId) + f.finishedTurns(second.ownerSessionId)).toBe(6));
      const prompts = f.claude.turns.filter((turn) => !/nonce set to/.test(turn.prompt)).map((turn) => turn.prompt);
      expect(prompts).toHaveLength(4);
      const lines = (prompt: string) => prompt.split("\n");
      for (const prompt of prompts) {
        expect(prompt).toContain("Call mcp__acp-cto__role_dispatch_pending to read the messages addressed to you.");
        expect(prompt).toContain("acknowledge each one with mcp__acp-cto__run_ack (or mcp__acp-cto__role_dispatch_ack when it names no run).");
        expect(prompt).toContain("A HANDOFF_PACKAGE is accepted with mcp__acp-cto__handoff_ack");
        expect(prompt).toContain("When nothing addressed to you remains, reply with a one-line summary of what you did.");
        expect(prompt).toContain(`at most ${PLAN_SUBMISSIONS_PER_TURN} plan_submit calls for that run in this turn`);
      }
      // The directive is the same bytes for every run: no run, project or README in it.
      const directive = (prompt: string) => lines(prompt).find((line) => line.startsWith("A RUN_DISPATCH for a run you own"))!;
      expect(new Set(prompts.map(directive)).size).toBe(1);
      for (const runId of [first.runId, second.runId]) expect(directive(prompts[0]!)).not.toContain(runId);
      const recoveryLine = (prompt: string) => lines(prompt).find((line) => line.startsWith('A wake for "plan recovery: run <runId> has no PLAN"'));
      const recoveries = prompts.filter((prompt) => prompt.includes("plan recovery: run run_") || /woke you for: plan recovery/.test(prompt));
      expect(recoveries).toHaveLength(2);
      expect(new Set(recoveries.map(recoveryLine)).size).toBe(1);
      expect(recoveryLine(recoveries[0]!)).toContain("mcp__acp-cto__contract_get");
      expect(prompts.filter((prompt) => recoveryLine(prompt) === undefined)).toHaveLength(2);
    });
  });
});

describe("the bootstrapPlanGuide contract_get carries", () => {
  const filled = (value: unknown): Record<string, unknown> => {
    let text = JSON.stringify(value);
    for (const [placeholder, real] of Object.entries(SCRIPTED_CONTRACT_VALUES)) text = text.split(placeholder).join(real);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const bootstrapRun = { kind: RunKind.PROJECT_BOOTSTRAP, projectId: null };

  it("its example manifest is built by the production function from placeholders and passes assertPortableManifest; so does the same function's output for real values", () => {
    const guide = bootstrapPlanGuide();
    expect(guide.schema).toBe(BOOTSTRAP_PLAN_GUIDE_SCHEMA_ID);
    expect(guide.manifest.schema).toBe(PROJECT_MANIFEST_SCHEMA_ID);
    expect(guide.manifest.example).toEqual(minimalBootstrapManifest({
      projectId: BOOTSTRAP_PLAN_GUIDE_PLACEHOLDERS.projectId,
      repositoryIdentity: BOOTSTRAP_PLAN_GUIDE_PLACEHOLDERS.repositoryIdentity,
    }));
    expect(assertPortableManifest(guide.manifest.example)).toMatchObject({ allowed: true });
    expect(assertPortableManifest(minimalBootstrapManifest({ projectId: "widget", repositoryIdentity: "github:acme/widget" })))
      .toMatchObject({ allowed: true });
    // The required keys are the schema's own, and each one is required.
    expect(guide.manifest.requiredKeys).toEqual(["schema", "projectId", "repositories", "branchProfile", "verificationProfiles"]);
    for (const key of guide.manifest.requiredKeys) {
      const { [key]: _removed, ...without } = guide.manifest.example as Record<string, unknown>;
      expect(assertPortableManifest(without).allowed, key).toBe(false);
    }
    expect(guide.repositoryCreateOperation.shape).toEqual({
      operationId: "<operation-id>",
      resourceType: "repository",
      resourceIdentity: "github:<owner>/<name>",
      desiredState: { visibility: "<public|private>", autoInit: true },
    });
    // Generic: no run, session or project value anywhere, and the same guide on every call.
    expect(JSON.stringify(guide)).not.toMatch(/\brun_[A-Za-z0-9]|\bses_[A-Za-z0-9]|widget|acme/);
    expect(bootstrapPlanGuide()).toEqual(guide);
  });

  it("the digest is what the rule says, and a MANIFEST_MISMATCH refusal reports it as supplied; the PLAN built from the guide is then accepted and plans executable outputs", () => {
    const guide = bootstrapPlanGuide();
    const manifest = filled(guide.manifest.example);
    const parsed = assertPortableManifest(manifest);
    if (!parsed.allowed) throw new Error(parsed.message);
    // "sha256:" and the lowercase hex SHA-256 of the canonical JSON, after the schema's defaults.
    expect(manifestDigest(parsed.value)).toBe(sha256(canonicalJson(parsed.value)));
    expect(manifestDigest(parsed.value)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifestDigest(parsed.value)).not.toBe(sha256(canonicalJson(manifest)));
    const plan = {
      summary: "create the repository",
      bootstrapOperationId: "bootstrap-widget",
      requestDigest: "sha256:contract",
      projectManifestDigest: "sha256:unknown",
      githubOperations: [filled(guide.repositoryCreateOperation.shape)],
      projectManifest: manifest,
    };
    const refused = planForSubmission(bootstrapRun, plan);
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: { refusal: "MANIFEST_MISMATCH", supplied: manifestDigest(parsed.value), named: "sha256:unknown" },
    });
    const accepted = planForSubmission(bootstrapRun, { ...plan, projectManifestDigest: (refused.evidence as { supplied: string }).supplied });
    if (!accepted.allowed) throw new Error(accepted.message);
    const current = currentBootstrapPlan("run_guide", { digest: "sha256:plan", content: accepted.value });
    expect(current, JSON.stringify(current)).toMatchObject({
      allowed: true,
      value: {
        outputs: {
          target: { repositoryIdentity: "github:acme/widget", repositoryRole: "primary", visibility: "private" },
          defaultBranch: "main",
          files: [],
        },
      },
    });
  });

  it("contract_get for a project-less bootstrap run adds the guide and leaves every other field as it was", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId } = await stalled(f, "ignore");
      const answer = await f.cto(ownerSessionId, "contract_get", { runId });
      expect(answer).toMatchObject({ ok: true });
      const { bootstrapPlanGuide: guide, ...rest } = answer["value"] as Record<string, unknown>;
      expect(guide).toEqual(bootstrapPlanGuide());
      const run = f.harness.cp.runs.require(runId);
      expect(rest).toEqual(JSON.parse(JSON.stringify({
        run,
        contract: f.harness.cp.artifacts.latest(runId, ArtifactKind.TASK_CONTRACT)?.content ?? null,
        pinnedManifestDigest: run.pinnedManifestDigest,
        verificationCommands: [],
        branchProfile: null,
        repositories: f.harness.cp.runs.repositoriesOf(runId),
      })));
    });
  });

  it("contract_get for a STANDARD_WORK run is byte-identical to the answer before the guide existed", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness, "standard-project");
    bindCeo(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: {
        goal: "make app() return 2", why: "callers expect 2", scope: ["src/app.js"], nonGoals: [],
        acceptance: ["verify.js exits 0"], priority: "NORMAL", humanGate: [], references: [],
      },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
    const runId = created.value.runId;
    const answer = await callCtoToolAsOwner(harness, runId, "contract_get", { runId });
    expect(answer.isError).toBe(false);
    // The answer as `contractForRun` built it before this change, serialized as `ok()` serializes it.
    const run = harness.cp.runs.require(runId);
    const manifest = harness.cp.projects.manifest(run.pinnedManifestDigest!);
    const before = {
      run,
      contract: harness.cp.artifacts.latest(runId, ArtifactKind.TASK_CONTRACT)?.content ?? null,
      pinnedManifestDigest: run.pinnedManifestDigest,
      verificationCommands: manifest?.verificationCommands ?? [],
      branchProfile: manifest?.branchProfile ?? null,
      repositories: harness.cp.runs.repositoriesOf(runId),
    };
    expect(answer.text).toBe(JSON.stringify({ ok: true, value: before }, null, 2));
    expect(answer.body["value"]).not.toHaveProperty("bootstrapPlanGuide");
  });
});
