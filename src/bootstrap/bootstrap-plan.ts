import { z } from "zod";

import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, assertPortableManifest, manifestDigest } from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import { RunKind } from "../domain/types.ts";
import { parseGitHubIdentity } from "./github-write-port.ts";
import { githubOperationSchema, preflightGitHubOperations, type GitHubOperation } from "./repo-factory-github.ts";
import {
  plannedBootstrapFiles,
  verificationKindRunning,
  type PlannedBootstrapFile,
  type RepoFactoryPlanFixture,
  type VerificationKind,
} from "./repo-factory-producer.ts";

/**
 * Issue #246 PR-C slice C2 — what a project-less PROJECT_BOOTSTRAP run's PLAN commits to, before
 * anything is written.
 *
 * The bootstrap CTO's `plan_submit` carries the full project manifest, and the PLAN artifact keeps it,
 * so the PLAN digest covers the manifest as well as the operations. From that artifact alone,
 * `plannedBootstrapOutputs` derives what production would leave behind: the files with their exact
 * bytes, the GitHub operations in the order they run, the default branch and the repository they
 * target, the verification command and the activation handoff. The candidate a bootstrap run freezes
 * names that PLAN, its manifest and those outputs by digest (`BootstrapPlanBinding`); the blind review
 * reads the outputs reloaded from the PLAN artifact; and activation accepts only a PASS whose binding
 * is the run's current one.
 *
 * Sharing this derivation with the producer is not verification (the CEO's correction): the reviewer
 * judges the outputs against the contract and the manifest, and after production the real tree at
 * the exact head must equal the approved files (`producedTreeDrift`).
 */

/** The approved PLAN artifact's provenance, as `BootstrapActivation` already requires it. */
export const approvedPlanSchema = z.object({
  bootstrapOperationId: z.string().min(1),
  requestDigest: z.string().min(1),
  projectManifestDigest: z.string().min(1),
  githubOperations: z.array(z.unknown()),
});

export type ApprovedBootstrapPlan = z.infer<typeof approvedPlanSchema>;

/** Its operations as this producer executes them: each with the state it asks for. */
export const executableOperationsSchema = z.array(githubOperationSchema).min(1);

/** A PLAN artifact as the store returns it: its digest and its content. */
export interface BootstrapPlanArtifact {
  digest: string;
  content: unknown;
}

/** The three digests a bootstrap candidate, its review and its activation are bound to. */
export interface BootstrapPlanBinding {
  planDigest: string;
  projectManifestDigest: string;
  plannedOutputsDigest: string;
}

export const bootstrapPlanBindingSchema = z
  .object({
    planDigest: z.string().min(1),
    projectManifestDigest: z.string().min(1),
    plannedOutputsDigest: z.string().min(1),
  })
  .strict();

export const sameBootstrapPlanBinding = (
  left: BootstrapPlanBinding | null | undefined,
  right: BootstrapPlanBinding | null | undefined,
): boolean =>
  left != null &&
  right != null &&
  left.planDigest === right.planDigest &&
  left.projectManifestDigest === right.projectManifestDigest &&
  left.plannedOutputsDigest === right.plannedOutputsDigest;

/**
 * The activation handoff a CEO-confirmed bootstrap delivers to the project's primary CTO. Nothing
 * on this path supplies one, so it is derived from the approved manifest alone — and is therefore
 * the same package on every call, which `activate` requires of a retry.
 */
export const bootstrapActivationHandoff = (manifest: ProjectManifest): HandoffPackage => ({
  projectStatus: "BOOTSTRAPPED",
  activeManifestDigest: manifestDigest(manifest),
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: manifest.repositories.map((repository) => ({
    identity: repository.remote,
    branch: null,
    head: null,
  })),
  knownRisks: [],
  recommendedNextAction: "acknowledge this handoff; the project's first work arrives as a run",
});

export interface BootstrapPlanPreflight {
  plan: ApprovedBootstrapPlan;
  operations: GitHubOperation[];
  repository: ProjectManifest["repositories"][number];
  command: VerificationCommand;
  verificationKind: VerificationKind;
  defaultBranch: string;
  /** The plan as the producer executes it. */
  executable: RepoFactoryPlanFixture;
}

/**
 * The pure checks the Repo Factory runner makes of a PLAN artifact and the manifest it names, lifted
 * out of `RepoFactoryBootstrapRunner.produceAndActivate` unchanged: the same refusals, in the same
 * order, with the same evidence (`stage: "precondition"`, the refusal name and the run id). It reads
 * nothing and writes nothing.
 */
export const bootstrapPlanPreflight = (input: {
  runId: string;
  planArtifact: BootstrapPlanArtifact | null;
  manifest: ProjectManifest;
}): Decision<BootstrapPlanPreflight> => {
  const { runId, planArtifact, manifest } = input;
  const refuse = (
    reasonCode: ReasonCode,
    refusal: string,
    message: string,
    evidence: Evidence = {},
  ): Decision<BootstrapPlanPreflight> => deny(reasonCode, message, { stage: "precondition", refusal, runId, ...evidence });

  const approvedPlan = approvedPlanSchema.safeParse(planArtifact?.content);
  if (planArtifact === null) {
    return refuse(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "PLAN_MISSING", "the run has no approved PLAN artifact");
  }
  if (!approvedPlan.success) {
    return refuse(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "PLAN_MISSING",
      "the run's PLAN artifact carries no bootstrap operation provenance",
    );
  }
  const plan = approvedPlan.data;

  // What executes is the artifact's own operations (RF1043-01). An artifact that names its
  // operations without the state each asks for approved nothing that could be executed.
  const executableOperations = executableOperationsSchema.safeParse(plan.githubOperations);
  if (!executableOperations.success) {
    return refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "PLAN_NOT_EXECUTABLE",
      "the approved PLAN artifact's GitHub operations do not carry the state each asks for, so there is nothing approved to execute",
      { issues: executableOperations.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    );
  }
  const operations = executableOperations.data;

  const manifestMismatch = (message: string, evidence: Evidence): Decision<BootstrapPlanPreflight> =>
    refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "MANIFEST_MISMATCH", message, evidence);
  const approvedManifestDigest = manifestDigest(manifest);
  if (approvedManifestDigest !== plan.projectManifestDigest) {
    return manifestMismatch("the manifest supplied is not the one the PLAN artifact approved", {
      supplied: approvedManifestDigest,
      approved: plan.projectManifestDigest,
    });
  }
  const declared = manifest.repositories[0];
  if (manifest.repositories.length !== 1) {
    return manifestMismatch("this producer creates exactly one repository and the manifest declares a different count", {
      declared: manifest.repositories.length,
    });
  }
  if (declared === undefined) return manifestMismatch("the manifest declares no repository", {});

  // RF1043-03 — a PASS is recorded under a manifest command id, so it must be the command the
  // producer runs. Anything else the manifest requires would be missing or misreported, and
  // activation would find that only after the repository already existed.
  const unsupported = (message: string, evidence: Evidence): Decision<BootstrapPlanPreflight> =>
    refuse(ReasonCode.VERIFICATION_GAP, "UNSUPPORTED_VERIFICATION", message, evidence);
  if (manifest.ciWorkflows.length > 0) {
    return unsupported("the manifest requires CI evidence, and this producer produces none", {
      ciWorkflows: manifest.ciWorkflows.map((workflow) => workflow.checkName),
    });
  }
  // G0a (RF-018) — the same for CommitLore: this producer installs no CommitLore hook and observes no
  // record, so a manifest that requires it would activate with the requirement silently unmet.
  // `preferred` activates, with the activation result naming CommitLore as not observed.
  if (manifest.commitlore.mode === "required") {
    return unsupported("the manifest requires CommitLore, and this producer neither installs it nor observes any record", {
      commitloreMode: manifest.commitlore.mode,
    });
  }
  const command = manifest.verificationCommands[0];
  if (manifest.verificationCommands.length !== 1) {
    return unsupported("this producer runs exactly one verification, and the manifest requires a different count", {
      commands: manifest.verificationCommands.map((candidate) => candidate.id),
    });
  }
  if (command === undefined) return unsupported("the manifest requires no verification command", {});
  const verificationKind = verificationKindRunning(command.argv);
  if (verificationKind === null) {
    return unsupported(`the manifest's command ${command.id} is not an invocation this producer runs`, {
      commandId: command.id,
      argv: command.argv,
    });
  }
  if (command.cwd !== ".") {
    return unsupported(`the manifest runs ${command.id} outside the repository root, where this producer runs it`, {
      commandId: command.id,
      cwd: command.cwd,
    });
  }
  if (command.repositoryRole !== declared.role) {
    return unsupported(`the manifest runs ${command.id} in another repository`, { commandId: command.id });
  }
  if (command.evidenceMode !== "LOCAL_COMMAND") {
    return unsupported(`the manifest requires ${command.id} as ${command.evidenceMode} evidence, and this producer records a local run`, {
      commandId: command.id,
      evidenceMode: command.evidenceMode,
    });
  }

  const push = operations.find((operation) => operation.resourceType === "branch");
  const pushed = push === undefined ? null : parseGitHubIdentity(push.resourceIdentity);
  const defaultBranch = pushed === null ? null : pushed.ref;
  if (defaultBranch === null) {
    return refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "PLAN_NOT_EXECUTABLE",
      "the approved PLAN artifact pushes no branch, so a produced repository would have no verified head",
    );
  }
  return allow(ReasonCode.OK, {
    plan,
    operations,
    repository: declared,
    command,
    verificationKind,
    defaultBranch,
    executable: {
      runId,
      bootstrapOperationId: plan.bootstrapOperationId,
      requestDigest: plan.requestDigest,
      planDigest: planArtifact.digest,
      projectManifestDigest: plan.projectManifestDigest,
      repositoryRole: declared.role,
      defaultBranch,
      verificationCommandId: command.id,
      verificationKind,
      githubOperations: operations,
    },
  });
};

export const BOOTSTRAP_PLANNED_OUTPUTS_SCHEMA_ID = "agent-control-plane.bootstrap-planned-outputs.v1";

/** Everything a bootstrap plan says production leaves behind, before anything is written. */
export interface PlannedBootstrapOutputs {
  schema: typeof BOOTSTRAP_PLANNED_OUTPUTS_SCHEMA_ID;
  runId: string;
  bootstrapOperationId: string;
  requestDigest: string;
  projectManifestDigest: string;
  /** The repository the operations create, exactly as the manifest's one repository names it. */
  target: { repositoryIdentity: string; repositoryRole: string; visibility: "public" | "private" };
  defaultBranch: string;
  /** Every file the produced commit holds, with its exact bytes. */
  files: PlannedBootstrapFile[];
  /** The GitHub operations in the order they run, desired state included. */
  githubOperations: GitHubOperation[];
  verification: { commandId: string; argv: string[]; cwd: string; kind: VerificationKind };
  handoff: HandoffPackage;
}

/**
 * The outputs a PLAN artifact and its manifest produce. Pure: the lifted preflight, then the GitHub
 * operations judged against the plan's own owner and visibility (the owner's approval must later name
 * the same ones, which the runner checks with the approval's authority), then the manifest's remote
 * against the repository the plan creates. A plan this producer could not execute has no outputs.
 */
export const plannedBootstrapOutputs = (
  plan: { runId: string; planArtifact: BootstrapPlanArtifact | null },
  manifest: ProjectManifest,
): Decision<PlannedBootstrapOutputs> => {
  const preflight = bootstrapPlanPreflight({ runId: plan.runId, planArtifact: plan.planArtifact, manifest });
  if (!preflight.allowed) return preflight as Decision<PlannedBootstrapOutputs>;
  const { operations, repository, command, verificationKind, defaultBranch, executable } = preflight.value;
  const refuse = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Evidence = {}) =>
    deny(reasonCode, message, { stage: "precondition", refusal, runId: plan.runId, ...evidence }) as Decision<PlannedBootstrapOutputs>;

  // The authority the plan itself implies: its first operation's owner and visibility, and its own
  // operations. Only the shape is judged here; whom the owner approved is the runner's question.
  const first = operations[0];
  if (first === undefined || first.resourceType !== "repository") {
    return refuse(
      ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      "UNSUPPORTED_PLAN_SHAPE",
      "the first GitHub operation must create the repository every later operation targets",
      { operationId: first?.operationId ?? null },
    );
  }
  const created = parseGitHubIdentity(first.resourceIdentity);
  if (created === null) {
    return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "UNSUPPORTED_PLAN_SHAPE", "the repository identity is not github:<owner>/<name>", {
      resourceIdentity: first.resourceIdentity,
    });
  }
  const shape = preflightGitHubOperations(executable, {
    owner: created.owner,
    visibility: first.desiredState.visibility,
    approvedOperations: operations.map(({ operationId, resourceType, resourceIdentity }) => ({
      operationId,
      resourceType,
      resourceIdentity,
    })),
  });
  if (!shape.allowed) {
    return deny(shape.reasonCode, shape.message, { stage: "precondition", runId: plan.runId, ...shape.evidence });
  }
  if (repository.remote !== shape.value.repositoryIdentity) {
    return refuse(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "MANIFEST_MISMATCH", "the manifest's remote is not the repository the plan creates", {
      manifestRemote: repository.remote,
      planned: shape.value.repositoryIdentity,
    });
  }
  return allow(ReasonCode.OK, {
    schema: BOOTSTRAP_PLANNED_OUTPUTS_SCHEMA_ID,
    runId: plan.runId,
    bootstrapOperationId: executable.bootstrapOperationId,
    requestDigest: executable.requestDigest,
    projectManifestDigest: executable.projectManifestDigest,
    target: {
      repositoryIdentity: shape.value.repositoryIdentity,
      repositoryRole: repository.role,
      visibility: shape.value.visibility,
    },
    defaultBranch,
    files: plannedBootstrapFiles(executable),
    githubOperations: shape.value.operations,
    verification: { commandId: command.id, argv: [...command.argv], cwd: command.cwd, kind: verificationKind },
    handoff: bootstrapActivationHandoff(manifest),
  });
};

/**
 * The plan the producer executes, rebuilt from the approved outputs and the PLAN digest — so the
 * producer is handed nothing the reviewed outputs do not already state.
 */
export const executablePlanOf = (outputs: PlannedBootstrapOutputs, planDigest: string): RepoFactoryPlanFixture => ({
  runId: outputs.runId,
  bootstrapOperationId: outputs.bootstrapOperationId,
  requestDigest: outputs.requestDigest,
  planDigest,
  projectManifestDigest: outputs.projectManifestDigest,
  repositoryRole: outputs.target.repositoryRole,
  defaultBranch: outputs.defaultBranch,
  verificationCommandId: outputs.verification.commandId,
  verificationKind: outputs.verification.kind,
  githubOperations: outputs.githubOperations,
});

/** A bootstrap run's current plan, reloaded from its PLAN artifact alone. */
export interface CurrentBootstrapPlan {
  binding: BootstrapPlanBinding;
  outputs: PlannedBootstrapOutputs;
  manifest: ProjectManifest;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The binding a bootstrap run's current PLAN artifact implies, computed from that artifact and the
 * manifest it carries — never from anything a caller supplies. A PLAN that carries no manifest, or
 * whose outputs cannot be planned, has no binding, and nothing can be reviewed or activated for it.
 */
export const currentBootstrapPlan = (
  runId: string,
  planArtifact: BootstrapPlanArtifact | null,
): Decision<CurrentBootstrapPlan> => {
  const refuse = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Evidence = {}) =>
    deny(reasonCode, message, { stage: "precondition", refusal, runId, ...evidence }) as Decision<CurrentBootstrapPlan>;
  if (planArtifact === null) {
    return refuse(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "PLAN_MISSING", "the run has no PLAN artifact");
  }
  const carried = isRecord(planArtifact.content) ? planArtifact.content["projectManifest"] : undefined;
  if (carried === undefined) {
    return refuse(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "MANIFEST_MISSING",
      "the run's PLAN artifact carries no project manifest, so its outputs cannot be planned",
      { planDigest: planArtifact.digest },
    );
  }
  const manifest = assertPortableManifest(carried);
  if (!manifest.allowed) {
    return refuse(manifest.reasonCode, "MANIFEST_INVALID", manifest.message, { planDigest: planArtifact.digest, ...manifest.evidence });
  }
  const outputs = plannedBootstrapOutputs({ runId, planArtifact }, manifest.value);
  if (!outputs.allowed) return outputs as Decision<CurrentBootstrapPlan>;
  return allow(ReasonCode.OK, {
    binding: {
      planDigest: planArtifact.digest,
      projectManifestDigest: manifestDigest(manifest.value),
      plannedOutputsDigest: digestOf(outputs.value),
    },
    outputs: outputs.value,
    manifest: manifest.value,
  });
};

/**
 * What the blind reviewer must account for: every planned file and every GitHub operation, keyed
 * `<repository identity>:<path>` as candidate coverage is. An operation is `#operation/<id>`.
 */
export const bootstrapPlanCoverageTargets = (
  outputs: PlannedBootstrapOutputs,
): Array<{ identity: string; path: string }> => [
  ...outputs.files.map((file) => ({ identity: outputs.target.repositoryIdentity, path: file.path })),
  ...outputs.githubOperations.map((operation) => ({
    identity: outputs.target.repositoryIdentity,
    path: `#operation/${operation.operationId}`,
  })),
];

/** Whether a run is the project-less PROJECT_BOOTSTRAP run this slice binds to its PLAN. */
export const isProjectlessBootstrap = (run: { kind: string; projectId: string | null }): boolean =>
  run.kind === RunKind.PROJECT_BOOTSTRAP && run.projectId === null;

/**
 * `plan_submit` for a project-less bootstrap run. A PLAN that names its manifest by digest carries
 * the manifest in full: it must be portable, its digest must be the one the PLAN names, and the
 * normalized manifest is what is stored, so the PLAN digest covers it. A PLAN that names no manifest
 * is stored as before; it carries no contract yet and cannot be reviewed until it does. Any other
 * run's plan is stored exactly as before this field existed: a `projectManifest` it supplies is
 * dropped, as the input schema used to drop it.
 */
export const planForSubmission = (
  run: { kind: string; projectId: string | null },
  plan: Record<string, unknown>,
): Decision<Record<string, unknown>> => {
  const { projectManifest: carried, ...rest } = plan;
  if (!isProjectlessBootstrap(run)) return allow(ReasonCode.OK, rest);
  const named = plan["projectManifestDigest"];
  if (carried === undefined) {
    if (named === undefined) return allow(ReasonCode.OK, rest);
    return deny(ReasonCode.INVALID_ARGUMENT, "a bootstrap PLAN that names a manifest digest carries the full manifest", {
      refusal: "MANIFEST_MISSING",
      projectManifestDigest: named,
    });
  }
  const manifest = assertPortableManifest(carried);
  if (!manifest.allowed) {
    return deny(manifest.reasonCode, manifest.message, { refusal: "MANIFEST_NOT_PORTABLE", ...manifest.evidence });
  }
  const supplied = manifestDigest(manifest.value);
  if (supplied !== named) {
    return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "the manifest the PLAN carries is not the one its projectManifestDigest names", {
      refusal: "MANIFEST_MISMATCH",
      supplied,
      named: named ?? null,
    });
  }
  return allow(ReasonCode.OK, { ...rest, projectManifest: manifest.value });
};
