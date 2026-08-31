/**
 * #639 (2026-08-29 amendment). Removing this branch restores the defect exactly: the reply's
 * completion resolves the turn again, so a `CEO_CONVERSATION_TIMEOUT` apology that Telegram
 * accepted writes `repliedAt` and the turn reads as answered by the CEO. The row is the only
 * evidence a later reader — doctor, an operator, #638's receipt comparison — has.
 */
const aTurnTheCeoDidNotAnswerStaysUnresolved = {
  id: "a-turn-the-ceo-did-not-answer-stays-unresolved",
  what: "a reply the CEO did not write is delivered without resolving the turn as answered",
  file: "src/ingress/ingress-guard.ts",
  find: "      const completed = this.#recordResultHere(channel, nonce, result, \"PENDING\");\n      if (!completed.allowed) return completed;\n      if (turnOutcome === \"UNANSWERED\") return allow(ReasonCode.OK, undefined);\n",
  replace: "      const completed = this.#recordResultHere(channel, nonce, result, \"PENDING\");\n      if (!completed.allowed) return completed;\n",
  killedBy: [
    "tests/unit/a-timeout-apology-is-not-an-answer.test.ts::leaves the turn unresolved while the reply's own lifecycle records that it was delivered",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aTurnTheCeoDidNotAnswerStaysUnresolved;
