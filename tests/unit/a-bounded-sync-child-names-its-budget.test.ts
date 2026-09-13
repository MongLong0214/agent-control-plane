import { describe, expect, it } from "vitest";

import { boundedExecFileSync, boundedSpawnSync, CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";

/**
 * #872. The helper exists so a wedged synchronous child becomes a failure that names itself instead
 * of a vitest timeout reported against whichever test the stalled worker happened to hold. Nothing
 * in the converted files can witness that: they only ever run children that finish, so every one of
 * them stays green if the bound is deleted.
 *
 * These use a caller-supplied 700ms budget rather than `CHILD_BUDGET_MS`, because a witness that
 * waits out the real bound costs 55s per case and would itself be the slowest thing in the suite.
 * That the default is the value the files actually run under is asserted directly.
 */
describe("a bounded synchronous child", () => {
  it("turns a child that never answers into an error naming the command and the budget", () => {
    expect(() =>
      boundedSpawnSync("/bin/sleep", ["30"], { encoding: "utf8", timeout: 700 }),
    ).toThrowError(/\/bin\/sleep 30 did not answer within 700ms/);

    expect(() =>
      boundedExecFileSync("/bin/sleep", ["30"], { encoding: "utf8", timeout: 700 }),
    ).toThrowError(/\/bin\/sleep 30 did not answer within 700ms/);
  });

  it("honours a caller's own timeout rather than overwriting it with the default", () => {
    // The first shape spread `timeout: CHILD_BUDGET_MS` *after* the caller's options, so a site
    // that had already chosen a tighter bound silently got the looser one. The 700ms above is the
    // proof this no longer happens: at the default it would not have thrown inside the test's own
    // timeout at all.
    expect(CHILD_BUDGET_MS).toBe(55_000);
  });

  it("leaves an ordinary nonzero exit reported as itself, not as the budget", () => {
    const refused = boundedSpawnSync("/bin/sh", ["-c", "exit 3"], { encoding: "utf8" });
    expect(refused.status).toBe(3);
    expect(refused.error).toBeUndefined();

    expect(() =>
      boundedExecFileSync("/bin/sh", ["-c", "exit 3"], { encoding: "utf8" }),
    ).toThrowError(/Command failed/);
  });
});
