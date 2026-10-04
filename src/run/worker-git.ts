import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { digestOf, sha256 } from "../core/digest.ts";
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
}

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
  return allow(ReasonCode.OK, Object.freeze({ workTree: tree, gitDir, commonDir, dotGit: dotGitFingerprint(tree)!, scratch }));
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
  options: { index?: string; input?: string | Buffer; timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): Promise<GitRun> =>
  new Promise((resolveRun) => {
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
      child = spawn("git", [...GIT_HARDENING, ...args], { cwd: repo.workTree, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolveRun({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
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
  for (const [path, base] of tracked) {
    if (base.type !== "blob") continue;
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
  };
};

/** Paths the real index stages against a tree; read from the index alone, never the worktree. */
export const stagedAgainst = async (repo: PinnedRepository, treeIsh: string): Promise<string[]> =>
  (await must(repo, ["diff-index", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", treeIsh]))
    .split("\0")
    .filter(Boolean);

/** The control plane's commit of a verified change. Injectable so a failing commit can be measured. */
export interface WorkerCommitPort {
  commit(
    repo: PinnedRepository,
    input: { baseHead: string; branch: string; entries: readonly WorkerDiffEntry[]; message: string; format: "sha1" | "sha256" },
  ): Promise<Decision<string>>;
}

/**
 * Commits exactly `entries` on top of `baseHead`, through plumbing over a private index: no filter,
 * no hook, no worktree read by git. Each blob is written from bytes read here and must hash to the id
 * the change was verified with. The branch moves only from `baseHead` (`update-ref` with its old
 * value), and only then is the real index replaced by the new tree.
 */
export const plumbingWorkerCommit: WorkerCommitPort = {
  commit: async (repo, input) => {
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
      await must(repo, ["update-index", "-z", "--index-info"], { index, input: lines.map((line) => `${line}\0`).join("") });
      const tree = (await must(repo, ["write-tree"], { index })).trim();
      const commit = (await must(repo, ["commit-tree", tree, "-p", input.baseHead, "--no-gpg-sign", "-m", input.message])).trim();
      const moved = await runPinnedGit(repo, ["update-ref", "-m", "agent-control-plane: worker commit", `refs/heads/${input.branch}`, commit, input.baseHead]);
      if (moved.exitCode !== 0) {
        return deny(ReasonCode.INTERNAL_ERROR, "the branch could not be moved to the worker commit", {
          exitCode: moved.exitCode,
          error: moved.stderr.slice(0, 500),
        });
      }
      const indexed = await runPinnedGit(repo, ["read-tree", commit]);
      if (indexed.exitCode !== 0) {
        return deny(ReasonCode.INTERNAL_ERROR, "the worker commit exists, but the worktree's index could not be moved to it", {
          head: commit,
          error: indexed.stderr.slice(0, 500),
        });
      }
      return allow(ReasonCode.OK, commit);
    } catch (error) {
      return deny(ReasonCode.INTERNAL_ERROR, "the worker commit could not be written", {
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
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
