import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { PRODUCER_ROLES, ROLE_CLASS, Role } from "../../src/domain/types.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun } from "../helpers/fixtures.ts";

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

  it("a failed attempt returns the message to the queue", () => {
    const { outbox } = enqueued();
    const claimed = outbox.claimDeliverable()[0]!;
    expect(outbox.markAttemptFailed(claimed.messageId, claimed.claimToken, "boom").allowed).toBe(true);
    expect(outbox.claimDeliverable()).toHaveLength(1);
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
    expect(core.outbox.get(message.value.messageId)?.status).not.toBe("ACKED");
  });
});
