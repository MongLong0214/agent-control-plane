import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { restoreDatabase } from "../../src/db/backup.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * docs/ops/owner-actions.md item 4 step 2 backs up the live database with SQLite's online
 * backup API through the `sqlite3` CLI. The previous version of this block ran
 * `state-admin.js backup`, which loads `better-sqlite3` — unavailable to a fresh `node` process
 * on the real host, per #512's execution report. That failure did not read as a failure: the
 * `node -e` step that parsed `$BACKUP_PATH` out of the (empty/error) output produced an empty
 * string, and `sqlite3 "" "PRAGMA integrity_check;"` opened a throwaway temporary database and
 * printed `ok` with exit `0` — a real command, a real `ok`, and no backup anywhere.
 *
 * This suite does not restate the corrected block: it extracts the real text out of the document
 * between `<!-- owner-actions:database-backup:start/end -->` and executes exactly that, for the
 * same reason `the-rollback-preflight-refuses-a-missing-backup-file.test.ts` does — a copy proves
 * the copy is fail-closed while the document drifts out from under it.
 *
 * Three counterexamples, matching the acceptance criteria for this change:
 *
 *   1. The backup command itself fails (simulated: a `sqlite3` on `PATH` that fails specifically
 *      on `.backup`, standing in for the missing-bindings failure this block replaces). The
 *      corrected script must exit nonzero and must never reach the integrity-check call — the
 *      exact line that, against an empty path, produced the false `ok`.
 *   2. The destination the script is about to write to already exists. The script must refuse
 *      before doing any of the destructive/verifying work that follows.
 *   3. A backup taken while a second process is continuously writing to the source database
 *      completes with `integrity_check` = `ok`, and the source remains open and writable
 *      afterward — this is the whole reason the online backup API replaces a raw `cp`.
 *
 * A CEO review of an earlier version of this block (#745) found two further counterexamples
 * about *publication*, not the backup itself, both still present at that point:
 *
 *   4. The destination-exists check above runs once, before the backup — it does not close the
 *      window between that check and the final `mv`, which is not no-clobber. Two runs sharing
 *      the same timestamp both pass every check independently and then both `mv` to the same
 *      `$BACKUP_PATH`; the second silently overwrites the first run's already-verified backup.
 *   5. The database and the manifest are published by two separate `mv` calls. A failure between
 *      them leaves a database with no manifest at the final path — not the verified pair the
 *      rest of this document treats `$BACKUP_PATH` as meaning.
 *
 * A second CEO review (#745, round 3) rejected the `mkdir`-reserve-then-release answer to those
 * two, for one reason that produces both: a lock's lifetime is its critical section, while the
 * artifact it protects — a published backup — outlives that section forever. Three more
 * counterexamples follow from it, and each has its own case at the bottom of this file:
 *
 *   6. Delayed claim. A run that passed `[ -e "$BACKUP_PATH" ]` before another run published can
 *      take the freed reservation afterwards and overwrite the published pair, never having
 *      re-read the final name.
 *   7. Untrappable death. `trap … EXIT` does not run on `SIGKILL` or power loss, so publishing the
 *      database first can leave one at the final path with no manifest beside it. The existing
 *      failure fixture only injects an ordinary nonzero return, which always reaches the trap.
 *   8. A stranger's failure is not a stranger's deletion. Cleanup keyed to a released lock deletes
 *      by name, and by then the name no longer records who owns it.
 *
 * The corrected block makes the final names themselves the claim, held permanently: `ln` is
 * atomic and fails `EEXIST` rather than replacing (`mv -n` is not a substitute — neither the GNU
 * nor the BSD implementation is race-free). The manifest is linked first and the database last,
 * so `$BACKUP_PATH` is the commit marker and no untrappable death can leave a database without
 * one; and cleanup unlinks only names this run created, only while that marker is absent.
 *
 * A third CEO review (#745, round 4) found that the ordering claim was stated too strongly and
 * that the artifact was unusable:
 *
 *   9. Manifest-first orders the two links against *process* termination — the kernel has applied
 *      both namespace operations by the time anything can look. It does not order them against
 *      power loss: nothing here `fsync`s, and macOS needs `F_FULLFSYNC`. The document now claims
 *      only what the `SIGKILL` case below actually demonstrates.
 *  10. The document had invented a second manifest schema. `readManifest` in src/db/backup.ts —
 *      which every restore goes through — accepts only `…/v1` with a `sha256:`-prefixed
 *      `databaseSha256`, an integer `schemaVersion`, a `databaseFile` equal to the backup's
 *      basename, and mode 0600 on both files. So `state-admin.js restore` rejected every backup
 *      this procedure produced. One schema now, owned by the code that validates it, and the case
 *      that proves it runs the real commands and hands the result to the real validator.
 *
 * Measured while closing (10): `Db`'s constructor sets `journal_mode = WAL`, while the live
 * database is `delete`. Every `sqlite3` call in the block is `-readonly`, and a read-only
 * connection cannot open a WAL database — so step 1 now refuses one by name rather than by errno.
 *
 * Safety: `HOME` is a disposable fixture directory for every case; nothing here reads or writes
 * `~/.agent-control-plane` or any real path.
 */
const OWNER_ACTIONS = join(process.cwd(), "docs/ops/owner-actions.md");
const BEGIN_MARKER = "<!-- owner-actions:database-backup:start -->";
const END_MARKER = "<!-- owner-actions:database-backup:end -->";

/**
 * Extracts the database-backup block verbatim from the live document.
 *
 * Fails loudly — never returns an empty or partial script — if the markers are gone, out of
 * order, or the block has drifted away from the 4-space indented code-block shape the doc uses.
 */
const extractDatabaseBackupScript = (): string => {
  const text = readFileSync(OWNER_ACTIONS, "utf8");
  const start = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/ops/owner-actions.md no longer carries both database-backup markers ` +
        `(${JSON.stringify(BEGIN_MARKER)} / ${JSON.stringify(END_MARKER)}). This fixture has ` +
        `nothing to extract and must fail, not silently skip.`,
    );
  }
  const body = text.slice(start + BEGIN_MARKER.length, end);
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("the database-backup markers in docs/ops/owner-actions.md bound no lines");
  }
  const stripped = lines.map((line) => {
    if (!line.startsWith("    ")) {
      throw new Error(
        `a line between the database-backup markers is not 4-space indented as a code block: ` +
          JSON.stringify(line),
      );
    }
    return line.slice(4);
  });
  const script = stripped.join("\n");
  if (!script.includes(".backup")) {
    throw new Error("the extracted database-backup script no longer contains a `.backup` invocation");
  }
  if (!script.includes("integrity_check")) {
    throw new Error("the extracted database-backup script no longer contains an integrity_check");
  }
  return script;
};

const BASH = "/bin/bash";

/** Minimal, explicit PATH: only what the script needs, plus a fixture directory prepended by a case. */
const minimalPath = (...extraDirs: string[]): string =>
  [...extraDirs, "/bin", "/usr/bin", dirname(process.execPath)].join(":");

const buildScratchDatabase = (path: string): void => {
  execFileSync("sqlite3", [
    path,
    "PRAGMA journal_mode=DELETE;",
    "PRAGMA user_version=25;",
    "create table t (x integer);",
    "insert into t values (1), (2), (3);",
  ]);
};

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | undefined;
  stdout: string;
  stderr: string;
}

const runExtractedBackup = (fixtureHome: string, path: string): RunResult => {
  const proc = spawnSync(BASH, ["-x", "-c", extractDatabaseBackupScript()], {
    cwd: fixtureHome,
    encoding: "utf8",
    env: { HOME: fixtureHome, PATH: path },
    timeout: 30_000,
  });
  return {
    code: proc.status,
    signal: proc.signal,
    spawnError: proc.error,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
};

/**
 * Same script, same shape as `runExtractedBackup`, but launched with the async `spawn` so two
 * instances can genuinely run concurrently rather than one completing before the next starts.
 */
const spawnExtractedBackup = (fixtureHome: string, path: string): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(BASH, ["-c", extractDatabaseBackupScript()], {
      cwd: fixtureHome,
      env: { HOME: fixtureHome, PATH: path },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      resolve({ code: null, signal: null, spawnError: err, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal, spawnError: undefined, stdout, stderr });
    });
  });

const setUpFixtureHome = (root: string): { fixtureHome: string; dbPath: string } => {
  const fixtureHome = join(root, "home");
  mkdirSync(join(fixtureHome, ".agent-control-plane"), { recursive: true });
  const dbPath = join(fixtureHome, ".agent-control-plane", "state.sqlite");
  buildScratchDatabase(dbPath);
  return { fixtureHome, dbPath };
};

/** Writes an executable shell stub and returns its path. */
const writeStub = (dir: string, name: string, lines: string[]): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, [...lines, ""].join("\n"));
  chmodSync(path, 0o755);
  return path;
};

/**
 * A `date` that answers the one call the script uses to name the destination with a fixed value,
 * and passes every other call (the manifest's `createdAt`) through. Two runs given this stub
 * target the identical `$BACKUP_PATH` deterministically instead of racing and hoping.
 */
const FIXED_STAMP = "FIXEDSTAMP";
const writeFixedDateStub = (dir: string): void => {
  writeStub(dir, "date", [
    "#!/bin/bash",
    `if [ "$1" = "-u" ] && [ "$2" = "+%Y%m%dT%H%M%SZ" ]; then`,
    `  echo "${FIXED_STAMP}"`,
    "else",
    '  exec /bin/date "$@"',
    "fi",
  ]);
};

const finalPathsFor = (fixtureHome: string): { backupsDir: string; finalDb: string; finalManifest: string } => {
  const backupsDir = join(fixtureHome, ".agent-control-plane", "backups");
  const finalDb = join(backupsDir, `state-${FIXED_STAMP}.sqlite`);
  return { backupsDir, finalDb, finalManifest: `${finalDb}.manifest.json` };
};

/**
 * The digest in the `sha256:`-prefixed form the manifest records, so an on-disk reading and a
 * manifest reading are directly comparable. The prefix is not decoration: `readManifest` requires
 * `^sha256:[a-f0-9]{64}$`, and comparing a bare hex digest against a manifest field would be a
 * comparison that can never match once the manifest is the shape the validator accepts.
 */
const sha256Of = (path: string): string =>
  `sha256:${execFileSync("shasum", ["-a", "256", path], { encoding: "utf8" }).trim().split(/\s+/)[0] ?? ""}`;

const listing = (dir: string): string[] =>
  spawnSync("find", [dir, "-mindepth", "1"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter((line) => line.length > 0);

/**
 * A `sqlite3` that stops the run *after* the destination precheck and *before* the backup itself,
 * signalling `reached` and waiting for `release`. This is the barrier the "delayed claim" cases
 * need: the paused run has already passed `[ -e "$BACKUP_PATH" ]`, which is precisely the state
 * a publication step must not assume still holds.
 */
const writeBarrierSqlite3Stub = (dir: string, reached: string, release: string): void => {
  writeStub(dir, "sqlite3", [
    "#!/bin/bash",
    'for a in "$@"; do',
    '  case "$a" in',
    `    *.backup*) /usr/bin/touch "${reached}"; while [ ! -e "${release}" ]; do /bin/sleep 0.05; done ;;`,
    "  esac",
    "done",
    'exec /usr/bin/sqlite3 "$@"',
  ]);
};

const waitForFile = async (path: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("the database-backup step in docs/ops/owner-actions.md, extracted and run against fixtures", () => {
  it("never calls sqlite3 against an empty path when the backup command itself fails, and exits nonzero", () => {
    const root = tempDir("acp-database-backup-cmd-fails-");
    const { fixtureHome } = setUpFixtureHome(root);

    // A `sqlite3` on PATH ahead of the real one that fails specifically on `.backup` — standing
    // in for the missing-bindings failure this block was written to survive. Every other
    // invocation (the `PRAGMA user_version` reads) is passed straight through to the real binary.
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, "sqlite3");
    writeFileSync(
      stubPath,
      [
        "#!/bin/bash",
        'for a in "$@"; do',
        "  case \"$a\" in",
        '    *.backup*) echo "stub: backup failed" >&2; exit 1 ;;',
        "  esac",
        "done",
        'exec /usr/bin/sqlite3 "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    // The specific defect this block replaces: sqlite3 invoked against an empty path, printing a
    // real `ok`. That call must never appear in the trace.
    expect(result.stderr).not.toContain("sqlite3 -readonly ''");
    expect(result.stderr).not.toContain("sqlite3 ''");
    // The integrity-check line — the one that produced the false `ok` in the original report —
    // must never be reached once the backup command itself has failed.
    expect(result.stderr).not.toContain("PRAGMA integrity_check");
    // Nothing left behind under a final (non-temporary) name.
    const listing = spawnSync("find", [join(fixtureHome, ".agent-control-plane", "backups"), "-maxdepth", "1", "-name", "state-*.sqlite", "!", "-name", ".*"], { encoding: "utf8" });
    expect((listing.stdout ?? "").trim()).toBe("");
  });

  it("refuses when the destination already exists, before any verification work runs", () => {
    const root = tempDir("acp-database-backup-dest-exists-");
    const { fixtureHome } = setUpFixtureHome(root);

    // Stub `date` to a fixed value so the destination name the script computes is predictable,
    // then pre-seed exactly that path as an already-existing file.
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, "date");
    writeFileSync(stubPath, ["#!/bin/bash", 'echo "FIXEDSTAMP"', ""].join("\n"));
    chmodSync(stubPath, 0o755);

    const backupsDir = join(fixtureHome, ".agent-control-plane", "backups");
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, "state-FIXEDSTAMP.sqlite"), "pre-existing, not a real backup\n");

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("already exists");
    // Refused before the backup command, the integrity check, or the manifest ever ran.
    expect(result.stderr).not.toContain(".backup '");
    expect(result.stderr).not.toContain("PRAGMA integrity_check");
    // The pre-existing file is untouched, not overwritten by a script that pressed ahead anyway.
    expect(readFileSync(join(backupsDir, "state-FIXEDSTAMP.sqlite"), "utf8")).toBe(
      "pre-existing, not a real backup\n",
    );
  });

  it("refuses when integrity_check exits 0 but does not print exactly ok, before renaming to the final path", () => {
    const root = tempDir("acp-database-backup-bad-integrity-");
    const { fixtureHome } = setUpFixtureHome(root);

    // A `sqlite3` stub that answers every `PRAGMA integrity_check` with a wrong-but-successful
    // result (`malformed`, exit 0) and passes every other invocation straight through. This is
    // the case the requirement calls out by name: exit 0 alone is not enough, the stdout content
    // is checked too.
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, "sqlite3");
    writeFileSync(
      stubPath,
      [
        "#!/bin/bash",
        'for a in "$@"; do',
        "  case \"$a\" in",
        '    *integrity_check*) echo "malformed"; exit 0 ;;',
        "  esac",
        "done",
        'exec /usr/bin/sqlite3 "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not ok");
    // No file was ever renamed to the final (non-temporary) name.
    const listing = spawnSync(
      "find",
      [join(fixtureHome, ".agent-control-plane", "backups"), "-maxdepth", "1", "-name", "state-*.sqlite", "!", "-name", ".*"],
      { encoding: "utf8" },
    );
    expect((listing.stdout ?? "").trim()).toBe("");
  });

  it("produces an integrity-checked backup while the source database is being written concurrently, and leaves the source open", async () => {
    const root = tempDir("acp-database-backup-concurrent-");
    const { fixtureHome, dbPath } = setUpFixtureHome(root);

    // A second process, independent of the backup script, that inserts rows in a tight loop for
    // the duration of the backup run. If the online backup API were replaced with a raw `cp`,
    // this is the scenario that could copy a torn file; it is also the reason `journal_mode` is
    // read and recorded rather than assumed. `busy_timeout` makes this writer tolerate the brief,
    // ordinary lock contention a concurrent reader causes under `journal_mode=delete` — the same
    // way any well-behaved writer would — rather than treating transient `SQLITE_BUSY` as the
    // scenario under test.
    const writer = spawn(
      "/bin/bash",
      [
        "-c",
        'i=0; end=$((SECONDS+5)); while [ "$SECONDS" -lt "$end" ]; do sqlite3 -cmd ".timeout 5000" "$1" "insert into t values ($i);" || exit 1; i=$((i+1)); done; echo "$i"',
        "writer",
        dbPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let writerStdout = "";
    let writerStderr = "";
    writer.stdout?.on("data", (chunk) => {
      writerStdout += String(chunk);
    });
    writer.stderr?.on("data", (chunk) => {
      writerStderr += String(chunk);
    });
    const writerExit = new Promise<number | null>((resolve) => {
      writer.on("close", (code) => resolve(code));
    });

    // Give the writer a head start so the backup genuinely overlaps live writes.
    execFileSync("sleep", ["1"]);

    const result = runExtractedBackup(fixtureHome, minimalPath());

    // Always wait for the writer before asserting, whether the backup succeeded or not, so a
    // failure never leaves an orphaned background process for the next test.
    const writerCode = await writerExit;

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("backup verified:");

    expect(writerCode).toBe(0);
    expect(writerStderr).toBe("");
    expect(Number(writerStdout.trim())).toBeGreaterThan(0);

    const backupsDir = join(fixtureHome, ".agent-control-plane", "backups");
    const listing = spawnSync(
      "find",
      [backupsDir, "-maxdepth", "1", "-name", "state-*.sqlite", "!", "-name", ".*"],
      { encoding: "utf8" },
    );
    const backupFiles = listing.stdout.trim().split("\n").filter((line) => line.length > 0);
    expect(backupFiles.length).toBe(1);
    const backupFile = backupFiles[0];
    if (backupFile === undefined) {
      throw new Error("expected exactly one backup file but found none");
    }

    const integrity = execFileSync("sqlite3", [backupFile, "PRAGMA integrity_check;"], {
      encoding: "utf8",
    }).trim();
    expect(integrity).toBe("ok");

    // The source must still be open and writable after the backup — the online backup API's
    // whole point, versus a raw `cp` that could contend with or corrupt a live writer.
    const rowCountAfter = Number(
      execFileSync("sqlite3", [dbPath, "insert into t values (999); select count(*) from t;"], {
        encoding: "utf8",
      }).trim(),
    );
    expect(rowCountAfter).toBeGreaterThan(3);
  }, 20_000);

  it("publishes atomically: two overlapping runs targeting the same final name — exactly one wins, and its artifact is byte-unchanged afterward", async () => {
    const root = tempDir("acp-database-backup-collision-");
    const { fixtureHome } = setUpFixtureHome(root);

    // `date` stubbed to a fixed value, but only for the exact call the script makes to name the
    // final destination — so two independent runs are forced to target the identical
    // `$BACKUP_PATH`, deterministically, the way #745 asked for ("pin the timestamp so the
    // collision is deterministic"), not by racing and hoping. Every other `date` invocation (the
    // manifest's `createdAt`) passes straight through to the real binary.
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, "date");
    writeFileSync(
      stubPath,
      [
        "#!/bin/bash",
        'if [ "$1" = "-u" ] && [ "$2" = "+%Y%m%dT%H%M%SZ" ]; then',
        '  echo "FIXEDSTAMP"',
        "else",
        '  exec /bin/date "$@"',
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    const path = minimalPath(stubDir);
    const [r1, r2] = await Promise.all([
      spawnExtractedBackup(fixtureHome, path),
      spawnExtractedBackup(fixtureHome, path),
    ]);

    expect(r1.spawnError).toBeUndefined();
    expect(r2.spawnError).toBeUndefined();
    expect(r1.signal).toBeNull();
    expect(r2.signal).toBeNull();

    const results = [r1, r2];
    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code !== 0);
    // Exactly one success and one collision — never both succeeding (the reservation guard
    // removed, or absent) and never both failing (a defect of a different shape entirely).
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    const winner = winners[0];
    const loser = losers[0];
    if (winner === undefined || loser === undefined) {
      throw new Error("expected exactly one winner and one loser");
    }
    expect(loser.stderr).toContain("already owns the final name");
    expect(winner.stdout).toContain("backup verified:");

    const winnerShaMatch = winner.stdout.match(/"databaseSha256": "(sha256:[0-9a-f]{64})"/);
    if (winnerShaMatch === null) {
      throw new Error("the winning run's stdout did not contain a databaseSha256 to compare against");
    }
    const winnerSha256 = winnerShaMatch[1];

    const backupsDir = join(fixtureHome, ".agent-control-plane", "backups");
    const finalFile = join(backupsDir, "state-FIXEDSTAMP.sqlite");
    const finalManifest = `${finalFile}.manifest.json`;
    expect(existsSync(finalFile)).toBe(true);
    expect(existsSync(finalManifest)).toBe(true);

    // The earlier (winning) run's artifact, byte-unchanged: the loser never got to overwrite it
    // with its own (independently built, separately verified) copy.
    expect(sha256Of(finalFile)).toBe(winnerSha256);

    const integrity = execFileSync("sqlite3", [finalFile, "PRAGMA integrity_check;"], {
      encoding: "utf8",
    }).trim();
    expect(integrity).toBe("ok");

    // Nothing else left behind under the claimed name — no reservation, no orphan, no temp file:
    // exactly the published pair and nothing more.
    expect(listing(backupsDir).sort()).toEqual([finalFile, finalManifest].sort());
  });

  it("leaves zero consumable backups at the final path when the second publish step fails after the first succeeded", () => {
    const root = tempDir("acp-database-backup-partial-publish-");
    const { fixtureHome } = setUpFixtureHome(root);
    const { backupsDir, finalDb, finalManifest } = finalPathsFor(fixtureHome);

    const stubDir = join(root, "stub-bin");
    writeFixedDateStub(stubDir);
    // Fail the *second* operation that writes a final name, whichever tool performs it and
    // whichever name comes first — so this case is about the half-published shape itself rather
    // than about one implementation of publishing. The counter is shared across both stubs.
    const counter = join(root, "publish-count");
    for (const tool of ["mv", "ln"]) {
      writeStub(stubDir, tool, [
        "#!/bin/bash",
        'last="${@: -1}"',
        'case "$last" in',
        `  "${finalDb}"|"${finalManifest}")`,
        `    n=$(/bin/cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${counter}"`,
        '    if [ "$n" -ge 2 ]; then echo "stub: second publish step failed" >&2; exit 1; fi',
        "    ;;",
        "esac",
        `exec /bin/${tool} "$@"`,
      ]);
    }

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("second publish step failed");

    // Zero consumable incomplete backups: no database-without-manifest, no manifest-without-
    // database, and no temp file left claiming anything — the failed run unwound exactly what it
    // had already put at a final name.
    expect(listing(backupsDir)).toEqual([]);
  });

  // #745, CEO round 4, blocker 2. The two halves of this procedure had two manifest schemas: the
  // document wrote `agent-control-plane.sqlite-backup/online-v1` with `backupSha256`, and
  // `readManifest` in src/db/backup.ts — which every restore goes through — accepts only
  // `…/v1` with a `sha256:`-prefixed `databaseSha256`, a `schemaVersion`, and a `databaseFile`
  // equal to the backup's basename. So the procedure that exists to make a rollback possible
  // produced a backup the rollback rejects.
  //
  // Asserting the manifest's *shape* would not have caught it and must not be what this checks:
  // a hand-written expectation is exactly how the two drifted apart. This runs the documented
  // commands for real, against a real ACP database, and hands the result to the function item 6
  // actually calls.
  it("produces a backup that item 6's real restore validator accepts, end to end", () => {
    const root = tempDir("acp-database-backup-restore-roundtrip-");
    const fixtureHome = join(root, "home");
    const stateDir = join(fixtureHome, ".agent-control-plane");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(fixtureHome, 0o700);
    chmodSync(stateDir, 0o700);

    // A real ACP database, not a scratch table. `validateBackup` re-reads `PRAGMA user_version`,
    // asserts this schema's load-bearing invariants and its migration ledger at that version, so
    // nothing less than the real thing can demonstrate acceptance.
    //
    // In `delete` journal mode, because that is what the live `state.sqlite` measures as, and the
    // procedure is written for it. `Db`'s constructor sets WAL on a database it creates, which is
    // a divergence worth knowing about — step 1 of the document now refuses a WAL source by name
    // rather than letting `sqlite3 -readonly` fail it with a bare errno.
    const source = join(stateDir, "state.sqlite");
    new Db(source).close();
    execFileSync("sqlite3", [source, "PRAGMA journal_mode=DELETE;"]);
    for (const sidecar of [`${source}-wal`, `${source}-shm`]) {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    chmodSync(source, 0o600);

    const result = runExtractedBackup(fixtureHome, minimalPath());
    expect(result.spawnError).toBeUndefined();
    expect(result.code).toBe(0);
    const published = /backup verified: (\S+)/.exec(result.stdout)?.[1];
    if (published === undefined) {
      throw new Error(`the documented backup did not report a published path:\n${result.stderr}`);
    }

    // `state-admin.js restore` is lock check + `restoreDatabase`, and `restoreDatabase` is
    // `validateBackup` + install. This is that path, on the bytes the document just produced.
    const target = join(root, "restore-target");
    mkdirSync(target, { recursive: true });
    chmodSync(target, 0o700);
    const restoredPath = join(target, "state.sqlite");
    const restored = restoreDatabase(restoredPath, published);
    expect(restored.restoredFrom).toBe(published);
    expect(restored.databasePath).toBe(restoredPath);

    // And the restored image is a database this binary will open, which is the property a
    // rollback needs and an accepted manifest alone does not prove.
    const reopened = new Db(restoredPath);
    try {
      expect(Number(reopened.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  }, 60_000);

  // #745 round 4, measured while building the case above. Every `sqlite3` call in this block
  // passes `-readonly`, and a read-only connection to a WAL database has to create the `-shm`
  // file it is not permitted to create. The document declares the live database is `delete` —
  // true, measured — but `Db`'s constructor sets `journal_mode = WAL` on a database it creates,
  // so a state file made by this code rather than inherited is WAL, and the procedure would fail
  // with a bare `SQLITE_CANTOPEN (14)` that explains nothing.
  //
  // The assertion is the named refusal, not merely a nonzero exit: without the guard the script
  // still fails, it just fails without saying why — which is the shape this whole block exists to
  // eliminate.
  it("refuses a WAL source by name rather than letting a read-only connection fail with an errno", () => {
    const root = tempDir("acp-database-backup-wal-source-");
    const fixtureHome = join(root, "home");
    const stateDir = join(fixtureHome, ".agent-control-plane");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(fixtureHome, 0o700);
    chmodSync(stateDir, 0o700);

    // Exactly what `new Db(...)` leaves behind, cleanly closed: WAL declared in the header, no
    // sidecars on disk.
    const source = join(stateDir, "state.sqlite");
    new Db(source).close();
    for (const sidecar of [`${source}-wal`, `${source}-shm`]) {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    expect(
      execFileSync("od", ["-An", "-tu1", "-j18", "-N1", source], { encoding: "utf8" }).trim(),
    ).toBe("2");

    const result = runExtractedBackup(fixtureHome, minimalPath());

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("has SQLite write-format 2, not 1");
    expect(existsSync(join(stateDir, "backups"))).toBe(false);
  }, 60_000);

  // #745 round 4: `schemaVersion` is the one JSON-unquoted field, so an empty or non-numeric
  // reading does not make the manifest wrong — it makes it not JSON, and `readManifest` then
  // fails at restore time with a parse error instead of here with a refusal.
  it("refuses when the backup's user_version does not read as an integer, before publishing a manifest", () => {
    const root = tempDir("acp-database-backup-nonnumeric-version-");
    const { fixtureHome } = setUpFixtureHome(root);
    const { backupsDir } = finalPathsFor(fixtureHome);

    const stubDir = join(root, "stub-bin");
    writeFixedDateStub(stubDir);
    // Answers `PRAGMA user_version` with nothing for the temp file only, so step 1's reading of
    // the source is untouched and the failure is specifically about the value that reaches the
    // manifest.
    writeStub(stubDir, "sqlite3", [
      "#!/bin/bash",
      'if [ "${*}" != "${*/user_version}" ] && [ "${*}" != "${*/.tmp-}" ]; then',
      "  exit 0",
      "fi",
      'exec /usr/bin/sqlite3 "$@"',
    ]);

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not an integer");
    expect(listing(backupsDir)).toEqual([]);
  });

  // #745, CEO round 3: the claim is a hard link, and `ln` needs both names on one filesystem.
  // `$BACKUP_TMP` is a sibling of `$BACKUP_PATH` inside `$BACKUP_DIR`, so this holds — which is
  // exactly why it is asserted rather than assumed. An assumption nothing checks is the shape
  // that survives until the day the directory is a mount point and the failure is a clobber.
  it("refuses when the temp file is not on the same filesystem as the destination directory", () => {
    const root = tempDir("acp-database-backup-cross-device-");
    const { fixtureHome } = setUpFixtureHome(root);
    const { backupsDir } = finalPathsFor(fixtureHome);

    const stubDir = join(root, "stub-bin");
    writeFixedDateStub(stubDir);
    // A `stat` that reports a different device number for the temp file than for its own parent
    // directory, and passes every other query (`%z`, `%i`, `%Sm` on the source) straight through.
    writeStub(stubDir, "stat", [
      "#!/bin/bash",
      `if [ "$1" = "-f" ] && [ "$2" = "%d" ]; then`,
      '  case "$3" in',
      '    *.tmp-*) echo "999999"; exit 0 ;;',
      "  esac",
      "fi",
      'exec /usr/bin/stat "$@"',
    ]);

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not on the same filesystem");
    // Refused before anything was published, and nothing left behind — the cleanup trap is armed
    // before the temp file can exist, so a refusal at this point is not a refusal that littered.
    expect(listing(backupsDir)).toEqual([]);
  });

  // #745, CEO round 3, counterexample 2 — the delayed claim. A mutual-exclusion primitive whose
  // lifetime is the critical section cannot protect an artifact that outlives it: a reservation
  // released once a run has published leaves the published name unclaimed, and a second run that
  // passed the destination precheck *before* that publication happened will not re-check it.
  it("refuses a delayed claim: a run that passed the destination check before another run published cannot overwrite it", async () => {
    const root = tempDir("acp-database-backup-delayed-claim-");
    const { fixtureHome, dbPath } = setUpFixtureHome(root);

    const winnerBin = join(root, "winner-bin");
    writeFixedDateStub(winnerBin);

    const stalledBin = join(root, "stalled-bin");
    writeFixedDateStub(stalledBin);
    const reached = join(root, "stalled-reached");
    const release = join(root, "stalled-release");
    writeBarrierSqlite3Stub(stalledBin, reached, release);

    // The stalled run starts first and parks after its `[ -e "$BACKUP_PATH" ]` precheck. Its view
    // of the final name is now stale for the rest of its life, deterministically.
    const stalled = spawnExtractedBackup(fixtureHome, minimalPath(stalledBin));
    await waitForFile(reached);

    // The other run then goes all the way through, cleanup included.
    const winner = runExtractedBackup(fixtureHome, minimalPath(winnerBin));
    expect(winner.spawnError).toBeUndefined();
    expect(winner.code).toBe(0);
    const winnerShaMatch = winner.stdout.match(/"databaseSha256": "(sha256:[0-9a-f]{64})"/);
    if (winnerShaMatch === null) {
      throw new Error("the winning run's stdout did not contain a databaseSha256 to compare against");
    }
    const winnerSha256 = winnerShaMatch[1];

    const { finalDb, finalManifest } = finalPathsFor(fixtureHome);
    expect(sha256Of(finalDb)).toBe(winnerSha256);

    // Move the source on before releasing the stalled run, so its own copy is genuinely different
    // bytes. Without this both runs copy an identical database and an overwrite is
    // indistinguishable from no overwrite — the assertion would pass against the defect.
    execFileSync("sqlite3", [
      dbPath,
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000) INSERT INTO t SELECT x FROM c;",
    ]);

    writeFileSync(release, "go\n");
    const stalledResult = await stalled;

    expect(stalledResult.spawnError).toBeUndefined();
    // The final name is a claim that is never released, so the delayed run collides here rather
    // than publishing over an artifact it last looked at before that artifact existed.
    expect(stalledResult.code).not.toBe(0);
    expect(stalledResult.stderr).toContain("already owns the final name");
    // Bytes on disk against what the winner reported — not merely "a file is still there".
    expect(sha256Of(finalDb)).toBe(winnerSha256);
    expect(readFileSync(finalManifest, "utf8")).toContain(`"databaseSha256": "${winnerSha256}"`);
  }, 60_000);

  // #745, CEO round 3, counterexample 1 — `trap … EXIT` does not run on SIGKILL or power loss, so
  // integrity across the two published names cannot depend on it. Ordering is what has to carry
  // it: the database is linked last, which makes it the commit marker.
  it("leaves no database at the final path when the run dies untrappably mid-publish, and the next run refuses rather than resuming", () => {
    const root = tempDir("acp-database-backup-sigkill-");
    const { fixtureHome } = setUpFixtureHome(root);
    const { backupsDir, finalDb, finalManifest } = finalPathsFor(fixtureHome);

    const killBin = join(root, "kill-bin");
    writeFixedDateStub(killBin);
    // Whatever tool publishes, and whichever name it publishes first: do the real operation, then
    // SIGKILL the shell that invoked it. No `trap` runs — which is the point. A host losing power
    // does not run the trap either, and the existing failure fixture (an ordinary nonzero return
    // from the second publish call) always reaches it.
    for (const tool of ["mv", "ln"]) {
      writeStub(killBin, tool, [
        "#!/bin/bash",
        `/bin/${tool} "$@" || exit $?`,
        'last="${@: -1}"',
        'case "$last" in',
        `  "${finalDb}"|"${finalManifest}") kill -9 "$PPID" ;;`,
        "esac",
        "exit 0",
      ]);
    }

    const killed = runExtractedBackup(fixtureHome, minimalPath(killBin));
    expect(killed.spawnError).toBeUndefined();
    expect(killed.signal).toBe("SIGKILL");

    // Item 6 opens `$BACKUP_PATH` with `sqlite3` and treats it as a verified backup. A database
    // sitting at that name with no manifest beside it is therefore the one shape that must be
    // unreachable even when no cleanup code gets to run at all.
    expect(existsSync(finalDb)).toBe(false);

    // The claim is permanent, so the next run refuses instead of resuming into a name whose
    // history it cannot see.
    const laterBin = join(root, "later-bin");
    writeFixedDateStub(laterBin);
    const later = runExtractedBackup(fixtureHome, minimalPath(laterBin));
    expect(later.spawnError).toBeUndefined();
    expect(later.code).not.toBe(0);
    expect(later.stderr).toContain("already owns the final name");
    expect(existsSync(finalDb)).toBe(false);
    // And it did not publish under the claimed name by another route either.
    expect(listing(backupsDir).filter((p) => p === finalDb)).toEqual([]);
  }, 60_000);

  // #745, CEO round 3, the derivative of counterexample 2 and its own property: a run that fails
  // must unwind what *it* created and nothing else. Cleanup keyed to a released lock deletes by
  // name, and by then the name no longer says who owns it.
  it("a failed run does not delete another run's published backup", async () => {
    const root = tempDir("acp-database-backup-stranger-delete-");
    const { fixtureHome } = setUpFixtureHome(root);
    const { finalDb, finalManifest } = finalPathsFor(fixtureHome);

    const winnerBin = join(root, "winner-bin");
    writeFixedDateStub(winnerBin);

    const stalledBin = join(root, "stalled-bin");
    writeFixedDateStub(stalledBin);
    const reached = join(root, "stalled-reached");
    const release = join(root, "stalled-release");
    writeBarrierSqlite3Stub(stalledBin, reached, release);
    // The stalled run's own publish step fails, whichever tool and whichever name it reaches
    // first. Its unwinding must touch only what it created.
    for (const tool of ["mv", "ln"]) {
      writeStub(stalledBin, tool, [
        "#!/bin/bash",
        'last="${@: -1}"',
        'case "$last" in',
        `  "${finalDb}"|"${finalManifest}") echo "stub: publish step failed" >&2; exit 1 ;;`,
        "esac",
        `exec /bin/${tool} "$@"`,
      ]);
    }

    const stalled = spawnExtractedBackup(fixtureHome, minimalPath(stalledBin));
    await waitForFile(reached);

    const winner = runExtractedBackup(fixtureHome, minimalPath(winnerBin));
    expect(winner.spawnError).toBeUndefined();
    expect(winner.code).toBe(0);
    const winnerShaMatch = winner.stdout.match(/"databaseSha256": "(sha256:[0-9a-f]{64})"/);
    if (winnerShaMatch === null) {
      throw new Error("the winning run's stdout did not contain a databaseSha256 to compare against");
    }
    const winnerSha256 = winnerShaMatch[1];
    const winnerManifest = readFileSync(finalManifest, "utf8");

    writeFileSync(release, "go\n");
    const stalledResult = await stalled;

    expect(stalledResult.spawnError).toBeUndefined();
    expect(stalledResult.code).not.toBe(0);

    // The published pair belongs to the run that made it. Another run's failure is not a licence
    // to remove it.
    expect(existsSync(finalDb)).toBe(true);
    expect(sha256Of(finalDb)).toBe(winnerSha256);
    expect(existsSync(finalManifest)).toBe(true);
    expect(readFileSync(finalManifest, "utf8")).toBe(winnerManifest);
  }, 60_000);
});
