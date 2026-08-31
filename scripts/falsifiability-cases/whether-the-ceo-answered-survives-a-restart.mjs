/**
 * #639. `storedState` rebuilds the row field by field rather than casting it, so a field it does
 * not name is dropped in silence — this is where the first draft of the fix lost `turnAnswered`
 * between the reservation and the restart that reads it back. Dropping the carry-through makes
 * every recovered claim read as unanswered, which is the fail-closed direction and therefore the
 * failure most likely to be shrugged off rather than seen.
 */
const whetherTheCeoAnsweredSurvivesARestart = {
  id: "whether-the-ceo-answered-survives-a-restart",
  what: "whether the CEO answered a claimed turn survives the process that recorded it",
  file: "src/ingress/telegram-polling.ts",
  find: "      ...(deliveryFailure ? { deliveryFailure } : {}),\n      ...(candidate.turnAnswered === undefined ? {} : { turnAnswered: candidate.turnAnswered }),\n",
  replace: "      ...(deliveryFailure ? { deliveryFailure } : {}),\n",
  killedBy: [
    "tests/unit/telegram-ingress.test.ts::a claimed turn's PENDING reply becomes delivery-unknown on redelivery instead of false no-reply",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default whetherTheCeoAnsweredSurvivesARestart;
