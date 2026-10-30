import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type FileHandle, chmod, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { COMMITLORE_BINARY_VARIABLE, COMMITLORE_PIN_MAX_BYTES, type CommitLorePinIdentity } from "./commitlore-pin.ts";

/**
 * #1268 — the CommitLore package a CommitLore run executes, copied once into a private directory and run from
 * there: a worker's or a bootstrap's commit attempt, and the bootstrap observation alike.
 *
 * The pin names an entrypoint, not a package: the installer's wrapper (`# commitlore:wrapper:v1`) execs node
 * on `<package>/dist/commitlore.mjs`, and that bundle reads the rest of its package (its `package.json`, its
 * `spec/`) from beside it at run time; it imports nothing but node's own modules. Checking the pin binds the
 * wrapper's bytes, and nothing stops the package behind it from changing between the checks and the commands.
 * So a run reads the pin's bytes (once its identity is bound, `bindCommitLorePin`), resolves the package that
 * entrypoint loads, copies what that package publishes — its `package.json` and the entries its `files` field
 * names — into an owner-only directory, and runs every check, reads the version it compares with the newest
 * release, and runs every command from that copy, with node, never through the wrapper. The copy's digest is
 * taken as it is written and asked again before each spawn: a copy that changed refuses.
 *
 * Every read is bounded as the pin's identity reading is (review S16-R2-01): a descriptor opened without
 * following a link and without blocking, a regular file only, a size cap, asynchronous, under a deadline.
 *
 * Its boundary: the copy is the package's published files as they were read, once. A package that was being
 * replaced while it was read is copied as the bytes read, which are then the bytes checked and the bytes run.
 */

/** The largest package copied, in bytes: CommitLore 1.7.5 publishes about 6 MiB. */
export const COMMITLORE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

/** How long one copy, or one re-check of a copy, may take: a bound of its own, as the pin's identity reading has. */
export const COMMITLORE_SNAPSHOT_TIMEOUT_MS = 30_000;

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

type Step = <T>(value: T) => T;

/** A deadline: `step` throws once it has passed, so a reading stops at its next step. */
const deadlineOf = (timeoutMs: number, what: string): Step => {
  const at = Date.now() + timeoutMs;
  return <T>(value: T): T => {
    if (Date.now() > at) throw refusal("UNREADABLE", `${what} was still being read at its ${timeoutMs} ms deadline`);
    return value;
  };
};

/** One regular file's bytes, read through a descriptor opened without following a link and without blocking. */
const readRegular = async (path: string, cap: number, step: Step): Promise<{ bytes: Buffer; executable: boolean }> => {
  let handle: FileHandle | null = null;
  try {
    handle = step(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const stat = step(await handle.stat());
    if (!stat.isFile()) throw refusal("UNSUPPORTED_PACKAGE", `${path} is not a regular file`);
    if (stat.size > cap) throw refusal("UNSUPPORTED_PACKAGE", `${path} is ${stat.size} bytes, more than the ${cap} bytes read`);
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = step(await handle.read(bytes, position, stat.size - position, position));
      if (bytesRead === 0) throw refusal("UNSUPPORTED_PACKAGE", `${path} changed while it was read`);
      position += bytesRead;
    }
    return { bytes, executable: (stat.mode & 0o111) !== 0 };
  } finally {
    await handle?.close();
  }
};

/**
 * The package the pin `bound` names loads, and the bundle it runs: an installer wrapper's `exec` target, or the
 * bundle itself when the pin is `dist/commitlore.mjs`. The pin's bytes are read once more and must be the
 * bytes its identity was bound to. Anything else is no entrypoint this resolves, and refuses.
 */
export const commitlorePackageOf = async (
  pin: string,
  bound: CommitLorePinIdentity,
  timeoutMs: number = COMMITLORE_SNAPSHOT_TIMEOUT_MS,
): Promise<{ root: string; entry: string }> => {
  const step = deadlineOf(timeoutMs, pin);
  let entry: string;
  if (bound.target.endsWith(`${sep}${BUNDLE}`)) {
    entry = bound.target;
  } else {
    const { bytes } = await readRegular(bound.target, COMMITLORE_PIN_MAX_BYTES, step);
    if (createHash("sha256").update(bytes).digest("hex") !== bound.sha256) {
      throw refusal("REPLACED", `${pin} is no longer the file its identity was bound to`);
    }
    const text = bytes.toString("utf8");
    const named = text.includes(WRAPPER_MARKER) ? WRAPPER_EXEC.exec(text)?.[1] : undefined;
    if (named === undefined || !isAbsolute(named) || !named.endsWith(`${sep}${BUNDLE}`)) {
      throw refusal("UNSUPPORTED_ENTRYPOINT", `${pin} is neither CommitLore's installer wrapper nor its ${BUNDLE}, so the package it runs cannot be named`);
    }
    entry = named;
  }
  return { root: dirname(dirname(entry)), entry };
};

interface Walked {
  readonly path: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

/** Every regular file under `root`'s `name`, relative to `root`; a link or any other kind refuses. */
const walk = async (root: string, name: string, budget: { left: number }, step: Step): Promise<Walked[]> => {
  const absolute = join(root, name);
  const stat = step(await lstat(absolute));
  if (stat.isSymbolicLink()) throw refusal("UNSUPPORTED_PACKAGE", `${name} in the CommitLore package is a link`);
  if (stat.isDirectory()) {
    const walked: Walked[] = [];
    for (const child of step(await readdir(absolute)).sort()) walked.push(...(await walk(root, join(name, child), budget, step)));
    return walked;
  }
  if (!stat.isFile()) throw refusal("UNSUPPORTED_PACKAGE", `${name} in the CommitLore package is not a regular file`);
  const { bytes, executable } = await readRegular(absolute, budget.left, step);
  budget.left -= bytes.length;
  return [{ path: name, mode: executable ? 0o700 : 0o600, bytes }];
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
const publishedNames = async (root: string, step: Step): Promise<{ names: string[]; version: string }> => {
  let manifest: { files?: unknown; version?: unknown };
  try {
    manifest = JSON.parse((await readRegular(join(root, "package.json"), 1024 * 1024, step)).bytes.toString("utf8")) as { files?: unknown; version?: unknown };
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
 * Copies the package the pin (whose identity is `bound`) loads into a new owner-only directory under `parent`
 * and returns it. The bytes written are the bytes read and digested; the version is the copied `package.json`'s.
 */
export const snapshotCommitLorePackage = async (
  pin: string,
  bound: CommitLorePinIdentity,
  parent: string = tmpdir(),
  timeoutMs: number = COMMITLORE_SNAPSHOT_TIMEOUT_MS,
): Promise<CommitLoreSnapshot> => {
  const step = deadlineOf(timeoutMs, `the CommitLore package ${pin} runs`);
  const { root, entry } = await commitlorePackageOf(pin, bound, timeoutMs);
  const { names, version } = await publishedNames(root, step);
  const budget = { left: COMMITLORE_SNAPSHOT_MAX_BYTES };
  const files: Walked[] = [];
  for (const name of names) files.push(...(await walk(root, name, budget, step)));
  const inside = relative(root, entry);
  if (!files.some((file) => file.path === inside)) {
    throw refusal("UNSUPPORTED_PACKAGE", `the bundle the entrypoint runs, ${inside}, is not among the package's published files`);
  }
  const copy = await mkdtemp(join(parent, "acp-commitlore-package-"));
  try {
    await chmod(copy, 0o700);
    for (const file of files) {
      await mkdir(dirname(join(copy, file.path)), { recursive: true, mode: 0o700 });
      await writeFile(join(copy, file.path), file.bytes, { mode: file.mode, flag: "wx" });
    }
    return { root: copy, entry: join(copy, inside), version, digest: digestOf(files), source: root };
  } catch (error) {
    await rm(copy, { recursive: true, force: true });
    throw error;
  }
};

/** Rejects `REPLACED` unless the copy is still exactly what was written; nothing is run either way. */
export const assertCommitLoreSnapshotUnchanged = async (
  snapshot: CommitLoreSnapshot,
  timeoutMs: number = COMMITLORE_SNAPSHOT_TIMEOUT_MS,
): Promise<void> => {
  const step = deadlineOf(timeoutMs, "the CommitLore package copy");
  let now: string;
  try {
    const files: Walked[] = [];
    for (const name of step(await readdir(snapshot.root)).sort()) {
      files.push(...(await walk(snapshot.root, name, { left: COMMITLORE_SNAPSHOT_MAX_BYTES }, step)));
    }
    now = digestOf(files);
  } catch (error) {
    throw refusal("REPLACED", `the CommitLore package copy can no longer be read as written (${(error as Error).message.slice(0, 200)})`);
  }
  if (now !== snapshot.digest) throw refusal("REPLACED", "the CommitLore package copy is no longer the bytes its checks ran");
};

export const disposeCommitLoreSnapshot = (snapshot: CommitLoreSnapshot): void => {
  rmSync(snapshot.root, { recursive: true, force: true });
};

/**
 * #1268 — the empty tree of each object format: the attribute source a CommitLore child's git reads, so that no
 * `.gitattributes` in the work tree selects a diff, textconv, filter or merge driver.
 */
export const EMPTY_TREE = Object.freeze({
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const);

const execFileAsync = promisify(execFile);

/** How long each of the attribute-source probe's git calls may take. */
const ATTR_SOURCE_PROBE_TIMEOUT_MS = 10_000;

/**
 * #1268 — whether the git a CommitLore child would run (the first `git` on `path`) honours `GIT_ATTR_SOURCE`, so
 * the empty attribute source takes effect. Asked of git itself in a scratch repository whose work tree names a
 * diff driver: a git that still reports the driver ignored the variable, and a CommitLore run on it refuses
 * rather than runs unprotected. Null when it honours it; otherwise the reason.
 */
export const gitIgnoresAttrSource = async (path: string): Promise<string | null> => {
  const scratch = mkdtempSync(join(tmpdir(), "acp-attr-source-probe-"));
  try {
    const env = { PATH: path, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
    await execFileAsync("git", ["init", "-q", scratch], { env, timeout: ATTR_SOURCE_PROBE_TIMEOUT_MS });
    writeFileSync(join(scratch, ".gitattributes"), "probe diff=acpprobe\n");
    writeFileSync(join(scratch, "probe"), "probe\n");
    const answer = (
      await execFileAsync("git", ["check-attr", "diff", "--", "probe"], {
        cwd: scratch,
        env: { ...env, GIT_ATTR_SOURCE: EMPTY_TREE.sha1 },
        encoding: "utf8",
        timeout: ATTR_SOURCE_PROBE_TIMEOUT_MS,
      })
    ).stdout.trim();
    return answer === "probe: diff: unspecified"
      ? null
      : `the git CommitLore would run does not honour GIT_ATTR_SOURCE (it answered ${JSON.stringify(answer.slice(0, 120))}), so a work tree's .gitattributes could select a program`;
  } catch (error) {
    return `the git CommitLore would run could not be asked whether it honours GIT_ATTR_SOURCE (${(error as Error).message.split("\n", 1)[0]})`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
