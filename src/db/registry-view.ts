import type { RegistryView } from "../core/credential-shapes.ts";
import type { Db } from "./database.ts";

/**
 * What the repository registry recorded, read from a store's own database: the record a stored
 * repository identity or checkout is checked against before it is read per segment
 * (core/credential-shapes.ts). Read-only.
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
});
