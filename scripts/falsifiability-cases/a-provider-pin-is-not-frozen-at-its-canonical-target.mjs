/**
 * #954 — the daemon spawns the pinned name, so each exec resolves it again.
 *
 * The other half of the launcher pin. An adapter assigns `#binary` once, in its constructor, and
 * every probe for the rest of the daemon's life spawns that one string. While `resolveExecutable`
 * canonicalised an absolute answer, that string was the version behind the stable name, frozen at
 * the moment the daemon started — so the installer could pin the name the updater maintains and
 * the daemon would still hold the file it was pointing at that second. Measured on the deployment
 * host: the daemon started at 01:59:50Z, the updater repointed the name at 02:01Z and pruned the
 * version the daemon was holding, and three versions arrived on three consecutive days.
 *
 * The mutation puts `realpathSync` back at that return, over the anchoring rather than instead of
 * it, so what it restores is the freeze alone and nothing else moves. The launcher-side row cannot see it: every
 * assertion about the generated launcher stays true, because the freeze happens after the launcher
 * has handed the value over. The named case is the only one that spawns through the seam after the
 * fixture has repointed the name and deleted the version the constructor saw.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-provider-pin-is-not-frozen-at-its-canonical-target",
  what:
    "resolveExecutable returns an absolute answer unchanged, so an adapter that resolves its "
    + "binary once still spawns the name rather than the version that was behind it at startup",
  file: "src/runtime/cli-adapters.ts",
  find: '  if (binary.includes("/")) return resolve(binary);\n',
  replace:
    '  if (binary.includes("/")) {\n'
    + "    try {\n"
    + "      return realpathSync(resolve(binary));\n"
    + "    } catch {\n"
    + "      return resolve(binary);\n"
    + "    }\n"
    + "  }\n",
  killedBy: [
    "tests/unit/usage-collectors.test.ts::#954 spawns the stable name after the provider's updater has replaced the version behind it",
  ],
};
export default c;
