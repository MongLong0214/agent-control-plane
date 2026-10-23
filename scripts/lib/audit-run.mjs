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
 *      tracked or untracked changes anywhere (ignored files aside), the run is refused too: reviewing HEAD would leave that work
 *      out, and calling the result "a review of the current work" would be false. `--allow-dirty`
 *      reviews HEAD anyway and records that the uncommitted changes were not reviewed.
 *   2. **Read a separate checkout.** The reviewer's working directory is a disposable
 *      `git worktree add --detach` of that commit under the system temporary directory, with hooks
 *      disabled. The user's working tree, index and branch are never reset or written; cleanup
 *      removes only that checkout.
 *   3. **Write a new directory.** Every run creates its own output directory and refuses one that
 *      already exists, so no file in it can predate the run.
 *   4. **Attribute every result.** `manifest.json` names the run, the exact revision and tree, the
 *      selected areas, the reviewer CLI and model, and each area's execution result and artifacts
 *      with their digests. `summary.json` is a view of the per-area reports on disk, restricted to
 *      the ones this manifest attributes and only while their bytes still match what was recorded.
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
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

const writeJson = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
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
const parseArguments = (argv, areaKeys) => {
  const options = { out: undefined, rev: "HEAD", allowDirty: false, areaTimeoutMs: DEFAULT_AREA_TIMEOUT_MS };
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
      default:
        throw new Refusal(
          `unknown option: ${name} (accepted: --rev=<ref>, --out=<new directory>, --allow-dirty, --area-timeout-ms=<n>)`,
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

const trackedChangesIn = (dir) =>
  git(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no"]);

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
      throw new Error(`the disposable checkout holds ${commit}/${tree}, not the pinned ${revision.commit}/${revision.tree}`);
    }
    checkout.trackedChanges = trackedChangesIn(dir);
    return checkout;
  } catch (error) {
    removeCheckout(repoRoot, checkout);
    throw error;
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

/** Reads a completed child's report. `{ report: "VALID", value }`, or a report state and a reason. */
const consume = (candidate, reportPath, reportFile) => {
  let value;
  if (candidate?.kind === "value") {
    value = candidate.value;
  } else if (candidate?.kind === "file") {
    if (!existsSync(reportPath)) return { report: "MISSING", reason: `the reviewer exited 0 without writing ${reportFile}` };
    try {
      value = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch (error) {
      return { report: "UNPARSABLE", reason: `${reportFile} is not JSON (truncated or partial): ${messageOf(error)}` };
    }
  } else {
    return {
      report: candidate?.kind === "invalid" ? "INVALID" : "UNPARSABLE",
      reason: candidate?.reason ?? "the reviewer returned no report",
    };
  }
  const problem = reportProblem(value);
  return problem === null ? { report: "VALID", value } : { report: "INVALID", reason: problem };
};

const quarantine = (path, suffix) => {
  if (!existsSync(path)) return null;
  const moved = `${path}.${suffix}`;
  renameSync(path, moved);
  return moved;
};

const digestOf = (outDir, name) => {
  const bytes = readFileSync(join(outDir, name));
  return { name, sha256: sha256(bytes), bytes: bytes.length };
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
  const { child, candidate } = outcome;
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
    report: "NOT_CONSUMED",
    reportFile: null,
    verdict: null,
    findings: null,
  };

  if (record.execution === "COMPLETED") {
    const consumed = consume(candidate, reportPath, reportFile);
    record.report = consumed.report;
    if (consumed.report === "VALID") {
      if (candidate.kind === "value") writeFileSync(reportPath, `${JSON.stringify(consumed.value, null, 2)}\n`);
      Object.assign(record, { reportFile, verdict: consumed.value.verdict, findings: consumed.value.findings.length });
    } else {
      notes.push(consumed.reason);
    }
  } else {
    notes.push(whyNotCompleted(child, ctx.timeoutMs));
  }

  if (record.report === "VALID") {
    artifacts.push(reportFile);
  } else if (quarantine(reportPath, "unconsumed") !== null) {
    artifacts.push(`${reportFile}.unconsumed`);
  }
  record.artifacts = artifacts.filter((name) => existsSync(join(ctx.outDir, name))).map((name) => digestOf(ctx.outDir, name));
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
    let bytes = null;
    try {
      bytes = readFileSync(join(outDir, record.reportFile));
    } catch {
      // gone, which is STALE below
    }
    if (bytes === null || recorded === undefined || sha256(bytes) !== recorded.sha256) {
      return { ...base, result: "STALE", report: "STALE", verdict: null, findings: null, reason: `${record.reportFile} is not the report this run recorded for ${key}` };
    }
    const report = JSON.parse(bytes.toString("utf8"));
    return { ...base, result: report.verdict, report: "VALID", verdict: report.verdict, findings: report.findings.length };
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
  let options;
  let pinned;
  let identity;
  let outDir;
  try {
    options = parseArguments(process.argv.slice(2), areaKeys);
    pinned = pinRevision(repoRoot, options);
    identity = identify(reviewer);
    outDir = createOutputDirectory(repoRoot, { out: options.out, tool, runId });
  } catch (error) {
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
    checkout: { method: "git worktree add --detach, hooks disabled, under the system temporary directory" },
    results: {},
    artifacts: [],
  };
  writeJson(manifestPath, manifest);

  let checkout = null;
  try {
    checkout = createCheckout(repoRoot, revision);
    const ctx = { checkoutDir: checkout.dir, scratchDir: checkout.scratch, outDir, revision, timeoutMs: options.areaTimeoutMs };
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
    manifest.checkout.trackedChangesDuringRun = trackedChangesIn(checkout.dir) !== checkout.trackedChanges;
  } catch (error) {
    manifest.error = messageOf(error);
    console.error(`${tool}: ${manifest.error}`);
  } finally {
    if (checkout !== null) Object.assign(manifest.checkout, removeCheckout(repoRoot, checkout));
  }

  manifest.interruptedBy = interruptedBy;
  const summary = summarize({ tool, manifest, outDir, areaKeys });
  writeJson(join(outDir, "summary.json"), summary);
  const exitCode =
    summary.execution === "INTERRUPTED" ? EXIT.INTERRUPTED : summary.execution === "COMPLETE" ? EXIT.COMPLETE : EXIT.INCOMPLETE;
  // What this run wrote, as recorded when each area finished, plus its summary. A file someone else
  // left in the directory is named in the summary as unattributed, not listed here.
  const artifacts = Object.values(manifest.results).flatMap((record) => record.artifacts);
  Object.assign(manifest, {
    endedAt: new Date().toISOString(),
    status: summary.execution,
    exitCode,
    artifacts: [...artifacts, digestOf(outDir, "summary.json")].sort((a, b) => (a.name < b.name ? -1 : 1)),
  });
  writeJson(manifestPath, manifest);

  const reported = summary.results.filter((result) => result.selected && VERDICTS.includes(result.result)).length;
  const notPass = summary.results.filter((result) => result.selected && result.result !== "PASS").map((result) => `${result.key}=${result.result}`);
  console.log(`\nexecution: ${summary.execution} — ${reported} of ${options.areas.length} selected area(s) returned a well-formed report`);
  console.log(`findings verdict: ${summary.findingsVerdict}${notPass.length > 0 ? ` (${notPass.join(", ")})` : ""}`);
  if (summary.unattributedFiles.length > 0) {
    console.log(`not attributed to this run, so not read: ${summary.unattributedFiles.join(", ")}`);
  }
  console.log("This is a diagnostic run. Neither line above is a PR review or a merge approval.");
  process.exit(exitCode);
};
