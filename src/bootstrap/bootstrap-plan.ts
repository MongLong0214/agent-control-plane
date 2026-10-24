import { MCP_MUTATION_RECOVERY } from "../core/mcp-recovery.ts";
import { parseGenesis, genesisDigest, bytesDigest, type GenesisBundle } from './genesis-bundle.ts';
import { z } from "zod";

import { canonicalJson, digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  PROJECT_MANIFEST_SCHEMA_ID,
  type ProjectManifest,
  assertPortableManifest,
  manifestDigest,
  projectManifestSchema,
} from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import type { HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { Db } from "../db/database.ts";
import { RunKind } from "../domain/types.ts";
import { parseGitHubIdentity } from "./github-write-port.ts";
import type { RepoFactoryResult } from "./repo-factory-result.ts";
import { githubOperationSchema, genesisRepositoryOperations, isCreateOnlyPlan, preflightGitHubOperations, type GitHubOperation } from "./repo-factory-github.ts";
import {
  VERIFICATION_KINDS,
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
export const bootstrapActivationHandoff = (manifest: ProjectManifest, genesis?: GenesisBundle): HandoffPackage => ({
  projectStatus: "BOOTSTRAPPED",
  activeManifestDigest: manifestDigest(manifest),
  recentDecisions: genesis ? [JSON.stringify({productIntent:genesis.productIntent,genesis,genesisDigest:genesisDigest(genesis)})] : [],
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

/** What a bootstrap's facts are bound to: the PLAN's target repository, default branch and required verification. */
export interface BootstrapFactsTarget {
  repositoryIdentity: string;
  defaultBranch: string;
  verificationCommandId: string;
}

/**
 * Review of run_7717 (F4) and of PR #1122 R1 (BCG-R1-02) — the repository facts a stored producer result
 * establishes, the one selection delivery, the ACK and the CONFIRM all make. The result must name exactly
 * the PLAN's target repository, on the PLAN's default branch, and every verification row it carries for
 * that repository must name one head, which the PLAN's required verification row names: never the first
 * PASS row of any command. Conflicting rows, a missing required row, or a head that is not a full SHA are
 * refused. That this head and branch are the create's own readback is checked where the readback is held,
 * the attempt ledger (`RepoFactoryBootstrapRunner.writtenChain`).
 */
export const observedRepositoryFacts = (
  result: RepoFactoryResult,
  target: BootstrapFactsTarget,
): Decision<HandoffPackage["repositoryFacts"]> => {
  const refuse = (message: string, evidence: Evidence = {}) =>
    deny(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, message, { refusal: "RESULT_FACTS_UNBOUND", ...target, ...evidence }) as Decision<
      HandoffPackage["repositoryFacts"]
    >;
  const [repository, ...others] = result.repositories;
  if (repository === undefined || others.length > 0 || repository.identity !== target.repositoryIdentity) {
    return refuse("the producer result does not name exactly the PLAN's target repository", {
      repositories: result.repositories.map((row) => row.identity),
    });
  }
  if (repository.defaultBranch !== target.defaultBranch) {
    return refuse("the producer result's default branch is not the PLAN's", { reported: repository.defaultBranch });
  }
  const rows = result.bootstrapVerification.filter((row) => row.repositoryIdentity === repository.identity);
  const heads = [...new Set(rows.map((row) => row.exactHead))];
  const required = rows.find((row) => row.commandId === target.verificationCommandId && row.status === "PASS");
  if (heads.length !== 1 || required === undefined || !/^[0-9a-f]{40}$/.test(required.exactHead)) {
    return refuse("the producer result's verification rows do not name one head under the PLAN's required verification", {
      heads,
      commands: rows.map((row) => row.commandId),
    });
  }
  return allow(ReasonCode.OK, [{ identity: repository.identity, branch: repository.defaultBranch, head: required.exactHead }]);
};

/**
 * The handoff activation delivers: `planned` (whose repository facts the PLAN cannot know before the
 * create, so null) with the facts `observedRepositoryFacts` selected from the stored producer result,
 * so a retried activation delivers the same package.
 */
export const deliveredBootstrapHandoff = (planned: HandoffPackage, facts: HandoffPackage["repositoryFacts"]): HandoffPackage => ({
  ...planned,
  repositoryFacts: facts,
});

/** The facts target of a PLAN's planned outputs. */
export const factsTargetOf = (outputs: PlannedBootstrapOutputs): BootstrapFactsTarget => ({
  repositoryIdentity: outputs.target.repositoryIdentity,
  defaultBranch: outputs.defaultBranch,
  verificationCommandId: outputs.verification.commandId,
});

/** Whether a delivered handoff's repository facts are exactly `observed`, one fact per repository. */
export const handoffFactsAre = (handoff: Partial<HandoffPackage>, observed: HandoffPackage["repositoryFacts"]): boolean => {
  const delivered = Array.isArray(handoff.repositoryFacts) ? handoff.repositoryFacts : [];
  return (
    observed.length > 0 &&
    delivered.length === observed.length &&
    observed.every((want) => {
      const facts = delivered.filter((fact) => fact?.identity === want.identity);
      return facts.length === 1 && want.branch !== null && want.head !== null && facts[0]!.branch === want.branch && facts[0]!.head === want.head;
    })
  );
};

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
  const carriedGenesis = (planArtifact.content as Record<string,unknown>)["genesis"];
  let genesis: GenesisBundle | undefined;
  if (carriedGenesis !== undefined) {
    try {
      genesis = parseGenesis(carriedGenesis,manifest);
      const normalized = planForSubmission({kind:"PROJECT_BOOTSTRAP",projectId:null},planArtifact.content as Record<string,unknown>);
      if (!normalized.allowed || canonicalJson(normalized.value["githubOperations"]) !== canonicalJson(operations)) throw new Error("genesis operations differ from approved contract");
    } catch {return refuse(ReasonCode.INVALID_ARGUMENT,"GENESIS_INVALID","genesis bytes, secret screen or manifest verification failed");}
  }

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
  if (!genesis && manifest.ciWorkflows.length > 0) {
    return unsupported("the manifest requires CI evidence, and this producer produces none", {
      ciWorkflows: manifest.ciWorkflows.map((workflow) => workflow.checkName),
    });
  }
  // #246 B3 (G0a, RF-018) — CommitLore is not refused here. A manifest that requires it is planned as
  // approved and enforced where it can be observed: the runner refuses before anything is consumed or
  // written when CommitLore cannot be observed on this host, the producer verifies it in the checkout at
  // the published head, and activation refuses a result that does not carry that verification
  // (`commitlore-observation.ts`). `preferred` activates named NOT_OBSERVED; `off` asks for nothing.
  const command = manifest.verificationCommands[0];
  if (!genesis && manifest.verificationCommands.length !== 1) {
    return unsupported("this producer runs exactly one verification, and the manifest requires a different count", {
      commands: manifest.verificationCommands.map((candidate) => candidate.id),
    });
  }
  if (command === undefined) return unsupported("the manifest requires no verification command", {});
  const verificationKind = genesis ? "GENESIS_TEST" : verificationKindRunning(command.argv);
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

  // #246 C5 — a create-only plan pushes nothing; its default branch is the one the manifest declares,
  // and GitHub's initialized branch must be that one when it is read back. Otherwise it is the pushed
  // ref, as before.
  const push = operations.find((operation) => operation.resourceType === "branch");
  const pushed = push === undefined ? null : parseGitHubIdentity(push.resourceIdentity);
  const defaultBranch = genesis ? "dev" : isCreateOnlyPlan(operations) ? manifest.branchProfile.defaultBranch : pushed === null ? null : pushed.ref;
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
      ...(genesis ? {genesis,ciWorkflows:manifest.ciWorkflows.map(w => ({path:w.path,checkName:w.checkName,approvedDigest:w.approvedDigest!})),verificationCommands:manifest.verificationCommands} : {}),
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
  genesis?: GenesisBundle;
  verificationCommands?: RepoFactoryPlanFixture["verificationCommands"];
  ciWorkflows?: RepoFactoryPlanFixture["ciWorkflows"];
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
    // #246 C5 — a create-only plan commits nothing: no file, the bootstrap content file included.
    files: executable.genesis ? executable.genesis.files.map(f => ({path:f.path,mode:f.mode,content:Buffer.from(f.contentBase64,"base64").toString("utf8"),contentBase64:f.contentBase64})) : shape.value.createOnly ? [] : plannedBootstrapFiles(executable),
    ...(executable.genesis ? {genesis:executable.genesis,verificationCommands:executable.verificationCommands,ciWorkflows:executable.ciWorkflows} : {}),
    githubOperations: shape.value.operations,
    verification: { commandId: command.id, argv: [...command.argv], cwd: command.cwd, kind: verificationKind },
    handoff: {...bootstrapActivationHandoff(manifest,executable.genesis),recentDecisions:[...bootstrapActivationHandoff(manifest,executable.genesis).recentDecisions,...(executable.genesis && (plan.planArtifact?.content as Record<string,unknown>)["originatingContract"] ? [JSON.stringify({originatingContract:(plan.planArtifact!.content as Record<string,unknown>)["originatingContract"]})] : [])]},
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
  ...(outputs.genesis ? {genesis:outputs.genesis,verificationCommands:outputs.verificationCommands,ciWorkflows:outputs.ciWorkflows} : {}),
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

export const BOOTSTRAP_PLAN_INTENT_SCHEMA_ID = "agent-control-plane.bootstrap-plan-intent.v1";

/**
 * The bound on each field of the intent a BOOTSTRAP_PLAN reviewer is shown. A field over its bound
 * refuses the review, naming the field, its length and the bound; it is never truncated, since a
 * reviewer judging a cut field would be judging something the PLAN does not say.
 */
export const BOOTSTRAP_PLAN_INTENT_BOUNDS = Object.freeze({
  summaryChars: 4_000,
  listItems: 32,
  itemChars: 1_000,
  taskTitleChars: 500,
});

/**
 * What a bootstrap PLAN says it intends, typed: its summary, repository and verification intent and
 * risks as the PLAN artifact stores them, and the title and completion criteria (`spec.completionCriteria`,
 * null when not stored) of the one live task created with it. The PLAN digest covers the first four;
 * the task is not covered by any digest the candidate binds, so a review records this projection's
 * own digest, and a projection that changed since is stale.
 */
export interface BootstrapPlanIntent {
  schema: typeof BOOTSTRAP_PLAN_INTENT_SCHEMA_ID;
  planDigest: string;
  summary: string | null;
  repositoryIntent: string[];
  verificationIntent: string[];
  risks: string[];
  task: { taskId: string; title: string; completionCriteria: string[] | null };
}

/** The run's tasks as `bootstrapPlanIntent` reads them; a CANCELLED one is ignored. */
export interface BootstrapPlanIntentTask {
  taskId: string;
  title: string;
  state: string;
  spec: unknown;
}

/** The intent projection of a bootstrap run's PLAN artifact and its one live task, with its digest. */
export const bootstrapPlanIntent = (input: {
  runId: string;
  planArtifact: BootstrapPlanArtifact;
  tasks: readonly BootstrapPlanIntentTask[];
}): Decision<{ intent: BootstrapPlanIntent; digest: string }> => {
  const { runId, planArtifact } = input;
  const bounds = BOOTSTRAP_PLAN_INTENT_BOUNDS;
  type Refusal = { ok: false; refusal: string; field: string; length?: number; bound?: number; unit?: "characters" | "items" };
  type Read<T> = { ok: true; value: T } | Refusal;
  const text = (field: string, value: unknown, bound: number, optional: boolean): Read<string | null> => {
    if (value === undefined && optional) return { ok: true, value: null };
    if (typeof value !== "string") return { ok: false, refusal: "PLAN_INTENT_FIELD_INVALID", field };
    if (value.length > bound) {
      return { ok: false, refusal: "PLAN_INTENT_FIELD_TOO_LONG", field, length: value.length, bound, unit: "characters" };
    }
    return { ok: true, value };
  };
  /** A list of strings; `absent` is what an absent list reads as. */
  const list = (field: string, value: unknown, absent: string[] | null): Read<string[] | null> => {
    if (value === undefined) return { ok: true, value: absent };
    if (!Array.isArray(value)) return { ok: false, refusal: "PLAN_INTENT_FIELD_INVALID", field };
    if (value.length > bounds.listItems) {
      return { ok: false, refusal: "PLAN_INTENT_FIELD_TOO_LONG", field, length: value.length, bound: bounds.listItems, unit: "items" };
    }
    const items: string[] = [];
    for (const [index, item] of value.entries()) {
      const read = text(`${field}[${index}]`, item, bounds.itemChars, false);
      if (!read.ok) return read;
      items.push(read.value!);
    }
    return { ok: true, value: items };
  };
  const refuse = (read: Refusal): Decision<{ intent: BootstrapPlanIntent; digest: string }> =>
    deny(
      ReasonCode.INVALID_ARGUMENT,
      read.refusal === "PLAN_INTENT_FIELD_TOO_LONG"
        ? `the PLAN's ${read.field} has ${read.length} ${read.unit}, over the review's bound of ${read.bound}; it is never truncated, so shorten it and submit the PLAN again`
        : `the PLAN's ${read.field} is not the type the review reads (a string, or a list of strings); submit the PLAN again with it corrected`,
      {
        stage: "precondition",
        refusal: read.refusal,
        runId,
        planDigest: planArtifact.digest,
        field: read.field,
        ...(read.length === undefined ? {} : { length: read.length, bound: read.bound }),
      },
    );

  const live = input.tasks.filter((task) => task.state !== "CANCELLED");
  const task = live[0];
  if (live.length !== 1 || task === undefined) {
    return deny(ReasonCode.TASK_RESULT_COUNT_MISMATCH, "a bootstrap PLAN's intent is read with its one live task", {
      stage: "precondition",
      refusal: "BOOTSTRAP_PLAN_TASK_COUNT",
      runId,
      planDigest: planArtifact.digest,
      tasks: live.map((candidate) => candidate.taskId),
    });
  }
  const plan = isRecord(planArtifact.content) ? planArtifact.content : {};
  const summary = text("summary", plan["summary"], bounds.summaryChars, true);
  if (!summary.ok) return refuse(summary);
  const repositoryIntent = list("repositoryIntent", plan["repositoryIntent"], []);
  if (!repositoryIntent.ok) return refuse(repositoryIntent);
  const verificationIntent = list("verificationIntent", plan["verificationIntent"], []);
  if (!verificationIntent.ok) return refuse(verificationIntent);
  const risks = list("risks", plan["risks"], []);
  if (!risks.ok) return refuse(risks);
  const title = text("task.title", task.title, bounds.taskTitleChars, false);
  if (!title.ok) return refuse(title);
  const completionCriteria = list("task.completionCriteria", isRecord(task.spec) ? task.spec["completionCriteria"] : undefined, null);
  if (!completionCriteria.ok) return refuse(completionCriteria);

  const intent: BootstrapPlanIntent = {
    schema: BOOTSTRAP_PLAN_INTENT_SCHEMA_ID,
    planDigest: planArtifact.digest,
    summary: summary.value,
    repositoryIntent: repositoryIntent.value!,
    verificationIntent: verificationIntent.value!,
    risks: risks.value!,
    task: { taskId: task.taskId, title: title.value!, completionCriteria: completionCriteria.value },
  };
  return allow(ReasonCode.OK, { intent, digest: digestOf(intent) });
};

/** A run's tasks as `bootstrapPlanIntent` reads them, in creation order, from the tasks table itself. */
export const bootstrapPlanIntentTasks = (db: Pick<Db, "all">, runId: string): BootstrapPlanIntentTask[] =>
  db
    .all<{ task_id: string; title: string; state: string; spec_json: string }>(
      `SELECT task_id, title, state, spec_json FROM tasks WHERE run_id = ? ORDER BY created_at, rowid`,
      [runId],
    )
    .map((row) => ({ taskId: row.task_id, title: row.title, state: row.state, spec: JSON.parse(row.spec_json) as unknown }));

/**
 * Review of #1119, round 1 (BPI-R1-01) — whether a BOOTSTRAP_PLAN review was shown the run's CURRENT
 * intent: its `bootstrapPlanIntentDigest` is the digest of the projection recomputed now from the run's
 * latest PLAN artifact and its one live task. No PLAN binding digest covers the task, so the same PLAN
 * submitted again with another task, or a task changed since, leaves the binding and changes only this.
 * A review with no such digest predates it (pre-#1119): it was never shown the intent and cannot be
 * compared, so it authorizes nothing until the PLAN is reviewed again. Every consumer that trusts such
 * a review asks this, after its last await and before it acts; none restates the comparison.
 */
export const bootstrapReviewIntentCurrent = (input: {
  runId: string;
  reviewedIntentDigest: unknown;
  planArtifact: BootstrapPlanArtifact | null;
  tasks: readonly BootstrapPlanIntentTask[];
}): Decision<{ digest: string }> => {
  const { runId } = input;
  if (typeof input.reviewedIntentDigest !== "string") {
    return deny(
      ReasonCode.EVIDENCE_STALE,
      "the bootstrap plan review carries no PLAN intent digest (it predates the intent check), so it was never shown the run's current PLAN intent; the PLAN must be reviewed again",
      { runId, refusal: "BOOTSTRAP_PLAN_INTENT_MISSING", reviewed: null },
    );
  }
  const current = input.planArtifact === null ? null : bootstrapPlanIntent({ runId, planArtifact: input.planArtifact, tasks: input.tasks });
  const currentDigest = current?.allowed ? current.value.digest : null;
  if (input.reviewedIntentDigest !== currentDigest) {
    return deny(ReasonCode.EVIDENCE_STALE, "the bootstrap plan review was shown another PLAN intent than the run's current one", {
      runId,
      refusal: "BOOTSTRAP_PLAN_INTENT_STALE",
      reviewed: input.reviewedIntentDigest,
      current: currentDigest,
    });
  }
  return allow(ReasonCode.OK, { digest: input.reviewedIntentDigest });
};

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
  if (rest["genesis"] !== undefined) {
    try {
      const genesis = parseGenesis(rest["genesis"],manifest.value);
      const identity = manifest.value.repositories[0]!.remote;
      const op = (suffix:string,resourceType:string,ref:string,desiredState?:unknown) => ({operationId:suffix,resourceType,resourceIdentity:`${identity}${ref ? `#${ref}` : ""}`,...(desiredState === undefined ? {} : {desiredState})});
      const base = genesisRepositoryOperations(identity,manifest.value.ciWorkflows.map(w => w.checkName));
      // Preserve Repo Factory's operation identities and approved state; never silently replace an unsafe plan.
      const supplied = rest["githubOperations"] === undefined ? base : executableOperationsSchema.parse(rest["githubOperations"]);
      const bootstrap = ["open","verify","merge"].map(action => op(`acp-genesis-${action}`,"genesis-bootstrap",`genesis-${action}`,{action}));
      const resources = [
        op("acp-genesis-labels","genesis-resources","genesis-labels",{labels:genesis.labels,milestones:[],issues:[]}),
        op("acp-genesis-milestones","genesis-resources","genesis-milestones",{labels:genesis.labels,milestones:genesis.milestones,issues:[]}),
        op("acp-genesis-issues","genesis-resources","genesis-issues",{labels:genesis.labels,milestones:genesis.milestones,issues:genesis.issues}),
      ];
      const expanded = supplied.length === 6 ? [...supplied.slice(0,3),...bootstrap,...supplied.slice(3),...resources] : supplied;
      const githubOperations = executableOperationsSchema.parse(expanded);
      if (canonicalJson(githubOperations.map(o => ({...o,operationId:""}))) !== canonicalJson([...base.slice(0,3),...bootstrap,...base.slice(3),...resources].map(o => ({...o,operationId:""})))) throw new Error("genesis operation order/state differs from the shared contract");
      return allow(ReasonCode.OK,{...rest,genesis,genesisDigest:genesisDigest(genesis),githubOperations,projectManifest:manifest.value});
    } catch {return deny(ReasonCode.INVALID_ARGUMENT,"genesis bundle/manifest refused",{refusal:"GENESIS_INVALID"});}
  }
  return allow(ReasonCode.OK, { ...rest, projectManifest: manifest.value });
};

/** The schema id of the guide `contract_get` hands a project-less bootstrap run's owner. */
export const BOOTSTRAP_PLAN_GUIDE_SCHEMA_ID = "agent-control-plane.bootstrap-plan-guide.v1";

/** The placeholders the guide is written in. The owner replaces each with the value its contract names. */
export const BOOTSTRAP_PLAN_GUIDE_PLACEHOLDERS = Object.freeze({
  projectId: "<project-id>",
  repositoryIdentity: "github:<owner>/<name>",
  operationId: "<operation-id>",
  visibility: "<public|private>",
});

/** The id the guide's example gives the one verification command this producer runs. */
const CLEAN_TREE_COMMAND_ID = "clean-tree";

/**
 * The smallest manifest the Repo Factory producer executes for one repository, from the caller's
 * values and nothing else: one repository with that remote, one long-lived default branch, and the
 * one verification command this producer runs (`VERIFICATION_KINDS.CLEAN_TREE`), named by every
 * profile. Every other field is the schema's default, so the manifest the schema parses from it is
 * the one a PLAN stores and its digest is taken over (`planForSubmission`).
 *
 * Built from placeholders it is the guide's example; `assertPortableManifest` accepts it either way.
 * `defaultBranch` defaults to `main`, the branch GitHub initializes for a create-only plan.
 */
export const minimalBootstrapManifest = (input: {
  projectId: string;
  repositoryIdentity: string;
  defaultBranch?: string;
}): z.input<typeof projectManifestSchema> => {
  const defaultBranch = input.defaultBranch ?? "main";
  return {
    schema: PROJECT_MANIFEST_SCHEMA_ID,
    projectId: input.projectId,
    repositories: [{ role: "primary", remote: input.repositoryIdentity }],
    branchProfile: { longLived: [defaultBranch], defaultBranch },
    verificationProfiles: {
      simple: [CLEAN_TREE_COMMAND_ID],
      standard: [CLEAN_TREE_COMMAND_ID],
      guarded: [CLEAN_TREE_COMMAND_ID],
    },
    verificationCommands: [{ id: CLEAN_TREE_COMMAND_ID, argv: ["git", ...VERIFICATION_KINDS.CLEAN_TREE.argv] }],
  };
};

/** The manifest keys the schema has no default for: absent, the manifest fails it. */
const requiredManifestKeys = (): string[] =>
  Object.entries(projectManifestSchema.innerType().shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);

/**
 * What a project-less bootstrap run's owner needs to write a PLAN `plan_submit` accepts and the
 * producer can execute, as data its session can read with `contract_get`: the owner has no tool that
 * runs code, so nothing here asks it to compute anything. Generic: it names no run, project, owner
 * or repository; the contract supplies those.
 */
export interface BootstrapPlanGuide {
  schema: typeof BOOTSTRAP_PLAN_GUIDE_SCHEMA_ID;
  submit: string[];
  planFields: Array<{ field: string; carries: string }>;
  repositoryCreateOperation: {
    shape: { operationId: string; resourceType: "repository"; resourceIdentity: string; desiredState: { visibility: string; autoInit: boolean } };
    rules: string[];
  };
  manifest: {
    schema: typeof PROJECT_MANIFEST_SCHEMA_ID;
    requiredKeys: string[];
    producerAccepts: string[];
    placeholders: string;
    example: z.input<typeof projectManifestSchema>;
  };
  digestRule: string[];
  genesisExample: GenesisBundle;
  githubOperationsExample: GitHubOperation[];
  afterAcceptance: string;
}

/** The guide `contract_get` carries for a project-less PROJECT_BOOTSTRAP run, and for no other run. */
export const bootstrapPlanGuide = (): BootstrapPlanGuide => {
  const placeholders = BOOTSTRAP_PLAN_GUIDE_PLACEHOLDERS;
  const test = "const assert = require('node:assert/strict'); assert.equal(2 + 2, 4);\n";
  const workflow = "name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n      - run: node test.js\n";
  const genesis:GenesisBundle = {schema:"acp.genesis-bundle.v1",commitMessage:"Create runnable project",files:[{path:"test.js",mode:"100644",contentBase64:Buffer.from(test).toString("base64"),sha256:bytesDigest(Buffer.from(test))},{path:".github/workflows/ci.yml",mode:"100644",contentBase64:Buffer.from(workflow).toString("base64"),sha256:bytesDigest(Buffer.from(workflow))}],branches:{main:"main",integration:"dev",genesis:"genesis"},labels:[],milestones:[],issues:[],productIntent:{summary:"Replace with the owner's product intent",references:[],ownerInstructions:[]}};
  return {
    schema: BOOTSTRAP_PLAN_GUIDE_SCHEMA_ID,
    submit: [
      "If contract_get carries bootstrapPlanDigest, read mcp__acp-cto__bootstrap_plan_get with { runId }, then call mcp__acp-cto__plan_submit with { idempotencyKey, runId, bootstrapPlanDigest }, without plan or tasks. This submits the exact CEO-delivered input; it grants no execution approval.",
      "Otherwise call mcp__acp-cto__plan_submit with { idempotencyKey, runId, plan, tasks }.",
      "Use the same idempotencyKey for an identical retry. " + MCP_MUTATION_RECOVERY,
      "tasks: at least one task { key, title, category }, for example one implementation task that creates the repository.",
    ],
    planFields: [
      { field:"genesis",carries:"INLINE acp.genesis-bundle.v1 bytes+SHA-256, branches main/dev/genesis, labels/milestones/issues, productIntent with references and ownerInstructions; never local filenames. See genesisExample." },
      { field: "summary", carries: "what this bootstrap creates and why, from the contract" },
      { field: "bootstrapOperationId", carries: "a non-empty id you choose for this bootstrap; keep it unchanged when you resubmit" },
      { field: "requestDigest", carries: "the digest of the Repo Factory compile request; independent of ACP's run contractDigest" },
      { field: "githubOperations", carries: "the GitHub operations in the order they run, each with its desiredState; the first is repositoryCreateOperation" },
      { field: "projectManifest", carries: "the full project manifest (manifest); its one repository's remote is the repository the first operation creates" },
      { field: "projectManifestDigest", carries: "the digest of projectManifest (digestRule)" },
    ],
    repositoryCreateOperation: {
      shape: {
        operationId: placeholders.operationId,
        resourceType: "repository",
        resourceIdentity: placeholders.repositoryIdentity,
        desiredState: { visibility: "public", autoInit: true },
      },
      rules: [
        "It is the first operation, and a plan creates exactly one repository; operation ids are unique.",
        "resourceIdentity is github:<owner>/<name> with no #ref: the repository the contract asks for, and exactly the manifest's repository remote.",
        "PUBLIC autoInit:true; protect main, push genesis, ACP opens/verifies/merges genesis PR, create/protect dev, default dev, labels/milestones/issues.",
        "GitHub initializes README on main; genesis has that head as parent and reaches main only through a protected PR merge commit.",
        "No force pushes or deletion; required protection checks are the manifest CI check names. ACP owns merges.",
      ],
    },
    manifest: {
      schema: PROJECT_MANIFEST_SCHEMA_ID,
      requiredKeys: requiredManifestKeys(),
      producerAccepts: [
        "exactly one repository { role, remote }, whose remote is the repository the first operation creates",
        "real test commands in genesis, cwd root, included in the standard verification profile",
        "ciWorkflows pinned to each genesis workflow file SHA-256; main/dev, default dev, merge_commit, semver",
        "commitlore.mode \"required\" only where this deployment can run CommitLore: the producer runs commitlore init and commitlore doctor --json in the checkout at the head it publishes, and refuses without a passing report; \"preferred\" is not observed and activates named NOT_OBSERVED; \"off\" asks for nothing",
        "branchProfile.defaultBranch is one of branchProfile.longLived",
        "portable: no absolute or home paths, and no secret, token or session identifier anywhere",
      ],
      placeholders: `Replace ${placeholders.projectId}, <owner> and <name> with the values the contract names; ${placeholders.projectId} is the new project's id.`,
      example: { ...minimalBootstrapManifest({projectId:placeholders.projectId,repositoryIdentity:placeholders.repositoryIdentity,defaultBranch:"dev"}),branchProfile:{longLived:["main","dev"],defaultBranch:"dev",mergeStrategy:"merge_commit",releaseTagPolicy:"semver"},verificationCommands:[{id:"test",argv:["node","test.js"],repositoryRole:"primary",cwd:".",timeoutSeconds:120,required:true,evidenceMode:"LOCAL_COMMAND"}],verificationProfiles:{simple:["test"],standard:["test"],guarded:["test"]},ciWorkflows:[{path:".github/workflows/ci.yml",checkName:"test",approvedDigest:genesis.files[1]!.sha256,unapprovedFirstActivation:false}],commitlore:{mode:"preferred"} },
    },
    digestRule: [
      "projectManifestDigest is \"sha256:\" and the lowercase hex SHA-256 of the manifest's canonical JSON (object keys sorted, no whitespace), taken after the manifest schema fills in its defaults; the PLAN stores that normalized manifest.",
      "Without a way to compute it, submit the PLAN with any non-empty projectManifestDigest: plan_submit refuses it with refusal MANIFEST_MISMATCH, and the refusal's evidence.supplied is the digest of the manifest you sent.",
      "Then submit the same PLAN again with projectManifestDigest set to evidence.supplied and a new idempotencyKey. Any change to the manifest changes its digest: read supplied again from the next refusal.",
      "A manifest that fails the schema or is not portable is refused first, with refusal MANIFEST_NOT_PORTABLE and the issues or violations, before any digest is compared.",
    ],
    genesisExample: genesis,
    githubOperationsExample: genesisRepositoryOperations(placeholders.repositoryIdentity,["test"]),
    afterAcceptance:
      "After independent review and authenticated CEO CONFIRM, ACP creates the repository and resumes resident provisioning without another CONFIRM. Completion requires the dedicated room/subscriber, canonical claim, Remote Control and same-session handoff ACK.",
  };
};
