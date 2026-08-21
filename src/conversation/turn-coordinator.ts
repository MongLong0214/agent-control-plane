import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
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

/** How a turn ended, when something positively established it. */
export type TurnOutcome =
  | {
      /** Typed pre-dispatch evidence that execution never started (#651). */
      readonly kind: "NEVER_ADMITTED";
      readonly authority: "ACP_PRE_DISPATCH";
      readonly reasonCode: string;
    }
  | {
      /** A terminal commit the target proved. Nothing here can mint this yet (#638). */
      readonly kind: "COMPLETED";
      readonly authority: "HERMES_TARGET";
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

      const turnRequestId = `tr_${randomUUID().replace(/-/g, "")}`;
      const promptDigest = digestOf(input.prompt);
      try {
        this.db.run(
          `INSERT INTO canonical_turns
             (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,
              executor_session_id, executor_session_incarnation, binding_generation,
              prompt_digest, claimed_at, lifecycle_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN_DOUBT')`,
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
          ],
        );
      } catch (error) {
        // The partial unique index fired: this actor already has an unresolved turn. Reported by
        // its own code rather than as a generic conflict, because the caller's next move differs
        // — a busy conversation is not a malformed request.
        return deny(
          ReasonCode.CONVERSATION_TURN_IN_DOUBT,
          "this conversation already has a turn whose outcome is unknown",
          {
            targetActorId: input.targetActorId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }

      input.sources.forEach((source, ordinal) => {
        this.db.run(
          `INSERT INTO canonical_turn_sources
             (turn_request_id, source_channel, source_nonce, source_attempt, batch_ordinal,
              source_digest, predecessor_turn_request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            turnRequestId,
            source.channel,
            source.nonce,
            source.attempt,
            ordinal,
            digestOf(source.payload),
            source.attempt === 1 ? null : this.previousAttempt(source)?.turn_request_id ?? null,
          ],
        );
      });

      this.audit.record({
        kind: "CONVERSATION_TURN_CLAIMED",
        actor: input.targetActorId,
        evidence: {
          turnRequestId,
          sources: input.sources.map((source) => `${source.channel}:${source.nonce}#${source.attempt}`),
        },
      });

      const fields = { turnRequestId, targetActorId: input.targetActorId, promptDigest };
      return allow(ReasonCode.OK, { ...fields, issuance: this.#sign(fields) });
    });
  }

  /**
   * Records how a turn ended, from something that observed it.
   *
   * There is no `settle` for "we stopped waiting". Every outcome this accepts names an authority
   * that saw something: pre-dispatch evidence that nothing ran, or the target's own word that it
   * committed or was fenced. A caller with none of those has nothing to record, which is the
   * state the design calls in-doubt.
   */
  settle(permit: TurnPermit, outcome: TurnOutcome): Decision<void> {
    return this.db.tx(() => {
      const issued = this.assertIssuedHere(permit);
      if (!issued.allowed) return deny(issued.reasonCode, issued.message, issued.evidence);

      const row = this.db.get<{ target_actor_id: string; prompt_digest: string }>(
        `SELECT target_actor_id, prompt_digest FROM canonical_turns WHERE turn_request_id = ?`,
        [permit.turnRequestId],
      );
      if (!row) {
        return deny(ReasonCode.CONFLICT, "no turn was ever claimed under this id", {
          turnRequestId: permit.turnRequestId,
        });
      }
      if (row.target_actor_id !== permit.targetActorId || row.prompt_digest !== permit.promptDigest) {
        // A permit whose signature is genuine but whose contents disagree with the row it names.
        // Reachable if a caller keeps a permit and mutates it before settling; the signature
        // covers the fields, so this is belt and braces, and it is the check that makes the
        // settlement provably about the turn the permit was issued for.
        return deny(
          ReasonCode.CONVERSATION_TURN_PERMIT_MISMATCH,
          "this permit does not describe the turn it names",
          { turnRequestId: permit.turnRequestId },
        );
      }

      const auditEventId = `ev_${randomUUID().replace(/-/g, "")}`;
      const evidenceDigest =
        outcome.kind === "NEVER_ADMITTED"
          ? digestOf({ authority: outcome.authority, reasonCode: outcome.reasonCode })
          : outcome.evidenceDigest;
      const updated = this.db.run(
        `UPDATE canonical_turns
            SET lifecycle_state = 'SETTLED', outcome_kind = ?, settled_at = ?,
                resolution_authority = ?, reason_code = ?, evidence_digest = ?, audit_event_id = ?
          WHERE turn_request_id = ? AND lifecycle_state = 'IN_DOUBT'`,
        [
          outcome.kind,
          this.clock.nowIso(),
          outcome.authority,
          outcome.reasonCode,
          evidenceDigest,
          auditEventId,
          permit.turnRequestId,
        ],
      );
      if (updated.changes !== 1) {
        // Conditional on IN_DOUBT, so a second settlement cannot overwrite the first. Which
        // authority settled a turn is the thing a later reader needs most, and a last-write-wins
        // update would quietly replace it.
        //
        // Unlike the unreachable conditional this design once carried in its claim path, this one
        // is reachable without any interleaving: two ordinary sequential calls on the same permit
        // reach it, which is the case that actually happens — a pre-dispatch refusal recorded,
        // and then a late receipt arriving for the same turn.
        return deny(
          ReasonCode.CONFLICT,
          "this turn is not in doubt; it was settled already or never claimed",
          { turnRequestId: permit.turnRequestId },
        );
      }
      this.audit.record({
        kind: "CONVERSATION_TURN_SETTLED",
        // The row's actor, not the permit's.
        //
        // Not independently falsifiable, and listed as such rather than as a guard: the issuance
        // signature covers the actor, so anything reaching this line already agrees with the row,
        // and swapping this expression for `permit.targetActorId` kills no test. It stays because
        // the row is the authoritative source and reading it costs nothing — but a falsifiability
        // row for it would report coverage that does not exist. The check that actually stops a
        // re-pointed permit is the signature, and that one has a test which dies without it.
        actor: row.target_actor_id,
        evidence: {
          turnRequestId: permit.turnRequestId,
          outcome: outcome.kind,
          authority: outcome.authority,
          auditEventId,
        },
      });
      return allow(ReasonCode.OK, undefined);
    });
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
      const settledSafely =
        previous.outcome_kind === "NEVER_ADMITTED" || previous.outcome_kind === "ABORTED";
      if (!settledSafely) {
        return deny(
          ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE,
          previous.outcome_kind === "COMPLETED"
            ? "the previous attempt at this message completed; running it again would repeat it"
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
