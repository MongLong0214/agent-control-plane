/**
 * #762. The version argument is the whole fix. Without it `v26-ledger-trigger-bodies` recreates
 * "the ledger triggers" from a list that grew to include `canonical_turn_dispatches_*`, whose
 * table `v29` creates — and a database that did not arrive through v12's full-schema replay dies
 * there with `no such table: main.canonical_turn_dispatches`, having committed no step at all.
 *
 * That was the live deployment. Every chain test started from the v11 fixture, which gets the
 * v29 table at v12, so nothing could see it.
 */
const aMigrationInstallsOnlyTheTriggersThatExistYet = {
  id: "a-migration-installs-only-the-triggers-that-exist-yet",
  what: "v26 installs the ledger triggers that exist at v26, not the ones a later migration adds",
  file: "src/db/migrations.ts",
  find: "    raw.exec(ledgerTriggerDdl(26));\n    raw.exec(provenanceNoReplaceDdl());",
  replace: "    raw.exec(ledgerTriggerDdl());\n    raw.exec(provenanceNoReplaceDdl());",
  killedBy: [
    "tests/unit/an-incremental-migration-owns-what-it-creates.test.ts::finds no leak in the shipped chain, and every step runs",
  ],
};

export default aMigrationInstallsOnlyTheTriggersThatExistYet;
