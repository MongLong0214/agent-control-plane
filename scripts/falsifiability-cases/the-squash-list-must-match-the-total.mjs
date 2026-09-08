/**
 * The count. A collected list must contain exactly the number of commits the PR reports.
 * Removing that comparison lets an incomplete list supply a message that silently leaves
 * out commit content.
 */
const theSquashListMustMatchTheTotal = {
  id: "the-squash-list-must-match-the-total",
  what: "the collected count must equal the exact PR total",
  file: "src/github/github-kernel.ts",
  find: "commits.length !== expectedCount || new Set",
  replace: "false || new Set",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::refuses a collected count that disagrees",
  ],
};

export default theSquashListMustMatchTheTotal;
