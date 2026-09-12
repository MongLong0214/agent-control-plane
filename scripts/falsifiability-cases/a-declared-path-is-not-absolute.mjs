/**
 * #833 — Without it `/etc/x` splits into an empty first segment, which the loop skips, and the claim is stored as `etc/x` — a repository-relative path that names a different file than the caller asked for. The refusal exists so that a claim and the thing it protects cannot diverge silently.
 *
 * The anchor is the operand rather than its line: this refusal puts four operands in one
 * condition, and the census credits every operand inside an anchor.
 *
 * Killed by an acquire that is valid in every other respect — the test claims a real path first,
 * so a refusal afterwards means this input was refused rather than that the registry refuses
 * everything.
 */
const aDeclaredPathIsNotAbsolute = {
  id: 'a-declared-path-is-not-absolute',
  what: 'a declared path that is absolute is refused rather than claimed as repository-relative',
  file: "src/claims/claim-registry.ts",
  find: 'separatorsNormalized.startsWith("/")',
  replace: 'false',
  killedBy: [
    'tests/unit/verify-hardening.test.ts::refuses a declared path that is not repository-relative, and normalises the ones that are',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDeclaredPathIsNotAbsolute;
