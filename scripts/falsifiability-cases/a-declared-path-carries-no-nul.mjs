/**
 * #833 — A NUL is not a separator, so the segment loop keeps it and the path is stored with it. Every consumer that eventually hands the value to a syscall truncates there, so the stored claim and the file actually touched stop being the same path. Nothing else on this line catches it.
 *
 * The anchor is the operand rather than its line: this refusal puts four operands in one
 * condition, and the census credits every operand inside an anchor.
 *
 * Killed by an acquire that is valid in every other respect — the test claims a real path first,
 * so a refusal afterwards means this input was refused rather than that the registry refuses
 * everything.
 */
const aDeclaredPathCarriesNoNul = {
  id: 'a-declared-path-carries-no-nul',
  what: 'a declared path containing a NUL is refused before it can truncate at a C-string boundary',
  file: "src/claims/claim-registry.ts",
  find: 'separatorsNormalized.includes("\\0")',
  replace: 'false',
  killedBy: [
    'tests/unit/verify-hardening.test.ts::refuses a declared path that is not repository-relative, and normalises the ones that are',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDeclaredPathCarriesNoNul;
