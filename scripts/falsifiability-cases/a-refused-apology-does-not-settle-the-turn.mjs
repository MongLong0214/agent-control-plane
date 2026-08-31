/**
 * #639. The refusal twin of the completion branch. `settledAt` says the turn's outcome is no
 * longer unknown, which is true of a CEO answer Telegram would not take and false of an apology
 * Telegram would not take — the CEO never answered either way. Removing this branch settles a
 * turn nobody answered, one HTTP status away from the defect the issue names.
 */
const aRefusedApologyDoesNotSettleTheTurn = {
  id: "a-refused-apology-does-not-settle-the-turn",
  what: "a reply the CEO did not write is terminalized without settling the turn it never answered",
  file: "src/ingress/ingress-guard.ts",
  find: "      const completed = this.#recordResultHere(channel, nonce, result, expected);\n      if (!completed.allowed) return completed;\n      if (turnOutcome === \"UNANSWERED\") return allow(ReasonCode.OK, undefined);\n",
  replace: "      const completed = this.#recordResultHere(channel, nonce, result, expected);\n      if (!completed.allowed) return completed;\n",
  killedBy: [
    "tests/unit/a-timeout-apology-is-not-an-answer.test.ts::terminalizes the reply but not the turn when Telegram refuses the apology",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aRefusedApologyDoesNotSettleTheTurn;
