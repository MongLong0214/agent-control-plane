/**
 * #674. Absence of a collaboration authority means no collaboration, not permissive
 * collaboration.
 *
 * Every host runs today without one, so this is the condition the whole fleet is in: the fourth
 * constructor argument is absent, and `#senderRoleFor` must answer `null` for every non-owner.
 * The failure direction that matters is the permissive one — an unconfigured deployment silently
 * accepting role-addressed envelopes from any allowlisted relay identity — and it is one token
 * away, because the same line decides both.
 *
 * Mutating the null branch to return the owner sentinel is that one token. It is killed by the
 * case that builds an ingress with three arguments, which is how production builds it on every
 * host that has not declared an authority.
 */
const noAuthorityMeansNoSecondDoor = {
  id: "no-authority-means-no-second-door",
  what: "a deployment with no collaboration authority admits no role sender",
  file: "src/ingress/buzz-message.ts",
  find: "    if (this.collaboration === null) return null;\n",
  replace: "    if (this.collaboration === null) return OWNER_SENDER;\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::opens no second door on a deployment that declares no collaboration authority",
  ],
};

export default noAuthorityMeansNoSecondDoor;
