import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * `stableFixtureExecutable` (one name) or `stableFixtureBinDir` (a directory of several) so the
 * same logical shim reuses the same inode across runs instead of minting a new one each time. A
 * script's content must be constant per logical shim — any per-run value (an observed-file path,
 * a counter file, a fixture directory) belongs in an env var the script reads, never embedded in
 * the script text, or every run mints a distinct inode again.
 */

const FIXTURE_BIN_ROOT = join(tmpdir(), "acp-fixture-bin");

const digestOf = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);

/**
 * Writes `script` to `<tmpdir>/acp-fixture-bin/<sha256(name + "\0" + script)[0:16]>/<name>` once
 * and returns that path. A later call with the same name and script returns the same path and
 * the same inode without touching it.
 */
export const stableFixtureExecutable = (name: string, script: string): string => {
  const dir = join(FIXTURE_BIN_ROOT, digestOf(`${name}\0${script}`));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return writeStableEntry(dir, name, script);
};

/**
 * The directory form, for a fixture that needs several names resolvable from one PATH entry
 * (e.g. `launchctl`, `security`, `node-wrapper` beside each other) rather than one shim per PATH
 * entry. Keyed by the hash of the whole `name -> script` set, so the same set reuses the same
 * directory and a test with a different set never collides with or overwrites it.
 */
export const stableFixtureBinDir = (entries: Readonly<Record<string, string>>): string => {
  const names = Object.keys(entries).sort();
  const setDigest = digestOf(["set", ...names.map((name) => `${name}\0${entries[name]}`)].join("\0"));
  const dir = join(FIXTURE_BIN_ROOT, setDigest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of names) writeStableEntry(dir, name, entries[name]!);
  return dir;
};

/**
 * Create-if-absent, and never a rewrite. The script goes into a randomly named temp file (mode
 * 0o700) first and is then published with `link`, which fails with `EEXIST` instead of replacing
 * what is there: `rename` would publish atomically too, but it replaces an existing target, so two
 * workers racing on a cold path would each mint an inode. The temp name is unlinked either way.
 *
 * An existing target is verified, not trusted: it must be a regular file (not a link planted at a
 * predictable path) holding exactly `script`. Anything else throws, because the hash this path is
 * keyed by makes a mismatch either a collision or something other than this helper writing there.
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
  writeFileSync(tmp, script, { mode: 0o700, flag: "wx" });
  try {
    chmodSync(tmp, 0o700); // writeFileSync's mode is subject to umask
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
  if (readFileSync(target, "utf8") !== script) {
    throw new Error(
      `stable fixture executable ${target} already holds different content than the script ` +
        "supplied for it; the path is keyed by that content's hash, so this is a collision or " +
        "a writer other than this helper. It is not rewritten.",
    );
  }
};
