import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  readonly #groups = new Map<number, { child: ChildProcess; leaderExited: boolean; leaderStartedAt: string | null }>();
  #heldIndexLock: string | null = null;

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

  /** Records a child's group the moment the child is spawned. */
  track(child: ChildProcess): void {
    const pgid = child.pid;
    if (pgid === undefined) return;
    const entry = { child, leaderExited: false, leaderStartedAt: readProcessStartToken(pgid) };
    this.#groups.set(pgid, entry);
    child.once("exit", () => {
      entry.leaderExited = true;
      // Released only when nothing is left in the group; a descendant keeps it registered.
      if (groupGone(pgid, entry)) this.#groups.delete(pgid);
    });
  }

  /** Groups still registered after dropping every one confirmed empty. */
  liveGroups(): GitProcessGroup[] {
    for (const [pgid, entry] of this.#groups) {
      if (groupGone(pgid, entry)) this.#groups.delete(pgid);
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
    for (const [pgid] of entries) if (stopped(pgid)) this.#groups.delete(pgid);
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
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a stopping daemon can stop it whole (ACP-WORKER-03).
      child = spawn("git", [...GIT_HARDENING, ...args], { cwd: repo.workTree, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      repo.children.track(child);
    } catch (error) {
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
    child.stdin?.end(options.input ?? "");
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
 * Every entry of the pinned git dir(s): path, kind, size, mtime, inode, and a symlink's target. The
 * index is left out: the provider CLI's own `git status` rewrites its stat cache, and the control
 * plane never reads the real index after a turn.
 */
export const gitDirFingerprint = (repo: PinnedRepository): string => {
  const roots = [...new Set([repo.commonDir, repo.gitDir])];
  const entries: string[] = [];
  const worktreesRoot = join(repo.commonDir, "worktrees");
  // The directories that hold an index: the pinned git dir, the common dir, and each linked worktree's.
  const holdsIndex = (dir: string): boolean => dir === repo.gitDir || dir === repo.commonDir || dirname(dir) === worktreesRoot;
  const walk = (root: string, dir: string, depth: number): void => {
    if (depth > 64) throw new Error("the git dir is nested too deeply to fingerprint");
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if ((name === "index" || name === "index.lock") && stat.isFile() && holdsIndex(dir)) continue;
      const kind = stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : stat.isFile() ? "f" : "o";
      entries.push(`${root}\0${path.slice(root.length + 1)}\0${kind}\0${stat.size}\0${stat.mtimeMs}\0${stat.ino}\0${stat.mode}\0${kind === "l" ? readlinkSync(path) : ""}`);
      if (kind === "d") walk(root, path, depth + 1);
    }
  };
  for (const root of roots) walk(root, root, 0);
  return digestOf(entries);
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
    },
  ): Promise<Decision<string>>;
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
      const tree = (await must(repo, ["write-tree"], { index })).trim();
      const commit = (await must(repo, ["commit-tree", tree, "-p", input.baseHead, "--no-gpg-sign", "-m", input.message])).trim();

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
