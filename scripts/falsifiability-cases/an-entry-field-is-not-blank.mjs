/**
 * #1005 - the per-entry version of `a-deployment-value-is-not-blank`.
 *
 * The scalar config fields have had this check since #760; the set's fields are the same kind of
 * deployment-private value and arrive by the same route — an environment variable a launcher may
 * export empty. A blank `projectId` would entitle the session to the role key `PRIMARY_CTO:` and a
 * blank `buzzActorId` would be handed to `bindBuzzActor` as the identity the adopted CTO speaks as;
 * neither field has any other check that would catch an empty string.
 *
 * Review #1006/sol: the row's original witness was three `it.each` cases, all spelled with a
 * whitespace-only value (`"  "`). With this operand removed, whitespace-only is still refused —
 * by the *padding* check two lines below (`value !== value.trim()`) — so those three cases killed
 * the row on a different thrown message, never on the constructor accepting what it should have
 * refused. A true empty string does not trip padding (`"" === "".trim()`), so it is the operand's
 * unique coverage: with the operand gone, an empty `projectId` or `buzzActorId` constructs nothing
 * to stop it, and the entry is accepted. A blank `sessionUuid` is not part of that unique coverage
 * — it is still caught, mutated or not, by the UUID pattern one line later (`""` matches no UUID).
 * The `it.each` now carries both spellings; `killedBy`'s prefix still selects every case.
 *
 * Spelled `value.trim() === ""` rather than `.length === 0` so that this row and
 * `a-deployment-value-is-not-blank` each have a `find` that matches the file exactly once; the
 * harness refuses an anchor that does not. Measured before this row was written: removing the
 * operand leaves the `typeof` half and three cases fail.
 */
const c = {
  id: "an-entry-field-is-not-blank",
  what: "an empty projectId or buzzActorId in a configured entry constructs nothing — the operand's only unique coverage, since whitespace-only is also caught by the padding check two lines below and a blank sessionUuid by the UUID pattern one line later",
  file: "src/registry/canonical-self-claim.ts",
  find: " || value.trim() === \"\"",
  replace: "",
  // One `-t` pattern covering every `it.each` case, for the same reason as
  // `the-adoptable-set-refuses-repeated-fields`: the mutation reaches every field, so the row's
  // witness is every case sharing this prefix and not whichever one happens to be listed first.
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::fails closed on a blank",
  ],
};
export default c;
