/**
 * #833 — A fractional generation is neither absent nor empty, so the three string operands do not see it. Witnessed by 1.5.
 *
 * The anchor is the operand rather than its line, because the census credits every operand inside
 * an anchor and this parser puts four of them in one condition.
 */
const aClaimOperatorGenerationIsAWholeNumber = {
  id: 'a-claim-operator-generation-is-a-whole-number',
  what: 'a fractional expected binding generation is refused before it can be compared against a stored one',
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: '!Number.isSafeInteger(expectedBindingGeneration)',
  replace: 'false',
  killedBy: [
    "tests/unit/a-claim-operator-request-names-every-missing-field.test.ts::refuses each field's absence, its wrong type, and its empty spelling",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aClaimOperatorGenerationIsAWholeNumber;
