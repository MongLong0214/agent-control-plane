/**
 * The other direction: the change moved the CTO findings off the daemon's startup gate, not out
 * of the doctor. Every "project" and "cto" report still blocks on them, targeted or not; only the
 * system report relaxes. The mutant is the first version of this change (ACP1045-R1-02): deciding
 * by whether a project was named, which read an untargeted project or CTO report as the system
 * report and demoted both findings in it.
 */
const aProjectsOwnReportStillBlocksOnItsCto = {
  id: "a-projects-own-report-still-blocks-on-its-cto",
  what: "an untargeted project or CTO doctor report still blocks on a dead CTO binding",
  file: "src/doctor/doctor.ts",
  find: "    const systemReport = scope === \"system\";\n",
  replace: "    const systemReport = !projectId;\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::blocks on a dead canonical binding in every project and CTO report, targeted or not",
  ],
};

export default aProjectsOwnReportStillBlocksOnItsCto;
