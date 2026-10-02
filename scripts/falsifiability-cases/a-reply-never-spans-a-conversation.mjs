/**
 * Every source proves its own address; a turn whose messages name different conversations has no
 * single place to answer.
 */
const aReplyNeverSpansAConversation = {
  id: "a-reply-never-spans-a-conversation",
  what: "a reply is refused when the turn's messages name different conversations",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "    if (own.value.conversation !== answered.value.conversation) {",
  replace: "    if (false as boolean) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled when its messages do not name one conversation to answer",
  ],
};

export default aReplyNeverSpansAConversation;
