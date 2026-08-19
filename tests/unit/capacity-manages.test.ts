import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { USAGE_PROVIDERS } from "../../src/capacity/usage-collectors.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `manages()` decides whether capacity is entitled to an opinion about a provider, and the
 * daemon's reconciliation reads that answer to decide whether a bound role is still covered
 * (`daemon.ts`, the `capacityManaged` branch). The exemption it grants has to stay narrow: a
 * provider capacity was never built to measure, and nothing else.
 *
 * The real monitor is asked, on a plane with **no adapters registered**. Stubbing the registry
 * and restating the rule in the test would pass whether or not the rule is in the source — the
 * shape this repository keeps finding, and the one this file would otherwise be an instance of.
 */
describe("which providers capacity is entitled to an opinion about", () => {
  const planeWithNoAdapters = (): ControlPlane => {
    const root = tempDir("acp-manages-");
    return new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock: new ManualClock("2026-08-19T00:00:00.000Z"),
      adapters: [],
      allowTestEvidenceWriters: true,
    });
  };

  it("claims every provider it has a vocabulary for, even with nothing registered", () => {
    const cp = planeWithNoAdapters();
    expect(USAGE_PROVIDERS.length).toBeGreaterThan(0);
    for (const provider of USAGE_PROVIDERS) {
      // Registered or not, a provider capacity can measure still owes a reading. Falling to the
      // exempt side would skip the check it genuinely needs.
      expect(cp.capacity.manages(provider)).toBe(true);
    }
  });

  it("does not claim a provider it was never built to measure", () => {
    // The generation-1 CEO runtime. No collector writes a snapshot for this name, and no
    // synthetic one should: a sensor reporting a fact it did not measure is the defect, not the
    // fix. So capacity says nothing about it, and the daemon reads that as "nothing to say"
    // rather than "not covered".
    expect((USAGE_PROVIDERS as readonly string[]).includes("hermes")).toBe(false);
    expect(planeWithNoAdapters().capacity.manages("hermes")).toBe(false);
  });
});
