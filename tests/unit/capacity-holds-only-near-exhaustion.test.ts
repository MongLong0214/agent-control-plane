import { describe, expect, it } from "vitest";

import { CAPACITY_DEFAULTS } from "../../src/capacity/capacity-monitor.ts";

/**
 * Where the capacity ladder stands, and why the three numbers move together.
 *
 * Measured on the live deployment 2026-09-20: the `claude` weekly bucket read **20% remaining**
 * and `allocationAdmission` was `CONSERVE`, so every worker allocation was refused
 * `CAPACITY_ADMISSION_CONSERVE` while four fifths of the week's capacity sat unused. The owner's
 * decision is that holding work is for a bucket that is nearly gone, not one with a quarter left.
 *
 * The ordering is the invariant this pins, not the individual figures. `admission` is evaluated
 * top-down — `exhausted` first, then `conserve` — so lowering only `conserve` would leave
 * `exhausted` firing ahead of it and suspend *earlier* than before, which is the opposite of the
 * instruction. A future change that moves one number has to move the others or fail here.
 */
describe("capacity holds only near exhaustion", () => {
  it("conserves at five percent, not at a quarter", () => {
    expect(CAPACITY_DEFAULTS.conservePercent).toBe(5);
  });

  it("keeps the ladder strictly ordered so the top rung cannot pre-empt the one below it", () => {
    // exhausted < critical < conserve. Equality is a failure too: two rungs at the same percent
    // make one of them unreachable, which is the same defect as an inverted pair wearing a
    // different shape.
    expect(CAPACITY_DEFAULTS.exhaustedPercent).toBeLessThan(CAPACITY_DEFAULTS.criticalPercent);
    expect(CAPACITY_DEFAULTS.criticalPercent).toBeLessThan(CAPACITY_DEFAULTS.conservePercent);
  });

  it("leaves a live reading that used to conserve open", () => {
    // The exact figure that was refusing work on this deployment. Written as the measurement it
    // came from rather than as a round number, so that if the policy is ever raised back above
    // it, the case says which observation it is contradicting.
    const liveWeeklyRemainingPercent = 20;
    expect(liveWeeklyRemainingPercent).toBeGreaterThan(CAPACITY_DEFAULTS.conservePercent);
  });
});
