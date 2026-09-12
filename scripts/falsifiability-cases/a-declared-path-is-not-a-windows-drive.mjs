/**
 * #833 — `C:/x` does not start with a slash, so this is the only operand that sees it. Without it the claim is stored as `C:/x`, which is absolute on Windows and a two-segment relative path everywhere else — the same string meaning two different files depending on who reads it.
 *
 * The anchor is the operand rather than its line: this refusal puts four operands in one
 * condition, and the census credits every operand inside an anchor.
 *
 * Killed by an acquire that is valid in every other respect — the test claims a real path first,
 * so a refusal afterwards means this input was refused rather than that the registry refuses
 * everything.
 */
const aDeclaredPathIsNotAWindowsDrive = {
  id: 'a-declared-path-is-not-a-windows-drive',
  what: 'a declared path beginning with a Windows drive letter is refused, which startsWith("/") does not catch',
  file: "src/claims/claim-registry.ts",
  find: '/^[A-Za-z]:($|\\/)/.test(separatorsNormalized)',
  replace: 'false',
  killedBy: [
    'tests/unit/verify-hardening.test.ts::refuses a declared path that is not repository-relative, and normalises the ones that are',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDeclaredPathIsNotAWindowsDrive;
