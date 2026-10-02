/**
 * Only a native Darwin start token is placed on the wall clock; any other token is refused rather
 * than estimated. The mutant places a non-Darwin token at the epoch instead of refusing it.
 */
const c = {
  id: "host-session-registry-non-darwin-token-refused",
  what: "a registry entry under a start token that is not a native Darwin token is refused as unverifiable",
  file: "src/registry/canonical-self-claim.ts",
  find: "if (!darwin) return null;",
  replace: "if (!darwin) return 0n;",
  killedBy: [
    "tests/unit/canonical-host-session-registry-non-darwin.test.ts::refuses a linux-clk registry entry under --continue and under a matching argv selector, consulting neither /proc nor getconf",
  ],
};
export default c;
