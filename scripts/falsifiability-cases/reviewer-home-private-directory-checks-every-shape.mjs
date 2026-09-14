/**
 * Five operands decide whether a directory is private, and each admits a different intruder: a
 * file where a directory is expected, a symlink standing in for it, another uid's directory, one
 * group- or world-readable, and a path that resolves elsewhere. Keeping only the first admits the
 * other four.
 */
const reviewerHomePrivateDirectoryChecksEveryShape = {
  id: "reviewer-home-private-directory-checks-every-shape",
  what: "a reviewer CODEX_HOME directory is refused unless it is an owner-only, non-symlinked, self-resolving directory",
  file: "src/runtime/reviewer-codex-home.ts",
  find: `  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) fail();`,
  replace: `  if (!stat.isDirectory()) fail();`,
  killedBy: [
    "tests/unit/reviewer-codex-home.test.ts::rejects mode drift before claim without repairing permissions",
  ],
};

export default reviewerHomePrivateDirectoryChecksEveryShape;
