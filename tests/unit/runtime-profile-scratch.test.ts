import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { __testing } from "../../src/runtime/cli-adapters.ts";
import { acpScratchDir } from "../../src/core/scratch-root.ts";

/**
 * A sandbox profile must not say two things about one directory.
 *
 * `hostCredentialPaths` denies reads under `~/.agent-control-plane` because it holds daemon
 * authority. #489 moved ACP's scratch beneath that path so a reviewer allowed the per-user temp
 * directory could not reach our packets. The profile then denied reads of the scratch while
 * explicitly granting writes to it — "write here, never read what you wrote" — and a live run died
 * on `stat` of a settings file we had just placed there (#512).
 *
 * The skip-guard above the denies shows the exemption was always intended: it drops a sensitive
 * path that sits *inside* the scratch. That test was right while scratch lived under the temp
 * directory and silently stopped matching when the containment inverted.
 *
 * This asserts the profile is coherent about the one directory, not that the credential tree is
 * open — the deny above it must survive, which the second expectation pins.
 */
describe("the runtime profile is coherent about its own scratch (#512)", () => {
  it("grants reads of the scratch it grants writes to", () => {
    const scratch = acpScratchDir("acp-profile-test-");
    const profile = __testing.runtimeProfile(
      join(homedir(), "workdir"),
      scratch,
      [],
      [],
    );

    expect(
      profile,
      "the profile grants writes to a directory it refuses to let the process read",
    ).toContain(`(allow file-read* (subpath "${scratch}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${scratch}"))`);

    // The read allowance is the last word for this path: SBPL takes the final matching rule, so
    // it must appear after the deny that covers the tree above it.
    const denyIndex = profile.indexOf(`(deny file-read* (subpath "${join(homedir(), ".agent-control-plane")}"))`);
    const allowIndex = profile.indexOf(`(allow file-read* (subpath "${scratch}"))`);
    expect(denyIndex, "the credential tree is no longer denied at all").toBeGreaterThanOrEqual(0);
    expect(allowIndex).toBeGreaterThan(denyIndex);
  });
});
