/**
 * #833 — Zero is a safe integer, so the other half never sees it. Both halves are witnessed by the same test because it drives both inputs through one claim each.
 *
 * The anchor is the operand rather than its line, because the census credits every operand inside
 * an anchor.
 */
const aClaimGenerationIsPositive = {
  id: 'a-claim-generation-is-positive',
  what: 'a zero or negative expected binding generation is refused as an argument error',
  file: "src/registry/canonical-self-claim.ts",
  find: 'request.expectedBindingGeneration <= 0',
  replace: 'false',
  killedBy: [
    'tests/unit/canonical-self-claim.test.ts::rejects a non-positive expected binding generation as an argument error',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aClaimGenerationIsPositive;
