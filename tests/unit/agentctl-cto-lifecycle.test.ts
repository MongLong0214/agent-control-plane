import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/agentctl.ts";
import {
  CTO_SUBCOMMANDS, CTO_USAGE, IDLE_SECONDS, checkoutHeldWork, hostRunner, runCtoCommand, workerHeldWork,
  type CtoExec, type CtoExecOptions, type CtoExecResult, type CtoPorts, type CtoRecord,
} from "../../src/cli/cto-command.ts";
import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { writeHandoff } from "../../src/cto/cto-session-refresh.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { CHANNEL_REGISTERED_LINE, DEV_CHANNELS_WARNING } from "../../src/runtime/cto-channel-launch.ts";
import type { CtoProcessReader, CtoRoleScope } from "../../src/cto/one-cto-per-project.ts";

/** A process of the fake host: its kernel argv (else its command split on spaces) and its working directory. */
interface FakeProcess { pid: number; ppid: number; command: string; argv?: string[]; cwd?: string }
import { formatHostProvisionerReason, hostProvisionerReason, hostReasonKind, hostRefusalText } from "../../src/runtime/host-provisioner-reason.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir } from "../helpers/fixtures.ts";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
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
  launched: { command: string | null; claims: boolean };
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
  /** The shared reader's alive() answers false for every pid: the old reading of `ps -o stat= -p` exiting 1. */
  psStatFails: boolean;
  /** Per pid, what each token read answers once the plan's first step has reported: by read number, from 1. */
  tokenAfterIdle: Map<number, (read: number) => string | null>;
  /** The daemon's switchover (`canonicalCto.rotate`) as a refresh drives it: what is pending, and what makes it refuse. */
  rotation: { pending: { to: string; handoff: Record<string, unknown> } | null; draining: boolean; liveRuns: string[]; refuses: boolean; cancelRefuses: boolean; calls: string[];
    rotated: Array<{ to: string; handoff: Record<string, unknown>; from: string | null }>;
    /** The conversations that claimed their switchover. */
    acked: string[];
    /** The daemon commits the switchover and its answer is lost (DAEMON_LOCK_LOST). */
    lostResponse: boolean;
    /** The 1-based numbers of the `canonicalCto.status` calls that fail, and how many have been made. */
    failStatusAt: number[]; statusCalls: number };
  /** Writes of these paths fail once with EIO, in order of the list. */
  replaceFailures: RegExp[];
  /** Each tmux launch: the conversation it starts and the claude processes alive when it started. */
  launchLog: Array<{ conversation: string; alive: number[] }>;
  /** The next tmux starts that fail outright, and the claim outcome of each next launch (else `launched.claims`). */
  tmuxStartFails: number;
  claimQueue: boolean[];
  /** What ACP's records say a successor needs; null: no active binding. */
  facts: { openRuns: Array<{ runId: string; state: string; kind: string }>; queued: Array<{ messageId: string; kind: string; status: string; createdAt: string; text: string | null }> } | null;
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
    out: [], changes: [], ran: [], files, mtimes, tmux: new Set([TMUX]), repo: { exists: true }, worker: { unpublished: false, fetchFails: false }, operatorAnswers: [], provisionerAnswers: [],
    dirty: new Set<string>(), archiveUnpublished: false, daemonRejects: false, retireExecutions: 0, rotateRuns: [],
    argv: new Map<number, string[]>(), panes: new Map([[100, TMUX]]), launched: { command: null, claims: true }, pane: "registered", oldReceiptDuringLaunch: false, hiddenFromPs: new Set<number>(), psFails: false, roleConversations: [],
    tokenUnavailable: new Set<number>(), survivesSigterm: new Set<number>(), tokenGlitchAfterSignal: new Map<number, number>(), signalled: new Set<number>(),
    psStatFails: false, tokenAfterIdle: new Map<number, (read: number) => string | null>(),
    facts: { openRuns: [{ runId: "run_1", state: "ACTIVE", kind: "STANDARD_WORK" }], queued: [] },
    rotation: { pending: null, draining: false, liveRuns: [], refuses: false, cancelRefuses: false, calls: [], rotated: [], acked: [], lostResponse: false, failStatusAt: [], statusCalls: 0 },
    replaceFailures: [], launchLog: [], tmuxStartFails: 0, claimQueue: [],
    procs: [
      { pid: 100, ppid: 1, command: "/bin/sh /state/resident-e2e-sort-fixture.sh" },
      { pid: CLAUDE, ppid: 100, command: `/bin/claude --model opus ${CHANNEL} --resume ${CONVERSATION} --name e2e CTO` },
      // The acp-cto relay names the conversation too, but is not the conversation's process.
      { pid: 16970, ppid: CLAUDE, command: `/node agentctl.js attach resident-cto --claimed-session-id ${CONVERSATION} --project-id ${P}` },
    ],
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
  let launches = 0;
  const subprocess = (bin: string, args: readonly string[], options: CtoExecOptions = {}): CtoExecResult => {
    const line = [bin, ...args].join(" ");
    w.ran.push(line);
    const answer = (status: number, stdout = "", stderr = ""): CtoExecResult => ({ status, stdout, stderr });
    if (bin === "tmux" && args[0] === "list-panes") return answer(0, [...w.panes].map(([pid, session]) => `${pid} ${session}\n`).join(""));
    // A launch: tmux starts the launcher, which resumes the conversation with its channel; the conversation claims the role.
    if (bin === "tmux" && (args[0] === "new-session" || args[0] === "new-window")) {
      if (w.tmuxStartFails > 0) { w.tmuxStartFails--; return answer(1, "", "tmux: no server running\n"); }
      w.changes.push(line);
      if (args[0] === "new-session") w.tmux.add(args[args.indexOf("-s") + 1]!);
      w.launched.command = args[args.length - 1]!;
      // The conversation the launcher starts: a new one (--session-id) or a resumed one (--resume), as its script says.
      const named = /'--(session-id|resume)' '([0-9a-f-]{36})'/.exec(files.get(w.launched.command) ?? "");
      const started = named?.[2] ?? w.record.conversation;
      const pid = 30000 + launches++;
      w.launchLog.push({ conversation: started!, alive: w.procs.filter((p) => /claude/.test(p.command)).map((p) => p.pid) });
      const claims = w.claimQueue.length > 0 ? w.claimQueue.shift()! : w.launched.claims;
      w.procs.push({ pid, ppid: 1, command: `${LOCAL_CLAUDE} --mcp-config {} ${CHANNEL} --${named?.[1] ?? "resume"} ${started}` });
      // A conversation a pending switchover does not name is fenced and never claims; the one it names takes the role.
      const named_ = w.rotation.pending !== null && started === w.rotation.pending.to;
      if (claims && (w.rotation.pending === null || named_)) {
        w.record = { ...w.record, ...(named_ ? { conversation: started } : {}), generation: (w.record.generation ?? 3) + 1, session: { pid, startedAt: `start-${pid}`, workdir: null } };
        if (named_) { w.rotation.acked.push(started!); w.rotation.pending = null; w.rotation.draining = false; }
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
    if (bin === LOCAL_CLAUDE && args[0] === "mcp") { w.changes.push(line); return answer(args[1] === "remove" ? 1 : 0); }
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
      // The daemon: it authenticates every request, answers reads, and replays a mutation's answer for a key it has seen.
      request: async (method: string, params: Record<string, unknown> = {}, idempotencyKey?: string) => {
        if (w.daemonRejects) return deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator authentication failed");
        if (method === "daemon.status") return allow(ReasonCode.OK, { mode: "RUNNING" });
        if (method.startsWith("canonicalCto.")) {
          w.rotation.calls.push(method);
          if (method !== "canonicalCto.status") w.changes.push(`operator ${method}`);
          if (method === "canonicalCto.status") {
            if (w.rotation.failStatusAt.includes(++w.rotation.statusCalls)) return deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held");
            return allow(ReasonCode.OK, { projectId: params["projectId"], holderSessionUuid: w.record.conversation, generation: w.record.generation ?? 0,
              binding: w.record.generation === null ? null : { generation: w.record.generation, sessionId: "session-1", lifecycle: w.rotation.draining ? "DRAINING" : "READY", liveRuns: w.rotation.liveRuns },
              rotations: [...w.rotation.rotated].reverse().map((one) => ({ toSessionUuid: one.to, fromSessionUuid: one.from,
                state: w.rotation.pending?.to === one.to ? "PENDING" : w.rotation.acked.includes(one.to) ? "ACKED" : "REVOKED" })) });
          }
          if (method === "canonicalCto.rotate") {
            if (w.rotation.refuses) return deny(ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS, "switchover requires the outgoing CTO to have zero active runs");
            w.rotation.pending = { to: params["toSessionUuid"] as string, handoff: params["handoff"] as Record<string, unknown> };
            w.rotation.rotated.push({ ...w.rotation.pending, from: w.record.conversation });
            w.rotation.draining = true;
            if (w.rotation.lostResponse) return deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for canonical CTO rotation");
            return allow(ReasonCode.OK, { outcome: "SWITCHOVER_PENDING", toSessionUuid: params["toSessionUuid"] });
          }
          if (w.rotation.pending === null) return deny(ReasonCode.NOT_FOUND, "no pending switchover");
          if (w.rotation.cancelRefuses) return deny(ReasonCode.CONFLICT, "cancel refused");
          w.rotation.pending = null; w.rotation.draining = false;
          return allow(ReasonCode.OK, { outcome: "SWITCHOVER_CANCELLED" });
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
      // The shared rule's scope as the database gives it: the role's conversations, its live checkouts, its bound process.
      roleScope: (id: string, extra: { conversationIds?: readonly string[]; checkouts?: readonly string[] } = {}): CtoRoleScope => ({
        projectId: id,
        conversationIds: [...new Set([...(w.record.conversation ? [w.record.conversation] : []), ...w.roleConversations, ...(extra.conversationIds ?? [])])],
        checkouts: [...new Set([...w.record.repositories.map((r) => r.checkoutPath), ...(extra.checkouts ?? [])])],
        bound: w.record.generation !== null && w.record.session?.pid ? [{ pid: w.record.session.pid, startedAt: w.record.session.startedAt }] : [],
      }),
      handoffFacts: (id: string, conversation: string) => w.facts ? { projectId: id, conversation, generation: w.record.generation ?? 0, sessionId: "session-1", ...w.facts } : null,
    },
    run: subprocess,
    // The shared one-CTO reader: the kernel's argv, the table ps gives (this test process included), working directories.
    ctoProcesses: {
      table: async () => {
        if (w.psFails) throw Object.assign(new Error("spawn /bin/ps ENOENT"), { code: "ENOENT" });
        return [{ pid: process.pid, ppid: 1, uid: process.getuid?.() ?? 0, startedAt: "Fri Jan  1 00:00:00 2027", command: "node vitest" },
          ...w.procs.filter((p) => !w.hiddenFromPs.has(p.pid)).map((p) => ({ pid: p.pid, ppid: p.ppid, uid: process.getuid?.() ?? 0, startedAt: `lstart-${p.pid}`, command: p.command }))];
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
      replace: (path: string, body: string) => {
        const failing = w.replaceFailures.findIndex((pattern) => pattern.test(path));
        if (failing >= 0) { w.replaceFailures.splice(failing, 1); throw Object.assign(new Error(`EIO: i/o error, write '${path}'`), { code: "EIO" }); }
        w.changes.push(`replace ${path}`); files.set(path, body);
      },
      move: (from: string, to: string) => { w.changes.push(`move ${from} -> ${to}`); move(from, to); },
      remove: (path: string) => { w.changes.push(`remove ${path}`); for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k); },
      mtimeMs: (path: string) => (files.has(path) ? mtimes.get(path) ?? NOW : null),
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
    expect(written.join("")).toContain("agentctl cto add|relaunch|refresh|retire <project>");
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

/**
 * `agentctl cto refresh`: a long conversation replaced by a fresh one, with the one-CTO order and its way back. The hosts
 * are fakes; what is proved is the command's own contract: the switchover is recorded before anything is stopped, the old
 * process is stopped and proven gone before the new one starts, the handoff is the new conversation's first prompt, a
 * failure after the stop resumes the OLD conversation, and the role never has two CTOs or none.
 */
describe("agentctl cto refresh", () => {
  const INFLIGHT = `${STATE}/cto-refresh/inflight-${P}.json`;
  const HANDOFF_FILE = `${STATE}/cto-refresh/handoff-${P}-g3.json`;
  const LAUNCHER = `${STATE}/cto-launch-${P}.sh`;
  const REFRESH_STEPS = ["recover", "self", "idle", "handoff", "trust", "channel", "one-cto", "switch"];
  const OLD_ARGV = [LOCAL_CLAUDE, "--resume", CONVERSATION, "--model", "claude-opus-5-5", "--effort", "medium", "--name", "Logic CTO",
    "--remote-control", "Logic CTO", "--messaging-socket-path", "/state/cc-session.sock", "--permission-mode", "bypassPermissions", "--mcp-config", "/x/canonical-mcp.json"];

  /** A canonical CTO of Logic Pro's shape: its claude is the tmux pane's own process, bound at generation 3. */
  const canonicalWorld = (): World => {
    const cwd = realpathSync(tempDir("acp-cto-refresh-"));
    const config = tempDir("acp-cto-refresh-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    const w = makeWorld({ kind: "canonical", resident: null, generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd },
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: cwd }] }, { ACP_OPERATOR_TOKEN: "operator-test-credential", CLAUDE_CONFIG_DIR: config });
    w.procs = [{ pid: CLAUDE, ppid: 1, command: OLD_ARGV.join(" "), argv: OLD_ARGV }];
    w.panes = new Map([[CLAUDE, "logic-claude-handoff"]]);
    w.tmux = new Set(["logic-claude-handoff"]);
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    return w;
  };
  const claudes = (w: World): FakeProcess[] => w.procs.filter((p) => /claude/.test(p.command));
  const at = (w: World, change: string | RegExp): number => w.changes.findIndex((c) => (typeof change === "string" ? c === change : change.test(c)));
  const launcherScript = (w: World): string => w.files.get(LAUNCHER) ?? "";

  it("is a dry run by default and changes nothing", async () => {
    const w = canonicalWorld();
    expect(await runCtoCommand(["refresh", P], w.ports)).toBe(0);
    expect(w.out[0]).toMatchObject({ command: "refresh", mode: "dry-run", steps: REFRESH_STEPS });
    expect(last(w)).toMatchObject({ result: "dry-run" });
    expect(w.changes).toEqual([]);
    expect(w.rotation.calls).toEqual([]);
  });

  it("records the switchover, stops the old process and proves it gone, then starts the new conversation with the handoff as its first prompt", async () => {
    const w = canonicalWorld();
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual(REFRESH_STEPS);
    expect(last(w)).toEqual({ result: "done" });
    // The daemon is asked for the role's state, then to record the switchover; nothing is cancelled.
    expect(w.rotation.calls).toEqual(["canonicalCto.status", "canonicalCto.rotate"]);
    const [rotated] = w.rotation.rotated;
    // The ONE-CTO ORDER: switchover recorded, old process signalled, the entry names the new conversation, then the new one starts.
    const order = [at(w, "operator canonicalCto.rotate"), at(w, `SIGTERM ${CLAUDE}`), at(w, /mcp add --scope local acp-cto/), at(w, /^tmux new-(session|window)/)];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The old process had provably gone from the kernel's table when the new one started.
    expect(w.launchLog).toEqual([{ conversation: rotated!.to, alive: [] }]);
    // The new conversation: a new session id (not the old one), the old one's name, remote-control name, socket, model, effort and permission mode.
    const script = launcherScript(w);
    expect(script).toContain(`'--session-id' '${rotated!.to}'`);
    expect(script).not.toContain(`'--resume'`);
    for (const pair of [["--name", "Logic CTO"], ["--remote-control", "Logic CTO"], ["--messaging-socket-path", "/state/cc-session.sock"],
      ["--model", "claude-opus-5-5"], ["--effort", "medium"], ["--permission-mode", "bypassPermissions"]]) {
      expect(script).toContain(`'${pair[0]}' '${pair[1]}'`);
    }
    expect(script).toContain("server:acp-buzz-channel");
    // The same tmux session (the pane's process ended with the old claude, so tmux makes it again under its name).
    expect(w.changes.some((c) => c.startsWith("tmux new-session -d -s logic-claude-handoff "))).toBe(true);
    // The role: the new conversation at the next generation, and exactly one CTO process.
    expect(w.record).toMatchObject({ conversation: rotated!.to, generation: 4 });
    expect(claudes(w)).toHaveLength(1);
    expect(w.files.has(INFLIGHT)).toBe(false);
    expect(w.changes).toContain(`${LOCAL_CLAUDE} mcp add --scope local acp-cto -- ${STATE}/current/dist/bin/node ${STATE}/current/dist/cli/agentctl.js attach canonical-cto --claimed-session-id ${rotated!.to} --project-id ${P} --expected-binding-generation auto`);
  });

  it("uses the handoff the CTO wrote for this generation as the first prompt, and the daemon's package", async () => {
    const w = canonicalWorld();
    const written = writeHandoff(w.ports.files, STATE, { projectId: P, generation: 3, conversation: CONVERSATION, source: "cto", text: "CTO HANDOFF: finish the sort fixture, then ask the CEO about CI", now: "2026-11-17T11:00:00.000Z" });
    expect(written.ok).toBe(true);
    w.changes.length = 0;
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(0);
    expect(results(w).find(([step]) => step === "handoff")).toEqual(["handoff", "skipped"]);
    expect(w.rotation.rotated[0]!.handoff).toMatchObject({ projectStatus: "CTO HANDOFF: finish the sort fixture, then ask the CEO about CI" });
    const script = launcherScript(w);
    expect(script).toContain("CTO HANDOFF: finish the sort fixture, then ask the CEO about CI");
    // The prompt is the last argument of the exec line (the recorded plan above it names it too).
    expect(script.lastIndexOf("--- handoff ---")).toBeGreaterThan(script.lastIndexOf("'--permission-mode'"));
    // The stored handoff is the CTO's, untouched.
    expect(JSON.parse(w.files.get(HANDOFF_FILE)!)).toMatchObject({ source: "cto", generation: 3 });
  });

  it("writes the handoff from ACP's records when the CTO wrote none: open runs and the newest queued messages, within 2 KB", async () => {
    const w = canonicalWorld();
    w.facts = { openRuns: [{ runId: "run_77", state: "READY_FOR_CEO_REVIEW", kind: "STANDARD_WORK" }],
      queued: [{ messageId: "msg_1", kind: "PEER_MESSAGE", status: "PENDING", createdAt: "2026-11-17T11:59:00.000Z", text: "please look at the red CI" }] };
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(0);
    expect(w.out.find((l) => l["step"] === "handoff" && l["result"] === "done")!["detail"]).toEqual({ source: "acp" });
    const stored = JSON.parse(w.files.get(HANDOFF_FILE)!) as { source: string; text: string };
    expect(stored.source).toBe("acp");
    expect(stored.text).toContain("run_77");
    expect(stored.text).toContain("msg_1");
    expect(stored.text).toContain("please look at the red CI");
    expect(Buffer.byteLength(stored.text, "utf8")).toBeLessThanOrEqual(2048);
    expect(launcherScript(w)).toContain("run_77");
  });

  it("fails after the stop (the new conversation cannot start): cancels the switchover and resumes the OLD conversation with --resume", async () => {
    const w = canonicalWorld();
    w.tmuxStartFails = 1;
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["switch", "failed"]);
    expect(JSON.stringify(w.out)).toContain("failed at launch");
    expect(JSON.stringify(w.out)).toContain(`the old conversation ${CONVERSATION} was resumed`);
    expect(w.out.some((l) => l["step"] === "switch" && l["phase"] === "rolled-back")).toBe(true);
    // The order: switchover, old stopped, switchover cancelled, old resumed.
    const order = [at(w, "operator canonicalCto.rotate"), at(w, `SIGTERM ${CLAUDE}`), at(w, "operator canonicalCto.cancel"), at(w, /^tmux new-(session|window)/)];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The old conversation, resumed (--resume), holds the role again at the next generation; one process; nothing pending.
    expect(w.launchLog).toEqual([{ conversation: CONVERSATION, alive: [] }]);
    expect(launcherScript(w)).toContain(`'--resume' '${CONVERSATION}'`);
    expect(w.record).toMatchObject({ conversation: CONVERSATION, generation: 4 });
    expect(claudes(w)).toHaveLength(1);
    expect(w.rotation.pending).toBeNull();
    expect(w.files.has(INFLIGHT)).toBe(false);
    expect(w.changes.filter((c) => /^tmux new-/.test(c))).toHaveLength(1);
    expect(w.changes.some((c) => c.includes(`mcp add --scope local acp-cto -- ${STATE}/current/dist/bin/node ${STATE}/current/dist/cli/agentctl.js attach canonical-cto --claimed-session-id ${CONVERSATION} `))).toBe(true);
  });

  it("a new conversation that starts but never claims is stopped and proven gone before the old one is resumed", async () => {
    const w = canonicalWorld();
    w.claimQueue = [false, true];
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(JSON.stringify(w.out)).toContain("failed at claim");
    const newPid = 30000;
    const order = [at(w, `SIGTERM ${CLAUDE}`), at(w, /^tmux new-/), at(w, `SIGTERM ${newPid}`), at(w, "operator canonicalCto.cancel")];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const second = w.changes.findIndex((c, i) => i > order[1]! && /^tmux new-/.test(c));
    expect(second).toBeGreaterThan(order[3]!);
    // Two launches; neither started while another claude of the role ran.
    expect(w.launchLog.map((l) => l.alive)).toEqual([[], []]);
    expect(w.launchLog[1]!.conversation).toBe(CONVERSATION);
    expect(w.record).toMatchObject({ conversation: CONVERSATION, generation: 4 });
    expect(claudes(w).map((p) => p.pid)).toEqual([30001]);
  });

  it("leaves the old conversation running, and only cancels the switchover, when its stop is not proven", async () => {
    const w = canonicalWorld();
    w.survivesSigterm.add(CLAUDE);
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(JSON.stringify(w.out)).toContain("failed at stop");
    expect(JSON.stringify(w.out)).toContain("still runs, and the switchover was cancelled");
    expect(w.rotation.calls).toEqual(["canonicalCto.status", "canonicalCto.rotate", "canonicalCto.cancel"]);
    expect(w.changes.some((c) => /^tmux new-/.test(c))).toBe(false);
    expect(w.launchLog).toEqual([]);
    expect(claudes(w).map((p) => p.pid)).toEqual([CLAUDE]);
    expect(w.rotation.pending).toBeNull();
  });

  it("keeps what it needs to finish undoing when the daemon will not cancel, and the next run does", async () => {
    const w = canonicalWorld();
    w.tmuxStartFails = 1;
    w.rotation.cancelRefuses = true;
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(JSON.stringify(w.out)).toContain("refused to cancel the switchover");
    // The old conversation was not started over a switchover that still fences it; the record of what to undo stays.
    expect(w.launchLog).toEqual([]);
    expect(w.files.has(INFLIGHT)).toBe(true);
    expect(claudes(w)).toHaveLength(0);

    w.out.length = 0; w.changes.length = 0;
    w.rotation.cancelRefuses = false;
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["recover", "failed"]]);
    expect(JSON.stringify(w.out)).toContain("an earlier refresh was interrupted");
    expect(JSON.stringify(w.out)).toContain(`the old conversation ${CONVERSATION} was resumed`);
    expect(w.record).toMatchObject({ conversation: CONVERSATION, generation: 4 });
    expect(w.files.has(INFLIGHT)).toBe(false);
    expect(claudes(w)).toHaveLength(1);
  });

  it("stops before anything when the daemon refuses the switchover, or the CTO still owns a live run", async () => {
    const refused = canonicalWorld();
    refused.rotation.refuses = true;
    expect(await runCtoCommand(["refresh", P, "--apply"], refused.ports)).toBe(1);
    expect(results(refused).at(-1)).toEqual(["switch", "failed"]);
    expect(refused.changes.filter((c) => c.startsWith("SIGTERM") || /^tmux new-/.test(c))).toEqual([]);
    expect(refused.files.has(INFLIGHT)).toBe(false);

    const busy = canonicalWorld();
    busy.rotation.liveRuns = ["run_9"];
    expect(await runCtoCommand(["refresh", P, "--apply"], busy.ports)).toBe(1);
    expect(JSON.stringify(busy.out)).toContain("still owns live runs (run_9)");
    expect(busy.rotation.calls).toEqual(["canonicalCto.status"]);
    expect(busy.changes.filter((c) => !c.startsWith("replace"))).toEqual([]);
  });

  it("does not refresh a CTO that is mid-turn", async () => {
    const w = canonicalWorld();
    const transcript = [...w.mtimes.keys()].find((k) => k.endsWith(`${CONVERSATION}.jsonl`) && k.includes("acp-cto-refresh"))!;
    w.mtimes.set(transcript, NOW - 5_000);
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["recover", "skipped"], ["self", "done"], ["idle", "failed"]]);
    expect(w.rotation.calls).toEqual([]);
    expect(w.changes).toEqual([]);
  });

  it("never replaces the session that is running it", async () => {
    const w = canonicalWorld();
    // This command's own pid is a descendant of the CTO's claude (a tool call it made).
    w.procs.push({ pid: 777, ppid: 700, command: "node agentctl.js cto refresh" }, { pid: 700, ppid: CLAUDE, command: "/bin/zsh -c agentctl" });
    w.ports = { ...w.ports, selfPid: 777 };
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["self", "failed"]);
    expect(JSON.stringify(w.out)).toContain("never replaces the session that is running it");
    expect(w.changes).toEqual([]);
    expect(w.rotation.calls).toEqual([]);
  });

  it("works for a resident CTO the provisioner started: its tmux session is kept and its own entry keeps its shape", async () => {
    const cwd = realpathSync(tempDir("acp-cto-refresh-resident-"));
    const config = tempDir("acp-cto-refresh-resident-config-");
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    const w = makeWorld({ generation: 3, session: { pid: CLAUDE, startedAt: `start-${CLAUDE}`, workdir: cwd },
      resident: { status: "COMPLETE", allocation: { projectId: P, sessionUuid: CONVERSATION, clonePath: cwd, roomId: ROOM } } },
    { ACP_OPERATOR_TOKEN: "operator-test-credential", CLAUDE_CONFIG_DIR: config });
    const argv = [LOCAL_CLAUDE, "--model", "opus", "--dangerously-load-development-channels", "server:acp-buzz-channel", "--resume", CONVERSATION,
      "--name", "e2e CTO", "--remote-control", "e2e CTO", "--messaging-socket-path", `${STATE}/cc.sock`, "--permission-mode", "bypassPermissions"];
    w.procs = [{ pid: 100, ppid: 1, command: "/bin/sh /state/resident-e2e-sort-fixture.sh" }, { pid: CLAUDE, ppid: 100, command: argv.join(" "), argv }];
    w.files.set(`${HOME}/.claude.json`, JSON.stringify({ projects: { [cwd]: { mcpServers: { "acp-cto": { command: `${STATE}/current/dist/bin/node`,
      args: [`${STATE}/current/dist/cli/agentctl.js`, "attach", "resident-cto", "--claimed-session-id", CONVERSATION, "--project-id", P] } } } } }));
    const transcript = `${HOME}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${CONVERSATION}.jsonl`;
    w.files.set(transcript, "{}");
    w.mtimes.set(transcript, NOW - (IDLE_SECONDS + 60) * 1000);
    w.tmux = new Set([TMUX]);
    w.panes = new Map([[100, TMUX]]);
    expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(0);
    const to = w.rotation.rotated[0]!.to;
    expect(w.record).toMatchObject({ conversation: to, generation: 4 });
    // Its tmux session is the resident's; the new conversation starts in it, named as before.
    expect(w.changes.some((c) => c.startsWith(`tmux new-window -d -P -F #{pane_id} -t =${TMUX}: `))).toBe(true);
    expect(launcherScript(w)).toContain(`'--session-id' '${to}'`);
    expect(launcherScript(w)).toContain("'--name' 'e2e CTO'");
    // The resident's entry keeps its `attach resident-cto` shape; only the conversation it claims changes.
    expect(w.changes).toContain(`${LOCAL_CLAUDE} mcp add --scope local acp-cto -- ${STATE}/current/dist/bin/node ${STATE}/current/dist/cli/agentctl.js attach resident-cto --claimed-session-id ${to} --project-id ${P}`);
    expect(w.launchLog).toEqual([{ conversation: to, alive: [] }]);
  });

  describe("a throw, or a lost answer, after the switchover is recorded", () => {
    const expectRolledBack = (w: World): void => {
      // The old conversation, resumed, holds the role at the next generation; the switchover is cancelled; one process; nothing left on record.
      expect(w.rotation.calls).toContain("canonicalCto.cancel");
      expect(w.rotation.pending).toBeNull();
      expect(w.record).toMatchObject({ conversation: CONVERSATION, generation: 4 });
      expect(claudes(w)).toHaveLength(1);
      expect(w.files.has(INFLIGHT)).toBe(false);
    };

    it("a one-time EIO writing the new conversation's launcher takes the way back: stops what is left, cancels, resumes the old conversation", async () => {
      const w = canonicalWorld();
      w.replaceFailures = [/cto-launch-.*\.sh$/];
      expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
      expect(results(w).at(-1)).toEqual(["switch", "failed"]);
      expect(JSON.stringify(w.out)).toContain("failed at launch (threw: EIO");
      expect(JSON.stringify(w.out)).toContain(`the old conversation ${CONVERSATION} was resumed`);
      const order = [at(w, "operator canonicalCto.rotate"), at(w, `SIGTERM ${CLAUDE}`), at(w, "operator canonicalCto.cancel"), at(w, /^tmux new-(session|window)/)];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(w.launchLog).toEqual([{ conversation: CONVERSATION, alive: [] }]);
      expectRolledBack(w);
    });

    it("a throw while stopping leaves the old conversation running and only lifts the fence", async () => {
      const w = canonicalWorld();
      w.ports = { ...w.ports, signal: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } };
      expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
      expect(JSON.stringify(w.out)).toContain("failed at stop (threw: EPERM");
      expect(w.rotation.calls).toEqual(["canonicalCto.status", "canonicalCto.rotate", "canonicalCto.cancel"]);
      expect(w.rotation.pending).toBeNull();
      expect(claudes(w).map((p) => p.pid)).toEqual([CLAUDE]);
      expect(w.changes.some((c) => /^tmux new-/.test(c))).toBe(false);
      expect(w.files.has(INFLIGHT)).toBe(false);
    });

    it("a way back that itself throws is reported, keeps the record, and `refresh --recover` finishes it", async () => {
      const w = canonicalWorld();
      // The new launcher cannot be written, and neither can the old one's, the one time each is tried.
      w.replaceFailures = [/cto-launch-.*\.sh$/, /cto-launch-.*\.sh$/];
      expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
      expect(JSON.stringify(w.out)).toContain("the rollback itself threw (EIO");
      expect(w.out.some((l) => l["step"] === "switch" && l["phase"] === "rolling-back")).toBe(true);
      expect(w.files.has(INFLIGHT)).toBe(true);
      expect(claudes(w)).toHaveLength(0);

      w.out.length = 0; w.changes.length = 0; w.rotation.calls.length = 0;
      expect(await runCtoCommand(["refresh", P, "--recover", "--apply"], w.ports)).toBe(0);
      expect(results(w)).toEqual([["self", "done"], ["recover", "done"]]);
      expect(last(w)).toEqual({ result: "done" });
      // Recovery undoes; it starts no new refresh.
      expect(w.rotation.calls).not.toContain("canonicalCto.rotate");
      expect(w.rotation.rotated).toHaveLength(1);
      expectRolledBack(w);
    });

    it("a rotate whose answer is lost after the daemon recorded it is read back from the daemon, and the refresh goes on", async () => {
      const w = canonicalWorld();
      w.rotation.lostResponse = true;
      expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(0);
      expect(w.out.find((l) => l["step"] === "switch" && l["phase"] === "rotated")).toMatchObject({ confirmedByReadBack: true });
      expect(w.rotation.calls).toEqual(["canonicalCto.status", "canonicalCto.rotate", "canonicalCto.status"]);
      expect(w.record).toMatchObject({ conversation: w.rotation.rotated[0]!.to, generation: 4 });
      expect(claudes(w)).toHaveLength(1);
      expect(w.files.has(INFLIGHT)).toBe(false);
    });

    it("a rotate whose outcome cannot be read back keeps its record, stops nothing, and the next run reconciles it with the daemon", async () => {
      const w = canonicalWorld();
      w.rotation.lostResponse = true;
      // The first status (before the rotate) answers; the read-back after the lost answer does not.
      w.rotation.failStatusAt = [2];
      expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
      expect(JSON.stringify(w.out)).toContain("cannot say whether it recorded the switchover");
      expect(w.files.has(INFLIGHT)).toBe(true);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM") || /^tmux new-/.test(c))).toEqual([]);
      // The daemon did record it: the old holder drains, the switchover is pending, and nothing has said so.
      expect(w.rotation.pending).not.toBeNull();
      expect(claudes(w).map((p) => p.pid)).toEqual([CLAUDE]);

      // Another refresh's process that still runs is left alone.
      const record = JSON.parse(w.files.get(INFLIGHT)!) as Record<string, unknown>;
      w.files.set(INFLIGHT, JSON.stringify({ ...record, refresher: { pid: 4242, startedAt: "start-4242" } }));
      w.procs.push({ pid: 4242, ppid: 1, command: "/node agentctl.js cto refresh" });
      w.out.length = 0; w.changes.length = 0;
      expect(await runCtoCommand(["refresh", P, "--recover", "--apply"], w.ports)).toBe(1);
      expect(JSON.stringify(w.out)).toContain("another refresh of this project is running (pid 4242)");
      expect(w.rotation.pending).not.toBeNull();

      // Once it is gone, the record is reconciled: the daemon holds the switchover, so it is cancelled and the old conversation, still running, continues.
      w.procs = w.procs.filter((p) => p.pid !== 4242);
      w.out.length = 0;
      expect(await runCtoCommand(["refresh", P, "--recover", "--apply"], w.ports)).toBe(0);
      expect(w.rotation.calls.at(-1)).toBe("canonicalCto.cancel");
      expect(w.rotation.pending).toBeNull();
      expect(w.files.has(INFLIGHT)).toBe(false);
      expect(claudes(w).map((p) => p.pid)).toEqual([CLAUDE]);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM") || /^tmux new-/.test(c))).toEqual([]);
    });

    it("a refusal the daemon's records confirm as no switchover ends it with nothing stopped, and the record is cleared", async () => {
      const w = canonicalWorld();
      w.rotation.refuses = true;
      expect(await runCtoCommand(["refresh", P, "--apply"], w.ports)).toBe(1);
      expect(JSON.stringify(w.out)).toContain("the daemon holds no switchover to ");
      expect(w.files.has(INFLIGHT)).toBe(false);
      expect(w.rotation.calls).toEqual(["canonicalCto.status", "canonicalCto.rotate", "canonicalCto.status"]);
      expect(w.changes.filter((c) => c.startsWith("SIGTERM") || /^tmux new-/.test(c))).toEqual([]);
    });
  });

  it("is listed in the usage and takes only --apply", async () => {
    const w = canonicalWorld();
    expect(await runCtoCommand(["refresh", P, "--handoff", "/h.json"], w.ports)).toBe(2);
    expect(await runCtoCommand(["refresh"], w.ports)).toBe(2);
    expect(CTO_SUBCOMMANDS).toContain("refresh");
    expect(CTO_USAGE).toContain("agentctl cto refresh <project> [--recover] [--apply]");
  });
});
