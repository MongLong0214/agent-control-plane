/**
 * Contract 6's pair on the canonical ledger (#1036): the transaction that makes a turn COMPLETED also
 * writes its owner reply. Without this line the turn completes and nothing records that the owner is
 * owed an answer, which is the one-way state the old refusal existed to prevent.
 */
const aCompletedReceiptOwesItsOwnerAReply = {
  id: "a-completed-receipt-owes-its-owner-a-reply",
  what: "a completed receipt settles the canonical turn only together with its owner reply",
  file: "src/conversation/turn-coordinator.ts",
  find: "      if (before.outcome === \"COMPLETED\" || observed.value.outcome !== \"COMPLETED\") return observed;",
  replace: "      return observed;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::settles the turn and stores one owner reply addressed to the Telegram message it answers",
    "tests/unit/the-sweep-asks-a-receipt-port-about-every-unresolved-turn.test.ts::completes a turn whose every identity field matches, and stores its owner reply in the same pass",
  ],
};

export default aCompletedReceiptOwesItsOwnerAReply;
