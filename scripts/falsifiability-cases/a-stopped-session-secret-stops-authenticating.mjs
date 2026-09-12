/**
 * #833 — The secret is still correct and the stored hash is still intact — the lifecycle is the only thing that changed, so the other three operands all pass. Killed by the STOPPED case of the parameterised terminal test, which authenticates successfully first and then transitions.
 *
 * The anchor is the operand itself rather than its line: this condition puts two operands on each
 * of two lines, and the census credits every operand inside an anchor, so a line-wide anchor would
 * name two while testing one.
 */
const aStoppedSessionSecretStopsAuthenticating = {
  id: 'a-stopped-session-secret-stops-authenticating',
  what: 'the correct secret of a STOPPED session no longer authenticates it',
  file: "src/session/session-registry.ts",
  find: 'row.lifecycle === SessionLifecycle.STOPPED',
  replace: 'false',
  killedBy: [
    'tests/unit/trusted-core.test.ts::terminal STOPPED secret is invalid while successor and immutable-hash guards remain intact',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aStoppedSessionSecretStopsAuthenticating;
