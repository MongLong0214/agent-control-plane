import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #682 (round 8) — the 24h floor `IngressGuard` enforces (#673) is derived from the retention the
 * transport states about itself (`transportRetentionMs`), not from the channel name. `null` means
 * "not measured", and the guard refuses construction rather than assume the official 24h figure.
 * A known, longer retention raises the effective floor when `nonceTtlMs` is not explicit; an
 * explicit `nonceTtlMs` shorter than a known retention is still refused.
 */
describe("#682 round 8: the retention floor tracks the transport's own declared retention", () => {
  it("raises the effective floor to a longer-than-24h transportRetentionMs rather than refusing, when nonceTtlMs is not explicit", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      // No explicit `nonceTtlMs`. A transport that can genuinely redeliver for 48h must raise this
      // guard's own floor to 48h, not be refused for a default nobody configured.
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], transportRetentionMs: 48 * 60 * 60 * 1000 },
    });
    const nonce = "48h-transport-update";
    const admit = (n: string) =>
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: n, payload: {} });

    expect(admit(nonce).allowed).toBe(true);

    // Relative to the harness's own (manual) clock, not real wall-clock time — `prune`'s cutoff
    // is computed from `this.clock.nowIso()`, and this harness's clock is fixed at a specific
    // instant rather than tracking `Date.now()`.
    const now = new Date(harness.clock.nowIso()).getTime();
    const hoursAgo = (hours: number): string => new Date(now - hours * 60 * 60 * 1000).toISOString();

    // Aged past the *old* 24h default but well inside the 48h floor this transport's retention
    // must now enforce. Directly, the same idiom `ingress-nonce-ttl-transport-retention.test.ts`
    // uses, rather than advancing the clock 30 real hours.
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE channel = 'telegram' AND nonce = ?",
      [hoursAgo(30), nonce],
    );
    // A prune runs on every admit; if the floor were still 24h (the old, buggy refuse-or-nothing
    // behaviour reduced to "refuse" and this test could never even get this far, but if it had
    // instead silently kept the 24h default) this row would already be gone and a redelivery
    // would be treated as fresh. It must still be a replay.
    expect(admit("unrelated-1").allowed).toBe(true);
    const stillThere = admit(nonce);
    expect(stillThere.allowed, "a 30h-old row must not be pruned when the floor is 48h").toBe(false);

    // Past the 48h floor now — this is what proves the floor is 48h, not merely "more than 30h".
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE channel = 'telegram' AND nonce = ?",
      [hoursAgo(49), nonce],
    );
    expect(admit("unrelated-2").allowed).toBe(true);
    const redelivered = admit(nonce);
    expect(redelivered.allowed, "a 49h-old row must be pruned once the 48h floor has passed").toBe(true);
  });

  it("still refuses an explicit nonceTtlMs shorter than a known, longer retention", () => {
    const harness = makeHarness();

    // An operator's own explicit choice, not the system default — silently raising it to match
    // the transport's retention would hide a real misconfiguration instead of refusing it.
    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            nonceTtlMs: 60 * 60 * 1000,
            transportRetentionMs: 48 * 60 * 60 * 1000,
          },
        }),
    ).toThrow(/retention/i);
  });

  it("succeeds once nonceTtlMs is raised to at least the declared 48h retention", () => {
    const harness = makeHarness();

    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            nonceTtlMs: 48 * 60 * 60 * 1000,
            transportRetentionMs: 48 * 60 * 60 * 1000,
          },
        }),
    ).not.toThrow();
  });

  it("refuses to construct when the transport's retention is unmeasured, regardless of nonceTtlMs", () => {
    const harness = makeHarness();

    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            // Generously long — this must still be refused, since the point is that nobody
            // measured what this transport actually does, not that the configured number is
            // too small.
            nonceTtlMs: 365 * 24 * 60 * 60 * 1000,
            transportRetentionMs: null,
          },
        }),
    ).toThrow(/retention/i);
  });
});
