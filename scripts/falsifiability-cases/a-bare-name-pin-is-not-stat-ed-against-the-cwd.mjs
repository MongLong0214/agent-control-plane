/**
 * `resolveExecutable`'s last return is a bare name, and its contract is that nothing of that name
 * was on the daemon's PATH when the adapter was built (`cli-adapters.ts`). Statting it asks the
 * wrong question twice: the name is relative, so the stat resolves against the daemon's working
 * directory rather than anything the spawn will search, and a directory named like the provider
 * sitting beside the daemon would answer it. Before this branch existed the check reported
 * `condition: "ABSENT"` with `error: "... stat 'claude'"` and an action reading "restore an
 * executable file at claude" — a real state, named as the wrong one, with the wrong repair.
 * `usage-collectors.ts:1184` already has the name: a CLI outside the daemon's PATH resolves to a
 * bare name and never starts.
 *
 * The mutation is a condition that cannot match, so the bare name falls through to the stat exactly
 * as it used to. It is not `if (false)`: the harness typechecks mutants and this keeps `path` in
 * use, and a test for a NUL byte in a pathname is inert rather than dead.
 */
const aBareNamePinIsNotStatEdAgainstTheCwd = {
  id: "a-bare-name-pin-is-not-stat-ed-against-the-cwd",
  what: "a pin with no separator is reported as not on the daemon's PATH, not stat'ed against the daemon's working directory",
  file: "src/doctor/doctor.ts",
  find: '  if (!path.includes("/")) return { condition: "NOT_ON_PATH" };',
  replace: '  if (path.includes("\\u0000")) return { condition: "NOT_ON_PATH" };',
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::calls a bare-name pin not-on-PATH instead of statting it against the daemon's cwd",
  ],
};

export default aBareNamePinIsNotStatEdAgainstTheCwd;
