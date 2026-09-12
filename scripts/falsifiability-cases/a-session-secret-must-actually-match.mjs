/**
 * #833 — The neighbouring `!validStoredHash` refuses an unreadable stored hash, and a wrong secret against a *readable* one is what this operand alone catches. Killed by the assertion that `verifySecret(sessionId, "wrong")` is refused while the session is READY and its hash is intact.
 *
 * The anchor is the operand itself rather than its line: this condition puts two operands on each
 * of two lines, and the census credits every operand inside an anchor, so a line-wide anchor would
 * name two while testing one.
 */
const aSessionSecretMustActuallyMatch = {
  id: 'a-session-secret-must-actually-match',
  what: 'a session secret that does not match the stored hash is refused, and not only because the hash was unreadable',
  file: "src/session/session-registry.ts",
  find: '!matches',
  replace: 'false',
  killedBy: [
    'tests/unit/trusted-core.test.ts::terminal STOPPED secret is invalid while successor and immutable-hash guards remain intact',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aSessionSecretMustActuallyMatch;
