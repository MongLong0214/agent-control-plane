import type {
  ConversationTurnCoordinator,
  ReceiptLookupQuery,
  ReceiptLookupResult,
  ReceiptPort,
} from "./turn-coordinator.ts";

/**
 * One pass over every turn nothing has settled yet.
 *
 * This is the active half of contract 6 — the CEO's correction that a matched-receipt rule is
 * vacuously true if nothing ever asks. `unresolvedIdentities()` names the turns; this asks a
 * `ReceiptPort` about each and, on a match, hands the answer to `reconcileWithReceipt`, which is
 * the one settlement path that needs no permit — because by the time a turn is old enough to be
 * swept, the process that claimed it may well be gone.
 *
 * A lookup failure or a stale-generation mismatch is not distinguished from "no receipt" in the
 * counts below: both leave the turn exactly where it was, `IN_DOUBT` and visible as
 * `OUTCOME_UNKNOWN` through the same surfaces `unresolvedAcrossActors` already feeds. Contract 6
 * forbids treating either as evidence for re-execution, so neither is reported as progress.
 */
export class TurnReconciler {
  constructor(
    private readonly coordinator: ConversationTurnCoordinator,
    private readonly port: ReceiptPort,
  ) {}

  /**
   * Sweeps every `IN_DOUBT` turn once.
   *
   * One call per turn is deliberate: a lookup that throws must not stop the sweep from asking
   * about the rest, so each is awaited and caught independently rather than run inside one
   * `Promise.all`.
   */
  async reconcileOnce(): Promise<{
    readonly swept: number;
    readonly settled: number;
    readonly unresolved: number;
  }> {
    const candidates = this.coordinator.unresolvedIdentities();
    let settled = 0;
    for (const candidate of candidates) {
      const query: ReceiptLookupQuery = {
        turnRequestId: candidate.turnRequestId,
        targetActorId: candidate.targetActorId,
        promptDigest: candidate.promptDigest,
        bindingGeneration: candidate.bindingGeneration,
      };
      let result: ReceiptLookupResult;
      try {
        result = await this.port.lookup(query);
      } catch {
        // A lookup that fails to answer is exactly "no receipt", not evidence that one exists.
        // The turn is left precisely as it was, for the next sweep to ask again.
        continue;
      }
      if (!result.found) continue;

      // `query.bindingGeneration` is what was *asked*: the generation this turn was claimed
      // under, per `unresolvedIdentities()`. `result.bindingGeneration` is what came *back*: the
      // generation the port says actually minted the receipt, which need not be the one asked
      // about — a target answering by `turnRequestId` alone could return a receipt from a later
      // generation without knowing the two disagree. `reconcileWithReceipt` is what has to catch
      // that, so it is given the answer's generation to check, not an echo of its own question.
      const decision = this.coordinator.reconcileWithReceipt(
        { ...query, bindingGeneration: result.bindingGeneration },
        {
          outcome: result.outcome,
          receiptId: result.receiptId,
          evidenceDigest: result.evidenceDigest,
          reasonCode: result.reasonCode,
        },
      );
      if (decision.allowed) settled += 1;
      // A denial here — wrong generation, mismatched identity, or an already-settled turn a
      // concurrent settlement reached first — leaves the turn exactly as it was. It is not
      // re-thrown: one candidate's refusal must not stop the sweep from asking about the rest.
    }
    return { swept: candidates.length, settled, unresolved: candidates.length - settled };
  }
}
