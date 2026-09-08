/**
 * The scope. A merge commit's message is not composed from the branch's commit messages and the
 * branch's commits survive it individually, so supplying one there adds content GitHub never wrote
 * and removes nothing. Widening the condition is how a narrow fix becomes an unreviewed change to
 * every merge the daemon performs.
 */
const theComposedMessageIsOnlyForASquash = {
  id: "the-composed-message-is-only-for-a-squash",
  what: "only a squash merge states a composed commit message",
  file: "src/github/github-kernel.ts",
  find: '      method === "squash" ? await this.outgoingSquashCommitMessage(owner, repo, input.pullNumber, preflight) : undefined;',
  replace: '      method !== "rebase" ? await this.outgoingSquashCommitMessage(owner, repo, input.pullNumber, preflight) : undefined;',
  killedBy: [
    "tests/unit/github-squash-request.test.ts::leaves non-squash PUT fields unchanged",
  ],
};

export default theComposedMessageIsOnlyForASquash;
