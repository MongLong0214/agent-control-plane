/**
 * #954. The pin that broke this host was a *stable name* — a symlink whose versioned target the
 * provider's updater pruned. `execve` resolves that symlink at the moment of the call, so a
 * readback that does not follow it answers about the wrong object: `lstat` reports the dangling
 * link as present, and the check would then pass on the one deployment state it exists for.
 *
 * The mutation swaps the whole file's `statSync` for `lstatSync` at the import, which is the only
 * place in this file `statSync` appears and therefore an exact substitution of one rule for the
 * other. It typechecks — `lstatSync(path)` has the same shape and returns `Stats` — so the
 * mutant is a plausible implementation rather than a compile error, which is what makes the kill
 * mean something.
 *
 * The witness is the pruned pin, and what it observes is the condition rather than the count: under
 * `lstat` the dangling link stats fine and `isFile()` is false, so a finding *still fires* and only
 * its classification changes from `ABSENT` to `NOT_A_FILE`. A row that asserted "some finding
 * appeared" would survive this mutation intact. The same substitution also turns the live-symlink
 * case's `NOT_EXECUTABLE` into `NOT_A_FILE` — the operator sent to fix the link instead of the
 * file — but the harness takes one test name per row and the pruned pin is the case that happened.
 *
 * What this does not prove is the other half of the same rule: that the pin is not canonicalised
 * before it is read. `realpathSync` is not imported in `src/doctor/doctor.ts`, so no mutation of
 * this shape can introduce canonicalisation and still compile —
 * `a-pin-finding-names-the-pin-it-was-given` covers what is observable of that half.
 */
const aPinReadbackFollowsTheLink = {
  id: "a-pin-readback-follows-the-link",
  what: "the pin is stat'd through its symlink the way execve resolves it, so a stable name whose target was pruned fails",
  file: "src/doctor/doctor.ts",
  find: 'import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";',
  replace: 'import { accessSync, constants, existsSync, lstatSync as statSync, readFileSync } from "node:fs";',
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::reports a stable name whose versioned target the updater pruned",
  ],
};

export default aPinReadbackFollowsTheLink;
