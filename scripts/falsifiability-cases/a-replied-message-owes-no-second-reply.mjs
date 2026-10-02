/**
 * R1041-02: `repliedAt` is the transport accepting the CEO's answer. A completion that arrives after it
 * discharges an obligation that was already met.
 */
const aRepliedMessageOwesNoSecondReply = {
  id: "a-replied-message-owes-no-second-reply",
  what: "a message whose reply the transport accepted is not owed another",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (claim?.[\"repliedAt\"] !== undefined) return true;",
  replace: "  if (false as boolean) return true;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 owes nothing new for a message whose reply the transport already accepted",
  ],
};

export default aRepliedMessageOwesNoSecondReply;
