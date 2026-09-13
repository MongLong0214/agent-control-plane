/**
 * #833 - the field that binds an approval to one attempt.
 *
 * `parameterDigest` is compared against `canonicalSelfClaimParameterDigest({projectId,
 * claimedSessionUuid, expectedBindingGeneration})`, which is what stops a real approval minted for
 * a different claim from authorising this one. This operand is the type half of that binding.
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
  id: "an-envelope-parameter-digest-is-a-string",
  what:
    "a parameterDigest that is not a string is refused before it is compared to the digest of this exact attempt",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    typeof record[\"parameterDigest\"] === \"string\" &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses a parameterDigest that is not a string",
  ],
};
export default c;
