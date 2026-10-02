/**
 * #1044 round 3. Admission found the receiving CTO on the room the event arrived on. If that CTO's
 * project channel is later cleared or moved, a fresh event there is refused as a channel mismatch,
 * and the queued one must not be handed over either. The mutation drops the channel comparison.
 */
const aPeerRowIsWithheldWhenTheCtoChannelChanged = {
  id: "a-peer-row-is-withheld-when-the-cto-channel-changed",
  what: "a queued peer message is withheld once the receiving CTO no longer answers on the room it arrived on",
  file: "src/ingress/buzz-message.ts",
  find: "    ctoChannel !== null &&\n    source.conversation === ctoChannel\n",
  replace: "    true\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::withholds a queued peer message once the receiving CTO's channel is another project's room, writing nothing",
  ],
};

export default aPeerRowIsWithheldWhenTheCtoChannelChanged;
