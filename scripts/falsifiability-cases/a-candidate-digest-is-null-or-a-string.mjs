/**
 * #833 - the second nullable field, and the same argument.
 *
 * Written as its own row rather than folded in with `runId`: they are checked by two separate
 * parenthesised clauses, and a change that dropped one would leave the other passing. The census
 * counts them separately for the same reason.
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
  id: "a-candidate-digest-is-null-or-a-string",
  what:
    "a candidateSnapshotDigest that is neither null nor a string is refused, for the same reason its sibling is",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: "    (record[\"candidateSnapshotDigest\"] === null || typeof record[\"candidateSnapshotDigest\"] === \"string\") &&\n",
  replace: "",
  killedBy: [
    "tests/unit/a-stored-owner-approval-envelope-is-checked-field-by-field.test.ts::refuses a candidateSnapshotDigest that is neither null nor a string",
  ],
};
export default c;
