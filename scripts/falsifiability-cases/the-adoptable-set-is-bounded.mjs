/**
 * #1005 - the bound on the configured set.
 *
 * The bound is not a safety property of the claim path; it is the statement that this is a local
 * deployment. `ACP_CTO_BINDING_TARGETS_JSON` carries the same kind of cap for the same reason, and
 * without one a misassembled environment value is accepted and every entry's identity is added to
 * the claim listener's `IngressGuard` allowlist.
 *
 * `>` -> `>=` would refuse the bound itself, so the mutation is the other direction: the comparison
 * is made unreachable while still reading both operands.
 */
const c = {
  id: "the-adoptable-set-is-bounded",
  what: "a configured set larger than MAX_CANONICAL_ADOPTABLE_SESSIONS constructs nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: "    if (config.canonicalSessions.length > MAX_CANONICAL_ADOPTABLE_SESSIONS) {",
  replace: "    if (config.canonicalSessions.length > MAX_CANONICAL_ADOPTABLE_SESSIONS && false) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::fails closed above the adoptable-set bound",
  ],
};
export default c;
