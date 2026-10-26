import {
  type Stats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { GIT_OUTPUT_MAX_BYTES } from "../git/git.ts";

/**
 * #1232 — files the CTO imports into a STANDARD_WORK task's write target.
 *
 * A worker writes only through its provider's patch tool inside the claimed checkout, so it cannot
 * add a font or an image, or reproduce a large generated file byte for byte. The task's recorded
 * write target may therefore carry `imports`: a manifest whose entries each name a path inside the
 * target's paths, the file's size and its sha256. The CTO stages the bytes in the task's staging
 * directory under the ACP state root, `<importRoot>/<runId>/<taskId>/<sha256 hex>`, so a source is
 * named by its digest and never by a host path.
 *
 * Before the task's worker is launched, the control plane reads every staged file once, checks its
 * size and every byte's sha256 against the manifest and every destination in the checkout, and only
 * then writes the bytes it read, create-only, through the Managed Write Guard. A missing, mismatched or
 * symlinked source, a path outside the target or a destination that is a symlink or already exists
 * refuses the whole import before anything is written. The files are committed with the worker's
 * change, and the success receipt binds the manifest.
 *
 * What review sees depends on the content (`classifyImport`). A file git reads as text is never bound
 * by its manifest: it stays in the candidate's patch and is reviewed like any other change, so a task's
 * text imports are bounded by what that patch can carry (`IMPORT_MAX_TEXT_BYTES`). A binary file may be
 * bound by its manifest only as non-executable data: executable or loadable formats and archives, and
 * binary bytes at a source, script or configuration path, are refused, and the reviewer reads the
 * detected type of every bound file.
 */

/** One imported file: where it lands in the repository, its size in bytes and the sha256 of its bytes. */
export interface TaskImport {
  path: string;
  size: number;
  /** `sha256:<64 lowercase hex>` of the file's bytes. */
  sha256: string;
}

/** The bytes of one import, read from its staging directory and verified against its entry. */
export interface StagedImport extends TaskImport {
  bytes: Buffer;
}

export const IMPORT_MAX_FILES = 100;
/**
 * 50 MiB, GitHub's warning size, and never more than the git wrapper can hand back whole: the freeze
 * reads each imported blob through it to bind the file by sha256 (`buildCandidateSnapshot`), and the
 * receipt check in review reads it again. A bound (binary data) import's patch is never materialised;
 * a text import's is, and `IMPORT_MAX_TEXT_BYTES` bounds that.
 */
export const IMPORT_MAX_FILE_BYTES = Math.min(50 * 1024 * 1024, GIT_OUTPUT_MAX_BYTES);
/** The bytes one task imports, held in memory once while they are verified and written. */
export const IMPORT_MAX_TOTAL_BYTES = 4 * IMPORT_MAX_FILE_BYTES;
/** The audit log keeps an unlisted string field only up to 200 characters, and an entry's path is one. */
const IMPORT_PATH_MAX_CHARS = 200;
/**
 * The most patch one new text file adds besides its lines: `diff --git a/<path> b/<path>`, the mode and
 * full-index lines, `--- /dev/null`, `+++ b/<path>`, the hunk header and a no-newline marker.
 */
const TEXT_PATCH_HEADER_BYTES = 3 * IMPORT_PATH_MAX_CHARS + 256;
/**
 * The text one task may import, all files together. A new text file of n bytes is at most 2n bytes of
 * patch (were every byte a newline, each would become `+\n`) plus its header, and the candidate's whole
 * patch is read through the git wrapper, which hands back at most `GIT_OUTPUT_MAX_BYTES`. One task's
 * text imports may take half of that; the other half is left to everything else the candidate changes.
 * Review carries any text the patch carries, chunked and range-split.
 */
export const IMPORT_MAX_TEXT_BYTES = Math.floor((GIT_OUTPUT_MAX_BYTES / 2 - IMPORT_MAX_FILES * TEXT_PATCH_HEADER_BYTES) / 2);

/**
 * Git's own text/binary decision on content (`buffer_is_binary` in git's xdiff-interface.c): a NUL byte
 * within the first 8000 bytes makes a blob binary. The freeze also asks git for its decision on each
 * path, attributes included (`binaryPaths`), before it binds anything.
 */
const GIT_BINARY_PROBE_BYTES = 8000;
export const gitReadsAsBinary = (bytes: Buffer): boolean => bytes.subarray(0, GIT_BINARY_PROBE_BYTES).includes(0);

interface Format {
  name: string;
  /** Every signature must match: `[offset, bytes]`. */
  signatures: ReadonlyArray<readonly [number, Buffer]>;
  /** Matched only in content git reads as binary (a text script's shebang is reviewed as text). */
  binaryOnly?: boolean;
}

const format = (name: string, ...signatures: Array<readonly [number, string | number[]]>): Format => ({
  name,
  signatures: signatures.map(([offset, bytes]) => [offset, typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes)] as const),
});

const matches = (bytes: Buffer, candidate: Format): boolean =>
  candidate.signatures.every(([offset, signature]) =>
    bytes.length >= offset + signature.length && bytes.subarray(offset, offset + signature.length).equals(signature));

/** Executable or loadable code, and archives that can carry it, by magic number: never imported. */
const REFUSED_FORMATS: readonly Format[] = [
  format("ELF executable or library", [0, [0x7f, 0x45, 0x4c, 0x46]]),
  ...[[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe]]
    .map((magic) => format("Mach-O executable or library", [0, magic])),
  format("Mach-O universal binary or Java class", [0, [0xca, 0xfe, 0xba, 0xbe]]),
  format("Mach-O universal binary", [0, [0xca, 0xfe, 0xba, 0xbf]]),
  format("Mach-O universal binary", [0, [0xbe, 0xba, 0xfe, 0xca]]),
  format("PE or DOS executable", [0, "MZ"]),
  format("WebAssembly module", [0, [0x00, 0x61, 0x73, 0x6d]]),
  { ...format("script with a shebang", [0, "#!"]), binaryOnly: true },
  format("Dalvik executable", [0, "dex\n"]),
  format("Lua bytecode", [0, [0x1b, 0x4c, 0x75, 0x61]]),
  ...["PK\x03\x04", "PK\x05\x06", "PK\x07\x08"].map((magic) => format("zip archive (JAR, APK and wheel included)", [0, magic])),
  format("gzip archive", [0, [0x1f, 0x8b]]),
  format("compress archive", [0, [0x1f, 0x9d]]),
  format("bzip2 archive", [0, "BZh"]),
  format("xz archive", [0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]]),
  format("zstd archive", [0, [0x28, 0xb5, 0x2f, 0xfd]]),
  format("7z archive", [0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]]),
  format("RAR archive", [0, "Rar!\x1a\x07"]),
  format("lzip archive", [0, "LZIP"]),
  format("LZ4 archive", [0, [0x04, 0x22, 0x4d, 0x18]]),
  format("cabinet archive", [0, "MSCF"]),
  format("ar archive (.deb and static libraries included)", [0, "!<arch>\n"]),
  format("xar archive", [0, "xar!"]),
  format("RPM package", [0, [0xed, 0xab, 0xee, 0xdb]]),
  ...["070707", "070701", "070702"].map((magic) => format("cpio archive", [0, magic])),
  format("cpio archive", [0, [0xc7, 0x71]]),
  format("cpio archive", [0, [0x71, 0xc7]]),
  format("tar archive", [257, "ustar"]),
];

/** Non-executable data formats a reviewer can name, by magic number; anything else is `unknown-binary`. */
const DATA_FORMATS: readonly Format[] = [
  format("PNG", [0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]),
  format("JPEG", [0, [0xff, 0xd8, 0xff]]),
  format("GIF", [0, "GIF87a"]),
  format("GIF", [0, "GIF89a"]),
  format("WebP", [0, "RIFF"], [8, "WEBP"]),
  format("WAV", [0, "RIFF"], [8, "WAVE"]),
  format("BMP", [0, "BM"]),
  format("ICO", [0, [0x00, 0x00, 0x01, 0x00]]),
  format("TIFF", [0, "II*\x00"]),
  format("TIFF", [0, "MM\x00*"]),
  format("font (WOFF2)", [0, "wOF2"]),
  format("font (WOFF)", [0, "wOFF"]),
  format("font (OpenType)", [0, "OTTO"]),
  format("font (TrueType)", [0, [0x00, 0x01, 0x00, 0x00]]),
  format("font (TrueType)", [0, "true"]),
  format("font (collection)", [0, "ttcf"]),
  format("PDF", [0, "%PDF-"]),
  format("ISO media (MP4, MOV, AVIF or HEIF)", [4, "ftyp"]),
  format("MP3", [0, "ID3"]),
  format("Ogg", [0, "OggS"]),
  format("FLAC", [0, "fLaC"]),
  format("MIDI", [0, "MThd"]),
  format("Photoshop document", [0, "8BPS"]),
  format("SQLite database", [0, "SQLite format 3\x00"]),
];

/**
 * Extensions and file names a toolchain loads as source, script or configuration. Binary bytes there
 * are refused: no reviewer can read them, and a loader may still run them (JavaScript allows a NUL in a
 * comment, so a script git reads as binary can still be loaded).
 */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "json5", "jsonc", "map", "vue", "svelte", "astro",
  "sh", "bash", "zsh", "fish", "ksh", "csh", "tcsh", "command", "ps1", "psm1", "psd1", "bat", "cmd", "vbs", "vba", "wsf",
  "py", "pyw", "pyi", "pyc", "pyo", "rb", "erb", "pl", "pm", "php", "phtml", "go", "rs", "java", "kt", "kts", "scala",
  "groovy", "gradle", "clj", "cljs", "cljc", "edn", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm", "swift",
  "cs", "csx", "fs", "fsx", "vb", "lua", "r", "jl", "dart", "ex", "exs", "erl", "hrl", "hs", "lhs", "ml", "mli", "elm",
  "nim", "zig", "sol", "sql", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties", "xml", "xsl", "xslt",
  "plist", "html", "htm", "xhtml", "css", "scss", "sass", "less", "md", "mdx", "txt", "rst", "lock", "tf", "tfvars",
  "hcl", "nix", "mk", "cmake", "service", "desktop", "npmrc", "yarnrc", "editorconfig", "gitattributes", "gitignore",
  "gitmodules", "dockerignore",
]);
const SOURCE_NAMES: ReadonlySet<string> = new Set([
  "makefile", "dockerfile", "containerfile", "gemfile", "rakefile", "procfile", "vagrantfile", "jenkinsfile", "brewfile",
  "podfile", "justfile", "build", "workspace",
]);

const isSourcePath = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return SOURCE_NAMES.has(name) || (dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1)));
};

/** How review can see one imported file, from its bytes and path. */
export type ImportContent =
  | { kind: "text" }
  | { kind: "data"; type: string }
  | { kind: "refused"; why: string };

/**
 * Text (git reads it as text) is reviewed as the patch it is; data is bound by its manifest and shown
 * as its detected type; anything else is refused. Executable or loadable formats and archives are
 * refused whatever git reads them as; binary bytes at a source, script or configuration path are refused.
 */
export const classifyImport = (path: string, bytes: Buffer): ImportContent => {
  const binary = gitReadsAsBinary(bytes);
  const refused = REFUSED_FORMATS.find((candidate) => (binary || candidate.binaryOnly !== true) && matches(bytes, candidate));
  if (refused !== undefined) return { kind: "refused", why: `${refused.name}: executable or loadable code, or an archive that can carry it` };
  if (!binary) return { kind: "text" };
  if (isSourcePath(path)) return { kind: "refused", why: "binary bytes at a source, script or configuration path, which no reviewer can read" };
  return { kind: "data", type: DATA_FORMATS.find((candidate) => matches(bytes, candidate))?.name ?? "unknown-binary" };
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;
/**
 * A path segment an import may use: ASCII letters, digits and `._@+-`. Nothing here is a glob, a
 * separator, a control character or a character a filesystem may normalise into another name.
 */
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
/** `.git`, in any case and with any trailing dots, names the git dir on a case-insensitive filesystem. */
const GIT_DIR_SEGMENT = /^\.git\.*$/i;
const RUN_OR_TASK_ID = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const insideAny = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => root === "." || path === root || path.startsWith(`${root}/`));

const isImportPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= IMPORT_PATH_MAX_CHARS &&
  path.split("/").every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== ".." && !GIT_DIR_SEGMENT.test(segment));

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * A declared import manifest, checked and sorted by path, or why it is refused: 1 to IMPORT_MAX_FILES
 * entries of exactly `{path, size, sha256}`; each path repository-relative in normal form, no `.git`
 * segment, inside one of the write target's `paths`; no path twice or below another; each size and
 * the total within their limits.
 */
export const parseImportManifest = (declared: unknown, paths: readonly string[]): Decision<TaskImport[]> => {
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > IMPORT_MAX_FILES) {
    return deny(ReasonCode.INVALID_ARGUMENT, `the write target's imports must list 1 to ${IMPORT_MAX_FILES} files`, {
      reason: "IMPORT_MANIFEST_INVALID",
      count: Array.isArray(declared) ? declared.length : null,
    });
  }
  const imports: TaskImport[] = [];
  const invalid: Array<string | number> = [];
  for (const [index, item] of declared.entries()) {
    const shaped = isRecord(item) && Object.keys(item).sort().join(",") === "path,sha256,size";
    if (
      !shaped ||
      !isImportPath(item["path"]) ||
      !Number.isSafeInteger(item["size"]) ||
      (item["size"] as number) < 0 ||
      (item["size"] as number) > IMPORT_MAX_FILE_BYTES ||
      typeof item["sha256"] !== "string" ||
      !DIGEST.test(item["sha256"])
    ) {
      invalid.push(isRecord(item) && typeof item["path"] === "string" && item["path"].length <= IMPORT_PATH_MAX_CHARS ? item["path"] : index);
      continue;
    }
    imports.push({ path: item["path"], size: item["size"] as number, sha256: item["sha256"] });
  }
  if (invalid.length > 0) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      `an import entry must be exactly {path, size, sha256}: a repository-relative path of [A-Za-z0-9._@+-] segments with no '.', '..' or .git segment, a size of at most ${IMPORT_MAX_FILE_BYTES} bytes and a sha256:<64 hex> digest`,
      { reason: "IMPORT_MANIFEST_INVALID", invalid: invalid.slice(0, 50) },
    );
  }
  imports.sort(byPath);
  const overlapping = imports
    .filter((entry, index) => imports.some((other, at) => at !== index && (other.path === entry.path || entry.path.startsWith(`${other.path}/`))))
    .map((entry) => entry.path);
  if (overlapping.length > 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "an import path is listed twice or lies below another import path", {
      reason: "IMPORT_MANIFEST_INVALID",
      overlapping: [...new Set(overlapping)].slice(0, 50),
    });
  }
  const outOfScope = imports.filter((entry) => !insideAny(entry.path, paths)).map((entry) => entry.path);
  if (outOfScope.length > 0) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "an import path lies outside the task's write-target paths", {
      reason: "IMPORT_OUT_OF_SCOPE",
      outOfScope: outOfScope.slice(0, 50),
      paths: [...paths],
    });
  }
  const total = imports.reduce((sum, entry) => sum + entry.size, 0);
  if (total > IMPORT_MAX_TOTAL_BYTES) {
    return deny(ReasonCode.INVALID_ARGUMENT, `a task imports at most ${IMPORT_MAX_TOTAL_BYTES} bytes`, { reason: "IMPORT_MANIFEST_INVALID", total });
  }
  return allow(ReasonCode.OK, imports);
};

/** The staging directory of one task, under the ACP-owned import root. */
export const importStagingDir = (root: string, runId: string, taskId: string): string => join(root, runId, taskId);

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
};

/** Why a staging directory is not one this daemon's user owns alone, or null when it is. */
const unownedDirectory = (stat: Stats): string | null => {
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (!stat.isDirectory()) return "not a directory";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "owned by another user";
  if ((stat.mode & 0o022) !== 0) return "writable by group or others";
  return null;
};

/** Reads one staged file without following a symlink or blocking on a fifo, and only up to its declared size. */
const readStaged = (path: string, size: number): { bytes: Buffer } | { problem: "missing" | "mismatch" | string } => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { problem: "missing" };
    return { problem: code === "ELOOP" ? "a symbolic link" : `unreadable (${code ?? "error"})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: "not a regular file" };
    if (stat.size !== size) return { problem: "mismatch" };
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) return { problem: "mismatch" };
      offset += read;
    }
    // Grown since the stat: not the declared size, so not the declared bytes.
    if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) return { problem: "mismatch" };
    return { bytes };
  } finally {
    closeSync(fd);
  }
};

/**
 * Every import's bytes, read once from the task's staging directory and verified against its entry,
 * or the refusal naming every file that is missing, insecure or not the declared bytes. The root, the
 * run's and the task's directories must be real directories this daemon's user owns and only it can
 * write; a staged file must be a regular file, not a symlink, named by the hex of its sha256.
 */
export const readStagedImports = (input: {
  root: string | null;
  runId: string;
  taskId: string;
  imports: readonly TaskImport[];
}): Decision<StagedImport[]> => {
  if (input.root === null) {
    return deny(ReasonCode.INVALID_ARGUMENT, "this control plane has no import staging root, so a task that declares imports is not run", {
      reason: "IMPORT_STAGING_UNCONFIGURED",
    });
  }
  if (!RUN_OR_TASK_ID.test(input.runId) || !RUN_OR_TASK_ID.test(input.taskId)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the run or task id cannot name a staging directory", { reason: "IMPORT_STAGING_INVALID" });
  }
  const stagingDir = importStagingDir(input.root, input.runId, input.taskId);
  for (const dir of [input.root, join(input.root, input.runId), stagingDir]) {
    const stat = lstatOrNull(dir);
    if (stat === null) {
      return deny(ReasonCode.EVIDENCE_MISSING, "the task's import staging directory does not exist; stage each file there under the hex of its sha256", {
        reason: "IMPORT_SOURCE_MISSING",
        stagingDir,
        missing: input.imports.map((entry) => entry.path).slice(0, 50),
      });
    }
    const problem = unownedDirectory(stat);
    if (problem !== null) {
      return deny(ReasonCode.STATE_PATH_INSECURE, `the import staging directory ${dir} is ${problem}`, {
        reason: "IMPORT_STAGING_INSECURE",
        stagingDir,
        problem,
      });
    }
  }
  const staged: StagedImport[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  const insecure: Array<{ path: string; problem: string }> = [];
  for (const entry of input.imports) {
    const read = readStaged(join(stagingDir, entry.sha256.slice("sha256:".length)), entry.size);
    if ("problem" in read) {
      if (read.problem === "missing") missing.push(entry.path);
      else if (read.problem === "mismatch") mismatched.push(entry.path);
      else insecure.push({ path: entry.path, problem: read.problem });
      continue;
    }
    if (sha256(read.bytes) !== entry.sha256) {
      mismatched.push(entry.path);
      continue;
    }
    staged.push({ ...entry, bytes: read.bytes });
  }
  const named = { stagingDir, missing: missing.slice(0, 50), mismatched: mismatched.slice(0, 50), insecure: insecure.slice(0, 50) };
  const refused: Array<{ path: string; why: string }> = [];
  const text: StagedImport[] = [];
  for (const entry of staged) {
    const content = classifyImport(entry.path, entry.bytes);
    if (content.kind === "refused") refused.push({ path: entry.path, why: content.why });
    else if (content.kind === "text") text.push(entry);
  }
  const textBytes = text.reduce((sum, entry) => sum + entry.size, 0);
  if (insecure.length > 0) {
    return deny(ReasonCode.STATE_PATH_INSECURE, "a staged import is not a regular file in its staging directory; nothing is imported", {
      reason: "IMPORT_SOURCE_INSECURE",
      ...named,
    });
  }
  if (mismatched.length > 0) {
    return deny(ReasonCode.IMPORT_DIGEST_MISMATCH, "a staged import is not the size or sha256 its manifest entry declares; nothing is imported", {
      reason: "IMPORT_DIGEST_MISMATCH",
      ...named,
    });
  }
  if (missing.length > 0) {
    return deny(ReasonCode.EVIDENCE_MISSING, "a manifest entry has no staged file; nothing is imported", { reason: "IMPORT_SOURCE_MISSING", ...named });
  }
  if (refused.length > 0) {
    return deny(ReasonCode.IMPORT_CONTENT_REFUSED, "an import is executable or loadable code, an archive, or binary bytes at a source path; nothing is imported", {
      reason: "IMPORT_NOT_REVIEWABLE",
      refused: refused.slice(0, 50),
    });
  }
  if (textBytes > IMPORT_MAX_TEXT_BYTES) {
    return deny(ReasonCode.IMPORT_CONTENT_REFUSED, `a task imports at most ${IMPORT_MAX_TEXT_BYTES} bytes of text, which review reads as patch; nothing is imported`, {
      reason: "IMPORT_TEXT_TOO_LARGE",
      textBytes,
      limit: IMPORT_MAX_TEXT_BYTES,
      text: text.map((entry) => entry.path).slice(0, 50),
    });
  }
  return allow(ReasonCode.OK, staged);
};

/**
 * Whether every import can be created in the checkout: no directory on its path is a symlink or a
 * file, and nothing stands at the path itself. An import never replaces a file.
 */
export const checkImportDestinations = (worktree: string, imports: readonly TaskImport[]): Decision<void> => {
  const symlinked: string[] = [];
  const occupied: string[] = [];
  for (const entry of imports) {
    let cursor = worktree;
    let blocked = false;
    for (const segment of entry.path.split("/").slice(0, -1)) {
      cursor = join(cursor, segment);
      const stat = lstatOrNull(cursor);
      if (stat === null) break;
      if (stat.isSymbolicLink()) {
        symlinked.push(entry.path);
        blocked = true;
        break;
      }
      if (!stat.isDirectory()) {
        occupied.push(entry.path);
        blocked = true;
        break;
      }
    }
    if (!blocked && lstatOrNull(join(worktree, entry.path)) !== null) occupied.push(entry.path);
  }
  if (symlinked.length > 0) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "a directory on an import's path is a symbolic link; nothing is imported", {
      reason: "IMPORT_DESTINATION_SYMLINK",
      symlinked: symlinked.slice(0, 50),
    });
  }
  if (occupied.length > 0) {
    return deny(ReasonCode.CONFLICT, "something already stands at an import's path or one of its directories; an import only adds files", {
      reason: "IMPORT_DESTINATION_EXISTS",
      occupied: occupied.slice(0, 50),
    });
  }
  return allow(ReasonCode.OK, undefined);
};

/** What one import attempt created, each with the identity it was created with. */
export interface WrittenImports {
  files: Array<{ path: string; dev: number; ino: number }>;
  directories: Array<{ path: string; dev: number; ino: number }>;
}

/**
 * Creates every import in the checkout: missing directories one at a time, each file create-only
 * (`O_EXCL`, never through a symlink) with exactly the verified bytes. Stops at the first error and
 * returns what it created, so the caller can take back exactly that.
 */
export const writeImports = (worktree: string, staged: readonly StagedImport[]): { written: WrittenImports; error: string | null } => {
  const written: WrittenImports = { files: [], directories: [] };
  try {
    for (const entry of staged) {
      const segments = entry.path.split("/");
      let relative = "";
      for (const segment of segments.slice(0, -1)) {
        relative = relative ? `${relative}/${segment}` : segment;
        const full = join(worktree, relative);
        const stat = lstatOrNull(full);
        if (stat === null) {
          mkdirSync(full, { mode: 0o755 });
          const made = lstatSync(full);
          written.directories.push({ path: relative, dev: made.dev, ino: made.ino });
        } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`${relative} is not a directory`);
        }
      }
      const fd = openSync(join(worktree, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        const made = fstatSync(fd);
        written.files.push({ path: entry.path, dev: made.dev, ino: made.ino });
        let offset = 0;
        while (offset < entry.bytes.length) offset += writeSync(fd, entry.bytes, offset, entry.bytes.length - offset, offset);
      } finally {
        closeSync(fd);
      }
    }
    return { written, error: null };
  } catch (error) {
    return { written, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
};

/**
 * Takes back what one import attempt created: a file or directory is removed only while it is still
 * the one this attempt created (same device and inode), and a directory only when empty. Returns the
 * paths left in place.
 */
export const undoImports = (worktree: string, written: WrittenImports): string[] => {
  const left: string[] = [];
  const same = (path: string, created: { dev: number; ino: number }, kind: "file" | "directory"): boolean => {
    const stat = lstatOrNull(join(worktree, path));
    return stat !== null && stat.dev === created.dev && stat.ino === created.ino && (kind === "file" ? stat.isFile() : stat.isDirectory());
  };
  for (const file of [...written.files].reverse()) {
    try {
      if (same(file.path, file, "file")) unlinkSync(join(worktree, file.path));
      else if (lstatOrNull(join(worktree, file.path)) !== null) left.push(file.path);
    } catch {
      left.push(file.path);
    }
  }
  for (const directory of [...written.directories].reverse()) {
    try {
      if (same(directory.path, directory, "directory")) rmdirSync(join(worktree, directory.path));
      else if (lstatOrNull(join(worktree, directory.path)) !== null) left.push(directory.path);
    } catch {
      left.push(directory.path);
    }
  }
  return left;
};

/**
 * The imports a scan of the checkout against its base (`scanAgainst` entries) does not show as
 * imported: each must be a regular, non-executable file with its declared sha256. After the import
 * this names one git does not see (an ignored path, say); after a turn, one the worker changed.
 */
export const importsNotHeld = (
  imports: readonly TaskImport[],
  entries: readonly { path: string; mode: string | null; sha256: string | null }[],
): string[] => {
  const scanned = new Map(entries.map((entry) => [entry.path, entry]));
  return imports
    .filter((entry) => scanned.get(entry.path)?.mode !== "100644" || scanned.get(entry.path)?.sha256 !== entry.sha256)
    .map((entry) => entry.path);
};
