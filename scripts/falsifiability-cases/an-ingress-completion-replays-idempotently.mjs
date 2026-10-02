/**
 * A redelivered COMPLETED receipt must read as the settlement it already made, not as a collision with
 * it, or the replayed Telegram update is held forever.
 */
const anIngressCompletionReplaysIdempotently = {
  id: "an-ingress-completion-replays-idempotently",
  what: "the same COMPLETED receipt settling an ingress claim twice is a replay",
  file: "src/ingress/ingress-guard.ts",
  find: "          : memberClaim.settledAt !== undefined && existing.settlement === REPLY_OUTBOX_SETTLEMENT &&",
  replace: "          : false &&",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::adds nothing when the same receipt settles the claim again",
  ],
};

export default anIngressCompletionReplaysIdempotently;
