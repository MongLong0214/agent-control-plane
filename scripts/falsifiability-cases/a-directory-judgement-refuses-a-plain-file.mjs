/**
 * #833 — a path this run depends on must be a directory, not merely not-a-symlink.
 *
 * The mutation removes the directory test, leaving `stat.isSymbolicLink()`. A plain file
 * occupying the name is then accepted, and this producer proceeds to write a repository
 * checkout into a path that is a file.
 *
 * The existing symlink case cannot kill this: `statEntry` is `lstatSync`, so a symlink reports
 * `isDirectory() === false` as well and either operand alone refuses it. A regular file is the
 * input only this operand answers.
 *
 * This row replaces an inline one in `verify-guards-are-falsifiable.mjs` that anchored the whole
 * `if (stat.isSymbolicLink() || !stat.isDirectory())` line and mutated it to
 * `if (false && (...))`. That proved the condition is tested as a unit — true, and it was CEO
 * review round 6 defect 1's record — but a line-wide anchor credits every operand on it, so the
 * census read both as watched while only one has a witness.
 *
 * Round 6 defect 1 is preserved and not weakened. `statSync` followed a symlink and reported its
 * *target*'s identity: `dirname(workDir)` resolved through `unsafeGrandparent/link -> safeTarget`
 * (0700, owned by this process) and was judged safe without examining `link` itself. What fixed
 * it was `statEntry` becoming `lstatSync`, and the test that pins it is the symlink case in the
 * same file — which is also precisely why the symlink operand has no independent witness here.
 */
const aDirectoryJudgementRefusesAPlainFile = {
  id: "a-directory-judgement-refuses-a-plain-file",
  what: "an entry this run depends on is refused unless it is a real directory, so a plain file occupying the name cannot be written into",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "!stat.isDirectory()",
  replace: "false",
  killedBy: [
    "tests/unit/repo-factory-producer.test.ts::ensureDirectoryLevel refuses a regular file occupying the name it needs",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aDirectoryJudgementRefusesAPlainFile;
