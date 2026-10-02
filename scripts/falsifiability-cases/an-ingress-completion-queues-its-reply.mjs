/**
 * The ingress half of #1036: the coordinator queues the owner reply in the transaction that settles
 * the claim. The early return is a mutant that settles and stops there.
 */
const anIngressCompletionQueuesItsReply = {
  id: "an-ingress-completion-queues-its-reply",
  what: "a completed receipt on the ingress lane queues its owner reply",
  file: "src/conversation/turn-coordinator.ts",
  find: "        const reply = enqueueOwnerReply(this.#ownerReplies, this.db, this.clock, {\n          turnRequestId: query.turnRequestId,",
  replace: "        if (settled.allowed) return settled;\n        const reply = enqueueOwnerReply(this.#ownerReplies, this.db, this.clock, {\n          turnRequestId: query.turnRequestId,",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::settles the ingress claim and stores one owner reply addressed to the owner's message",
  ],
};

export default anIngressCompletionQueuesItsReply;
