/**
 * The total. Collection needs a positive safe integer to establish how many commits must
 * be present. Removing that check lets an absent or invalid total start collection
 * without a usable completeness bound.
 */
const theSquashTotalMustBeExact = {
  id: "the-squash-total-must-be-exact",
  what: "an absent or invalid exact total cannot start collection",
  file: "src/github/github-kernel.ts",
  // Keep numeric totals unchanged and unknown totals unusable, but let collection start before the later count check.
  find: "    const expectedCount = pull.commits;\n" +
    "    if (typeof expectedCount !== \"number\" || !Number.isSafeInteger(expectedCount) || expectedCount < 1) {\n" +
    "      throw new Error(`pull request ${pullNumber} has no usable exact commit total`);\n" +
    "    }",
  replace: "    const expectedCount = typeof pull.commits === \"number\" ? pull.commits : NaN;",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::refuses an unusable exact commit total",
  ],
};

export default theSquashTotalMustBeExact;
