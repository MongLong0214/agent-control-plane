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
import {
  isSameTarget,
  isTargetIdentity,
  targetIdentityOf,
  type TargetIdentity,
} from "./target-identity.ts";

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
  /**
   * The database this approves (#747). Without it the approval is a capability over whichever
   * file happens to be opened next in the same directory, and the recovery point below belongs
   * to a file that may not be the one about to change.
   */
  target: TargetIdentity;
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
    typeof parsed.approvedAt !== "string" ||
    !isTargetIdentity(parsed.target)
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
  opened: TargetIdentity,
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
        target: opened,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        migrations: plan.migrations,
        action:
          "agentcpd-state approve-migration --database <db> --approved-by <who> --confirm-migration",
      },
    );
  }
  // #747 — the first thing to establish is *which database* this approves. An approval names
  // one target; the file being opened is the only one it may be spent on. Measured before this
  // check existed: two v11 databases in one directory, an approval taken on A, a start opened
  // on B — B migrated on A's approval and A's backup became B's recovery point.
  if (!isSameTarget(approval.target, opened)) {
    throw acpError(
      ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED,
      "the migration approval is for a different database than the one being opened",
      { databasePath, approvalPath, approvedTarget: approval.target, openedTarget: opened },
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
  assertRollbackPointAt(approval.backupPath, plan.fromVersion, approval.target);
  return approval;
};

/** Whether a spent approval was filed away, and why not when it was not. */
export interface ApprovalRetirement {
  retired: boolean;
  approvalPath: string;
  error: string | null;
}

const retiredApprovalPath = (approvalPath: string, from: number, to: number): string =>
  join(dirname(approvalPath), `migration-approval.applied-v${from}-v${to}-${Date.now()}.json`);

/**
 * Files a spent approval away, and **never throws** (#747).
 *
 * The migration is the irreversible act; filing the approval is bookkeeping about an act that
 * already committed. Letting the bookkeeping fail the operation it describes is what produced
 * the state this contract exists to remove — a database upgraded to the new version and a
 * startup that reported failure, with nothing on either side saying which of the two had
 * happened. So the rename is attempted, its failure is reported to the caller, and the caller
 * carries on.
 *
 * Safety does not rest on this succeeding. A spent approval is inert because `applySchema`
 * compares versions before it ever consults an approval: the database is now at the build's
 * version, so the early-return branch is taken and the file is not read, and `approveMigration`
 * refuses to issue another for a database already at that version. Retirement is what keeps the
 * state directory honest, not what keeps it safe.
 */
export const retireMigrationApproval = (
  databasePath: string,
  from: number,
  to: number,
): ApprovalRetirement => {
  const approvalPath = migrationApprovalPath(databasePath);
  if (!existsSync(approvalPath)) return { retired: true, approvalPath, error: null };
  try {
    renameSync(approvalPath, retiredApprovalPath(approvalPath, from, to));
    return { retired: true, approvalPath, error: null };
  } catch (error) {
    return {
      retired: false,
      approvalPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * The repair half of the same contract: an approval that outlived its own migration is retired
 * the next time this database is opened at the build's version.
 *
 * Reached from the branch that does no migration at all, so it costs one `existsSync` on a path
 * that normally does not exist, and it refuses nothing. An approval naming some *other*
 * to-version is left alone and reported rather than filed away — this is a repair for
 * bookkeeping that failed, not a sweep of anything it does not recognise.
 */
export const retireStaleMigrationApproval = (databasePath: string): ApprovalRetirement | null => {
  const approvalPath = migrationApprovalPath(databasePath);
  if (!existsSync(approvalPath)) return null;
  let approval: MigrationApproval | null;
  try {
    approval = readMigrationApproval(databasePath);
  } catch {
    // Unreadable or malformed. `migration-plan` still shows the file; guessing at its contents
    // in order to delete it is not a repair.
    return { retired: false, approvalPath, error: "the approval on file could not be read" };
  }
  if (approval === null || approval.toVersion !== SCHEMA_VERSION) return null;
  return retireMigrationApproval(databasePath, approval.fromVersion, approval.toVersion);
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
  // Identity is taken before the snapshot and the snapshot records it independently, so the
  // approval and its recovery point name the same target because the same call observed both —
  // rather than because a later reader assumed they went together (#747).
  const target = targetIdentityOf(databasePath);
  const backup = captureRollbackPointSync(databasePath);
  const approval: MigrationApproval = {
    format: MIGRATION_APPROVAL_FORMAT,
    target,
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
