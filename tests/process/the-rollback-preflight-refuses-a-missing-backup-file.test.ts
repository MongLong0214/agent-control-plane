import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { backupDatabase } from "../../src/db/backup.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
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
 * A real ACP database in the journal mode the live one is actually in.
 *
 * `Db`'s constructor sets `journal_mode = WAL` on a database it creates, while the live
 * `state.sqlite` is `delete` (both measured). The document's procedure is written for the live
 * shape and refuses anything else, so a fixture that left the default would be testing a database
 * this procedure never sees.
 */
const buildRealAcpDatabase = (path: string): void => {
  new Db(path).close();
  execFileSync("sqlite3", [path, "PRAGMA journal_mode=DELETE;"]);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  chmodSync(path, 0o600);
};

/**
 * Stands in for the operator's deployed `$BYTES_BACKUP/dist/db/state-admin.js`.
 *
 * It delegates to *this repository's built* `state-admin.js` rather than reimplementing it, so
 * the thing the preflight exercises is the real CLI and the real `restoreDatabase` →
 * `validateBackup` → `readManifest` chain. A stub that merely exited 0 — which is what this
 * fixture used to write — would make the preflight's new validating step unfalsifiable: it would
 * pass for every backup, valid or not.
 *
 * Written as CommonJS with a dynamic `import()`: the fixture directory has no `package.json`, so
 * a bare `.js` there is CJS regardless of what this repository's own `type` field says.
 */
const stateAdminShim = (): string => {
  const real = join(process.cwd(), "dist", "db", "state-admin.js");
  if (!existsSync(real)) {
    throw new Error(
      `${real} does not exist — run \`pnpm build\` before this suite. This fixture must not ` +
        `silently fall back to a stub: a stub cannot refuse an invalid backup, and refusing one ` +
        `is the property under test.`,
    );
  }
  return [
    `import(${JSON.stringify(real)})`,
    "  .then((m) => m.main(process.argv.slice(2)))",
    "  .then((code) => process.exit(code))",
    "  .catch((error) => { console.error(error && error.message ? error.message : error); process.exit(1); });",
    "",
  ].join("\n");
};

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
const buildBackupFixture = async (
  root: string,
  omit: "launcher" | "stateAdmin" | "nothing",
  manifest: "valid" | "priorDocumentSchema" = "valid",
): Promise<BackupFixture> => {
  const bytesBackup = join(root, "bytes-backup");
  mkdirSync(join(bytesBackup, "dist", "daemon"), { recursive: true });
  mkdirSync(join(bytesBackup, "dist", "db"), { recursive: true });
  chmodSync(bytesBackup, 0o700);

  writeFileSync(join(bytesBackup, "dist", "daemon", "agentcpd.js"), BACKUP_DIST_SENTINEL);
  const shasumOut = execFileSync(
    "shasum",
    ["-a", "256", join(bytesBackup, "dist", "daemon", "agentcpd.js")],
    { encoding: "utf8" },
  );
  writeFileSync(join(bytesBackup, "agentcpd.js.sha256"), shasumOut);

  if (omit !== "stateAdmin") {
    writeFileSync(join(bytesBackup, "dist", "db", "state-admin.js"), stateAdminShim());
  }
  if (omit !== "launcher") {
    writeFileSync(join(bytesBackup, "agentcpd-launch.sh"), "#!/bin/sh\nexit 0\n");
  }
  writeFileSync(
    join(bytesBackup, "com.agentcontrolplane.agentcpd.plist"),
    "<?xml version=\"1.0\"?><plist><dict/></plist>\n",
  );

  // A genuinely valid backup, produced by the authority on what "valid" means — `backupDatabase`
  // in src/db/backup.ts, the same writer whose `readManifest` the rollback's restore goes
  // through. Hand-writing this pair is what let the document's manifest schema and the
  // validator's drift apart unnoticed (#745 round 4); a fixture that hand-writes it can only
  // repeat that.
  //
  // "Fully valid otherwise" is also what makes the falsifiability rows work: delete the one guard
  // a row targets and every remaining check must pass, so the extracted script really does reach
  // `rm -rf`. A fixture whose backup the preflight would reject anyway would let those rows
  // report kills they did not earn.
  const sourceHome = join(root, "backup-source");
  mkdirSync(sourceHome, { recursive: true });
  chmodSync(sourceHome, 0o700);
  const sourceDb = join(sourceHome, "state.sqlite");
  buildRealAcpDatabase(sourceDb);
  const backupPath = join(bytesBackup, "state-backup.sqlite");
  await backupDatabase(sourceDb, backupPath);

  if (manifest === "priorDocumentSchema") {
    // Exactly what item 4 step 2 wrote before #745 round 4: a second, invented manifest schema
    // that `readManifest` refuses on `format`, on `databaseFile`, and on `databaseSha256` alike.
    // The backup file beside it is real, private and integral — every existence check in the
    // preflight passes, which is the whole point.
    writeFileSync(
      `${backupPath}.manifest.json`,
      `${JSON.stringify({
        format: "agent-control-plane.sqlite-backup/online-v1",
        sourcePath: sourceDb,
        backupPath,
        backupSha256: execFileSync("shasum", ["-a", "256", backupPath], { encoding: "utf8" })
          .trim()
          .split(/\s+/)[0],
        backupUserVersion: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(`${backupPath}.manifest.json`, 0o600);
  }

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
  // 0700, because the real restore this script ends in refuses an insecure state directory. The
  // default here is 0755, and leaving it would make every case in this file fail on a directory
  // mode before it ever reached the property it is about.
  chmodSync(join(fixtureHome, ".agent-control-plane"), 0o700);

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
  it("refuses to run rm -rf when the launcher backup file is missing", async () => {
    const root = tempDir("acp-rollback-preflight-backup-");
    const fixture = await buildBackupFixture(root, "launcher");

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

  it("refuses to run rm -rf when the backup state-admin.js is missing", async () => {
    const root = tempDir("acp-rollback-preflight-backup-");
    const fixture = await buildBackupFixture(root, "stateAdmin");

    const { result, fixtureAppRoot } = runExtractedRollback(fixture);

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain(`rm -rf ${fixtureAppRoot}/dist`);
    // Refused before *attempting* to run it, which is what these two `test` lines are for and the
    // only thing that distinguishes them now. The validating restore added in round 4 also runs
    // this binary before `rm -rf`, so a missing file already stops the rollback by failing there
    // — and the falsifiability sweep caught exactly that: delete the guard and the destructive
    // command still never ran, so nothing was watching the guard any more. A preflight that
    // names what it will read has to refuse before the read, not by the read failing.
    expect(result.stderr).not.toContain("state-admin.js restore");
    expect(readFileSync(join(fixtureAppRoot, "dist", "daemon", "agentcpd.js"), "utf8")).toBe(
      LIVE_DIST_SENTINEL,
    );
  });

  // #745 round 4, blocker 2. Every check the preflight had asked whether a file was *present*.
  // None asked whether `restoreDatabase` would accept it, and those are different claims — so a
  // backup with an unreadable manifest failed *after* `rm -rf dist`, in the procedure you reach
  // for when things are already broken.
  //
  // The manifest here is not an invented broken shape: it is exactly what item 4 step 2 wrote
  // before this round, and the database beside it is real, private and integral. Everything the
  // old preflight looked at passes.
  it("refuses to run rm -rf when the backup's manifest is one the real restore validator rejects", async () => {
    const root = tempDir("acp-rollback-preflight-unreadable-manifest-");
    const fixture = await buildBackupFixture(root, "nothing", "priorDocumentSchema");

    const { result, fixtureAppRoot } = runExtractedRollback(fixture);

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    // Refused for the stated reason — the validator read the manifest and rejected it — rather
    // than incidentally, on a missing file or a shell error.
    expect(result.stderr).toContain("backup manifest");
    expect(result.stderr).not.toContain(`rm -rf ${fixtureAppRoot}/dist`);
    expect(readFileSync(join(fixtureAppRoot, "dist", "daemon", "agentcpd.js"), "utf8")).toBe(
      LIVE_DIST_SENTINEL,
    );
  }, 60_000);

  // The other half of the same property: a preflight that refuses everything would satisfy the
  // case above and be useless. A backup the validator does accept must get all the way through.
  it("passes the preflight and reaches the restore when the backup is one the real validator accepts", async () => {
    const root = tempDir("acp-rollback-preflight-valid-");
    const fixture = await buildBackupFixture(root, "nothing");

    const { result, fixtureAppRoot } = runExtractedRollback(fixture);

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    // It got past the preflight and did the destructive work it is supposed to do.
    expect(result.stderr).toContain(`rm -rf ${fixtureAppRoot}/dist`);
    expect(readFileSync(join(fixtureAppRoot, "dist", "daemon", "agentcpd.js"), "utf8")).toBe(
      BACKUP_DIST_SENTINEL,
    );
  }, 60_000);
});
