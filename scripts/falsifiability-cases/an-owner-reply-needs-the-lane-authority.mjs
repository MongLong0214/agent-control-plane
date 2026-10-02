/**
 * R1041-03: only the holder of the database's owner-reply authority — the turn coordinator — can
 * create an obligation, so no transaction elsewhere can write an item with no settlement beside it.
 */
const anOwnerReplyNeedsTheLaneAuthority = {
  id: "an-owner-reply-needs-the-lane-authority",
  what: "an owner reply is refused to a caller without this database's authority",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (ISSUED_OWNER_REPLY_AUTHORITIES.get(db.identity) !== authority) {",
  replace: "  if (false as boolean) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::refuses a caller that does not hold this database's owner-reply authority, and issues it once",
  ],
};

export default anOwnerReplyNeedsTheLaneAuthority;
