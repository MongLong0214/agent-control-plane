/**
 * The head. A complete-looking list can still belong to an older PR head. Requiring its last
 * commit to match the checked head keeps the composed message tied to the revision being
 * merged; removing that check lets a stale list supply the message.
 */
const theSquashListMustEndAtTheHead = {
  id: "the-squash-list-must-end-at-the-head",
  what: "the collected list must end at the checked PR head",
  file: "src/github/github-kernel.ts",
  find: "    if (commits.at(-1)!.sha !== pull.head.sha) {",
  replace: "    if (false) {",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::refuses a collected list that does not end at the exact head",
  ],
};

export default theSquashListMustEndAtTheHead;
