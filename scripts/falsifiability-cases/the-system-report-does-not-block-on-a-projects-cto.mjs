/**
 * A project's CTO is availability, not a precondition for the daemon's sockets. Making the dead
 * binding blocking again in the system report parks the daemon at startup, and a parked daemon
 * never opens the claim socket or cto.mcp.sock through which a CTO would take the role back.
 */
const theSystemReportDoesNotBlockOnAProjectsCto = {
  id: "the-system-report-does-not-block-on-a-projects-cto",
  what: "a dead canonical binding does not park the daemon at startup",
  file: "src/doctor/doctor.ts",
  find: "          severity: systemReport ? \"ERROR\" : \"CRITICAL\",\n          scope: `project:${project.projectId}`,\n          blocking: !systemReport,\n",
  replace: "          severity: \"CRITICAL\",\n          scope: `project:${project.projectId}`,\n          blocking: true,\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::comes up past a dead canonical binding, and the operator door still releases it",
  ],
};

export default theSystemReportDoesNotBlockOnAProjectsCto;
