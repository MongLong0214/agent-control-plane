import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newProjectId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  type ProjectManifest,
  assertPortableManifest,
  manifestDigest,
} from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { type Activity, type Availability, Role } from "../domain/types.ts";
import {
  type BootstrapManifestAuthority,
  type GuardRequest,
  type ManagedWriteGuard,
  WriteOperation,
} from "../guard/managed-write-guard.ts";

export interface ProjectRecord {
  projectId: string;
  name: string;
  activeManifestDigest: string | null;
  /** PRD §5.1 — derived from primary CTO binding presence, never stored. */
  activity: Activity;
  availability: Availability;
  suspended: boolean;
  createdAt: string;
}

/** Exact proof required for every persisted or activated manifest mutation. */
export interface ManagedManifestWrite {
  projectId: string;
  runId: string | null;
  sessionId: string | null;
  bindingGeneration: number | null;
  expectedManifestDigest: string;
  /** Present only for an explicitly fixture/bootstrap registration before a run exists. */
  bootstrapManifestAuthority?: BootstrapManifestAuthority | null;
}

/**
 * PRD §9.1 — a project record carries identity and an activation reference. It is not
 * a copy of the manifest: the portable contract lives in `manifests`, addressed by its
 * canonical digest, and the project points at whichever digest is currently active.
 */
export class ProjectRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly guard: ManagedWriteGuard,
  ) {}

  register(input: {
    name: string;
    projectId?: string;
    manifest?: ProjectManifest | null;
    authorization?: ManagedManifestWrite;
  }): Decision<ProjectRecord> {
    const projectId = input.projectId ?? newProjectId();
    if (this.db.get(`SELECT 1 FROM projects WHERE project_id = ?`, [projectId])) {
      return deny(ReasonCode.CONFLICT, "project already registered", { projectId });
    }

    let digest: string | null = null;
    if (input.manifest) {
      if (input.manifest.projectId !== projectId) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "registered project and manifest identities differ", {
          projectId,
          manifestProjectId: input.manifest.projectId,
        });
      }
      const stored = this.storeManifest(input.manifest, input.authorization!);
      if (!stored.allowed) return stored as Decision<ProjectRecord>;
      digest = stored.value;
    }

    this.db.run(
      `INSERT INTO projects (project_id, name, active_manifest_digest, created_at) VALUES (?, ?, ?, ?)`,
      [projectId, input.name, digest, this.clock.nowIso()],
    );
    this.audit.record({
      kind: "PROJECT_REGISTERED",
      projectId,
      evidence: { name: input.name, activeManifestDigest: digest },
    });
    return allow(ReasonCode.OK, this.get(projectId)!);
  }

  /**
   * Stores a manifest as an immutable, content-addressed contract. Portability is
   * checked here so an absolute path or a session id can never reach the registry
   * (Integration §10.2, CP-S04).
   */
  storeManifest(manifest: ProjectManifest, authorization: ManagedManifestWrite): Decision<string> {
    const portable = assertPortableManifest(manifest);
    if (!portable.allowed) return portable as Decision<string>;

    const digest = manifestDigest(portable.value);
    const authorized = this.authorizeManifestWrite(portable.value, authorization);
    if (!authorized.allowed) return authorized as Decision<string>;
    if (!this.db.get(`SELECT 1 FROM manifests WHERE digest = ?`, [digest])) {
      this.db.run(
        `INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`,
        [digest, portable.value.schema, JSON.stringify(portable.value), this.clock.nowIso()],
      );
    }
    return allow(ReasonCode.OK, digest);
  }

  manifest(digest: string): ProjectManifest | null {
    const row = this.db.get<{ content_json: string }>(
      `SELECT content_json FROM manifests WHERE digest = ?`,
      [digest],
    );
    return row ? (JSON.parse(row.content_json) as ProjectManifest) : null;
  }

  activeManifest(projectId: string): { digest: string; manifest: ProjectManifest } | null {
    const project = this.get(projectId);
    if (!project?.activeManifestDigest) return null;
    const manifest = this.manifest(project.activeManifestDigest);
    return manifest ? { digest: project.activeManifestDigest, manifest } : null;
  }

  /**
   * Activating a new contract is a deliberate act. A candidate that edits the manifest
   * during a run does not change what judges it — that requires a dedicated
   * CONTRACT_CHANGE run (§10.4, CP-HI-03).
   */
  activateManifest(
    projectId: string,
    manifest: ProjectManifest,
    via: { runKind: string; runId: string | null },
    authorization: ManagedManifestWrite,
  ): Decision<string> {
    const project = this.get(projectId);
    if (!project) return deny(ReasonCode.NOT_FOUND, "unknown project", { projectId });

    if (via.runKind !== "CONTRACT_CHANGE" && via.runKind !== "PROJECT_BOOTSTRAP") {
      return deny(
        ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN,
        "manifest activation requires a CONTRACT_CHANGE or PROJECT_BOOTSTRAP run",
        { projectId, current: project.activeManifestDigest, viaRunKind: via.runKind },
      );
    }

    if (!authorization || authorization.projectId !== projectId || authorization.runId !== via.runId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "manifest activation proof does not bind this project and run", {
        projectId,
        viaRunId: via.runId,
        authorizedProjectId: authorization?.projectId ?? null,
        authorizedRunId: authorization?.runId ?? null,
      });
    }

    // Authorise the activation effect before storing the candidate. Activation has a
    // distinct grant from the manifest-store effect, and a rejected activation must not
    // leave even the new manifest row behind as a side effect.
    const portable = assertPortableManifest(manifest);
    if (!portable.allowed) return portable as Decision<string>;
    const activationAuthorized = this.authorizeManifestWrite(portable.value, authorization);
    if (!activationAuthorized.allowed) return activationAuthorized as Decision<string>;

    const stored = this.storeManifest(portable.value, authorization);
    if (!stored.allowed) return stored;
    if (project.activeManifestDigest === stored.value) return stored;

    return this.db.tx(() => {
      const fresh = this.get(projectId);
      if (!fresh) return deny(ReasonCode.NOT_FOUND, "unknown project", { projectId });
      if (fresh.activeManifestDigest === stored.value) return stored;

      // A run label and a terminal state are not authorization for an arbitrary new
      // contract. The production gate must issue an immutable grant that names this
      // project, run kind, candidate, and exact manifest digest.
      const grant = this.activationGrant(projectId, stored.value, via);
      if (!grant.allowed) return grant;
      if (this.activationGrantConsumed(grant.value.artifactDigest)) {
        return deny(
          ReasonCode.MANIFEST_ACTIVATION_GRANT_CONSUMED,
          "manifest activation grant has already been consumed",
          { projectId, runId: via.runId, activationGrantDigest: grant.value.artifactDigest },
        );
      }

      this.db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [
        stored.value,
        projectId,
      ]);
      // Repository bindings are local evidence of the formerly active contract. A new
      // project digest invalidates that evidence until each checkout is re-read and a
      // managed operation acknowledges the resulting head.
      this.db.run(
        `UPDATE repositories
            SET active_manifest_digest = ?, drift_state = 'DRIFTED'
          WHERE project_id = ?`,
        [stored.value, projectId],
      );
      this.audit.record({
        kind: "PROJECT_MANIFEST_ACTIVATED",
        projectId,
        runId: via.runId,
        evidence: {
          from: fresh.activeManifestDigest,
          to: stored.value,
          viaRunKind: via.runKind,
          activationGrantDigest: grant.value.artifactDigest,
          candidateSnapshotDigest: grant.value.candidateSnapshotDigest,
        },
      });
      return stored;
    });
  }

  get(projectId: string): ProjectRecord | null {
    const row = this.db.get<RawProject>(`SELECT * FROM projects WHERE project_id = ?`, [projectId]);
    return row ? this.hydrate(row) : null;
  }

  require(projectId: string): ProjectRecord {
    return this.get(projectId) ?? fail(ReasonCode.NOT_FOUND, "unknown project", { projectId });
  }

  list(): ProjectRecord[] {
    return this.db
      .all<RawProject>(`SELECT * FROM projects ORDER BY created_at`)
      .map((row) => this.hydrate(row));
  }

  setAvailability(projectId: string, availability: Availability, reason: string): void {
    this.db.run(`UPDATE projects SET availability = ? WHERE project_id = ?`, [
      availability,
      projectId,
    ]);
    this.audit.record({
      kind: "PROJECT_AVAILABILITY",
      projectId,
      evidence: { availability, reason },
    });
  }

  setSuspended(projectId: string, suspended: boolean, ownerApproved: boolean): Decision<void> {
    if (suspended && !ownerApproved) {
      // §10.4 — a capacity-driven project suspend is an owner gate, not a CEO call.
      return deny(
        ReasonCode.HUMAN_GATE_REQUIRED,
        "project suspend requires owner approval",
        { projectId },
      );
    }
    this.db.run(`UPDATE projects SET suspended = ? WHERE project_id = ?`, [
      suspended ? 1 : 0,
      projectId,
    ]);
    this.audit.record({
      kind: suspended ? "PROJECT_SUSPENDED" : "PROJECT_RESUMED",
      projectId,
      evidence: { ownerApproved },
    });
    return allow(ReasonCode.OK, undefined);
  }

  private authorizeManifestWrite(
    manifest: ProjectManifest,
    authorization: ManagedManifestWrite,
  ): Decision<void> {
    if (!authorization) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "manifest mutation requires managed authorization", {});
    }
    const digest = manifestDigest(manifest);
    if (
      authorization.projectId !== manifest.projectId ||
      authorization.expectedManifestDigest !== digest
    ) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "manifest authorization does not bind the exact project digest", {
        projectId: manifest.projectId,
        authorizedProjectId: authorization.projectId,
        expectedManifestDigest: authorization.expectedManifestDigest,
        calculatedManifestDigest: digest,
      });
    }
    const request: GuardRequest = {
      operation: WriteOperation.MANIFEST_CHANGE,
      projectId: authorization.projectId,
      runId: authorization.runId,
      sessionId: authorization.sessionId,
      bindingGeneration: authorization.bindingGeneration,
      claimedClassification: "MANAGED",
      actor: "project-registry",
      bootstrapManifestAuthority: authorization.bootstrapManifestAuthority ?? null,
    };
    const evaluated = this.guard.evaluate(request);
    if (!evaluated.allowed) return evaluated as Decision<void>;
    const consumed = this.guard.consume(evaluated.value.grantId);
    if (!consumed.allowed) return consumed as Decision<void>;
    return allow(ReasonCode.WRITE_ALLOWED, undefined);
  }

  private activationGrant(
    projectId: string,
    manifestDigestValue: string,
    via: { runKind: string; runId: string | null },
  ): Decision<{ artifactDigest: string; candidateSnapshotDigest: string }> {
    const run = via.runId
      ? this.db.get<{
          kind: string;
          state: string;
          project_id: string | null;
          current_candidate_digest: string | null;
        }>(
          `SELECT kind, state, project_id, current_candidate_digest FROM runs WHERE run_id = ?`,
          [via.runId],
        )
      : null;
    if (
      !run ||
      run.project_id !== projectId ||
      run.kind !== via.runKind ||
      run.state !== "COMPLETED" ||
      !run.current_candidate_digest
    ) {
      return deny(
        ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN,
        "manifest activation requires a completed dedicated run with a current candidate",
        {
          projectId,
          runId: via.runId,
          observed: run
            ? {
                kind: run.kind,
                state: run.state,
                projectId: run.project_id,
                currentCandidateDigest: run.current_candidate_digest,
              }
            : null,
        },
      );
    }

    const grants = this.db.all<RawActivationGrant>(
      `SELECT digest, candidate_snapshot_digest, content_json FROM run_artifacts
        WHERE run_id = ? AND kind = 'APPROVAL' AND produced_by = 'production-gate'
          AND superseded = 0
        ORDER BY created_at DESC, rowid DESC`,
      [via.runId],
    );
    const grant = grants.find((row) => {
      const content = parseActivationGrant(row.content_json);
      return (
        content?.projectId === projectId &&
        content.runId === via.runId &&
        content.runKind === via.runKind &&
        content.manifestDigest === manifestDigestValue &&
        content.candidateSnapshotDigest === run.current_candidate_digest &&
        row.candidate_snapshot_digest === run.current_candidate_digest
      );
    });
    if (!grant) {
      return deny(
        ReasonCode.MANIFEST_ACTIVATION_EVIDENCE_MISSING,
        "no production-gate activation grant proves this exact manifest and candidate",
        { projectId, runId: via.runId, runKind: via.runKind, manifestDigest: manifestDigestValue },
      );
    }
    return allow(ReasonCode.OK, {
      artifactDigest: grant.digest,
      candidateSnapshotDigest: run.current_candidate_digest,
    });
  }

  private activationGrantConsumed(artifactDigest: string): boolean {
    return this.db
      .all<{ evidence_json: string }>(
        `SELECT evidence_json FROM audit_events WHERE kind = 'PROJECT_MANIFEST_ACTIVATED'`,
      )
      .some((row) => {
        try {
          return (JSON.parse(row.evidence_json) as { activationGrantDigest?: unknown }).activationGrantDigest === artifactDigest;
        } catch {
          return false;
        }
      });
  }

  private hydrate(row: RawProject): ProjectRecord {
    const bound = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments
        WHERE project_id = ? AND role = ? AND status = 'ACTIVE'`,
      [row.project_id, Role.PRIMARY_CTO],
    );
    return {
      projectId: row.project_id,
      name: row.name,
      activeManifestDigest: row.active_manifest_digest,
      activity: (bound?.n ?? 0) > 0 ? "ACTIVE" : "INACTIVE",
      availability: row.availability,
      suspended: row.suspended === 1,
      createdAt: row.created_at,
    };
  }
}

interface RawProject {
  project_id: string;
  name: string;
  active_manifest_digest: string | null;
  availability: Availability;
  suspended: number;
  created_at: string;
}

interface RawActivationGrant {
  digest: string;
  candidate_snapshot_digest: string | null;
  content_json: string;
}

interface ActivationGrant {
  schema: "acp.manifest-activation-grant.v1";
  projectId: string;
  runId: string;
  runKind: "CONTRACT_CHANGE" | "PROJECT_BOOTSTRAP";
  manifestDigest: string;
  candidateSnapshotDigest: string;
}

const parseActivationGrant = (content: string): ActivationGrant | null => {
  try {
    const value = JSON.parse(content) as Partial<ActivationGrant>;
    if (
      value.schema !== "acp.manifest-activation-grant.v1" ||
      typeof value.projectId !== "string" ||
      typeof value.runId !== "string" ||
      (value.runKind !== "CONTRACT_CHANGE" && value.runKind !== "PROJECT_BOOTSTRAP") ||
      typeof value.manifestDigest !== "string" ||
      typeof value.candidateSnapshotDigest !== "string"
    ) {
      return null;
    }
    return value as ActivationGrant;
  } catch {
    return null;
  }
};
