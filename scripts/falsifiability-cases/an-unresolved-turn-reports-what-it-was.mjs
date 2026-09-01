/**
 * #631 — a reconciler asking what is outstanding gets the message, not only its digest.
 *
 * The mutation reads the column as NULL, so `unresolvedTurns` reports every row's payload as
 * absent while the rows themselves still exist. That is the failure mode a stored-and-never-read
 * column has: the write gate passes, the restart path still cannot say what was lost, and the
 * park reply the owner sees falls back to a bare timestamp. A `promptDigest` cannot be shown to a
 * person, matched against what they remember sending, or re-run.
 *
 * Separate from the row that guards the write: a column written and not read, and a column read
 * and not written, are two different defects and one mutation cannot stand for both.
 */
const anUnresolvedTurnReportsWhatItWas = {
  id: "an-unresolved-turn-reports-what-it-was",
  what: "unresolvedTurns carries each outstanding turn's admitted payload, so what was lost can be named rather than only counted",
  file: "src/ingress/ingress-guard.ts",
  find: "      payload: admittedPayload(row.payload_json),\n",
  replace: "      payload: null,\n",
  killedBy: [
    "tests/process/an-owner-message-outlives-the-process-that-lost-its-turn.test.ts::holds Telegram's copy when restart finds an unresolved governed turn",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anUnresolvedTurnReportsWhatItWas;
