import { projectManifestSchema } from "../contracts/manifest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { CI_FAILED_CONCLUSIONS, ciVerificationRecords, type CiVerificationRecord } from "../verify/ci-verification-records.ts";
import type { ProjectRegistry } from "./project-registry.ts";

/**
 * #1257 — the CI section of a project read: what CI the active manifest declares and what ACP has
 * recorded about those checks. Nothing here is asserted by anyone; every value is read from the
 * active manifest, the repository registry, a post-merge verification receipt, or a trusted-CI
 * verification result.
 *
 * Kept apart from availability on purpose. `HEALTHY` says the project's runtime is serviceable and
 * says nothing about CI, so neither is computed from the other.
 */
export type ProjectCiUndeclaredReason = "NO_ACTIVE_MANIFEST" | "NO_CI_WORKFLOWS" | "ACTIVE_MANIFEST_UNREADABLE";

/**
 * OLDER_COMMIT: the observation is for a commit other than the repository's recorded head.
 * HEAD_UNOBSERVED: ACP has recorded no head for the repository, so no commit can be shown current.
 * DIGEST_MISMATCH: the observing run's pinned manifest approved a different digest (or none).
 * DIGEST_UNVERIFIED: the record keeps no workflow digest, so the digest cannot be shown current.
 */
export type ProjectCiStaleReason = "OLDER_COMMIT" | "HEAD_UNOBSERVED" | "DIGEST_MISMATCH" | "DIGEST_UNVERIFIED";

/**
 * Why the newest record for a workflow holds no PASS or FAIL.
 * PENDING: the check had not finished when it was observed.
 * NOT_A_RESULT: the record holds no pass or fail — a missing check, `neutral`, `skipped`, a refused
 * provenance, a conclusion not listed below, or a verification ERROR, TIMEOUT or SKIPPED.
 * CONCLUSION_UNRECORDED: a trusted-CI verification FAIL whose reason code says neither "finished
 * failing" nor "not finished": every such row written before those codes existed, and a `neutral`,
 * `skipped` or unlisted conclusion.
 * PROVENANCE_UNRECORDED: a post-merge receipt's failing conclusion. Post-merge verification records a
 * failing check by name before, and without, proving which workflow or app produced it, so the
 * receipt cannot say that the approved workflow failed.
 */
export type ProjectCiNoResultReason = "PENDING" | "NOT_A_RESULT" | "CONCLUSION_UNRECORDED" | "PROVENANCE_UNRECORDED";

export type ProjectCiSource =
  | { kind: "POST_MERGE_VERIFY_RECEIPT"; receiptId: string; runId: string }
  | {
    kind: "CI_VERIFICATION_RESULT";
    resultId: string;
    runId: string;
    status: CiVerificationRecord["status"];
    reasonCode: string | null;
  };

interface ProjectCiRecord {
  /** The check's conclusion as a post-merge receipt recorded it; null for a verification result, which keeps none. */
  conclusion: string | null;
  commitSha: string | null;
  observedAt: string;
  source: ProjectCiSource;
}

export interface ProjectCiObservation extends ProjectCiRecord {
  /**
   * PASS only for a recorded success whose provenance was proven before it was recorded. FAIL only
   * for a trusted-CI result recorded as a finished, failing check (VERIFICATION_CI_CHECK_FAILED).
   */
  result: "PASS" | "FAIL";
  /** The digest the observing run's pinned manifest approved; null when it approved none or the record cannot say. */
  approvedDigestAtObservation: string | null;
  freshness: "current" | "stale";
  staleReasons: ProjectCiStaleReason[];
}

export interface ProjectCiNonResult extends ProjectCiRecord {
  reason: ProjectCiNoResultReason;
}

export interface ProjectCiWorkflow {
  path: string;
  checkName: string;
  repositoryRole: string;
  approvedDigest: string | null;
  repositoryIdentity: string | null;
  /** The repository's accepted default-branch head as the registry last recorded it. */
  repositoryHead: { commitSha: string; observedAt: string | null } | null;
  /** The newest recorded PASS or FAIL for this workflow. */
  lastObserved: ProjectCiObservation | null;
  /** The newest record when it holds no result: newer than `lastObserved`, or the only kind there is. */
  latestNonResult: ProjectCiNonResult | null;
  unobserved: boolean;
  unobservedReason: "NO_REPOSITORY_FOR_ROLE" | "NO_RECORDED_OBSERVATION" | ProjectCiNoResultReason | null;
}

export type ProjectCi =
  | { declared: false; reason: ProjectCiUndeclaredReason; manifestDigest: string | null }
  | { declared: true; manifestDigest: string; workflows: ProjectCiWorkflow[] };

type Projects = Pick<ProjectRegistry, "get" | "manifest">;

/** The declared workflow a record is evidence for, as its run's pinned manifest named it. */
interface AttributedWorkflow { path: string; repositoryRole: string; approvedDigest: string | null }

interface CandidateRecord extends ProjectCiRecord {
  outcome: "PASS" | "FAIL" | ProjectCiNoResultReason;
  rowOrder: number;
}

const PENDING_CONCLUSIONS = new Set(["pending", "in_progress", "queued", "requested", "waiting"]);

/**
 * A post-merge conclusion mapped explicitly. Only `success` passes: post-merge records it only after
 * proving the approved workflow produced the check. A finished, failing conclusion is recorded with
 * no such proof (github-kernel `observePostMergeChecks`), so it is never a FAIL for a workflow. An
 * unfinished check (`incomplete:<status>` as post-merge records it) is pending; everything else —
 * `missing`, `neutral`, `skipped`, `ambiguous`, `untrusted`, `unapproved`, or a value not listed
 * here — is not a result.
 */
const receiptOutcome = (conclusion: string | null): CandidateRecord["outcome"] => {
  if (conclusion === "success") return "PASS";
  if (conclusion === null) return "NOT_A_RESULT";
  if (CI_FAILED_CONCLUSIONS.has(conclusion)) return "PROVENANCE_UNRECORDED";
  if (conclusion.startsWith("incomplete:") || PENDING_CONCLUSIONS.has(conclusion)) return "PENDING";
  return "NOT_A_RESULT";
};

/**
 * A trusted-CI verification row mapped. `collectCi` writes a row PASS or FAIL only after the check
 * passed its trust checks, PASS only for `success`, and keeps in a FAIL row's reason code whether the
 * check finished failing or had not finished. A FAIL row with neither code is no result.
 */
const verificationOutcome = (
  status: CiVerificationRecord["status"],
  reasonCode: string | null,
): CandidateRecord["outcome"] => {
  if (status === "PASS") return "PASS";
  if (status !== "FAIL") return "NOT_A_RESULT";
  if (reasonCode === ReasonCode.VERIFICATION_CI_CHECK_FAILED) return "FAIL";
  if (reasonCode === ReasonCode.VERIFICATION_CI_CHECK_PENDING) return "PENDING";
  return "CONCLUSION_UNRECORDED";
};

export const projectCi = (db: Db, projects: Projects, projectId: string): ProjectCi => {
  const digest = projects.get(projectId)?.activeManifestDigest ?? null;
  if (digest === null) return { declared: false, reason: "NO_ACTIVE_MANIFEST", manifestDigest: null };
  const manifest = projectManifestSchema.safeParse(projects.manifest(digest));
  if (!manifest.success) return { declared: false, reason: "ACTIVE_MANIFEST_UNREADABLE", manifestDigest: digest };
  if (manifest.data.ciWorkflows.length === 0) return { declared: false, reason: "NO_CI_WORKFLOWS", manifestDigest: digest };

  const attribution = new Map<string, AttributedWorkflow | null>();
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
      return { ...declared, repositoryIdentity: null, repositoryHead: null, lastObserved: null, latestNonResult: null,
        unobserved: true, unobservedReason: "NO_REPOSITORY_FOR_ROLE" };
    }
    const identity = repository.identity;
    const repositoryHead = repository.last_observed_head === null
      ? null
      : { commitSha: repository.last_observed_head, observedAt: repository.last_observed_at };

    // A workflow is its path, check name and role together. A record names only a check, so it is
    // evidence for the one entry its run's pinned manifest declares for that check on the role the
    // repository held in that run, and for no other workflow sharing the name. The pin says which
    // workflow was approved, not which one produced the check: only a record whose producer proved
    // that before writing it can be a result (see receiptOutcome and verificationOutcome).
    const attributed = (runId: string): AttributedWorkflow | null => {
      const key = `${runId}\n${identity}\n${workflow.checkName}`;
      if (!attribution.has(key)) attribution.set(key, attributedWorkflow(db, projects, runId, identity, workflow.checkName));
      return attribution.get(key)!;
    };
    const records = [...postMergeRecords(db, identity, workflow.checkName), ...verificationRecords(db, identity, workflow.checkName)]
      .sort(newestFirst);

    // Newest first: the first result ends the walk, and the newest non-result before it is kept.
    let result: { record: CandidateRecord; entry: AttributedWorkflow } | null = null;
    let latestNonResult: ProjectCiNonResult | null = null;
    for (const record of records) {
      const entry = attributed(record.source.runId);
      if (entry === null || entry.path !== workflow.path || entry.repositoryRole !== workflow.repositoryRole) continue;
      if (record.outcome === "PASS" || record.outcome === "FAIL") {
        result = { record, entry };
        break;
      }
      latestNonResult ??= { ...recordOf(record), reason: record.outcome };
    }
    if (result === null) {
      return { ...declared, repositoryIdentity: identity, repositoryHead, lastObserved: null, latestNonResult,
        unobserved: true, unobservedReason: latestNonResult?.reason ?? "NO_RECORDED_OBSERVATION" };
    }

    const { record, entry } = result;
    const verification = record.source.kind === "CI_VERIFICATION_RESULT";
    const approvedDigestAtObservation = verification ? null : entry.approvedDigest;
    const staleReasons: ProjectCiStaleReason[] = [];
    if (repositoryHead === null) staleReasons.push("HEAD_UNOBSERVED");
    else if (record.commitSha !== repositoryHead.commitSha) staleReasons.push("OLDER_COMMIT");
    if (verification) staleReasons.push("DIGEST_UNVERIFIED");
    else if (workflow.approvedDigest === null || approvedDigestAtObservation !== workflow.approvedDigest) {
      staleReasons.push("DIGEST_MISMATCH");
    }
    return {
      ...declared,
      repositoryIdentity: identity,
      repositoryHead,
      lastObserved: {
        ...recordOf(record),
        result: record.outcome as "PASS" | "FAIL",
        approvedDigestAtObservation,
        freshness: staleReasons.length === 0 ? "current" : "stale",
        staleReasons,
      },
      latestNonResult,
      unobserved: false,
      unobservedReason: null,
    };
  });
  return { declared: true, manifestDigest: digest, workflows };
};

const recordOf = (record: CandidateRecord): ProjectCiRecord => ({
  conclusion: record.conclusion,
  commitSha: record.commitSha,
  observedAt: record.observedAt,
  source: record.source,
});

const instant = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** A post-merge receipt follows the candidate verification of the same change, so it wins a tie. */
const SOURCE_RANK = { POST_MERGE_VERIFY_RECEIPT: 1, CI_VERIFICATION_RESULT: 0 } as const;

/** Newest first; ties broken by source (post-merge first), then by insertion order within a source. */
const newestFirst = (a: CandidateRecord, b: CandidateRecord): number =>
  instant(b.observedAt) - instant(a.observedAt) ||
  SOURCE_RANK[b.source.kind] - SOURCE_RANK[a.source.kind] ||
  b.rowOrder - a.rowOrder;

/**
 * Every verified post-merge receipt naming this check that names its run; a receipt without a run
 * has no pinned manifest to attribute it by. CASE keeps a malformed entry from failing the read.
 */
const postMergeRecords = (db: Db, identity: string, checkName: string): CandidateRecord[] =>
  db.all<{ receipt_id: string; run_id: string; resource_identity: string; created_at: string;
    conclusion: unknown; row_order: number }>(
    `SELECT g.receipt_id, g.run_id, g.resource_identity, g.created_at, g.rowid AS row_order,
            CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.conclusion') END AS conclusion
       FROM github_receipts g,
            json_each(CASE WHEN json_valid(g.response_json) THEN g.response_json ELSE '{}' END, '$.checks') c
      WHERE g.operation = 'post_merge_verify' AND g.status = 'APPLIED' AND g.verified = 1
        AND g.repository_identity = ? AND g.run_id IS NOT NULL
        AND (CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.name') END) = ?
      ORDER BY g.created_at DESC, g.rowid DESC`,
    [identity, checkName],
  ).map((row) => {
    const at = row.resource_identity.lastIndexOf("@");
    const conclusion = typeof row.conclusion === "string" ? row.conclusion : null;
    return {
      conclusion,
      commitSha: at >= 0 ? row.resource_identity.slice(at + 1) : null,
      observedAt: row.created_at,
      source: { kind: "POST_MERGE_VERIFY_RECEIPT" as const, receiptId: row.receipt_id, runId: row.run_id },
      outcome: receiptOutcome(conclusion),
      rowOrder: row.row_order,
    };
  });

/** Trusted-CI verification results for this check, read through the one helper that reads them. */
const verificationRecords = (db: Db, identity: string, checkName: string): CandidateRecord[] =>
  ciVerificationRecords(db, identity, checkName).map((row) => ({
    conclusion: null,
    commitSha: row.exactHead,
    observedAt: row.endedAt,
    source: {
      kind: "CI_VERIFICATION_RESULT" as const,
      resultId: row.resultId,
      runId: row.runId,
      status: row.status,
      reasonCode: row.reasonCode,
    },
    outcome: verificationOutcome(row.status, row.reasonCode),
    rowOrder: row.rowOrder,
  }));

/**
 * The entry the run's pinned manifest declares for this check on the role the repository held in
 * that run. Null when the run, its pin or its role cannot be read, or when the pin declares the
 * check on that role more than once: a record names a check, not a path, so it cannot say which.
 */
const attributedWorkflow = (
  db: Db,
  projects: Pick<ProjectRegistry, "manifest">,
  runId: string,
  repositoryIdentity: string,
  checkName: string,
): AttributedWorkflow | null => {
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
  const entry = matches[0]!;
  return { path: entry.path, repositoryRole: entry.repositoryRole, approvedDigest: entry.approvedDigest };
};
