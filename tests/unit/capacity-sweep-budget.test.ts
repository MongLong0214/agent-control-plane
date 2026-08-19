import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { COLLECTOR_TIMEOUT_MS } from "../../src/capacity/usage-collectors.ts";
import { sweepBudgetMs } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The periodic capacity sweep has to be allowed to finish.
 *
 * `CapacityMonitor.refresh` loops the registered providers one at a time, and each collector may
 * run to `COLLECTOR_TIMEOUT_MS`. For a while both the startup refresh and the periodic one used
 * a 15s budget sized against a healthy pass — "Claude answers in ~2s and the Codex app-server in
 * ~3s". Measured on the running deployment, 24 of about 30 periodic sweeps in two hours were
 * abandoned, and each abandonment was followed ~27 seconds later by the CEO role going uncovered
 * for roughly three and a half minutes: the providers that never got their turn had no fresh
 * observation, and capacity with no observation is not routable.
 *
 * These assertions derive from `COLLECTOR_TIMEOUT_MS` rather than restating a number. A test
 * that hard-coded the budget would agree with whatever the source said, including a value too
 * small to bound the work — which is the thing that was wrong.
 */
const DAEMON = readFileSync(join(process.cwd(), "src", "daemon", "daemon.ts"), "utf8");

const constantIn = (name: string): number => {
  const line = DAEMON.split("\n").find((text) => text.startsWith(`const ${name} = `));
  if (!line) throw new Error(`${name} is not declared in daemon.ts`);
  const expression = line.slice(line.indexOf("=") + 1).replace(";", "").replace(/_/g, "").trim();
  // `4 * 60_000` is a product in the source, so the value is computed rather than parsed. The
  // point is to read the declaration rather than restate the number here.
  const value = expression.split("*").reduce((total, part) => total * Number(part.trim()), 1);
  if (!Number.isFinite(value)) throw new Error(`${name} is not a numeric literal: ${expression}`);
  return value;
};

describe("the periodic capacity sweep's budget", () => {
  it("is larger than a sequential pass over every registered provider", () => {
    // Three production providers today; the daemon derives it from the registry at runtime.
    // The real function, not the formula restated here. Recomputing it would agree with any
    // implementation at all — including one that ignores the provider count, which is exactly
    // the value it replaced. The mutation harness caught this on the first attempt.
    for (const providerCount of [1, 3, 5]) {
      expect(sweepBudgetMs(providerCount)).toBeGreaterThan(providerCount * COLLECTOR_TIMEOUT_MS);
    }
  });

  it("still fits inside the interval between sweeps, for the deployment's provider count", () => {
    // `runPeriodic` has a failure backoff and no overlap guard, so a sweep that outlives its
    // interval runs alongside its successor and both compete for the same sequential collectors.
    // The daemon refuses this configuration at start; this is the same relationship, checked
    // where it can fail before a deployment does.
    const intervalMs = constantIn("DEFAULT_CAPACITY_REFRESH_MS");

    expect(sweepBudgetMs(3)).toBeLessThan(intervalMs);
  });

  it("keeps the startup budget short, because failing to read a quota is not failing to start", () => {
    // The startup and parked callers should abandon: the daemon comes up and the periodic
    // refresh supplies what the startup sweep did not. Raising this one would trade a fast
    // start for a fresher reading nobody is waiting on yet.
    expect(constantIn("STARTUP_CAPACITY_REFRESH_BUDGET_MS")).toBeLessThan(COLLECTOR_TIMEOUT_MS);
  });
});
