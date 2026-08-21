import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, acpError, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";

/**
 * One inbound message a turn is being asked to answer.
 *
 * Several arrive together when consecutive owner messages coalesce: three messages are one turn,
 * with their ids and their order kept, because the answer has to be able to say what it consumed.
 */
export interface TurnSource {
  channel: string;
  nonce: string;
  /** Which attempt at *this* message. The first is 1; a later one needs its predecessor to have
   *  settled safely, which is checked here rather than in a constraint SQLite cannot express. */
  attempt: number;
  payload: unknown;
}

/**
 * The right to run one turn against one conversation.
 *
 * Opaque on purpose. It is not a description of the turn — it is proof that the claim and the
 * hold were taken together, and the only thing that can be exchanged for permission to speak to
 * the CEO. A caller holding one cannot have skipped the transaction that issued it.
 */
export interface TurnPermit {
  readonly turnRequestId: string;
  readonly targetActorId: string;
  readonly promptDigest: string;
  /**
   * Proof that this coordinator issued the permit, over the three fields above.
   *
   * A TypeScript interface is structural: any caller can write an object of this shape, and
   * `settle()` used to trust whatever `turnRequestId` it found there. So the opacity is enforced
   * at runtime instead of by the type — the key never leaves the coordinator, and a hand-built
   * permit cannot carry a signature that verifies.
   *
   * The key is per instance and not persisted, so a permit does not survive the process that
   * issued it. That is the right lifetime rather than a limitation: a permit is the right to
   * report what *this* execution observed, and a process that died observed nothing. Settling a
   * turn after a restart is the reconciler's job, from a receipt, not a resurrected permit.
   */
  readonly issuance: string;
}

/**
 * What an authority reported about a turn.
 *
 * Reported, not decided. Several of these can exist for one turn and two of them may disagree;
 * the turn's outcome is computed from the set rather than written by whichever arrived first.
 */
export interface TurnObservation {
  readonly outcome: "COMPLETED" | "NEVER_ADMITTED" | "ABORTED";
  readonly authority:
    | "ACP_PRE_DISPATCH"
    | "HERMES_TARGET"
    | "OWNER_AFTER_TARGET_FENCE"
    | "ACP_OBSERVED_HERMES_REPLY";
  /**
   * Identity of the receipt this observation carries, scoped to its authority.
   *
   * Makes redelivery a no-op. Without it a retrying transport reports the same receipt twice and
   * manufactures a disagreement with itself, which quarantines a conversation for no reason.
   */
  readonly receiptId: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
}

/** What the ledger now holds about a turn, after an observation was recorded. */
export interface TurnMaterialization {
  readonly lifecycleState: "IN_DOUBT" | "SETTLED";
  readonly outcome: string | null;
  readonly authority: string | null;
  readonly consistency: "CONSISTENT" | "CONTRADICTED" | "ADJUDICATED";
}

/**
 * How retry-blocking each outcome is. Higher wins, and the winner is never lowered.
 *
 * `COMPLETED` forbids a re-run; the other two permit one. So lowering an outcome is exactly how a
 * completed exchange becomes runnable again — the measured defect this ordering exists to make
 * unreachable. A fence is a stronger statement than an intention, so `ABORTED` outranks
 * `NEVER_ADMITTED`.
 */
const OUTCOME_STRENGTH: Record<string, number> = {
  NEVER_ADMITTED: 1,
  ABORTED: 2,
  COMPLETED: 3,
};

/**
 * The authorities whose observations may set the turn's outcome.
 *
 * `ACP_OBSERVED_HERMES_REPLY` is deliberately absent. ACP watching a reply come back is real
 * evidence and is recorded as such, but it is not the target proving a durable commit — and the
 * cost of confusing them falls in the direction that loses the owner's message: a turn marked
 * `COMPLETED` on an answer Hermes never committed is never re-run, and the question disappears.
 *
 * This is the one line the whole authority argument reduces to, so it is here rather than spread
 * across the branches that consult it.
 */
const MATERIALIZING_AUTHORITIES = new Set([
  "ACP_PRE_DISPATCH",
  "HERMES_TARGET",
  "OWNER_AFTER_TARGET_FENCE",
]);

/** How a turn ended, when something positively established it. */
export type TurnOutcome =
  | {
      /** Typed pre-dispatch evidence that execution never started (#651). */
      readonly kind: "NEVER_ADMITTED";
      readonly authority: "ACP_PRE_DISPATCH";
      readonly reasonCode: string;
    }
  | {
      /**
       * The turn ended and must never run again.
       *
       * Two authorities can say so, and they are not the same claim. `HERMES_TARGET` is the
       * target's own durable receipt, which nothing can mint yet (#638). `ACP_OBSERVED_HERMES_REPLY`
       * is what ACP can honestly say about a success it watched: the peer was re-authenticated
       * before dispatch, `createMessage` returned a correlated reply, and the runtime resolved
       * only after the reply child exited zero.
       *
       * The second is strong enough to forbid a re-run and not strong enough to be called the
       * first. Stretching one name over both is the laundering this file keeps having to remove.
       */
      readonly kind: "COMPLETED";
      readonly authority: "HERMES_TARGET" | "ACP_OBSERVED_HERMES_REPLY";
      readonly reasonCode: string;
      readonly evidenceDigest: string;
    }
  | {
      /** The target proved a stale execution can no longer write. Also #638's to produce. */
      readonly kind: "ABORTED";
      readonly authority: "HERMES_TARGET" | "OWNER_AFTER_TARGET_FENCE";
      readonly reasonCode: string;
      readonly evidenceDigest: string;
    };

/**
 * Takes the right to run a turn, and records how it ended.
 *
 * **Nothing here ever clears a hold on a timeout, a rejection, an age or a restart.** That is the
 * design's central rule and the reason this is not a lease: a turn is created already unresolved,
 * and only a positively observed outcome moves it. A crash therefore has nothing to undo — the
 * absence of a settlement *is* the record, rather than something a cleanup path has to write.
 *
 * The claim and the hold are one transaction. Taken separately, a crash between them leaves a
 * message that was accepted with no hold protecting the conversation, or a hold naming a message
 * nobody admitted — two states that cannot be told apart afterwards.
 *
 * It cannot admit anything today, and that is deliberate rather than unfinished: a turn requires
 * a target binding and an attestation, and only an authenticated preflight bind produces those
 * (#638). The activation embargo is therefore a property of the schema this reads, not a rule
 * somebody follows.
 */
export class ConversationTurnCoordinator {
  /** Never persisted, never exported. See `TurnPermit.issuance`. */
  readonly #issuanceKey = randomUUID();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  #sign(fields: Omit<TurnPermit, "issuance">): string {
    return createHmac("sha256", this.#issuanceKey)
      .update(digestOf([fields.turnRequestId, fields.targetActorId, fields.promptDigest]))
      .digest("hex");
  }

  /**
   * Whether this coordinator issued this permit.
   *
   * Compared in constant time. The comparison is not a secret-recovery target in any realistic
   * sense here, but a plain `!==` on a MAC is the kind of detail that gets copied into somewhere
   * it does matter.
   */
  private assertIssuedHere(permit: TurnPermit): Decision<void> {
    const expected = Buffer.from(this.#sign(permit), "hex");
    const offered = Buffer.from(String(permit.issuance ?? ""), "hex");
    const genuine = expected.length === offered.length && timingSafeEqual(expected, offered);
    if (!genuine) {
      return deny(
        ReasonCode.CONVERSATION_TURN_PERMIT_UNISSUED,
        "this permit was not issued by this coordinator",
        { turnRequestId: permit.turnRequestId },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * Claims the right to run one turn for an actor, consuming one or more inbound messages.
   *
   * Refuses rather than queues. A queue here would hold the caller for the length of a turn,
   * which is the stall the design exists to remove; ordering belongs where the message is
   * durable, not in a caller's stack frame.
   */
  claim(input: {
    targetActorId: string;
    prompt: string;
    sources: readonly TurnSource[];
  }): Decision<TurnPermit> {
    if (input.sources.length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a turn has to answer at least one message", {
        targetActorId: input.targetActorId,
      });
    }

    return this.db.tx(() => {
      const target = this.db.get<{ target_binding_id: string }>(
        `SELECT target_binding_id FROM actor_target_bindings WHERE target_actor_id = ?`,
        [input.targetActorId],
      );
      if (!target) {
        // The embargo, arriving as an ordinary refusal. Nothing has established which
        // conversation this actor owns, so there is nothing to serialise against and no honest
        // way to say where an answer would go.
        return deny(
          ReasonCode.CONVERSATION_TARGET_UNVERIFIED,
          "this actor has no verified target, so a turn cannot be claimed for it",
          { targetActorId: input.targetActorId },
        );
      }

      const attestation = this.db.get<{
        target_attestation_id: string;
        executor_session_id: string;
        executor_session_incarnation: string;
        binding_generation: number;
      }>(
        `SELECT target_attestation_id, executor_session_id, executor_session_incarnation,
                binding_generation
           FROM actor_target_attestations
          WHERE target_binding_id = ?
          ORDER BY attested_at DESC, rowid DESC
          LIMIT 1`,
        [target.target_binding_id],
      );
      if (!attestation) {
        // A binding says which conversation; an attestation says a runtime verified it under a
        // named authority generation. Admitting on the first alone would trust a claim that has
        // not been checked since it was made.
        return deny(
          ReasonCode.CONVERSATION_TARGET_UNATTESTED,
          "this actor's target has never been attested by a runtime, so a turn cannot be claimed",
          { targetActorId: input.targetActorId, targetBindingId: target.target_binding_id },
        );
      }

      const chained = this.assertAttemptsMayRun(input.sources);
      if (!chained.allowed) return deny(chained.reasonCode, chained.message, chained.evidence);

      // A turn on this actor whose observations disagree. The disagreement is about whether a
      // past turn ran, so nothing new may be admitted until someone adjudicates it — running a
      // fresh turn against a conversation whose last outcome is disputed is how the dispute
      // becomes two disputes.
      //
      // Checked per actor rather than per turn, and separately from the unresolved hold: a
      // contradicted turn may already be settled, so the partial unique index does not see it.
      const contradicted = this.db.get<{ turn_request_id: string }>(
        `SELECT turn_request_id FROM canonical_turns
          WHERE target_actor_id = ? AND observation_consistency = 'CONTRADICTED'
          ORDER BY rowid ASC LIMIT 1`,
        [input.targetActorId],
      );
      if (contradicted) {
        return deny(
          ReasonCode.CONVERSATION_ACTOR_QUARANTINED,
          "an earlier turn on this conversation has observations that disagree, so no new turn may start",
          { targetActorId: input.targetActorId, contradicted: contradicted.turn_request_id },
        );
      }

      // Read the incumbent before writing anything, so a busy conversation is an ordinary
      // refusal rather than an exception. `db.tx` holds a write lock from BEGIN IMMEDIATE, so
      // nothing can slip a turn in between this read and the insert below; the partial unique
      // index stays as the backstop for a bug, and firing it is a fault rather than a state.
      const incumbent = this.db.get<{ turn_request_id: string }>(
        `SELECT turn_request_id FROM canonical_turns
          WHERE target_actor_id = ? AND lifecycle_state = 'IN_DOUBT'`,
        [input.targetActorId],
      );
      if (incumbent) {
        return deny(
          ReasonCode.CONVERSATION_TURN_IN_DOUBT,
          "this conversation already has a turn whose outcome is unknown",
          { targetActorId: input.targetActorId, incumbent: incumbent.turn_request_id },
        );
      }

      // Everything above this line is a read. Everything below is a write, and none of it may
      // report a refusal by returning — `Db.tx` commits a body that returns a denial, so a
      // `return deny()` after a write leaves the write behind (#664). Below, failure throws and
      // the transaction rolls back whole.
      const turnRequestId = `tr_${randomUUID().replace(/-/g, "")}`;
      const promptDigest = digestOf(input.prompt);

      // The audit row first, so the turn can cite its real identity. The shape this replaces
      // minted an `ev_<uuid>` string and stored that — a value satisfying a NOT NULL column while
      // identifying no row an operator could find.
      const audited = this.audit.record({
        kind: "CONVERSATION_TURN_CLAIMED",
        actor: input.targetActorId,
        evidence: {
          turnRequestId,
          sources: input.sources.map(
            (source) => `${source.channel}:${source.nonce}#${source.attempt}`,
          ),
        },
      });
      if (!audited.allowed) {
        throw acpError(audited.reasonCode, audited.message, audited.evidence);
      }
      const claimAuditEventId = audited.value;

      this.db.run(
        `INSERT INTO canonical_turns
           (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,
            executor_session_id, executor_session_incarnation, binding_generation,
            prompt_digest, claimed_at, claim_audit_event_id, lifecycle_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN_DOUBT')`,
        [
          turnRequestId,
          input.targetActorId,
          target.target_binding_id,
          attestation.target_attestation_id,
          attestation.executor_session_id,
          attestation.executor_session_incarnation,
          attestation.binding_generation,
          promptDigest,
          this.clock.nowIso(),
          claimAuditEventId,
        ],
      );

      input.sources.forEach((source, ordinal) => {
        this.db.run(
          `INSERT INTO canonical_turn_sources
             (turn_request_id, source_channel, source_nonce, source_attempt, batch_ordinal,
              source_digest, predecessor_turn_request_id, admission_audit_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            turnRequestId,
            source.channel,
            source.nonce,
            source.attempt,
            ordinal,
            digestOf(source.payload),
            source.attempt === 1 ? null : this.previousAttempt(source)?.turn_request_id ?? null,
            claimAuditEventId,
          ],
        );
      });

      const fields = { turnRequestId, targetActorId: input.targetActorId, promptDigest };
      return allow(ReasonCode.OK, { ...fields, issuance: this.#sign(fields) });
    });
  }

  /**
   * Records what an authority observed, and recomputes the turn's outcome from every such record.
   *
   * Not an update of the turn. The shape this replaces settled with an `UPDATE … WHERE
   * lifecycle_state = 'IN_DOUBT'`, which correctly refuses an overwrite and therefore **discards
   * the later, more authoritative record**: a mistaken pre-dispatch refusal arriving first kept
   * the false retry-safe answer and threw away the target's real receipt. That is worse than the
   * overwrite it prevents — an overwrite loses the first record, this lost the true one.
   *
   * So both are kept. The outcome is materialized from the observation set under a fixed
   * conservative order, and a disagreement raises the turn's consistency rather than picking a
   * winner.
   */
  observe(permit: TurnPermit, observation: TurnObservation): Decision<TurnMaterialization> {
    return this.db.tx(() => {
      const issued = this.assertIssuedHere(permit);
      if (!issued.allowed) return deny(issued.reasonCode, issued.message, issued.evidence);

      const row = this.db.get<{ target_actor_id: string; prompt_digest: string }>(
        `SELECT target_actor_id, prompt_digest FROM canonical_turns WHERE turn_request_id = ?`,
        [permit.turnRequestId],
      );
      if (!row) {
        // Unreachable since v24: a turn cannot be deleted, so a genuinely issued permit always
        // names a row. Recorded as unreachable rather than claimed as a guard — no test can kill
        // it, and a falsifiability row for it would report coverage that does not exist.
        return deny(ReasonCode.CONFLICT, "no turn was ever claimed under this id", {
          turnRequestId: permit.turnRequestId,
        });
      }
      if (row.target_actor_id !== permit.targetActorId || row.prompt_digest !== permit.promptDigest) {
        return deny(
          ReasonCode.CONVERSATION_TURN_PERMIT_MISMATCH,
          "this permit does not describe the turn it names",
          { turnRequestId: permit.turnRequestId },
        );
      }

      const already = this.db.get<{
        observed_outcome: string;
        evidence_digest: string;
        reason_code: string;
      }>(
        `SELECT observed_outcome, evidence_digest, reason_code FROM canonical_turn_observations
          WHERE turn_request_id = ? AND observing_authority = ? AND receipt_id = ?`,
        [permit.turnRequestId, observation.authority, observation.receiptId],
      );
      if (already) {
        const identical =
          already.observed_outcome === observation.outcome &&
          already.evidence_digest === observation.evidenceDigest &&
          already.reason_code === observation.reasonCode;
        if (!identical) {
          // A receipt id reused for different content is not a redelivery — it is two claims
          // wearing one identity, and accepting the second silently reported the first back as a
          // confirmation of it. Refused so the caller learns its receipt identity is wrong,
          // rather than believing evidence landed that did not.
          return deny(
            ReasonCode.CONVERSATION_TURN_RECEIPT_REUSED,
            "this receipt id already carries different evidence on this turn",
            {
              turnRequestId: permit.turnRequestId,
              authority: observation.authority,
              receiptId: observation.receiptId,
            },
          );
        }
        // The same receipt redelivered is a no-op, not a second opinion. Without this a retrying
        // transport manufactures a disagreement with itself and quarantines the conversation.
        return allow(ReasonCode.OK, this.materialization(permit.turnRequestId));
      }

      // Past this line every failure throws, because `Db.tx` commits a body that returns a
      // denial (#664) and an observation written without its audit row is testimony with no
      // provenance.
      const audited = this.audit.record({
        kind: "CONVERSATION_TURN_OBSERVED",
        actor: row.target_actor_id,
        evidence: {
          turnRequestId: permit.turnRequestId,
          outcome: observation.outcome,
          authority: observation.authority,
          receiptId: observation.receiptId,
        },
      });
      if (!audited.allowed) throw acpError(audited.reasonCode, audited.message, audited.evidence);

      this.db.run(
        `INSERT INTO canonical_turn_observations
           (turn_request_id, observed_outcome, observing_authority, receipt_id,
            evidence_digest, reason_code, observed_at, audit_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          permit.turnRequestId,
          observation.outcome,
          observation.authority,
          observation.receiptId,
          observation.evidenceDigest,
          observation.reasonCode,
          this.clock.nowIso(),
          audited.value,
        ],
      );

      return allow(ReasonCode.OK, this.materialize(permit.turnRequestId));
    });
  }

  /**
   * Recomputes a turn's outcome from every observation on it.
   *
   * The order is conservative and fixed: **an authenticated `COMPLETED` beats everything.** No
   * later adjudication, fence or owner decision can lower it, because lowering it is precisely
   * what re-opens a completed exchange for a second run. Below that, a fenced `ABORTED` beats a
   * pre-dispatch `NEVER_ADMITTED`, since a fence is a stronger statement than an intention.
   *
   * Only authorities the turn table accepts can *materialize* an outcome. `ACP_OBSERVED_HERMES_REPLY`
   * is recorded as an observation and does not raise the outcome — ACP watching a reply is not
   * the target proving a commit, and the difference is the whole reason the authority column
   * exists. When a target receipt arrives, it materializes and the earlier observation stands
   * beside it as what ACP saw at the time.
   */
  private materialize(turnRequestId: string): TurnMaterialization {
    const observations = this.db.all<{ observed_outcome: string; observing_authority: string;
      evidence_digest: string; reason_code: string }>(
      `SELECT observed_outcome, observing_authority, evidence_digest, reason_code
         FROM canonical_turn_observations WHERE turn_request_id = ? ORDER BY observation_id ASC`,
      [turnRequestId],
    );

    const materializing = observations.filter((o) => MATERIALIZING_AUTHORITIES.has(o.observing_authority));
    const strengthOf = (outcome: string): number => OUTCOME_STRENGTH[outcome] ?? 0;
    const strongest = [...materializing].sort(
      (a, b) => strengthOf(b.observed_outcome) - strengthOf(a.observed_outcome),
    )[0];

    // A disagreement about whether the turn ran at all, or about how it ended — across **every**
    // observation, not only the ones that can materialize.
    //
    // The version this replaces counted only materializing records, which made a
    // non-materializing COMPLETED invisible twice over: it could not raise the outcome, and it
    // could not dissent either. So an ACP-observed reply followed by a pre-dispatch
    // NEVER_ADMITTED settled the turn retry-safe and reported CONSISTENT, and the retry rule
    // admitted attempt 2 — a re-run of an exchange ACP had watched reach the owner. Measured.
    //
    // Two observations of the same outcome are corroboration, not conflict, whoever made them.
    const distinct = new Set(observations.map((o) => o.observed_outcome));
    const consistency = distinct.size > 1 ? "CONTRADICTED" : "CONSISTENT";

    const current = this.materialization(turnRequestId);

    if (strongest) {
      // `settled_at` records when this turn *settled*, so it is written once and then left alone.
      // The version this replaced rewrote it on every later observation, including ones that
      // changed no outcome, so a late weak record moved the terminal time of a turn it did not
      // decide. The provenance trigger now refuses that; keeping the first value here is what
      // makes the trigger's refusal something this code never has to hit.
      const settledAt = this.clock.nowIso();
      this.db.materializeTurn(
        {
          turnRequestId,
          outcome: strongest.observed_outcome,
          authority: strongest.observing_authority,
          consistency,
        },
        () =>
          this.db.run(
            `UPDATE canonical_turns
                SET lifecycle_state = 'SETTLED', outcome_kind = ?,
                    settled_at = COALESCE(settled_at, ?),
                    resolution_authority = ?, reason_code = ?, evidence_digest = ?,
                    observation_consistency = ?
              WHERE turn_request_id = ?`,
            [
              strongest.observed_outcome,
              settledAt,
              strongest.observing_authority,
              strongest.reason_code,
              strongest.evidence_digest,
              consistency,
              turnRequestId,
            ],
          ),
      );
    } else if (consistency !== current.consistency) {
      this.db.materializeTurn(
        { turnRequestId, outcome: current.outcome, authority: current.authority, consistency },
        () =>
          this.db.run(`UPDATE canonical_turns SET observation_consistency = ? WHERE turn_request_id = ?`, [
            consistency,
            turnRequestId,
          ]),
      );
    }

    return this.materialization(turnRequestId);
  }

  /** The turn's current outcome and consistency, as the ledger now holds them. */
  private materialization(turnRequestId: string): TurnMaterialization {
    const row = this.db.get<{ lifecycle_state: string; outcome_kind: string | null;
      resolution_authority: string | null; observation_consistency: string }>(
      `SELECT lifecycle_state, outcome_kind, resolution_authority, observation_consistency
         FROM canonical_turns WHERE turn_request_id = ?`,
      [turnRequestId],
    );
    return {
      lifecycleState: (row?.lifecycle_state ?? "IN_DOUBT") as TurnMaterialization["lifecycleState"],
      outcome: row?.outcome_kind ?? null,
      authority: row?.resolution_authority ?? null,
      consistency: (row?.observation_consistency ?? "CONSISTENT") as TurnMaterialization["consistency"],
    };
  }

  /**
   * Every turn on this conversation whose outcome nobody established, oldest first.
   *
   * The claim time is carried because it is the only thing separating a turn that is merely in
   * flight from a conversation that is wedged, and that distinction is what the doctor escalates
   * on. Ordering falls back to rowid within a shared timestamp so the sequence stays total under
   * a manual clock.
   */
  unresolved(targetActorId: string): readonly { turnRequestId: string; claimedAt: string }[] {
    return this.db
      .all<{ turn_request_id: string; claimed_at: string }>(
        `SELECT turn_request_id, claimed_at FROM canonical_turns
          WHERE target_actor_id = ? AND lifecycle_state = 'IN_DOUBT'
          ORDER BY claimed_at ASC, rowid ASC`,
        [targetActorId],
      )
      .map((row) => ({ turnRequestId: row.turn_request_id, claimedAt: row.claimed_at }));
  }

  private previousAttempt(source: TurnSource) {
    return this.db.get<{ turn_request_id: string; lifecycle_state: string; outcome_kind: string | null }>(
      `SELECT s.turn_request_id, t.lifecycle_state, t.outcome_kind
         FROM canonical_turn_sources s
         JOIN canonical_turns t ON t.turn_request_id = s.turn_request_id
        WHERE s.source_channel = ? AND s.source_nonce = ? AND s.source_attempt = ?`,
      [source.channel, source.nonce, source.attempt - 1],
    );
  }

  /**
   * Whether these messages may be run at all.
   *
   * "Not currently in another unresolved turn" is too weak on its own — it permits silently
   * re-running a message that already completed. What makes a retry legal is the *outcome* of the
   * previous attempt, and only two outcomes qualify: nothing ran, or the target proved the old
   * execution can no longer write. A completed one must never run again, and one still in doubt
   * must not be raced.
   *
   * SQLite cannot express that as a constraint, so it lives here — inside the same transaction as
   * the insert, because a check outside it is a read that a concurrent admission can invalidate.
   */
  private assertAttemptsMayRun(sources: readonly TurnSource[]): Decision<void> {
    for (const source of sources) {
      if (source.attempt < 1) {
        return deny(ReasonCode.INVALID_ARGUMENT, "an attempt is numbered from one", {
          channel: source.channel,
          nonce: source.nonce,
          attempt: source.attempt,
        });
      }
      if (source.attempt === 1) continue;

      const previous = this.previousAttempt(source);
      if (!previous) {
        // A gap in the chain. Without this an admission could number itself attempt 3 and skip
        // every check that the earlier attempts ended safely.
        return deny(
          ReasonCode.CONVERSATION_TURN_ATTEMPT_UNCHAINED,
          "this attempt's predecessor does not exist, so nothing says the earlier one ended",
          { channel: source.channel, nonce: source.nonce, attempt: source.attempt },
        );
      }
      // Read off the outcome alone, and deliberately not off the lifecycle state as well. The
      // schema pairs them — an IN_DOUBT row must have a NULL outcome and a SETTLED row must not —
      // so a state check here refuses nothing the outcome check does not already refuse. Adding
      // it back would answer "is this checked twice?" with a yes it has not earned.
      //
      // Note the shape it must *not* collapse to: `!== "COMPLETED"` reads as the same rule and
      // is not, because it admits the NULL of a turn still in doubt.
      // The materialized outcome is not the whole record, and reading it alone is how a
      // completed exchange became re-runnable: a COMPLETED observation from an authority that
      // cannot materialize left the turn's outcome saying something weaker. So the retry rule
      // asks the observation set directly — was this ever reported completed, by anyone, and is
      // the disagreement still open.
      // Three conditions guarding one property from three sides, which is deliberate and has a
      // cost worth naming: a COMPLETED previous turn is refused by the outcome test *and* by this
      // count, so neither of those two is killable by a test of that case alone. The count is
      // what carries the falsifiability row, because it is the side that catches a completion the
      // materialized outcome does not show — an observation from an authority that cannot set the
      // outcome. The outcome test has no row of its own for the same reason the audit actor does
      // not: a row for a check nothing can kill reports coverage that does not exist.
      const anyCompletion = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM canonical_turn_observations
          WHERE turn_request_id = ? AND observed_outcome = 'COMPLETED'`,
        [previous.turn_request_id],
      );
      const unresolved = this.db.get<{ observation_consistency: string }>(
        `SELECT observation_consistency FROM canonical_turns WHERE turn_request_id = ?`,
        [previous.turn_request_id],
      );
      const settledSafely =
        (previous.outcome_kind === "NEVER_ADMITTED" || previous.outcome_kind === "ABORTED") &&
        (anyCompletion?.n ?? 0) === 0 &&
        unresolved?.observation_consistency !== "CONTRADICTED";
      if (!settledSafely) {
        return deny(
          ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE,
          previous.outcome_kind === "COMPLETED" || (anyCompletion?.n ?? 0) > 0
            ? "the previous attempt at this message was reported completed; running it again would repeat it"
            : unresolved?.observation_consistency === "CONTRADICTED"
              ? "the previous attempt's observations disagree, so whether it ran is still open"
              : "the previous attempt at this message has no known outcome, so it may still be running",
          {
            channel: source.channel,
            nonce: source.nonce,
            attempt: source.attempt,
            previousOutcome: previous.outcome_kind ?? previous.lifecycle_state,
          },
        );
      }
    }
    return allow(ReasonCode.OK, undefined);
  }
}
