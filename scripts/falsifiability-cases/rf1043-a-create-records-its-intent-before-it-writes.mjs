/**
 * PR #1043 review, RF1043-02 — Without it a create whose response is lost leaves nothing a retry can recognise it by, and the retry refuses its own repository as someone else's.
 */
const rf1043ACreateRecordsItsIntentBeforeItWrites = {
  id: "rf1043-a-create-records-its-intent-before-it-writes",
  what: "a create records its intent and marker in the ledger before the call that may reach GitHub",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    begin(intent);\n    const created = await remote(",
  replace: "    const created = await remote(",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ACreateRecordsItsIntentBeforeItWrites;
