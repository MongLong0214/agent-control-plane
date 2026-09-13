/**
 * #833 - `null or a string` is two accepted values, not `anything`.
 *
 * `runId` is nullable because a canonical self-claim approval binds no run -- `CanonicalSelfClaim`
 * later refuses any approval where `runId !== null`. This operand is what makes the field's *type*
 * true before that clause reads its *value*, and removing it lets a number or an object through to
 * a field the receipt declares as `string | null`.
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
  id: "a-run-id-is-null-or-a-string",
  what:
    "a runId that is neither null nor a string is refused, so the envelope's optional fields are typed rather than assumed",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    (record[\"runId\"] === null || typeof record[\"runId\"] === \"string\") &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses a runId that is neither null nor a string",
  ],
};
export default c;
