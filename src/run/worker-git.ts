import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { digestOf, sha256 } from "../core/digest.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";

/**
 * #512 — the only way the worker-turn runner calls git (ACP-WORKER-01).
 *
 * A WORKER turn can write anything in its worktree, and in a main checkout that includes `.git`.
 * Every git call the control plane makes after the turn therefore has to be unable to run code the
 * worker chose:
 *
 * - The git dir and work tree are pinned before the turn and passed explicitly (`GIT_DIR`,
 *   `GIT_WORK_TREE`), never discovered through the worktree's `.git`, which the worker can redirect.
 * - The `.git` entry, the effective configuration (`git config --list --show-origin`, include targets
 *   included) and every file of the git dirs (bar the index, which the CLI's own `git status`
 *   refreshes) are compared byte-for-byte with what they were before the turn; any difference refuses
 *   the turn before git reads the worktree again.
 * - Nothing that applies a filter, a diff driver or a hook is used: the change set is computed here
 *   from the raw bytes against `git ls-tree`, and the commit is plumbing over a private index
 *   (`hash-object --no-filters`, `update-index --index-info`, `write-tree`, `commit-tree`,
 *   `update-ref`). Hooks are pointed at /dev/null, fsmonitor and the untracked cache are off, and no
 *   credential or askpass helper is configured.
 * - System and global configuration are not read (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`),
 *   HOME is an empty private directory, and replace refs are ignored.
 * - The index is excluded from the git-dir comparison only for its stat cache: what it stages is
 *   fenced separately (`stagedContent`), and the commit locks it and updates only the committed
 *   paths, so no one's staged work is erased (ACP-WORKER-06).
 * - A gitlink's contents live in another repository, which is never run: one is accepted only with
 *   nothing checked out at its path, in every pass (ACP-WORKER-05).
 */

const GIT_TIMEOUT_MS = 120_000;
const ZERO_OID = { sha1: "0".repeat(40), sha256: "0".repeat(64) } as const;

/** Configuration that would otherwise let a repository run a command inside a plumbing call. */
export const GIT_HARDENING: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "commit.gpgSign=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "credential.helper=",
  "-c", "core.askPass=",
];

/** The committer the control plane signs worker commits as; no provider, model or session in it. */
const CONTROL_PLANE_IDENTITY = {
  GIT_AUTHOR_NAME: "agent-control-plane",
  GIT_AUTHOR_EMAIL: "agent-control-plane@localhost.invalid",
  GIT_COMMITTER_NAME: "agent-control-plane",
  GIT_COMMITTER_EMAIL: "agent-control-plane@localhost.invalid",
};

export interface PinnedRepository {
  readonly workTree: string;
  readonly gitDir: string;
  readonly commonDir: string;
  /** The work tree's `.git` entry as it was before the turn: kind, device, inode, and a file's bytes. */
  readonly dotGit: string;
  /** Private: temporary indexes and an empty HOME. Never inside the work tree. */
  readonly scratch: string;
  /** Every git child running against this repository for the turn, and whether more may start. */
  readonly children: GitChildren;
}

/** What closing a repository's git children observed. */
/** A git process group a turn started: its id (the leader's pid) and the leader's OS start time. */
export interface GitProcessGroup {
  pgid: number;
  /** `readProcessStartToken` of the leader when it was spawned; null where the platform cannot say. */
  leaderStartedAt: string | null;
}

/**
 * S2 — what records a turn's git groups durably and ahead, so a daemon that restarts, or one killed at
 * any instant, still sees one that may live on: `intended` before the spawn, under a nonce (false when
 * it could not be written: nothing is spawned); `started` with the group once spawned (false when it
 * could not be written: the child never runs git); `ended` once the group is confirmed empty or was
 * never spawned.
 */
export interface GitGroupRecorder {
  intended(nonce: string): boolean;
  started(nonce: string, group: GitProcessGroup): boolean;
  ended(nonce: string, group: GitProcessGroup | null): void;
}

/**
 * S2 — a worker git child is spawned as this gate, its argv[0] naming its intent (`GIT_GATE_NAME` +
 * nonce): it runs git, in place and in the same process group, only on reading `go`, which the runner
 * writes only once the group is on record. A runner that dies first closes the pipe, and the gate
 * exits without ever running git. So git runs only as a recorded group, and a gate still waiting is
 * found by its argv (`gatedGitChildren`).
 */
const GIT_GATE = 'IFS= read -r gate || exit 97; [ "$gate" = go ] || exit 97; exec git "$@"';
export const GIT_GATE_NAME = "acp-git-";

/**
 * S2 — which of `nonces` a live process still carries as its gate's name (`GIT_GATE_NAME` + nonce, one
 * whole argument), read from `ps` as the release repair reads it. null when the table cannot be read,
 * or does not list this process itself: then nothing is proven gone.
 */
export const gatedGitChildren = (nonces: readonly string[]): Set<string> | null => {
  if (nonces.length === 0) return new Set();
  let table: string;
  try {
    table = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const wanted = new Map(nonces.map((nonce) => [`${GIT_GATE_NAME}${nonce}`, nonce]));
  const carried = new Set<string>();
  let listsItself = false;
  for (const line of table.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] === String(process.pid)) listsItself = true;
    for (const token of tokens.slice(1)) {
      const nonce = wanted.get(token);
      if (nonce !== undefined) carried.add(nonce);
    }
  }
  return listsItself ? carried : null;
};

export interface GitChildrenClosed {
  /** Every group was emptied: its leader seen to exit and no member left (`kill(-pgid, 0)` is ESRCH). */
  reaped: boolean;
  killed: number[];
  /** Groups that still had a member when the bound ran out. */
  unreaped: GitProcessGroup[];
  /** The real index's lock the commit held, removed here because the commit can no longer. */
  indexLockReleased: boolean;
}

/**
 * The git process groups a turn has started against its repository (#1070 ACP-WORKER-03).
 *
 * Each git child is spawned as its own process group, and the registry owns the group, not the child:
 * a group stays registered after its leader exits for as long as any member is left — a descendant
 * the leader forked keeps the group, and the right to mutate the repository, alive. A group leaves
 * the registry only once it is confirmed empty: the leader's exit observed and `kill(-pgid, 0)` ESRCH.
 *
 * Closing the registry stops every group still registered — SIGKILL to the group, repeated while it
 * has members — and waits, bounded, until each is confirmed empty; from then on no git command starts
 * against the repository and the commit publishes nothing. A stopping daemon closes every registry
 * its runner has opened, of running turns and settled ones alike, before it gives up its authority.
 */
export class GitChildren {
  #closed = false;
  #retired = false;
  readonly #groups = new Map<number, { child: ChildProcess; leaderExited: boolean; leaderStartedAt: string | null; nonce: string }>();
  #heldIndexLock: string | null = null;
  #recorder: GitGroupRecorder | null = null;

  /** S2 — every group from now on is recorded at its spawn and again once confirmed empty. */
  record(recorder: GitGroupRecorder): void {
    this.#recorder = recorder;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Its owner — a turn that settled, an admission that never launched — will start no more git. */
  retire(): void {
    this.#retired = true;
  }

  /** Retired, and no group of it left: nothing here can mutate the repository any more. */
  get finished(): boolean {
    return this.#retired && this.liveGroups().length === 0;
  }

  /**
   * S2 — before a spawn: a fresh nonce whose intent is recorded, durably, before the child exists. null
   * when the intent could not be recorded: the child is then never spawned.
   */
  intend(): string | null {
    const nonce = randomUUID();
    if (!this.#recorder) return nonce;
    try {
      return this.#recorder.intended(nonce) ? nonce : null;
    } catch {
      return null;
    }
  }

  /** S2 — an intended child that was never spawned. */
  abandon(nonce: string): void {
    this.#recorder?.ended(nonce, null);
  }

  /**
   * Records a child's group the moment the child is spawned, against the intent it was spawned under.
   * Whether the group is on record: only then may a gated child run git.
   */
  track(child: ChildProcess, nonce: string = randomUUID()): boolean {
    const pgid = child.pid;
    if (pgid === undefined) {
      this.abandon(nonce);
      return false;
    }
    const entry = { child, leaderExited: false, leaderStartedAt: readProcessStartToken(pgid), nonce };
    this.#groups.set(pgid, entry);
    let recorded = true;
    try {
      recorded = this.#recorder?.started(nonce, { pgid, leaderStartedAt: entry.leaderStartedAt }) ?? true;
    } catch {
      recorded = false;
    }
    child.once("exit", () => {
      entry.leaderExited = true;
      // Released only when nothing is left in the group; a descendant keeps it registered.
      if (groupGone(pgid, entry)) this.drop(pgid);
    });
    return recorded;
  }

  private drop(pgid: number): void {
    const entry = this.#groups.get(pgid);
    if (!entry) return;
    this.#groups.delete(pgid);
    this.#recorder?.ended(entry.nonce, { pgid, leaderStartedAt: entry.leaderStartedAt });
  }

  /** Groups still registered after dropping every one confirmed empty. */
  liveGroups(): GitProcessGroup[] {
    for (const [pgid, entry] of this.#groups) {
      if (groupGone(pgid, entry)) this.drop(pgid);
    }
    return [...this.#groups.entries()].map(([pgid, entry]) => ({ pgid, leaderStartedAt: entry.leaderStartedAt }));
  }

  /** The commit holds the real index's lock (or has released it: null). */
  holdIndexLock(lock: string | null): void {
    this.#heldIndexLock = lock;
  }

  holdsIndexLock(lock: string): boolean {
    return this.#heldIndexLock === lock;
  }

  async close(boundMs: number): Promise<GitChildrenClosed> {
    this.#closed = true;
    const entries = [...this.#groups.entries()];
    const stopped = (pgid: number): boolean => {
      const entry = this.#groups.get(pgid);
      return entry === undefined || groupGone(pgid, entry);
    };
    const kill = (): void => {
      for (const [pgid, { child }] of entries) {
        if (stopped(pgid)) continue;
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* the group is already gone */
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    kill();
    const deadline = Date.now() + boundMs;
    let lastKill = Date.now();
    while (entries.some(([pgid]) => !stopped(pgid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      // A member forked between the signal and its delivery joins the same group: signal it again.
      if (Date.now() - lastKill >= 200) {
        kill();
        lastKill = Date.now();
      }
    }
    const unreaped = entries.filter(([pgid]) => !stopped(pgid)).map(([pgid, entry]) => ({ pgid, leaderStartedAt: entry.leaderStartedAt }));
    for (const [pgid] of entries) if (stopped(pgid)) this.drop(pgid);
    let indexLockReleased = false;
    if (this.#heldIndexLock !== null) {
      rmSync(this.#heldIndexLock, { force: true });
      this.#heldIndexLock = null;
      indexLockReleased = true;
    }
    return { reaped: unreaped.length === 0, killed: entries.map(([pgid]) => pgid), unreaped, indexLockReleased };
  }
}

/**
 * Whether a registered group is confirmed empty: its leader's exit was observed and no member is left.
 * A process holding the group's id once the leader has exited is a new one — a pid cannot be reused
 * while a group of that id has members — so our group is gone, and that process is never signalled.
 */
const groupGone = (pgid: number, entry: { leaderExited: boolean }): boolean =>
  entry.leaderExited && (!groupAlive(pgid) || processExists(pgid));

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

export interface GitRun {
  stdout: string;
  stderr: string;
  /** null when git did not answer: a timeout, a signal, or no binary. */
  exitCode: number | null;
}

/** One changed path, as the worktree holds it. A deletion has neither mode nor content. */
export interface WorkerDiffEntry {
  path: string;
  mode: "100644" | "100755" | "120000" | null;
  /** sha256 of the file's bytes (a symlink's target), null for a deletion. */
  sha256: string | null;
  /** The git object id the same bytes have, null for a deletion. */
  blob: string | null;
}

export interface TreeScan {
  /** Tracked paths that differ from the tree, and untracked paths git does not ignore. */
  entries: WorkerDiffEntry[];
  /** Paths that are not a plain file or symlink, or sit below a symlink: never committable. */
  unsafe: string[];
  /** Untracked agent configuration at the root, ignored or not. */
  untrackedAgentConfiguration: string[];
  /**
   * Gitlinks (submodules) whose path is anything but absent or an empty directory: checked out, or
   * replaced. Also in `unsafe`. Their state lives in another repository, which the control plane will
   * not run git inside, so a turn never starts on one and never ends having made one (ACP-WORKER-05).
   */
  populatedGitlinks: string[];
}

const dotGitIdentity = (workTree: string): { kind: "dir" | "file"; stat: Stats; bytes: Buffer | null } | null => {
  const path = join(workTree, ".git");
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return { kind: "dir", stat, bytes: null };
  if (stat.isFile()) return { kind: "file", stat, bytes: readFileSync(path) };
  return null;
};

/** The work tree's `.git` entry, fingerprinted; null when it is missing or neither a directory nor a file. */
export const dotGitFingerprint = (workTree: string): string | null => {
  const entry = dotGitIdentity(workTree);
  if (!entry) return null;
  return `${entry.kind}:${entry.stat.dev}:${entry.stat.ino}:${entry.bytes ? sha256(entry.bytes) : "-"}`;
};

/**
 * Pins the git dir of a registered checkout before a turn. A `.git` directory is used as it is. A
 * `.git` file (a linked worktree) is accepted only when it names a git dir outside the work tree whose
 * own `gitdir` record points back at this work tree, and whose common dir is outside it too: a worker
 * can write only inside its work tree, so a git dir it could have made is refused.
 */
export const pinRepository = (workTree: string, scratch: string): Decision<PinnedRepository> => {
  const tree = canonical(workTree);
  const entry = dotGitIdentity(tree);
  if (!entry) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the claimed worktree has no .git directory or file", { worktreeId: tree });
  }
  let gitDir: string;
  let commonDir: string;
  try {
    if (entry.kind === "dir") {
      gitDir = realpathSync(join(tree, ".git"));
      commonDir = gitDir;
      if (lstatOrNull(join(gitDir, "commondir"))) {
        return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the worktree's .git directory names another common dir", { worktreeId: tree });
      }
    } else {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(entry.bytes!.toString("utf8"))?.[1];
      if (!named) return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the worktree's .git file names no git dir", { worktreeId: tree });
      gitDir = realpathSync(isAbsolute(named) ? named : resolve(tree, named));
      const backLink = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
      if (realpathSync(isAbsolute(backLink) ? backLink : resolve(gitDir, backLink)) !== realpathSync(join(tree, ".git"))) {
        return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the linked git dir does not point back at this worktree", { worktreeId: tree });
      }
      const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      commonDir = realpathSync(isAbsolute(common) ? common : resolve(gitDir, common));
    }
  } catch (error) {
    return deny(ReasonCode.PROBE_FAILED, "the claimed worktree's git dir cannot be resolved", {
      worktreeId: tree,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
  }
  if (entry.kind === "file" && (isWithin(tree, gitDir) || isWithin(tree, commonDir))) {
    return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the worktree's .git file names a git dir inside the worktree", { worktreeId: tree });
  }
  if (!lstatOrNull(join(gitDir, "HEAD"))) {
    return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "the pinned git dir has no HEAD", { worktreeId: tree });
  }
  mkdirSync(join(scratch, "home"), { recursive: true, mode: 0o700 });
  return allow(ReasonCode.OK, Object.freeze({
    workTree: tree, gitDir, commonDir, dotGit: dotGitFingerprint(tree)!, scratch, children: new GitChildren(),
  }));
};

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Runs git against the pinned repository only; the environment is built here, never inherited. */
export const runPinnedGit = (
  repo: PinnedRepository,
  args: readonly string[],
  options: {
    index?: string;
    input?: string | Buffer;
    timeoutMs?: number;
    extraEnv?: Record<string, string>;
    /** A read the stopping daemon itself makes after closing the repository: the ref, for its record. */
    afterClose?: boolean;
  } = {},
): Promise<GitRun> =>
  new Promise((resolveRun) => {
    if (repo.children.closed && options.afterClose !== true) {
      resolveRun({ stdout: "", stderr: "the turn's repository was closed by a stopping daemon; no git command starts", exitCode: null });
      return;
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: join(repo.scratch, "home"),
      XDG_CONFIG_HOME: join(repo.scratch, "home"),
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_DIR: repo.gitDir,
      GIT_WORK_TREE: repo.workTree,
      ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
      ...CONTROL_PLANE_IDENTITY,
      ...(options.extraEnv ?? {}),
    };
    // S2 — write-ahead: the intent is on record before the child exists, and the child runs git only
    // once its group is on record too (`GIT_GATE`).
    const nonce = repo.children.intend();
    if (nonce === null) {
      resolveRun({ stdout: "", stderr: "the git command's intent could not be recorded; it is not started", exitCode: null });
      return;
    }
    let child: ReturnType<typeof spawn>;
    let admitted: boolean;
    try {
      // Its own process group, so a stopping daemon can stop it whole (ACP-WORKER-03).
      child = spawn("/bin/sh", ["-c", GIT_GATE, `${GIT_GATE_NAME}${nonce}`, ...GIT_HARDENING, ...args], {
        cwd: repo.workTree, env, stdio: ["pipe", "pipe", "pipe"], detached: true,
      });
      admitted = repo.children.track(child, nonce);
    } catch (error) {
      repo.children.abandon(nonce);
      resolveRun({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode });
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code, signal) => finish(signal ? null : code));
    child.stdin?.on("error", () => undefined);
    if (admitted) {
      child.stdin?.write("go\n");
      child.stdin?.end(options.input ?? "");
    } else {
      // Its group is not on record: the gate is killed by its exact pid, and would read end of input and
      // exit without running git besides.
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      child.stdin?.end();
    }
  });

const must = async (repo: PinnedRepository, args: readonly string[], options: Parameters<typeof runPinnedGit>[2] = {}): Promise<string> => {
  const run = await runPinnedGit(repo, args, options);
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} ${run.exitCode === null ? "did not answer" : `exited ${run.exitCode}`}: ${run.stderr.slice(0, 300)}`);
  }
  return run.stdout;
};

export const objectFormatOf = async (repo: PinnedRepository): Promise<"sha1" | "sha256"> =>
  (await must(repo, ["rev-parse", "--show-object-format"])).trim() === "sha256" ? "sha256" : "sha1";

/** HEAD's commit and the branch it is on (null when detached). */
export const headOf = async (repo: PinnedRepository): Promise<{ head: string | null; branch: string | null }> => {
  const head = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const ref = await runPinnedGit(repo, ["symbolic-ref", "-q", "HEAD"]);
  const branch = ref.exitCode === 0 && ref.stdout.trim().startsWith("refs/heads/") ? ref.stdout.trim().slice("refs/heads/".length) : null;
  return { head: head.exitCode === 0 ? head.stdout.trim() : null, branch };
};

/** The effective configuration with the file each value came from, include targets resolved. */
export const effectiveConfig = async (repo: PinnedRepository): Promise<string> =>
  must(repo, ["config", "--list", "--show-origin", "--show-scope", "-z"]);

/**
 * #1227 — the names under a git dir's `objects/` that are content-addressed storage: a loose object's
 * fan-out directory (`objects/[0-9a-f]{2}`) and the pack directory (`objects/pack`).
 */
const OBJECT_STORAGE = /^(?:[0-9a-f]{2}|pack)$/;

/**
 * Every entry of the pinned git dir(s): path, kind, size, mtime, inode, and a symlink's target. The
 * index is left out: the provider CLI's own `git status` rewrites its stat cache, and the control
 * plane never reads the real index after a turn. One line per entry, its fields `\0`-separated and led
 * by the root and the path relative to it; the order is the walk's, and the same tree gives the same list.
 *
 * #1227 — content-addressed object storage is left out as well, under the common dir and the pinned
 * git dir alike: every loose object (`objects/[0-9a-f]{2}/*`) and everything in `objects/pack/`, so
 * another writer of the object store adding, freshening or repacking objects does not refuse a turn:
 * the control plane's own fetch of a run's base into a resident's worker clone, or the resident's gc
 * freshening an object file the worker clone shares with it by hardlink. A resident's worker clone has
 * its own git dir, so nothing else the resident writes is in its baseline.
 * Only a real directory of those names is left out; anything else there is read. The `objects`
 * directory is read without its size and times, which those additions move, so its replacement still
 * shows. Everything else under `objects/` (`objects/info/*`: alternates, http-alternates, the
 * commit-graph) is read as before, as are refs, packed-refs, HEAD, config, hooks, info/, logs and a
 * linked worktree's own files.
 */
export const gitDirEntries = (repo: PinnedRepository): string[] => {
  const roots = [...new Set([repo.commonDir, repo.gitDir])];
  const entries: string[] = [];
  const worktreesRoot = join(repo.commonDir, "worktrees");
  // The directories that hold an index: the pinned git dir, the common dir, and each linked worktree's.
  const holdsIndex = (dir: string): boolean => dir === repo.gitDir || dir === repo.commonDir || dirname(dir) === worktreesRoot;
  const walk = (root: string, dir: string, depth: number): void => {
    if (depth > 64) throw new Error("the git dir is nested too deeply to fingerprint");
    const objects = join(root, "objects");
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if ((name === "index" || name === "index.lock") && stat.isFile() && holdsIndex(dir)) continue;
      const kind = stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : stat.isFile() ? "f" : "o";
      if (dir === objects && kind === "d" && OBJECT_STORAGE.test(name)) continue;
      const times = path === objects && kind === "d" ? "-\0-" : `${stat.size}\0${stat.mtimeMs}`;
      entries.push(`${root}\0${path.slice(root.length + 1)}\0${kind}\0${times}\0${stat.ino}\0${stat.mode}\0${kind === "l" ? readlinkSync(path) : ""}`);
      if (kind === "d") walk(root, path, depth + 1);
    }
  };
  for (const root of roots) walk(root, root, 0);
  return entries;
};

/**
 * #1227 review — the object store may be repacked, freshened, or gain objects while a resident and a
 * worker share it, but an object already named by an id must still hash to that id. Normal Git reads
 * trust the object-id path and can consume substituted bytes; strict fsck re-hashes the reachable
 * graph before those bytes are used to compare or commit a candidate. Dangling objects are harmless
 * concurrent additions and are not reported, while corrupt reachable loose or packed objects refuse.
 */
export const objectStoreIntegrity = async (repo: PinnedRepository, head: string): Promise<GitRun> =>
  runPinnedGit(repo, ["fsck", "--strict", "--no-dangling", "--no-reflogs", "--no-progress", head]);

/**
 * #1246 — git configuration a WORKER turn's own git runs with, over the repository's (`GIT_CONFIG_COUNT`
 * in its environment; see `productionRunCli`), so the read-only commands its prompt allows write nothing
 * in the git dir where the repository's configuration would have them do so. Measured on git 2.50, with
 * `GIT_OPTIONAL_LOCKS=0` already set:
 * - `core.fsmonitor=false`: the builtin fsmonitor daemon a `git status` or `git diff` starts keeps
 *   cookie files under the git dir (`fsmonitor--daemon/`), and outlives the turn;
 * - `diff.<driver>.cachetextconv=false`, for every driver the repository's configuration names: a caching
 *   textconv driver stores its output as notes (`refs/notes/textconv/<driver>`, objects, a reflog) on a
 *   `git diff`, `show`, `log -p` or `blame`.
 * Read through the pinned git with the HOME the worker's git has (`home`, the provider child's), so a
 * `~/` in an `include.path` or `includeIf` resolves to the file the worker reads: the repository's
 * configuration and everything it includes. The worker's git reads no global or system configuration
 * (`productionRunCli`), so this is all of what it reads.
 */
export const workerGitConfig = async (repo: PinnedRepository, home: string | undefined): Promise<Record<string, string>> => {
  const cached = await runPinnedGit(repo, ["config", "-z", "--name-only", "--get-regexp", "^diff\\..*\\.cachetextconv$"], asTheWorker(home));
  if (cached.exitCode !== 0 && cached.exitCode !== 1) {
    throw new Error(`git config --get-regexp ${cached.exitCode === null ? "did not answer" : `exited ${cached.exitCode}`}: ${cached.stderr.slice(0, 300)}`);
  }
  const config: Record<string, string> = { "core.fsmonitor": "false" };
  for (const key of cached.exitCode === 0 ? cached.stdout.split("\0").filter(Boolean) : []) config[key] = "false";
  return config;
};

/** `runPinnedGit` options under which git reads its configuration as the worker's git does: with its HOME. */
const asTheWorker = (home: string | undefined): Parameters<typeof runPinnedGit>[2] => (home === undefined ? {} : { extraEnv: { HOME: home } });

/**
 * #1246 — whether the repository depends on a split index, read as the worker's git reads it (`home`):
 * - `configured`: `core.splitIndex` is effectively true, so the next index write splits the index;
 * - `active`: the index on disk uses a shared index. Git freshens that file's mtime on every read of the
 *   index, optional locks or not, so a turn on it always changes its git dir.
 * `active` is asked with `core.splitIndex` forced true, because git applies the setting to the index it
 * has read: with it false, `--shared-index-path` prints nothing for an index still split on disk, which
 * every read still freshens. Forced true, it names the real shared index exactly when the index on disk
 * is split, and an all-zero one when it is not. A `sharedindex.*` file the index no longer uses (left
 * by `git update-index --no-split-index`) is not read and does not count. Writes nothing.
 *
 * A sparse index cannot be split, and the forced probe refuses on one ("cannot use split index with a
 * sparse index"). That refusal, in a repository configured for a sparse index (`index.sparse` and
 * `core.sparseCheckout`), reads as inactive; any other failure of the probe fails closed. The probe still
 * runs there: an index split before sparse-index was turned on stays split, and is reported active.
 */
export const splitIndexOf = async (repo: PinnedRepository, home: string | undefined): Promise<{ configured: boolean; active: boolean }> => {
  const options = asTheWorker(home);
  const setting = await runPinnedGit(repo, ["config", "--type=bool", "--get", "core.splitIndex"], options);
  if (setting.exitCode !== 0 && setting.exitCode !== 1) {
    throw new Error(`git config core.splitIndex ${setting.exitCode === null ? "did not answer" : `exited ${setting.exitCode}`}: ${setting.stderr.slice(0, 300)}`);
  }
  const configured = setting.exitCode === 0 && setting.stdout.trim() === "true";
  const sparse = await runPinnedGit(repo, ["config", "-z", "--type=bool", "--get-regexp", "^(index\\.sparse|core\\.sparsecheckout)$"], options);
  if (sparse.exitCode !== 0 && sparse.exitCode !== 1) {
    throw new Error(`git config index.sparse ${sparse.exitCode === null ? "did not answer" : `exited ${sparse.exitCode}`}: ${sparse.stderr.slice(0, 300)}`);
  }
  // `-z` prints `key\nvalue\0` per value; the last value of a key is the one git uses.
  const sparseSettings = new Map(sparse.stdout.split("\0").filter(Boolean).map((entry) => entry.split("\n", 2) as [string, string]));
  const sparseIndex = sparseSettings.get("index.sparse") === "true" && sparseSettings.get("core.sparsecheckout") === "true";
  const shared = await runPinnedGit(repo, ["-c", "core.splitIndex=true", "rev-parse", "--shared-index-path"], options);
  if (shared.exitCode === 0) return { configured, active: /sharedindex\.[0-9a-f]*[1-9a-f][0-9a-f]*$/.test(shared.stdout.trim()) };
  if (sparseIndex && shared.exitCode === 128 && shared.stderr.includes("cannot use split index with a sparse index")) return { configured, active: false };
  throw new Error(`git rev-parse --shared-index-path ${shared.exitCode === null ? "did not answer" : `exited ${shared.exitCode}`}: ${shared.stderr.slice(0, 300)}`);
};

/** One git-dir entry that differs between two `gitDirEntries` readings; never its contents. */
export interface GitDirChange {
  change: "added" | "removed" | "changed";
  /** The walk root the path is relative to: the pinned git dir, or a linked worktree's common dir. */
  root: "gitDir" | "commonDir";
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
}

const GIT_DIR_KINDS: Readonly<Record<string, GitDirChange["kind"]>> = { f: "file", d: "directory", l: "symlink", o: "other" };

/**
 * #1246 — which entries differ between two readings of the same walk (`gitDirEntries`): added,
 * removed, or changed in any recorded field. Named by root, relative path and kind only, ordered by
 * root and path. A removed entry has the kind it had; any other, the kind it has now.
 */
export const gitDirChanges = (repo: PinnedRepository, before: readonly string[], after: readonly string[]): GitDirChange[] => {
  const keyed = (lines: readonly string[]): Map<string, string> =>
    new Map(lines.map((line) => [line.split("\0", 2).join("\0"), line]));
  const was = keyed(before);
  const now = keyed(after);
  const changes: GitDirChange[] = [];
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const previous = was.get(key);
    const current = now.get(key);
    if (previous === current) continue;
    const [root = "", path = "", kind = "o"] = (current ?? previous)!.split("\0", 3);
    changes.push({
      change: previous === undefined ? "added" : current === undefined ? "removed" : "changed",
      root: root === repo.gitDir ? "gitDir" : "commonDir",
      path,
      kind: GIT_DIR_KINDS[kind] ?? "other",
    });
  }
  return changes;
};

const gitBlobId = (format: "sha1" | "sha256", bytes: Buffer): string =>
  createHash(format).update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

/** The worktree's state of one path, read without following any symlink above it. */
const readWorktreePath = (
  workTree: string,
  path: string,
  format: "sha1" | "sha256",
): { kind: "missing" } | { kind: "unsafe" } | { kind: "entry"; entry: WorkerDiffEntry } => {
  const parts = path.split("/");
  let cursor = workTree;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    const stat = lstatOrNull(cursor);
    if (!stat) return { kind: "missing" };
    if (!stat.isDirectory()) return stat.isSymbolicLink() ? { kind: "unsafe" } : { kind: "missing" };
  }
  const full = join(workTree, path);
  const stat = lstatOrNull(full);
  if (!stat) return { kind: "missing" };
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(readlinkSync(full));
    return { kind: "entry", entry: { path, mode: "120000", sha256: sha256(target), blob: gitBlobId(format, target) } };
  }
  if (stat.isFile()) {
    const bytes = readFileSync(full);
    return {
      kind: "entry",
      entry: { path, mode: (stat.mode & 0o100) !== 0 ? "100755" : "100644", sha256: sha256(bytes), blob: gitBlobId(format, bytes) },
    };
  }
  return { kind: "unsafe" };
};

/**
 * The worktree against a tree: tracked paths whose bytes or mode differ, untracked paths git does not
 * ignore, and the root's untracked agent configuration. Computed from the raw bytes; git is asked only
 * for the tree (`ls-tree`) and, over a private index read from that tree, for untracked names.
 *
 * #1227 — nothing is passed over. A resident CTO's Claude Code session cron lock
 * (`.claude/scheduled_tasks.lock`) is written in the resident's clone, which worker turns no longer
 * use (registry/worker-checkout.ts); one in a worker checkout is untracked agent configuration.
 */
export const scanAgainst = async (
  repo: PinnedRepository,
  treeIsh: string,
  format: "sha1" | "sha256",
  label: string,
): Promise<TreeScan> => {
  const listed = await must(repo, ["ls-tree", "-r", "-z", "--full-tree", treeIsh]);
  const tracked = new Map<string, { mode: string; type: string; oid: string }>();
  for (const record of listed.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    tracked.set(record.slice(tab + 1), { mode: mode!, type: type!, oid: oid! });
  }
  const index = join(repo.scratch, `${label}.index`);
  await must(repo, ["read-tree", treeIsh], { index });
  const untracked = (await must(repo, ["ls-files", "-z", "--others", "--exclude-standard"], { index })).split("\0").filter(Boolean);
  const untrackedAgentConfiguration = (await must(
    repo,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ".claude", ".mcp.json"],
    { index },
  )).split("\0").filter(Boolean);

  const entries: WorkerDiffEntry[] = [];
  const unsafe: string[] = [];
  const populatedGitlinks: string[] = [];
  for (const [path, base] of tracked) {
    if (base.type === "commit") {
      // A gitlink. Git reads a checked-out submodule's state from the submodule's own repository; this
      // scan does not, so the only states it can vouch for are the ones with nothing in them.
      if (!gitlinkIsEmpty(repo.workTree, path)) {
        unsafe.push(path);
        populatedGitlinks.push(path);
      }
      continue;
    }
    if (base.type !== "blob") {
      unsafe.push(path);
      continue;
    }
    const now = readWorktreePath(repo.workTree, path, format);
    if (now.kind === "missing") entries.push({ path, mode: null, sha256: null, blob: null });
    else if (now.kind === "unsafe") unsafe.push(path);
    else if (now.entry.blob !== base.oid || now.entry.mode !== base.mode) entries.push(now.entry);
  }
  for (const path of untracked) {
    const now = readWorktreePath(repo.workTree, path.replace(/\/$/, ""), format);
    if (now.kind === "entry") entries.push(now.entry);
    else unsafe.push(path);
  }
  return {
    entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    unsafe: unsafe.sort(),
    untrackedAgentConfiguration: untrackedAgentConfiguration.sort(),
    populatedGitlinks: populatedGitlinks.sort(),
  };
};

/** #1097 — how many entries beneath ignored directories one reading walks before it reports a failure. */
const IGNORED_WALK_LIMIT = 200_000;

/**
 * #1097 — what `lstat` reports of every path git ignores in the worktree (kind, size, mode, inode, mtime
 * and ctime), keyed by path, over a private index read from `treeIsh`. Git lists no ignored path to
 * `scanAgainst`, so a turn's change under one is neither committed nor seen there; two readings, before
 * the turn and after it, name every ignored path the turn created, changed or removed. Nothing listed
 * here is ever committed.
 *
 * Git lists an ignored nested repository as one directory (`build/cache/`) and does not descend into it,
 * so every entry beneath such a directory is read here as well — by `lstat` and `readdir` alone: a
 * symlink is recorded as itself and never followed, and nothing of the nested repository is run. A
 * directory is recorded by kind, mode and inode only; what changes inside it is named by its entries.
 * A walk past `IGNORED_WALK_LIMIT` entries, or a directory that cannot be read, fails the reading.
 */
export const ignoredPathState = async (repo: PinnedRepository, treeIsh: string, label: string): Promise<Map<string, string>> => {
  const index = join(repo.scratch, `${label}.ignored.index`);
  await must(repo, ["read-tree", treeIsh], { index });
  const listed = (await must(repo, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { index }))
    .split("\0")
    .filter(Boolean);
  const state = new Map<string, string>();
  let walked = 0;
  const record = (path: string): void => {
    const stat = lstatOrNull(join(repo.workTree, path.replace(/\/$/, "")));
    if (stat === null) {
      state.set(path, "missing");
      return;
    }
    if (!stat.isDirectory()) {
      state.set(path, [stat.isSymbolicLink() ? "l" : stat.isFile() ? "f" : "o", stat.size, stat.mode, stat.ino, stat.mtimeMs, stat.ctimeMs].join(":"));
      return;
    }
    state.set(path, ["d", stat.mode, stat.ino].join(":"));
    const directory = path.endsWith("/") ? path : `${path}/`;
    for (const entry of readdirSync(join(repo.workTree, directory), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      walked += 1;
      if (walked > IGNORED_WALK_LIMIT) throw new Error(`more than ${IGNORED_WALK_LIMIT} entries beneath ignored directories`);
      record(entry.isDirectory() ? `${directory}${entry.name}/` : `${directory}${entry.name}`);
    }
  };
  for (const path of listed) record(path);
  return state;
};

/** #1097 — the ignored paths whose state differs between two `ignoredPathState` readings, sorted. */
export const ignoredPathsChanged = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();

/** A gitlink's path is absent, or an empty directory reached without a symlink: nothing checked out. */
const gitlinkIsEmpty = (workTree: string, path: string): boolean => {
  let cursor = workTree;
  for (const part of path.split("/").slice(0, -1)) {
    cursor = join(cursor, part);
    const stat = lstatOrNull(cursor);
    if (!stat) return true;
    if (!stat.isDirectory()) return false;
  }
  const stat = lstatOrNull(join(workTree, path));
  if (!stat) return true;
  return stat.isDirectory() && readdirSync(join(workTree, path)).length === 0;
};

/**
 * What an index stages: each entry's tag, mode, object id, stage and path (`ls-files -s -v`), and not
 * its stat cache. A `git status` that refreshes the cache leaves this unchanged; staging anything,
 * marking an entry, or removing one changes it (ACP-WORKER-06). `GIT_OPTIONAL_LOCKS=0` keeps the read
 * from rewriting the index it reads.
 */
export const stagedContent = async (repo: PinnedRepository, index?: string): Promise<string> =>
  digestOf((await must(repo, ["ls-files", "-s", "-v", "-z"], index ? { index } : {})).split("\0").filter(Boolean));

/** Paths an index stages against a tree; read from the index alone, never the worktree. */
export const stagedAgainst = async (repo: PinnedRepository, treeIsh: string, index?: string): Promise<string[]> =>
  (await must(repo, ["diff-index", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", treeIsh], index ? { index } : {}))
    .split("\0")
    .filter(Boolean);

/**
 * One copy of the real index, taken in a single read (ACP-WORKER-06). Git replaces an index by
 * renaming a new file over it, never by rewriting it in place, so the copy is one whole index: every
 * question preparation asks of the index — is anything staged, what is the baseline — is asked of this
 * one snapshot, and nothing staged between two reads can become the baseline. An absent index is an
 * empty one, which stages the deletion of every tracked path and so is never clean.
 */
export const indexSnapshot = (repo: PinnedRepository, label: string): string => {
  const snapshot = join(repo.scratch, `${label}.snapshot.index`);
  rmSync(snapshot, { force: true });
  const real = join(repo.gitDir, "index");
  if (lstatOrNull(real)) copyFileSync(real, snapshot);
  return snapshot;
};

/** The control plane's commit of a verified change. Injectable so a failing commit can be measured. */
export interface WorkerCommitPort {
  commit(
    repo: PinnedRepository,
    input: {
      baseHead: string;
      branch: string;
      entries: readonly WorkerDiffEntry[];
      message: string;
      format: "sha1" | "sha256";
      /** `stagedContent` of the real index before the turn; the commit refuses if it has changed. */
      stagedBaseline: string;
      /**
       * The live authority fence (ACP-WORKER-03), asked under the index lock immediately before the
       * branch moves. A refusal commits nothing.
       */
      stillAuthorized: () => Decision<void>;
      /**
       * #1268 — CommitLore's procedure around this commit, for a run whose contract requires it. `consider`
       * gets the private index once it stages exactly `entries`, before any commit object exists, and
       * answers the message to commit; a refusal commits nothing. `settle` gets the commit once the branch
       * and the index are at it; a refusal leaves that commit where it is and reports it.
       */
      commitlore?: WorkerCommitLoreStep;
    },
  ): Promise<Decision<string>>;
}

/** #1268 — see `WorkerCommitPort`'s `commitlore`. */
export interface WorkerCommitLoreStep {
  consider(index: string, message: string): Promise<Decision<string>>;
  settle(commit: string): Promise<Decision<unknown>>;
}

/**
 * Commits exactly `entries` on top of `baseHead`, through plumbing over a private index: no filter,
 * no hook, no worktree read by git. Each blob is written from bytes read here and must hash to the id
 * the change was verified with.
 *
 * The real index is never replaced wholesale (ACP-WORKER-06). It is locked the way git locks it — its
 * `index.lock` created exclusively — and a lock someone else holds means another writer is at work:
 * nothing is committed. Under the lock its staged content must still be the turn's baseline, so no
 * one's staged work is overwritten; the branch then moves from `baseHead` (`update-ref` with its old
 * value), and only the committed paths are updated, in a copy of the real index that replaces it
 * through the lock. Every other entry, its stat cache included, is kept as it was.
 */
export const plumbingWorkerCommit: WorkerCommitPort = {
  commit: async (repo, input) => {
    const realIndex = join(repo.gitDir, "index");
    const lock = `${realIndex}.lock`;
    let held = false;
    try {
      const index = join(repo.scratch, "commit.index");
      await must(repo, ["read-tree", input.baseHead], { index });
      const lines: string[] = [];
      for (const entry of input.entries) {
        if (entry.mode === null) {
          lines.push(`0 ${ZERO_OID[input.format]}\t${entry.path}`);
          continue;
        }
        const full = join(repo.workTree, entry.path);
        const bytes = entry.mode === "120000" ? Buffer.from(readlinkSync(full)) : readFileSync(full);
        const written = (await must(repo, ["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes })).trim();
        if (written !== entry.blob) {
          return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "a file changed between verification and the commit", { paths: [entry.path] });
        }
        lines.push(`${entry.mode} ${written}\t${entry.path}`);
      }
      const indexInfo = lines.map((line) => `${line}\0`).join("");
      await must(repo, ["update-index", "-z", "--index-info"], { index, input: indexInfo });
      // #1268 — CommitLore considers exactly the tree this commit will have, before the commit exists.
      let message = input.message;
      if (input.commitlore) {
        const considered = await input.commitlore.consider(index, input.message);
        if (!considered.allowed) {
          return deny(considered.reasonCode, considered.message, { ...considered.evidence, committed: false });
        }
        message = considered.value;
      }
      const tree = (await must(repo, ["write-tree"], { index })).trim();
      const commit = (await must(repo, ["commit-tree", tree, "-p", input.baseHead, "--no-gpg-sign", "-m", message])).trim();

      try {
        writeFileSync(lock, "", { flag: "wx", mode: 0o644 });
        held = true;
        repo.children.holdIndexLock(lock);
      } catch (error) {
        return deny(ReasonCode.CONFLICT, "the worktree's index is locked by another writer; nothing was committed", {
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
      const copy = join(repo.scratch, "real.index");
      if (lstatOrNull(realIndex)) copyFileSync(realIndex, copy);
      if ((await stagedContent(repo, copy)) !== input.stagedBaseline) {
        return deny(ReasonCode.WRITE_EFFECT_FENCE_LOST, "the index's staged content changed during the turn; nothing was committed", {});
      }
      // Asked last, with nothing awaited between it and the ref update: authority withdrawn at any
      // earlier point — a daemon that began to stop, an execution ended elsewhere — commits nothing.
      const authority = input.stillAuthorized();
      if (!authority.allowed) {
        return deny(authority.reasonCode, `${authority.message}; nothing was committed`, { ...authority.evidence, committed: false });
      }
      const moved = await runPinnedGit(repo, ["update-ref", "-m", "agent-control-plane: worker commit", `refs/heads/${input.branch}`, commit, input.baseHead]);
      if (moved.exitCode !== 0) {
        return deny(ReasonCode.INTERNAL_ERROR, "the branch could not be moved to the worker commit", {
          exitCode: moved.exitCode,
          error: moved.stderr.slice(0, 500),
        });
      }
      const updated = await runPinnedGit(
        repo,
        ["-c", "core.splitIndex=false", "update-index", "--no-split-index", "-z", "--index-info"],
        { index: copy, input: indexInfo },
      );
      if (updated.exitCode !== 0) {
        return deny(ReasonCode.INTERNAL_ERROR, "the worker commit exists, but the worktree's index could not be updated; it is left as it was", {
          head: commit,
          error: updated.stderr.slice(0, 500),
        });
      }
      // A stopping daemon that closed the repository has already let the index lock go: publish nothing.
      if (repo.children.closed) {
        return deny(ReasonCode.CONFLICT, "the turn's repository was closed by a stopping daemon; the index was not published", {
          head: commit,
        });
      }
      const descriptor = openSync(lock, "w");
      try {
        writeSync(descriptor, readFileSync(copy));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(lock, realIndex);
      held = false;
      repo.children.holdIndexLock(null);
      if (input.commitlore) {
        const settled = await input.commitlore.settle(commit);
        if (!settled.allowed) {
          return deny(settled.reasonCode, `the worker commit exists, and CommitLore did not settle it: ${settled.message}`, {
            ...settled.evidence,
            head: commit,
          });
        }
      }
      return allow(ReasonCode.OK, commit);
    } catch (error) {
      return deny(ReasonCode.INTERNAL_ERROR, "the worker commit could not be written", {
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } finally {
      // Only a lock this commit still holds: one a stopping daemon released may be someone else's by now.
      if (held && repo.children.holdsIndexLock(lock)) {
        rmSync(lock, { force: true });
        repo.children.holdIndexLock(null);
      }
    }
  },
};

/** `git diff-tree -r -z --raw`: `:oldmode newmode oldoid newoid status` then the path. */
export const committedChanges = async (
  repo: PinnedRepository,
  base: string,
  head: string,
): Promise<Array<{ path: string; mode: string | null; blob: string | null }>> => {
  const raw = await must(repo, ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--raw", "--no-ext-diff", "--no-textconv", base, head]);
  const fields = raw.split("\0").filter((field) => field.length > 0);
  const out: Array<{ path: string; mode: string | null; blob: string | null }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!.replace(/^:/, "").split(" ");
    const deleted = (meta[4] ?? "").startsWith("D");
    out.push({ path: fields[index + 1]!, mode: deleted ? null : (meta[1] ?? null), blob: deleted ? null : (meta[3] ?? null) });
  }
  return out;
};

export const parentOf = async (repo: PinnedRepository, commit: string): Promise<string | null> => {
  const run = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", `${commit}^1`]);
  return run.exitCode === 0 ? run.stdout.trim() : null;
};
