/**
 * The transitional shape (the grant deployed before #575) has to keep matching until the owner
 * narrows the App in GitHub settings, and the narrowed target shape has to already match so that
 * narrowing needs no coordinated deploy.
 *
 * The mutation upgrades the narrowed shape's `metadata` entry to `write`, so it demands a level
 * the actual narrowed grant (`metadata: read`) does not have. Only the transitional shape would
 * still match — reproducing exactly the ordering deadlock #575 exists to remove.
 *
 * `metadata` is the entry to mutate because the two-line window `issues` → `metadata` occurs only
 * in the narrowed shape: the transitional one carries `merge_queues` between them. A single-line
 * selector on any permission this shape shares with the transitional one would match twice, and
 * the harness requires each `find` to match its file exactly once.
 *
 * Migrated out of the array in `verify-guards-are-falsifiable.mjs` by #741. Retargeted from the
 * `actions` entry by the change that removed it (see credential-store.ts).
 */
const narrowedPost575ShapeIsApproved = {
  id: "narrowed-post-575-shape-is-approved",
  what: "the narrowed post-575 target shape is present in the approved list, not only the transitional one",
  file: "src/github/credential-store.ts",
  find: '    issues: "write",\n    metadata: "read",\n',
  replace: '    issues: "write",\n    metadata: "write",\n',
  killedBy: [
    "tests/unit/github-app-credential-store.test.ts::accepts the narrowed post-575 target grant shape with merge_queues and statuses dropped",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default narrowedPost575ShapeIsApproved;
