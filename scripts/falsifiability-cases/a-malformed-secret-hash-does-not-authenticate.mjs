/**
 * #833 - the stored hash's shape is checked before it is read as one.
 *
 * `src/session/session-registry.ts` was one of the four files on the PRIMARY_CTO authority path
 * that `verify-refusal-operands-are-watched.mjs` excluded, on a per-file boilerplate reason
 * ("tracked as its own unit") naming a unit that did not exist. This row is part of bringing the
 * file into the census.
 *
 * Removing the regex leaves `typeof row.session_secret_hash === "string"`, so a row whose hash is
 * a string of the wrong shape is treated as valid: `Buffer.from("not-a-hash", "hex")` does not
 * throw - it returns a short buffer, stopping at the first non-hex pair - and `timingSafeEqual`
 * *does* throw on a length mismatch. So the mutant turns an authentication refusal into an
 * exception out of `verifySecret`, on a path a caller reaches by session id.
 *
 * Such a row is reachable rather than hypothetical, which is why this is a row and not a reason.
 * `sessions_secret_hash_immutable` fires only `WHEN OLD.session_secret_hash IS NOT NULL`, so a row
 * that is already null is outside it, and the column was added by migration - every session
 * predating that migration has NULL there while `secretStorageAvailable()` becomes true for the
 * whole table at once.
 *
 * The anchor is scoped to this operand alone rather than to the whole assignment. `dbe5abe` ruled
 * out the wider form - "the census credits every operand inside an anchor, so one anchor would
 * name three operands while testing one mutation" - and a line-spanning anchor here would have
 * credited `typeof row.session_secret_hash === "string"`, which this mutation does not exercise.
 * That operand carries a written reason instead: removing it leaves the regex to coerce NULL to
 * the string "null" and reject it, measured, mutant SURVIVED.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-malformed-secret-hash-does-not-authenticate",
  what:
    "a stored secret hash that is not a hash refuses authentication rather than throwing out of "
    + "timingSafeEqual on a short buffer",
  file: "src/session/session-registry.ts",
  find: " && SESSION_SECRET_HASH.test(row.session_secret_hash)",
  replace: "",
  killedBy: ["tests/unit/a-row-whose-secret-hash-is-not-a-hash-does-not-authenticate.test.ts::refuses a row whose hash is a string but not a hash"],
};
export default c;
