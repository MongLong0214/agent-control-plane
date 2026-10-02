/**
 * Outside the settlement transaction the item and the turn are two commits, the half-written state the
 * lane exists to make unreachable.
 */
const aReplyIsEnqueuedInsideItsSettlement = {
  id: "a-reply-is-enqueued-inside-its-settlement",
  what: "an owner reply cannot be enqueued outside a transaction",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (!db.inTransaction) {",
  replace: "  if (false) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::refuses to enqueue outside the transaction that settles the turn",
  ],
};

export default aReplyIsEnqueuedInsideItsSettlement;
