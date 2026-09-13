/**
 * #833 - the field the claim's first authority check reads.
 *
 * `CanonicalSelfClaim.claim()` refuses when `ownerApproval.operation !== SELF_CLAIM_OPERATION`.
 * That comparison is `===` against a literal, so a non-string simply fails it -- which is why this
 * operand looks redundant and is not. Remove it and the receipt is constructed with a field whose
 * declared type is a lie, and the next reader of that receipt is entitled to treat it as a string.
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
  id: "an-envelope-operation-is-a-string",
  what:
    "an operation that is not a string is refused before the claim compares it to its own operation name",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    typeof record[\"operation\"] === \"string\" &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses an operation that is not a string",
  ],
};
export default c;
