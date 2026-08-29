import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { PRODUCER_ROLES, ROLE_CLASS, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedActor, seedRun } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Regressions for the binding and outbox defects the Sol review found. Each closes a way
 * authority could be forged, orphaned, or replayed.
 */
const setup = () => {
  const core = makeCore();
  const repo = makeRepo();
  const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
  const session = (id: string) => {
    core.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, ?, 'scripted', 'm', 'READY', ?, ?)`,
      [id, `inc-${id}`, core.clock.nowIso(), core.clock.nowIso()],
    );
    return id;
  };
  return { ...core, seeded, session };
};

describe("CP-HI-04 role classification is exhaustive", () => {
  it("counts every non-blind reviewer as a producer", () => {
    // §4 lists the optional adversarial reviewer in the producer set; leaving it out let a
    // session act as adversarial reviewer and then as the blind reviewer for the same run.
    expect(PRODUCER_ROLES).toContain(Role.OPTIONAL_ADVERSARIAL_REVIEWER);
    expect(ROLE_CLASS[Role.BLIND_REVIEWER]).toBe("QUALITY");
    expect(Object.keys(ROLE_CLASS).sort()).toEqual(Object.values(Role).sort());
  });

  it("refuses a blind reviewer that previously reviewed the same run adversarially", () => {
    const { bindings, seeded, session } = setup();
    const s = session("ses_adv");
    expect(
      bindings.bind({
        role: Role.OPTIONAL_ADVERSARIAL_REVIEWER,
        sessionId: s,
        runId: seeded.runId,
      }).allowed,
    ).toBe(true);

    const refused = bindings.assertReviewerIndependence(seeded.runId, s);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });
});

describe("#380 — worker execution provenance is fail-closed", () => {
  const recordWorkerExecution = (
    db: ReturnType<typeof makeCore>["db"],
    clock: ReturnType<typeof makeCore>["clock"],
    runId: string,
    taskId: string,
    workerSessionId: string | null,
    workerProcessId: number | null = null,
  ) => {
    db.run(
      `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
       VALUES (?, ?, 'worker task', 'implementation', 'READY', '{}', ?, ?)`,
      [taskId, runId, clock.nowIso(), clock.nowIso()],
    );
    db.run(
      `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                    worker_session_id, worker_process_id, provider, model, started_at, status)
       VALUES (?, ?, ?, 1, 1, ?, ?, 'scripted', 'worker', ?, 'RUNNING')`,
      [`${taskId}#1`, runId, taskId, workerSessionId, workerProcessId, clock.nowIso()],
    );
  };

  it("refuses an anonymous worker receipt before reviewer admission is even possible", () => {
    const { db, clock, seeded } = setup();
    db.run(`UPDATE runs SET dispatched_at = ? WHERE run_id = ?`, [clock.nowIso(), seeded.runId]);
    let caught: unknown;
    try {
      recordWorkerExecution(db, clock, seeded.runId, "tsk_anonymous_worker", null);
    } catch (error) {
      caught = error;
    }
    expect(isAcpError(caught)).toBe(true);
    if (!isAcpError(caught)) throw new Error("anonymous receipt did not fail structurally");
    expect(caught.reasonCode).toBe(ReasonCode.WORKER_BINDING_REQUIRED);
  });

  it("refuses the bound worker as reviewer from its persisted worker receipt", () => {
    const { db, clock, bindings, seeded, session } = setup();
    db.run(`UPDATE runs SET dispatched_at = ? WHERE run_id = ?`, [clock.nowIso(), seeded.runId]);
    const taskId = "tsk_bound_worker";
    const worker = session("ses_worker_from_bound_history");
    const workerBinding = bindings.bind({
      role: Role.WORKER,
      sessionId: worker,
      taskId,
      runId: seeded.runId,
      projectId: seeded.projectId,
    });
    expect(workerBinding.allowed).toBe(true);
    recordWorkerExecution(db, clock, seeded.runId, taskId, worker);

    const refused = bindings.bind({
      role: Role.BLIND_REVIEWER,
      sessionId: worker,
      runId: seeded.runId,
      projectId: seeded.projectId,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });

  it("refuses W as reviewer when the receipt records W alongside its process id", () => {
    const { db, clock, sessions, bindings, seeded } = setup();
    db.run(`UPDATE runs SET dispatched_at = ? WHERE run_id = ?`, [clock.nowIso(), seeded.runId]);
    const worker = sessions.create({
      provider: "scripted",
      model: "worker",
      sessionId: "ses_worker_process_identity",
      osPid: 424_242,
    });
    expect(sessions.transition(worker.sessionId, SessionLifecycle.READY, "worker session ready").allowed).toBe(true);
    const taskId = "tsk_worker_process_identity";
    const workerBinding = bindings.bind({
      role: Role.WORKER,
      sessionId: worker.sessionId,
      taskId,
      runId: seeded.runId,
      projectId: seeded.projectId,
    });
    expect(workerBinding.allowed).toBe(true);
    recordWorkerExecution(db, clock, seeded.runId, taskId, worker.sessionId, worker.osPid);

    const refused = bindings.bind({
      role: Role.BLIND_REVIEWER,
      sessionId: worker.sessionId,
      runId: seeded.runId,
      projectId: seeded.projectId,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });
});

describe("role keys cannot be forged", () => {
  it("refuses a supplied key that disagrees with the role and scope", () => {
    const { bindings, seeded, session } = setup();
    const s = session("ses_forge");
    const refused = bindings.bind({
      roleKey: `PRIMARY_CTO:${seeded.projectId}`,
      role: Role.CEO,
      sessionId: s,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("refuses a role bound without its required scope", () => {
    const { bindings, session } = setup();
    const s = session("ses_noscope");
    const refused = bindings.bind({ role: Role.BLIND_REVIEWER, sessionId: s });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("refuses reusing a role key for a different role", () => {
    const { bindings, seeded, session } = setup();
    const s = session("ses_reuse");
    // PRIMARY_CTO:<project> already exists from the fixture.
    const refused = bindings.bind({
      role: Role.PRIMARY_CTO,
      sessionId: s,
      projectId: seeded.projectId,
    });
    // Same role, but the key is already actively bound.
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);
  });
});

describe("a switch cannot orphan live runs", () => {
  it("refuses a plain switch while the outgoing binding owns work", () => {
    const { bindings, seeded, session } = setup();
    const s = session("ses_next");
    const refused = bindings.switchTo({
      role: Role.PRIMARY_CTO,
      sessionId: s,
      projectId: seeded.projectId,
      reason: "replacement",
      conversation: "REPLACED",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS);
  });

  it("a takeover repoints the run in the same transaction", () => {
    const { db, bindings, seeded, session } = setup();
    const s = session("ses_takeover");
    const switched = bindings.switchTo({
      role: Role.PRIMARY_CTO,
      sessionId: s,
      projectId: seeded.projectId,
      reason: "recovery",
      conversation: "REPLACED",
      takeover: true,
    });
    expect(switched.allowed).toBe(true);
    if (!switched.allowed) return;

    const run = db.get<{ owner_session_id: string; owner_binding_generation: number }>(
      `SELECT owner_session_id, owner_binding_generation FROM runs WHERE run_id = ?`,
      [seeded.runId],
    );
    expect(run?.owner_session_id).toBe(s);
    expect(run?.owner_binding_generation).toBe(switched.value.bindingGeneration);
  });
});

describe("final CEO independence sees the project-scoped CTO", () => {
  it("refuses the run's pinned owner as the deciding CEO", () => {
    const { bindings, seeded } = setup();
    const refused = bindings.assertFinalCeoIndependence(seeded.runId, seeded.sessionId);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.FINAL_CEO_SESSION_NOT_INDEPENDENT);
  });

  it("allows an unrelated session", () => {
    const { bindings, seeded, session } = setup();
    const s = session("ses_ceo");
    expect(bindings.assertFinalCeoIndependence(seeded.runId, s).allowed).toBe(true);
  });
});

describe("outbox delivery is claimed, not merely selected", () => {
  const enqueued = () => {
    const core = setup();
    const message = core.outbox.enqueue({
      idempotencyKey: `k:${core.seeded.runId}`,
      roleKey: core.seeded.roleKey,
      bindingGeneration: 1,
      targetSessionId: core.seeded.sessionId,
      runId: core.seeded.runId,
      kind: "RUN_DISPATCH",
      payload: { runId: core.seeded.runId },
    });
    if (!message.allowed) throw new Error(message.message);
    return { ...core, messageId: message.value.messageId };
  };

  it("a second delivery loop finds nothing to take", () => {
    const { outbox } = enqueued();
    const first = outbox.claimDeliverable();
    expect(first).toHaveLength(1);
    expect(outbox.claimDeliverable()).toHaveLength(0);
  });

  it("only the claim holder may complete the delivery", () => {
    const { outbox } = enqueued();
    const claimed = outbox.claimDeliverable()[0]!;
    expect(outbox.markSent(claimed.messageId, "clm_someone_else").allowed).toBe(false);
    expect(outbox.markSent(claimed.messageId, claimed.claimToken).allowed).toBe(true);
  });

  it("rejects an unclassified delivery failure instead of retrying it", () => {
    const { outbox } = enqueued();
    const claimed = outbox.claimDeliverable()[0]!;
    const failed = outbox.markAttemptFailed(claimed.messageId, claimed.claimToken, "boom");
    expect(failed.allowed).toBe(false);
    expect(failed.reasonCode).toBe(ReasonCode.OUTBOX_DELIVERY_REJECTED);
    expect(outbox.get(claimed.messageId)?.status).toBe("REJECTED");
    expect(outbox.claimDeliverable()).toHaveLength(0);
  });

  it("an abandoned lease is reclaimed rather than stuck", () => {
    const { outbox, clock } = enqueued();
    outbox.claimDeliverable();
    expect(outbox.claimDeliverable()).toHaveLength(0);
    clock.advance(6 * 60 * 1000);
    expect(outbox.claimDeliverable()).toHaveLength(1);
  });
});

describe("an ACK from a revoked generation changes nothing", () => {
  it("refuses the ACK even though it matches the stored envelope", () => {
    const core = setup();
    const message = core.outbox.enqueue({
      idempotencyKey: "k:ack",
      roleKey: core.seeded.roleKey,
      bindingGeneration: 1,
      targetSessionId: core.seeded.sessionId,
      runId: core.seeded.runId,
      kind: "RUN_DISPATCH",
      payload: {},
    });
    if (!message.allowed) throw new Error(message.message);

    // The role moves on; the old session's late ACK still matches the row exactly.
    core.db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [core.seeded.roleKey]);

    const ack = core.outbox.acknowledge(message.value.messageId, core.seeded.sessionId, 1);
    expect(ack.allowed).toBe(false);
    expect(ack.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(message.value.messageId)?.status).toBe("PENDING");
    expect(core.audit.byKind("OUTBOX_ACK_REJECTED").length).toBeGreaterThan(0);
  });

  it("refuses an ACK for an expired message", () => {
    const core = setup();
    const message = core.outbox.enqueue({
      idempotencyKey: "k:exp",
      roleKey: core.seeded.roleKey,
      bindingGeneration: 1,
      targetSessionId: core.seeded.sessionId,
      kind: "RUN_DISPATCH",
      payload: {},
    });
    if (!message.allowed) throw new Error(message.message);
    core.clock.advance(31 * 60 * 1000);

    const ack = core.outbox.acknowledge(message.value.messageId, core.seeded.sessionId, 1);
    expect(ack.allowed).toBe(false);
    expect(ack.reasonCode).toBe(ReasonCode.OUTBOX_EXPIRED);
    expect(core.outbox.get(message.value.messageId)?.status).not.toBe("ACKED");
  });
});

/**
 * CP-HI-08 — failover must not fence the counterpart the owner is mid-conversation with (#493).
 *
 * `assignments` bound a role to a session. A session is a replaceable model runtime, so
 * recovering a crashed one wrote a new binding, which advanced `binding_generation` — and
 * advancing that generation is how this system retires a superseded role holder. The effect was
 * that a runtime crash silently retired the CTO.
 *
 * #449 built `conversational_actors` and moved the live runtime pointer onto it, deliberately
 * without changing behaviour. This is the behaviour change, and the assertion whose absence was
 * the whole defect is the first one below: the generation does **not** move.
 */
describe("failover moves the runtime without retiring the counterpart (CP-HI-08, #493)", () => {
  const failoverSetup = () => {
    const core = setup();
    const incoming = core.session("ses_incoming");
    const roleKey = `PRIMARY_CTO:${core.seeded.projectId}`;
    const before = core.bindings.require(roleKey);
    return { ...core, incoming, roleKey, before, projectId: core.seeded.projectId };
  };

  it("leaves binding_generation unchanged when the conversation survived", () => {
    // The defect, stated directly. Before #493 this switch advanced the generation and the
    // owner's CTO was fenced by its own recovery.
    const { bindings, incoming, roleKey, before, projectId } = failoverSetup();
    const switched = bindings.switchTo({
      roleKey,
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: incoming,
      reason: "runtime crashed and was replaced",
      conversation: "SURVIVED",
    });
    expect(switched.allowed).toBe(true);
    expect(bindings.require(roleKey).bindingGeneration).toBe(before.bindingGeneration);
    expect(bindings.require(roleKey).assignmentId).toBe(before.assignmentId);
  });

  it("repoints the actor at the incoming runtime", () => {
    // The other half: the generation holding is only correct if the runtime actually moved.
    // Asserting one without the other would pass for a switch that did nothing at all.
    const { bindings, db, incoming, roleKey, before, projectId } = failoverSetup();
    bindings.switchTo({
      roleKey,
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: incoming,
      reason: "runtime crashed and was replaced",
      conversation: "SURVIVED",
    });
    const actor = db.get<{ current_session_id: string }>(
      `SELECT a.current_session_id FROM conversational_actors a
         JOIN assignments b ON b.actor_id = a.actor_id
        WHERE b.assignment_id = ?`,
      [before.assignmentId],
    );
    expect(actor?.current_session_id).toBe(incoming);
  });

  it("still advances the generation when the counterpart was replaced", () => {
    // The converse. A rule that never rotated would be a broken fence, not a fixed one — this
    // is what keeps the change from being "failover stopped fencing".
    const { bindings, incoming, roleKey, before, projectId } = failoverSetup();
    const switched = bindings.switchTo({
      roleKey,
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: incoming,
      reason: "a different CTO acknowledged the handoff",
      conversation: "REPLACED",
      // The seeded run is live, and replacing the counterpart would strand it on a revoked
      // generation — so this path requires an explicit takeover, exactly as before #493. The
      // SURVIVED cases above need no such thing, which is the difference.
      takeover: true,
    });
    expect(switched.allowed).toBe(true);
    expect(bindings.require(roleKey).bindingGeneration).toBeGreaterThan(before.bindingGeneration);
  });

  it("refuses a surviving conversation with no active binding to carry it", () => {
    // Nothing survived if nothing was bound. Reporting success here would leave the caller
    // believing a counterpart continued when none existed.
    const { bindings, incoming } = failoverSetup();
    const orphan = bindings.switchTo({
      roleKey: "PRIMARY_CTO:prj_absent",
      role: Role.PRIMARY_CTO,
      projectId: "prj_absent",
      sessionId: incoming,
      reason: "no binding here",
      conversation: "SURVIVED",
    });
    expect(orphan.allowed).toBe(false);
  });
});

/**
 * CP-HI-08 — the worker guard's dependency has to stay enforced, not become conventional (#493).
 *
 * `task_executions_worker_binding_required` used to rest on `assignments.session_id`, which
 * `assignments_generation_immutable` holds still. #493 moved it onto
 * `conversational_actors.current_session_id`, which is mutable — so the guard would have traded
 * an enforced dependency for a convention, and a convention is exactly what CP-HI-08 exists to
 * catch. `conversational_actors_runtime_ready` is what keeps it enforced.
 *
 * Written because the mutation table said so: deleting that trigger left every other test green.
 */
describe("an actor's runtime can only ever be a READY session (CP-HI-08, #493)", () => {
  it("refuses to repoint an actor at a session that is not ready", () => {
    const { db, bindings, seeded } = setup();
    db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES ('ses_draining', 'inc-draining', 'scripted', 'm', 'DRAINING', 't', 't')`,
    );
    const roleKey = `PRIMARY_CTO:${seeded.projectId}`;
    const actor = db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [bindings.require(roleKey).assignmentId],
    );
    // The raw-SQL bypass the trigger exists for. Going through switchTo would be refused earlier
    // by SESSION_NOT_READY, which proves the service layer and not the database backstop. Both
    // columns move together, matching what a real repoint always does (#666 round 7) — the READY
    // trigger is what this test is about, and the incarnation is set to the real one so its own
    // guard has nothing to say.
    expect(() =>
      db.run(
        `UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ?
          WHERE actor_id = ?`,
        ["ses_draining", "inc-draining", actor!.actor_id],
      ),
    ).toThrow(/ACTOR_RUNTIME_NOT_READY/);
  });

  it("allows the move when the incoming session is ready", () => {
    // The converse: a guard that refused every move would block failover itself, which is the
    // opposite failure and would not be caught by the refusal test alone.
    const { db, bindings, seeded, session } = setup();
    const ready = session("ses_ready_runtime");
    const roleKey = `PRIMARY_CTO:${seeded.projectId}`;
    const actor = db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [bindings.require(roleKey).assignmentId],
    );
    db.run(
      `UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ?
        WHERE actor_id = ?`,
      [ready, `inc-${ready}`, actor!.actor_id],
    );
    expect(bindings.require(roleKey).sessionId).toBe(ready);
  });
});

/**
 * A reused pid must not make an innocent session look like a producer (#505).
 *
 * `sessions.os_pid` was resolved back to a session inside `assertReviewerIndependence` with
 * nothing verifying it. Pids are reused, so that lookup could name a session that never touched
 * the run — which then gets refused as its blind reviewer. A guard that refuses correct work is
 * a bug, not safety, the same shape as the worker-binding guard fixed in #493.
 *
 * Note this is *not* a CP-HI-04 hole: `task_executions.worker_session_id` is NOT NULL, so the
 * real producer is always named directly and cannot be missed. The pid path only ever adds.
 *
 * The first draft of this test asserted its own SQL rather than driving the registry, and passed
 * with the fix mutated away. This one goes through `bind`.
 */
describe("a reused pid does not make an innocent session a producer (#505)", () => {
  const reviewerAfterReusedPid = () => {
    const core = setup();
    const producer = core.session("ses_real_producer");
    const innocent = core.session("ses_innocent_reviewer");
    // The innocent session carries the same pid the execution recorded, with a start time that
    // belongs to no live process — the shape a reused pid leaves behind.
    core.db.run(`UPDATE sessions SET os_pid = ?, os_process_started_at = ? WHERE session_id = ?`, [
      process.pid,
      "Thu Jan  1 00:00:00 1970",
      innocent,
    ]);
    // Producer history is reconstructed from the dispatched owner tuple, so the run has to have
    // been dispatched for the check to reach the pid lookup at all.
    core.db.run(`UPDATE runs SET dispatched_at = 't' WHERE run_id = ?`, [core.seeded.runId]);
    core.db.run(
      `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
       VALUES ('tsk_reuse', ?, 'work', 'implementation', 'READY', '{}', 't', 't')`,
      [core.seeded.runId],
    );
    // `producer`'s real incarnation, not the default — the actor's live pointer has to name the
    // session it actually points to (#666 round 7).
    const actorId = seedActor(core.db, "WORKER", producer, `inc-${producer}`);
    core.db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, run_id, task_id, actor_id, session_id,
                                session_incarnation, binding_generation, mode, status, created_at)
       VALUES ('asg_reuse', 'WORKER:tsk_reuse', 'WORKER', ?, 'tsk_reuse', ?, ?, ?, 1, 'PREFERRED', 'ACTIVE', 't')`,
      [core.seeded.runId, actorId, producer, `inc-${producer}`],
    );
    core.db.run(
      `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                    worker_session_id, worker_process_id, provider, model,
                                    status, started_at)
       VALUES ('exe_reuse', ?, 'tsk_reuse', 1, 1, ?, ?, 'scripted', 'm', 'RUNNING', 't')`,
      [core.seeded.runId, producer, process.pid],
    );
    return { ...core, innocent };
  };

  it("admits a blind reviewer that only shares a recycled pid with the execution", () => {
    const { bindings, seeded, innocent } = reviewerAfterReusedPid();
    const decision = bindings.bind({
      role: Role.BLIND_REVIEWER,
      sessionId: innocent,
      runId: seeded.runId,
    });
    expect(
      decision.allowed,
      `refused a reviewer that never produced: ${decision.allowed ? "" : decision.reasonCode}`,
    ).toBe(true);
  });

  it("still refuses the session that actually produced the work", () => {
    // The converse. A matcher that resolved nothing would pass the test above while removing the
    // independence guard entirely, which is the failure that matters.
    const { bindings, seeded } = reviewerAfterReusedPid();
    const decision = bindings.bind({
      role: Role.BLIND_REVIEWER,
      sessionId: "ses_real_producer",
      runId: seeded.runId,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("#664 — a takeover's revoke-and-mint rolls back when it cannot repoint every run", () => {
  /**
   * `CtoLifecycle.recoveryTakeover` calls `BindingRegistry.switchTo` with exactly this
   * shape (mode: FALLBACK, takeover: true, conversation: REPLACED) after its own
   * handoffs INSERT. Driving it through the full daemon is not possible for this
   * specific denial: `ControlPlane` always calls `bindings.attach({ tasks: this.tasks })`
   * during normal construction (src/app/control-plane.ts), so `!this.#tasks` can never be
   * true there. `makeCore()` builds a `BindingRegistry` the same way core-hardening.test.ts
   * and the rest of this file already do — without attaching a `TaskGraph` — which is
   * exactly the configuration this guard exists for, so this exercises the real
   * `switchTo` body (not a substitute) under the one precondition that reaches it.
   */
  it("switchTo denies a takeover that would strand a live, unabandonable execution, and rolls back its own writes", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });

    // A worker is bound and mid-execution on the run the dying CTO owns.
    const worker = "ses_worker_recovery_race";
    core.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc-1', 'scripted', 'm', 'READY', ?, ?)`,
      [worker, core.clock.nowIso(), core.clock.nowIso()],
    );
    const taskId = "tsk_recovery_race";
    const workerBinding = core.bindings.bind({
      role: Role.WORKER,
      sessionId: worker,
      taskId,
      runId: seeded.runId,
      projectId: seeded.projectId,
    });
    expect(workerBinding.allowed).toBe(true);
    core.db.run(
      `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
       VALUES (?, ?, 'recovery race task', 'implementation', 'READY', '{}', ?, ?)`,
      [taskId, seeded.runId, core.clock.nowIso(), core.clock.nowIso()],
    );
    core.db.run(
      `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                    worker_session_id, provider, model, started_at, status)
       VALUES (?, ?, ?, 1, ?, ?, 'scripted', 'worker', ?, 'RUNNING')`,
      [`${taskId}#1`, seeded.runId, taskId, seeded.generation, worker, core.clock.nowIso()],
    );

    const replacement = "ses_recovery_replacement";
    core.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc-1', 'scripted', 'm', 'READY', ?, ?)`,
      [replacement, core.clock.nowIso(), core.clock.nowIso()],
    );

    const before = core.db.get<{ assignment_id: string; status: string }>(
      `SELECT assignment_id, status FROM assignments
        WHERE role_key = ? AND binding_generation = ? AND status = 'ACTIVE'`,
      [seeded.roleKey, seeded.generation],
    );
    expect(before?.status).toBe("ACTIVE");

    const result = core.bindings.switchTo({
      roleKey: seeded.roleKey,
      role: Role.PRIMARY_CTO,
      sessionId: replacement,
      projectId: seeded.projectId,
      mode: "FALLBACK",
      reason: "recovery takeover race",
      conversation: "REPLACED",
      takeover: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);

    // The whole point of #664: switchTo's own revoke-and-mint had already written by the
    // time the stale-execution guard denied. Read the table directly, not the returned
    // Decision, to prove neither write survived.
    const original = core.db.get<{ status: string }>(
      `SELECT status FROM assignments WHERE assignment_id = ?`,
      [before!.assignment_id],
    );
    expect(original?.status).toBe("ACTIVE");

    const minted = core.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments WHERE role_key = ? AND binding_generation <> ?`,
      [seeded.roleKey, seeded.generation],
    );
    expect(minted?.n).toBe(0);

    const current = core.bindings.active(seeded.roleKey);
    expect(current?.sessionId).toBe(seeded.sessionId);
    expect(current?.bindingGeneration).toBe(seeded.generation);
  });
});
