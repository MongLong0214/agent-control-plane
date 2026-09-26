/**
 * #954 — a configured binary is anchored to this process's directory, not passed on as written.
 *
 * `realpathSync` used to stand at this return and did two jobs: it canonicalised, which froze the
 * pin at the version behind a stable name, and it absolutised. Removing it to end the freeze took
 * the anchoring with it, and for one commit this branch returned its argument verbatim. The branch
 * is reached by `binary.includes("/")`, which tests for a slash and not for an absolute path, and
 * `CliAdapterOptions.binary` states no absolute constraint — so `./bin/claude` and `tools/claude`
 * arrive here from a deployment's configuration and were handed on unchanged.
 *
 * That is not a cosmetic difference, because the spawn does not happen where this ran: `runCli`
 * takes a `cwd` from its caller, so the daemon would spawn a relative pathname against a directory
 * that was never checked. The mutation is the regression itself.
 *
 * The freeze row over the same line cannot see this: its witness supplies an already-absolute
 * fixture, so it dies for canonicalisation only. This row's witness supplies a relative spelling
 * and nothing else does in either file.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-configured-provider-path-is-anchored-before-the-spawn",
  what:
    "resolveExecutable anchors a configured binary that contains a slash to the current working "
    + "directory, so a relative configuration still names that program at a spawn the caller gives "
    + "a different cwd",
  file: "src/runtime/cli-adapters.ts",
  find: '  if (binary.includes("/")) return resolve(binary);\n',
  replace: '  if (binary.includes("/")) return binary;\n',
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 anchors a relative configured binary before the adapter spawns it",
  ],
};
export default c;
