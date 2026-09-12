/**
 * #833 — The ERROR half of the same pair. It needs its own row because its own parameterised case is the only thing that distinguishes it: with this operand removed the STOPPED case still passes.
 *
 * The anchor is the operand itself rather than its line: this condition puts two operands on each
 * of two lines, and the census credits every operand inside an anchor, so a line-wide anchor would
 * name two while testing one.
 */
const anErroredSessionSecretStopsAuthenticating = {
  id: 'an-errored-session-secret-stops-authenticating',
  what: 'the correct secret of an ERROR session no longer authenticates it',
  file: "src/session/session-registry.ts",
  find: 'row.lifecycle === SessionLifecycle.ERROR',
  replace: 'false',
  killedBy: [
    'tests/unit/trusted-core.test.ts::terminal ERROR secret is invalid while successor and immutable-hash guards remain intact',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anErroredSessionSecretStopsAuthenticating;
