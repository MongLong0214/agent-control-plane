/**
 * #674 — one message must not read as N deliveries because the relay flapped N times.
 *
 * `since` is inclusive by design, so every reconnect re-requests the boundary event and the seam
 * answers `ALREADY_DURABLE`. With that answer counted as an admission, `admitted` tracked
 * reconnect count rather than delivery count — measured by a merge-gate review, which fed one
 * event through a reconnect and watched the tally go from 1 to 2.
 *
 * The mutation gives the replay no reason of its own, which sends it back to the `rejected: null`
 * tail it shared with `DURABLE`. The mark still advances either way — a replay whose mark never
 * moved would be re-requested forever — so nothing else in the file's behaviour changes, and the
 * kill is on the count.
 */
const aReplayDoesNotClimbTheDeliveryCount = {
  id: "a-replay-does-not-climb-the-delivery-count",
  what: "an already-durable answer is counted under its own reason rather than sharing the durable tail",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: '    if (admission === "ALREADY_DURABLE") return { rejected: "admission-already-durable", admission };\n',
  replace: "",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::advances the mark for an already-durable event without counting a second delivery",
  ],
};

export default aReplayDoesNotClimbTheDeliveryCount;
