import type { Db } from "../db/database.ts";

/**
 * v61 — the names one repository has held, read from `repository_identity_renames`. Rows written once under a
 * repository's old name (receipts, verification results, claims, bootstrap results, the resident allocation)
 * keep that name, so a reader that matches one of them against a repository has to match every name in the
 * chain. Reads only, and imports nothing but the database type, so the kernel, the finalizer and the guards
 * can use it without reaching the rename command.
 */

/**
 * Every identity the repository has held: its current one first, then each it was renamed from. A record
 * written once under an old name is the repository's when it names any of them.
 */
export const repositoryIdentities = (db: Db, repositoryId: string, current: string): string[] => [
  current,
  ...db.all<{ from_identity: string }>(
    `SELECT DISTINCT from_identity FROM repository_identity_renames WHERE repository_id = ? AND from_identity <> ? ORDER BY from_identity`,
    [repositoryId, current],
  ).map((row) => row.from_identity),
];

/**
 * The whole chain of the repository that holds `identity` now, or held it before a rename: its current identity
 * first, then the earlier ones. A repository holding `identity` now is preferred over one that was renamed away
 * from it, so a new repository registered under a freed name does not take on the old one's history. `[identity]`
 * when no registered repository holds it and no rename names it.
 */
export const identityChain = (db: Db, identity: string): string[] => {
  const holder = db.get<{ repository_id: string; identity: string }>(
    `SELECT repository_id, identity FROM repositories WHERE identity = ? AND retired_at IS NULL
      ORDER BY created_at, repository_id LIMIT 1`,
    [identity],
  ) ?? db.get<{ repository_id: string; identity: string }>(
    `SELECT r.repository_id, r.identity FROM repository_identity_renames n JOIN repositories r ON r.repository_id = n.repository_id
      WHERE n.from_identity = ? AND r.retired_at IS NULL
      ORDER BY n.project_id, n.sequence DESC LIMIT 1`,
    [identity],
  );
  return holder === undefined ? [identity] : repositoryIdentities(db, holder.repository_id, holder.identity);
};

/** `identityChain` as the JSON array a `repository_identity IN (SELECT value FROM json_each(?))` predicate binds. */
export const identityChainJson = (db: Db, identity: string): string => JSON.stringify(identityChain(db, identity));

/**
 * The identity the repository GitHub knows by `nodeId` holds now, for an identity recorded under an earlier
 * name of it (the resident allocation's): the renamed repository's current identity, or `identity` itself
 * when no rename of it is recorded.
 */
export const currentRepositoryIdentity = (db: Db, identity: string, nodeId: unknown): string =>
  typeof nodeId !== "string" ? identity : db.get<{ identity: string }>(
    `SELECT r.identity FROM repository_identity_renames n JOIN repositories r ON r.repository_id = n.repository_id
      WHERE n.from_identity = ? AND n.repository_node_id = ? AND r.retired_at IS NULL
      ORDER BY n.project_id, n.sequence DESC LIMIT 1`,
    [identity, nodeId],
  )?.identity ?? identity;
