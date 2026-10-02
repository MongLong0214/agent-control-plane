/**
 * The in-flight wait applies to this process's own open claims only. A claim another incarnation left
 * belongs to a process that can no longer answer, which is the case a receipt exists to reconcile.
 * The replacement keeps `claim` narrowed so the mutant compiles.
 */
const aGoneProcessClaimIsNotInFlight = {
  id: "a-gone-process-claim-is-not-in-flight",
  what: "a claim left by a gone process does not hold back its receipt's reply",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (claim?.[\"claimedByProcess\"] !== answeringProcess) return false;",
  replace: "  if (claim === null) return false;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::settles the turn and stores one owner reply addressed to the Telegram message it answers",
  ],
};

export default aGoneProcessClaimIsNotInFlight;
