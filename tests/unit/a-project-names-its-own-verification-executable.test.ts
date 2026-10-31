import { afterEach, describe, expect, it } from "vitest";

import { fixtureManifest, makeHarness } from "../helpers/harness.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { assertPortableManifest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { runSandboxed, type SandboxOutcome } from "../../src/verify/sandbox.ts";

/**
 * #1253 — a project whose suite is not a Node toolchain (Repo Factory's is pytest) could declare no
 * verification command, because argv[0] had to be one of the shared allowlist's Node tools, so its
 * STANDARD_WORK runs stopped at VERIFICATION_GAP. #1253 let a manifest name extra executables from an
 * addable list that shipped empty. The owner directive of 2026-10-31 removed both lists: any
 * executable may be argv[0], so a manifest declares `python3 verify.py` as it is, with no list. What
 * stays bound is that only the commands the pinned manifest declares run.
 *
 * These cases used to prove the refusal; they now prove the same commands are accepted and run.
 */

afterEach(cleanupTempDirs);

const sandboxIt = (name: string, fn: () => Promise<void>): void => {
  if (process.platform === "darwin") it(name, fn);
};

const described = (outcome: SandboxOutcome): string =>
  `sandbox ${outcome.status} exit=${outcome.exitCode} reason=${outcome.reasonCode ?? "none"} ` +
  `stdout: ${outcome.stdout.trim().slice(-500)} stderr: ${outcome.stderr.trim().slice(-1_500)}`;

const pythonCommand = (argv: string[]): ProjectManifest["verificationCommands"][number] => ({
  ...fixtureManifest("python-project").verificationCommands[0]!,
  argv,
});

const pythonManifest = (overrides: Partial<ProjectManifest> = {}): ProjectManifest =>
  fixtureManifest("python-project", {
    verificationCommands: [pythonCommand(["python3", "verify.py"])],
    ...overrides,
  });

const issuesOf = (manifest: unknown): Array<{ path: string; message: string }> => {
  const decision = assertPortableManifest(manifest);
  if (decision.allowed) return [];
  return (decision.evidence as { issues?: Array<{ path: string; message: string }> }).issues ?? [];
};

describe("any executable may be argv[0]; there is no executable list to declare", () => {
  it("accepts a manifest whose command is python3, with no list", () => {
    expect(assertPortableManifest(pythonManifest())).toMatchObject({ allowed: true });
  });

  it("accepts sh exactly as it accepts python3: no executable is special", () => {
    expect(assertPortableManifest(pythonManifest({
      verificationCommands: [pythonCommand(["sh", "verify.sh"])],
    }))).toMatchObject({ allowed: true });
  });

  it("refuses a manifest that still names verificationExecutables, now an unknown key", () => {
    expect(issuesOf({ ...pythonManifest(), verificationExecutables: ["python3"] })).toEqual([
      expect.objectContaining({ message: expect.stringContaining("verificationExecutables") }),
    ]);
  });

  it("accepts the same command outside a manifest", () => {
    expect(parseVerificationCommand({ id: "verify", argv: ["python3", "verify.py"] }).argv).toEqual(["python3", "verify.py"]);
  });

  it("still refuses an argv[0] that leads to no executable file", () => {
    expect(issuesOf(pythonManifest({
      verificationCommands: [pythonCommand(["acp-no-such-tool-1253", "verify.py"])],
    }))).toEqual([
      expect.objectContaining({
        path: "verificationCommands.0.argv.0",
        message: expect.stringContaining("does not lead to an executable file"),
      }),
    ]);
  });

  sandboxIt("the sandbox runs python3 for any request, with no declaration", async () => {
    const worktree = tempDir("acp-1253-sandbox-");
    writeFiles(worktree, { "verify.py": "print('python suite ran')\n" });
    const outcome = await runSandboxed({
      command: pythonCommand(["python3", "verify.py"]),
      worktreePath: worktree,
      processLimit: "supervised-budget",
    });
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(outcome.stdout.trim()).toBe("python suite ran");
  });
});

describe("a STANDARD run runs a python suite in the sandbox and records the result", () => {

  const contract = {
    goal: "python verification",
    why: "test",
    scope: [],
    nonGoals: [],
    acceptance: ["verified"],
    priority: "NORMAL" as const,
    humanGate: [],
    references: [],
  };

  const verifyStandardRun = async (manifest: ProjectManifest, files: Record<string, string>) => {
    const harness = makeHarness();
    const project = harness.cp.projects.register({
      projectId: manifest.projectId,
      name: "python-project",
      manifest,
      authorization: harness.cp.manifestAuthorizationForTests(manifest),
    });
    if (!project.allowed) throw new Error(project.message);
    const repository = await harness.cp.repositories.register({
      checkoutPath: harness.repoPath,
      projectId: manifest.projectId,
      repositoryRole: "primary",
      activeManifestDigest: project.value.activeManifestDigest,
      identity: "github:acme/fixture",
    });
    if (!repository.allowed) throw new Error(repository.message);
    const created = harness.cp.runs.create({
      projectId: manifest.projectId,
      executionMode: ExecutionMode.STANDARD,
      contract,
      repositories: [{ repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    gitSync(harness.repoPath, ["checkout", "-q", "-b", "task/python-suite"]);
    writeFiles(harness.repoPath, files);
    commitAll(harness.repoPath, "python suite");
    const snapshot = await harness.cp.pipeline.freeze(created.value.runId);
    if (!snapshot.allowed) throw new Error(snapshot.message);
    const verified = await harness.cp.verification.verify({
      runId: created.value.runId,
      snapshot: snapshot.value,
      commands: manifest.verificationCommands,
      contractDigest: snapshot.value.contractDigest,
    });
    const recorded = harness.cp.db.all<{ command_id: string; status: string }>(
      "SELECT command_id, status FROM verification_results WHERE run_id = ?",
      [created.value.runId],
    );
    return { verified, recorded };
  };

  sandboxIt("a passing suite is recorded PASS", async () => {
    const { verified, recorded } = await verifyStandardRun(pythonManifest(), {
      "verify.py": "import sys\nprint('python suite ran')\nsys.exit(0)\n",
    });
    expect(verified.allowed, verified.allowed ? "" : `${verified.reasonCode}: ${verified.message}`).toBe(true);
    if (!verified.allowed) return;
    expect(verified.value).toMatchObject({ status: "PASS", results: [{ commandId: "verify", status: "PASS" }] });
    expect(recorded).toEqual([{ command_id: "verify", status: "PASS" }]);
  });

  sandboxIt("a failing suite is recorded FAIL", async () => {
    const { verified, recorded } = await verifyStandardRun(pythonManifest(), {
      "verify.py": "import sys\nprint('one test failed')\nsys.exit(1)\n",
    });
    expect(verified).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED });
    expect(recorded).toEqual([{ command_id: "verify", status: "FAIL" }]);
  });

  it("with no command configured the run still stops at VERIFICATION_GAP", async () => {
    const manifest = pythonManifest({
      verificationProfiles: { simple: [], standard: [], guarded: [] },
      verificationCommands: [],
    });
    const { verified, recorded } = await verifyStandardRun(manifest, { "verify.py": "print('unused')\n" });
    expect(verified).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP });
    expect(recorded).toEqual([]);
  });
});
