import { afterAll, describe, expect, it } from "vitest";

import { bootstrapOperations, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { type Operation, activateAndConfirm, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { projectCi } from "../../src/registry/project-ci.ts";

afterAll(cleanupTempDirs);

/**
 * #1172 — the activation result says what CI the activated project declares, beside its availability,
 * so a healthy activation cannot be read as CI PASS. Read from the same `projectCi` as `project_get`.
 */
describe("bootstrap activation CI status (#1172)", () => {
  it("names CI NOT_DECLARED beside an unchanged availability, before and after the CEO CONFIRM", async () => {
    const prepared = await prepareBootstrapRun("ci-status-activation", {
      manifest: cleanTreeManifest("ci-status-activation"),
      ops: bootstrapOperations() as Operation[],
    });

    const { beforeConfirm, final } = await activateAndConfirm(prepared);

    const cp = prepared.harness.cp;
    const project = cp.projects.require("ci-status-activation");
    for (const activation of [beforeConfirm, final]) {
      expect(activation["ci"]).toMatchObject({ status: "NOT_DECLARED", declared: false, reason: "NO_CI_WORKFLOWS" });
      expect(activation["availability"]).toBe(project.availability);
    }
    expect(final["ci"]).toEqual(projectCi(cp.db, cp.projects, "ci-status-activation"));
  });
});
