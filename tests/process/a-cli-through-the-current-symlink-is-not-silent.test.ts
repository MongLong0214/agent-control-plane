import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #1052's `deploy/install-launchd.sh` publishes `<state root>/current` as a symlink to
 * `runtime/generation-<sha8>`, so every long-lived caller — the Claude Code acp-cto entry and the
 * Hermes acp-ceo entry among them — launches this CLI through that link rather than through the
 * generation directory's real path.
 *
 * Each entrypoint decided whether it was the running program with
 * `import.meta.url === pathToFileURL(process.argv[1]).href`. `import.meta.url` is always the
 * realpath Node resolved the module through; `process.argv[1]` is whatever path the caller
 * passed. Handing that comparison a symlinked `argv[1]` never matches, so the module's own
 * `main()` guard never fires. Measured directly before this fix:
 * `~/.agent-control-plane/current/dist/bin/node
 * ~/.agent-control-plane/current/dist/cli/agentctl.js attach canonical-cto --bogus` exited 0 and
 * printed nothing, where the identical argv through the real (unsymlinked) path printed a
 * selector error on stderr and exited 2. A silent exit 0 here is not "nothing to do" — it is the
 * attach relay, the restore, or the migration never having run.
 *
 * This runs the *built* `dist/cli/agentctl.js` and `dist/db/state-admin.js` (not the source;
 * `pnpm build` must have already run) through a fresh symlink standing in for `current`, and
 * compares that run against the same argv through the real path. The comparison, rather than a
 * hardcoded exit code, is the assertion that must hold: the two runs must agree. Before the fix
 * they did not — the symlinked run went quiet while the direct one failed loudly.
 */

const REPO_ROOT = process.cwd();
const AGENTCTL_REL = join("dist", "cli", "agentctl.js");
const STATE_ADMIN_REL = join("dist", "db", "state-admin.js");
const AGENTCTL = join(REPO_ROOT, AGENTCTL_REL);
const STATE_ADMIN = join(REPO_ROOT, STATE_ADMIN_REL);

/**
 * A fresh `<tmp>/current -> REPO_ROOT` symlink, one per call, so two cases in this file never
 * share — and never race on — the same link.
 */
const runThroughCurrentSymlink = (scriptRelativeToRoot: string, argv: readonly string[]) => {
  const linkParent = tempDir("acp-current-symlink-");
  const currentLink = join(linkParent, "current");
  symlinkSync(REPO_ROOT, currentLink);
  return boundedSpawnSync(process.execPath, [join(currentLink, scriptRelativeToRoot), ...argv], {
    encoding: "utf8",
  });
};

describe("a CLI run through the `current` symlink is not silent", () => {
  it("agentctl: fails the same way through the symlink as through the real path", () => {
    expect(existsSync(AGENTCTL), `${AGENTCTL} is missing — run pnpm build first`).toBe(true);

    const argv = ["attach", "canonical-cto", "--bogus"];
    const direct = boundedSpawnSync(process.execPath, [AGENTCTL, ...argv], { encoding: "utf8" });
    const viaSymlink = runThroughCurrentSymlink(AGENTCTL_REL, argv);

    // Pinned first, independently of the comparison below: if the selector check itself ever
    // regresses and both runs start agreeing on an empty, zero-exit "success", the comparison
    // alone would not catch it.
    expect(direct.status, direct.stderr).not.toBe(0);
    expect(direct.stderr).toContain("selectors must be option/value pairs");

    // The regression this guards: before the fix, `viaSymlink` was `{ status: 0, stdout: "",
    // stderr: "" }` while `direct` failed loudly. Launching through a symlink must not change
    // what the program decides to do.
    expect(viaSymlink.status).toBe(direct.status);
    expect(viaSymlink.stdout).toBe(direct.stdout);
    expect(viaSymlink.stderr).toBe(direct.stderr);
  });

  it("state-admin: fails the same way through the symlink as through the real path", () => {
    expect(existsSync(STATE_ADMIN), `${STATE_ADMIN} is missing — run pnpm build first`).toBe(true);

    const argv = ["--bogus"];
    const direct = boundedSpawnSync(process.execPath, [STATE_ADMIN, ...argv], { encoding: "utf8" });
    const viaSymlink = runThroughCurrentSymlink(STATE_ADMIN_REL, argv);

    expect(direct.status, direct.stderr || direct.stdout).not.toBe(0);

    expect(viaSymlink.status).toBe(direct.status);
    expect(viaSymlink.stdout).toBe(direct.stdout);
    expect(viaSymlink.stderr).toBe(direct.stderr);
  });
});
