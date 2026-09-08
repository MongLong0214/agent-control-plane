/**
 * Order, which "every line is present" does not cover. A composer that gathers the record lines
 * into a set, sorts them, or groups them by key satisfies a membership check and silently reorders
 * the decisions — `Follows:` and `Supersedes:` chains read against a sequence, and a reader of
 * `main` has only the sequence to read. Reversing the branch is the smallest mutation that keeps
 * every line and changes only the order.
 */
const theComposedMessageKeepsTheBranchOrder = {
  id: "the-composed-message-keeps-the-branch-order",
  what: "the composition keeps the branch's commits in the order they were written",
  file: "src/github/merge-commit-message.ts",
  find: "  return commits",
  replace: "  return [...commits].reverse()",
  killedBy: [
    "tests/unit/merge-commit-message.test.ts::keeps every record line in the order the branch wrote it, repeats included",
  ],
};

export default theComposedMessageKeepsTheBranchOrder;
