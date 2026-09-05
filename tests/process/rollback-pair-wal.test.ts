import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import {
  applyRollbackPair,
  sealRollbackPair,
  stageRollbackPair,
  type RollbackPairExpectation,
  type RollbackPairSources,
} from "../../src/deploy/rollback-pair.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Two claims that only hold at process level.
 *
 * **The image is WAL-complete.** SQLite in WAL mode commits into a side file; until a checkpoint
 * runs, the main `.sqlite` file does not contain those pages. `cp state.sqlite` produces a file
 * that opens cleanly, passes an integrity check, and is silently missing everything committed
 * since the last checkpoint. The counterexample is run for real here rather than described.
 *
 * **The generation moves as one.** A rollback that restores pair A's database and leaves
 * generation B's runtime in place is not a smaller rollback — it is a combination that has never
 * run anywhere, assembled at the moment the deployment is already broken. So these rows seal a
 * real runtime closure (this repository's own `dist`, the actual thing a deployment runs), apply
 * it over a different generation, and check that the database and the bytes changed together.
 *
 * `pnpm build` must have run: the CLI row executes `dist/deploy/rollback-pair.js`, which is what
 * `deploy/install-launchd.sh` invokes, and the sealed closure is `dist` itself.
 */

const LABEL = "com.agentcontrolplane.agentcpd";
const REPO_DIST = join(process.cwd(), "dist");
const VALIDATOR = join(REPO_DIST, "deploy", "rollback-pair.js");
const PROBE_ROWS = 64;

interface WalFixture {
  databasePath: string;
  sources: RollbackPairSources;
  pairsRoot: string;
  rawMainFileCopy: string;
  /** Held open on purpose: closing it checkpoints the log and destroys the state under test. */
  close: () => void;
}

const writeGenerationArtifacts = (
  root: string,
  generation: string,
  appRoot: string,
  launcherDestination: string,
  nodePath: string,
): { plistPath: string; launcherPath: string } => {
  const plistPath = join(root, `${LABEL}.plist`);
  writeFileSync(
    plistPath,
    [
      '<?xml version="1.0"?>',
      "<plist><dict>",
      "  <key>Label</key>",
      `  <string>${LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      `  <array><string>${launcherDestination}</string></array>`,
      "  <key>WorkingDirectory</key>",
      `  <string>${appRoot}</string>`,
      `  <!-- ${generation} -->`,
      "</dict></plist>",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const launcherPath = join(root, "agentcpd-launch.sh");
  writeFileSync(
    launcherPath,
    [
      "#!/bin/bash",
      `# ${generation}`,
      `ACP_NODE_PATH=${nodePath}`,
      `ACP_APP_ROOT=${appRoot}`,
      'exec "$ACP_NODE_PATH" "$ACP_APP_ROOT/dist/daemon/agentcpd.js"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { plistPath, launcherPath };
};

/**
 * A database with committed rows still resident in the write-ahead log.
 *
 * `wal_autocheckpoint = 0` is what makes the state reproducible: without it SQLite folds the log
 * back into the main file on its own schedule and the fixture stops testing anything.
 */
const buildDatabaseWithUncheckpointedCommits = (root: string): WalFixture => {
  const appRootRaw = join(root, "app-root");
  mkdirSync(join(appRootRaw, "dist"), { recursive: true, mode: 0o700 });
  const appRoot = realpathSync(appRootRaw);
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

  const source = join(root, "source");
  const runtimeRoot = join(source, "runtime");
  mkdirSync(join(runtimeRoot, "daemon"), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtimeRoot, "db"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, "daemon", "agentcpd.js"), "// sealed runtime closure\n", { mode: 0o600 });
  writeFileSync(join(runtimeRoot, "db", "state-admin.js"), "// sealed state admin\n", { mode: 0o600 });
  const launcherDestination = join(realpathSync(state), "agentcpd-launch.sh");
  const artifacts = writeGenerationArtifacts(source, "generation-under-test", appRoot, launcherDestination, "/opt/sealed/bin/node");

  return {
    databasePath,
    rawMainFileCopy,
    close: () => raw.close(),
    pairsRoot: join(root, "rollback-pairs"),
    sources: {
      databasePath,
      runtimeRoot,
      entrypoint: "daemon/agentcpd.js",
      stateAdmin: "db/state-admin.js",
      nodePath: "/opt/sealed/bin/node",
      nodeVersion: "v22.18.0",
      install: {
        runtimeRoot: join(appRoot, "dist"),
        plistPath: join(realpathSync(root), "LaunchAgents.plist"),
        launcherPath: launcherDestination,
        workingDirectory: appRoot,
      },
      launchd: {
        label: LABEL,
        generation: "generation-under-test",
        plistPath: artifacts.plistPath,
        launcherPath: artifacts.launcherPath,
      },
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

/**
 * A whole deployment: an app root whose `dist` is a real runtime closure, a live database, and a
 * plist and launcher bound to that generation. `dist` is this repository's own build, so the
 * state-admin the rollback executes is the real CLI and the real `restoreDatabase` chain rather
 * than a stub that would agree with anything.
 */
interface GenerationFixture {
  root: string;
  appRoot: string;
  installRoot: string;
  databasePath: string;
  plistDestination: string;
  launcherDestination: string;
  pairsRoot: string;
  sourcesFor: (generation: string, runtimeRoot: string) => RollbackPairSources;
  expectation: (pairId: string, indexDigest: string) => RollbackPairExpectation;
}

const GENERATION_MARKER = "GENERATION.txt";

const makeGenerationFixture = (prefix: string): GenerationFixture => {
  const root = tempDir(prefix);
  const appRootRaw = join(root, "app-root");
  const state = join(root, "state");
  const launchAgents = join(root, "LaunchAgents");
  mkdirSync(appRootRaw, { recursive: true, mode: 0o700 });
  // A real deployment resolves the closure's dependencies from a sibling of `dist`, not from
  // inside it. Linking rather than copying keeps the fixture small; what matters is that the
  // sibling is outside the install root, so a rollback replaces `dist` and leaves it alone —
  // which is exactly the shape the sealed closure assumes.
  symlinkSync(join(process.cwd(), "node_modules"), join(appRootRaw, "node_modules"));
  const appRoot = realpathSync(appRootRaw);
  const installRoot = join(appRoot, "dist");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });

  const databasePath = join(realpathSync(state), "state.sqlite");
  const plistDestination = join(realpathSync(launchAgents), `${LABEL}.plist`);
  const launcherDestination = join(realpathSync(state), "agentcpd-launch.sh");

  return {
    root,
    appRoot,
    installRoot,
    databasePath,
    plistDestination,
    launcherDestination,
    pairsRoot: join(root, "rollback-pairs"),
    sourcesFor: (generation, runtimeRoot) => {
      const source = join(root, `source-${generation}`);
      mkdirSync(source, { recursive: true, mode: 0o700 });
      const artifacts = writeGenerationArtifacts(
        source,
        generation,
        appRoot,
        launcherDestination,
        process.execPath,
      );
      return {
        databasePath,
        runtimeRoot,
        entrypoint: "daemon/agentcpd.js",
        stateAdmin: "db/state-admin.js",
        nodePath: process.execPath,
        nodeVersion: process.version,
        install: {
          runtimeRoot: installRoot,
          plistPath: plistDestination,
          launcherPath: launcherDestination,
          workingDirectory: appRoot,
        },
        launchd: { label: LABEL, generation, plistPath: artifacts.plistPath, launcherPath: artifacts.launcherPath },
      };
    },
    expectation: (pairId, indexDigest) => ({
      pairId,
      indexDigest,
      databaseTargetPath: databasePath,
      serviceLabel: LABEL,
      workingDirectory: appRoot,
    }),
  };
};

/** A copy of the real built closure, marked so a test can tell which generation is installed. */
const runtimeClosureFor = (root: string, generation: string): string => {
  const runtimeRoot = join(root, `runtime-${generation}`);
  cpSync(REPO_DIST, runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, GENERATION_MARKER), `${generation}\n`, { mode: 0o600 });
  return runtimeRoot;
};

const installedGeneration = (installRoot: string): string =>
  existsSync(join(installRoot, GENERATION_MARKER))
    ? readFileSync(join(installRoot, GENERATION_MARKER), "utf8").trim()
    : "<none>";

const probeDatabase = (path: string, marker: string): void => {
  const raw = new Database(path);
  try {
    raw.exec("CREATE TABLE IF NOT EXISTS generation_probe (marker TEXT NOT NULL)");
    raw.prepare("INSERT INTO generation_probe (marker) VALUES (?)").run(marker);
  } finally {
    raw.close();
  }
  chmodSync(path, 0o600);
};

const databaseMarkers = (path: string): string[] => {
  const scratch = join(tempDir("acp-generation-probe-"), "probe.sqlite");
  copyFileSync(path, scratch);
  const raw = new Database(scratch);
  try {
    const table = raw
      .prepare("SELECT count(*) AS present FROM sqlite_master WHERE type='table' AND name='generation_probe'")
      .get() as { present: number };
    if (table.present === 0) return [];
    return (raw.prepare("SELECT marker FROM generation_probe ORDER BY rowid").all() as { marker: string }[]).map(
      (row) => row.marker,
    );
  } finally {
    raw.close();
  }
};

describe("a sealed rollback pair carries a WAL-complete image", () => {
  it("seals what is committed, which the main file alone does not have", async () => {
    const fixture = buildDatabaseWithUncheckpointedCommits(tempDir("acp-rollback-pair-wal-"));
    try {
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
});

describe("a rollback installs one whole generation", () => {
  it("replaces generation B's runtime and database together, through the built binary", async () => {
    expect(existsSync(VALIDATOR), `${VALIDATOR} is missing — run pnpm build first`).toBe(true);
    const fixture = makeGenerationFixture("acp-rollback-generation-");

    // Generation A: the deployment as it was, sealed.
    new Db(fixture.databasePath).close();
    probeDatabase(fixture.databasePath, "generation-a");
    const sealed = await sealRollbackPair(
      fixture.pairsRoot,
      fixture.sourcesFor("generation-a", runtimeClosureFor(fixture.root, "generation-a")),
    );

    // The sealed image is the database as it was, before anything moved on.
    expect(databaseMarkers(join(sealed.root, sealed.manifest.database.member))).toEqual(["generation-a"]);

    // Generation B: what is live now — different bytes, and a database that has moved on.
    cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, { recursive: true });
    probeDatabase(fixture.databasePath, "generation-b");
    writeFileSync(fixture.plistDestination, "<!-- generation-b plist -->\n", { mode: 0o600 });
    writeFileSync(fixture.launcherDestination, "#!/bin/bash\n# generation-b\n", { mode: 0o700 });

    expect(installedGeneration(fixture.installRoot)).toBe("generation-b");
    expect(databaseMarkers(fixture.databasePath)).toEqual(["generation-a", "generation-b"]);

    const staged = spawnSync(
      process.execPath,
      [
        VALIDATOR,
        "stage",
        "--pair-root",
        sealed.root,
        "--pair-id",
        sealed.pairId,
        "--expected-index-digest",
        sealed.indexDigest,
        "--expect-database",
        fixture.databasePath,
        "--expect-service-label",
        LABEL,
        "--expect-working-directory",
        fixture.appRoot,
        "--stage-parent",
        join(fixture.root, "stage"),
      ],
      { encoding: "utf8" },
    );
    expect(staged.status, staged.stderr).toBe(0);
    const stageRoot = /ACP_STAGE_ROOT=(.+)/.exec(staged.stdout)?.[1];
    expect(stageRoot).toBeDefined();

    const applied = spawnSync(process.execPath, [VALIDATOR, "apply", "--stage-root", stageRoot!], {
      encoding: "utf8",
    });
    expect(applied.status, applied.stderr).toBe(0);

    // Both halves moved, and they moved together. A database-only rollback would have left
    // generation-b here — the untested combination this whole mechanism exists to prevent.
    //
    // This row is also the regression for a defect it found: the app root here is reached through
    // macOS's `/var` -> `/private/var` link, and `apply` was handing the sealed state-admin its
    // unresolved path. A Node entrypoint compares `import.meta.url` against `process.argv[1]` to
    // decide whether it is the program being run, so the guard never fired, the process exited 0,
    // and the rollback reported success having restored nothing.
    expect(installedGeneration(fixture.installRoot)).toBe("generation-a");
    expect(databaseMarkers(fixture.databasePath), applied.stdout).toEqual(["generation-a"]);
    expect(readFileSync(fixture.plistDestination, "utf8")).toContain("generation-a");
    expect(readFileSync(fixture.launcherDestination, "utf8")).toContain("generation-a");
    // The runtime that is installed really is a working closure, not a marker file.
    expect(existsSync(join(fixture.installRoot, "db", "state-admin.js"))).toBe(true);
  });

  it("refuses a pair sealed for another database or service, through the built binary", async () => {
    const fixture = makeGenerationFixture("acp-rollback-cross-target-");
    new Db(fixture.databasePath).close();
    chmodSync(fixture.databasePath, 0o600);
    const sealed = await sealRollbackPair(
      fixture.pairsRoot,
      fixture.sourcesFor("generation-a", runtimeClosureFor(fixture.root, "generation-a")),
    );
    const elsewhere = makeGenerationFixture("acp-rollback-cross-target-other-");
    new Db(elsewhere.databasePath).close();

    const stageArgs = (overrides: Record<string, string> = {}): string[] => {
      const flags: Record<string, string> = {
        "--pair-root": sealed.root,
        "--pair-id": sealed.pairId,
        "--expected-index-digest": sealed.indexDigest,
        "--expect-database": fixture.databasePath,
        "--expect-service-label": LABEL,
        "--expect-working-directory": fixture.appRoot,
        "--stage-parent": join(fixture.root, "stage"),
        ...overrides,
      };
      return [VALIDATOR, "stage", ...Object.entries(flags).flat()];
    };

    for (const [what, overrides] of [
      ["database", { "--expect-database": elsewhere.databasePath }],
      ["service label", { "--expect-service-label": "com.example.other" }],
      ["app root", { "--expect-working-directory": elsewhere.appRoot }],
    ] as const) {
      const refused = spawnSync(process.execPath, stageArgs(overrides), { encoding: "utf8" });
      expect(refused.status, `${what} mismatch was accepted`).toBe(1);
      expect(refused.stdout).toBe("");
    }

    // A repeated flag is refused rather than silently resolved to its first occurrence — which
    // is how the three rows above passed against an earlier build that never saw the override.
    const repeated = spawnSync(
      process.execPath,
      [...stageArgs(), "--expect-database", elsewhere.databasePath],
      { encoding: "utf8" },
    );
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain("given more than once");
  });

  it("puts the previous generation back at every post-stop failure point", async () => {
    const fixture = makeGenerationFixture("acp-rollback-recovery-");
    new Db(fixture.databasePath).close();
    probeDatabase(fixture.databasePath, "generation-a");
    const sealed = await sealRollbackPair(
      fixture.pairsRoot,
      fixture.sourcesFor("generation-a", runtimeClosureFor(fixture.root, "generation-a")),
    );

    for (const failAfter of ["recovery", "runtime", "plist", "launcher", "database"] as const) {
      // Restore generation B as the live deployment before each attempt.
      cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, {
        recursive: true,
        force: true,
      });
      writeFileSync(fixture.plistDestination, "<!-- generation-b plist -->\n", { mode: 0o600 });
      writeFileSync(fixture.launcherDestination, "#!/bin/bash\n# generation-b\n", { mode: 0o700 });
      const plistBefore = readFileSync(fixture.plistDestination, "utf8");
      const launcherBefore = readFileSync(fixture.launcherDestination, "utf8");
      const runtimeBefore = readdirSync(fixture.installRoot).sort();

      const staged = stageRollbackPair(
        sealed.root,
        fixture.expectation(sealed.pairId, sealed.indexDigest),
        join(fixture.root, `stage-${failAfter}`),
      );
      expect(() => applyRollbackPair(staged, { failAfter })).toThrow(new RegExp(`injected failure after ${failAfter}`));

      expect(installedGeneration(fixture.installRoot), `runtime was left mixed after ${failAfter}`).toBe(
        "generation-b",
      );
      expect(readdirSync(fixture.installRoot).sort(), `runtime contents differ after ${failAfter}`).toEqual(
        runtimeBefore,
      );
      expect(readFileSync(fixture.plistDestination, "utf8"), `plist was left replaced after ${failAfter}`).toBe(
        plistBefore,
      );
      expect(
        readFileSync(fixture.launcherDestination, "utf8"),
        `launcher was left replaced after ${failAfter}`,
      ).toBe(launcherBefore);
    }
  });

  it("refuses a destination of the wrong type before it mutates anything", async () => {
    const fixture = makeGenerationFixture("acp-rollback-destination-");
    new Db(fixture.databasePath).close();
    chmodSync(fixture.databasePath, 0o600);
    const sealed = await sealRollbackPair(
      fixture.pairsRoot,
      fixture.sourcesFor("generation-a", runtimeClosureFor(fixture.root, "generation-a")),
    );
    cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, { recursive: true });
    writeFileSync(fixture.launcherDestination, "#!/bin/bash\n# generation-b\n", { mode: 0o700 });
    // The plist destination is a directory, not a file — a rollback must find that out before it
    // has replaced the runtime, not after.
    mkdirSync(fixture.plistDestination, { recursive: true, mode: 0o700 });

    const staged = stageRollbackPair(
      sealed.root,
      fixture.expectation(sealed.pairId, sealed.indexDigest),
      join(fixture.root, "stage"),
    );
    expect(() => applyRollbackPair(staged)).toThrow(/plist destination is not a regular, non-symlink file/);

    expect(installedGeneration(fixture.installRoot)).toBe("generation-b");
    expect(readFileSync(fixture.launcherDestination, "utf8")).toContain("generation-b");
  });
});
