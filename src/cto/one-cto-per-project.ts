import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

import { readProcessStartToken } from "../core/process-argv.ts";

/**
 * One project, one CTO process (owner directive 2026-11-18). This is the single check every door that
 * can start or admit a CTO asks: the resident provisioner before it creates a tmux session, the
 * canonical rotation launcher before it starts the target, the daemon's claim before it binds a
 * claimant, and the doctor when it looks for two. Nothing here is copied into a caller; a caller passes
 * a role scope and a reader and gets the answer.
 *
 * A live process belongs to a project's CTO role when any of these holds, however it was started:
 *   - it is a claude process that resumes or names one of the role's conversation ids;
 *   - it is an interactive claude process whose working directory is one of the project's checkouts;
 *   - it is the bound session's OS process (`sessions.os_pid` with its recorded start).
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

export interface CtoProcessReader {
  /** Every process of the host. Throws when the table cannot be read. */
  table(): Promise<CtoProcess[]>;
  /** Working directories of the given pids. A pid with no entry is gone; throws when the read fails. */
  cwds(pids: readonly number[]): Promise<Map<number, string>>;
  /** Pane pid to tmux session name, for evidence only. Never throws; unreadable is empty. */
  tmuxPanes(): Promise<Map<number, string>>;
  /** Whether a pid still exists. */
  alive(pid: number): boolean;
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

export interface CtoProcessSnapshot {
  rows: readonly CtoProcess[];
  /** Working directory of each interactive claude process this uid owns. */
  cwd: ReadonlyMap<number, string>;
  tmux: ReadonlyMap<number, string>;
  startToken: (pid: number) => string | null;
}

export type CtoSnapshotResult =
  | { ok: true; snapshot: CtoProcessSnapshot }
  | { ok: false; detail: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_FLAG = new RegExp(`(?:^|\\s)(?:--resume|--session-id|-r)(?:\\s+|=)(${UUID})(?=\\s|$)`, "gi");
const NATIVE_VERSIONED_CLAUDE = /^.+\/claude\/versions\/\d+\.\d+\.\d+$/;
/** `claude <subcommand>` runs a short command, not a conversation: it is never a CTO. */
const CLAUDE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "mcp", "config", "doctor", "update", "upgrade", "install", "migrate-installer", "setup-token", "plugin", "plugins", "agents", "auth",
]);
/** Where a headless flag can sit: before the prompt, which is the last and longest part of a launch. */
const FLAG_REGION = 4096;

const claudeTokens = (command: string): string[] | null => {
  const tokens = command.trim().split(/\s+/);
  let index = 0;
  if (/(^|\/)env$/.test(tokens[0] ?? "")) {
    index = 1;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
  }
  const first = tokens[index];
  if (first === undefined) return null;
  return /(^|\/)claude$/.test(first) || NATIVE_VERSIONED_CLAUDE.test(first) ? tokens.slice(index) : null;
};

/** A process whose executable is claude, whatever it is doing. */
export const isClaudeProcess = (command: string): boolean => claudeTokens(command) !== null;

/** A claude process that holds a conversation: not a subcommand, not a headless `-p` query. */
export const isInteractiveClaude = (command: string): boolean => {
  const tokens = claudeTokens(command);
  if (tokens === null) return false;
  const second = tokens[1];
  if (second !== undefined && !second.startsWith("-") && CLAUDE_SUBCOMMANDS.has(second)) return false;
  const region = tokens.join(" ").slice(0, FLAG_REGION);
  return !/(^|\s)(?:-p|--print|--output-format)(?:\s|=|$)/.test(region);
};

/** Every conversation id the claude process's own argv resumes or names. */
export const conversationIdsNamedBy = (command: string): string[] => {
  if (!isClaudeProcess(command)) return [];
  return [...command.matchAll(CONVERSATION_FLAG)].map((match) => match[1]!.toLowerCase());
};

const sameDirectory = (observed: string, checkout: string): boolean => {
  const strip = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  if (strip(observed) === strip(checkout)) return true;
  try { return realpathSync(checkout) === strip(observed); } catch { return false; }
};

/**
 * The role's live processes, from one snapshot. `exclude` names pids that are the expected process
 * itself (the claimant re-attaching, the old CTO a rotation is replacing); nothing else is excluded.
 */
export const ctoProcessesFor = (
  scope: CtoRoleScope,
  snapshot: CtoProcessSnapshot,
  exclude: readonly number[] = [],
): CtoMatch[] => {
  const wanted = new Set(scope.conversationIds.map((id) => id.toLowerCase()));
  const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]));
  const matches: CtoMatch[] = [];
  for (const row of snapshot.rows) {
    if (exclude.includes(row.pid) || row.pid === process.pid) continue;
    const named = conversationIdsNamedBy(row.command);
    const matchedBy: CtoMatch["matchedBy"] = [];
    if (named.some((id) => wanted.has(id))) matchedBy.push("conversation");
    const cwd = snapshot.cwd.get(row.pid);
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
 * very process, or a working-directory read that leaves a live claude without an answer is UNREADABLE,
 * never an empty or partial table.
 */
export const snapshotCtoProcesses = async (reader: CtoProcessReader): Promise<CtoSnapshotResult> => {
  let rows: CtoProcess[];
  try { rows = await reader.table(); } catch (error) { return { ok: false, detail: `process table: ${describe(error)}` }; }
  if (!rows.some((row) => row.pid === process.pid)) return { ok: false, detail: "process table: this process is not in it" };
  const own = process.getuid?.();
  const candidates = rows.filter((row) => (own === undefined || row.uid === own) && isInteractiveClaude(row.command));
  const cwd = new Map<number, string>();
  if (candidates.length > 0) {
    let read: Map<number, string>;
    try { read = await reader.cwds(candidates.map((row) => row.pid)); } catch (error) { return { ok: false, detail: `working directories: ${describe(error)}` }; }
    for (const row of candidates) {
      const observed = read.get(row.pid);
      if (observed !== undefined) cwd.set(row.pid, observed);
      else if (reader.alive(row.pid)) return { ok: false, detail: `working directory of claude pid ${row.pid} was not answered` };
    }
  }
  return { ok: true, snapshot: { rows, cwd, tmux: await reader.tmuxPanes(), startToken: (pid) => reader.startToken(pid) } };
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
 * excluded ones matches the role, and refuses when the process table cannot be read.
 */
export const assertNoOtherCtoProcess = async (
  scope: CtoRoleScope,
  reader: CtoProcessReader = systemCtoProcessReader(),
  exclude: readonly number[] = [],
): Promise<OneCtoVerdict> => {
  const read = await snapshotCtoProcesses(reader);
  if (!read.ok) {
    return { ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE, projectId: scope.projectId, detail: read.detail,
      message: `${CTO_PROCESS_TABLE_UNREADABLE}: project ${scope.projectId}: ${read.detail}` };
  }
  const processes = ctoProcessesFor(scope, read.snapshot, exclude);
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
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: unknown }).code === "EPERM"; }
  },
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
