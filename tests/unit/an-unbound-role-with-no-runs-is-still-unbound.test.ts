import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The deployment read `NORMAL` with nothing blocking while no role was bound at all.
 *
 * Measured on the live database 2026-09-20: `ACTIVE assignments` 0 rows, `runs` 0 rows, and
 * `health.json` reporting `mode NORMAL` with `blockingFindings []` for two days. Nothing could be
 * dispatched and no surface said so.
 *
 * The cause is a condition that cannot become true from the state it is supposed to describe.
 * `checkBindings` reported a missing CTO only when the project also had **open runs** — and
 * `runs.create()`'s one production caller is the CEO MCP port, so a project with no bound role
 * cannot acquire a run. Unbound means no runs; no runs means unreported.
 *
 * These rows pin the reachable half, and the last one pins the reason the finding must not block.
 */
describe("an unbound role with no runs is still unbound", () => {
  it("reports a project whose primary CTO is unbound and which has no runs at all", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);

    const report = await harness.cp.doctor.run("system");
    const finding = report.findings.find((f) => f.code === "CTO_MISSING_WITH_NO_RUNS");

    expect(finding, "an unbound project with no runs produced no finding").toBeDefined();
    expect(finding?.scope).toBe(`project:${projectId}`);
    expect(harness.cp.runs.list({ projectId })).toHaveLength(0);
  });

  it("does not block, because blocking parks the daemon behind the thing that would fix it", async () => {
    // #950 and #958: a blocking finding for a missing thing is how a daemon ends up waiting on
    // the coordinator that would supply it. A deployment with an unbound role can still do
    // everything that is not a run, and it has to stay up to be bound at all.
    const harness = makeHarness();
    await registerFixtureProject(harness);

    const report = await harness.cp.doctor.run("system");

    expect(report.findings.filter((f) => f.blocking).map((f) => f.code))
      .not.toContain("CTO_MISSING_WITH_NO_RUNS");
  });

  it("says nothing about a suspended project, which is deliberately unbound", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    expect(harness.cp.projects.setSuspended(projectId, true, true).allowed).toBe(true);

    const report = await harness.cp.doctor.run("system");

    expect(report.findings.map((f) => f.code)).not.toContain("CTO_MISSING_WITH_NO_RUNS");
  });

  it("cannot be qualified by `activity`, which is the same fact under another name", async () => {
    // The first draft added `project.activity !== "INACTIVE"` as a condition and would have
    // reported nothing ever. `ProjectRegistry` derives activity as
    // `(bound PRIMARY_CTO count) > 0 ? "ACTIVE" : "INACTIVE"`, so an unbound project is always
    // INACTIVE — the guard would have made the branch unreachable, which is the defect this
    // check exists to remove, reproduced inside it.
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);

    expect(harness.cp.projects.get(projectId)?.activity).toBe("INACTIVE");
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();

    const report = await harness.cp.doctor.run("system");
    expect(report.findings.map((f) => f.code)).toContain("CTO_MISSING_WITH_NO_RUNS");
  });
});
