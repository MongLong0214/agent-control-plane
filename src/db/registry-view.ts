import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RegistryView } from "../core/credential-shapes.ts";
import type { Db } from "./database.ts";

/** A stored path, canonical where it still exists (a removed tree keeps its stored, resolved form). */
const canonicalStored = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

/**
 * Facts ACP already stored, read from a store's own database: what a stored repository identity,
 * checkout or grant path is checked against before it is read per segment
 * (core/credential-shapes.ts). Read-only. Only locations ACP itself made or registered: the
 * registry's checkouts (the canonical git toplevel it resolved) and the verification engine's own
 * trees (under its configured worktree root). A path a caller or MCP request supplied and ACP only
 * stored, such as a task execution's worktree, is never one.
 */
export const registryView = (db: Db): RegistryView => ({
  records: (identity, checkoutPath) =>
    db.get(`SELECT 1 AS found FROM repositories WHERE identity = ? AND checkout_path = ?`, [identity, checkoutPath]) !== undefined,
  recordsForRun: (runId, identity, checkoutPath) =>
    db.get(
      `SELECT 1 AS found FROM repositories
        WHERE identity = ? AND checkout_path = ?
          AND (temporary_for_run = ? OR project_id = (SELECT project_id FROM runs WHERE run_id = ?))`,
      [identity, checkoutPath, runId, runId],
    ) !== undefined,
  checkoutsOf: (identity) =>
    db.all<{ checkout_path: string }>(`SELECT checkout_path FROM repositories WHERE identity = ?`, [identity])
      .map((row) => canonicalStored(row.checkout_path)),
  runWorktrees: (runId, identity) =>
    db.all<{ worktree_path: string }>(
      `SELECT worktree_path FROM verification_worktrees WHERE run_id = ? AND repository_identity = ?`, [runId, identity],
    ).map((row) => canonicalStored(row.worktree_path)),
});
