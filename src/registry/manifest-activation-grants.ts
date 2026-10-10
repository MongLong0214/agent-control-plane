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
import {
  type ContractChangeWorkflowEvidence,
  currentContractChangePlan,
  sameContractChangeBinding,
  storedManifest,
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

/** Where `verify` is asked: before the first GitHub write, or in the activation transaction itself. */
export type ManifestGrantPhase = "PRE_MERGE" | "ACTIVATION";

const PHASE_STATES: Readonly<Record<ManifestGrantPhase, readonly RunState[]>> = {
  PRE_MERGE: [RunState.CEO_APPROVED, RunState.MERGING, RunState.POST_MERGE_VERIFYING],
  ACTIVATION: [RunState.POST_MERGE_VERIFYING],
};

/** The states a confirmed CONTRACT_CHANGE finalizes through; a second one may not be confirmed beside it. */
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
}

/** What a verified grant activates: the manifest its PLAN carries and the workflows that manifest names. */
export interface ManifestActivationTarget {
  grant: ManifestActivationGrant;
  manifest: ProjectManifest;
  workflowEvidence: ContractChangeWorkflowEvidence[];
}

/**
 * What the finalizer established about one workflow the manifest points to, before the activation
 * transaction and outside it (CEO ruling 6). `READ`: the file's exact bytes at `revision` of the exact
 * repository hash to `approvedDigest`. `REUSED`: the base manifest declares this exact entry, so the
 * exact-byte approval the base already carries stands, and nothing is read again.
 */
export interface ActivatedWorkflowEvidence {
  repositoryRole: string;
  repositoryIdentity: string | null;
  path: string;
  checkName: string;
  approvedDigest: string | null;
  evidence: "READ" | "REUSED";
  revision: string | null;
  observedDigest: string | null;
}

/**
 * Whether `supplied` compares exactly the workflows `expected` names, one each: a changed or new
 * workflow was read and matched, an unchanged one was reused, and nothing is missing or extra.
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
      entry.approvedDigest === workflow.approvedDigest &&
      (workflow.unchangedFromBase
        ? entry.evidence === "REUSED"
        : entry.evidence === "READ" &&
          workflow.approvedDigest !== null &&
          entry.observedDigest === workflow.approvedDigest &&
          entry.repositoryIdentity === workflow.repositoryRemote &&
          typeof entry.revision === "string" && entry.revision.length > 0));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
};

/**
 * The CEO call's transport identity, as the MCP door that admitted it authenticated it: never a tool
 * argument. Absent for an in-process caller.
 */
export interface CeoDecisionIngress {
  sessionId: string | null;
  sessionIncarnation: string | null;
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
});

/** The digest a grant's identity columns recompute to; a row whose columns moved no longer matches it. */
const grantDigestOf = (grant: Omit<ManifestActivationGrant, "grantDigest" | "consumedAt" | "consumedAttemptId">): string =>
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

  /**
   * The read-only half of a CONTRACT_CHANGE CONFIRM's admission, asked before the decision changes
   * anything: the base is still the active manifest (CEO ruling 1), no other CONTRACT_CHANGE of the
   * project is confirmed and finalizing, and the candidate is still the one its PLAN and its packet bind.
   */
  admitConfirm(runId: string, candidateSnapshotDigest: string): Decision<{ planDigest: string; manifestDigest: string; fromManifestDigest: string; packetDigest: string }> {
    const run = this.runs.get(runId);
    if (!run || run.kind !== RunKind.CONTRACT_CHANGE || !run.projectId) {
      return deny(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN, "a manifest activation grant is issued only for a CONTRACT_CHANGE run of a project", {
        runId,
        kind: run?.kind ?? null,
        projectId: run?.projectId ?? null,
      });
    }
    const pinned = this.pinStillActive(run);
    if (!pinned.allowed) return pinned as Decision<never>;
    const overlap = this.finalizingContractChanges(run.projectId, runId);
    if (overlap.length > 0) {
      return deny(ReasonCode.CONTRACT_CHANGE_FINALIZATION_OVERLAP, "another CONTRACT_CHANGE of this project is confirmed and finalizing", {
        runId,
        projectId: run.projectId,
        finalizing: overlap,
      });
    }
    return this.boundTarget(run, candidateSnapshotDigest);
  }

  /**
   * The project's other CONTRACT_CHANGE runs already confirmed and finalizing. Two grants on one base
   * would race to the same compare-and-set; refusing the second CONFIRM keeps that race from reaching a
   * merge, and the compare-and-set at activation still decides it if it ever does.
   */
  finalizingContractChanges(projectId: string, exceptRunId: string): Array<{ runId: string; state: string }> {
    return this.db.all<{ run_id: string; state: string }>(
      `SELECT run_id, state FROM runs
        WHERE project_id = ? AND kind = 'CONTRACT_CHANGE' AND run_id <> ?
          AND state IN (${FINALIZING_STATES.map(() => "?").join(",")})
        ORDER BY run_id`,
      [projectId, exceptRunId, ...FINALIZING_STATES],
    ).map((row) => ({ runId: row.run_id, state: row.state }));
  }

  /**
   * Issues the run's one grant. Called only by the production gate, inside the CONFIRM transaction,
   * after the run moved to CEO_APPROVED, so a refusal here undoes the decision. The CEO authority it
   * records is the live binding's, and when the call came through an MCP door, the session that door
   * authenticated must be that binding's session and incarnation as well as the one the call names.
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

    const ceo = this.liveCeo();
    if (!ceo || ceo.sessionId !== input.ceoSessionId) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "the confirming session is not the live CEO binding", {
        runId: input.runId,
        ceoSessionId: input.ceoSessionId,
        liveCeoSessionId: ceo?.sessionId ?? null,
      });
    }
    if (input.ingress !== undefined) {
      const ingress = input.ingress;
      if (ingress.sessionId !== input.ceoSessionId || ingress.sessionIncarnation !== ceo.sessionIncarnation) {
        return deny(ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, "the authenticated caller is not the CEO session the decision names", {
          runId: input.runId,
          ceoSessionId: input.ceoSessionId,
          authenticatedSessionId: ingress.sessionId,
          authenticatedIncarnationMatches: ingress.sessionIncarnation === ceo.sessionIncarnation,
        });
      }
    }

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
    const grant: ManifestActivationGrant = { ...identity, grantDigest: grantDigestOf(identity), consumedAt: null, consumedAttemptId: null };
    this.db.run(
      `INSERT INTO manifest_activation_grants
         (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
          candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
          ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest)
       VALUES (?, ?, ?, 'CONTRACT_CHANGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.grantId, grant.runId, grant.projectId, grant.manifestDigest, grant.fromManifestDigest,
        grant.planDigest, grant.candidateSnapshotDigest, grant.packetDigest, grant.ceoAssignmentId,
        grant.ceoActorId, grant.ceoSessionId, grant.ceoSessionIncarnation, grant.ceoBindingGeneration,
        grant.issuedAt, grant.grantDigest,
      ],
    );
    return allow(ReasonCode.OK, grant);
  }

  /**
   * Every fact the run's grant names, re-derived: the grant is the run's and unaltered, the run is the
   * CONTRACT_CHANGE it was issued for, on the same candidate, in a state this phase admits; the
   * candidate still binds the PLAN, its manifest and its base; the packet still exists; the project's
   * active manifest is still the base (compare-and-set); and the CEO authority that confirmed still
   * holds the role (CEO ruling 2). Unconsumed, always: a consumed grant activates nothing again.
   */
  verify(runId: string, phase: ManifestGrantPhase): Decision<ManifestActivationTarget> {
    const grant = this.get(runId);
    if (!grant) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "this CONTRACT_CHANGE run holds no activation grant from a CEO CONFIRM", { runId, phase });
    }
    const evidence = { runId, phase, grantId: grant.grantId };
    const { grantDigest, consumedAt: _consumedAt, consumedAttemptId: _consumedAttemptId, ...identity } = grant;
    if (grantDigestOf(identity) !== grantDigest) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the grant's columns no longer recompute to its digest", evidence);
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

    const manifest = this.currentPlan(run);
    if (!manifest.allowed) return manifest as Decision<ManifestActivationTarget>;
    return allow(ReasonCode.OK, { grant, manifest: manifest.value.manifest, workflowEvidence: manifest.value.workflowEvidence });
  }

  /**
   * Consumes the run's grant for one finalization attempt. Called only by the activation transaction,
   * after `verify(runId, "ACTIVATION")` in that same transaction; the attempt must be the run's RUNNING
   * finalization attempt for the confirmed candidate, so the consumption names who executed it.
   */
  consume(runId: string, attemptId: string): Decision<ManifestActivationGrant> {
    const grant = this.get(runId);
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
      `UPDATE manifest_activation_grants SET consumed_at = ?, consumed_attempt_id = ?
        WHERE run_id = ? AND consumed_at IS NULL`,
      [consumedAt, attemptId, runId],
    ).changes;
    if (changed !== 1) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED, "this grant has already been consumed", { runId, attemptId });
    }
    return allow(ReasonCode.OK, { ...grant, consumedAt, consumedAttemptId: attemptId });
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
    const binding = snapshot?.content.contractChange;
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
      !sameContractChangeBinding(review.content.contractChange, binding)
    ) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_TARGET_STALE, "the candidate's review did not pass this exact contract change", {
        ...evidence,
        packetDigest: packet.digest,
        reviewDigest: review?.digest ?? null,
      });
    }
    return allow(ReasonCode.OK, {
      planDigest: binding.planDigest,
      manifestDigest: binding.manifestDigest,
      fromManifestDigest: binding.baseManifestDigest,
      packetDigest: packet.digest,
    });
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
  private currentAuthority(grant: ManifestActivationGrant): Decision<void> {
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
            EXISTS (SELECT 1 FROM manifest_activation_grants g WHERE g.run_id = r.run_id) AS granted,
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
