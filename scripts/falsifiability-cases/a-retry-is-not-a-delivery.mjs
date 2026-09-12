/**
 * #674 — a retryable admission is the case an operator most needs told apart from a delivery.
 *
 * `RETRY` means the addressed role is between holders: nothing was spent, the mark did not move,
 * the socket was dropped and the event will be asked for again. In production it is
 * `ROLE_PEER_ABSENT` (`SUBSCRIBER_RETRY_CODES`), so the state it describes is "the role's peer is
 * down and no message is reaching any session" — and before this reason existed the tally
 * reported it as one delivery with an empty `rejections`, which sends the operator to look at the
 * relay instead of at the peer.
 *
 * The mutation drops the reason and leaves the answer unattributed, which is what the code did
 * before. It survives every assertion about the mark and the socket — those are unchanged — and
 * dies only on the tally, which is the point: the behaviour was already right and the *report* was
 * wrong.
 */
const aRetryIsNotADelivery = {
  id: "a-retry-is-not-a-delivery",
  what: "a retryable admission is counted under its own reason, not left unattributed",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: '      return { rejected: "admission-retry-pending", admission };\n',
  replace: "      return { rejected: null, admission };\n",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::does not advance the mark for a retryable admission, and drops the socket",
  ],
};

export default aRetryIsNotADelivery;
