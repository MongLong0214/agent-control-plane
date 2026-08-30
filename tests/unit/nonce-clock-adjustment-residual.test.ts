import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #673's floor guarantees `received_at + nonceTtlMs >= created_at + retention` — but only if
 * `received_at` and the `now` `prune` later reads come from a clock that moves forward at the
 * rate real time actually passes. Found by review (#682): production's clock is `new Date()`
 * (`clock.ts`), the local wall clock, which is not that — NTP, a manual change, or a resumed VM
 * can step it forward between the moment a message is admitted and the moment `prune` compares
 * `received_at` against `now()` again.
 *
 * A unit test cannot drive a real NTP step, so this demonstrates the mechanism the guard cannot
 * tell apart from one: `ManualClock.set()` moves time discontinuously, the same shape as a clock
 * *adjustment* rather than elapsed *duration* — as opposed to `.advance()`, which every other test
 * in this suite uses to simulate ordinary elapsed time. `prune`'s SQL compares two timestamps; it
 * has no way to know whether the gap between them was lived through or jumped over.
 *
 * This is not a bug to fix here. `IngressGuard.ts`'s docstring on `TRANSPORT_RETENTION_MS`
 * explains why a monotonic clock cannot close it either: `received_at` has to survive a daemon
 * restart, and a monotonic clock's value means nothing outside the process that produced it. The
 * residual this leaves is real and bounded — exactly the size of whatever forward step the host
 * clock takes during the pruning window, not the unbounded gap an unmeasured retention number
 * would leave.
 */
describe("the retention floor assumes the local clock does not step forward", () => {
  it("a discontinuous forward clock step prunes a row before nonceTtlMs of real time has passed", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      // The default 24h ttl — already at the floor #673 requires, not a misconfiguration.
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"] },
    });
    const nonce = "stepped-clock-update";
    const admittedAt = harness.clock.nowIso();

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: {} }).allowed,
    ).toBe(true);

    // A step, not an advance: the clock is *set* forward past the 24h floor in one instant,
    // exactly the shape of an NTP correction or a resumed VM's clock catching up — not 24 real
    // hours of owner-facing time during which Telegram's own 24h retention would also have
    // elapsed. This is the gap the docstring discloses: the guard cannot distinguish this from
    // 24 real hours passing, because both look identical in `received_at` vs `now()`.
    const oneMillisecondPastTheFloor = new Date(admittedAt).getTime() + 24 * 60 * 60 * 1000 + 1;
    harness.clock.set(oneMillisecondPastTheFloor);

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: "unrelated", payload: {} })
        .allowed,
    ).toBe(true);

    // Pruned and re-admitted as fresh — after a clock *step*, not 24 hours anyone actually lived
    // through. If Telegram's own redelivery window had not yet closed at the moment of the step
    // (it queues for up to 24h from an update's *creation*, and `received_at` is only ever
    // stamped no earlier than that), a genuine redelivery landing in that gap would now run the
    // handler again — the residual this file's docstring names, bounded by the size of the step.
    const redelivered = guard.admit({
      channel: "telegram",
      actor: "owner",
      conversation: "chat",
      nonce,
      payload: {},
    });
    expect(redelivered.allowed, "a clock step must not be indistinguishable from lived time here").toBe(true);
  });
});
