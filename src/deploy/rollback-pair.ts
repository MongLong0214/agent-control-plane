#!/usr/bin/env node
/**
 * The exact rollback pair: one sealed, self-contained artifact named by ID.
 *
 * A rollback is two restores that have to agree — the database and the bytes that read it. When
 * they are selected separately, nothing ties the two choices together, and the deployment path
 * here selected the bytes half implicitly: `find "$deploy_backups_dir" -maxdepth 1 -type d |
 * sort | tail -n 1`, the newest directory *by name*. Newest is not approved. An operator who
 * approved a rollback to generation N and installed anything later got a rollback to an identity
 * nobody named.
 *
 * So the pair is one directory named by a UUID, holding a supported WAL-complete database
 * backup, the runtime closure that reads it, and the launchd generation and config that starts
 * it. It is sealed once and then depends on nothing outside its own root: not the source tree,
 * not a registry, not the machine that made it. `validateRollbackPair` proves all of that before
 * anything is stopped or replaced.
 *
 * Two things are deliberately *not* inside the pair:
 *
 *   - The **index digest**, `SHA256(SHA256SUMS)`. A pair that vouches for its own index vouches
 *     for a forged one just as happily: rewrite a member, rewrite its line in the index, and
 *     every internal check agrees. The digest of the index is the one value the approver retains
 *     outside, and it is what the whole chain hangs from — index digest covers the index, the
 *     index covers `pair.json` and every member, `pair.json` states the inventory and identity.
 *   - The index's own line. `SHA256SUMS` cannot cover itself; a self-covering checksum file is
 *     either impossible to write or trivially forgeable depending on how it is done. It is
 *     self-excluding by construction and refused if it ever names itself.
 */
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
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { acpError, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { backupDatabase, validateBackup } from "../db/backup.ts";
import { PRIVATE_FILE_MODE, ensurePrivateDirectory } from "../db/state-preflight.ts";

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
  runtime: { nodePath: string; nodeVersion: string; entrypoint: string; entrypointSha256: string };
  service: { label: string; generation: string; plist: string; launcher: string };
}

export interface RollbackPairManifest {
  format: string;
  pairId: string;
  createdAt: string;
  database: { member: string; manifestMember: string };
  identity: RollbackPairIdentity;
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
 * sealed — a producer that discovers its own generation can only ever seal that generation.
 *
 * That matters beyond tidiness: a rollback to a sealed generation is a one-way door unless the
 * same code can seal the *forward* generation as its return leg. So `nodeVersion`, the service
 * label and the generation are inputs, and the member names are derived from the paths given
 * rather than from constants naming today's deployment.
 */
export interface RollbackPairSources {
  /** The database to seal a recovery point of. */
  databasePath: string;
  /** The runtime closure that reads it: a directory tree copied whole. */
  runtimeRoot: string;
  /** The runtime entrypoint, relative to `runtimeRoot`. */
  entrypoint: string;
  nodePath: string;
  /** Stated by the caller, never probed: the closure being sealed may not run here. */
  nodeVersion: string;
  launchd: { label: string; generation: string; plistPath: string; launcherPath: string };
}

export interface RollbackPairExpectation {
  pairId: string;
  /** The externally retained `SHA256(SHA256SUMS)`. */
  indexDigest: string;
  schemaVersion?: number;
  serviceLabel?: string;
  serviceGeneration?: string;
  nodeVersion?: string;
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

/**
 * Every entry that is not a directory, symbolic links included — a symlink is a member that has
 * to be refused by name, not one that quietly fails to appear in the walk.
 */
const walkMembers = (root: string, prefix = ""): string[] => {
  const members: string[] = [];
  for (const entry of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) members.push(...walkMembers(root, relative));
    else members.push(relative);
  }
  return members;
};

const copyPrivateFile = (from: string, to: string): void => {
  const source = lstatSync(from);
  if (!source.isFile() || source.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member source must be a regular file", { from });
  }
  mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  chmodSync(to, PRIVATE_FILE_MODE);
};

const renderIndex = (root: string, members: readonly string[]): string =>
  `${[...members]
    .sort()
    .map((member) => `${hashFile(join(root, member)).slice("sha256:".length)}  ${member}`)
    .join("\n")}\n`;

/**
 * Seals one pair. After this returns, the directory at `root` is the whole artifact: the caller
 * keeps `indexDigest` and the `pairId`, and nothing else has to survive.
 */
export const sealRollbackPair = async (
  pairsRoot: string,
  sources: RollbackPairSources,
  pairId: string = randomUUID(),
): Promise<SealedRollbackPair> => {
  if (!isAbsolute(pairsRoot)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the rollback pair root must be absolute", { pairsRoot });
  }
  if (!PAIR_ID.test(pairId)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a rollback pair is named by a UUID", { pairId });
  }
  ensurePrivateDirectory(pairsRoot);
  const root = join(pairsRoot, pairId);
  if (existsSync(root)) {
    throw acpError(ReasonCode.CONFLICT, "a rollback pair with this id already exists", { root });
  }
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);

  const databaseMember = `database/${basename(sources.databasePath)}`;
  const sealedDatabase = join(root, databaseMember);
  mkdirSync(join(root, "database"), { mode: 0o700 });
  // The supported path, not a file copy. SQLite in WAL mode commits into a side file, so the
  // bytes of `state.sqlite` are older than the last commit until something checkpoints them;
  // `cp` of that file yields a database that opens cleanly and is silently missing writes.
  // `backupDatabase` reads through SQLite's own backup API, which is WAL-coherent, and writes
  // the manifest a copy cannot produce — recorded by the process that had both files open.
  await backupDatabase(sources.databasePath, sealedDatabase);
  const backupManifestMember = `${databaseMember}.manifest.json`;

  for (const member of walkMembers(sources.runtimeRoot)) {
    copyPrivateFile(join(sources.runtimeRoot, member), join(root, "runtime", member));
  }
  const plistMember = `launchd/${basename(sources.launchd.plistPath)}`;
  const launcherMember = `launchd/${basename(sources.launchd.launcherPath)}`;
  copyPrivateFile(sources.launchd.plistPath, join(root, plistMember));
  copyPrivateFile(sources.launchd.launcherPath, join(root, launcherMember));

  const sealedManifest = validateBackup(sealedDatabase, { assertSchemaInvariants: false });
  const entrypointMember = `runtime/${sources.entrypoint}`;
  const identity: RollbackPairIdentity = {
    schemaVersion: sealedManifest.schemaVersion,
    runtime: {
      nodePath: sources.nodePath,
      nodeVersion: sources.nodeVersion,
      entrypoint: entrypointMember,
      entrypointSha256: hashFile(join(root, entrypointMember)),
    },
    service: {
      label: sources.launchd.label,
      generation: sources.launchd.generation,
      plist: plistMember,
      launcher: launcherMember,
    },
  };

  const inventoryMembers = walkMembers(root).sort();
  const manifest: RollbackPairManifest = {
    format: ROLLBACK_PAIR_FORMAT,
    pairId,
    createdAt: new Date().toISOString(),
    database: { member: databaseMember, manifestMember: backupManifestMember },
    identity,
    inventory: inventoryMembers.map((member) => ({
      path: member,
      sha256: hashFile(join(root, member)),
      bytes: lstatSync(join(root, member)).size,
    })),
  };
  writeFileSync(join(root, ROLLBACK_PAIR_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });

  const indexed = walkMembers(root).filter((member) => member !== ROLLBACK_PAIR_INDEX_FILE);
  const index = renderIndex(root, indexed);
  const indexPath = join(root, ROLLBACK_PAIR_INDEX_FILE);
  writeFileSync(indexPath, index, { encoding: "utf8", mode: PRIVATE_FILE_MODE });

  // The resolved root, so a caller's later `join(root, member)` names the same file the validator
  // will open after it resolves. Handing back the unresolved string is how the two drift.
  return {
    pairId,
    root: realpathSync(root),
    indexPath,
    indexDigest: hashBytes(Buffer.from(index, "utf8")),
    manifest,
  };
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
  if (
    candidate.format !== ROLLBACK_PAIR_FORMAT ||
    typeof candidate.pairId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.database?.member !== "string" ||
    typeof candidate.database?.manifestMember !== "string" ||
    !Number.isInteger(candidate.identity?.schemaVersion) ||
    typeof candidate.identity?.runtime?.nodePath !== "string" ||
    typeof candidate.identity?.runtime?.nodeVersion !== "string" ||
    typeof candidate.identity?.runtime?.entrypoint !== "string" ||
    typeof candidate.identity?.runtime?.entrypointSha256 !== "string" ||
    typeof candidate.identity?.service?.label !== "string" ||
    candidate.identity.service.label.length === 0 ||
    typeof candidate.identity.service.generation !== "string" ||
    candidate.identity.service.generation.length === 0 ||
    typeof candidate.identity.service.plist !== "string" ||
    typeof candidate.identity.service.launcher !== "string" ||
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
}

/**
 * Proves a named pair is the exact sealed artifact the approver retained a digest for, before
 * anything is stopped, restored or replaced.
 */
export const validateRollbackPair = (
  pairRoot: string,
  expectation: RollbackPairExpectation,
): ValidatedRollbackPair => {
  if (!isAbsolute(pairRoot)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed pair root must be absolute", { pairRoot });
  }
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

  // (2) The externally retained digest, first, because everything below is read out of files this
  // digest is the only evidence about. A pair whose index vouches for itself vouches for a
  // forgery just as readily: rewrite a member, rewrite its line, and every internal check agrees.
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

  // (5) and (6): every member is a regular, non-symlink file, and the path that gets *opened* —
  // the resolved one — is inside this pair. The unresolved string is never used again below.
  const contained = `${root}${sep}`;
  const resolvedByMember = new Map<string, string>();
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
  }

  // Nothing extra: a file the index does not name is a file nothing vouches for, and the pair is
  // the whole artifact rather than the part of it somebody happened to list.
  const present = walkMembers(root);
  const vouched = [...entryPaths, ROLLBACK_PAIR_INDEX_FILE];
  if (present.length !== vouched.length) {
    const vouchedSet = new Set(vouched);
    const extra = present.filter((member) => !vouchedSet.has(member));
    const missing = vouched.filter((member) => !present.includes(member));
    throw acpError(ReasonCode.INTERNAL_ERROR, "a file is present that nothing in the sealed pair vouches for", {
      root,
      extra,
      missing,
    });
  }

  // (3) The inventory. `pair.json` cannot list its own digest, so the index covers it and it
  // covers everything else; the two lists have to agree exactly, counts first.
  const manifest = readPairManifest(resolvedByMember.get(ROLLBACK_PAIR_MANIFEST_FILE)!, root);
  if (manifest.pairId !== expectation.pairId) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair manifest names a different pair", {
      root,
      declared: manifest.pairId,
      requested: expectation.pairId,
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
  }
  for (const member of indexedInventory) {
    if (!distinctInventory.has(member)) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair index names a file the inventory does not", {
        root,
        member,
      });
    }
  }

  // (4) Schema, runtime and service identity — stated by the pair and checked against what it
  // actually contains, then against whatever the approver pinned alongside the digest.
  const named = {
    database: manifest.database.member,
    databaseManifest: manifest.database.manifestMember,
    entrypoint: manifest.identity.runtime.entrypoint,
    plist: manifest.identity.service.plist,
    launcher: manifest.identity.service.launcher,
  };
  for (const [role, member] of Object.entries(named)) {
    if (!distinctInventory.has(member)) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair names a member it does not contain", {
        root,
        role,
        member,
      });
    }
  }
  if (named.databaseManifest !== `${named.database}.manifest.json`) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair database manifest is not the one beside its image", {
      root,
      ...named,
    });
  }
  if (digestByMember.get(named.entrypoint) !== manifest.identity.runtime.entrypointSha256) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a runtime entrypoint digest its closure is not at", {
      root,
      declared: manifest.identity.runtime.entrypointSha256,
      found: digestByMember.get(named.entrypoint),
    });
  }

  const databasePath = resolvedByMember.get(named.database)!;
  // The supported-backup check: private mode, manifest shape, checksum, integrity, and a version
  // this build can read. A raw copy of a live SQLite file has no manifest and fails here.
  const backupManifest = validateBackup(databasePath, { assertSchemaInvariants: false });
  if (backupManifest.schemaVersion !== manifest.identity.schemaVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a schema version its image is not at", {
      root,
      declared: manifest.identity.schemaVersion,
      found: backupManifest.schemaVersion,
    });
  }

  if (expectation.schemaVersion !== undefined && expectation.schemaVersion !== manifest.identity.schemaVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair is at a different schema version", {
      root,
      expected: expectation.schemaVersion,
      found: manifest.identity.schemaVersion,
    });
  }
  if (expectation.serviceLabel !== undefined && expectation.serviceLabel !== manifest.identity.service.label) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a different service label", {
      root,
      expected: expectation.serviceLabel,
      found: manifest.identity.service.label,
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
    plistPath: resolvedByMember.get(named.plist)!,
    launcherPath: resolvedByMember.get(named.launcher)!,
  };
};

const argumentValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  return argv[at + 1];
};

const USAGE = `rollback-pair — seal and validate one exact rollback pair

  rollback-pair seal --pairs-root /absolute/rollback-pairs \\
    --database /absolute/state.sqlite \\
    --runtime-root /absolute/dist --entrypoint daemon/agentcpd.js \\
    --node-path /absolute/node --node-version vX.Y.Z \\
    --service-label LABEL --service-generation NAME \\
    --plist /absolute/LABEL.plist --launcher /absolute/agentcpd-launch.sh

  rollback-pair validate --pair-root /absolute/<uuid> --pair-id <uuid> \\
    --expected-index-digest sha256:<hex>

seal states every identity rather than probing for it, so the same command seals the
generation being left and, later, the one being moved to. It prints the pair id and
SHA256(SHA256SUMS); retain both OUTSIDE the pair, because a pair cannot prove its own index.

validate refuses before anything is stopped or replaced, and prints the absolute member
paths a rollback consumes.
`;

const REQUIRED_SEAL_FLAGS = [
  "--pairs-root",
  "--database",
  "--runtime-root",
  "--entrypoint",
  "--node-path",
  "--node-version",
  "--service-label",
  "--service-generation",
  "--plist",
  "--launcher",
] as const;

const main = async (argv: readonly string[]): Promise<number> => {
  const command = argv[0];
  if (command === "seal") {
    const supplied = new Map<string, string>();
    for (const flag of REQUIRED_SEAL_FLAGS) {
      const value = argumentValue(argv, flag);
      if (!value) {
        process.stderr.write(USAGE);
        return 2;
      }
      supplied.set(flag, value);
    }
    const sealed = await sealRollbackPair(supplied.get("--pairs-root")!, {
      databasePath: supplied.get("--database")!,
      runtimeRoot: supplied.get("--runtime-root")!,
      entrypoint: supplied.get("--entrypoint")!,
      nodePath: supplied.get("--node-path")!,
      nodeVersion: supplied.get("--node-version")!,
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
  if (command !== "validate") {
    process.stdout.write(USAGE);
    return command === "--help" || command === "-h" || command === "help" ? 0 : 2;
  }
  const pairRoot = argumentValue(argv, "--pair-root");
  const pairId = argumentValue(argv, "--pair-id");
  const indexDigest = argumentValue(argv, "--expected-index-digest");
  if (!pairRoot || !pairId || !indexDigest) {
    process.stderr.write(USAGE);
    return 2;
  }
  const validated = validateRollbackPair(pairRoot, { pairId, indexDigest });
  process.stdout.write(
    [
      `ACP_PAIR_ROOT=${validated.root}`,
      `ACP_PAIR_DATABASE=${validated.databasePath}`,
      `ACP_PAIR_PLIST=${validated.plistPath}`,
      `ACP_PAIR_LAUNCHER=${validated.launcherPath}`,
      `ACP_PAIR_SCHEMA_VERSION=${validated.manifest.identity.schemaVersion}`,
      `ACP_PAIR_SERVICE_LABEL=${validated.manifest.identity.service.label}`,
      `ACP_PAIR_SERVICE_GENERATION=${validated.manifest.identity.service.generation}`,
      "",
    ].join("\n"),
  );
  return 0;
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
