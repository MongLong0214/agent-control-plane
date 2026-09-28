/**
 * Every arm executes the hard link the run holds, never the path the launcher resolved to.
 *
 * The launcher is a symlink the updater re-points, and the version file behind it is one the
 * updater renames over and deletes. A hard link in a private directory names the digested inode
 * through all three moves; the resolved path does not survive any of them. The killing row makes
 * the three moves and reads the held name after each.
 *
 * This row is about what the hold *names*, measured by a test that reads that name. That the name is
 * what an arm starts is carried the rest of the way by two things: `spawnPlanFor` takes only
 * `{ executable }`, so the resolved launcher path is not a field the spawn decision can reach, and
 * `the-arm-starts-the-plan-and-nothing-beside-it` drives the real probe through an injected process
 * boundary and requires that the executable started is the held link the plan named. That call was
 * previously called live-only here; a reviewer refuted it by executing the branch offline.
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
