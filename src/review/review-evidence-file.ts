import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";

import { sha256 } from "../core/digest.ts";
import { acpError, allow, deny, isAcpError, type Decision } from "../core/errors.ts";
import { BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES } from "../core/mcp-limits.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { RollbackFilesystem, type RollbackEntry, type RollbackParent } from "../db/fd-vfs.ts";
import { assertPrivatePath, ensurePrivateDirectory } from "../db/state-preflight.ts";

/**
 * GAP 2 — a STANDARD_WORK or CONTRACT_CHANGE run's review evidence bundle as a file, so a large bundle need not
 * pass through the CTO's MCP call. The server names the file itself, `<stateRoot>/review-evidence/<runId>/<sha256>`;
 * the caller names only the digest. `prepareReviewEvidenceFile` (`agentctl review-evidence prepare`) writes it there,
 * and `readReviewEvidenceFile` reads it for `review_evidence_stage`, which then checks the bytes exactly as it
 * checks an inline body.
 */
export const REVIEW_EVIDENCE_DIRECTORY = "review-evidence";
const MAX_BYTES = BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES;
/** The inline path's refusal text (review/standard-review-evidence.ts parseStandardBundle), so both inputs read alike. */
const OVERSIZE_MESSAGE = `review evidence bundle exceeds the ${MAX_BYTES}-byte UTF-8 staging limit`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIRECTORY_MODE = 0o700n;
const FILE_MODE = 0o600n;

/** Where a refusal happened: the state root, the evidence directory, the run's directory or the file. */
type Place = "stateRoot" | "review-evidence" | "run" | "file";
/** Test-only seam, fired after the directories are held, after the file is opened and checked, and after each read. */
export type ReviewEvidenceFileStep = "held" | "opened" | "read";

const refused = (reasonCode: ReasonCode, refusal: string, at: Place, message: string) =>
  acpError(reasonCode, message, { refusal, at });
const insecure = (refusal: string, at: Place, message: string) => refused(ReasonCode.STATE_PATH_INSECURE, refusal, at, message);

/** A name the server joins under a directory: one component, never `.` or `..`. */
const isComponent = (name: string): boolean =>
  name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !/[/\0]/.test(name);

const kindOf = (stat: BigIntStats): RollbackEntry["type"] =>
  (stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other");

const lstatOrNull = (path: string): BigIntStats | null => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
};

/** Owned by the user this process runs as, with exactly `mode`: what the preparation helper writes. */
const assertOwnedPrivately = (stat: BigIntStats, mode: bigint, at: Place): void => {
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== BigInt(uid)) throw insecure("OWNER", at, `review evidence ${at} is not owned by the user ACP runs as`);
  if ((stat.mode & 0o777n) !== mode) {
    throw insecure("MODE", at, `review evidence ${at} has mode ${(stat.mode & 0o777n).toString(8)}, expected ${mode.toString(8)}`);
  }
};

interface Held { handle: RollbackParent; path: string }

/** `fstatat(AT_SYMLINK_NOFOLLOW)` of `name` under the held directory; null when nothing is there. */
const entryIn = (fs: RollbackFilesystem, parent: Held, name: string, at: Place): RollbackEntry | null => {
  try {
    return fs.stat(parent.handle, name);
  } catch {
    throw insecure("UNHELD", at, `review evidence ${at} could not be inspected through its held directory`);
  }
};

/**
 * The directory at `path`, which `entry` says it is (seen through its held parent, or by `lstat` for the state
 * root): never a symbolic link, held open `O_DIRECTORY | O_NOFOLLOW`, and the very object `entry` saw, so a swap
 * between the look and the open is refused. Owner and mode are read from that same object.
 */
const holdDirectory = (fs: RollbackFilesystem, path: string, at: Place, entry: Pick<RollbackEntry, "type" | "dev" | "ino"> | null): Held => {
  if (entry === null) throw refused(ReasonCode.NOT_FOUND, "MISSING", at, `no review evidence ${at} directory; write the file with agentctl review-evidence prepare`);
  if (entry.type === "symlink") throw insecure("SYMLINK", at, `review evidence ${at} is a symbolic link`);
  if (entry.type !== "dir") throw insecure("NOT_DIRECTORY", at, `review evidence ${at} is not a directory`);
  let handle: RollbackParent;
  try {
    handle = fs.openParent(path);
  } catch {
    throw insecure("UNHELD", at, `review evidence ${at} could not be held open without following a link`);
  }
  const live = lstatOrNull(path);
  if (handle.dev !== entry.dev || handle.ino !== entry.ino || live === null || live.dev !== handle.dev || live.ino !== handle.ino) {
    throw insecure("SWAPPED", at, `review evidence ${at} changed while it was checked`);
  }
  assertOwnedPrivately(live, DIRECTORY_MODE, at);
  return { handle, path };
};

const holdChild = (fs: RollbackFilesystem, parent: Held, name: string, at: Place): Held =>
  holdDirectory(fs, join(parent.path, name), at, entryIn(fs, parent, name, at));

/**
 * The file `name` in the held run directory, read through one descriptor: it must be the object the held directory
 * names (no link, no other name, the user's own, 0600, within the staging limit), the read is bounded by that limit,
 * and the file must be unchanged and still under its name once the read ends.
 */
const readHeldFile = (fs: RollbackFilesystem, run: Held, name: string, onStep?: (step: ReviewEvidenceFileStep) => void): Buffer => {
  const entry = entryIn(fs, run, name, "file");
  if (entry === null) {
    throw refused(ReasonCode.NOT_FOUND, "MISSING", "file", "no review evidence file at review-evidence/<runId>/<expectedSha256> under the state root; write it with agentctl review-evidence prepare");
  }
  if (entry.type === "symlink") throw insecure("SYMLINK", "file", "review evidence file is a symbolic link");
  if (entry.type !== "file") throw insecure("NOT_REGULAR_FILE", "file", "review evidence file is not a regular file");
  if (entry.size > BigInt(MAX_BYTES)) throw refused(ReasonCode.INVALID_ARGUMENT, "OVERSIZE", "file", OVERSIZE_MESSAGE);
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO swapped in after the look cannot hold this synchronous open.
    fd = openSync(join(run.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw insecure("SWAPPED", "file", "review evidence file changed while it was checked");
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    // The path walk can be steered after the directories were held; the inode the held directory names cannot.
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || kindOf(opened) !== "file") {
      throw insecure("SWAPPED", "file", "review evidence file is not the file its held directory names");
    }
    assertOwnedPrivately(opened, FILE_MODE, "file");
    if (opened.nlink !== 1n) throw insecure("LINKED", "file", "review evidence file has another name");
    if (opened.size > BigInt(MAX_BYTES)) throw refused(ReasonCode.INVALID_ARGUMENT, "OVERSIZE", "file", OVERSIZE_MESSAGE);
    onStep?.("opened");
    // One byte past the limit, and never more: the bound is on the read itself.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
      onStep?.("read");
    }
    if (BigInt(total) !== opened.size) throw insecure("CHANGED_DURING_READ", "file", "review evidence file changed size while it was read");
    const named = entryIn(fs, run, name, "file");
    if (named === null || named.dev !== opened.dev || named.ino !== opened.ino) {
      throw insecure("REPLACED", "file", "review evidence file was replaced while it was read");
    }
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
        || after.ctimeNs !== opened.ctimeNs || after.nlink !== opened.nlink || after.mode !== opened.mode || after.uid !== opened.uid) {
      throw insecure("CHANGED_DURING_READ", "file", "review evidence file changed while it was read");
    }
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
};

/**
 * The exact bytes at `<stateRoot>/review-evidence/<runId>/<expectedSha256>`, or the refusal (`evidence.refusal` and
 * `evidence.at` say which check and where; no path is echoed). Each directory is held open no-follow and each child
 * is looked at through its held parent (`RollbackFilesystem`, the repository's fd primitive: Node has no `*at`
 * calls), so access is bound to the directories checked rather than to a path string. Content is not judged here.
 */
export const readReviewEvidenceFile = (
  stateRoot: string, runId: string, expectedSha256: string, onStep?: (step: ReviewEvidenceFileStep) => void,
): Decision<Buffer> => {
  if (!isComponent(runId) || !DIGEST.test(expectedSha256)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "review evidence file names a run id and a sha256:<64 lowercase hex> digest", { refusal: "NAME" });
  }
  let fs: RollbackFilesystem | null = null;
  try {
    fs = RollbackFilesystem.load();
    const root = holdDirectory(fs, stateRoot, "stateRoot", (() => {
      const stat = lstatOrNull(stateRoot);
      return stat === null ? null : { type: kindOf(stat), dev: stat.dev, ino: stat.ino };
    })());
    const evidence = holdChild(fs, root, REVIEW_EVIDENCE_DIRECTORY, "review-evidence");
    const run = holdChild(fs, evidence, runId, "run");
    onStep?.("held");
    return allow(ReasonCode.OK, readHeldFile(fs, run, expectedSha256, onStep));
  } catch (error) {
    if (isAcpError(error)) return deny(error.reasonCode, error.message, error.evidence);
    throw error;
  } finally {
    fs?.dispose();
  }
};

/** A bundle source file's bytes, read once and bounded by the staging limit. */
const readSource = (path: string): Buffer => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw acpError(ReasonCode.NOT_FOUND, "the bundle file cannot be opened", { code: (error as NodeJS.ErrnoException).code ?? null });
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw acpError(ReasonCode.INVALID_ARGUMENT, "the bundle file is not a regular file");
    if (stat.size > BigInt(MAX_BYTES)) throw acpError(ReasonCode.INVALID_ARGUMENT, OVERSIZE_MESSAGE, { refusal: "OVERSIZE" });
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
    }
    if (total > MAX_BYTES) throw acpError(ReasonCode.INVALID_ARGUMENT, OVERSIZE_MESSAGE, { refusal: "OVERSIZE" });
    return Buffer.from(buffer.subarray(0, total));
  } finally {
    closeSync(fd);
  }
};

/**
 * `agentctl review-evidence prepare <runId> <bundle-file>`: writes the bundle where `review_evidence_stage` reads it
 * with `evidenceFromFile`, and answers the `expectedSha256` to stage with. The state root must already exist and be
 * private; the evidence and run directories are created 0700 when absent (an existing one is checked, never
 * repaired); the file is written 0600 beside its final name and renamed onto it, so the name only ever holds a
 * whole file. Identical bytes already in place are left as they are. The written file is then read back through the
 * stage's own reader, so an answer here is a file the stage accepts. Nothing about the run or the bundle is judged.
 */
export const prepareReviewEvidenceFile = (
  stateRoot: string, runId: string, sourcePath: string,
): Decision<{ runId: string; expectedSha256: string; bytes: number }> => {
  try {
    if (!isComponent(runId)) return deny(ReasonCode.INVALID_ARGUMENT, "the run id must be a single path component", { refusal: "NAME" });
    const bytes = readSource(sourcePath);
    const expectedSha256 = sha256(bytes);
    const prepared = allow(ReasonCode.OK, { runId, expectedSha256, bytes: bytes.length });
    const existing = readReviewEvidenceFile(stateRoot, runId, expectedSha256);
    if (existing.allowed && existing.value.equals(bytes)) return prepared;
    assertPrivatePath(stateRoot, "directory");
    const runDirectory = join(stateRoot, REVIEW_EVIDENCE_DIRECTORY, runId);
    ensurePrivateDirectory(runDirectory);
    const temporary = join(runDirectory, `.${expectedSha256.slice("sha256:".length)}.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        fchmodSync(fd, 0o600);
        let written = 0;
        while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, join(runDirectory, expectedSha256));
    } finally {
      rmSync(temporary, { force: true });
    }
    const directory = openSync(runDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    const written = readReviewEvidenceFile(stateRoot, runId, expectedSha256);
    if (!written.allowed) return written as Decision<never>;
    if (!written.value.equals(bytes)) return deny(ReasonCode.CONFLICT, "the review evidence file changed after it was written", { refusal: "CHANGED_DURING_READ" });
    return prepared;
  } catch (error) {
    if (isAcpError(error)) return deny(error.reasonCode, error.message, error.evidence);
    throw error;
  }
};
