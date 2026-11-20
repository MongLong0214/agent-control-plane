import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Decision } from "../core/errors.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import {
  CTO_PROCESS_TABLE_UNREADABLE, assertNoOtherCtoProcess, ctoProcessesFor, ctoRoleScope, snapshotCtoProcesses, systemCtoProcessReader,
  type CtoMatch, type CtoProcessReader, type CtoProcessSnapshot, type CtoRoleScope, type ExpectedProcess,
} from "../cto/one-cto-per-project.ts";
import { fallbackHandoff, firstPromptOf, readHandoff, writeHandoff } from "../cto/cto-conversation.ts";
import { residentWorkerCheckoutPath } from "../core/resident-allocation-paths.ts";
import { daemonBuzzSigner } from "../outbox/ceo-buzz-signer.ts";
import { BUZZ_CHANNEL_SERVER, CHANNEL_DEV_FLAG, channelEmittedBy, channelLaunchArgs, confirmChannelStartup, launchFolderTrust, tmuxChannelDriver } from "../runtime/cto-channel-launch.ts";
import { readHostProvisionerReason, recordedResidentExitStatus } from "../runtime/host-provisioner-reason.ts";

/**
 * `agentctl cto` — one operator command group for a project CTO's whole life on this host: list, add, relaunch and
 * retire. It composes the pieces that already exist and reinvents none of them:
 *
 *   - ACP's own operator methods (`project.register`, `project.retire`) over the authenticated operator socket;
 *   - the host project provisioner (`ensure-routing`, `ensure-resident`, `acknowledge-resident-exit`), the launcher a
 *     resident CTO and the fleet watcher already use, which carries the acp-buzz-channel and resumes the conversation;
 *   - `src/runtime/cto-channel-launch.ts` (channel argv, folder trust, the one development-channels confirmation), with
 *     which a canonical CTO's one long-lived conversation is resumed in tmux rather than rotated to a new one (#1437 R1);
 *   - Hermes's `buzz-identity-map.sh`, which rebuilds channel-cto.map from the roster;
 *   - `tmux`, `git` and `gh` for the session, the checkouts and the repository.
 *
 * Every mutating subcommand prints its plan and changes nothing unless `--apply` is given. Applied, the steps run in
 * the plan's order; each reports done, skipped (already in the state it brings about) or failed, and the first failure
 * stops the run. Each step's "already done" is read from the world, so running the same command again continues where
 * it stopped. The one thing kept between runs is a canonical relaunch's target conversation, until it is verified.
 *
 * Operator only. `--apply` needs ACP_OPERATOR_TOKEN, which every CTO launch shell unsets and which the daemon must
 * authenticate before any step runs, and none of this is a tool on a CTO's acp-cto surface: a CTO cannot retire or
 * relaunch another.
 */

export const CTO_SUBCOMMANDS = ["list", "add", "relaunch", "retire"] as const;

export const CTO_USAGE = `agentctl cto — a project CTO's lifecycle on this host (operator only)

  agentctl cto list
      every CTO: project, binding generation, live session (pid, tmux), whether the session carries
      the acp-buzz-channel, its room, whether the roster routes that room, and its last Buzz activity
  agentctl cto add <project> [--repo <owner/name>] [--canonical] [--apply]
      register the project if missing (cloning --repo into ~/projects), check its Buzz identity and
      room, bind the roster, rebuild channel-cto.map, and start the CTO with the channel: a resident
      through ensure-resident (which writes the resident request and the fleet entry), a canonical
      CTO (--canonical) by resuming its existing conversation as relaunch does; a canonical CTO
      with no conversation yet is refused
  agentctl cto relaunch <project> [--conversation <id>] [--apply]
      wait for an idle CTO, then restart it with the channel, in the same conversation:
      a canonical CTO's folder must already be trusted; its exact claude process (pid and start
      time) is stopped and claude --resume <the role's bound conversation> is started with the
      channel in its tmux session (or a new detached one), its acp-cto entry claiming with
      --expected-binding-generation auto, so its queued messages are kept. No new conversation and
      no handoff package. A resident is stopped and started again by ensure-resident with --resume
      (this resident path overlaps #1447, which replaces it)
  agentctl cto relaunch <project> --fresh [--apply]
      the same relaunch for a canonical CTO, except it starts a NEW conversation (--session-id) whose first
      prompt is the stored handoff (cto_handoff_write; else a short one ACP writes from the binding and open
      runs). Refused while the project has running work. Nothing is rolled back on failure: the old
      conversation id is printed with the one command that resumes it:
      agentctl cto relaunch <project> --conversation <old id> --apply
  agentctl cto retire <project> --reason <text> [--delete-repo --yes-delete-repo <owner/name>] [--apply]
      wait for an idle CTO, then agentctl project retire (stops the session, releases the binding,
      archives its room, retires its roster route, takes it off the fleet), confirm the session,
      roster map, fleet manifest and tmux session are gone, and remove the worker checkouts and the
      archived local clone. Unless the repository is deleted too, a clone holding work found nowhere
      else is kept: the archived clone in place, a worker checkout moved beside it and listed.
      --delete-repo also runs gh repo delete, last; it is irreversible and needs --yes-delete-repo
      naming the repository exactly

  Without --apply nothing is changed: the plan is printed, with each step already done or not.
  --apply first asks the daemon to authenticate ACP_OPERATOR_TOKEN and refuses if it does not.
  With --apply each step prints done, skipped or failed, and the first failure stops the run;
  running the same command again continues from where it stopped. Output is one JSON object a line.
`;

/** What one subprocess answered. `status` is null when it could not be started or ran out of time. */
export interface CtoExecResult { status: number | null; stdout: string; stderr: string }
export interface CtoExecOptions { cwd?: string; input?: string; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number }
export type CtoExec = (bin: string, args: readonly string[], options?: CtoExecOptions) => CtoExecResult;
export interface CtoFiles {
  exists(path: string): boolean;
  read(path: string): string;
  /** Replaces the file whole (written beside it, then renamed into place), 0600 unless `mode` says otherwise. */
  replace(path: string, body: string, mode?: number): void;
  /** Renames a file or a directory tree to a path that does not exist yet, creating its parent. */
  move(from: string, to: string): void;
  /** Removes a file or a directory tree. */
  remove(path: string): void;
  mtimeMs(path: string): number | null;
}

/** The operator socket, as `agentctl`'s own client speaks it. */
export interface CtoOperator { request(method: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<Decision<unknown>> }

export interface CtoRepository { repositoryId: string; identity: string; checkoutPath: string }

/** One project's CTO as ACP's database records it, read fresh on every call. */
export interface CtoRecord {
  projectId: string;
  name: string;
  retiredAt: string | null;
  /** `resident`: provisioned by a repo-factory bootstrap. `canonical`: an entitlement without one. */
  kind: "resident" | "canonical" | "none";
  repositories: CtoRepository[];
  /** The conversation the CTO holds now: the active binding's, else the latest an entitlement or switchover names. */
  conversation: string | null;
  /** The active PRIMARY_CTO binding's generation, null when the role is unbound. */
  generation: number | null;
  /** The pid, start and working directory ACP recorded for the active binding's session. */
  session: { pid: number | null; startedAt: string | null; workdir: string | null } | null;
  room: string | null;
  actorId: string | null;
  /** A resident's provisioning: its status and its allocation (with the room the daemon bound). */
  resident: { status: string; allocation: Record<string, unknown> | null } | null;
  lastBuzzAt: string | null;
}
export interface CtoStateReader {
  projects(): CtoRecord[];
  project(projectId: string): CtoRecord | null;
  /** The project's runs that are not finished, newest first. */
  openRuns(projectId: string): Array<{ runId: string; state: string; kind: string }>;
  /** The shared one-CTO rule's scope for the role, from the database (`ctoRoleScope`), with what this run adds. */
  roleScope(projectId: string, extra?: { conversationIds?: readonly string[]; checkouts?: readonly string[] }): CtoRoleScope;
}

export interface CtoPorts {
  home: string;
  stateDir: string;
  databasePath: string;
  /** The environment the composed scripts run with. Never printed. */
  env: Readonly<Record<string, string | undefined>>;
  operator: CtoOperator;
  state: CtoStateReader;
  run: CtoExec;
  /** The shared one-CTO process reader (`systemCtoProcessReader`): kernel argv, a table that fails closed. */
  ctoProcesses: CtoProcessReader;
  startToken(pid: number): string | null;
  /** Whether the kernel has no such pid (`kill(pid, 0)` throws ESRCH): the one proof that a process is gone. */
  kernelGone(pid: number): boolean;
  signal(pid: number, signal: "SIGTERM"): void;
  files: CtoFiles;
  /** The Buzz public key of a key file, never its contents; null when it cannot be read. */
  publicKeyOf(keyFile: string): string | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newUuid(): string;
  write(line: Record<string, unknown>): void;
  node: string;
  scripts: { provisioner: string | null };
}

type Outcome = { ok: true; detail?: Record<string, unknown> } | { ok: false; reason: string; detail?: Record<string, unknown> };
export interface CtoStep {
  id: string;
  plan: string;
  /** Already in the state this step brings about: skipped. Reads only; never changes anything. */
  done?: () => boolean | Promise<boolean>;
  run: () => Outcome | Promise<Outcome>;
}

const ok = (detail?: Record<string, unknown>): Outcome => ({ ok: true, ...(detail ? { detail } : {}) });
const refused = (reason: string, detail?: Record<string, unknown>): Outcome => ({ ok: false, reason, ...(detail ? { detail } : {}) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** How long a conversation's transcript must be unchanged before it is treated as between turns. */
export const IDLE_SECONDS = 60;
const STOP_TIMEOUT_MS = 30_000;
/** How long a resumed canonical CTO has to claim its role from inside its own process. */
const CLAIM_WAIT_MS = 120_000;
const POLL_MS = 250;

const githubRepoOf = (identity: string): string | null => {
  const match = /^github:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.exec(identity);
  return match ? match[1]! : null;
};
const tmuxNameOf = (projectId: string): string => `acp-${Buffer.from(projectId).toString("hex")}`;
const fleetNameOf = (projectId: string): string => `acp-${projectId}`;
const keyFileOf = (ports: CtoPorts, projectId: string): string => join(ports.home, ".hermes", "bridge", "keys", `cto-${projectId}.priv`);
const bridgeFile = (ports: CtoPorts, name: string): string => join(ports.home, ".hermes", "bridge", name);
const fleetDir = (ports: CtoPorts): string => join(ports.home, ".claude", "watchers", "fleet");
const residentRequestOf = (ports: CtoPorts, projectId: string): string => join(fleetDir(ports), `${fleetNameOf(projectId)}.resident.json`);
/** Claude Code keeps a conversation's transcript under its cwd with every non-alphanumeric character a dash. */
const transcriptOf = (ports: CtoPorts, cwd: string, uuid: string): string =>
  join(ports.home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${uuid}.jsonl`);
const allocationString = (record: CtoRecord, field: string): string | null => {
  const value = record.resident?.allocation?.[field];
  return typeof value === "string" ? value : null;
};
const cloneOf = (record: CtoRecord): string | null =>
  allocationString(record, "clonePath") ?? record.repositories.find((r) => !r.checkoutPath.includes("/.acp-worker-checkouts/"))?.checkoutPath ?? null;

const cwdOf = (record: CtoRecord | null): string | null => (record ? record.session?.workdir ?? cloneOf(record) : null);

/** Whether a claude argv, element by element, loads the acp-buzz-channel development channel. */
const argvCarriesChannel = (argv: readonly string[] | null | undefined): boolean => {
  if (!argv) return false;
  const wanted = `server:${BUZZ_CHANNEL_SERVER}`;
  for (let at = 0; at < argv.length; at++) {
    const element = argv[at]!;
    if (element.startsWith(`${CHANNEL_DEV_FLAG}=`) && element.slice(CHANNEL_DEV_FLAG.length + 1).split(/[ ,]/).includes(wanted)) return true;
    if (element !== CHANNEL_DEV_FLAG) continue;
    for (let value = at + 1; value < argv.length && (value === at + 1 || !argv[value]!.startsWith("-")); value++) if (argv[value] === wanted) return true;
  }
  return false;
};

/** The role's scope by the shared rule: the database's, plus the bound conversation and folder this run knows. */
const roleScopeOf = (ports: CtoPorts, projectId: string): CtoRoleScope => {
  const record = fresh(ports, projectId);
  const cwd = cwdOf(record);
  return ports.state.roleScope(projectId, { conversationIds: record?.conversation ? [record.conversation] : [], checkouts: cwd ? [cwd] : [] });
};

interface RoleProcesses { matches: CtoMatch[]; snapshot: CtoProcessSnapshot }
/**
 * The project's live CTO processes, by the one shared rule rather than a process reader or pattern of cto's own:
 * `src/cto/one-cto-per-project.ts`, with real argv, the role's whole scope and the bound process. A process table that
 * cannot be read is an error, never "nothing runs".
 */
const roleProcesses = async (ports: CtoPorts, projectId: string): Promise<RoleProcesses> => {
  const read = await snapshotCtoProcesses(ports.ctoProcesses);
  if (!read.ok) throw new Error(`${CTO_PROCESS_TABLE_UNREADABLE}: project ${projectId}: ${read.detail}`);
  return { matches: ctoProcessesFor(roleScopeOf(ports, projectId), read.snapshot), snapshot: read.snapshot };
};
const withChannel = (role: RoleProcesses, pid: number): boolean => argvCarriesChannel(role.snapshot.claude.get(pid)?.argv);

/** The one process a stop may signal, by its pid and its native start token. */
interface StopTarget { pid: number; startToken: string; tmux: string | null }
/**
 * What a stop may signal, and nothing else: the bound session's recorded os_pid while the kernel still gives it the
 * start ACP recorded, or, for a resident whose role is unbound, the one process the shared check matched. Never a
 * match over command text. Null is nothing to stop; the pre-launch check decides whether a launch is then safe.
 */
/**
 * A pid as the kernel says it is: GONE (provably: no such process, or only waiting to be reaped), ALIVE with its native
 * start token, or UNAVAILABLE (alive, or not known not to be, and its token cannot be read). An unreadable token is never
 * taken as exited.
 */
type Liveness = { state: "gone" } | { state: "alive"; token: string } | { state: "unavailable" };
// GONE is the kernel's word alone (ESRCH): a failing `ps`, whatever it printed, never makes a pid gone.
const livenessOf = async (ports: CtoPorts, pid: number): Promise<Liveness> => {
  const token = ports.startToken(pid);
  if (token !== null) return { state: "alive", token };
  return ports.kernelGone(pid) ? { state: "gone" } : { state: "unavailable" };
};

const stopTargetOf = async (ports: CtoPorts, record: CtoRecord | null, role: RoleProcesses): Promise<StopTarget | null | { refused: string }> => {
  // An ACTIVE binding: its recorded os_pid is the only thing a stop may signal, and nothing ever stands in for it.
  if (record?.generation !== null && record?.generation !== undefined) {
    const pid = record.session?.pid ?? null;
    if (!pid) return null;
    const live = await livenessOf(ports, pid);
    if (live.state === "gone") return null;
    if (live.state === "unavailable") {
      return { refused: `the bound session's os_pid ${pid} is not provably gone and its start cannot be read, so its identity cannot be confirmed; nothing was stopped or launched` };
    }
    const recorded = record.session!.startedAt;
    const row = role.snapshot.rows.find((one) => one.pid === pid);
    if (recorded !== null && (recorded === live.token || (row !== undefined && row.startedAt === recorded))) {
      return { pid, startToken: live.token, tmux: role.matches.find((one) => one.pid === pid)?.tmuxSession ?? null };
    }
    // Alive with another start, or none recorded: the bound session's identity cannot be confirmed, and no other
    // process is taken in its place. Nothing is stopped and, since the one-cto and stop steps refuse, nothing launched.
    return { refused: `the bound session's os_pid ${pid} is alive with a start that is not the one ACP recorded, so its identity cannot be confirmed; nothing was stopped or launched` };
  }
  // No ACTIVE binding at all: only a resident falls back to the one process the shared check matched.
  if (record?.kind !== "resident") return null;
  if (role.matches.length > 1) return { refused: `${role.matches.length} processes are this CTO role's (${role.matches.map((one) => one.pid).join(", ")}); nothing was signalled` };
  const only = role.matches[0];
  if (!only) return null;
  const live = await livenessOf(ports, only.pid);
  if (live.state === "gone") return null;
  if (live.state === "unavailable") return { refused: `pid ${only.pid}, this CTO role's process, is not provably gone and its start cannot be read; nothing was signalled` };
  return { pid: only.pid, startToken: live.token, tmux: only.tmuxSession };
};

const tmuxExists = (ports: CtoPorts, name: string): boolean =>
  ports.run("tmux", ["has-session", "-t", `=${name}`], { timeoutMs: 5_000 }).status === 0;

interface RosterRoute { status?: string; acp_project_id?: string; peer?: { pubkey?: string; handle?: string } }
const rosterRoute = (ports: CtoPorts, room: string | null): RosterRoute | null => {
  if (!room) return null;
  const file = bridgeFile(ports, "required-mentions.json");
  if (!ports.files.exists(file)) return null;
  const roster = JSON.parse(ports.files.read(file)) as { channels?: Record<string, RosterRoute> };
  return roster.channels?.[room] ?? null;
};
const routeActive = (route: RosterRoute | null): boolean => route !== null && (route.status ?? "active") === "active";
const mapNames = (ports: CtoPorts, room: string): boolean => {
  const file = bridgeFile(ports, "channel-cto.map");
  return ports.files.exists(file) && ports.files.read(file).split("\n").some((line) => line.split(" ")[0] === room);
};

const firstLine = (text: string): string => text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 400) ?? "";
const lastJsonLine = (text: string): Record<string, unknown> | null => {
  for (const line of text.trim().split("\n").reverse()) {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* not a JSON line */ }
  }
  return null;
};

const scriptEnv = (ports: CtoPorts): Record<string, string | undefined> => ({
  ...ports.env, HOME: ports.home, ACP_STATE_DIR: ports.stateDir, ACP_HOST_DATABASE_PATH: ports.databasePath,
});

/** One host provisioner operation, as the fleet watcher sends it: the resident request, versioned. */
const provision = (ports: CtoPorts, request: { allocation: unknown; packet?: unknown }, operation: string, packet: unknown = request.packet): CtoExecResult => {
  if (!ports.scripts.provisioner) return { status: null, stdout: "", stderr: "the host project provisioner script was not found (set ACP_HOST_PROJECT_PROVISIONER)" };
  return ports.run(ports.node, [ports.scripts.provisioner], {
    input: JSON.stringify({ ...request, version: 1, operation, packet }), env: scriptEnv(ports), timeoutMs: 180_000,
  });
};

const readResidentRequest = (ports: CtoPorts, projectId: string): { allocation: unknown; packet?: unknown } | null => {
  const file = residentRequestOf(ports, projectId);
  if (!ports.files.exists(file)) return null;
  return JSON.parse(ports.files.read(file)) as { allocation: unknown; packet?: unknown };
};

// ---------------------------------------------------------------------------------------------------------------
// Steps shared by the subcommands.

const fresh = (ports: CtoPorts, projectId: string): CtoRecord | null => ports.state.project(projectId);

/** Between turns: no process runs the conversation, or its transcript has been unchanged for IDLE_SECONDS. */
const idleStep = (ports: CtoPorts, projectId: string): CtoStep => ({
  id: "idle",
  plan: `check the CTO is between turns: no process runs its conversation, or its transcript has not changed for ${IDLE_SECONDS}s`,
  run: async () => {
    const record = fresh(ports, projectId);
    const uuid = record?.conversation ?? null;
    const role = await roleProcesses(ports, projectId);
    if (!record || role.matches.length === 0) return ok({ running: false });
    const cwd = record.session?.workdir ?? cloneOf(record);
    const mtime = cwd ? ports.files.mtimeMs(transcriptOf(ports, cwd, uuid!)) : null;
    if (mtime === null) return refused(`conversation ${uuid} is running and its transcript cannot be found, so whether it is mid-turn is unknown`);
    const quiet = Math.floor((ports.now() - mtime) / 1000);
    if (quiet < IDLE_SECONDS) return refused(`conversation ${uuid} wrote its transcript ${quiet}s ago and may be mid-turn; run this again once it has been idle for ${IDLE_SECONDS}s`);
    return ok({ running: true, quietSeconds: quiet });
  },
});

/**
 * SIGTERM to exactly the stop target (`stopTargetOf`: the bound session's os_pid with the start ACP recorded, or a
 * resident's one matched process), then its exit confirmed by its native start token changing. Nothing found by
 * command text is ever signalled. `keepChanneled` leaves a target that already carries the channel running (cto add
 * brings a CTO up; it does not restart one that is up). The stopped identity goes to `stopped`, which the launch's
 * pre-launch check excuses (pid and start token) and nothing else.
 */
const stopStep = (ports: CtoPorts, projectId: string, id = "stop", keepChanneled = false, stopped: ExpectedProcess[] = []): CtoStep => ({
  id,
  plan: keepChanneled
    ? "unless the CTO already runs with the acp-buzz-channel, send SIGTERM to its bound session's process (the recorded pid, checked by its native start token), nothing else, and wait for it to exit"
    : "send SIGTERM to the CTO's bound session's process (the recorded pid, checked by its native start token; for an unbound resident, the one process the shared one-CTO check matches), nothing else, and wait for it to exit",
  done: async () => {
    const role = await roleProcesses(ports, projectId);
    const target = await stopTargetOf(ports, fresh(ports, projectId), role);
    if (target === null) return true;
    return !("refused" in target) && keepChanneled && withChannel(role, target.pid);
  },
  run: async () => {
    const role = await roleProcesses(ports, projectId);
    const target = await stopTargetOf(ports, fresh(ports, projectId), role);
    if (target === null) return ok({ running: false });
    if ("refused" in target) return refused(target.refused);
    // Exited is proven only by the kernel: the pid gone, or a readable token that is another process's.
    const exited = async (): Promise<boolean | null> => {
      const live = await livenessOf(ports, target.pid);
      return live.state === "gone" || (live.state === "alive" && live.token !== target.startToken) ? true : live.state === "unavailable" ? null : false;
    };
    // Immediately before the signal the token is read again: only the very identity selected is signalled. A pid the
    // kernel no longer has is already stopped; a token that cannot be read, or that is another process's, refuses.
    const now = ports.startToken(target.pid);
    if (now === null && ports.kernelGone(target.pid)) return ok({ pid: target.pid, alreadyGone: true });
    if (now !== target.startToken) {
      return refused(now === null
        ? `pid ${target.pid}'s start cannot be read right before the signal, so it cannot be confirmed as the process selected; nothing was signalled or launched`
        : `pid ${target.pid} is another process than the one selected (its start changed); nothing was signalled or launched`);
    }
    try { ports.signal(target.pid, "SIGTERM"); } catch (error) {
      // Gone between the read and the signal is the outcome this step wants; anything else is reported.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (const deadline = ports.now() + STOP_TIMEOUT_MS; (await exited()) !== true;) {
      if (ports.now() >= deadline) {
        return refused(`pid ${target.pid} did not provably exit within ${STOP_TIMEOUT_MS / 1000}s of SIGTERM (it still runs, or its start could not be read); nothing else was signalled and nothing was launched`);
      }
      await ports.sleep(POLL_MS);
    }
    stopped.push({ pid: target.pid, startedAt: target.startToken });
    return ok({ pid: target.pid, tmux: target.tmux });
  },
});

/** The provisioner's ensure-resident: MCP entry, resident request, boot packet, fleet entry and a launch with the channel. */
const residentLaunchStep = (ports: CtoPorts, projectId: string): CtoStep => ({
  id: "launch",
  plan: "start the resident through the host provisioner's ensure-resident, the fleet watcher's launcher: it writes the resident request, boot packet and fleet entry and starts claude with the acp-buzz-channel, resuming the conversation it has a record of",
  done: async () => {
    const role = await roleProcesses(ports, projectId);
    return role.matches.some((one) => withChannel(role, one.pid));
  },
  run: async () => {
    const request = readResidentRequest(ports, projectId);
    if (!request) return refused(`${residentRequestOf(ports, projectId)} is missing: the daemon writes it when it activates this resident, so ACP has not activated it on this host`);
    // A tmux pane whose claude was just stopped is still settling for a moment; the provisioner refuses until it has.
    let answer = provision(ports, request, "ensure-resident");
    for (let i = 0; i < 20 && answer.status !== 0 && answer.stderr.includes("still settling"); i++) {
      await ports.sleep(500);
      answer = provision(ports, request, "ensure-resident");
    }
    // The fleet watcher's rule: claude's recorded exit is acknowledged, then the resident is ensured again.
    if (answer.status === recordedResidentExitStatus) {
      const reason = readHostProvisionerReason(answer.stderr, "ensure-resident");
      if (!reason) return refused(`ensure-resident refused: ${firstLine(answer.stderr)}`);
      const acknowledged = provision(ports, request, "acknowledge-resident-exit", { residentExitReason: reason });
      if (acknowledged.status !== 0) return refused(`acknowledge-resident-exit refused: ${firstLine(acknowledged.stderr)}`);
      answer = provision(ports, request, "ensure-resident");
    }
    if (answer.status !== 0) return refused(`ensure-resident refused: ${firstLine(answer.stderr) || `exit ${answer.status ?? "timeout"}`}`);
    const resident = (lastJsonLine(answer.stdout)?.["resident"] ?? null) as { pid?: number } | null;
    return ok({ pid: resident?.pid ?? null, tmux: tmuxNameOf(projectId) });
  },
});

// ---- a canonical CTO: its one long-lived conversation, resumed (#1437 R1) ------------------------------------------

/** The launcher a canonical resume writes and tmux starts; it is also the record of the tmux session it belongs in. */
const canonicalLauncherOf = (ports: CtoPorts, projectId: string): string => join(ports.stateDir, `cto-launch-${projectId}.sh`);
const runtimeNodeOf = (ports: CtoPorts): string => join(ports.stateDir, "current", "dist", "bin", "node");
const runtimeCliOf = (ports: CtoPorts): string => join(ports.stateDir, "current", "dist", "cli", "agentctl.js");
/** The acp-cto entry a canonical CTO's claude starts: the same claim, at the role's next generation, from inside it. */
const acpCtoEntryArgs = (ports: CtoPorts, projectId: string, uuid: string): string[] =>
  [runtimeCliOf(ports), "attach", "canonical-cto", "--claimed-session-id", uuid, "--project-id", projectId, "--expected-binding-generation", "auto"];
/** The options a running session was started with that its resume keeps: each takes one value. */
const CARRIED_OPTIONS = new Set(["--model", "--effort", "--name", "--remote-control", "--messaging-socket-path", "--permission-mode"]);
const carriedOptions = (argv: readonly string[]): string[] => {
  const kept: string[] = [];
  for (let i = 1; i < argv.length - 1; i++) {
    if (CARRIED_OPTIONS.has(argv[i]!) && !argv[i + 1]!.startsWith("--")) { kept.push(argv[i]!, argv[i + 1]!); i++; }
  }
  return kept;
};
const claudeBinaryOf = (ports: CtoPorts, argv: readonly string[] | null): string | null => {
  const pinned = ports.env["ACP_CLAUDE_BINARY"] || ports.env["ACP_RESOLVED_CLAUDE_BINARY"];
  if (pinned) return pinned;
  return argv?.[0] && argv[0].startsWith("/") && basename(argv[0]) === "claude" ? argv[0] : null;
};

/**
 * The key file of the Buzz identity ACP holds for the project, never a new one: the project's own `cto-<project>.priv`,
 * or the local alias Hermes's channel-cto.map gives its room, whichever is that identity. Paths only; no key is read out.
 */
const channelOf = (ports: CtoPorts, record: CtoRecord): { keyFile: string; roomId: string } | string => {
  const room = record.room;
  if (!room || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(room) || !/^[0-9a-f]{64}$/.test(record.actorId ?? "")) {
    return "ACP holds no Buzz identity and room for this CTO to start its channel with";
  }
  const map = bridgeFile(ports, "channel-cto.map");
  const alias = ports.files.exists(map) ? ports.files.read(map).split("\n").map((line) => line.split(" ")).find(([r]) => r === room)?.[1] : undefined;
  const candidates = [keyFileOf(ports, record.projectId), ...(alias && /^[A-Za-z0-9._-]+$/.test(alias) ? [join(ports.home, ".hermes", "bridge", "keys", `${alias}.priv`)] : [])];
  const keyFile = candidates.find((file) => ports.publicKeyOf(file) === record.actorId);
  return keyFile ? { keyFile, roomId: room } : `no key file here is the Buzz identity ACP holds for this CTO (${record.actorId}): looked at ${candidates.join(", ")}`;
};

/** What a canonical launch starts: the binary, the resume and the options it keeps, and its channel's key and room. */
interface CanonicalLauncher { tmux: string; cwd: string; claude: string; keyFile: string; roomId: string; resume: string[] }
const quoteShell = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;
/** The launcher script for one launch: `launchId` is this launch's own, passed to its channel server. */
const writeCanonicalLauncher = (ports: CtoPorts, projectId: string, plan: CanonicalLauncher, launchId?: string): string[] => {
  const argv = [plan.claude,
    ...channelLaunchArgs({ runtimeNode: runtimeNodeOf(ports), runtimeCli: runtimeCliOf(ports), projectId, keyFile: plan.keyFile, roomId: plan.roomId, stateDir: ports.stateDir, ...(launchId ? { launchId } : {}) }),
    ...plan.resume];
  ports.files.replace(canonicalLauncherOf(ports, projectId), `#!/bin/sh\n# cto-launch: ${JSON.stringify(plan)}\n` +
    "unset ACP_OPERATOR_TOKEN ACP_MCP_TOKEN ACP_BUZZ_INGRESS_SECRET GH_TOKEN GITHUB_TOKEN\n" +
    `cd ${quoteShell(plan.cwd)} || exit 1\nexec ${argv.map(quoteShell).join(" ")}\n`, 0o700);
  return argv;
};
/** The launcher's recorded line, whatever version wrote it; null when there is none or it does not parse. */
const launcherRecordOf = (ports: CtoPorts, projectId: string): Record<string, unknown> | null => {
  const file = canonicalLauncherOf(ports, projectId);
  if (!ports.files.exists(file)) return null;
  const line = ports.files.read(file).split("\n").find((l) => l.startsWith("# cto-launch: "));
  try {
    const value: unknown = line ? JSON.parse(line.slice("# cto-launch: ".length)) : null;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
};
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");
/** This version's launcher record, or null: one with any of its metadata missing is regenerated, never used. */
const readCanonicalLauncher = (ports: CtoPorts, projectId: string): CanonicalLauncher | null => {
  const r = launcherRecordOf(ports, projectId);
  return r && ["tmux", "cwd", "claude", "keyFile", "roomId"].every((key) => typeof r[key] === "string") && isStrings(r["resume"])
    ? r as unknown as CanonicalLauncher : null;
};
/** What an earlier version's launcher (`{tmux, argv}`) carried: its tmux session and its full argv, for the options it kept. */
const readLegacyLauncher = (ports: CtoPorts, projectId: string): { tmux: string | null; argv: string[] } | null => {
  const r = launcherRecordOf(ports, projectId);
  return r && isStrings(r["argv"]) && r["argv"].length > 0 ? { tmux: typeof r["tmux"] === "string" ? r["tmux"] : null, argv: r["argv"] } : null;
};

/**
 * A canonical CTO restarted in the same conversation: its folder already trusted, its channel's identity and room
 * resolved, its exact claude process stopped, and `claude --resume <the role's bound conversation>` started with the
 * channel in the tmux session the old one ran in (or a new detached one), confirming only the development-channels
 * warning. Its acp-cto entry claims with `--expected-binding-generation auto`, so the conversation re-attaches as the
 * same actor and the daemon keeps its queued messages for the channel to deliver. Nothing here starts a new
 * conversation, writes a handoff package or runs a rotation. Everything that can refuse is checked before the stop.
 */
const canonicalResumeSteps = (ports: CtoPorts, projectId: string, restart: boolean, options: { conversation?: string; fresh?: { uuid: string } } = {}): CtoStep[] => {
  const planned = fresh(ports, projectId);
  // The conversation the launch starts: a new one (--fresh), one the operator names (--conversation), or the bound one.
  const wanted = (record: CtoRecord | null): string | null => options.fresh?.uuid ?? options.conversation ?? record?.conversation ?? null;
  const uuid = wanted(planned);
  const cwd = planned ? cwdOf(planned) : null;
  const launcher = canonicalLauncherOf(ports, projectId);
  const bound = (): { record: CtoRecord; uuid: string; cwd: string } | string => {
    const record = fresh(ports, projectId);
    const conversation = wanted(record);
    if (!record || !conversation || !UUID.test(conversation)) return "the role has no bound conversation to resume";
    const folder = cwdOf(record);
    return folder ? { record, uuid: conversation, cwd: folder } : "the CTO's working directory is not recorded";
  };
  // The process this run stopped: the only one the pre-launch check excuses.
  const stopped: ExpectedProcess[] = [];
  /** The role is held by a process the kernel still knows by its recorded start, and it carries the channel. */
  const resumed = async (record: CtoRecord | null): Promise<boolean> => {
    const pid = record?.generation !== null ? record?.session?.pid ?? null : null;
    if (!pid || ports.startToken(pid) === null || ports.startToken(pid) !== record!.session!.startedAt) return false;
    return argvCarriesChannel(await ports.ctoProcesses.argv(pid));
  };
  return [idleStep(ports, projectId), {
    id: "trust",
    plan: `check Claude Code would find ${cwd ?? "the CTO's folder"} already trusted (launchFolderTrust); nothing is ever trusted here`,
    run: () => {
      const at = bound();
      if (typeof at === "string") return refused(at);
      const trust = launchFolderTrust(at.cwd, { home: ports.home, env: ports.env });
      return trust.trusted ? ok({ folder: trust.folder })
        : refused(`Claude Code would not find ${at.cwd} trusted (${trust.reason}); run ~/.claude/scripts/claude-trust-dir.sh ${at.cwd}, then run this again; nothing was stopped`);
    },
  }, {
    id: "channel",
    plan: "resolve the Buzz identity's key file and the room ACP holds for this CTO, for its channel",
    run: () => {
      const at = bound();
      if (typeof at === "string") return refused(at);
      const channel = channelOf(ports, at.record);
      return typeof channel === "string" ? refused(`${channel}; nothing was stopped`) : ok(channel);
    },
  }, {
    id: "one-cto",
    plan: "check with the shared one-CTO rule (the role's whole scope, real argv) that no process of the role runs but the bound session's own, which the stop replaces",
    run: async () => {
      const role = await roleProcesses(ports, projectId);
      const target = await stopTargetOf(ports, fresh(ports, projectId), role);
      if (target !== null && "refused" in target) return refused(target.refused);
      const one = await assertNoOtherCtoProcess(roleScopeOf(ports, projectId), ports.ctoProcesses, target ? [{ pid: target.pid, startedAt: target.startToken }] : []);
      return one.ok ? ok(target ? { replaces: target.pid } : {}) : refused(`${one.message}; nothing was written, stopped or started`);
    },
  }, {
    id: "launcher",
    plan: `write ${launcher}: claude ${options.fresh ? `--session-id ${uuid} (a new conversation, first prompt: the handoff)` : `--resume ${uuid ?? "<the bound conversation>"}`} with the channel, keeping the running session's model, effort, name, remote-control name, messaging socket and permission mode, to be started in its tmux session`,
    // A launcher an earlier run wrote is kept once nothing runs the conversation: it holds what the stopped session carried.
    done: async () => {
      const record = fresh(ports, projectId);
      const role = await roleProcesses(ports, projectId);
      return role.matches.length === 0 && readCanonicalLauncher(ports, projectId)?.resume.includes(wanted(record) ?? "\0") === true;
    },
    run: async () => {
      const at = bound();
      if (typeof at === "string") return refused(at);
      const channel = channelOf(ports, at.record);
      if (typeof channel === "string") return refused(channel);
      const role = await roleProcesses(ports, projectId);
      const target = await stopTargetOf(ports, at.record, role);
      if (target !== null && "refused" in target) return refused(target.refused);
      // What the bound session was started with, from its kernel argv; nothing is read from command text.
      const argv = target ? role.snapshot.claude.get(target.pid)?.argv ?? null : null;
      if (target && argv === null) return refused(`pid ${target.pid}'s argv cannot be read, so what its session was started with is unknown; nothing was written`);
      const earlier = readCanonicalLauncher(ports, projectId);
      const legacy = earlier ? null : readLegacyLauncher(ports, projectId);
      const claude = claudeBinaryOf(ports, argv ?? (earlier ? [earlier.claude] : legacy?.argv ?? null));
      if (!claude) return refused("the claude binary is not known: set ACP_CLAUDE_BINARY (agentcpd's launcher pins ACP_RESOLVED_CLAUDE_BINARY)");
      const kept = argv ? carriedOptions(argv) : earlier ? carriedOptions([earlier.claude, ...earlier.resume]) : legacy ? carriedOptions(legacy.argv) : [];
      const perm = kept.includes("--permission-mode") ? [] : ["--permission-mode", "bypassPermissions"];
      let resume = ["--resume", at.uuid, ...kept, ...perm];
      if (options.fresh) {
        const stored = readHandoff(ports.files, ports.stateDir, projectId);
        if (!stored) return refused("the handoff is not stored; nothing was written");
        resume = ["--session-id", at.uuid, ...kept, ...perm, firstPromptOf({ projectId, previousConversation: stored.conversation, text: stored.text })];
      }
      const tmux = target?.tmux ?? earlier?.tmux ?? legacy?.tmux ?? `cto-${projectId}`;
      // The launch writes its own id into this script before tmux starts it; this one is the plan a rerun starts from.
      writeCanonicalLauncher(ports, projectId, { tmux, cwd: at.cwd, claude, keyFile: channel.keyFile, roomId: channel.roomId, resume });
      return ok({ launcher, tmux });
    },
  }, {
    id: "mcp",
    plan: `point the project's local acp-cto entry at conversation ${uuid ?? "<the bound conversation>"} with --expected-binding-generation auto, so the resumed claude makes the claim itself`,
    done: () => {
      const at = bound();
      if (typeof at === "string") return false;
      const config = join(ports.home, ".claude.json");
      if (!ports.files.exists(config)) return false;
      const entry = (JSON.parse(ports.files.read(config)) as { projects?: Record<string, { mcpServers?: Record<string, { command?: string; args?: string[] }> }> })
        .projects?.[at.cwd]?.mcpServers?.["acp-cto"];
      return entry?.command === runtimeNodeOf(ports) && JSON.stringify(entry.args ?? []) === JSON.stringify(acpCtoEntryArgs(ports, projectId, at.uuid));
    },
    run: () => {
      const at = bound();
      if (typeof at === "string") return refused(at);
      const earlier = readCanonicalLauncher(ports, projectId);
      const claude = claudeBinaryOf(ports, earlier ? [earlier.claude] : readLegacyLauncher(ports, projectId)?.argv ?? null);
      if (!claude) return refused("the claude binary is not known: set ACP_CLAUDE_BINARY");
      // Absent is fine; the add below is what has to succeed.
      ports.run(claude, ["mcp", "remove", "--scope", "local", "acp-cto"], { cwd: at.cwd, timeoutMs: 30_000 });
      const added = ports.run(claude, ["mcp", "add", "--scope", "local", "acp-cto", "--", runtimeNodeOf(ports), ...acpCtoEntryArgs(ports, projectId, at.uuid)], { cwd: at.cwd, timeoutMs: 30_000 });
      return added.status === 0 ? ok() : refused(`claude mcp add acp-cto failed: ${firstLine(added.stderr)}`);
    },
  }, stopStep(ports, projectId, "stop", !restart, stopped), {
    id: "launch",
    plan: `check with the shared one-CTO rule that no process of the role runs but the one this run stopped, then start ${launcher} in tmux and confirm the acp-buzz-channel came up, pressing nothing but its development-channels warning`,
    done: async () => {
      const role = await roleProcesses(ports, projectId);
      return role.matches.some((one) => withChannel(role, one.pid));
    },
    run: async () => {
      const planned = readCanonicalLauncher(ports, projectId);
      if (!planned) return refused(`${launcher} is missing or unreadable; run this again to write it`);
      // The one definition of running, asked with the role's whole scope; only the process this run stopped is excused.
      const one = await assertNoOtherCtoProcess(roleScopeOf(ports, projectId), ports.ctoProcesses, stopped);
      if (!one.ok) return refused(`${one.message}; nothing was started`);
      // This launch's own id, in the script tmux is about to start and so in its channel server's every receipt.
      const launchId = ports.newUuid();
      const argv = writeCanonicalLauncher(ports, projectId, planned, launchId);
      const tmuxRun = (args: string[]): CtoExecResult => ports.run("tmux", args, { timeoutMs: 10_000 });
      const started = tmuxExists(ports, planned.tmux)
        ? tmuxRun(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${planned.tmux}:`, launcher])
        : tmuxRun(["new-session", "-d", "-s", planned.tmux, "-P", "-F", "#{pane_id}", launcher]);
      const pane = started.stdout.trim();
      if (started.status !== 0 || !/^%\d+$/.test(pane)) return refused(`tmux could not start ${launcher} in ${planned.tmux}: ${firstLine(started.stderr)}`);
      const run = (bin: string, args: string[]): string => {
        const answer = ports.run(bin, args, { timeoutMs: 10_000 });
        if (answer.status !== 0) throw new Error(firstLine(answer.stderr) || `${bin} exited ${answer.status ?? "on timeout"}`);
        return answer.stdout;
      };
      // A backlog flood can scroll the registered line away; a receipt carrying this launch's id proves it too, and nothing older does.
      const registered = channelEmittedBy(ports.stateDir, projectId, launchId, (path) => ports.files.read(path));
      const startup = await confirmChannelStartup(tmuxChannelDriver({ tmux: "tmux", target: pane, startCommand: launcher, run, registered }));
      if (!startup.ok) {
        return refused(`the resumed conversation was started in tmux ${planned.tmux} (${pane}) and its channel did not come up (${startup.failure}, screen ${startup.screen}); it was left running there`, { tmux: planned.tmux, pane });
      }
      return ok({ argv, tmux: planned.tmux, pane, launchId, confirmed: startup.confirmed });
    },
  }, {
    id: "claimed",
    plan: `wait for the resumed claude to claim the PRIMARY_CTO role as conversation ${uuid ?? "<the bound conversation>"} (generation auto)`,
    done: () => resumed(fresh(ports, projectId)),
    run: async () => {
      for (const deadline = ports.now() + CLAIM_WAIT_MS; ;) {
        const record = fresh(ports, projectId);
        if (await resumed(record)) return ok({ conversation: record!.conversation, generation: record!.generation, pid: record!.session!.pid });
        if (ports.now() >= deadline) return refused(`the resumed conversation runs with its channel and has not claimed the role within ${CLAIM_WAIT_MS / 1000}s; it was left running`);
        await ports.sleep(2_000);
      }
    },
  }];
};

/** The roster routes the project's room to this project and Buzz identity, and is active. */
const rosterStep = (ports: CtoPorts, projectId: string): CtoStep => ({
  id: "roster",
  plan: "bind the project's room in the Hermes roster (required-mentions.json) to this project and its Buzz identity, through the provisioner's ensure-routing",
  done: () => {
    const record = fresh(ports, projectId);
    const route = rosterRoute(ports, record?.room ?? null);
    return routeActive(route) && route!.acp_project_id === projectId && route!.peer?.pubkey === record?.actorId;
  },
  run: () => {
    const record = fresh(ports, projectId);
    if (record?.kind !== "resident" || !record.resident?.allocation) {
      return refused("only a resident's allocation names everything ensure-routing writes; a canonical CTO's roster entry is bound with its own launcher");
    }
    const answer = provision(ports, { allocation: record.resident.allocation }, "ensure-routing", null);
    if (answer.status !== 0) return refused(`ensure-routing refused: ${firstLine(answer.stderr)}`);
    return ok();
  },
});

/** Hermes rebuilds channel-cto.map from the roster with its own script; this never writes the map itself. */
const channelMapStep = (ports: CtoPorts, projectId: string, wantRouted: boolean): CtoStep => ({
  id: "channel-map",
  plan: `rebuild ~/.hermes/bridge/channel-cto.map from the roster with buzz-identity-map.sh, so it ${wantRouted ? "names" : "no longer names"} the project's room`,
  done: () => {
    const room = fresh(ports, projectId)?.room ?? null;
    return room === null ? !wantRouted : mapNames(ports, room) === wantRouted;
  },
  run: () => {
    const answer = ports.run(bridgeFile(ports, "buzz-identity-map.sh"), [], { env: { ...ports.env, HOME: ports.home }, timeoutMs: 30_000 });
    if (answer.status !== 0) return refused(`buzz-identity-map.sh refused: ${firstLine(answer.stderr)}`);
    const room = fresh(ports, projectId)?.room ?? null;
    if (room !== null && mapNames(ports, room) !== wantRouted) return refused(`channel-cto.map was rebuilt and still ${wantRouted ? "does not name" : "names"} room ${room}: the roster ${wantRouted ? "does not route" : "still routes"} it`);
    return ok();
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Subcommands.

const listCtos = async (ports: CtoPorts): Promise<number> => {
  const read = await snapshotCtoProcesses(ports.ctoProcesses);
  if (!read.ok) { ports.write({ refused: `${CTO_PROCESS_TABLE_UNREADABLE}: ${read.detail}` }); return 1; }
  const rows = ports.state.projects().filter((r) => r.kind !== "none" || r.generation !== null).map((record) => {
    const cwd = cwdOf(record);
    const scope = ports.state.roleScope(record.projectId, { conversationIds: record.conversation ? [record.conversation] : [], checkouts: cwd ? [cwd] : [] });
    const live = ctoProcessesFor(scope, read.snapshot);
    const route = rosterRoute(ports, record.room);
    return {
      project: record.projectId,
      name: record.name,
      kind: record.kind,
      generation: record.generation,
      conversation: record.conversation,
      session: live.length === 0 ? null : live.map((one) => ({ pid: one.pid, tmux: one.tmuxSession, channel: argvCarriesChannel(read.snapshot.claude.get(one.pid)?.argv), matchedBy: one.matchedBy })),
      room: record.room,
      roomRouted: routeActive(route) && route!.acp_project_id === record.projectId,
      lastBuzzAt: record.lastBuzzAt,
    };
  });
  ports.write({ ctos: rows });
  return 0;
};

const addPlan = (ports: CtoPorts, projectId: string, options: { repo: string | null; canonical: boolean }): CtoStep[] => {
  const steps: CtoStep[] = [{
    id: "project",
    plan: options.repo
      ? `register project ${projectId} with ACP (agentctl project register), cloning ${options.repo} into ~/projects/${options.repo.split("/")[1]} first if it is not there`
      : `confirm project ${projectId} is registered with ACP`,
    done: () => fresh(ports, projectId) !== null,
    run: async () => {
      if (!options.repo) return refused(`project ${projectId} is not registered; pass --repo <owner/name> to register it`);
      const checkout = join(ports.home, "projects", options.repo.split("/")[1]!);
      if (!ports.files.exists(checkout)) {
        const cloned = ports.run("gh", ["repo", "clone", options.repo, checkout], { timeoutMs: 300_000 });
        if (cloned.status !== 0) return refused(`gh repo clone ${options.repo} failed: ${firstLine(cloned.stderr)}`);
      }
      // A fresh key per attempt: the client's default key is derived from the parameters, so the daemon would replay a
      // refusal it once gave (a transient one included) to every rerun. Whether it is already done is read from the state.
      const registered = await ports.operator.request("project.register", { name: projectId, checkoutPath: checkout, projectId }, `cto:${ports.newUuid()}`);
      return registered.allowed ? ok({ checkout }) : refused(`project register refused: ${registered.message}`, { reasonCode: registered.reasonCode });
    },
  }, {
    id: "identity",
    plan: options.canonical
      ? "confirm ACP holds a canonical entitlement for the project: its conversation, Buzz identity and room"
      : "confirm ACP holds a resident allocation for the project: its conversation, Buzz identity and room",
    done: () => {
      const record = fresh(ports, projectId);
      return Boolean(record && record.actorId && record.room && record.conversation && (options.canonical ? record.kind !== "none" : record.kind === "resident"));
    },
    run: () => {
      const record = fresh(ports, projectId);
      if (options.canonical && record && record.kind !== "none" && !record.conversation) {
        return refused("this canonical CTO has no conversation yet: cto add only resumes an existing conversation, and starting a first one is out of scope here");
      }
      return refused(options.canonical
        ? "ACP holds no canonical entitlement for this project: a canonical CTO's conversation, Buzz identity and room are granted from ACP_CANONICAL_SESSIONS_JSON at daemon start"
        : "ACP holds no resident allocation for this project: a resident CTO's conversation, Buzz identity and room are allocated by its repo-factory bootstrap; pass --canonical for a canonical CTO");
    },
  }, {
    id: "buzz-key",
    plan: `confirm ~/.hermes/bridge/keys/cto-${projectId}.priv is the Buzz identity ACP holds for the project`,
    done: () => {
      const record = fresh(ports, projectId);
      return Boolean(record?.actorId) && ports.publicKeyOf(keyFileOf(ports, projectId)) === record!.actorId;
    },
    run: () => {
      const record = fresh(ports, projectId);
      const key = ports.publicKeyOf(keyFileOf(ports, projectId));
      return refused(key === null
        ? `the CTO key ${keyFileOf(ports, projectId)} is missing or unreadable; a new key would not be the identity ACP holds (${record?.actorId ?? "none"}): put that identity's key back (a retired one is under ${join(ports.stateDir, "retired-buzz-identities")})`
        : `the CTO key ${keyFileOf(ports, projectId)} is identity ${key}, not ${record?.actorId ?? "none"}, which ACP holds for the project`);
    },
  }, rosterStep(ports, projectId), channelMapStep(ports, projectId, true)];
  if (options.canonical) steps.push(...canonicalResumeSteps(ports, projectId, false));
  else steps.push(residentLaunchStep(ports, projectId));
  return steps;
};

/** Runs the daemon is executing or merging: the project is busy, and a new conversation would orphan them. */
const LIVE_RUN_STATES = new Set(["ACTIVE", "MERGING", "POST_MERGE_VERIFYING", "CEO_APPROVED"]);

/** --fresh: refuse while the project has running work, then keep the handoff the new conversation starts from. */
const freshSteps = (ports: CtoPorts, record: CtoRecord, uuid: string): CtoStep[] => {
  const projectId = record.projectId;
  return [{
    id: "no-live-run",
    plan: "refuse while the project has a running, merging or approved run",
    run: () => {
      const live = ports.state.openRuns(projectId).filter((r) => LIVE_RUN_STATES.has(r.state));
      return live.length === 0 ? ok() : refused(`the project has running work (${live.map((r) => `${r.runId} ${r.state}`).join(", ")}); nothing was changed`);
    },
  }, {
    id: "handoff",
    plan: `use the handoff stored for ${record.conversation} (cto_handoff_write), else write ACP's from the binding and open runs (under 2 KB); it records the old conversation id`,
    run: () => {
      const old = record.conversation!;
      const stored = readHandoff(ports.files, ports.stateDir, projectId);
      if (stored?.conversation === old) return ok({ source: stored.source, oldConversation: old, newConversation: uuid });
      const text = fallbackHandoff({ projectId, conversation: old, generation: record.generation, openRuns: ports.state.openRuns(projectId) });
      const written = writeHandoff(ports.files, ports.stateDir, { projectId, conversation: old, source: "acp", text, now: new Date(ports.now()).toISOString() });
      return written.ok ? ok({ source: "acp", oldConversation: old, newConversation: uuid }) : refused(written.reason);
    },
  }, ...canonicalResumeSteps(ports, projectId, true, { fresh: { uuid } })];
};

const relaunchPlan = (ports: CtoPorts, record: CtoRecord, conversation?: string): CtoStep[] => {
  const projectId = record.projectId;
  // The resident path stays as it is until #1447 replaces it.
  if (record.kind === "resident") return [idleStep(ports, projectId), stopStep(ports, projectId), residentLaunchStep(ports, projectId)];
  return canonicalResumeSteps(ports, projectId, true, conversation ? { conversation } : {});
};

/** The temporary namespace a worker's refs are fetched into, in the project's primary clone. Never counted as work. */
const RETIRE_REFS = "refs/acp-cto-retire/";

/** Uncommitted changes or untracked files, or null; a tree that cannot be read counts as holding work. */
const dirtyTree = (run: CtoExec, path: string): string | null => {
  const status = run("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"], { timeoutMs: 60_000 });
  if (status.status !== 0) return `${path}'s working tree could not be read: ${firstLine(status.stderr)}`;
  return status.stdout.trim() ? `${path} has uncommitted or untracked files` : null;
};

/**
 * A namespace no other check has used, under RETIRE_REFS: one check's refs are never read by another, so refs an
 * earlier check could not clear are never taken as this one's (they stay under RETIRE_REFS, which no check counts).
 */
const freshNamespace = (): string => `${RETIRE_REFS}${randomUUID()}/`;
/** The refs under `prefix`, or null when git cannot list them. */
const refsUnder = (run: CtoExec, repo: string, prefix: string): string[] | null => {
  const listed = run("git", ["-C", repo, "for-each-ref", "--format=%(refname)", prefix], { timeoutMs: 60_000 });
  return listed.status === 0 ? listed.stdout.split("\n").filter((ref) => ref.startsWith(prefix)) : null;
};
/** Deletes every ref under `prefix`; true only when git said so and none is left. */
const clearRefs = (run: CtoExec, repo: string, prefix: string): boolean => {
  const refs = refsUnder(run, repo, prefix);
  if (refs === null) return false;
  if (refs.length > 0) {
    const deleted = run("git", ["-C", repo, "update-ref", "--stdin"], { timeoutMs: 60_000, input: refs.map((ref) => `delete ${ref}\n`).join("") });
    if (deleted.status !== 0) return false;
  }
  return refsUnder(run, repo, prefix)?.length === 0;
};
const uncleared = (repo: string, prefix: string): string => `temp refs could not be cleared from ${repo} (${prefix}); the checkout is kept`;

/**
 * Runs `check` against a fresh namespace of `repo` and clears that namespace afterwards. The answer stands only if the
 * namespace was empty when the check began and is empty again when it ends: anything else is held work.
 */
const inFreshNamespace = (run: CtoExec, repo: string, check: (namespace: string) => string | null): string | null => {
  const namespace = freshNamespace();
  const before = refsUnder(run, repo, namespace);
  if (before === null || before.length > 0) return `temp refs could not be listed or were not empty in ${repo} (${namespace}); the checkout is kept`;
  let answer: string | null = null;
  try {
    answer = check(namespace);
  } finally {
    if (!clearRefs(run, repo, namespace)) answer = uncleared(repo, namespace);
  }
  return answer;
};

/**
 * The first commit reachable from `positives` that `repo`'s remotes do not contain, as held work, or null. A notes ref
 * (CommitLore's records) is never a remote-tracking branch, so when the positives hold notes, origin's own notes refs
 * are fetched into `namespace` by this check and count as published too; notes that cannot be compared with origin's
 * are held work. Nothing but what this check fetched is ever read as origin's.
 */
const unpublishedCommit = (run: CtoExec, repo: string, positives: readonly string[], notes: boolean, namespace: string): string | null => {
  const originNotes = `${namespace}origin-notes/`;
  if (notes) {
    const fetched = run("git", ["-C", repo, "fetch", "--no-tags", "--quiet", "origin", `+refs/notes/*:${originNotes}*`], { timeoutMs: 120_000 });
    if (fetched.status !== 0) return `its notes could not be compared with origin's: ${firstLine(fetched.stderr)}`;
  }
  const ahead = run("git", ["-C", repo, "rev-list", "--max-count=1", ...positives, "--not", "--remotes", ...(notes ? [`--glob=${originNotes}*`] : [])], { timeoutMs: 120_000 });
  if (ahead.status !== 0) return `its commits could not be compared with ${repo}'s remotes: ${firstLine(ahead.stderr)}`;
  const commit = ahead.stdout.trim();
  return commit ? `commit ${commit.slice(0, 12)} is on no remote-tracking branch or notes ref of ${repo}'s origin` : null;
};

/**
 * Why a checkout holds work no remote has, or null only on proof that it holds none: its tree is clean, and every
 * commit reachable from HEAD or any of its refs (`--all`, stash and private refs included) is contained in its
 * remote-tracking refs, or for its notes in origin's notes refs. Neither the archive nor a worker is removed while
 * this answers, unless the repository goes too.
 */
export const checkoutHeldWork = (run: CtoExec, path: string): string | null => {
  const dirty = dirtyTree(run, path);
  if (dirty) return dirty;
  const notes = refsUnder(run, path, "refs/notes/");
  if (notes === null) return `${path}'s notes refs could not be listed`;
  return inFreshNamespace(run, path, (namespace) => unpublishedCommit(run, path, [`--exclude=${RETIRE_REFS}*`, "--all"], notes.length > 0, namespace));
};

/**
 * The same question for a worker checkout. A worker clone keeps no remote-tracking refs of its own, so its HEAD and
 * every one of its refs are fetched into a fresh namespace of the project's primary clone and compared there with that
 * clone's remote-tracking refs and origin's notes; the namespace is cleared again either way. Anything that cannot be
 * established, a fetch or a clear that git refuses included, answers as held work.
 */
export const workerHeldWork = (run: CtoExec, primary: string | null, worker: string): string | null => {
  const dirty = dirtyTree(run, worker);
  if (dirty) return dirty;
  if (primary === null) return "there is no primary clone to compare its commits with";
  return inFreshNamespace(run, primary, (namespace) => {
    const workerRefs = `${namespace}worker/`;
    const fetched = run("git", ["-C", primary, "fetch", "--no-tags", "--quiet", worker, `+refs/*:${workerRefs}*`, `+HEAD:${workerRefs}HEAD`], { timeoutMs: 120_000 });
    if (fetched.status !== 0) return `its commits could not be read into ${primary}: ${firstLine(fetched.stderr)}`;
    const refs = refsUnder(run, primary, workerRefs);
    if (refs === null || refs.length === 0) return `its commits could not be read into ${primary}`;
    return unpublishedCommit(run, primary, refs, refs.some((ref) => ref.startsWith(`${workerRefs}notes/`)), namespace);
  });
};

const retirePlan = (ports: CtoPorts, record: CtoRecord, options: { reason: string; deleteRepo: string | null }): CtoStep[] => {
  const projectId = record.projectId;
  const clone = cloneOf(record);
  const repoName = clone ? basename(clone) : null;
  const archive = repoName ? join(ports.home, "projects", ".retired", `${repoName}-${projectId}`) : null;
  const workerCheckouts = (): string[] => {
    const now = fresh(ports, projectId) ?? record;
    const from = cloneOf(now);
    return from ? now.repositories.map((r) => residentWorkerCheckoutPath(from, r.repositoryId)).filter((p) => ports.files.exists(p)) : [];
  };
  const fleetLines = (): { lines: string[]; ours: string[] } => {
    const manifest = join(fleetDir(ports), "manifest.tsv");
    const lines = ports.files.exists(manifest) ? ports.files.read(manifest).split("\n") : [];
    const conversation = fresh(ports, projectId)?.conversation ?? record.conversation;
    // The provisioner's own retirement rule, and an entry naming the conversation under any name.
    const ours = lines.filter((line) => {
      const fields = line.split("\t");
      return !line.startsWith("#") && (fields[0] === fleetNameOf(projectId) || (conversation !== null && fields[4] === conversation));
    });
    return { lines, ours };
  };
  const steps: CtoStep[] = [idleStep(ports, projectId), {
    id: "project-retire",
    plan: `agentctl project retire ${projectId}: ACP cancels the project's runs, stops the session, archives its Buzz room, retires its roster route, takes it off the fleet, moves its clone to ~/projects/.retired, and releases the PRIMARY_CTO binding`,
    done: () => fresh(ports, projectId)?.retiredAt != null,
    run: async () => {
      // A fresh key per attempt, as for project.register: a rerun asks the daemon again rather than reading its old answer.
      const retired = await ports.operator.request("project.retire", { projectId, reason: options.reason }, `cto:${ports.newUuid()}`);
      if (retired.allowed) return ok();
      const order = retired.evidence["requiredOrder"];
      return refused(`project retire refused: ${retired.message}`, { reasonCode: retired.reasonCode, ...(Array.isArray(order) ? { requiredOrder: order } : {}) });
    },
  }, stopStep(ports, projectId, "session-stopped"), {
    id: "roster",
    plan: "confirm the Hermes roster no longer routes the project's room",
    done: () => !routeActive(rosterRoute(ports, fresh(ports, projectId)?.room ?? record.room)),
    run: () => refused("the roster still routes the project's room as active; project retire retires it, so run this again or retire the route in required-mentions.json"),
  }, channelMapStep(ports, projectId, false), {
    id: "fleet",
    plan: `take the CTO off the fleet: no manifest.tsv entry for ${fleetNameOf(projectId)} or its conversation, and no ${fleetNameOf(projectId)}.resident.json for fleet recovery to relaunch it from`,
    done: () => fleetLines().ours.length === 0 && !ports.files.exists(residentRequestOf(ports, projectId)),
    run: () => {
      const { lines, ours } = fleetLines();
      if (ours.length > 0) ports.files.replace(join(fleetDir(ports), "manifest.tsv"), lines.filter((line) => !ours.includes(line)).join("\n"));
      ports.files.remove(residentRequestOf(ports, projectId));
      return ok({ removedEntries: ours.length });
    },
  }, {
    id: "tmux",
    plan: `end tmux session ${tmuxNameOf(projectId)} once nothing in it runs the conversation`,
    done: () => !tmuxExists(ports, tmuxNameOf(projectId)),
    run: async () => {
      if ((await roleProcesses(ports, projectId)).matches.length > 0) return refused("a process of this CTO role is still running; nothing was killed");
      const killed = ports.run("tmux", ["kill-session", "-t", `=${tmuxNameOf(projectId)}`], { timeoutMs: 5_000 });
      return killed.status === 0 || !tmuxExists(ports, tmuxNameOf(projectId)) ? ok() : refused(`tmux kill-session failed: ${firstLine(killed.stderr)}`);
    },
  }, {
    id: "worker-checkouts",
    plan: options.deleteRepo
      ? "remove the project's worker checkouts under ~/projects/.acp-worker-checkouts, each only if it is the worker clone ACP made from this project's clone"
      : "remove the project's worker checkouts under ~/projects/.acp-worker-checkouts, each only if it is the worker clone ACP made from this project's clone; one with uncommitted or untracked files, or a commit on HEAD or any ref that the primary clone's remotes do not have, is moved beside the archived clone instead, and listed",
    done: () => workerCheckouts().length === 0,
    run: () => {
      if (fresh(ports, projectId)?.retiredAt == null) return refused("the project is not retired yet; its worker checkouts may still be in use");
      const from = cloneOf(fresh(ports, projectId) ?? record);
      // The project's primary clone: archived by project retire, or still in place.
      const primary = archive !== null && ports.files.exists(archive) ? archive : from !== null && ports.files.exists(from) ? from : null;
      const removed: string[] = [];
      const kept: Array<{ path: string; movedTo: string; why: string }> = [];
      for (const path of workerCheckouts()) {
        const madeFrom = ports.run("git", ["-C", path, "config", "--get", "acp.residentClone"], { timeoutMs: 10_000 });
        if (madeFrom.status !== 0 || madeFrom.stdout.trim() !== from) return refused(`${path} is not a worker clone made from ${from}; it was left as it is`, { removed, kept });
        const repositoryId = basename(path);
        // The whole repository goes with --delete-repo, so its unpublished work is already given up.
        const why = options.deleteRepo ? null : workerHeldWork(ports.run, primary, path);
        if (why === null) {
          ports.files.remove(path);
          removed.push(path);
          continue;
        }
        const movedTo = `${archive ?? join(ports.home, "projects", ".retired", projectId)}.worker-${repositoryId}`;
        if (ports.files.exists(movedTo)) return refused(`${path} holds work no remote has (${why}) and ${movedTo} already exists; it was left as it is`, { removed, kept });
        ports.files.move(path, movedTo);
        kept.push({ path, movedTo, why });
      }
      return ok({ removed, kept });
    },
  }, {
    id: "local-checkout",
    plan: options.deleteRepo
      ? `remove the archived clone ${archive ?? "(none recorded)"} that project retire left`
      : `remove the archived clone ${archive ?? "(none recorded)"} that project retire left, unless it holds work no remote has`,
    // Before retirement the clone is still where it was and is not done; a path a later project reuses is never touched.
    done: () => (archive === null || !ports.files.exists(archive)) && !(clone !== null && ports.files.exists(clone) && fresh(ports, projectId)?.retiredAt == null),
    run: () => {
      if (fresh(ports, projectId)?.retiredAt == null) return refused("the project is not retired yet: its clone is still its CTO's");
      if (archive === null || !ports.files.exists(archive)) return ok();
      if (!options.deleteRepo) {
        const held = checkoutHeldWork(ports.run, archive);
        if (held) return refused(`${held}; push it or move it aside, or delete the repository too (--delete-repo)`);
      }
      ports.files.remove(archive);
      return ok({ removed: archive });
    },
  }];
  if (options.deleteRepo) {
    const repo = options.deleteRepo;
    const gone = (): boolean => {
      const read = ports.run("gh", ["api", `repos/${repo}`, "--jq", ".full_name"], { timeoutMs: 30_000 });
      return read.status !== 0 && /HTTP 404|Not Found/.test(read.stderr);
    };
    steps.push({
      id: "github-repo",
      plan: `delete the GitHub repository ${repo} (gh repo delete): irreversible`,
      done: gone,
      run: () => {
        const deleted = ports.run("gh", ["repo", "delete", repo, "--yes"], { timeoutMs: 60_000 });
        if (deleted.status !== 0) return refused(`gh repo delete ${repo} failed: ${firstLine(deleted.stderr)}`);
        return gone() ? ok({ deleted: repo }) : refused(`gh repo delete ${repo} answered, and the repository still reads back`);
      },
    });
  }
  return steps;
};

/** Prints the plan; applied, runs it in order, stopping at the first failure. */
export const executeCtoPlan = async (ports: CtoPorts, header: Record<string, unknown>, steps: CtoStep[], apply: boolean, rerun: string): Promise<number> => {
  ports.write({ ...header, mode: apply ? "apply" : "dry-run", steps: steps.map((s) => s.id) });
  if (!apply) {
    for (const step of steps) {
      let already: boolean | "unknown" = false;
      try { already = step.done ? await step.done() : false; } catch { already = "unknown"; }
      ports.write({ step: step.id, plan: step.plan, already });
    }
    ports.write({ result: "dry-run", note: "nothing was changed; add --apply to run this plan" });
    return 0;
  }
  for (const step of steps) {
    let outcome: Outcome;
    try {
      if (step.done && (await step.done())) { ports.write({ step: step.id, result: "skipped" }); continue; }
      outcome = await step.run();
    } catch (error) {
      outcome = refused(error instanceof Error ? error.message : String(error));
    }
    if (!outcome.ok) {
      ports.write({ step: step.id, result: "failed", reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) });
      ports.write({ result: "stopped", at: step.id, rerun });
      return 1;
    }
    ports.write({ step: step.id, result: "done", ...(outcome.detail ? { detail: outcome.detail } : {}) });
  }
  ports.write({ result: "done" });
  return 0;
};

const BOOLEAN_FLAGS = new Set(["--apply", "--canonical", "--delete-repo", "--fresh"]);
const VALUE_FLAGS = new Set(["--reason", "--repo", "--yes-delete-repo", "--conversation"]);
const ALLOWED: Record<string, readonly string[]> = {
  add: ["--apply", "--repo", "--canonical"],
  relaunch: ["--apply", "--fresh", "--conversation"],
  retire: ["--apply", "--reason", "--delete-repo", "--yes-delete-repo"],
};

const refuse = (ports: CtoPorts, message: string): number => {
  ports.write({ refused: message, nothingChanged: true });
  return 2;
};

export const runCtoCommand = async (args: readonly string[], ports: CtoPorts): Promise<number> => {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") { ports.write({ usage: CTO_USAGE }); return sub ? 0 : 2; }
  if (sub === "list") return rest.length === 0 ? await listCtos(ports) : refuse(ports, "cto list takes no arguments");
  const allowed = ALLOWED[sub];
  if (!allowed) return refuse(ports, `unknown cto subcommand: ${sub}`);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!allowed.includes(arg)) return refuse(ports, `cto ${sub} does not take ${arg}`);
    if (flags.has(arg)) return refuse(ports, `${arg} is given twice`);
    if (BOOLEAN_FLAGS.has(arg)) { flags.set(arg, true); continue; }
    const value = rest[i + 1];
    if (!VALUE_FLAGS.has(arg) || value === undefined || value.startsWith("--") || !value.trim()) return refuse(ports, `${arg} needs a value`);
    flags.set(arg, value);
    i++;
  }
  const value = (flag: string): string | null => { const v = flags.get(flag); return typeof v === "string" ? v : null; };
  if (positional.length !== 1 || !PROJECT_ID.test(positional[0]!)) return refuse(ports, `cto ${sub} takes exactly one project id`);
  const projectId = positional[0]!;
  const apply = flags.has("--apply");
  // Operator only: a CTO's launch shell unsets ACP_OPERATOR_TOKEN, so a CTO cannot apply any of these. A token that is
  // merely set proves nothing, and several steps change the host without the daemon, so before any of them the daemon
  // must authenticate it: one read-only request over the operator socket. Every --apply asks, cleanup-only reruns included.
  if (apply && !ports.env["ACP_OPERATOR_TOKEN"]) return refuse(ports, "--apply is operator only and needs ACP_OPERATOR_TOKEN; nothing was changed");
  if (apply) {
    const authenticated = await ports.operator.request("daemon.status", {});
    if (!authenticated.allowed) return refuse(ports, `--apply is operator only: the daemon did not authenticate this credential (${authenticated.reasonCode}); nothing was changed`);
  }
  const rerun = `agentctl cto ${args.map((a) => (/^[A-Za-z0-9._/:=@-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;
  const record = fresh(ports, projectId);

  if (sub === "add") {
    const repo = value("--repo");
    if (repo !== null && !REPO.test(repo)) return refuse(ports, "--repo must be <owner/name>");
    if (record?.retiredAt) return refuse(ports, `project ${projectId} is retired; a retired project is not added back`);
    return executeCtoPlan(ports, { command: "add", project: projectId }, addPlan(ports, projectId, { repo, canonical: flags.has("--canonical") }), apply, rerun);
  }
  if (!record) return refuse(ports, `unknown project: ${projectId}`);
  if (sub === "relaunch") {
    if (record.retiredAt) return refuse(ports, `project ${projectId} is retired`);
    if (record.kind === "none") return refuse(ports, `project ${projectId} has no CTO allocation or entitlement to relaunch`);
    const conversation = value("--conversation");
    if (conversation !== null && (!UUID.test(conversation) || record.kind !== "canonical" || flags.has("--fresh"))) {
      return refuse(ports, "--conversation takes a conversation uuid, for a canonical CTO, and not with --fresh");
    }
    if (flags.has("--fresh")) {
      if (record.kind !== "canonical" || !record.conversation) return refuse(ports, "--fresh needs a canonical CTO with a bound conversation");
      const next = ports.newUuid();
      const code = await executeCtoPlan(ports, { command: "relaunch", project: projectId, kind: record.kind, fresh: true, oldConversation: record.conversation, newConversation: next },
        freshSteps(ports, record, next), apply, rerun);
      // No rollback: the old conversation is only resumed by this command, run by the operator.
      if (code !== 0) ports.write({ oldConversation: record.conversation, recovery: `agentctl cto relaunch ${projectId} --conversation ${record.conversation} --apply` });
      return code;
    }
    return executeCtoPlan(ports, { command: "relaunch", project: projectId, kind: record.kind }, relaunchPlan(ports, record, conversation ?? undefined), apply, rerun);
  }
  // retire
  const reason = value("--reason");
  if (!reason) return refuse(ports, "cto retire needs --reason <text>");
  const confirmation = value("--yes-delete-repo");
  let deleteRepo: string | null = null;
  if (flags.has("--delete-repo") || confirmation !== null) {
    const repos = record.repositories.map((r) => githubRepoOf(r.identity)).filter((r): r is string => r !== null);
    if (!flags.has("--delete-repo")) return refuse(ports, "--yes-delete-repo confirms --delete-repo, which was not given");
    if (repos.length !== 1) return refuse(ports, `--delete-repo needs the project to have exactly one GitHub repository; it has ${repos.length}`);
    if (confirmation !== repos[0]) return refuse(ports, `--delete-repo deletes ${repos[0]} and needs --yes-delete-repo ${repos[0]} exactly; nothing was changed`);
    deleteRepo = repos[0]!;
  }
  return executeCtoPlan(ports, { command: "retire", project: projectId, kind: record.kind, ...(deleteRepo ? { deletesRepository: deleteRepo } : {}) },
    retirePlan(ports, record, { reason, deleteRepo }), apply, rerun);
};

// ---------------------------------------------------------------------------------------------------------------
// Production ports.

/** The install-time binary pins the daemon's launcher was rendered with, read when the caller set none: paths only. */
const launcherPins = (stateDir: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const pins: Record<string, string> = {};
  let text = "";
  try { text = readFileSync(join(stateDir, "agentcpd-launch.sh"), "utf8"); } catch { return pins; }
  for (const name of ["CLAUDE", "BUZZ"]) {
    if (env[`ACP_${name}_BINARY`] || env[`ACP_RESOLVED_${name}_BINARY`]) continue;
    const pin = new RegExp(`^ACP_RESOLVED_${name}_BINARY=(/[^\\s'"$;]+)$`, "m").exec(text)?.[1];
    if (pin) pins[`ACP_RESOLVED_${name}_BINARY`] = pin;
  }
  return pins;
};

const firstExisting = (paths: readonly (string | undefined)[]): string | null => paths.find((p) => p && existsSync(p)) ?? null;

interface ProjectRow { project_id: string; name: string; retired_at: string | null }

/** ACP's database, read only and opened for each read, so every answer is current. */
export const openCtoState = async (databasePath: string): Promise<CtoStateReader> => {
  const { default: Database } = await import("better-sqlite3");
  const withDb = <T>(read: (db: InstanceType<typeof Database>) => T): T => {
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { return read(db); } finally { db.close(); }
  };
  const recordOf = (db: InstanceType<typeof Database>, p: ProjectRow): CtoRecord => {
    const id = p.project_id;
    const get = <T>(sql: string, ...params: unknown[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
    const repositories = db.prepare(`SELECT repository_id AS repositoryId, identity, checkout_path AS checkoutPath FROM repositories WHERE project_id = ? ORDER BY repository_id`).all(id) as CtoRepository[];
    const binding = get<{ generation: number; locator: string | null; pid: number | null; startedAt: string | null; workdir: string | null }>(
      `SELECT a.binding_generation AS generation, tb.target_locator AS locator, s.os_pid AS pid, s.os_process_started_at AS startedAt, s.workdir AS workdir
         FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
         LEFT JOIN sessions s ON s.session_id = c.current_session_id
         LEFT JOIN actor_target_bindings tb ON tb.target_actor_id = a.actor_id
        WHERE a.project_id = ? AND a.role = 'PRIMARY_CTO' AND a.status = 'ACTIVE'`, id);
    const entitlement = get<{ sessionUuid: string; actorId: string; room: string }>(
      `SELECT session_uuid AS sessionUuid, buzz_actor_id AS actorId, buzz_address AS room FROM canonical_session_entitlements WHERE project_id = ?`, id);
    const claimed = get<{ sessionUuid: string; actorId: string; room: string }>(
      `SELECT to_session_uuid AS sessionUuid, buzz_actor_id AS actorId, buzz_address AS room FROM canonical_entitlement_transfers
        WHERE project_id = ? AND claimed_at IS NOT NULL ORDER BY claimed_binding_generation DESC, claimed_at DESC, transfer_id DESC LIMIT 1`, id);
    const provisioning = get<{ status: string; allocation: string; steps: string }>(
      `SELECT status, allocation_json AS allocation, steps_json AS steps FROM resident_project_provisioning
        WHERE project_id = ? ORDER BY status = 'RETIRED', updated_at DESC, run_id DESC LIMIT 1`, id);
    let allocation: Record<string, unknown> | null = null;
    if (provisioning) {
      const parsed = JSON.parse(provisioning.allocation) as Record<string, unknown>;
      const bound = (JSON.parse(provisioning.steps) as { roomBinding?: { roomId?: string } }).roomBinding?.roomId;
      allocation = typeof parsed["sessionUuid"] === "string" ? { ...parsed, ...(bound ? { roomId: bound } : {}) } : null;
    }
    const locator = binding?.locator && UUID.test(binding.locator) ? binding.locator : null;
    const room = claimed?.room ?? entitlement?.room ?? (typeof allocation?.["roomId"] === "string" ? allocation["roomId"] as string : null);
    const last = room ? get<{ at: number | null }>(
      `SELECT MAX(json_extract(e.payload_json, '$.created_at')) AS at FROM buzz_events e, json_each(json_extract(e.payload_json, '$.tags')) t
        WHERE json_extract(t.value, '$[0]') = 'h' AND json_extract(t.value, '$[1]') = ?`, room) : undefined;
    return {
      projectId: id,
      name: p.name,
      retiredAt: p.retired_at,
      kind: provisioning ? "resident" : entitlement ? "canonical" : "none",
      repositories,
      conversation: locator ?? claimed?.sessionUuid ?? entitlement?.sessionUuid ?? (typeof allocation?.["sessionUuid"] === "string" ? allocation["sessionUuid"] as string : null),
      generation: binding?.generation ?? null,
      session: binding ? { pid: binding.pid, startedAt: binding.startedAt, workdir: binding.workdir } : null,
      room,
      actorId: claimed?.actorId ?? entitlement?.actorId ?? null,
      resident: provisioning ? { status: provisioning.status, allocation } : null,
      lastBuzzAt: typeof last?.at === "number" ? new Date(last.at * 1000).toISOString() : null,
    };
  };
  return {
    projects: () => withDb((db) => (db.prepare(`SELECT project_id, name, retired_at FROM projects WHERE retired_at IS NULL ORDER BY name, project_id`).all() as ProjectRow[]).map((p) => recordOf(db, p))),
    project: (projectId) => withDb((db) => {
      const row = db.prepare(`SELECT project_id, name, retired_at FROM projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
      return row ? recordOf(db, row) : null;
    }),
    openRuns: (projectId) => withDb((db) => (db.prepare(
      `SELECT run_id AS runId, state, kind FROM runs WHERE (project_id = ? OR owner_role_key = ?) AND state NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at DESC, run_id LIMIT 10`)
      .all(projectId, `PRIMARY_CTO:${projectId}`) as Array<{ runId: string; state: string; kind: string }>)),
    roleScope: (projectId, extra) => withDb((db) => ctoRoleScope(<T>(sql: string, params: readonly unknown[]) => db.prepare(sql).all(...params) as T[], projectId, extra)),
  };
};

/** Subprocesses as the command runs them on the host: bounded, no shell, stdout and stderr captured. */
export const hostRunner = (env: Readonly<Record<string, string | undefined>>): CtoExec => (bin, args, options = {}) => {
  const result = spawnSync(bin, [...args], {
    encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 8_000_000, cwd: options.cwd,
    env: (options.env ?? env) as NodeJS.ProcessEnv, ...(options.input !== undefined ? { input: options.input } : { stdio: ["ignore", "pipe", "pipe"] }),
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error.message) : "") };
};

export const createCtoPorts = async (input: {
  databasePath: string; operator: CtoOperator; env: Readonly<Record<string, string | undefined>>;
}): Promise<CtoPorts> => {
  const stateDir = join(input.databasePath, "..");
  const home = input.env["HOME"] ?? "";
  const env = { ...input.env, ...launcherPins(stateDir, input.env) };
  const runner = hostRunner(env);
  return {
    home, stateDir, databasePath: input.databasePath, env, operator: input.operator, run: runner,
    state: await openCtoState(input.databasePath),
    ctoProcesses: systemCtoProcessReader(),
    startToken: readProcessStartToken,
    kernelGone: (pid) => {
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    },
    signal: (pid, signal) => { process.kill(pid, signal); },
    files: {
      exists: existsSync,
      read: (path) => readFileSync(path, "utf8"),
      replace: (path, body, mode = 0o600) => { const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, body, { mode }); renameSync(tmp, path); },
      move: (from, to) => { mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); renameSync(from, to); },
      remove: (path) => rmSync(path, { recursive: true, force: true }),
      mtimeMs: (path) => { try { return statSync(path).mtimeMs; } catch { return null; } },
    },
    publicKeyOf: (keyFile) => { try { return daemonBuzzSigner(readFileSync(keyFile, "utf8")); } catch { return null; } },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newUuid: () => randomUUID(),
    write: (line) => { process.stdout.write(`${JSON.stringify(line)}\n`); },
    node: process.execPath,
    scripts: {
      // The packaged copy beside this build, then the source tree (a generation keeps both).
      provisioner: firstExisting([env["ACP_HOST_PROJECT_PROVISIONER"], fileURLToPath(new URL("../host/host-project-provisioner.mjs", import.meta.url)),
        fileURLToPath(new URL("../../scripts/host-project-provisioner.mjs", import.meta.url))]),
    },
  };
};
