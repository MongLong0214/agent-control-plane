/**
 * SPEC §2.4: a paragraph earlier than the last is a record block if and only if every line in it is
 * a trailer *and* it declares `Record-Id:`. Paragraph structure is therefore load-bearing, not
 * cosmetic — over-collapsing the blank lines left by a removed line merges the trailer block into
 * the prose above it, and every record on the branch is demoted to body text while every line it
 * contains is still present. A line-level preservation check cannot see that.
 */
const aRecordBlockIsStillARecordBlockAfterFiltering = {
  id: "a-record-block-is-still-a-record-block-after-filtering",
  what: "filtering leaves the paragraph boundaries that make a record block a record block",
  file: "src/github/merge-commit-message.ts",
  find: '    .replace(/\\n{3,}/g, "\\n\\n")',
  replace: '    .replace(/\\n{2,}/g, "\\n")',
  killedBy: [
    "tests/unit/merge-commit-message.test.ts::recognises the same record blocks, by the same identities, before and after",
  ],
};

export default aRecordBlockIsStillARecordBlockAfterFiltering;
