import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { IN_BAND_REWAKE_MS } from "../../src/outbox/outbox.ts";
import {
  type BootstrapRuntimeFixture,
  acknowledgeInBandOnWorkTurns,
  withBootstrapRuntime,
} from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 PR-C slice C1b, review round 1 (PR #1073) — the four blockers, each driven through the
 * real sockets, the real launch channel and the daemon's own continuity reconcile; only the model is
 * scripted (`HeadlessRuntimeDouble`), and its work turns read and acknowledge what is addressed to
 * them in band as the CTO prompt asks.
 */

const dispatches = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId)
    .filter((message) => message.kind === MessageKind.RUN_DISPATCH)
    .map((message) => ({ key: message.idempotencyKey, generation: message.bindingGeneration, status: message.status }))
    .sort((left, right) => left.key.localeCompare(right.key));

const countKind = (f: BootstrapRuntimeFixture, kind: string, roleKey?: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    roleKey === undefined
      ? `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?`
      : `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND role_key = ?`,
    roleKey === undefined ? [kind] : [kind, roleKey],
  )?.n ?? 0;

/** A dispatched bootstrap run whose first work turn read and acknowledged its RUN_DISPATCH. */
const dispatchedAndAcked = async (f: BootstrapRuntimeFixture) => {
  const handled = acknowledgeInBandOnWorkTurns(f);
  const dispatched = await f.dispatchBootstrap();
  await vi.waitFor(() => expect(f.finishedTurns(dispatched.ownerSessionId)).toBe(2));
  expect(handled).toEqual([{ kind: MessageKind.RUN_DISPATCH, generation: 1, acked: true }]);
  return { ...dispatched, handled };
};

/** The CEO sends the run back for revision: the C2 review stand-in, then FINAL_REVISE over Hermes. */
const revise = async (f: BootstrapRuntimeFixture, runId: string): Promise<void> => {
  // TODO(C2): the bootstrap review gate moves the run to CEO review; this transition stands in.
  expect(f.harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed").allowed).toBe(true);
  const revised = await f.hermes("ceo_decision_submit", {
    runId,
    decision: "FINAL_REVISE",
    candidateSnapshotDigest: "sha256:bootstrap-candidate",
    ceoSessionId: f.ceoSessionId,
    rationale: "revise the plan",
  });
  expect(revised).toMatchObject({ ok: true, value: { state: RunState.REVISION_REQUIRED } });
};

/** The bootstrap CTO opens an escalation over its own authenticated socket. */
const escalate = async (f: BootstrapRuntimeFixture, runId: string, sessionId: string, blocksCriticalPath: boolean) => {
  const credential = f.claude.credentials.get(sessionId)!;
  const opened = await callMcpToolOverSocket(
    f.ctoSocket,
    { token: credential.token ?? "", sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
    "escalation_open",
    {
      idempotencyKey: `escalation-${blocksCriticalPath ? "critical" : "advisory"}`,
      runId,
      question: "which repository name?",
      options: ["acp-new", "acp-next"],
      ctoRecommendation: "acp-new",
      whyItMatters: "it is the repository's permanent identity",
      blocksCriticalPath,
    },
  );
  expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
};

describe("ACP-C1B-01: a failed work turn does not suppress its retry", () => {
  it("a RUN_DISPATCH whose work turn failed is run again when the outbox re-wakes it after the window, and is settled", async () => {
    await withBootstrapRuntime(async (f) => {
      const handled = acknowledgeInBandOnWorkTurns(f);
      f.claude.failNextWorkTurns = 1;
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      expect(handled).toEqual([]);
      expect(dispatches(f, runId)).toEqual([expect.objectContaining({ generation: 1, status: "PENDING" })]);

      f.harness.clock.advance(IN_BAND_REWAKE_MS);
      await f.harness.cp.outbox.wakeInBandPending();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3));
      await vi.waitFor(() => expect(handled).toEqual([{ kind: MessageKind.RUN_DISPATCH, generation: 1, acked: true }]));
      expect(dispatches(f, runId)).toEqual([expect.objectContaining({ generation: 1, status: "ACKED" })]);
      expect(f.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OUTBOX_IN_BAND_WAKE_FAILED' AND reason_code = ?`,
        [ReasonCode.SESSION_TURN_DUPLICATE],
      )?.n).toBe(0);
    });
  });

  it.each([MessageKind.ESCALATION_REPLY, MessageKind.REVISION_REQUEST] as const)(
    "a %s whose work turn failed is retried and settled the same way",
    async (kind) => {
      await withBootstrapRuntime(async (f) => {
        const { runId, ownerSessionId, roleKey, handled } = await dispatchedAndAcked(f);
        f.claude.failNextWorkTurns = 1;
        if (kind === MessageKind.ESCALATION_REPLY) {
          await escalate(f, runId, ownerSessionId, false);
          expect(f.harness.cp.ceo.resolveEscalation(runId, "use acp-new", f.ceoSessionId).allowed).toBe(true);
        } else {
          const binding = f.harness.cp.bindings.active(roleKey)!;
          expect(f.harness.cp.outbox.enqueue({
            idempotencyKey: `revision-request:${runId}:fixture`,
            roleKey,
            bindingGeneration: binding.bindingGeneration,
            targetSessionId: binding.sessionId,
            runId,
            kind,
            payload: { runId, feedback: "tighten the plan" },
          }).allowed).toBe(true);
        }
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3));
        const pending = () => f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === kind);
        expect(pending().map((message) => message.status)).toEqual(["PENDING"]);

        f.harness.clock.advance(IN_BAND_REWAKE_MS);
        await f.harness.cp.outbox.wakeInBandPending();
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(4));
        await vi.waitFor(() => expect(handled.map((entry) => entry.kind)).toContain(kind));
        expect(pending().map((message) => message.status)).toEqual(["ACKED"]);
      });
    },
  );
});

/**
 * Review round 2 (PR #1073), ROUND1-ESCAPE-01 — the reviewer's own witnesses are
 * `review-r2-witnesses.test.ts`, unchanged. These pin the rest of the rule: an envelope is done
 * when the outbox says it is, whatever any turn's exit said, and unacknowledged work waits for the
 * outbox's own window rather than looping.
 */
describe("ROUND1-ESCAPE-01: an envelope is settled by the outbox, not by a turn's exit", () => {
  const dispatchOf = (f: BootstrapRuntimeFixture, runId: string) =>
    f.harness.cp.outbox.listByRun(runId).find((message) => message.kind === MessageKind.RUN_DISPATCH)!;

  it("a completed turn that left its RUN_DISPATCH PENDING runs nothing more until the outbox's window passes", async () => {
    await withBootstrapRuntime(async (f) => {
      // No acknowledgement handler: the work turn exits 0 having made no tool call.
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      expect(dispatchOf(f, runId).status).toBe("PENDING");
      await f.harness.cp.outbox.wakeInBandPending();
      f.harness.clock.advance(IN_BAND_REWAKE_MS - 1);
      await f.harness.cp.outbox.wakeInBandPending();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
      expect(countKind(f, "OUTBOX_IN_BAND_WAKE_FAILED")).toBe(0);
      // The window passes: exactly one more turn, which settles it.
      const handled = acknowledgeInBandOnWorkTurns(f);
      f.harness.clock.advance(1);
      await f.harness.cp.outbox.wakeInBandPending();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(3));
      await vi.waitFor(() => expect(dispatchOf(f, runId).status).toBe("ACKED"));
      expect(handled).toEqual([{ kind: MessageKind.RUN_DISPATCH, generation: 1, acked: true }]);
      expect(f.finishedTurns(ownerSessionId)).toBe(3);
    });
  });

  it("a wake naming an envelope already acknowledged is refused and runs no turn", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await dispatchedAndAcked(f);
      const dispatch = dispatchOf(f, runId);
      expect(dispatch.status).toBe("ACKED");
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: dispatch.messageId, kind: "in-band dispatch" }])).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_TURN_DUPLICATE,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
    });
  });

  it("a wake naming an envelope that expired unacknowledged is refused and runs no turn", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
      const pending = dispatchOf(f, runId);
      expect(pending.status).toBe("PENDING");
      f.harness.clock.advance(Date.parse(pending.expiresAt) - Date.parse(f.harness.clock.nowIso()));
      expect(f.harness.cp.outbox.expireOverdue()).toBeGreaterThanOrEqual(1);
      expect(dispatchOf(f, runId).status).toBe("EXPIRED");
      expect(f.harness.cp.sessionRuntime.wake(roleKey, [{ id: pending.messageId, kind: "in-band dispatch" }])).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.SESSION_TURN_DUPLICATE,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
    });
  });
});

describe("ACP-C1B-02: recovery restores the bootstrap CTO's authority and keeps a CEO decision hold", () => {
  it.each(["credential lost at a restart", "provider outage"] as const)(
    "after %s, a run BLOCKED on CEO_DECISION_REQUIRED stays BLOCKED for the CEO, with its owner renewed",
    async (cause) => {
      await withBootstrapRuntime(async (f) => {
        const { runId, ownerSessionId, roleKey } = await dispatchedAndAcked(f);
        await escalate(f, runId, ownerSessionId, true);
        expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, stateReason: "CEO_DECISION_REQUIRED" });

        if (cause === "credential lost at a restart") {
          f.harness.cp.sessionRuntime.release(ownerSessionId);
          await f.daemon.reconcileContinuity("first tick after a restart");
        } else {
          f.loseClaude();
          await f.daemon.reconcileContinuity("claude coverage lost");
          f.restoreClaude();
        }
        await f.daemon.reconcileContinuity("recovery tick");

        // Authority is back on the same session, at the next generation …
        expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 2, sessionId: ownerSessionId });
        expect(f.harness.cp.sessionRuntime.holds(ownerSessionId)).toBe(true);
        // … and the CEO's decision is still owed: the run did not move and nothing was dispatched.
        expect(f.harness.cp.runs.require(runId)).toMatchObject({
          state: RunState.BLOCKED,
          stateReason: "CEO_DECISION_REQUIRED",
          ownerBindingGeneration: 2,
        });
        expect(dispatches(f, runId).map((message) => message.generation)).toEqual([1]);
        expect(countKind(f, "CEO_DECISION")).toBe(0);

        // The CEO's resolution reaches the renewed generation, which runs a turn for it.
        const turns = f.finishedTurns(ownerSessionId);
        expect(f.harness.cp.ceo.resolveEscalation(runId, "use acp-new", f.ceoSessionId).allowed).toBe(true);
        expect(f.harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
        await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(turns + 1));
        expect(f.harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.ESCALATION_REPLY)
          .map((message) => [message.bindingGeneration, message.status])).toEqual([[2, "ACKED"]]);
      });
    },
  );
});

describe("ACP-C1B-03: a restart that loses the credential does not strand a run sent back for revision", () => {
  it("REVISION_REQUIRED: the same session is renewed, the run keeps REVISION_REQUIRED, and the revision is redispatched to it", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await dispatchedAndAcked(f);
      await revise(f, runId);
      f.harness.cp.sessionRuntime.release(ownerSessionId);

      await f.daemon.reconcileContinuity("first tick after a restart");
      await f.daemon.reconcileContinuity("recovery tick");
      expect(countKind(f, "CONTINUITY_REVOKE_DEFERRED", roleKey)).toBe(0);
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 2, sessionId: ownerSessionId });
      expect(f.harness.cp.sessionRuntime.holds(ownerSessionId)).toBe(true);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.REVISION_REQUIRED, ownerBindingGeneration: 2 });

      const turns = f.finishedTurns(ownerSessionId);
      const redispatched = await f.hermes("run_dispatch", { runId });
      expect(redispatched, JSON.stringify(redispatched)).toMatchObject({
        ok: true,
        value: { state: RunState.ACTIVE, ownerSessionId, ownerBindingGeneration: 2 },
      });
      // The revision is dispatched to the renewed generation, and its work turn runs and settles it.
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(turns + 2));
      await vi.waitFor(() => expect(dispatches(f, runId)).toEqual([
        { key: `run-dispatch:${runId}:1`, generation: 1, status: "ACKED" },
        { key: `run-dispatch:${runId}:2:r1`, generation: 2, status: "ACKED" },
      ]));
    });
  });
});

describe("ACP-C1B-03 sibling: a run at CEO review keeps its human hold through a credential loss", () => {
  it("READY_FOR_CEO_REVIEW → AWAITING_HUMAN by continuity's pause; the owner is renewed and the run stays with the human", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await dispatchedAndAcked(f);
      // TODO(C2): the bootstrap review gate moves the run to CEO review; this transition stands in.
      expect(f.harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed").allowed).toBe(true);
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      await f.daemon.reconcileContinuity("first tick after a restart");
      await f.daemon.reconcileContinuity("recovery tick");
      expect(countKind(f, "CONTINUITY_REVOKE_DEFERRED", roleKey)).toBe(0);
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 2, sessionId: ownerSessionId });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.AWAITING_HUMAN, ownerBindingGeneration: 2 });
      expect(dispatches(f, runId).map((message) => message.generation)).toEqual([1]);
    });
  });
});

describe("ACP-C1B-04: a revision redispatch dispatches the revision", () => {
  it("bootstrap: the reused binding gets a RUN_DISPATCH for the revision cycle, and a work turn reads and settles it", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, handled } = await dispatchedAndAcked(f);
      await revise(f, runId);
      const redispatched = await f.hermes("run_dispatch", { runId });
      expect(redispatched).toMatchObject({ ok: true, value: { state: RunState.ACTIVE, ownerBindingGeneration: 1 } });
      // The reuse attestation, then the revision's own work turn.
      await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(4));
      await vi.waitFor(() => expect(handled).toHaveLength(2));
      expect(handled).toEqual([
        { kind: MessageKind.RUN_DISPATCH, generation: 1, acked: true },
        { kind: MessageKind.RUN_DISPATCH, generation: 1, acked: true },
      ]);
      expect(dispatches(f, runId)).toEqual([
        { key: `run-dispatch:${runId}:1`, generation: 1, status: "ACKED" },
        { key: `run-dispatch:${runId}:1:r1`, generation: 1, status: "ACKED" },
      ]);
    });
  });

  it("project: a revision redispatch at the same generation enqueues the revision's RUN_DISPATCH; the first cycle's key is unchanged", async () => {
    const h = makeHarness();
    try {
      const { projectId, repositoryId } = await registerFixtureProject(h);
      const created = h.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: {
          goal: "g", why: "w", scope: [], nonGoals: [], acceptance: ["a"], priority: "NORMAL", humanGate: [], references: [],
        },
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!created.allowed) throw new Error(created.message);
      const runId = created.value.runId;
      const first = await h.cp.runs.dispatch(runId);
      if (!first.allowed) throw new Error(first.message);
      const generation = first.value.ownerBindingGeneration!;
      const [initial] = h.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.RUN_DISPATCH);
      expect(initial?.idempotencyKey).toBe(`run-dispatch:${runId}:${generation}`);
      expect(h.cp.outbox.acknowledge(initial!.messageId, first.value.ownerSessionId!, generation).allowed).toBe(true);
      expect(h.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "reviewed").allowed).toBe(true);
      expect(h.cp.runs.transition(runId, RunState.REVISION_REQUIRED, "revise").allowed).toBe(true);

      const again = await h.cp.runs.dispatch(runId);
      expect(again).toMatchObject({ allowed: true, value: { state: RunState.ACTIVE, ownerBindingGeneration: generation } });
      expect(h.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.RUN_DISPATCH)
        .map((message) => [message.idempotencyKey, message.status]).sort()).toEqual([
        [`run-dispatch:${runId}:${generation}`, "ACKED"],
        [`run-dispatch:${runId}:${generation}:r1`, "PENDING"],
      ]);
    } finally {
      h.cp.close();
    }
  });
});

describe("ACP-C1B-02 schema: only a run-state transition writes a continuity hold", () => {
  const blockedRun = async () => {
    const h = makeHarness();
    const created = h.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "g", why: "w", scope: [], nonGoals: [], acceptance: ["a"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    // BLOCKED, so the only refusal left for a raw hold write is the authority trigger itself:
    // the only-while-BLOCKED trigger has nothing to say about a BLOCKED run.
    for (const to of [RunState.ACTIVE, RunState.BLOCKED] as const) {
      const moved = h.cp.runs.transition(runId, to, `fixture: ${to}`);
      if (!moved.allowed) throw new Error(moved.message);
    }
    return { h, runId };
  };

  it("a raw UPDATE cannot mark a run as held by continuity", async () => {
    const { h, runId } = await blockedRun();
    try {
      expect(h.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: null });
      expect(() => h.cp.db.run(`UPDATE runs SET continuity_hold_role_key = ? WHERE run_id = ?`, [`BOOTSTRAP_CTO:${runId}`, runId]))
        .toThrow(/RUN_CONTINUITY_HOLD_DENIED|RUN_STATE_TRANSITION_AUTHORITY_DENIED|authority/i);
      expect(h.cp.runs.require(runId).continuityHoldRoleKey).toBeNull();
    } finally {
      h.cp.close();
    }
  });

  it("a run is never inserted already held", async () => {
    const { h, runId } = await blockedRun();
    try {
      const row = h.cp.db.get<Record<string, unknown>>(`SELECT * FROM runs WHERE run_id = ?`, [runId])!;
      expect(() => h.cp.db.run(
        `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at, continuity_hold_role_key)
         VALUES ('run_forged_hold', ?, ?, ?, 'QUEUED', ?, ?, ?, 'BOOTSTRAP_CTO:run_forged_hold')`,
        [row["kind"], row["execution_mode"], row["priority"], row["goal"], row["contract_digest"], row["created_at"]],
      )).toThrow(/RUN_CONTINUITY_HOLD_DENIED|RUN_STATE_TRANSITION_AUTHORITY_DENIED|authority/i);
    } finally {
      h.cp.close();
    }
  });
});

describe("ACP-C1B-02/03 guard: what continuity held is distinguishable from what it did not", () => {
  it("a run continuity paused can still be cancelled: the hold ends with the pause it recorded", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, roleKey } = await dispatchedAndAcked(f);
      f.loseClaude();
      await f.daemon.reconcileContinuity("claude coverage lost");
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: roleKey });
      const cancelled = await f.hermes("run_cancel", { runId, reason: "withdrawn while paused" });
      expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ ok: true });
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.CANCELLED, continuityHoldRoleKey: null });
    });
  });

  it("a run continuity paused records the hold; a CEO-decision hold records none", async () => {
    await withBootstrapRuntime(async (f) => {
      const { runId, ownerSessionId, roleKey } = await dispatchedAndAcked(f);
      f.loseClaude();
      await f.daemon.reconcileContinuity("claude coverage lost");
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: roleKey });
      f.restoreClaude();
      await f.daemon.reconcileContinuity("recovery tick");
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.ACTIVE, continuityHoldRoleKey: null });
      await escalate(f, runId, ownerSessionId, true);
      expect(f.harness.cp.runs.require(runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: null });
      expect(roleKeyFor(Role.BOOTSTRAP_CTO, { runId })).toBe(roleKey);
    });
  });
});
