/**
 * The two receipt lanes mint different turn ids for one owner message. Keyed by turn alone, both could
 * queue a reply to it; the anchor check is what makes it one.
 *
 * The replacement keeps `sibling` narrowed rather than reading `if (false)`: the harness compiles
 * every mutant, and under `if (false)` the block's `sibling.nonce` no longer type-checks.
 */
const oneOwnerMessageGetsOneReply = {
  id: "one-owner-message-gets-one-reply",
  what: "a second turn cannot queue a reply to an ingress message another turn already answers",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (sibling) {",
  replace: "  if (sibling?.nonce === \"\") {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::refuses a second turn's reply to an ingress message another turn already answers",
  ],
};

export default oneOwnerMessageGetsOneReply;
