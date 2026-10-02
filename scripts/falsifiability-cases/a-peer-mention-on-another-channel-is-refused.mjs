/**
 * #1038. A peer turn arrives on the addressed PRIMARY_CTO's project channel — its session's
 * `buzz_address` — or not at all. The subscriber is configured with several rooms, and a CEO
 * mention of this CTO posted in another project's room is not an instruction for this project.
 *
 * The mutation keeps the NULL refusal and drops only the comparison, so the killing row's event on
 * the other room is admitted.
 */
const aPeerMentionOnAnotherChannelIsRefused = {
  id: "a-peer-mention-on-another-channel-is-refused",
  what: "a CEO mention on a room other than the addressed CTO's project channel is refused",
  file: "src/ingress/buzz-message.ts",
  find: "    if (cto.channel === null || cto.channel !== input.conversation) {\n",
  replace: "    if (cto.channel === null) {\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses a CEO mention on another project's channel with zero writes, and names the reason in health",
  ],
};

export default aPeerMentionOnAnotherChannelIsRefused;
