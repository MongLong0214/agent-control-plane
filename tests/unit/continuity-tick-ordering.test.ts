import { describe, expect, it } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { CONTINUITY_MODE_MAX_AGE_MS } from "../../src/run/run-engine.ts";
import { makeHarness, bindCeo } from "../helpers/harness.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { afterAll } from "vitest";

afterAll(cleanupTempDirs);

/**
 * The sensor tick must stay ahead of the freshness window dispatch applies.
 *
 * Dispatch re-evaluates a SURVIVAL verdict older than CONTINUITY_MODE_MAX_AGE_MS. A tick slower
 * than that window lets dispatch act on a verdict the tick was supposed to have refreshed. The
 * two values lived in different files as independent literals, so changing either silently
 * changed what the other meant (#454) — and nothing anywhere reported the contradiction.
 */
describe("capacity tick and continuity window are ordered (#454)", () => {
  it("refuses a refresh interval at or beyond the freshness window", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    bindCeo(harness);
    const daemon = new Daemon(harness.cp, {
      stateDir: tempDir("acp-ordering-"),
      capacityRefreshIntervalMs: CONTINUITY_MODE_MAX_AGE_MS,
    });
    try {
      // The daemon converts a startup throw into DAEMON_STARTUP_FAILED carrying the reason,
      // which is the fail-closed shape: it refuses to run rather than running misconfigured.
      const started = await daemon.start();
      expect(started.allowed).toBe(false);
      expect(JSON.stringify(started.evidence)).toContain(
        "shorter than the continuity freshness window",
      );
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
