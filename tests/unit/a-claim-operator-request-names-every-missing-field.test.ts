import { describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { parseCanonicalSelfClaimOperatorRequest } from "../../src/daemon/canonical-self-claim-operator.ts";

/**
 * #833 — the operator request parser assumes nothing, and each of its refusals is the only thing
 * that catches its own input.
 *
 * The parser is pure and exported, so these need no daemon: one valid request as the positive
 * control, then one variant per operand. Without the control a refusal means only "this parser
 * refused", which a parser that refused everything would also produce.
 */
const VALID = {
  claimedSessionUuid: "11111111-2222-3333-4444-555555555555",
  projectId: "github:acme/fixture",
  expectedBindingGeneration: 3,
  ownerApprovalNonce: "ownerapp-69d2f438",
};

describe("a claim-operator request names every missing field", () => {
  it("admits a complete request", () => {
    expect(parseCanonicalSelfClaimOperatorRequest({ ...VALID })).toMatchObject({
      allowed: true,
      value: VALID,
    });
  });

  it("refuses each field's absence, its wrong type, and its empty spelling", () => {
    // One input per operand. `isNonEmptyString` is shared by three of the four fields, so its two
    // operands are witnessed through one of them: a number reaches only the `typeof` half, and an
    // empty string reaches only the `length > 0` half — a number has no `.length` to test and an
    // empty string is a string.
    const variants: Array<[string, Record<string, unknown>]> = [
      ["claimedSessionUuid absent", { ...VALID, claimedSessionUuid: undefined }],
      ["claimedSessionUuid is a number", { ...VALID, claimedSessionUuid: 12345 }],
      ["claimedSessionUuid is empty", { ...VALID, claimedSessionUuid: "" }],
      ["projectId absent", { ...VALID, projectId: undefined }],
      ["expectedBindingGeneration is fractional", { ...VALID, expectedBindingGeneration: 1.5 }],
      ["ownerApprovalNonce absent", { ...VALID, ownerApprovalNonce: undefined }],
    ];
    for (const [name, params] of variants) {
      expect(parseCanonicalSelfClaimOperatorRequest(params), name).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
      });
    }
  });
});
