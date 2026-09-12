/**
 * #833 — a contract-change run at CEO review may not complete, which only the kind operand decides.
 *
 * A pure guard in one of the small excluded files: no fixture, so its operands are
 * answerable with a row rather than owed. The anchor is the operand rather than its line,
 * because the census credits every operand inside an anchor.
 */
const onlyABootstrapRunCompletesFromCeoReview = {
  id: 'only-a-bootstrap-run-completes-from-ceo-review',
  what: 'a contract-change run at CEO review may not complete, which only the kind operand decides',
  file: 'src/domain/run-state.ts',
  find: 'kind === RunKind.PROJECT_BOOTSTRAP',
  replace: 'true',
  killedBy: [
    'tests/unit/the-small-guards-have-witnesses.test.ts::a bootstrap run at CEO review may complete, and nothing else may',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default onlyABootstrapRunCompletesFromCeoReview;
