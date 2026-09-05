#!/usr/bin/env node
/**
 * The exact rollback pair: one sealed, self-contained generation, applied as a whole or not at all.
 *
 * A rollback is not "restore a database". It is putting back a *generation*: the database image,
 * the runtime closure that reads it, the Node executable that runs that closure, and the launchd
 * plist and launcher that start it. Restoring one half and leaving the other is not a smaller
 * rollback, it is a new combination that has never run anywhere — assembled at the exact moment
 * the deployment is already broken. So the pair seals all of it under one UUID, and this module
 * is the orchestrator that consumes it: nothing downstream re-picks a member, and nothing
 * downstream reopens bytes this module has not already copied and re-verified.
 *
 * Three properties do the work, and each exists because its absence is a real failure:
 *
 *   - **The index digest lives outside the pair.** `SHA256(SHA256SUMS)` is retained by the
 *     approver. A pair that vouches for its own index vouches for a forgery just as happily:
 *     rewrite a member, rewrite its line, and every internal check agrees. The index in turn
 *     covers `pair.json` and every member, and cannot cover itself.
 *   - **Validation and use are the same act.** A validator that returns a path string and lets a
 *     caller open it later has proved something about bytes that may no longer be there. So
 *     `stageRollbackPair` copies every member into an owner-only stage and re-verifies the
 *     *copies*; `applyRollbackPair` installs only from that stage. A member swapped, or aliased
 *     through a hard link, after validation cannot reach the installed generation.
 *   - **A failed apply leaves the previous generation whole.** Before the first mutation the
 *     current runtime, plist and launcher are secured into the stage, every destination is
 *     type-checked, and any failure compensates back to what was there.
 *
 * Sealing states every identity rather than probing for it, so the same code seals the generation
 * being left and the one being moved to. Applying is the opposite: it must execute the sealed
 * closure, because running pair A's database under generation B's runtime is the defect this
 * whole mechanism exists to prevent.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { acpError, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { backupDatabase, validateBackup } from "../db/backup.ts";
import { PRIVATE_FILE_MODE } from "../db/state-preflight.ts";

export const ROLLBACK_PAIR_FORMAT = "agent-control-plane.rollback-pair/v1";
export const ROLLBACK_PAIR_INDEX_FILE = "SHA256SUMS";
export const ROLLBACK_PAIR_MANIFEST_FILE = "pair.json";

const PAIR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INDEX_LINE = /^([a-f0-9]{64}) {2}(\S+)$/;
/** Member paths are POSIX-relative, whitespace-free, and cannot climb out by name. */
const MEMBER_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface RollbackPairMember {
  /** POSIX-style path relative to the pair root. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface RollbackPairIdentity {
  /** The schema version of the sealed database image. */
  schemaVersion: number;
  /** The logical database this pair is a recovery point for, as recorded when it was taken. */
  database: { targetPath: string };
  runtime: {
    nodePath: string;
    nodeVersion: string;
    entrypoint: string;
    entrypointSha256: string;
    stateAdmin: string;
    stateAdminSha256: string;
    /** Where this closure lives once installed — what the launcher and plist must point at. */
    installRoot: string;
  };
  service: {
    label: string;
    generation: string;
    plist: string;
    launcher: string;
    plistDestination: string;
    launcherDestination: string;
    workingDirectory: string;
  };
}

export interface RollbackPairManifest {
  format: string;
  pairId: string;
  createdAt: string;
  database: { member: string; manifestMember: string };
  identity: RollbackPairIdentity;
  /** Every directory in the pair, so an empty one cannot hide between the named members. */
  directories: string[];
  inventory: RollbackPairMember[];
}

export interface SealedRollbackPair {
  pairId: string;
  root: string;
  indexPath: string;
  /** `SHA256(SHA256SUMS)` — retain this OUTSIDE the pair; nothing inside it can prove it. */
  indexDigest: string;
  manifest: RollbackPairManifest;
}

/**
 * Everything a pair is made of is supplied by the caller. Nothing here is read from the machine
 * the producer happens to be running on, and no value is derived by executing the closure being
 * sealed — a producer that discovers its own generation can only ever seal that generation, which
 * would make a rollback a one-way door with no forward return leg.
 */
export interface RollbackPairSources {
  databasePath: string;
  /**
   * The runtime closure that reads the database: a directory tree sealed and installed whole.
   *
   * Whatever is under this path is the closure — this module does not decide where one ends. A
   * deployment whose `dist` resolves its dependencies from a sibling `node_modules` seals `dist`
   * and leaves that sibling in place, which is right when the sibling does not change between
   * generations and wrong when it does. If dependencies move with the generation, point this at
   * the tree that holds both; the install root then has to be that tree too.
   */
  runtimeRoot: string;
  /** The daemon entrypoint, relative to `runtimeRoot`. */
  entrypoint: string;
  /** The state maintenance entrypoint, relative to `runtimeRoot`. Applying restores through it. */
  stateAdmin: string;
  nodePath: string;
  /** Stated by the caller, never probed: the closure being sealed may not run here. */
  nodeVersion: string;
  /** Where this generation lives when it is installed. */
  install: {
    runtimeRoot: string;
    plistPath: string;
    launcherPath: string;
    workingDirectory: string;
  };
  launchd: { label: string; generation: string; plistPath: string; launcherPath: string };
}

/**
 * What the approver retained, and what the deployment is. Every field is required: an expectation
 * a caller may omit is an expectation that will be omitted, and then a pair for one database,
 * service or app root can be applied to another with nothing objecting.
 */
export interface RollbackPairExpectation {
  pairId: string;
  indexDigest: string;
  /** The live database this rollback is for. */
  databaseTargetPath: string;
  /** The launchd service this rollback is for. */
  serviceLabel: string;
  /** The app root this generation installs under. */
  workingDirectory: string;
  serviceGeneration?: string;
  nodeVersion?: string;
  schemaVersion?: number;
}

const hashFile = (path: string): string => {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
};

const hashBytes = (value: Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

interface Tree {
  files: string[];
  directories: string[];
}

/**
 * Every entry that is not a directory counts as a file here, symbolic links included — a symlink
 * is a member that has to be refused by name, not one that quietly fails to appear in the walk.
 * Directories are enumerated too, so an empty one cannot sit inside a pair unaccounted for.
 */
const walkTree = (root: string, prefix = ""): Tree => {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      directories.push(path);
      const nested = walkTree(root, path);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else files.push(path);
  }
  return { files, directories };
};

const copyPrivateFile = (from: string, to: string): void => {
  const source = lstatSync(from);
  if (!source.isFile() || source.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member source must be a regular file", { from });
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  chmodSync(to, PRIVATE_FILE_MODE);
};

const copyPrivateTree = (from: string, to: string): void => {
  for (const member of walkTree(from).files) copyPrivateFile(join(from, member), join(to, member));
};

const renderIndex = (root: string, members: readonly string[]): string =>
  `${[...members]
    .sort()
    .map((member) => `${hashFile(join(root, member)).slice("sha256:".length)}  ${member}`)
    .join("\n")}\n`;

/**
 * The canonical spelling of a path that may not exist yet.
 *
 * `realpathSync` refuses a path with a missing tail, but an install root legitimately does not
 * exist before the first install. Resolving the nearest existing ancestor and re-appending the
 * remainder gives the same answer the path will have once it is created, which is the spelling
 * every later comparison uses.
 */
const canonical = (path: string): string => {
  const parts: string[] = [];
  let cursor = path;
  for (;;) {
    if (existsSync(cursor)) return join(realpathSync(cursor), ...parts.reverse());
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    parts.push(basename(cursor));
    cursor = parent;
  }
};

const assertAbsolute = (value: string, what: string): void => {
  if (!isAbsolute(value)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} must be an absolute path`, { value });
  }
};

/**
 * The bindings the plist and launcher must already carry, checked against the identity the pair
 * declares. This is what stops pair A's database from being installed beside generation B's
 * runtime: the sealed launcher names one Node executable and one entrypoint, and if they are not
 * the closure in this pair the pair is refused rather than half-applied.
 */
const assertGenerationBindings = (
  identity: RollbackPairIdentity,
  plistText: string,
  launcherText: string,
  where: string,
): void => {
  const { runtime, service } = identity;
  const expectedLabel = `<key>Label</key>`;
  if (!plistText.includes(expectedLabel) || !plistText.includes(`<string>${service.label}</string>`)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist does not declare the service label this pair names", {
      where,
      label: service.label,
    });
  }
  if (!plistText.includes(`<string>${service.launcherDestination}</string>`)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist does not run the launcher this pair installs", {
      where,
      launcherDestination: service.launcherDestination,
    });
  }
  if (
    !plistText.includes("<key>WorkingDirectory</key>") ||
    !plistText.includes(`<string>${service.workingDirectory}</string>`)
  ) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist does not name the working directory this pair installs under", {
      where,
      workingDirectory: service.workingDirectory,
    });
  }
  if (!launcherText.includes(`ACP_NODE_PATH=${runtime.nodePath}`)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher is not bound to the Node executable this pair names", {
      where,
      nodePath: runtime.nodePath,
    });
  }
  if (!launcherText.includes(`ACP_APP_ROOT=${service.workingDirectory}`)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher is not bound to the app root this pair installs under", {
      where,
      workingDirectory: service.workingDirectory,
    });
  }
  const installedEntrypoint = join(runtime.installRoot, runtime.entrypoint);
  const fromAppRoot = relative(service.workingDirectory, installedEntrypoint);
  if (fromAppRoot.startsWith("..") || isAbsolute(fromAppRoot)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed runtime installs outside the app root it declares", {
      where,
      installRoot: runtime.installRoot,
      workingDirectory: service.workingDirectory,
    });
  }
  if (!launcherText.includes(`"$ACP_APP_ROOT/${fromAppRoot}"`)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher does not execute the entrypoint this pair installs", {
      where,
      entrypoint: fromAppRoot,
    });
  }
};

/**
 * Seals one pair, published atomically.
 *
 * Everything is built inside an owner-only staging directory beside the destination and validated
 * canonically there; only then is it renamed into place. A sequential write into the final UUID
 * root would leave a half-built pair under a name that looks approved if anything failed partway,
 * and the moment a rollback can find that name it can try to use it.
 */
export const sealRollbackPair = async (
  pairsRoot: string,
  sources: RollbackPairSources,
  pairId: string = randomUUID(),
): Promise<SealedRollbackPair> => {
  assertAbsolute(pairsRoot, "the rollback pair root");
  if (!PAIR_ID.test(pairId)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a rollback pair is named by a UUID", { pairId });
  }
  for (const [what, value] of [
    ["the install runtime root", sources.install.runtimeRoot],
    ["the install plist path", sources.install.plistPath],
    ["the install launcher path", sources.install.launcherPath],
    ["the install working directory", sources.install.workingDirectory],
    ["the node path", sources.nodePath],
  ] as const) {
    assertAbsolute(value, what);
  }
  // Canonical from here on. The installer resolves its app root with `cd -P` before it compares,
  // and a deployment reached through a link — `/var` -> `/private/var` on macOS, every time —
  // would otherwise seal one spelling and be validated against the other. The same mistake, in
  // the same direction, as handing an entrypoint its unresolved path.
  const install = {
    runtimeRoot: canonical(sources.install.runtimeRoot),
    plistPath: canonical(sources.install.plistPath),
    launcherPath: canonical(sources.install.launcherPath),
    workingDirectory: canonical(sources.install.workingDirectory),
  };
  const root = join(pairsRoot, pairId);
  if (existsSync(root)) {
    throw acpError(ReasonCode.CONFLICT, "a rollback pair with this id already exists", { root });
  }
  if (basename(sources.launchd.plistPath) === basename(sources.launchd.launcherPath)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "the plist and launcher cannot share a basename inside one pair", {
      plistPath: sources.launchd.plistPath,
      launcherPath: sources.launchd.launcherPath,
    });
  }

  // Owner-only, hidden, and beside the destination so the rename that publishes it is atomic
  // rather than a cross-device copy. Only this directory is ever removed on failure.
  mkdirSync(pairsRoot, { recursive: true, mode: 0o700 });
  const stage = join(pairsRoot, `.staging-${pairId}-${process.pid}-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  chmodSync(stage, 0o700);
  const building = join(stage, pairId);

  try {
    mkdirSync(building, { mode: 0o700 });
    chmodSync(building, 0o700);

    const databaseMember = `database/${basename(sources.databasePath)}`;
    const sealedDatabase = join(building, databaseMember);
    mkdirSync(join(building, "database"), { mode: 0o700 });
    // The supported path, not a file copy. SQLite in WAL mode commits into a side file, so the
    // bytes of the main file are older than the last commit until something checkpoints them;
    // `cp` yields a database that opens cleanly and is silently missing writes. `backupDatabase`
    // reads through SQLite's own backup API and writes the manifest a copy cannot produce.
    await backupDatabase(sources.databasePath, sealedDatabase);
    const backupManifestMember = `${databaseMember}.manifest.json`;

    copyPrivateTree(sources.runtimeRoot, join(building, "runtime"));
    const plistMember = `launchd/${basename(sources.launchd.plistPath)}`;
    const launcherMember = `launchd/${basename(sources.launchd.launcherPath)}`;
    copyPrivateFile(sources.launchd.plistPath, join(building, plistMember));
    copyPrivateFile(sources.launchd.launcherPath, join(building, launcherMember));

    const sealedManifest = validateBackup(sealedDatabase, { assertSchemaInvariants: false });
    if (sealedManifest.source === undefined) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed backup records no database it was taken from", {
        databasePath: sources.databasePath,
      });
    }
    const entrypointMember = `runtime/${sources.entrypoint}`;
    const stateAdminMember = `runtime/${sources.stateAdmin}`;
    const identity: RollbackPairIdentity = {
      schemaVersion: sealedManifest.schemaVersion,
      database: { targetPath: sealedManifest.source.path },
      runtime: {
        nodePath: sources.nodePath,
        nodeVersion: sources.nodeVersion,
        entrypoint: sources.entrypoint,
        entrypointSha256: hashFile(join(building, entrypointMember)),
        stateAdmin: sources.stateAdmin,
        stateAdminSha256: hashFile(join(building, stateAdminMember)),
        installRoot: install.runtimeRoot,
      },
      service: {
        label: sources.launchd.label,
        generation: sources.launchd.generation,
        plist: plistMember,
        launcher: launcherMember,
        plistDestination: install.plistPath,
        launcherDestination: install.launcherPath,
        workingDirectory: install.workingDirectory,
      },
    };
    assertGenerationBindings(
      identity,
      readFileSync(join(building, plistMember), "utf8"),
      readFileSync(join(building, launcherMember), "utf8"),
      building,
    );

    const tree = walkTree(building);
    const manifest: RollbackPairManifest = {
      format: ROLLBACK_PAIR_FORMAT,
      pairId,
      createdAt: new Date().toISOString(),
      database: { member: databaseMember, manifestMember: backupManifestMember },
      identity,
      directories: [...tree.directories].sort(),
      inventory: tree.files.sort().map((member) => ({
        path: member,
        sha256: hashFile(join(building, member)),
        bytes: lstatSync(join(building, member)).size,
      })),
    };
    writeFileSync(join(building, ROLLBACK_PAIR_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });

    const indexed = walkTree(building).files.filter((member) => member !== ROLLBACK_PAIR_INDEX_FILE);
    const index = renderIndex(building, indexed);
    writeFileSync(join(building, ROLLBACK_PAIR_INDEX_FILE), index, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    });
    const indexDigest = hashBytes(Buffer.from(index, "utf8"));

    // Canonically validated where it was built, under the rules a rollback will apply, so a pair
    // that could never be used never becomes visible under an approved-looking name.
    validateRollbackPair(building, {
      pairId,
      indexDigest,
      databaseTargetPath: identity.database.targetPath,
      serviceLabel: identity.service.label,
      workingDirectory: identity.service.workingDirectory,
    });

    if (existsSync(root)) {
      throw acpError(ReasonCode.CONFLICT, "a rollback pair with this id appeared while this one was sealing", { root });
    }
    renameSync(building, root);
    return { pairId, root: realpathSync(root), indexPath: join(root, ROLLBACK_PAIR_INDEX_FILE), indexDigest, manifest };
  } catch (error) {
    // Only the stage this call created. The final root is never partially written, so there is
    // nothing there to clean up and nothing of anyone else's to remove.
    rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

interface IndexEntry {
  path: string;
  sha256: string;
}

const parseIndex = (text: string, root: string): IndexEntry[] => {
  const lines = text.split("\n");
  if (lines.at(-1) !== "") {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index is not newline-terminated", { root });
  }
  return lines.slice(0, -1).map((line) => {
    const match = INDEX_LINE.exec(line);
    if (!match?.[1] || !match[2]) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index has an unreadable line", { root, line });
    }
    return { sha256: `sha256:${match[1]}`, path: match[2] };
  });
};

const readPairManifest = (path: string, root: string): RollbackPairManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair manifest is unreadable", {
      root,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const candidate = parsed as Partial<RollbackPairManifest>;
  const runtime = candidate.identity?.runtime;
  const service = candidate.identity?.service;
  if (
    candidate.format !== ROLLBACK_PAIR_FORMAT ||
    typeof candidate.pairId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.database?.member !== "string" ||
    typeof candidate.database?.manifestMember !== "string" ||
    !Number.isInteger(candidate.identity?.schemaVersion) ||
    typeof candidate.identity?.database?.targetPath !== "string" ||
    candidate.identity.database.targetPath.length === 0 ||
    typeof runtime?.nodePath !== "string" ||
    typeof runtime.nodeVersion !== "string" ||
    typeof runtime.entrypoint !== "string" ||
    typeof runtime.entrypointSha256 !== "string" ||
    typeof runtime.stateAdmin !== "string" ||
    typeof runtime.stateAdminSha256 !== "string" ||
    typeof runtime.installRoot !== "string" ||
    typeof service?.label !== "string" ||
    service.label.length === 0 ||
    typeof service.generation !== "string" ||
    service.generation.length === 0 ||
    typeof service.plist !== "string" ||
    typeof service.launcher !== "string" ||
    typeof service.plistDestination !== "string" ||
    typeof service.launcherDestination !== "string" ||
    typeof service.workingDirectory !== "string" ||
    !Array.isArray(candidate.directories) ||
    candidate.directories.some((entry) => typeof entry !== "string") ||
    !Array.isArray(candidate.inventory) ||
    candidate.inventory.some(
      (member) =>
        typeof member?.path !== "string" ||
        typeof member.sha256 !== "string" ||
        !DIGEST.test(member.sha256) ||
        !Number.isInteger(member.bytes),
    )
  ) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair manifest has an invalid shape", { root });
  }
  return candidate as RollbackPairManifest;
};

export interface ValidatedRollbackPair {
  pairId: string;
  root: string;
  manifest: RollbackPairManifest;
  databasePath: string;
  plistPath: string;
  launcherPath: string;
  runtimeRoot: string;
  entrypointPath: string;
  stateAdminPath: string;
}

/**
 * Proves a named pair is the exact sealed artifact the approver retained a digest for, that it is
 * for this database, this service and this app root, and that it is internally whole.
 *
 * Mutates nothing, creates nothing, and changes no mode — a refusal has to be free, because the
 * commonest reason to run it is to find out whether a rollback is possible at all.
 */
export const validateRollbackPair = (
  pairRoot: string,
  expectation: RollbackPairExpectation,
): ValidatedRollbackPair => {
  assertAbsolute(pairRoot, "the sealed pair root");
  if (!PAIR_ID.test(expectation.pairId)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a rollback pair is named by a UUID", {
      pairId: expectation.pairId,
    });
  }
  if (!DIGEST.test(expectation.indexDigest)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "the retained index digest must be sha256:<hex>", {
      indexDigest: expectation.indexDigest,
    });
  }
  for (const [what, value] of [
    ["the intended database target", expectation.databaseTargetPath],
    ["the app root", expectation.workingDirectory],
  ] as const) {
    assertAbsolute(value, what);
  }
  if (expectation.serviceLabel.length === 0) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "the intended service label must be stated", {});
  }
  if (!existsSync(pairRoot)) {
    throw acpError(ReasonCode.NOT_FOUND, "no sealed rollback pair at this path", { pairRoot });
  }
  const rootStat = lstatSync(pairRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed pair root must be a direct directory", { pairRoot });
  }
  const root = realpathSync(pairRoot);
  if (basename(root) !== expectation.pairId) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair directory is not named by the requested id", {
      root,
      pairId: expectation.pairId,
    });
  }

  // The externally retained digest, first, because everything below is read out of files this
  // digest is the only evidence about.
  const indexPath = join(root, ROLLBACK_PAIR_INDEX_FILE);
  const indexStat = lstatSync(indexPath);
  if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed pair index must be a regular, non-symlink file", {
      indexPath,
    });
  }
  const indexBytes = readFileSync(indexPath);
  const indexDigest = hashBytes(indexBytes);
  if (indexDigest !== expectation.indexDigest) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index digest does not match the one retained outside it", {
      root,
      expected: expectation.indexDigest,
      actual: indexDigest,
    });
  }

  const entries = parseIndex(indexBytes.toString("utf8"), root);
  const entryPaths = entries.map((entry) => entry.path);
  // Counted before any set is built. A duplicated line and a missing one collapse to the same
  // set, and a comparison made after the collapse cannot tell them apart.
  const uniqueEntryPaths = new Set(entryPaths);
  if (uniqueEntryPaths.size !== entryPaths.length) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index names the same member twice", {
      root,
      named: entryPaths.length,
      distinct: uniqueEntryPaths.size,
    });
  }
  if (uniqueEntryPaths.has(ROLLBACK_PAIR_INDEX_FILE)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index cannot cover itself", { root });
  }
  if (!uniqueEntryPaths.has(ROLLBACK_PAIR_MANIFEST_FILE)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index does not cover the pair manifest", { root });
  }
  for (const member of entryPaths) {
    if (!MEMBER_PATH.test(member)) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member path is not a plain relative path", {
        root,
        member,
      });
    }
  }

  // Every member is a regular, unaliased, non-symlink file, and the path that gets *opened* — the
  // resolved one — is inside this pair. The unresolved string is never used again below.
  const contained = `${root}${sep}`;
  const resolvedByMember = new Map<string, string>();
  const identityByMember = new Map<string, string>();
  const sizeByMember = new Map<string, number>();
  for (const entry of entries) {
    const declared = join(root, entry.path);
    let stat;
    try {
      stat = lstatSync(declared);
    } catch {
      throw acpError(ReasonCode.NOT_FOUND, "the sealed pair index names a member that is not present", {
        root,
        member: entry.path,
      });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member must be a regular, non-symlink file", {
        root,
        member: entry.path,
      });
    }
    // A hard link is a second name for the same inode, outside the pair and not covered by it.
    // Whoever holds the other name can rewrite these bytes after this validation and before the
    // install, and no digest taken here would notice.
    if (stat.nlink !== 1) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member is hard-linked from outside the pair", {
        root,
        member: entry.path,
        links: stat.nlink,
      });
    }
    const resolved = realpathSync(declared);
    if (!resolved.startsWith(contained)) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member escapes the sealed pair root once resolved", {
        root,
        member: entry.path,
        resolved,
      });
    }
    const actual = hashFile(resolved);
    if (actual !== entry.sha256) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "a sealed pair member does not match the digest the index gives it", {
        root,
        member: entry.path,
        expected: entry.sha256,
        actual,
      });
    }
    resolvedByMember.set(entry.path, resolved);
    identityByMember.set(entry.path, `${stat.dev}:${stat.ino}`);
    sizeByMember.set(entry.path, stat.size);
  }

  // Nothing extra, and no empty directory hiding between the named members.
  const tree = walkTree(root);
  const vouched = [...entryPaths, ROLLBACK_PAIR_INDEX_FILE];
  if (tree.files.length !== vouched.length) {
    const vouchedSet = new Set(vouched);
    throw acpError(ReasonCode.INTERNAL_ERROR, "a file is present that nothing in the sealed pair vouches for", {
      root,
      extra: tree.files.filter((member) => !vouchedSet.has(member)),
      missing: vouched.filter((member) => !tree.files.includes(member)),
    });
  }

  const manifest = readPairManifest(resolvedByMember.get(ROLLBACK_PAIR_MANIFEST_FILE)!, root);
  if (manifest.pairId !== expectation.pairId) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair manifest names a different pair", {
      root,
      declared: manifest.pairId,
      requested: expectation.pairId,
    });
  }
  const presentDirectories = [...tree.directories].sort();
  const declaredDirectories = [...manifest.directories].sort();
  if (
    presentDirectories.length !== declaredDirectories.length ||
    presentDirectories.some((entry, at) => entry !== declaredDirectories[at])
  ) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair contains a directory its manifest does not declare", {
      root,
      present: presentDirectories,
      declared: declaredDirectories,
    });
  }

  const inventoryPaths = manifest.inventory.map((member) => member.path);
  const distinctInventory = new Set(inventoryPaths);
  const indexedInventory = entryPaths.filter((member) => member !== ROLLBACK_PAIR_MANIFEST_FILE);
  if (distinctInventory.size !== inventoryPaths.length || inventoryPaths.length !== indexedInventory.length) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index names a file the inventory does not", {
      root,
      indexed: indexedInventory.length,
      inventoried: inventoryPaths.length,
      distinctInventoried: distinctInventory.size,
    });
  }
  const digestByMember = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  for (const member of manifest.inventory) {
    if (!digestByMember.has(member.path)) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair inventory names a file the index does not", {
        root,
        member: member.path,
      });
    }
    if (digestByMember.get(member.path) !== member.sha256) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "a sealed pair member has two different recorded digests", {
        root,
        member: member.path,
        index: digestByMember.get(member.path),
        inventory: member.sha256,
      });
    }
    if (sizeByMember.get(member.path) !== member.bytes) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "a sealed pair member is not the size its inventory records", {
        root,
        member: member.path,
        declared: member.bytes,
        actual: sizeByMember.get(member.path),
      });
    }
  }
  for (const member of indexedInventory) {
    if (!distinctInventory.has(member)) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index names a file the inventory does not", {
        root,
        member,
      });
    }
  }

  // Roles: each named member exists, and no two roles are the same file — by path or by inode.
  const roles = {
    database: manifest.database.member,
    databaseManifest: manifest.database.manifestMember,
    entrypoint: `runtime/${manifest.identity.runtime.entrypoint}`,
    stateAdmin: `runtime/${manifest.identity.runtime.stateAdmin}`,
    plist: manifest.identity.service.plist,
    launcher: manifest.identity.service.launcher,
  } as const;
  for (const [role, member] of Object.entries(roles)) {
    if (!distinctInventory.has(member)) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair names a member it does not contain", {
        root,
        role,
        member,
      });
    }
  }
  const rolePaths = Object.values(roles);
  if (new Set(rolePaths).size !== rolePaths.length) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "two roles in the sealed pair are the same member", { root, roles });
  }
  const roleIdentities = rolePaths.map((member) => identityByMember.get(member)!);
  if (new Set(roleIdentities).size !== roleIdentities.length) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "two roles in the sealed pair are the same file", { root, roles });
  }
  if (basename(roles.plist) === basename(roles.launcher)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the plist and launcher in the sealed pair share a basename", {
      root,
      plist: roles.plist,
      launcher: roles.launcher,
    });
  }
  if (roles.databaseManifest !== `${roles.database}.manifest.json`) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair database manifest is not the one beside its image", {
      root,
      ...roles,
    });
  }
  if (digestByMember.get(roles.entrypoint) !== manifest.identity.runtime.entrypointSha256) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a runtime entrypoint digest its closure is not at", {
      root,
    });
  }
  if (digestByMember.get(roles.stateAdmin) !== manifest.identity.runtime.stateAdminSha256) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a state-admin digest its closure is not at", {
      root,
    });
  }

  const databasePath = resolvedByMember.get(roles.database)!;
  const backupManifest = validateBackup(databasePath, { assertSchemaInvariants: false });
  if (backupManifest.schemaVersion !== manifest.identity.schemaVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a schema version its image is not at", {
      root,
      declared: manifest.identity.schemaVersion,
      found: backupManifest.schemaVersion,
    });
  }
  if (backupManifest.source?.path !== manifest.identity.database.targetPath) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a database target its image is not of", {
      root,
      declared: manifest.identity.database.targetPath,
      found: backupManifest.source?.path,
    });
  }

  assertGenerationBindings(
    manifest.identity,
    readFileSync(resolvedByMember.get(roles.plist)!, "utf8"),
    readFileSync(resolvedByMember.get(roles.launcher)!, "utf8"),
    root,
  );

  // Compatibility with the deployment this is about to be applied to. The database target is
  // compared by canonical path only: a restore replaces the inode, so device and inode recorded
  // when the pair was sealed are legitimately different by the time it is used.
  const intendedTarget = canonical(expectation.databaseTargetPath);
  if (manifest.identity.database.targetPath !== intendedTarget) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair is a recovery point for a different database", {
      root,
      expected: intendedTarget,
      found: manifest.identity.database.targetPath,
    });
  }
  if (manifest.identity.service.label !== expectation.serviceLabel) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair is for a different service label", {
      root,
      expected: expectation.serviceLabel,
      found: manifest.identity.service.label,
    });
  }
  const intendedAppRoot = canonical(expectation.workingDirectory);
  if (manifest.identity.service.workingDirectory !== intendedAppRoot) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair installs under a different app root", {
      root,
      expected: intendedAppRoot,
      found: manifest.identity.service.workingDirectory,
    });
  }
  if (expectation.schemaVersion !== undefined && expectation.schemaVersion !== manifest.identity.schemaVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair is at a different schema version", {
      root,
      expected: expectation.schemaVersion,
      found: manifest.identity.schemaVersion,
    });
  }
  if (
    expectation.serviceGeneration !== undefined &&
    expectation.serviceGeneration !== manifest.identity.service.generation
  ) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a different service generation", {
      root,
      expected: expectation.serviceGeneration,
      found: manifest.identity.service.generation,
    });
  }
  if (expectation.nodeVersion !== undefined && expectation.nodeVersion !== manifest.identity.runtime.nodeVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a different runtime version", {
      root,
      expected: expectation.nodeVersion,
      found: manifest.identity.runtime.nodeVersion,
    });
  }

  return {
    pairId: manifest.pairId,
    root,
    manifest,
    databasePath,
    plistPath: resolvedByMember.get(roles.plist)!,
    launcherPath: resolvedByMember.get(roles.launcher)!,
    runtimeRoot: join(root, "runtime"),
    entrypointPath: resolvedByMember.get(roles.entrypoint)!,
    stateAdminPath: resolvedByMember.get(roles.stateAdmin)!,
  };
};

export interface StagedRollbackPair {
  pairId: string;
  stageRoot: string;
  manifest: RollbackPairManifest;
  databasePath: string;
  plistPath: string;
  launcherPath: string;
  runtimeRoot: string;
  stateAdminPath: string;
}

const STAGE_MANIFEST = "stage.json";

/**
 * Validates a pair and then takes its own copy of every member.
 *
 * This is the whole answer to "validated, then something else opened the file". The bytes an
 * apply installs are the bytes hashed here, in this directory, after the copy — not bytes at a
 * path someone was told about. A member swapped between validation and install, or rewritten
 * through a hard-linked alias, changes the pair and not the stage, and the stage is what runs.
 */
export const stageRollbackPair = (
  pairRoot: string,
  expectation: RollbackPairExpectation,
  stageParent: string,
): StagedRollbackPair => {
  assertAbsolute(stageParent, "the stage parent");
  const validated = validateRollbackPair(pairRoot, expectation);
  mkdirSync(stageParent, { recursive: true, mode: 0o700 });
  const stageRoot = join(stageParent, `.rollback-stage-${validated.pairId}-${process.pid}-${randomUUID()}`);
  mkdirSync(stageRoot, { mode: 0o700 });
  chmodSync(stageRoot, 0o700);
  try {
    const pairMembers = join(stageRoot, "pair");
    for (const member of validated.manifest.inventory) {
      copyPrivateFile(join(validated.root, member.path), join(pairMembers, member.path));
    }
    // Re-verified as copies. Hashing the source again would prove nothing about what was copied.
    for (const member of validated.manifest.inventory) {
      const staged = join(pairMembers, member.path);
      const stat = lstatSync(staged);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw acpError(ReasonCode.STATE_PATH_INSECURE, "a staged rollback member is not a private regular file", {
          stageRoot,
          member: member.path,
        });
      }
      const actual = hashFile(staged);
      if (actual !== member.sha256 || stat.size !== member.bytes) {
        throw acpError(ReasonCode.INTERNAL_ERROR, "a rollback member changed between validation and staging", {
          stageRoot,
          member: member.path,
          expected: member.sha256,
          actual,
        });
      }
    }
    const identity = validated.manifest.identity;
    assertGenerationBindings(
      identity,
      readFileSync(join(pairMembers, identity.service.plist), "utf8"),
      readFileSync(join(pairMembers, identity.service.launcher), "utf8"),
      stageRoot,
    );
    // The staged image has to satisfy the backup contract in its own right, not by inheritance.
    validateBackup(join(pairMembers, validated.manifest.database.member), { assertSchemaInvariants: false });

    return {
      pairId: validated.pairId,
      stageRoot,
      manifest: validated.manifest,
      databasePath: join(pairMembers, validated.manifest.database.member),
      plistPath: join(pairMembers, identity.service.plist),
      launcherPath: join(pairMembers, identity.service.launcher),
      runtimeRoot: join(pairMembers, "runtime"),
      stateAdminPath: join(pairMembers, "runtime", identity.runtime.stateAdmin),
    };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
};

const assertReplaceableFile = (path: string, what: string): void => {
  assertAbsolute(path, what);
  const parent = dirname(path);
  if (!existsSync(parent)) {
    throw acpError(ReasonCode.NOT_FOUND, `${what} has no directory to be installed into`, { path });
  }
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} is inside a directory that is not a direct directory`, {
      path,
    });
  }
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} is not a regular, non-symlink file`, { path });
  }
};

const assertReplaceableDirectory = (path: string, what: string): void => {
  assertAbsolute(path, what);
  const parent = dirname(path);
  if (!existsSync(parent)) {
    throw acpError(ReasonCode.NOT_FOUND, `${what} has no parent directory`, { path });
  }
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} is not a direct directory`, { path });
  }
};

export interface AppliedRollbackPair {
  pairId: string;
  generation: string;
  runtimeRoot: string;
  plistPath: string;
  launcherPath: string;
  databasePath: string;
  recoveryRoot: string;
}

export interface ApplyOptions {
  /** Test-only fault injection, named for the step it fires after. */
  failAfter?: "recovery" | "runtime" | "plist" | "launcher" | "database";
}

/**
 * Installs one staged generation, or leaves the previous one exactly as it was.
 *
 * The caller stops the service before this and starts it after; everything between is here, in
 * one process, so there is no window in which a partly-installed generation is somebody else's
 * problem. The previous runtime, plist and launcher are copied into the stage before the first
 * mutation, and any failure — including the database restore, which runs last and through the
 * *sealed* state-admin under the *sealed* Node — puts all of them back.
 */
export const applyRollbackPair = (
  staged: StagedRollbackPair,
  options: ApplyOptions = {},
): AppliedRollbackPair => {
  const identity = staged.manifest.identity;
  const runtimeDestination = identity.runtime.installRoot;
  const plistDestination = identity.service.plistDestination;
  const launcherDestination = identity.service.launcherDestination;
  const databaseDestination = identity.database.targetPath;

  // Every destination checked before the first mutation, so a wrong type is a refusal rather than
  // a discovery made halfway through replacing a generation.
  assertReplaceableDirectory(runtimeDestination, "the runtime install root");
  assertReplaceableFile(plistDestination, "the plist destination");
  assertReplaceableFile(launcherDestination, "the launcher destination");
  assertReplaceableFile(databaseDestination, "the database destination");

  const recoveryRoot = join(staged.stageRoot, "recovery");
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  chmodSync(recoveryRoot, 0o700);
  const hadRuntime = existsSync(runtimeDestination);
  const hadPlist = existsSync(plistDestination);
  const hadLauncher = existsSync(launcherDestination);
  if (hadRuntime) copyPrivateTree(runtimeDestination, join(recoveryRoot, "runtime"));
  if (hadPlist) copyPrivateFile(plistDestination, join(recoveryRoot, "plist"));
  if (hadLauncher) copyPrivateFile(launcherDestination, join(recoveryRoot, "launcher"));

  const compensate = (): void => {
    if (hadRuntime) {
      rmSync(runtimeDestination, { recursive: true, force: true });
      copyPrivateTree(join(recoveryRoot, "runtime"), runtimeDestination);
    } else rmSync(runtimeDestination, { recursive: true, force: true });
    if (hadPlist) {
      copyFileSync(join(recoveryRoot, "plist"), plistDestination);
      chmodSync(plistDestination, PRIVATE_FILE_MODE);
    } else rmSync(plistDestination, { force: true });
    if (hadLauncher) {
      copyFileSync(join(recoveryRoot, "launcher"), launcherDestination);
      chmodSync(launcherDestination, 0o700);
    } else rmSync(launcherDestination, { force: true });
  };

  try {
    if (options.failAfter === "recovery") throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after recovery", {});

    rmSync(runtimeDestination, { recursive: true, force: true });
    copyPrivateTree(staged.runtimeRoot, runtimeDestination);
    if (options.failAfter === "runtime") throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after runtime", {});

    copyFileSync(staged.plistPath, plistDestination);
    chmodSync(plistDestination, PRIVATE_FILE_MODE);
    if (options.failAfter === "plist") throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after plist", {});

    copyFileSync(staged.launcherPath, launcherDestination);
    chmodSync(launcherDestination, 0o700);
    if (options.failAfter === "launcher") throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after launcher", {});

    // The sealed generation restores its own database: its state-admin, under its Node. Running
    // the current build's restore here would be the defect this pair exists to prevent, one layer
    // down — pair A's image installed by generation B's code.
    //
    // The *resolved* path, and this is not tidiness. A Node entrypoint decides whether it is the
    // program being run by comparing `import.meta.url` — which is always the real path — against
    // `process.argv[1]` as given. Hand it a path that traverses a symlink and the comparison
    // fails, the CLI's main guard never fires, and the process exits 0 having done nothing.
    // Measured here: `/var/...` versus `/private/var/...` on macOS produced a rollback that
    // reported success and restored no database at all.
    const installedStateAdmin = join(realpathSync(runtimeDestination), identity.runtime.stateAdmin);
    execFileSync(
      identity.runtime.nodePath,
      [installedStateAdmin, "restore", staged.databasePath, "--database", databaseDestination, "--confirm-restore"],
      { encoding: "utf8", stdio: "pipe" },
    );
    // Exit zero is a claim, not a result. Whatever the sealed state-admin did, the destination
    // now has to be the image that was staged, byte for byte, or this rollback did not happen.
    const restoredDigest = hashFile(databaseDestination);
    const stagedDigest = hashFile(staged.databasePath);
    if (restoredDigest !== stagedDigest) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the restore reported success without installing the sealed image", {
        databaseDestination,
        expected: stagedDigest,
        actual: restoredDigest,
      });
    }
    if (options.failAfter === "database") throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after database", {});

    return {
      pairId: staged.pairId,
      generation: identity.service.generation,
      runtimeRoot: runtimeDestination,
      plistPath: plistDestination,
      launcherPath: launcherDestination,
      databasePath: databaseDestination,
      recoveryRoot,
    };
  } catch (error) {
    compensate();
    throw error;
  }
};

/**
 * A repeated flag is refused rather than resolved.
 *
 * `indexOf` takes the first occurrence, so `--expect-database A ... --expect-database B` would
 * quietly use A and ignore B. On this command that is the difference between rolling back the
 * database an operator named and one they corrected themselves out of, and nothing would say so.
 */
const argumentValue = (argv: readonly string[], flag: string): string | undefined => {
  const occurrences = argv.reduce((count, entry) => (entry === flag ? count + 1 : count), 0);
  if (occurrences > 1) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a flag was given more than once", { flag, occurrences });
  }
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  return argv[at + 1];
};

const USAGE = `rollback-pair — seal, validate, stage and apply one exact rollback pair

  rollback-pair seal --pairs-root DIR --database FILE \\
    --runtime-root DIR --entrypoint REL --state-admin REL \\
    --node-path FILE --node-version vX.Y.Z \\
    --install-runtime-root DIR --install-plist FILE --install-launcher FILE \\
    --working-directory DIR \\
    --service-label LABEL --service-generation NAME --plist FILE --launcher FILE

  rollback-pair validate|stage --pair-root DIR --pair-id UUID \\
    --expected-index-digest sha256:HEX --expect-database FILE \\
    --expect-service-label LABEL --expect-working-directory DIR [--stage-parent DIR]

  rollback-pair apply --stage-root DIR

seal states every identity rather than probing for it, so the same command seals the generation
being left and the one being moved to. It prints the pair id and SHA256(SHA256SUMS); retain both
OUTSIDE the pair, because a pair cannot prove its own index.

validate mutates nothing. stage validates and then takes its own verified copy of every member,
and apply installs only from that stage: runtime closure, plist, launcher and database together,
or the previous generation put back.
`;

const REQUIRED_SEAL_FLAGS = [
  "--pairs-root",
  "--database",
  "--runtime-root",
  "--entrypoint",
  "--state-admin",
  "--node-path",
  "--node-version",
  "--install-runtime-root",
  "--install-plist",
  "--install-launcher",
  "--working-directory",
  "--service-label",
  "--service-generation",
  "--plist",
  "--launcher",
] as const;

const REQUIRED_USE_FLAGS = [
  "--pair-root",
  "--pair-id",
  "--expected-index-digest",
  "--expect-database",
  "--expect-service-label",
  "--expect-working-directory",
] as const;

const expectationFrom = (supplied: Map<string, string>): RollbackPairExpectation => ({
  pairId: supplied.get("--pair-id")!,
  indexDigest: supplied.get("--expected-index-digest")!,
  databaseTargetPath: supplied.get("--expect-database")!,
  serviceLabel: supplied.get("--expect-service-label")!,
  workingDirectory: supplied.get("--expect-working-directory")!,
});

const collect = (argv: readonly string[], flags: readonly string[]): Map<string, string> | null => {
  const supplied = new Map<string, string>();
  for (const flag of flags) {
    const value = argumentValue(argv, flag);
    if (!value) return null;
    supplied.set(flag, value);
  }
  return supplied;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const command = argv[0];

  if (command === "seal") {
    const supplied = collect(argv, REQUIRED_SEAL_FLAGS);
    if (!supplied) {
      process.stderr.write(USAGE);
      return 2;
    }
    const sealed = await sealRollbackPair(supplied.get("--pairs-root")!, {
      databasePath: supplied.get("--database")!,
      runtimeRoot: supplied.get("--runtime-root")!,
      entrypoint: supplied.get("--entrypoint")!,
      stateAdmin: supplied.get("--state-admin")!,
      nodePath: supplied.get("--node-path")!,
      nodeVersion: supplied.get("--node-version")!,
      install: {
        runtimeRoot: supplied.get("--install-runtime-root")!,
        plistPath: supplied.get("--install-plist")!,
        launcherPath: supplied.get("--install-launcher")!,
        workingDirectory: supplied.get("--working-directory")!,
      },
      launchd: {
        label: supplied.get("--service-label")!,
        generation: supplied.get("--service-generation")!,
        plistPath: supplied.get("--plist")!,
        launcherPath: supplied.get("--launcher")!,
      },
    });
    process.stdout.write(
      [
        `ACP_PAIR_ID=${sealed.pairId}`,
        `ACP_PAIR_ROOT=${sealed.root}`,
        `ACP_PAIR_INDEX_DIGEST=${sealed.indexDigest}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (command === "validate" || command === "stage") {
    const supplied = collect(argv, REQUIRED_USE_FLAGS);
    if (!supplied) {
      process.stderr.write(USAGE);
      return 2;
    }
    const expectation = expectationFrom(supplied);
    if (command === "validate") {
      const validated = validateRollbackPair(supplied.get("--pair-root")!, expectation);
      process.stdout.write(
        [
          `ACP_PAIR_ROOT=${validated.root}`,
          `ACP_PAIR_SCHEMA_VERSION=${validated.manifest.identity.schemaVersion}`,
          `ACP_PAIR_SERVICE_LABEL=${validated.manifest.identity.service.label}`,
          `ACP_PAIR_SERVICE_GENERATION=${validated.manifest.identity.service.generation}`,
          "",
        ].join("\n"),
      );
      return 0;
    }
    const stageParent = argumentValue(argv, "--stage-parent");
    if (!stageParent) {
      process.stderr.write(USAGE);
      return 2;
    }
    const stagedPair = stageRollbackPair(supplied.get("--pair-root")!, expectation, stageParent);
    writeFileSync(
      join(stagedPair.stageRoot, STAGE_MANIFEST),
      `${JSON.stringify({ pairId: stagedPair.pairId, manifest: stagedPair.manifest }, null, 2)}\n`,
      { encoding: "utf8", mode: PRIVATE_FILE_MODE },
    );
    process.stdout.write(
      [
        `ACP_PAIR_ID=${stagedPair.pairId}`,
        `ACP_STAGE_ROOT=${stagedPair.stageRoot}`,
        `ACP_PAIR_SERVICE_GENERATION=${stagedPair.manifest.identity.service.generation}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (command === "apply") {
    const stageRoot = argumentValue(argv, "--stage-root");
    if (!stageRoot) {
      process.stderr.write(USAGE);
      return 2;
    }
    assertAbsolute(stageRoot, "the stage root");
    const stageManifest = JSON.parse(readFileSync(join(stageRoot, STAGE_MANIFEST), "utf8")) as {
      pairId: string;
      manifest: RollbackPairManifest;
    };
    const manifest = stageManifest.manifest;
    const pairMembers = join(stageRoot, "pair");
    const applied = applyRollbackPair({
      pairId: stageManifest.pairId,
      stageRoot,
      manifest,
      databasePath: join(pairMembers, manifest.database.member),
      plistPath: join(pairMembers, manifest.identity.service.plist),
      launcherPath: join(pairMembers, manifest.identity.service.launcher),
      runtimeRoot: join(pairMembers, "runtime"),
      stateAdminPath: join(pairMembers, "runtime", manifest.identity.runtime.stateAdmin),
    });
    process.stdout.write(
      [
        `ACP_APPLIED_PAIR_ID=${applied.pairId}`,
        `ACP_APPLIED_GENERATION=${applied.generation}`,
        `ACP_APPLIED_RUNTIME_ROOT=${applied.runtimeRoot}`,
        `ACP_APPLIED_DATABASE=${applied.databasePath}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  process.stdout.write(USAGE);
  return command === "--help" || command === "-h" || command === "help" ? 0 : 2;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      const body = isAcpError(error)
        ? { reasonCode: error.reasonCode, message: error.message, evidence: error.evidence }
        : { message: error instanceof Error ? error.message : String(error) };
      process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
      process.exit(1);
    });
}
