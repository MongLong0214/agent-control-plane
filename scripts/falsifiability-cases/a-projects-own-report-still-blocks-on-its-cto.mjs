/**
 * The other direction: the change moved the CTO findings off the daemon's startup gate, not out
 * of the doctor. A report scoped to the project still blocks on its dead binding, which is what a
 * project activation reads. Answering "not scoped" everywhere would quietly loosen that gate.
 */
const aProjectsOwnReportStillBlocksOnItsCto = {
  id: "a-projects-own-report-still-blocks-on-its-cto",
  what: "a project-scoped doctor report still blocks on that project's dead CTO binding",
  file: "src/doctor/doctor.ts",
  find: "    const projectScoped = Boolean(projectId);\n",
  replace: "    const projectScoped = false;\n",
  killedBy: [
    "tests/unit/a-dead-cto-session-locks-the-daemon-out.test.ts::comes up past a dead canonical binding, and the operator door still releases it",
  ],
};

export default aProjectsOwnReportStillBlocksOnItsCto;
