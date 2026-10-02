/**
 * #1044 round 3, the review's ACP-1044-04. A queued row whose stored payload is not readable is
 * withheld by itself; it must not throw the claim, which would cost the holder the readable message
 * ahead of it. The mutation reads every row unguarded again.
 */
const anUnreadableRowIsWithheldOnItsOwn = {
  id: "an-unreadable-row-is-withheld-on-its-own",
  what: "an unreadable queued row does not stop the readable message ahead of it",
  file: "src/outbox/outbox.ts",
  find: "        const message = readableMessage(row);\n",
  replace: "        const message = hydrate(row);\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::hands over a readable message ahead of a queued row whose stored payload is not readable",
  ],
};

export default anUnreadableRowIsWithheldOnItsOwn;
