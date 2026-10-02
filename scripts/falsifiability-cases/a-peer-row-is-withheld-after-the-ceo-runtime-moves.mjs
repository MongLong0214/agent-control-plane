/**
 * #1044 round 2. A CEO runtime move keeps the generation, so a hand-over that compared only the
 * generation handed a departed runtime's instruction over. The mutation drops the CEO-runtime and
 * channel-identity comparisons together; the killing row moves the CEO onto a runtime with no
 * identity and requires the queued peer message to be withheld with zero writes.
 *
 * The runtime comparison alone has no row of its own: no reachable state changes the CEO runtime
 * while keeping the identity that signed — the old runtime still holds it, or, once stopped, its row
 * marks the identity reused — so its removal is masked by the identity and reuse checks.
 */
const aPeerRowIsWithheldAfterTheCeoRuntimeMoves = {
  id: "a-peer-row-is-withheld-after-the-ceo-runtime-moves",
  what: "a queued peer message is withheld when the CEO runtime that signed it no longer serves the CEO",
  file: "src/ingress/buzz-message.ts",
  find: "    proof[\"ceoSessionId\"] === ceo.sessionId &&\n    ceo.channelIdentity !== null &&\n    sameChannelIdentity(ceo.channelIdentity, source.author) &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::withholds a queued peer message after the CEO's runtime moves within its generation, writing nothing",
  ],
};

export default aPeerRowIsWithheldAfterTheCeoRuntimeMoves;
