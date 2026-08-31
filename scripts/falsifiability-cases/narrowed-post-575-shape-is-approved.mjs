/**
 * The transitional shape (the grant deployed before #575) has to keep matching until the owner
 * narrows the App in GitHub settings, and the narrowed target shape has to already match so that
 * narrowing needs no coordinated deploy. Downgrading the narrowed shape's `actions` entry to
 * `write` makes it require a permission level the actual narrowed grant (`actions: read`) does not
 * have, so only the transitional shape would still match — reproducing exactly the ordering
 * deadlock #575 exists to remove.
 *
 * Migrated out of the array in `verify-guards-are-falsifiable.mjs` by #741, unchanged.
 */
const narrowedPost575ShapeIsApproved = {
  id: "narrowed-post-575-shape-is-approved",
  what: "the narrowed post-575 target shape is present in the approved list, not only the transitional one",
  file: "src/github/credential-store.ts",
  find: '    actions: "read",\n',
  replace: '    actions: "write",\n',
  killedBy: [
    "tests/unit/github-app-credential-store.test.ts::accepts the narrowed post-575 target grant shape with merge_queues and statuses dropped and actions read added",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default narrowedPost575ShapeIsApproved;
