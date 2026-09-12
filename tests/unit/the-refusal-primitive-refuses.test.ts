import { describe, expect, it } from "vitest";

import { acpError, isAcpError, isDenialPayload } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

/**
 * `isAcpError` is the structural gate every denial in this repository passes through, and
 * `isDenialPayload` is the same function under another name. Its positive path is well covered —
 * `core-hardening.test.ts` round-trips a payload over the wire — and until #833 nothing exercised
 * a single one of its six refusals.
 *
 * That matters more here than in most places: the guard is deliberately structural rather than
 * `instanceof`-based, so anything carrying the shape is trusted as a denial *whichever realm
 * produced it*. The refusals are the whole of what keeps that from meaning "anything at all".
 *
 * Each case below is a value only one of the six operands rejects.
 */
const denial = { reasonCode: ReasonCode.INTERNAL_ERROR, message: "no", evidence: {} };

describe("the structural denial guard refuses what does not carry the contract", () => {
  it("accepts a plain object carrying the contract", () => {
    // The control. Without it every refusal below passes against a guard that refuses everything.
    expect(isAcpError(denial)).toBe(true);
    expect(isDenialPayload(denial)).toBe(true);
    expect(isAcpError(acpError(ReasonCode.INTERNAL_ERROR, "no"))).toBe(true);
  });

  it("refuses a function carrying the contract on its own properties", () => {
    // The witness for `typeof value !== "object"`, and the only one it has: a string or number
    // is refused anyway, because reading `reasonCode` off it yields undefined. A function is
    // different — functions hold properties, and `typeof fn` is "function", so without that
    // operand a callable would be accepted as a denial.
    const callable = Object.assign(() => undefined, denial);

    expect(isAcpError(callable)).toBe(false);
  });

  it("refuses null without throwing", () => {
    // `typeof null === "object"`, so the null check is not redundant with the one above it —
    // remove it and `candidate.reasonCode` reads a property of null, which throws rather than
    // returning false. A guard that throws is not a guard that refuses: every caller here uses
    // it in a boolean position.
    expect(isAcpError(null)).toBe(false);
    expect(isDenialPayload(null)).toBe(false);
  });

  it("refuses a reason code that is not a string", () => {
    expect(isAcpError({ ...denial, reasonCode: 7 })).toBe(false);
  });

  it("refuses a message that is not a string", () => {
    expect(isAcpError({ ...denial, message: 7 })).toBe(false);
  });

  it("refuses evidence that is not an object", () => {
    expect(isAcpError({ ...denial, evidence: "none" })).toBe(false);
  });

  it("refuses null evidence, which the typeof check admits", () => {
    // `typeof null === "object"` passes the operand above, so this is the only one that rejects
    // it. Evidence is what a denial is read for; null there would be a denial with no account.
    expect(isAcpError({ ...denial, evidence: null })).toBe(false);
  });
});
