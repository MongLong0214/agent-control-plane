/**
 * #858 — the doctor distinguishes an empty canonical ledger from a healthy one.
 *
 * The mutation removes the ingress-claim half of the condition, leaving `canonicalTurns === 0`.
 * That is a finding on every fresh install, which is the noise the first case in this file's
 * test is written against — and the `.toBeUndefined()` on a deployment that has taken no turns
 * is what catches it. The opposite mutation (dropping the emptiness half) cannot be tested this
 * way: with rows present the group's other checks already answer, so the row goes here.
 *
 * Killed by the case asserting a brand-new harness stays quiet. Without this finding at all the
 * whole group passes on zero rows, which is the state the live deployment has been in for 26
 * days while 30,789 audit events accumulated.
 */
const theCanonicalTurnLedgerSaysItIsUnobserved = {
  id: "the-canonical-turn-ledger-says-it-is-unobserved",
  what: "an empty canonical ledger is reported as unobserved only when the other authority has claims, so a fresh install gets no standing warning and a live one gets the truth",
  file: "src/doctor/doctor.ts",
  find: 'if ((canonicalTurns?.n ?? 0) === 0 && (ingressClaims?.n ?? 0) > 0) {',
  replace: 'if ((canonicalTurns?.n ?? 0) === 0) {',
  killedBy: [
    "tests/unit/doctor-sees-the-canonical-ledger.test.ts::stays quiet on a deployment that has taken no turns at all",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theCanonicalTurnLedgerSaysItIsUnobserved;
