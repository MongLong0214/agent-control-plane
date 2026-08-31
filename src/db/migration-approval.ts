/**
 * Approval for a schema migration performed on an existing database (#738).
 *
 * The hazard this exists for is not that migrations are dangerous. It is that nothing decided
 * one. `/Users/isaac/projects/agent-control-plane` is at once this repository's checkout and the
 * launchd job's `WorkingDirectory`, so a `pnpm build` run there for an unrelated reason changes
 * which `SCHEMA_VERSION` the next start declares, and `Db`'s constructor migrates in place the
 * moment the on-disk version differs. `KeepAlive { SuccessfulExit = false }` and `RunAtLoad`
 * then supply the start. Measured on 2026-08-31: running bytes and live database both at 25,
 * the checkout at 30, `main` at 34 — and migrations 21..25 had been applied 85ms into a daemon
 * start, which is the ledger recording that this already happened once.
 *
 * The one-way part is what makes it urgent rather than untidy: `applySchema` refuses a database
 * newer than the build, so once the file moves to 34 the deployed 25 bytes can never open it
 * again, and the supervisor retries every 30 seconds.
 *
 * So a migration becomes an act with an author. The approval names the exact starting version,
 * the exact ending version, the exact ordered migration ids, and a validated recovery point.
 * Nothing produces that shape in passing: not an environment variable, not a build, not an
 * unrelated script — a wrong or stale approval names a chain that is not the one about to run
 * and is refused with the same code as no approval at all.
 *
 * Deliberately *not* bound to a declared owner identity. The approval lives in the 0700 state
 * directory beside `owner-identities`, so anything that could forge one could forge the other;
 * checking a file against its neighbour in the same trust domain buys ceremony, not authority.
 * What is load-bearing is that the content has to be the exact plan, and `approvedBy` records
 * who claimed it so the refusal report and the audit trail have an author to name.
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { assertRollbackPointAt, captureRollbackPointSync } from "./backup.ts";
import { SCHEMA_VERSION, migrationChainFrom } from "./migrations.ts";
import { PRIVATE_FILE_MODE, assertPrivatePath, ensurePrivateDirectory } from "./state-preflight.ts";

export const MIGRATION_APPROVAL_FORMAT = "agent-control-plane.migration-approval/v1";

/** Exactly what a start would do to the database it just opened. */
export interface MigrationPlan {
  fromVersion: number;
  toVersion: number;
  /** The ordered migration ids, so an approval names the steps and not just the endpoints. */
  migrations: readonly string[];
}

export interface MigrationApproval extends MigrationPlan {
  format: typeof MIGRATION_APPROVAL_FORMAT;
  /** The validated image the owner gets back if the chain fails partway. */
  backupPath: string;
  approvedBy: string;
  approvedAt: string;
}

export const migrationApprovalPath = (databasePath: string): string =>
  join(dirname(databasePath), "migration-approval.json");

/** Where a refused start leaves its account of what it would have done. */
export const migrationRefusalPath = (databasePath: string): string =>
  join(dirname(databasePath), "migration-refusal.json");

/** Reads `user_version` without giving anything a handle that could migrate it. */
export const onDiskSchemaVersion = (databasePath: string): number => {
  const raw = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return Number(raw.pragma("user_version", { simple: true }));
  } finally {
    raw.close();
  }
};

export const migrationPlanFrom = (fromVersion: number): MigrationPlan => ({
  fromVersion,
  toVersion: SCHEMA_VERSION,
  migrations: migrationChainFrom(fromVersion).map((migration) => migration.id),
});

const sameOrderedIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Reads the approval on file, or null when there is none.
 *
 * A malformed approval throws rather than reading as absent: a file that says the owner
 * approved something, in a shape this cannot check, must not become "no approval, refuse
 * quietly" — the difference matters to whoever wrote it.
 */
export const readMigrationApproval = (databasePath: string): MigrationApproval | null => {
  const path = migrationApprovalPath(databasePath);
  if (!existsSync(path)) return null;
  assertPrivatePath(path, "file");
  let parsed: Partial<MigrationApproval>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MigrationApproval>;
  } catch (error) {
    throw acpError(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED, "the migration approval on file is unreadable", {
      approvalPath: path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    parsed.format !== MIGRATION_APPROVAL_FORMAT ||
    !Number.isInteger(parsed.fromVersion) ||
    !Number.isInteger(parsed.toVersion) ||
    !Array.isArray(parsed.migrations) ||
    parsed.migrations.some((id) => typeof id !== "string" || id.length === 0) ||
    typeof parsed.backupPath !== "string" ||
    parsed.backupPath.length === 0 ||
    typeof parsed.approvedBy !== "string" ||
    parsed.approvedBy.trim().length === 0 ||
    typeof parsed.approvedAt !== "string"
  ) {
    throw acpError(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED, "the migration approval on file has an invalid shape", {
      approvalPath: path,
    });
  }
  return parsed as MigrationApproval;
};

/**
 * The enforcement point. Throws unless an approval names this exact plan and its recovery
 * point validates.
 *
 * `supplied` is the programmatic seam a tool or fixture uses to approve without a file; it is
 * held to the identical checks, so it is a different way to deliver an approval rather than a
 * way around one.
 */
export const assertMigrationApproved = (
  databasePath: string,
  plan: MigrationPlan,
  supplied: MigrationApproval | null,
): MigrationApproval => {
  const approvalPath = migrationApprovalPath(databasePath);
  const approval = supplied ?? readMigrationApproval(databasePath);
  if (approval === null) {
    throw acpError(
      ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED,
      "opening this database would migrate its schema and no approval names that migration",
      {
        databasePath,
        approvalPath,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        migrations: plan.migrations,
        action:
          "agentcpd-state approve-migration --database <db> --approved-by <who> --confirm-migration",
      },
    );
  }
  if (
    approval.fromVersion !== plan.fromVersion ||
    approval.toVersion !== plan.toVersion ||
    !sameOrderedIds(approval.migrations, plan.migrations)
  ) {
    throw acpError(
      ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED,
      "the migration approval does not name the migration this start would perform",
      {
        databasePath,
        approvalPath,
        approved: {
          fromVersion: approval.fromVersion,
          toVersion: approval.toVersion,
          migrations: approval.migrations,
        },
        planned: {
          fromVersion: plan.fromVersion,
          toVersion: plan.toVersion,
          migrations: plan.migrations,
        },
      },
    );
  }
  assertRollbackPointAt(approval.backupPath, plan.fromVersion);
  return approval;
};

/**
 * Retires an approval that has been spent, so a file left lying in the state directory is
 * never a standing permission. The version check above already refuses a second use — the
 * database is no longer at `fromVersion` — but an approval whose migration ran is a record of
 * something that happened, and it is filed as one.
 */
export const consumeMigrationApproval = (databasePath: string, approval: MigrationApproval): void => {
  const path = migrationApprovalPath(databasePath);
  if (!existsSync(path)) return;
  renameSync(
    path,
    join(
      dirname(path),
      `migration-approval.applied-v${approval.fromVersion}-v${approval.toVersion}-${Date.now()}.json`,
    ),
  );
};

export const writeMigrationApproval = (
  databasePath: string,
  approval: MigrationApproval,
): string => {
  const path = migrationApprovalPath(databasePath);
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(approval, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  assertPrivatePath(path, "file");
  return path;
};

/**
 * The owner's act, in one call: take the recovery point, then write an approval naming it and
 * the exact chain. Shared by the `agentcpd-state approve-migration` command and by fixtures, so
 * a test approves the way production approves rather than by hand-assembling a permission.
 */
export const approveMigration = (databasePath: string, approvedBy: string): MigrationApproval => {
  const who = approvedBy.trim();
  if (who.length === 0) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a migration approval must name who approved it", {
      databasePath,
    });
  }
  const fromVersion = onDiskSchemaVersion(databasePath);
  if (fromVersion === SCHEMA_VERSION) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "this database is already at the build's schema version", {
      databasePath,
      version: fromVersion,
    });
  }
  const plan = migrationPlanFrom(fromVersion);
  const backup = captureRollbackPointSync(databasePath);
  const approval: MigrationApproval = {
    format: MIGRATION_APPROVAL_FORMAT,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    migrations: plan.migrations,
    backupPath: backup.path,
    approvedBy: who,
    approvedAt: new Date().toISOString(),
  };
  writeMigrationApproval(databasePath, approval);
  return approval;
};

/**
 * Leaves the refusal where an owner can find it with no daemon and no database.
 *
 * During a refusal there is no operator socket and no `Doctor` — both need a constructed
 * `ControlPlane`, which is the thing that could not open the file. This report and the stderr
 * line beside it are the whole observation surface, so it carries the plan verbatim rather
 * than a pointer to it.
 */
export const recordMigrationRefusal = (
  databasePath: string,
  report: Record<string, unknown>,
): string => {
  const path = migrationRefusalPath(databasePath);
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  return path;
};
