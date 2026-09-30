import { afterAll, describe, expect, it } from "vitest";

import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  IngressGuard,
  type OwnerBatchCanonicalClaim,
  type TurnIdentity,
} from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import { TelegramHermesRouter } from "../../src/ingress/telegram-router.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * #858, the router's half of the missing writer.
 *
 * `canonical_turns` has exactly one writer — `ConversationTurnCoordinator.claim()` — and no
 * production caller, so the canonical ledger stayed empty while `inbound_messages.turn_claim_json`
 * held the real turn. Four adjudication surfaces and a 60s reconcile sweep therefore passed over
 * an empty row set: not two ledgers with different counts, two ledgers holding different turns.
 *
 * The bridge is a narrow port rather than the coordinator itself, because the router is sealed
 * away from the ControlPlane by design. This measures the router end: after it claims a DIRECT
 * message, it hands that exact nonce and prompt over. The coordinator end is a closure assembled
 * in `telegram-polling`, where `cp` is in scope.
 *
 * Why the port and not `canonical_turns` directly: the coordinator refuses a turn whose actor has
 * no verified target, and this fixture binds no Hermes CEO. Asserting on the row would measure the
 * fixture's binding rather than the router's behaviour — and would have passed for a router that
 * never called anything, since the row is absent either way.
 */
const SECRET = "telegram-secret";
const NOW = "2026-09-20T00:00:00.000Z";

const canonicalTarget = (harness: ReturnType<typeof makeHarness>, name: string) => {
  const targetActorId = `actor:${name}`;
  const targetBindingId = `bind:${name}`;
  const targetAttestationId = `att:${name}`;
  const executorSessionId = `runtime:${name}`;
  const assignmentId = `asg:${name}`;
  harness.cp.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc', 'claude', 'opus', 'READY', ?, ?)`,
    [executorSessionId, NOW, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc', ?)`,
    [targetActorId, executorSessionId, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [targetBindingId, targetActorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [assignmentId, `CEO:${name}`, targetActorId, executorSessionId, NOW],
  );
  harness.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc', 1, ?, ?)`,
    [targetAttestationId, targetBindingId, `attd:${name}`, executorSessionId, assignmentId, NOW],
  );
  return (identity: TurnIdentity) => ({
    turnRequestId: identity.turnRequestId,
    targetActorId,
    promptDigest: identity.promptDigest,
    bindingGeneration: 1,
    targetBindingId,
    targetAttestationId,
    executorSessionId,
    executorSessionIncarnation: "inc",
  });
};

afterAll(() => {
  cleanupTempDirs();
});

const buildRouter = (
  harness: ReturnType<typeof makeHarness>,
  materializeTurn?: (input: OwnerBatchCanonicalClaim & { prompt: string }) => Decision<void>,
  directHandler?: (input: { text: string }) => string,
  canonicalTargetForClaim?: (identity: TurnIdentity) => ReturnType<ReturnType<typeof canonicalTarget>>,
) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: { allowedActors: ["424242"], allowedConversations: ["999"], recoverInFlight: true },
  }, canonicalTargetForClaim ? { canonicalTargetForClaim } : {});
  const ingress = new TelegramIngress(guard, { webhookSecret: SECRET });
  const router = new TelegramHermesRouter({
    ingress,
    hermes: createHermesMcpPort(harness.cp),
    currentCandidateSnapshotDigest: () => null,
    bindingGeneration: () => null,
    ...(materializeTurn ? { materializeTurn } : {}),
    ...(directHandler ? { directHandler } : {}),
  });
  return { guard, ingress, router };
};

const update = (updateId: number, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_700_000_000,
    text,
    from: { id: 424242, username: "owner" },
    chat: { id: 999 },
  },
});

describe("#858 the router hands a claimed turn to the canonical ledger", () => {
  it("hands over the nonce and prompt it just claimed", async () => {
    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "handoff");
    const handed: Array<{ channel: string; nonce: string; prompt: string }> = [];
    const { ingress, router } = buildRouter(harness, ({ sources, prompt }) => {
      const source = sources[0]!;
      handed.push({ channel: source.channel, nonce: source.nonce, prompt });
      return allow(ReasonCode.OK, undefined);
    }, undefined, targetForClaim);

    const inbound = update(8581, "이 문장은 canonical 원장의 증인이다.");
    await router.route(inbound, SECRET);

    expect(handed, "the router claimed a DIRECT turn and told the canonical ledger nothing").toHaveLength(1);
    expect(handed[0]?.channel).toBe("telegram");
    expect(handed[0]?.prompt).toBe("이 문장은 canonical 원장의 증인이다.");
    // The nonce has to be the one the ingress claimed, not a fresh one: a bridge that invents an
    // identifier writes a canonical turn nobody can match back to the message it answered.
    expect(handed[0]?.nonce, "the handed nonce is not the one the ingress claimed").toBe(
      ingress.nonceFor(inbound),
    );
  });

  it("rolls back the owner batch and never dispatches when the verified target has an unresolved canonical turn", async () => {
    const baselineHarness = makeHarness();
    let baselineExecutions = 0;
    const baseline = buildRouter(
      baselineHarness,
      undefined,
      () => {
        baselineExecutions += 1;
        return "owner handled";
      },
    );
    const baselineParked = update(8582, "first");
    expect(baseline.ingress.admit(baselineParked, SECRET).allowed).toBe(true);
    baseline.guard.parkForBatch(
      baseline.ingress.nonceFor(baselineParked),
      baseline.ingress.turnIdentityFor(baselineParked, "first", null, null).sessionDigest,
    );

    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "refusing");
    let executions = 0;
    const handedSources: OwnerBatchCanonicalClaim["sources"][] = [];
    const refusing = buildRouter(
      harness,
      ({ target, sources, prompt }) => {
        handedSources.push(sources);
        const claimed = harness.cp.conversation.claim({ targetActorId: target.targetActorId, prompt, sources });
        return claimed.allowed
          ? allow(ReasonCode.OK, undefined)
          : deny(claimed.reasonCode, claimed.message, claimed.evidence);
      },
      () => {
        executions += 1;
        return "owner handled";
      },
      targetForClaim,
    );
    const incumbent = update(8581, "incumbent");
    expect(refusing.ingress.admit(incumbent, SECRET).allowed).toBe(true);
    const incumbentPayload = JSON.parse(harness.cp.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8581'`,
    )!.payload_json) as unknown;
    const first = harness.cp.conversation.claim({
      targetActorId: targetForClaim(refusing.ingress.turnIdentityFor(incumbent, "incumbent", null, null)).targetActorId,
      prompt: "incumbent",
      sources: [{ channel: "telegram", nonce: "update:8581", attempt: 1, payload: incumbentPayload }],
    });
    expect(first.allowed).toBe(true);
    const refusingParked = update(8582, "first");
    expect(refusing.ingress.admit(refusingParked, SECRET).allowed).toBe(true);
    refusing.guard.parkForBatch(
      refusing.ingress.nonceFor(refusingParked),
      refusing.ingress.turnIdentityFor(refusingParked, "first", null, null).sessionDigest,
    );
    const parkedBefore = harness.cp.db.get<{ result_json: string }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8582'`,
    )!.result_json;

    const baselineOutcome = await baseline.router.route(update(8583, "second"), SECRET);
    const refusedOutcome = await refusing.router.route(update(8583, "second"), SECRET);

    expect(handedSources).toHaveLength(1);
    expect(handedSources[0]?.map(({ nonce, payload }) => ({ nonce, payload }))).toEqual([
      { nonce: "update:8582", payload: expect.objectContaining({ text: "first", messageId: 8582 }) },
      { nonce: "update:8583", payload: expect.objectContaining({ text: "second", messageId: 8583 }) },
    ]);
    expect(baselineExecutions).toBe(1);
    expect(baselineOutcome.reasonCode).toBe(ReasonCode.OK);
    expect(executions).toBe(0);
    expect(refusedOutcome.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_IN_DOUBT);
    expect(harness.cp.db.all<{ nonce: string }>(
      `SELECT nonce FROM inbound_messages WHERE turn_claim_json IS NOT NULL`,
    )).toEqual([]);
    expect(harness.cp.db.get<{ turn_claim_json: string | null; result_json: string }>(
      `SELECT turn_claim_json, result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8582'`,
    )).toEqual({ turn_claim_json: null, result_json: parkedBefore });
    expect(harness.cp.db.get<{ turn_claim_json: string | null }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8583'`,
    )?.turn_claim_json).toBeNull();
    expect(harness.cp.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM canonical_turns`,
    )?.count).toBe(1);
  });

  it("claims a second auditable canonical turn for a verified-target /again without replaying the incumbent", async () => {
    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "again");
    let executions = 0;
    const { guard, ingress, router } = buildRouter(
      harness,
      ({ target, prompt, sources, overriddenUnresolvedNonces }) => {
        const incumbent = overriddenUnresolvedNonces?.length
          ? harness.cp.db.get<{ turn_request_id: string }>(
            `SELECT turn_request_id FROM canonical_turn_sources
             WHERE source_channel = 'telegram' AND source_nonce = ?`,
            [overriddenUnresolvedNonces[0]],
          )?.turn_request_id
          : undefined;
        const claimed = harness.cp.conversation.claim({
          targetActorId: target.targetActorId, prompt, sources,
          ...(incumbent ? { overrideIncumbentTurnRequestId: incumbent } : {}),
        });
        return claimed.allowed
          ? allow(ReasonCode.OK, undefined)
          : deny(claimed.reasonCode, claimed.message, claimed.evidence);
      },
      () => {
        executions += 1;
        return "owner handled";
      },
      targetForClaim,
    );
    const incumbent = update(8585, "first");
    expect(ingress.admit(incumbent, SECRET).allowed).toBe(true);
    const identity = ingress.turnIdentityFor(incumbent, "first", null, null);
    const sourcePayload = JSON.parse(harness.cp.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8585'`,
    )!.payload_json) as unknown;
    const first = harness.cp.conversation.claim({
      targetActorId: targetForClaim(identity).targetActorId,
      prompt: "first",
      sources: [{ channel: "telegram", nonce: "update:8585", attempt: 1, payload: sourcePayload }],
    });
    if (!first.allowed) throw new Error(`incumbent canonical claim failed: ${first.reasonCode}`);
    expect(guard.claimTurn("telegram", "update:8585", identity).allowed).toBe(true);

    const second = await router.route(update(8586, "/again second"), SECRET);
    expect(second.reasonCode).toBe(ReasonCode.OK);
    expect(executions).toBe(1);
    const turns = harness.cp.db.all<{ turn_request_id: string; lifecycle_state: string; claim_audit_event_id: number }>(
      `SELECT turn_request_id, lifecycle_state, claim_audit_event_id FROM canonical_turns ORDER BY rowid`,
    );
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.lifecycle_state)).toEqual(["IN_DOUBT", "IN_DOUBT"]);
    expect(turns[0]!.turn_request_id).toBe(first.value.turnRequestId);
    expect(turns[1]!.turn_request_id).not.toBe(turns[0]!.turn_request_id);
    const sources = harness.cp.db.all<{ turn_request_id: string; source_nonce: string }>(
      `SELECT turn_request_id, source_nonce FROM canonical_turn_sources ORDER BY rowid`,
    );
    expect(sources).toEqual([
      { turn_request_id: turns[0]!.turn_request_id, source_nonce: "update:8585" },
      { turn_request_id: turns[1]!.turn_request_id, source_nonce: "update:8586" },
    ]);
    const claim = JSON.parse(harness.cp.db.get<{ turn_claim_json: string }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8586'`,
    )!.turn_claim_json) as { overriddenUnresolvedNonces?: string[]; canonicalTarget?: { targetActorId: string } };
    expect(claim.overriddenUnresolvedNonces).toEqual(["update:8585"]);
    expect(claim.canonicalTarget?.targetActorId).toBe(targetForClaim(identity).targetActorId);
    const audit = harness.cp.db.get<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE event_id = ?`,
      [turns[1]!.claim_audit_event_id],
    );
    expect(JSON.parse(audit!.evidence_json)).toEqual(expect.objectContaining({
      turnRequestId: turns[1]!.turn_request_id,
      overrideIncumbentTurnRequestId: turns[0]!.turn_request_id,
      ingressOverride: expect.objectContaining({
        channel: "telegram",
        nonce: "update:8586",
        overriddenUnresolvedNonces: ["update:8585"],
      }),
    }));
  });

  it("publishes every consumed nonce to the canonical ledger in arrival order", async () => {
    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, "owner-batch");
    const { guard, ingress, router } = buildRouter(
      harness,
      ({ target, prompt, sources }) => {
        const claimed = harness.cp.conversation.claim({
          targetActorId: target.targetActorId,
          prompt,
          sources,
        });
        return claimed.allowed
          ? allow(ReasonCode.OK, undefined)
          : deny(claimed.reasonCode, claimed.message, claimed.evidence);
      },
      undefined,
      targetForClaim,
    );
    const parked = update(8583, "first");
    expect(ingress.admit(parked, SECRET).allowed).toBe(true);
    const scope = ingress.turnIdentityFor(parked, "first", null, null).sessionDigest;
    guard.parkForBatch(ingress.nonceFor(parked), scope);

    await router.route(update(8584, "second"), SECRET);

    const ingressClaim = JSON.parse(harness.cp.db.get<{ turn_claim_json: string }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:8584'`,
    )!.turn_claim_json) as { batchConsumedNonces: string[] };
    const canonicalSources = harness.cp.db.all<{ source_nonce: string; batch_ordinal: number }>(
      `SELECT source_nonce, batch_ordinal FROM canonical_turn_sources ORDER BY batch_ordinal`,
    );
    expect(canonicalSources.map((source) => source.source_nonce)).toEqual(ingressClaim.batchConsumedNonces);
    expect(canonicalSources.map((source) => source.batch_ordinal)).toEqual([0, 1]);
  });

  it.each(["omitted", "reordered"] as const)("refuses an %s durable override batch", async (shape) => {
    const harness = makeHarness();
    const targetForClaim = canonicalTarget(harness, `batch-${shape}`);
    let captured: (OwnerBatchCanonicalClaim & { prompt: string }) | undefined;
    const { guard, ingress, router } = buildRouter(harness, (input) => {
      captured = input;
      return allow(ReasonCode.OK, undefined);
    }, undefined, targetForClaim);
    const incumbent = update(8590, "first");
    expect(ingress.admit(incumbent, SECRET).allowed).toBe(true);
    const identity = ingress.turnIdentityFor(incumbent, "first", null, null);
    expect(guard.claimTurn("telegram", "update:8590", identity).allowed).toBe(true);
    const first = harness.cp.conversation.claim({
      targetActorId: targetForClaim(identity).targetActorId, prompt: "first",
      sources: [{ channel: "telegram", nonce: "update:8590", attempt: 1,
        payload: ingress.admittedPayloadFor(incumbent) }],
    });
    if (!first.allowed) throw new Error(`incumbent refused: ${first.reasonCode}`);
    const parked = update(8591, "/again parked");
    expect(ingress.admit(parked, SECRET).allowed).toBe(true);
    guard.parkForBatch(ingress.nonceFor(parked), ingress.turnIdentityFor(parked, "parked", null, null).sessionDigest);
    await router.route(update(8592, "/again current"), SECRET);
    if (!captured) throw new Error("the real router did not claim its batch");
    expect(captured.sources.map((item) => item.nonce)).toEqual(["update:8591", "update:8592"]);
    const sources = shape === "omitted" ? [captured.sources[1]!] : [...captured.sources].reverse();
    const request = { targetActorId: captured.target.targetActorId, prompt: captured.prompt,
      overrideIncumbentTurnRequestId: first.value.turnRequestId };
    const forged = harness.cp.conversation.claim({ ...request, sources });
    expect(forged.allowed).toBe(false);
    expect(forged.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_IN_DOUBT);
    expect(harness.cp.db.all(`SELECT turn_request_id FROM canonical_turns`)).toHaveLength(1);
    expect(harness.cp.conversation.claim({ ...request, sources: captured.sources }).allowed).toBe(true);
  });
});
