import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, acpError, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db, TurnMaterializationAuthority } from "../db/database.ts";

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
/** What an authority carries when it reports an outcome: which receipt, and on what evidence. */
export interface TurnReceipt {
  readonly receiptId: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
}

/**
 * What a reconciler asks a target about one turn it is still holding.
 *
 * Every field `canonical_turns` pins for this turn, not only the four contract 1 names first
 * (`turnRequestId`, `targetActorId`, `promptDigest`, `bindingGeneration`). A review found the
 * ledger also fixes `targetBindingId`, `targetAttestationId`, `executorSessionId` and
 * `executorSessionIncarnation` at claim time, and none of the first four catch a receipt that
 * describes the wrong one of those: `BindingRegistry.switchTo` can move an actor's live runtime
 * to an entirely new session while a `SURVIVED` failover **keeps the same `bindingGeneration`**
 * ("the binding is not rewritten, which is why `binding_generation` cannot advance here" —
 * `binding-registry.ts`, the `conversation === "SURVIVED"` branch). So a turn claimed under
 * session S1 can have its actor's runtime move to S2 while the turn is still `IN_DOUBT`, and a
 * receipt attesting to S2's execution would pass every one of the original four checks — turn,
 * actor, prompt and generation all genuinely unchanged — while describing work a different
 * runtime did. `bindingGeneration` is the fence against a *later CEO*; it was never the fence
 * against a *later runtime under the same CEO*, and nothing else was checking that one.
 */
export interface ReceiptLookupQuery {
  readonly turnRequestId: string;
  readonly targetActorId: string;
  readonly promptDigest: string;
  readonly bindingGeneration: number;
  readonly targetBindingId: string;
  readonly targetAttestationId: string;
  readonly executorSessionId: string;
  readonly executorSessionIncarnation: string;
}

/**
 * What a target answers a reconciler. Absence and ambiguity are both "no receipt", never
 * evidence that one exists — the distinction contract 6 draws between a lookup that failed and
 * one that found nothing to say.
 */
export type ReceiptLookupResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly outcome: "COMPLETED" | "ABORTED";
      readonly receiptId: string;
      readonly evidenceDigest: string;
      readonly reasonCode: string;
      /**
       * The identity the receipt itself attests to — every field `ReceiptLookupQuery` names, not
       * an echo of the query.
       *
       * This is the untrusted half of contract 6: all eight fields, and a caller must compare
       * every one of them against the stored turn rather than assume they matched because they
       * were asked about. `turnRequestId` was added first — a port that confused two turns
       * sharing the same actor, prompt and generation could otherwise settle the wrong one.
       * `targetBindingId`, `targetAttestationId`, `executorSessionId` and
       * `executorSessionIncarnation` were added next, for the gap `bindingGeneration` alone
       * cannot close: a `SURVIVED` failover moves an actor's runtime to a new session while
       * keeping the same generation, so a receipt describing the *new* runtime's work would
       * satisfy every one of the first four fields while being evidence about an execution this
       * turn was never dispatched under. `reconcileUnresolved` checks all eight against the row
       * it settles, so a caller that rebuilds any of them from its own query instead of from this
       * answer makes that check compare the database against itself for that field.
       */
      readonly turnRequestId: string;
      readonly targetActorId: string;
      readonly promptDigest: string;
      readonly bindingGeneration: number;
      readonly targetBindingId: string;
      readonly targetAttestationId: string;
      readonly executorSessionId: string;
      readonly executorSessionIncarnation: string;
    };

/**
 * The seam #638 implements. Until it exists every real deployment wires a port that always
 * reports `found: false` — the unmatched-receipt state this whole design has run in since #635,
 * and the state contract 6 requires it keep running in rather than guess.
 *
 * `signal` is part of this seam on purpose, not added once a real implementation needed it. A
 * review found the sweep's own per-lookup timeout only abandoned a slow call — the promise kept
 * running, so a genuinely slow network request left duplicate, uncancelled work behind on every
 * timeout, compounding across overlapping sweeps. `#lookupWithTimeout` aborts this signal exactly
 * when it gives up waiting, so a real implementation backed by `fetch` or an RPC client with its
 * own abort support can actually stop the call rather than merely being ignored by the caller.
 * `NEVER_FOUND_RECEIPT_PORT` never needs to look at it, and that is fine — the contract is "you
 * may honor this," not "you must," because nothing here can force a network client to cooperate.
 * Adding the parameter after #638 already implemented this interface would have been the more
 * expensive version of this same change.
 */
export interface ReceiptPort {
  lookup(query: ReceiptLookupQuery, signal: AbortSignal): Promise<ReceiptLookupResult> | ReceiptLookupResult;
}

/**
 * The only real deployment shape before #638: every lookup answers `found: false`.
 *
 * The coordinator's default, so composing it without a real port yet is the same visible,
 * intentional choice everywhere — not an omission a reader has to notice by its absence.
 *
 * `Object.freeze`d because it is exported, shared, and stateless. A review found that an
 * un-frozen shared default is itself a forgery path one indirection removed from a swappable
 * field: even with `#receiptPort` made truly private, code importing this singleton could still
 * overwrite its `lookup` method in place, and every coordinator that was ever handed this exact
 * object — which is every one of them, since it is the default — would answer differently from
 * that point on. Freezing makes that assignment throw (this file, like every ES module, runs in
 * strict mode) instead of silently taking effect.
 */
export const NEVER_FOUND_RECEIPT_PORT: ReceiptPort = Object.freeze({
  lookup: (_query: ReceiptLookupQuery, _signal: AbortSignal): ReceiptLookupResult => ({ found: false }),
});

/**
 * How long `reconcileUnresolved()` waits for one `ReceiptPort.lookup()` before treating it as
 * `found: false` rather than evidence of anything.
 *
 * A review found the sweep awaited each lookup with no bound at all: a port that never settles —
 * not a misbehaving one, a slow network call is a legitimate implementation of the interface —
 * would hang the sweep on that one turn forever, and every candidate after it in the same pass
 * along with it. Ten seconds is comfortably longer than an ordinary receipt-store round trip (the
 * daemon's own network collectors budget 20–45s for a much heavier call, `usage-collectors.ts`'s
 * `COLLECTOR_TIMEOUT_MS`/`NON_INTERACTIVE_TIMEOUT_MS`) while staying well inside the periodic
 * sweep's own interval, so a handful of slow turns in one pass do not by themselves run into the
 * next. A port that is *routinely* this slow is a `runPeriodic` failure the daemon already
 * surfaces through its backoff and audit trail, not something a longer timeout should paper over.
 */
export const RECEIPT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * How long one whole `reconcileUnresolved()` pass may run before it stops issuing new lookups and
 * returns with whatever it swept.
 *
 * A per-lookup timeout bounds one turn; it does not bound the sweep. A review found seven slow
 * (not hung) turns in one pass — each honestly answering just under `RECEIPT_LOOKUP_TIMEOUT_MS` —
 * add up past the periodic interval, so the next sweep starts before the first returns. Nothing
 * in `runPeriodic` guards against that overlap (see `capacity-sweep-budget.test.ts`'s own
 * docstring: "`runPeriodic` has a failure backoff and no overlap guard"), and this codebase's
 * answer to that for the capacity sensor sweep is not an in-flight lock — it is a budget the
 * caller races the work against (`Daemon.refreshCapacitySensors`), sized to fit inside the
 * interval and asserted so at startup rather than invented per call site. This constant and the
 * assertion in `daemon.ts`'s `startTimers()` are the same shape applied here: a candidate not
 * reached before the budget runs out is left exactly where it was, `IN_DOUBT`, for the next sweep
 * to try — the same "absent is handled, not a special case" argument the capacity sweep already
 * makes for its own abandoned collectors.
 */
export const RECONCILE_SWEEP_BUDGET_MS = 45_000;

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
  // A person deciding a turn nobody observed. It belongs here for the same reason
  // `ACP_OBSERVED_HERMES_REPLY` does not: what matters is which direction an authority can move
  // the outcome, not how strong its evidence is. This one is restricted to `ABORTED` by the
  // schema, so the only thing it can do is release a hold in the retry-safe direction — and a
  // resolution that could not set the outcome would leave the turn exactly as wedged as before,
  // which is the state it exists to end.
  "OPERATOR_AFTER_REVIEW",
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
 *
 * **What this covers today, stated plainly rather than left to be inferred from the test suite.**
 * `src/app/control-plane.ts` constructs one instance, but nothing in `src/` outside this file
 * calls `claim()`, `dispatch()`, or any of the `ports.*` settlement entry points — `grep -rn
 * "\.claim(\|conversation\.ports"` outside `tests/` finds nothing. The production Telegram path
 * (`telegram-router.ts`) claims a turn through `IngressGuard.claimTurn()` and its own
 * `inbound_messages.turn_claim_json`, a different lifecycle entirely; it never reaches this
 * ledger. What *is* wired to production is the read/write half a daemon operator can already
 * reach — `contradictions()`, `unresolvedAcrossActors()`, `resolveInDoubt()`, `adjudicate()` — and
 * those operate correctly on whatever rows this class holds, but nothing in production creates
 * one. So this suite is a real, exercised contract with no production caller yet: every property
 * above is true of the code and false of the running system until something calls `claim()`.
 * Wiring a production entry point is a separate, larger change (tracked alongside #639's turn
 * reconciliation work) and is deliberately not attempted here.
 *
 * The currency check this file leans on hardest — the exact `assignments` row an attestation was
 * made under, that row's own generation, its own actor, and a live `READY` session whose own
 * `incarnation` column agrees with the actor's copy of it — answers the same way. Every layer of
 * it, including the two write-time triggers added alongside it, exists for an attestation nothing
 * writes yet (`#638`). Tested and correct is not the same claim as reachable, and this file does
 * not get to keep the first word only by going quiet about the second.
 */
export class ConversationTurnCoordinator {
  /** Never persisted, never exported. See `TurnPermit.issuance`. */
  readonly #issuanceKey = randomUUID();

  /**
   * The capability that lets this coordinator settle a turn.
   *
   * Claimed once per database. The trigger that guards the settlement columns asks the database
   * for a connection-local marker, and only this method can raise it — so "the outcome is
   * computed from the observations" is a property the database holds rather than a rule this
   * class remembers.
   */
  readonly #materialization: TurnMaterializationAuthority;

  /**
   * Where `reconcileUnresolved()` asks about a receipt. Bound once, in the constructor, and never
   * exposed again — a review of the first version of this field found that `private readonly`
   * is compile-time only: TypeScript erases it, and the ES2023 output was an ordinary writable,
   * enumerable own property. Anything holding this coordinator could overwrite it with a fake port
   * and call `reconcileUnresolved()` to forge a completion, the same attack the previous round's
   * fix closed one door earlier for.
   *
   * A `#`-private field is a different part of the language, not a stricter annotation of the same
   * one: there is no string or symbol key for it, so no assignment, `Object.defineProperty`,
   * `Reflect.set` or enumeration from outside this class body can reach it. `#materialization`
   * above already uses this for the same reason; this field failed to match it.
   */
  readonly #receiptPort: ReceiptPort;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    receiptPort: ReceiptPort = NEVER_FOUND_RECEIPT_PORT,
  ) {
    this.#materialization = db.claimTurnMaterializationAuthority();
    this.#receiptPort = receiptPort;
  }

  /**
   * Settlement entry points, one per authority, to be handed out individually by the wiring.
   *
   * Each method fixes both halves of the pair the schema already constrains — an authority and
   * the outcomes it is competent to report — so an unreachable combination cannot be expressed
   * rather than being rejected after the fact. The one asymmetry is deliberate:
   * `acpObservedReply` records a completion that will not materialize one, because ACP watching a
   * reply return is evidence and is not the target proving a durable commit.
   */
  readonly ports = {
    preDispatch: {
      neverAdmitted: (permit: TurnPermit, receipt: TurnReceipt): Decision<TurnMaterialization> =>
        this.#observe(permit, { ...receipt, outcome: "NEVER_ADMITTED", authority: "ACP_PRE_DISPATCH" }, "BEFORE"),
    },
    target: {
      completed: (permit: TurnPermit, receipt: TurnReceipt): Decision<TurnMaterialization> =>
        this.#observe(permit, { ...receipt, outcome: "COMPLETED", authority: "HERMES_TARGET" }, "AFTER"),
      aborted: (permit: TurnPermit, receipt: TurnReceipt): Decision<TurnMaterialization> =>
        this.#observe(permit, { ...receipt, outcome: "ABORTED", authority: "HERMES_TARGET" }, "AFTER"),
    },
    ownerFence: {
      aborted: (permit: TurnPermit, receipt: TurnReceipt): Decision<TurnMaterialization> =>
        this.#observe(permit, { ...receipt, outcome: "ABORTED", authority: "OWNER_AFTER_TARGET_FENCE" }, "AFTER"),
    },
    acpObservedReply: {
      sawCompletion: (permit: TurnPermit, receipt: TurnReceipt): Decision<TurnMaterialization> =>
        this.#observe(
          permit,
          { ...receipt, outcome: "COMPLETED", authority: "ACP_OBSERVED_HERMES_REPLY" },
          "AFTER",
        ),
    },
  } as const;

  /**
   * Records that this turn was dispatched, which is what makes an authority's claim checkable.
   *
   * Every port above says something about a phase — `ACP_PRE_DISPATCH` that nothing ran, the target
   * and owner-fence authorities that something did. Until this row existed both were reachable in
   * either phase, so "only a positively observed outcome moves a turn" was a statement about the
   * caller's discipline. It is a refusal with a row behind it now.
   *
   * The caller does not choose the order, because a review showed that choosing it wrongly is the
   * whole defect back again: send first, then mark, and an error path reports `NEVER_ADMITTED` on a
   * turn the target already has. So the send is passed *in* — the row is written and committed, and
   * only then does the message go out.
   *
   * A crash between the two leaves a dispatched turn with no outcome, which is `IN_DOUBT` and is
   * the correct reading: something may have run. The reverse crash cannot happen through this
   * method, which is the point of it holding the send.
   *
   * **The cost, named because it is a real one.** A send that fails *before* the target is reached
   * leaves the same state as one that fails after: the row is committed, so `NEVER_ADMITTED` is
   * refused and the turn stays held. Before this method existed such a failure could release the
   * conversation. Nothing here can tell a definite pre-send failure from an ambiguous one — the
   * send either completed or it did not, and "did the peer receive it" is not something a thrown
   * error answers — so the choice is which way to be wrong. A duplicate is unrecoverable and a
   * held turn is not: `agentctl conversation resolve` is the exit (#669), and it asks for a fence
   * exactly because the process making the pre-send failure may still be alive.
   *
   * Ruled out: letting `send` signal "not reached" so the row could be withheld. It puts the
   * ordering back in the caller's hands under a different name — a send that forgets to signal is
   * the send-before-mark bug again, and the signal is unverifiable in the one direction that
   * matters.
   *
   * One per turn. A second dispatch is the owner's message delivered twice, which is refused here
   * rather than counted — the primary key says so as well, for a caller that goes around this.
   *
   * Limit: a caller that never calls this and speaks to the target anyway is not stopped by
   * anything here. What that produces is a turn with no dispatch row, where a `NEVER_ADMITTED`
   * claim is admitted — the original defect, reachable only by declining the one API that reaches
   * the target. Nothing in this process can close that; a receipt the target signed (#638) can.
   */
  async dispatch<T>(permit: TurnPermit, send: () => Promise<T> | T): Promise<Decision<T>> {
    const marked = this.#markDispatching(permit);
    if (!marked.allowed) return deny(marked.reasonCode, marked.message, marked.evidence);
    // Outside the transaction on purpose. `db.tx` bodies must be synchronous, and more importantly
    // the row has to be *committed* before the message goes out: a transaction still open when the
    // target receives it is a dispatch that happened and a record that can still roll back.
    return allow(ReasonCode.OK, await send());
  }

  #markDispatching(permit: TurnPermit): Decision<void> {
    return this.db.tx(() => {
      const permitted = this.assertIssuedHere(permit);
      if (!permitted.allowed) {
        return deny(permitted.reasonCode, permitted.message, permitted.evidence);
      }

      const turn = this.db.get<{ target_actor_id: string; lifecycle_state: string }>(
        `SELECT target_actor_id, lifecycle_state FROM canonical_turns WHERE turn_request_id = ?`,
        [permit.turnRequestId],
      );
      if (turn?.target_actor_id !== permit.targetActorId) {
        return deny(ReasonCode.NOT_FOUND, "no such turn on this conversation", {
          turnRequestId: permit.turnRequestId,
        });
      }
      if (turn.lifecycle_state !== "IN_DOUBT") {
        return deny(ReasonCode.CONFLICT, "this turn is settled, so nothing is left to dispatch", {
          turnRequestId: permit.turnRequestId,
        });
      }
      if (this.dispatched(permit.turnRequestId)) {
        return deny(
          ReasonCode.CONVERSATION_TURN_ALREADY_DISPATCHED,
          "this turn was already dispatched; a second dispatch is the owner's message sent twice",
          { turnRequestId: permit.turnRequestId },
        );
      }

      // Past this line every failure throws, for the reason `#observe` states: `Db.tx` commits a
      // body that returns a denial (#664), and a dispatch row without its audit row is a phase
      // change with no provenance.
      const audited = this.audit.record({
        kind: "CONVERSATION_TURN_DISPATCHED",
        actor: turn.target_actor_id,
        evidence: { turnRequestId: permit.turnRequestId },
      });
      if (!audited.allowed) throw acpError(audited.reasonCode, audited.message, audited.evidence);

      return this.db.materializeTurn(this.#materialization, { turnRequestId: permit.turnRequestId }, () => {
        this.db.run(
          `INSERT INTO canonical_turn_dispatches (turn_request_id, dispatched_at, audit_event_id)
           VALUES (?, ?, ?)`,
          [permit.turnRequestId, this.clock.nowIso(), audited.value],
        );
        return allow(ReasonCode.OK, undefined);
      });
    });
  }

  /** Whether the ledger holds a dispatch for this turn. */
  private dispatched(turnRequestId: string): boolean {
    return (
      this.db.get<{ turn_request_id: string }>(
        `SELECT turn_request_id FROM canonical_turn_dispatches WHERE turn_request_id = ?`,
        [turnRequestId],
      ) !== undefined
    );
  }

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
   *
   * **Nothing in production calls this method.** The live Telegram path claims its turn through
   * `IngressGuard.claimTurn()`, which writes `inbound_messages.turn_claim_json` — a different
   * table this class never reads or writes. `canonical_turns`, the table this method and
   * `reconcileUnresolved()` both work against, has no production writer today: every row in it
   * this build will ever see comes from a test calling `claim()` directly. A review (#691) named
   * this precisely, and it is a correct description of the current system rather than a defect in
   * this one — wiring a production caller here is #683/#639's other half, deliberately not done in
   * this change. See `reconcileUnresolved`'s docstring, fact 1 of 2, for what that means for the
   * sweep — and fact 2, which is independent of this one and does not resolve when this does.
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

      // The most recent attestation *that is still current*, checked from the same admission
      // snapshot rather than trusted on its timestamp alone (#666): the actor must not have
      // retired, its live runtime pointer must still be the one this attestation named and that
      // runtime must still be usable, and the *exact assignment* this attestation was made under
      // must still be active.
      //
      // The session/incarnation currency is checked against `conversational_actors.current_*`
      // only, never against `assignments.session_id`/`session_incarnation`. Those columns are
      // the runtime *at binding time* (schema.sql says so in those words); #449 moved the live
      // pointer to the actor row precisely so a surviving counterpart's runtime could move
      // without rewriting the binding. A review built the counterexample this used to produce:
      // `BindingRegistry.switchTo({ conversation: "SURVIVED" })` moves `current_session_id` and
      // leaves `assignments` untouched, so comparing the attestation against the binding-time
      // session made every fresh, honest attestation from a survived counterpart unmatchable —
      // the live pointer says one session, the frozen binding-time column says another, and no
      // attestation can equal both at once. The live pointer is what "current" means here.
      //
      // Currency is judged on `asg.assignment_id = att.assignment_id`, not on role read alone.
      // Two reviews found the same shape twice over, at finer and finer grain: `asg.role =
      // ca.kind` (an earlier version of this check) scoped to the actor's own role, and that
      // still was not enough, because generation is minted per `role_key`
      // (`nextGeneration(roleKey)`) and `bind()` can reuse one physical actor across *different*
      // role_keys that share one `role` (#657) — `WORKER:task-A` and `WORKER:task-B` are both
      // `role = 'WORKER'` and each counts its own generation from 1. A stale attestation for
      // task-A's retired generation 1 was revived by task-B's own, unrelated, generation 1, and a
      // `role`-only check cannot tell the two role_keys apart because nothing about `role` names
      // which role_key a generation belongs to. `assignment_id` has no such ambiguity: it is
      // minted once per bind or rebind and never reused, so naming it *is* naming the exact
      // role_key and generation together.
      //
      // `asg.binding_generation = att.binding_generation` stayed in the WHERE clause through
      // that rewrite, and it must. `assignment_id` pins *which* assignment the attestation speaks
      // for; it does not vouch for what the attestation *says* about it. A third review built the
      // counterexample this leaves open without it: an attestation citing a real, currently
      // ACTIVE assignment_id but claiming generation 1 while that assignment's own row already
      // reads 2 — the join matched on identity alone, admitted the claim, and `canonical_turns`
      // recorded generation 2 for a turn no attestation ever attested. The two columns are
      // supposed to always agree (an honest writer reads both off the same assignment row), which
      // is exactly why an *unchecked* copy is the hazard: nothing enforced that they still did.
      // `asg.binding_generation` is still what gets stored — once both identity and content are
      // verified, the assignment's own value is the authoritative one to record, not the
      // attestation's copy of it — but "authoritative to store" and "not worth comparing" are two
      // different claims, and only the first one is true. A write-time trigger
      // (`attestation_generation_matches_assignment`) now refuses this shape at the source; this
      // condition is what stops it here too, for a row that reached the table by any other path.
      //
      // `sess.lifecycle = 'READY'` closes the other half of "current": the runtime-ready trigger
      // (`conversational_actors_runtime_ready`) only checks READY at the moment the pointer is
      // *written*. Nothing re-checks it afterwards, so a session that later transitions to
      // `ERROR` or `STOPPED` (`SessionRegistry.transition`) leaves the pointer exactly where it
      // was — a review matched an attestation through a session already in `ERROR`. Pointing at
      // *a* session is not the same fact as pointing at one still capable of running anything.
      //
      // The incarnation is checked against `sess.incarnation` — `sessions`' own column, immutable
      // by trigger (`sessions_incarnation_immutable`) — not against
      // `conversational_actors.current_session_incarnation`. A sixth review found that column is
      // itself a copy, one table further out than the last two rounds looked: `current_session_id`
      // is the live pointer and does not need a second source, because nothing else claims to know
      // "the actor's current session" — but `current_session_incarnation` claims to know
      // `sessions.incarnation` for whatever session that pointer names, and nothing enforced that
      // the two stayed equal. A plain `UPDATE conversational_actors SET
      // current_session_incarnation = ?` — no trigger fired, because
      // `conversational_actors_runtime_ready` watches `current_session_id` alone — let an
      // incarnation that never existed sit beside a real, READY session id, and this query
      // compared the attestation only against that copy. Comparing against `sess.incarnation`
      // instead makes the copy irrelevant to this decision rather than merely rechecked: since
      // `sess` is already joined on `sess.session_id = ca.current_session_id`, and a session's
      // incarnation is immutable for its lifetime, `sess.incarnation` is the one value this could
      // ever honestly be. A write-time trigger
      // (`conversational_actors_incarnation_matches_session`) now refuses the corrupting write at
      // its source too.
      const attestation = this.db.get<{
        target_attestation_id: string;
        executor_session_id: string;
        executor_session_incarnation: string;
        binding_generation: number;
      }>(
        `SELECT att.target_attestation_id AS target_attestation_id,
                att.executor_session_id AS executor_session_id,
                att.executor_session_incarnation AS executor_session_incarnation,
                asg.binding_generation AS binding_generation
           FROM actor_target_attestations att
           JOIN actor_target_bindings tb
             ON tb.target_binding_id = att.target_binding_id
           JOIN conversational_actors ca
             ON ca.actor_id = tb.target_actor_id
           JOIN sessions sess
             ON sess.session_id = ca.current_session_id
           JOIN assignments asg
             ON asg.assignment_id = att.assignment_id
            AND asg.actor_id = ca.actor_id
            AND asg.status = 'ACTIVE'
            AND asg.binding_generation = att.binding_generation
          WHERE att.target_binding_id = ?
            AND tb.target_actor_id = ?
            AND ca.retired_at IS NULL
            AND sess.lifecycle = 'READY'
            AND ca.current_session_id = att.executor_session_id
            AND sess.incarnation = att.executor_session_incarnation
          ORDER BY att.attested_at DESC, att.rowid DESC
          LIMIT 1`,
        [target.target_binding_id, input.targetActorId],
      );
      if (!attestation) {
        // Which refusal to report depends on whether an attestation exists at all: one that
        // never happened is a different fact from one that happened and has since gone stale,
        // and the two point an operator somewhere different.
        const everAttested = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM actor_target_attestations WHERE target_binding_id = ?`,
          [target.target_binding_id],
        );
        if (!everAttested || everAttested.n === 0) {
          // A binding says which conversation; an attestation says a runtime verified it under a
          // named authority generation. Admitting on the first alone would trust a claim that has
          // not been checked since it was made.
          return deny(
            ReasonCode.CONVERSATION_TARGET_UNATTESTED,
            "this actor's target has never been attested by a runtime, so a turn cannot be claimed",
            { targetActorId: input.targetActorId, targetBindingId: target.target_binding_id },
          );
        }
        // An attestation exists, but nothing ties it to the actor's current generation: the
        // actor may have retired, its runtime may have moved, or the role's active assignment may
        // have advanced past the generation this attestation named. The value stored as proof
        // that a named generation verified the target may be from a generation that is gone.
        return deny(
          ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE,
          "this actor's target was attested, but not by anything the current generation can verify",
          { targetActorId: input.targetActorId, targetBindingId: target.target_binding_id },
        );
      }

      const unadmitted = input.sources.find(
        (candidate) =>
          !this.db.get<{ 1: number }>(
            `SELECT 1 FROM inbound_messages WHERE channel = ? AND nonce = ?`,
            [candidate.channel, candidate.nonce],
          ),
      );
      if (unadmitted) {
        // A source names which inbound message a turn consumed. Without this, a caller's word
        // that a channel and nonce exist would be written straight into `canonical_turn_sources`
        // — the ledger would record that a turn consumed a message that was never admitted, and
        // the retry chain would reason about attempts of a message with no admission record.
        return deny(
          ReasonCode.CONVERSATION_TURN_SOURCE_UNADMITTED,
          "a source names a channel and nonce that ingress never admitted",
          {
            targetActorId: input.targetActorId,
            channel: unadmitted.channel,
            nonce: unadmitted.nonce,
          },
        );
      }

      // Existence is not identity. The check above only asks "did ingress admit *something*
      // under this (channel, nonce)" — a caller could have ingress admit `{text:"A"}` for a
      // nonce and then claim that same nonce with `{text:"B"}`, and the row's mere existence
      // would pass. `canonical_turn_sources.source_digest` below is computed from the caller's
      // payload, so without this check B's digest would be recorded as what the nonce carried —
      // permanently, since that table is append-only. `INGRESS_ADMITTED` is the one place a
      // payload digest is recorded at admission time, keyed by the (channel, nonce) it was
      // admitted under; read it rather than trusting the caller's payload for both "did this
      // happen" and "what happened". `inbound_messages` itself stores no payload — the admit
      // writer's audit record is the only durable copy.
      const mismatched = input.sources.find((candidate) => {
        const admitted = this.db.get<{ payload_digest: string | null }>(
          `SELECT json_extract(evidence_json, '$.payloadDigest') AS payload_digest
             FROM audit_events
            WHERE kind = 'INGRESS_ADMITTED'
              AND json_extract(evidence_json, '$.channel') = ?
              AND json_extract(evidence_json, '$.nonce') = ?
            ORDER BY event_id DESC LIMIT 1`,
          [candidate.channel, candidate.nonce],
        );
        return admitted?.payload_digest !== digestOf(candidate.payload);
      });
      if (mismatched) {
        return deny(
          ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH,
          "a source's payload does not match what ingress recorded admitting for this channel and nonce",
          {
            targetActorId: input.targetActorId,
            channel: mismatched.channel,
            nonce: mismatched.nonce,
          },
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
  /**
   * The one settlement path, reached only through a port that names the authority for the caller.
   *
   * Private because the authority is the whole claim an observation makes. While a caller passed
   * it as a field, "the target committed this turn" was a string anyone holding the coordinator
   * could type, and the ledger recorded a provenance nobody had established. The ports below
   * derive it from which object the caller was given, so a component wired with the pre-dispatch
   * port cannot record a target receipt however it is called.
   */
  #observe(
    permit: TurnPermit,
    observation: TurnObservation,
    /**
     * Which side of the dispatch this authority speaks from.
     *
     * `BEFORE` is the one authority that can say nothing ran; every other reports what happened to
     * an execution. Checked against the ledger's dispatch row rather than trusted, because that is
     * the whole of #662: the outcome is a caller's word and the phase is a fact.
     */
    phase: "BEFORE" | "AFTER",
  ): Decision<TurnMaterialization> {
    const issued = this.assertIssuedHere(permit);
    if (!issued.allowed) return deny(issued.reasonCode, issued.message, issued.evidence);
    return this.#observeVerified(
      { turnRequestId: permit.turnRequestId, targetActorId: permit.targetActorId, promptDigest: permit.promptDigest },
      observation,
      phase,
    );
  }

  /**
   * `#observe`'s body, reached two ways that establish the same three facts by different means.
   *
   * A live caller's permit proves "the process that claimed this turn issued this call", checked
   * by `assertIssuedHere` before this is reached. `reconcileWithReceipt` instead reads the row
   * directly and compares every field a reconciler's identity carries — it has no permit to check,
   * by design (see that method's docstring). Once either has established `identity`, the recording
   * and materialization logic below does not need to know which path it came from.
   */
  #observeVerified(
    identity: { turnRequestId: string; targetActorId: string; promptDigest: string },
    observation: TurnObservation,
    phase: "BEFORE" | "AFTER",
  ): Decision<TurnMaterialization> {
    return this.db.tx(() => {
      // Asymmetric, and the asymmetry is the whole design.
      //
      // A turn with a dispatch row cannot be reported as never started: that claim contradicts a
      // fact the ledger holds, and admitting it is #662 — the caller that dispatched, said nothing
      // ran, and got attempt 2 admitted while attempt 1 was still in flight.
      //
      // The other direction is *not* symmetric. A target receipt for a turn with no dispatch row
      // is either a caller that skipped `markDispatching`, or a genuine late receipt after a
      // mistaken pre-dispatch refusal — and refusing it discards a true record to punish a
      // bookkeeping mistake, which is precisely the failure this issue named when it said the
      // first-settlement-wins rule "loses the *true* one". It is admitted, and if it disagrees with
      // what is already there the consistency axis says so.
      //
      // What that leaves open is stated rather than implied: a caller that never dispatched can
      // still fabricate a completion. Nothing here can tell that from a late receipt, because both
      // are a caller supplying an evidence digest. Closing it needs a receipt the target signed,
      // which is #638's to produce.
      if (phase === "BEFORE" && this.dispatched(identity.turnRequestId)) {
        return deny(
          ReasonCode.CONVERSATION_TURN_PHASE_MISMATCH,
          "this turn was dispatched, so nothing can report that it never started",
          { turnRequestId: identity.turnRequestId, authority: observation.authority },
        );
      }

      // The three fields are what make the row a record of something observed. Measured on the
      // merged head, all three were accepted empty and stored empty, so a settlement could say
      // COMPLETED and cite nothing. The receipt id is the sharpest: it is half of
      // `(observing_authority, receipt_id)`, so the first blank settlement an authority makes takes
      // that slot and every later blank one is either a redelivery of it or a reuse conflict
      // against evidence that never existed.
      const blank = (["receiptId", "evidenceDigest", "reasonCode"] as const).filter(
        (field) => String(observation[field] ?? "").trim() === "",
      );
      if (blank.length > 0) {
        return deny(
          ReasonCode.CONVERSATION_TURN_OBSERVATION_UNEVIDENCED,
          `an observation must carry a ${blank.join(", a ")}`,
          { turnRequestId: identity.turnRequestId, authority: observation.authority, blank },
        );
      }

      const row = this.db.get<{ target_actor_id: string; prompt_digest: string }>(
        `SELECT target_actor_id, prompt_digest FROM canonical_turns WHERE turn_request_id = ?`,
        [identity.turnRequestId],
      );
      if (!row) {
        // Unreachable since v24: a turn cannot be deleted, so a genuinely issued permit always
        // names a row. Recorded as unreachable rather than claimed as a guard — no test can kill
        // it, and a falsifiability row for it would report coverage that does not exist.
        return deny(ReasonCode.CONFLICT, "no turn was ever claimed under this id", {
          turnRequestId: identity.turnRequestId,
        });
      }
      if (row.target_actor_id !== identity.targetActorId || row.prompt_digest !== identity.promptDigest) {
        return deny(
          ReasonCode.CONVERSATION_TURN_PERMIT_MISMATCH,
          "this permit does not describe the turn it names",
          { turnRequestId: identity.turnRequestId },
        );
      }

      // Looked up across turns, because a receipt id names something the issuing authority
      // produced — not something this turn owns. Searching only this turn let one authority's
      // receipt land on two turns, which with a caller-supplied authority is a wrong-turn
      // completion laundering path.
      const already = this.db.get<{
        turn_request_id: string;
        observed_outcome: string;
        evidence_digest: string;
        reason_code: string;
      }>(
        `SELECT turn_request_id, observed_outcome, evidence_digest, reason_code
           FROM canonical_turn_observations
          WHERE observing_authority = ? AND receipt_id = ?`,
        [observation.authority, observation.receiptId],
      );
      if (already) {
        const identical =
          already.turn_request_id === identity.turnRequestId &&
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
            already.turn_request_id === identity.turnRequestId
              ? "this receipt id already carries different evidence on this turn"
              : "this receipt id is already bound to a different turn",
            {
              turnRequestId: identity.turnRequestId,
              authority: observation.authority,
              receiptId: observation.receiptId,
            },
          );
        }
        // The same receipt redelivered is a no-op, not a second opinion. Without this a retrying
        // transport manufactures a disagreement with itself and quarantines the conversation.
        return allow(ReasonCode.OK, this.materialization(identity.turnRequestId));
      }

      // Past this line every failure throws, because `Db.tx` commits a body that returns a
      // denial (#664) and an observation written without its audit row is testimony with no
      // provenance.
      const audited = this.audit.record({
        kind: "CONVERSATION_TURN_OBSERVED",
        actor: row.target_actor_id,
        evidence: {
          turnRequestId: identity.turnRequestId,
          outcome: observation.outcome,
          authority: observation.authority,
          receiptId: observation.receiptId,
        },
      });
      if (!audited.allowed) throw acpError(audited.reasonCode, audited.message, audited.evidence);

      // Recording and recomputing under one marker. Split, an observation could land while the
      // computed columns still described the set without it — measured on a review head, where a
      // directly inserted completion left the turn reading NEVER_ADMITTED / CONSISTENT, so the
      // doctor stayed green and the quarantine never engaged.
      return this.db.materializeTurn(this.#materialization, { turnRequestId: identity.turnRequestId }, () => {
        this.db.run(
          `INSERT INTO canonical_turn_observations
             (turn_request_id, observed_outcome, observing_authority, receipt_id,
              evidence_digest, reason_code, observed_at, audit_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            identity.turnRequestId,
            observation.outcome,
            observation.authority,
            observation.receiptId,
            observation.evidenceDigest,
            observation.reasonCode,
            this.clock.nowIso(),
            audited.value,
          ],
        );
        return allow(ReasonCode.OK, this.materialize(identity.turnRequestId));
      });
    });
  }

  /**
   * Every turn a reconciler still needs to ask a target about, with the identity a lookup needs.
   *
   * The read half of contract 6. `unresolvedAcrossActors` answers a person and omits
   * `promptDigest`/`bindingGeneration` because a person does not need them to decide;
   * `reconcileUnresolved`'s whole job is comparing them, so this exposes what that one omits.
   * Read-only, and harmless on its own: naming which turns are open is not the write half of
   * contract 6, and nothing here accepts an externally supplied receipt for one of them — see
   * `reconcileUnresolved`.
   */
  unresolvedIdentities(): ReadonlyArray<ReceiptLookupQuery & { claimedAt: string }> {
    return this.db
      .all<{
        turn_request_id: string;
        target_actor_id: string;
        prompt_digest: string;
        binding_generation: number;
        target_binding_id: string;
        target_attestation_id: string;
        executor_session_id: string;
        executor_session_incarnation: string;
        claimed_at: string;
      }>(
        `SELECT turn_request_id, target_actor_id, prompt_digest, binding_generation,
                target_binding_id, target_attestation_id, executor_session_id,
                executor_session_incarnation, claimed_at
           FROM canonical_turns WHERE lifecycle_state = 'IN_DOUBT' ORDER BY claimed_at ASC`,
      )
      .map((row) => ({
        turnRequestId: row.turn_request_id,
        targetActorId: row.target_actor_id,
        promptDigest: row.prompt_digest,
        bindingGeneration: row.binding_generation,
        targetBindingId: row.target_binding_id,
        targetAttestationId: row.target_attestation_id,
        executorSessionId: row.executor_session_id,
        executorSessionIncarnation: row.executor_session_incarnation,
        claimedAt: row.claimed_at,
      }));
  }

  /**
   * Sweeps every `IN_DOUBT` turn once, asking `this.#receiptPort` about each — the write half of
   * contract 6, and the one settlement path that does not take a `TurnPermit`.
   *
   * A permit proves the transaction that claimed the turn also issued this call, a discipline
   * that only holds inside the process that ran `claim()`. Reconciliation exists precisely
   * because that process may be gone: `TurnPermit`'s own docstring says settling a turn after a
   * restart is the reconciler's job, "not a resurrected permit", and `issuance` is signed with a
   * key that dies with its coordinator instance.
   *
   * A review of the first version of this method (#691) found what that gap actually costs: it
   * took a receipt as a plain argument, `{turnRequestId, targetActorId, promptDigest,
   * bindingGeneration}` and `{outcome, receiptId, evidenceDigest, reasonCode}`, both ordinary
   * data. Anyone holding this coordinator could read a turn's identity from
   * `unresolvedIdentities()`, hand it straight back with a fabricated receipt, and record a
   * `HERMES_TARGET` completion that no target ever attested — the identity fix from the same
   * review closed a tautology in *which* fields were compared, but a caller supplying both the
   * query and the receipt satisfies any comparison between them. And the settlement it forges is
   * close to irreversible: `COMPLETED` cannot be walked back through the ordinary API, so a forged
   * one permanently blocks a retry of a turn that may never have run.
   *
   * What closes it is that the receipt never arrives as an argument at all. `this.#receiptPort` is
   * bound once, at construction — by the composition root, the one place `claimTurnMaterializationAuthority`
   * already makes singular, since a second coordinator on the same database throws before it
   * could bind a different port. A caller can still read `unresolvedIdentities()`, but the only
   * receipt this method will ever act on is one *this instance's own port* returned to *this
   * instance's own lookup call* — there is no public entry point left that accepts one from
   * outside.
   *
   * One call per turn, not one `Promise.all`: a lookup that throws must not stop the sweep from
   * asking about the rest, so each is awaited and caught independently. A review found that
   * "awaited" needed a bound: `ReceiptPort.lookup` may return a `Promise`, and one that never
   * settles — a legitimate implementation of the interface, not a misbehaving one — used to hang
   * this whole method on that single turn, forever, with every candidate after it never asked.
   * Every lookup now races against `RECEIPT_LOOKUP_TIMEOUT_MS` and a timeout is treated exactly
   * like a thrown lookup: never evidence, never stopping the rest of the sweep, and both are
   * counted in `failed`. A lookup failure or timeout and a `found: false` answer both leave the
   * turn exactly where it was, `IN_DOUBT` and visible as `OUTCOME_UNKNOWN`, and contract 6 forbids
   * treating either as evidence for re-execution — but they are no longer the same event to the
   * caller: `found: false` is a real answer, `failed` is the sweep not getting one at all, and a
   * second review found that difference used to be invisible, which made a port that fails on
   * every call indistinguishable from one with nothing to report.
   *
   * **What this does and does not do in the deployed system, stated as two separate facts rather
   * than one, because a third review (#691) found the first draft's disclosure let the second one
   * read as a footnote of the first. They are independent, and resolving #1 does not resolve #2:**
   *
   * 1. **Nothing to sweep.** This method observes `canonical_turns`, which nothing in production
   *    currently populates — `ConversationTurnCoordinator.claim()` has no caller in `src/` today;
   *    the live Telegram path claims through `IngressGuard` into a different table,
   *    `inbound_messages.turn_claim_json` (see `claim()`'s docstring). So today this sweep runs, and
   *    asks, over an empty set. The design is kept rather than pointed at the ledger production
   *    does write, because that is a different table with a different shape and its own review;
   *    silently retargeting this sweep at it would change what this change *is* without saying so.
   *    Wiring a production writer for `canonical_turns` is #683/#639's other half.
   * 2. **Even with something to sweep, `COMPLETED` cannot be acted on — unconditionally, not only
   *    while #1 holds.** Contract 6 requires a matched receipt to move `TURN_COMPLETED` and insert
   *    one reply-outbox item atomically, in the same transaction. Nothing wired to `canonical_turns`
   *    can perform the second half (`src/outbox/outbox.ts` exists, but its message kinds are
   *    role-to-role task dispatch, not a reply to the owner who asked), so `#settleFromReceipt`
   *    refuses every `COMPLETED` receipt outright, unconditionally — not "when the reply obligation
   *    happens to be undischargeable", because there is no path today on which it is dischargeable.
   *    This was a deliberate choice over a conditional refusal: a conditional check would need a
   *    reply-outbox interface to test against, and no consumer of one exists yet — inventing that
   *    seam now is how an API nobody can use gets built. What has to exist first is a reply-outbox
   *    mechanism actually wired to this ledger; until it does, resolving #1 makes `ABORTED`
   *    settlements real and leaves `COMPLETED` exactly as inert as it is today. `ABORTED` carries no
   *    reply obligation and is unaffected by this refusal. A refusal here is recoverable; a
   *    `COMPLETED` recorded with no way to prove the reply went anywhere is not, since
   *    `canonical_turns`' settlement is one-way through the ordinary API.
   */
  async reconcileUnresolved(
    /**
     * How long this whole pass may run before it stops issuing new lookups. Defaults to
     * `RECONCILE_SWEEP_BUDGET_MS`; overridable for the same reason `Daemon.refreshCapacitySensors`
     * takes one — a caller sizing it against a deliberately short interval (tests, a tighter
     * deployment) needs the two to agree, and a hardcoded budget could not.
     */
    budgetMs: number = RECONCILE_SWEEP_BUDGET_MS,
  ): Promise<{
    readonly swept: number;
    readonly settled: number;
    readonly unresolved: number;
    /**
     * How many lookups this pass could not get an honest answer from — threw, or timed out.
     *
     * A review found the sweep swallowed these silently: `reconcileUnresolved()` always returned
     * as if it had succeeded, so a port that fails on *every* call looked identical to one with
     * nothing to find, which is the exact ambiguity contract 6 exists to remove. The daemon's
     * caller throws when this is nonzero, so `runPeriodic`'s existing backoff and audit trail —
     * built for the watchdog and capacity timers — sees a struggling receipt port the same way it
     * already sees any other failing periodic job, with no new mechanism needed for it.
     */
    readonly failed: number;
  }> {
    const candidates = this.unresolvedIdentities();
    const startedAt = Date.now();
    let settled = 0;
    let failed = 0;
    for (const candidate of candidates) {
      // The overall bound a per-lookup timeout does not provide. A review measured seven honestly
      // slow (not hung) lookups in one pass adding up past the periodic interval, so the next
      // sweep started before this one returned — `runPeriodic` has no in-flight guard, and this
      // codebase's answer to that for the analogous capacity sweep is a budget the pass is raced
      // against, not a lock (see `RECONCILE_SWEEP_BUDGET_MS`). A candidate not reached before the
      // budget runs out is left exactly where it was, `IN_DOUBT`, for the next sweep to try.
      if (Date.now() - startedAt >= budgetMs) break;

      let result: ReceiptLookupResult;
      try {
        result = await this.#lookupWithTimeout({
          turnRequestId: candidate.turnRequestId,
          targetActorId: candidate.targetActorId,
          promptDigest: candidate.promptDigest,
          bindingGeneration: candidate.bindingGeneration,
          targetBindingId: candidate.targetBindingId,
          targetAttestationId: candidate.targetAttestationId,
          executorSessionId: candidate.executorSessionId,
          executorSessionIncarnation: candidate.executorSessionIncarnation,
        });
      } catch {
        failed += 1;
        continue;
      }
      if (!result.found) continue;

      // Every identity field checked below comes from `result` — the port's answer — not from
      // `candidate`. `candidate.turnRequestId` is passed too, but only as *which row this sweep
      // asked about*; it is `result.turnRequestId` — what the receipt itself attests to — that
      // `#settleFromReceipt` compares against it. A port that confused this turn with another
      // sharing the same actor, prompt and generation used to be indistinguishable from a genuine
      // match, because nothing compared the one field that would have caught it.
      const decision = this.#settleFromReceipt(candidate.turnRequestId, {
        turnRequestId: result.turnRequestId,
        targetActorId: result.targetActorId,
        promptDigest: result.promptDigest,
        bindingGeneration: result.bindingGeneration,
        targetBindingId: result.targetBindingId,
        targetAttestationId: result.targetAttestationId,
        executorSessionId: result.executorSessionId,
        executorSessionIncarnation: result.executorSessionIncarnation,
      }, { outcome: result.outcome, receiptId: result.receiptId, evidenceDigest: result.evidenceDigest, reasonCode: result.reasonCode });
      if (decision.allowed) settled += 1;
      // A denial here — wrong generation, mismatched identity, or an already-settled turn a
      // concurrent settlement reached first — leaves the turn exactly as it was. It is not
      // re-thrown: one candidate's refusal must not stop the sweep from asking about the rest.
    }
    return { swept: candidates.length, settled, unresolved: candidates.length - settled, failed };
  }

  /**
   * `this.#receiptPort.lookup()`, bounded to `RECEIPT_LOOKUP_TIMEOUT_MS`.
   *
   * `Promise.race` against a timer that rejects, not one that resolves `found: false` — resolving
   * would make a timeout indistinguishable from the port's own answer in a stack trace or a log,
   * and the caller above already treats a thrown lookup as `found: false`'s equivalent, so
   * rejecting reuses that path instead of adding a second one. The timer is `unref()`d so a lookup
   * that outlives this call cannot itself keep the process alive.
   *
   * A review found the first version of this method only abandoned a timed-out lookup — the
   * underlying promise kept running, so a genuinely slow port left duplicate, uncancelled work
   * behind on every timeout, and that work compounded across the overlapping sweeps a slow port
   * also causes. `signal.abort()` on timeout is what tells a real implementation to actually stop:
   * whether it does is that implementation's choice, not something this method can force on a
   * network client, but the seam exists now rather than after #638 already built against a
   * `lookup` with nothing to abort.
   */
  #lookupWithTimeout(query: ReceiptLookupQuery): Promise<ReceiptLookupResult> {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort(new Error(`receipt lookup for ${query.turnRequestId} timed out`));
        reject(new Error(`receipt lookup for ${query.turnRequestId} timed out`));
      }, RECEIPT_LOOKUP_TIMEOUT_MS);
      timer.unref();
      Promise.resolve(this.#receiptPort.lookup(query, controller.signal)).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * `reconcileUnresolved`'s settlement half, kept private so a receipt can only ever reach it from
   * this coordinator's own `this.#receiptPort.lookup()` call — never from a caller-supplied
   * argument. See that method's docstring for why a public version of this was #691's finding.
   */
  #settleFromReceipt(
    turnRequestId: string,
    attested: {
      turnRequestId: string;
      targetActorId: string;
      promptDigest: string;
      bindingGeneration: number;
      targetBindingId: string;
      targetAttestationId: string;
      executorSessionId: string;
      executorSessionIncarnation: string;
    },
    receipt: TurnReceipt & { outcome: "COMPLETED" | "ABORTED" },
  ): Decision<TurnMaterialization> {
    // Contract 6's atomic pair, and the half this build cannot perform: a matched receipt must
    // move `TURN_COMPLETED` and insert one reply-outbox item in the same transaction, and nothing
    // wired to `canonical_turns` can do the second half today (see `reconcileUnresolved`'s
    // docstring). Checked first and unconditionally — no identity or generation match makes this
    // safe, because the gap is not about which turn the receipt names, it is about what recording
    // `COMPLETED` here would fail to guarantee for any turn. `ABORTED` carries no reply obligation
    // and reaches the checks below unaffected.
    if (receipt.outcome === "COMPLETED") {
      return deny(
        ReasonCode.CONVERSATION_TURN_RECEIPT_REPLY_OBLIGATION_UNDISCHARGEABLE,
        "this receipt reports completion, but no reply-outbox insert can be performed atomically with it yet",
        { turnRequestId },
      );
    }
    // Checked next, and against no table: a receipt attesting to a different turn than the one
    // this sweep asked about is not evidence about this row at all, whatever else it says. A port
    // that confused two turns sharing the same actor, prompt and generation — an earlier completed
    // one and a later one, say — is exactly what this catches; every other field here could agree
    // by coincidence, and this is the one contract 1 fixes so that coincidence is not enough.
    if (attested.turnRequestId !== turnRequestId) {
      return deny(
        ReasonCode.CONVERSATION_TURN_RECEIPT_WRONG_TURN,
        "this receipt attests to a different turn than the one this sweep asked about",
        { turnRequestId, receiptTurnRequestId: attested.turnRequestId },
      );
    }
    return this.db.tx(() => {
      const row = this.db.get<{
        binding_generation: number;
        target_binding_id: string;
        target_attestation_id: string;
        executor_session_id: string;
        executor_session_incarnation: string;
      }>(
        `SELECT binding_generation, target_binding_id, target_attestation_id,
                executor_session_id, executor_session_incarnation
           FROM canonical_turns WHERE turn_request_id = ?`,
        [turnRequestId],
      );
      if (!row) {
        // Unreachable through this method's one caller: `reconcileUnresolved` sources
        // `turnRequestId` from `unresolvedIdentities()`, which reads this same table, and turns
        // are never deleted (canonical_turns_identity_immutable). Kept as a refusal rather than an
        // assumption — a private method with one caller today is still a method a later caller
        // could reach differently — and recorded as unreachable rather than claimed as a guard: no
        // test can kill it, and a falsifiability row for it would report coverage that does not
        // exist.
        return deny(ReasonCode.NOT_FOUND, "no turn was ever claimed under this id", { turnRequestId });
      }
      // Deliberately not also checking `target_actor_id` / `prompt_digest` here: `#observeVerified`
      // re-reads this same row and checks exactly those two fields against the identity it is
      // given, below. A second copy of that comparison would be untested by construction — it
      // could never fail a test on its own, because the downstream check would catch whatever it
      // missed — and a check nothing can kill reports coverage it does not have.
      if (row.binding_generation !== attested.bindingGeneration) {
        return deny(
          ReasonCode.CONVERSATION_TURN_RECEIPT_WRONG_GENERATION,
          "this receipt names a different CEO generation than the one that claimed this turn",
          { turnRequestId, claimedGeneration: row.binding_generation, receiptGeneration: attested.bindingGeneration },
        );
      }
      // The fence a matching generation does not provide: `bindingGeneration` distinguishes CEO
      // generations, and a `SURVIVED` failover deliberately keeps the generation unchanged while
      // moving the actor's live runtime to a new session (`binding-registry.ts`, the
      // `conversation === "SURVIVED"` branch — "the binding is not rewritten, which is why
      // `binding_generation` cannot advance here"). So these three are checked separately, each
      // against the row this turn was actually claimed against.
      if (row.target_binding_id !== attested.targetBindingId) {
        return deny(
          ReasonCode.CONVERSATION_TURN_RECEIPT_WRONG_BINDING,
          "this receipt names a different target binding than the one this turn was claimed against",
          { turnRequestId, claimedBindingId: row.target_binding_id, receiptBindingId: attested.targetBindingId },
        );
      }
      if (row.target_attestation_id !== attested.targetAttestationId) {
        return deny(
          ReasonCode.CONVERSATION_TURN_RECEIPT_WRONG_ATTESTATION,
          "this receipt names a different attestation than the one that verified this turn's target",
          {
            turnRequestId,
            claimedAttestationId: row.target_attestation_id,
            receiptAttestationId: attested.targetAttestationId,
          },
        );
      }
      if (
        row.executor_session_id !== attested.executorSessionId ||
        row.executor_session_incarnation !== attested.executorSessionIncarnation
      ) {
        return deny(
          ReasonCode.CONVERSATION_TURN_RECEIPT_WRONG_RUNTIME,
          "this receipt names a different executor session or incarnation than the one this turn was claimed under",
          {
            turnRequestId,
            claimedSession: { id: row.executor_session_id, incarnation: row.executor_session_incarnation },
            receiptSession: { id: attested.executorSessionId, incarnation: attested.executorSessionIncarnation },
          },
        );
      }
      return this.#observeVerified(
        { turnRequestId, targetActorId: attested.targetActorId, promptDigest: attested.promptDigest },
        { ...receipt, authority: "HERMES_TARGET" },
        "AFTER",
      );
    });
  }

  /**
   * Settles a turn nothing else can, under an authority that says a person decided it.
   *
   * The permit is signed with a key that dies with the coordinator instance, so a turn held across
   * a restart has no settler: `contradictions()` does not list it because its records do not
   * disagree, `adjudicate()` refuses it for the same reason, and the actor's next message is
   * refused because the first is unresolved. Doctor reports `CANONICAL_TURN_IN_DOUBT` and names no
   * command, which is the shape the operator door was built to remove and then did not cover — an
   * exit that is named and unreachable is worse than one that is absent, because the report reads
   * as actionable.
   *
   * Restricted to `ABORTED`, in the schema and not only here. An operator did not watch the target
   * commit, so a completion under this authority would be a person asserting something nobody
   * observed — and `COMPLETED` is the direction that loses the owner's question forever. `ABORTED`
   * is retry-safe: it says the outcome is unknown and re-running is permitted, which is what a
   * person choosing on incomplete information should be able to choose.
   *
   * It does not make the turn safe to retry on its own. If ACP watched a reply for this turn, that
   * completion observation still stands, the retry rule still refuses, and the turn goes
   * `CONTRADICTED` — which `adjudicate()` can now take, because the records genuinely disagree.
   * Two steps, both reachable, and neither of them a timer.
   */
  resolveInDoubt(input: {
    targetActorId: string;
    turnRequestId: string;
    reasonCode: string;
    evidenceDigest: string;
    /**
     * The operator's word that the execution holding this turn can no longer write.
     *
     * Needed only when ACP cannot see that for itself. `ABORTED` means a fence happened, and a
     * review pointed out that this authority was recording one without any: resolve a turn whose
     * execution is still live and attempt 2 is admitted while attempt 1 may still deliver, which is
     * the duplicate the whole ledger exists to prevent.
     *
     * So the fence is *checked* where it can be. A turn records the executor incarnation it was
     * claimed under; if the actor's current attestation names a different one, the execution that
     * held this turn belongs to a superseded incarnation and provably cannot commit — which is
     * exactly the restart case #668 is about. When the incarnation is still current, the execution
     * may still be running and this flag is the only thing that admits the resolution, recorded as
     * `ASSERTED` rather than `VERIFIED` so the ledger says which one it got.
     */
    fenceAsserted?: boolean;
  }): Decision<TurnMaterialization> {
    if (input.reasonCode.trim() === "" || input.evidenceDigest.trim() === "") {
      // Same rule as an adjudication and as every other observation: a record with no reason and
      // no evidence is a state change wearing the word. Trimmed, matching `#observe` — whitespace
      // is not a reason, and the two checks disagreeing would be a difference nobody chose. Refused here so the caller learns which
      // field was empty; the table refuses it too.
      return deny(ReasonCode.CONVERSATION_TURN_OBSERVATION_UNEVIDENCED, "a resolution has to say why, and on what", {
        turnRequestId: input.turnRequestId,
      });
    }
    return this.db.tx(() => {
      const held = this.db.get<{
        target_actor_id: string;
        lifecycle_state: string;
        target_binding_id: string;
        executor_session_id: string;
        executor_session_incarnation: string;
      }>(
        `SELECT target_actor_id, lifecycle_state, target_binding_id,
                executor_session_id, executor_session_incarnation
           FROM canonical_turns WHERE turn_request_id = ?`,
        [input.turnRequestId],
      );
      if (held?.target_actor_id !== input.targetActorId) {
        // The actor is part of the identity, not a convenience. An operator holding one
        // conversation's turn id must not be able to settle another's.
        return deny(ReasonCode.NOT_FOUND, "no such turn on this conversation", {
          turnRequestId: input.turnRequestId,
        });
      }
      if (held.lifecycle_state !== "IN_DOUBT") {
        return deny(ReasonCode.CONFLICT, "this turn is already settled, so there is nothing to resolve", {
          turnRequestId: input.turnRequestId,
          lifecycleState: held.lifecycle_state,
        });
      }

      // The fence, checked where it can be checked. A turn records the executor incarnation it was
      // claimed under; if the actor's current attestation names a different one, the execution
      // that held this turn belongs to a superseded incarnation and cannot still write. That is
      // the restart case this whole method exists for, and it is a fact rather than a promise.
      //
      // Scoped to the binding the turn was claimed under, not to the actor.
      //
      // A review built the actor-wide version's counterexample — a second binding for the same
      // actor, attested later under a different incarnation, reporting VERIFIED while the first
      // binding's execution is untouched. Measured, that state cannot exist: `UNIQUE
      // (target_actor_id)` on `actor_target_bindings` refuses the second binding, so the two
      // queries return the same row today. Scoped anyway, because a check should not depend on a
      // constraint two tables away to be about the right subject, and the test that pins that
      // constraint says so out loud.
      //
      // The session id is compared as well as the incarnation, because two runtimes can number
      // their incarnations independently and a match on the number alone is not a match on the
      // execution.
      const current = this.db.get<{ executor_session_id: string; executor_session_incarnation: string }>(
        `SELECT executor_session_id, executor_session_incarnation
           FROM actor_target_attestations
          WHERE target_binding_id = ?
          ORDER BY attested_at DESC, rowid DESC
          LIMIT 1`,
        [held.target_binding_id],
      );
      const fence =
        current !== undefined &&
        (current.executor_session_id !== held.executor_session_id ||
          current.executor_session_incarnation !== held.executor_session_incarnation)
          ? "VERIFIED"
          : "ASSERTED";
      if (fence === "ASSERTED" && input.fenceAsserted !== true) {
        // The execution may still be able to write, and `ABORTED` means it cannot. Recording one
        // here without the operator saying they established it is how a resolution admits attempt
        // 2 while attempt 1 is still in flight — the duplicate this ledger exists to prevent.
        return deny(
          ReasonCode.CONVERSATION_TURN_FENCE_UNPROVEN,
          "this turn's executor incarnation is still the current one, so its execution may still commit",
          {
            turnRequestId: input.turnRequestId,
            incarnation: held.executor_session_incarnation,
          },
        );
      }

      // Past this line every failure throws, for the reason `#observe` states: `Db.tx` commits a
      // body that returns a denial (#664), and an observation written without its audit row is
      // testimony with no provenance.
      const audited = this.audit.record({
        kind: "CONVERSATION_TURN_OBSERVED",
        actor: held.target_actor_id,
        evidence: {
          turnRequestId: input.turnRequestId,
          outcome: "ABORTED",
          authority: "OPERATOR_AFTER_REVIEW",
          reasonCode: input.reasonCode,
          // Which one the ledger got. A verified fence and a person's word are both admissible and
          // they are not the same claim, so the record says which rather than flattening them.
          fence,
        },
      });
      if (!audited.allowed) throw acpError(audited.reasonCode, audited.message, audited.evidence);

      return this.db.materializeTurn(this.#materialization, { turnRequestId: input.turnRequestId }, () => {
        this.db.run(
          `INSERT INTO canonical_turn_observations
             (turn_request_id, observed_outcome, observing_authority, receipt_id,
              evidence_digest, reason_code, observed_at, audit_event_id)
           VALUES (?, 'ABORTED', 'OPERATOR_AFTER_REVIEW', ?, ?, ?, ?, ?)`,
          [
            input.turnRequestId,
            // Derived rather than supplied. The receipt identity is `(authority, receipt_id)`, so
            // one resolution per turn is what this expresses; a second attempt is refused by the
            // IN_DOUBT check above before it can reach the constraint.
            `operator:${input.turnRequestId}`,
            input.evidenceDigest,
            input.reasonCode,
            this.clock.nowIso(),
            audited.value,
          ],
        );
        return allow(ReasonCode.OK, this.materialize(input.turnRequestId));
      });
    });
  }

  /**
   * Every turn waiting on a person, with what an operator needs to decide it.
   *
   * The read half of `resolveInDoubt`, and the same argument as `contradictions()`: doctor reports
   * the count, and an operator acting on it needs the ids and the ages rather than a number.
   */
  unresolvedAcrossActors(): ReadonlyArray<{
    turnRequestId: string;
    targetActorId: string;
    claimedAt: string;
    observations: ReadonlyArray<{ observationId: number; authority: string; outcome: string }>;
  }> {
    return this.db
      .all<{ turn_request_id: string; target_actor_id: string; claimed_at: string }>(
        `SELECT turn_request_id, target_actor_id, claimed_at FROM canonical_turns
          WHERE lifecycle_state = 'IN_DOUBT' ORDER BY claimed_at ASC`,
      )
      .map((row) => ({
        turnRequestId: row.turn_request_id,
        targetActorId: row.target_actor_id,
        claimedAt: row.claimed_at,
        // What is already on the turn, because it changes the decision: a turn carrying a
        // completion ACP watched is not the same case as one carrying nothing, and an operator
        // resolving the first will land on a contradiction that needs a second step.
        observations: this.db
          .all<{ observation_id: number; observing_authority: string; observed_outcome: string }>(
            `SELECT observation_id, observing_authority, observed_outcome
               FROM canonical_turn_observations WHERE turn_request_id = ? ORDER BY observation_id ASC`,
            [row.turn_request_id],
          )
          .map((o) => ({
            observationId: o.observation_id,
            authority: o.observing_authority,
            outcome: o.observed_outcome,
          })),
      }));
  }

  /**
   * Every contradicted turn, with the observations an adjudication would have to cite.
   *
   * The read half of the one operator action a quarantined conversation needs. Doctor named the
   * action and nothing could perform it, so this is the surface that makes the instruction true:
   * an operator sees which records disagree, and passes exactly those ids back to `adjudicate`.
   *
   * Returns the ids rather than a summary, because the adjudication has to name them and an
   * operator retyping them from prose is a way to cite the wrong set.
   */
  contradictions(): Array<{
    readonly turnRequestId: string;
    readonly targetActorId: string;
    readonly outcomeKind: string | null;
    readonly observations: Array<{
      readonly observationId: number;
      readonly outcome: string;
      readonly authority: string;
      readonly reasonCode: string;
    }>;
  }> {
    const turns = this.db.all<{ turn_request_id: string; target_actor_id: string; outcome_kind: string | null }>(
      `SELECT turn_request_id, target_actor_id, outcome_kind FROM canonical_turns
        WHERE observation_consistency = 'CONTRADICTED'
        ORDER BY turn_request_id`,
    );
    return turns.map((turn) => ({
      turnRequestId: turn.turn_request_id,
      targetActorId: turn.target_actor_id,
      outcomeKind: turn.outcome_kind,
      observations: this.db
        .all<{ observation_id: number; observed_outcome: string; observing_authority: string; reason_code: string }>(
          `SELECT observation_id, observed_outcome, observing_authority, reason_code
             FROM canonical_turn_observations WHERE turn_request_id = ?
            ORDER BY observation_id`,
          [turn.turn_request_id],
        )
        .map((row) => ({
          observationId: row.observation_id,
          outcome: row.observed_outcome,
          authority: row.observing_authority,
          reasonCode: row.reason_code,
        })),
    }));
  }

  /**
   * Closes a disagreement by citing the observations that made it, and nothing else.
   *
   * Until this existed a contradicted conversation had **no exit at all** — not through the API,
   * which had no method; not through raw SQL, which the settlement-authority trigger refuses; not
   * through the sqlite3 CLI, which cannot supply the connection-local marker the trigger calls;
   * and not by dropping the trigger, because the load-bearing-invariant check rejects the
   * database on the next open. The doctor told an operator to record an adjudication that
   * nothing could record. A review traced all four doors.
   *
   * What it cannot do is decide the outcome. An adjudication moves consistency and only
   * consistency: the conservative order already chose the outcome from the evidence, and letting
   * a human step choose a more retry-safe one would make "an authenticated COMPLETED is never
   * lowered" a preference rather than a rule.
   */
  adjudicate(input: {
    targetActorId: string;
    turnRequestId: string;
    /** Every observation the adjudication answers. Citing them is what distinguishes this from
     *  an assertion that the disagreement is over. */
    citedObservationIds: readonly number[];
    reasonCode: string;
    evidenceDigest: string;
  }): Decision<TurnMaterialization> {
    if (input.reasonCode.length === 0 || input.evidenceDigest.length === 0) {
      // An adjudication with no reason and no evidence is a state change wearing the word. The
      // schema refuses it too; refusing here means the caller learns which field was empty.
      return deny(ReasonCode.INVALID_ARGUMENT, "an adjudication has to say why, and on what", {
        turnRequestId: input.turnRequestId,
      });
    }
    return this.db.tx(() => {
      const turn = this.db.get<{ target_actor_id: string; observation_consistency: string }>(
        `SELECT target_actor_id, observation_consistency FROM canonical_turns
          WHERE turn_request_id = ?`,
        [input.turnRequestId],
      );
      if (!turn || turn.target_actor_id !== input.targetActorId) {
        return deny(ReasonCode.NOT_FOUND, "no such turn on this conversation", {
          turnRequestId: input.turnRequestId,
        });
      }
      if (turn.observation_consistency !== "CONTRADICTED") {
        return deny(
          ReasonCode.CONFLICT,
          "this turn's observations do not disagree, so there is nothing to adjudicate",
          { turnRequestId: input.turnRequestId, consistency: turn.observation_consistency },
        );
      }

      const conflicting = this.db
        .all<{ observation_id: number }>(
          `SELECT observation_id FROM canonical_turn_observations WHERE turn_request_id = ?`,
          [input.turnRequestId],
        )
        .map((row) => row.observation_id);
      const cited = new Set(input.citedObservationIds);
      const uncited = conflicting.filter((id) => !cited.has(id));
      if (uncited.length > 0 || input.citedObservationIds.some((id) => !conflicting.includes(id))) {
        // Every observation on the turn has to be answered, and nothing else may be cited. A
        // partial citation closes a disagreement while leaving part of it unread, which is the
        // same shape as a review that reports on what it happened to look at.
        return deny(
          ReasonCode.CONVERSATION_ADJUDICATION_INCOMPLETE,
          "an adjudication has to cite every observation on the turn, and only those",
          { turnRequestId: input.turnRequestId, uncited, cited: [...cited] },
        );
      }

      const audited = this.audit.record({
        kind: "CONVERSATION_TURN_ADJUDICATED",
        actor: input.targetActorId,
        evidence: {
          turnRequestId: input.turnRequestId,
          citedObservationIds: [...cited],
          reasonCode: input.reasonCode,
        },
      });
      if (!audited.allowed) throw acpError(audited.reasonCode, audited.message, audited.evidence);

      const current = this.materialization(input.turnRequestId);
      return this.db.materializeTurn(this.#materialization, { turnRequestId: input.turnRequestId }, () => {
        const written = this.db.run(
          `INSERT INTO canonical_turn_adjudications
             (turn_request_id, resolved_outcome, reason_code, evidence_digest, adjudicated_at,
              audit_event_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.turnRequestId,
            // Recorded, not chosen. The conservative order produced this from the evidence, and
            // an adjudication that could pick a different one would make "an authenticated
            // COMPLETED is never lowered" a preference rather than a rule.
            current.outcome,
            input.reasonCode,
            input.evidenceDigest,
            this.clock.nowIso(),
            audited.value,
          ],
        );
        const adjudicationId = Number(written.lastInsertRowid);
        for (const observationId of conflicting) {
          this.db.run(
            `INSERT INTO canonical_turn_adjudication_citations (adjudication_id, observation_id)
             VALUES (?, ?)`,
            [adjudicationId, observationId],
          );
        }
        return allow(ReasonCode.OK, this.materialize(input.turnRequestId));
      });
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
    const observations = this.db.all<{ observation_id: number; observed_outcome: string;
      observing_authority: string; evidence_digest: string; reason_code: string }>(
      `SELECT observation_id, observed_outcome, observing_authority, evidence_digest, reason_code
         FROM canonical_turn_observations WHERE turn_request_id = ? ORDER BY observation_id ASC`,
      [turnRequestId],
    );

    const materializing = observations.filter((o) => MATERIALIZING_AUTHORITIES.has(o.observing_authority));
    const strengthOf = (outcome: string): number => OUTCOME_STRENGTH[outcome] ?? 0;
    const strongest = [...materializing].sort(
      (a, b) => strengthOf(b.observed_outcome) - strengthOf(a.observed_outcome),
    )[0];

    // What an adjudication already answered, and what it resolved to.
    //
    // Without this the recompute counted every observation that ever existed, and the disagreeing
    // ones are permanent — so an adjudication lasted exactly until the next observation of any
    // kind, including one that *agreed* with the resolution. A late or redelivered receipt, which
    // is precisely what this ledger is built to keep accepting, re-wedged the conversation with
    // no new disagreement to answer. Measured end to end by two review lanes.
    const resolved = this.db.get<{ adjudication_id: number; resolved_outcome: string }>(
      `SELECT adjudication_id, resolved_outcome FROM canonical_turn_adjudications
        WHERE turn_request_id = ? ORDER BY adjudication_id DESC LIMIT 1`,
      [turnRequestId],
    );
    const answered = resolved
      ? new Set(
          this.db
            .all<{ observation_id: number }>(
              `SELECT observation_id FROM canonical_turn_adjudication_citations
                WHERE adjudication_id = ?`,
              [resolved.adjudication_id],
            )
            .map((row) => row.observation_id),
        )
      : new Set<number>();

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
    // Observations the adjudication did not read. Anything it did read is answered, whatever it
    // said; what re-opens a turn is a *new* record that disagrees with what was resolved.
    const unanswered = observations.filter((o) => !answered.has(o.observation_id));
    const distinct = new Set(unanswered.map((o) => o.observed_outcome));
    const disagreesWithResolution =
      resolved !== undefined && unanswered.some((o) => o.observed_outcome !== resolved.resolved_outcome);
    const consistency = disagreesWithResolution || distinct.size > 1
      ? "CONTRADICTED"
      : resolved !== undefined
        ? "ADJUDICATED"
        : "CONSISTENT";

    const current = this.materialization(turnRequestId);

    if (strongest) {
      // `settled_at` records when this turn *settled*, so it is written once and then left alone.
      // The version this replaced rewrote it on every later observation, including ones that
      // changed no outcome, so a late weak record moved the terminal time of a turn it did not
      // decide. The provenance trigger now refuses that; keeping the first value here is what
      // makes the trigger's refusal something this code never has to hit.
      const settledAt = this.clock.nowIso();
      this.db.materializeTurn(
        this.#materialization,
        { turnRequestId },
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
      this.db.materializeTurn(this.#materialization, { turnRequestId }, () =>
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
      // Three conditions, and each is the sole reason a retry is refused in some state.
      //
      // I wrote here that the completion count could not be killed — that a materializing
      // completion raises `outcome_kind` so the first condition refuses, and a non-materializing
      // one makes the turn CONTRADICTED so the third does. Both are true and the conclusion was
      // wrong: an adjudication moves the turn off CONTRADICTED while the completion observation
      // stays on it. A review built that state through these ports and refuted the claim.
      //
      //   ownerFence.aborted             -> ABORTED, which the first condition calls safe
      //   acpObservedReply.sawCompletion -> a completion that cannot materialize; CONTRADICTED
      //   adjudicate citing both         -> ADJUDICATED, so the third no longer refuses
      //
      // Only the count refuses the retry there, and with it removed the retry is admitted — a
      // re-run of an exchange ACP watched Hermes deliver to the owner. It has a test and a
      // falsifiability row now.
      //
      // The lesson is not about this condition. I reasoned from two mechanisms to "no state can
      // reach here" and did not try to build one; the state took three calls.
      //
      // And the guarantee these three make is conditional, which is worth stating where the rule
      // is rather than in a design note. A retry is admitted after `NEVER_ADMITTED`, so:
      //
      //   preDispatch.neverAdmitted(P1)  -> a turn that in fact ran is recorded as never started
      //   claim(attempt 2)               -> admitted; the owner's message is dispatched again
      //   target.completed(P1) arrives   -> CONTRADICTED, correctly, and one turn too late
      //
      // Nothing here can refuse that, because the rule's whole input is what the authorities
      // reported. **Exactly-once holds exactly as far as `ACP_PRE_DISPATCH` is truthful**, and
      // what makes it truthful is that the port is only reachable before dispatch — a discipline
      // in the caller, not a property the coordinator checks. #662 is that gap; this is what it
      // costs. Refusing the retry instead would turn every transient refusal into a permanent
      // hold, which is the failure #651 is about, so the trade is deliberate and one-directional.
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
