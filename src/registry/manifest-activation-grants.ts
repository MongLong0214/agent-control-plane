import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ProjectManifest } from "../contracts/manifest.ts";
import { type ArtifactStore, EVIDENCE_PRODUCERS } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, Role, RunKind, RunState, type RunRow, roleKeyFor } from "../domain/types.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import { isMcpReservationInFlight } from "../ingress/ingress-guard.ts";
import {
  type AnyContractChangeBinding,
  type ContractChangeWorkflowEvidence,
  type FirstActivationBinding,
  type FirstActivationFacts,
  type WorkflowRevision,
  currentContractChangePlan,
  currentFirstActivationPlan,
  isFirstActivationRun,
  sameContractChangeBinding,
  storedManifest,
  workflowRevisionsDigest,
} from "./contract-change-plan.ts";

/**
 * Issue #246 B2-b — the authority that lets a CONTRACT_CHANGE run move its project's active manifest.
 *
 * The CEO's CONFIRM of a CONTRACT_CHANGE candidate issues one grant for the run (`issue`), in the
 * transaction that moves the run to CEO_APPROVED. The daemon finalizer asks `verify` before its first
 * GitHub write and again in the transaction that activates: that transaction consumes the grant, moves
 * the pointer from the run's pin to the manifest the run's PLAN carries, and completes the run.
 *
 * The authority is this code. A grant row names facts; `verify` re-derives every one of them from the
 * run, its candidate, its PLAN, its packet and the live CEO binding, and refuses on any that no longer
 * holds. The schema keeps only the structural guards (one grant per run, fixed once written, consumed
 * once, never deleted, the pointer moves only with a consumed grant naming the move, a CONTRACT_CHANGE
 * completes only with its own); a writer with the raw database handle is outside what they stop.
 */

const GRANT_SCHEMA = "acp.manifest-activation-grant.v2";

/** #512 — the digest schema of a first-activation grant; it covers every identity column of its row. */
const FIRST_GRANT_SCHEMA = "acp.manifest-first-activation-grant.v1";

/** Where `verify` is asked: before the first GitHub write, or in the activation transaction itself. */
export type ManifestGrantPhase = "PRE_MERGE" | "ACTIVATION";

const PHASE_STATES: Readonly<Record<ManifestGrantPhase, readonly RunState[]>> = {
  PRE_MERGE: [RunState.CEO_APPROVED, RunState.MERGING, RunState.POST_MERGE_VERIFYING],
  ACTIVATION: [RunState.POST_MERGE_VERIFYING],
};

/** The states a confirmed CONTRACT_CHANGE finalizes through. */
const FINALIZING_STATES: readonly RunState[] = PHASE_STATES.PRE_MERGE;

export interface ManifestActivationGrant {
  grantId: string;
  runId: string;
  projectId: string;
  manifestDigest: string;
  /** The run's dispatch pin: the manifest activation compares-and-sets from. */
  fromManifestDigest: string;
  planDigest: string;
  candidateSnapshotDigest: string;
  packetDigest: string;
  ceoAssignmentId: string;
  ceoActorId: string;
  ceoSessionId: string;
  ceoSessionIncarnation: string;
  ceoBindingGeneration: number;
  issuedAt: string;
  grantDigest: string;
  consumedAt: string | null;
  consumedAttemptId: string | null;
  /**
   * The authenticated CEO session whose call drives consumption (CEO ruling 2): the confirming session
   * at issue, re-bound only by a live CEO session's admitted re-entry. Not part of the grant's digest.
   */
  consumer: GrantConsumer;
}

/** A CEO session, by id and incarnation, as an admitted MCP call authenticated it. */
export interface GrantConsumer {
  sessionId: string;
  sessionIncarnation: string;
}

/**
 * #512 — a first-activation grant: issued at the CEO's CONFIRM of a first-activation CONTRACT_CHANGE of
 * an operator-registered NULL project, bound to the project's registration, the manifest, the PLAN,
 * the candidate, its packet and review, and the exact workflow revisions; no base.
 */
export interface ManifestFirstActivationGrant {
  grantId: string;
  runId: string;
  projectId: string;
  /** The project's PROJECT_REGISTERED audit row, which recorded a NULL active manifest. */
  registrationEventId: number;
  manifestDigest: string;
  planDigest: string;
  candidateSnapshotDigest: string;
  packetDigest: string;
  /** The BLIND_REVIEW artifact that passed this exact binding. */
  reviewDigest: string;
  workflowRevisions: WorkflowRevision[];
  workflowRevisionsDigest: string;
  ceoAssignmentId: string;
  ceoActorId: string;
  ceoSessionId: string;
  ceoSessionIncarnation: string;
  ceoBindingGeneration: number;
  issuedAt: string;
  grantDigest: string;
  consumedAt: string | null;
  consumedAttemptId: string | null;
  consumer: GrantConsumer;
}

/** What a verified grant activates: the manifest its PLAN carries and the workflows that manifest names. */
export type ManifestActivationTarget =
  | {
      kind: "CHANGE";
      grant: ManifestActivationGrant;
      manifest: ProjectManifest;
      workflowEvidence: ContractChangeWorkflowEvidence[];
    }
  | {
      /** #512 — a first activation: no base, and the exact revisions every workflow is read at. */
      kind: "FIRST";
      grant: ManifestFirstActivationGrant;
      manifest: ProjectManifest;
      workflowEvidence: ContractChangeWorkflowEvidence[];
      workflowRevisions: WorkflowRevision[];
    };

/**
 * What the finalizer read of one workflow the manifest points to, before the activation transaction and
 * outside it (CEO ruling 6): the file's exact bytes at `revision` of the exact repository hash to
 * `approvedDigest`. Every workflow is read, an unchanged declaration included: an equal entry in the
 * base says nothing about the bytes at the revision being activated.
 */
export interface ActivatedWorkflowEvidence {
  repositoryRole: string;
  repositoryIdentity: string;
  path: string;
  checkName: string;
  approvedDigest: string;
  evidence: "READ";
  revision: string;
  observedDigest: string;
}

/**
 * #512 — what the finalizer read of one bound workflow revision of a first activation: the exact
 * bytes at the bound commit object, by the exact-commit reader. `revision` is the bound commit.
 */
export interface FirstActivationWorkflowEvidence extends ActivatedWorkflowEvidence {
  commitSha: string;
  objectType: "commit";
  blobSha: string;
  readVia: "LOCAL" | "GITHUB";
  /** Evidence only: whether the default branch head reaches the bound commit. Never decides. */
  reachable: "REACHABLE" | "NOT_REACHABLE" | "UNKNOWN";
  /** The default branch head that evidence was taken against; never read in the commit's place. */
  defaultBranchHead: string | null;
}

/**
 * #512 — `sameWorkflowCoverage` for a first grant: a non-empty set, and an exact bijection between the
 * bound revisions and what was read, each entry read at exactly its bound commit of exactly its bound
 * repository, hashing to its bound digest, which is its workflow's approved digest. `([], [])` is not
 * coverage here.
 */
export const sameFirstActivationCoverage = (
  bound: readonly WorkflowRevision[],
  expected: readonly ContractChangeWorkflowEvidence[],
  supplied: readonly FirstActivationWorkflowEvidence[],
): boolean => {
  if (bound.length === 0 || bound.length !== supplied.length || bound.length !== expected.length) return false;
  const remaining = [...supplied];
  for (const revision of bound) {
    const workflow = expected.find((entry) =>
      entry.repositoryRole === revision.repositoryRole &&
      entry.repositoryRemote === revision.repositoryIdentity &&
      entry.path === revision.path &&
      entry.checkName === revision.checkName);
    if (!workflow || workflow.approvedDigest === null || workflow.unapprovedFirstActivation || workflow.approvedDigest !== revision.fileDigest) {
      return false;
    }
    const index = remaining.findIndex((entry) =>
      entry.repositoryRole === revision.repositoryRole &&
      entry.repositoryIdentity === revision.repositoryIdentity &&
      entry.path === revision.path &&
      entry.checkName === revision.checkName &&
      entry.approvedDigest === revision.fileDigest &&
      entry.evidence === "READ" &&
      entry.objectType === "commit" &&
      entry.revision === revision.commitSha &&
      entry.commitSha === revision.commitSha &&
      entry.observedDigest === revision.fileDigest);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
};

/**
 * Whether `supplied` compares exactly the workflows `expected` names, one each, each read at an exact
 * revision of the exact repository and matching an approved digest; nothing missing or extra, and no
 * workflow without an approved digest.
 */
export const sameWorkflowCoverage = (
  expected: readonly ContractChangeWorkflowEvidence[],
  supplied: readonly ActivatedWorkflowEvidence[],
): boolean => {
  if (expected.length !== supplied.length) return false;
  const remaining = [...supplied];
  for (const workflow of expected) {
    const index = remaining.findIndex((entry) =>
      entry.repositoryRole === workflow.repositoryRole &&
      entry.path === workflow.path &&
      entry.checkName === workflow.checkName &&
      workflow.approvedDigest !== null &&
      !workflow.unapprovedFirstActivation &&
      entry.approvedDigest === workflow.approvedDigest &&
      entry.evidence === "READ" &&
      entry.observedDigest === workflow.approvedDigest &&
      entry.repositoryIdentity === workflow.repositoryRemote &&
      typeof entry.revision === "string" && entry.revision.length > 0);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
};

/**
 * The CEO call's transport identity, as the MCP door that admitted it authenticated it, and the key of
 * the MCP mutation that call is running under: never a tool argument. A CONTRACT_CHANGE CONFIRM without
 * it, or whose mutation is not in flight in this process, issues nothing.
 */
export interface CeoDecisionIngress {
  actor: string | null;
  sessionId: string | null;
  sessionIncarnation: string | null;
  idempotencyKey: string | null;
}

interface RawGrant {
  grant_id: string;
  run_id: string;
  project_id: string;
  manifest_digest: string;
  from_manifest_digest: string;
  plan_digest: string;
  candidate_snapshot_digest: string;
  packet_digest: string;
  ceo_assignment_id: string;
  ceo_actor_id: string;
  ceo_session_id: string;
  ceo_session_incarnation: string;
  ceo_binding_generation: number;
  issued_at: string;
  grant_digest: string;
  consumed_at: string | null;
  consumed_attempt_id: string | null;
  consumer_session_id: string;
  consumer_session_incarnation: string;
  consumer_bound_at: string;
}

interface RawFirstGrant {
  grant_id: string;
  run_id: string;
  project_id: string;
  registration_event_id: number;
  manifest_digest: string;
  plan_digest: string;
  candidate_snapshot_digest: string;
  packet_digest: string;
  review_digest: string;
  workflow_revisions_json: string;
  workflow_revisions_digest: string;
  ceo_assignment_id: string;
  ceo_actor_id: string;
  ceo_session_id: string;
  ceo_session_incarnation: string;
  ceo_binding_generation: number;
  issued_at: string;
  grant_digest: string;
  consumed_at: string | null;
  consumed_attempt_id: string | null;
  consumer_session_id: string;
  consumer_session_incarnation: string;
  consumer_bound_at: string;
}

interface LiveCeo {
  assignmentId: string;
  actorId: string;
  sessionId: string;
  sessionIncarnation: string;
  bindingGeneration: number;
}

const hydrate = (row: RawGrant): ManifestActivationGrant => ({
  grantId: row.grant_id,
  runId: row.run_id,
  projectId: row.project_id,
  manifestDigest: row.manifest_digest,
  fromManifestDigest: row.from_manifest_digest,
  planDigest: row.plan_digest,
  candidateSnapshotDigest: row.candidate_snapshot_digest,
  packetDigest: row.packet_digest,
  ceoAssignmentId: row.ceo_assignment_id,
  ceoActorId: row.ceo_actor_id,
  ceoSessionId: row.ceo_session_id,
  ceoSessionIncarnation: row.ceo_session_incarnation,
  ceoBindingGeneration: row.ceo_binding_generation,
  issuedAt: row.issued_at,
  grantDigest: row.grant_digest,
  consumedAt: row.consumed_at,
  consumedAttemptId: row.consumed_attempt_id,
  consumer: { sessionId: row.consumer_session_id, sessionIncarnation: row.consumer_session_incarnation },
});

/** The digest a grant's identity columns recompute to; a row whose columns moved no longer matches it. */
const grantDigestOf = (grant: Omit<ManifestActivationGrant, "grantDigest" | "consumedAt" | "consumedAttemptId" | "consumer">): string =>
  digestOf({
    schema: GRANT_SCHEMA,
    grantId: grant.grantId,
    runId: grant.runId,
    projectId: grant.projectId,
    runKind: RunKind.CONTRACT_CHANGE,
    manifestDigest: grant.manifestDigest,
    fromManifestDigest: grant.fromManifestDigest,
    planDigest: grant.planDigest,
    candidateSnapshotDigest: grant.candidateSnapshotDigest,
    packetDigest: grant.packetDigest,
    ceoAssignmentId: grant.ceoAssignmentId,
    ceoActorId: grant.ceoActorId,
    ceoSessionId: grant.ceoSessionId,
    ceoSessionIncarnation: grant.ceoSessionIncarnation,
    ceoBindingGeneration: grant.ceoBindingGeneration,
    issuedAt: grant.issuedAt,
  });

const newGrantId = (runId: string, issuedAt: string): string =>
  `mag_${digestOf({ runId, issuedAt }).slice("sha256:".length, "sha256:".length + 24)}`;

const parseRevisions = (json: string): WorkflowRevision[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkflowRevision[]) : [];
  } catch {
    return [];
  }
};

const hydrateFirst = (row: RawFirstGrant): ManifestFirstActivationGrant => ({
  grantId: row.grant_id,
  runId: row.run_id,
  projectId: row.project_id,
  registrationEventId: row.registration_event_id,
  manifestDigest: row.manifest_digest,
  planDigest: row.plan_digest,
  candidateSnapshotDigest: row.candidate_snapshot_digest,
  packetDigest: row.packet_digest,
  reviewDigest: row.review_digest,
  workflowRevisions: parseRevisions(row.workflow_revisions_json),
  workflowRevisionsDigest: row.workflow_revisions_digest,
  ceoAssignmentId: row.ceo_assignment_id,
  ceoActorId: row.ceo_actor_id,
  ceoSessionId: row.ceo_session_id,
  ceoSessionIncarnation: row.ceo_session_incarnation,
  ceoBindingGeneration: row.ceo_binding_generation,
  issuedAt: row.issued_at,
  grantDigest: row.grant_digest,
  consumedAt: row.consumed_at,
  consumedAttemptId: row.consumed_attempt_id,
  consumer: { sessionId: row.consumer_session_id, sessionIncarnation: row.consumer_session_incarnation },
});

/**
 * #512 — the digest a first grant's identity columns recompute to, under its own schema: every
 * identity column of its row, the revisions' JSON (through their digest) included.
 */
const firstGrantDigestOf = (
  grant: Omit<ManifestFirstActivationGrant, "grantDigest" | "consumedAt" | "consumedAttemptId" | "consumer">,
): string =>
  digestOf({
    schema: FIRST_GRANT_SCHEMA,
    grantId: grant.grantId,
    runId: grant.runId,
    projectId: grant.projectId,
    runKind: RunKind.CONTRACT_CHANGE,
    registrationEventId: grant.registrationEventId,
    manifestDigest: grant.manifestDigest,
    planDigest: grant.planDigest,
    candidateSnapshotDigest: grant.candidateSnapshotDigest,
    packetDigest: grant.packetDigest,
    reviewDigest: grant.reviewDigest,
    workflowRevisions: grant.workflowRevisions,
    workflowRevisionsDigest: grant.workflowRevisionsDigest,
    ceoAssignmentId: grant.ceoAssignmentId,
    ceoActorId: grant.ceoActorId,
    ceoSessionId: grant.ceoSessionId,
    ceoSessionIncarnation: grant.ceoSessionIncarnation,
    ceoBindingGeneration: grant.ceoBindingGeneration,
    issuedAt: grant.issuedAt,
  });

const newFirstGrantId = (runId: string, issuedAt: string): string =>
  `mfa_${digestOf({ runId, issuedAt, kind: "FIRST" }).slice("sha256:".length, "sha256:".length + 24)}`;

export class ManifestActivationGrants {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly artifacts: ArtifactStore,
    private readonly runs: { get(runId: string): RunRow | null; currentCandidate(runId: string): string | null },
    private readonly bindings: Pick<BindingRegistry, "active">,
  ) {}

  /** The run's grant, consumed or not; null when its CONFIRM issued none. */
  get(runId: string): ManifestActivationGrant | null {
    const row = this.db.get<RawGrant>(`SELECT * FROM manifest_activation_grants WHERE run_id = ?`, [runId]);
    return row ? hydrate(row) : null;
  }

  /** #512 — the run's first-activation grant, consumed or not; null when its CONFIRM issued none. */
  getFirst(runId: string): ManifestFirstActivationGrant | null {
    const row = this.db.get<RawFirstGrant>(`SELECT * FROM manifest_first_activation_grants WHERE run_id = ?`, [runId]);
    return row ? hydrateFirst(row) : null;
  }

  /**
   * #512 — the first-activation facts for the run as they stand now (E2–E5), for a reader that holds no
   * database of its own (plan_submit, the candidate freeze); null for a run that is not a NULL-pinned
   * CONTRACT_CHANGE of a project.
   */
  firstActivationFactsFor(runId: string): FirstActivationFacts | null {
    const run = this.runs.get(runId);
    return run !== null ? firstActivationFactsOf(this.db, run) : null;
  }

  /**
   * #512 — whether the run's CONFIRM issues a first-activation grant: a CONTRACT_CHANGE run of a
   * project whose pin is NULL. Its CONFIRM is judged by the first-activation conditions only.
   */
  isFirstActivation(runId: string): boolean {
    const run = this.runs.get(runId);
    return run !== null && isFirstActivationRun(run);
  }

  /**
   * The read-only half of a CONTRACT_CHANGE CONFIRM's admission, asked before the decision changes
   * anything: the call is an admitted MCP mutation authenticated as the live CEO session it names, the
   * base is still the active manifest (CEO ruling 1), and the candidate is still the one its PLAN, its
   * review and its packet bind.
   */
  admitConfirm(
    runId: string,
    candidateSnapshotDigest: string,
    caller: { ceoSessionId: string; ingress?: CeoDecisionIngress },
  ): Decision<{ planDigest: string; manifestDigest: string; fromManifestDigest: string | null; packetDigest: string }> {
    const authenticated = this.authenticateCaller(runId, caller);
    if (!authenticated.allowed) return authenticated as Decision<never>;
    const run = this.runs.get(runId);
    if (!run || run.kind !== RunKind.CONTRACT_CHANGE || !run.projectId) {
      return deny(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN, "a manifest activation grant is issued only for a CONTRACT_CHANGE run of a project", {
        runId,
        kind: run?.kind ?? null,
        projectId: run?.projectId ?? null,
      });
    }
    // #512 — a NULL-pinned CONTRACT_CHANGE is a first activation, judged by its own conditions only.
    if (isFirstActivationRun(run)) {
      const first = this.firstTarget(run, candidateSnapshotDigest);
      if (!first.allowed) return first as Decision<never>;
      return allow(ReasonCode.OK, {
        planDigest: first.value.binding.planDigest,
        manifestDigest: first.value.binding.manifestDigest,
        fromManifestDigest: null,
        packetDigest: first.value.packetDigest,
      });
    }
    const pinned = this.pinStillActive(run);
    if (!pinned.allowed) return pinned as Decision<never>;
    return this.boundTarget(run, candidateSnapshotDigest);
  }

  /**
   * The project's other CONTRACT_CHANGE runs whose finalization is under way: merging, verifying after
   * a merge, or holding a live finalization attempt. Two grants on one base race to the same
   * compare-and-set, so the finalizer starts a CONTRACT_CHANGE only when none is, which keeps the loser
   * from merging anything; the compare-and-set then refuses it before its first GitHub write. A run
   * merely confirmed, or stuck at CEO_APPROVED, is not counted, so it never blocks the project.
   */
  finalizingContractChanges(projectId: string, exceptRunId: string): Array<{ runId: string; state: string }> {
    return this.db.all<{ run_id: string; state: string }>(
      `SELECT r.run_id, r.state FROM runs r
        WHERE r.project_id = ? AND r.kind = 'CONTRACT_CHANGE' AND r.run_id <> ?
          AND (r.state IN ('MERGING','POST_MERGE_VERIFYING')
               OR EXISTS (SELECT 1 FROM finalization_attempts f
                           WHERE f.run_id = r.run_id AND f.state = 'RUNNING' AND f.deadline_at > ?))
        ORDER BY r.run_id`,
      [projectId, exceptRunId, this.clock.nowIso()],
    ).map((row) => ({ runId: row.run_id, state: row.state }));
  }

  /**
   * Issues the run's one grant. Called only by the production gate, inside the CONFIRM transaction,
   * after the run moved to CEO_APPROVED, so a refusal here undoes the decision. The call must be an
   * admitted MCP mutation, in flight now, whose door authenticated the live CEO binding's session and
   * incarnation, and that session must be the one the call names; it becomes the grant's consumer.
   */
  issue(input: {
    runId: string;
    candidateSnapshotDigest: string;
    ceoSessionId: string;
    ingress?: CeoDecisionIngress;
  }): Decision<ManifestActivationGrant> {
    const run = this.runs.get(input.runId);
    if (!run || run.kind !== RunKind.CONTRACT_CHANGE || !run.projectId || run.state !== RunState.CEO_APPROVED) {
      return deny(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN, "a grant is issued only as a CONTRACT_CHANGE run is confirmed", {
        runId: input.runId,
        kind: run?.kind ?? null,
        state: run?.state ?? null,
      });
    }
    if (this.get(input.runId)) {
      return deny(ReasonCode.CONFLICT, "this run already holds its one activation grant", { runId: input.runId });
    }
    if (this.runs.currentCandidate(input.runId) !== input.candidateSnapshotDigest) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the confirmed candidate is not the run's current candidate", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        currentCandidateSnapshotDigest: this.runs.currentCandidate(input.runId),
      });
    }
    const pinned = this.pinStillActive(run);
    if (!pinned.allowed) return pinned as Decision<ManifestActivationGrant>;
    const target = this.boundTarget(run, input.candidateSnapshotDigest);
    if (!target.allowed) return target as Decision<ManifestActivationGrant>;

    const authenticated = this.authenticateCaller(input.runId, input);
    if (!authenticated.allowed) return authenticated as Decision<ManifestActivationGrant>;
    const ceo = authenticated.value;

    const issuedAt = this.clock.nowIso();
    const identity = {
      grantId: newGrantId(input.runId, issuedAt),
      runId: input.runId,
      projectId: run.projectId,
      manifestDigest: target.value.manifestDigest,
      fromManifestDigest: target.value.fromManifestDigest,
      planDigest: target.value.planDigest,
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      packetDigest: target.value.packetDigest,
      ceoAssignmentId: ceo.assignmentId,
      ceoActorId: ceo.actorId,
      ceoSessionId: ceo.sessionId,
      ceoSessionIncarnation: ceo.sessionIncarnation,
      ceoBindingGeneration: ceo.bindingGeneration,
      issuedAt,
    };
    const grant: ManifestActivationGrant = {
      ...identity,
      grantDigest: grantDigestOf(identity),
      consumedAt: null,
      consumedAttemptId: null,
      consumer: { sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation },
    };
    this.db.run(
      `INSERT INTO manifest_activation_grants
         (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
          candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
          ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
          consumer_session_id, consumer_session_incarnation, consumer_bound_at)
       VALUES (?, ?, ?, 'CONTRACT_CHANGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.grantId, grant.runId, grant.projectId, grant.manifestDigest, grant.fromManifestDigest,
        grant.planDigest, grant.candidateSnapshotDigest, grant.packetDigest, grant.ceoAssignmentId,
        grant.ceoActorId, grant.ceoSessionId, grant.ceoSessionIncarnation, grant.ceoBindingGeneration,
        grant.issuedAt, grant.grantDigest, grant.consumer.sessionId, grant.consumer.sessionIncarnation, issuedAt,
      ],
    );
    return allow(ReasonCode.OK, grant);
  }

  /**
   * #512 — issues the run's one first-activation grant. Called only by the production gate, inside the
   * CONFIRM transaction, after the run moved to CEO_APPROVED, so a refusal here undoes the decision. On
   * top of everything `issue` asks of the call, the run must be a first-activation CONTRACT_CHANGE
   * (E1), the project NULL now (E2) and operator-registered (E3), the manifest's repositories exactly
   * the project's registered ones (E4), the run without a repository (E5), and the PLAN bound to an
   * exact revision of every workflow (E6); the candidate's latest review must PASS that exact binding.
   */
  issueFirst(input: {
    runId: string;
    candidateSnapshotDigest: string;
    ceoSessionId: string;
    ingress?: CeoDecisionIngress;
  }): Decision<ManifestFirstActivationGrant> {
    const run = this.runs.get(input.runId);
    if (!run || run.kind !== RunKind.CONTRACT_CHANGE || !run.projectId || run.state !== RunState.CEO_APPROVED || !isFirstActivationRun(run)) {
      return deny(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN, "a first-activation grant is issued only as a NULL-pinned CONTRACT_CHANGE run is confirmed", {
        runId: input.runId,
        kind: run?.kind ?? null,
        state: run?.state ?? null,
        pinnedManifestDigest: run?.pinnedManifestDigest ?? null,
      });
    }
    if (this.get(input.runId) || this.getFirst(input.runId)) {
      return deny(ReasonCode.CONFLICT, "this run already holds its one activation grant", { runId: input.runId });
    }
    if (this.runs.currentCandidate(input.runId) !== input.candidateSnapshotDigest) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the confirmed candidate is not the run's current candidate", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        currentCandidateSnapshotDigest: this.runs.currentCandidate(input.runId),
      });
    }
    const target = this.firstTarget(run, input.candidateSnapshotDigest);
    if (!target.allowed) return target as Decision<ManifestFirstActivationGrant>;

    const authenticated = this.authenticateCaller(input.runId, input);
    if (!authenticated.allowed) return authenticated as Decision<ManifestFirstActivationGrant>;
    const ceo = authenticated.value;

    const issuedAt = this.clock.nowIso();
    const identity = {
      grantId: newFirstGrantId(input.runId, issuedAt),
      runId: input.runId,
      projectId: run.projectId,
      registrationEventId: target.value.registrationEventId,
      manifestDigest: target.value.binding.manifestDigest,
      planDigest: target.value.binding.planDigest,
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      packetDigest: target.value.packetDigest,
      reviewDigest: target.value.reviewDigest,
      workflowRevisions: target.value.workflowRevisions,
      workflowRevisionsDigest: target.value.binding.workflowRevisionsDigest,
      ceoAssignmentId: ceo.assignmentId,
      ceoActorId: ceo.actorId,
      ceoSessionId: ceo.sessionId,
      ceoSessionIncarnation: ceo.sessionIncarnation,
      ceoBindingGeneration: ceo.bindingGeneration,
      issuedAt,
    };
    const grant: ManifestFirstActivationGrant = {
      ...identity,
      grantDigest: firstGrantDigestOf(identity),
      consumedAt: null,
      consumedAttemptId: null,
      consumer: { sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation },
    };
    this.db.run(
      `INSERT INTO manifest_first_activation_grants
         (grant_id, run_id, project_id, run_kind, registration_event_id, manifest_digest, plan_digest,
          candidate_snapshot_digest, packet_digest, review_digest, workflow_revisions_json,
          workflow_revisions_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
          ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
          consumer_session_id, consumer_session_incarnation, consumer_bound_at)
       VALUES (?, ?, ?, 'CONTRACT_CHANGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.grantId, grant.runId, grant.projectId, grant.registrationEventId, grant.manifestDigest,
        grant.planDigest, grant.candidateSnapshotDigest, grant.packetDigest, grant.reviewDigest,
        JSON.stringify(grant.workflowRevisions), grant.workflowRevisionsDigest, grant.ceoAssignmentId,
        grant.ceoActorId, grant.ceoSessionId, grant.ceoSessionIncarnation, grant.ceoBindingGeneration,
        grant.issuedAt, grant.grantDigest, grant.consumer.sessionId, grant.consumer.sessionIncarnation, issuedAt,
      ],
    );
    return allow(ReasonCode.OK, grant);
  }

  /**
   * Every fact the run's grant names, re-derived: the grant is the run's and unaltered, the run is the
   * CONTRACT_CHANGE it was issued for, on the same candidate, in a state this phase admits; the
   * candidate still binds the PLAN, its manifest and its base; the packet still exists; the project's
   * active manifest is still the base (compare-and-set); the CEO authority that confirmed still holds
   * the role; and the grant's consumer is the live CEO binding's session and incarnation, and the one
   * the asking finalization attempt started for (CEO ruling 2). Unconsumed, always: a consumed grant
   * activates nothing again.
   */
  verify(runId: string, phase: ManifestGrantPhase, attemptConsumer: GrantConsumer | null): Decision<ManifestActivationTarget> {
    const first = this.getFirst(runId);
    if (first) return this.verifyFirst(first, phase, attemptConsumer);
    const grant = this.get(runId);
    if (!grant) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "this CONTRACT_CHANGE run holds no activation grant from a CEO CONFIRM", { runId, phase });
    }
    const evidence = { runId, phase, grantId: grant.grantId };
    const { grantDigest, consumedAt: _consumedAt, consumedAttemptId: _consumedAttemptId, consumer: _consumer, ...identity } = grant;
    if (grantDigestOf(identity) !== grantDigest) {
      // An altered row, not a newer generation: a failure, never a staleness verdict.
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "the grant's columns no longer recompute to its digest", evidence);
    }
    if (grant.consumedAt !== null) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED, "this grant has already been consumed", {
        ...evidence,
        consumedAt: grant.consumedAt,
        consumedAttemptId: grant.consumedAttemptId,
      });
    }
    const run = this.runs.get(runId);
    if (!run || run.kind !== RunKind.CONTRACT_CHANGE || run.projectId !== grant.projectId) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the grant does not belong to this CONTRACT_CHANGE run of its project", {
        ...evidence,
        kind: run?.kind ?? null,
        projectId: run?.projectId ?? null,
        grantProjectId: grant.projectId,
      });
    }
    if (!PHASE_STATES[phase].includes(run.state)) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `a grant is not used at ${phase} while the run is ${run.state}`, { ...evidence, state: run.state });
    }
    if (this.runs.currentCandidate(runId) !== grant.candidateSnapshotDigest) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the run's current candidate is not the one the CEO confirmed", {
        ...evidence,
        grantCandidate: grant.candidateSnapshotDigest,
        currentCandidate: this.runs.currentCandidate(runId),
      });
    }
    const target = this.boundTarget(run, grant.candidateSnapshotDigest);
    if (!target.allowed) return target as Decision<ManifestActivationTarget>;
    if (
      target.value.planDigest !== grant.planDigest ||
      target.value.manifestDigest !== grant.manifestDigest ||
      target.value.fromManifestDigest !== grant.fromManifestDigest ||
      target.value.packetDigest !== grant.packetDigest
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate no longer binds the PLAN, manifest, base and packet the grant names", {
        ...evidence,
        granted: { plan: grant.planDigest, manifest: grant.manifestDigest, base: grant.fromManifestDigest, packet: grant.packetDigest },
        current: target.value,
      });
    }
    const active = this.activeManifestDigest(grant.projectId);
    if (active !== grant.fromManifestDigest) {
      return deny(ReasonCode.MANIFEST_PIN_SUPERSEDED, "the project's active manifest is no longer the base this grant replaces", {
        ...evidence,
        base: grant.fromManifestDigest,
        active,
      });
    }
    const authority = this.currentAuthority(grant);
    if (!authority.allowed) return deny(authority.reasonCode, authority.message, { ...evidence, ...authority.evidence });
    const consuming = this.liveConsumer(grant, attemptConsumer);
    if (!consuming.allowed) return deny(consuming.reasonCode, consuming.message, { ...evidence, ...consuming.evidence });

    const manifest = this.currentPlan(run);
    if (!manifest.allowed) return manifest as Decision<ManifestActivationTarget>;
    return allow(ReasonCode.OK, { kind: "CHANGE", grant, manifest: manifest.value.manifest, workflowEvidence: manifest.value.workflowEvidence });
  }

  /**
   * #512 — `verify` for a first-activation grant: every fact it names re-derived as `verify` does, and
   * on top the first-activation conditions, re-checked now: the run is still a NULL-pinned
   * CONTRACT_CHANGE of the grant's project (E1); the project is still NULL (E2) and operator-registered
   * under the registration the grant names (E3); its registered repositories and roles are still
   * exactly the manifest's (E4); the run has no repository (E5); the PLAN still binds the grant's exact
   * revisions (E6); and the candidate's latest review is still the bound one, with PASS.
   */
  private verifyFirst(
    grant: ManifestFirstActivationGrant,
    phase: ManifestGrantPhase,
    attemptConsumer: GrantConsumer | null,
  ): Decision<ManifestActivationTarget> {
    const runId = grant.runId;
    const evidence = { runId, phase, grantId: grant.grantId, activation: "FIRST" };
    const { grantDigest, consumedAt: _consumedAt, consumedAttemptId: _consumedAttemptId, consumer: _consumer, ...identity } = grant;
    if (firstGrantDigestOf(identity) !== grantDigest || workflowRevisionsDigest(grant.workflowRevisions) !== grant.workflowRevisionsDigest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "the first-activation grant's columns no longer recompute to its digest", evidence);
    }
    if (grant.consumedAt !== null) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED, "this grant has already been consumed", {
        ...evidence,
        consumedAt: grant.consumedAt,
        consumedAttemptId: grant.consumedAttemptId,
      });
    }
    const run = this.runs.get(runId);
    if (!run || run.kind !== RunKind.CONTRACT_CHANGE || run.projectId !== grant.projectId || !isFirstActivationRun(run)) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the grant does not belong to this NULL-pinned CONTRACT_CHANGE run of its project", {
        ...evidence,
        kind: run?.kind ?? null,
        projectId: run?.projectId ?? null,
        pinnedManifestDigest: run?.pinnedManifestDigest ?? null,
        grantProjectId: grant.projectId,
      });
    }
    if (!PHASE_STATES[phase].includes(run.state)) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `a grant is not used at ${phase} while the run is ${run.state}`, { ...evidence, state: run.state });
    }
    if (this.runs.currentCandidate(runId) !== grant.candidateSnapshotDigest) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the run's current candidate is not the one the CEO confirmed", {
        ...evidence,
        grantCandidate: grant.candidateSnapshotDigest,
        currentCandidate: this.runs.currentCandidate(runId),
      });
    }
    const target = this.firstTarget(run, grant.candidateSnapshotDigest);
    if (!target.allowed) return deny(target.reasonCode, target.message, { ...evidence, ...target.evidence });
    if (
      target.value.binding.planDigest !== grant.planDigest ||
      target.value.binding.manifestDigest !== grant.manifestDigest ||
      target.value.binding.workflowRevisionsDigest !== grant.workflowRevisionsDigest ||
      target.value.packetDigest !== grant.packetDigest ||
      target.value.reviewDigest !== grant.reviewDigest ||
      target.value.registrationEventId !== grant.registrationEventId
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate no longer binds the PLAN, manifest, revisions, packet, review and registration the grant names", {
        ...evidence,
        granted: {
          plan: grant.planDigest,
          manifest: grant.manifestDigest,
          revisions: grant.workflowRevisionsDigest,
          packet: grant.packetDigest,
          review: grant.reviewDigest,
          registrationEventId: grant.registrationEventId,
        },
        current: {
          plan: target.value.binding.planDigest,
          manifest: target.value.binding.manifestDigest,
          revisions: target.value.binding.workflowRevisionsDigest,
          packet: target.value.packetDigest,
          review: target.value.reviewDigest,
          registrationEventId: target.value.registrationEventId,
        },
      });
    }
    const authority = this.currentAuthority(grant);
    if (!authority.allowed) return deny(authority.reasonCode, authority.message, { ...evidence, ...authority.evidence });
    const consuming = this.liveConsumer(grant, attemptConsumer);
    if (!consuming.allowed) return deny(consuming.reasonCode, consuming.message, { ...evidence, ...consuming.evidence });
    return allow(ReasonCode.OK, {
      kind: "FIRST",
      grant,
      manifest: target.value.manifest,
      workflowEvidence: target.value.workflowEvidence,
      workflowRevisions: target.value.workflowRevisions,
    });
  }

  /** The grant's consumer as it stands, which a finalization attempt takes as its own when it starts. */
  consumerOf(runId: string): GrantConsumer | null {
    return this.getFirst(runId)?.consumer ?? this.get(runId)?.consumer ?? null;
  }

  /**
   * CEO ruling 2's other half: a live CEO session re-enters a confirmed CONTRACT_CHANGE whose grant is
   * unconsumed — after an official re-adoption left the grant's consumer an earlier session — and
   * becomes its consumer, with no new approval. It is the CEO's CONFIRM of the same run and candidate,
   * admitted as an MCP mutation in flight now and authenticated as the live binding, of the actor that
   * confirmed or its re-adopted successor. A finalization attempt started for the earlier consumer can
   * no longer consume; the next one does, for this one.
   */
  bindConsumer(input: {
    runId: string;
    candidateSnapshotDigest: string;
    ceoSessionId: string;
    ingress?: CeoDecisionIngress;
  }): Decision<ManifestActivationGrant | ManifestFirstActivationGrant> {
    const authenticated = this.authenticateCaller(input.runId, input);
    if (!authenticated.allowed) return authenticated as Decision<never>;
    const ceo = authenticated.value;
    // #512 — a first-activation run's grant is in its own table; the re-entry rule is the same.
    const first = this.getFirst(input.runId);
    const grant = first ?? this.get(input.runId);
    if (!grant) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "this CONTRACT_CHANGE run holds no activation grant from a CEO CONFIRM", { runId: input.runId });
    }
    if (grant.consumedAt !== null) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED, "this grant has already been consumed", { runId: input.runId, consumedAt: grant.consumedAt });
    }
    const run = this.runs.get(input.runId);
    if (!run || !PHASE_STATES.PRE_MERGE.includes(run.state)) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "a grant's consumer is re-bound only while its run finalizes", {
        runId: input.runId,
        state: run?.state ?? null,
      });
    }
    if (input.candidateSnapshotDigest !== grant.candidateSnapshotDigest || this.runs.currentCandidate(input.runId) !== grant.candidateSnapshotDigest) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the call does not name the candidate the grant was issued for", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        grantCandidate: grant.candidateSnapshotDigest,
      });
    }
    const authority = this.currentAuthority(grant);
    if (!authority.allowed) return authority as Decision<never>;
    const consumer = { sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation };
    const changed = this.db.run(
      `UPDATE ${first ? "manifest_first_activation_grants" : "manifest_activation_grants"}
          SET consumer_session_id = ?, consumer_session_incarnation = ?, consumer_bound_at = ?
        WHERE run_id = ? AND consumed_at IS NULL`,
      [consumer.sessionId, consumer.sessionIncarnation, this.clock.nowIso(), input.runId],
    ).changes;
    if (changed !== 1) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED, "this grant has already been consumed", { runId: input.runId });
    }
    return allow(ReasonCode.OK, { ...grant, consumer });
  }

  /**
   * Consumes the run's grant for one finalization attempt. Called only by the activation transaction,
   * after `verify(runId, "ACTIVATION")` in that same transaction; the attempt must be the run's RUNNING
   * finalization attempt for the confirmed candidate, so the consumption names who executed it.
   */
  consume(runId: string, attemptId: string): Decision<ManifestActivationGrant | ManifestFirstActivationGrant> {
    // #512 — a first-activation grant is consumed the same way, in its own table, where the schema
    // also refuses it unless the project is still NULL.
    const first = this.getFirst(runId);
    const grant = first ?? this.get(runId);
    if (!grant) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "this CONTRACT_CHANGE run holds no activation grant", { runId });
    }
    const attempt = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM finalization_attempts
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND candidate_digest = ?`,
      [runId, attemptId, grant.candidateSnapshotDigest],
    );
    if ((attempt?.n ?? 0) !== 1) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "a grant is consumed only by the run's running finalization attempt for the confirmed candidate", {
        runId,
        attemptId,
        candidateSnapshotDigest: grant.candidateSnapshotDigest,
      });
    }
    const consumedAt = this.clock.nowIso();
    const changed = this.db.run(
      `UPDATE ${first ? "manifest_first_activation_grants" : "manifest_activation_grants"} SET consumed_at = ?, consumed_attempt_id = ?
        WHERE run_id = ? AND consumed_at IS NULL`,
      [consumedAt, attemptId, runId],
    ).changes;
    if (changed !== 1) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED, "this grant has already been consumed", { runId, attemptId });
    }
    return allow(ReasonCode.OK, { ...grant, consumedAt, consumedAttemptId: attemptId });
  }

  /**
   * The caller of a CONFIRM that issues a grant or re-binds its consumer: an MCP mutation whose handler
   * is running now (the reservation is in this process's in-flight set, its row unanswered), whose door
   * authenticated the live CEO binding's session and incarnation, and that session is the one the call
   * names. An in-process call, which carries no ingress, is refused.
   */
  private authenticateCaller(runId: string, caller: { ceoSessionId: string; ingress?: CeoDecisionIngress }): Decision<LiveCeo> {
    const ingress = caller.ingress;
    if (!ingress || !ingress.actor || !ingress.sessionId || !ingress.sessionIncarnation || !ingress.idempotencyKey) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "a CONTRACT_CHANGE confirmation must arrive as an authenticated MCP call", {
        runId,
        ingress: ingress ? "INCOMPLETE" : "ABSENT",
      });
    }
    if (!isMcpReservationInFlight(this.db, ingress.idempotencyKey, ingress.actor)) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "the confirmation is not an MCP mutation in flight in this process", {
        runId,
        idempotencyKey: ingress.idempotencyKey,
      });
    }
    const ceo = this.liveCeo();
    if (
      !ceo ||
      ingress.sessionId !== caller.ceoSessionId ||
      ingress.sessionId !== ceo.sessionId ||
      ingress.sessionIncarnation !== ceo.sessionIncarnation
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "the authenticated caller is not the live CEO session the decision names", {
        runId,
        ceoSessionId: caller.ceoSessionId,
        authenticatedSessionId: ingress.sessionId,
        liveCeoSessionId: ceo?.sessionId ?? null,
        authenticatedIncarnationMatches: ceo !== null && ingress.sessionIncarnation === ceo.sessionIncarnation,
      });
    }
    return allow(ReasonCode.OK, ceo);
  }

  /**
   * CEO ruling 2: the grant's consumer is the live CEO binding's session and incarnation now, and the
   * finalization attempt asking is the one started for that consumer. An attempt started for an earlier
   * session, or a consumer an official re-adoption has since replaced, consumes nothing.
   */
  private liveConsumer(grant: Pick<ManifestActivationGrant, "consumer">, attemptConsumer: GrantConsumer | null): Decision<void> {
    const ceo = this.liveCeo();
    const evidence = {
      consumerSessionId: grant.consumer.sessionId,
      attemptConsumerSessionId: attemptConsumer?.sessionId ?? null,
      liveCeoSessionId: ceo?.sessionId ?? null,
    };
    if (
      !attemptConsumer ||
      attemptConsumer.sessionId !== grant.consumer.sessionId ||
      attemptConsumer.sessionIncarnation !== grant.consumer.sessionIncarnation
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "this finalization attempt was not started for the grant's current consumer", evidence);
    }
    if (!ceo || ceo.sessionId !== grant.consumer.sessionId || ceo.sessionIncarnation !== grant.consumer.sessionIncarnation) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "the grant's consumer is not the live CEO session; a live CEO session must re-enter", evidence);
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** CEO ruling 1: a CONTRACT_CHANGE replaces only the manifest it was judged against. */
  private pinStillActive(run: RunRow): Decision<void> {
    const active = run.projectId ? this.activeManifestDigest(run.projectId) : null;
    if (!run.pinnedManifestDigest || run.pinnedManifestDigest !== active) {
      return deny(ReasonCode.MANIFEST_PIN_SUPERSEDED, "the run's base is no longer the project's active manifest", {
        runId: run.runId,
        projectId: run.projectId,
        base: run.pinnedManifestDigest,
        active,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * What the confirmed candidate binds: its snapshot's `contractChange` is the binding the run's latest
   * PLAN still implies, and its published packet's review covered that same binding with a PASS.
   */
  private boundTarget(
    run: RunRow,
    candidateSnapshotDigest: string,
  ): Decision<{ planDigest: string; manifestDigest: string; fromManifestDigest: string; packetDigest: string }> {
    const evidence = { runId: run.runId, candidateSnapshotDigest };
    const snapshot = this.artifacts.latestForSnapshot<CandidateSnapshot>(run.runId, ArtifactKind.CANDIDATE_SNAPSHOT, candidateSnapshotDigest);
    // #512 — a snapshot may name a first activation, which never equals the general binding below.
    const binding = snapshot?.content.contractChange as AnyContractChangeBinding | undefined;
    if (!snapshot || snapshot.superseded || !binding) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate binds no contract change", evidence);
    }
    const current = this.currentPlan(run);
    if (!current.allowed || !sameContractChangeBinding(current.value.binding, binding)) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the PLAN this candidate binds is no longer the run's current PLAN", {
        ...evidence,
        candidate: binding,
        current: current.allowed ? current.value.binding : null,
      });
    }
    const packet = this.artifacts.latestForSnapshot<unknown>(run.runId, ArtifactKind.PRODUCTION_READY_PACKET, candidateSnapshotDigest);
    if (!packet || packet.producedBy !== EVIDENCE_PRODUCERS.PRODUCTION_READY_PACKET) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "no production-ready packet was published for this candidate", evidence);
    }
    // The review itself, not the packet's summary of it: a no-repository candidate's packet records a
    // not-applicable placeholder even though its contract change was reviewed.
    const review = this.artifacts.latestForSnapshot<{
      verdict?: unknown;
      contractChange?: { planDigest: string; manifestDigest: string; baseManifestDigest: string };
    }>(run.runId, ArtifactKind.BLIND_REVIEW, candidateSnapshotDigest);
    if (
      !review ||
      review.producedBy !== EVIDENCE_PRODUCERS.BLIND_REVIEW ||
      review.content.verdict !== "PASS" ||
      !sameContractChangeBinding(review.content.contractChange, current.value.binding)
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate's review did not pass this exact contract change", {
        ...evidence,
        packetDigest: packet.digest,
        reviewDigest: review?.digest ?? null,
      });
    }
    return allow(ReasonCode.OK, {
      planDigest: current.value.binding.planDigest,
      manifestDigest: current.value.binding.manifestDigest,
      fromManifestDigest: current.value.binding.baseManifestDigest,
      packetDigest: packet.digest,
    });
  }

  /**
   * #512 — what a first-activation candidate binds, re-derived now: its snapshot's `contractChange` is
   * the first-activation binding the run's latest PLAN still implies, judged against the project as it
   * stands (E2–E6); a production-ready packet was published for it; and the candidate's latest review
   * passed that exact binding. Also returns the registration (E3) the grant names.
   */
  private firstTarget(
    run: RunRow,
    candidateSnapshotDigest: string,
  ): Decision<{
    binding: FirstActivationBinding;
    manifest: ProjectManifest;
    workflowEvidence: ContractChangeWorkflowEvidence[];
    workflowRevisions: WorkflowRevision[];
    packetDigest: string;
    reviewDigest: string;
    registrationEventId: number;
  }> {
    const evidence = { runId: run.runId, candidateSnapshotDigest, activation: "FIRST" };
    const facts = this.firstActivationFacts(run);
    const current = currentFirstActivationPlan(run, this.artifacts.latest<unknown>(run.runId, ArtifactKind.PLAN), facts);
    if (!current.allowed) return current as Decision<never>;
    const snapshot = this.artifacts.latestForSnapshot<CandidateSnapshot>(run.runId, ArtifactKind.CANDIDATE_SNAPSHOT, candidateSnapshotDigest);
    const named = snapshot?.content.contractChange as unknown as FirstActivationBinding | undefined;
    if (!snapshot || snapshot.superseded || !named || !sameContractChangeBinding(current.value.binding, named)) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate does not bind the first activation the run's current PLAN implies", {
        ...evidence,
        candidate: named ?? null,
        current: current.value.binding,
      });
    }
    const packet = this.artifacts.latestForSnapshot<unknown>(run.runId, ArtifactKind.PRODUCTION_READY_PACKET, candidateSnapshotDigest);
    if (!packet || packet.producedBy !== EVIDENCE_PRODUCERS.PRODUCTION_READY_PACKET) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "no production-ready packet was published for this candidate", evidence);
    }
    const review = this.artifacts.latestForSnapshot<{ verdict?: unknown; contractChange?: FirstActivationBinding }>(
      run.runId,
      ArtifactKind.BLIND_REVIEW,
      candidateSnapshotDigest,
    );
    if (
      !review ||
      review.superseded ||
      review.producedBy !== EVIDENCE_PRODUCERS.BLIND_REVIEW ||
      review.content.verdict !== "PASS" ||
      !sameContractChangeBinding(review.content.contractChange, current.value.binding)
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate's latest review did not pass this exact first activation", {
        ...evidence,
        packetDigest: packet.digest,
        reviewDigest: review?.digest ?? null,
      });
    }
    // E3's registration, which `currentFirstActivationPlan` above has just required to exist.
    const registrationEventId = facts.registrationEventId!;
    return allow(ReasonCode.OK, {
      binding: current.value.binding,
      manifest: current.value.manifest,
      workflowEvidence: current.value.workflowEvidence,
      workflowRevisions: current.value.workflowRevisions,
      packetDigest: packet.digest,
      reviewDigest: review.digest,
      registrationEventId,
    });
  }

  /** #512 — the first-activation facts only the database holds, as they stand now (E2–E5). */
  private firstActivationFacts(run: RunRow): FirstActivationFacts {
    return firstActivationFactsOf(this.db, run) ?? {
      activeManifestDigest: this.activeManifestDigest(run.projectId ?? ""),
      registrationEventId: null,
      bootstrapApplications: 0,
      registeredRepositories: [],
      runRepositories: 0,
    };
  }

  private currentPlan(run: RunRow) {
    return currentContractChangePlan(
      run,
      this.artifacts.latest<unknown>(run.runId, ArtifactKind.PLAN),
      (digest) => storedManifest(this.db, digest),
    );
  }

  /**
   * CEO ruling 2: the authority that consumes is the live CEO binding, authenticated now. It must be
   * the actor that confirmed, not retired, served by a READY session; an official re-adoption of that
   * actor (a later generation) is not a reason to re-approve, but a binding of another actor, no binding
   * at all, or a session that is no longer live is refused.
   */
  private currentAuthority(
    grant: Pick<ManifestActivationGrant, "ceoActorId" | "ceoAssignmentId" | "ceoBindingGeneration">,
  ): Decision<void> {
    const ceo = this.liveCeo();
    const granted = {
      grantedActorId: grant.ceoActorId,
      grantedAssignmentId: grant.ceoAssignmentId,
      grantedGeneration: grant.ceoBindingGeneration,
    };
    if (!ceo) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "no live CEO binding holds the authority that confirmed", granted);
    }
    const live = { liveActorId: ceo.actorId, liveAssignmentId: ceo.assignmentId, liveGeneration: ceo.bindingGeneration };
    if (ceo.actorId !== grant.ceoActorId) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "the CEO role is now held by another actor than the one that confirmed", { ...granted, ...live });
    }
    if (
      ceo.bindingGeneration < grant.ceoBindingGeneration ||
      (ceo.bindingGeneration === grant.ceoBindingGeneration && ceo.assignmentId !== grant.ceoAssignmentId)
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "the live CEO binding is not the confirming one or its successor", { ...granted, ...live });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** The active CEO binding, its actor not retired and served by a READY session; null otherwise. */
  private liveCeo(): LiveCeo | null {
    const binding = this.bindings.active(roleKeyFor(Role.CEO));
    if (!binding) return null;
    const row = this.db.get<{ actor_id: string; retired_at: string | null; lifecycle: string | null }>(
      `SELECT a.actor_id, c.retired_at, s.lifecycle
         FROM assignments a
         JOIN conversational_actors c ON c.actor_id = a.actor_id
         LEFT JOIN sessions s ON s.session_id = c.current_session_id
        WHERE a.assignment_id = ? AND a.status = 'ACTIVE'`,
      [binding.assignmentId],
    );
    if (!row || row.retired_at !== null || row.lifecycle !== "READY") return null;
    return {
      assignmentId: binding.assignmentId,
      actorId: row.actor_id,
      sessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation,
      bindingGeneration: binding.bindingGeneration,
    };
  }

  private activeManifestDigest(projectId: string): string | null {
    return this.db.get<{ active_manifest_digest: string | null }>(
      `SELECT active_manifest_digest FROM projects WHERE project_id = ?`,
      [projectId],
    )?.active_manifest_digest ?? null;
  }
}

/**
 * #512 — the first-activation facts only the database holds, as they stand now: the project's active
 * manifest (E2), its one PROJECT_REGISTERED row with a JSON-null manifest and the bootstrap
 * applications naming it (E3), its REGISTERED repositories (E4) and the run's own (E5). Null for a run
 * that is not a NULL-pinned CONTRACT_CHANGE of a project. For a reader holding the database but not the
 * grant registry (plan_submit, the candidate freeze).
 */
export const firstActivationFactsOf = (
  db: Pick<Db, "get" | "all">,
  run: { runId: string; kind: string; projectId: string | null; pinnedManifestDigest: string | null },
): FirstActivationFacts | null => {
  if (!isFirstActivationRun(run) || run.projectId === null) return null;
  const projectId = run.projectId;
  const registrations = db.all<{ event_id: number; manifest_type: string | null }>(
    `SELECT event_id,
            CASE WHEN json_valid(evidence_json) THEN json_type(evidence_json, '$.activeManifestDigest') END AS manifest_type
       FROM audit_events
      WHERE kind = 'PROJECT_REGISTERED' AND project_id = ?
      ORDER BY event_id`,
    [projectId],
  );
  return {
    activeManifestDigest: db.get<{ active_manifest_digest: string | null }>(
      `SELECT active_manifest_digest FROM projects WHERE project_id = ?`,
      [projectId],
    )?.active_manifest_digest ?? null,
    registrationEventId: registrations.length === 1 && registrations[0]!.manifest_type === "null" ? registrations[0]!.event_id : null,
    bootstrapApplications: db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bootstrap_applications WHERE project_id = ?`,
      [projectId],
    )?.n ?? 0,
    registeredRepositories: db.all<{ role: string | null; identity: string }>(
      `SELECT repository_role AS role, identity FROM repositories
        WHERE project_id = ? AND registration = 'REGISTERED'
        ORDER BY identity`,
      [projectId],
    ),
    runRepositories: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_repositories WHERE run_id = ?`, [run.runId])?.n ?? 0,
  };
};

/**
 * CEO ruling 8 — a CONTRACT_CHANGE run this slice cannot finish is listed, never moved onto the new
 * path: one that reached a finalization state with no grant (confirmed before v44), or one whose latest
 * PLAN carries no manifest (submitted before B2-a). Its run and artifacts stay as they are.
 */
export interface ContractChangeRunWithoutGrant {
  runId: string;
  projectId: string | null;
  state: string;
  cause: "CONFIRMED_WITHOUT_GRANT" | "PLAN_CARRIES_NO_MANIFEST";
}

export const contractChangeRunsWithoutGrant = (db: Db, runId: string | null): ContractChangeRunWithoutGrant[] => {
  const rows = db.all<{ run_id: string; project_id: string | null; state: string; granted: number; plan_json: string | null }>(
    `SELECT r.run_id, r.project_id, r.state,
            (EXISTS (SELECT 1 FROM manifest_activation_grants g WHERE g.run_id = r.run_id)
             OR EXISTS (SELECT 1 FROM manifest_first_activation_grants f WHERE f.run_id = r.run_id)) AS granted,
            (SELECT a.content_json FROM run_artifacts a
              WHERE a.run_id = r.run_id AND a.kind = 'PLAN' AND a.superseded = 0
              ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS plan_json
       FROM runs r
      WHERE r.kind = 'CONTRACT_CHANGE'
        AND r.state NOT IN ('COMPLETED','CANCELLED','FAILED')
        ${runId ? "AND r.run_id = ?" : ""}
      ORDER BY r.created_at, r.run_id`,
    runId ? [runId] : [],
  );
  return rows.flatMap((row): ContractChangeRunWithoutGrant[] => {
    if (row.granted === 0 && ([...FINALIZING_STATES, RunState.BLOCKED_POST_MERGE] as string[]).includes(row.state)) {
      return [{ runId: row.run_id, projectId: row.project_id, state: row.state, cause: "CONFIRMED_WITHOUT_GRANT" }];
    }
    if (row.plan_json !== null) {
      let carries = false;
      try {
        const plan = JSON.parse(row.plan_json) as Record<string, unknown> | null;
        carries = typeof plan === "object" && plan !== null && plan["projectManifest"] !== undefined;
      } catch {
        carries = false;
      }
      if (!carries) {
        return [{ runId: row.run_id, projectId: row.project_id, state: row.state, cause: "PLAN_CARRIES_NO_MANIFEST" }];
      }
    }
    return [];
  });
};
