import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixtureManifest, makeHarness } from "../helpers/harness.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { assertPortableManifest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import {
  parseVerificationCommand,
  PROJECT_VERIFICATION_EXECUTABLES,
} from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { runSandboxed, type SandboxOutcome } from "../../src/verify/sandbox.ts";

/**
 * #1253 — a project whose suite is not a Node toolchain (Repo Factory's is pytest) could declare no
 * verification command, because argv[0] had to be one of the shared allowlist's Node tools, so its
 * STANDARD_WORK runs stopped at VERIFICATION_GAP. A project can now name an extra executable in its
 * own manifest (`verificationExecutables`); only that project's runs may launch it, and only names
 * ACP lists as addable are accepted. ACP ships that list empty, so production admits none.
 *
 * To exercise the mechanism, the "with an addable name" cases add `python3` to that list for this
 * file only and remove it afterwards. Nothing in src/ changes for it; the "production" cases run
 * against the list as shipped.
 */

afterEach(cleanupTempDirs);

const ADDED_FOR_TESTS = "python3";
const addable = PROJECT_VERIFICATION_EXECUTABLES as Set<string>;
const withAddableName = (): void => {
  beforeEach(() => {
    addable.add(ADDED_FOR_TESTS);
  });
  afterEach(() => {
    addable.delete(ADDED_FOR_TESTS);
  });
};

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
    verificationExecutables: [ADDED_FOR_TESTS],
    verificationCommands: [pythonCommand([ADDED_FOR_TESTS, "verify.py"])],
    ...overrides,
  });

const issuesOf = (manifest: unknown): Array<{ path: string; message: string }> => {
  const decision = assertPortableManifest(manifest);
  if (decision.allowed) return [];
  return (decision.evidence as { issues?: Array<{ path: string; message: string }> }).issues ?? [];
};

const notAddable = (name: string) => [
  expect.objectContaining({ path: "verificationExecutables", message: expect.stringContaining(`'${name}'`) }),
  expect.objectContaining({
    path: "verificationCommands.0.argv.0",
    message: expect.stringContaining("is not on the verification executable allowlist"),
  }),
];

describe("#1253 production admits no project-added executable", () => {
  it("ships an empty addable list", () => {
    expect([...PROJECT_VERIFICATION_EXECUTABLES]).toEqual([]);
  });

  it("refuses a manifest that names python3 exactly as it refuses any other name", () => {
    expect(issuesOf(pythonManifest())).toEqual(notAddable("python3"));
    expect(issuesOf(pythonManifest({
      verificationExecutables: ["sh"],
      verificationCommands: [pythonCommand(["sh", "verify.py"])],
    }))).toEqual(notAddable("sh"));
  });

  sandboxIt("the sandbox refuses python3 even for a request that declares it", async () => {
    const worktree = tempDir("acp-1253-sandbox-");
    writeFiles(worktree, { "verify.py": "print('python suite ran')\n" });
    const outcome = await runSandboxed({
      command: pythonCommand(["python3", "verify.py"]),
      worktreePath: worktree,
      processLimit: "supervised-budget",
      executables: ["python3"],
    });
    expect(outcome, described(outcome)).toMatchObject({ status: "ERROR", reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(outcome.stderr).toContain("is not on the verification executable allowlist");
  });
});

describe("#1253 with an addable name, a project's manifest names the executables its own commands may launch", () => {
  withAddableName();

  it("accepts the command when the manifest names the executable", () => {
    expect(assertPortableManifest(pythonManifest())).toMatchObject({ allowed: true });
  });

  it("refuses the same command in a manifest that does not name it", () => {
    const { verificationExecutables: _omitted, ...undeclared } = pythonManifest();
    expect(issuesOf(undeclared)).toEqual([
      expect.objectContaining({
        path: "verificationCommands.0.argv.0",
        message: expect.stringContaining("is not on the verification executable allowlist"),
      }),
    ]);
  });

  it("still refuses a name ACP does not list as addable", () => {
    expect(issuesOf(pythonManifest({
      verificationExecutables: ["sh"],
      verificationCommands: [pythonCommand(["sh", "-c", "exit 0"])],
    }))).toEqual(notAddable("sh"));
  });

  it("leaves a command outside a manifest on the shared allowlist", () => {
    expect(() => parseVerificationCommand({ id: "verify", argv: ["python3", "verify.py"] }))
      .toThrow(/not on the verification executable allowlist/);
  });

  sandboxIt("the sandbox launches it only for a request that carries the declaration", async () => {
    const worktree = tempDir("acp-1253-sandbox-");
    writeFiles(worktree, { "verify.py": "print('python suite ran')\n" });
    const command = pythonCommand(["python3", "verify.py"]);

    const declared = await runSandboxed({
      command,
      worktreePath: worktree,
      processLimit: "supervised-budget",
      executables: ["python3"],
    });
    expect(declared, described(declared)).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(declared.stdout.trim()).toBe("python suite ran");

    const undeclared = await runSandboxed({ command, worktreePath: worktree, processLimit: "supervised-budget" });
    expect(undeclared, described(undeclared)).toMatchObject({ status: "ERROR", reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(undeclared.stderr).toContain("is not on the verification executable allowlist");
  });
});

describe("#1253 with an addable name, a STANDARD run runs the project's suite in the sandbox and records the result", () => {
  withAddableName();

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
