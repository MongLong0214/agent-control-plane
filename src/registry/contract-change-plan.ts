import { canonicalJson } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { assertPortableManifest, manifestDigest, projectManifestSchema, type ProjectManifest } from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import { RunKind } from "../domain/types.ts";

/**
 * Issue #246 B2-a — a CONTRACT_CHANGE run's PLAN carries the manifest the run proposes.
 *
 * Before this, `plan_submit` dropped `projectManifest` from every PLAN that was not a project-less
 * bootstrap's, so a CONTRACT_CHANGE run had nothing to review and nothing a later activation could
 * name. Here the manifest is carried, checked against the run's pinned manifest (its *base*), and
 * stored normalized in the PLAN, so the PLAN digest covers it. Nothing here activates anything:
 * the proposed manifest is reviewed now and may be activated later; until then every run, this one
 * included, is verified against the manifest it pinned at dispatch.
 */

/**
 * Why a CONTRACT_CHANGE PLAN was refused: one stable code per refusal, in `evidence.refusal`, the way a
 * bootstrap PLAN's refusals are named. The top-level reason code each one carries is an existing one.
 */
export const ContractChangeRefusal = {
  /** The run names no project, so there is no contract to change. */
  PROJECT_MISSING: "CONTRACT_CHANGE_PROJECT_MISSING",
  /** The PLAN carries no full manifest. It is refused rather than stored without one. */
  MANIFEST_MISSING: "CONTRACT_CHANGE_MANIFEST_MISSING",
  MANIFEST_NOT_PORTABLE: "CONTRACT_CHANGE_MANIFEST_NOT_PORTABLE",
  /** The carried manifest is not the one `projectManifestDigest` names. */
  MANIFEST_DIGEST_MISMATCH: "CONTRACT_CHANGE_MANIFEST_DIGEST_MISMATCH",
  /** The carried manifest names another project. */
  PROJECT_MISMATCH: "CONTRACT_CHANGE_PROJECT_MISMATCH",
  /** `repositories[]` differs from the base; repository identity changes are out of this slice. */
  REPOSITORIES_CHANGED: "CONTRACT_CHANGE_REPOSITORIES_CHANGED",
  /** The carried manifest is the base itself. */
  NO_CHANGE: "CONTRACT_CHANGE_NO_CHANGE",
  /** The carried manifest lowers the verification bar; no owner approval can be bound to it yet. */
  VERIFICATION_BAR_LOWERED: "CONTRACT_CHANGE_VERIFICATION_BAR_LOWERED",
  /** The run has no pinned manifest, or the pinned manifest cannot be read back by its digest. */
  BASE_UNAVAILABLE: "CONTRACT_CHANGE_BASE_UNAVAILABLE",
} as const;
export type ContractChangeRefusal = (typeof ContractChangeRefusal)[keyof typeof ContractChangeRefusal];

/** What a CONTRACT_CHANGE candidate is, by digest: its PLAN, the manifest it carries and its base. */
export interface ContractChangeBinding {
  planDigest: string;
  manifestDigest: string;
  /** The run's dispatch pin. A later activation compares the active manifest against it. */
  baseManifestDigest: string;
}

/** The facts about a run this module reads. */
export interface ContractChangeRun {
  kind: string;
  projectId: string | null;
  pinnedManifestDigest: string | null;
}

/** Reads a stored manifest back by its digest; null when nothing is stored under it. */
export type ManifestLookup = (digest: string) => unknown;

export const isContractChangeRun = (run: { kind: string }): boolean => run.kind === RunKind.CONTRACT_CHANGE;

/** One way the carried manifest asks less of a candidate than the base did. */
export interface VerificationBarLowering {
  kind:
    | "COMMAND_REMOVED"
    | "COMMAND_REPLACED"
    | "EVIDENCE_MODE_DOWNGRADED"
    | "PROFILE_COMMAND_REMOVED"
    | "POST_MERGE_COMMAND_REMOVED"
    | "CI_WORKFLOW_DROPPED"
    | "CI_WORKFLOW_UNAPPROVED"
    | "COMMITLORE_MODE_DOWNGRADED";
  detail: Record<string, string | null>;
}

/** What a later activation must check for one CI workflow the carried manifest names. */
export interface ContractChangeWorkflowEvidence {
  repositoryRole: string;
  /** The portable remote of the repository with that role, as the carried manifest declares it. */
  repositoryRemote: string | null;
  path: string;
  checkName: string;
  approvedDigest: string | null;
  unapprovedFirstActivation: boolean;
  /** True when the base declares this exact entry, so existing exact-byte evidence may be reused. */
  unchangedFromBase: boolean;
}

/** A CONTRACT_CHANGE PLAN as validated: the carried manifest and the base it is judged against. */
export interface CurrentContractChangePlan {
  binding: ContractChangeBinding;
  manifest: ProjectManifest;
  baseManifest: ProjectManifest;
  workflowEvidence: ContractChangeWorkflowEvidence[];
}

const refuse = <T>(
  reasonCode: ReasonCode,
  refusal: ContractChangeRefusal,
  message: string,
  evidence: Evidence = {},
): Decision<T> => deny(reasonCode, message, { refusal, ...evidence }) as Decision<T>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const EVIDENCE_SOURCES: Readonly<Record<VerificationCommand["evidenceMode"], readonly string[]>> = {
  LOCAL_COMMAND: ["local"],
  TRUSTED_CI: ["ci"],
  BOTH_REQUIRED: ["local", "ci"],
};

const COMMITLORE_RANK: Readonly<Record<ProjectManifest["commitlore"]["mode"], number>> = {
  off: 0,
  preferred: 1,
  required: 2,
};

const PROFILES = ["simple", "standard", "guarded"] as const;

const workflowKey = (workflow: ProjectManifest["ciWorkflows"][number]): string =>
  `${workflow.repositoryRole}\u0000${workflow.checkName}`;

/**
 * Every way `proposed` asks less of a candidate than `base` did, found by comparison rather than
 * declared. A command, profile entry, post-merge command or CI workflow the base requires has to be
 * required by the proposal too, with at least the same evidence, under the same argv, cwd and
 * repository; a CI workflow may not become unapproved, and the CommitLore mode may not drop.
 * Anything added is stricter. Resource limits, network, environment and branch profile are not
 * judged here.
 */
export const verificationBarLowerings = (
  base: ProjectManifest,
  proposed: ProjectManifest,
): VerificationBarLowering[] => {
  const lowered: VerificationBarLowering[] = [];
  const proposedCommands = new Map(proposed.verificationCommands.map((command) => [command.id, command]));
  for (const command of base.verificationCommands) {
    const next = proposedCommands.get(command.id);
    if (!next) {
      lowered.push({ kind: "COMMAND_REMOVED", detail: { commandId: command.id } });
      continue;
    }
    if (
      canonicalJson(next.argv) !== canonicalJson(command.argv) ||
      next.cwd !== command.cwd ||
      next.repositoryRole !== command.repositoryRole
    ) {
      lowered.push({ kind: "COMMAND_REPLACED", detail: { commandId: command.id } });
    }
    const kept = EVIDENCE_SOURCES[next.evidenceMode];
    if (EVIDENCE_SOURCES[command.evidenceMode].some((source) => !kept.includes(source))) {
      lowered.push({
        kind: "EVIDENCE_MODE_DOWNGRADED",
        detail: { commandId: command.id, from: command.evidenceMode, to: next.evidenceMode },
      });
    }
  }
  for (const profile of PROFILES) {
    const kept = new Set(proposed.verificationProfiles[profile]);
    for (const commandId of base.verificationProfiles[profile]) {
      if (!kept.has(commandId)) lowered.push({ kind: "PROFILE_COMMAND_REMOVED", detail: { profile, commandId } });
    }
  }
  const keptPostMerge = new Set(proposed.postMergeCommands);
  for (const commandId of base.postMergeCommands) {
    if (!keptPostMerge.has(commandId)) lowered.push({ kind: "POST_MERGE_COMMAND_REMOVED", detail: { commandId } });
  }
  const proposedWorkflows = new Map(proposed.ciWorkflows.map((workflow) => [workflowKey(workflow), workflow]));
  const baseWorkflows = new Set(base.ciWorkflows.map((workflow) => canonicalJson(workflow)));
  for (const workflow of base.ciWorkflows) {
    const next = proposedWorkflows.get(workflowKey(workflow));
    if (!next || next.path !== workflow.path) {
      lowered.push({
        kind: "CI_WORKFLOW_DROPPED",
        detail: { repositoryRole: workflow.repositoryRole, checkName: workflow.checkName, path: workflow.path },
      });
    }
  }
  for (const workflow of proposed.ciWorkflows) {
    if (workflow.unapprovedFirstActivation && !baseWorkflows.has(canonicalJson(workflow))) {
      lowered.push({
        kind: "CI_WORKFLOW_UNAPPROVED",
        detail: { repositoryRole: workflow.repositoryRole, checkName: workflow.checkName, path: workflow.path },
      });
    }
  }
  if (COMMITLORE_RANK[proposed.commitlore.mode] < COMMITLORE_RANK[base.commitlore.mode]) {
    lowered.push({
      kind: "COMMITLORE_MODE_DOWNGRADED",
      detail: { from: base.commitlore.mode, to: proposed.commitlore.mode },
    });
  }
  return lowered;
};

/**
 * What activating `proposed` will have to verify about CI: each workflow it names, at the exact
 * repository its role resolves to, with the digest it approves. An entry the base already declares
 * byte for byte is marked unchanged, so evidence for it may be reused.
 */
export const contractChangeWorkflowEvidence = (
  base: ProjectManifest,
  proposed: ProjectManifest,
): ContractChangeWorkflowEvidence[] => {
  const unchanged = new Set(base.ciWorkflows.map((workflow) => canonicalJson(workflow)));
  return proposed.ciWorkflows.map((workflow) => ({
    repositoryRole: workflow.repositoryRole,
    repositoryRemote: proposed.repositories.find((repository) => repository.role === workflow.repositoryRole)?.remote ?? null,
    path: workflow.path,
    checkName: workflow.checkName,
    approvedDigest: workflow.approvedDigest,
    unapprovedFirstActivation: workflow.unapprovedFirstActivation,
    unchangedFromBase: unchanged.has(canonicalJson(workflow)),
  }));
};

/** The base: the run's pinned manifest, read back by its digest and checked to hash to it. */
const baseManifestFor = (run: ContractChangeRun, lookup: ManifestLookup): Decision<ProjectManifest> => {
  const pinned = run.pinnedManifestDigest;
  if (!pinned) {
    return refuse(ReasonCode.CONTRACT_UNVERIFIED, ContractChangeRefusal.BASE_UNAVAILABLE, "the run has no pinned manifest to change", {
      pinnedManifestDigest: null,
    });
  }
  const stored = lookup(pinned);
  const parsed = stored === null || stored === undefined ? null : projectManifestSchema.safeParse(stored);
  if (!parsed?.success || manifestDigest(parsed.data) !== pinned) {
    return refuse(
      ReasonCode.CONTRACT_UNVERIFIED,
      ContractChangeRefusal.BASE_UNAVAILABLE,
      "the run's pinned manifest cannot be read back by its digest",
      { pinnedManifestDigest: pinned },
    );
  }
  return allow(ReasonCode.OK, parsed.data);
};

interface ValidatedContractChange {
  manifest: ProjectManifest;
  manifestDigest: string;
  baseManifest: ProjectManifest;
  baseManifestDigest: string;
}

/** Every check a CONTRACT_CHANGE PLAN passes, in order; each refusal names its own code. */
const validateContractChangePlan = (
  run: ContractChangeRun,
  plan: Record<string, unknown>,
  lookup: ManifestLookup,
): Decision<ValidatedContractChange> => {
  if (!run.projectId) {
    return refuse(ReasonCode.INVALID_ARGUMENT, ContractChangeRefusal.PROJECT_MISSING, "a CONTRACT_CHANGE run names the project whose contract it changes");
  }
  const carried = plan["projectManifest"];
  const named = plan["projectManifestDigest"];
  if (carried === undefined) {
    return refuse(ReasonCode.INVALID_ARGUMENT, ContractChangeRefusal.MANIFEST_MISSING, "a CONTRACT_CHANGE PLAN carries the full manifest it proposes", {
      projectManifestDigest: typeof named === "string" ? named : null,
    });
  }
  const manifest = assertPortableManifest(carried);
  if (!manifest.allowed) {
    return refuse(manifest.reasonCode, ContractChangeRefusal.MANIFEST_NOT_PORTABLE, manifest.message, manifest.evidence);
  }
  const supplied = manifestDigest(manifest.value);
  if (supplied !== named) {
    return refuse(
      ReasonCode.CONTRACT_DIGEST_MISMATCH,
      ContractChangeRefusal.MANIFEST_DIGEST_MISMATCH,
      "the manifest the PLAN carries is not the one its projectManifestDigest names",
      { supplied, named: typeof named === "string" ? named : null },
    );
  }
  if (manifest.value.projectId !== run.projectId) {
    return refuse(ReasonCode.INVALID_ARGUMENT, ContractChangeRefusal.PROJECT_MISMATCH, "the carried manifest names another project", {
      runProjectId: run.projectId,
      manifestProjectId: manifest.value.projectId,
    });
  }
  const base = baseManifestFor(run, lookup);
  if (!base.allowed) return base as Decision<ValidatedContractChange>;
  const baseDigest = run.pinnedManifestDigest!;
  if (canonicalJson(manifest.value.repositories) !== canonicalJson(base.value.repositories)) {
    return refuse(
      ReasonCode.REPOSITORY_IDENTITY_MISMATCH,
      ContractChangeRefusal.REPOSITORIES_CHANGED,
      "a CONTRACT_CHANGE may not change the project's repositories",
      { baseManifestDigest: baseDigest },
    );
  }
  if (supplied === baseDigest) {
    return refuse(ReasonCode.INVALID_ARGUMENT, ContractChangeRefusal.NO_CHANGE, "the carried manifest is the run's pinned manifest; there is nothing to change", {
      baseManifestDigest: baseDigest,
    });
  }
  const lowered = verificationBarLowerings(base.value, manifest.value);
  if (lowered.length > 0) {
    // Lowering the bar needs the owner's approval bound to these exact lowerings. Nothing can bind
    // one yet, so every lowering is refused; a stricter or equivalent manifest is not.
    return deny(ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT, "the carried manifest lowers the verification bar of the run's pinned manifest", {
      refusal: ContractChangeRefusal.VERIFICATION_BAR_LOWERED,
      baseManifestDigest: baseDigest,
      manifestDigest: supplied,
      lowered: lowered.map((entry) => ({ kind: entry.kind, ...entry.detail })),
      ownerApproval: "NOT_AVAILABLE",
    }) as Decision<ValidatedContractChange>;
  }
  return allow(ReasonCode.OK, {
    manifest: manifest.value,
    manifestDigest: supplied,
    baseManifest: base.value,
    baseManifestDigest: baseDigest,
  });
};

/**
 * `plan_submit` for a CONTRACT_CHANGE run. The PLAN must carry `projectManifest` in full and name it
 * by `projectManifestDigest`; a PLAN without it is refused rather than stored without it, as every
 * non-bootstrap PLAN used to be. What is stored is the PLAN with the normalized manifest, so the PLAN
 * digest covers the manifest.
 */
export const contractChangePlanForSubmission = (
  run: ContractChangeRun,
  plan: Record<string, unknown>,
  lookup: ManifestLookup,
): Decision<Record<string, unknown>> => {
  const validated = validateContractChangePlan(run, plan, lookup);
  if (!validated.allowed) return validated as Decision<Record<string, unknown>>;
  return allow(ReasonCode.OK, { ...plan, projectManifest: validated.value.manifest });
};

/**
 * The CONTRACT_CHANGE candidate the run's latest PLAN implies, re-validated from the stored PLAN: the
 * binding a snapshot freezes, the manifest it carries and the base. A run whose PLAN carries no
 * manifest, including one stored before this slice, has no candidate.
 */
export const currentContractChangePlan = (
  run: ContractChangeRun,
  planArtifact: { digest: string; content: unknown } | null,
  lookup: ManifestLookup,
): Decision<CurrentContractChangePlan> => {
  if (planArtifact === null || !isRecord(planArtifact.content)) {
    return refuse(ReasonCode.INVALID_ARGUMENT, ContractChangeRefusal.MANIFEST_MISSING, "the CONTRACT_CHANGE run has no PLAN carrying a manifest", {
      planDigest: planArtifact?.digest ?? null,
    });
  }
  const validated = validateContractChangePlan(run, planArtifact.content, lookup);
  if (!validated.allowed) {
    return deny(validated.reasonCode, validated.message, { planDigest: planArtifact.digest, ...validated.evidence }) as Decision<CurrentContractChangePlan>;
  }
  return allow(ReasonCode.OK, {
    binding: {
      planDigest: planArtifact.digest,
      manifestDigest: validated.value.manifestDigest,
      baseManifestDigest: validated.value.baseManifestDigest,
    },
    manifest: validated.value.manifest,
    baseManifest: validated.value.baseManifest,
    workflowEvidence: contractChangeWorkflowEvidence(validated.value.baseManifest, validated.value.manifest),
  });
};

export const sameContractChangeBinding = (
  left: ContractChangeBinding | null | undefined,
  right: ContractChangeBinding | null | undefined,
): boolean =>
  left !== null &&
  left !== undefined &&
  right !== null &&
  right !== undefined &&
  left.planDigest === right.planDigest &&
  left.manifestDigest === right.manifestDigest &&
  left.baseManifestDigest === right.baseManifestDigest;

/**
 * The blind-review coverage item for the carried manifest, keyed like candidate coverage:
 * `<projectId>:#manifest/<manifestDigest>`.
 */
export const contractChangeCoverageTarget = (
  projectId: string,
  binding: Pick<ContractChangeBinding, "manifestDigest">,
): { identity: string; path: string } => ({ identity: projectId, path: `#manifest/${binding.manifestDigest}` });

/** A manifest stored under `digest`, for a caller that holds the database but not the registry. */
export const storedManifest = (
  db: { get<T>(sql: string, params?: unknown[]): T | undefined },
  digest: string,
): unknown => {
  const row = db.get<{ content_json: string }>(`SELECT content_json FROM manifests WHERE digest = ?`, [digest]);
  if (!row) return null;
  try {
    return JSON.parse(row.content_json) as unknown;
  } catch {
    return null;
  }
};
