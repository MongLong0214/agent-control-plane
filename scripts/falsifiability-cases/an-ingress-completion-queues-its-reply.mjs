/**
 * The ingress half of #1036: a COMPLETED receipt settles the Telegram claim and queues the owner reply
 * in the same transaction, addressed from the batch's own rows.
 *
 * Not `if (false)`: inside a block TypeScript reads as unreachable, `reply` stops narrowing and the
 * mutant fails to compile, which the harness reports as an unusable row rather than a kill.
 */
const anIngressCompletionQueuesItsReply = {
  id: "an-ingress-completion-queues-its-reply",
  what: "a completed receipt on the ingress lane queues its owner reply",
  file: "src/ingress/ingress-guard.ts",
  find: "      if (receipt.outcome === \"COMPLETED\") {\n        const reply = enqueueOwnerReply(",
  replace: "      if (receipt.outcome !== receipt.outcome) {\n        const reply = enqueueOwnerReply(",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::settles the ingress claim and stores one owner reply addressed to the owner's message",
  ],
};

export default anIngressCompletionQueuesItsReply;
