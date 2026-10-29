import type { Clock } from "../core/clock.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import { workflowDigestAtCommitLocal, type LocalWorkflowRead } from "../github/workflow-digest-at-commit.ts";
import type { WorkflowRevision } from "../registry/contract-change-plan.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";

/**
 * #1255 — what ACP itself reads, when a CONTRACT_CHANGE candidate is frozen, for that candidate's blind
 * review: the project's registration and active manifest, each of its repositories' registration, stored
 * observation and checkout as read then, and, for a first activation, each bound workflow revision read
 * at its exact commit the way the finalizer reads it locally. Stored as a HANDOFF artifact bound to the
 * candidate, so the review shows what held at the freeze rather than at review time. The PLAN itself is
 * not copied: the candidate names it by digest and its artifact is immutable.
 */
export const CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA = "acp.contract-change-review-context.v1";

export interface ContractChangeReviewContext {
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
    lastObservedHead: string | null;
    lastObservedAt: string | null;
    driftState: string;
    checkout: { status: "READ"; head: string | null; branch: string | null; clean: boolean } | { status: "UNREADABLE" };
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
  input: {
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
      if (inspected) checkout = { status: "READ", head: inspected.observedHead, branch: inspected.branch, clean: inspected.clean };
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

/** The readback captured for exactly this candidate, or null when none was. */
export const storedContractChangeReviewContext = (
  artifacts: Pick<ArtifactStore, "list">,
  runId: string,
  candidateSnapshotDigest: string,
): ContractChangeReviewContext | null =>
  artifacts.list<ContractChangeReviewContext>(runId, ArtifactKind.HANDOFF)
    .filter((artifact) =>
      !artifact.superseded &&
      artifact.candidateSnapshotDigest === candidateSnapshotDigest &&
      artifact.content?.schema === CONTRACT_CHANGE_REVIEW_CONTEXT_SCHEMA &&
      artifact.content.runId === runId &&
      artifact.content.candidateSnapshotDigest === candidateSnapshotDigest)
    .at(-1)?.content ?? null;
