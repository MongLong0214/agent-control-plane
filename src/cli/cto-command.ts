import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Decision } from "../core/errors.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { residentWorkerCheckoutPath } from "../core/resident-allocation-paths.ts";
import { daemonBuzzSigner } from "../outbox/ceo-buzz-signer.ts";
import { BUZZ_CHANNEL_SERVER, CHANNEL_DEV_FLAG } from "../runtime/cto-channel-launch.ts";
import { readHostProvisionerReason, recordedResidentExitStatus } from "../runtime/host-provisioner-reason.ts";

/**
 * `agentctl cto` — one operator command group for a project CTO's whole life on this host: list, add, relaunch and
 * retire. It composes the pieces that already exist and reinvents none of them:
 *
 *   - ACP's own operator methods (`project.register`, `project.retire`) over the authenticated operator socket;
 *   - the host project provisioner (`ensure-routing`, `ensure-resident`, `acknowledge-resident-exit`), the launcher a
 *     resident CTO and the fleet watcher already use, which carries the acp-buzz-channel and resumes the conversation;
 *   - `scripts/rotate-canonical-cto.mjs`, the canonical CTO's launcher;
 *   - Hermes's `buzz-identity-map.sh`, which rebuilds channel-cto.map from the roster;
 *   - `tmux`, `git` and `gh` for the session, the checkouts and the repository.
 *
 * Every mutating subcommand prints its plan and changes nothing unless `--apply` is given. Applied, the steps run in
 * the plan's order; each reports done, skipped (already in the state it brings about) or failed, and the first failure
 * stops the run. Each step's "already done" is read from the world, not from a record of an earlier run, so running
 * the same command again continues where it stopped.
 *
 * Operator only. `--apply` needs ACP_OPERATOR_TOKEN, which every CTO launch shell unsets, and none of this is a tool
 * on a CTO's acp-cto surface: a CTO cannot retire or relaunch another.
 */

export const CTO_SUBCOMMANDS = ["list", "add", "relaunch", "retire"] as const;

export const CTO_USAGE = `agentctl cto — a project CTO's lifecycle on this host (operator only)

  agentctl cto list
      every CTO: project, binding generation, live session (pid, tmux), whether the session carries
      the acp-buzz-channel, its room, whether the roster routes that room, and its last Buzz activity
  agentctl cto add <project> [--repo <owner/name>] [--canonical] [--handoff <package.json>] [--apply]
      register the project if missing (cloning --repo into ~/projects), check its Buzz identity and
      room, bind the roster, rebuild channel-cto.map, and start the CTO with the channel: a resident
      through ensure-resident (which writes the resident request and the fleet entry), a canonical
      CTO (--canonical) through rotate-canonical-cto, which needs --handoff
  agentctl cto relaunch <project> [--handoff <package.json>] [--apply]
      wait for an idle CTO, then restart it with the channel: a resident is stopped (its exact pid)
      and started again by ensure-resident with --resume, the same conversation; a canonical CTO
      goes through rotate-canonical-cto, which moves it to a new conversation and needs --handoff
  agentctl cto retire <project> --reason <text> [--delete-repo --yes-delete-repo <owner/name>] [--apply]
      wait for an idle CTO, then agentctl project retire (stops the session, releases the binding,
      archives its room, retires its roster route, takes it off the fleet), confirm the session,
      roster map, fleet manifest and tmux session are gone, and remove the worker checkouts and the
      archived local clone (a clone holding work found nowhere else is kept unless the repository is
      deleted too). --delete-repo also runs gh repo delete, last; it is irreversible and needs
      --yes-delete-repo naming the repository exactly

  Without --apply nothing is changed: the plan is printed, with each step already done or not.
  With --apply each step prints done, skipped or failed, and the first failure stops the run;
  running the same command again continues from where it stopped. Output is one JSON object a line.
`;

/** What one subprocess answered. `status` is null when it could not be started or ran out of time. */
export interface CtoExecResult { status: number | null; stdout: string; stderr: string }
export interface CtoExecOptions { cwd?: string; input?: string; env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number }
export type CtoExec = (bin: string, args: readonly string[], options?: CtoExecOptions) => CtoExecResult;
export interface CtoProcess { pid: number; ppid: number; command: string }
export interface CtoFiles {
  exists(path: string): boolean;
  read(path: string): string;
  /** Replaces the file whole (written beside it, then renamed into place). */
  replace(path: string, body: string): void;
  /** Removes a file or a directory tree. */
  remove(path: string): void;
  mtimeMs(path: string): number | null;
}

/** The operator socket, as `agentctl`'s own client speaks it. */
export interface CtoOperator { request(method: string, params?: Record<string, unknown>): Promise<Decision<unknown>> }

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
  pendingRotation: { toSessionUuid: string; fromGeneration: number } | null;
  lastBuzzAt: string | null;
}
export interface CtoStateReader {
  projects(): CtoRecord[];
  project(projectId: string): CtoRecord | null;
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
  processes(): CtoProcess[];
  startToken(pid: number): string | null;
  signal(pid: number, signal: "SIGTERM"): void;
  files: CtoFiles;
  /** The Buzz public key of a key file, never its contents; null when it cannot be read. */
  publicKeyOf(keyFile: string): string | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newUuid(): string;
  write(line: Record<string, unknown>): void;
  node: string;
  scripts: { provisioner: string | null; rotate: string | null };
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

/** Processes whose argv runs `uuid` as a Claude conversation, the rule the provisioner and the rotation launcher use. */
const conversationProcesses = (ports: CtoPorts, uuid: string | null): CtoProcess[] => {
  if (!uuid || !UUID.test(uuid)) return [];
  const names = new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${uuid}(?:\\s|$)`);
  return ports.processes().filter((p) => names.test(p.command));
};
const carriesChannel = (command: string): boolean => command.includes(`${CHANNEL_DEV_FLAG} server:${BUZZ_CHANNEL_SERVER}`);
const alive = (ports: CtoPorts, pid: number | null | undefined): boolean => Boolean(pid) && ports.processes().some((p) => p.pid === pid);

/** The tmux session one of whose panes is `pid` or an ancestor of it. */
const tmuxOf = (ports: CtoPorts, pid: number): string | null => {
  const listed = ports.run("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{session_name}"], { timeoutMs: 5_000 });
  if (listed.status !== 0) return null;
  const panes = new Map<number, string>();
  for (const line of listed.stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) panes.set(Number(line.slice(0, at)), line.slice(at + 1));
  }
  const parents = new Map(ports.processes().map((p) => [p.pid, p.ppid]));
  for (let current: number | undefined = pid, hops = 0; current && current > 1 && hops < 64; hops++) {
    const session = panes.get(current);
    if (session) return session;
    current = parents.get(current);
  }
  return null;
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
  run: () => {
    const record = fresh(ports, projectId);
    const uuid = record?.conversation ?? null;
    const live = conversationProcesses(ports, uuid);
    if (!record || live.length === 0) return ok({ running: false });
    const cwd = record.session?.workdir ?? cloneOf(record);
    const mtime = cwd ? ports.files.mtimeMs(transcriptOf(ports, cwd, uuid!)) : null;
    if (mtime === null) return refused(`conversation ${uuid} is running and its transcript cannot be found, so whether it is mid-turn is unknown`);
    const quiet = Math.floor((ports.now() - mtime) / 1000);
    if (quiet < IDLE_SECONDS) return refused(`conversation ${uuid} wrote its transcript ${quiet}s ago and may be mid-turn; run this again once it has been idle for ${IDLE_SECONDS}s`);
    return ok({ running: true, quietSeconds: quiet });
  },
});

/**
 * SIGTERM to exactly the one process running the conversation, never to anything else, then its exit confirmed by its
 * start token changing. ACP's recorded pid, when that process is alive, must be the same process.
 */
const stopStep = (ports: CtoPorts, projectId: string, id = "stop"): CtoStep => ({
  id,
  plan: "send SIGTERM to the one claude process running the CTO's conversation, nothing else, and wait for it to exit",
  done: () => conversationProcesses(ports, fresh(ports, projectId)?.conversation ?? null).length === 0,
  run: async () => {
    const record = fresh(ports, projectId);
    const uuid = record?.conversation ?? null;
    const live = conversationProcesses(ports, uuid);
    if (live.length === 0) return ok({ running: false });
    if (live.length > 1) return refused(`${live.length} processes run conversation ${uuid} (${live.map((p) => p.pid).join(", ")}); nothing was signalled`);
    const target = live[0]!;
    const recorded = record?.session?.pid ?? null;
    if (recorded && recorded !== target.pid && alive(ports, recorded)) {
      return refused(`ACP records pid ${recorded} for this CTO, which is alive, but pid ${target.pid} runs its conversation; nothing was signalled`);
    }
    const start = ports.startToken(target.pid);
    if (start === null) return refused(`pid ${target.pid}'s start time cannot be read, so its exit could not be confirmed; nothing was signalled`);
    try { ports.signal(target.pid, "SIGTERM"); } catch (error) {
      // Gone between the read and the signal is the outcome this step wants; anything else is reported.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (const deadline = ports.now() + STOP_TIMEOUT_MS; ports.startToken(target.pid) === start;) {
      if (ports.now() >= deadline) return refused(`pid ${target.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s of SIGTERM; nothing else was signalled`);
      await ports.sleep(POLL_MS);
    }
    return ok({ pid: target.pid });
  },
});

/** The provisioner's ensure-resident: MCP entry, resident request, boot packet, fleet entry and a launch with the channel. */
const residentLaunchStep = (ports: CtoPorts, projectId: string): CtoStep => ({
  id: "launch",
  plan: "start the resident through the host provisioner's ensure-resident, the fleet watcher's launcher: it writes the resident request, boot packet and fleet entry and starts claude with the acp-buzz-channel, resuming the conversation it has a record of",
  done: () => conversationProcesses(ports, fresh(ports, projectId)?.conversation ?? null).some((p) => carriesChannel(p.command)),
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

/**
 * The canonical CTO's launcher, called as it is. It refuses before touching anything when the project's room, Buzz
 * identity or key disagree, stops the old conversation only at a safe boundary, and starts the new one with the
 * channel. A switchover it left pending is resumed by handing it the same conversation again.
 */
const rotateStep = (ports: CtoPorts, projectId: string, handoff: string | null, to: string): CtoStep => ({
  id: "rotate",
  plan: `run rotate-canonical-cto to move the canonical CTO to conversation ${to}: it fences and stops the old conversation at a safe boundary, starts the new one in tmux session cto-${projectId}-${to.slice(0, 8)} with the acp-buzz-channel, and verifies its claim and Buzz delivery`,
  done: () => {
    const record = fresh(ports, projectId);
    return record?.conversation === to && conversationProcesses(ports, to).some((p) => carriesChannel(p.command));
  },
  run: () => {
    if (!handoff) return refused("--handoff <package.json> is required: rotate-canonical-cto starts the new conversation from that handoff package");
    if (!ports.scripts.rotate) return refused("rotate-canonical-cto.mjs was not found (set ACP_ROTATE_CANONICAL_CTO)");
    const record = fresh(ports, projectId);
    if (!record || record.generation === null) return refused("the project's PRIMARY_CTO role is unbound: rotate-canonical-cto moves a CTO that holds it");
    const old = conversationProcesses(ports, record.conversation);
    if (old.length > 1) return refused(`${old.length} processes run conversation ${record.conversation}; nothing was started`);
    const cwd = record.session?.workdir ?? cloneOf(record);
    if (!cwd) return refused("the CTO's working directory is not recorded");
    const expected = record.pendingRotation?.toSessionUuid === to ? record.pendingRotation.fromGeneration : record.generation;
    const answer = ports.run(ports.node, [ports.scripts.rotate,
      "--project", projectId, "--to", to, "--expected-generation", String(expected), "--cwd", cwd,
      "--old-pid", String(old[0]?.pid ?? record.session?.pid ?? 0), "--tmux-session", `cto-${projectId}-${to.slice(0, 8)}`, "--handoff", handoff,
    ], { env: scriptEnv(ports), timeoutMs: 600_000 });
    const last = lastJsonLine(answer.stdout) ?? {};
    if (answer.status !== 0) return refused(`rotate-canonical-cto exited ${answer.status ?? "on timeout"} at its ${String(last["step"] ?? "first")} step`, last);
    return ok(last);
  },
});

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

const listCtos = (ports: CtoPorts): number => {
  const rows = ports.state.projects().filter((r) => r.kind !== "none" || r.generation !== null).map((record) => {
    const live = conversationProcesses(ports, record.conversation);
    const route = rosterRoute(ports, record.room);
    return {
      project: record.projectId,
      name: record.name,
      kind: record.kind,
      generation: record.generation,
      conversation: record.conversation,
      session: live.length === 0 ? null : live.map((p) => ({ pid: p.pid, tmux: tmuxOf(ports, p.pid), channel: carriesChannel(p.command) })),
      room: record.room,
      roomRouted: routeActive(route) && route!.acp_project_id === record.projectId,
      lastBuzzAt: record.lastBuzzAt,
    };
  });
  ports.write({ ctos: rows });
  return 0;
};

const addPlan = (ports: CtoPorts, projectId: string, options: { repo: string | null; canonical: boolean; handoff: string | null }): CtoStep[] => {
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
      const registered = await ports.operator.request("project.register", { name: projectId, checkoutPath: checkout, projectId });
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
    run: () => refused(options.canonical
      ? "ACP holds no canonical entitlement for this project: a canonical CTO's conversation, Buzz identity and room are granted from ACP_CANONICAL_SESSIONS_JSON at daemon start"
      : "ACP holds no resident allocation for this project: a resident CTO's conversation, Buzz identity and room are allocated by its repo-factory bootstrap; pass --canonical for a canonical CTO"),
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
  if (options.canonical) {
    const record = fresh(ports, projectId);
    steps.push(rotateStep(ports, projectId, options.handoff, record?.pendingRotation?.toSessionUuid ?? ports.newUuid()));
  } else {
    steps.push(residentLaunchStep(ports, projectId));
  }
  return steps;
};

const relaunchPlan = (ports: CtoPorts, record: CtoRecord, handoff: string | null): CtoStep[] => {
  const projectId = record.projectId;
  if (record.kind === "resident") return [idleStep(ports, projectId), stopStep(ports, projectId), residentLaunchStep(ports, projectId)];
  return [idleStep(ports, projectId), rotateStep(ports, projectId, handoff, record.pendingRotation?.toSessionUuid ?? ports.newUuid())];
};

/** Neither the worker clones nor the archive are removed while they hold something no remote has, unless the repo goes too. */
const localOnlyWork = (ports: CtoPorts, path: string): string | null => {
  const status = ports.run("git", ["-C", path, "status", "--porcelain=v1"], { timeoutMs: 30_000 });
  if (status.status !== 0) return `git status failed in ${path}: ${firstLine(status.stderr)}`;
  if (status.stdout.trim()) return `${path} has uncommitted changes`;
  const unpushed = ports.run("git", ["-C", path, "log", "--branches", "--not", "--remotes", "--format=%H", "-n", "1"], { timeoutMs: 30_000 });
  if (unpushed.status !== 0) return `git log failed in ${path}: ${firstLine(unpushed.stderr)}`;
  return unpushed.stdout.trim() ? `${path} has commits on a local branch that no remote-tracking branch contains` : null;
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
      const retired = await ports.operator.request("project.retire", { projectId, reason: options.reason });
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
    run: () => {
      if (conversationProcesses(ports, fresh(ports, projectId)?.conversation ?? record.conversation).length > 0) return refused("the conversation is still running; nothing was killed");
      const killed = ports.run("tmux", ["kill-session", "-t", `=${tmuxNameOf(projectId)}`], { timeoutMs: 5_000 });
      return killed.status === 0 || !tmuxExists(ports, tmuxNameOf(projectId)) ? ok() : refused(`tmux kill-session failed: ${firstLine(killed.stderr)}`);
    },
  }, {
    id: "worker-checkouts",
    plan: "remove the project's worker checkouts under ~/projects/.acp-worker-checkouts, each only if it is the worker clone ACP made from this project's clone",
    // A worker clone carries no remote-tracking refs, so whether its commits were published cannot be read here: removing it discards any that were not.
    done: () => workerCheckouts().length === 0,
    run: () => {
      if (fresh(ports, projectId)?.retiredAt == null) return refused("the project is not retired yet; its worker checkouts may still be in use");
      const from = cloneOf(fresh(ports, projectId) ?? record);
      const removed: string[] = [];
      for (const path of workerCheckouts()) {
        const madeFrom = ports.run("git", ["-C", path, "config", "--get", "acp.residentClone"], { timeoutMs: 10_000 });
        if (madeFrom.status !== 0 || madeFrom.stdout.trim() !== from) return refused(`${path} is not a worker clone made from ${from}; it was left as it is`, { removed });
        ports.files.remove(path);
        removed.push(path);
      }
      return ok({ removed });
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
        const held = localOnlyWork(ports, archive);
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

const BOOLEAN_FLAGS = new Set(["--apply", "--canonical", "--delete-repo"]);
const VALUE_FLAGS = new Set(["--reason", "--repo", "--handoff", "--yes-delete-repo"]);
const ALLOWED: Record<string, readonly string[]> = {
  add: ["--apply", "--repo", "--canonical", "--handoff"],
  relaunch: ["--apply", "--handoff"],
  retire: ["--apply", "--reason", "--delete-repo", "--yes-delete-repo"],
};

const refuse = (ports: CtoPorts, message: string): number => {
  ports.write({ refused: message, nothingChanged: true });
  return 2;
};

export const runCtoCommand = async (args: readonly string[], ports: CtoPorts): Promise<number> => {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help") { ports.write({ usage: CTO_USAGE }); return sub ? 0 : 2; }
  if (sub === "list") return rest.length === 0 ? listCtos(ports) : refuse(ports, "cto list takes no arguments");
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
  // Operator only: a CTO's launch shell unsets ACP_OPERATOR_TOKEN, so a CTO cannot apply any of these.
  if (apply && !ports.env["ACP_OPERATOR_TOKEN"]) return refuse(ports, "--apply is operator only and needs ACP_OPERATOR_TOKEN; nothing was changed");
  const rerun = `agentctl cto ${args.map((a) => (/^[A-Za-z0-9._/:=@-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;
  const record = fresh(ports, projectId);

  if (sub === "add") {
    const repo = value("--repo");
    if (repo !== null && !REPO.test(repo)) return refuse(ports, "--repo must be <owner/name>");
    if (record?.retiredAt) return refuse(ports, `project ${projectId} is retired; a retired project is not added back`);
    return executeCtoPlan(ports, { command: "add", project: projectId }, addPlan(ports, projectId, { repo, canonical: flags.has("--canonical"), handoff: value("--handoff") }), apply, rerun);
  }
  if (!record) return refuse(ports, `unknown project: ${projectId}`);
  if (sub === "relaunch") {
    if (record.retiredAt) return refuse(ports, `project ${projectId} is retired`);
    if (record.kind === "none") return refuse(ports, `project ${projectId} has no CTO allocation or entitlement to relaunch`);
    return executeCtoPlan(ports, { command: "relaunch", project: projectId, kind: record.kind }, relaunchPlan(ports, record, value("--handoff")), apply, rerun);
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
    const pending = get<{ toSessionUuid: string; fromGeneration: number }>(
      `SELECT t.to_session_uuid AS toSessionUuid, r.from_generation AS fromGeneration FROM canonical_entitlement_transfers t
         JOIN canonical_cto_rotations r ON r.transfer_id = t.transfer_id WHERE t.project_id = ? AND t.claimed_at IS NULL AND t.revoked_at IS NULL`, id);
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
      pendingRotation: pending ?? null,
      lastBuzzAt: typeof last?.at === "number" ? new Date(last.at * 1000).toISOString() : null,
    };
  };
  return {
    projects: () => withDb((db) => (db.prepare(`SELECT project_id, name, retired_at FROM projects WHERE retired_at IS NULL ORDER BY name, project_id`).all() as ProjectRow[]).map((p) => recordOf(db, p))),
    project: (projectId) => withDb((db) => {
      const row = db.prepare(`SELECT project_id, name, retired_at FROM projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
      return row ? recordOf(db, row) : null;
    }),
  };
};

export const createCtoPorts = async (input: {
  databasePath: string; operator: CtoOperator; env: Readonly<Record<string, string | undefined>>;
}): Promise<CtoPorts> => {
  const stateDir = join(input.databasePath, "..");
  const home = input.env["HOME"] ?? "";
  const env = { ...input.env, ...launcherPins(stateDir, input.env) };
  const runner: CtoExec = (bin, args, options = {}) => {
    const result = spawnSync(bin, [...args], {
      encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 8_000_000, cwd: options.cwd,
      env: (options.env ?? env) as NodeJS.ProcessEnv, ...(options.input !== undefined ? { input: options.input } : { stdio: ["ignore", "pipe", "pipe"] }),
    });
    return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error.message) : "") };
  };
  return {
    home, stateDir, databasePath: input.databasePath, env, operator: input.operator, run: runner,
    state: await openCtoState(input.databasePath),
    processes: () => runner("ps", ["-axww", "-o", "pid=,ppid=,command="], { env: { ...env, LC_ALL: "C" }, timeoutMs: 10_000 }).stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() }] : [];
    }),
    startToken: readProcessStartToken,
    signal: (pid, signal) => { process.kill(pid, signal); },
    files: {
      exists: existsSync,
      read: (path) => readFileSync(path, "utf8"),
      replace: (path, body) => { const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, body, { mode: 0o600 }); renameSync(tmp, path); },
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
      rotate: firstExisting([env["ACP_ROTATE_CANONICAL_CTO"], fileURLToPath(new URL("../../scripts/rotate-canonical-cto.mjs", import.meta.url))]),
    },
  };
};
