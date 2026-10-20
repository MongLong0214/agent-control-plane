import { describe, expect, it } from "vitest";

import {
  CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON,
  CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON,
  CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON,
  coverageRevocationReason,
  isContinuityRevocationReason,
} from "../../src/continuity/continuity-kernel.ts";

// Historical revocations remain readable for recovery; quota no longer creates new evictions.
describe("legacy continuity recovery reasons", () => {
  it.each([
    [false, true, CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON],
    [true, false, CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON],
    [true, true, CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON],
  ] as const)("recognizes runtimeLost=%s quotaExhausted=%s", (runtimeLost, quotaExhausted, reason) => {
    expect(coverageRevocationReason({ runtimeLost, quotaExhausted })).toBe(reason);
    expect(isContinuityRevocationReason(reason)).toBe(true);
  });
});
