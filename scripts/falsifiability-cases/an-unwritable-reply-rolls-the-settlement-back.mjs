/**
 * `tx` commits a body that returns a denial (#664). The reply half refuses after the receipt observation
 * and the settlement were written, so only `txDecision` takes them back with it.
 */
const anUnwritableReplyRollsTheSettlementBack = {
  id: "an-unwritable-reply-rolls-the-settlement-back",
  what: "a reply that cannot be addressed leaves the canonical turn exactly as it was",
  file: "src/conversation/turn-coordinator.ts",
  find: "    return this.db.txDecision(() => {\n      const row = this.db.get<{\n        binding_generation: number;",
  replace: "    return this.db.tx(() => {\n      const row = this.db.get<{\n        binding_generation: number;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled when its messages do not name one conversation to answer",
  ],
};

export default anUnwritableReplyRollsTheSettlementBack;
