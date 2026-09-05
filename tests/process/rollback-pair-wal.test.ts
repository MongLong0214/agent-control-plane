import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { sealRollbackPair, type RollbackPairSources } from "../../src/deploy/rollback-pair.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * What "WAL-complete" has to mean for a sealed pair, and why a copy is not it.
 *
 * SQLite in WAL mode commits into a side file. Until a checkpoint runs, the main `.sqlite` file
 * does not contain those pages at all — it is a valid database that is simply older than the last
 * commit. `cp state.sqlite` therefore produces a file that opens cleanly, passes an integrity
 * check, and is silently missing everything committed since the last checkpoint. A rollback
 * resting on it restores a database that never existed.
 *
 * So this test writes rows that are committed and deliberately *not* checkpointed, proves the
 * main file alone does not have them, and then requires the sealed member to have them. The
 * counterexample is run for real rather than described: the raw copy is taken in the same
 * fixture, from the same file, at the same moment.
 *
 * It also asserts the one destructive thing a naive implementation reaches for — checkpoint the
 * source and delete its `-wal`/`-shm` so the copy is complete. Sealing a recovery point must not
 * touch the database it is a recovery point for.
 *
 * Process-level on purpose: the last step runs the built `dist/deploy/rollback-pair.js` as a real
 * child, because that binary — not the module import — is what `deploy/install-launchd.sh` uses
 * to prevalidate a pair before it stops anything. Run `pnpm build` first.
 */

const LABEL = "com.agentcontrolplane.agentcpd";
const VALIDATOR = join(process.cwd(), "dist", "deploy", "rollback-pair.js");
const PROBE_ROWS = 64;

interface WalFixture {
  databasePath: string;
  sources: RollbackPairSources;
  pairsRoot: string;
  rawMainFileCopy: string;
  /** Held open on purpose: closing it checkpoints the log and destroys the state under test. */
  close: () => void;
}

/**
 * A database with committed rows still resident in the write-ahead log.
 *
 * `wal_autocheckpoint = 0` is what makes the state reproducible: without it SQLite folds the log
 * back into the main file on its own schedule and the fixture stops testing anything.
 */
const buildDatabaseWithUncheckpointedCommits = (root: string): WalFixture => {
  const state = join(root, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const databasePath = join(state, "state.sqlite");
  new Db(databasePath).close();
  chmodSync(databasePath, 0o600);

  const raw = new Database(databasePath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("wal_autocheckpoint = 0");
  raw.exec("CREATE TABLE wal_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  const insert = raw.prepare("INSERT INTO wal_probe (id, payload) VALUES (?, ?)");
  const writeAll = raw.transaction(() => {
    for (let id = 1; id <= PROBE_ROWS; id += 1) insert.run(id, `committed-into-the-wal-${id}`);
  });
  writeAll();
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }

  const rawMainFileCopy = join(root, "raw-main-file-copy.sqlite");
  copyFileSync(databasePath, rawMainFileCopy);

  const runtimeRoot = join(root, "runtime-source");
  mkdirSync(join(runtimeRoot, "daemon"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, "daemon", "agentcpd.js"), "// sealed runtime closure\n", { mode: 0o600 });
  const plistPath = join(root, `${LABEL}.plist`);
  writeFileSync(plistPath, '<?xml version="1.0"?><plist><dict/></plist>\n', { mode: 0o600 });
  const launcherPath = join(root, "agentcpd-launch.sh");
  writeFileSync(launcherPath, "#!/bin/bash\nexec agentcpd\n", { mode: 0o600 });

  return {
    databasePath,
    rawMainFileCopy,
    close: () => raw.close(),
    pairsRoot: join(root, "rollback-pairs"),
    sources: {
      databasePath,
      runtimeRoot,
      entrypoint: "daemon/agentcpd.js",
      nodePath: "/opt/sealed-generation/bin/node",
      nodeVersion: "v22.18.0",
      launchd: { label: LABEL, generation: "generation-under-test", plistPath, launcherPath },
    },
  };
};

/**
 * Reads through a throwaway copy rather than the file itself. Opening a WAL-mode database
 * read-write creates sidecars beside it, and doing that to a sealed member would change the pair
 * this test is about; opening one read-only without its `-shm` is refused outright by SQLite.
 */
let probeSequence = 0;
const probeRowCount = (path: string): number => {
  const scratch = join(tempDir("acp-rollback-pair-probe-"), `probe-${(probeSequence += 1)}.sqlite`);
  copyFileSync(path, scratch);
  const raw = new Database(scratch);
  try {
    const table = raw
      .prepare("SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'wal_probe'")
      .get() as { present: number };
    if (table.present === 0) return -1;
    return (raw.prepare("SELECT count(*) AS rows FROM wal_probe").get() as { rows: number }).rows;
  } finally {
    raw.close();
  }
};

describe("a sealed rollback pair carries a WAL-complete image", () => {
  it("seals what is committed, which the main file alone does not have", async () => {
    const fixture = buildDatabaseWithUncheckpointedCommits(tempDir("acp-rollback-pair-wal-"));
    try {
      // The counterexample, measured rather than asserted: the bytes of the main file at the
      // moment of capture do not contain the committed rows.
      expect(existsSync(`${fixture.databasePath}-wal`)).toBe(true);
      expect(statSync(`${fixture.databasePath}-wal`).size).toBeGreaterThan(0);
      expect(probeRowCount(fixture.rawMainFileCopy)).not.toBe(PROBE_ROWS);

      const pair = await sealRollbackPair(fixture.pairsRoot, fixture.sources);
      expect(probeRowCount(join(pair.root, pair.manifest.database.member))).toBe(PROBE_ROWS);
    } finally {
      fixture.close();
    }
  });

  it("leaves the source database and both sidecars exactly as it found them", async () => {
    const fixture = buildDatabaseWithUncheckpointedCommits(tempDir("acp-rollback-pair-wal-intact-"));
    try {
      const before = [
        fixture.databasePath,
        `${fixture.databasePath}-wal`,
        `${fixture.databasePath}-shm`,
      ].map((path) => ({ path, present: existsSync(path), size: existsSync(path) ? statSync(path).size : -1 }));
      expect(before.every((entry) => entry.present)).toBe(true);

      await sealRollbackPair(fixture.pairsRoot, fixture.sources);

      for (const entry of before) {
        expect(existsSync(entry.path), `${entry.path} was removed while sealing`).toBe(true);
        expect(statSync(entry.path).size, `${entry.path} was truncated while sealing`).toBe(entry.size);
      }
    } finally {
      fixture.close();
    }
  });

  it("prevalidates through the built binary the installer actually runs", async () => {
    expect(existsSync(VALIDATOR), `${VALIDATOR} is missing — run pnpm build first`).toBe(true);
    const fixture = buildDatabaseWithUncheckpointedCommits(tempDir("acp-rollback-pair-wal-cli-"));
    try {
      const pair = await sealRollbackPair(fixture.pairsRoot, fixture.sources);

      const accepted = spawnSync(
        process.execPath,
        [
          VALIDATOR,
          "validate",
          "--pair-root",
          pair.root,
          "--pair-id",
          pair.pairId,
          "--expected-index-digest",
          pair.indexDigest,
        ],
        { encoding: "utf8" },
      );
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain(
        `ACP_PAIR_DATABASE=${join(pair.root, pair.manifest.database.member)}`,
      );
      expect(accepted.stdout).toContain("ACP_PAIR_SERVICE_GENERATION=generation-under-test");

      const refused = spawnSync(
        process.execPath,
        [
          VALIDATOR,
          "validate",
          "--pair-root",
          pair.root,
          "--pair-id",
          pair.pairId,
          "--expected-index-digest",
          `sha256:${"0".repeat(64)}`,
        ],
        { encoding: "utf8" },
      );
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("index digest");
    } finally {
      fixture.close();
    }
  });
});
