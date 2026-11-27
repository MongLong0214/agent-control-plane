import type { Db } from "../db/database.ts";

/**
 * v61 — the names one repository has held, read from `repository_identity_renames`. Rows written once under a
 * repository's old name (receipts, verification results, claims, bootstrap results, the resident allocation)
 * keep that name, so a reader that matches one of them against a repository has to match every name in the
 * chain. Reads only, and imports nothing but the database type, so the kernel, the finalizer and the guards
 * can use it without reaching the rename command.
 */

/**
 * One stretch of time in which a repository held a name: from `from` (inclusive) until `until` (exclusive), an open
 * end being null. A name is bound to the repository by the stretch it was valid in, not by the text alone: GitHub
 * frees a name when its repository is renamed, and another repository may take it.
 */
export interface RepositoryNameSpan {
  identity: string;
  from: string | null;
  until: string | null;
}

interface RenameSpanRow {
  from_identity: string;
  to_identity: string;
  renamed_at: string;
}

/**
 * The names the repository `repositoryId` held, each with when it held it. A name's stretch starts at the rename that
 * gave it (open before the first one) and ends at the rename that took it away (open for the current one); when
 * another repository left that name before this one held it, the stretch starts no earlier than that departure, so a
 * repository that takes a freed name does not take on the history of the one that left it.
 */
export const repositoryNameSpans = (db: Db, repositoryId: string, current: string): RepositoryNameSpan[] => {
  const renames = db.all<RenameSpanRow>(
    `SELECT from_identity, to_identity, renamed_at FROM repository_identity_renames WHERE repository_id = ? ORDER BY sequence`,
    [repositoryId],
  );
  const holdings: RepositoryNameSpan[] = renames.length === 0
    ? [{ identity: current, from: null, until: null }]
    : [
        ...renames.map((rename, index) => ({ identity: rename.from_identity, from: index === 0 ? null : renames[index - 1]!.renamed_at, until: rename.renamed_at })),
        { identity: renames[renames.length - 1]!.to_identity, from: renames[renames.length - 1]!.renamed_at, until: null },
      ];
  return holdings.map((holding) => {
    const others = db.get<{ departed: string | null; held: number }>(
      `SELECT (SELECT MAX(renamed_at) FROM repository_identity_renames
                WHERE repository_id <> ? AND lower(from_identity) = lower(?) AND (? IS NULL OR renamed_at < ?)) AS departed,
              (EXISTS (SELECT 1 FROM repositories WHERE repository_id <> ? AND lower(identity) = lower(?))
               OR EXISTS (SELECT 1 FROM repository_identity_renames WHERE repository_id <> ? AND (lower(from_identity) = lower(?) OR lower(to_identity) = lower(?)))) AS held`,
      [repositoryId, holding.identity, holding.until, holding.until, repositoryId, holding.identity, repositoryId, holding.identity, holding.identity],
    );
    // A name no other repository has held is this repository's whenever a row wrote it, as before v61 read it; the
    // stretch only bounds a name that changed hands.
    const until = others?.held ? holding.until : null;
    const departed = others?.departed ?? null;
    const from = departed !== null && (holding.from === null || departed > holding.from) ? departed : holding.from;
    return { ...holding, from: others?.held ? from : null, until };
  });
};

/** `repositoryNameSpans` as the JSON array `nameSpanMatchSql` binds. */
export const repositoryNameSpansJson = (db: Db, repositoryId: string, current: string): string =>
  JSON.stringify(repositoryNameSpans(db, repositoryId, current).map((span) => ({ identity: span.identity.toLowerCase(), from: span.from, until: span.until })));

/**
 * A predicate that is true when the row's `identityColumn` names the repository whose spans (`repositoryNameSpansJson`)
 * the `?` binds, in the stretch that held it at `atColumn`, in any letter case. The one place a row written under a
 * name is attributed to a repository when the name may have changed hands since.
 */
export const nameSpanMatchSql = (identityColumn: string, atColumn: string): string =>
  `EXISTS (SELECT 1 FROM json_each(?) s
            WHERE json_extract(s.value, '$.identity') = lower(${identityColumn})
              AND (json_extract(s.value, '$.from') IS NULL OR ${atColumn} >= json_extract(s.value, '$.from'))
              AND (json_extract(s.value, '$.until') IS NULL OR ${atColumn} < json_extract(s.value, '$.until')))`;

/**
 * Every identity the repository has held that is the repository's alone: its current one first, then each it was
 * renamed from, except a name another repository has held too (it took the freed name). Such a name is not the
 * repository's by its text; a row under it belongs to one repository or the other by when it was written, which
 * `repositoryNameSpans` and `identityChain`'s `at` answer.
 */
export const repositoryIdentities = (db: Db, repositoryId: string, current: string): string[] => [
  current,
  ...db.all<{ from_identity: string }>(
    `SELECT DISTINCT n.from_identity FROM repository_identity_renames n
      WHERE n.repository_id = ? AND n.from_identity <> ?
        AND NOT EXISTS (SELECT 1 FROM repositories o WHERE o.repository_id <> n.repository_id AND lower(o.identity) = lower(n.from_identity))
        AND NOT EXISTS (SELECT 1 FROM repository_identity_renames m
                         WHERE m.repository_id <> n.repository_id
                           AND (lower(m.from_identity) = lower(n.from_identity) OR lower(m.to_identity) = lower(n.from_identity)))
      ORDER BY n.from_identity`,
    [repositoryId, current],
  ).map((row) => row.from_identity),
];

/**
 * The whole chain of the repository that holds `identity` now, or held it before a rename: its current identity
 * first, then the earlier ones. Without `at`, a repository holding `identity` now is preferred over one that was
 * renamed away from it, so a new repository registered under a freed name does not take on the old one's history.
 * With `at` (when a row naming `identity` was written) the repository that held the name then is the one, so a past
 * receipt of the repository that was renamed away from it stays that repository's after another took the name.
 * `[identity]` when no registered repository holds it and no rename names it.
 */
export const identityChain = (db: Db, identity: string, at?: string): string[] => {
  const heldThen = at === undefined ? undefined : holderAt(db, identity, at);
  if (heldThen !== undefined) {
    const chain = repositoryIdentities(db, heldThen.repository_id, heldThen.identity);
    return chain.some((name) => name.toLowerCase() === identity.toLowerCase()) ? chain : [...chain, identity];
  }
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
  if (holder === undefined) return [identity];
  const chain = repositoryIdentities(db, holder.repository_id, holder.identity);
  return chain.some((name) => name.toLowerCase() === identity.toLowerCase()) ? chain : [...chain, identity];
};

/** The repository that held `identity` at `at`, by the stretches `repositoryNameSpans` gives; undefined when none did. */
const holderAt = (db: Db, identity: string, at: string): { repository_id: string; identity: string } | undefined => {
  const candidates = db.all<{ repository_id: string; identity: string }>(
    `SELECT repository_id, identity FROM repositories
      WHERE lower(identity) = lower(?) OR repository_id IN (SELECT repository_id FROM repository_identity_renames WHERE lower(from_identity) = lower(?))
      ORDER BY created_at, repository_id`,
    [identity, identity],
  );
  return candidates.find((candidate) => repositoryNameSpans(db, candidate.repository_id, candidate.identity).some((span) =>
    span.identity.toLowerCase() === identity.toLowerCase() && (span.from === null || at >= span.from) && (span.until === null || at < span.until)));
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
