import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/agentctl.ts";
import {
  CTO_SUBCOMMANDS, IDLE_SECONDS, checkoutHeldWork, createCtoPorts, hostRunner, runCtoCommand, workerHeldWork,
  type CtoExec, type CtoExecOptions, type CtoExecResult, type CtoPorts, type CtoRecord,
} from "../../src/cli/cto-command.ts";
import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { CHANNEL_REGISTERED_LINE, DEV_CHANNELS_WARNING } from "../../src/runtime/cto-channel-launch.ts";
import type { CtoProcessReader, CtoRoleScope } from "../../src/cto/one-cto-per-project.ts";

/** A process of the fake host: its kernel argv (else its command split on spaces) and its working directory. */
interface FakeProcess { pid: number; ppid: number; command: string; argv?: string[]; cwd?: string }
import { formatHostProvisionerReason, hostProvisionerReason, hostReasonKind, hostRefusalText } from "../../src/runtime/host-provisioner-reason.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir } from "../helpers/fixtures.ts";
import { mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * `agentctl cto` composes the existing lifecycle pieces. Every host the command touches — the process table, tmux, gh,
 * git, the Buzz roster and its map script, the fleet files, the provisioner and the rotation launcher — is a fake here,
 * so what is proved is the command's own contract: a dry run by default, the plan's order when applied, the stop at
 * the first failure and the continuation on a rerun, the repository deleted only on its exact name, operator only.
 */
const HOME = "/home/op";
const STATE = "/state";
const P = "e2e-sort-fixture";
const REPO = "MongLong0214/e2e-sort-fixture";
const CONVERSATION = "13a705bf-23dd-429d-a3e4-0c7f8eb61b40";
const ROOM = "bd05ad09-58c4-4e15-8198-6c1500c2aeed";
const ACTOR = "a".repeat(64);
const CLONE = `${HOME}/projects/e2e-sort-fixture`;
const WORKER = `${HOME}/projects/.acp-worker-checkouts/repo_1`;
const ARCHIVE = `${HOME}/projects/.retired/e2e-sort-fixture-${P}`;
const TMUX = `acp-${Buffer.from(P).toString("hex")}`;
const MANIFEST = `${HOME}/.claude/watchers/fleet/manifest.tsv`;
const REQUEST = `${HOME}/.claude/watchers/fleet/acp-${P}.resident.json`;
const ROSTER = `${HOME}/.hermes/bridge/required-mentions.json`;
const MAP = `${HOME}/.hermes/bridge/channel-cto.map`;
const MAP_SCRIPT = `${HOME}/.hermes/bridge/buzz-identity-map.sh`;
const TRANSCRIPT = `${HOME}/.claude/projects/-home-op-projects-e2e-sort-fixture/${CONVERSATION}.jsonl`;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const CLAUDE = 16590;
const LOCAL_CLAUDE = "/Users/isaac/.local/bin/claude";
const CHANNEL = "--dangerously-load-development-channels server:acp-buzz-channel";
const recordedExit = hostRefusalText(formatHostProvisionerReason(hostProvisionerReason("claude", "ensure-resident", hostReasonKind.nonZeroExit, 143)!));

interface World {
  ports: CtoPorts;
  out: Record<string, unknown>[];
  /** Every change the command made to the world, in order. */
  changes: string[];
  /** Every subprocess the command ran, in order. */
  ran: string[];
  record: CtoRecord;
  openRuns: Array<{ runId: string; state: string; kind: string }>;
  /** The daemon's canonical switchovers (canonicalCto.status/rotate): what it recorded, what rotate was asked, and whether its answer is lost. */
  switchovers: Array<{ toSessionUuid: string; state: "PENDING" | "ACKED" }>;
  rotateCalls: Array<{ params: Record<string, unknown>; handoffFile: string | undefined }>;
  rotate: { answer: "ok" | "lost" | "denied" | "competing" };
  /** The daemon's hold on the project (ctoRefresh.hold): refused because another run holds it, or the connection it is kept on is open. */
  hold: { refused: boolean; open: boolean; calls: Array<Record<string, unknown>>; released: number };
  /** Interleavings: what another run does to the world right after a process-table reading, or just before the daemon answers a status read. */
  onTable?: () => void;
  onStatus?: () => void;
  files: Map<string, string>;
  procs: FakeProcess[];
  tmux: Set<string>;
  repo: { exists: boolean };
  /** What the primary clone answers about the worker's commits: a commit no remote-tracking branch has, or a fetch that fails. */
  worker: { unpublished: boolean; fetchFails: boolean };
  operatorAnswers: Array<(method: string) => Decision<unknown> | null>;
  provisionerAnswers: Array<(operation: string) => CtoExecResult | null>;
  mtimes: Map<string, number>;
  /** Paths whose `git status` shows uncommitted or untracked files. */
  dirty: Set<string>;
  /** The archived clone holds a commit (on any ref, HEAD included) its remotes do not. */
  archiveUnpublished: boolean;
  /** The daemon refuses the credential (a token that is set but is not the operator's). */
  daemonRejects: boolean;
  /** How many times the daemon actually executed `project.retire`; a replayed cached answer is not one. */
  retireExecutions: number;
  /** Every run of the old rotation launcher: there must be none. */
  rotateRuns: string[];
  /** Each process's exact argv, as the kernel gives it. */
  argv: Map<number, string[]>;
  /** tmux panes: the pane's process and its session. */
  panes: Map<number, string>;
  /** The launcher tmux last started, and whether the conversation it resumes claims the role. */
  launched: { command: string | null; claims: boolean; fails?: boolean };
  /** The launch's pane: the registered line; the warning and then a backlog flood that scrolls that line away; or still loading. */
  pane: "registered" | "flood" | "loading";
  /** The old channel process appends a receipt (a later time, no launch id) while the launch asks tmux for its session. */
  oldReceiptDuringLaunch: boolean;
  /** Pids alive in the kernel that `ps` does not list (a process table that could not be read whole). */
  hiddenFromPs: Set<number>;
  /** `ps` cannot be spawned at all. */
  psFails: boolean;
  /** Earlier conversations of the role, as the database's role scope lists them. */
  roleConversations: string[];
  /** Pids whose native start token cannot be read although they run. */
  tokenUnavailable: Set<number>;
  /** Pids that outlive SIGTERM. */
  survivesSigterm: Set<number>;
  /** Pids whose token read answers null this many times once they have been signalled. */
  tokenGlitchAfterSignal: Map<number, number>;
  signalled: Set<number>;
  /** The folder each `claude mcp` call ran in, with its line. */
  mcpCalls: string[];
  /** The shared reader's alive() answers false for every pid: the old reading of `ps -o stat= -p` exiting 1. */
  psStatFails: boolean;
  /** Per pid, what each token read answers once the plan's first step has reported: by read number, from 1. */
  tokenAfterIdle: Map<number, (read: number) => string | null>;
}

const results = (w: World): Array<[string, string]> => w.out.filter((l) => typeof l["result"] === "string" && typeof l["step"] === "string").map((l) => [l["step"] as string, l["result"] as string]);
const last = (w: World): Record<string, unknown> => w.out[w.out.length - 1]!;

const makeWorld = (overrides: Partial<CtoRecord> = {}, env: Record<string, string | undefined> = { ACP_OPERATOR_TOKEN: "operator-test-credential" }): World => {
  const files = new Map<string, string>([
    [`${CLONE}/README.md`, "clone"], [`${WORKER}/README.md`, "worker"], [REQUEST, JSON.stringify({ allocation: { projectId: P, sessionUuid: CONVERSATION }, packet: { handoff: {} } })],
    [MANIFEST, `# comment\nother\t/x\tother CTO\t/b\t11111111-1111-1111-1111-111111111111\nacp-${P}\t${CLONE}\t${P} CTO\t/boot\t${CONVERSATION}\n`],
    [ROSTER, JSON.stringify({ version: 1, channels: { [ROOM]: { status: "active", acp_project_id: P, peer: { pubkey: ACTOR, handle: "cto-e2e" } } } })],
    [MAP, `${ROOM} cto-${P}\n`], [`${HOME}/.hermes/bridge/keys/cto-${P}.priv`, ACTOR], [TRANSCRIPT, "{}"],
  ]);
  const mtimes = new Map([[TRANSCRIPT, NOW - (IDLE_SECONDS + 60) * 1000]]);
  const w = {
    out: [], changes: [], ran: [], mcpCalls: [], files, mtimes, tmux: new Set([TMUX]), repo: { exists: true }, worker: { unpublished: false, fetchFails: false }, operatorAnswers: [], provisionerAnswers: [],
    dirty: new Set<string>(), archiveUnpublished: false, daemonRejects: false, retireExecutions: 0, rotateRuns: [],
    argv: new Map<number, string[]>(), panes: new Map([[100, TMUX]]), launched: { command: null, claims: true }, pane: "registered", oldReceiptDuringLaunch: false, hiddenFromPs: new Set<number>(), psFails: false, roleConversations: [],
    tokenUnavailable: new Set<number>(), survivesSigterm: new Set<number>(), tokenGlitchAfterSignal: new Map<number, number>(), signalled: new Set<number>(),
    psStatFails: false, tokenAfterIdle: new Map<number, (read: number) => string | null>(),
    procs: [
      { pid: 100, ppid: 1, command: "/bin/sh /state/resident-e2e-sort-fixture.sh" },
      { pid: CLAUDE, ppid: 100, command: `/bin/claude --model opus ${CHANNEL} --resume ${CONVERSATION} --name e2e CTO` },
      // The acp-cto relay names the conversation too, but is not the conversation's process.
      { pid: 16970, ppid: CLAUDE, command: `/node agentctl.js attach resident-cto --claimed-session-id ${CONVERSATION} --project-id ${P}` },
    ],
    openRuns: [], switchovers: [], rotateCalls: [], rotate: { answer: "ok" }, hold: { refused: false, open: false, calls: [], released: 0 },
    record: {
      projectId: P, name: P, retiredAt: null, kind: "resident",
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: WORKER }],
      conversation: CONVERSATION, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: CLONE },
      room: ROOM, actorId: ACTOR, resident: { status: "COMPLETE", allocation: { projectId: P, sessionUuid: CONVERSATION, clonePath: CLONE, roomId: ROOM } },
      lastBuzzAt: null, ...overrides,
    },
  } as unknown as World;
  const exists = (path: string): boolean => files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`));
  const move = (from: string, to: string): void => {
    for (const [k, v] of [...files]) if (k === from || k.startsWith(`${from}/`)) { files.delete(k); files.set(to + k.slice(from.length), v); }
  };
  const roster = (): { channels: Record<string, { status: string }> } => JSON.parse(files.get(ROSTER)!) as { channels: Record<string, { status: string }> };
  /** The daemon and the host provisioner's retirement, as `project retire` performs it. */
  const retire = (): Decision<unknown> => {
    w.record = { ...w.record, retiredAt: new Date(NOW).toISOString(), generation: null, session: null };
    const r = roster(); r.channels[ROOM]!.status = "retired"; files.set(ROSTER, JSON.stringify(r));
    files.set(MANIFEST, files.get(MANIFEST)!.split("\n").filter((l) => !l.startsWith(`acp-${P}\t`)).join("\n"));
    files.delete(REQUEST);
    w.procs = w.procs.filter((p) => p.pid !== CLAUDE && p.pid !== 16970);
    move(CLONE, ARCHIVE);
    return allow(ReasonCode.OK, { projectId: P });
  };
  const daemonCache = new Map<string, Decision<unknown>>();
  const tokenReads = new Map<number, number>();
  const tempRefs = new Set<string>();
  let clock = NOW;
  let uuids = 0;
  const subprocess = (bin: string, args: readonly string[], options: CtoExecOptions = {}): CtoExecResult => {
    const line = [bin, ...args].join(" ");
    w.ran.push(line);
    const answer = (status: number, stdout = "", stderr = ""): CtoExecResult => ({ status, stdout, stderr });
    if (bin === "tmux" && args[0] === "list-panes") return answer(0, [...w.panes].map(([pid, session]) => `${pid} ${session}\n`).join(""));
    // A launch: tmux starts the launcher, which resumes the conversation with its channel; the conversation claims the role.
    if (bin === "tmux" && (args[0] === "new-session" || args[0] === "new-window")) {
      w.changes.push(line);
      if (w.launched.fails) return answer(1, "", "no server running");
      if (args[0] === "new-session") w.tmux.add(args[args.indexOf("-s") + 1]!);
      w.launched.command = args[args.length - 1]!;
      // The conversation the launcher starts: --resume or --session-id, as its script says.
      const started = /'--(?:resume|session-id)' '([0-9a-f-]{36})'/.exec(files.get(w.launched.command) ?? "")?.[1] ?? w.record.conversation;
      w.procs.push({ pid: 30000, ppid: 1, command: `${LOCAL_CLAUDE} --mcp-config {} ${CHANNEL} --resume ${started}`, argv: [LOCAL_CLAUDE, "--mcp-config", "{}", ...CHANNEL.split(" "), "--resume", started!] });
      if (w.launched.claims) {
        w.record = { ...w.record, conversation: started, generation: 4, session: { pid: 30000, startedAt: "start-30000", workdir: null } };
        for (const one of w.switchovers) if (one.toSessionUuid === started) one.state = "ACKED";
      }
      return answer(0, "%9\n");
    }
    if (bin === "tmux" && args[0] === "display-message") return answer(0, args[4] === "#{pane_id}" ? "%9\n" : `${w.launched.command}\n`);
    if (bin === "tmux" && args[0] === "capture-pane") {
      if (w.pane === "registered") return answer(0, `${CHANNEL_REGISTERED_LINE}\n`);
      if (w.pane === "loading") return answer(0, "Loading...\n");
      return answer(0, w.changes.includes("tmux send-keys -t %9 Enter") ? `${Array.from({ length: 40 }, (_, i) => `← acp-buzz-channel: backlog ${i}`).join("\n")}\n` : `${DEV_CHANNELS_WARNING}\n`);
    }
    if (bin === "tmux" && args[0] === "send-keys") {
      w.changes.push(line);
      // This launch's channel delivers its backlog into the session and appends emitted receipts carrying its launch id.
      const launchId = /\\?"--launch-id\\?",\\?"([^"\\]+)/.exec(files.get(w.launched.command ?? "") ?? "")?.[1];
      files.set(`${STATE}/buzz-channel/${P}.receipts.jsonl`, `${JSON.stringify({ type: "emitted", eventId: "e1", room: ROOM, senderPubkey: "p", emittedAt: 1, ...(launchId ? { launchId } : {}) })}\n`);
      return answer(0);
    }
    if (bin === LOCAL_CLAUDE && args[0] === "mcp") { w.changes.push(line); w.mcpCalls.push(`${options.cwd} ${args[1]}`); return answer(args[1] === "remove" ? 1 : 0); }
    if (bin === "tmux" && args[0] === "has-session") {
      if (w.oldReceiptDuringLaunch) {
        const file = `${STATE}/buzz-channel/${P}.receipts.jsonl`;
        files.set(file, `${files.get(file) ?? ""}${JSON.stringify({ type: "emitted", eventId: "old", room: ROOM, senderPubkey: "p", emittedAt: 9_999_999_999 })}\n`);
      }
      return answer(w.tmux.has(args[2]!.slice(1)) ? 0 : 1);
    }
    if (bin === "tmux" && args[0] === "kill-session") { w.changes.push(line); w.tmux.delete(args[2]!.slice(1)); return answer(0); }
    if (bin === "git" && args[2] === "status") return answer(0, w.dirty.has(args[1]!) ? "?? scratch.txt\n" : "");
    if (bin === "git" && args[2] === "log") return answer(0, "");
    if (bin === "git" && args[2] === "config") return answer(0, `${CLONE}\n`);
    // The worker's branches and HEAD, fetched into a namespace of the primary clone and compared with its remotes.
    // The primary clone's refs a fetch writes into a namespace, as git keeps them: listed by prefix, deleted on request.
    if (bin === "git" && args[2] === "fetch") {
      if (w.worker.fetchFails) return answer(128, "", "fatal: could not read from the worker\n");
      const spec = args.find((a) => a.startsWith("+refs/*:"));
      if (spec) for (const ref of ["HEAD", "heads/main"]) tempRefs.add(`${spec.slice("+refs/*:".length, -1)}${ref}`);
      return answer(0);
    }
    if (bin === "git" && args[2] === "for-each-ref") return answer(0, [...tempRefs].filter((ref) => ref.startsWith(args[4]!)).map((ref) => `${ref}\n`).join(""));
    if (bin === "git" && args[2] === "rev-list") {
      const unpublished = args.includes("--all") ? w.archiveUnpublished : w.worker.unpublished;
      return answer(0, unpublished ? "deadbeefcafe0123\n" : "");
    }
    if (bin === "git" && args[2] === "update-ref") {
      for (const line of (options.input ?? "").split("\n")) if (line.startsWith("delete ")) tempRefs.delete(line.slice("delete ".length));
      return answer(0);
    }
    if (bin === "gh" && args[0] === "api") return w.repo.exists ? answer(0, `${REPO}\n`) : answer(1, "", "gh: Not Found (HTTP 404)\n");
    if (bin === "gh" && args[0] === "repo" && args[1] === "delete") { w.changes.push(line); w.repo.exists = false; return answer(0); }
    if (bin === MAP_SCRIPT) {
      w.changes.push("buzz-identity-map.sh");
      files.set(MAP, Object.entries(roster().channels).filter(([, v]) => v.status === "active").map(([room]) => `${room} cto-${P}\n`).join(""));
      return answer(0);
    }
    if (bin === "/node" && args[0] === "/prov.mjs") {
      const operation = (JSON.parse(options.input!) as { operation: string }).operation;
      w.changes.push(`provisioner ${operation}`);
      const scripted = w.provisionerAnswers.shift()?.(operation);
      if (scripted) return scripted;
      if (operation === "ensure-resident") {
        w.procs.push({ pid: 20000, ppid: 1, command: `/bin/claude --model opus ${CHANNEL} --resume ${w.record.conversation} --name e2e CTO` });
        return answer(0, JSON.stringify({ fleet: true, resident: { pid: 20000 } }));
      }
      return answer(0, "{}");
    }
    if (bin === "/node" && args[0] === "/rotate.mjs") {
      w.changes.push(line);
      const to = args[args.indexOf("--to") + 1]!;
      w.rotateRuns.push(to);
      return answer(0, `${JSON.stringify({ step: "verify", generation: 27 })}\n`);
    }
    throw new Error(`unexpected subprocess: ${line}`);
  };
  w.ports = {
    home: HOME, stateDir: STATE, databasePath: `${STATE}/state.sqlite`, env,
    operator: {
      hold: async (_method: string, params: Record<string, unknown> = {}) => {
        w.hold.calls.push(params);
        if (w.hold.refused) return { decision: deny(ReasonCode.CTO_REFRESH_IN_PROGRESS, "another cto relaunch --fresh holds project e2e-sort-fixture (pid 4242); nothing was changed"), open: () => false, release: () => undefined };
        w.hold.open = true;
        return { decision: allow(ReasonCode.OK, { projectId: params["projectId"] }), open: () => w.hold.open, release: () => { w.hold.open = false; w.hold.released++; } };
      },
      // The daemon: it authenticates every request, answers reads, and replays a mutation's answer for a key it has seen.
      request: async (method: string, params: Record<string, unknown> = {}, idempotencyKey?: string) => {
        if (w.daemonRejects) return deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator authentication failed");
        if (method === "daemon.status") return allow(ReasonCode.OK, { mode: "RUNNING" });
        if (method === "canonicalCto.status") w.onStatus?.();
        if (method === "canonicalCto.status") return allow(ReasonCode.OK, { holderSessionUuid: w.record.conversation, generation: w.record.generation, rotations: structuredClone(w.switchovers) });
        if (method === "canonicalCto.rotate") {
          w.changes.push(`operator ${method}`);
          w.rotateCalls.push({ params, handoffFile: files.get(`${STATE}/cto-refresh/handoff-${P}.json`) });
          if (w.rotate.answer === "denied") return deny(ReasonCode.CONFLICT, "the switchover is refused");
          // Another rotate (the owner's own, say) won: its conversation is the one pending, and ours is refused.
          if (w.rotate.answer === "competing") { w.switchovers.push({ toSessionUuid: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee", state: "PENDING" }); return deny(ReasonCode.CONFLICT, "a canonical switchover of this project is pending"); }
          w.switchovers.push({ toSessionUuid: params["toSessionUuid"] as string, state: "PENDING" });
          if (w.rotate.answer === "lost") throw new Error("operator socket closed before the answer");
          return allow(ReasonCode.OK, { outcome: "SWITCHOVER_PENDING" });
        }
        const key = idempotencyKey ?? `operator:${JSON.stringify({ method, params })}`;
        const cached = daemonCache.get(key);
        if (cached) return cached;
        w.changes.push(`operator ${method}`);
        if (method === "project.retire") w.retireExecutions++;
        const answered = w.operatorAnswers.shift()?.(method) ?? (method === "project.retire" ? retire() : allow(ReasonCode.OK, {}));
        daemonCache.set(key, answered);
        return answered;
      },
    },
    state: {
      projects: () => (w.record.retiredAt ? [] : [structuredClone(w.record)]),
      project: (id: string) => (id === P ? structuredClone(w.record) : null),
      openRuns: () => structuredClone(w.openRuns),
      // The shared rule's scope as the database gives it: the role's conversations, its live checkouts, its bound process.
      roleScope: (id: string, extra: { conversationIds?: readonly string[]; checkouts?: readonly string[] } = {}): CtoRoleScope => ({
        projectId: id,
        conversationIds: [...new Set([...(w.record.conversation ? [w.record.conversation] : []), ...w.roleConversations, ...(extra.conversationIds ?? [])])],
        checkouts: [...new Set([...w.record.repositories.map((r) => r.checkoutPath), ...(extra.checkouts ?? [])])],
        bound: w.record.generation !== null && w.record.session?.pid ? [{ pid: w.record.session.pid, startedAt: w.record.session.startedAt }] : [],
      }),
    },
    run: subprocess,
    // The shared one-CTO reader: the kernel's argv, the table ps gives (this test process included), working directories.
    ctoProcesses: {
      table: async () => {
        if (w.psFails) throw Object.assign(new Error("spawn /bin/ps ENOENT"), { code: "ENOENT" });
        const rows = [{ pid: process.pid, ppid: 1, uid: process.getuid?.() ?? 0, startedAt: "Fri Jan  1 00:00:00 2027", command: "node vitest" },
          ...w.procs.filter((p) => !w.hiddenFromPs.has(p.pid)).map((p) => ({ pid: p.pid, ppid: p.ppid, uid: process.getuid?.() ?? 0, startedAt: `lstart-${p.pid}`, command: p.command }))];
        // A concurrent run acts right after this reading was taken.
        w.onTable?.();
        return rows;
      },
      argv: (pid: number) => { const p = w.procs.find((x) => x.pid === pid); return p ? (p.argv ?? p.command.split(" ")) : null; },
      cwds: async (pids: readonly number[]) => new Map(pids.flatMap((pid) => { const p = w.procs.find((x) => x.pid === pid); return p ? [[pid, p.cwd ?? "/"] as [number, string]] : []; })),
      tmuxPanes: async () => new Map(w.panes),
      alive: (pid: number) => !w.psStatFails && w.procs.some((p) => p.pid === pid),
      startToken: (pid: number) => (w.procs.some((p) => p.pid === pid) ? `start-${pid}` : null),
    } satisfies CtoProcessReader,
    // The kernel: a pid it no longer has (kill(pid, 0) would throw ESRCH).
    kernelGone: (pid: number) => !w.procs.some((p) => p.pid === pid),
    startToken: (pid: number) => {
      if (!w.procs.some((p) => p.pid === pid) || w.tokenUnavailable.has(pid)) return null;
      const script = w.tokenAfterIdle.get(pid);
      if (script && w.out.some((l) => l["step"] === "idle" && l["result"] === "done")) {
        tokenReads.set(pid, (tokenReads.get(pid) ?? 0) + 1);
        return script(tokenReads.get(pid)!);
      }
      const glitches = w.signalled.has(pid) ? w.tokenGlitchAfterSignal.get(pid) ?? 0 : 0;
      if (glitches > 0) { w.tokenGlitchAfterSignal.set(pid, glitches - 1); return null; }
      return `start-${pid}`;
    },
    signal: (pid: number) => {
      w.changes.push(`SIGTERM ${pid}`);
      w.signalled.add(pid);
      if (w.survivesSigterm.has(pid)) return;
      w.procs = w.procs.filter((p) => p.pid !== pid && p.ppid !== pid);
      // A pane whose own process was claude ends with it, and so does its session.
      const session = w.panes.get(pid);
      if (session) { w.panes.delete(pid); w.tmux.delete(session); }
    },
    files: {
      exists,
      read: (path: string) => { const body = files.get(path); if (body === undefined) throw new Error(`ENOENT ${path}`); return body; },
      replace: (path: string, body: string) => { w.changes.push(`replace ${path}`); files.set(path, body); },
      move: (from: string, to: string) => { w.changes.push(`move ${from} -> ${to}`); move(from, to); },
      remove: (path: string) => { w.changes.push(`remove ${path}`); for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k); },
      mtimeMs: (path: string) => (files.has(path) ? mtimes.get(path) ?? NOW : null),
      real: (path: string) => { try { const at = realpathSync(path); return { path: at, directory: statSync(at).isDirectory() }; } catch { return null; } },
    },
    // A fake key file holds its own public key.
    publicKeyOf: (keyFile: string) => files.get(keyFile) ?? null,
    now: () => clock, sleep: async (ms: number) => { clock += ms; }, newUuid: () => `99999999-8888-4777-8666-${String(++uuids).padStart(12, "5")}`,
    write: (line: Record<string, unknown>) => { w.out.push(line); },
    node: "/node", scripts: { provisioner: "/prov.mjs" },
  };
  return w;
};

const RETIRE = ["retire", P, "--reason", "fixture done"];
const RETIRE_STEPS = ["idle", "project-retire", "session-stopped", "roster", "channel-map", "fleet", "tmux", "worker-checkouts", "local-checkout"];

describe("agentctl cto: a dry run is the default", () => {
  it("prints every mutating subcommand's plan and changes nothing without --apply", async () => {
    for (const args of [RETIRE, [...RETIRE, "--delete-repo", "--yes-delete-repo", REPO], ["relaunch", P], ["add", P]]) {
      const w = makeWorld();
      expect(await runCtoCommand(args, w.ports)).toBe(0);
      expect(w.out[0]).toMatchObject({ mode: "dry-run" });
      expect(last(w)).toMatchObject({ result: "dry-run" });
      const planned = w.out[0]!["steps"] as string[];
      expect(w.out.slice(1, -1).map((l) => l["step"])).toEqual(planned);
      expect(w.changes).toEqual([]);
      expect(w.ran.filter((l) => /kill-session|repo delete|\/prov\.mjs|\/rotate\.mjs|buzz-identity-map/.test(l))).toEqual([]);
    }
  });

  it("is listed in agentctl's usage", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    try { expect(await main(["--help"])).toBe(0); } finally { spy.mockRestore(); }
    expect(written.join("")).toContain("agentctl cto add|relaunch|retire <project>");
  });
});

describe("agentctl cto retire --apply", () => {
  it("runs the plan in its order, reports each step, and removes the worker and archived checkouts", async () => {
    const w = makeWorld();
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual(RETIRE_STEPS);
    expect(results(w)).toEqual([
      ["idle", "done"], ["project-retire", "done"], ["session-stopped", "skipped"], ["roster", "skipped"], ["channel-map", "done"],
      ["fleet", "skipped"], ["tmux", "done"], ["worker-checkouts", "done"], ["local-checkout", "done"],
    ]);
    expect(last(w)).toEqual({ result: "done" });
    expect(w.changes).toEqual([
      "operator project.retire", "buzz-identity-map.sh", `tmux kill-session -t =${TMUX}`, `remove ${WORKER}`, `remove ${ARCHIVE}`,
    ]);
    expect(w.files.get(MAP)).toBe("");
    expect([...w.files.keys()].some((k) => k.startsWith(WORKER) || k.startsWith(ARCHIVE) || k.startsWith(CLONE))).toBe(false);
    expect(w.ran.some((l) => l.startsWith("gh repo delete"))).toBe(false);
  });

  it("stops at the first failure and, run again, continues from where it stopped", async () => {
    const w = makeWorld();
    w.operatorAnswers.push(() => deny(ReasonCode.CONFLICT, "host retirement refused: provisioner busy; nothing was changed", { requiredOrder: [`run agentctl project retire ${P} again`] }));
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "done"], ["project-retire", "failed"]]);
    expect(last(w)).toMatchObject({ result: "stopped", at: "project-retire", rerun: `agentctl cto retire ${P} --reason "fixture done" --apply` });
    expect(w.changes).toEqual(["operator project.retire"]);
    expect(w.files.has(`${WORKER}/README.md`)).toBe(true);

    w.out.length = 0; w.changes.length = 0;
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual(RETIRE_STEPS);
    expect(w.changes[0]).toBe("operator project.retire");

    // Everything is in place now: a third run changes nothing.
    w.out.length = 0; w.changes.length = 0;
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(results(w).filter(([, r]) => r !== "skipped")).toEqual([["idle", "done"]]);
    expect(w.changes).toEqual([]);
  });

  it("keeps an archived clone holding work no remote has, and stops before anything after it", async () => {
    const w = makeWorld();
    w.archiveUnpublished = true;
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["local-checkout", "failed"]);
    expect(w.files.has(`${ARCHIVE}/README.md`)).toBe(true);
  });

  it("does not run while the CTO is mid-turn", async () => {
    const w = makeWorld();
    w.mtimes.set(TRANSCRIPT, NOW - 5_000);
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "failed"]]);
    expect(w.changes).toEqual([]);
  });
});

describe("agentctl cto retire: worker checkouts", () => {
  const KEPT = `${ARCHIVE}.worker-repo_1`;

  it("moves a worker checkout holding a commit no remote has beside the archived clone, and lists it", async () => {
    for (const hazard of ["unpublished", "fetchFails"] as const) {
      const w = makeWorld();
      w.worker[hazard] = true;
      expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
      expect(w.changes).not.toContain(`remove ${WORKER}`);
      expect(w.changes).toContain(`move ${WORKER} -> ${KEPT}`);
      expect(w.files.get(`${KEPT}/README.md`)).toBe("worker");
      const step = w.out.find((l) => l["step"] === "worker-checkouts" && l["result"] === "done")!;
      expect(step["detail"]).toMatchObject({ removed: [], kept: [expect.objectContaining({ path: WORKER, movedTo: KEPT })] });
      // The archived clone itself is still removed; the worker kept beside it is not inside it.
      expect(w.changes).toContain(`remove ${ARCHIVE}`);
    }
  });

  it("removes a clean worker checkout once its commits are found on the primary clone's remotes", async () => {
    const w = makeWorld();
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(w.ran.some((l) => l.startsWith(`git -C ${ARCHIVE} fetch`) && l.includes(WORKER))).toBe(true);
    expect(w.changes).toContain(`remove ${WORKER}`);
    expect(w.changes.some((c) => c.startsWith("move "))).toBe(false);
    // The temporary refs are taken out of the primary clone again.
    expect(w.ran.some((l) => l === `git -C ${ARCHIVE} update-ref --stdin`)).toBe(true);
  });

  it("deletes an unpublished worker checkout only when the repository is deleted too", async () => {
    const w = makeWorld();
    w.worker.unpublished = true;
    expect(await runCtoCommand([...RETIRE, "--delete-repo", "--yes-delete-repo", REPO, "--apply"], w.ports)).toBe(0);
    expect(w.changes).toContain(`remove ${WORKER}`);
    expect(w.files.has(`${KEPT}/README.md`)).toBe(false);
  });
});

describe("agentctl cto retire --delete-repo", () => {
  it("is refused, with nothing planned or run, unless --yes-delete-repo names the repository exactly", async () => {
    for (const extra of [["--delete-repo"], ["--delete-repo", "--yes-delete-repo", "MongLong0214/e2e-sort-fixtur"],
      ["--delete-repo", "--yes-delete-repo", "monglong0214/e2e-sort-fixture"], ["--delete-repo", "--yes-delete-repo", "e2e-sort-fixture"],
      ["--yes-delete-repo", REPO]]) {
      const w = makeWorld();
      expect(await runCtoCommand([...RETIRE, ...extra, "--apply"], w.ports)).toBe(2);
      expect(w.out).toEqual([expect.objectContaining({ nothingChanged: true })]);
      expect(w.changes).toEqual([]);
      expect(w.ran).toEqual([]);
    }
  });

  it("deletes exactly that repository, last, once every other step is done", async () => {
    const w = makeWorld();
    expect(await runCtoCommand([...RETIRE, "--delete-repo", "--yes-delete-repo", REPO, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual([...RETIRE_STEPS, "github-repo"]);
    expect(w.changes.at(-1)).toBe(`gh repo delete ${REPO} --yes`);
    expect(w.changes.filter((c) => c.includes("repo delete"))).toHaveLength(1);
  });

  it("never reaches the deletion when an earlier step fails", async () => {
    const w = makeWorld();
    const original = w.ports.run;
    w.ports.run = (bin, args, options) => (bin === "git" && args[2] === "config" ? { status: 0, stdout: "/somewhere/else\n", stderr: "" } : original(bin, args, options));
    expect(await runCtoCommand([...RETIRE, "--delete-repo", "--yes-delete-repo", REPO, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["worker-checkouts", "failed"]);
    expect(w.ran.some((l) => l.startsWith("gh repo delete"))).toBe(false);
    expect(w.repo.exists).toBe(true);
  });
});

describe("agentctl cto relaunch", () => {
  it("stops only the resident's claude process and starts it again through ensure-resident, acknowledging its recorded exit", async () => {
    const w = makeWorld();
    w.provisionerAnswers.push((operation) => (operation === "ensure-resident" ? { status: 3, stdout: "", stderr: recordedExit } : null));
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(results(w)).toEqual([["idle", "done"], ["stop", "done"], ["launch", "done"]]);
    expect(w.changes).toEqual([`SIGTERM ${CLAUDE}`, "provisioner ensure-resident", "provisioner acknowledge-resident-exit", "provisioner ensure-resident"]);
    expect(w.procs.find((p) => p.pid === 20000)?.command).toContain(`${CHANNEL} --resume ${CONVERSATION}`);
  });

  it("continues with the launch when a rerun finds the old process already stopped", async () => {
    const w = makeWorld();
    w.provisionerAnswers.push(() => ({ status: 1, stdout: "", stderr: "host project provisioner refused operation: provisioner busy\n" }));
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "done"], ["stop", "done"], ["launch", "failed"]]);
    w.out.length = 0; w.changes.length = 0;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(results(w)).toEqual([["idle", "done"], ["stop", "skipped"], ["launch", "done"]]);
    expect(w.changes).toEqual(["provisioner ensure-resident"]);
  });

});

describe("review r1", () => {
  it("1: moves and lists a worker checkout with uncommitted or untracked files instead of deleting it", async () => {
    const w = makeWorld();
    w.dirty.add(WORKER);
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(w.changes).not.toContain(`remove ${WORKER}`);
    expect(w.changes).toContain(`move ${WORKER} -> ${ARCHIVE}.worker-repo_1`);
    const step = w.out.find((l) => l["step"] === "worker-checkouts" && l["result"] === "done")!;
    expect(step["detail"]).toMatchObject({ kept: [expect.objectContaining({ path: WORKER, why: expect.stringContaining("uncommitted or untracked") })] });
  });

  it("1: keeps an archived clone with untracked files", async () => {
    const w = makeWorld();
    w.dirty.add(ARCHIVE);
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["local-checkout", "failed"]);
    expect(w.files.has(`${ARCHIVE}/README.md`)).toBe(true);
  });

  it("3: refuses --apply before any step when the daemon does not authenticate the credential, cleanup-only reruns included", async () => {
    const retired = { retiredAt: new Date(NOW).toISOString(), generation: null, session: null };
    for (const [args, overrides] of [[[...RETIRE, "--apply"], {}], [["relaunch", P, "--apply"], {}], [["add", P, "--apply"], {}], [[...RETIRE, "--apply"], retired]] as const) {
      const w = makeWorld(overrides, { ACP_OPERATOR_TOKEN: "set-but-not-the-operator-token" });
      w.daemonRejects = true;
      expect(await runCtoCommand([...args], w.ports)).toBe(2);
      expect(w.out).toEqual([expect.objectContaining({ nothingChanged: true })]);
      expect(w.changes).toEqual([]);
      expect(w.ran).toEqual([]);
    }
  });

  it("4: a transient refusal of project retire is asked again on the rerun, not replayed", async () => {
    const w = makeWorld();
    w.operatorAnswers.push(() => deny(ReasonCode.CONFLICT, "host retirement refused: provisioner busy; nothing was changed"));
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(w.retireExecutions).toBe(1);
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(w.retireExecutions).toBe(2);
    expect(w.record.retiredAt).not.toBeNull();
  });
});

/** Item 2 on real git: HEAD and every ref count, in the worker and in the archived primary clone. */
describe("review r1, item 2: held work, read from real repositories", () => {
  // The production runner, resolved inside each test so that one missing export fails only the tests that use it.
  const run: CtoExec = (bin, args, options) => hostRunner({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" })(bin, args, options);
  const repos = (): { primary: string; worker: string; root: string } => {
    const root = tempDir("acp-cto-held-");
    gitSync(root, ["init", "-q", "--bare", "origin.git"]);
    gitSync(root, ["clone", "-q", join(root, "origin.git"), "primary"]);
    const primary = join(root, "primary");
    writeFileSync(join(primary, "README.md"), "one\n");
    commitAll(primary, "one");
    gitSync(primary, ["push", "-q", "origin", "HEAD:main"]);
    gitSync(primary, ["fetch", "-q", "origin"]);
    gitSync(root, ["clone", "-q", primary, "worker"]);
    const worker = join(root, "worker");
    gitSync(worker, ["remote", "remove", "origin"]);
    return { primary, worker, root };
  };

  it("finds nothing in a clean, published checkout", () => {
    const { primary, worker } = repos();
    expect(checkoutHeldWork(run, primary)).toBeNull();
    expect(workerHeldWork(run, primary, worker)).toBeNull();
  });

  it("finds an unpublished commit on a detached HEAD, in the archived clone and in the worker", () => {
    const { primary, worker } = repos();
    for (const repo of [primary, worker]) {
      gitSync(repo, ["checkout", "-q", "--detach"]);
      writeFileSync(join(repo, "detached.txt"), "x\n");
      commitAll(repo, "on a detached HEAD only");
    }
    expect(checkoutHeldWork(run, primary)).toMatch(/commit [0-9a-f]{12}/);
    gitSync(primary, ["checkout", "-q", "main"]);
    expect(workerHeldWork(run, primary, worker)).toMatch(/commit [0-9a-f]{12}/);
    expect(gitSync(primary, ["for-each-ref", "refs/acp-cto-retire/"])).toBe("");
  });

  it("finds untracked files, in the archived clone and in the worker", () => {
    const { primary, worker } = repos();
    writeFileSync(join(primary, "notes.txt"), "x\n");
    writeFileSync(join(worker, "notes.txt"), "x\n");
    expect(checkoutHeldWork(run, primary)).toMatch(/uncommitted or untracked/);
    expect(workerHeldWork(run, primary, worker)).toMatch(/uncommitted or untracked/);
  });
});

describe("review r2, item 3: notes on a real bare origin", () => {
  const run: CtoExec = (bin, args, options) => hostRunner({ ...process.env })(bin, args, options);

  it("does not count notes published to origin as held work, and still counts notes that are not", () => {
    const root = tempDir("acp-cto-notes-");
    gitSync(root, ["init", "-q", "--bare", "origin.git"]);
    gitSync(root, ["clone", "-q", join(root, "origin.git"), "primary"]);
    const primary = join(root, "primary");
    writeFileSync(join(primary, "README.md"), "one\n");
    commitAll(primary, "one");
    gitSync(primary, ["push", "-q", "origin", "HEAD:main"]);
    gitSync(primary, ["fetch", "-q", "origin"]);
    gitSync(primary, ["notes", "--ref=commitlore", "add", "-m", "a record", "HEAD"]);
    gitSync(primary, ["push", "-q", "origin", "refs/notes/commitlore"]);
    gitSync(root, ["clone", "-q", primary, "worker"]);
    const worker = join(root, "worker");
    gitSync(worker, ["remote", "remove", "origin"]);
    // A worker clone carries the resident's notes refs (#1268).
    gitSync(worker, ["fetch", "-q", primary, "refs/notes/commitlore:refs/notes/commitlore"]);

    expect(checkoutHeldWork(run, primary)).toBeNull();
    expect(workerHeldWork(run, primary, worker)).toBeNull();
    expect(gitSync(primary, ["for-each-ref", "refs/acp-cto-retire/"])).toBe("");

    gitSync(primary, ["notes", "--ref=commitlore", "append", "-m", "never pushed", "HEAD"]);
    gitSync(worker, ["notes", "--ref=commitlore", "append", "-m", "worker only", "HEAD"]);
    expect(checkoutHeldWork(run, primary)).toMatch(/commit [0-9a-f]{12}/);
    expect(workerHeldWork(run, primary, worker)).toMatch(/commit [0-9a-f]{12}/);
    expect(gitSync(primary, ["for-each-ref", "refs/acp-cto-retire/"])).toBe("");
  });
});

/** The final review's repro, on real repositories: a temporary ref that could not be cleared is never proof of publication. */
describe("review r3: temporary refs that cannot be cleared", () => {
  const run: CtoExec = (bin, args, options) => hostRunner({ ...process.env })(bin, args, options);
  /** A primary clone whose notes are on origin, and a worker clone carrying the same notes, as #1268 copies them. */
  const notesRepos = (): { primary: string; worker: string } => {
    const root = tempDir("acp-cto-temp-refs-");
    gitSync(root, ["init", "-q", "--bare", "origin.git"]);
    gitSync(root, ["clone", "-q", join(root, "origin.git"), "primary"]);
    const primary = join(root, "primary");
    writeFileSync(join(primary, "README.md"), "one\n");
    commitAll(primary, "one");
    gitSync(primary, ["push", "-q", "origin", "HEAD:main"]);
    gitSync(primary, ["fetch", "-q", "origin"]);
    gitSync(primary, ["notes", "--ref=commitlore", "add", "-m", "a record", "HEAD"]);
    gitSync(primary, ["push", "-q", "origin", "refs/notes/commitlore"]);
    gitSync(root, ["clone", "-q", primary, "worker"]);
    const worker = join(root, "worker");
    gitSync(worker, ["remote", "remove", "origin"]);
    gitSync(worker, ["fetch", "-q", primary, "refs/notes/commitlore:refs/notes/commitlore"]);
    return { primary, worker };
  };

  it("notes an earlier run fetched into its temp namespace, locked there and since removed upstream, are not taken as published: the worker and the archive are kept", () => {
    const { primary, worker } = notesRepos();
    gitSync(primary, ["fetch", "-q", "origin", "+refs/notes/*:refs/acp-cto-retire/origin-notes/*"]);
    writeFileSync(join(primary, ".git", "refs", "acp-cto-retire", "origin-notes", "commitlore.lock"), "");
    gitSync(primary, ["push", "-q", "origin", ":refs/notes/commitlore"]);
    expect(checkoutHeldWork(run, primary)).toMatch(/commit [0-9a-f]{12}/);
    expect(workerHeldWork(run, primary, worker)).toMatch(/commit [0-9a-f]{12}/);
  });

  it("a temp ref this check fetched and cannot clear (packed-refs.lock) keeps the checkout: temp refs could not be cleared", () => {
    const { primary, worker } = notesRepos();
    const lock = join(primary, ".git", "packed-refs.lock");
    writeFileSync(lock, "");
    expect(checkoutHeldWork(run, primary)).toMatch(/temp refs could not be cleared/);
    expect(workerHeldWork(run, primary, worker)).toMatch(/temp refs could not be cleared/);
    // Once the lock is gone a new check answers from a namespace of its own, not from the refs the failed ones left.
    rmSync(lock);
    expect(checkoutHeldWork(run, primary)).toBeNull();
    expect(workerHeldWork(run, primary, worker)).toBeNull();
  });
});

/** Owner requirement R1 (#1437): one long-lived conversation per project is its PRIMARY_CTO, so a canonical CTO is resumed, never rotated. */
describe("a canonical relaunch resumes the role's bound conversation", () => {
  /** Logic Pro MCP's shape: its claude is the tmux pane's own process, it runs without the channel, and its role is bound to it. */
  const canonicalWorld = (options: { trusted?: boolean; conversation?: string | null } = {}): { w: World; cwd: string } => {
    const cwd = realpathSync(tempDir("acp-cto-canonical-"));
    const config = tempDir("acp-cto-claude-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: options.trusted === false ? {} : { [cwd]: { hasTrustDialogAccepted: true } } }));
    const w = makeWorld({ kind: "canonical", resident: null, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd },
      conversation: options.conversation === undefined ? CONVERSATION : options.conversation,
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] }, { ACP_OPERATOR_TOKEN: "operator-test-credential", CLAUDE_CONFIG_DIR: config });
    const argv = [LOCAL_CLAUDE, "--resume", CONVERSATION, "--model", "claude-opus-5-5", "--effort", "medium", "--name", "Logic CTO",
      "--remote-control", "Logic CTO", "--permission-mode", "bypassPermissions", "--mcp-config", "/x/canonical-mcp.json"];
    w.procs = [{ pid: CLAUDE, ppid: 1, command: argv.join(" "), argv }];
    w.panes = new Map([[CLAUDE, "logic-claude-handoff"]]);
    w.tmux = new Set(["logic-claude-handoff"]);
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    return { w, cwd };
  };
  const RESUME_STEPS = ["idle", "trust", "channel", "one-cto", "launcher", "mcp", "stop", "launch", "claimed"];

  it("stops the exact claude process and resumes the bound conversation with the channel in its tmux session, claiming with auto; no rotation", async () => {
    const { w } = canonicalWorld();
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    // The fake conversation claims as it starts, so the wait for the claim finds it already made.
    expect(results(w)).toEqual([...RESUME_STEPS.slice(0, -1).map((step) => [step, "done"]), ["claimed", "skipped"]]);
    expect(last(w)).toEqual({ result: "done" });
    expect(w.changes).toContain(`SIGTERM ${CLAUDE}`);
    const launch = w.out.find((l) => l["step"] === "launch" && l["result"] === "done")!["detail"] as { argv: string[]; tmux: string };
    expect(launch.argv[0]).toBe(LOCAL_CLAUDE);
    expect(launch.argv.slice(launch.argv.indexOf("--resume"), launch.argv.indexOf("--resume") + 2)).toEqual(["--resume", CONVERSATION]);
    expect(launch.argv).toEqual(expect.arrayContaining(["--mcp-config", "--dangerously-load-development-channels", "server:acp-buzz-channel"]));
    expect(launch.argv.slice(launch.argv.indexOf("--name"), launch.argv.indexOf("--name") + 2)).toEqual(["--name", "Logic CTO"]);
    expect(launch.argv).not.toContain("/x/canonical-mcp.json");
    // Not a fresh conversation: the channel is given no switch time, and shows its backlog as it always did.
    expect(launch.argv.join(" ")).not.toContain("--history-before");
    expect(launch.tmux).toBe("logic-claude-handoff");
    expect(w.changes.some((c) => c.startsWith("tmux new-session -d -s logic-claude-handoff "))).toBe(true);
    expect(w.changes).toContain(`${LOCAL_CLAUDE} mcp add --scope local acp-cto -- ${STATE}/current/dist/bin/node ${STATE}/current/dist/cli/agentctl.js attach canonical-cto --claimed-session-id ${CONVERSATION} --project-id ${P} --expected-binding-generation auto`);
    expect(w.rotateRuns).toEqual([]);
    expect(w.ran.filter((l) => /rotate/.test(l))).toEqual([]);
  });

  it("reports a resumed conversation that does not claim the role, and leaves it running", async () => {
    const { w } = canonicalWorld();
    w.launched.claims = false;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["claimed", "failed"]);
    expect(w.procs.some((p) => p.pid === 30000)).toBe(true);
  });

  it("refuses a launch folder that is not trusted (launchFolderTrust), before anything is stopped", async () => {
    const { w } = canonicalWorld({ trusted: false });
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "done"], ["trust", "failed"]]);
    expect(JSON.stringify(w.out)).toContain("no-record");
    expect(w.changes).toEqual([]);
  });

  it("add --canonical resumes an existing conversation the same way", async () => {
    const { w } = canonicalWorld();
    expect(await runCtoCommand(["add", P, "--canonical", "--apply"], w.ports)).toBe(0);
    expect(results(w).filter(([, r]) => r === "done").map(([s]) => s)).toEqual(RESUME_STEPS.slice(0, -1));
    expect(w.changes).toContain(`SIGTERM ${CLAUDE}`);
  });

  it("add --canonical refuses a canonical CTO with no conversation yet", async () => {
    const { w } = canonicalWorld({ conversation: null });
    expect(await runCtoCommand(["add", P, "--canonical", "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["identity", "failed"]);
    expect(JSON.stringify(w.out)).toContain("has no conversation yet");
    expect(w.changes).toEqual([]);
  });

  it("takes no --handoff: there is no handoff package and no new conversation", async () => {
    const { w } = canonicalWorld();
    expect(await runCtoCommand(["relaunch", P, "--handoff", "/h.json", "--apply"], w.ports)).toBe(2);
    expect(w.changes).toEqual([]);
  });

  describe("relaunch --fresh: the daemon's switchover, then the new conversation, rolling forward only", () => {
    const FRESH_STEPS = ["no-live-run", "handoff", "idle", "trust", "channel", "switchover", "one-cto", "launcher", "mcp", "stop", "launch", "claimed", "complete"];
    const handoffFile = (w: World): { conversation: string; source: string; text: string; next?: string; completed?: boolean; history?: { conversation: string; before: number } } => JSON.parse(w.files.get(`${STATE}/cto-refresh/handoff-${P}.json`)!);
    const launched = (w: World): string[] => (w.out.find((l) => l["step"] === "launch" && l["result"] === "done")!["detail"] as { argv: string[] }).argv;

    it("with no pending switchover: prepares one (old to U, the current generation, the handoff as package, U already in the handoff file) and launches U with --session-id and the handoff", async () => {
      const { w } = canonicalWorld();
      w.files.set(`${STATE}/cto-refresh/handoff-${P}.json`, JSON.stringify({ schema: "acp.cto-handoff.v1", projectId: P, conversation: CONVERSATION, source: "cto", text: "Finish run_3 first.", writtenAt: "2026-11-20T00:00:00Z" }));
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(results(w).map(([step]) => step)).toEqual(FRESH_STEPS);
      expect(w.rotateCalls).toHaveLength(1);
      const U = w.rotateCalls[0]!.params["toSessionUuid"] as string;
      expect(w.rotateCalls[0]!.params).toMatchObject({ projectId: P, expectedGeneration: 3, handoff: { projectStatus: "Finish run_3 first." } });
      // U was written down before the daemon was asked, and the swap was seen through.
      expect(JSON.parse(w.rotateCalls[0]!.handoffFile!)).toMatchObject({ conversation: CONVERSATION, next: U });
      expect(handoffFile(w)).toMatchObject({ next: U, completed: true });
      const argv = launched(w);
      expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", U]);
      expect(argv).not.toContain("--resume");
      expect(argv.at(-1)).toContain("Finish run_3 first.");
      expect(w.changes).toContain(`${LOCAL_CLAUDE} mcp add --scope local acp-cto -- ${STATE}/current/dist/bin/node ${STATE}/current/dist/cli/agentctl.js attach canonical-cto --claimed-session-id ${U} --project-id ${P} --expected-binding-generation auto`);
      expect(w.changes).toContain(`SIGTERM ${CLAUDE}`);
      expect(w.record).toMatchObject({ conversation: U, generation: 4 });
    });

    it("with a pending switchover to U: prepare is not called and U is reused", async () => {
      const { w } = canonicalWorld();
      const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      w.switchovers = [{ toSessionUuid: U, state: "PENDING" }];
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(w.rotateCalls).toEqual([]);
      // Prepare is skipped: the reused conversation was written down by the very first step, which read the daemon's record.
      expect(results(w).find(([step]) => step === "switchover")).toEqual(["switchover", "skipped"]);
      expect(w.out.find((l) => l["step"] === "handoff" && l["result"] === "done")!["detail"]).toMatchObject({ newConversation: U });
      expect(handoffFile(w)).toMatchObject({ next: U });
      const argv = launched(w);
      expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", U]);
      expect(w.record.conversation).toBe(U);
    });

    it("never signals a process whose argv names U, and starts no second one", async () => {
      const { w } = canonicalWorld();
      const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      w.switchovers = [{ toSessionUuid: U, state: "PENDING" }];
      // The role's recorded process is the one running U (it has not claimed yet).
      const argv = [LOCAL_CLAUDE, "--session-id", U, ...CHANNEL.split(" ")];
      w.procs = [{ pid: CLAUDE, ppid: 1, command: argv.join(" "), argv }];
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM"))).toEqual([]);
      expect(w.changes.some((c) => c.startsWith("tmux new-"))).toBe(false);
      expect(w.procs.map((p) => p.pid)).toEqual([CLAUDE]);
      expect(results(w).find(([step]) => step === "stop")).toEqual(["stop", "skipped"]);
      expect(results(w).at(-1)).toEqual(["claimed", "failed"]);
    });

    it("a re-run after a launch failure relaunches the same U, and asks the daemon for nothing more", async () => {
      const { w } = canonicalWorld();
      w.launched.fails = true;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(results(w).at(-1)).toEqual(["launch", "failed"]);
      const U = w.rotateCalls[0]!.params["toSessionUuid"] as string;
      expect(w.switchovers).toEqual([{ toSessionUuid: U, state: "PENDING" }]);
      expect(w.changes).toContain(`SIGTERM ${CLAUDE}`);
      w.launched.fails = false;
      w.out.length = 0; w.changes.length = 0;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(w.rotateCalls).toHaveLength(1);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM"))).toEqual([]);
      const argv = launched(w);
      expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", U]);
      expect(w.record).toMatchObject({ conversation: U, generation: 4 });
    });

    it("a new conversation whose transcript exists is resumed, with no second first prompt", async () => {
      const { w, cwd } = canonicalWorld();
      const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      w.switchovers = [{ toSessionUuid: U, state: "PENDING" }];
      w.files.set(`${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${U}.jsonl`, "{}");
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      const argv = launched(w);
      expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", U]);
      expect(argv).not.toContain("--session-id");
      expect(argv.join(" ")).not.toContain("--- handoff ---");
    });

    it("a lost rotate answer is followed by a status read-back, not a second rotate", async () => {
      const { w } = canonicalWorld();
      w.rotate.answer = "lost";
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(w.rotateCalls).toHaveLength(1);
      expect(w.record.conversation).toBe(w.rotateCalls[0]!.params["toSessionUuid"]);
      expect(w.out.find((l) => l["step"] === "switchover" && l["result"] === "done")!["detail"]).toMatchObject({ rotateAnswer: expect.stringContaining("closed before the answer") });
    });

    it("a refused rotate that left nothing pending stops before anything is stopped, and says the old conversation is unchanged", async () => {
      const { w } = canonicalWorld();
      w.rotate.answer = "denied";
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(results(w).at(-1)).toEqual(["switchover", "failed"]);
      expect(JSON.stringify(w.out)).toContain("the old conversation is unchanged");
      expect(w.changes.filter((c) => c.startsWith("SIGTERM") || c.startsWith("tmux new-"))).toEqual([]);
    });

    it("refuses while the project has running work, before anything is written or asked of the daemon", async () => {
      const { w } = canonicalWorld();
      w.openRuns = [{ runId: "run_1", state: "ACTIVE", kind: "IMPLEMENT" }];
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(results(w)).toEqual([["no-live-run", "failed"]]);
      expect(w.changes).toEqual([]);
      expect(w.rotateCalls).toEqual([]);
    });

    it("on failure prints the one recovery command, --fresh --apply, which never goes back to the old conversation", async () => {
      const { w } = canonicalWorld();
      w.launched.claims = false;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(last(w)).toEqual({ result: "stopped", at: "claimed", rerun: `agentctl cto relaunch ${P} --fresh --apply` });
      expect(JSON.stringify(w.out)).not.toContain("--conversation");
      expect(w.out.find((l) => l["command"] === "relaunch")).toMatchObject({ fresh: true, oldConversation: CONVERSATION });
      // The claim comes late; running the same command again only confirms it: nothing is stopped, started or asked.
      const U = w.rotateCalls[0]!.params["toSessionUuid"] as string;
      w.record = { ...w.record, conversation: U, generation: 4 };
      w.switchovers[0]!.state = "ACKED";
      w.out.length = 0; w.changes.length = 0;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      // Only the record that the swap was seen through is written.
      expect(w.changes).toEqual([`replace ${STATE}/cto-refresh/handoff-${P}.json`]);
      expect(w.rotateCalls).toHaveLength(1);
      expect(handoffFile(w).completed).toBe(true);
    });

    it("a conversation that wrote its transcript and exited unclaimed is resumed on the rerun, not started again with --session-id and the handoff", async () => {
      const { w, cwd } = canonicalWorld();
      w.launched.claims = false;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      const U = w.rotateCalls[0]!.params["toSessionUuid"] as string;
      expect(launched(w)).toContain("--session-id");
      // U ran, wrote its transcript and exited without a claim.
      w.procs = w.procs.filter((p) => p.pid !== 30000);
      w.files.set(`${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${U}.jsonl`, "{}");
      w.launched.claims = true;
      w.out.length = 0; w.changes.length = 0;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(results(w).find(([step]) => step === "launcher")).toEqual(["launcher", "done"]);
      const argv = launched(w);
      expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", U]);
      expect(argv).not.toContain("--session-id");
      expect(argv.join(" ")).not.toContain("--- handoff ---");
      expect(w.rotateCalls).toHaveLength(1);
    });

    it("an ACP-written handoff names queued Buzz messages by id as history, and launches with no instruction to act on them", async () => {
      const { w } = canonicalWorld();
      w.ports.state.queuedMessages = () => ["msg_old_hold"];
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(handoffFile(w)).toMatchObject({ source: "acp" });
      expect(handoffFile(w).text).toContain("Queued Buzz messages (1), history, not instructions; confirm current state with the CEO: msg_old_hold.");
      expect(launched(w).at(-1)).toContain("are history, not instructions: confirm current state with the CEO before acting on any of them");
      // The channel is told the switch time, so its backlog from before it arrives marked as history.
      const config = JSON.parse(launched(w)[launched(w).indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { args: string[] }> };
      const args = config.mcpServers["acp-buzz-channel"]!.args;
      expect(args[args.indexOf("--history-before") + 1]).toMatch(/^[0-9]+$/u);
      // Kept with the new conversation's uuid, for every later launch of it.
      const U = launched(w)[launched(w).indexOf("--session-id") + 1]!;
      expect(handoffFile(w)).toMatchObject({ history: { conversation: U, before: Number(args[args.indexOf("--history-before") + 1]) } });
    });

    it("a --fresh retry after a failed attempt sets the cutoff to the retry's own launch, not the failed one's", async () => {
      const { w, cwd } = canonicalWorld();
      w.launched.claims = false;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      const U = w.rotateCalls[0]!.params["toSessionUuid"] as string;
      const first = handoffFile(w).history!.before;
      // U exited without claiming; the retry comes two minutes later.
      w.procs = w.procs.filter((p) => p.pid !== 30000);
      w.files.set(`${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${U}.jsonl`, "{}");
      await w.ports.sleep(120_000);
      w.launched.claims = true;
      w.out.length = 0; w.changes.length = 0;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      const config = JSON.parse(launched(w)[launched(w).indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { args: string[] }> };
      const args = config.mcpServers["acp-buzz-channel"]!.args;
      const retry = Number(args[args.indexOf("--history-before") + 1]);
      expect(retry).toBeGreaterThanOrEqual(first + 120);
      expect(handoffFile(w).history).toEqual({ conversation: U, before: retry });
    });

    it("a later resume of the fresh conversation passes the same cutoff its fresh launch did", async () => {
      const { w } = canonicalWorld();
      w.files.set(`${STATE}/cto-refresh/handoff-${P}.json`, JSON.stringify({
        schema: "acp.cto-handoff.v1", projectId: P, conversation: "00000000-0000-4000-8000-000000000000", source: "acp", text: "t",
        writtenAt: "2026-11-20T00:00:00Z", next: CONVERSATION, completed: true, history: { conversation: CONVERSATION, before: 1_795_000_000 },
      }));
      expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
      const config = JSON.parse(launched(w)[launched(w).indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { args: string[] }> };
      const args = config.mcpServers["acp-buzz-channel"]!.args;
      expect(args.slice(args.indexOf("--history-before"), args.indexOf("--history-before") + 2)).toEqual(["--history-before", "1795000000"]);
    });

    it("a pending switchover found with no local handoff is written down at once: U's late claim is then recognized, and nothing is prepared or stopped again", async () => {
      const { w } = canonicalWorld();
      const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      w.switchovers = [{ toSessionUuid: U, state: "PENDING" }];
      w.launched.claims = false;
      expect(w.files.has(`${STATE}/cto-refresh/handoff-${P}.json`)).toBe(false);
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(w.rotateCalls).toEqual([]);
      expect(handoffFile(w)).toMatchObject({ conversation: CONVERSATION, source: "acp", next: U });
      // U claims late, as the process the role is bound to.
      w.record = { ...w.record, conversation: U, generation: 4 };
      w.switchovers[0]!.state = "ACKED";
      w.out.length = 0; w.changes.length = 0;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(w.rotateCalls).toEqual([]);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM") || c.startsWith("tmux new-"))).toEqual([]);
      expect(handoffFile(w).completed).toBe(true);
    });

    /** What U's claim looks like to everything else: the old process gone, U's running with the channel, the role bound to U at the next generation. */
    const claimByNew = (w: World, U: string): void => {
      const argv = [LOCAL_CLAUDE, "--session-id", U, ...CHANNEL.split(" ")];
      w.procs = [{ pid: 30000, ppid: 1, command: argv.join(" "), argv }];
      w.record = { ...w.record, conversation: U, generation: 4, session: { pid: 30000, startedAt: "start-30000", workdir: null } };
      for (const one of w.switchovers) if (one.toSessionUuid === U) one.state = "ACKED";
    };
    const U1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const mutations = (w: World): string[] => w.changes.filter((c) => c.startsWith("SIGTERM") || c.startsWith("tmux new-") || c.includes(" mcp ") || c.startsWith("operator canonicalCto.rotate"));

    it("A: signals only the identity it checked: another run stops the old process and U claims right after the stop's reading, and U is not signalled", async () => {
      const { w } = canonicalWorld();
      w.switchovers = [{ toSessionUuid: U1, state: "PENDING" }];
      let reads = 0;
      // The third process-table reading after the mcp step is the stop's own selection.
      w.onTable = () => { if (w.out.some((l) => l["step"] === "mcp" && l["result"]) && ++reads === 3) claimByNew(w, U1); };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM"))).toEqual([]);
      expect(w.procs.map((p) => p.pid)).toEqual([30000]);
      expect(handoffFile(w)).toMatchObject({ next: U1, completed: true });
    });

    it("B: a pending switchover with no handoff whose U claims after the channel step is a finished swap: nothing is prepared, stopped or started, and the run exits 0", async () => {
      const { w } = canonicalWorld();
      w.switchovers = [{ toSessionUuid: U1, state: "PENDING" }];
      let fired = false;
      w.onStatus = () => { if (!fired && w.out.some((l) => l["step"] === "channel" && l["result"])) { fired = true; claimByNew(w, U1); } };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(fired).toBe(true);
      expect(mutations(w)).toEqual([]);
      expect(w.rotateCalls).toEqual([]);
      expect(handoffFile(w)).toMatchObject({ conversation: CONVERSATION, next: U1, completed: true });
      expect(w.record.conversation).toBe(U1);
    });

    it("C: a role that another, unknown conversation holds after this run began changes nothing and exits non-zero, before rotate and again after it", async () => {
      const OTHER = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const before = canonicalWorld().w;
      let fired = false;
      before.onStatus = () => { if (!fired && before.out.some((l) => l["step"] === "channel" && l["result"])) { fired = true; before.record = { ...before.record, conversation: OTHER, generation: 4 }; } };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], before.ports)).toBe(1);
      expect(fired).toBe(true);
      expect(mutations(before)).toEqual([]);
      expect(JSON.stringify(before.out)).toContain(`the bound conversation is ${OTHER}`);
      // The same, right after the daemon accepted rotate.
      const after = canonicalWorld().w;
      const rotate = after.ports.operator.request;
      after.ports.operator.request = async (method, params, key) => {
        const answer = await rotate(method, params, key);
        if (method === "canonicalCto.rotate") after.record = { ...after.record, conversation: OTHER };
        return answer;
      };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], after.ports)).toBe(1);
      expect(mutations(after).filter((c) => !c.startsWith("operator canonicalCto.rotate"))).toEqual([]);
      expect(after.procs.some((p) => p.pid === CLAUDE)).toBe(true);
    });

    it("D: a hold lost during the switchover's own status read: rotate is not asked and the handoff is not rewritten", async () => {
      const { w } = canonicalWorld();
      w.files.set(`${STATE}/cto-refresh/handoff-${P}.json`, JSON.stringify({ schema: "acp.cto-handoff.v1", projectId: P, conversation: CONVERSATION, source: "cto", text: "Go on.", writtenAt: "2026-11-20T00:00:00Z" }));
      // After the channel step: the first status read is the step's done, the second is run's own, which awaits before it mutates.
      let reads = 0;
      w.onStatus = () => { if (w.out.some((l) => l["step"] === "channel" && l["result"]) && ++reads === 2) w.hold.open = false; };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(w.rotateCalls).toHaveLength(0);
      expect(mutations(w)).toEqual([]);
      expect(handoffFile(w).next).toBeUndefined();
      expect(JSON.stringify(w.out)).toContain("the hold on this swap was lost");
    });

    it("E: a hold lost during the stop's own process reading: the old CTO is not signalled and U is not launched", async () => {
      const { w } = canonicalWorld();
      w.switchovers = [{ toSessionUuid: U1, state: "PENDING" }];
      let reads = 0;
      // The third process-table reading after the mcp step is the stop's own selection, awaited before the signal.
      w.onTable = () => { if (w.out.some((l) => l["step"] === "mcp" && l["result"]) && ++reads === 3) w.hold.open = false; };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM") || c.startsWith("tmux new-"))).toEqual([]);
      expect(w.procs.some((p) => p.pid === CLAUDE)).toBe(true);
      expect(JSON.stringify(w.out)).toContain("the hold on this swap was lost");
    });

    const handoffWrites = (w: World): number => w.changes.filter((c) => c === `replace ${STATE}/cto-refresh/handoff-${P}.json`).length;

    it("F: a run that lost the hold to a successor prints no recovery command that would replace the successor's conversation", async () => {
      const { w } = canonicalWorld();
      const OTHER = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      let reads = 0;
      // The hold closes during the switchover's own status read; the successor then holds the role.
      w.onStatus = () => { if (w.out.some((l) => l["step"] === "channel" && l["result"]) && ++reads === 2) { w.hold.open = false; w.record = { ...w.record, conversation: OTHER, generation: 4 }; } };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(last(w)).toMatchObject({ result: "stopped", at: "switchover" });
      expect(last(w)["rerun"]).toBeUndefined();
      expect(JSON.stringify(w.out)).not.toContain("--fresh --apply");
      expect(mutations(w)).toEqual([]);
    });

    it("G: a hold lost during the status read after rotate: the handoff file is not replaced again", async () => {
      const { w } = canonicalWorld();
      w.files.set(`${STATE}/cto-refresh/handoff-${P}.json`, JSON.stringify({ schema: "acp.cto-handoff.v1", projectId: P, conversation: CONVERSATION, source: "cto", text: "Go on.", writtenAt: "2026-11-20T00:00:00Z" }));
      let writes = -1;
      const status = w.onStatus;
      w.onStatus = () => { status?.(); if (writes < 0 && w.rotateCalls.length > 0) { writes = handoffWrites(w); w.hold.open = false; } };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(w.rotateCalls).toHaveLength(1);
      expect(writes).toBeGreaterThanOrEqual(0);
      expect(handoffWrites(w)).toBe(writes);
      expect(mutations(w).filter((c) => !c.startsWith("operator canonicalCto.rotate"))).toEqual([]);
    });

    it("H: a hold lost during the launcher step's process-table read: cto-launch-<project>.sh is not replaced", async () => {
      const { w } = canonicalWorld();
      w.switchovers = [{ toSessionUuid: U1, state: "PENDING" }];
      let reads = 0;
      // After one-cto: the launcher's done reads the table twice, its run's own read is the third.
      w.onTable = () => { if (w.out.some((l) => l["step"] === "one-cto" && l["result"]) && !w.out.some((l) => l["step"] === "launcher" && l["result"]) && ++reads === 3) w.hold.open = false; };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(w.changes.filter((c) => c.includes(`cto-launch-${P}.sh`))).toEqual([]);
      expect(mutations(w)).toEqual([]);
    });

    it("I: a hold lost during the first pane capture of the launch: Enter is not sent to the startup warning", async () => {
      const { w } = canonicalWorld();
      w.pane = "flood";
      w.switchovers = [{ toSessionUuid: U1, state: "PENDING" }];
      const run = w.ports.run;
      let captures = 0;
      w.ports.run = (bin, args, options) => { if (bin === "tmux" && args[0] === "capture-pane" && ++captures === 1) w.hold.open = false; return run(bin, args, options); };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(captures).toBeGreaterThanOrEqual(1);
      expect(w.changes.filter((c) => c.startsWith("tmux send-keys"))).toEqual([]);
      expect(JSON.stringify(w.out)).toContain("nothing was pressed");
    });

    describe("--cwd: the new conversation starts in another folder", () => {
      const withFolder = (): { w: World; cwd: string; dir: string } => {
        const { w, cwd } = canonicalWorld();
        const dir = realpathSync(tempDir("acp-cto-newdir-"));
        const config = w.ports.env["CLAUDE_CONFIG_DIR"]!;
        writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true }, [dir]: { hasTrustDialogAccepted: true } } }));
        w.files.set(`${dir}/.keep`, "");
        w.files.set(`${STATE}/cto-refresh/handoff-${P}.json`, JSON.stringify({ schema: "acp.cto-handoff.v1", projectId: P, conversation: CONVERSATION, source: "cto", text: "Go on.", writtenAt: "2026-11-20T00:00:00Z" }));
        return { w, cwd, dir };
      };
      const unchanged = (w: World): void => { expect(w.changes).toEqual([]); expect(w.rotateCalls).toHaveLength(0); expect(w.files.get(`${STATE}/cto-refresh/handoff-${P}.json`)).not.toContain('"cwd"'); };

      it("the plan names the folder, the trust step checks it, the launcher goes there and the mcp entry moves", async () => {
        const { w, cwd, dir } = withFolder();
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir], w.ports)).toBe(0);
        expect(JSON.stringify(w.out)).toContain(dir);
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(0);
        expect(w.out.find((l) => l["step"] === "trust" && l["result"] === "done")!["detail"]).toMatchObject({ folder: dir });
        expect(w.files.get(w.launched.command!)).toContain(dir);
        expect(w.files.get(w.launched.command!)).not.toContain(cwd);
        // Only the new folder's entry is written; the old folder's is never touched.
        expect(w.mcpCalls).toEqual([`${dir} remove`, `${dir} add`]);
        expect(JSON.parse(w.files.get(`${STATE}/cto-refresh/handoff-${P}.json`)!)).toMatchObject({ cwd: dir });
      });

      it("the trust step refuses an untrusted folder and nothing is stopped or written", async () => {
        const { w, dir } = withFolder();
        writeFileSync(join(w.ports.env["CLAUDE_CONFIG_DIR"]!, ".claude.json"), JSON.stringify({ projects: {} }));
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(1);
        expect(JSON.stringify(w.out)).toContain(dir);
        expect(w.changes.filter((c) => !c.startsWith("replace "))).toEqual([]);
      });

      it("the new conversation's transcript is looked for under the new folder", async () => {
        const { w, dir } = withFolder();
        const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        w.switchovers = [{ toSessionUuid: U, state: "PENDING" }];
        w.files.set(`${HOME}/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, "-")}/${U}.jsonl`, "{}");
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(0);
        const argv = (w.out.find((l) => l["step"] === "launch" && l["result"] === "done")!["detail"] as { argv: string[] }).argv;
        expect(argv).toContain("--resume");
        expect(argv).not.toContain("--session-id");
      });

      it("refuses a folder that does not exist, the home folder, and --cwd without --fresh; nothing changes", async () => {
        const { w, dir } = withFolder();
        for (const args of [["--fresh", "--cwd", `${dir}/missing`], ["--fresh", "--cwd", HOME], ["--cwd", dir]]) {
          expect(await runCtoCommand(["relaunch", P, ...args, "--apply"], w.ports)).toBe(2);
          expect(last(w)).toMatchObject({ nothingChanged: true });
          unchanged(w);
        }
        expect(w.hold.calls).toEqual([]);
      });

      const seed = (w: World, projects: Record<string, unknown>, at: string): void => { w.files.set(`${at}/.claude.json`, JSON.stringify({ projects })); };
      const theirs = { command: "node", args: ["cli.js", "attach", "canonical-cto", "--claimed-session-id", CONVERSATION, "--project-id", "prj_other"] };

      it("another project's entry in the new folder, read from $CLAUDE_CONFIG_DIR, is never overwritten: refused, nothing stopped or written", async () => {
        const { w, dir } = withFolder();
        // ~/.claude.json holds nothing there; Claude reads the config dir's file, so that is where the entry is.
        seed(w, {}, HOME);
        seed(w, { [dir]: { mcpServers: { "acp-cto": theirs } } }, w.ports.env["CLAUDE_CONFIG_DIR"]!);
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(1);
        expect(w.mcpCalls).toEqual([]);
        expect(w.changes.filter((c) => c.startsWith("SIGTERM") || c.startsWith("tmux new-"))).toEqual([]);
      });

      it("an entry in the new folder that already names this project is repointed, not refused", async () => {
        const { w, dir } = withFolder();
        seed(w, { [dir]: { mcpServers: { "acp-cto": { ...theirs, args: ["cli.js", "attach", "--project-id", P] } } } }, w.ports.env["CLAUDE_CONFIG_DIR"]!);
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(0);
        expect(w.mcpCalls).toEqual([`${dir} remove`, `${dir} add`]);
      });

      it("a --cwd naming another folder than the one a pending swap started in is refused, nothing changed", async () => {
        const { w, dir } = withFolder();
        const other = realpathSync(tempDir("acp-cto-newdir2-"));
        w.launched.claims = false;
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(1);
        const before = [w.changes.length, w.files.get(`${STATE}/cto-refresh/handoff-${P}.json`)];
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", other, "--apply"], w.ports)).toBe(2);
        const U = JSON.parse(w.files.get(`${STATE}/cto-refresh/handoff-${P}.json`)!).next as string;
        expect(last(w)).toEqual({ refused: `swap to ${U} already started in ${dir}; rerun without --cwd or with --cwd ${dir}; nothing was changed`, nothingChanged: true });
        expect([w.changes.length, w.files.get(`${STATE}/cto-refresh/handoff-${P}.json`)]).toEqual(before);
      });

      it("home through a symlink, and a regular file, are refused before any write, a dry run included", async () => {
        const { w, dir } = withFolder();
        const home = realpathSync(tempDir("acp-cto-home-"));
        const alias = join(realpathSync(tempDir("acp-cto-homelink-")), "home");
        symlinkSync(home, alias);
        const file = join(dir, "a-file");
        writeFileSync(file, "x");
        w.files.set(file, "x");
        w.files.set(`${alias}/.keep`, "");
        for (const [target, apply] of [[alias, false], [alias, true], [file, false], [file, true]] as const) {
          expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", target, ...(apply ? ["--apply"] : [])], { ...w.ports, home })).toBe(2);
          expect(last(w)).toMatchObject({ nothingChanged: true });
          unchanged(w);
        }
      });

      it("the retry command names --cwd when the run stops before the folder is kept", async () => {
        const { w, dir } = withFolder();
        w.openRuns = [{ runId: "run_1", state: "ACTIVE", kind: "IMPLEMENT" }];
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(1);
        expect(last(w)).toEqual({ result: "stopped", at: "no-live-run", rerun: `agentctl cto relaunch ${P} --fresh --cwd ${dir} --apply` });
      });

      it("the retry command quotes the folder for sh, so $USER stays literal", async () => {
        const { w } = withFolder();
        const odd = join(realpathSync(tempDir("acp-cto-odd-")), "project-$USER's");
        mkdirSync(odd);
        w.openRuns = [{ runId: "run_1", state: "ACTIVE", kind: "IMPLEMENT" }];
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", odd, "--apply"], w.ports)).toBe(1);
        expect(last(w)).toMatchObject({ rerun: `agentctl cto relaunch ${P} --fresh --cwd '${odd.replaceAll("'", "'\\''")}' --apply` });
      });

      it("a launcher written for another folder is rewritten, not reused", async () => {
        const { w, cwd, dir } = withFolder();
        w.launched.fails = true;
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
        w.launched.fails = false;
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(0);
        expect(w.files.get(w.launched.command!)).toContain(`cd '${dir}'`);
        expect(w.files.get(w.launched.command!)).not.toContain(cwd);
      });

      it("a rerun without --cwd for the same pending conversation uses the stored folder", async () => {
        const { w, dir } = withFolder();
        w.launched.claims = false;
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--cwd", dir, "--apply"], w.ports)).toBe(1);
        w.launched.claims = true;
        w.mcpCalls.length = 0;
        expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
        expect(w.files.get(w.launched.command!)).toContain(dir);
        expect(w.mcpCalls.every((c) => c.startsWith(dir) || c.endsWith("remove"))).toBe(true);
      });
    });

    it("takes the daemon's hold first and keeps it for the whole run; a dry run takes none", async () => {
      const { w } = canonicalWorld();
      expect(await runCtoCommand(["relaunch", P, "--fresh"], w.ports)).toBe(0);
      expect(w.hold.calls).toEqual([]);
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(w.hold.calls).toEqual([{ projectId: P, holderPid: process.pid }]);
      expect(w.hold.released).toBe(1);
    });

    it("refuses when the daemon refuses the hold, and nothing is mutated", async () => {
      const { w } = canonicalWorld();
      w.hold.refused = true;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(2);
      expect(JSON.stringify(w.out)).toContain("holds project");
      expect(JSON.stringify(w.out)).toContain(`agentctl cto relaunch ${P} --fresh --apply`);
      expect(w.changes).toEqual([]);
      expect(w.rotateCalls).toEqual([]);
      expect(w.files.has(`${STATE}/cto-refresh/handoff-${P}.json`)).toBe(false);
    });

    it("a hold lost mid-run aborts before the next mutation and prints no rerun command, which could replace a successor", async () => {
      const { w } = canonicalWorld();
      let fired = false;
      // The connection closes (the daemon restarted, say) right after the channel step.
      w.onStatus = () => { if (!fired && w.out.some((l) => l["step"] === "channel" && l["result"])) { fired = true; w.hold.open = false; } };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(fired).toBe(true);
      expect(mutations(w)).toEqual([]);
      expect(last(w)).toMatchObject({ result: "stopped", at: "switchover" });
      expect(last(w)["rerun"]).toBeUndefined();
      expect(String(last(w)["note"])).toContain("no recovery command is printed");
    });

    it("(a) a conversation that claims during the launch preflight is not launched a second time", async () => {
      const { w } = canonicalWorld();
      w.switchovers = [{ toSessionUuid: U1, state: "PENDING" }];
      let reads = 0;
      // The second process-table reading after the stop is the launch's own preflight; U claims right after it.
      w.onTable = () => { if (w.out.some((l) => l["step"] === "stop" && l["result"]) && ++reads === 2) claimByNew(w, U1); };
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(w.changes.filter((c) => c.startsWith("tmux new-"))).toEqual([]);
      expect(handoffFile(w)).toMatchObject({ next: U1, completed: true });
    });

    it("(b) a swap another run saw through, whose conversation holds the role, is a success for a run that began with the old one", async () => {
      const { w } = canonicalWorld();
      let fired = false;
      w.onStatus = () => {
        if (fired || !w.out.some((l) => l["step"] === "channel" && l["result"])) return;
        fired = true;
        // The other run: prepared U, launched it, saw it claim, and marked the handoff completed.
        claimByNew(w, U1);
        w.files.set(`${STATE}/cto-refresh/handoff-${P}.json`, JSON.stringify({ ...handoffFile(w), next: U1, completed: true }));
      };
      w.switchovers = [{ toSessionUuid: U1, state: "ACKED" }];
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(0);
      expect(fired).toBe(true);
      expect(mutations(w)).toEqual([]);
      expect(w.record.conversation).toBe(U1);
    });

    it("(c) the target the daemon's read-back names is the one written down, whoever asked for it", async () => {
      const { w } = canonicalWorld();
      const V = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      w.rotate.answer = "competing";
      w.launched.claims = false;
      expect(await runCtoCommand(["relaunch", P, "--fresh", "--apply"], w.ports)).toBe(1);
      expect(handoffFile(w).next).toBe(V);
      const argv = launched(w);
      expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", V]);
    });

    it("a dry run prints the plan and asks the daemon for nothing but a read", async () => {
      const { w } = canonicalWorld();
      expect(await runCtoCommand(["relaunch", P, "--fresh"], w.ports)).toBe(0);
      expect(w.out.find((l) => l["command"] === "relaunch")!["steps"]).toEqual(FRESH_STEPS);
      expect(w.rotateCalls).toEqual([]);
      expect(w.changes).toEqual([]);
    });

    it("takes a canonical CTO only, and no --conversation", async () => {
      const resident = makeWorld({}, { ACP_OPERATOR_TOKEN: "operator-test-credential" });
      expect(await runCtoCommand(["relaunch", P, "--fresh"], resident.ports)).toBe(2);
      expect(await runCtoCommand(["relaunch", P, "--conversation", CONVERSATION], resident.ports)).toBe(2);
    });
  });
});

describe("the production file port", () => {
  it("makes the directory of a file it replaces: the first handoff, written by ACP, is the first thing in <state>/cto-refresh", async () => {
    const dir = tempDir("acp-cto-state-");
    const ports = await createCtoPorts({ databasePath: join(dir, "state.sqlite"), operator: { request: async () => allow(ReasonCode.OK, {}) }, env: { HOME: dir } });
    const path = join(dir, "cto-refresh", `handoff-${P}.json`);
    expect(ports.files.exists(join(dir, "cto-refresh"))).toBe(false);
    ports.files.replace(path, "{}\n");
    expect(ports.files.read(path)).toBe("{}\n");
  });
});

/** deploy135, live: two relaunches the channel served were reported as failed, and a stop read as already done while its CTO ran. */
describe("deploy135 live defects", () => {
  it("1: a relaunch whose backlog flood scrolls the registered line away counts as registered by the channel's emitted receipt", async () => {
    const cwd = realpathSync(tempDir("acp-cto-flood-"));
    const w = makeWorld({ kind: "canonical", resident: null, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd } });
    const config = tempDir("acp-cto-flood-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    w.record = { ...w.record, repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] };
    w.ports = { ...w.ports, env: { ...w.ports.env, CLAUDE_CONFIG_DIR: config } };
    w.procs = [{ pid: CLAUDE, ppid: 1, command: `${LOCAL_CLAUDE} --resume ${CONVERSATION}`, argv: [LOCAL_CLAUDE, "--resume", CONVERSATION] }];
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    w.pane = "flood";
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(results(w).find(([s]) => s === "launch")).toEqual(["launch", "done"]);
    expect(w.changes.filter((c) => c.startsWith("tmux send-keys"))).toEqual(["tmux send-keys -t %9 Enter"]);
  });

  it("#1463 r1: an old channel's receipt appended while the launch asks for its tmux session does not count: the screen still loads", async () => {
    const cwd = realpathSync(tempDir("acp-cto-old-receipt-"));
    const w = makeWorld({ kind: "canonical", resident: null, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd } });
    const config = tempDir("acp-cto-old-receipt-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    w.record = { ...w.record, repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] };
    w.ports = { ...w.ports, env: { ...w.ports.env, CLAUDE_CONFIG_DIR: config } };
    w.procs = [{ pid: CLAUDE, ppid: 1, command: `${LOCAL_CLAUDE} --resume ${CONVERSATION}`, argv: [LOCAL_CLAUDE, "--resume", CONVERSATION] }];
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    w.pane = "loading";
    w.oldReceiptDuringLaunch = true;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["launch", "failed"]);
  }, 60_000);

  it("#1463 r1: a recorded os_pid alive with another start refuses: nothing is stopped and nothing launched, not even the process that does match", async () => {
    // The reviewer's shape: the binding's os_pid 16590 now belongs to some other process, and the CTO's conversation runs as pid 20000.
    const w = makeWorld({ generation: 4, session: { pid: CLAUDE, startedAt: "start-before-the-pid-was-reused", workdir: CLONE } });
    w.procs = [{ pid: CLAUDE, ppid: 1, command: "/usr/libexec/some-daemon" }, { pid: 20000, ppid: 1, command: `claude --resume ${CONVERSATION}`, cwd: CLONE }];
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["stop", "failed"]);
    expect(JSON.stringify(w.out)).toContain("cannot be confirmed");
    expect(w.changes).toEqual([]);
    expect(w.procs.map((p) => p.pid)).toEqual([CLAUDE, 20000]);
  });

  // myeotnyeon: pid 84604, `claude --resume 36276d16-…` (a bare argv[0]), binding ACTIVE gen 4 with os_pid 84604.
  const MYEOTNYEON = "36276d16-29e8-4946-bb88-3e5c1895e0d7";
  const myeotnyeon = (): World => {
    const w = makeWorld({ conversation: MYEOTNYEON, generation: 4, session: { pid: 84604, startedAt: "start-84604", workdir: CLONE } });
    w.procs = [{ pid: 84604, ppid: 3327, command: `claude --resume ${MYEOTNYEON} --messaging-socket-path ${STATE}/cc-session-acp-myeotnyeon.sock --remote-control myeotnyeon CTO --permission-mode bypassPermissions --dangerously-skip-permissions` }];
    w.files.set(TRANSCRIPT.replace(CONVERSATION, MYEOTNYEON), "{}");
    w.mtimes.set(TRANSCRIPT.replace(CONVERSATION, MYEOTNYEON), NOW - (IDLE_SECONDS + 60) * 1000);
    return w;
  };

  it("2: a stop is not already done while the bound session's os_pid is alive, even when the process table does not show it", async () => {
    const w = myeotnyeon();
    w.hiddenFromPs.add(84604);
    expect(await runCtoCommand(["relaunch", P], w.ports)).toBe(0);
    expect(w.out.find((l) => l["step"] === "stop")).toMatchObject({ already: false });
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(w.changes[0]).toBe("SIGTERM 84604");
  });

  it("2: with that exact argv and binding, the stop is planned and stops pid 84604", async () => {
    const w = myeotnyeon();
    expect(await runCtoCommand(["relaunch", P], w.ports)).toBe(0);
    expect(w.out.find((l) => l["step"] === "stop")).toMatchObject({ already: false });
  });

});

/** #1436 final review of cto-command.ts: the three shapes the reviewer reproduced. */
describe("one CTO per project, through the shared check (#1463)", () => {
  /** A canonical CTO whose role is bound to the claude process running `argv`. */
  const canonical = (argv: string[], bound: boolean): { w: World; cwd: string } => {
    const cwd = realpathSync(tempDir("acp-cto-one-"));
    const config = tempDir("acp-cto-one-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    const w = makeWorld({ kind: "canonical", resident: null, generation: bound ? 3 : null, session: bound ? { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd } : null,
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] }, { ACP_OPERATOR_TOKEN: "operator-test-credential", CLAUDE_CONFIG_DIR: config });
    w.procs = [{ pid: CLAUDE, ppid: 1, command: argv.join(" "), argv, cwd: "/elsewhere" }];
    w.panes = new Map([[CLAUDE, "logic-claude-handoff"]]);
    w.tmux = new Set(["logic-claude-handoff"]);
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    return { w, cwd };
  };
  const launched = (w: World): string[] => w.changes.filter((c) => /^tmux new-(session|window)/.test(c));

  it("P1 510: a bound holder started with --resume=<uuid> is stopped before the resume starts", async () => {
    const { w } = canonical([LOCAL_CLAUDE, `--resume=${CONVERSATION}`, "--permission-mode", "bypassPermissions"], true);
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(w.changes).toContain(`SIGTERM ${CLAUDE}`);
    expect(launched(w)).toHaveLength(1);
  });

  for (const [shape, argv, cwdIsCheckout, earlier] of [
    ["an unbound holder started with --resume=<uuid>", [LOCAL_CLAUDE, `--resume=${CONVERSATION}`], false, false],
    ["an earlier conversation of the role", [LOCAL_CLAUDE, "--resume", "11111111-2222-4333-8444-555555555555"], false, true],
    ["an interactive claude in the project's checkout, naming no conversation", [LOCAL_CLAUDE, "--permission-mode", "bypassPermissions"], true, false],
  ] as const) {
    it(`P1 510: ${shape} refuses the launch with CTO_ALREADY_RUNNING, and no second claude starts`, async () => {
      const { w, cwd } = canonical([...argv], false);
      if (cwdIsCheckout) w.procs[0]!.cwd = cwd;
      if (earlier) w.roleConversations.push("11111111-2222-4333-8444-555555555555");
      expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
      expect(results(w).at(-1)).toEqual(["one-cto", "failed"]);
      expect(JSON.stringify(w.out)).toContain("CTO_ALREADY_RUNNING");
      expect(w.changes).toEqual([]);
      expect(launched(w)).toEqual([]);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM"))).toEqual([]);
    });
  }

  it("P1 1096: a process reader that cannot spawn ps stops the relaunch before anything is stopped or launched", async () => {
    const { w } = canonical([LOCAL_CLAUDE, "--resume", CONVERSATION], true);
    w.psFails = true;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(JSON.stringify(w.out)).toContain("CTO_PROCESS_TABLE_UNREADABLE");
    expect(w.changes.filter((c) => c.startsWith("SIGTERM") || /^tmux new-/.test(c))).toEqual([]);
  });

  it("P1 317: prompt text \"Explain --resume <uuid> please\" is one argv element, and that process is never stopped", async () => {
    const w = makeWorld({ generation: null, session: null });
    w.procs = [{ pid: 40000, ppid: 1, command: `claude -p Explain --resume ${CONVERSATION} please`, argv: ["claude", "-p", `Explain --resume ${CONVERSATION} please`], cwd: "/tmp/elsewhere" }];
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(w.changes.filter((c) => c.startsWith("SIGTERM"))).toEqual([]);
    expect(w.procs.some((p) => p.pid === 40000)).toBe(true);
  });
});

/** #1463 review r2: a token that cannot be read is never proof of exit, and a binding is never stepped around. */
describe("#1463 r2: gone, alive and unavailable are three states", () => {
  const canonicalBound = (): World => {
    const cwd = realpathSync(tempDir("acp-cto-r2-"));
    const config = tempDir("acp-cto-r2-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    const w = makeWorld({ kind: "canonical", resident: null, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd },
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] }, { ACP_OPERATOR_TOKEN: "operator-test-credential", CLAUDE_CONFIG_DIR: config });
    w.procs = [{ pid: CLAUDE, ppid: 1, command: `${LOCAL_CLAUDE} --resume ${CONVERSATION}`, argv: [LOCAL_CLAUDE, "--resume", CONVERSATION], cwd }];
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    return w;
  };
  const launches = (w: World): string[] => w.changes.filter((c) => /^tmux new-(session|window)/.test(c) || c === "provisioner ensure-resident");

  it("P1 346: a pid that survives SIGTERM and whose token reads null once is not taken as exited; nothing launches beside it", async () => {
    const w = canonicalBound();
    w.survivesSigterm.add(CLAUDE);
    w.tokenGlitchAfterSignal.set(CLAUDE, 1);
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["stop", "failed"]);
    expect(JSON.stringify(w.out)).toContain("did not provably exit");
    expect(launches(w)).toEqual([]);
  });

  it("P1 234: a bound os_pid whose start cannot be read refuses, and the resident fallback never signals pid 20000 in its place", async () => {
    const w = makeWorld({ generation: 4, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: CLONE } });
    w.procs = [{ pid: CLAUDE, ppid: 1, command: "/bin/claude --model opus", cwd: "/elsewhere" }, { pid: 20000, ppid: 1, command: `claude --resume ${CONVERSATION}`, cwd: CLONE }];
    w.tokenUnavailable.add(CLAUDE);
    expect(await runCtoCommand(["relaunch", P], w.ports)).toBe(0);
    expect(w.out.find((l) => l["step"] === "stop")).toMatchObject({ already: false });
    w.out.length = 0;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["stop", "failed"]);
    expect(JSON.stringify(w.out)).toContain("cannot be read");
    expect(w.changes).toEqual([]);
  });

  it("P1 234: a bound os_pid that is provably gone is nothing to stop; another matching process is never signalled in its place", async () => {
    const w = makeWorld({ generation: 4, session: { pid: 16591, startedAt: "start-16591", workdir: CLONE } });
    w.procs = [{ pid: 20000, ppid: 1, command: `claude --resume ${CONVERSATION}`, cwd: CLONE }];
    await runCtoCommand(["relaunch", P, "--apply"], w.ports);
    expect(w.changes.filter((c) => c.startsWith("SIGTERM"))).toEqual([]);
  });

  it("P1 234: the fallback to the shared check's match is an unbound resident's only", async () => {
    const w = makeWorld({ generation: null, session: null });
    w.procs = [{ pid: 20000, ppid: 1, command: `claude --resume ${CONVERSATION}`, cwd: CLONE }];
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(w.changes[0]).toBe("SIGTERM 20000");
  });

  it("P2 509: a launcher an earlier version wrote ({tmux, argv}) is regenerated, keeping what it carried, and the relaunch goes on", async () => {
    const w = canonicalBound();
    w.procs = [];
    w.record = { ...w.record, generation: null, session: null };
    const legacy = { tmux: "logic-claude-handoff", argv: [LOCAL_CLAUDE, "--mcp-config", "{}", "--dangerously-load-development-channels", "server:acp-buzz-channel", "--resume", CONVERSATION, "--name", "Logic CTO", "--permission-mode", "bypassPermissions"] };
    w.files.set(`${STATE}/cto-launch-${P}.sh`, `#!/bin/sh\n# cto-launch: ${JSON.stringify(legacy)}\nexec true\n`);
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(results(w).find(([s]) => s === "launcher")).toEqual(["launcher", "done"]);
    const launch = w.out.find((l) => l["step"] === "launch" && l["result"] === "done")!["detail"] as { argv: string[]; tmux: string };
    expect(launch.argv.slice(launch.argv.indexOf("--name"), launch.argv.indexOf("--name") + 2)).toEqual(["--name", "Logic CTO"]);
    expect(launch.tmux).toBe("logic-claude-handoff");
  });
});

/** #1463 final review: the reviewer's two repros, by name. */
describe("#1463 final review repros", () => {
  const canonicalBound = (): World => {
    const cwd = realpathSync(tempDir("acp-cto-final-"));
    const config = tempDir("acp-cto-final-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    const w = makeWorld({ kind: "canonical", resident: null, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd },
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] }, { ACP_OPERATOR_TOKEN: "operator-test-credential", CLAUDE_CONFIG_DIR: config });
    w.procs = [{ pid: CLAUDE, ppid: 1, command: `${LOCAL_CLAUDE} --resume ${CONVERSATION}`, argv: [LOCAL_CLAUDE, "--resume", CONVERSATION], cwd }];
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    return w;
  };
  const launchesOrSignals = (w: World): string[] => w.changes.filter((c) => /^tmux new-(session|window)|^SIGTERM|^provisioner ensure-resident/.test(c));

  it("a surviving CTO with one null token after SIGTERM while ps -o stat exits 1 is not exited, and pid 30000 never launches beside it", async () => {
    const w = canonicalBound();
    w.survivesSigterm.add(CLAUDE);
    w.tokenGlitchAfterSignal.set(CLAUDE, 1);
    w.psStatFails = true;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["stop", "failed"]);
    expect(w.changes.filter((c) => /^tmux new-/.test(c))).toEqual([]);
    expect(w.procs.some((p) => p.pid === 30000)).toBe(false);
  });

  // After the plan's first step, the stop's done() and its target selection read the token once each; the read right
  // before the signal is the 3rd.
  it("pid 16590 replaced after its selection, with the last token read unavailable: the replacement is never signalled", async () => {
    const w = makeWorld();
    w.tokenAfterIdle.set(CLAUDE, (read) => (read <= 2 ? `start-${CLAUDE}` : null));
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["stop", "failed"]);
    expect(launchesOrSignals(w)).toEqual([]);
  });

  it("pid 16590 replaced after its selection, with a different token read right before the signal: refused, nothing signalled", async () => {
    const w = makeWorld();
    w.tokenAfterIdle.set(CLAUDE, (read) => (read <= 2 ? `start-${CLAUDE}` : "start-of-the-replacement"));
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["stop", "failed"]);
    expect(launchesOrSignals(w)).toEqual([]);
  });
});

describe("agentctl cto list", () => {
  it("reports the CTO's generation, live session, channel, room and route, and not its relay", async () => {
    const w = makeWorld();
    expect(await runCtoCommand(["list"], w.ports)).toBe(0);
    expect(w.out).toEqual([{ ctos: [expect.objectContaining({
      project: P, kind: "resident", generation: 3, conversation: CONVERSATION, room: ROOM, roomRouted: true,
      session: [{ pid: CLAUDE, tmux: TMUX, channel: true, matchedBy: ["conversation", "bound-pid"] }],
    })] }]);
  });
});

describe("agentctl cto is operator only", () => {
  it("refuses --apply, before any step, without the operator credential a CTO's launch shell unsets", async () => {
    for (const args of [[...RETIRE, "--apply"], ["relaunch", P, "--apply"], ["add", P, "--apply"]]) {
      const w = makeWorld({}, {});
      expect(await runCtoCommand(args, w.ports)).toBe(2);
      expect(w.out).toEqual([expect.objectContaining({ nothingChanged: true })]);
      expect(w.changes).toEqual([]);
      expect(w.ran).toEqual([]);
    }
  });

  it("has no tool on a CTO's acp-cto surface", async () => {
    const h = makeHarness();
    const cto = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: "cto" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await cto.connect(serverTransport);
    const client = new Client({ name: "cto-surface", version: "1" });
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      for (const sub of CTO_SUBCOMMANDS) expect(names).not.toContain(`cto_${sub}`);
      expect(names.filter((name) => /retire|relaunch|project_register|repo_delete/.test(name))).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
