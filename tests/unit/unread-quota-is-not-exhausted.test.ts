import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * An unread quota was reported as an exhausted one.
 *
 * `advisoryState` derived `EXHAUSTED` from `lowest === null` — the case where no bucket was read
 * at all. The doctor then emitted `CAPACITY_LOW` with `severity: ERROR`, `confidence: HIGH` and
 * the advice *"wait for reset"*. On 2026-08-20 the deployment showed exactly that for grok:
 * `advisoryState: "EXHAUSTED", buckets: []`, produced by a billing token that expires every six
 * hours. The provider was usable the whole time, and no reset was ever going to arrive.
 *
 * Routing was never affected — `allocationAdmission` distinguishes "unknown" from "empty" and
 * suspends either way. The damage was to a reader: I reported to the owner that blind review was
 * down, on the strength of this finding, and it was not.
 */
const CAPACITY_MONITOR = "src/capacity/capacity-monitor.ts";
const DOCTOR = "src/doctor/doctor.ts";

const sourceOf = async (path: string): Promise<string> => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  return readFileSync(join(process.cwd(), path), "utf8");
};

describe("a quota nobody could read", () => {
  it("is not called exhausted", async () => {
    const source = await sourceOf(CAPACITY_MONITOR);
    const advisory = source.slice(source.indexOf("const advisoryState = "));
    const body = advisory.slice(0, advisory.indexOf("})();"));

    // The branch that fires when nothing was read must not produce a level of low.
    expect(body).toMatch(/lowest === null\) return "UNKNOWN"/);
    expect(body).not.toMatch(/lowest === null\) return "EXHAUSTED"/);
  });

  it("is not called exhausted when every bucket it did return is unknown", async () => {
    // `lowest === null` is not the only shape of "no reading". A provider can answer with buckets
    // whose remaining percent is unknown, and `admission` already treats that as no reading at
    // all — the advisory value has to agree, or the two disagree about the same observation.
    const source = await sourceOf(CAPACITY_MONITOR);

    expect(source).toMatch(/unknownBuckets\.length === reading\.buckets\.length\) return "UNKNOWN"/);
  });

  it("does not reach the doctor's low-capacity finding", async () => {
    // The finding carries `confidence: "HIGH"` and advises waiting for a reset. Both are claims
    // about a measurement; neither survives if there was none.
    const source = await sourceOf(DOCTOR);
    const guard = source.slice(source.indexOf('reading.advisoryState === "EXHAUSTED"'));

    expect(guard.slice(0, 200)).not.toContain("UNKNOWN");
  });

  it("still says something, rather than nothing", async () => {
    // Silence would be the other failure: a provider that cannot be read is a state the operator
    // has to act on. CAPACITY_SENSOR_FAILED is the finding that carries it, and it must remain.
    const source = await sourceOf(DOCTOR);

    expect(source).toContain("CAPACITY_SENSOR_FAILED");
  });
});
