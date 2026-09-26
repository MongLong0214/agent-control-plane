/**
 * #954 — `-x` is not enough; the pinned answer has to be a regular file.
 *
 * `canonical_executable` used to contribute this clause at the call site, and when the pin stopped
 * being canonicalised the clause was written out inline instead. Inline is where an unwitnessed
 * clause gets deleted as redundant, and until this row every case in the file kept `-f` inside its
 * own `find` and mutated something else, so deleting it survived the whole suite.
 *
 * A mode-755 FIFO is the case that separates `-f` from `-x`: `-x` is true of it and `command -v`
 * answers for it exactly as it would for a CLI, but a spawn blocks on an open with no writer, so
 * the daemon's first capacity probe hangs rather than failing. A directory would not do — `command
 * -v` skips those, so that fixture would stay green with the clause gone.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-pinned-provider-cli-is-a-regular-file",
  what:
    "the installer refuses to pin a name the shell answers for that is not a regular file, so an "
    + "executable FIFO on the installing PATH cannot become the path a capacity probe blocks on",
  file: "deploy/install-launchd.sh",
  find: '  [[ -n "$found" && "$found" == /* && -f "$found" && -x "$found" ]] || return 0\n',
  replace: '  [[ -n "$found" && "$found" == /* && -x "$found" ]] || return 0\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::#954 refuses a name that answers for something other than a regular file",
  ],
};
export default c;
