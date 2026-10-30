import type { Clock } from "../core/clock.ts";
import { isAcpError } from "../core/errors.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import { workflowDigestAtCommitLocal, type LocalWorkflowRead } from "../github/workflow-digest-at-commit.ts";
import type { WorkflowRevision } from "../registry/contract-change-plan.ts";
import type { RepositoryDriftCause, RepositoryInspection, RepositoryRegistry } from "../registry/repository-registry.ts";

/**
 * #1255 — what ACP itself reads, when a CONTRACT_CHANGE candidate is frozen, for that candidate's blind
 * review: the project's registration and active manifest, each of its repositories' registration, stored
 * observation and checkout as read then, and, for a first activation, each bound workflow revision read
 * at its exact commit the way the finalizer reads it locally. Stored as a HANDOFF artifact bound to the
 * candidate and to the freeze that read it (`freezeId`), so the review shows what held at that freeze
 * rather than at review time. The PLAN itself is not copied: the candidate names it by digest and its
 * artifact is immutable.
 */
export const CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA = "acp.contract-change-review-context.v1";

/**
 * #1255 G-6 — what a freeze stores in place of its readback when the artifact store refused the readback:
 * which freeze, and the refusal's reason code and field name, never the refused text. Every freeze leaves
 * exactly one row of these two schemas for its candidate, so the latest row is the latest freeze's.
 */
export const CONTRACT_CHANGE_REVIEW_CONTEXT_REFUSED_SCHEMA = "acp.contract-change-review-context-refused.v1";

/** The freeze a readback row belongs to: minted for each freeze, and the submission's attempt when there is one. */
interface FreezeIdentity {
  freezeId: string;
  attemptId: string | null;
}

export interface ContractChangeReviewContext extends FreezeIdentity {
  schema: typeof CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA;
  runId: string;
  candidateSnapshotDigest: string;
  planDigest: string;
  capturedAt: string;
  project: {
    projectId: string;
    activeManifestDigest: string | null;
    /** Every PROJECT_REGISTERED record of the project, as stored. */
    registrations: Array<{ eventId: number; at: string; name: string | null; activeManifestDigest: string | null }>;
    bootstrapApplications: number;
  };
  repositories: Array<{
    identity: string;
    role: string | null;
    registration: string;
    /** The REPOSITORY_REGISTERED records naming this identity in the project. */
    registeredEvents: Array<{ eventId: number; at: string }>;
    /** The registry's stored values, as stored at the freeze. */
    lastObservedHead: string | null;
    lastObservedAt: string | null;
    driftState: string;
    /**
     * The checkout as ACP read it at the freeze, with the drift ACP recomputed from that read
     * (`RepositoryRegistry.inspect`) and what it was decided on, labelled apart from the stored `driftState`.
     */
    checkout:
      | {
          status: "READ"; head: string | null; branch: string | null; clean: boolean;
          observedDriftState: RepositoryInspection["driftState"]; observedDriftCauses: RepositoryDriftCause[];
        }
      | { status: "UNREADABLE" };
  }>;
  /** A first activation's bound revisions with what the exact local read found; empty for any other change. */
  workflowRevisions: Array<WorkflowRevision & { read: LocalWorkflowRead | { status: "UNREADABLE" } }>;
}

export const captureContractChangeReviewContext = async (
  ports: {
    db: Pick<Db, "get" | "all">;
    repositories: Pick<RepositoryRegistry, "byIdentity" | "inspect">;
    clock: Clock;
  },
  input: FreezeIdentity & {
    runId: string;
    projectId: string;
    candidateSnapshotDigest: string;
    planDigest: string;
    workflowRevisions: readonly WorkflowRevision[];
  },
): Promise<ContractChangeReviewContext> => {
  const { db, repositories } = ports;
  const registrations = db.all<{ event_id: number; at: string; name: unknown; active: unknown }>(
    `SELECT event_id, at,
            CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json, '$.name') END AS name,
            CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json, '$.activeManifestDigest') END AS active
       FROM audit_events WHERE kind = 'PROJECT_REGISTERED' AND project_id = ? ORDER BY event_id`,
    [input.projectId],
  );
  const rows = db.all<{
    repository_id: string; identity: string; repository_role: string | null; registration: string;
    last_observed_head: string | null; last_observed_at: string | null; drift_state: string;
  }>(
    `SELECT repository_id, identity, repository_role, registration, last_observed_head, last_observed_at, drift_state
       FROM repositories WHERE project_id = ? AND retired_at IS NULL ORDER BY identity`,
    [input.projectId],
  );
  const repositoryFacts: ContractChangeReviewContext["repositories"] = [];
  for (const row of rows) {
    let checkout: ContractChangeReviewContext["repositories"][number]["checkout"] = { status: "UNREADABLE" };
    try {
      const inspected = await repositories.inspect(row.repository_id);
      if (inspected) {
        checkout = {
          status: "READ", head: inspected.observedHead, branch: inspected.branch, clean: inspected.clean,
          observedDriftState: inspected.driftState, observedDriftCauses: inspected.driftCauses,
        };
      }
    } catch {
      // Recorded as unreadable; the review says so.
    }
    repositoryFacts.push({
      identity: row.identity,
      role: row.repository_role,
      registration: row.registration,
      registeredEvents: db.all<{ event_id: number; at: string }>(
        `SELECT event_id, at FROM audit_events
          WHERE kind = 'REPOSITORY_REGISTERED' AND project_id = ?
            AND json_valid(evidence_json) AND json_extract(evidence_json, '$.identity') = ?
          ORDER BY event_id`,
        [input.projectId, row.identity],
      ).map((event) => ({ eventId: event.event_id, at: event.at })),
      lastObservedHead: row.last_observed_head,
      lastObservedAt: row.last_observed_at,
      driftState: row.drift_state,
      checkout,
    });
  }
  const workflowRevisions: ContractChangeReviewContext["workflowRevisions"] = [];
  for (const revision of input.workflowRevisions) {
    let read: ContractChangeReviewContext["workflowRevisions"][number]["read"];
    try {
      read = await workflowDigestAtCommitLocal(repositories, {
        repositoryIdentity: revision.repositoryIdentity,
        projectId: input.projectId,
        commitSha: revision.commitSha,
        path: revision.path,
      });
    } catch {
      read = { status: "UNREADABLE" };
    }
    workflowRevisions.push({ ...revision, read });
  }
  return {
    schema: CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA,
    runId: input.runId,
    candidateSnapshotDigest: input.candidateSnapshotDigest,
    planDigest: input.planDigest,
    capturedAt: ports.clock.nowIso(),
    freezeId: input.freezeId,
    attemptId: input.attemptId,
    project: {
      projectId: input.projectId,
      activeManifestDigest: db.get<{ active_manifest_digest: string | null }>(
        `SELECT active_manifest_digest FROM projects WHERE project_id = ?`, [input.projectId],
      )?.active_manifest_digest ?? null,
      registrations: registrations.map((row) => ({
        eventId: row.event_id,
        at: row.at,
        name: typeof row.name === "string" ? row.name : null,
        activeManifestDigest: typeof row.active === "string" ? row.active : null,
      })),
      bootstrapApplications: db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bootstrap_applications WHERE project_id = ?`, [input.projectId],
      )?.n ?? 0,
    },
    repositories: repositoryFacts,
    workflowRevisions,
  };
};

interface ContractChangeReviewContextRefusal extends FreezeIdentity {
  schema: typeof CONTRACT_CHANGE_REVIEW_CONTEXT_REFUSED_SCHEMA;
  runId: string;
  candidateSnapshotDigest: string;
  planDigest: string;
  capturedAt: string;
  refusal: { reasonCode: string; field: string | null };
}

/** What one freeze stored for its readback, as its CANDIDATE_FROZEN record names it. */
export type ReviewContextOutcome =
  | { freezeId: string; status: "STORED"; digest: string }
  | { freezeId: string; status: "REFUSED"; digest: string; reasonCode: string; field: string | null };

/** A refused field's name as the artifact store reports it: a key of the record, or its `<value>` marker. */
const REFUSED_FIELD_NAME = /^[A-Za-z0-9_<>.-]{1,64}$/;

/**
 * #1255 G-6 — stores this freeze's readback, or, when the artifact store refuses it (a credential-shaped
 * branch name read from the checkout), a refusal row for this freeze in its place. Either way this freeze
 * leaves the latest readback row for its candidate, so an earlier freeze's readback is never shown for it.
 * A refusal row that cannot be stored either fails the freeze.
 */
export const storeContractChangeReviewContext = (
  artifacts: Pick<ArtifactStore, "put">,
  context: ContractChangeReviewContext,
): ReviewContextOutcome => {
  try {
    const stored = artifacts.put(context.runId, ArtifactKind.HANDOFF, context, context.candidateSnapshotDigest);
    return { freezeId: context.freezeId, status: "STORED", digest: stored.digest };
  } catch (error) {
    if (!isAcpError(error)) throw error;
    const named = error.evidence["field"];
    const refusal = { reasonCode: error.reasonCode, field: typeof named === "string" && REFUSED_FIELD_NAME.test(named) ? named : null };
    const marker: ContractChangeReviewContextRefusal = {
      schema: CONTRACT_CHANGE_REVIEW_CONTEXT_REFUSED_SCHEMA,
      runId: context.runId,
      candidateSnapshotDigest: context.candidateSnapshotDigest,
      planDigest: context.planDigest,
      capturedAt: context.capturedAt,
      freezeId: context.freezeId,
      attemptId: context.attemptId,
      refusal,
    };
    const stored = artifacts.put(context.runId, ArtifactKind.HANDOFF, marker, context.candidateSnapshotDigest);
    return { freezeId: context.freezeId, status: "REFUSED", digest: stored.digest, ...refusal };
  }
};

/** The readback the review is shown for a candidate: its latest freeze's, or why there is none. */
export type ContractChangeReadback =
  | { status: "STORED"; context: ContractChangeReviewContext }
  | { status: "MISSING"; reason: string };

/**
 * #1255 G-6 — the readback of this candidate's latest freeze: the latest readback row stored for the
 * candidate, by insertion order. When that freeze's readback was refused, it is missing, with the refusal's
 * reason; an earlier freeze's readback is never shown in its place.
 */
export const contractChangeReadbackFor = (
  db: Pick<Db, "get">,
  runId: string,
  candidateSnapshotDigest: string,
): ContractChangeReadback => {
  const row = db.get<{ content_json: string }>(
    `SELECT content_json FROM run_artifacts
      WHERE run_id = ? AND kind = ? AND candidate_snapshot_digest = ? AND superseded = 0
        AND json_valid(content_json) AND json_extract(content_json, '$.schema') IN (?, ?)
      ORDER BY rowid DESC LIMIT 1`,
    [runId, ArtifactKind.HANDOFF, candidateSnapshotDigest, CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA, CONTRACT_CHANGE_REVIEW_CONTEXT_REFUSED_SCHEMA],
  );
  if (row === undefined) return { status: "MISSING", reason: "no freeze of it stored one" };
  const content = JSON.parse(row.content_json) as ContractChangeReviewContext | ContractChangeReviewContextRefusal;
  if (content.runId !== runId || content.candidateSnapshotDigest !== candidateSnapshotDigest) {
    return { status: "MISSING", reason: "the latest readback row stored for it names another run or candidate" };
  }
  if (content.schema === CONTRACT_CHANGE_REVIEW_CONTEXT_REFUSED_SCHEMA) {
    const field = content.refusal.field === null ? "" : `, field ${content.refusal.field}`;
    return {
      status: "MISSING",
      reason: `the readback ACP read at its latest freeze (${content.freezeId}, ${content.capturedAt}) was refused at storage (${content.refusal.reasonCode}${field}); no earlier freeze's readback is shown in its place`,
    };
  }
  return { status: "STORED", context: content };
};
