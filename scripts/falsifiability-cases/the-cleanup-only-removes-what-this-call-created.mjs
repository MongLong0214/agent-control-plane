/**
 * #833 — a refused judgement removes the directory only when this call is what created it.
 *
 * The mutation makes the `justCreated` operand always true. A pre-existing directory that is
 * judged unsafe — someone else's directory, which this run merely found — is then deleted by the
 * refusal that was supposed to protect it. That is the worst available outcome on this path: the
 * guard exists because the entry cannot be trusted, and the mutant answers distrust with `rm -rf`.
 */
const theCleanupOnlyRemovesWhatThisCallCreated = {
  id: "the-cleanup-only-removes-what-this-call-created",
  what: "the self-cleanup after a refused judgement deletes only a directory this call created, never one it found already there",
  file: "src/bootstrap/repo-factory-producer.ts",
  // Anchored so it names `justCreated` and not `!judged.allowed`: a `find` spanning both
  // operands would credit the one this row does not test, which is how a disjunction ends up
  // half-covered with a green census.
  find: "&& justCreated) {",
  replace: "&& true) {",
  killedBy: [
    "tests/unit/repo-factory-producer.test.ts::ensureDirectoryLevel refuses a regular file occupying the name it needs",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theCleanupOnlyRemovesWhatThisCallCreated;
