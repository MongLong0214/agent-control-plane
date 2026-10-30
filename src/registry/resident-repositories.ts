import { residentWorkerCheckoutPath } from "../core/resident-allocation-paths.ts";
import type { Db } from "../db/database.ts";
import { canonical } from "../guard/workspace-probe.ts";

/**
 * #1227 — which registered repositories belong to a live resident, where the resident works (its clone,
 * its cwd) and where the repository's worker clone is. Reads only; the move is `worker-checkout.ts`.
 *
 * A registered repository whose project has a live resident, and where that resident works.
 */
export interface ResidentRepository {
  repositoryId: string;
  identity: string;
  projectId: string;
  /** The registered checkout, as the registry holds it. */
  checkoutPath: string;
  /** The resident's clone, its working directory: the provisioning allocation's `clonePath`. */
  clonePath: string;
  /** `residentWorkerCheckoutPath` of that clone and this repository. */
  workerCheckoutPath: string;
}

interface ResidentRow {
  repository_id: string;
  identity: string;
  project_id: string;
  checkout_path: string;
  clone_path: string;
}

/**
 * Every active repository of a project whose resident provisioning is live (PENDING or COMPLETE), for
 * the repository the allocation was made for. Optionally just one repository.
 */
export const residentRepositories = (db: Db, repositoryId?: string): ResidentRepository[] =>
  db
    .all<ResidentRow>(
      `SELECT r.repository_id, r.identity, r.project_id, r.checkout_path,
              json_extract(p.allocation_json, '$.clonePath') AS clone_path
         FROM resident_project_provisioning p
         JOIN repositories r ON r.project_id = p.project_id AND r.retired_at IS NULL
                            AND r.identity = json_extract(p.allocation_json, '$.repositoryIdentity')
        WHERE p.status IN ('PENDING', 'COMPLETE')
          AND json_type(p.allocation_json, '$.clonePath') = 'text'
          AND (? IS NULL OR r.repository_id = ?)
        ORDER BY r.repository_id`,
      [repositoryId ?? null, repositoryId ?? null],
    )
    .map((row) => {
      const clonePath = canonical(row.clone_path);
      return {
        repositoryId: row.repository_id,
        identity: row.identity,
        projectId: row.project_id,
        checkoutPath: row.checkout_path,
        clonePath,
        workerCheckoutPath: residentWorkerCheckoutPath(clonePath, row.repository_id),
      };
    });

/** The resident a repository belongs to, or null when its project has no live resident. */
export const residentRepository = (db: Db, repositoryId: string): ResidentRepository | null =>
  residentRepositories(db, repositoryId)[0] ?? null;

/**
 * Where a repository's base branch is read as its current base: the resident's clone, when the
 * registered checkout is that resident's worker clone, whose own base branch stays where the clone was
 * made; null when the registered checkout is its own base. The run's base pin (`task-write-target.ts`)
 * and every candidate freshness check (`verifySnapshotFreshness`, the CEO confirmation) take this one
 * answer, so the base a candidate was pinned to and the base it is held to are read in the same place.
 */
export const residentBaseClone = (db: Db, repositoryId: string, checkoutPath: string): string | null => {
  const resident = residentRepository(db, repositoryId);
  return resident && checkoutPath.length > 0 && canonical(checkoutPath) === resident.workerCheckoutPath ? resident.clonePath : null;
};

/**
 * Every clone a resident allocation names, whatever its state: the resident's own tree, which no
 * candidate command may read. Once its repository is registered at the worker checkout, no registry
 * row names the clone any more, so a deny list built from the registry alone would leave it open.
 */
export const residentClonePaths = (db: Db): string[] =>
  [...new Set(
    db
      .all<{ clone_path: string }>(
        `SELECT json_extract(allocation_json, '$.clonePath') AS clone_path FROM resident_project_provisioning
          WHERE json_type(allocation_json, '$.clonePath') = 'text' ORDER BY run_id`,
      )
      .map((row) => canonical(row.clone_path)),
  )];
