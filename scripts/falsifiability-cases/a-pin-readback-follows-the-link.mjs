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
 * Two witnesses, because the wrong rule is wrong in two distinguishable ways. On the pruned pin,
 * `lstat` succeeds and `isFile()` is false, so `ABSENT` becomes `NOT_A_FILE` — a finding still
 * fires, and a row that only counted findings would survive this. On the live symlink whose
 * target has lost its execute bit, the same substitution turns `NOT_EXECUTABLE` into
 * `NOT_A_FILE`, which is the operator being sent to fix the link instead of the file.
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
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::does not canonicalise: the evidence names the pin, not what it resolved to",
  ],
};

export default aPinReadbackFollowsTheLink;
