import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { COMMITLORE_BINARY_VARIABLE } from "./commitlore-pin.ts";

/**
 * #1268 — the CommitLore package a commit attempt runs, copied once into a private directory and run from
 * there.
 *
 * The pin names an entrypoint, not a package: the installer's wrapper (`# commitlore:wrapper:v1`) execs node
 * on `<package>/dist/commitlore.mjs`, and that bundle reads the rest of its package (its `package.json`, its
 * `spec/`) from beside it at run time. Checking the pin binds the wrapper's bytes, and nothing stops the
 * package behind it from changing between the checks and the commands. So an attempt resolves the package the
 * pinned entrypoint loads, copies what that package publishes — its `package.json` and the entries its
 * `files` field names — into an owner-only directory, and runs every check, reads the version it compares
 * with the newest release, and runs every command from that copy, with node, never through the wrapper. The
 * copy's digest is taken as it is written and asked again before each spawn: a copy that changed refuses.
 *
 * Its boundary: the copy is the package's published files as they were read, once. A package that was being
 * replaced while it was read is copied as the bytes read, which are then the bytes checked and the bytes run.
 */

/** The largest package copied, in bytes: CommitLore 1.7.5 publishes about 6 MiB. */
export const COMMITLORE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

export interface CommitLoreSnapshot {
  /** The private directory the package was copied into; the caller removes it (`disposeCommitLoreSnapshot`). */
  readonly root: string;
  /** The bundle to run with node, inside `root`. */
  readonly entry: string;
  /** The `version` the copied `package.json` states. */
  readonly version: string;
  /** `sha256:<hex>` over every copied file's relative path, mode and bytes. */
  readonly digest: string;
  /** Where the package was copied from, for evidence. */
  readonly source: string;
}

const refusal = (condition: string, message: string): Error => new Error(`${COMMITLORE_BINARY_VARIABLE} ${condition}: ${message}`);

const WRAPPER_MARKER = "# commitlore:wrapper:v1";
const WRAPPER_EXEC = /^exec "\$NODE" "(\/[^"\n]+)" "\$@"$/m;
const BUNDLE = join("dist", "commitlore.mjs");

/**
 * The package `pin` loads and the bundle it runs: an installer wrapper's `exec` target, or the bundle itself
 * when the pin is `dist/commitlore.mjs`. Anything else is no entrypoint this resolves, and refuses.
 */
export const commitlorePackageOf = (pin: string): { root: string; entry: string } => {
  const target = realpathSync(pin);
  let entry: string;
  if (target.endsWith(`${sep}${BUNDLE}`)) {
    entry = target;
  } else {
    const text = readFileSync(target, "utf8");
    const named = text.includes(WRAPPER_MARKER) ? WRAPPER_EXEC.exec(text)?.[1] : undefined;
    if (named === undefined || !isAbsolute(named) || !named.endsWith(`${sep}${BUNDLE}`)) {
      throw refusal("UNSUPPORTED_ENTRYPOINT", `${pin} is neither CommitLore's installer wrapper nor its ${BUNDLE}, so the package it runs cannot be named`);
    }
    entry = realpathSync(named);
  }
  return { root: dirname(dirname(entry)), entry };
};

interface Walked {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

/** Every regular file under `root`'s `name`, relative to `root`; a link or any other kind refuses. */
const walk = (root: string, name: string, budget: { left: number }): Walked[] => {
  const absolute = join(root, name);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw refusal("UNSUPPORTED_PACKAGE", `${name} in the CommitLore package is a link`);
  if (stat.isDirectory()) {
    return readdirSync(absolute).sort().flatMap((child) => walk(root, join(name, child), budget));
  }
  if (!stat.isFile()) throw refusal("UNSUPPORTED_PACKAGE", `${name} in the CommitLore package is not a regular file`);
  budget.left -= stat.size;
  if (budget.left < 0) throw refusal("UNSUPPORTED_PACKAGE", `the CommitLore package is larger than ${COMMITLORE_SNAPSHOT_MAX_BYTES} bytes`);
  return [{ path: name, mode: stat.mode & 0o111 ? 0o700 : 0o600, bytes: readFileSync(absolute) }];
};

const digestOf = (files: readonly Walked[]): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${file.mode.toString(8)}\0${file.bytes.length}\0`);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
};

/** The published names of the package at `root`: `package.json` and its `files` entries, each a plain relative name. */
const publishedNames = (root: string): { names: string[]; version: string } => {
  let manifest: { files?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: unknown; version?: unknown };
  } catch (error) {
    throw refusal("UNSUPPORTED_PACKAGE", `the CommitLore package's package.json could not be read (${(error as Error).message.slice(0, 200)})`);
  }
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0 || !files.every((name) => typeof name === "string" && name !== "" && !isAbsolute(name) && !name.split(/[\\/]/).includes(".."))) {
    throw refusal("UNSUPPORTED_PACKAGE", "the CommitLore package's package.json names no published files");
  }
  if (typeof manifest.version !== "string") throw refusal("UNSUPPORTED_PACKAGE", "the CommitLore package's package.json states no version");
  return { names: ["package.json", ...(files as string[])], version: manifest.version };
};

/**
 * Copies the package `pin` loads into a new owner-only directory under `parent` and returns it. The bytes
 * written are the bytes read and digested; the version is the copied `package.json`'s.
 */
export const snapshotCommitLorePackage = (pin: string, parent: string = tmpdir()): CommitLoreSnapshot => {
  const { root, entry } = commitlorePackageOf(pin);
  const { names, version } = publishedNames(root);
  const budget = { left: COMMITLORE_SNAPSHOT_MAX_BYTES };
  const files = names.flatMap((name) => walk(root, name, budget));
  const inside = relative(root, entry);
  if (!files.some((file) => file.path === inside)) {
    throw refusal("UNSUPPORTED_PACKAGE", `the bundle the entrypoint runs, ${inside}, is not among the package's published files`);
  }
  const copy = mkdtempSync(join(parent, "acp-commitlore-package-"));
  try {
    chmodSync(copy, 0o700);
    for (const file of files) {
      mkdirSync(dirname(join(copy, file.path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(copy, file.path), file.bytes, { mode: file.mode, flag: "wx" });
    }
    return { root: copy, entry: join(copy, inside), version, digest: digestOf(files), source: root };
  } catch (error) {
    rmSync(copy, { recursive: true, force: true });
    throw error;
  }
};

/** Rejects `REPLACED` unless the copy is still exactly what was written; nothing is run either way. */
export const assertCommitLoreSnapshotUnchanged = (snapshot: CommitLoreSnapshot): void => {
  let now: string;
  try {
    const names = readdirSync(snapshot.root).sort();
    now = digestOf(names.flatMap((name) => walk(snapshot.root, name, { left: COMMITLORE_SNAPSHOT_MAX_BYTES })));
  } catch (error) {
    throw refusal("REPLACED", `the CommitLore package copy can no longer be read as written (${(error as Error).message.slice(0, 200)})`);
  }
  if (now !== snapshot.digest) throw refusal("REPLACED", "the CommitLore package copy is no longer the bytes its checks ran");
};

export const disposeCommitLoreSnapshot = (snapshot: CommitLoreSnapshot): void => {
  rmSync(snapshot.root, { recursive: true, force: true });
};
