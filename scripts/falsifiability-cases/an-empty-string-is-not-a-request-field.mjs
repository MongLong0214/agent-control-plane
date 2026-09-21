/**
 * An empty string is not a request field.
 *
 * `isNonEmptyString` is `typeof value === "string" && value.length > 0`, and this row removes the
 * second half. The first half still holds, so `""` becomes a valid `projectId` and a valid
 * `claimedSessionUuid` and both reach `CanonicalSelfClaim.claim()`. Neither has an equivalent
 * refusal waiting: the empty `claimedSessionUuid` is compared against the derived UUID and denied
 * `CONFLICT` as an identity mismatch, and the empty `projectId` is carried into the role key. A
 * caller who sent nothing is then told their identity did not match, which is the reading that
 * sends an operator looking for a session.
 *
 * Its sibling `typeof value === "string"` cannot carry a row: removing it leaves an `unknown`
 * flowing into a `string` field and the mutant refuses to compile. TypeScript enforces that half.
 *
 * This replaces `an-empty-string-nonce-is-not-a-nonce`, which named the same operand through the
 * `ownerApprovalNonce` field. That field, and the owner approval it named, no longer exist — the
 * operand does, and it still guards the two fields the request does carry.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-empty-string-is-not-a-request-field",
  what:
    "an empty projectId or claimedSessionUuid is refused as a malformed request rather than carried into derivation",
  file: "src/daemon/canonical-self-claim-operator.ts",
  find: " && value.length > 0",
  replace: "",
  killedBy: [
    "tests/unit/an-empty-string-is-not-a-request-field.test.ts::refuses an empty projectId",
  ],
};
export default c;
