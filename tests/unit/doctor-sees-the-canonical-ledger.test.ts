import { afterAll, describe, expect, it } from "vitest";

import { ConversationTurnCoordinator, type TurnPermit } from "../../src/conversation/turn-coordinator.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The canonical ledger, seen by the tool an operator actually runs.
 *
 * `doctor` already reported an unresolved *ingress* claim, and that check reads
 * `inbound_messages` — a representation the reply reservation overwrites on an ordinary timeout.
 * So the canonical ledger could be wedged, refusing every later turn, while `agentctl doctor
 * system` reported a healthy CEO route. An external review named that state exactly: the ledger
 * red and the doctor green.
 *
 * The two checks stay separate and are never summed. They watch different representations, and
 * a healthy count in one hiding a wedge in the other is the failure this is written against.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-21T00:00:00.000Z";

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
    [`bind:${name}`, actorId, `locator-${name}`, `digest-${name}`, NOW],
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

/**
 * One coordinator per harness. A permit is signed with a key that lives only in the instance
 * that issued it, so a second instance cannot settle what the first claimed — deliberate, and
 * the reason these helpers share one.
 */
const coordinators = new WeakMap<object, ConversationTurnCoordinator>();
const coordinatorOf = (h: Harness): ConversationTurnCoordinator => {
  const existing = coordinators.get(h.cp.db as object);
  if (existing) return existing;
  const made = new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);
  coordinators.set(h.cp.db as object, made);
  return made;
};

/** An admitted inbound message, which a turn's source now has to name. */
const admit = (h: Harness, nonce: string, channel = "telegram"): void => {
  h.cp.db.run(
    `INSERT OR IGNORE INTO inbound_messages (channel, nonce, actor, received_at, payload_digest)
     VALUES (?, ?, 'owner', ?, ?)`,
    [channel, nonce, NOW, `sha256:${channel}:${nonce}`],
  );
};

const claim = (h: Harness, actorId: string, nonce: string): TurnPermit => {
  const coordinator = coordinatorOf(h);
  admit(h, nonce);
  const claimed = coordinator.claim({
    targetActorId: actorId,
    prompt: "question",
    sources: [{ channel: "telegram", nonce, attempt: 1 }],
  });
  if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
  return claimed.value;
};

const finding = (report: DoctorReport, code: string) =>
  report.findings.find((one) => one.code === code);

describe("doctor reads the canonical ledger, not only the ingress claim", () => {
  it("says nothing when nothing is outstanding", async () => {
    // A finding that is always present is not a signal, and an operator who learns to ignore it
    // has lost the one they needed.
    const h = makeHarness();

    expect(finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_IN_DOUBT")).toBeUndefined();
  });

  it("reports a turn in doubt, with the age that decides what to do about it", async () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claim(h, actorId, "n1");
    h.clock.advance(3 * 60_000);

    const found = finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_IN_DOUBT");

    expect(found?.severity).toBe("WARN");
    expect(found?.observedEvidence).toMatchObject({
      outstanding: 1,
      oldestAgeMinutes: 3,
      oldest: { turnRequestId: permit.turnRequestId, actor: actorId },
    });
  });

  it("escalates once the turn is older than the threshold", async () => {
    // Age never clears the hold, so escalation is the only thing age is allowed to do.
    const h = makeHarness();
    claim(h, target(h, "ceo"), "n1");
    h.clock.advance(20 * 60_000);

    expect(finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_IN_DOUBT")?.severity).toBe("ERROR");
  });

  it("stops reporting once an authority settles it", async () => {
    const h = makeHarness();
    const coordinator = coordinatorOf(h);
    const permit = claim(h, target(h, "ceo"), "n1");
    coordinator.observe(permit, {
      outcome: "COMPLETED",
      authority: "HERMES_TARGET",
      receiptId: "r1",
      evidenceDigest: "sha256:receipt",
      reasonCode: ReasonCode.OK,
    });

    expect(finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_IN_DOUBT")).toBeUndefined();
  });

  it("does not merge its count with the ingress claim's", async () => {
    // The two checks watch different representations of a turn. Summing them would let a healthy
    // count in one hide a wedge in the other, which is the exact state this check exists for.
    const h = makeHarness();
    claim(h, target(h, "ceo"), "n1");
    h.cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, result_json)
       VALUES ('telegram', 'ingress-only', 'owner', ?, ?)`,
      [NOW, JSON.stringify({ deliveryStatus: "TURN_CLAIMED", turnRequestId: "ingress-only" })],
    );

    const report = await h.cp.doctor.run("system");

    expect(finding(report, "CANONICAL_TURN_IN_DOUBT")?.observedEvidence["outstanding"]).toBe(1);
    expect(finding(report, "TURN_OUTCOME_UNKNOWN")?.observedEvidence["outstanding"]).toBe(1);
  });
});

describe("doctor surfaces a disagreement between authorities", () => {
  const contradict = (h: Harness, actorId: string): TurnPermit => {
    const coordinator = coordinatorOf(h);
    const permit = claim(h, actorId, "n1");
    coordinator.observe(permit, {
      outcome: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      receiptId: "pre-1",
      evidenceDigest: "sha256:pre",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    coordinator.observe(permit, {
      outcome: "COMPLETED",
      authority: "HERMES_TARGET",
      receiptId: "target-1",
      evidenceDigest: "sha256:target",
      reasonCode: ReasonCode.OK,
    });
    return permit;
  };

  it("reports a contradicted turn and blocks on it", async () => {
    // The actor takes no new turns until someone adjudicates, so this is not advisory.
    const h = makeHarness();
    const permit = contradict(h, target(h, "ceo"));

    const found = finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_CONTRADICTED");

    expect(found?.severity).toBe("ERROR");
    expect(found?.blocking).toBe(true);
    expect(found?.observedEvidence).toMatchObject({ turnRequestId: permit.turnRequestId });
  });

  it("names the conflicting observations, so the adjudication has something to cite", async () => {
    // "These two disagree" without saying which two sends an operator to read the whole table.
    const h = makeHarness();
    contradict(h, target(h, "ceo"));

    const found = finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_CONTRADICTED");
    const conflicting = found?.observedEvidence["conflicting"] as readonly string[];

    expect(conflicting).toHaveLength(2);
    expect(conflicting.some((one) => one.includes("ACP_PRE_DISPATCH:NEVER_ADMITTED"))).toBe(true);
    expect(conflicting.some((one) => one.includes("HERMES_TARGET:COMPLETED"))).toBe(true);
  });

  it("says nothing when two authorities agree", async () => {
    // Corroboration is not conflict. Two observations of the same outcome are the ordinary case
    // once a target receipt confirms what ACP already saw.
    const h = makeHarness();
    const coordinator = coordinatorOf(h);
    const permit = claim(h, target(h, "ceo"), "n1");
    coordinator.observe(permit, {
      outcome: "COMPLETED",
      authority: "ACP_OBSERVED_HERMES_REPLY",
      receiptId: "acp-1",
      evidenceDigest: "sha256:acp",
      reasonCode: ReasonCode.OK,
    });
    coordinator.observe(permit, {
      outcome: "COMPLETED",
      authority: "HERMES_TARGET",
      receiptId: "target-1",
      evidenceDigest: "sha256:target",
      reasonCode: ReasonCode.OK,
    });

    expect(finding(await h.cp.doctor.run("system"), "CANONICAL_TURN_CONTRADICTED")).toBeUndefined();
  });
});
