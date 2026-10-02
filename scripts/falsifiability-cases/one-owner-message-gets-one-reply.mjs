/**
 * R1041-02: the two receipt lanes mint different turn ids for one owner message. Without the coverage
 * check a canonical batch and an ingress claim on one of its messages each queue a reply.
 */
const oneOwnerMessageGetsOneReply = {
  id: "one-owner-message-gets-one-reply",
  what: "a turn whose messages another item already answers queues no second reply",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (covered.length > 0) {",
  replace: "  if (false as boolean) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-02 owes one reply when a canonical batch settles before an ingress claim on one of its messages",
  ],
};

export default oneOwnerMessageGetsOneReply;
