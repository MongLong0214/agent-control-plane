/**
 * One run of an area-based audit script (`scripts/production-review.mjs`,
 * `scripts/grok-review.mjs`): the commit it reviewed, the directory it wrote, and what each area's
 * reviewer actually did.
 *
 * Both scripts used to point their reviewer at the live checkout and write into a fixed directory.
 * Three things followed from that (#1189):
 *
 *   * the reviewer read whatever the working tree held while it ran, including other agents'
 *     unfinished edits, so no report could say which code it was about;
 *   * a child that failed left the previous run's `<area>.json` in place, and the script read it
 *     back as this run's verdict;
 *   * a summary built from the directory counted areas this run never selected, from whatever
 *     revision last wrote them.
 *
 * So a run now does four things in order, and refuses before the first reviewer starts when any of
 * them cannot be done:
 *
 *   1. **Pin a commit.** `--rev=<ref>` (default `HEAD`) is resolved to a commit and its tree. An
 *      unknown ref is refused. When the commit is the working tree's own HEAD and the tree holds
 *      tracked or untracked changes anywhere (ignored files aside), the run is refused too:
 *      reviewing HEAD would leave that work out, and calling the result "a review of the current
 *      work" would be false. `--allow-dirty` reviews HEAD anyway and records that the uncommitted
 *      changes were not reviewed.
 *   2. **Read a separate checkout.** The reviewer's working directory is a disposable
 *      `git worktree add --detach` of that commit under the system temporary directory, with hooks
 *      disabled, compared byte for byte with the commit's blobs before any reviewer starts. A
 *      checkout that differs — a smudge filter or an eol attribute rewrote it — is refused. The
 *      user's working tree, index and branch are never reset or written; cleanup removes only
 *      that checkout.
 *   3. **Write a new directory.** Every run creates its own output directory and refuses one that
 *      already exists, so no file in it can predate the run.
 *   4. **Attribute every result.** `manifest.json` names the run, the exact revision and tree, the
 *      selected areas, the reviewer CLI and model (or that the model is UNKNOWN), and each area's
 *      execution result and artifacts with their digests. A report is read once, and its verdict,
 *      finding count and digest all come from those bytes. `summary.json` is a view of the
 *      per-area reports on disk, restricted to the ones this manifest attributes and only while
 *      their bytes still match what was recorded.
 *
 * Two outcomes are reported separately and never folded into each other: whether each reviewer
 * *ran* (`execution`) and what it *found* (`verdict`). A child that failed, timed out, was
 * interrupted or produced an unreadable report has no verdict — whatever file it left is renamed
 * `<area>.json.unconsumed` so no reader of `<area>.json` takes it for a report. The process exit
 * status describes execution only: 0 when every selected area returned a well-formed report, 1
 * when any did not, 2 when the run was refused before it started, 130 when it was interrupted.
 * None of those, and no verdict, is a PR review or a merge approval.
 *
 * Limit: a process killed with SIGKILL cannot clean up. Its temporary checkout stays under the
 * system temporary directory and `git worktree list` shows it until it is removed with
 * `git worktree remove --force <path>`.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

const EXIT = Object.freeze({ COMPLETE: 0, INCOMPLETE: 1, REFUSED: 2, INTERRUPTED: 130 });

/** A run that must not start. Raised only before the output directory exists. */
class Refusal extends Error {}

const VERDICTS = ["PASS", "REVISE", "BLOCK"];
const DEFAULT_AREA_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;
const GIT_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 10_000;

const NOT_AN_APPROVAL =
  "A diagnostic run. `execution` says whether each reviewer ran to a well-formed report; " +
  "`findingsVerdict` says what the reports found. Neither is a PR review, neither counts toward " +
  "or around a frontier review's attempt limit, and neither is a merge approval.";

/**
 * Git and the reviewer CLIs run with the repository named by `-C`/`cwd` only. An inherited
 * `GIT_DIR` (a hook, an editor integration) would otherwise point every one of these calls at
 * some other repository while the manifest named this one.
 */
const GIT_LOCATION_VARIABLES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
]);
const childEnvironment = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARIABLES.has(name)));

const messageOf = (error) => {
  const stderr = error?.stderr?.toString?.().trim();
  return stderr || (error instanceof Error ? error.message : String(error));
};

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Writes through a temporary name and returns the exact bytes written. */
const writeJson = (path, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
  return bytes;
};

/** `lstat`, so a dangling symbolic link or a FIFO still counts as something being there. */
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * One read of a regular file through one descriptor: `{ bytes }` or `{ problem }`. A symbolic
 * link, FIFO or anything else that could hand a second reader different bytes is refused rather
 * than read; `O_NONBLOCK` keeps a FIFO from holding this process until something writes to it.
 */
const readRegularFile = (path) => {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") return { problem: "missing" };
    if (error?.code === "ELOOP") return { problem: "a symbolic link, not a regular file" };
    return { problem: messageOf(error) };
  }
  try {
    if (!fstatSync(fd).isFile()) return { problem: "not a regular file" };
    return { bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
};

const tildify = (path) => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

const shown = (repoRoot, path) => {
  const inside = relative(repoRoot, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : tildify(path);
};

// ---------------------------------------------------------------------------------------------
// Arguments

/**
 * An option this script does not know is refused rather than ignored. `--ref=HEAD~1` for
 * `--rev=HEAD~1` used to run a full review of HEAD and say nothing about it.
 */
const parseArguments = (argv, areaKeys, { modelSelectable }) => {
  const options = { out: undefined, rev: "HEAD", allowDirty: false, areaTimeoutMs: DEFAULT_AREA_TIMEOUT_MS, model: undefined };
  const seen = new Set();
  const areas = [];
  const valueOf = (name, value) => {
    if (value === undefined || value === "") throw new Refusal(`${name}= needs a value`);
    return value;
  };
  for (const argument of argv) {
    if (!argument.startsWith("--")) {
      if (!areaKeys.includes(argument)) {
        throw new Refusal(`unknown area: ${argument} (areas: ${areaKeys.join(", ")})`);
      }
      if (areas.includes(argument)) throw new Refusal(`area named twice: ${argument}`);
      areas.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const value = equals === -1 ? undefined : argument.slice(equals + 1);
    if (seen.has(name)) throw new Refusal(`${name} given twice`);
    seen.add(name);
    switch (name) {
      case "--out":
        options.out = valueOf(name, value);
        break;
      case "--rev":
        options.rev = valueOf(name, value);
        break;
      case "--allow-dirty":
        if (value !== undefined) throw new Refusal("--allow-dirty takes no value");
        options.allowDirty = true;
        break;
      case "--area-timeout-ms": {
        const milliseconds = Number(valueOf(name, value));
        if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
          throw new Refusal(`--area-timeout-ms must be a positive integer, not ${JSON.stringify(value)}`);
        }
        options.areaTimeoutMs = milliseconds;
        break;
      }
      case "--model":
        if (modelSelectable) {
          options.model = valueOf(name, value);
          break;
        }
      // falls through: this script's model is pinned
      default:
        throw new Refusal(
          `unknown option: ${name} (accepted: --rev=<ref>, --out=<new directory>, --allow-dirty, --area-timeout-ms=<n>` +
            `${modelSelectable ? ", --model=<id>" : ""})`,
        );
    }
  }
  return { ...options, areas: areas.length > 0 ? areas : [...areaKeys] };
};

// ---------------------------------------------------------------------------------------------
// The revision

/** `null` only for git's own "no such commit" answer; a git that could not answer is not a no. */
const commitNamedBy = (repoRoot, ref) => {
  try {
    return git(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch (error) {
    if (error?.status === 1 && !error.stderr?.toString().trim()) return null;
    throw new Refusal(`git could not say whether ${ref} names a commit: ${messageOf(error)}`);
  }
};

const pinRevision = (repoRoot, { rev, allowDirty }) => {
  if (rev.startsWith("-")) throw new Refusal(`refusing ref ${JSON.stringify(rev)}: a ref does not start with "-"`);
  const head = commitNamedBy(repoRoot, "HEAD");
  if (head === null) throw new Refusal("HEAD names no commit here, so there is no revision to pin");
  const commit = commitNamedBy(repoRoot, rev);
  if (commit === null) throw new Refusal(`unknown ref: ${rev} does not name a commit in this repository`);
  const tree = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]).trim();

  // `--no-optional-locks`: asking whether the tree is dirty must not refresh the user's index.
  const entries = git(repoRoot, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .split("\0")
    .filter(Boolean);
  const dirty = entries.length > 0;
  if (dirty && commit === head && !allowDirty) {
    const sample = entries.slice(0, 5).map((entry) => JSON.stringify(entry)).join(", ");
    throw new Refusal(
      `the working tree has uncommitted changes (${entries.length} status entr${entries.length === 1 ? "y" : "ies"}: ` +
        `${sample}${entries.length > 5 ? ", ..." : ""}) and the requested revision is its HEAD ${commit.slice(0, 12)}. ` +
        "A review of that commit would not read them, and reporting it as a review of the current work would be false. " +
        "Commit the work and review that commit, or pass --allow-dirty to review HEAD and record that the uncommitted changes were not reviewed.",
    );
  }
  return {
    requestedRef: rev,
    revision: { commit, tree },
    workingTree: { head, dirty, dirtyEntries: entries.length, uncommittedWorkReviewed: false },
  };
};

// ---------------------------------------------------------------------------------------------
// The output directory

const newRunId = () =>
  `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(4).toString("hex")}`;

const createOutputDirectory = (repoRoot, { out, tool, runId }) => {
  const dir =
    out === undefined ? join(repoRoot, "evidence", "local", "audit-runs", `${tool}-${runId}`) : resolve(repoRoot, out);
  const refusal = () =>
    new Refusal(
      `output directory ${shown(repoRoot, dir)} already exists. Every run writes a new directory, so that ` +
        "nothing a previous run left there can be read as this run's result; name a new one.",
    );
  if (existsSync(dir)) throw refusal();
  try {
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir); // not recursive: two runs racing for one name cannot both get it
  } catch (error) {
    if (error?.code === "EEXIST") throw refusal();
    throw new Refusal(`cannot create output directory ${shown(repoRoot, dir)}: ${messageOf(error)}`);
  }
  return dir;
};

// ---------------------------------------------------------------------------------------------
// The reviewer CLI

const executableOnPath = (name) => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
};

/** Best effort: a CLI with no `--version` is still identified by its path. */
const versionOf = (path) => {
  try {
    const text = execFileSync(path, ["--version"], {
      encoding: "utf8",
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: VERSION_TIMEOUT_MS,
    });
    return text.trim().split("\n")[0]?.slice(0, 200) || null;
  } catch {
    return null;
  }
};

const identify = (reviewer) => {
  const path = executableOnPath(reviewer.cli);
  if (path === null) throw new Refusal(`${reviewer.cli} is not on PATH, so no reviewer can run`);
  return { ...reviewer, path: tildify(path), version: versionOf(path) };
};

// ---------------------------------------------------------------------------------------------
// The disposable checkout

/** Git's object id for `bytes` as a blob, in the repository's own hash (the commit id's length says which). */
const blobId = (commit, bytes) =>
  createHash(commit.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * Where the checkout's bytes differ from the pinned commit's blobs, compared byte for byte.
 *
 * `git status` is not this question. A smudge filter, an `eol` attribute or `ident` rewrites the
 * file as it is checked out while the index still names the committed blob, and whether status
 * notices depends on its stat cache; measured, a repository-local smudge filter made the reviewer
 * read `NOT IN PINNED COMMIT` where the commit holds `pinned v1`, and the run reported PASS. So each
 * tracked path is hashed here as raw bytes, with no filter, and compared with the tree entry.
 * Gitlinks are skipped: a worktree does not check out submodules. `extraFiles` also reports files
 * the commit does not have; after a run that is off, because a reviewer CLI may leave a cache.
 */
const checkoutDifferences = (dir, commit, { extraFiles }) => {
  const expected = new Map();
  for (const entry of git(dir, ["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    expected.set(entry.slice(tab + 1), { mode, type, oid });
  }
  const differences = [];
  for (const [path, entry] of expected) {
    if (entry.type !== "blob") continue;
    const full = join(dir, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      differences.push(`${path}: missing`);
      continue;
    }
    if (entry.mode === "120000") {
      if (!stat.isSymbolicLink()) differences.push(`${path}: not the symbolic link the commit holds`);
      else if (blobId(commit, readlinkSync(full, { encoding: "buffer" })) !== entry.oid) differences.push(`${path}: link target differs from the commit`);
    } else if (!stat.isFile()) {
      differences.push(`${path}: not a regular file`);
    } else if (blobId(commit, readFileSync(full)) !== entry.oid) {
      differences.push(`${path}: bytes differ from the commit`);
    }
  }
  if (extraFiles) {
    const walk = (relativeDir) => {
      for (const dirent of readdirSync(join(dir, relativeDir), { withFileTypes: true })) {
        const path = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
        if (path === ".git") continue; // the linked worktree's pointer to its git directory
        if (dirent.isDirectory()) walk(path);
        else if (!expected.has(path)) differences.push(`${path}: not in the commit`);
      }
    };
    walk("");
  }
  return differences;
};

const describeDifferences = (differences) =>
  `${differences.slice(0, 5).map((difference) => JSON.stringify(difference)).join(", ")}${differences.length > 5 ? `, and ${differences.length - 5} more` : ""}`;

const createCheckout = (repoRoot, revision) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "acp-audit-")));
  const dir = join(scratch, "checkout");
  const noHooks = join(scratch, "no-hooks");
  mkdirSync(noHooks);
  const checkout = { scratch, dir };
  try {
    git(repoRoot, ["-c", `core.hooksPath=${noHooks}`, "worktree", "add", "--detach", "--quiet", dir, revision.commit]);
    const [commit, tree] = git(dir, ["rev-parse", "HEAD", "HEAD^{tree}"]).trim().split("\n");
    if (commit !== revision.commit || tree !== revision.tree) {
      throw new Refusal(`the disposable checkout holds ${commit}/${tree}, not the pinned ${revision.commit}/${revision.tree}`);
    }
    const differences = checkoutDifferences(dir, revision.commit, { extraFiles: true });
    if (differences.length > 0) {
      throw new Refusal(
        `the disposable checkout of ${revision.commit.slice(0, 12)} does not hold that commit's bytes ` +
          `(${differences.length} path(s): ${describeDifferences(differences)}). Something in this repository's ` +
          "checkout configuration (a smudge filter, an eol or ident attribute) changed what a reviewer would read, " +
          `so no review of it would be a review of ${revision.commit.slice(0, 12)}. No reviewer was started.`,
      );
    }
    return checkout;
  } catch (error) {
    removeCheckout(repoRoot, checkout);
    if (error instanceof Refusal) throw error;
    throw new Refusal(`could not prepare a disposable checkout of ${revision.commit.slice(0, 12)}: ${messageOf(error)}`);
  }
};

/** Removes this run's checkout and its own temporary directory, and nothing else. */
const removeCheckout = (repoRoot, checkout) => {
  let error = null;
  if (existsSync(checkout.dir)) {
    try {
      git(repoRoot, ["worktree", "remove", "--force", checkout.dir]);
    } catch (failure) {
      error = `git worktree remove failed: ${messageOf(failure)}`;
    }
  }
  rmSync(checkout.scratch, { recursive: true, force: true });
  return { removed: !existsSync(checkout.dir), ...(error === null ? {} : { removeError: error }) };
};

// ---------------------------------------------------------------------------------------------
// Children

const liveChildren = new Set();
let interruptedBy = null;

/**
 * Each reviewer leads its own process group, so a terminal's Ctrl-C reaches this process only and
 * the stop is deliberate: every live group is signalled and the run is recorded as INTERRUPTED,
 * instead of dying with the previous run's files as the only record.
 */
const installInterruptHandlers = () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (interruptedBy !== null) return;
      interruptedBy = signal;
      process.stderr.write(`\n${signal}: stopping the reviewers; this run is recorded as INTERRUPTED\n`);
      for (const child of liveChildren) child.stop();
    });
  }
};

/**
 * Spawns one reviewer with a time bound and an output cap, and reaps its whole process group when
 * either is exceeded or the run is interrupted. Never rejects: every way the child can end is a
 * field on the result.
 */
const runChild = (file, args, { cwd, timeoutMs }) =>
  new Promise((settle) => {
    const startedAt = new Date();
    const out = [];
    const err = [];
    let bytes = 0;
    const state = { timedOut: false, interrupted: false, overflowed: false, spawnError: null };
    let killTimer = null;
    let settled = false;

    let child;
    try {
      child = spawn(file, args, { cwd, env: childEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      settle({ ...state, spawnError: messageOf(error), code: null, signal: null, stdout: "", stderr: "", startedAt, endedAt: new Date() });
      return;
    }

    const signalGroup = (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // ESRCH: the group is already gone
      }
    };
    const stop = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const handle = {
      stop: () => {
        state.interrupted = true;
        stop();
      },
    };
    liveChildren.add(handle);
    if (interruptedBy !== null) handle.stop();

    const collect = (into) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CHILD_OUTPUT_BYTES) {
        if (!state.overflowed) {
          state.overflowed = true;
          stop();
        }
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => {
      state.timedOut = true;
      stop();
    }, timeoutMs);

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (state.timedOut || state.interrupted || state.overflowed) signalGroup("SIGKILL");
      liveChildren.delete(handle);
      settle({
        ...state,
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        startedAt,
        endedAt: new Date(),
      });
    };
    child.on("error", (error) => {
      state.spawnError = messageOf(error);
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });

const executionOf = (child) => {
  if (child.interrupted) return "INTERRUPTED";
  if (child.timedOut) return "TIMED_OUT";
  if (child.spawnError !== null || child.overflowed || child.code !== 0) return "FAILED";
  return "COMPLETED";
};

const whyNotCompleted = (child, timeoutMs) => {
  if (child.interrupted) return `interrupted by ${interruptedBy ?? "a signal"}`;
  if (child.timedOut) return `no answer within ${timeoutMs}ms; the reviewer's process group was stopped`;
  if (child.spawnError !== null) return `could not start: ${child.spawnError}`;
  if (child.overflowed) return `output exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes and was cut off`;
  return `exited with ${child.code === null ? `signal ${child.signal}` : `status ${child.code}`}`;
};

// ---------------------------------------------------------------------------------------------
// One area

const reportProblem = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "the report is not a JSON object";
  if (!VERDICTS.includes(value.verdict)) return `verdict ${JSON.stringify(value.verdict)} is not one of ${VERDICTS.join(", ")}`;
  for (const field of ["filesExamined", "findings", "omittedItems"]) {
    if (!Array.isArray(value[field])) return `${field} is not an array`;
  }
  return null;
};

/**
 * Validation, verdict, finding count and digest all come from one byte sequence, captured once.
 * A report that is read twice — once to validate, once to digest — can be two different reports:
 * measured, a BLOCK with one finding was validated, another invocation's PASS was digested, and
 * the manifest and the summary disagreed while the run exited 0.
 */
const fromBytes = (bytes, reportFile) => {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { report: "UNPARSABLE", reason: `${reportFile} is not JSON (truncated or partial): ${messageOf(error)}` };
  }
  const problem = reportProblem(value);
  return problem === null ? { report: "VALID", value, bytes } : { report: "INVALID", reason: problem };
};

/** A completed child's report: `{ report: "VALID", value, bytes }`, or a report state and a reason. */
const consume = (candidate, reportPath, reportFile) => {
  if (candidate?.kind === "file") {
    const read = readRegularFile(reportPath);
    if (read.problem === "missing") return { report: "MISSING", reason: `the reviewer exited 0 without writing ${reportFile}` };
    if (read.problem !== undefined) return { report: "INVALID", reason: `${reportFile} is ${read.problem}` };
    return fromBytes(read.bytes, reportFile);
  }
  if (candidate?.kind === "value") {
    const consumed = fromBytes(Buffer.from(`${JSON.stringify(candidate.value, null, 2)}\n`), reportFile);
    if (consumed.report !== "VALID") return consumed;
    try {
      // Exclusive: if anything is at this path, this run did not put it there.
      writeFileSync(reportPath, consumed.bytes, { flag: "wx" });
    } catch (error) {
      return { report: "INVALID", reason: `could not write ${reportFile} as this run's own file: ${messageOf(error)}` };
    }
    return consumed;
  }
  return {
    report: candidate?.kind === "invalid" ? "INVALID" : "UNPARSABLE",
    reason: candidate?.reason ?? "the reviewer returned no report",
  };
};

const quarantine = (path, suffix) => {
  if (!present(path)) return null;
  const moved = `${path}.${suffix}`;
  renameSync(path, moved);
  return moved;
};

const digestOf = (outDir, name) => {
  const read = readRegularFile(join(outDir, name));
  if (read.problem !== undefined) return { name, sha256: null, bytes: null, problem: read.problem };
  return { name, sha256: sha256(read.bytes), bytes: read.bytes.length };
};

/**
 * `reviewArea` starts the reviewer and says where its report is: `{ kind: "file" }` when the CLI
 * wrote `ctx.reportPath` itself, `{ kind: "value", value }` when the script extracted it, or
 * `{ kind: "unparsable" | "invalid", reason }`. The verdict is read only when the child completed.
 */
const executeArea = async (key, area, ctx, reviewArea) => {
  const reportFile = `${key}.json`;
  const reportPath = join(ctx.outDir, reportFile);
  const notes = [];
  // The directory is new, so this can only be something written during this run by someone else.
  if (quarantine(reportPath, "preexisting") !== null) notes.push(`${reportFile} existed before its reviewer started; kept as ${reportFile}.preexisting`);

  let outcome;
  try {
    outcome = await reviewArea(key, area, { ...ctx, reportPath, runChild: (file, args) => runChild(file, args, { cwd: ctx.checkoutDir, timeoutMs: ctx.timeoutMs }) });
  } catch (error) {
    const now = new Date();
    outcome = { child: { spawnError: messageOf(error), timedOut: false, interrupted: false, overflowed: false, code: null, signal: null, stdout: "", stderr: "", startedAt: now, endedAt: now }, candidate: null };
  }
  const { child, candidate, reportedModel = null } = outcome;
  const artifacts = [...(outcome.artifacts ?? [])];
  writeFileSync(join(ctx.outDir, `${key}.log`), `${child.stdout}\n--- stderr ---\n${child.stderr}`);
  artifacts.push(`${key}.log`);

  const record = {
    execution: executionOf(child),
    exitCode: child.code,
    signal: child.signal,
    startedAt: child.startedAt.toISOString(),
    endedAt: child.endedAt.toISOString(),
    seconds: Math.round((child.endedAt.getTime() - child.startedAt.getTime()) / 1000),
    reportedModel,
    report: "NOT_CONSUMED",
    reportFile: null,
    verdict: null,
    findings: null,
  };
  let reportDigest = null;

  if (record.execution === "COMPLETED") {
    const consumed = consume(candidate, reportPath, reportFile);
    record.report = consumed.report;
    if (consumed.report === "VALID") {
      Object.assign(record, { reportFile, verdict: consumed.value.verdict, findings: consumed.value.findings.length });
      reportDigest = { name: reportFile, sha256: sha256(consumed.bytes), bytes: consumed.bytes.length };
    } else {
      notes.push(consumed.reason);
    }
  } else {
    notes.push(whyNotCompleted(child, ctx.timeoutMs));
  }

  if (record.report !== "VALID" && quarantine(reportPath, "unconsumed") !== null) {
    artifacts.push(`${reportFile}.unconsumed`);
  }
  // The report's digest is of the bytes that were validated, never of a later read of the path.
  record.artifacts = [
    ...artifacts.filter((name) => present(join(ctx.outDir, name))).map((name) => digestOf(ctx.outDir, name)),
    ...(reportDigest === null ? [] : [reportDigest]),
  ];
  if (notes.length > 0) record.notes = notes;
  return record;
};

// ---------------------------------------------------------------------------------------------
// The summary

/**
 * A view of the per-area reports on disk — but only of the reports this run's manifest attributes
 * to itself, and only while each one's bytes still match the digest recorded when its reviewer
 * finished. An unselected area is NOT_RUN whatever file exists for it; a report that changed
 * afterwards is STALE; anything without a well-formed report is ERROR. None of them is PASS.
 */
/**
 * The model is identified only when this run selected one explicitly and no area's CLI reported
 * a different one. Otherwise it is UNKNOWN, said so in plain words, and never filled with a
 * description of where the model might have come from.
 */
const modelIdentityOf = (reviewer, results) => {
  if (reviewer.model === null) {
    return { modelIdentity: "UNKNOWN", modelNote: "no model was selected, so the CLI used one this run cannot see" };
  }
  const others = [...new Set(Object.values(results).map((record) => record.reportedModel).filter((model) => typeof model === "string" && model !== reviewer.model))];
  if (others.length > 0) {
    return { modelIdentity: "UNKNOWN", modelNote: `${reviewer.model} was selected but the CLI reported ${others.join(", ")}` };
  }
  return { modelIdentity: "ESTABLISHED" };
};

const summarize = ({ tool, manifest, outDir, areaKeys }) => {
  const results = areaKeys.map((key) => {
    if (!manifest.selectedAreas.includes(key)) {
      return { key, selected: false, result: "NOT_RUN", execution: "NOT_RUN", report: null, verdict: null, findings: null };
    }
    const record = manifest.results[key];
    if (record === undefined) {
      return { key, selected: true, result: "NOT_RUN", execution: "NOT_RUN", report: null, verdict: null, findings: null, reason: "the run stopped before this area started" };
    }
    const base = { key, selected: true, execution: record.execution, seconds: record.seconds };
    if (record.report !== "VALID") {
      return { ...base, result: "ERROR", report: record.report, verdict: null, findings: null, reason: (record.notes ?? []).join("; ") };
    }
    const recorded = record.artifacts.find((artifact) => artifact.name === record.reportFile);
    const read = readRegularFile(join(outDir, record.reportFile));
    if (read.problem !== undefined || recorded === undefined || sha256(read.bytes) !== recorded.sha256) {
      return { ...base, result: "STALE", report: "STALE", verdict: null, findings: null, reason: `${record.reportFile} is not the report this run recorded for ${key}` };
    }
    // Same bytes as were validated, so the same answer; checked anyway rather than assumed.
    const report = fromBytes(read.bytes, record.reportFile);
    if (report.report !== "VALID" || report.value.verdict !== record.verdict || report.value.findings.length !== record.findings) {
      return { ...base, result: "ERROR", report: "STALE", verdict: null, findings: null, reason: `${record.reportFile} does not say what this run recorded for ${key}` };
    }
    return { ...base, result: record.verdict, report: "VALID", verdict: record.verdict, findings: record.findings };
  });

  const selected = results.filter((result) => result.selected);
  const allReported = selected.every((result) => VERDICTS.includes(result.result));
  const execution =
    manifest.interruptedBy !== null
      ? "INTERRUPTED"
      : allReported && manifest.error === undefined && manifest.checkout?.trackedChangesDuringRun !== true
        ? "COMPLETE"
        : "INCOMPLETE";
  const findingsVerdict =
    execution !== "COMPLETE" ? "UNDETERMINED" : selected.every((result) => result.result === "PASS") ? "PASS" : "NOT_PASS";

  const attributed = new Set(["manifest.json", "summary.json"]);
  for (const record of Object.values(manifest.results)) for (const artifact of record.artifacts) attributed.add(artifact.name);
  const unattributedFiles = readdirSync(outDir).filter((name) => !attributed.has(name) && !name.endsWith(".tmp")).sort();

  return {
    schema: "acp-audit-summary/1",
    tool,
    reviewer: manifest.reviewer.cli,
    reviewerModel: manifest.reviewer.model,
    reviewerModelIdentity: manifest.reviewer.modelIdentity,
    ...(manifest.reviewer.modelNote === undefined ? {} : { reviewerModelNote: manifest.reviewer.modelNote }),
    runId: manifest.runId,
    requestedRef: manifest.requestedRef,
    revision: manifest.revision,
    workingTree: manifest.workingTree,
    execution,
    findingsVerdict,
    mergeApproval: false,
    note: NOT_AN_APPROVAL,
    results,
    unattributedFiles,
  };
};

// ---------------------------------------------------------------------------------------------
// The run

/**
 * `sequential` runs areas one at a time (grok's leader socket cannot be shared); otherwise they run
 * concurrently. Exits the process with one of `EXIT`.
 */
export const runAudit = async ({ tool, script, repoRoot, areas, sequential, reviewer, reviewArea }) => {
  installInterruptHandlers();
  const areaKeys = Object.keys(areas);
  const runId = newRunId();
  const { modelSelectable = false, ...reviewerIdentity } = reviewer;
  let options;
  let pinned;
  let identity;
  let checkout = null;
  let outDir;
  try {
    options = parseArguments(process.argv.slice(2), areaKeys, { modelSelectable });
    pinned = pinRevision(repoRoot, options);
    identity = identify({ ...reviewerIdentity, model: options.model ?? reviewerIdentity.model ?? null });
    // Before the output directory: a checkout that does not hold the commit's bytes is a refusal.
    checkout = createCheckout(repoRoot, pinned.revision);
    outDir = createOutputDirectory(repoRoot, { out: options.out, tool, runId });
  } catch (error) {
    if (checkout !== null) removeCheckout(repoRoot, checkout);
    if (!(error instanceof Refusal)) throw error;
    console.error(`${tool}: refused: ${error.message}`);
    process.exit(EXIT.REFUSED);
  }

  const { revision } = pinned;
  console.log(`run directory: ${outDir}`);
  console.log(`revision: ${revision.commit} (tree ${revision.tree}), requested as ${options.rev}`);
  if (pinned.workingTree.dirty) {
    console.log(
      `note: the working tree has ${pinned.workingTree.dirtyEntries} uncommitted status entr${pinned.workingTree.dirtyEntries === 1 ? "y" : "ies"}; ` +
        `they are not part of ${revision.commit.slice(0, 12)} and are not reviewed by this run`,
    );
  }

  const manifestPath = join(outDir, "manifest.json");
  const manifest = {
    schema: "acp-audit-run/1",
    runId,
    tool,
    script,
    purpose: NOT_AN_APPROVAL,
    requestedRef: options.rev,
    revision,
    workingTree: pinned.workingTree,
    outputDirectory: shown(repoRoot, outDir),
    selectedAreas: options.areas,
    reviewer: identity,
    areaTimeoutMs: options.areaTimeoutMs,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "RUNNING",
    exitCode: null,
    interruptedBy: null,
    checkout: {
      method: "git worktree add --detach, hooks disabled, under the system temporary directory",
      verified: "every tracked path's bytes equal the commit's blob, and nothing else is present",
    },
    results: {},
    artifacts: [],
  };
  writeJson(manifestPath, manifest);

  try {
    const ctx = { checkoutDir: checkout.dir, scratchDir: checkout.scratch, outDir, revision, model: identity.model, timeoutMs: options.areaTimeoutMs };
    const one = async (key) => {
      if (interruptedBy !== null) return;
      const record = await executeArea(key, areas[key], ctx, reviewArea);
      manifest.results[key] = record;
      writeJson(manifestPath, manifest);
      console.log(
        `${key.padEnd(11)} ${record.execution.padEnd(11)} ${(record.verdict ?? record.report).padEnd(12)} ` +
          `findings=${String(record.findings ?? "-").padEnd(3)} ${record.seconds}s` +
          `${record.notes ? ` (${record.notes.join("; ").slice(0, 160)})` : ""}`,
      );
    };
    if (sequential) for (const key of options.areas) await one(key);
    else await Promise.all(options.areas.map(one));
    const changed = checkoutDifferences(checkout.dir, revision.commit, { extraFiles: false });
    manifest.checkout.trackedChangesDuringRun = changed.length > 0;
    if (changed.length > 0) manifest.checkout.changedDuringRun = changed.slice(0, 20);
  } catch (error) {
    manifest.error = messageOf(error);
    console.error(`${tool}: ${manifest.error}`);
  } finally {
    Object.assign(manifest.checkout, removeCheckout(repoRoot, checkout));
  }

  manifest.interruptedBy = interruptedBy;
  Object.assign(manifest.reviewer, modelIdentityOf(manifest.reviewer, manifest.results));
  const summary = summarize({ tool, manifest, outDir, areaKeys });
  const summaryBytes = writeJson(join(outDir, "summary.json"), summary);
  const exitCode =
    summary.execution === "INTERRUPTED" ? EXIT.INTERRUPTED : summary.execution === "COMPLETE" ? EXIT.COMPLETE : EXIT.INCOMPLETE;
  // What this run wrote, as recorded when each area finished, plus its summary. A file someone else
  // left in the directory is named in the summary as unattributed, not listed here.
  const artifacts = Object.values(manifest.results).flatMap((record) => record.artifacts);
  Object.assign(manifest, {
    endedAt: new Date().toISOString(),
    status: summary.execution,
    exitCode,
    artifacts: [...artifacts, { name: "summary.json", sha256: sha256(summaryBytes), bytes: summaryBytes.length }].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    ),
  });
  writeJson(manifestPath, manifest);

  const reported = summary.results.filter((result) => result.selected && VERDICTS.includes(result.result)).length;
  const notPass = summary.results.filter((result) => result.selected && result.result !== "PASS").map((result) => `${result.key}=${result.result}`);
  console.log(`\nexecution: ${summary.execution} — ${reported} of ${options.areas.length} selected area(s) returned a well-formed report`);
  console.log(`findings verdict: ${summary.findingsVerdict}${notPass.length > 0 ? ` (${notPass.join(", ")})` : ""}`);
  console.log(
    `reviewer model: ${summary.reviewerModelIdentity === "ESTABLISHED" ? summary.reviewerModel : `UNKNOWN (${summary.reviewerModelNote})`}`,
  );
  if (summary.unattributedFiles.length > 0) {
    console.log(`not attributed to this run, so not read: ${summary.unattributedFiles.join(", ")}`);
  }
  console.log("This is a diagnostic run. Neither line above is a PR review or a merge approval.");
  process.exit(exitCode);
};
