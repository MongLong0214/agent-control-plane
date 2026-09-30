import { rmSync } from "node:fs";

import { gitSync } from "../helpers/fixtures.ts";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const missingCheckout = async (suspended: boolean) => {
  const harness = makeHarness();
  const { projectId, identity } = await registerFixtureProject(harness);
  const checkoutPath = harness.cp.repositories.list().find((repository) => repository.identity === identity)!.checkoutPath;
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  if (suspended) {
    expect(harness.cp.projects.setSuspended(projectId, true, true).allowed).toBe(true);
  }
  rmSync(harness.repoPath, { recursive: true, force: true });
  return { harness, identity, checkoutPath };
};

describe("#1032: a registered checkout disappears", () => {
  it("downgrades both findings for a suspended project and permits daemon startup", async () => {
    const { harness, identity, checkoutPath } = await missingCheckout(true);
    const report = await harness.cp.doctor.run("system");
    const missing = report.findings.filter((finding) =>
      finding.scope === `repository:${identity}` &&
      ["REPOSITORY_UNREADABLE", "WORKTREE_PROBE_FAILED"].includes(finding.code)
    );
    expect(missing.map((finding) => finding.code).sort()).toEqual([
      "REPOSITORY_UNREADABLE", "WORKTREE_PROBE_FAILED",
    ]);
    for (const finding of missing) {
      expect(finding).toMatchObject({
        severity: "WARN",
        blocking: false,
        observedEvidence: { projectSuspended: true, checkoutPath },
      });
      expect(finding.recommendedAction).toMatch(/restore.*checkout.*before resuming the project/i);
    }

    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-1032-suspended-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (started.allowed) {
      expect(started.value.doctorStatus).not.toBe("BLOCKED");
      expect(started.value.blockingFindings.map((finding) => finding.code)).not.toContain("REPOSITORY_UNREADABLE");
      expect(started.value.blockingFindings.map((finding) => finding.code)).not.toContain("WORKTREE_PROBE_FAILED");
    }
    await daemon.stop();
  });

  it("keeps both findings blocking for an active project and refuses daemon startup", async () => {
    const { harness, identity } = await missingCheckout(false);
    const report = await harness.cp.doctor.run("system");
    const missing = report.findings.filter((finding) =>
      finding.scope === `repository:${identity}` &&
      ["REPOSITORY_UNREADABLE", "WORKTREE_PROBE_FAILED"].includes(finding.code)
    );
    expect(missing.map((finding) => finding.code).sort()).toEqual([
      "REPOSITORY_UNREADABLE", "WORKTREE_PROBE_FAILED",
    ]);
    for (const finding of missing) {
      expect(finding.severity).toBe("ERROR");
      expect(finding.blocking).toBe(true);
      expect(finding.observedEvidence).not.toHaveProperty("projectSuspended");
    }

    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-1032-active-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
  });

  it("keeps a repository with no project blocking", async () => {
    const harness = makeHarness();
    const repository = await harness.cp.repositories.register({
      checkoutPath: harness.repoPath,
      identity: "local:unassigned",
    });
    expect(repository.allowed).toBe(true);
    rmSync(harness.repoPath, { recursive: true, force: true });

    const report = await harness.cp.doctor.run("system");
    const missing = report.findings.filter((finding) =>
      finding.scope === "repository:local:unassigned" &&
      ["REPOSITORY_UNREADABLE", "WORKTREE_PROBE_FAILED"].includes(finding.code)
    );
    expect(missing).toHaveLength(2);
    for (const finding of missing) {
      expect(finding.severity).toBe("ERROR");
      expect(finding.blocking).toBe(true);
      expect(finding.observedEvidence).not.toHaveProperty("projectSuspended");
    }
  });

  it.each([
    ["suspended", true, { severity: "WARN", blocking: false }],
    ["active", false, { severity: "ERROR", blocking: true }],
  ])("reports a %s project's failed repository probe accordingly", async (_label, suspended, expected) => {
    const harness = makeHarness();
    const { projectId, identity } = await registerFixtureProject(harness);
    if (suspended) expect(harness.cp.projects.setSuspended(projectId, true, true).allowed).toBe(true);
    // `rev-parse` still answers and `git status` refuses: the probe throws on a checkout that exists.
    gitSync(harness.repoPath, ["config", "core.bare", "true"]);
    const report = await harness.cp.doctor.run("system");
    const failed = report.findings.find((finding) =>
      finding.scope === `repository:${identity}` && finding.code === "REPOSITORY_PROBE_FAILED");
    expect(failed).toMatchObject(expected);
    expect(failed?.observedEvidence["projectSuspended"]).toBe(suspended ? true : undefined);
  });
});
