/**
 * What an arm executes and what its reading records are one value, so a flag cannot be added to one
 * without the other.
 *
 * Both reviewers made the same point about the previous rows here: they mutated `probeArgv`, a
 * helper, and were killed by a test that calls `probeArgv`. The spawn a few lines further on built
 * its own second expression, so appending `--print` there -- or starting the resolved launcher path
 * rather than the held hard link -- left every named killing test green, and the live row read the
 * harness's own `run.command` rather than anything observed. `spawnPlanFor` is now the one place
 * that decides, and it returns what is spawned beside what is recorded.
 *
 * The mutation adds a flag to the interactive arm's *executed* argv and leaves the recorded command
 * alone: exactly the divergence the structure exists to prevent, and the one a reader of the
 * reading could never detect. The killing row asserts the executed argv is the pty script followed
 * by the recorded command, and asks the production interactivity predicate about both.
 */
const theArmExecutesTheInvocationItRecords = {
  id: "the-arm-executes-the-invocation-it-records",
  what: "an arm's spawned argv is the invocation its reading records, with nothing added to one side",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  return { executable: pty.python, argv: [pty.script, ...command], command };\n",
  replace: '  return { executable: pty.python, argv: [pty.script, "--print", ...command], command };\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::what an arm executes is the invocation its reading records, for both shapes",
  ],
};

export default theArmExecutesTheInvocationItRecords;
