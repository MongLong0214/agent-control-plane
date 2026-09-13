/**
 * #833 - the field the consumption record is keyed by.
 *
 * `OwnerAuthority` spends an approval exactly once, and the key it spends is this one. A record
 * keyed by a non-string is the shape #789 is about: validation and consumption keyed on different
 * fields let one ignored junk value spend a single-use approval twice.
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
  id: "an-envelope-idempotency-key-is-a-string",
  what:
    "an idempotencyKey that is not a string is refused, so the single-use record has a key it can be recorded under",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    typeof record[\"idempotencyKey\"] === \"string\" &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses an idempotencyKey that is not a string",
  ],
};
export default c;
