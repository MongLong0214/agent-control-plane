/**
 * Only the transaction that moves a turn to COMPLETED owes a reply. A sweep that finds the turn already
 * completed (an overlapping sweep, or the live holder's own permit) must not queue one, or the owner is
 * answered twice.
 */
const aRedeliveredReceiptOwesNoSecondReply = {
  id: "a-redelivered-receipt-owes-no-second-reply",
  what: "a receipt for a turn something else already completed queues no reply",
  file: "src/conversation/turn-coordinator.ts",
  find: "      if (before.outcome === \"COMPLETED\" || observed.value.outcome !== \"COMPLETED\") return observed;",
  replace: "      if (observed.value.outcome !== \"COMPLETED\") return observed;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::owes nothing new for a turn another settlement completed while the sweep was asking",
  ],
};

export default aRedeliveredReceiptOwesNoSecondReply;
