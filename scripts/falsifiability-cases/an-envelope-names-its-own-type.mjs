/**
 * #833 - the envelope says what it is, and that is checked.
 *
 * `inbound_messages` carries every admitted ingress payload, not only owner approvals: a Buzz
 * message, a Telegram update and an owner decision share the table and are told apart by
 * `payload_json.type`. Remove this operand and any stored payload whose remaining fields happen to
 * be string-shaped is reconstructed as an `OwnerApprovalReceipt` and handed to `OwnerAuthority`.
 *
 * That is not a hypothetical shape: the mint writes `{type, runId, candidateSnapshotDigest,
 * operation, parameterDigest, idempotencyKey, approved}`, and `type` is the only field whose value
 * -- rather than whose JavaScript type -- is checked at all.
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
  id: "an-envelope-names-its-own-type",
  what:
    "a stored payload that does not name itself OWNER_APPROVAL is not read as one",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    record[\"type\"] === \"OWNER_APPROVAL\" &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses a type that is not OWNER_APPROVAL",
  ],
};
export default c;
