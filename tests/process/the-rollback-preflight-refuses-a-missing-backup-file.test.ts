import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * docs/ops/owner-actions.md item 6 ("Rollback") runs a preflight — a chain of `test`/`sqlite3`/
 * `shasum` checks — before its first destructive command, `rm -rf .../dist`. The claim is that a
 * missing backup file stops the rollback before that line runs, ever, for any of the files the
 * rollback reads.
 *
 * That claim is worth nothing if this test copies the commands into itself: a copy proves the
 * copy is fail-closed while the document is free to drift out from under it — the exact defect a
 * `--theirs` merge produced elsewhere in this repository, dropping a package script while
 * `ci.yml` still called it, invisible until CI ran. So this test does not restate the rollback
 * commands. It extracts the real block out of the document between the
 * `<!-- owner-actions:rollback-preflight:start/end -->` markers and executes exactly that text.
 *
 * Two counterexamples only, matching the CEO's bounded scope for #737 — no general runbook
 * harness, no other section, no other document:
 *
 *   1. `$BYTES_BACKUP/agentcpd-launch.sh` is missing.
 *   2. `$BYTES_BACKUP/dist/db/state-admin.js` is missing.
 *
 * For each, the fixture backup is otherwise fully valid (matching hash, valid sqlite backup,
 * non-empty manifest, non-empty plist, the other file present) so that if the guard checking the
 * one missing file were ever deleted from the document, every other check would still pass and
 * the extracted script would sail through to `rm -rf` for real — which is exactly the row added
 * to scripts/verify-guards-are-falsifiable.mjs below proves.
 *
 * Safety: the extracted text names the owner's real machine — `/Users/isaac/projects/agent-
 * control-plane` literally, `$HOME` for the rest. Both are substituted before anything runs: the
 * literal app-root path is replaced (string substitution, not logic rewriting) with a disposable
 * temp directory, and the child process is given a `HOME` pointing at a second disposable temp
 * directory. Nothing this test runs can touch `/Users/isaac/projects/agent-control-plane`,
 * `~/.agent-control-plane`, or `~/Library/LaunchAgents` as they exist on the real machine — those
 * strings do not appear anywhere in the environment or arguments this test actually executes
 * with.
 *
 * `bash -x` traces every command the extracted script runs, to stderr. The assertion is not just
 * "the live dist directory still has its file" (which a script that never even started would
 * also satisfy) — it is that the trace itself never contains the `rm -rf` line, i.e. the
 * destructive command was never *invoked*, not merely that its effect is invisible.
 */
const OWNER_ACTIONS = join(process.cwd(), "docs/ops/owner-actions.md");
const REAL_APP_ROOT = "/Users/isaac/projects/agent-control-plane";
const BEGIN_MARKER = "<!-- owner-actions:rollback-preflight:start -->";
const END_MARKER = "<!-- owner-actions:rollback-preflight:end -->";

/**
 * Extracts the rollback preflight + destructive-command block verbatim from the live document.
 *
 * Fails loudly — never returns an empty or partial script — if the markers are gone, out of
 * order, or the block has drifted away from the 4-space indented code-block shape the doc uses.
 * A fixture that quietly finds nothing to run is worse than no fixture: silence here would read
 * as "still fail-closed" while actually testing nothing.
 */
const extractRollbackPreflightScript = (): string => {
  const text = readFileSync(OWNER_ACTIONS, "utf8");
  const start = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/ops/owner-actions.md no longer carries both rollback-preflight markers ` +
        `(${JSON.stringify(BEGIN_MARKER)} / ${JSON.stringify(END_MARKER)}). This fixture has ` +
        `nothing to extract and must fail, not silently skip.`,
    );
  }
  const body = text.slice(start + BEGIN_MARKER.length, end);
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("the rollback-preflight markers in docs/ops/owner-actions.md bound no lines");
  }
  const stripped = lines.map((line) => {
    if (!line.startsWith("    ")) {
      throw new Error(
        `a line between the rollback-preflight markers is not 4-space indented as a code block: ` +
          JSON.stringify(line),
      );
    }
    return line.slice(4);
  });
  const script = stripped.join("\n");
  if (script.split(REAL_APP_ROOT).length - 1 === 0) {
    throw new Error(
      `the extracted rollback script no longer names ${REAL_APP_ROOT}; this fixture substitutes ` +
        `a disposable directory for that literal path and found nothing to substitute`,
    );
  }
  if (!script.includes("rm -rf")) {
    throw new Error("the extracted rollback script no longer contains a destructive rm -rf command");
  }
  return script;
};

/** String substitution of the literal owner app-root path — not a rewrite of the script's logic. */
const neutralizeAppRoot = (script: string, fixtureAppRoot: string): string =>
  script.split(REAL_APP_ROOT).join(fixtureAppRoot);

const LIVE_DIST_SENTINEL = "LIVE-DIST-SENTINEL-do-not-replace";
const BACKUP_DIST_SENTINEL = "BACKUP-DIST-SENTINEL-restored-content";

/** A stub `install-launchd.sh`: real one manages launchd; this only needs `stop`/`start` to exit 0. */
const INSTALL_LAUNCHD_STUB = "#!/bin/sh\ncase \"$1\" in\n  stop|start) exit 0 ;;\n  *) exit 1 ;;\nesac\n";

interface BackupFixture {
  bytesBackup: string;
  backupPath: string;
}

/**
 * Builds a fully valid `$BYTES_BACKUP` + `$BACKUP_PATH` pair — matching hash, a real sqlite
 * database that passes `PRAGMA integrity_check`, a non-empty manifest and plist — and then omits
 * exactly one file, per the two counterexamples in #737's scope.
 *
 * "Fully valid otherwise" is not incidental realism: it is what makes the falsifiability row
 * work. If the fixture were missing several files at once, deleting the one guard line the row
 * targets would still leave the *other* checks blocking `rm -rf`, and the row would report a kill
 * it did not earn.
 */
const buildBackupFixture = (root: string, omit: "launcher" | "stateAdmin"): BackupFixture => {
  const bytesBackup = join(root, "bytes-backup");
  mkdirSync(join(bytesBackup, "dist", "daemon"), { recursive: true });
  mkdirSync(join(bytesBackup, "dist", "db"), { recursive: true });

  writeFileSync(join(bytesBackup, "dist", "daemon", "agentcpd.js"), BACKUP_DIST_SENTINEL);
  const shasumOut = execFileSync(
    "shasum",
    ["-a", "256", join(bytesBackup, "dist", "daemon", "agentcpd.js")],
    { encoding: "utf8" },
  );
  writeFileSync(join(bytesBackup, "agentcpd.js.sha256"), shasumOut);

  if (omit !== "stateAdmin") {
    writeFileSync(join(bytesBackup, "dist", "db", "state-admin.js"), "process.exit(0);\n");
  }
  if (omit !== "launcher") {
    writeFileSync(join(bytesBackup, "agentcpd-launch.sh"), "#!/bin/sh\nexit 0\n");
  }
  writeFileSync(
    join(bytesBackup, "com.agentcontrolplane.agentcpd.plist"),
    "<?xml version=\"1.0\"?><plist><dict/></plist>\n",
  );

  const backupPath = join(bytesBackup, "state-backup.sqlite");
  execFileSync("sqlite3", [backupPath, "create table t (x integer);"]);
  writeFileSync(`${backupPath}.manifest.json`, JSON.stringify({ databaseSha256: "fixture" }));

  return { bytesBackup, backupPath };
};

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | undefined;
  stdout: string;
  stderr: string;
}

/**
 * The absolute `bash` binary, spawned directly rather than left for the child to resolve via
 * `PATH`. The standard location on every runner and every developer machine this repository
 * targets (macOS): resolving it any other way would mean the child's own minimal `PATH` below
 * decides which `bash` interprets the extracted script, before that `PATH` has done anything else.
 */
const BASH = "/bin/bash";

/**
 * An explicit, minimal environment for the child — built from nothing, never `...process.env`.
 *
 * `process.env` on a developer's or CI machine can carry `BASH_ENV`/`ENV` (sourced by
 * non-interactive bash *before* anything in `-c`'s script runs, ahead of the `HOME` substitution
 * below ever taking effect) or a `PATH` this test did not choose, which decides which `sqlite3`,
 * `shasum`, `seq`, `sleep`, `cut`, `grep`, `cp`, `rm`, `mkdir`, `chmod` and `node` actually run.
 * Spreading it would make "no owner path is touched" a claim about *this machine's current
 * environment*, not about what the test itself guarantees.
 *
 * So every variable here is named and justified, and nothing else is passed:
 *   - `PATH`: only the directories holding the external commands the extracted script invokes,
 *     plus this Node's own directory (for the `node "$BYTES_BACKUP/dist/db/state-admin.js"` line,
 *     reached only if a guard were removed) — no inherited PATH, no surprise binary.
 *   - `HOME`: the one variable this whole fixture exists to substitute; the disposable directory
 *     built above, never the real one.
 *   - `BYTES_BACKUP` / `BACKUP_PATH`: the two variables the document's own procedure expects an
 *     operator's shell to have already set; here they point at the fixture backup, never a real
 *     one.
 * `BASH_ENV` and `ENV` are absent because nothing is spread — there is no inherited value to omit.
 */
const explicitChildEnv = (fixtureHome: string, fixture: BackupFixture): NodeJS.ProcessEnv => ({
  PATH: ["/bin", "/usr/bin", dirname(process.execPath)].join(":"),
  HOME: fixtureHome,
  BYTES_BACKUP: fixture.bytesBackup,
  BACKUP_PATH: fixture.backupPath,
});

const runExtractedRollback = (fixture: BackupFixture): { result: RunResult; fixtureAppRoot: string; fixtureHome: string } => {
  const root = tempDir("acp-rollback-preflight-");
  const fixtureAppRoot = join(root, "app-root");
  const fixtureHome = join(root, "home");

  mkdirSync(join(fixtureAppRoot, "deploy"), { recursive: true });
  writeFileSync(join(fixtureAppRoot, "deploy", "install-launchd.sh"), INSTALL_LAUNCHD_STUB);
  chmodSync(join(fixtureAppRoot, "deploy", "install-launchd.sh"), 0o755);
  mkdirSync(join(fixtureAppRoot, "dist", "daemon"), { recursive: true });
  writeFileSync(join(fixtureAppRoot, "dist", "daemon", "agentcpd.js"), LIVE_DIST_SENTINEL);

  mkdirSync(join(fixtureHome, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(fixtureHome, ".agent-control-plane"), { recursive: true });

  const script = neutralizeAppRoot(extractRollbackPreflightScript(), fixtureAppRoot);

  const proc = spawnSync(BASH, ["-x", "-c", script], {
    cwd: fixtureAppRoot,
    encoding: "utf8",
    env: explicitChildEnv(fixtureHome, fixture),
    timeout: 30_000,
  });

  return {
    result: {
      code: proc.status,
      signal: proc.signal,
      spawnError: proc.error,
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
    fixtureAppRoot,
    fixtureHome,
  };
};

describe("the rollback preflight in docs/ops/owner-actions.md, extracted and run against a fixture backup", () => {
  it("refuses to run rm -rf when the launcher backup file is missing", () => {
    const root = tempDir("acp-rollback-preflight-backup-");
    const fixture = buildBackupFixture(root, "launcher");

    const { result, fixtureAppRoot } = runExtractedRollback(fixture);

    // A refusal has a specific shape, and only that shape is accepted: the process must have
    // actually run to completion under `bash`'s own control (no spawn error, no signal — a hang,
    // a crash or a timeout all report `status: null` too, and `.not.toBe(0)` alone cannot tell
    // "refused" apart from "never ran"), and it must exit with exactly the code `set -e` gives a
    // failing `test` — 1, not merely "not zero".
    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    // The destructive command was never *invoked* — not merely that its effect is absent.
    expect(result.stderr).not.toContain(`rm -rf ${fixtureAppRoot}/dist`);
    expect(readFileSync(join(fixtureAppRoot, "dist", "daemon", "agentcpd.js"), "utf8")).toBe(
      LIVE_DIST_SENTINEL,
    );
  });

  it("refuses to run rm -rf when the backup state-admin.js is missing", () => {
    const root = tempDir("acp-rollback-preflight-backup-");
    const fixture = buildBackupFixture(root, "stateAdmin");

    const { result, fixtureAppRoot } = runExtractedRollback(fixture);

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(`rm -rf ${fixtureAppRoot}/dist`);
    expect(readFileSync(join(fixtureAppRoot, "dist", "daemon", "agentcpd.js"), "utf8")).toBe(
      LIVE_DIST_SENTINEL,
    );
  });
});
