/**
 * A turn whose messages disagree on their conversation has no single place to answer; guessing one is
 * how a reply reaches the wrong room.
 */
const aReplyNeverSpansAConversation = {
  id: "a-reply-never-spans-a-conversation",
  what: "a reply is refused when the turn's messages name different conversations",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "    if (canonicalJson(admitted.value.thread) !== canonicalJson(answered.value.thread)) {",
  replace: "    if (false) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled when its messages do not name one conversation to answer",
  ],
};

export default aReplyNeverSpansAConversation;
