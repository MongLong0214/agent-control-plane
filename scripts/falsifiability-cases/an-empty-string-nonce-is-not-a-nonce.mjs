/**
 * #833 - an empty string is not a handle.
 *
 * `isNonEmptyString` is `typeof value === "string" && value.length > 0`, and this row removes the
 * second half. The first half still holds, so `""` becomes a valid nonce and reaches
 * `loadAdmittedOwnerApproval`, where it is a `WHERE nonce = ''` that names no row -- refused, but
 * as OWNER_AUTHORITY_NOT_DELEGABLE rather than INVALID_ARGUMENT. A caller who sent nothing is then
 * told the authority was missing rather than that the request was malformed, which is the reading
 * that sends an operator to look for an approval nobody minted.
 *
 * Its sibling `typeof value === "string"` cannot carry a row: removing it leaves an `unknown`
 * flowing into a `string` field and the mutant refuses to compile. TypeScript enforces that half.
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
  id: "an-empty-string-nonce-is-not-a-nonce",
  what:
    "an empty ownerApprovalNonce is refused as a malformed request rather than used as a lookup key",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: " && value.length > 0",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses an empty ownerApprovalNonce",
  ],
};
export default c;
