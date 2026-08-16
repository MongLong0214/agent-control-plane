import { describe, expect, it } from "vitest";

import { __testing } from "../../src/runtime/cli-adapters.ts";

/**
 * The provider CLI reads *hooks* — arbitrary shell commands — from the operator's own settings.
 * A managed session must not execute them: unsanctioned code would run inside the run, and a hook
 * whose binary is missing from the agent's restricted PATH makes the CLI exit non-zero, which the
 * review gate correctly reads as "no verdict" and the run stops at REVIEW_UNAVAILABLE.
 *
 * The override used to be a file. Every place to put that file was wrong — the per-user temp
 * directory is reachable by a reviewer whose profile must allow it (#489), and
 * `~/.agent-control-plane` is on the sandbox's own deny list because it holds daemon authority.
 * #489 put it in the second one, so a live run handed the CLI a `--settings` path inside a
 * directory the same sandbox forbade it to stat, and the run died at CTO planning with EPERM.
 *
 * Passing it inline removes the placement question instead of answering it. What has to stay true
 * is that the value is a constant carrying no secret — inline argv is visible in `ps`, so a
 * settings blob that ever held one would have to become a file again, and the placement problem
 * would return with it.
 */
describe("the sanctioned settings override (#512)", () => {
  it("empties hooks and plugins", () => {
    const parsed = JSON.parse(__testing.sanctionedSettings()) as {
      hooks?: unknown;
      enabledPlugins?: unknown;
    };
    expect(
      parsed.hooks,
      "operator hooks would execute inside a managed session",
    ).toEqual({});
    expect(parsed.enabledPlugins).toEqual({});
  });

  it("carries no secret, because it is passed in argv where `ps` can read it", () => {
    // The condition that licenses passing this inline at all. If it ever stops holding, the
    // override has to go back to a file and #489's placement conflict comes back with it.
    const settings = __testing.sanctionedSettings();
    expect(settings).toBe(JSON.stringify({ hooks: {}, enabledPlugins: {} }));
    expect(settings).not.toMatch(/token|secret|key|password|Bearer/i);
  });
});
