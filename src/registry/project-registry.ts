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
  ) {}

  register(input: {
    name: string;
    projectId?: string;
    manifest?: ProjectManifest | null;
  }): Decision<ProjectRecord> {
    const projectId = input.projectId ?? newProjectId();
    if (this.db.get(`SELECT 1 FROM projects WHERE project_id = ?`, [projectId])) {
      return deny(ReasonCode.CONFLICT, "project already registered", { projectId });
    }

    let digest: string | null = null;
    if (input.manifest) {
      const stored = this.storeManifest(input.manifest);
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
  storeManifest(manifest: ProjectManifest): Decision<string> {
    const portable = assertPortableManifest(manifest);
    if (!portable.allowed) return portable as Decision<string>;

    const digest = manifestDigest(portable.value);
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
  ): Decision<string> {
    const project = this.get(projectId);
    if (!project) return deny(ReasonCode.NOT_FOUND, "unknown project", { projectId });

    if (
      project.activeManifestDigest &&
      via.runKind !== "CONTRACT_CHANGE" &&
      via.runKind !== "PROJECT_BOOTSTRAP"
    ) {
      return deny(
        ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN,
        "replacing an active manifest requires a CONTRACT_CHANGE run",
        { projectId, current: project.activeManifestDigest, viaRunKind: via.runKind },
      );
    }

    // A run *kind* is a label, not a proof. Replacing a live contract requires a real
    // CONTRACT_CHANGE run for this project that actually completed (Integration §10.4).
    if (project.activeManifestDigest && via.runKind === "CONTRACT_CHANGE") {
      const run = via.runId
        ? this.db.get<{ kind: string; state: string; project_id: string | null }>(
            `SELECT kind, state, project_id FROM runs WHERE run_id = ?`,
            [via.runId],
          )
        : null;
      if (
        !run ||
        run.project_id !== projectId ||
        run.kind !== "CONTRACT_CHANGE" ||
        run.state !== "COMPLETED"
      ) {
        return deny(
          ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN,
          "a contract change must be carried by a completed CONTRACT_CHANGE run for this project",
          {
            projectId,
            runId: via.runId,
            observed: run ? { kind: run.kind, state: run.state, projectId: run.project_id } : null,
          },
        );
      }
    }

    const stored = this.storeManifest(manifest);
    if (!stored.allowed) return stored;

    this.db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [
      stored.value,
      projectId,
    ]);
    this.audit.record({
      kind: "PROJECT_MANIFEST_ACTIVATED",
      projectId,
      runId: via.runId,
      evidence: { from: project.activeManifestDigest, to: stored.value, viaRunKind: via.runKind },
    });
    return stored;
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
