/**
 * #674 — `admitted` counts deliveries, and the other three answers each carry their own reason.
 *
 * `BuzzMentionAdmission` has four values and only `DURABLE` is a delivery. The tally counted all
 * four (`outcome.admission !== null`), so `health.json` read a refusal, a retry and a replay as
 * deliveries — in the one place an operator looks to tell "nothing arrived" from "arrived and did
 * not get through", which is what #855 added that surface for.
 *
 * A first repair excluded only `REFUSED`, and a merge-gate review measured what that left:
 * `RETRY` reporting `admitted: 1` with an empty `rejections` while the role's peer was down
 * (`ROLE_PEER_ABSENT` — nothing reaching any session), and `ALREADY_DURABLE` incrementing once per
 * reconnect for a single message, because `since` is inclusive and every reconnect re-requests the
 * boundary event. So the predicate is now positive — `=== "DURABLE"` — and the mutation restores
 * the whole original defect rather than a third of it.
 *
 * Killed by the seam-refusal case. The sibling answers have their own cases beside it
 * (`does not advance the mark for a retryable admission`,
 * `advances the mark for an already-durable event without counting a second delivery`), each
 * asserting `admitted === 0` with its own reason counted; this row names one because a row names
 * exactly one test.
 */
const aRefusedAdmissionIsNotAnAdmittedOne = {
  id: "a-refused-admission-is-not-an-admitted-one",
  what: "only a durable admission is counted as one, so health.json cannot read a refusal, a retry or a replay as a delivery",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: 'if (outcome.admission === "DURABLE") this.#admitted += 1;',
  replace: "if (outcome.admission !== null) this.#admitted += 1;",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::keeps the connection and moves nothing when the seam refuses the event",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aRefusedAdmissionIsNotAnAdmittedOne;
