/**
 * Every arm executes the hard link the run holds, never the path the launcher resolved to.
 *
 * The launcher is a symlink the updater re-points, and the version file behind it is one the
 * updater renames over and deletes. A hard link in a private directory names the digested inode
 * through all three moves; the resolved path does not survive any of them. The killing row makes
 * the three moves and reads the held name after each.
 */
const everyArmExecutesTheHeldLink = {
  id: "every-arm-executes-the-held-link",
  what: "the qualification run executes a hard link to the digested inode, not the resolved launcher path",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      executable: held,\n",
  replace: "      executable: path,\n",
  killedBy: [
    "tests/feasibility/wake-transport-image-hold.test.ts::the held image outlives the updater re-pointing the launcher, renaming a new file over it, and deleting it",
  ],
};

export default everyArmExecutesTheHeldLink;
