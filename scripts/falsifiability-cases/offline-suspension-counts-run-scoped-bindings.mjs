/**
 * #1032. A run-scoped binding carries its run id, not the project's, so the quiet-project check
 * matches it through the project's runs. The mutant drops that join and misses a binding left
 * active after its run finished.
 */
const offlineSuspensionCountsRunScopedBindings = {
  id: "offline-suspension-counts-run-scoped-bindings",
  what: "an offline project suspension counts a run-scoped binding of the project's runs as active work",
  file: "src/db/state-admin.ts",
  find: "                     OR a.run_id IN (SELECT run_id FROM runs WHERE project_id = ?)\n",
  replace: "                     OR a.run_id IN (SELECT run_id FROM runs WHERE 0 AND project_id = ?)\n",
  killedBy: [
    "tests/unit/an-offline-project-suspension.test.ts::refuses a project with a run-scoped binding left active after its run finished, which only the daemon's owner path can quiesce",
  ],
};

export default offlineSuspensionCountsRunScopedBindings;
