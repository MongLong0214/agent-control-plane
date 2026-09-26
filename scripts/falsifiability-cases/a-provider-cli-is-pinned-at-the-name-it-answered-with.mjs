/**
 * #954 — the provider CLI pin records the stable name, not the version behind it.
 *
 * The mutation restores the rule this replaced: resolve the shell's answer through
 * `canonical_executable` before baking it. That reads as correct on the install that writes it
 * and stops being true the first time the provider's updater runs — it repoints the stable name
 * at a new version and deletes the one this install accepted, leaving the launcher exporting a
 * path that no longer exists. Measured on the deployment host: the pin named a version directory
 * that had been deleted, every capacity probe spawned it, the provider reported no quota, and the
 * bound role was revoked for having no capacity.
 *
 * The named test carries both halves — that the launcher text holds the link rather than the
 * target, and that the pinned path still runs after the updater has moved the version behind it.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-provider-cli-is-pinned-at-the-name-it-answered-with",
  what:
    "resolve_cli_binary bakes the path the installing shell answered with, so a provider whose "
    + "updater repoints its stable name and deletes the old version is still reachable",
  file: "deploy/install-launchd.sh",
  find: '  [[ -n "$found" && "$found" == /* && -x "$found" ]] || return 0\n',
  replace:
    '  [[ -n "$found" && "$found" == /* && -x "$found" ]] || return 0\n'
    + '  found="$(canonical_executable "$found")" || return 0\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::#954 pins the stable name a provider's updater maintains, not the versioned file behind it",
  ],
};
export default c;
