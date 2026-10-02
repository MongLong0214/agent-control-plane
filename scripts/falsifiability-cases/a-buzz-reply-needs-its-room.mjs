/**
 * R1041-01: a Buzz reply goes back to the room the signed envelope names, and nowhere else.
 */
const aBuzzReplyNeedsItsRoom = {
  id: "a-buzz-reply-needs-its-room",
  what: "a Buzz reply is refused when the envelope names no room",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "    const room = textOf(payload[\"conversation\"]);",
  replace: "    const room = textOf(payload[\"conversation\"]) ?? \"unaddressed\";",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::leaves the turn unsettled for R1041-01 a Buzz message whose envelope names no room",
  ],
};

export default aBuzzReplyNeedsItsRoom;
