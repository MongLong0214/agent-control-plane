/**
 * PR #1043 review round 2, RF1043-04 — Without it `required_pull_request_reviews: {}` reads as no review requirement, and matching protection is receipted as verified.
 */
const rf1043ReviewCountPresentWithoutAValueIsUnobserved = {
  id: "rf1043-review-count-present-without-a-value-is-unobserved",
  what: "a review requirement GitHub returned without a count is unobserved, not \"no reviews required\"",
  file: "src/bootstrap/github-write-port.ts",
  find: "      reviews == null ? null : typeof reviewCount === \"number\" ? reviewCount : UNOBSERVED,\n",
  replace: "      reviews == null ? null : typeof reviewCount === \"number\" ? reviewCount : null,\n",
  killedBy: ["tests/unit/github-write-port.test.ts"],
};

export default rf1043ReviewCountPresentWithoutAValueIsUnobserved;
