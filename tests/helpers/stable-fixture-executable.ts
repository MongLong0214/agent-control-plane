import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * macOS's Gatekeeper provenance table (syspolicyd) records one row per new executable inode
 * exec'd, and that table is SIP-protected: it cannot be pruned. A test fixture that writes a
 * fresh script into a fresh temp directory on every run mints a fresh inode every run, so a
 * suite run thousands of times grows that table without bound. Measured on one development host:
 * 92% of a week's rows came from this repository's tests — the `ps` shim
 * (`…/T/acp-ps-shim-XXXXXX/ps`) and the `acp-launchd-home-XXXX/fake-bin/*` fixtures among them —
 * and syspolicyd sat at 100% CPU, stalling every exec of a new file.
 *
 * Warn: test fixtures must not create per-run executables. Route every shim through
 * `stableFixtureExecutable` (one name), `stableFixtureBinDir` (a directory of several) or
 * `stableFixtureLink` (one name at a path the test needs) so the
 * same logical shim reuses the same inode across runs instead of minting a new one each time. A
 * script's content must be constant per logical shim — any per-run value (an observed-file path,
 * a counter file, a fixture directory) belongs in an env var the script reads, never embedded in
 * the script text, or every run mints a distinct inode again.
 */

const FIXTURE_BIN_ROOT = join(tmpdir(), "acp-fixture-bin");
/** The one mode an entry is published with, and so the one an existing entry is reused at. */
const PUBLISHED_MODE = 0o700;

const digestOf = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);

/**
 * Writes `script` to `<tmpdir>/acp-fixture-bin/<sha256(name + "\0" + script)[0:16]>/<name>` once
 * and returns that path. A later call with the same name and script returns the same path and
 * the same inode without touching it.
 *
 * `root` exists so this helper's own tests can tamper with a cache they own rather than with the
 * shared one other tests are executing from; every fixture leaves it at the default.
 */
export const stableFixtureExecutable = (name: string, script: string, root: string = FIXTURE_BIN_ROOT): string => {
  const dir = join(root, digestOf(`${name}\0${script}`));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return writeStableEntry(dir, name, script);
};

/**
 * The directory form, for a fixture that needs several names resolvable from one PATH entry
 * (e.g. `launchctl`, `security`, `node-wrapper` beside each other) rather than one shim per PATH
 * entry. Keyed by the hash of the whole `name -> script` set, so the same set reuses the same
 * directory and a test with a different set never collides with or overwrites it.
 */
export const stableFixtureBinDir = (
  entries: Readonly<Record<string, string>>,
  root: string = FIXTURE_BIN_ROOT,
): string => {
  const names = Object.keys(entries).sort();
  const setDigest = digestOf(["set", ...names.map((name) => `${name}\0${entries[name]}`)].join("\0"));
  const dir = join(root, setDigest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of names) writeStableEntry(dir, name, entries[name]!);
  return dir;
};

/**
 * For a fixture its test needs at one particular path rather than anywhere on PATH — a provider CLI
 * pinned as the path the shell answered with, a versioned file an updater deletes, an interpreter a
 * sealed closure copies. `path` becomes a hard link to the cached entry for `script` (cached under
 * `basename(path)`): a regular file at that path with its own name and its own realpath, sharing the
 * cached inode, so executing it executes the warm entry rather than a new one.
 *
 * A hard link rather than a symlink because the rows this serves tell the two apart. A symlink's
 * realpath is the cache: a pin taken at the canonical target would then survive a row written to
 * show that the updater deletes that target, and a row that searches output for a sentinel carried
 * in the target's own name would search for a name the canonical path no longer has. The cache and
 * every `path` must share a filesystem, which they do under `tmpdir()`.
 *
 * Warn: the inode is shared. Writing to or chmod'ing `path` writes the cached entry, which the next
 * reuse then refuses. Removing `path` removes only the name.
 */
export const stableFixtureLink = (path: string, script: string, root: string = FIXTURE_BIN_ROOT): string => {
  linkSync(stableFixtureExecutable(basename(path), script, root), path);
  return path;
};

/**
 * Create-if-absent, and never a rewrite. The script goes into a randomly named temp file (mode
 * 0o700) first and is then published with `link`, which fails with `EEXIST` instead of replacing
 * what is there: `rename` would publish atomically too, but it replaces an existing target, so two
 * workers racing on a cold path would each mint an inode. The temp name is unlinked either way.
 *
 * An existing target is verified, not trusted: it must be a regular file (not a link planted at a
 * predictable path) with exactly the mode this helper publishes, holding exactly `script`. Anything
 * else throws, because the hash this path is keyed by makes a mismatch either a collision or
 * something other than this helper writing there. The mode is part of that because a shim that
 * cannot run is worse than a missing one: its caller puts the directory first on PATH, the shell
 * skips a file it cannot execute, and the lookup reaches the real command — the test then measures
 * the host while reading as a measurement of its shim.
 */
const writeStableEntry = (dir: string, name: string, script: string): string => {
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    verifyExisting(target, script);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileSync(tmp, script, { mode: PUBLISHED_MODE, flag: "wx" });
  try {
    chmodSync(tmp, PUBLISHED_MODE); // writeFileSync's mode is subject to umask
    try {
      linkSync(tmp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyExisting(target, script); // a concurrent writer published first
    }
  } finally {
    unlinkSync(tmp);
  }
  return target;
};

const verifyExisting = (target: string, script: string): void => {
  const stat = lstatSync(target); // ENOENT propagates to the caller as "absent"
  if (!stat.isFile()) {
    throw new Error(`stable fixture executable ${target} exists but is not a regular file`);
  }
  const mode = stat.mode & 0o7777;
  if (mode !== PUBLISHED_MODE) {
    throw new Error(
      `stable fixture executable ${target} has mode ${mode.toString(8)}, not the ` +
        `${PUBLISHED_MODE.toString(8)} this helper publishes, so it is not reused: a cached shim that ` +
        "cannot run lets PATH lookup reach the real command instead. It is not modified.",
    );
  }
  if (readFileSync(target, "utf8") !== script) {
    throw new Error(
      `stable fixture executable ${target} already holds different content than the script ` +
        "supplied for it; the path is keyed by that content's hash, so this is a collision or " +
        "a writer other than this helper. It is not rewritten.",
    );
  }
};
