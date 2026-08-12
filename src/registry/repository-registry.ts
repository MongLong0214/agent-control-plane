import { resolve } from "node:path";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newRepositoryId, normalizeRemoteIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { isClean, remoteUrl, toplevel, tryRevParse } from "../git/git.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";

export interface RepositoryRecord {
  repositoryId: string;
  identity: string;
  checkoutPath: string;
  projectId: string | null;
  repositoryRole: string | null;
  trustClass: "OWNER_TRUSTED" | "UNTRUSTED";
  activeManifestDigest: string | null;
  observedRemoteUrl: string | null;
  /** Trusted accepted head; schema migration will split this from the latest observation. */
  lastObservedHead: string | null;
  lastObservedAt: string | null;
  driftState: "UNKNOWN" | "IN_SYNC" | "DRIFTED";
  registration: "REGISTERED" | "TEMPORARY";
  temporaryForRun: string | null;
  createdAt: string;
}

/** A live filesystem reading. Unlike `observe`, this has no registry side effect. */
export interface RepositoryInspection {
  repositoryId: string;
  checkoutPath: string;
  acceptedHead: string | null;
  observedHead: string | null;
  observedAt: string;
  clean: boolean;
  driftState: RepositoryRecord["driftState"];
}

/**
 * PRD §9.2 / Integration §11 — the machine-local binding SSOT.
 *
 * Absolute checkout paths exist here and nowhere else. A committed manifest that
 * carries one is rejected upstream by `assertPortableManifest`; this registry is where
 * the local truth is allowed to live.
 */
export class RepositoryRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  async register(input: {
    checkoutPath: string;
    projectId?: string | null;
    repositoryRole?: string;
    activeManifestDigest?: string | null;
    trustClass?: "OWNER_TRUSTED" | "UNTRUSTED";
    identity?: string;
  }): Promise<Decision<RepositoryRecord>> {
    const path = canonical(input.checkoutPath);
    const root = await toplevel(path).catch(() => null);
    if (!root) {
      return deny(ReasonCode.NOT_FOUND, "path is not inside a git work tree", { path });
    }

    const observedRemote = await remoteUrl(root);
    const observedIdentity = observedRemote ? normalizeRemoteIdentity(observedRemote) : null;
    // A declared identity may *name* a checkout that has no remote, but it may never
    // contradict one that does: evidence would then describe a different repository from
    // the one being read and tested (CP-HI-06).
    if (input.identity && observedIdentity && input.identity !== observedIdentity) {
      return deny(
        ReasonCode.REPOSITORY_IDENTITY_MISMATCH,
        "declared repository identity does not match the checkout's remote",
        { declared: input.identity, observed: observedIdentity, path: canonical(root) },
      );
    }
    const identity = input.identity ?? observedIdentity ?? `local:${root}`;

    const rootPath = canonical(root);
    const existing = this.byIdentity(identity);
    const existingAtPath = this.byCheckoutPath(rootPath);
    if (existingAtPath && existingAtPath.identity !== identity) {
      return deny(
        ReasonCode.REPOSITORY_CHECKOUT_ALREADY_REGISTERED,
        "canonical checkout path is already bound to a different repository identity",
        {
          checkoutPath: rootPath,
          requestedIdentity: identity,
          existingIdentity: existingAtPath.identity,
        },
      );
    }
    // Re-registering the same checkout under the same identity is idempotent: a retried
    // bootstrap or activation must not fail because a previous attempt got this far.
    // A *different* path for a registered identity is still a conflict.
    if (
      existing &&
      existing.registration === "REGISTERED" &&
      existing.checkoutPath !== rootPath
    ) {
      return deny(ReasonCode.CONFLICT, "repository identity already registered", {
        identity,
        existingPath: existing.checkoutPath,
        requestedPath: rootPath,
      });
    }

    if (existing?.registration === "TEMPORARY") {
      return deny(
        ReasonCode.TEMPORARY_REPOSITORY_SCOPE_VIOLATION,
        "a run-scoped temporary repository cannot be promoted by re-registration",
        { identity, temporaryForRun: existing.temporaryForRun },
      );
    }

    if (existing && hasBindingChange(existing, input)) {
      return deny(
        ReasonCode.REPOSITORY_BINDING_CHANGE_REQUIRES_ACTIVATION,
        "re-registration may not change project, manifest, role, or trust binding",
        { identity, repositoryId: existing.repositoryId },
      );
    }

    if (existing) {
      // Registration retries are deliberately observationally inert. In particular, a
      // retry cannot turn a DRIFTED checkout into IN_SYNC or detach its project binding.
      this.audit.record({
        kind: "REPOSITORY_REGISTERED",
        projectId: existing.projectId,
        evidence: { identity, checkoutPath: existing.checkoutPath, role: existing.repositoryRole, idempotent: true },
      });
      return allow(ReasonCode.OK, existing);
    }

    const record: RepositoryRecord = {
      repositoryId: newRepositoryId(),
      identity,
      checkoutPath: rootPath,
      projectId: input.projectId ?? null,
      repositoryRole: input.repositoryRole ?? "primary",
      trustClass: input.trustClass ?? "OWNER_TRUSTED",
      activeManifestDigest: input.activeManifestDigest ?? null,
      observedRemoteUrl: observedRemote,
      lastObservedHead: await tryRevParse(root, "HEAD"),
      lastObservedAt: this.clock.nowIso(),
      driftState: "IN_SYNC",
      registration: "REGISTERED",
      temporaryForRun: null,
      createdAt: this.clock.nowIso(),
    };

    this.db.run(
      `INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role,
                                 trust_class, active_manifest_digest, observed_remote_url,
                                 last_observed_head, last_observed_at, drift_state, registration, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN_SYNC', 'REGISTERED', ?)`,
      [
        record.repositoryId, record.identity, record.checkoutPath, record.projectId,
        record.repositoryRole, record.trustClass, record.activeManifestDigest,
        record.observedRemoteUrl, record.lastObservedHead, record.lastObservedAt, record.createdAt,
      ],
    );

    this.audit.record({
      kind: "REPOSITORY_REGISTERED",
      projectId: record.projectId,
      evidence: { identity, checkoutPath: record.checkoutPath, role: record.repositoryRole },
    });
    return allow(ReasonCode.OK, record);
  }

  /**
   * PRD §16.3 — an unregistered local repository can be touched by a run. It gets a
   * run-scoped temporary identity and binding, and is deliberately *not* promoted to an
   * active project.
   */
  async registerTemporary(
    checkoutPath: string,
    runId: string,
  ): Promise<Decision<RepositoryRecord>> {
    const path = canonical(checkoutPath);
    const root = await toplevel(path).catch(() => null);
    if (!root) return deny(ReasonCode.NOT_FOUND, "path is not inside a git work tree", { path });

    const observedRemote = await remoteUrl(root);
    const identity = observedRemote
      ? normalizeRemoteIdentity(observedRemote)
      : `local:${canonical(root)}`;

    const rootPath = canonical(root);
    const existing = this.byIdentity(identity);
    const existingAtPath = this.byCheckoutPath(rootPath);
    if (existingAtPath && existingAtPath.identity !== identity) {
      return deny(
        ReasonCode.REPOSITORY_CHECKOUT_ALREADY_REGISTERED,
        "canonical checkout path is already bound to a different repository identity",
        { checkoutPath: rootPath, requestedIdentity: identity, existingIdentity: existingAtPath.identity },
      );
    }
    if (existing) return this.assertRunScope(existing.repositoryId, runId);

    const repositoryId = newRepositoryId();
    this.db.run(
      `INSERT INTO repositories (repository_id, identity, checkout_path, trust_class,
                                 observed_remote_url, last_observed_head, last_observed_at,
                                 drift_state, registration, temporary_for_run, created_at)
       VALUES (?, ?, ?, 'OWNER_TRUSTED', ?, ?, ?, 'IN_SYNC', 'TEMPORARY', ?, ?)`,
      [
        repositoryId, identity, rootPath, observedRemote,
        await tryRevParse(root, "HEAD"), this.clock.nowIso(), runId, this.clock.nowIso(),
      ],
    );
    this.audit.record({
      kind: "REPOSITORY_TEMPORARY_BINDING",
      runId,
      evidence: { identity, checkoutPath: rootPath },
    });
    return allow(ReasonCode.OK, this.byIdentity(identity)!);
  }

  /** Re-reads the checkout and records its verdict without advancing the accepted head. */
  async observe(repositoryId: string): Promise<RepositoryRecord | null> {
    const inspection = await this.inspect(repositoryId);
    if (!inspection) return null;

    this.db.run(
      `UPDATE repositories SET last_observed_at = ?, drift_state = ?
        WHERE repository_id = ?`,
      [inspection.observedAt, inspection.driftState, repositoryId],
    );
    return this.byId(repositoryId);
  }

  /** Doctor-safe repository read: inspect the checkout without mutating registry evidence. */
  async inspect(repositoryId: string): Promise<RepositoryInspection | null> {
    const record = this.byId(repositoryId);
    if (!record) return null;

    const observedHead = await tryRevParse(record.checkoutPath, "HEAD");
    const clean = observedHead ? await isClean(record.checkoutPath) : false;
    const driftState: RepositoryRecord["driftState"] =
      observedHead === null
        ? "UNKNOWN"
        : observedHead === record.lastObservedHead && clean
          ? "IN_SYNC"
          : "DRIFTED";
    return {
      repositoryId,
      checkoutPath: record.checkoutPath,
      acceptedHead: record.lastObservedHead,
      observedHead,
      observedAt: this.clock.nowIso(),
      clean,
      driftState,
    };
  }

  /** Accept the current head as the new baseline after a legitimate managed change. */
  acknowledgeHead(repositoryId: string, head: string): void {
    this.db.run(
      `UPDATE repositories SET last_observed_head = ?, last_observed_at = ?, drift_state = 'IN_SYNC'
        WHERE repository_id = ?`,
      [head, this.clock.nowIso(), repositoryId],
    );
  }

  /** Enforces the §16.3 relation wherever a repository is attached to a run. */
  assertRunScope(repositoryId: string, runId: string): Decision<RepositoryRecord> {
    const record = this.byId(repositoryId);
    if (!record) return deny(ReasonCode.NOT_FOUND, "unknown repository", { repositoryId, runId });
    if (record.registration === "TEMPORARY" && record.temporaryForRun !== runId) {
      return deny(
        ReasonCode.TEMPORARY_REPOSITORY_SCOPE_VIOLATION,
        "temporary repository binding belongs to another run",
        { repositoryId, requestedRunId: runId, temporaryForRun: record.temporaryForRun },
      );
    }
    return allow(ReasonCode.OK, record);
  }

  byId(repositoryId: string): RepositoryRecord | null {
    const row = this.db.get<RawRepository>(`SELECT * FROM repositories WHERE repository_id = ?`, [
      repositoryId,
    ]);
    return row ? hydrate(row) : null;
  }

  byIdentity(identity: string): RepositoryRecord | null {
    const row = this.db.get<RawRepository>(`SELECT * FROM repositories WHERE identity = ?`, [
      identity,
    ]);
    return row ? hydrate(row) : null;
  }

  byCheckoutPath(checkoutPath: string): RepositoryRecord | null {
    const row = this.db.get<RawRepository>(`SELECT * FROM repositories WHERE checkout_path = ?`, [
      canonical(checkoutPath),
    ]);
    return row ? hydrate(row) : null;
  }

  requireByIdentity(identity: string): RepositoryRecord {
    return (
      this.byIdentity(identity) ??
      fail(ReasonCode.NOT_FOUND, "unknown repository identity", { identity })
    );
  }

  byProject(projectId: string): RepositoryRecord[] {
    return this.db
      .all<RawRepository>(`SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at`, [
        projectId,
      ])
      .map(hydrate);
  }

  list(): RepositoryRecord[] {
    return this.db
      .all<RawRepository>(`SELECT * FROM repositories ORDER BY created_at`)
      .map(hydrate);
  }

  /** Longest-prefix match, so a nested checkout resolves to the innermost repository. */
  resolvePath(path: string): RepositoryRecord | null {
    const target = canonical(resolve(path));
    return (
      this.list()
        .filter((repo) => isWithin(repo.checkoutPath, target))
        .sort((a, b) => b.checkoutPath.length - a.checkoutPath.length)[0] ?? null
    );
  }
}

interface RawRepository {
  repository_id: string;
  identity: string;
  checkout_path: string;
  project_id: string | null;
  repository_role: string | null;
  trust_class: RepositoryRecord["trustClass"];
  active_manifest_digest: string | null;
  observed_remote_url: string | null;
  last_observed_head: string | null;
  last_observed_at: string | null;
  drift_state: RepositoryRecord["driftState"];
  registration: RepositoryRecord["registration"];
  temporary_for_run: string | null;
  created_at: string;
}

/** Existing bindings change only through their owning activation workflow. */
const hasBindingChange = (
  existing: RepositoryRecord,
  input: {
    projectId?: string | null;
    repositoryRole?: string;
    activeManifestDigest?: string | null;
    trustClass?: "OWNER_TRUSTED" | "UNTRUSTED";
  },
): boolean =>
  (input.projectId !== undefined && input.projectId !== existing.projectId) ||
  (input.repositoryRole !== undefined && input.repositoryRole !== existing.repositoryRole) ||
  (input.activeManifestDigest !== undefined && input.activeManifestDigest !== existing.activeManifestDigest) ||
  (input.trustClass !== undefined && input.trustClass !== existing.trustClass);

const hydrate = (row: RawRepository): RepositoryRecord => ({
  repositoryId: row.repository_id,
  identity: row.identity,
  checkoutPath: row.checkout_path,
  projectId: row.project_id,
  repositoryRole: row.repository_role,
  trustClass: row.trust_class,
  activeManifestDigest: row.active_manifest_digest,
  observedRemoteUrl: row.observed_remote_url,
  lastObservedHead: row.last_observed_head,
  lastObservedAt: row.last_observed_at,
  driftState: row.drift_state,
  registration: row.registration,
  temporaryForRun: row.temporary_for_run,
  createdAt: row.created_at,
});
