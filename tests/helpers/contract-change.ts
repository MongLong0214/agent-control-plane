import { sha256 } from "../../src/core/digest.ts";
import { manifestDigest, projectManifestSchema, type ProjectManifest } from "../../src/contracts/manifest.ts";
import type { VerificationCommand } from "../../src/contracts/verification-command.ts";
import { ExecutionMode, Role, type RunKind, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { bindCeo, type Harness } from "./harness.ts";

/**
 * Issue #246 B2-a — the CONTRACT_CHANGE fixture the carriage and binding witnesses share: a project
 * on the harness's fixture manifest (the base, M0), and M1, which adds `unit-tests` (BOTH_REQUIRED)
 * and the CI workflow that runs it. Nothing here writes anything a production door would not.
 */

export const CONTRACT_CHANGE_CONTRACT: TaskContract = {
  goal: "add unit tests and CI to the project contract",
  why: "git status alone is not a verification bar",
  scope: [".github/workflows/ci.yml"],
  nonGoals: [],
  acceptance: ["the proposed manifest requires the tests locally and in CI"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test\n";

export const UNIT_TESTS: VerificationCommand = {
  id: "unit-tests",
  argv: ["node", "--test"],
  repositoryRole: "primary",
  cwd: ".",
  timeoutSeconds: 120,
  envAllowlist: ["CI"],
  network: "deny",
  networkAllowlist: [],
  required: true,
  evidenceMode: "BOTH_REQUIRED",
  maxOutputBytes: 1_048_576,
  maxMemoryMb: 2048,
};

export const normalized = (manifest: unknown): ProjectManifest => projectManifestSchema.parse(manifest);

/** M1: the base with `unit-tests` (BOTH_REQUIRED) required and its CI workflow approved. Stricter. */
export const stricter = (base: ProjectManifest): ProjectManifest => normalized({
  ...base,
  verificationCommands: [...base.verificationCommands, UNIT_TESTS],
  verificationProfiles: {
    simple: base.verificationProfiles.simple,
    standard: [...base.verificationProfiles.standard, "unit-tests"],
    guarded: [...base.verificationProfiles.guarded, "unit-tests"],
  },
  ciWorkflows: [
    ...base.ciWorkflows,
    { path: WORKFLOW_PATH, checkName: "unit-tests", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" },
  ],
});

export const planCarrying = (manifest: unknown, digest: string = manifestDigest(normalized(manifest))) => ({
  summary: "change the project contract",
  projectManifestDigest: digest,
  projectManifest: manifest,
});

export interface DispatchedRun {
  runId: string;
  projectId: string;
  base: ProjectManifest;
  baseDigest: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
}

export const dispatchRun = async (
  harness: Harness,
  projectId: string,
  kind: RunKind,
  repositories: Array<{ repositoryId: string; repositoryRole: string; baseBranch: string }> = [],
): Promise<DispatchedRun> => {
  if (!harness.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(harness);
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const created = harness.cp.runs.create({ projectId, kind, executionMode: ExecutionMode.STANDARD, contract: CONTRACT_CHANGE_CONTRACT, repositories });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const baseDigest = dispatched.value.pinnedManifestDigest!;
  return {
    runId: created.value.runId,
    projectId,
    base: harness.cp.projects.manifest(baseDigest)!,
    baseDigest,
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
  };
};

export const storedPlan = (harness: Harness, runId: string) => harness.cp.artifacts.latest<Record<string, unknown>>(runId, "PLAN");
