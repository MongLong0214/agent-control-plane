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
  lastObservedHead: string | null;
  lastObservedAt: string | null;
  driftState: "UNKNOWN" | "IN_SYNC" | "DRIFTED";
  registration: "REGISTERED" | "TEMPORARY";
  temporaryForRun: string | null;
  createdAt: string;
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
    const identity =
      input.identity ?? (observedRemote ? normalizeRemoteIdentity(observedRemote) : `local:${root}`);

    const existing = this.byIdentity(identity);
    if (existing && existing.registration === "REGISTERED") {
      return deny(ReasonCode.CONFLICT, "repository identity already registered", {
        identity,
        existingPath: existing.checkoutPath,
      });
    }

    const record: RepositoryRecord = {
      repositoryId: existing?.repositoryId ?? newRepositoryId(),
      identity,
      checkoutPath: canonical(root),
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

    if (existing) {
      this.db.run(
        `UPDATE repositories SET checkout_path = ?, project_id = ?, repository_role = ?,
                                 trust_class = ?, active_manifest_digest = ?, observed_remote_url = ?,
                                 last_observed_head = ?, last_observed_at = ?, drift_state = 'IN_SYNC',
                                 registration = 'REGISTERED', temporary_for_run = NULL
          WHERE repository_id = ?`,
        [
          record.checkoutPath, record.projectId, record.repositoryRole, record.trustClass,
          record.activeManifestDigest, record.observedRemoteUrl, record.lastObservedHead,
          record.lastObservedAt, record.repositoryId,
        ],
      );
    } else {
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
    }

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

    const existing = this.byIdentity(identity);
    if (existing) return allow(ReasonCode.OK, existing);

    const repositoryId = newRepositoryId();
    this.db.run(
      `INSERT INTO repositories (repository_id, identity, checkout_path, trust_class,
                                 observed_remote_url, last_observed_head, last_observed_at,
                                 drift_state, registration, temporary_for_run, created_at)
       VALUES (?, ?, ?, 'OWNER_TRUSTED', ?, ?, ?, 'IN_SYNC', 'TEMPORARY', ?, ?)`,
      [
        repositoryId, identity, canonical(root), observedRemote,
        await tryRevParse(root, "HEAD"), this.clock.nowIso(), runId, this.clock.nowIso(),
      ],
    );
    this.audit.record({
      kind: "REPOSITORY_TEMPORARY_BINDING",
      runId,
      evidence: { identity, checkoutPath: canonical(root) },
    });
    return allow(ReasonCode.OK, this.byIdentity(identity)!);
  }

  /** Re-reads the checkout and records drift; a dirty or moved tree is DRIFTED. */
  async observe(repositoryId: string): Promise<RepositoryRecord | null> {
    const record = this.byId(repositoryId);
    if (!record) return null;

    const head = await tryRevParse(record.checkoutPath, "HEAD");
    const clean = head ? await isClean(record.checkoutPath) : false;
    const drift: RepositoryRecord["driftState"] =
      head === null ? "UNKNOWN" : head === record.lastObservedHead && clean ? "IN_SYNC" : "DRIFTED";

    this.db.run(
      `UPDATE repositories SET last_observed_head = ?, last_observed_at = ?, drift_state = ?
        WHERE repository_id = ?`,
      [head, this.clock.nowIso(), drift, repositoryId],
    );
    return this.byId(repositoryId);
  }

  /** Accept the current head as the new baseline after a legitimate managed change. */
  acknowledgeHead(repositoryId: string, head: string): void {
    this.db.run(
      `UPDATE repositories SET last_observed_head = ?, last_observed_at = ?, drift_state = 'IN_SYNC'
        WHERE repository_id = ?`,
      [head, this.clock.nowIso(), repositoryId],
    );
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
