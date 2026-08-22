import { afterAll, describe, expect, it } from "vitest";

import {
  BOOTSTRAP_OPERATOR_METHODS,
  OPERATOR_METHOD,
  canParkForBootstrap,
} from "../../src/daemon/daemon.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The instruction the doctor gives, and whether anything can carry it out.
 *
 * A contradicted conversation is quarantined: the actor takes no new turns until someone
 * adjudicates. The doctor said so and told the operator to record an adjudication — and there was
 * no operator method that recorded one, no `agentctl` command that called one, and a daemon that
 * refused to start at all while the finding stood, so there was not even a socket to ask. The exit
 * existed only inside the process that had the coordinator.
 *
 * A wedge whose exit is named and unreachable is worse than one with no exit named, because the
 * report reads as actionable. So the properties here are: the door opens, the read half shows what
 * to cite, and the write half actually clears the quarantine.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-22T00:00:00.000Z";

const target = (h: Harness, name: string): string => {
  const actorId = `actor:${name}`;
  h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [
    actorId,
    NOW,
  ]);
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, attested_at)
     VALUES (?, ?, 'v1', ?, 'ses', 'inc', 1, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, NOW],
  );
  return actorId;
};

/** A turn whose records disagree: the target says it committed, pre-dispatch says nothing ran. */
const contradicted = (h: Harness, actorId: string): string => {
  const claimed = h.cp.conversation.claim({
    targetActorId: actorId,
    prompt: "m1",
    sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: {} }],
  });
  if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
  h.cp.conversation.ports.target.completed(claimed.value, {
    receiptId: "target:m1",
    evidenceDigest: "sha256:receipt",
    reasonCode: ReasonCode.OK,
  });
  h.cp.conversation.ports.preDispatch.neverAdmitted(claimed.value, {
    receiptId: "pre:m1",
    evidenceDigest: "sha256:pre",
    reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
  });
  return claimed.value.turnRequestId;
};

describe("a contradicted conversation can be cleared from outside the process", () => {
  it("parks the daemon rather than refusing to start, so the door is reachable", () => {
    // The rule already said "park for what an operator can actually clear"; while no door existed
    // it enforced "park for capacity". Adding the door is what makes the sentence true.
    expect(canParkForBootstrap([{ code: "CANONICAL_TURN_CONTRADICTED", detail: "x" } as never])).toBe(
      true,
    );
    expect(BOOTSTRAP_OPERATOR_METHODS.has(OPERATOR_METHOD.CONVERSATION_CONTRADICTIONS)).toBe(true);
    expect(BOOTSTRAP_OPERATOR_METHODS.has(OPERATOR_METHOD.CONVERSATION_ADJUDICATE)).toBe(true);
  });

  it("still refuses to park for a finding no door can answer", () => {
    // Parking is a weaker state than stopping. It stays reachable only for findings an operator
    // has a way to clear, which is the whole reason the previous line is not simply "always park".
    expect(canParkForBootstrap([{ code: "STATE_PATH_INSECURE", detail: "x" } as never])).toBe(false);
    expect(
      canParkForBootstrap([
        { code: "CANONICAL_TURN_CONTRADICTED", detail: "x" } as never,
        { code: "STATE_PATH_INSECURE", detail: "x" } as never,
      ]),
    ).toBe(false);
  });

  it("shows the operator exactly the ids an adjudication has to cite", () => {
    const h = makeHarness();
    const actorId = target(h, "door");
    const turnRequestId = contradicted(h, actorId);

    const [reported] = h.cp.conversation.contradictions();

    expect(reported?.turnRequestId).toBe(turnRequestId);
    expect(reported?.targetActorId).toBe(actorId);
    // Ids rather than prose: the adjudication must name them, and an operator retyping a summary
    // is how a partial citation gets made.
    expect(reported?.observations.map((o) => o.authority).sort()).toEqual([
      "ACP_PRE_DISPATCH",
      "HERMES_TARGET",
    ]);
    expect(reported?.observations.every((o) => Number.isSafeInteger(o.observationId))).toBe(true);
  });

  it("clears the quarantine when those ids are cited back", () => {
    const h = makeHarness();
    const actorId = target(h, "cleared");
    const turnRequestId = contradicted(h, actorId);

    const blockedWhileContradicted = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "m2",
      sources: [{ channel: "telegram", nonce: "m2", attempt: 1, payload: {} }],
    });
    expect(blockedWhileContradicted.allowed).toBe(false);

    const [reported] = h.cp.conversation.contradictions();
    const decision = h.cp.conversation.adjudicate({
      targetActorId: actorId,
      turnRequestId,
      citedObservationIds: (reported?.observations ?? []).map((o) => o.observationId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:operator-read-both",
    });
    expect(decision.allowed).toBe(true);

    // The property that matters to the owner: the conversation takes messages again.
    const afterwards = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "m2",
      sources: [{ channel: "telegram", nonce: "m2", attempt: 1, payload: {} }],
    });
    expect(afterwards.allowed).toBe(true);
    expect(h.cp.conversation.contradictions()).toEqual([]);
  });
});
