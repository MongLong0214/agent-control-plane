/**
 * The interactive arm executes the invocation its reading records, pty allocator and all.
 *
 * A reviewer made the point concretely: the offline rows drove the headless shape only, so a
 * mutation confined to the interactive branch survived all of them. That branch is the one the
 * canonical claim is about -- the interactive plan starts a pty allocator whose argv is its script
 * followed by exactly the client's own invocation, and the reading records that invocation. A flag
 * inserted between them is an argv the reading does not describe, in the arm whose shape the claim
 * depends on, and the headless rows cannot see it.
 *
 * The mutation adds one argument there. The killing row starts the interactive shape through the
 * injected process boundary and requires the allocator's argv, after its script, to be the command
 * the reading records.
 */
const theInteractiveStartIsTheInvocationItsReadingRecords = {
  id: "the-interactive-start-is-the-invocation-its-reading-records",
  what: "the interactive arm starts the pty allocator on exactly the invocation its reading records",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "  return { executable: pty.python, argv: [pty.script, ...command], command };\n",
  replace: '  return { executable: pty.python, argv: [pty.script, "--", ...command], command };\n',
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::starts the invocation its reading records, and nothing beside it",
  ],
};

export default theInteractiveStartIsTheInvocationItsReadingRecords;
