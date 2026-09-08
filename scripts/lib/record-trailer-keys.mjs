/**
 * The trailer keys this project records, named once.
 *
 * The list already existed twice — as a regex literal in `verify-trailers-are-parsable.mjs` and as
 * a second copy of the same literal in `merge-pr.mjs`. Two copies of one policy is a policy that
 * drifts, and this one is consulted by the `commit-msg` hook, by CI over a range, by the merge
 * path before it composes a body, and now by the check that the daemon's outgoing merge message
 * never excludes a record. A fifth caller reading a fifth copy is how a key gets added in one
 * place and dropped in another without anything failing.
 *
 * The membership is unchanged from the regex it replaces. Widening it here would silently widen
 * what the `commit-msg` hook refuses, which is a different decision than removing a duplicate.
 *
 * Not exhaustive of what CommitLore writes: `Provenance:` and `Unverified:` appear in records on
 * `main` (see d0d885f) and are absent here, exactly as they were absent from the regex. Anything
 * that must not lose a record should preserve by default and exclude by name, rather than keep
 * only what this list happens to mention.
 */
export const RECORD_TRAILER_KEYS = Object.freeze([
  "Limit",
  "Ruled-out",
  "Warn",
  "Supersedes",
  "Refs",
  "Record-Id",
]);

/** The same set as the anchored line matcher the callers used before it had a name. */
export const RECORD_TRAILER_KEY_PATTERN = new RegExp(`^(${RECORD_TRAILER_KEYS.join("|")}):`);
