import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import {
  ROLLBACK_PAIR_INDEX_FILE,
  ROLLBACK_PAIR_MANIFEST_FILE,
  sealRollbackPair,
  stageRollbackPair,
  validateRollbackPair,
  type RollbackPairExpectation,
  type RollbackPairManifest,
  type RollbackPairSources,
  type SealedRollbackPair,
} from "../../src/deploy/rollback-pair.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A rollback pair is a whole generation — database image, runtime closure, Node executable, plist
 * and launcher — and these tests are about what has to be refused *before* any of it is installed.
 * Every row builds its own disposable generation and then breaks it the way a mistake, an
 * attacker, or a half-finished copy would.
 *
 * The forging helpers below are the point. A tamper that also rewrites `SHA256SUMS` and
 * `pair.json` is internally perfect: every digest inside the pair agrees with every other one.
 * Only the index digest the approver kept outside can tell it from the sealed original, which is
 * why that value is an argument and never a field.
 */

const LABEL = "com.agentcontrolplane.agentcpd";

interface Tree {
  files: string[];
  directories: string[];
}

const walk = (root: string, prefix = ""): Tree => {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      directories.push(path);
      const nested = walk(root, path);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else files.push(path);
  }
  return { files, directories };
};

const sha256 = (value: Buffer | string): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

const digestOfFile = (path: string): string => sha256(readFileSync(path));

/** Rewrites `SHA256SUMS` to agree with whatever is on disk and returns the forger's digest. */
const reindex = (root: string): string => {
  const members = walk(root)
    .files.filter((member) => member !== ROLLBACK_PAIR_INDEX_FILE)
    .sort();
  const text = `${members.map((member) => `${digestOfFile(join(root, member))}  ${member}`).join("\n")}\n`;
  writeFileSync(join(root, ROLLBACK_PAIR_INDEX_FILE), text, { encoding: "utf8", mode: 0o600 });
  chmodSync(join(root, ROLLBACK_PAIR_INDEX_FILE), 0o600);
  return `sha256:${sha256(text)}`;
};

const readPairManifest = (root: string): RollbackPairManifest =>
  JSON.parse(readFileSync(join(root, ROLLBACK_PAIR_MANIFEST_FILE), "utf8")) as RollbackPairManifest;

const writePairManifest = (root: string, manifest: RollbackPairManifest): void => {
  writeFileSync(join(root, ROLLBACK_PAIR_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(join(root, ROLLBACK_PAIR_MANIFEST_FILE), 0o600);
};

/** Re-states every inventory digest and size from the bytes on disk, as a careful forger would. */
const restateInventory = (root: string): void => {
  const manifest = readPairManifest(root);
  manifest.inventory = manifest.inventory.map((member) => ({
    path: member.path,
    sha256: `sha256:${digestOfFile(join(root, member.path))}`,
    bytes: lstatSync(join(root, member.path)).size,
  }));
  writePairManifest(root, manifest);
};

const buildDatabase = (path: string): void => {
  new Db(path).close();
  chmodSync(path, 0o600);
};

interface Fixture {
  home: string;
  pairsRoot: string;
  appRoot: string;
  databasePath: string;
  plistDestination: string;
  launcherDestination: string;
  sources: RollbackPairSources;
}

interface FixtureOptions {
  label?: string;
  launcherName?: string;
  entrypoint?: string;
  stateAdmin?: string;
  nodeVersion?: string;
  nodePath?: string;
}

/**
 * A whole disposable generation: an app root the runtime installs into, a live database, a plist
 * and a launcher whose text really does name this generation's Node executable and entrypoint.
 * The bindings matter — a fixture whose launcher pointed anywhere would make the checks that stop
 * pair A running under generation B's runtime unfalsifiable.
 */
const makeFixture = (generation = "generation-a", options: FixtureOptions = {}): Fixture => {
  const label = options.label ?? LABEL;
  const launcherName = options.launcherName ?? "agentcpd-launch.sh";
  const entrypoint = options.entrypoint ?? "daemon/agentcpd.js";
  const stateAdmin = options.stateAdmin ?? "db/state-admin.js";
  const nodePath = options.nodePath ?? `/opt/${generation}/bin/node`;

  const home = tempDir("acp-rollback-pair-");
  // Canonical, because the installer resolves its app root with `cd -P` before comparing and the
  // rendered plist and launcher carry the resolved spelling. A fixture that wrote the
  // unresolved one would be testing a deployment shape that never exists.
  const appRoot = join(home, "app-root");
  const installRoot = join(appRoot, "dist");
  mkdirSync(installRoot, { recursive: true, mode: 0o700 });

  const canonicalAppRoot = realpathSync(appRoot);
  const state = join(home, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const databasePath = join(state, "state.sqlite");
  buildDatabase(databasePath);

  const launchAgents = join(home, "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  // Canonical destinations for the same reason as the app root: these strings are written into
  // the sealed plist and launcher, and are compared against later.
  const plistDestination = join(realpathSync(launchAgents), `${label}.plist`);
  const launcherDestination = join(realpathSync(state), launcherName);

  const source = join(home, "source");
  const runtimeRoot = join(source, "runtime");
  mkdirSync(join(runtimeRoot, entrypoint, ".."), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtimeRoot, stateAdmin, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, entrypoint), `// ${generation} daemon\n`, { mode: 0o600 });
  writeFileSync(join(runtimeRoot, stateAdmin), `// ${generation} state admin\n`, { mode: 0o600 });

  const plistPath = join(source, `${label}.plist`);
  writeFileSync(
    plistPath,
    [
      '<?xml version="1.0"?>',
      "<plist><dict>",
      "  <key>Label</key>",
      `  <string>${label}</string>`,
      "  <key>ProgramArguments</key>",
      `  <array><string>${launcherDestination}</string></array>`,
      "  <key>WorkingDirectory</key>",
      `  <string>${canonicalAppRoot}</string>`,
      `  <!-- ${generation} -->`,
      "</dict></plist>",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const launcherPath = join(source, launcherName);
  writeFileSync(
    launcherPath,
    [
      "#!/bin/bash",
      `# ${generation}`,
      `ACP_NODE_PATH=${nodePath}`,
      `ACP_APP_ROOT=${canonicalAppRoot}`,
      `exec "$ACP_NODE_PATH" "$ACP_APP_ROOT/dist/${entrypoint}"`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  return {
    home,
    appRoot: canonicalAppRoot,
    databasePath,
    plistDestination,
    launcherDestination,
    pairsRoot: join(home, "rollback-pairs"),
    sources: {
      databasePath,
      runtimeRoot,
      entrypoint,
      stateAdmin,
      nodePath,
      nodeVersion: options.nodeVersion ?? "v22.18.0",
      install: {
        runtimeRoot: installRoot,
        plistPath: plistDestination,
        launcherPath: launcherDestination,
        workingDirectory: appRoot,
      },
      launchd: { label, generation, plistPath, launcherPath },
    },
  };
};

/** What the deployment is, alongside what the approver retained. Every field is required. */
const expectationFor = (
  fixture: Fixture,
  pair: SealedRollbackPair,
  overrides: Partial<RollbackPairExpectation> = {},
): RollbackPairExpectation => ({
  pairId: pair.pairId,
  indexDigest: pair.indexDigest,
  databaseTargetPath: fixture.databasePath,
  serviceLabel: fixture.sources.launchd.label,
  workingDirectory: fixture.appRoot,
  ...overrides,
});

const sealFixture = async (
  generation = "generation-a",
  options: FixtureOptions = {},
): Promise<{ fixture: Fixture; pair: SealedRollbackPair }> => {
  const fixture = makeFixture(generation, options);
  const pair = await sealRollbackPair(fixture.pairsRoot, fixture.sources);
  return { fixture, pair };
};

const treeFingerprint = (root: string): string =>
  walk(root)
    .files.sort()
    .map((member) => `${member}:${digestOfFile(join(root, member))}`)
    .join("\n");

describe("the exact rollback pair", () => {
  it("seals a pair that validates with the retained digest and what the deployment is", async () => {
    const { fixture, pair } = await sealFixture();

    // Self-contained after capture: the tree it was made from is gone and the pair still stands.
    rmSync(join(fixture.home, "source"), { recursive: true, force: true });

    const validated = validateRollbackPair(pair.root, expectationFor(fixture, pair));

    expect(validated.pairId).toBe(pair.pairId);
    expect(existsSync(validated.databasePath)).toBe(true);
    expect(existsSync(validated.stateAdminPath)).toBe(true);
    expect(existsSync(validated.entrypointPath)).toBe(true);
    expect(readFileSync(validated.plistPath, "utf8")).toContain("generation-a");
    expect(validated.manifest.identity.service.generation).toBe("generation-a");
    expect(validated.manifest.identity.database.targetPath).toBe(realpathSync(fixture.databasePath));
    expect(validated.manifest.identity.schemaVersion).toBeGreaterThan(0);
  });

  it("keeps the index self-excluding and refuses one that covers itself", async () => {
    const { fixture, pair } = await sealFixture();
    const indexPath = join(pair.root, ROLLBACK_PAIR_INDEX_FILE);
    const original = readFileSync(indexPath, "utf8");
    expect(original).not.toContain(ROLLBACK_PAIR_INDEX_FILE);
    expect(original).toContain(ROLLBACK_PAIR_MANIFEST_FILE);

    const selfCovering = `${original}${"0".repeat(64)}  ${ROLLBACK_PAIR_INDEX_FILE}\n`;
    writeFileSync(indexPath, selfCovering, { encoding: "utf8", mode: 0o600 });

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: `sha256:${sha256(selfCovering)}` })),
    ).toThrow(/index cannot cover itself/);
  });

  it("refuses a forgery whose own index and manifest were rewritten to agree with it", async () => {
    const { fixture, pair } = await sealFixture();
    const launcher = join(pair.root, pair.manifest.identity.service.launcher);
    writeFileSync(launcher, readFileSync(launcher, "utf8").replace("generation-a", "not-approved"), {
      encoding: "utf8",
      mode: 0o600,
    });
    restateInventory(pair.root);
    const forgedDigest = reindex(pair.root);

    // The forgery is internally perfect: every digest inside the pair now agrees.
    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: forgedDigest })),
    ).not.toThrow();

    // And it is refused, because the digest that decides is the one kept outside.
    expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair))).toThrow(/index digest/);
  });

  it("refuses a member replaced by a symlink to a byte-identical member of another pair", async () => {
    const [a, b] = await Promise.all([sealFixture("generation-a"), sealFixture("generation-a")]);
    const member = a.pair.manifest.database.manifestMember;
    const borrowed = join(b.pair.root, member);

    unlinkSync(join(a.pair.root, member));
    symlinkSync(borrowed, join(a.pair.root, member));
    expect(() => validateRollbackPair(a.pair.root, expectationFor(a.fixture, a.pair))).toThrow(
      /regular, non-symlink file/,
    );
  });

  it("refuses a member hard-linked from outside the pair", async () => {
    const { fixture, pair } = await sealFixture();
    const member = pair.manifest.identity.service.launcher;
    const inside = join(pair.root, member);
    const alias = join(fixture.home, "alias-anyone-can-rewrite");

    // A hard link is a second name for the same inode. Every digest still matches — the bytes are
    // literally the same bytes — and whoever holds the other name can rewrite them after this
    // validation and before the install.
    linkSync(inside, alias);
    expect(lstatSync(inside).nlink).toBe(2);
    expect(digestOfFile(inside)).toBe(digestOfFile(alias));

    expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair))).toThrow(
      /hard-linked from outside the pair/,
    );
  });

  it("resolves a member before it compares, refusing one reached through a linked directory", async () => {
    const { fixture, pair } = await sealFixture();
    const outside = join(pair.root, "..", `${pair.pairId}-escaped-runtime`);
    cpSync(join(pair.root, "runtime"), outside, { recursive: true });
    rmSync(join(pair.root, "runtime"), { recursive: true, force: true });
    symlinkSync(outside, join(pair.root, "runtime"));

    // Every member path string still starts with `runtime/`, and every byte still hashes the
    // same. The unresolved string is not the path that gets opened.
    expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair))).toThrow(
      /escapes the sealed pair root/,
    );
  });

  it("counts the index before it collapses it, refusing a duplicated entry", async () => {
    const { fixture, pair } = await sealFixture();
    const indexPath = join(pair.root, ROLLBACK_PAIR_INDEX_FILE);
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    const duplicated = `${[...lines, lines[0]].join("\n")}\n`;
    writeFileSync(indexPath, duplicated, { encoding: "utf8", mode: 0o600 });

    expect(new Set(duplicated.split("\n").filter(Boolean)).size).toBe(lines.length);
    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: `sha256:${sha256(duplicated)}` })),
    ).toThrow(/names the same member twice/);
  });

  it("refuses a file present in the pair root that the index does not vouch for", async () => {
    const { fixture, pair } = await sealFixture();
    writeFileSync(join(pair.root, "runtime", "unvouched.js"), "// slipped in\n", { mode: 0o600 });

    expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair))).toThrow(
      /nothing in the sealed pair vouches for/,
    );
  });

  it("refuses an empty directory hiding between the members nothing would notice", async () => {
    const { fixture, pair } = await sealFixture();
    mkdirSync(join(pair.root, "runtime", "empty-and-unaccounted"), { mode: 0o700 });

    // Not one file changed, so every digest and the index digest still match. Only a closure over
    // directories sees it — a file census cannot, because there is no file.
    expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair))).toThrow(
      /directory its manifest does not declare/,
    );
  });

  it("refuses a member whose recorded byte count is not its size", async () => {
    const { fixture, pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    const target = manifest.inventory.find((member) => member.path === manifest.identity.service.plist)!;
    target.bytes += 1;
    writePairManifest(pair.root, manifest);
    const forgedDigest = reindex(pair.root);

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: forgedDigest })),
    ).toThrow(/not the size its inventory records/);
  });

  it("counts the inventory before it collapses it, refusing a duplicated entry", async () => {
    const { fixture, pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    manifest.inventory = [...manifest.inventory, manifest.inventory[0]!];
    writePairManifest(pair.root, manifest);
    const forgedDigest = reindex(pair.root);

    expect(new Set(manifest.inventory.map((member) => member.path)).size).toBe(manifest.inventory.length - 1);
    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: forgedDigest })),
    ).toThrow(/inventory does not/);
  });

  it("refuses two roles that are the same member", async () => {
    const { fixture, pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    // The state-admin role pointed at the daemon entrypoint: one file doing two jobs means a
    // restore would run whatever the daemon entrypoint happens to be.
    manifest.identity.runtime.stateAdmin = manifest.identity.runtime.entrypoint;
    manifest.identity.runtime.stateAdminSha256 = manifest.identity.runtime.entrypointSha256;
    writePairManifest(pair.root, manifest);
    const forgedDigest = reindex(pair.root);

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: forgedDigest })),
    ).toThrow(/two roles in the sealed pair are the same member/);
  });

  it("refuses a plist and launcher that share a basename", async () => {
    const fixture = makeFixture("generation-a", { launcherName: `${LABEL}.plist` });
    await expect(sealRollbackPair(fixture.pairsRoot, fixture.sources)).rejects.toThrow(
      /cannot share a basename/,
    );
  });

  it("refuses another pair's directory renamed to the approved id", async () => {
    const [approved, other] = await Promise.all([
      sealFixture("generation-approved"),
      sealFixture("generation-later"),
    ]);
    const impostor = join(other.fixture.pairsRoot, approved.pair.pairId);
    renameSync(other.pair.root, impostor);

    expect(() =>
      validateRollbackPair(impostor, expectationFor(other.fixture, approved.pair)),
    ).toThrow(/index digest/);
    expect(() =>
      validateRollbackPair(
        impostor,
        expectationFor(other.fixture, approved.pair, { indexDigest: other.pair.indexDigest }),
      ),
    ).toThrow(/names a different pair/);
  });

  it("refuses a pair id that is not a UUID, `latest` included", async () => {
    const { fixture, pair } = await sealFixture();
    for (const pairId of ["latest", "..", "20260901T000000Z-newest", ""]) {
      expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair, { pairId }))).toThrow(
        /named by a UUID/,
      );
    }
  });

  it("refuses a pair sealed for a different database, service or app root", async () => {
    const { fixture, pair } = await sealFixture();
    const elsewhere = makeFixture("generation-elsewhere");

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { databaseTargetPath: elsewhere.databasePath })),
    ).toThrow(/recovery point for a different database/);
    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { serviceLabel: "com.example.other" })),
    ).toThrow(/different service label/);
    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { workingDirectory: elsewhere.appRoot })),
    ).toThrow(/installs under a different app root/);
  });

  it("refuses a sealed launcher not bound to the runtime the pair carries", async () => {
    const { fixture, pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    // Pair A's members, but the launcher is now said to run some other Node. This is the shape of
    // "restore the database and leave generation B's runtime in place", declared rather than
    // stumbled into.
    manifest.identity.runtime.nodePath = "/opt/generation-b/bin/node";
    writePairManifest(pair.root, manifest);
    const forgedDigest = reindex(pair.root);

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: forgedDigest })),
    ).toThrow(/not bound to the Node executable this pair names/);
  });

  it("refuses a declared schema version the sealed image is not at", async () => {
    const { fixture, pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    manifest.identity.schemaVersion += 1;
    writePairManifest(pair.root, manifest);
    restateInventory(pair.root);
    const forgedDigest = reindex(pair.root);

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: forgedDigest })),
    ).toThrow(/schema version its image is not at/);
  });

  it("seals a different generation with the same code, and neither pair vouches for the other", async () => {
    const back = await sealFixture("generation-before");
    const backFingerprint = treeFingerprint(back.pair.root);
    const forward = await sealFixture("generation-after", {
      label: "com.example.successor",
      launcherName: "successor-launch.sh",
      entrypoint: "bin/successor.js",
      stateAdmin: "bin/successor-state.js",
      nodeVersion: "v24.4.1",
    });

    expect(existsSync(forward.fixture.sources.nodePath)).toBe(false);
    expect(treeFingerprint(back.pair.root), "sealing a later pair mutated the earlier one").toBe(
      backFingerprint,
    );

    for (const sealed of [back, forward]) {
      expect(() =>
        validateRollbackPair(sealed.pair.root, expectationFor(sealed.fixture, sealed.pair)),
      ).not.toThrow();
    }
    expect(forward.pair.manifest.identity.service.label).toBe("com.example.successor");
    expect(forward.pair.manifest.identity.runtime.nodeVersion).toBe("v24.4.1");

    expect(() =>
      validateRollbackPair(
        back.pair.root,
        expectationFor(back.fixture, back.pair, { indexDigest: forward.pair.indexDigest }),
      ),
    ).toThrow(/index digest/);
  });

  it("seals the supported backup rather than a raw copy, and deletes no sidecar", async () => {
    const fixture = makeFixture();
    const sidecars = [`${fixture.databasePath}-wal`, `${fixture.databasePath}-shm`];
    for (const sidecar of sidecars) writeFileSync(sidecar, "", { mode: 0o600 });

    const pair = await sealRollbackPair(fixture.pairsRoot, fixture.sources);
    for (const sidecar of sidecars) expect(existsSync(sidecar)).toBe(true);

    const sealedDatabase = join(pair.root, pair.manifest.database.member);
    expect(readFileSync(`${sealedDatabase}.manifest.json`, "utf8")).toContain(
      "agent-control-plane.sqlite-backup/v1",
    );
    expect(basename(sealedDatabase)).toBe(basename(fixture.databasePath));
  });

  it("publishes atomically: a mid-seal failure leaves no pair root and no stage behind", async () => {
    const fixture = makeFixture();
    // The runtime's state-admin is gone, so sealing fails after the database has been captured
    // and the runtime copied — partway, which is exactly when a sequential writer would have
    // left a half-built directory under an approved-looking UUID.
    rmSync(join(fixture.sources.runtimeRoot, fixture.sources.stateAdmin), { force: true });

    await expect(sealRollbackPair(fixture.pairsRoot, fixture.sources)).rejects.toThrow();

    const survivors = existsSync(fixture.pairsRoot) ? readdirSync(fixture.pairsRoot) : [];
    expect(survivors, "a failed seal left something under the pairs root").toEqual([]);
  });

  it("changes nothing at all when it refuses, including for a pair that is not there", async () => {
    const { fixture, pair } = await sealFixture();
    const before = treeFingerprint(pair.root);

    validateRollbackPair(pair.root, expectationFor(fixture, pair));
    expect(treeFingerprint(pair.root)).toBe(before);

    expect(() =>
      validateRollbackPair(pair.root, expectationFor(fixture, pair, { indexDigest: `sha256:${"0".repeat(64)}` })),
    ).toThrow();
    expect(treeFingerprint(pair.root)).toBe(before);

    // Validating a pair that does not exist must not bring its directory into existence, and must
    // not touch the mode of the root it looked in.
    const absent = join(fixture.pairsRoot, "11111111-2222-3333-4444-555555555555");
    const rootModeBefore = statSync(fixture.pairsRoot).mode;
    const entriesBefore = readdirSync(fixture.pairsRoot).sort();

    expect(() =>
      validateRollbackPair(absent, expectationFor(fixture, pair, { pairId: "11111111-2222-3333-4444-555555555555" })),
    ).toThrow(/no sealed rollback pair at this path/);

    expect(existsSync(absent)).toBe(false);
    expect(readdirSync(fixture.pairsRoot).sort()).toEqual(entriesBefore);
    expect(statSync(fixture.pairsRoot).mode).toBe(rootModeBefore);
  });

  it("stages its own copy, so a member swapped after validation cannot reach an install", async () => {
    const { fixture, pair } = await sealFixture();
    const stageParent = join(fixture.home, "stage");
    const staged = stageRollbackPair(pair.root, expectationFor(fixture, pair), stageParent);

    const approvedLauncher = readFileSync(staged.launcherPath, "utf8");
    expect(approvedLauncher).toContain("generation-a");

    // The swap a path-returning validator cannot defend against: rewrite the member in the pair
    // after validation has passed. The stage already holds its own verified copy.
    const inPair = join(pair.root, pair.manifest.identity.service.launcher);
    writeFileSync(inPair, "#!/bin/bash\nexec /tmp/attacker\n", { encoding: "utf8", mode: 0o600 });

    expect(readFileSync(staged.launcherPath, "utf8")).toBe(approvedLauncher);
    expect(readFileSync(staged.launcherPath, "utf8")).not.toContain("attacker");
    expect(lstatSync(staged.launcherPath).nlink).toBe(1);

    // And the now-tampered pair no longer validates at all, so a second attempt is refused. The
    // index file itself was not touched, so its digest still matches; what catches this is the
    // member's own digest, which is why both checks exist.
    expect(() => validateRollbackPair(pair.root, expectationFor(fixture, pair))).toThrow(
      /does not match the digest the index gives it/,
    );
  });

  it("leaves no stage behind when staging refuses", async () => {
    const { fixture, pair } = await sealFixture();
    const stageParent = join(fixture.home, "stage");

    expect(() =>
      stageRollbackPair(pair.root, expectationFor(fixture, pair, { serviceLabel: "com.example.other" }), stageParent),
    ).toThrow(/different service label/);

    const survivors = existsSync(stageParent) ? readdirSync(stageParent) : [];
    expect(survivors).toEqual([]);
  });
});
