/**
 * #674 — a refusal is counted under a reason, not as an admission.
 *
 * `BuzzMentionCounters.admitted` promises *"frames that produced an admission attempt — the only
 * outcome that can reach a session"*. `REFUSED` reaches none, and the tally was counting it there
 * anyway: `outcome.admission !== null` is true for a refusal.
 *
 * The mutation restores that. `health.json` then reads a refused event as a delivered one, in the
 * one place an operator looks to tell "nothing arrived" from "arrived and was turned down" — and
 * #855 added that surface precisely to separate those two.
 *
 * Killed by the seam-refusal case, which drives a real `REFUSED` answer through the subscriber and
 * asserts `admitted === 0` with the refusal under `rejections["admission-refused"]`. Measured both
 * ways: with the mutation, `admitted` is 1.
 */
const aRefusedAdmissionIsNotAnAdmittedOne = {
  id: "a-refused-admission-is-not-an-admitted-one",
  what: "a refused admission is counted under its own reason rather than as an admission, so health.json cannot read a refusal as a delivery",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: 'if (outcome.admission !== null && outcome.admission !== "REFUSED") this.#admitted += 1;',
  replace: "if (outcome.admission !== null) this.#admitted += 1;",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::keeps the connection and moves nothing when the seam refuses the event",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aRefusedAdmissionIsNotAnAdmittedOne;
