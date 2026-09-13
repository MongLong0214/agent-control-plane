/**
 * #833 - a binding generation is positive.
 *
 * Generations start at 1 and only advance. Removing the positivity check admits `0` or a negative
 * as an `expectedBindingGeneration`, which then has to be refused by the generation comparison
 * deeper in the claim - and that comparison's message is about the *current* generation, so the
 * operator reads a mismatch where the request was malformed.
 *
 * Its sibling `!Number.isSafeInteger(...)` survived its own mutation and carries a written reason:
 * the suite supplies non-positive generations but never a fractional one.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-expected-generation-is-positive",
  what:
    "a non-positive expectedBindingGeneration is refused as an argument error rather than as a "
    + "generation mismatch",
  file: "src/registry/canonical-self-claim.ts",
  find: " || request.expectedBindingGeneration <= 0",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::rejects a non-positive expected binding generation as an argument error",
  ],
};
export default c;
