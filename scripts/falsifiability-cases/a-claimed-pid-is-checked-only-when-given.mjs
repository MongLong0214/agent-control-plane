/**
 * #833 - clause 1's optional pid is checked only when the caller supplied one.
 *
 * `claimedPid` is optional: a caller may assert which process it believes it is, and the claim
 * compares that assertion against the pid it derived independently. Removing the
 * `!== undefined` half turns the comparison on for every request, so `undefined !== identity.pid`
 * refuses every claim that did not volunteer a pid - including the ordinary one.
 *
 * The witness is the success case rather than a refusal case, which is why the first killedBy
 * (the mismatch test) let it live: a test that already supplies a mismatching pid still refuses
 * under the mutant, for the same reason and with the same code.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-claimed-pid-is-checked-only-when-given",
  what:
    "an absent claimedPid is not compared against the derived pid, so a claim that volunteers "
    + "nothing is not refused for volunteering nothing",
  file: "src/registry/canonical-self-claim.ts",
  find: "request.claimedPid !== undefined && ",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::claims the canonical session in one atomic mutation, writing exactly one row to each of the five tables",
  ],
};
export default c;
