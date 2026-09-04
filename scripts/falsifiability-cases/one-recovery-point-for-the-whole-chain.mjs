/**
 * #738. `migrate()` takes one backup, names it `pre-migration-v{fromVersion}`, and runs every
 * migration in the chain inside it — so a chain that fails at its ninth step restores to where
 * the chain started, not to the eighth. The owner packet now says that in the place where it
 * changes what the owner does after a failure, and this is the fact it rests on.
 *
 * The ledger is where that fact is observable: only the first receipt names a `backup_file`.
 * Handing every step the same handle makes nine receipts each claim a recovery point, and eight
 * of those claims are false — the image is the pre-chain one, not a snapshot of that step.
 */
const oneRecoveryPointForTheWholeChain = {
  id: "one-recovery-point-for-the-whole-chain",
  what: "only the migration that opened the chain records the automatic backup, because there is only one",
  file: "src/db/database.ts",
  find: "        this.applyMigration(migration, migration.fromVersion === fromVersion ? backup : null);\n",
  replace: "        this.applyMigration(migration, backup);\n",
  killedBy: [
    "tests/unit/database-migration-restore.test.ts::migrates a v11 fixture in order, records its backup receipt, and re-establishes load-bearing guards",
  ],
};

export default oneRecoveryPointForTheWholeChain;
