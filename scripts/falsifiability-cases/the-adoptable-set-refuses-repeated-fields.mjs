/**
 * #1005 - duplicates in the configured set are refused at construction, not resolved later.
 *
 * Each of the three fields fails differently and none fails loudly. A repeated `sessionUuid` makes
 * one entry dead configuration that reads as live, because the entitlement lookup is a `find` and
 * takes the first match. A repeated `projectId` gives one role key two entitled sessions, which is
 * the one-CTO-per-project property every reader downstream assumes. A repeated `buzzActorId`
 * constructs fine and is then refused by the `sessions_buzz_actor` partial unique index the moment
 * both sessions are live — a startup misconfiguration surfacing as an unexplained runtime claim
 * failure hours later.
 *
 * The mutation makes the set-size comparison vacuous, which is the shape a "simplification" of
 * this loop takes.
 */
const c = {
  id: "the-adoptable-set-refuses-repeated-fields",
  what: "a configured set that repeats a sessionUuid, projectId or buzzActorId constructs nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: "      if (new Set(values).size !== values.length) {",
  replace: "      if (new Set(values).size !== new Set(values).size) {",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::refuses a set that repeats a sessionUuid rather than resolving it by first match",
    "tests/unit/canonical-self-claim.test.ts::refuses a set that repeats a projectId rather than resolving it by first match",
    "tests/unit/canonical-self-claim.test.ts::refuses a set that repeats a buzzActorId rather than resolving it by first match",
  ],
};
export default c;
