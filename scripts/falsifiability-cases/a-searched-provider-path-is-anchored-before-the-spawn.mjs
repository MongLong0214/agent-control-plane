/**
 * #954 — a CLI found through PATH is anchored, not returned as the entry spelled it.
 *
 * The search joins the PATH entry to the bare name, and a PATH entry may be relative. `accessSync`
 * then answers about this process's working directory while the spawn happens in whatever `cwd`
 * `runCli`'s caller passes, so an unanchored candidate is a pathname that was checked in one
 * directory and executed in another — it names a different file there, or nothing.
 *
 * `realpathSync` used to do this anchoring incidentally, as a side effect of canonicalising. When
 * canonicalisation was removed to stop the pin freezing at the version behind a stable name, the
 * anchoring went with it; the mutation is that state.
 *
 * The `#785` PATH-fallback case cannot see it: its PATH entry is absolute, so `join` already
 * returns an absolute candidate and `resolve` is the identity. The named case spells the entry
 * relative to the process's own directory.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-searched-provider-path-is-anchored-before-the-spawn",
  what:
    "resolveExecutable anchors the candidate it found on PATH to the current working directory, so "
    + "a relative PATH entry still names the program it was checked for at a spawn given another cwd",
  file: "src/runtime/cli-adapters.ts",
  find: "      return resolve(candidate);\n",
  replace: "      return candidate;\n",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 anchors a bare name found through a relative PATH entry",
  ],
};
export default c;
