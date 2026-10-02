/**
 * The ingress half of #1036: a COMPLETED receipt settles the Telegram claim and queues the owner reply
 * in the same transaction, addressed from the batch's own rows.
 */
const anIngressCompletionQueuesItsReply = {
  id: "an-ingress-completion-queues-its-reply",
  what: "a completed receipt on the ingress lane queues its owner reply",
  file: "src/ingress/ingress-guard.ts",
  find: "      if (receipt.outcome === \"COMPLETED\") {\n        const reply = enqueueOwnerReply(",
  replace: "      if (false) {\n        const reply = enqueueOwnerReply(",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::settles the ingress claim and stores one owner reply addressed to the owner's message",
  ],
};

export default anIngressCompletionQueuesItsReply;
