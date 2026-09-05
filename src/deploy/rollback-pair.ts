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
  constants as fsConstants,
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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { acpError, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { backupDatabase, captureRollbackPointSync, restoreDatabase, validateBackup } from "../db/backup.ts";
import { RollbackFilesystem, type RollbackEntry, type RollbackParent } from "../db/fd-vfs.ts";
import { PRIVATE_FILE_MODE } from "../db/state-preflight.ts";

export const ROLLBACK_PAIR_FORMAT = "agent-control-plane.rollback-pair/v1";
export const ROLLBACK_PAIR_INDEX_FILE = "SHA256SUMS";
export const ROLLBACK_PAIR_MANIFEST_FILE = "pair.json";

const PAIR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INDEX_LINE = /^([a-f0-9]{64}) {2}(\S+)$/;
/**
 * Member paths are POSIX-relative, whitespace-free, and cannot climb out by name.
 *
 * Segments may begin with a dot. The first version of this rule required an alphanumeric first
 * character, which is fine for a synthetic pair and cannot express a real one: sealing an actual
 * dependency tree turned up `.npmignore`, `.travis.yml` and a `.bin/` directory immediately. What
 * this is for is refusing traversal and whitespace, so `.` and `..` are refused by name and a
 * leading dot is not treated as suspicious on its own.
 */
const MEMBER_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isMemberPath = (value: string): boolean => {
  if (value.length === 0) return false;
  return value
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && MEMBER_SEGMENT.test(segment));
};

export interface RollbackPairMember {
  /** POSIX-style path relative to the pair root. */
  path: string;
  sha256: string;
  bytes: number;
  /** The permission bits the member is installed with. An executable that arrives 0600 is inert. */
  mode: number;
}

export interface RollbackPairIdentity {
  /** The schema version of the sealed database image. */
  schemaVersion: number;
  /** The logical database this pair is a recovery point for, as recorded when it was taken. */
  database: { targetPath: string };
  runtime: {
    /** The Node executable, relative to the sealed runtime root. Never an external path. */
    nodeExecutable: string;
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
  /**
   * Every directory in the pair with its mode.
   *
   * Not just a census against hiding: a tree copied by walking its *files* never creates an empty
   * directory at all, so one that mattered — a spool, a socket directory, a plugin drop — would
   * be silently absent from the installed generation. Measured before this carried modes: an empty
   * directory produced no file entries and was lost through seal, stage and install alike.
   */
  directories: Array<{ path: string; mode: number }>;
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
  /**
   * The Node executable, relative to `runtimeRoot`.
   *
   * It is sealed, not referenced. A pair that names an external interpreter is not self-contained:
   * the rollback it promises is "restore these bytes and run them under whatever `node` happens to
   * be on this machine afterwards", which is the generation-mixing this whole mechanism exists to
   * prevent, one layer down. The closure has to be able to run after the external Node is gone.
   */
  nodeExecutable: string;
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
  /** Where the runtime closure is installed. */
  runtimeRoot: string;
  /** The schema version the sealed image must be at. */
  schemaVersion: number;
  /** The generation being restored, as the approver recorded it. */
  serviceGeneration: string;
  /** The runtime version the sealed closure declares. */
  nodeVersion: string;
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

/**
 * Copies one member, preserving the bits that decide whether it can run.
 *
 * Forcing every member to 0600 was fine while a pair held only data. It is not fine once the pair
 * holds the interpreter: an executable installed without its execute bit is an inert file, and the
 * rollback would put back a generation that cannot start. So the source mode is carried across,
 * refused if it is group- or world-writable, and recorded in the inventory so validation can see a
 * mode that drifted.
 *
 * `COPYFILE_FICLONE` asks APFS for a copy-on-write clone and falls back to a real copy elsewhere,
 * which is what makes sealing a 100MB interpreter cost almost nothing on this filesystem.
 */
const copyMemberFile = (from: string, to: string): void => {
  const source = lstatSync(from);
  if (!source.isFile() || source.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member source must be a regular file", { from });
  }
  const mode = source.mode & 0o7777;
  if ((mode & 0o022) !== 0) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member source is group- or world-writable", {
      from,
      mode: mode.toString(8),
    });
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to, fsConstants.COPYFILE_FICLONE);
  chmodSync(to, mode);
};

const copyPrivateFile = (from: string, to: string): void => {
  copyMemberFile(from, to);
};

const copyPrivateTree = (from: string, to: string): void => {
  const tree = walkTree(from);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  // Directories first, and every one of them — including the empty ones a file walk cannot see.
  for (const directory of tree.directories) {
    const source = lstatSync(join(from, directory));
    mkdirSync(join(to, directory), { recursive: true, mode: 0o700 });
    chmodSync(join(to, directory), source.mode & 0o7777);
  }
  for (const member of tree.files) copyMemberFile(join(from, member), join(to, member));
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

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

const unescapeXml = (value: string): string =>
  value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);

export type PlistValue = string | string[];

/**
 * Parses the launchd plist into its top-level keys.
 *
 * A substring search over the plist text is not a check on the plist. `text.includes(label)` is
 * satisfied by the label appearing in an XML comment, in an unrelated key's value, or in a
 * `StandardOutPath` that happens to contain it — none of which is launchd loading that job. What
 * decides at load time is the value bound to a key, so that is what this reads.
 *
 * Deliberately a closed parser over the shape this repository's own renderer emits — a flat
 * `<dict>` of `<key>` to `<string>` or `<array>` of `<string>` — rather than a general XML
 * reader. Anything outside that shape is refused rather than guessed at.
 */
export const parsePlistDictionary = (text: string, where: string): Record<string, PlistValue> => {
  const open = text.indexOf("<dict>");
  const close = text.lastIndexOf("</dict>");
  if (open === -1 || close === -1 || close < open) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist has no dictionary to read", { where });
  }
  const body = text.slice(open + "<dict>".length, close);
  const entries: Record<string, PlistValue> = {};
  const scanner = /<key>([\s\S]*?)<\/key>\s*(<string>[\s\S]*?<\/string>|<array>[\s\S]*?<\/array>|<true\/>|<false\/>|<integer>[\s\S]*?<\/integer>|<dict>[\s\S]*?<\/dict>)/g;
  for (;;) {
    const match = scanner.exec(body);
    if (!match) break;
    const key = unescapeXml(match[1]!.trim());
    const raw = match[2]!;
    if (raw.startsWith("<string>")) {
      entries[key] = unescapeXml(raw.slice("<string>".length, -"</string>".length));
    } else if (raw.startsWith("<array>")) {
      const inner = raw.slice("<array>".length, -"</array>".length);
      entries[key] = [...inner.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((entry) =>
        unescapeXml(entry[1]!),
      );
    }
  }
  return entries;
};

export interface LauncherBinding {
  nodePath: string;
  appRoot: string;
  /** The entrypoint the launcher executes, relative to the app root. */
  entrypoint: string;
}

/** `printf %q` leaves a plain path bare and single-quotes anything that needs it. */
const unquoteShell = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  }
  return trimmed;
};

/**
 * Reads the launcher as the closed grammar the installer generates, rather than searching it.
 *
 * The installer writes exactly three things this cares about: an `ACP_NODE_PATH` assignment, an
 * `ACP_APP_ROOT` assignment, and a final `exec` of the entrypoint under both. A launcher that does
 * not parse as that grammar is refused — which is the point, because a comment mentioning the
 * right path satisfies a substring search while binding the daemon to something else entirely.
 */
export const parseLauncherBinding = (text: string, where: string): LauncherBinding => {
  const nodeLine = /^ACP_NODE_PATH=(.+)$/m.exec(text);
  const appLine = /^ACP_APP_ROOT=(.+)$/m.exec(text);
  const execLine = /^exec "\$ACP_NODE_PATH" "\$ACP_APP_ROOT\/(.+)"\s*$/m.exec(text);
  if (!nodeLine?.[1] || !appLine?.[1] || !execLine?.[1]) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher does not parse as a launcher this deployment generates", {
      where,
      boundNode: Boolean(nodeLine),
      boundAppRoot: Boolean(appLine),
      boundEntrypoint: Boolean(execLine),
    });
  }
  return {
    nodePath: unquoteShell(nodeLine[1]),
    appRoot: unquoteShell(appLine[1]),
    entrypoint: execLine[1].trim(),
  };
};

/**
 * The bindings the plist and launcher must already carry, checked against the identity the pair
 * declares — by parsed field and parsed grammar, never by substring.
 *
 * This is what stops pair A's database from being installed beside generation B's runtime: the
 * sealed launcher binds one Node executable and one entrypoint, and if they are not the closure
 * in this pair the pair is refused rather than half-applied.
 */
const assertGenerationBindings = (
  identity: RollbackPairIdentity,
  plistText: string,
  launcherText: string,
  where: string,
): void => {
  const { runtime, service } = identity;
  const plist = parsePlistDictionary(plistText, where);

  if (plist["Label"] !== service.label) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist does not declare the service label this pair names", {
      where,
      expected: service.label,
      found: plist["Label"],
    });
  }
  const programArguments = plist["ProgramArguments"];
  if (
    !Array.isArray(programArguments) ||
    programArguments.length !== 1 ||
    programArguments[0] !== service.launcherDestination
  ) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist does not run the launcher this pair installs", {
      where,
      expected: [service.launcherDestination],
      found: programArguments,
    });
  }
  if (plist["WorkingDirectory"] !== service.workingDirectory) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed plist does not name the working directory this pair installs under", {
      where,
      expected: service.workingDirectory,
      found: plist["WorkingDirectory"],
    });
  }

  const launcher = parseLauncherBinding(launcherText, where);
  const installedNode = join(runtime.installRoot, runtime.nodeExecutable);
  if (launcher.nodePath !== installedNode) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher is not bound to the Node executable this pair installs", {
      where,
      expected: installedNode,
      found: launcher.nodePath,
    });
  }
  if (launcher.appRoot !== service.workingDirectory) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher is not bound to the app root this pair installs under", {
      where,
      expected: service.workingDirectory,
      found: launcher.appRoot,
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
  if (launcher.entrypoint !== fromAppRoot) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed launcher does not execute the entrypoint this pair installs", {
      where,
      expected: fromAppRoot,
      found: launcher.entrypoint,
    });
  }
};

const SYSTEM_LIBRARY_PREFIXES = ["/usr/lib/", "/System/Library/", "/System/iOSSupport/"];
/** Mach-O magic numbers: 64/32-bit, both endiannesses, and the fat-binary wrappers. */
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca]);

const isMachO = (path: string): boolean => {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) < 4) return false;
    return MACH_O_MAGIC.has(header.readUInt32BE(0)) || MACH_O_MAGIC.has(header.readUInt32LE(0));
  } finally {
    closeSync(fd);
  }
};

/**
 * Refuses a closure that cannot run once everything outside it is gone.
 *
 * A pair that carries the interpreter but leaves a dylib behind is self-contained only until the
 * machine it was sealed on changes, and the way that failure shows up is a rollback that installs
 * cleanly and then will not start. So every Mach-O in the sealed tree is asked what it links
 * against, recursively, and anything absolute that is neither a macOS system library nor inside
 * this tree is a refusal at seal time — where it is a message, rather than at start time, where it
 * is an outage.
 *
 * `@rpath`, `@loader_path` and `@executable_path` references resolve relative to the image that
 * carries them, so they stay inside the tree by construction and are accepted. macOS system
 * libraries are the one declared platform boundary: they live in the dyld shared cache and are not
 * copyable artifacts.
 */
const assertClosureIsSelfContained = (runtimeRoot: string): void => {
  const external: Array<{ member: string; dependency: string }> = [];
  for (const member of walkTree(runtimeRoot).files) {
    const absolute = join(runtimeRoot, member);
    if (!isMachO(absolute)) continue;
    let linkage: string;
    try {
      linkage = execFileSync("/usr/bin/otool", ["-L", absolute], { encoding: "utf8", stdio: "pipe" });
    } catch {
      // A Mach-O this host cannot read the linkage of is not evidence that it has none.
      throw acpError(ReasonCode.INTERNAL_ERROR, "the dynamic linkage of a sealed binary could not be read", {
        member,
      });
    }
    for (const line of linkage.split("\n").slice(1)) {
      const dependency = line.trim().split(" ")[0];
      if (!dependency || !dependency.startsWith("/")) continue;
      if (SYSTEM_LIBRARY_PREFIXES.some((prefix) => dependency.startsWith(prefix))) continue;
      if (dependency.startsWith(`${runtimeRoot}/`)) continue;
      external.push({ member, dependency });
    }
  }
  if (external.length > 0) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed runtime closure depends on a library outside itself", {
      runtimeRoot,
      external,
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
  if (basename(sources.launchd.plistPath) === basename(sources.launchd.launcherPath)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "the plist and launcher cannot share a basename inside one pair", {
      plistPath: sources.launchd.plistPath,
      launcherPath: sources.launchd.launcherPath,
    });
  }

  // Owner-only, hidden, and beside the destination so the rename that publishes it is atomic
  // rather than a cross-device copy. Only this directory is ever removed on failure.
  mkdirSync(pairsRoot, { recursive: true, mode: 0o700 });
  const stageName = `.staging-${pairId}-${process.pid}-${randomUUID()}`;
  const stage = join(pairsRoot, stageName);
  mkdirSync(stage, { mode: 0o700 });
  chmodSync(stage, 0o700);
  const building = join(stage, pairId);

  // Publication and cleanup are anchored on held descriptors and inode identity, not pathnames.
  // `existsSync(root)` then `renameSync` was a check and a use with a gap between them, and the
  // gap is where a foreign directory takes the final name; a pathname-only cleanup then removes
  // whatever is under the stage name when it runs, which after a swap is somebody else's tree.
  const rollbackFs = RollbackFilesystem.load();
  const pairsParent = rollbackFs.openParent(pairsRoot);
  const stageIdentity = rollbackFs.stat(pairsParent, stageName);
  if (stageIdentity === null || stageIdentity.type !== "dir") {
    rollbackFs.dispose();
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the staging directory vanished as it was created", {
      stage,
    });
  }

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
    const nodeMember = `runtime/${sources.nodeExecutable}`;
    const nodeStat = lstatSync(join(building, nodeMember));
    if ((nodeStat.mode & 0o111) === 0) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed Node executable has no execute bit", {
        member: nodeMember,
        mode: (nodeStat.mode & 0o7777).toString(8),
      });
    }
    assertClosureIsSelfContained(join(building, "runtime"));
    const identity: RollbackPairIdentity = {
      schemaVersion: sealedManifest.schemaVersion,
      database: { targetPath: sealedManifest.source.path },
      runtime: {
        nodeExecutable: sources.nodeExecutable,
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
      directories: [...tree.directories]
        .sort()
        .map((directory) => ({ path: directory, mode: lstatSync(join(building, directory)).mode & 0o7777 })),
      inventory: tree.files.sort().map((member) => ({
        path: member,
        sha256: hashFile(join(building, member)),
        bytes: lstatSync(join(building, member)).size,
        mode: lstatSync(join(building, member)).mode & 0o7777,
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
      runtimeRoot: identity.runtime.installRoot,
      schemaVersion: identity.schemaVersion,
      serviceGeneration: identity.service.generation,
      nodeVersion: identity.runtime.nodeVersion,
    });

    // One syscall decides both that the name was free and that it is now ours. A pair id already
    // taken — by a real pair or by a foreign empty directory that appeared a moment ago — is an
    // EEXIST refusal, never an overwrite of what is there.
    const stageParent = rollbackFs.openParent(stage);
    try {
      rollbackFs.renameExclusive(stageParent, pairId, pairsParent, pairId);
    } finally {
      rollbackFs.closeParent(stageParent);
    }
    return { pairId, root: realpathSync(root), indexPath: join(root, ROLLBACK_PAIR_INDEX_FILE), indexDigest, manifest };
  } finally {
    // Only the exact directory this call created, identified by the inode it had when it was
    // created. If the stage was replaced in the meantime this refuses and leaves the intruder
    // alone rather than deleting it on somebody else's behalf.
    try {
      rollbackFs.removeOwned(pairsParent, stageName, stageIdentity.dev, stageIdentity.ino);
    } catch {
      /* A cleanup that refuses must not replace the reason the seal failed. The stage is
         owner-private and named as a dotfile; leaving it is the safe half of this trade. */
    }
    rollbackFs.dispose();
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
    typeof runtime?.nodeExecutable !== "string" ||
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
    candidate.directories.some(
      (entry) => typeof entry?.path !== "string" || !Number.isInteger(entry.mode),
    ) ||
    !Array.isArray(candidate.inventory) ||
    candidate.inventory.some(
      (member) =>
        typeof member?.path !== "string" ||
        typeof member.sha256 !== "string" ||
        !DIGEST.test(member.sha256) ||
        !Number.isInteger(member.bytes) ||
        !Number.isInteger(member.mode),
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
  // The index is held to every rule a member is held to. It is the file the whole chain hangs
  // from, and for a while it was the one file exempt from the checks it makes possible: a
  // hard-linked or link-reached index can be rewritten by whoever holds the other name, and then
  // every digest below is measured against text an outsider chose.
  const containedIn = `${root}${sep}`;
  const indexPath = join(root, ROLLBACK_PAIR_INDEX_FILE);
  const indexStat = lstatSync(indexPath);
  if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed pair index must be a regular, non-symlink file", {
      indexPath,
    });
  }
  if (indexStat.nlink !== 1) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed pair index is hard-linked from outside the pair", {
      indexPath,
      links: indexStat.nlink,
    });
  }
  const resolvedIndexPath = realpathSync(indexPath);
  if (!resolvedIndexPath.startsWith(containedIn)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed pair index escapes the sealed pair root once resolved", {
      indexPath,
      resolved: resolvedIndexPath,
    });
  }
  const indexIdentity = `${indexStat.dev}:${indexStat.ino}`;
  const indexBytes = readFileSync(resolvedIndexPath);
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
    if (!isMemberPath(member)) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member path is not a plain relative path", {
        root,
        member,
      });
    }
  }

  // Every member is a regular, unaliased, non-symlink file, and the path that gets *opened* — the
  // resolved one — is inside this pair. The unresolved string is never used again below.
  const contained = containedIn;
  const resolvedByMember = new Map<string, string>();
  const identityByMember = new Map<string, string>();
  const sizeByMember = new Map<string, number>();
  const modeByMember = new Map<string, number>();
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
    modeByMember.set(entry.path, stat.mode & 0o7777);
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
  const declaredDirectories = [...manifest.directories].map((entry) => entry.path).sort();
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
  for (const directory of manifest.directories) {
    const actual = lstatSync(join(root, directory.path));
    if (!actual.isDirectory() || actual.isSymbolicLink()) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair directory is not a direct directory", {
        root,
        directory: directory.path,
      });
    }
    if ((actual.mode & 0o7777) !== directory.mode) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "a sealed pair directory is not at the mode its manifest records", {
        root,
        directory: directory.path,
        declared: directory.mode.toString(8),
        actual: (actual.mode & 0o7777).toString(8),
      });
    }
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
    // A digest says what the bytes are; it says nothing about whether they can run. An executable
    // whose mode drifted to 0600 installs as an inert file and the generation will not start.
    if (modeByMember.get(member.path) !== member.mode) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "a sealed pair member is not at the mode its inventory records", {
        root,
        member: member.path,
        declared: member.mode.toString(8),
        actual: modeByMember.get(member.path)?.toString(8),
      });
    }
    if ((member.mode & 0o022) !== 0) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "a sealed pair member is group- or world-writable", {
        root,
        member: member.path,
        mode: member.mode.toString(8),
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
    nodeExecutable: `runtime/${manifest.identity.runtime.nodeExecutable}`,
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
  // Every role, plus the index and the manifest: no two of them may be the same inode. A pair
  // whose index and manifest are one file, or whose plist is also its launcher, has fewer
  // independent artifacts than it claims to have.
  const roleIdentities = [
    ...rolePaths.map((member) => identityByMember.get(member)!),
    indexIdentity,
    identityByMember.get(ROLLBACK_PAIR_MANIFEST_FILE)!,
  ];
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
  if (((modeByMember.get(roles.nodeExecutable) ?? 0) & 0o111) === 0) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "the sealed Node executable is not executable in this pair", {
      root,
      member: roles.nodeExecutable,
      mode: modeByMember.get(roles.nodeExecutable)?.toString(8),
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
  // None of these is optional. An expectation a caller may omit is an expectation that will be
  // omitted, and then a pair for one schema, generation, runtime or install root is applied to
  // another with nothing objecting.
  if (expectation.schemaVersion !== manifest.identity.schemaVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair is at a different schema version", {
      root,
      expected: expectation.schemaVersion,
      found: manifest.identity.schemaVersion,
    });
  }
  if (expectation.serviceGeneration !== manifest.identity.service.generation) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a different service generation", {
      root,
      expected: expectation.serviceGeneration,
      found: manifest.identity.service.generation,
    });
  }
  if (expectation.nodeVersion !== manifest.identity.runtime.nodeVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair states a different runtime version", {
      root,
      expected: expectation.nodeVersion,
      found: manifest.identity.runtime.nodeVersion,
    });
  }
  if (canonical(expectation.runtimeRoot) !== manifest.identity.runtime.installRoot) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "the sealed pair installs its runtime somewhere else", {
      root,
      expected: canonical(expectation.runtimeRoot),
      found: manifest.identity.runtime.installRoot,
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
    // Directories first, every one of them. Copying the inventory alone reproduces only the files,
    // so an empty directory would reach the stage as nothing and the install would be missing it —
    // measured, and invisible to any census that counts files.
    mkdirSync(pairMembers, { recursive: true, mode: 0o700 });
    for (const directory of validated.manifest.directories) {
      mkdirSync(join(pairMembers, directory.path), { recursive: true, mode: 0o700 });
      chmodSync(join(pairMembers, directory.path), directory.mode);
    }
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
    // The index and the manifest come into the stage too, and the index is then re-verified from
    // the copy against the digest retained outside the pair — not against the pair, and not by
    // trusting the earlier read. Everything installed below is checked against text this stage
    // holds, so a rewrite of the pair's index after validation changes nothing that runs.
    for (const member of [ROLLBACK_PAIR_MANIFEST_FILE, ROLLBACK_PAIR_INDEX_FILE]) {
      copyPrivateFile(join(validated.root, member), join(pairMembers, member));
      const stagedStat = lstatSync(join(pairMembers, member));
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.nlink !== 1) {
        throw acpError(ReasonCode.STATE_PATH_INSECURE, "a staged pair artifact is not a private regular file", {
          stageRoot,
          member,
        });
      }
    }
    const stagedIndexBytes = readFileSync(join(pairMembers, ROLLBACK_PAIR_INDEX_FILE));
    const stagedIndexDigest = hashBytes(stagedIndexBytes);
    if (stagedIndexDigest !== expectation.indexDigest) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "the staged index does not match the digest retained outside the pair", {
        stageRoot,
        expected: expectation.indexDigest,
        actual: stagedIndexDigest,
      });
    }
    // And the staged members are measured against the staged index, so the stage is internally
    // whole on its own terms rather than by inheritance from the pair it came from.
    const stagedEntries = parseIndex(stagedIndexBytes.toString("utf8"), stageRoot);
    const stagedDigests = new Map(stagedEntries.map((entry) => [entry.path, entry.sha256]));
    for (const member of validated.manifest.inventory) {
      if (stagedDigests.get(member.path) !== hashFile(join(pairMembers, member.path))) {
        throw acpError(ReasonCode.INTERNAL_ERROR, "a staged member does not match the staged index", {
          stageRoot,
          member: member.path,
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



/**
 * A destination frozen on a held descriptor and an inode, not on a pathname.
 *
 * Verifying `dirname(dest)` and then writing to `dest` walks the directory twice. Renaming the
 * parent between the two, or replacing a component with a symlink, steers the second walk
 * somewhere the first never saw — and every pathname-based re-check agrees, because it walks the
 * new path too. So the parent is held open no-follow for the whole operation and its identity is
 * recorded; before each mutation the pathname is resolved again and required to still name that
 * exact object, and the leaf is required to still be the exact object planned.
 *
 * The remaining limit is stated rather than hidden: the copy itself still goes through the
 * pathname, because creating a file through a held descriptor would need a create-capable
 * `openat` on the primitive's surface and that surface is deliberately five operations wide. What
 * this closes is the steering *window*: a swap is detected immediately before and immediately
 * after each mutation and fails closed, rather than being installed silently.
 */
interface FrozenDestination {
  path: string;
  parent: RollbackParent;
  parentDev: bigint;
  parentIno: bigint;
  name: string;
  /** The leaf as it was at plan time, or null when it was absent. */
  identity: RollbackEntry | null;
}

const freezeDestination = (fs: RollbackFilesystem, path: string, what: string): FrozenDestination => {
  assertAbsolute(path, what);
  const parentPath = dirname(path);
  if (!existsSync(parentPath)) {
    throw acpError(ReasonCode.NOT_FOUND, `${what} has no directory to be installed into`, { path });
  }
  const parent = fs.openParent(parentPath);
  const name = basename(path);
  return { path, parent, parentDev: parent.dev, parentIno: parent.ino, name, identity: fs.stat(parent, name) };
};

/** Refuses unless the pathname still names the held parent and the leaf is still the same object. */
const assertDestinationIntact = (
  fs: RollbackFilesystem,
  destination: FrozenDestination,
  what: string,
): void => {
  const parentPath = dirname(destination.path);
  let live;
  try {
    // `bigint: true` because the default `stat` returns `dev`/`ino` as JavaScript numbers, which
    // are already collided above 53 bits — converting one to BigInt afterwards preserves the
    // collision rather than the identity.
    live = statSync(parentPath, { bigint: true });
  } catch {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} no longer has the directory it was planned in`, {
      path: destination.path,
    });
  }
  if (BigInt(live.dev) !== destination.parentDev || BigInt(live.ino) !== destination.parentIno) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} now resolves to a different directory than the one verified`, {
      path: destination.path,
      planned: { dev: String(destination.parentDev), ino: String(destination.parentIno) },
      found: { dev: String(live.dev), ino: String(live.ino) },
    });
  }
  const now = fs.stat(destination.parent, destination.name);
  const planned = destination.identity;
  if (planned === null) {
    if (now !== null) {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} was created by something else after it was planned`, {
        path: destination.path,
      });
    }
    return;
  }
  if (now === null || now.dev !== planned.dev || now.ino !== planned.ino || now.type !== planned.type) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} is no longer the object that was verified`, {
      path: destination.path,
      planned: { dev: String(planned.dev), ino: String(planned.ino), type: planned.type },
      found: now === null ? null : { dev: String(now.dev), ino: String(now.ino), type: now.type },
    });
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
  failAfter?: "recovery" | "runtime" | "plist" | "launcher" | "restoreHelper" | "database" | "cleanup";
  /**
   * Test-only seam, fired immediately before a step re-verifies its destination.
   *
   * The window this exists to measure cannot be reached from outside: it opens after the plan is
   * frozen and closes when the step runs. Without a way to act inside it, the re-verification
   * before each mutation would be code nothing can fail.
   */
  onStep?: (step: "runtime" | "plist" | "launcher" | "database") => void;
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

  const fs = RollbackFilesystem.load();
  try {
    // Every destination frozen on a held descriptor and an inode before the first mutation, so a
    // wrong type is a refusal rather than a discovery made halfway through replacing a
    // generation — and so a rename or symlink swap afterwards is detected instead of followed.
    const plan = {
      runtime: freezeDestination(fs, runtimeDestination, "the runtime install root"),
      plist: freezeDestination(fs, plistDestination, "the plist destination"),
      launcher: freezeDestination(fs, launcherDestination, "the launcher destination"),
      database: freezeDestination(fs, databaseDestination, "the database destination"),
    };
    if (plan.runtime.identity !== null && plan.runtime.identity.type !== "dir") {
      throw acpError(ReasonCode.STATE_PATH_INSECURE, "the runtime install root is not a direct directory", {
        path: runtimeDestination,
      });
    }
    for (const [what, frozen] of [
      ["the plist destination", plan.plist],
      ["the launcher destination", plan.launcher],
      ["the database destination", plan.database],
    ] as const) {
      if (frozen.identity !== null && frozen.identity.type !== "file") {
        throw acpError(ReasonCode.STATE_PATH_INSECURE, `${what} is not a regular, non-symlink file`, {
          path: frozen.path,
        });
      }
    }
    const intact = (what: string): void => {
      assertDestinationIntact(fs, plan.runtime, "the runtime install root");
      assertDestinationIntact(fs, plan.plist, "the plist destination");
      assertDestinationIntact(fs, plan.launcher, "the launcher destination");
      assertDestinationIntact(fs, plan.database, "the database destination");
      void what;
    };
    intact("before securing recovery");

    const recoveryRoot = join(staged.stageRoot, "recovery");
    mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
    chmodSync(recoveryRoot, 0o700);
    const hadRuntime = plan.runtime.identity !== null;
    const hadPlist = plan.plist.identity !== null;
    const hadLauncher = plan.launcher.identity !== null;
    const hadDatabase = plan.database.identity !== null;

    // The prior database is secured through the supported WAL-complete path, not copied. A file
    // copy of a live SQLite database is older than its last commit, so compensating from one
    // would put back a database that never existed — the same defect the sealed image avoids.
    const recoveryDatabase = join(recoveryRoot, `${basename(databaseDestination)}`);
    if (hadDatabase) captureRollbackPointSync(databaseDestination, recoveryDatabase);
    if (hadRuntime) copyPrivateTree(runtimeDestination, join(recoveryRoot, "runtime"));
    if (hadPlist) copyPrivateFile(plistDestination, join(recoveryRoot, "plist"));
    if (hadLauncher) copyPrivateFile(launcherDestination, join(recoveryRoot, "launcher"));

    /** Puts back every half of the previous generation, including its database. */
    const compensate = (): void => {
      if (hadRuntime) {
        rmSync(runtimeDestination, { recursive: true, force: true });
        copyPrivateTree(join(recoveryRoot, "runtime"), runtimeDestination);
      } else rmSync(runtimeDestination, { recursive: true, force: true });
      // Unlink first, always. `copyFileSync` onto an existing name *follows* a symbolic link, so
      // a compensation that copied straight over the destination would write the recovered plist
      // through whatever link had replaced it — measured: the attacker's file received the old
      // plist while the deployment kept the intruder. Removing the name first unlinks the link
      // itself and never the thing it points at.
      rmSync(plistDestination, { force: true });
      if (hadPlist) {
        copyFileSync(join(recoveryRoot, "plist"), plistDestination);
        chmodSync(plistDestination, PRIVATE_FILE_MODE);
      }
      rmSync(launcherDestination, { force: true });
      if (hadLauncher) {
        copyFileSync(join(recoveryRoot, "launcher"), launcherDestination);
        chmodSync(launcherDestination, 0o700);
      }
      // The database last, and only when this call actually replaced it: restoring an image over
      // a database nothing touched would be a mutation performed by the compensation itself.
      if (hadDatabase && databaseReplaced) {
        restoreDatabase(databaseDestination, recoveryDatabase);
      }
    };

    let databaseReplaced = false;
    try {
      if (options.failAfter === "recovery") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after recovery", {});
      }

      options.onStep?.("runtime");
      intact("before installing the runtime");
      rmSync(runtimeDestination, { recursive: true, force: true });
      copyPrivateTree(staged.runtimeRoot, runtimeDestination);
      if (options.failAfter === "runtime") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after runtime", {});
      }

      options.onStep?.("plist");
      assertDestinationIntact(fs, plan.plist, "the plist destination");
      rmSync(plistDestination, { force: true });
      copyFileSync(staged.plistPath, plistDestination);
      chmodSync(plistDestination, PRIVATE_FILE_MODE);
      if (options.failAfter === "plist") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after plist", {});
      }

      options.onStep?.("launcher");
      assertDestinationIntact(fs, plan.launcher, "the launcher destination");
      rmSync(launcherDestination, { force: true });
      copyFileSync(staged.launcherPath, launcherDestination);
      chmodSync(launcherDestination, 0o700);
      if (options.failAfter === "launcher") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after launcher", {});
      }

      // The sealed generation restores its own database: its state-admin, under its Node. Running
      // the current build's restore here would be the defect this pair exists to prevent, one
      // layer down — pair A's image installed by generation B's code.
      //
      // The *resolved* path, and this is not tidiness. A Node entrypoint decides whether it is the
      // program being run by comparing `import.meta.url` — which is always the real path — against
      // `process.argv[1]` as given. Hand it a path that traverses a symlink and the comparison
      // fails, the CLI's main guard never fires, and the process exits 0 having done nothing.
      // Measured: `/var/...` versus `/private/var/...` on macOS produced a rollback that reported
      // success and restored no database at all.
      options.onStep?.("database");
      assertDestinationIntact(fs, plan.database, "the database destination");
      const installedRuntime = realpathSync(runtimeDestination);
      const installedStateAdmin = join(installedRuntime, identity.runtime.stateAdmin);
      const installedNode = join(installedRuntime, identity.runtime.nodeExecutable);
      if (options.failAfter === "restoreHelper") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after restoreHelper", {});
      }
      databaseReplaced = true;
      execFileSync(
        installedNode,
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
      if (options.failAfter === "database") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after database", {});
      }

      if (options.failAfter === "cleanup") {
        throw acpError(ReasonCode.INTERNAL_ERROR, "injected failure after cleanup", {});
      }

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
  } finally {
    fs.dispose();
  }
};

/**
 * A repeated flag is refused rather than resolved.
 *
 * `indexOf` takes the first occurrence, so `--expect-database A ... --expect-database B` would
 * quietly use A and ignore B. On this command that is the difference between rolling back the
 * database an operator named and one they corrected themselves out of, and nothing would say so.
 */
/**
 * The whole rollback, under one authority, in one process.
 *
 * There is deliberately no way to hand a caller a stage path and let them apply it later. A stage
 * directory named on a command line is an unauthenticated mutation authority: whoever can name it
 * can install whatever is in it, and whatever wrote `stage.json` decides what a later `apply`
 * believes it is installing. So validate, copy, re-verify, install and the post-condition all
 * happen inside this call, and the stage is created and destroyed within it.
 *
 * The caller stops the service before and starts it after; that is the only seam, because
 * launchctl is theirs to drive.
 */
export const rollbackToSealedPair = (
  pairRoot: string,
  expectation: RollbackPairExpectation,
  stageParent: string,
  options: ApplyOptions = {},
): AppliedRollbackPair => {
  const staged = stageRollbackPair(pairRoot, expectation, stageParent);
  try {
    return applyRollbackPair(staged, options);
  } finally {
    rmSync(staged.stageRoot, { recursive: true, force: true });
  }
};

const argumentValue = (argv: readonly string[], flag: string): string | undefined => {
  const occurrences = argv.reduce((count, entry) => (entry === flag ? count + 1 : count), 0);
  if (occurrences > 1) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a flag was given more than once", { flag, occurrences });
  }
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  return argv[at + 1];
};

const USAGE = `rollback-pair — seal, validate and roll back one exact sealed pair

  rollback-pair seal --pairs-root DIR --database FILE \\
    --runtime-root DIR --entrypoint REL --state-admin REL \\
    --node-executable REL --node-version vX.Y.Z \\
    --install-runtime-root DIR --install-plist FILE --install-launcher FILE \\
    --working-directory DIR \\
    --service-label LABEL --service-generation NAME --plist FILE --launcher FILE

  rollback-pair validate|rollback --pair-root DIR --pair-id UUID \\
    --expected-index-digest sha256:HEX --expect-database FILE \\
    --expect-service-label LABEL --expect-working-directory DIR \\
    --expect-runtime-root DIR --expect-schema-version N \\
    --expect-service-generation NAME --expect-node-version vX.Y.Z \\
    [--stage-parent DIR, required by rollback]

seal states every identity rather than probing for it, so the same command seals the generation
being left and the one being moved to. It prints the pair id and SHA256(SHA256SUMS); retain both
OUTSIDE the pair, because a pair cannot prove its own index.

validate mutates nothing. rollback does the whole operation under one authority — validate, a
private verified copy of every member, install of the runtime closure, plist, launcher and
database together, and the post-condition — or puts the previous generation back. There is no way
to hand out a stage and apply it later: a stage path on a command line is a mutation authority
anyone who can name it holds.
`;

const REQUIRED_SEAL_FLAGS = [
  "--pairs-root",
  "--database",
  "--runtime-root",
  "--entrypoint",
  "--state-admin",
  "--node-executable",
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
  "--expect-runtime-root",
  "--expect-schema-version",
  "--expect-service-generation",
  "--expect-node-version",
] as const;

const expectationFrom = (supplied: Map<string, string>): RollbackPairExpectation => {
  const schemaVersion = Number(supplied.get("--expect-schema-version"));
  if (!Number.isInteger(schemaVersion)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "the expected schema version must be an integer", {
      value: supplied.get("--expect-schema-version"),
    });
  }
  return {
    pairId: supplied.get("--pair-id")!,
    indexDigest: supplied.get("--expected-index-digest")!,
    databaseTargetPath: supplied.get("--expect-database")!,
    serviceLabel: supplied.get("--expect-service-label")!,
    workingDirectory: supplied.get("--expect-working-directory")!,
    runtimeRoot: supplied.get("--expect-runtime-root")!,
    schemaVersion,
    serviceGeneration: supplied.get("--expect-service-generation")!,
    nodeVersion: supplied.get("--expect-node-version")!,
  };
};

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
      nodeExecutable: supplied.get("--node-executable")!,
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

  if (command === "validate" || command === "rollback") {
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
    const applied = rollbackToSealedPair(supplied.get("--pair-root")!, expectation, stageParent);
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
