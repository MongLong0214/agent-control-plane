/**
 * #833 - the constant-time comparison is what the refusal rests on.
 *
 * Removing `!matches` leaves `!validStoredHash` and the two lifecycle tests, so any secret
 * authenticates any session whose stored hash is well-formed and whose lifecycle is live. That is
 * the whole of session authentication: `verifySecret` is what proves a caller *is* the session it
 * names, and `bindBuzzActor` and the role-attachment path both begin with it.
 *
 * The anchor is scoped to this operand alone, per the alternative `dbe5abe` ruled out: an anchor
 * spanning the refusal's first line would also have credited `!validStoredHash`, which this
 * mutation leaves in place. That one carries a written reason - it is defence in depth behind this
 * comparison, since a malformed hash makes `stored` all zeros and the denial lands here anyway.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-wrong-secret-does-not-authenticate",
  what:
    "a secret that does not hash to the stored value does not authenticate the session",
  file: "src/session/session-registry.ts",
  find: " || !matches",
  replace: "",
  killedBy: ["tests/unit/binding-r2.test.ts::issues an opaque session secret when secret storage is available"],
};
export default c;
