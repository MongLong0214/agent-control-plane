import { describe, expect, it } from "vitest";

import { systemClock } from "../../src/core/clock.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";

/**
 * #512. The probe that gates every dispatch answered `UNAVAILABLE` and said nothing else, so the
 * acceptance run stopped with one word and four candidate causes: an authentication failure inside
 * the adapter's sandbox, a first call whose cache warm-up outran the 30s bound, a handle for
 * another provider, and the one it turned out to be — a `SessionEnd` hook whose binary is not on
 * the sandbox's PATH, which makes the CLI exit 1 after the session has already answered.
 *
 * Reaching that string took three files: the adapter records it, `CapacityObservedAdapter` wraps
 * the adapter and had to pass it through, and the denial in `cto-lifecycle` had to carry it. Each
 * of those is a place the diagnostic existed and was invisible.
 *
 * **These rows pin the reporting, not the verdict.** The refusal conditions are untouched: this
 * asserts that a refusal still refuses *and* now says why, so a later change that makes the probe
 * lenient fails the first row rather than passing quietly.
 */
describe("a session probe says why it refused", () => {
  const adapter = new ClaudeCliAdapter({
    binary: "/bin/echo",
    clock: systemClock,
    capacityFile: "/nonexistent/capacity.json",
  });
  const foreignHandle = {
    provider: "gpt",
    externalSessionId: "s1",
    model: "opus",
    effort: "medium",
    pid: null,
  } as const;

  it("still refuses a handle belonging to another provider", async () => {
    const health = await adapter.probeSession(foreignHandle);

    expect(health).toBe("UNAVAILABLE");
  });

  it("names the mismatch rather than leaving the caller one word", async () => {
    await adapter.probeSession(foreignHandle);

    expect(adapter.lastProbeDiagnostic).toContain("gpt");
    expect(adapter.lastProbeDiagnostic).toContain("claude");
  });
});
