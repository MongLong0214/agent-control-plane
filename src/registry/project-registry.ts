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
import { bootstrapReservationsHolding } from "../bootstrap/bootstrap-applications.ts";
import type { Db } from "../db/database.ts";
import { type Activity, type Availability, Role } from "../domain/types.ts";
import { type CompletionAuthority, isDaemonFinalizerCompletion } from "../run/run-engine.ts";
import {
  type ActivatedWorkflowEvidence,
  type FirstActivationWorkflowEvidence,
  type GrantConsumer,
  type ManifestActivationGrants,
  sameFirstActivationCoverage,
  sameWorkflowCoverage,
} from "./manifest-activation-grants.ts";
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
  buzzAddress: string | null;
  retiredAt: string | null;
  supersedesProjectId: string | null;
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
  #grants: ManifestActivationGrants | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly guard: ManagedWriteGuard,
  ) {}

  /** Read-only preflight, repeated under registration's write transaction to close competing claims. */
  validatePredecessor(projectId: string, supersedesProjectId: string | undefined): Decision<void> {
    if (supersedesProjectId === undefined) return allow(ReasonCode.OK, undefined);
    const evidence = { projectId, supersedesProjectId };
    if (supersedesProjectId === projectId) {
      return deny(ReasonCode.PROJECT_PREDECESSOR_SELF, "a project cannot supersede itself", evidence);
    }
    const predecessor = this.get(supersedesProjectId);
    if (!predecessor) {
      return deny(ReasonCode.PROJECT_PREDECESSOR_NOT_FOUND, "the named predecessor is not registered", evidence);
    }
    if (predecessor.retiredAt === null) {
      return deny(ReasonCode.PROJECT_PREDECESSOR_NOT_RETIRED, "the named predecessor is not retired", evidence);
    }
    const claimant = this.db.get<{ project_id: string }>(
      `SELECT project_id FROM projects WHERE supersedes_project_id = ? AND project_id <> ? ORDER BY project_id LIMIT 1`,
      [supersedesProjectId, projectId],
    );
    if (claimant) {
      return deny(ReasonCode.PROJECT_PREDECESSOR_ALREADY_SUPERSEDED, "another project already claims the predecessor", { ...evidence, claimedBy: claimant.project_id });
    }
    const existing = this.get(projectId);
    if (existing && existing.supersedesProjectId !== supersedesProjectId) {
      return deny(ReasonCode.PROJECT_PREDECESSOR_LINK_CONFLICT, "an existing project's predecessor link cannot be overwritten", evidence);
    }
    return allow(ReasonCode.OK, undefined);
  }

  register(input: {
    name: string;
    projectId?: string;
    supersedesProjectId?: string;
    manifest?: ProjectManifest | null;
    authorization?: ManagedManifestWrite;
  }): Decision<ProjectRecord> {
    // Keep the legacy path unchanged; explicit claims validate and register under one write lock.
    return input.supersedesProjectId === undefined
      ? this.registerProject(input)
      : this.db.txDecision(() => this.registerProject(input));
  }

  private registerProject(input: {
    name: string;
    projectId?: string;
    supersedesProjectId?: string;
    manifest?: ProjectManifest | null;
    authorization?: ManagedManifestWrite;
  }): Decision<ProjectRecord> {
    const projectId = input.projectId ?? newProjectId();
    const predecessorCheck = this.validatePredecessor(projectId, input.supersedesProjectId);
    if (!predecessorCheck.allowed) return predecessorCheck;
    const existing = this.get(projectId);
    if (existing) {
      // The explicit link was revalidated under the write lock, excluding this row as a claimant.
      // A retry returns the original registration without storing a manifest or auditing it again.
      if (input.supersedesProjectId !== undefined && (!input.manifest || manifestDigest(input.manifest) === existing.activeManifestDigest)) {
        return allow(ReasonCode.OK, existing);
      }
      return deny(ReasonCode.CONFLICT, "project already registered", { projectId });
    }
    // #246 C3 — a project id a bootstrap run reserved is registered by that run's activation alone;
    // every other registration of it is refused, whatever its phase: a reservation is never reused.
    const reservedBy = bootstrapReservationsHolding(this.db, { projectId })
      .filter((reservation) => reservation.projectId === projectId && reservation.runId !== input.authorization?.runId);
    if (reservedBy.length > 0) {
      return deny(ReasonCode.BOOTSTRAP_APPLICATION_RESERVED, "the project id is reserved by another bootstrap run", {
        projectId,
        reservedBy: reservedBy.map((reservation) => ({ runId: reservation.runId, phase: reservation.phase })),
      });
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
      `INSERT INTO projects (project_id, name, active_manifest_digest, created_at, supersedes_project_id) VALUES (?, ?, ?, ?, ?)`,
      [projectId, input.name, digest, this.clock.nowIso(), input.supersedesProjectId ?? null],
    );
    const predecessor = input.manifest?.repositories[0]?.remote;
    if (predecessor && input.supersedesProjectId === undefined) {
      const retired = this.db.get<{project_id:string}>(`SELECT project_id FROM repositories WHERE identity = ? AND retired_at IS NOT NULL ORDER BY retired_at DESC, repository_id DESC LIMIT 1`,[predecessor]);
      if (retired) this.db.run(`UPDATE projects SET supersedes_project_id = ? WHERE project_id = ?`,[retired.project_id,projectId]);
    }
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
   * #246 B2-b — the one path that moves an existing project's active manifest.
   *
   * Activating a new contract is a deliberate act. A candidate that edits the manifest during a run
   * does not change what judges it — that requires a dedicated CONTRACT_CHANGE run (§10.4, CP-HI-03)
   * whose CEO CONFIRM issued it a grant. Only the daemon finalizer calls this, with its completion
   * capability and its running attempt, in the transaction that also completes the run: the grant is
   * verified there, consumed, and the pointer moves from the run's pin to the manifest the run's PLAN
   * carries — the caller supplies no manifest. The repository bindings are marked drifted, and the move
   * is audited. Any refusal leaves all of it as it was.
   *
   * `workflows` is what the finalizer read, outside this transaction, of every workflow the manifest
   * points to (CEO ruling 6); it must cover each one exactly. `consumer` is the authenticated CEO
   * session the finalization attempt started for; it must still be the grant's consumer and the live
   * CEO binding when this transaction commits (CEO ruling 2).
   *
   * #512 — a first-activation grant moves the pointer from NULL instead: `workflows` must then be an
   * exact, non-empty bijection with the grant's bound revisions, each read at its bound commit, and the
   * audit records `from: null` and `activation: "FIRST"`. The grant is consumed before the pointer
   * moves, which is the order the schema's consumed-while-NULL guard relies on.
   */
  activateManifest(
    runId: string,
    input: {
      completion: CompletionAuthority;
      attemptId: string;
      workflows: readonly ActivatedWorkflowEvidence[];
      consumer: GrantConsumer | null;
    },
  ): Decision<{ from: string | null; to: string; grantId: string }> {
    if (!isDaemonFinalizerCompletion(input.completion)) {
      return deny(ReasonCode.COMPLETION_AUTHORITY_DENIED, "only the daemon finalizer activates a CONTRACT_CHANGE manifest", { runId });
    }
    const grants = this.#grants;
    if (!grants) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "manifest activation grants are not configured", { runId });
    }
    type Activated = Decision<{ from: string | null; to: string; grantId: string }>;
    return this.db.txDecision((): Activated => {
      const target = grants.verify(runId, "ACTIVATION", input.consumer);
      if (!target.allowed) return target as Activated;
      const { grant, manifest } = target.value;
      const first = target.value.kind === "FIRST";
      const covered = target.value.kind === "FIRST"
        ? sameFirstActivationCoverage(
            target.value.workflowRevisions,
            target.value.workflowEvidence,
            input.workflows as readonly FirstActivationWorkflowEvidence[],
          )
        : sameWorkflowCoverage(target.value.workflowEvidence, input.workflows);
      if (!covered) {
        return deny(ReasonCode.MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED, "activation must carry a comparison for every workflow the manifest names", {
          runId,
          ...(first ? { activation: "FIRST" } : {}),
          expected: target.value.workflowEvidence.map((workflow) => `${workflow.repositoryRole}:${workflow.path}`),
          supplied: input.workflows.map((workflow) => `${workflow.repositoryRole}:${workflow.path}`),
        });
      }
      const consumed = grants.consume(runId, input.attemptId);
      if (!consumed.allowed) return consumed as Activated;
      const from = target.value.kind === "FIRST" ? null : target.value.grant.fromManifestDigest;

      // Content-addressed and immutable: the PLAN's manifest was checked portable and to hash to the
      // grant's digest when the PLAN was stored, and again by `verify` just above.
      if (!this.db.get(`SELECT 1 FROM manifests WHERE digest = ?`, [grant.manifestDigest])) {
        this.db.run(
          `INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`,
          [grant.manifestDigest, manifest.schema, JSON.stringify(manifest), this.clock.nowIso()],
        );
      }
      this.db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [
        grant.manifestDigest,
        grant.projectId,
      ]);
      // Repository bindings are local evidence of the formerly active contract. A new project digest
      // invalidates that evidence until each checkout is re-read and a managed operation acknowledges
      // the resulting head.
      this.db.run(
        `UPDATE repositories
            SET active_manifest_digest = ?, drift_state = 'DRIFTED'
          WHERE project_id = ?`,
        [grant.manifestDigest, grant.projectId],
      );
      this.audit.record({
        kind: "PROJECT_MANIFEST_ACTIVATED",
        projectId: grant.projectId,
        runId,
        evidence: {
          from,
          to: grant.manifestDigest,
          viaRunKind: "CONTRACT_CHANGE",
          ...(target.value.kind === "FIRST"
            ? {
                activation: "FIRST",
                registrationEventId: target.value.grant.registrationEventId,
                reviewDigest: target.value.grant.reviewDigest,
                workflowRevisionsDigest: target.value.grant.workflowRevisionsDigest,
              }
            : {}),
          grantId: grant.grantId,
          grantDigest: grant.grantDigest,
          attemptId: input.attemptId,
          consumer: grant.consumer,
          candidateSnapshotDigest: grant.candidateSnapshotDigest,
          workflows: input.workflows.map((workflow) => ({ ...workflow })),
        },
      });
      return allow(ReasonCode.OK, { from, to: grant.manifestDigest, grantId: grant.grantId });
    });
  }

  /** #246 B2-b — wired once by the composition root; activation reads its grants through nothing else. */
  attachManifestGrants(grants: ManifestActivationGrants): void {
    if (this.#grants) throw new Error("manifest activation grants are already attached");
    this.#grants = grants;
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
      .all<RawProject>(`SELECT * FROM projects ORDER BY created_at, project_id`)
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

  setSuspended(
    projectId: string,
    suspended: boolean,
    ownerApproved: boolean,
    approval?: { approvedBy: string; source: "agentcpd-state" },
  ): Decision<void> {
    if (!suspended && this.get(projectId)?.retiredAt) return deny(ReasonCode.CONFLICT,"retired project cannot resume",{projectId});
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
      evidence: { ownerApproved, ...approval },
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
      buzzAddress: row.buzz_address,
      retiredAt: row.retired_at,
      supersedesProjectId: row.supersedes_project_id,
      createdAt: row.created_at,
    };
  }
}

interface RawProject {
  buzz_address: string | null;
  retired_at: string | null;
  supersedes_project_id: string | null;
  project_id: string;
  name: string;
  active_manifest_digest: string | null;
  availability: Availability;
  suspended: number;
  created_at: string;
}
