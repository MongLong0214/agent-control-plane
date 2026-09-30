/**
 * #1032. Offline, nothing can checkpoint a run or stop a CTO, so suspending under live work would
 * leave it authorised while the doctor stops reporting its checkout. The mutant suspends anyway.
 */
const offlineSuspensionNeedsAQuietProject = {
  id: "offline-suspension-needs-a-quiet-project",
  what: "an offline project suspension refuses a project with unfinished runs or active bindings",
  file: "src/db/state-admin.ts",
  find: "          if (openRuns > 0 || activeBindings > 0) {\n",
  replace: "          if (openRuns < 0) {\n",
  killedBy: [
    "tests/unit/an-offline-project-suspension.test.ts::refuses a project with %s, which only the daemon's owner path can quiesce",
  ],
};

export default offlineSuspensionNeedsAQuietProject;
