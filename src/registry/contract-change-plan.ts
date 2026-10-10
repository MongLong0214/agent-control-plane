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
 * bootstrap PLAN's refusals are named. The top-level reason code each one carries is an existing one;
 * the catalogue in core/reason-codes.ts gains no entry for these refusals.
 */
export const ContractChangeRefusal = {
  /** The run names no project, so there is no contract to change. */
  PROJECT_MISSING: "CONTRACT_CHANGE_PROJECT_MISSING",
  /**
   * The PLAN carries no full manifest. It is refused rather than stored without one, as plan_submit
   * stored every non-bootstrap PLAN, so nothing reviewed or later activated can name a manifest the
   * PLAN does not carry.
   */
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
  /**
   * The carried manifest changes the approved digest of a workflow the base already declares. Nothing
   * in this slice can show the new bytes check as much as the old, and no owner evidence can be bound
   * to the change yet, so any change is refused; it waits for the owner-evidence path.
   */
  WORKFLOW_DIGEST_CHANGED: "CONTRACT_CHANGE_WORKFLOW_DIGEST_CHANGED",
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
    | "COMMAND_LIMIT_RAISED"
    | "COMMAND_COLLAPSED"
    | "COMMAND_ID_DUPLICATED"
    | "PROFILE_COMMAND_REMOVED"
    | "POST_MERGE_COMMAND_REMOVED"
    | "CI_WORKFLOW_DROPPED"
    | "CI_WORKFLOW_DIGEST_CHANGED"
    | "CI_WORKFLOW_ORDER_CHANGED"
    | "CI_WORKFLOW_CHECK_NAME_SHADOWED"
    | "CI_WORKFLOW_UNAPPROVED"
    | "CI_WORKFLOW_ADDED_BESIDE_CI_EVIDENCE"
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

type Command = ProjectManifest["verificationCommands"][number];
type Workflow = ProjectManifest["ciWorkflows"][number];

const workflowKey = (workflow: Workflow): string =>
  `${workflow.repositoryRole}\u0000${workflow.checkName}\u0000${workflow.path}`;

const sourcesOf = (command: Command): readonly string[] => EVIDENCE_SOURCES[command.evidenceMode];

const hasCiEvidence = (command: Command): boolean => sourcesOf(command).includes("ci");

/**
 * What a command checks, resolved from its specification: what runs, where, with which environment
 * and network. Its id is not part of it unless CI evidence is required: a CI result is matched to a
 * command by its check name, which is the command id, so renaming such a command changes the check
 * that counts. Evidence and resource limits are compared separately, because more of either is
 * stricter rather than different.
 */
const executionIdentity = (command: Command, withId: boolean): string =>
  canonicalJson({
    ...(withId ? { id: command.id } : {}),
    argv: command.argv,
    repositoryRole: command.repositoryRole,
    cwd: command.cwd,
    envAllowlist: [...new Set(command.envAllowlist)].sort(),
    network: command.network,
    networkAllowlist: [...new Set(command.networkAllowlist)].sort(),
    required: command.required,
  });

/** The limits a command runs under; a tighter one fails sooner, a looser one admits more. */
const limitsOf = (command: Command) => ({
  timeoutSeconds: command.timeoutSeconds,
  maxOutputBytes: command.maxOutputBytes,
  maxMemoryMb: command.maxMemoryMb,
  // Absent, the timeout is also the CPU budget.
  maxCpuSeconds: command.maxCpuSeconds ?? command.timeoutSeconds,
});

const sameExecution = (base: Command, next: Command): boolean =>
  executionIdentity(base, hasCiEvidence(base)) === executionIdentity(next, hasCiEvidence(base));

const keepsEvidence = (base: Command, next: Command): boolean =>
  sourcesOf(base).every((source) => sourcesOf(next).includes(source));

const keepsLimits = (base: Command, next: Command): boolean => {
  const before = limitsOf(base);
  const after = limitsOf(next);
  return (Object.keys(before) as Array<keyof typeof before>).every((key) => after[key] <= before[key]);
};

/** Whether `next` discharges the obligation `base` stated: the same check, at least as strict. */
const discharges = (base: Command, next: Command): boolean =>
  sameExecution(base, next) && keepsEvidence(base, next) && keepsLimits(base, next);

/** The commands a profile selects, as `commandsForMode` resolves them. */
const selected = (manifest: ProjectManifest, ids: readonly string[]): Command[] => {
  const wanted = new Set(ids);
  return manifest.verificationCommands.filter((command) => wanted.has(command.id));
};

/**
 * A one-to-one assignment of base obligations to proposed ones (augmenting paths), rather than a match
 * any proposed item may serve several times: each base item gets its own proposed item that `fits` it,
 * or null when no assignment leaves one for it. One proposed command can therefore discharge one base
 * command only, so two required commands that check the same thing cannot collapse into one; `fits`
 * is an order rather than an equality, which is why a greedy choice is not enough.
 */
const assign = <B, P>(bases: readonly B[], proposals: readonly P[], fits: (base: B, proposal: P) => boolean): Array<P | null> => {
  const holder = proposals.map((): number => -1);
  const assigned = bases.map((): number => -1);
  const place = (index: number, seen: boolean[]): boolean => {
    for (let candidate = 0; candidate < proposals.length; candidate++) {
      if (seen[candidate] || !fits(bases[index]!, proposals[candidate]!)) continue;
      seen[candidate] = true;
      if (holder[candidate] === -1 || place(holder[candidate]!, seen)) {
        holder[candidate] = index;
        assigned[index] = candidate;
        return true;
      }
    }
    return false;
  };
  bases.forEach((_, index) => place(index, proposals.map(() => false)));
  return assigned.map((candidate) => (candidate === -1 ? null : proposals[candidate]!));
};

/**
 * Every way `proposed` asks less of a candidate than `base` did, found by comparison rather than
 * declared. Obligations are compared by what they resolve to rather than by name, one to one: each
 * base command, each command a profile selects and each post-merge check has to be discharged by its
 * own proposed counterpart, which for a command checks the same thing (`executionIdentity`) with at
 * least the same evidence and no looser limits. A post-merge entry is a check name, which the
 * consumer deduplicates: each distinct base name is kept by the same name, or, when it names a
 * command, by a distinct name naming a command that discharges it. A workflow the base declares must
 * stay, at the same role, check name and path, with the same approved digest, and keep its place
 * among entries sharing its role and check name, because a check is matched to the first such entry.
 * A new workflow may not be unapproved, may not share a role and check name with another entry, and
 * may not be added beside commands that already take CI evidence, since a check from any approved
 * workflow can supply that evidence. A command id may not be declared twice. The CommitLore mode may
 * not drop. The branch profile is not judged.
 */
export const verificationBarLowerings = (
  base: ProjectManifest,
  proposed: ProjectManifest,
): VerificationBarLowering[] => {
  const lowered: VerificationBarLowering[] = [];

  const commandMatch = assign(base.verificationCommands, proposed.verificationCommands, discharges);
  const matched = new Set(base.verificationCommands.filter((_, index) => commandMatch[index] !== null));
  base.verificationCommands.forEach((command, index) => {
    if (commandMatch[index] !== null) return;
    const same = proposed.verificationCommands.filter((next) => sameExecution(command, next));
    const named = same.find((next) => next.id === command.id) ?? same[0];
    if (proposed.verificationCommands.some((next) => discharges(command, next))) {
      // A proposed command checks this, but it is already the counterpart of another base command.
      lowered.push({ kind: "COMMAND_COLLAPSED", detail: { commandId: command.id } });
    } else if (named && same.some((next) => keepsEvidence(command, next))) {
      lowered.push({ kind: "COMMAND_LIMIT_RAISED", detail: { commandId: command.id } });
    } else if (named) {
      lowered.push({
        kind: "EVIDENCE_MODE_DOWNGRADED",
        detail: { commandId: command.id, from: command.evidenceMode, to: named.evidenceMode },
      });
    } else if (proposed.verificationCommands.some((next) => next.id === command.id)) {
      lowered.push({ kind: "COMMAND_REPLACED", detail: { commandId: command.id } });
    } else {
      lowered.push({ kind: "COMMAND_REMOVED", detail: { commandId: command.id } });
    }
  });
  // An id names one command for every consumer keyed by it (CI results, result rows, limits).
  const baseIds = base.verificationCommands.map((command) => command.id);
  const proposedIds = proposed.verificationCommands.map((command) => command.id);
  for (const id of new Set(proposedIds.filter((id, index) => proposedIds.indexOf(id) !== index))) {
    if (baseIds.filter((baseId) => baseId === id).length < proposedIds.filter((next) => next === id).length) {
      lowered.push({ kind: "COMMAND_ID_DUPLICATED", detail: { commandId: id } });
    }
  }
  // A profile or post-merge obligation is reported only when its command kept a counterpart; a
  // command that is gone, weakened or collapsed is reported once, above.
  for (const profile of PROFILES) {
    const before = selected(base, base.verificationProfiles[profile]);
    const profileMatch = assign(before, selected(proposed, proposed.verificationProfiles[profile]), discharges);
    before.forEach((command, index) => {
      if (profileMatch[index] === null && matched.has(command)) {
        lowered.push({ kind: "PROFILE_COMMAND_REMOVED", detail: { profile, commandId: command.id } });
      }
    });
  }
  const baseChecks = [...new Set(base.postMergeCommands)];
  const proposedChecks = [...new Set(proposed.postMergeCommands)];
  const checkMatch = assign(baseChecks, proposedChecks, (name, next) => {
    if (name === next) return true;
    const commands = selected(base, [name]);
    const candidates = selected(proposed, [next]);
    return commands.length > 0 && candidates.length > 0 &&
      commands.every((command) => candidates.some((candidate) => discharges(command, candidate)));
  });
  baseChecks.forEach((name, index) => {
    if (checkMatch[index] !== null) return;
    const commands = selected(base, [name]);
    if (commands.length > 0 && !commands.some((command) => matched.has(command))) return;
    lowered.push({ kind: "POST_MERGE_COMMAND_REMOVED", detail: { commandId: name } });
  });

  const proposedWorkflows = new Map<string, Workflow[]>();
  for (const workflow of proposed.ciWorkflows) {
    proposedWorkflows.set(workflowKey(workflow), [...(proposedWorkflows.get(workflowKey(workflow)) ?? []), workflow]);
  }
  const baseKeys = new Set(base.ciWorkflows.map(workflowKey));
  for (const workflow of base.ciWorkflows) {
    const next = proposedWorkflows.get(workflowKey(workflow)) ?? [];
    const detail = { repositoryRole: workflow.repositoryRole, checkName: workflow.checkName, path: workflow.path };
    if (next.length === 0) {
      lowered.push({ kind: "CI_WORKFLOW_DROPPED", detail });
    } else if (!next.every((entry) => canonicalJson(entry) === canonicalJson(workflow))) {
      // A newly declared digest is the proposal's own claim about bytes this slice cannot read, so it
      // is no authority for the change, whichever way the digest moved.
      const changed = next.find((entry) => canonicalJson(entry) !== canonicalJson(workflow))!;
      lowered.push({
        kind: "CI_WORKFLOW_DIGEST_CHANGED",
        detail: { ...detail, from: workflow.approvedDigest, to: changed.approvedDigest },
      });
    }
  }
  // Post-merge trust takes the first workflow matching a check's role and name, so the order of
  // entries sharing both decides which bytes a check is compared against.
  const checkSlot = (workflow: Workflow): string => `${workflow.repositoryRole}\u0000${workflow.checkName}`;
  const pathsIn = (manifest: ProjectManifest, slot: string): string[] =>
    manifest.ciWorkflows.filter((workflow) => checkSlot(workflow) === slot).map((workflow) => workflow.path);
  for (const slot of new Set(base.ciWorkflows.map(checkSlot))) {
    const before = pathsIn(base, slot);
    if (before.length < 2) continue;
    const after = pathsIn(proposed, slot).filter((path) => before.includes(path));
    if (canonicalJson(after) !== canonicalJson(before.filter((path) => after.includes(path)))) {
      const [repositoryRole, checkName] = slot.split("\u0000");
      lowered.push({ kind: "CI_WORKFLOW_ORDER_CHANGED", detail: { repositoryRole: repositoryRole!, checkName: checkName! } });
    }
  }
  const baseTakesCiEvidence = base.verificationCommands.some(hasCiEvidence);
  for (const workflow of proposed.ciWorkflows) {
    if (baseKeys.has(workflowKey(workflow))) continue;
    const detail = { repositoryRole: workflow.repositoryRole, checkName: workflow.checkName, path: workflow.path };
    if (workflow.unapprovedFirstActivation) lowered.push({ kind: "CI_WORKFLOW_UNAPPROVED", detail });
    if (proposed.ciWorkflows.some((other) => other !== workflow && checkSlot(other) === checkSlot(workflow))) {
      lowered.push({ kind: "CI_WORKFLOW_CHECK_NAME_SHADOWED", detail });
    }
    if (baseTakesCiEvidence) lowered.push({ kind: "CI_WORKFLOW_ADDED_BESIDE_CI_EVIDENCE", detail });
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
    // one yet, so every lowering is refused; a stricter or equivalent manifest is not. A changed
    // workflow digest is refused under its own code: whether it lowers the bar is not decidable here.
    const workflowChanged = lowered.some((entry) => entry.kind === "CI_WORKFLOW_DIGEST_CHANGED");
    return deny(ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT, workflowChanged
      ? "the carried manifest changes the approved digest of a workflow the run's pinned manifest declares"
      : "the carried manifest lowers the verification bar of the run's pinned manifest", {
      refusal: workflowChanged ? ContractChangeRefusal.WORKFLOW_DIGEST_CHANGED : ContractChangeRefusal.VERIFICATION_BAR_LOWERED,
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
