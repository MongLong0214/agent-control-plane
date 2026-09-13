/**
 * #833 - `typeof null === "object"`, which is why this operand is first.
 *
 * Remove it and `null` passes the object check, is cast to `Record<string, unknown>`, and
 * `record["type"]` throws a TypeError on an authenticated socket path -- an exception out of a
 * refusal, rather than a refusal. Its two siblings on the same line survive their own mutations
 * because the type check below catches what they let through; this one does not, because there is
 * nothing below a throw.
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
  id: "a-null-payload-is-not-an-envelope",
  what:
    "a null payload is refused before it is indexed as a record",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "value === null || ",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses a payload that is null",
  ],
};
export default c;
