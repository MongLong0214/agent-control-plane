/**
 * #1032. A repository probe that throws on a suspended project's checkout is a WARN, not a blocking
 * finding, for the same reason a missing one is. The mutant keeps it blocking.
 */
const aSuspendedProjectsFailedProbeDoesNotBlock = {
  id: "a-suspended-projects-failed-probe-does-not-block",
  what: "a suspended project's failed repository probe is a non-blocking warning",
  file: "src/doctor/doctor.ts",
  find: "          code: \"REPOSITORY_PROBE_FAILED\",\n          severity: projectSuspended ? \"WARN\" : \"ERROR\",\n          scope: `repository:${repository.identity}`,\n          blocking: !projectSuspended,\n",
  replace: "          code: \"REPOSITORY_PROBE_FAILED\",\n          severity: projectSuspended ? \"WARN\" : \"ERROR\",\n          scope: `repository:${repository.identity}`,\n          blocking: true,\n",
  killedBy: [
    "tests/unit/a-suspended-projects-missing-checkout-does-not-block-startup.test.ts::reports a %s project's failed repository probe accordingly",
  ],
};

export default aSuspendedProjectsFailedProbeDoesNotBlock;
