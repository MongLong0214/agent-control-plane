/**
 * #760 Q2. Role admission writes three facts in one transaction — the inbound row, the outbox row
 * and the turn claim — and the contract is that it produces all of them or none.
 *
 * The frame is `atomically`, and a *returned* denial there commits. Two refusals in this function
 * need that: a refused sender and an unresolvable address have already spent the `(buzz, nonce)`
 * slot, and spending it is the authenticated unbound-address semantics this slice preserves. A
 * refused enqueue is the opposite case and is why `rollingBack` exists — `admit` has already run,
 * so committing here would leave a spent nonce addressed to nobody, and the relay's redelivery of
 * the same event would then be dismissed as a replay of a message that was never queued.
 *
 * The mutation is the whole of that distinction and nothing else: the same denial, returned rather
 * than thrown. Every visible answer is unchanged — the caller still gets
 * `OUTBOX_PAYLOAD_DIGEST_MISMATCH` on the socket — and only the durable residue differs, which is
 * exactly why a row asserting on the refusal alone would stay green against it.
 *
 * The killing row asserts the residue: no inbound row, no second outbox row, and then the same
 * event id admitted successfully once the collision is removed — a positive control that could not
 * pass if the first attempt had consumed its nonce.
 *
 * Limit, deliberately uncovered: the sibling `throw rollingBack(claimed)` on the turn claim is not
 * reachable through this admission path, because `admit` inserts the row one statement earlier in
 * the same transaction and `claimTurn` cannot deny against it. Covering it would mean adding a
 * seam to production to inject a failure, which is a larger change than the guard is worth; the
 * enqueue refusal above traverses the same private rollback sentinel and proves the no-half-state
 * property it shares.
 */
const aRefusedOwnerMessageEnqueueSpendsNoNonce = {
  id: "a-refused-owner-message-enqueue-spends-no-nonce",
  what: "a refused owner-message enqueue rolls the whole admission back instead of committing it",
  file: "src/ingress/buzz-message.ts",
  find: "      if (!enqueued.allowed) throw rollingBack(enqueued);\n",
  replace: "      if (!enqueued.allowed) return enqueued as Decision<BuzzMessageAdmission>;\n",
  killedBy: [
    "tests/unit/an-owner-message-has-one-durable-copy.test.ts::leaves no admitted row and no spent nonce when the enqueue underneath it refuses",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aRefusedOwnerMessageEnqueueSpendsNoNonce;
