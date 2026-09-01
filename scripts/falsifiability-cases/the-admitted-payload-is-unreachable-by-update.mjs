/**
 * #631 / #646 — the words are write-once, structurally.
 *
 * The mutation removes the trigger's RAISE, leaving a column any UPDATE can rewrite or clear. That
 * is not a hypothetical: the turn claim used to share `result_json` with the reply lifecycle, the
 * reservation wrote that column whole, and a completed turn came back looking like a message
 * nobody had claimed (#646). The writers being careful is not the property — #646's writers were
 * careful too. A field reachable by UPDATE is a lifecycle waiting to be given to it.
 *
 * Killed at the boundary that actually holds the rule, so a future writer that reaches for this
 * column is stopped by the database rather than by whoever reviews it.
 */
const theAdmittedPayloadIsUnreachableByUpdate = {
  id: "the-admitted-payload-is-unreachable-by-update",
  what: "the admitted payload cannot be rewritten or cleared by an UPDATE, so no second lifecycle can be given the column that holds the sender's words",
  file: "src/db/schema.sql",
  find: "  SELECT RAISE(ABORT, 'INBOUND_PAYLOAD_IMMUTABLE');\n",
  replace: "  SELECT 1;\n",
  killedBy: [
    "tests/unit/the-admitted-payload-is-write-once.test.ts::refuses an UPDATE that would change it, so no lifecycle can be given this column",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theAdmittedPayloadIsUnreachableByUpdate;
