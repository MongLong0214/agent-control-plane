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
 * `import.meta.url === pathToFileURL(process.argv[1]).href` (agentctl, state-admin,
 * rollback-pair), `fileURLToPath(import.meta.url) === resolve(process.argv[1])` (agentcpd), or
 * `import.meta.url === new URL(\`file://${"$"}{entry}\`).href` (hermes-ceo, hermes-tool-bridge).
 * `import.meta.url` is always the realpath Node resolved the module through; `process.argv[1]` is
 * whatever path the caller passed. Handing that comparison a symlinked `argv[1]` never matches, so
 * the module's own `main()` guard never fires. Measured directly before this fix:
 * `~/.agent-control-plane/current/dist/bin/node
 * ~/.agent-control-plane/current/dist/cli/agentctl.js attach canonical-cto --bogus` exited 0 and
 * printed nothing, where the identical argv through the real (unsymlinked) path printed a
 * selector error on stderr and exited 2. A silent exit 0 here is not "nothing to do" — it is the
 * attach relay, the restore, the migration, or the Hermes CEO relay never having run.
 *
 * This runs the *built* `dist/cli/agentctl.js`, `dist/db/state-admin.js`,
 * `dist/runtime/hermes-tool-bridge.js`, `dist/runtime/hermes-ceo.js` and
 * `dist/deploy/rollback-pair.js` (not the source; `pnpm build` must have already run) through a
 * fresh symlink standing in for `current`, and compares that run against the same argv through
 * the real path. The comparison, rather than a hardcoded exit code, is the assertion that must
 * hold: the two runs must agree. Before the fix they did not — the symlinked run went quiet while
 * the direct one failed loudly.
 *
 * `src/daemon/agentcpd.ts` has the same fix but is not run here directly: spawning `agentcpd.js`
 * for real opens a listening socket and a database.
 *
 * `src/deploy/rollback-pair.ts` has the same fix and *is* run here, through `--help`:
 * `rollback-pair-wal.test.ts`'s realpath regression launches `dist/deploy/rollback-pair.js` only
 * from the checkout path (`REPO_DIST = join(process.cwd(), "dist")`), so nothing there exercises
 * this entrypoint through a symlink. `--help` is the cheap, side-effect-free argv for it: `main()`
 * reaches it before any flag is read, so it never touches a pair, a database or the filesystem.
 *
 * `src/tools/traceability.ts`'s `isMain` has the identical fix but is deliberately not run
 * through a symlink here: its `main()` takes no argv to make it fail cheaply, and with no
 * `options.vitest` supplied it calls `runVitestJson(root)` — spawning this repository's whole
 * suite — and writes `evidence/traceability.json`/`.md` as a side effect. There is no cheap,
 * side-effect-free invocation of it the way there is for the other five.
 */

const REPO_ROOT = process.cwd();
const AGENTCTL_REL = join("dist", "cli", "agentctl.js");
const STATE_ADMIN_REL = join("dist", "db", "state-admin.js");
const HERMES_TOOL_BRIDGE_REL = join("dist", "runtime", "hermes-tool-bridge.js");
const HERMES_CEO_REL = join("dist", "runtime", "hermes-ceo.js");
const ROLLBACK_PAIR_REL = join("dist", "deploy", "rollback-pair.js");
const AGENTCTL = join(REPO_ROOT, AGENTCTL_REL);
const STATE_ADMIN = join(REPO_ROOT, STATE_ADMIN_REL);
const HERMES_TOOL_BRIDGE = join(REPO_ROOT, HERMES_TOOL_BRIDGE_REL);
const HERMES_CEO = join(REPO_ROOT, HERMES_CEO_REL);
const ROLLBACK_PAIR = join(REPO_ROOT, ROLLBACK_PAIR_REL);

/**
 * A fresh `<tmp>/current -> REPO_ROOT` symlink, one per call, so two cases in this file never
 * share — and never race on — the same link.
 */
const runThroughCurrentSymlink = (
  scriptRelativeToRoot: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) => {
  const linkParent = tempDir("acp-current-symlink-");
  const currentLink = join(linkParent, "current");
  symlinkSync(REPO_ROOT, currentLink);
  return boundedSpawnSync(process.execPath, [join(currentLink, scriptRelativeToRoot), ...argv], {
    encoding: "utf8",
    env,
  });
};

/**
 * Scrubbed of the four variables `hermes-ceo`'s `main()` requires before it does anything else,
 * so the case below takes that cheap, no-socket early return regardless of what this process's
 * own ambient environment happens to carry.
 */
const withoutHermesBootstrapEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env["ACP_HERMES_BOOTSTRAP_SOCKET"];
  delete env["ACP_HERMES_BOOTSTRAP_TOKEN"];
  delete env["ACP_HERMES_MCP_SOCKET"];
  delete env["ACP_MCP_TOKEN"];
  return env;
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

  it("hermes-tool-bridge: fails the same way through the symlink as through the real path", () => {
    expect(
      existsSync(HERMES_TOOL_BRIDGE),
      `${HERMES_TOOL_BRIDGE} is missing — run pnpm build first`,
    ).toBe(true);

    // No socket path: `main()` returns its usage error before `createConnection` is ever called,
    // so this is the cheap, side-effect-free path through an entrypoint that otherwise opens a
    // unix socket and pipes stdio both ways.
    const argv: string[] = [];
    const direct = boundedSpawnSync(process.execPath, [HERMES_TOOL_BRIDGE, ...argv], {
      encoding: "utf8",
    });
    const viaSymlink = runThroughCurrentSymlink(HERMES_TOOL_BRIDGE_REL, argv);

    expect(direct.status, direct.stderr).not.toBe(0);
    expect(direct.stderr).toContain("usage: hermes-tool-bridge");

    expect(viaSymlink.status).toBe(direct.status);
    expect(viaSymlink.stdout).toBe(direct.stdout);
    expect(viaSymlink.stderr).toBe(direct.stderr);
  });

  it("hermes-ceo: fails the same way through the symlink as through the real path", () => {
    expect(existsSync(HERMES_CEO), `${HERMES_CEO} is missing — run pnpm build first`).toBe(true);

    // No `--reply-command`: `main()` returns its usage error before it reads any bootstrap
    // environment variable or opens a socket, so this is the cheap, side-effect-free path
    // through an entrypoint that otherwise holds a live MCP connection for the life of the
    // process.
    const argv: string[] = [];
    const env = withoutHermesBootstrapEnv();
    const direct = boundedSpawnSync(process.execPath, [HERMES_CEO, ...argv], {
      encoding: "utf8",
      env,
    });
    const viaSymlink = runThroughCurrentSymlink(HERMES_CEO_REL, argv, env);

    expect(direct.status, direct.stderr).not.toBe(0);
    expect(direct.stderr).toContain("--reply-command is required");

    expect(viaSymlink.status).toBe(direct.status);
    expect(viaSymlink.stdout).toBe(direct.stdout);
    expect(viaSymlink.stderr).toBe(direct.stderr);
  });

  it("rollback-pair: fails the same way through the symlink as through the real path", () => {
    expect(existsSync(ROLLBACK_PAIR), `${ROLLBACK_PAIR} is missing — run pnpm build first`).toBe(
      true,
    );

    // `--help` reaches the usage branch before any flag is read, so this is the cheap,
    // side-effect-free path through an entrypoint that otherwise seals, validates or applies a
    // sealed pair against a real database and runtime closure.
    const argv = ["--help"];
    const direct = boundedSpawnSync(process.execPath, [ROLLBACK_PAIR, ...argv], {
      encoding: "utf8",
    });
    const viaSymlink = runThroughCurrentSymlink(ROLLBACK_PAIR_REL, argv);

    // Pinned first, independently of the comparison below: `--help` prints the usage text and
    // exits 0 on the real path.
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.stdout.length).toBeGreaterThan(0);

    // The regression this guards: before the fix, the symlinked run's own `isMainModule()` check
    // never matched, so `main()` never ran and the process exited 0 having printed nothing —
    // indistinguishable from `--help` having "worked", except silently.
    expect(viaSymlink.status).toBe(direct.status);
    expect(viaSymlink.stdout).toBe(direct.stdout);
    expect(viaSymlink.stderr).toBe(direct.stderr);
  });
});
