/**
 * #760 Q1/Q2. `inbound_messages.payload_json` is the single durable copy of an owner's envelope,
 * so the outbox row carries a pointer rather than a second copy of the words. A pointer is only
 * worth what it is re-checked against, and this comparison is that check: the row is claimed
 * first, then — in the same transaction — the envelope the pointer resolves to is required to be
 * the one the digest was taken over.
 *
 * The comparison is over the **whole** stored payload, not its `text`. That is the part a
 * plausible implementation gets wrong and this row makes falsifiable: a digest over the text alone
 * still matches after the recipient fields inside the signed envelope have been rewritten, so the
 * holder would be handed words that were addressed somewhere else and told they were its own.
 *
 * Deleting the comparison leaves the happy path identical — the digest matches, the text is read,
 * the message is handed over — and the only observable difference is that a mismatched source is
 * now read and returned instead of refused. The killing row builds exactly that: a pointer whose
 * stored envelope is not the one it was enqueued for, and asserts both halves, that no text comes
 * back and that the claimed row is terminally `REJECTED` rather than left to be served forever.
 */
const anOwnerMessageSourceIsTheEnvelopeItWasEnqueuedFor = {
  id: "an-owner-message-source-is-the-envelope-it-was-enqueued-for",
  what: "an owner-message hands over only the stored envelope its full-payload digest names",
  file: "src/daemon/agentcpd.ts",
  find:
    "        if (digestOf(payload) !== pointer.sourcePayloadDigest) {\n" +
    "          return refuseClaimed(\n" +
    "            ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,\n" +
    '            "the stored source envelope is not the one this message was enqueued for",\n' +
    "          );\n" +
    "        }\n",
  replace: "",
  killedBy: [
    "tests/unit/an-owner-message-has-one-durable-copy.test.ts::returns no text and terminally rejects when the source does not match its pointer",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anOwnerMessageSourceIsTheEnvelopeItWasEnqueuedFor;
