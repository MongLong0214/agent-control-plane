import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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
 * The corrected block claims the final name with `mkdir` (POSIX-atomic, fails `EEXIST` rather
 * than replacing) before either `mv`, and unwinds anything it already published if it does not
 * reach the end — so a partial publish leaves nothing at the final path at all.
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

    const winnerShaMatch = winner.stdout.match(/"backupSha256": "([0-9a-f]{64})"/);
    if (winnerShaMatch === null) {
      throw new Error("the winning run's stdout did not contain a backupSha256 to compare against");
    }
    const winnerSha256 = winnerShaMatch[1];

    const backupsDir = join(fixtureHome, ".agent-control-plane", "backups");
    const finalFile = join(backupsDir, "state-FIXEDSTAMP.sqlite");
    const finalManifest = `${finalFile}.manifest.json`;
    expect(existsSync(finalFile)).toBe(true);
    expect(existsSync(finalManifest)).toBe(true);

    const onDiskSha256 = execFileSync("shasum", ["-a", "256", finalFile], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];
    // The earlier (winning) run's artifact, byte-unchanged: the loser never got to overwrite it
    // with its own (independently built, separately verified) copy.
    expect(onDiskSha256).toBe(winnerSha256);

    const integrity = execFileSync("sqlite3", [finalFile, "PRAGMA integrity_check;"], {
      encoding: "utf8",
    }).trim();
    expect(integrity).toBe("ok");

    // No reservation directory left behind claiming the name either.
    const reservationListing = spawnSync(
      "find",
      [backupsDir, "-mindepth", "1", "-name", ".reserved-*"],
      { encoding: "utf8" },
    );
    expect((reservationListing.stdout ?? "").trim()).toBe("");
  });

  it("leaves zero consumable backups at the final path when the manifest publish fails after the database publish succeeds", () => {
    const root = tempDir("acp-database-backup-partial-publish-");
    const { fixtureHome } = setUpFixtureHome(root);

    // A `mv` stub that behaves exactly like the real one, except for the one call that publishes
    // the manifest to its final name — injecting a failure strictly *after* the database's own
    // `mv` to `$BACKUP_PATH` has already succeeded, per #745's required RED (b).
    const stubDir = join(root, "stub-bin");
    mkdirSync(stubDir, { recursive: true });
    const stubPath = join(stubDir, "mv");
    writeFileSync(
      stubPath,
      [
        "#!/bin/bash",
        'last="${@: -1}"',
        'case "$last" in',
        '  *.manifest.json) echo "stub: manifest publish failed" >&2; exit 1 ;;',
        "esac",
        'exec /bin/mv "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    const result = runExtractedBackup(fixtureHome, minimalPath(stubDir));

    expect(result.spawnError).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("manifest publish failed");

    // Zero consumable incomplete backups: no database-without-manifest (or the reverse) under
    // the final naming pattern, and no reservation directory left claiming the name either — the
    // failed run unwound exactly what it had already published.
    const backupsDir = join(fixtureHome, ".agent-control-plane", "backups");
    const survivors = spawnSync("find", [backupsDir, "-mindepth", "1"], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(survivors).toEqual([]);
  });
});
