/**
 * #627, on the fence #639 built. A turn claimed under one CEO generation and reconciled under the
 * next is a different CEO's work, and `bindingDigest` is what makes that visible: a receipt that
 * matches the turn id but names another generation is not this turn's.
 *
 * A digest over `null` is not a weaker version of that fence, it is the absence of one wearing
 * its shape. Every claim would carry the same value, every comparison against it would agree, and
 * the disagreement the fence exists to produce could never occur.
 *
 * The generation is read from the binding registry at claim time rather than from the peer: the
 * question is which CEO generation this turn was claimed under, and the peer cannot be its own
 * authority for that.
 *
 * Worth recording next to the row: Telegram's production composition still passes no
 * `bindingGeneration` (`TelegramHermesRouter` accepts the seam, `startTelegramLongPollListener`
 * never supplies it), so every Telegram claim carries `digestOf({ bindingGeneration: null })` —
 * exactly what this mutation produces here. This path is the first that records a real one, and
 * that asymmetry is a live gap in the other surface, not a property this row can defend.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzTurnClaimRecordsTheCeoGeneration = {
  id: "buzz-turn-claim-records-the-ceo-generation",
  what: "a Buzz turn's claim records the CEO generation it actually ran under",
  file: "src/daemon/agentcpd.ts",
  find: "    bindingGeneration: () => cp.bindings.active(roleKeyFor(Role.CEO))?.bindingGeneration ?? null,\n",
  replace: "    bindingGeneration: () => null,\n",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::claims the turn under the CEO generation it was answered by, and refuses the same event twice",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzTurnClaimRecordsTheCeoGeneration;
