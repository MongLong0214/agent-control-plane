import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
  validateRollbackPair,
  type RollbackPairManifest,
  type RollbackPairSources,
  type SealedRollbackPair,
} from "../../src/deploy/rollback-pair.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The pair is the unit of a rollback: one UUID names a database image, the runtime that reads it,
 * and the launchd generation that starts it, and after it is sealed it depends on nothing outside
 * its own root. These tests are about what a validator must refuse *before* anything is stopped
 * or replaced, so every one of them builds its own disposable pair and mutates it the way an
 * attacker, a mistake, or a half-finished copy would.
 *
 * The forging helpers below are the point. A tamper that also rewrites `SHA256SUMS` and
 * `pair.json` is internally perfect — every digest inside the pair agrees with every other one.
 * The only thing that can tell it apart from the sealed original is the index digest the
 * approver kept outside, which is why that value is an argument and not a field.
 */

const LABEL = "com.agentcontrolplane.agentcpd";

const walk = (root: string, prefix = ""): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(root, relative));
    else found.push(relative);
  }
  return found;
};

const sha256 = (value: Buffer | string): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

const digestOfFile = (path: string): string => sha256(readFileSync(path));

/** Rewrites `SHA256SUMS` to agree with whatever is on disk and returns the forger's digest. */
const reindex = (root: string): string => {
  const members = walk(root)
    .filter((member) => member !== ROLLBACK_PAIR_INDEX_FILE)
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

/** Re-states every inventory digest from the bytes on disk, the way a careful forger would. */
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
  sources: RollbackPairSources;
}

const makeFixture = (
  generation = "generation-a",
  service: { label?: string; launcherName?: string; entrypoint?: string; nodeVersion?: string } = {},
): Fixture => {
  const label = service.label ?? LABEL;
  const launcherName = service.launcherName ?? "agentcpd-launch.sh";
  const entrypoint = service.entrypoint ?? "daemon/agentcpd.js";
  const home = tempDir("acp-rollback-pair-");
  const state = join(home, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);

  const databasePath = join(state, "state.sqlite");
  buildDatabase(databasePath);

  const runtimeRoot = join(home, "runtime-source");
  mkdirSync(join(runtimeRoot, entrypoint, ".."), { recursive: true, mode: 0o700 });
  mkdirSync(join(runtimeRoot, "db"), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtimeRoot, entrypoint), `// ${generation} daemon\n`, { mode: 0o600 });
  writeFileSync(join(runtimeRoot, "db", "state-admin.js"), `// ${generation} state admin\n`, { mode: 0o600 });

  const plistPath = join(home, `${label}.plist`);
  writeFileSync(plistPath, `<?xml version="1.0"?><plist><dict><!-- ${generation} --></dict></plist>\n`, {
    mode: 0o600,
  });
  const launcherPath = join(home, launcherName);
  writeFileSync(launcherPath, `#!/bin/bash\n# ${generation}\n`, { mode: 0o600 });

  return {
    home,
    pairsRoot: join(home, "rollback-pairs"),
    sources: {
      databasePath,
      runtimeRoot,
      entrypoint,
      nodePath: `/opt/${generation}/bin/node`,
      nodeVersion: service.nodeVersion ?? "v22.18.0",
      launchd: { label, generation, plistPath, launcherPath },
    },
  };
};

const sealFixture = async (
  generation = "generation-a",
  service: Parameters<typeof makeFixture>[1] = {},
): Promise<{ fixture: Fixture; pair: SealedRollbackPair }> => {
  const fixture = makeFixture(generation, service);
  const pair = await sealRollbackPair(fixture.pairsRoot, fixture.sources);
  return { fixture, pair };
};

const treeFingerprint = (root: string): string =>
  walk(root)
    .sort()
    .map((member) => `${member}:${digestOfFile(join(root, member))}`)
    .join("\n");

describe("the exact rollback pair", () => {
  it("seals a pair that validates with nothing but its id and the retained index digest", async () => {
    const { fixture, pair } = await sealFixture();

    // Self-contained after capture: the tree it was made from is gone and the pair still stands.
    rmSync(fixture.sources.runtimeRoot, { recursive: true, force: true });
    rmSync(fixture.sources.launchd.plistPath, { force: true });
    rmSync(fixture.sources.launchd.launcherPath, { force: true });
    rmSync(join(fixture.home, "state"), { recursive: true, force: true });

    const validated = validateRollbackPair(pair.root, {
      pairId: pair.pairId,
      indexDigest: pair.indexDigest,
    });

    expect(validated.pairId).toBe(pair.pairId);
    expect(existsSync(validated.databasePath)).toBe(true);
    expect(readFileSync(validated.plistPath, "utf8")).toContain("generation-a");
    expect(readFileSync(validated.launcherPath, "utf8")).toContain("generation-a");
    expect(validated.manifest.identity.service.generation).toBe("generation-a");
    expect(validated.manifest.identity.schemaVersion).toBeGreaterThan(0);
  });

  it("keeps the index self-excluding and refuses one that covers itself", async () => {
    const { pair } = await sealFixture();
    const indexPath = join(pair.root, ROLLBACK_PAIR_INDEX_FILE);
    const original = readFileSync(indexPath, "utf8");
    expect(original).not.toContain(ROLLBACK_PAIR_INDEX_FILE);
    expect(original).toContain(ROLLBACK_PAIR_MANIFEST_FILE);

    // A line for the index itself can only ever be a lie about the file it sits in, so it is
    // refused on sight rather than compared against anything.
    const selfCovering = `${original}${"0".repeat(64)}  ${ROLLBACK_PAIR_INDEX_FILE}\n`;
    writeFileSync(indexPath, selfCovering, { encoding: "utf8", mode: 0o600 });

    expect(() =>
      validateRollbackPair(pair.root, {
        pairId: pair.pairId,
        indexDigest: `sha256:${sha256(selfCovering)}`,
      }),
    ).toThrow(/index cannot cover itself/);
  });

  it("refuses a forgery whose own index and manifest were rewritten to agree with it", async () => {
    const { pair } = await sealFixture();
    const launcher = join(pair.root, pair.manifest.identity.service.launcher);
    writeFileSync(launcher, "#!/bin/bash\nexec /tmp/not-the-approved-launcher\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    restateInventory(pair.root);
    const forgedDigest = reindex(pair.root);

    // The forgery is internally perfect: every digest inside the pair now agrees.
    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: forgedDigest }),
    ).not.toThrow(/index digest/);

    // And it is refused, because the digest that decides is the one kept outside.
    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: pair.indexDigest }),
    ).toThrow(/index digest/);
  });

  it("refuses a member replaced by a symlink to a byte-identical member of another pair", async () => {
    const [a, b] = await Promise.all([sealFixture("generation-a"), sealFixture("generation-a")]);
    const member = a.pair.manifest.identity.service.launcher;
    const borrowed = join(b.pair.root, member);
    expect(digestOfFile(join(a.pair.root, member))).toBe(digestOfFile(borrowed));

    unlinkSync(join(a.pair.root, member));
    symlinkSync(borrowed, join(a.pair.root, member));
    // Byte-identical content, so every digest still matches; only membership tells them apart.
    expect(() =>
      validateRollbackPair(a.pair.root, { pairId: a.pair.pairId, indexDigest: a.pair.indexDigest }),
    ).toThrow(/regular, non-symlink file/);
  });

  it("resolves a member before it compares, refusing one reached through a linked directory", async () => {
    const { pair } = await sealFixture();
    const outside = join(pair.root, "..", `${pair.pairId}-escaped-runtime`);
    cpSync(join(pair.root, "runtime"), outside, { recursive: true });
    rmSync(join(pair.root, "runtime"), { recursive: true, force: true });
    symlinkSync(outside, join(pair.root, "runtime"));

    // Every member path string still starts with `runtime/`, and every byte still hashes the
    // same. The unresolved string is not the path that gets opened.
    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: pair.indexDigest }),
    ).toThrow(/escapes the sealed pair root/);
  });

  it("counts the index before it collapses it, refusing a duplicated entry", async () => {
    const { pair } = await sealFixture();
    const indexPath = join(pair.root, ROLLBACK_PAIR_INDEX_FILE);
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    const duplicated = `${[...lines, lines[0]].join("\n")}\n`;
    writeFileSync(indexPath, duplicated, { encoding: "utf8", mode: 0o600 });

    // A set of these entries is identical to a set of the originals; only a count sees it.
    expect(new Set(duplicated.split("\n").filter(Boolean)).size).toBe(lines.length);
    expect(() =>
      validateRollbackPair(pair.root, {
        pairId: pair.pairId,
        indexDigest: `sha256:${sha256(duplicated)}`,
      }),
    ).toThrow(/names the same member twice/);
  });

  it("refuses a file present in the pair root that the index does not vouch for", async () => {
    const { pair } = await sealFixture();
    writeFileSync(join(pair.root, "runtime", "unvouched.js"), "// slipped in\n", { mode: 0o600 });

    // The index digest still matches: nothing the index covers has changed.
    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: pair.indexDigest }),
    ).toThrow(/nothing in the sealed pair vouches for/);
  });

  it("refuses a member the index names and the inventory does not", async () => {
    const { pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    const dropped = manifest.identity.service.plist;
    manifest.inventory = manifest.inventory.filter((member) => member.path !== dropped);
    writePairManifest(pair.root, manifest);
    const forgedDigest = reindex(pair.root);

    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: forgedDigest }),
    ).toThrow(/inventory does not/);
  });

  it("counts the inventory before it collapses it, refusing a duplicated entry", async () => {
    // Added after a measured survivor: removing the inventory/index *count* comparison left the
    // "index names a file the inventory does not" row passing, because two membership loops
    // already cover set difference in both directions. The one thing only a count sees is this —
    // an inventory that names a member twice, so the sets match and the lists do not.
    const { pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    manifest.inventory = [...manifest.inventory, manifest.inventory[0]!];
    writePairManifest(pair.root, manifest);
    const forgedDigest = reindex(pair.root);

    expect(new Set(manifest.inventory.map((member) => member.path)).size).toBe(
      manifest.inventory.length - 1,
    );
    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: forgedDigest }),
    ).toThrow(/inventory does not/);
  });

  it("refuses another pair's directory renamed to the approved id", async () => {
    const [approved, other] = await Promise.all([
      sealFixture("generation-approved"),
      sealFixture("generation-later"),
    ]);
    const impostor = join(other.fixture.pairsRoot, approved.pair.pairId);
    renameSync(other.pair.root, impostor);

    expect(() =>
      validateRollbackPair(impostor, {
        pairId: approved.pair.pairId,
        indexDigest: approved.pair.indexDigest,
      }),
    ).toThrow(/index digest/);

    // Even with the impostor's own digest, the pair still names itself and is refused.
    expect(() =>
      validateRollbackPair(impostor, {
        pairId: approved.pair.pairId,
        indexDigest: other.pair.indexDigest,
      }),
    ).toThrow(/names a different pair/);
  });

  it("refuses a pair id that is not a UUID, `latest` included", async () => {
    const { pair } = await sealFixture();
    for (const pairId of ["latest", "..", "20260901T000000Z-newest", ""]) {
      expect(() => validateRollbackPair(pair.root, { pairId, indexDigest: pair.indexDigest })).toThrow(
        /named by a UUID/,
      );
    }
  });

  it("refuses a declared schema version the sealed image is not at", async () => {
    const { pair } = await sealFixture();
    const manifest = readPairManifest(pair.root);
    manifest.identity.schemaVersion += 1;
    writePairManifest(pair.root, manifest);
    restateInventory(pair.root);
    const forgedDigest = reindex(pair.root);

    expect(() =>
      validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: forgedDigest }),
    ).toThrow(/schema version its image is not at/);
  });

  it("refuses the pinned identity a caller retained alongside the digest", async () => {
    const { pair } = await sealFixture("generation-a");
    const base = { pairId: pair.pairId, indexDigest: pair.indexDigest };

    expect(() => validateRollbackPair(pair.root, { ...base, serviceGeneration: "generation-a" })).not.toThrow();
    expect(() => validateRollbackPair(pair.root, { ...base, serviceGeneration: "generation-b" })).toThrow(
      /service generation/,
    );
    expect(() => validateRollbackPair(pair.root, { ...base, serviceLabel: "com.example.other" })).toThrow(
      /service label/,
    );
  });

  it("seals the supported backup rather than a raw copy, and deletes no sidecar", async () => {
    const fixture = makeFixture();
    const sidecars = [`${fixture.sources.databasePath}-wal`, `${fixture.sources.databasePath}-shm`];
    for (const sidecar of sidecars) writeFileSync(sidecar, "", { mode: 0o600 });

    const pair = await sealRollbackPair(fixture.pairsRoot, fixture.sources);
    for (const sidecar of sidecars) expect(existsSync(sidecar)).toBe(true);

    const sealedDatabase = join(pair.root, pair.manifest.database.member);
    expect(existsSync(`${sealedDatabase}.manifest.json`)).toBe(true);
    expect(pair.manifest.database.manifestMember).toBe(
      `${pair.manifest.database.member}.manifest.json`,
    );
    // The manifest a raw `cp` cannot produce: the supported path writes it from the process that
    // held both files open, and `validateBackup` is what reads it back.
    expect(readFileSync(`${sealedDatabase}.manifest.json`, "utf8")).toContain(
      "agent-control-plane.sqlite-backup/v1",
    );
    expect(basename(sealedDatabase)).toBe(basename(fixture.sources.databasePath));
  });

  it("seals a different generation with the same code, and neither pair vouches for the other", async () => {
    // A rollback to a sealed generation is a one-way door unless this same producer can seal the
    // forward generation as its return leg. Nothing here is read from the machine: the node path
    // below does not exist on it, and the label, launcher name, entrypoint and version all differ
    // between the two pairs. Sealing the second must not touch or need the first.
    const back = await sealFixture("generation-before");
    const backFingerprint = treeFingerprint(back.pair.root);
    const forward = await sealFixture("generation-after", {
      label: "com.example.successor",
      launcherName: "successor-launch.sh",
      entrypoint: "bin/successor.js",
      nodeVersion: "v24.4.1",
    });

    expect(existsSync(forward.fixture.sources.nodePath)).toBe(false);
    expect(treeFingerprint(back.pair.root), "sealing a later pair mutated the earlier one").toBe(
      backFingerprint,
    );

    for (const sealed of [back.pair, forward.pair]) {
      expect(() =>
        validateRollbackPair(sealed.root, { pairId: sealed.pairId, indexDigest: sealed.indexDigest }),
      ).not.toThrow();
    }
    expect(forward.pair.manifest.identity.service.label).toBe("com.example.successor");
    expect(forward.pair.manifest.identity.runtime.nodeVersion).toBe("v24.4.1");
    expect(forward.pair.manifest.identity.runtime.entrypoint).toBe("runtime/bin/successor.js");

    // Cross-pair: each is refused under the other's retained digest, in both directions.
    expect(() =>
      validateRollbackPair(back.pair.root, {
        pairId: back.pair.pairId,
        indexDigest: forward.pair.indexDigest,
      }),
    ).toThrow(/index digest/);
    expect(() =>
      validateRollbackPair(forward.pair.root, {
        pairId: forward.pair.pairId,
        indexDigest: back.pair.indexDigest,
      }),
    ).toThrow(/index digest/);
  });

  it("changes nothing it inspects, whether it accepts or refuses", async () => {
    const { pair } = await sealFixture();
    const before = treeFingerprint(pair.root);

    validateRollbackPair(pair.root, { pairId: pair.pairId, indexDigest: pair.indexDigest });
    expect(treeFingerprint(pair.root)).toBe(before);

    expect(() =>
      validateRollbackPair(pair.root, {
        pairId: pair.pairId,
        indexDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow();
    expect(treeFingerprint(pair.root)).toBe(before);
  });
});
