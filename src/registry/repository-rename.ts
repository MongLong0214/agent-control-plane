import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type { Clock } from "../core/clock.ts";
import { canonicalJson } from "../core/digest.ts";
import { allow, deny, isAcpError, type Decision } from "../core/errors.ts";
import { normalizeRemoteIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { assertPortableManifest, manifestDigest, type ProjectManifest } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { git } from "../git/git.ts";
import { nameSpanMatchSql, repositoryIdentities, repositoryNameSpansJson } from "./repository-identity-chain.ts";
import { parseGitHubIdentity, type ObservedRepository, type GitHubRepositoryTarget } from "../bootstrap/github-write-port.ts";

/**
 * The same GitHub repository under a new name (schema v61).
 *
 * GitHub keeps a repository's node id across a rename and answers the old path with a redirect, which ACP's
 * transport refuses, so every call ACP builds from the old `github:owner/name` fails once the owner renames
 * it. This adopts the new name for the same repository, and only for it: GitHub must answer the new name
 * with the node id the project's resident allocation recorded (for a repository no allocation names, the one
 * GitHub answered at its operator registration, `recordRegisteredNodeId`), and the new name as its full name. The
 * project must be quiet — no unfinished run, HELD claim or PENDING receipt of the repository — so nothing
 * in flight needs to accept either name, and no CI check is widened: new evidence must name the new full
 * name exactly, as the kernel already requires.
 *
 * One transaction records the rename (`repository_identity_renames`), stores the active manifest with that
 * one remote changed, moves the project's pointer to it (the move the v61 pointer guard admits for a
 * recorded rename), and renames the repository row. Rows written once under the old name (receipts,
 * verification results, the bootstrap application, the allocation) stay as they are and are read through
 * the rename record. Then each local clone's `origin` is set to the new URL. Every step is read from the
 * world first, so the same command run again continues where it stopped; run again after it finished, it
 * changes nothing and says the repository is already renamed.
 *
 * The clones are pointed at the new URL rather than ACP tolerating the old one: GitHub redirects an old name
 * only until another repository takes it, and a push to it would then reach that repository.
 *
 * A reader that matches one of those write-once identity columns against `repositories.identity` has to match
 * `repositoryIdentities` (or `currentRepositoryIdentity` for the allocation), or a row written before a rename
 * stops being the repository's.
 */

/**
 * The audit kind holding the node id GitHub answered for a repository at its operator registration. An
 * append-only event rather than a `repositories` column, which would take a schema version for one value.
 * The rename trusts it, so nothing but `recordRegisteredNodeId` writes this kind.
 */
export const REPOSITORY_NODE_ID_RECORDED = "REPOSITORY_NODE_ID_RECORDED";

/**
 * Why `recordRegisteredNodeId` recorded nothing: a fixed code and at most GitHub's HTTP status, rather than
 * the error's text or anything of GitHub's answer, which can carry a request header or a private body.
 */
export const RepositoryNodeIdUnrecorded = {
  NOT_GITHUB_REPOSITORY: "NODE_ID_NOT_GITHUB_REPOSITORY",
  LOOKUP_FAILED: "NODE_ID_LOOKUP_FAILED",
  NOT_ON_GITHUB: "NODE_ID_NOT_ON_GITHUB",
  /** GitHub answers the registered name with another full name. */
  OTHER_FULL_NAME: "NODE_ID_OTHER_FULL_NAME",
  /** The repository row changed while GitHub was asked. */
  STATE_MOVED: "NODE_ID_STATE_MOVED",
  ALREADY_RECORDED: "NODE_ID_ALREADY_RECORDED",
  AUDIT_REFUSED: "NODE_ID_AUDIT_REFUSED",
} as const;

export interface NodeIdUnrecorded {
  code: (typeof RepositoryNodeIdUnrecorded)[keyof typeof RepositoryNodeIdUnrecorded];
  status?: number;
}

/** GitHub's HTTP status on a failed read, when the transport named one; nothing else of the error. */
const httpStatusOf = (error: unknown): number | undefined => {
  const status = isAcpError(error) ? error.evidence["status"] : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
};

/** Why a rename was refused: one stable code per refusal, in `evidence.refusal`. */
export const RepositoryRenameRefusal = {
  NAME_INVALID: "REPOSITORY_RENAME_NAME_INVALID",
  PROJECT_NOT_FOUND: "REPOSITORY_RENAME_PROJECT_NOT_FOUND",
  REPOSITORY_NOT_FOUND: "REPOSITORY_RENAME_REPOSITORY_NOT_FOUND",
  /** The repository already holds this name and no rename gave it to it. */
  NO_CHANGE: "REPOSITORY_RENAME_NO_CHANGE",
  /** Another registered repository holds the new name. */
  NAME_TAKEN: "REPOSITORY_RENAME_NAME_TAKEN",
  /** No node id is recorded for this repository, so "the same repository" cannot be shown. */
  NODE_ID_UNRECORDED: "REPOSITORY_RENAME_NODE_ID_UNRECORDED",
  /** The active manifest does not name this repository's current identity for its role exactly once. */
  MANIFEST_REMOTE_MISMATCH: "REPOSITORY_RENAME_MANIFEST_REMOTE_MISMATCH",
  /** The renamed manifest changes a repository's role, or the repositories' count or order. */
  ROLE_CHANGED: "REPOSITORY_RENAME_ROLE_CHANGED",
  /** The renamed manifest differs from the active one by more than the one remote. */
  MANIFEST_DIFFERS: "REPOSITORY_RENAME_MANIFEST_DIFFERS",
  /** GitHub has no repository at the new name. */
  NAME_NOT_ON_GITHUB: "REPOSITORY_RENAME_NAME_NOT_ON_GITHUB",
  /** GitHub's repository at the new name is not the one at the recorded node id. */
  DIFFERENT_REPOSITORY: "REPOSITORY_RENAME_DIFFERENT_REPOSITORY",
  /** GitHub answered the new name with another full name: the new name is not the repository's own. */
  NOT_GITHUB_NAME: "REPOSITORY_RENAME_NOT_GITHUB_NAME",
  GITHUB_UNREADABLE: "REPOSITORY_RENAME_GITHUB_UNREADABLE",
  /** A run, claim or receipt of the repository has not finished. */
  PROJECT_BUSY: "REPOSITORY_RENAME_PROJECT_BUSY",
  /** The repository or the project's manifest changed between the read and the write. */
  STATE_MOVED: "REPOSITORY_RENAME_STATE_MOVED",
} as const;

export interface RepositoryRenameRequest {
  projectId: string;
  /** The new name, `owner/name` or `github:owner/name`. */
  to: string;
  /** The manifest role of the repository renamed; `primary` when omitted. */
  role?: string;
  /** Without it nothing is written: the plan is returned. */
  apply: boolean;
}

/** One local clone of the repository and what its `origin` needs. */
export interface CloneRemote {
  path: string;
  /** CURRENT: names the new name. STALE: names the old one and is set to `next`. MISSING/NO_ORIGIN/FOREIGN: left alone. */
  state: "CURRENT" | "STALE" | "MISSING" | "NO_ORIGIN" | "FOREIGN";
  url: string | null;
  next: string | null;
  /** After --apply: whether `git remote set-url` left `origin` at `next`. */
  result?: "SET" | "FAILED";
  error?: string;
}

export interface RepositoryRenamePlan {
  mode: "dry-run" | "apply";
  /** PLANNED: dry run. RENAMED: this call renamed it. ALREADY_RENAMED: a rename to this name is recorded. */
  state: "PLANNED" | "RENAMED" | "ALREADY_RENAMED";
  projectId: string;
  repositoryId: string;
  role: string;
  from: string;
  to: string;
  repositoryNodeId: string;
  fromManifestDigest: string;
  toManifestDigest: string;
  renameId: string | null;
  clones: CloneRemote[];
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface RepositoryRenamePorts {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  /** GitHub's answer for a name: the repository there, or null on a 404. */
  github: { observeRepository(target: GitHubRepositoryTarget): Promise<ObservedRepository | null> };
  git?: GitRunner;
}

interface RepositoryRow {
  repository_id: string;
  identity: string;
  checkout_path: string;
  observed_remote_url: string | null;
}

interface RenameRow {
  rename_id: string;
  from_identity: string;
  to_identity: string;
  repository_node_id: string;
  from_manifest_digest: string;
  to_manifest_digest: string;
}

const refuse = <T>(reasonCode: ReasonCode, refusal: string, message: string, evidence: Record<string, unknown> = {}): Decision<T> =>
  deny(reasonCode, message, { refusal, ...evidence });

/** `github:owner/name` for `owner/name` or `github:owner/name`, or null. */
export const renameTargetIdentity = (to: string): string | null => {
  const identity = to.startsWith("github:") ? to : `github:${to}`;
  const parsed = parseGitHubIdentity(identity);
  return parsed === null || parsed.ref !== null ? null : identity;
};

/** The manifest with the one entry for `role` naming `to` instead of `from`; nothing else changes. */
export const renamedManifest = (base: ProjectManifest, role: string, to: string): ProjectManifest => ({
  ...base,
  repositories: base.repositories.map((repository) => (repository.role === role ? { ...repository, remote: to } : repository)),
});

/**
 * The one difference a rename may make between two manifests: the entry for `role` names `from` in the base
 * and `to` in the candidate. Refused when the repositories differ in count, order or role, when any other
 * entry changes, or when anything outside `repositories` differs.
 */
export const renameManifestDiff = (base: ProjectManifest, candidate: ProjectManifest, role: string, from: string, to: string): Decision<void> => {
  const before = base.repositories;
  const after = candidate.repositories;
  if (before.length !== after.length || before.some((repository, index) => repository.role !== after[index]!.role)) {
    return refuse(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, RepositoryRenameRefusal.ROLE_CHANGED,
      "a rename keeps every repository's role, count and order; only the renamed repository's remote changes", {
        base: before.map((repository) => repository.role), candidate: after.map((repository) => repository.role),
      });
  }
  const changed = before.flatMap((repository, index) => (canonicalJson(repository) === canonicalJson(after[index]) ? [] : [index]));
  const renamed = before.findIndex((repository) => repository.role === role);
  const expected = renamed >= 0 && before[renamed]!.remote === from
    && canonicalJson(after[renamed]) === canonicalJson({ ...before[renamed]!, remote: to });
  if (!expected || changed.length !== 1 || changed[0] !== renamed
      || canonicalJson({ ...candidate, repositories: before }) !== canonicalJson(base)) {
    return refuse(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, RepositoryRenameRefusal.MANIFEST_DIFFERS,
      "a rename changes exactly one thing in the manifest: the renamed repository's remote, from its old name to its new one", {
        role, from, to,
      });
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * `url` with its GitHub `owner/name` replaced by `to`'s, keeping its scheme, user and `.git` suffix; null when
 * `url` does not name `from`.
 */
export const renamedRemoteUrl = (url: string, from: string, to: string): string | null => {
  if (!sameIdentity(normalizeRemoteIdentity(url), from)) return null;
  const target = parseGitHubIdentity(to);
  const match = /^(.*github\.com[:/]+)[^/]+\/[^/]+?(\.git)?\/?$/.exec(url.trim());
  if (target === null || match === null) return null;
  return `${match[1]}${target.owner}/${target.name}${match[2] ?? ""}`;
};

/** GitHub names are case-insensitive. */
const sameIdentity = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export { currentRepositoryIdentity, repositoryIdentities } from "./repository-identity-chain.ts";

export class RepositoryRenames {
  private readonly runGit: GitRunner;

  constructor(private readonly ports: RepositoryRenamePorts) {
    this.runGit = ports.git ?? ((cwd, args) => git(cwd, args, { allowFailure: true }));
  }

  /**
   * Records the node id GitHub answers for a repository the operator has just registered, so a later rename
   * can show a new name is the same repository. It is read at the exact registered `owner/name` and kept only
   * when GitHub answers that name as the repository's own full name. Anything else (not a GitHub repository,
   * no repository there, a redirect, an unreadable answer, another full name) records nothing: the
   * registration stands as it did before, and a rename of the repository stays refused.
   */
  async recordRegisteredNodeId(repositoryId: string): Promise<{ repositoryNodeId: string | null; unrecorded?: NodeIdUnrecorded }> {
    const unrecorded = (code: NodeIdUnrecorded["code"], status?: number) =>
      ({ repositoryNodeId: null, unrecorded: { code, ...(status === undefined ? {} : { status }) } });
    const registered = () => this.ports.db.get<{ identity: string; project_id: string | null }>(
      `SELECT identity, project_id FROM repositories WHERE repository_id = ? AND registration = 'REGISTERED' AND retired_at IS NULL`,
      [repositoryId]);
    const repository = registered();
    const target = repository === undefined ? null : parseGitHubIdentity(repository.identity);
    if (repository === undefined || target === null || target.ref !== null) return unrecorded(RepositoryNodeIdUnrecorded.NOT_GITHUB_REPOSITORY);
    let observed: ObservedRepository | null;
    try {
      observed = await this.ports.github.observeRepository({ owner: target.owner, name: target.name });
    } catch (error) {
      return unrecorded(RepositoryNodeIdUnrecorded.LOOKUP_FAILED, httpStatusOf(error));
    }
    if (observed === null) return unrecorded(RepositoryNodeIdUnrecorded.NOT_ON_GITHUB, 404);
    if (!sameIdentity(`github:${observed.fullName}`, repository.identity)) return unrecorded(RepositoryNodeIdUnrecorded.OTHER_FULL_NAME);
    // Read again after the await: still this repository under this name, and nothing recorded for it meanwhile.
    if (registered()?.identity !== repository.identity) return unrecorded(RepositoryNodeIdUnrecorded.STATE_MOVED);
    if (this.registeredNodeIds(repositoryId, repository.identity).length > 0) return unrecorded(RepositoryNodeIdUnrecorded.ALREADY_RECORDED);
    const recorded = this.ports.audit.record({
      kind: REPOSITORY_NODE_ID_RECORDED,
      projectId: repository.project_id,
      evidence: { repositoryId, identity: repository.identity, repositoryNodeId: observed.nodeId },
    });
    return recorded.allowed ? { repositoryNodeId: observed.nodeId } : unrecorded(RepositoryNodeIdUnrecorded.AUDIT_REFUSED);
  }

  async rename(request: RepositoryRenameRequest): Promise<Decision<RepositoryRenamePlan>> {
    const { db } = this.ports;
    const role = request.role ?? "primary";
    const to = renameTargetIdentity(request.to);
    if (to === null) {
      return refuse(ReasonCode.INVALID_ARGUMENT, RepositoryRenameRefusal.NAME_INVALID, "the new name must be a GitHub owner/name", { to: request.to });
    }
    const project = db.get<{ retired_at: string | null; active_manifest_digest: string | null }>(
      `SELECT retired_at, active_manifest_digest FROM projects WHERE project_id = ?`, [request.projectId]);
    if (!project || project.retired_at !== null) {
      return refuse(ReasonCode.NOT_FOUND, RepositoryRenameRefusal.PROJECT_NOT_FOUND, "no live project has this id", { projectId: request.projectId });
    }
    const repository = this.repositoryOf(request.projectId, role);
    if (!repository) {
      return refuse(ReasonCode.NOT_FOUND, RepositoryRenameRefusal.REPOSITORY_NOT_FOUND, "the project has no registered repository in this role", {
        projectId: request.projectId, role,
      });
    }

    // Already done: a recorded rename gave the repository this name. Only the local clones may be left.
    if (sameIdentity(repository.identity, to)) {
      const done = db.get<RenameRow>(
        `SELECT rename_id, from_identity, to_identity, repository_node_id, from_manifest_digest, to_manifest_digest
           FROM repository_identity_renames WHERE repository_id = ? AND to_identity = ?
          ORDER BY sequence DESC LIMIT 1`,
        [repository.repository_id, repository.identity],
      );
      if (!done) {
        return refuse(ReasonCode.INVALID_ARGUMENT, RepositoryRenameRefusal.NO_CHANGE, "the repository already has this name", { identity: repository.identity });
      }
      const clones = await this.clones(request.projectId, repository, done.from_identity, done.to_identity);
      return allow(ReasonCode.OK, {
        mode: request.apply ? "apply" : "dry-run", state: "ALREADY_RENAMED", projectId: request.projectId, repositoryId: repository.repository_id,
        role, from: done.from_identity, to: done.to_identity, repositoryNodeId: done.repository_node_id,
        fromManifestDigest: done.from_manifest_digest, toManifestDigest: done.to_manifest_digest, renameId: done.rename_id,
        clones: request.apply ? await this.setOrigins(clones) : clones,
      });
    }

    const from = repository.identity;
    const taken = db.get<{ repository_id: string }>(
      `SELECT repository_id FROM repositories WHERE identity = ? COLLATE NOCASE AND retired_at IS NULL AND repository_id <> ?`,
      [to, repository.repository_id]);
    if (taken) {
      return refuse(ReasonCode.CONFLICT, RepositoryRenameRefusal.NAME_TAKEN, "another registered repository holds the new name", { to, repositoryId: taken.repository_id });
    }
    const nodeId = this.recordedNodeId(request.projectId, repository);
    if (nodeId === null) {
      return refuse(ReasonCode.EVIDENCE_MISSING, RepositoryRenameRefusal.NODE_ID_UNRECORDED,
        "no GitHub node id is recorded for this repository, so the new name cannot be shown to be the same repository", { from, to });
    }
    const base = this.manifestOf(project.active_manifest_digest);
    if (base === null || base.manifest.repositories.filter((entry) => entry.role === role && entry.remote === from).length !== 1
        || base.manifest.repositories.filter((entry) => entry.role === role).length !== 1) {
      return refuse(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, RepositoryRenameRefusal.MANIFEST_REMOTE_MISMATCH,
        "the project's active manifest does not name this repository's identity for its role exactly once", {
          role, identity: from, activeManifestDigest: project.active_manifest_digest,
        });
    }
    const renamedIndex = base.manifest.repositories.findIndex((entry) => entry.role === role);
    const candidate = renamedManifest(base.manifest, role, to);
    const diff = renameManifestDiff(base.manifest, candidate, role, from, to);
    if (!diff.allowed) return diff as Decision<never>;
    const portable = assertPortableManifest(candidate);
    if (!portable.allowed) return portable as Decision<never>;
    const toManifestDigest = manifestDigest(portable.value);

    // The same repository: GitHub answers the new name with the recorded node id and the new name as its own.
    const target = parseGitHubIdentity(to)!;
    let observed: ObservedRepository | null;
    try {
      observed = await this.ports.github.observeRepository({ owner: target.owner, name: target.name });
    } catch (error) {
      // The fixed refusal and at most GitHub's HTTP status, rather than the error's text, which can carry a
      // request header or a private body.
      const status = httpStatusOf(error);
      return refuse(ReasonCode.INTERNAL_ERROR, RepositoryRenameRefusal.GITHUB_UNREADABLE, "GitHub's answer for the new name could not be read; nothing was changed", {
        to, ...(status === undefined ? {} : { status }),
      });
    }
    if (observed === null) {
      return refuse(ReasonCode.NOT_FOUND, RepositoryRenameRefusal.NAME_NOT_ON_GITHUB, "GitHub has no repository at the new name", { to });
    }
    if (observed.nodeId !== nodeId) {
      return refuse(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, RepositoryRenameRefusal.DIFFERENT_REPOSITORY,
        "the repository at the new name is not the one at the recorded node id; nothing was changed", {
          to, recordedNodeId: nodeId, observedNodeId: observed.nodeId,
        });
    }
    if (!sameIdentity(`github:${observed.fullName}`, to)) {
      return refuse(ReasonCode.REPOSITORY_IDENTITY_MISMATCH, RepositoryRenameRefusal.NOT_GITHUB_NAME,
        "GitHub answers the new name with another full name, so it is not the repository's own name", { to, fullName: observed.fullName });
    }
    const busy = this.busy(request.projectId, repository);
    if (busy !== null) return busy as Decision<never>;

    const clones = await this.clones(request.projectId, repository, from, to);
    const plan: RepositoryRenamePlan = {
      mode: request.apply ? "apply" : "dry-run", state: "PLANNED", projectId: request.projectId, repositoryId: repository.repository_id,
      role, from, to, repositoryNodeId: nodeId, fromManifestDigest: base.digest, toManifestDigest, renameId: null, clones,
    };
    if (!request.apply) return allow(ReasonCode.OK, plan);

    const renameId = `ren_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const written = db.txDecision((): Decision<void> => {
      // Read again inside the transaction: the GitHub answer above was awaited, and anything may have moved.
      const now = this.repositoryOf(request.projectId, role);
      const pointer = db.get<{ active_manifest_digest: string | null }>(`SELECT active_manifest_digest FROM projects WHERE project_id = ?`, [request.projectId]);
      if (now?.repository_id !== repository.repository_id || now.identity !== from || pointer?.active_manifest_digest !== base.digest) {
        return refuse(ReasonCode.CONFLICT, RepositoryRenameRefusal.STATE_MOVED, "the repository or the project's manifest changed while GitHub was asked; run the command again", {
          from, to,
        });
      }
      const stillBusy = this.busy(request.projectId, repository);
      if (stillBusy !== null) return stillBusy;
      // The stored manifest is the active one's own text with that one remote set, as the rename guard compares
      // it; its digest is the one planned, or the text moved since the plan.
      const content = db.get<{ content: string }>(`SELECT json_set(content_json, ?, ?) AS content FROM manifests WHERE digest = ?`,
        [`$.repositories[${renamedIndex}].remote`, to, base.digest])!.content;
      const stored = assertPortableManifest(JSON.parse(content) as unknown);
      if (!stored.allowed || manifestDigest(stored.value) !== toManifestDigest) {
        return refuse(ReasonCode.CONFLICT, RepositoryRenameRefusal.STATE_MOVED, "the renamed manifest is not the one planned; run the command again", { from, to });
      }
      if (!db.get(`SELECT 1 FROM manifests WHERE digest = ?`, [toManifestDigest])) {
        db.run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`,
          [toManifestDigest, stored.value.schema, content, this.ports.clock.nowIso()]);
      }
      const sequence = db.get<{ next: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM repository_identity_renames WHERE project_id = ?`, [request.projectId])!.next;
      db.run(
        `INSERT INTO repository_identity_renames (rename_id, repository_id, project_id, sequence, from_identity, to_identity, repository_node_id,
                                                  from_manifest_digest, to_manifest_digest, renamed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [renameId, repository.repository_id, request.projectId, sequence, from, to, nodeId, base.digest, toManifestDigest, this.ports.clock.nowIso()],
      );
      db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [toManifestDigest, request.projectId]);
      // The checkout's content did not change, so its drift state stands; only the contract it was read under is the new one.
      db.run(`UPDATE repositories SET active_manifest_digest = ? WHERE project_id = ? AND active_manifest_digest IS ?`,
        [toManifestDigest, request.projectId, base.digest]);
      const observedRemoteUrl = repository.observed_remote_url === null ? null : renamedRemoteUrl(repository.observed_remote_url, from, to) ?? repository.observed_remote_url;
      db.run(`UPDATE repositories SET identity = ?, observed_remote_url = ? WHERE repository_id = ?`, [to, observedRemoteUrl, repository.repository_id]);
      const recorded = this.ports.audit.record({
        kind: "REPOSITORY_RENAMED",
        projectId: request.projectId,
        evidence: { renameId, repositoryId: repository.repository_id, role, from, to, repositoryNodeId: nodeId, fromManifestDigest: base.digest, toManifestDigest },
      });
      return recorded.allowed ? allow(ReasonCode.OK, undefined) : (recorded as Decision<void>);
    });
    if (!written.allowed) return written as Decision<never>;
    return allow(ReasonCode.OK, { ...plan, state: "RENAMED", renameId, clones: await this.setOrigins(clones) });
  }

  private repositoryOf(projectId: string, role: string): RepositoryRow | undefined {
    return this.ports.db.get<RepositoryRow>(
      `SELECT repository_id, identity, checkout_path, observed_remote_url FROM repositories
        WHERE project_id = ? AND repository_role = ? AND retired_at IS NULL AND registration = 'REGISTERED'
        ORDER BY created_at, repository_id LIMIT 1`,
      [projectId, role],
    );
  }

  private manifestOf(digest: string | null): { digest: string; manifest: ProjectManifest } | null {
    if (digest === null) return null;
    const row = this.ports.db.get<{ content_json: string }>(`SELECT content_json FROM manifests WHERE digest = ?`, [digest]);
    return row ? { digest, manifest: JSON.parse(row.content_json) as ProjectManifest } : null;
  }

  /** The project's resident allocation, when it was made for this repository (under any name it has held). */
  private allocation(projectId: string, repository: RepositoryRow): { nodeId: unknown; clonePath: unknown } | null {
    const row = this.ports.db.get<{ identity: unknown; nodeId: unknown; clonePath: unknown }>(
      `SELECT json_extract(allocation_json, '$.repositoryIdentity') AS identity, json_extract(allocation_json, '$.repositoryNodeId') AS nodeId,
              json_extract(allocation_json, '$.clonePath') AS clonePath
         FROM resident_project_provisioning WHERE project_id = ?`,
      [projectId],
    );
    if (!row || typeof row.identity !== "string") return null;
    if (sameIdentity(row.identity, repository.identity)) return row;
    // An earlier name of this repository: the allocation's node id is the repository's own, so a name another
    // repository has taken since still resolves here and nowhere else.
    return this.ports.db.get(
      `SELECT 1 FROM repository_identity_renames WHERE repository_id = ? AND lower(from_identity) = lower(?) AND repository_node_id IS ?`,
      [repository.repository_id, row.identity, row.nodeId],
    ) ? row : null;
  }

  /**
   * The node ids `recordRegisteredNodeId` recorded for this repository row under the exact name it was
   * registered with: its first rename's `from`, or its name when it has none. Distinct.
   */
  private registeredNodeIds(repositoryId: string, identity: string): unknown[] {
    return this.ports.db.all<{ nodeId: unknown }>(
      `SELECT DISTINCT json_extract(e.evidence_json, '$.repositoryNodeId') AS nodeId FROM audit_events e
        WHERE e.kind = ? AND json_extract(e.evidence_json, '$.repositoryId') = ?
          AND json_extract(e.evidence_json, '$.identity') = COALESCE(
            (SELECT r.from_identity FROM repository_identity_renames r WHERE r.repository_id = ? ORDER BY r.sequence LIMIT 1), ?)`,
      [REPOSITORY_NODE_ID_RECORDED, repositoryId, repositoryId, identity],
    ).map((row) => row.nodeId);
  }

  /**
   * The resident allocation's node id when an allocation names this repository, whatever it holds; otherwise
   * the one node id recorded at its operator registration. Neither fills in for the other, and registration
   * records that disagree are none.
   */
  private recordedNodeId(projectId: string, repository: RepositoryRow): string | null {
    const allocation = this.allocation(projectId, repository);
    const registered = allocation === null ? this.registeredNodeIds(repository.repository_id, repository.identity) : [];
    const nodeId = allocation !== null ? allocation.nodeId : registered.length === 1 ? registered[0] : null;
    return typeof nodeId === "string" && /^[\x21-\x7e]{1,256}$/.test(nodeId) ? nodeId : null;
  }

  /** The refusal when the repository has work in flight: an unfinished run, a HELD claim or a PENDING receipt. */
  private busy(projectId: string, repository: RepositoryRow): Decision<void> | null {
    const { db } = this.ports;
    const terminal = TERMINAL_RUN_STATES.map(() => "?").join(", ");
    const runs = db.all<{ run_id: string; state: string }>(
      `SELECT r.run_id, r.state FROM runs r
        WHERE r.state NOT IN (${terminal})
          AND (r.project_id = ? OR EXISTS (SELECT 1 FROM run_repositories rr WHERE rr.run_id = r.run_id AND rr.repository_id = ?))
        ORDER BY r.run_id`,
      [...TERMINAL_RUN_STATES, projectId, repository.repository_id],
    );
    // Under every name the repository has held, in any letter case, and only while it held it: a name freed by a
    // rename may be taken by another repository, whose claims and receipts under it are not this one's work.
    const spans = repositoryNameSpansJson(db, repository.repository_id, repository.identity);
    const claims = db.all<{ claim_id: string }>(
      `SELECT c.claim_id FROM resource_claims c WHERE c.status = 'HELD' AND ${nameSpanMatchSql("c.repository_identity", "c.acquired_at")}
        ORDER BY c.claim_id`, [spans]);
    const receipts = db.all<{ receipt_id: string }>(
      `SELECT g.receipt_id FROM github_receipts g WHERE g.status = 'PENDING' AND ${nameSpanMatchSql("g.repository_identity", "g.created_at")}
        ORDER BY g.receipt_id`, [spans]);
    if (runs.length === 0 && claims.length === 0 && receipts.length === 0) return null;
    return refuse(ReasonCode.CONFLICT, RepositoryRenameRefusal.PROJECT_BUSY,
      "the repository has work in flight; a rename waits until every run, claim and receipt of it has finished", {
        runs: runs.map((run) => ({ runId: run.run_id, state: run.state })),
        claims: claims.map((claim) => claim.claim_id),
        receipts: receipts.map((receipt) => receipt.receipt_id),
      });
  }

  /** The registered checkout and the resident's clone, each with what its `origin` needs. */
  private async clones(projectId: string, repository: RepositoryRow, from: string, to: string): Promise<CloneRemote[]> {
    const clonePath = this.allocation(projectId, repository)?.clonePath;
    const paths = [...new Set([repository.checkout_path, ...(typeof clonePath === "string" ? [clonePath] : [])])];
    const formerNames = repositoryIdentities(this.ports.db, repository.repository_id, repository.identity).concat(from);
    const clones: CloneRemote[] = [];
    for (const path of paths) {
      if (!existsSync(path)) {
        clones.push({ path, state: "MISSING", url: null, next: null });
        continue;
      }
      const read = await this.runGit(path, ["remote", "get-url", "origin"]);
      const url = read.exitCode === 0 ? read.stdout.trim() : "";
      if (url === "") {
        clones.push({ path, state: "NO_ORIGIN", url: null, next: null });
        continue;
      }
      const identity = normalizeRemoteIdentity(url);
      if (sameIdentity(identity, to)) {
        clones.push({ path, state: "CURRENT", url, next: null });
        continue;
      }
      const former = formerNames.find((name) => sameIdentity(name, identity));
      const next = former === undefined ? null : renamedRemoteUrl(url, former, to);
      clones.push(next === null ? { path, state: "FOREIGN", url, next: null } : { path, state: "STALE", url, next });
    }
    return clones;
  }

  /** Sets each stale clone's `origin` to its new URL and reads it back. */
  private async setOrigins(clones: CloneRemote[]): Promise<CloneRemote[]> {
    const settled: CloneRemote[] = [];
    for (const clone of clones) {
      if (clone.state !== "STALE" || clone.next === null) {
        settled.push(clone);
        continue;
      }
      const set = await this.runGit(clone.path, ["remote", "set-url", "origin", clone.next]);
      const read = await this.runGit(clone.path, ["remote", "get-url", "origin"]);
      settled.push(set.exitCode === 0 && read.exitCode === 0 && read.stdout.trim() === clone.next
        ? { ...clone, result: "SET" }
        : { ...clone, result: "FAILED", error: (set.stderr || read.stderr).trim().slice(0, 300) });
    }
    return settled;
  }
}
