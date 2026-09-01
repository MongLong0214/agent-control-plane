/**
 * #631 — the other half of write-once, and the half an UPDATE trigger cannot see.
 *
 * `INSERT OR REPLACE` deletes the row and writes a new one, so it rewrites the stored payload
 * without ever running `inbound_messages_payload_immutable`. The mutation removes the RAISE and
 * leaves that door open. Two things go through it: the sender's words, and the replay defence this
 * whole table exists for — a replaced row is a nonce that has never been seen.
 *
 * A separate row from the UPDATE one on purpose. `pnpm schema:census` found this hole *after* the
 * UPDATE guard was written and passing, which is the whole argument for not letting one mutation
 * stand for a rule that has two verbs.
 */
const theAdmittedPayloadIsUnreachableByReplace = {
  id: "the-admitted-payload-is-unreachable-by-replace",
  what: "an INSERT OR REPLACE cannot rewrite an inbound row, so the write-once payload rule is not reachable around its UPDATE trigger",
  file: "src/db/schema.sql",
  find: "  SELECT RAISE(ABORT, 'INBOUND_MESSAGE_NO_REPLACE');\n",
  replace: "  SELECT 1;\n",
  killedBy: [
    "tests/unit/the-admitted-payload-is-write-once.test.ts::refuses an INSERT OR REPLACE, which rewrites the row without running an UPDATE trigger",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theAdmittedPayloadIsUnreachableByReplace;
