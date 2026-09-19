/**
 * The CEO's #631 boundary, in the one line that enforces it: *"다른 project/conversation/thread/
 * root는 절대 합치지 않는다."*
 *
 * Both operands are load-bearing and neither subsumes the other — a rule that compared only the
 * project would absorb another conversation in the same project, and one that compared only the
 * conversation would absorb another project's room that happens to share a chat id. The row's
 * test supplies a case differing in exactly one field for each.
 */
const aBatchNeverSpansAConversation = {
  id: "a-batch-never-spans-a-conversation",
  what: "an owner batch takes only messages of its own project and conversation",
  file: "src/ingress/owner-batch.ts",
  find: "  message.projectId === scope.projectId && message.conversation === scope.conversation;",
  replace: "  true;",
  killedBy: [
    "tests/unit/three-messages-do-not-become-three-turns.test.ts::never spans a conversation, a project, or both",
  ],
};

export default aBatchNeverSpansAConversation;
