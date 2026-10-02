/**
 * The ingress closure performs both writes; this check is the coordinator reading that the reply this
 * receipt names is durable before the transaction commits, instead of trusting the closure to have done it.
 */
const anIngressCompletionWithoutItsReplyIsRolledBack = {
  id: "an-ingress-completion-without-its-reply-is-rolled-back",
  what: "an ingress settlement that does not leave the matched receipt's reply durable is refused and rolled back",
  file: "src/conversation/turn-coordinator.ts",
  find: "      if (reply === null || reply.receipt.receiptId !== receipt.receiptId ||\n          reply.receipt.evidenceDigest !== receipt.evidenceDigest) {",
  replace: "      if (false) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::refuses, and rolls back, a settlement that records completion without its reply",
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::refuses a settlement whose queued reply names a different receipt than the one matched",
  ],
};

export default anIngressCompletionWithoutItsReplyIsRolledBack;
