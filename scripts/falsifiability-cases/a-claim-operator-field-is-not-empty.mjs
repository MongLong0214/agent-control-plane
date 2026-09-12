/**
 * #833 — The empty string is a string, so the typeof half admits it and this operand is the only thing left. A session uuid, a project id or an approval nonce that is present but empty would otherwise reach the claim as a real value.
 *
 * The anchor is the operand rather than its line, because the census credits every operand inside
 * an anchor and this parser puts four of them in one condition.
 */
const aClaimOperatorFieldIsNotEmpty = {
  id: 'a-claim-operator-field-is-not-empty',
  what: 'an empty string is refused rather than admitted as a present field',
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: 'value.length > 0',
  replace: 'true',
  killedBy: [
    "tests/unit/a-claim-operator-request-names-every-missing-field.test.ts::refuses each field's absence, its wrong type, and its empty spelling",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aClaimOperatorFieldIsNotEmpty;
