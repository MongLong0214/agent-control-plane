/**
 * #833 - the ancestry walk recognises a claude process by the name it was executed as.
 *
 * Removing the pattern leaves `firstElement !== undefined`, so the *first* ancestor with any argv
 * at all is taken as the claude process and its argv is searched for a session selector. The walk
 * would then stop at a shell, or at the daemon, and derive a session id from whatever that
 * process's command line happened to contain.
 *
 * The native updater instead executes `.../claude/versions/x.y.z` directly, so that exact form is
 * also admitted. `latest`, a non-semver version, any suffix, and every other binary remain outside
 * the two allowed forms.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-claude-invocation-is-named-claude",
  what:
    "the ancestry walk recognises only a claude basename or exact native versioned argv[0], so the "
    + "first process with any argv is not adopted as the session's runtime",
  file: "src/registry/canonical-self-claim.ts",
  find:
    "  return firstElement !== undefined &&\n"
    + "    (/(^|\\/)claude$/.test(firstElement) || NATIVE_VERSIONED_CLAUDE_PATH.test(firstElement));\n",
  replace: "  return firstElement !== undefined;\n",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::matches only a directly executed binary named claude or an exact native versioned Claude path",
  ],
};
export default c;
