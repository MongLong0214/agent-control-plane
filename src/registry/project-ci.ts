import { type ProjectManifest, projectManifestSchema } from "../contracts/manifest.ts";
import { parseRepoFactoryResult } from "../bootstrap/repo-factory-result.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { CI_FAILED_CONCLUSIONS, ciVerificationRecords, type CiVerificationRecord } from "../verify/ci-verification-records.ts";
import type { ProjectRegistry } from "./project-registry.ts";

/**
 * #1257 — the CI section of a project read: what CI the active manifest declares and what ACP has
 * recorded about those checks. Nothing here is asserted by anyone; every value is read from the
 * active manifest, the repository registry, a post-merge verification receipt, a trusted-CI
 * verification result, or a bootstrap's CI evidence as its activation validated it (#1172).
 *
 * Kept apart from availability on purpose. `HEALTHY` says the project's runtime is serviceable and
 * says nothing about CI, so neither is computed from the other.
 */
export type ProjectCiUndeclaredReason = "NO_CI_WORKFLOWS";

/** Why the declaration could not be read. CI is then UNKNOWN, never NOT_DECLARED (#1172). */
export type ProjectCiUnknownReason = "NO_ACTIVE_MANIFEST" | "ACTIVE_MANIFEST_UNREADABLE";

/**
 * #1172 — the one CI answer, read beside availability and never from it.
 * NOT_DECLARED: the active manifest was read and declares no CI workflow.
 * DECLARED_UNOBSERVED: CI is declared, and a declared workflow has no PASS or FAIL recorded at its
 * repository's recorded head — nothing recorded, only an unfinished or non-result record, a result for
 * another commit, or no recorded head at all.
 * DECLARED_OBSERVED: every declared workflow has a PASS or FAIL recorded at its repository's recorded
 * head. Observed, not passed: each workflow's result stays its own `observedAtHead.result`.
 * UNKNOWN: the declaration, or a workflow's observations, could not be read.
 */
export type ProjectCiStatus = "NOT_DECLARED" | "DECLARED_UNOBSERVED" | "DECLARED_OBSERVED" | "UNKNOWN";

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
  /** A bootstrap run's stored producer result, read only as its activation validated it (see bootstrapRecords). */
  | { kind: "BOOTSTRAP_CI_EVIDENCE"; artifactId: string; runId: string }
  | {
    kind: "CI_VERIFICATION_RESULT";
    resultId: string;
    runId: string;
    status: CiVerificationRecord["status"];
    reasonCode: string | null;
  };

interface ProjectCiRecord {
  /**
   * The check's conclusion as its record holds it: a post-merge receipt's GitHub conclusion, a bootstrap
   * result's `PASS`; null for a verification result, which keeps none.
   */
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
  /** DECLARED_OBSERVED exactly when `observedAtHead` is set; see ProjectCiStatus. */
  status: Exclude<ProjectCiStatus, "NOT_DECLARED">;
  path: string;
  checkName: string;
  repositoryRole: string;
  approvedDigest: string | null;
  repositoryIdentity: string | null;
  /** The repository's accepted default-branch head as the registry last recorded it. */
  repositoryHead: { commitSha: string; observedAt: string | null } | null;
  /** The newest recorded PASS or FAIL for this workflow, at whatever commit. */
  lastObserved: ProjectCiObservation | null;
  /**
   * #1172 — the newest recorded PASS or FAIL at `repositoryHead.commitSha`, selected apart from
   * `lastObserved`: a newer result for another commit neither hides it nor stands in for it.
   */
  observedAtHead: ProjectCiObservation | null;
  /** The newest record when it holds no result: newer than `lastObserved`, or the only kind there is. */
  latestNonResult: ProjectCiNonResult | null;
  unobserved: boolean;
  unobservedReason: "NO_REPOSITORY_FOR_ROLE" | "NO_RECORDED_OBSERVATION" | "OBSERVATIONS_UNREADABLE" | ProjectCiNoResultReason | null;
}

export type ProjectCi =
  | { status: "UNKNOWN"; declared: null; reason: ProjectCiUnknownReason; manifestDigest: string | null }
  | { status: "NOT_DECLARED"; declared: false; reason: ProjectCiUndeclaredReason; manifestDigest: string }
  | { status: Exclude<ProjectCiStatus, "NOT_DECLARED">; declared: true; manifestDigest: string; workflows: ProjectCiWorkflow[] };

type Projects = Pick<ProjectRegistry, "get" | "manifest">;

/** The declared workflow a record is evidence for, as its run's pinned manifest named it. */
interface AttributedWorkflow { path: string; repositoryRole: string; approvedDigest: string | null }

interface CandidateRecord extends ProjectCiRecord {
  outcome: "PASS" | "FAIL" | ProjectCiNoResultReason;
  rowOrder: number;
  /** Set by a source that attributes its own records; otherwise the record's run pin attributes it. */
  attributedTo?: AttributedWorkflow;
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

/**
 * Never throws: a lookup that fails is UNKNOWN with its reason, so a caller composing this into a
 * larger answer (bootstrap activation) is not failed by it, and a failure never reads as NOT_DECLARED.
 */
export const projectCi = (db: Db, projects: Projects, projectId: string): ProjectCi => {
  let digest: string | null = null;
  let manifest: ReturnType<typeof projectManifestSchema.safeParse>;
  try {
    digest = projects.get(projectId)?.activeManifestDigest ?? null;
    if (digest === null) return { status: "UNKNOWN", declared: null, reason: "NO_ACTIVE_MANIFEST", manifestDigest: null };
    manifest = projectManifestSchema.safeParse(projects.manifest(digest));
  } catch {
    return { status: "UNKNOWN", declared: null, reason: "ACTIVE_MANIFEST_UNREADABLE", manifestDigest: digest };
  }
  if (!manifest.success) return { status: "UNKNOWN", declared: null, reason: "ACTIVE_MANIFEST_UNREADABLE", manifestDigest: digest };
  if (manifest.data.ciWorkflows.length === 0) {
    return { status: "NOT_DECLARED", declared: false, reason: "NO_CI_WORKFLOWS", manifestDigest: digest };
  }

  const attribution = new Map<string, AttributedWorkflow | null>();
  const workflows = manifest.data.ciWorkflows.map((workflow): ProjectCiWorkflow => {
    const declared = {
      path: workflow.path,
      checkName: workflow.checkName,
      repositoryRole: workflow.repositoryRole,
      approvedDigest: workflow.approvedDigest,
    };
    try {
      return observedWorkflow(db, projects, projectId, workflow, declared, attribution);
    } catch {
      return { status: "UNKNOWN", ...declared, repositoryIdentity: null, repositoryHead: null, lastObserved: null,
        observedAtHead: null, latestNonResult: null, unobserved: true, unobservedReason: "OBSERVATIONS_UNREADABLE" };
    }
  });
  const status = workflows.some((workflow) => workflow.status === "UNKNOWN")
    ? "UNKNOWN"
    : workflows.every((workflow) => workflow.status === "DECLARED_OBSERVED") ? "DECLARED_OBSERVED" : "DECLARED_UNOBSERVED";
  return { status, declared: true, manifestDigest: digest, workflows };
};

type DeclaredWorkflow = Pick<ProjectCiWorkflow, "path" | "checkName" | "repositoryRole" | "approvedDigest">;

/** One declared workflow with what is recorded of it; throws when a record cannot be read. */
const observedWorkflow = (
  db: Db,
  projects: Projects,
  projectId: string,
  workflow: ProjectManifest["ciWorkflows"][number],
  declared: DeclaredWorkflow,
  attribution: Map<string, AttributedWorkflow | null>,
): ProjectCiWorkflow => {
  const repository = db.get<{ identity: string; last_observed_head: string | null; last_observed_at: string | null }>(
    `SELECT identity, last_observed_head, last_observed_at FROM repositories
      WHERE project_id = ? AND repository_role = ? AND retired_at IS NULL AND registration = 'REGISTERED'
      ORDER BY created_at, repository_id LIMIT 1`,
    [projectId, workflow.repositoryRole],
  );
  if (!repository) {
    return { status: "DECLARED_UNOBSERVED", ...declared, repositoryIdentity: null, repositoryHead: null, lastObserved: null,
      observedAtHead: null, latestNonResult: null, unobserved: true, unobservedReason: "NO_REPOSITORY_FOR_ROLE" };
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
  const records = [
    ...postMergeRecords(db, identity, workflow.checkName),
    ...verificationRecords(db, identity, workflow.checkName),
    ...bootstrapRecords(db, projects, projectId, identity, workflow.checkName),
  ].sort(newestFirst);

  // Newest first. The first result is `lastObserved`, and the newest non-result before it is kept. The
  // walk goes on past a result for another commit until it finds the head's own (`observedAtHead`).
  type Found = { record: CandidateRecord; entry: AttributedWorkflow };
  let result: Found | null = null;
  let atHead: Found | null = null;
  let latestNonResult: ProjectCiNonResult | null = null;
  for (const record of records) {
    const entry = record.attributedTo ?? attributed(record.source.runId);
    if (entry === null || entry.path !== workflow.path || entry.repositoryRole !== workflow.repositoryRole) continue;
    if (record.outcome === "PASS" || record.outcome === "FAIL") {
      result ??= { record, entry };
      if (repositoryHead !== null && record.commitSha === repositoryHead.commitSha) atHead = { record, entry };
      if (atHead !== null || repositoryHead === null) break;
      continue;
    }
    if (result === null) latestNonResult ??= { ...recordOf(record), reason: record.outcome };
  }
  if (result === null) {
    return { status: "DECLARED_UNOBSERVED", ...declared, repositoryIdentity: identity, repositoryHead, lastObserved: null,
      observedAtHead: null, latestNonResult, unobserved: true, unobservedReason: latestNonResult?.reason ?? "NO_RECORDED_OBSERVATION" };
  }

  const observation = ({ record, entry }: Found): ProjectCiObservation => {
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
      ...recordOf(record),
      result: record.outcome as "PASS" | "FAIL",
      approvedDigestAtObservation,
      freshness: staleReasons.length === 0 ? "current" : "stale",
      staleReasons,
    };
  };
  return {
    // Observed at the current head or not; another commit's result is shown as that commit's, never the head's.
    status: atHead === null ? "DECLARED_UNOBSERVED" : "DECLARED_OBSERVED",
    ...declared,
    repositoryIdentity: identity,
    repositoryHead,
    lastObserved: observation(result),
    observedAtHead: atHead === null ? null : observation(atHead),
    latestNonResult,
    unobserved: false,
    unobservedReason: null,
  };
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

/**
 * A post-merge receipt follows the candidate verification of the same change, so it wins a tie; a
 * bootstrap's evidence comes before either.
 */
const SOURCE_RANK = { POST_MERGE_VERIFY_RECEIPT: 1, CI_VERIFICATION_RESULT: 0, BOOTSTRAP_CI_EVIDENCE: -1 } as const;

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
 * #1172 — a bootstrap's CI evidence, read only as its activation validated it. Activation stores the
 * run's bootstrap-activation DOCTOR_REPORT only after every check on the producer result passed, CI
 * included, so the result admitted is the run's latest REPO_FACTORY_RESULT stored before such a report —
 * the one the CONFIRM itself binds. Of it, only an entry activation's CI check accepts is a record: the
 * check as the result's own manifest declares it once on the repository's role, PASS, at the one head
 * the result's verification names, under that entry's approved digest unless it is an unapproved first
 * activation. It is an observation at that head like any other, never current by being a bootstrap's.
 */
const bootstrapRecords = (
  db: Db,
  projects: Pick<ProjectRegistry, "manifest">,
  projectId: string,
  identity: string,
  checkName: string,
): CandidateRecord[] =>
  db.all<{ artifact_id: string; run_id: string; content_json: string; created_at: string; row_order: number }>(
    `SELECT DISTINCT f.artifact_id, f.run_id, f.content_json, f.created_at, f.rowid AS row_order
       FROM run_artifacts f
       JOIN runs r ON r.run_id = f.run_id AND r.kind = 'PROJECT_BOOTSTRAP'
       JOIN run_artifacts d ON d.run_id = f.run_id AND d.kind = 'DOCTOR_REPORT' AND d.superseded = 0 AND d.rowid > f.rowid
      WHERE f.kind = 'REPO_FACTORY_RESULT' AND f.superseded = 0
        AND json_valid(d.content_json)
        AND json_extract(d.content_json, '$.source') = 'bootstrap-activation'
        AND json_extract(d.content_json, '$.projectId') = ?
        AND NOT EXISTS (SELECT 1 FROM run_artifacts n
                         WHERE n.run_id = f.run_id AND n.kind = 'REPO_FACTORY_RESULT' AND n.rowid > f.rowid AND n.rowid < d.rowid)`,
    [projectId],
  ).flatMap((row): CandidateRecord[] => {
    let content: unknown;
    try {
      content = JSON.parse(row.content_json);
    } catch {
      return [];
    }
    const parsed = parseRepoFactoryResult(content);
    if (!parsed.allowed) return [];
    const result = parsed.value;
    const repository = result.repositories.find((candidate) => candidate.identity === identity);
    const heads = [...new Set(result.bootstrapVerification
      .filter((verification) => verification.repositoryIdentity === identity)
      .map((verification) => verification.exactHead))];
    const manifest = projectManifestSchema.safeParse(projects.manifest(result.projectManifestDigest));
    if (repository === undefined || heads.length !== 1 || !manifest.success) return [];
    const declared = manifest.data.ciWorkflows.filter(
      (entry) => entry.checkName === checkName && entry.repositoryRole === repository.role,
    );
    if (declared.length !== 1) return [];
    const entry = declared[0]!;
    const evidence = result.ciEvidence.find((candidate) =>
      candidate.repositoryIdentity === identity &&
      candidate.checkName === checkName &&
      candidate.head === heads[0] &&
      candidate.conclusion === "PASS" &&
      (entry.unapprovedFirstActivation || candidate.workflowDigest === entry.approvedDigest));
    if (evidence === undefined) return [];
    return [{
      conclusion: evidence.conclusion,
      commitSha: evidence.head,
      observedAt: row.created_at,
      source: { kind: "BOOTSTRAP_CI_EVIDENCE", artifactId: row.artifact_id, runId: row.run_id },
      outcome: "PASS",
      rowOrder: row.row_order,
      attributedTo: { path: entry.path, repositoryRole: entry.repositoryRole, approvedDigest: entry.approvedDigest },
    }];
  });

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
