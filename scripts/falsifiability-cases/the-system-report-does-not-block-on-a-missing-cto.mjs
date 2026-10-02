/**
 * One project's open work without a CTO used to end the process: a blocking ERROR that
 * `canParkForBootstrap` does not admit. Restoring it makes that project's gap a precondition for
 * the whole daemon, including the claim socket a CTO would bind through.
 */
const theSystemReportDoesNotBlockOnAMissingCto = {
  id: "the-system-report-does-not-block-on-a-missing-cto",
  what: "a project whose open work has no CTO does not stop the daemon starting",
  file: "src/doctor/doctor.ts",
  find: "          code: \"CTO_MISSING_WITH_OPEN_RUNS\",\n          severity: \"ERROR\",\n          scope: `project:${project.projectId}`,\n          blocking: projectScoped,\n",
  replace: "          code: \"CTO_MISSING_WITH_OPEN_RUNS\",\n          severity: \"ERROR\",\n          scope: `project:${project.projectId}`,\n          blocking: true,\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::comes up for a project whose open work has no CTO, and still names the gap",
  ],
};

export default theSystemReportDoesNotBlockOnAMissingCto;
