import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

import { readProcessArgv, readProcessStartToken } from "../core/process-argv.ts";

/**
 * One project, one CTO process (owner directive 2026-11-18). This is the single check every door that
 * can start or admit a CTO asks: the resident provisioner before it creates a tmux session, the
 * canonical rotation launcher before it starts the target, the daemon's claim before it binds a
 * claimant, and the doctor when it looks for two. Nothing here is copied into a caller; a caller passes
 * a role scope and a reader and gets the answer.
 *
 * A live process belongs to a project's CTO role when any of these holds, however it was started:
 *   - it is a claude process whose argv resumes or names one of the role's conversation ids;
 *   - it is an interactive claude process whose working directory is one of the project's checkouts;
 *   - it is the bound session's OS process (`sessions.os_pid` with its recorded start).
 *
 * What a process is, and what it was asked to do, is read from its real argv, one element at a time
 * (`CtoProcessReader.argv`, the kernel's own copy), rather than from `ps`'s whitespace-joined text: prompt text
 * such as "Explain how -p works" or one that quotes `--resume <uuid>` is a single element and is never a
 * flag. `ps` supplies only the table and the start times. A claude-looking process whose argv cannot be
 * read is not guessed at: the snapshot is UNREADABLE.
 *
 * Runs from source under Node's type stripping (the host scripts import it), so it holds only erasable
 * syntax and node builtins. A read that fails is never an empty table: `snapshotCtoProcesses` says
 * UNREADABLE and each caller decides, launches refusing and the doctor reporting UNKNOWN.
 */

export const CTO_ALREADY_RUNNING = "CTO_ALREADY_RUNNING";
export const CTO_PROCESS_TABLE_UNREADABLE = "CTO_PROCESS_TABLE_UNREADABLE";

export interface CtoProcess {
  pid: number;
  ppid: number;
  uid: number;
  /** `ps -o lstart=` text, in the C locale. */
  startedAt: string;
  /** `ps`'s rendering of the command line: evidence and a cheap filter only, never what decides anything. */
  command: string;
}

export interface CtoRoleScope {
  projectId: string;
  /** Claude conversation ids (UUIDs) of this role: the current one, the ones switched over from, the one being started. */
  conversationIds: readonly string[];
  /** Absolute checkout paths of the project. */
  checkouts: readonly string[];
  /** The bound session's process, as recorded: its pid and the start it was recorded with (lstart text or native token). */
  bound: ReadonlyArray<{ pid: number; startedAt: string | null }>;
}

/** A process a door expects and so does not count: this pid, and only while it still has this start (lstart text or native token). */
export interface ExpectedProcess {
  pid: number;
  startedAt: string;
}

export interface CtoProcessReader {
  /** Every process of the host. Throws when the table cannot be read. */
  table(): Promise<CtoProcess[]>;
  /** The kernel's own argv of a pid, element by element. Null when it cannot be read (gone, denied, or no such interface). */
  argv(pid: number): readonly string[] | null | Promise<readonly string[] | null>;
  /** Working directories of the given pids. A pid with no entry is gone; throws when the read fails. */
  cwds(pids: readonly number[]): Promise<Map<number, string>>;
  /** Pane pid to tmux session name, for evidence only. Never throws; unreadable is empty. */
  tmuxPanes(): Promise<Map<number, string>>;
  /** Whether a pid is a live process: one that has exited, and is only waiting to be reaped, is not. */
  alive(pid: number): boolean | Promise<boolean>;
  /** The native start token of a pid, or null. */
  startToken(pid: number): string | null;
}

export interface CtoMatch {
  pid: number;
  startedAt: string;
  /** The conversation id the process's own argv names, when it names one. */
  conversationId: string | null;
  tmuxSession: string | null;
  matchedBy: Array<"conversation" | "cwd" | "bound-pid">;
}

/** What a claude process's real argv says it is. */
export interface ClaudeProcess {
  argv: readonly string[];
  /** Holds a conversation: not a subcommand, not a headless `-p` query. */
  interactive: boolean;
  /** The ids its `--resume`, `-r` and `--session-id` elements name. */
  conversationIds: readonly string[];
}

export interface CtoProcessSnapshot {
  rows: readonly CtoProcess[];
  /** The claude processes among them, by pid, from their real argv. */
  claude: ReadonlyMap<number, ClaudeProcess>;
  /** Working directory of each interactive claude process this uid owns. */
  cwd: ReadonlyMap<number, string>;
  tmux: ReadonlyMap<number, string>;
  startToken: (pid: number) => string | null;
}

export type CtoSnapshotResult =
  | { ok: true; snapshot: CtoProcessSnapshot }
  | { ok: false; detail: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_VERSIONED_CLAUDE = /^.+\/claude\/versions\/\d+\.\d+\.\d+$/;
/** `claude <subcommand>` runs a short command, not a conversation: it is never a CTO. */
const CLAUDE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "mcp", "config", "doctor", "update", "upgrade", "install", "migrate-installer", "setup-token", "plugin", "plugins", "agents", "auth",
]);
/** Options that take every following non-option element as values: a prompt after one is read as one of them, so the launch's own prompt follows another option. */
const LIST_FLAGS: ReadonlySet<string> = new Set([
  "--mcp-config", "--dangerously-load-development-channels", "--channels", "--add-dir", "--allowed-tools", "--allowedTools",
  "--disallowed-tools", "--disallowedTools", "--plugin-dir", "--betas", "--tools",
]);
/** Options whose next element is their value, never a flag and never the prompt. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--model", "--name", "-n", "--messaging-socket-path", "--remote-control", "--permission-mode", "--effort", "--input-format",
  "--system-prompt", "--append-system-prompt", "--settings", "--setting-sources", "--max-turns", "--agents", "--fallback-model",
  "--session-id", "--resume", "-r", "--output-format", "--mcp-debug-file", "--debug-file",
]);

/** The argv from the claude executable on (past a leading `env VAR=value`), or null when the process is not claude. */
const claudeArgv = (argv: readonly string[]): readonly string[] | null => {
  let at = 0;
  if (/(^|\/)env$/.test(argv[0] ?? "")) {
    at = 1;
    while (at < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[at]!)) at += 1;
  }
  const executable = argv[at];
  if (executable === undefined) return null;
  return /(^|\/)claude$/.test(executable) || NATIVE_VERSIONED_CLAUDE.test(executable) ? argv.slice(at) : null;
};

/**
 * What a process is from its real argv, or null when it is not claude. Decided on whole elements only:
 * `-p` and `--print` make it headless when they are elements of their own before the prompt, the first
 * element that is neither an option nor an option's value (a prompt that merely contains "-p" is one
 * element, and is not one); `--resume`, `-r` and `--session-id` name a conversation when an element is
 * exactly that flag and the next is exactly a UUID, or one element is `--resume=<uuid>`. Nothing after a
 * bare `--` is an option.
 */
export const parseClaudeArgv = (argv: readonly string[]): ClaudeProcess | null => {
  const claude = claudeArgv(argv);
  if (claude === null) return null;
  const boundary = claude.indexOf("--");
  const end = boundary === -1 ? claude.length : boundary;
  const conversationIds: string[] = [];
  for (let at = 1; at < end; at += 1) {
    const element = claude[at]!;
    const attached = /^(?:--resume|--session-id)=(.*)$/.exec(element);
    if (attached !== null) { if (UUID.test(attached[1]!)) conversationIds.push(attached[1]!.toLowerCase()); continue; }
    if ((element === "--resume" || element === "-r" || element === "--session-id") && claude[at + 1] !== undefined && UUID.test(claude[at + 1]!)) {
      conversationIds.push(claude[at + 1]!.toLowerCase());
      at += 1;
    }
  }
  const second = claude[1];
  let interactive = !(second !== undefined && !second.startsWith("-") && CLAUDE_SUBCOMMANDS.has(second));
  for (let at = 1; interactive && at < end; at += 1) {
    const element = claude[at]!;
    if (element === "-p" || element === "--print" || element.startsWith("--print=")) { interactive = false; break; }
    if (!element.startsWith("-")) break;
    if (element.includes("=")) continue;
    if (LIST_FLAGS.has(element)) {
      while (at + 1 < end && !claude[at + 1]!.startsWith("-")) at += 1;
    } else if (VALUE_FLAGS.has(element) && at + 1 < end && !claude[at + 1]!.startsWith("-")) {
      at += 1;
    }
  }
  return { argv: claude, interactive, conversationIds };
};

const sameDirectory = (observed: string, checkout: string): boolean => {
  const strip = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  if (strip(observed) === strip(checkout)) return true;
  try { return realpathSync(checkout) === strip(observed); } catch { return false; }
};

/**
 * The role's live processes, from one snapshot. `expected` names the processes a door expects and does not
 * count (the claimant re-attaching, the old CTO a rotation is replacing). A process is excluded only while
 * its pid AND its start still match what the door recorded, so a pid that has since been reused by another
 * process is counted like any other. Nothing else is excluded.
 */
export const ctoProcessesFor = (
  scope: CtoRoleScope,
  snapshot: CtoProcessSnapshot,
  expected: readonly ExpectedProcess[] = [],
): CtoMatch[] => {
  const wanted = new Set(scope.conversationIds.map((id) => id.toLowerCase()));
  const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]));
  const matches: CtoMatch[] = [];
  for (const row of snapshot.rows) {
    if (row.pid === process.pid) continue;
    if (expected.some((one) => one.pid === row.pid && (one.startedAt === row.startedAt || one.startedAt === snapshot.startToken(row.pid)))) continue;
    const claude = snapshot.claude.get(row.pid);
    const named = claude?.conversationIds ?? [];
    const matchedBy: CtoMatch["matchedBy"] = [];
    if (named.some((id) => wanted.has(id))) matchedBy.push("conversation");
    const cwd = claude?.interactive === true ? snapshot.cwd.get(row.pid) : undefined;
    if (cwd !== undefined && scope.checkouts.some((checkout) => sameDirectory(cwd, checkout))) matchedBy.push("cwd");
    const bound = scope.bound.find((one) => one.pid === row.pid);
    if (bound !== undefined && (bound.startedAt === null || bound.startedAt === row.startedAt || bound.startedAt === snapshot.startToken(row.pid))) {
      matchedBy.push("bound-pid");
    }
    if (matchedBy.length === 0) continue;
    let tmuxSession: string | null = null;
    for (let at: number | undefined = row.pid, hops = 0; at !== undefined && hops < 64 && tmuxSession === null; hops += 1) {
      tmuxSession = snapshot.tmux.get(at) ?? null;
      at = byPid.get(at)?.ppid;
    }
    matches.push({
      pid: row.pid,
      startedAt: row.startedAt,
      conversationId: named.find((id) => wanted.has(id)) ?? named[0] ?? null,
      tmuxSession,
      matchedBy,
    });
  }
  return matches.sort((a, b) => a.pid - b.pid);
};

/**
 * Reads the host's processes once. A failure to read the table, a table that does not contain this
 * very process, a process that looks like claude whose argv cannot be read, or a working-directory read
 * that leaves a live interactive claude without an answer is UNREADABLE, never an empty or partial table.
 */
export const snapshotCtoProcesses = async (reader: CtoProcessReader): Promise<CtoSnapshotResult> => {
  let rows: CtoProcess[];
  try { rows = await reader.table(); } catch (error) { return { ok: false, detail: `process table: ${describe(error)}` }; }
  if (!rows.some((row) => row.pid === process.pid)) return { ok: false, detail: "process table: this process is not in it" };
  const own = process.getuid?.();
  const claude = new Map<number, ClaudeProcess>();
  // The rendered command is only a filter: a process whose text never says claude is not claude. Whether it is, and what
  // it was asked to do, comes from its argv. Another user's processes are not ours to read, and cannot resume our transcript.
  for (const row of rows) {
    if (row.pid === process.pid || (own !== undefined && row.uid !== own) || !/claude/i.test(row.command)) continue;
    const argv = await reader.argv(row.pid);
    if (argv === null) {
      if (await reader.alive(row.pid)) return { ok: false, detail: `argv of pid ${row.pid} was not readable` };
      continue;
    }
    const parsed = parseClaudeArgv(argv);
    if (parsed !== null) claude.set(row.pid, parsed);
  }
  const interactive = [...claude].filter(([, one]) => one.interactive).map(([pid]) => pid);
  const cwd = new Map<number, string>();
  if (interactive.length > 0) {
    let read: Map<number, string>;
    try { read = await reader.cwds(interactive); } catch (error) { return { ok: false, detail: `working directories: ${describe(error)}` }; }
    for (const pid of interactive) {
      const observed = read.get(pid);
      if (observed !== undefined) cwd.set(pid, observed);
      else if (await reader.alive(pid)) return { ok: false, detail: `working directory of claude pid ${pid} was not answered` };
    }
  }
  return { ok: true, snapshot: { rows, claude, cwd, tmux: await reader.tmuxPanes(), startToken: (pid) => reader.startToken(pid) } };
};

export type OneCtoVerdict =
  | { ok: true }
  | { ok: false; reasonCode: typeof CTO_ALREADY_RUNNING; projectId: string; processes: CtoMatch[]; message: string }
  | { ok: false; reasonCode: typeof CTO_PROCESS_TABLE_UNREADABLE; projectId: string; detail: string; message: string };

/** The refusal text, in the one shape every door writes: the code, the project, then each process's evidence. */
export const describeCtoMatches = (matches: readonly CtoMatch[]): string =>
  matches.map((one) => `pid=${one.pid} started="${one.startedAt}" conversation=${one.conversationId ?? "none"} tmux=${one.tmuxSession ?? "none"} by=${one.matchedBy.join("+")}`).join("; ");

/**
 * Whether the project's CTO role may have another process. Refuses when any process other than the
 * expected ones matches the role, and refuses when the process table cannot be read.
 */
export const assertNoOtherCtoProcess = async (
  scope: CtoRoleScope,
  reader: CtoProcessReader = systemCtoProcessReader(),
  expected: readonly ExpectedProcess[] = [],
): Promise<OneCtoVerdict> => {
  const read = await snapshotCtoProcesses(reader);
  if (!read.ok) {
    return { ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE, projectId: scope.projectId, detail: read.detail,
      message: `${CTO_PROCESS_TABLE_UNREADABLE}: project ${scope.projectId}: ${read.detail}` };
  }
  const processes = ctoProcessesFor(scope, read.snapshot, expected);
  if (processes.length === 0) return { ok: true };
  return { ok: false, reasonCode: CTO_ALREADY_RUNNING, projectId: scope.projectId, processes,
    message: `${CTO_ALREADY_RUNNING}: project ${scope.projectId} already has a CTO process: ${describeCtoMatches(processes)}` };
};

/** The shape a host script writes on stderr and the daemon reads back; nothing else of the child's output crosses. */
const REFUSAL_LINE = /^host project provisioner refused operation: ((?:CTO_ALREADY_RUNNING|CTO_PROCESS_TABLE_UNREADABLE): [^\n]{1,2000})\n?$/;
export const ctoRefusalOfStderr = (stderr: string): string | null => REFUSAL_LINE.exec(stderr)?.[1] ?? null;

const describe = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? `read failed (${code})` : "read failed";
};

// ---------------------------------------------------------------------------
// The host's own readers. ps and lsof, which answer under launchd as they do in a shell.
// ---------------------------------------------------------------------------

const exec = promisify(execFile);
const PS_BUDGET_MS = 10_000;
const LSOF_BUDGET_MS = 15_000;
const TMUX_BUDGET_MS = 5_000;
/** A tool by name, and by its system path when the launching environment's PATH does not hold it (launchd's is short). Always bounded. */
const run = async (name: string, system: string, args: string[], timeout: number, maxBuffer: number, env?: NodeJS.ProcessEnv): Promise<{ stdout: string }> => {
  try {
    return await exec(name, args, { encoding: "utf8", timeout, maxBuffer, ...(env === undefined ? {} : { env }) });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return exec(system, args, { encoding: "utf8", timeout, maxBuffer, ...(env === undefined ? {} : { env }) });
  }
};
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s?(.*)$/;

export const parseProcessTable = (text: string): CtoProcess[] => {
  const rows: CtoProcess[] = [];
  for (const line of text.split("\n")) {
    const match = PS_ROW.exec(line);
    // A zombie has exited and can write nothing.
    if (match !== null && !match[4]!.startsWith("Z")) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startedAt: match[5]!, command: match[6]! });
    }
  }
  return rows;
};

export const parseLsofCwds = (text: string): Map<number, string> => {
  const found = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null && Number.isSafeInteger(pid) && !found.has(pid)) found.set(pid, line.slice(1));
  }
  return found;
};

const ARGV_TRIES = 8;
const ARGV_RETRY_MS = 25;

/** Whether a pid is a live process. Signal 0 says a pid exists; a process that has exited and not yet been reaped exists to it too, so `ps` is asked its state. */
const processExists = async (pid: number): Promise<boolean> => {
  try { process.kill(pid, 0); } catch (error) { return (error as { code?: unknown }).code === "EPERM"; }
  try {
    const { stdout } = await run("ps", "/bin/ps", ["-o", "stat=", "-p", String(pid)], PS_BUDGET_MS, 64 * 1024);
    return stdout.trim() !== "" && !stdout.trim().startsWith("Z");
  } catch (error) {
    // `ps -p` exits 1 for a pid that is not there; any other failure is no answer, and no answer is alive.
    return (error as { code?: unknown }).code !== 1;
  }
};

export const systemCtoProcessReader = (): CtoProcessReader => ({
  async table() {
    // Unlimited width, so no command is cut short; the C locale, so the start time parses.
    const { stdout } = await run("ps", "/bin/ps", ["-axww", "-o", "pid=,ppid=,uid=,stat=,lstart=,command="],
      PS_BUDGET_MS, 256 * 1024 * 1024, { ...process.env, LC_ALL: "C" });
    return parseProcessTable(stdout);
  },
  async cwds(pids) {
    let stdout = "";
    try {
      ({ stdout } = await run("lsof", "/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], LSOF_BUDGET_MS, 16 * 1024 * 1024));
    } catch (error) {
      // lsof exits 1 when some pid it was asked for is gone, and still prints the others; a timeout or a spawn failure prints nothing usable.
      const failed = error as { code?: unknown; killed?: boolean; stdout?: unknown };
      if (failed.code !== 1 || failed.killed === true || typeof failed.stdout !== "string") throw error;
      stdout = failed.stdout;
    }
    return parseLsofCwds(stdout);
  },
  async tmuxPanes() {
    const panes = new Map<number, string>();
    try {
      const { stdout } = await exec("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{session_name}"],
        { encoding: "utf8", timeout: TMUX_BUDGET_MS, maxBuffer: 4 * 1024 * 1024 });
      for (const line of stdout.split("\n")) {
        const match = /^(\d+) (.+)$/.exec(line);
        if (match !== null) panes.set(Number(match[1]), match[2]!);
      }
    } catch { /* Evidence only: a host with no tmux server names no session. */ }
    return panes;
  },
  async argv(pid) {
    // The kernel's argv read is a size probe and then a fetch, and it fails now and then on a live process: on one with a very large
    // argv (a CTO launched with its boot packet is over 100 KB) the two disagree (measured at one null in 600 reads), and on one that
    // has only just been exec'd, or is being reaped, there is nothing settled to read yet. A read is tried again, a moment apart,
    // before a process is called unreadable; a process that has exited ends the tries.
    for (let attempt = 0; attempt < ARGV_TRIES; attempt += 1) {
      const argv = readProcessArgv(pid);
      if (argv !== null) return argv;
      if (!(await processExists(pid))) return null;
      await new Promise<void>((resolve) => { setTimeout(resolve, ARGV_RETRY_MS); });
    }
    return null;
  },
  alive: processExists,
  startToken: readProcessStartToken,
});

// ---------------------------------------------------------------------------
// The role's scope, from the daemon's database.
// ---------------------------------------------------------------------------

export type RoleScopeQuery = <T>(sql: string, params: readonly unknown[]) => T[];

/**
 * What names a project's CTO in the database: every conversation that held or was entitled to the role
 * (a conversation switched over from still counts, because it must not be running either), the
 * project's registered checkouts and the bound session's process. A table this database does not have
 * names nothing. `extra` adds what a door already knows: the conversation it is about to start, its cwd.
 */
export const ctoRoleScope = (
  query: RoleScopeQuery,
  projectId: string,
  extra: { conversationIds?: readonly string[]; checkouts?: readonly string[] } = {},
): CtoRoleScope => {
  const rows = <T>(sql: string): T[] => {
    try { return query<T>(sql, [projectId]); } catch { return []; }
  };
  const conversationIds = new Set<string>((extra.conversationIds ?? []).map((id) => id.toLowerCase()));
  for (const row of rows<{ id: string }>(
    `SELECT DISTINCT tb.target_locator AS id FROM assignments a JOIN actor_target_bindings tb ON tb.target_actor_id = a.actor_id
      WHERE a.role = 'PRIMARY_CTO' AND a.project_id = ? AND tb.executor_kind = 'claude-cli'`,
  )) conversationIds.add(row.id.toLowerCase());
  for (const row of rows<{ id: string }>(`SELECT session_uuid AS id FROM canonical_session_entitlements WHERE project_id = ?`)) conversationIds.add(row.id.toLowerCase());
  for (const column of ["from_session_uuid", "to_session_uuid"]) {
    for (const row of rows<{ id: string }>(`SELECT ${column} AS id FROM canonical_entitlement_transfers WHERE project_id = ?`)) conversationIds.add(row.id.toLowerCase());
  }
  const checkouts = new Set<string>(extra.checkouts ?? []);
  for (const row of rows<{ path: string }>(`SELECT checkout_path AS path FROM repositories WHERE project_id = ? AND retired_at IS NULL`)) checkouts.add(row.path);
  const bound = rows<{ os_pid: number | null; os_process_started_at: string | null }>(
    `SELECT s.os_pid, s.os_process_started_at FROM assignments a
       JOIN conversational_actors c ON c.actor_id = a.actor_id
       JOIN sessions s ON s.session_id = COALESCE(c.current_session_id, a.session_id)
      WHERE a.role = 'PRIMARY_CTO' AND a.project_id = ? AND a.status = 'ACTIVE'`,
  ).filter((row) => row.os_pid !== null && Number.isSafeInteger(row.os_pid) && row.os_pid > 1)
    .map((row) => ({ pid: row.os_pid as number, startedAt: row.os_process_started_at }));
  return { projectId, conversationIds: [...conversationIds], checkouts: [...checkouts], bound };
};
