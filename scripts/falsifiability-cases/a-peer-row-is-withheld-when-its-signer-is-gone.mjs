/**
 * #1044 round 2. The CEO binding can keep naming the same runtime after that runtime stops, and a
 * stopped runtime speaks as no Buzz channel identity. The mutation drops the identity comparison
 * alone; the killing row stops the CEO runtime and requires the queued peer message to be withheld.
 */
const aPeerRowIsWithheldWhenItsSignerIsGone = {
  id: "a-peer-row-is-withheld-when-its-signer-is-gone",
  what: "a queued peer message is withheld once the CEO runtime no longer speaks as the identity that signed it",
  file: "src/ingress/buzz-message.ts",
  find: "    ceo.channelIdentity !== null &&\n    sameChannelIdentity(ceo.channelIdentity, source.author) &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::withholds a queued peer message once the CEO's runtime no longer speaks as the identity that signed it, writing nothing",
  ],
};

export default aPeerRowIsWithheldWhenItsSignerIsGone;
