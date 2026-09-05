import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
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
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, "bin", "node"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  chmodSync(join(runtimeRoot, "bin", "node"), 0o755);
  const launcherDestination = join(realpathSync(state), "agentcpd-launch.sh");
  const artifacts = writeGenerationArtifacts(
    source,
    "generation-under-test",
    appRoot,
    launcherDestination,
    join(appRoot, "dist", "bin", "node"),
  );

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
      nodeExecutable: "bin/node",
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

/** Every flag the one canonical rollback invocation requires. */
const cliFlags = (
  fixture: GenerationFixture,
  sealed: { root: string; pairId: string; indexDigest: string },
): string[] => [
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
  "--expect-runtime-root",
  fixture.installRoot,
  "--expect-schema-version",
  String(SCHEMA_VERSION),
  "--expect-service-generation",
  "generation-a",
  "--expect-node-version",
  process.version,
  "--stage-parent",
  join(fixture.root, "stage"),
];

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
  symlinkSync(join(process.cwd(), "native"), join(appRootRaw, "native"));
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
        join(installRoot, "bin", "node"),
      );
      return {
        databasePath,
        runtimeRoot,
        entrypoint: "daemon/agentcpd.js",
        stateAdmin: "db/state-admin.js",
        nodeExecutable: "bin/node",
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
      runtimeRoot: installRoot,
      schemaVersion: SCHEMA_VERSION,
      serviceGeneration: "generation-a",
      nodeVersion: process.version,
    }),
  };
};

/** A copy of the real built closure, marked so a test can tell which generation is installed. */
const runtimeClosureFor = (root: string, generation: string): string => {
  const runtimeRoot = join(root, `runtime-${generation}`);
  cpSync(REPO_DIST, runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, GENERATION_MARKER), `${generation}\n`, { mode: 0o600 });
  // The interpreter travels inside the closure. Here it is a shim that hands off to this test
  // process's own Node — a tiny synthetic stand-in under the same schema, inventory and mode
  // rules. The heavy row below seals the real 108MB executable and proves the real property.
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, "bin", "node"), `#!/bin/bash\nexec ${process.execPath} "$@"\n`, {
    mode: 0o755,
  });
  chmodSync(join(runtimeRoot, "bin", "node"), 0o755);
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


/**
 * The real executable closure, sealed once.
 *
 * Everything the sealed generation needs to run: the built application tree, the Node executable
 * that runs it, and the native addon it loads — flattened into the layout a deployment installs,
 * with no symbolic links, because a pair refuses those. `cp -Rc` asks APFS for clones, which is
 * what makes carrying a 108MB interpreter cost almost nothing here.
 *
 * This is the one heavy fixture in the suite. Every adversarial row uses a tiny synthetic closure
 * under the same schema, inventory and mode rules; building thirty of these to vary a metadata
 * field would buy nothing and cost gigabytes.
 */
const buildRealClosure = (root: string): string => {
  const closure = join(root, "real-closure");
  mkdirSync(join(closure, "bin"), { recursive: true, mode: 0o700 });
  execFileSync("/bin/cp", ["-Rc", `${REPO_DIST}/.`, closure]);
  mkdirSync(join(closure, "node_modules"), { recursive: true, mode: 0o700 });
  for (const pkg of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const found = execFileSync(
      "/usr/bin/find",
      ["node_modules/.pnpm", "-maxdepth", "4", "-type", "d", "-path", `*/node_modules/${pkg}`],
      { encoding: "utf8", cwd: process.cwd() },
    )
      .split("\n")
      .filter(Boolean)[0];
    if (!found) throw new Error(`the fixture could not find ${pkg} to seal`);
    // `-L` dereferences pnpm's symlinks: a sealed pair refuses links, and rightly.
    execFileSync("/bin/cp", ["-RcL", join(process.cwd(), found), join(closure, "node_modules", pkg)]);
  }
  execFileSync("/bin/cp", ["-c", process.execPath, join(closure, "bin", "node")]);
  chmodSync(join(closure, "bin", "node"), 0o755);
  return closure;
};

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

    // One invocation. There is no stage to hand back and no second command that could be pointed
    // at one, which is the whole point: a stage path on a command line is a mutation authority.
    const applied = spawnSync(process.execPath, [VALIDATOR, "rollback", ...cliFlags(fixture, sealed)], {
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


  it("runs the sealed generation after the source, the external Node and node_modules are gone", async () => {
    const fixture = makeGenerationFixture("acp-rollback-closure-");
    new Db(fixture.databasePath).close();
    probeDatabase(fixture.databasePath, "generation-a");

    const closure = buildRealClosure(fixture.root);
    const sealed = await sealRollbackPair(fixture.pairsRoot, fixture.sourcesFor("generation-a", closure));

    // The pair carries the interpreter and the native addon, with the bits that let them run.
    const inventory = new Map(sealed.manifest.inventory.map((m) => [m.path, m]));
    const sealedNode = inventory.get("runtime/bin/node");
    expect(sealedNode, "the pair does not carry a Node executable").toBeDefined();
    expect(sealedNode!.mode & 0o111, "the sealed interpreter lost its execute bit").not.toBe(0);
    expect(
      [...inventory.keys()].some((path) => path.endsWith(".node")),
      "the pair does not carry the native addon its runtime loads",
    ).toBe(true);

    // Generation B is live, and the database has moved on.
    cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, {
      recursive: true,
      force: true,
    });
    probeDatabase(fixture.databasePath, "generation-b");
    expect(databaseMarkers(fixture.databasePath)).toEqual(["generation-a", "generation-b"]);

    // Everything outside the pair that it could have leaned on is removed before it is used.
    rmSync(closure, { recursive: true, force: true });
    expect(existsSync(closure)).toBe(false);

    const staged = stageRollbackPair(
      sealed.root,
      fixture.expectation(sealed.pairId, sealed.indexDigest),
      join(fixture.root, "stage"),
    );
    applyRollbackPair(staged);

    // The database came back through the sealed state-admin under the sealed interpreter.
    expect(databaseMarkers(fixture.databasePath)).toEqual(["generation-a"]);
    expect(installedGeneration(fixture.installRoot)).toBe("<none>");

    // And the installed generation runs on its own: no PATH, no inherited environment, no
    // external Node and no external node_modules — and it loads the native addon, which is the
    // part a pure-JS closure would pass without proving.
    const installedNode = join(fixture.installRoot, "bin", "node");
    expect(statSync(installedNode).mode & 0o111).not.toBe(0);
    const standalone = spawnSync(
      installedNode,
      [join(fixture.installRoot, "db", "state-admin.js"), "migration-plan", "--database", fixture.databasePath],
      { encoding: "utf8", env: { HOME: fixture.root, PATH: "/nonexistent" } },
    );
    expect(standalone.status, standalone.stderr).toBe(0);
    // A real reading from the sealed closure: it opened the database through the sealed native
    // addon and reported its on-disk version. A module-resolution failure could not get here.
    expect(standalone.stdout).toContain("onDiskVersion");
    expect(JSON.parse(standalone.stdout).onDiskVersion).toBeGreaterThan(0);
  }, 300_000);

  it("refuses a closure that still links a library outside itself", async () => {
    const fixture = makeGenerationFixture("acp-rollback-linkage-");
    new Db(fixture.databasePath).close();
    chmodSync(fixture.databasePath, 0o600);
    const closure = runtimeClosureFor(fixture.root, "generation-a");

    // A real Mach-O with a real external dependency. The library is built outside the closure and
    // linked by its absolute install name, which is exactly the shape that makes a pair install
    // cleanly and then fail to start once the machine it was sealed on has moved on.
    const scratch = join(fixture.root, "linkage");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    writeFileSync(join(scratch, "lib.c"), "int acp_external(void){return 0;}\n");
    writeFileSync(join(scratch, "main.c"), "int acp_external(void);\nint main(void){return acp_external();}\n");
    execFileSync("/usr/bin/cc", ["-dynamiclib", "-o", join(scratch, "libexternal.dylib"), join(scratch, "lib.c")]);
    execFileSync("/usr/bin/cc", [
      "-o",
      join(closure, "bin", "helper"),
      join(scratch, "main.c"),
      join(scratch, "libexternal.dylib"),
    ]);
    // The dependency really is outside the closure and really is not a system library.
    const linkage = execFileSync("/usr/bin/otool", ["-L", join(closure, "bin", "helper")], {
      encoding: "utf8",
    });
    expect(linkage).toContain(join(scratch, "libexternal.dylib"));

    await expect(
      sealRollbackPair(fixture.pairsRoot, fixture.sourcesFor("generation-a", closure)),
    ).rejects.toThrow(/depends on a library outside itself/);
  }, 120_000);

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

    const rollbackArgs = (overrides: Record<string, string> = {}): string[] => [
      VALIDATOR,
      "rollback",
      ...Object.entries({
        ...Object.fromEntries(
          cliFlags(fixture, sealed)
            .reduce<string[][]>((pairs, value, at) => {
              if (at % 2 === 0) pairs.push([value]);
              else pairs[pairs.length - 1]!.push(value);
              return pairs;
            }, [])
            .map((pair) => [pair[0]!, pair[1]!]),
        ),
        ...overrides,
      }).flat(),
    ];

    for (const [what, overrides] of [
      ["database", { "--expect-database": elsewhere.databasePath }],
      ["service label", { "--expect-service-label": "com.example.other" }],
      ["app root", { "--expect-working-directory": elsewhere.appRoot }],
      ["generation", { "--expect-service-generation": "generation-nobody-sealed" }],
      ["runtime version", { "--expect-node-version": "v0.0.0" }],
    ] as const) {
      const refused = spawnSync(process.execPath, rollbackArgs(overrides), { encoding: "utf8" });
      expect(refused.status, `${what} mismatch was accepted`).toBe(1);
      expect(refused.stdout).toBe("");
    }

    // A repeated flag is refused rather than silently resolved to its first occurrence — which
    // is how the rows above passed against an earlier build that never saw the override.
    const repeated = spawnSync(
      process.execPath,
      [...rollbackArgs(), "--expect-database", elsewhere.databasePath],
      { encoding: "utf8" },
    );
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain("given more than once");

    // And the retired handoff is really gone: there is no command that takes a stage.
    const handoff = spawnSync(process.execPath, [VALIDATOR, "apply", "--stage-root", fixture.root], {
      encoding: "utf8",
    });
    expect(handoff.status, "a stage handoff command still exists").not.toBe(0);
    expect(handoff.stdout, "a stage handoff command still installs something").not.toContain(
      "ACP_APPLIED_",
    );
  });

  it("puts the previous generation back at every post-stop failure point", async () => {
    const fixture = makeGenerationFixture("acp-rollback-recovery-");
    new Db(fixture.databasePath).close();
    probeDatabase(fixture.databasePath, "generation-a");
    const sealed = await sealRollbackPair(
      fixture.pairsRoot,
      fixture.sourcesFor("generation-a", runtimeClosureFor(fixture.root, "generation-a")),
    );
    // The live database moves on after the seal, so the sealed image and the live file differ.
    // Without this the database assertions below would hold whether or not anything compensated.
    probeDatabase(fixture.databasePath, "generation-b");
    expect(databaseMarkers(fixture.databasePath)).toEqual(["generation-a", "generation-b"]);

    for (const failAfter of [
      "recovery",
      "runtime",
      "plist",
      "launcher",
      "restoreHelper",
      "database",
      "cleanup",
    ] as const) {
      cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, {
        recursive: true,
        force: true,
      });
      writeFileSync(fixture.plistDestination, "<!-- generation-b plist -->\n", { mode: 0o600 });
      writeFileSync(fixture.launcherDestination, "#!/bin/bash\n# generation-b\n", { mode: 0o700 });
      const plistBefore = readFileSync(fixture.plistDestination, "utf8");
      const launcherBefore = readFileSync(fixture.launcherDestination, "utf8");
      const runtimeBefore = readdirSync(fixture.installRoot).sort();
      const databaseBefore = readFileSync(fixture.databasePath);

      const staged = stageRollbackPair(
        sealed.root,
        fixture.expectation(sealed.pairId, sealed.indexDigest),
        join(fixture.root, `stage-${failAfter}`),
      );
      expect(() => applyRollbackPair(staged, { failAfter })).toThrow(
        new RegExp(`injected failure after ${failAfter}`),
      );

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

      // Real rows, and real bytes. `restoreHelper` fires before the restore runs and `database`
      // fires after it succeeded, so this is the assertion that tells a compensation that put the
      // database back from a rollback that never touched it.
      expect(databaseMarkers(fixture.databasePath), `database rows lost after ${failAfter}`).toEqual([
        "generation-a",
        "generation-b",
      ]);
      if (failAfter !== "database" && failAfter !== "cleanup") {
        expect(
          readFileSync(fixture.databasePath).equals(databaseBefore),
          `database bytes changed after ${failAfter}`,
        ).toBe(true);
      }
    }
  });

  it("carries an empty directory through seal, stage and install", async () => {
    const fixture = makeGenerationFixture("acp-rollback-emptydir-");
    new Db(fixture.databasePath).close();
    probeDatabase(fixture.databasePath, "generation-a");
    const closure = runtimeClosureFor(fixture.root, "generation-a");
    // A directory with nothing in it. A tree copied by walking its files never creates one, so it
    // would be silently absent from the installed generation — and a census over files cannot see
    // that it went missing either.
    mkdirSync(join(closure, "spool"), { mode: 0o700 });
    mkdirSync(join(closure, "spool", "inner"), { mode: 0o750 });

    const sealed = await sealRollbackPair(fixture.pairsRoot, fixture.sourcesFor("generation-a", closure));
    const declared = new Map(sealed.manifest.directories.map((d) => [d.path, d.mode]));
    expect(declared.get("runtime/spool")).toBe(0o700);
    expect(declared.get("runtime/spool/inner"), "the empty directory's mode was not recorded").toBe(0o750);
    expect(existsSync(join(sealed.root, "runtime", "spool", "inner"))).toBe(true);

    cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, { recursive: true });
    writeFileSync(fixture.plistDestination, "<!-- generation-b plist -->\n", { mode: 0o600 });
    writeFileSync(fixture.launcherDestination, "#!/bin/bash\n# generation-b\n", { mode: 0o700 });

    const staged = stageRollbackPair(
      sealed.root,
      fixture.expectation(sealed.pairId, sealed.indexDigest),
      join(fixture.root, "stage"),
    );
    applyRollbackPair(staged);

    // Through the stage and into the installed generation, with its mode.
    const installed = join(fixture.installRoot, "spool", "inner");
    expect(existsSync(installed), "the empty directory was lost on install").toBe(true);
    expect(statSync(installed).mode & 0o7777).toBe(0o750);
  }, 120_000);

  it("refuses a destination swapped between the plan and the step that uses it", async () => {
    const fixture = makeGenerationFixture("acp-rollback-toctou-");
    new Db(fixture.databasePath).close();
    probeDatabase(fixture.databasePath, "generation-a");
    const sealed = await sealRollbackPair(
      fixture.pairsRoot,
      fixture.sourcesFor("generation-a", runtimeClosureFor(fixture.root, "generation-a")),
    );
    cpSync(runtimeClosureFor(fixture.root, "generation-b"), fixture.installRoot, { recursive: true });
    writeFileSync(fixture.plistDestination, "<!-- generation-b plist -->\n", { mode: 0o600 });
    writeFileSync(fixture.launcherDestination, "#!/bin/bash\n# generation-b\n", { mode: 0o700 });
    const launcherBefore = readFileSync(fixture.launcherDestination, "utf8");

    const staged = stageRollbackPair(
      sealed.root,
      fixture.expectation(sealed.pairId, sealed.indexDigest),
      join(fixture.root, "stage"),
    );

    // The window a pathname-based rollback cannot see: the plan is frozen, and the plist is
    // replaced by a symlink pointing somewhere else before the step that writes it runs. A
    // re-check that walked the path again would follow the link and agree.
    const elsewhere = join(fixture.root, "attacker-target");
    writeFileSync(elsewhere, "not the deployment\n", { mode: 0o600 });
    expect(() =>
      applyRollbackPair(staged, {
        onStep: (step) => {
          if (step !== "plist") return;
          rmSync(fixture.plistDestination, { force: true });
          symlinkSync(elsewhere, fixture.plistDestination);
        },
      }),
    ).toThrow(/no longer the object that was verified/);

    // The attacker's file was not written through, and the previous generation is whole again.
    expect(readFileSync(elsewhere, "utf8")).toBe("not the deployment\n");
    expect(installedGeneration(fixture.installRoot)).toBe("generation-b");
    expect(readFileSync(fixture.launcherDestination, "utf8")).toBe(launcherBefore);
    expect(databaseMarkers(fixture.databasePath)).toEqual(["generation-a"]);
  }, 120_000);

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
