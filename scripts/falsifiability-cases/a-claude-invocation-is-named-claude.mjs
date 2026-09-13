/**
 * #833 - the ancestry walk recognises a claude process by the name it was executed as.
 *
 * Removing the pattern leaves `firstElement !== undefined`, so the *first* ancestor with any argv
 * at all is taken as the claude process and its argv is searched for a session selector. The walk
 * would then stop at a shell, or at the daemon, and derive a session id from whatever that
 * process's command line happened to contain.
 *
 * This is also the operand that made the first relaunch of the canonical session fail closed on
 * 2026-09-13: launching the versioned binary directly put `.../versions/2.1.268` in argv[0], the
 * pattern refused it, and the claim was denied with a message about process ancestry rather than
 * about the version. The refusal was correct; the launch was wrong.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-claude-invocation-is-named-claude",
  what:
    "the ancestry walk recognises a claude ancestor by argv[0] ending in claude, so the first "
    + "process with any argv is not adopted as the session's runtime",
  file: "src/registry/canonical-self-claim.ts",
  find: " && /(^|\\/)claude$/.test(firstElement)",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::matches only a directly executed binary named claude \u2014 never an interpreter-launched script",
  ],
};
export default c;
