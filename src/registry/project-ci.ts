import { projectManifestSchema } from "../contracts/manifest.ts";
import type { Db } from "../db/database.ts";
import type { ProjectRegistry } from "./project-registry.ts";

/**
 * #1257 — the CI section of a project read: what CI the active manifest declares and what ACP has
 * recorded about those checks. Nothing here is asserted by anyone; every value is read from the
 * active manifest, the repository registry, or a post-merge verification receipt.
 *
 * Kept apart from availability on purpose. `HEALTHY` says the project's runtime is serviceable and
 * says nothing about CI, so neither is computed from the other.
 */
export type ProjectCiUndeclaredReason = "NO_ACTIVE_MANIFEST" | "NO_CI_WORKFLOWS" | "ACTIVE_MANIFEST_UNREADABLE";

/**
 * OLDER_COMMIT: the observation is for a commit other than the repository's recorded head.
 * DIGEST_MISMATCH: the observing run's pinned manifest approved a different digest (or none).
 * PATH_MISMATCH: the observing run approved this check name at a different workflow path (or none).
 * HEAD_UNOBSERVED: ACP has recorded no head for the repository, so no commit can be shown current.
 */
export type ProjectCiStaleReason = "OLDER_COMMIT" | "DIGEST_MISMATCH" | "PATH_MISMATCH" | "HEAD_UNOBSERVED";

export interface ProjectCiObservation {
  /** PASS only for a recorded `success`; any other recorded conclusion fails, as post-merge verification judges it. */
  result: "PASS" | "FAIL";
  conclusion: string | null;
  commitSha: string | null;
  observedAt: string;
  source: { kind: "POST_MERGE_VERIFY_RECEIPT"; receiptId: string; runId: string | null };
  /** The digest the observing run's pinned manifest approved for this check; null when it approved none. */
  approvedDigestAtObservation: string | null;
  /** The workflow path the observing run pinned for this check; null when it cannot be bound uniquely. */
  workflowPathAtObservation: string | null;
  freshness: "current" | "stale";
  staleReasons: ProjectCiStaleReason[];
}

export interface ProjectCiWorkflow {
  path: string;
  checkName: string;
  repositoryRole: string;
  approvedDigest: string | null;
  repositoryIdentity: string | null;
  /** The repository's accepted default-branch head as the registry last recorded it. */
  repositoryHead: { commitSha: string; observedAt: string | null } | null;
  lastObserved: ProjectCiObservation | null;
  unobserved: boolean;
  unobservedReason: "NO_REPOSITORY_FOR_ROLE" | "NO_RECORDED_OBSERVATION" | null;
}

export type ProjectCi =
  | { declared: false; reason: ProjectCiUndeclaredReason; manifestDigest: string | null }
  | { declared: true; manifestDigest: string; workflows: ProjectCiWorkflow[] };

interface ReceiptCheckRow {
  receipt_id: string;
  run_id: string | null;
  resource_identity: string;
  created_at: string;
  conclusion: unknown;
}

export const projectCi = (
  db: Db,
  projects: Pick<ProjectRegistry, "get" | "manifest">,
  projectId: string,
): ProjectCi => {
  const digest = projects.get(projectId)?.activeManifestDigest ?? null;
  if (digest === null) return { declared: false, reason: "NO_ACTIVE_MANIFEST", manifestDigest: null };
  const manifest = projectManifestSchema.safeParse(projects.manifest(digest));
  if (!manifest.success) return { declared: false, reason: "ACTIVE_MANIFEST_UNREADABLE", manifestDigest: digest };
  if (manifest.data.ciWorkflows.length === 0) return { declared: false, reason: "NO_CI_WORKFLOWS", manifestDigest: digest };

  const workflows = manifest.data.ciWorkflows.map((workflow): ProjectCiWorkflow => {
    const declared = {
      path: workflow.path,
      checkName: workflow.checkName,
      repositoryRole: workflow.repositoryRole,
      approvedDigest: workflow.approvedDigest,
    };
    const repository = db.get<{ identity: string; last_observed_head: string | null; last_observed_at: string | null }>(
      `SELECT identity, last_observed_head, last_observed_at FROM repositories
        WHERE project_id = ? AND repository_role = ? AND retired_at IS NULL AND registration = 'REGISTERED'
        ORDER BY created_at, repository_id LIMIT 1`,
      [projectId, workflow.repositoryRole],
    );
    if (!repository) {
      return { ...declared, repositoryIdentity: null, repositoryHead: null, lastObserved: null,
        unobserved: true, unobservedReason: "NO_REPOSITORY_FOR_ROLE" };
    }
    const repositoryHead = repository.last_observed_head === null
      ? null
      : { commitSha: repository.last_observed_head, observedAt: repository.last_observed_at };
    // The latest receipt naming this check. CASE keeps a malformed entry from failing the read.
    const row = db.get<ReceiptCheckRow>(
      `SELECT g.receipt_id, g.run_id, g.resource_identity, g.created_at,
              CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.conclusion') END AS conclusion
         FROM github_receipts g,
              json_each(CASE WHEN json_valid(g.response_json) THEN g.response_json ELSE '{}' END, '$.checks') c
        WHERE g.operation = 'post_merge_verify' AND g.status = 'APPLIED' AND g.verified = 1
          AND g.repository_identity = ?
          AND (CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.name') END) = ?
        ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1`,
      [repository.identity, workflow.checkName],
    );
    if (!row) {
      return { ...declared, repositoryIdentity: repository.identity, repositoryHead, lastObserved: null,
        unobserved: true, unobservedReason: "NO_RECORDED_OBSERVATION" };
    }
    const at = row.resource_identity.lastIndexOf("@");
    const commitSha = at >= 0 ? row.resource_identity.slice(at + 1) : null;
    const conclusion = typeof row.conclusion === "string" ? row.conclusion : null;
    const approvedWorkflowAtObservation = row.run_id === null
      ? null
      : pinnedApprovedWorkflow(db, projects, row.run_id, repository.identity, workflow.checkName);
    const approvedDigestAtObservation = approvedWorkflowAtObservation?.approvedDigest ?? null;
    const workflowPathAtObservation = approvedWorkflowAtObservation?.path ?? null;
    const staleReasons: ProjectCiStaleReason[] = [];
    if (repositoryHead === null) staleReasons.push("HEAD_UNOBSERVED");
    else if (commitSha !== repositoryHead.commitSha) staleReasons.push("OLDER_COMMIT");
    if (workflow.approvedDigest === null || approvedDigestAtObservation !== workflow.approvedDigest) {
      staleReasons.push("DIGEST_MISMATCH");
    }
    if (workflowPathAtObservation !== workflow.path) staleReasons.push("PATH_MISMATCH");
    return {
      ...declared,
      repositoryIdentity: repository.identity,
      repositoryHead,
      lastObserved: {
        result: conclusion === "success" ? "PASS" : "FAIL",
        conclusion,
        commitSha,
        observedAt: row.created_at,
        source: { kind: "POST_MERGE_VERIFY_RECEIPT", receiptId: row.receipt_id, runId: row.run_id },
        approvedDigestAtObservation,
        workflowPathAtObservation,
        freshness: staleReasons.length === 0 ? "current" : "stale",
        staleReasons,
      },
      unobserved: false,
      unobservedReason: null,
    };
  });
  return { declared: true, manifestDigest: digest, workflows };
};

/**
 * The workflow entry the observing run's pinned manifest approved for this check, matched on the
 * role the repository held in that run — the same entry post-merge verification compared against.
 */
const pinnedApprovedWorkflow = (
  db: Db,
  projects: Pick<ProjectRegistry, "manifest">,
  runId: string,
  repositoryIdentity: string,
  checkName: string,
): { path: string; approvedDigest: string | null } | null => {
  const pinned = db.get<{ pinned_manifest_digest: string | null }>(
    `SELECT pinned_manifest_digest FROM runs WHERE run_id = ?`,
    [runId],
  )?.pinned_manifest_digest ?? null;
  const role = db.get<{ repository_role: string }>(
    `SELECT rr.repository_role FROM run_repositories rr
       JOIN repositories r ON r.repository_id = rr.repository_id
      WHERE rr.run_id = ? AND r.identity = ?`,
    [runId, repositoryIdentity],
  )?.repository_role ?? null;
  if (pinned === null || role === null) return null;
  const manifest = projectManifestSchema.safeParse(projects.manifest(pinned));
  if (!manifest.success) return null;
  const matches = manifest.data.ciWorkflows.filter(
    (entry) => entry.checkName === checkName && entry.repositoryRole === role,
  );
  if (matches.length !== 1) return null;
  const workflow = matches[0]!;
  return { path: workflow.path, approvedDigest: workflow.approvedDigest };
};
