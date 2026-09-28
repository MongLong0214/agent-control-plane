/**
 * Every arm executes the hard link the run holds, never the path the launcher resolved to.
 *
 * The launcher is a symlink the updater re-points, and the version file behind it is one the
 * updater renames over and deletes. A hard link in a private directory names the digested inode
 * through all three moves; the resolved path does not survive any of them. The killing row makes
 * the three moves and reads the held name after each.
 *
 * **What this row does not reach**, narrowed after a review found it claimed the arm's execution:
 * it is about what the hold *names*, measured by a test that reads that name. What an arm starts is
 * now structurally narrowed instead of asserted -- `spawnPlanFor` takes only `{ executable }`, so
 * the resolved launcher path is not a field the spawn decision can reach -- and the plan's own row
 * is `the-arm-executes-the-invocation-it-records`. The `spawn()` call itself runs only in a live
 * arm.
 */
const everyArmExecutesTheHeldLink = {
  id: "every-arm-executes-the-held-link",
  what: "the image hold names a hard link to the digested inode, not the resolved launcher path, as what an arm is to execute",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      executable: held,\n",
  replace: "      executable: path,\n",
  killedBy: [
    "tests/feasibility/wake-transport-image-hold.test.ts::the held image outlives the updater re-pointing the launcher, renaming a new file over it, and deleting it",
  ],
};

export default everyArmExecutesTheHeldLink;
