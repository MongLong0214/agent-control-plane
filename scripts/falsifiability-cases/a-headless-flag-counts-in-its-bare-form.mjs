/**
 * #833 - a headless flag counts in its separated form.
 *
 * `isInteractiveClaudeInvocation` decides whether the process that may hold the canonical claim is
 * the interactive shape. Removing the exact-match half leaves only the `flag=` prefix test, so
 * `--print` written the ordinary way stops counting and a headless invocation is admitted as
 * interactive - the shape the qualification receipt explicitly says it never observed.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-headless-flag-counts-in-its-bare-form",
  what:
    "a headless flag written in its separated form still marks the invocation headless",
  file: "src/registry/canonical-self-claim.ts",
  find: "token === flag || ",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::reads interactivity from the absence of a headless flag, honoring the -- boundary",
  ],
};
export default c;
