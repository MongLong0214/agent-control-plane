/**
 * #760 Q1. `exactHolderTarget` is the one predicate the owner-message lifecycle asserts — the
 * claim, the completion, the rejection and the terminal replay read-back all compose it — and the
 * `sessions` join is the half that is not on the outbox row.
 *
 * Deleting the lifecycle clause leaves every visible behaviour intact: the assignment is still
 * `ACTIVE`, the role key, the generation, the session id and the incarnation all still match, and
 * a claim by the real holder still works. What is gone is the only thing that distinguishes a
 * runtime that is running from one that has stopped — a `STOPPED` session keeps its `ACTIVE`
 * assignment row — so a settle from a runtime that no longer exists is answered "succeeded", on
 * the path that then tells `prune` and `unresolvedTurns` the turn is closed.
 *
 * The killing row asserts the `STOPPED` case with the *same tuple* it had already had accepted
 * while the session was live, so the refusal it measures cannot be the identity being wrong.
 */
const anOwnerMessageSettlesOnlyForALiveHolder = {
  id: "an-owner-message-settles-only-for-a-live-holder",
  what: "an owner-message is claimed and settled only by a holder whose session is still live",
  file: "src/outbox/outbox.ts",
  find: "     AND s.lifecycle IN ('READY','DRAINING')\n)",
  replace: ")",
  killedBy: [
    "tests/unit/outbox-owner-message-holder.test.ts::refuses a claim, a completion and a rejection from a mismatched incarnation",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anOwnerMessageSettlesOnlyForALiveHolder;
