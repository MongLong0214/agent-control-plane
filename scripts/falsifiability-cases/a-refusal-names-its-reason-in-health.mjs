/**
 * #1038. Health counted every seam refusal as one `admission-refused`, and on the live daemon 710
 * of 721 of them were the bound CEO's own mentions — which the count alone could not say. The
 * daemon's sink now answers with the reason code, and the tally keys the refusal by it.
 *
 * The mutation folds every coded refusal back into the bare bucket. The killing row requires
 * `admission-refused:BUZZ_PEER_CHANNEL_MISMATCH` and the absence of the bare one.
 */
const aRefusalNamesItsReasonInHealth = {
  id: "a-refusal-names-its-reason-in-health",
  what: "a refused mention is counted in health under its admission reason code",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: "    ? `admission-refused:${code}`\n",
  replace: "    ? \"admission-refused\"\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses a CEO mention on another project's channel with zero writes, and names the reason in health",
  ],
};

export default aRefusalNamesItsReasonInHealth;
