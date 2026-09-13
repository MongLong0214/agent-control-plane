/**
 * #869. `checkRepositories` probes every registered repository with `tryRevParse` and `isClean`.
 * Once `git()` gained a time bound those calls can *refuse* rather than hang, and an unhandled
 * refusal leaves `doctor.run()` rejecting — carrying away every finding already collected about
 * everything else. Its sibling `checkWorktrees` had a per-item `try`/`catch` for exactly this
 * reason; `checkRepositories` did not, and #869 gave it one.
 *
 * Round 1 flagged the new guard as a coverage gap and named its closure: a doctor test with an
 * unresolvable git and two registered repositories, plus a falsifiability row. Round 3 measured
 * that the closure had been dropped rather than deferred — `REPOSITORY_PROBE_FAILED` appeared at
 * exactly one place in the repository, its own `findings.push`, with zero test or script
 * references. This file is that closure.
 *
 * The unresolvable git is real, not a mock. The sibling worktree case stubs its probe with
 * `vi.spyOn(...).mockRejectedValueOnce`, which measures the catch but not what actually reaches
 * it, and the reachable shape here is narrow: `tryRevParse` passes `allowFailure`, so a fatal
 * becomes `null` and the repository reports `REPOSITORY_UNREADABLE` through the ordinary path.
 * Only `isClean` throws, and it runs only when the head resolved. `core.bare = true` is the state
 * that produces exactly that pair — measured:
 *
 *     git rev-parse --verify 'HEAD^{commit}'   exit 0   54c5f28...
 *     git status --porcelain                   exit 128  fatal: this operation must be run in a work tree
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, commitAll, gitSync, makeRepo } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A registered checkout whose `git status` becomes fatal while `git rev-parse` keeps answering.
 *
 * Applied after registration on purpose: the registry refuses a path that is not a work tree, so a
 * checkout broken beforehand could never be registered and the probe would have nothing to fail
 * on. This is the state a checkout can fall into *while* registered, which is the case the guard
 * exists for.
 */
const breakStatusOnly = (checkoutPath: string): void => {
  gitSync(checkoutPath, ["config", "core.bare", "true"]);
};

const register = async (harness: ReturnType<typeof makeHarness>, checkoutPath: string, identity: string) => {
  const registered = await harness.cp.repositories.register({ checkoutPath, identity });
  if (!registered.allowed) throw new Error(`${identity}: ${registered.message}`);
  return registered.value;
};

/** Move a checkout off its acknowledged head, so a healthy probe has something to report. */
const drift = (checkoutPath: string): void => {
  writeFileSync(join(checkoutPath, "README.md"), "# changed out of band\n");
  commitAll(checkoutPath, "out of band");
};

describe("a repository probe that did not complete", () => {
  it("is reported, and does not carry the rest of the doctor report away with it", async () => {
    const harness = makeHarness();
    const broken = makeRepo({ "README.md": "# broken\n" });
    const healthy = makeRepo({ "README.md": "# healthy\n" });

    // The broken one first, so the loop has to *continue* rather than merely finish.
    await register(harness, broken, "local:probe-refuses");
    await register(harness, healthy, "local:probe-answers");
    drift(healthy);
    breakStatusOnly(broken);

    const report = await harness.cp.doctor.run("system");

    const probeFailed = report.findings.find((finding) => finding.code === "REPOSITORY_PROBE_FAILED");
    expect(probeFailed?.scope).toBe("repository:local:probe-refuses");
    expect(probeFailed?.blocking).toBe(true);

    // The point of the guard, stated as a finding that had to survive the refusal above it. Without
    // the per-repository catch this assertion is unreachable: the throw leaves `doctor.run()`
    // rejecting and there is no report to read at all.
    const driftFinding = report.findings.find((finding) => finding.code === "REPOSITORY_DRIFT");
    expect(driftFinding?.scope).toBe("repository:local:probe-answers");
  });

  it("is absent when both checkouts answer — the control", async () => {
    // A guard that emits its finding unconditionally would satisfy the case above while saying
    // nothing. #869's first repair of a sibling defect over-corrected in exactly this direction
    // and its control caught it on the first run.
    const harness = makeHarness();
    const first = makeRepo({ "README.md": "# one\n" });
    const second = makeRepo({ "README.md": "# two\n" });
    await register(harness, first, "local:answers-one");
    await register(harness, second, "local:answers-two");
    drift(second);

    const report = await harness.cp.doctor.run("system");

    expect(report.findings.map((finding) => finding.code)).not.toContain("REPOSITORY_PROBE_FAILED");
    expect(report.findings.find((finding) => finding.code === "REPOSITORY_DRIFT")?.scope).toBe(
      "repository:local:answers-two",
    );
  });

  it("keeps the refusal's own words out of the operator's evidence and inside the finding", async () => {
    // `safeErrorMessage` is what puts git's text in `observedEvidence.error`. The assertion is that
    // the finding names the checkout and carries a message, not that it quotes any particular git
    // wording — git's phrasing is not this project's contract.
    const harness = makeHarness();
    const broken = makeRepo({ "README.md": "# broken\n" });
    await register(harness, broken, "local:refusal-evidence");
    breakStatusOnly(broken);

    const report = await harness.cp.doctor.run("system");

    const probeFailed = report.findings.find((finding) => finding.code === "REPOSITORY_PROBE_FAILED");
    expect(probeFailed?.observedEvidence).toMatchObject({
      checkoutPath: expect.any(String),
      error: expect.any(String),
    });
    expect(String((probeFailed?.observedEvidence as { error?: unknown }).error)).not.toHaveLength(0);
  });
});
