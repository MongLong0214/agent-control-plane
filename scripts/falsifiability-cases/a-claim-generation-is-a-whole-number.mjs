/**
 * #833 — 1.5 is not <= 0, so the comparison half never sees it. Without this operand the value reaches the optimistic-concurrency comparison and is answered as stale — a different answer to a different question, and one an operator would act on differently.
 *
 * The anchor is the operand rather than its line, because the census credits every operand inside
 * an anchor.
 */
const aClaimGenerationIsAWholeNumber = {
  id: 'a-claim-generation-is-a-whole-number',
  what: 'a fractional expected binding generation is refused as an argument error rather than compared against a stored one',
  file: "src/registry/canonical-self-claim.ts",
  find: '!Number.isSafeInteger(request.expectedBindingGeneration)',
  replace: 'false',
  killedBy: [
    'tests/unit/canonical-self-claim.test.ts::rejects a non-positive expected binding generation as an argument error',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aClaimGenerationIsAWholeNumber;
