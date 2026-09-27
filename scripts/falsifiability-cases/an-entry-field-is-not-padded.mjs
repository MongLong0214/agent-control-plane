/**
 * Review #1006/sol ACP1006-R1-01. The blank check and the uniqueness check both run on the
 * configured strings, but `SessionRegistry.bindBuzzActor` trims the actor id before the
 * `sessions_buzz_actor` unique index ever sees it. So `"a"` and `" a "` were two entitlements in
 * this module and one Buzz channel identity in the database: a set holding both constructed, both
 * sessions claimed, and the second bound the first entry's identity.
 *
 * Padding is refused rather than trimmed on purpose. Trimming here would make this function a
 * second authority over the value every other reader compares, which is the shape of defect the
 * per-project set was introduced to remove.
 */
const c = {
  id: "an-entry-field-is-not-padded",
  what: "a configured entry whose field is surrounded by whitespace constructs nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: "      if (value !== value.trim()) {",
  replace: "      if (value !== value.trim() && false) {",
  // One `-t` pattern for the three `it.each` cases the mutation reaches at once. Deliberately the
  // distinctive tail rather than the shared "fails closed on a" prefix, which also selects the
  // blank-field cases this mutation does not touch.
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::padded with whitespace, which uniqueness would not have caught",
  ],
};
export default c;
