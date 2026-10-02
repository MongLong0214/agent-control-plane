/**
 * Neither a signed room nor a claimed scope: nothing durable says where the message came from, so the
 * turn stays in doubt rather than completing with a reply addressed to nobody.
 */
const aReplyNeedsADurableConversation = {
  id: "a-reply-needs-a-durable-conversation",
  what: "a reply is refused when no durable record names the message's conversation",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "    if (thread.scopeDigest === null) {",
  replace: "    if (false) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled when nothing durable names the conversation its message came from",
  ],
};

export default aReplyNeedsADurableConversation;
