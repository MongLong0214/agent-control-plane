/**
 * #1005 - the per-entry version of `a-deployment-value-is-not-blank`.
 *
 * The scalar config fields have had this check since #760; the set's fields are the same kind of
 * deployment-private value and arrive by the same route — an environment variable a launcher may
 * export empty. A blank `sessionUuid` is caught one line later by the UUID pattern, but a blank
 * `projectId` would entitle the session to the role key `PRIMARY_CTO:` and a blank `buzzActorId`
 * would be handed to `bindBuzzActor` as the identity the adopted CTO speaks as.
 *
 * Spelled `value.trim() === ""` rather than `.length === 0` so that this row and
 * `a-deployment-value-is-not-blank` each have a `find` that matches the file exactly once; the
 * harness refuses an anchor that does not. Measured before this row was written: removing the
 * operand leaves the `typeof` half and three cases fail.
 */
const c = {
  id: "an-entry-field-is-not-blank",
  what: "a blank sessionUuid, projectId or buzzActorId in a configured entry constructs nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: " || value.trim() === \"\"",
  replace: "",
  // One `-t` pattern covering the three `it.each` cases, for the same reason as
  // `the-adoptable-set-refuses-repeated-fields`: the mutation reaches every field, so the row's
  // witness is all three cases and not whichever one happens to be listed first.
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::fails closed on a blank",
  ],
};
export default c;
