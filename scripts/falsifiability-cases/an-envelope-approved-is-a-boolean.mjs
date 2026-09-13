/**
 * #833 - the field that carries the owner's answer, and the one most worth forging.
 *
 * `CanonicalSelfClaim.claim()` checks `ownerApproval.approved !== true`, which a string `"true"`
 * fails -- so again this looks redundant. It is not, and the minting path says why: `owner.approve
 * ClaimCanonicalCto` refuses `typeof approved !== "boolean"` precisely so an *omitted* field cannot
 * read as approval. This operand is the same refusal on the read side, and dropping it would leave
 * the write side alone in holding a property both ends declare.
 *
 * The envelope is read back out of `inbound_messages.payload_json` by `loadAdmittedOwnerApproval`,
 * which exists so a claimant never supplies approval content -- every field comes from storage the
 * claiming connection cannot write to. A validator that accepts a shape the minting path never
 * produces is therefore a door into `OwnerAuthority` that does not go through an owner.
 *
 * The malformed row is inserted directly rather than written and corrupted:
 * `inbound_messages_payload_immutable` refuses an UPDATE of `payload_json`, so the only way to
 * hold a bad envelope is to have stored one.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-envelope-approved-is-a-boolean",
  what:
    "an approved that is not a boolean is refused, so a truthy string cannot stand in for an owner saying yes",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    typeof record[\"approved\"] === \"boolean\"\n",
  replace: "    true\n",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses an approved that is not a boolean",
  ],
};
export default c;
