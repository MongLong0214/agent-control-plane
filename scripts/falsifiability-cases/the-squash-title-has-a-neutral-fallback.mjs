/**
 * The fallback. Filtering can remove the entire title when it contains only metadata.
 * The neutral replacement keeps the outgoing title explicit and meaningful; removing it
 * leaves only the pull request number.
 */
const theSquashTitleHasANeutralFallback = {
  id: "the-squash-title-has-a-neutral-fallback",
  what: "a wholly removed title has a neutral explicit replacement",
  file: "src/github/merge-commit-message.ts",
  find: "  return `${title || \"Squash pull request\"} (#${pullNumber})`;",
  replace: "  return `${title} (#${pullNumber})`;",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::uses a neutral PUT title when metadata is the entire",
  ],
};

export default theSquashTitleHasANeutralFallback;
