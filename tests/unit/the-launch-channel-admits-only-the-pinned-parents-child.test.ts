import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type * as PeercredModule from "../../src/core/peercred.ts";
import type * as ProcessArgvModule from "../../src/core/process-argv.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import type { SessionLaunchCredential, SessionLaunchPin } from "../../src/cto/cto-lifecycle.ts";
import { startSessionLaunchChannel, type LocalSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { SessionTurnRequest, SessionTurnResult } from "../../src/runtime/provider.ts";
import { BOOTSTRAP_FIXTURE_TOKEN, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * Packet O4 slice B — the launch channel hands a driven turn's credential only to the shape the real
 * adapter produces: the holder the daemon spawned and pinned → the CLI the holder runs → this socket's
 * kernel peer. The CLI between them is not pinned: any child of the holder's child passes. Same-user
 * trust in the turn's own process tree, nothing more.
 *
 * Process trees here are real: a holder that waits for "go", then its children, then a leaf that asks
 * the real launch socket and prints what came back. Pins are real pids and the start tokens the kernel
 * reports for them. Only the start-token reader and the kernel peer read are wrapped, to make a read fail
 * or to act in the middle of an admission.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-o4b-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

const hooks = vi.hoisted(() => ({
  /** Pids whose start token reads as unavailable, as a permission or native error makes it. */
  unreadableTokens: new Set<number>(),
  /** Runs on every start-token read: an admission reads the holder's while it decides. */
  onTokenRead: null as ((pid: number) => void) | null,
  /** The kernel peer read fails. */
  peerUnreadable: false,
  /** Replaces a start token as the kernel reports it: a pid reused between two reads. */
  tokenFor: null as ((pid: number, actual: string | null) => string | null) | null,
  /** Replaces the n-th kernel peer read (1-based, counted while set): a pid reused, a read that fails. */
  peerAnswer: null as ((call: number, actual: PeerAnswer) => PeerAnswer) | null,
  peerCalls: 0,
}));
type PeerAnswer = ReturnType<typeof PeercredModule.getPeerCredentials>;
vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessArgvModule>();
  return {
    ...actual,
    readProcessStartToken: (pid: number): string | null => {
      hooks.onTokenRead?.(pid);
      const read = hooks.unreadableTokens.has(pid) ? null : actual.readProcessStartToken(pid);
      return hooks.tokenFor ? hooks.tokenFor(pid, read) : read;
    },
  };
});
vi.mock("../../src/core/peercred.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PeercredModule>();
  return {
    ...actual,
    getPeerCredentials: (fd: number): PeerAnswer => {
      if (hooks.peerUnreadable) return null;
      const read = actual.getPeerCredentials(fd);
      if (!hooks.peerAnswer) return read;
      hooks.peerCalls += 1;
      return hooks.peerAnswer(hooks.peerCalls, read);
    },
  };
});

const live: ChildProcess[] = [];
/** Process groups a test leaves running (an idle turn tree), ended after it. */
const groups: number[] = [];
afterEach(() => {
  hooks.unreadableTokens.clear();
  hooks.onTokenRead = null;
  hooks.peerUnreadable = false;
  hooks.tokenFor = null;
  hooks.peerAnswer = null;
  hooks.peerCalls = 0;
  for (const child of live.splice(0)) child.kill("SIGKILL");
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      /* the group already ended */
    }
  }
});
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const TOKEN = "o4b-mcp-token";
const REFUSED = "SESSION_LAUNCH_CREDENTIAL_REFUSED";

interface LaunchReply {
  ok?: boolean;
  sessionId?: string;
  sessionSecret?: string;
  reasonCode?: string;
}

/** One request on the launch socket from this test process: a same-uid peer that is nobody's child here. */
const claimFromHere = (socketPath: string, externalSessionId: string): Promise<LaunchReply> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ externalSessionId })}\n`));
    socket.on("data", (chunk: string) => (received += chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(JSON.parse(received.trim()) as LaunchReply));
  });

/**
 * `tree.cjs wait|run <depth> <socket> <externalSessionId> <fanout>`: depth 0 asks the socket and prints
 * `{pid, ppid, reply}`; depth n starts one child at depth n-1 (`fanout` of them at depth 1) and stays alive
 * until they exit. `wait` holds the spawn until a line arrives on stdin, so the holder can be pinned first.
 */
const treeScript = (): string => {
  const path = join(tempDir("acp-o4b-tree-"), "tree.cjs");
  writeFileSync(path, `
const { spawn } = require("node:child_process");
const net = require("node:net");
const [mode, depthArg, socketPath, externalSessionId, fanoutArg] = process.argv.slice(2);
const depth = Number(depthArg);
const fanout = Number(fanoutArg);
const leaf = () => {
  const socket = net.createConnection(socketPath);
  let received = "";
  let done = false;
  const report = () => {
    if (done) return;
    done = true;
    const line = received.trim();
    process.stdout.write(JSON.stringify({ pid: process.pid, ppid: process.ppid, reply: line ? JSON.parse(line) : null }) + "\\n", () => process.exit(0));
  };
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write(JSON.stringify({ externalSessionId }) + "\\n"));
  socket.on("data", (chunk) => { received += chunk; });
  socket.once("close", report);
  socket.once("error", report);
};
const branch = () => {
  const count = depth === 1 ? fanout : 1;
  let open = count;
  for (let i = 0; i < count; i += 1) {
    const child = spawn(process.execPath, [__filename, "run", String(depth - 1), socketPath, externalSessionId, String(fanout)], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", () => { open -= 1; if (open === 0) process.exit(0); });
  }
};
const start = () => (depth === 0 ? leaf() : branch());
if (mode === "wait") { process.stdin.setEncoding("utf8"); process.stdin.once("data", start); } else start();
`);
  return path;
};

interface LeafReport {
  pid: number;
  ppid: number;
  reply: LaunchReply | null;
}

interface Tree {
  /** The top process: the one a pin names when the tree is the turn's own. */
  pid: number;
  /** Starts the children and answers what every leaf got back. */
  go(): Promise<LeafReport[]>;
}

const startTree = (script: string, depth: number, socketPath: string, externalSessionId: string, fanout = 1): Tree => {
  const holder = spawn(process.execPath, [script, "wait", String(depth), socketPath, externalSessionId, String(fanout)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  live.push(holder);
  let out = "";
  holder.stdout!.setEncoding("utf8");
  holder.stdout!.on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  return {
    pid: holder.pid!,
    go: async () => {
      holder.stdin!.write("go\n");
      await exited;
      return out.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as LeafReport);
    },
  };
};

/** An unrelated live process, for a pin that names someone else. */
const idleProcess = (): number => {
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  live.push(idle);
  return idle.pid!;
};

/** One line of a child's stdout, parsed. */
const firstLine = <T>(child: ChildProcess): Promise<T> =>
  new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      const boundary = out.indexOf("\n");
      if (boundary !== -1) resolve(JSON.parse(out.slice(0, boundary)) as T);
    });
    // `close`, not `exit`: a child that handed its stdout on (the outsider's sender) outlives it.
    child.once("close", () => {
      if (!out.includes("\n")) reject(new Error("the child wrote no line"));
    });
  });

/** A turn tree whose leaf stays alive and never asks: holder → its child → leaf, in the holder's own group. */
const idleTurnTree = async (): Promise<{ holder: number; leaf: number }> => {
  const leaf = `process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n"); setInterval(() => {}, 1000);`;
  const level = (inner: string) =>
    `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { stdio: ["ignore", "inherit", "ignore"] });` +
    `c.on("exit", () => process.exit(0));`;
  const holder = spawn(process.execPath, ["-e", level(level(leaf))], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  groups.push(holder.pid!);
  const { pid } = await firstLine<{ pid: number }>(holder);
  return { holder: holder.pid!, leaf: pid };
};

/**
 * A same-uid outsider that connects, hands its connected socket to a child, and exits; the child, once
 * the connector is gone, sends the request on that socket and reports what came back.
 */
const outsiderPassingItsSocket = async (socketPath: string, externalSessionId: string) => {
  const sender = `
const net = require("node:net");
const [connector, externalSessionId] = process.argv.slice(1);
const gone = () => { try { process.kill(Number(connector), 0); return false; } catch { return true; } };
const ask = () => {
  const socket = new net.Socket({ fd: 3, readable: true, writable: true });
  let received = ""; let done = false;
  const report = () => { if (done) return; done = true; const line = received.trim(); process.stdout.write(JSON.stringify({ sender: process.pid, reply: line ? JSON.parse(line) : null }) + "\\n", () => process.exit(0)); };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { received += chunk; });
  socket.once("close", report);
  socket.once("error", report);
  socket.write(JSON.stringify({ externalSessionId }) + "\\n");
};
const wait = () => (gone() ? ask() : setTimeout(wait, 20));
wait();
`;
  const connector = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const [socketPath, externalSessionId] = process.argv.slice(1);
const socket = net.createConnection(socketPath);
socket.once("connect", () => {
  spawn(process.execPath, ["-e", ${JSON.stringify(sender)}, String(process.pid), externalSessionId], { stdio: ["ignore", "inherit", "ignore", socket._handle.fd] });
  process.exit(0);
});
`;
  const child = spawn(process.execPath, ["-e", connector, socketPath, externalSessionId], { stdio: ["ignore", "pipe", "ignore"] });
  live.push(child);
  const report = await firstLine<{ sender: number; reply: LaunchReply | null }>(child);
  return { connector: child.pid!, ...report };
};

/**
 * A connector that is gone before the daemon accepts: this test process's event loop is held (the whole
 * outsider runs under `spawnSync`) while the connector connects, hands its socket to a holder and exits.
 * The holder, alone on the socket, sends the request once the daemon runs again and writes what came back
 * to a file.
 */
const connectorGoneBeforeAccept = async (socketPath: string, externalSessionId: string) => {
  const result = join(tempDir("acp-o4b-gone-"), "reply.json");
  const holder = `
const net = require("node:net");
const fs = require("node:fs");
const [result, externalSessionId] = process.argv.slice(1);
setTimeout(() => {
  const socket = new net.Socket({ fd: 3, readable: true, writable: true });
  let received = ""; let done = false;
  const report = () => { if (done) return; done = true; const line = received.trim(); fs.writeFileSync(result, JSON.stringify({ sender: process.pid, reply: line ? JSON.parse(line) : null })); process.exit(0); };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { received += chunk; });
  socket.once("close", report);
  socket.once("error", report);
  socket.write(JSON.stringify({ externalSessionId }) + "\\n");
}, 500);
`;
  const connector = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const [socketPath, externalSessionId, result] = process.argv.slice(1);
const socket = net.createConnection(socketPath);
socket.once("connect", () => {
  const held = spawn(process.execPath, ["-e", ${JSON.stringify(holder)}, result, externalSessionId], { stdio: ["ignore", "ignore", "ignore", socket._handle.fd], detached: true });
  held.unref();
  process.stdout.write(String(process.pid) + "\\n", () => process.exit(0));
});
`;
  const outsider = `
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", ${JSON.stringify(connector)}, ...process.argv.slice(1)], { stdio: ["ignore", "pipe", "ignore"] });
let out = ""; c.stdout.on("data", (chunk) => { out += chunk; });
c.on("close", () => { process.stdout.write(out); process.exit(0); });
`;
  const ran = spawnSync(process.execPath, ["-e", outsider, socketPath, externalSessionId, result], { encoding: "utf8", timeout: 20_000 });
  const connectorPid = Number(ran.stdout.trim());
  await vi.waitFor(() => expect(existsSync(result)).toBe(true), { timeout: 10_000, interval: 20 });
  const report = JSON.parse(readFileSync(result, "utf8")) as { sender: number; reply: LaunchReply | null };
  return { connector: connectorPid, ...report };
};

const pinOf = (pid: number): SessionLaunchPin => {
  const startToken = readProcessStartToken(pid);
  if (startToken === null) throw new Error(`no start token for ${pid}`);
  return { pid, startToken };
};

/** A channel the way the daemon composes it: the registry to verify an entry against, and the audit log. */
const world = async () => {
  const h = makeHarness();
  const launch: LocalSessionLaunchChannel = await startSessionLaunchChannel(tempDir("acp-o4b-launch-"), {
    mcpToken: TOKEN,
    sessions: h.cp.sessions,
    audit: h.cp.audit,
  });
  const script = treeScript();
  const session = (label: string) => {
    const created = h.cp.sessions.create({ provider: "scripted", model: label });
    h.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "o4b fixture");
    return created;
  };
  const credentialOf = (created: ReturnType<typeof session>, secret = created.sessionSecret!): SessionLaunchCredential => ({
    sessionId: created.sessionId,
    sessionIncarnation: created.incarnation,
    externalSessionId: `o4b-${randomUUID()}`,
    sessionSecret: secret,
  });
  /** A driven turn's entry, offered as the runtime offers it and pinned after, as its spawn pins it. */
  const offerDriven = async (credential: SessionLaunchCredential, pin: SessionLaunchPin | null) => {
    const offered = await launch.provision(credential);
    if (!offered.allowed) throw new Error(offered.message);
    if (pin !== null) credential.pin = pin;
  };
  const refusals = (): unknown[] => h.cp.audit.byKind(REFUSED).map((event) => event.evidence["refusal"]);
  /** No audit row anywhere carries the plaintext. */
  const auditNeverHolds = (secret: string): void => {
    const rows = h.cp.db.all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events`);
    expect(rows.some((row) => row.evidence_json.includes(secret))).toBe(false);
  };
  return {
    h, launch, script, session, credentialOf, offerDriven, refusals, auditNeverHolds,
    tree: (depth: number, credential: SessionLaunchCredential, fanout = 1) =>
      startTree(script, depth, launch.socketPath, credential.externalSessionId, fanout),
    close: async () => {
      await launch.close();
      h.cp.close();
    },
  };
};

const handed = (reply: LaunchReply | null | undefined, credential: SessionLaunchCredential): boolean =>
  reply?.ok === true && reply.sessionSecret === credential.sessionSecret;

describe("O4 slice B — a driven entry goes only to the pinned holder's grandchild", () => {
  it("W2: a same-uid non-child presenting the session id is refused, the entry is kept, and the turn's relay then takes it", async () => {
    const w = await world();
    try {
      const credential = w.credentialOf(w.session("w2"));
      const turn = w.tree(2, credential);
      await w.offerDriven(credential, pinOf(turn.pid));

      const impostor = await claimFromHere(w.launch.socketPath, credential.externalSessionId);
      expect(handed(impostor, credential)).toBe(false);
      expect(impostor).toEqual({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      expect(w.refusals()).toEqual(["NOT_HOLDER_GRANDCHILD"]);

      const [relay] = await turn.go();
      expect(handed(relay!.reply, credential)).toBe(true);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(false);
      expect(w.refusals()).toEqual(["NOT_HOLDER_GRANDCHILD"]);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W3: a grandchild of a reused holder pid (same pid, another start token) is refused and the entry kept", async () => {
    const w = await world();
    try {
      const credential = w.credentialOf(w.session("w3"));
      const turn = w.tree(2, credential);
      await w.offerDriven(credential, { pid: turn.pid, startToken: "darwin-tv:1.000000" });
      const [relay] = await turn.go();
      expect(handed(relay!.reply, credential)).toBe(false);
      expect(w.refusals()).toEqual(["HOLDER_PID_REUSED"]);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-UNK: an unreadable live holder token, an unread pinned token, or another token format is refused and the entry kept", async () => {
    const w = await world();
    try {
      // The holder's live token cannot be read now (EPERM, a native error): refused, then admitted once readable.
      const credential = w.credentialOf(w.session("w-unk"));
      const first = w.tree(2, credential);
      await w.offerDriven(credential, pinOf(first.pid));
      hooks.unreadableTokens.add(first.pid);
      const [refused] = await first.go();
      expect(handed(refused!.reply, credential)).toBe(false);
      expect(w.refusals()).toEqual(["HOLDER_START_UNKNOWN"]);

      // The daemon could not read the token at spawn: the pin carries none.
      const unread = w.credentialOf(w.session("w-unk-unread"));
      const second = w.tree(2, unread);
      await w.offerDriven(unread, { pid: second.pid, startToken: null });
      const [unreadRelay] = await second.go();
      expect(handed(unreadRelay!.reply, unread)).toBe(false);

      // A pinned token in another format (ps lstart text) is not compared, it is unknown.
      const lstart = w.credentialOf(w.session("w-unk-format"));
      const third = w.tree(2, lstart);
      await w.offerDriven(lstart, { pid: third.pid, startToken: "Sun Nov  1 02:26:57 2026" });
      const [formatRelay] = await third.go();
      expect(handed(formatRelay!.reply, lstart)).toBe(false);

      expect(w.refusals()).toEqual(["HOLDER_START_UNKNOWN", "HOLDER_START_UNKNOWN", "HOLDER_START_UNKNOWN"]);
      for (const entry of [credential, unread, lstart]) {
        expect(w.launch.withdraw(entry.externalSessionId)).toBe(true);
        w.auditNeverHolds(entry.sessionSecret);
      }
    } finally {
      await w.close();
    }
  });

  it("W-GC: a grandchild under a wrong holder, a great-grandchild and a direct child of the holder are refused", async () => {
    const w = await world();
    try {
      // The right depth under a holder the pin does not name.
      const wrongHolder = w.credentialOf(w.session("w-gc-wrong"));
      const other = w.tree(2, wrongHolder);
      await w.offerDriven(wrongHolder, pinOf(idleProcess()));
      const [underOther] = await other.go();
      expect(handed(underOther!.reply, wrongHolder)).toBe(false);

      // One level deeper than the CLI's child, under the pinned holder.
      const deeper = w.credentialOf(w.session("w-gc-deeper"));
      const deep = w.tree(3, deeper);
      await w.offerDriven(deeper, pinOf(deep.pid));
      const [greatGrandchild] = await deep.go();
      expect(handed(greatGrandchild!.reply, deeper)).toBe(false);

      // One level shallower: the holder's own child.
      const shallower = w.credentialOf(w.session("w-gc-shallower"));
      const shallow = w.tree(1, shallower);
      await w.offerDriven(shallower, pinOf(shallow.pid));
      const [child] = await shallow.go();
      expect(handed(child!.reply, shallower)).toBe(false);

      expect(w.refusals()).toEqual(["NOT_HOLDER_GRANDCHILD", "NOT_HOLDER_GRANDCHILD", "NOT_HOLDER_GRANDCHILD"]);
      for (const entry of [wrongHolder, deeper, shallower]) expect(w.launch.withdraw(entry.externalSessionId)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("W-NOPIN-driven: a driven entry with no pin is refused and kept, even for the right shape", async () => {
    const w = await world();
    try {
      const credential = w.credentialOf(w.session("w-nopin"));
      const turn = w.tree(2, credential);
      await w.offerDriven(credential, null);
      const [relay] = await turn.go();
      expect(handed(relay!.reply, credential)).toBe(false);
      expect(w.refusals()).toEqual(["PIN_ABSENT"]);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-PEER: a connection whose kernel peer cannot be read is refused and the entry kept", async () => {
    const w = await world();
    try {
      const credential = w.credentialOf(w.session("w-peer"));
      const turn = w.tree(2, credential);
      await w.offerDriven(credential, pinOf(turn.pid));
      hooks.peerUnreadable = true;
      const [relay] = await turn.go();
      expect(handed(relay!.reply, credential)).toBe(false);
      expect(w.refusals()).toEqual(["PEER_UNREADABLE"]);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("W-OTHER: session X's valid lineage does not admit a request for session Y, nor a credential naming another incarnation", async () => {
    const w = await world();
    try {
      const x = w.credentialOf(w.session("w-other-x"));
      const y = w.credentialOf(w.session("w-other-y"));
      // X's turn tree, asking for Y's entry; Y's own entry is pinned to Y's own holder.
      const xTurn = startTree(w.script, 2, w.launch.socketPath, y.externalSessionId);
      await w.offerDriven(x, pinOf(xTurn.pid));
      await w.offerDriven(y, pinOf(idleProcess()));
      const [asksForY] = await xTurn.go();
      expect(handed(asksForY!.reply, y)).toBe(false);
      expect(w.launch.withdraw(y.externalSessionId)).toBe(true);
      expect(w.launch.withdraw(x.externalSessionId)).toBe(true);

      // An entry whose credential names an incarnation the session does not have.
      const created = w.session("w-other-incarnation");
      const stale = { ...w.credentialOf(created), sessionIncarnation: `${created.incarnation}-earlier` };
      const turn = w.tree(2, stale);
      await w.offerDriven(stale, pinOf(turn.pid));
      const [relay] = await turn.go();
      expect(handed(relay!.reply, stale)).toBe(false);
      expect(w.launch.withdraw(stale.externalSessionId)).toBe(true);
      expect(w.refusals()).toEqual(["NOT_HOLDER_GRANDCHILD", "CREDENTIAL_NOT_CURRENT"]);
    } finally {
      await w.close();
    }
  });

  it("W-OTHER: an entry withdrawn, or withdrawn and replaced, between admission and hand-over is not handed over", async () => {
    const w = await world();
    try {
      // Withdrawn while the admission reads the holder's start token.
      const withdrawn = w.credentialOf(w.session("w-other-withdrawn"));
      const first = w.tree(2, withdrawn);
      await w.offerDriven(withdrawn, pinOf(first.pid));
      hooks.onTokenRead = (pid) => {
        if (pid !== first.pid) return;
        hooks.onTokenRead = null;
        w.launch.withdraw(withdrawn.externalSessionId);
      };
      const [late] = await first.go();
      expect(handed(late!.reply, withdrawn)).toBe(false);
      expect(w.refusals()).toEqual(["ENTRY_REPLACED"]);

      // Withdrawn and offered again: the new entry is the one that stays, and it is taken by its own turn.
      const created = w.session("w-other-replaced");
      const original = w.credentialOf(created);
      const second = w.tree(2, original);
      await w.offerDriven(original, pinOf(second.pid));
      const replacement: SessionLaunchCredential = { ...original, pin: undefined };
      let reoffered: Promise<unknown> | null = null;
      hooks.onTokenRead = (pid) => {
        if (pid !== second.pid) return;
        hooks.onTokenRead = null;
        w.launch.withdraw(original.externalSessionId);
        reoffered = w.launch.provision(replacement);
      };
      const [raced] = await second.go();
      expect(reoffered).not.toBeNull();
      await reoffered;
      expect(handed(raced!.reply, original)).toBe(false);
      expect(w.refusals()).toEqual(["ENTRY_REPLACED", "ENTRY_REPLACED"]);
      const next = w.tree(2, replacement);
      replacement.pin = pinOf(next.pid);
      const [taken] = await next.go();
      expect(handed(taken!.reply, replacement)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("W-EPOCH: an entry from a previous credential epoch is never handed out or consumed", async () => {
    const w = await world();
    try {
      const created = w.session("w-epoch");
      const previous = w.credentialOf(created);
      const rotated = w.h.cp.sessions.rotateSecret(created.sessionId, 0);
      if (!rotated.allowed) throw new Error(rotated.message);

      // A driven entry holding epoch 0's secret, pinned to its own turn's holder.
      const turn = w.tree(2, previous);
      await w.offerDriven(previous, pinOf(turn.pid));
      const [relay] = await turn.go();
      expect(handed(relay!.reply, previous)).toBe(false);
      expect(w.launch.withdraw(previous.externalSessionId)).toBe(true);

      // An interactive spawn's entry holding it is refused as well.
      const interactive = { ...w.credentialOf(created), sessionSecret: previous.sessionSecret };
      const offered = await w.launch.interactiveSpawns.provision(interactive);
      if (!offered.allowed) throw new Error(offered.message);
      expect(handed(await claimFromHere(w.launch.socketPath, interactive.externalSessionId), interactive)).toBe(false);
      expect(w.launch.withdraw(interactive.externalSessionId)).toBe(true);
      expect(w.refusals()).toEqual(["CREDENTIAL_NOT_CURRENT", "CREDENTIAL_NOT_CURRENT"]);

      // Epoch 1's credential, offered for the next turn, is handed to that turn's relay.
      const current = { ...w.credentialOf(created), sessionSecret: rotated.value.sessionSecret };
      const next = w.tree(2, current);
      await w.offerDriven(current, pinOf(next.pid));
      const [nextRelay] = await next.go();
      expect(handed(nextRelay!.reply, current)).toBe(true);
      w.auditNeverHolds(previous.sessionSecret);
      w.auditNeverHolds(current.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-STALE (a): a connector that hands its socket to a child and exits is refused, even when its pid now names a valid grandchild", async () => {
    const w = await world();
    try {
      const turn = await idleTurnTree();
      const credential = w.credentialOf(w.session("w-stale"));
      await w.offerDriven(credential, pinOf(turn.holder));

      // As the kernel reports it: the connector at the connection, its child at the request.
      const real = await outsiderPassingItsSocket(w.launch.socketPath, credential.externalSessionId);
      expect(real.sender).not.toBe(real.connector);
      expect(handed(real.reply, credential)).toBe(false);
      // The kernel names the connector at the connection and the sender at the request. Were the daemon to
      // read the connection only after the sender wrote, it would name the sender at both, which is no
      // grandchild of the holder.
      expect(["PEER_CHANGED", "NOT_HOLDER_GRANDCHILD"]).toContain(w.refusals()[0]);

      // The connector's pid reused by a valid grandchild of the pinned holder: the connection-time read
      // names that grandchild; every later read is the kernel's own.
      hooks.peerAnswer = (call, actual) => (call === 1 && actual ? { ...actual, peerPid: turn.leaf, effectivePid: turn.leaf } : actual);
      const reused = await outsiderPassingItsSocket(w.launch.socketPath, credential.externalSessionId);
      expect(handed(reused.reply, credential)).toBe(false);
      expect(reused.reply).toEqual({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });

      expect(w.refusals()).toHaveLength(2);
      expect(w.refusals()[1]).toBe("PEER_CHANGED");
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-STALE (a): the admitted peer's start token or pid differing at hand-over is refused and the entry kept", async () => {
    const w = await world();
    try {
      // The peer's pid reused between admission and hand-over: its start token reads differently the second time.
      const byToken = w.credentialOf(w.session("w-stale-token"));
      const first = w.tree(2, byToken);
      await w.offerDriven(byToken, pinOf(first.pid));
      const seen = new Map<number, number>();
      hooks.tokenFor = (pid, actual) => {
        if (pid === first.pid) return actual;
        const reads = (seen.get(pid) ?? 0) + 1;
        seen.set(pid, reads);
        // The reads at accept and at admission see the admitted process; the read at hand-over sees another.
        return reads <= 2 ? actual : "darwin-tv:1.000001";
      };
      const [tokenRelay] = await first.go();
      expect(handed(tokenRelay!.reply, byToken)).toBe(false);
      hooks.tokenFor = null;

      // The fresh kernel read at hand-over names another pid.
      const byPid = w.credentialOf(w.session("w-stale-pid"));
      const second = w.tree(2, byPid);
      await w.offerDriven(byPid, pinOf(second.pid));
      hooks.peerAnswer = (call, actual) => (call === 3 && actual ? { ...actual, peerPid: actual.peerPid + 1, effectivePid: actual.peerPid + 1 } : actual);
      const [pidRelay] = await second.go();
      expect(handed(pidRelay!.reply, byPid)).toBe(false);

      expect(w.refusals()).toEqual(["PEER_CHANGED", "PEER_CHANGED"]);
      expect(w.h.cp.audit.byKind(REFUSED).map((event) => event.evidence["stage"])).toEqual(["hand-over", "hand-over"]);
      for (const entry of [byToken, byPid]) expect(w.launch.withdraw(entry.externalSessionId)).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("W-REUSED (review o4b2): a pid reused after accept, named by every peer read, is refused against the token bound at accept", async () => {
    const w = await world();
    try {
      const turn = await idleTurnTree();
      const credential = w.credentialOf(w.session("w-reused"));
      await w.offerDriven(credential, pinOf(turn.holder));
      // The kernel keeps naming the dead connector's pid; after the accept-time read it belongs to a valid
      // grandchild of the pinned holder. At accept that pid was still the connector (this process here).
      const connectorToken = readProcessStartToken(process.pid);
      hooks.peerAnswer = (_call, actual) => (actual ? { ...actual, peerPid: turn.leaf, effectivePid: turn.leaf } : actual);
      hooks.tokenFor = (pid, actual) => (pid === turn.leaf && hooks.peerCalls <= 1 ? connectorToken : actual);
      const reply = await claimFromHere(w.launch.socketPath, credential.externalSessionId);
      expect(handed(reply, credential)).toBe(false);
      expect(reply).toEqual({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      expect(w.refusals()).toEqual(["PEER_CHANGED"]);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-GONE: a connector that is gone before the daemon accepts is refused, the entry kept and nothing written", async () => {
    const w = await world();
    try {
      const turn = await idleTurnTree();
      const credential = w.credentialOf(w.session("w-gone"));
      await w.offerDriven(credential, pinOf(turn.holder));
      const gone = await connectorGoneBeforeAccept(w.launch.socketPath, credential.externalSessionId);
      expect(gone.sender).not.toBe(gone.connector);
      expect(handed(gone.reply, credential)).toBe(false);
      expect(gone.reply).toEqual({ ok: false, reasonCode: "MCP_PEER_UNAUTHENTICATED" });
      // At accept the kernel still named the dead connector, whose start token could not be read.
      expect(w.refusals()).toEqual(["PEER_START_UNKNOWN"]);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-STALE (b): a fresh kernel peer read that fails at hand-over is refused and the entry kept", async () => {
    const w = await world();
    try {
      const credential = w.credentialOf(w.session("w-stale-unread"));
      const turn = w.tree(2, credential);
      await w.offerDriven(credential, pinOf(turn.pid));
      hooks.peerAnswer = (call, actual) => (call === 3 ? null : actual);
      const [relay] = await turn.go();
      expect(handed(relay!.reply, credential)).toBe(false);
      expect(w.refusals()).toEqual(["PEER_UNREADABLE"]);
      expect(w.h.cp.audit.byKind(REFUSED).map((event) => event.evidence["stage"])).toEqual(["hand-over"]);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(true);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("W-ONCE: two concurrent requests from the turn's own relays get exactly one credential, and the entry is consumed once", async () => {
    const w = await world();
    try {
      const credential = w.credentialOf(w.session("w-once"));
      // One CLI starting two relays at once, both grandchildren of the pinned holder.
      const turn = w.tree(2, credential, 2);
      await w.offerDriven(credential, pinOf(turn.pid));
      const relays = await turn.go();
      expect(relays).toHaveLength(2);
      expect(relays.filter((relay) => handed(relay.reply, credential))).toHaveLength(1);
      expect(relays.filter((relay) => relay.reply?.ok === false)).toHaveLength(1);
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(false);
      expect(w.refusals()).toEqual([]);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });

  it("non-driven control: an entry offered through the interactive-spawn door keeps the same-uid path", async () => {
    const w = await world();
    try {
      const created = w.session("non-driven");
      const credential = w.credentialOf(created);
      const offered = await w.launch.interactiveSpawns.provision(credential);
      if (!offered.allowed) throw new Error(offered.message);
      const reply = await claimFromHere(w.launch.socketPath, credential.externalSessionId);
      expect(reply).toMatchObject({ ok: true, sessionId: created.sessionId, sessionSecret: created.sessionSecret, token: TOKEN });
      expect(w.launch.withdraw(credential.externalSessionId)).toBe(false);
      expect(w.refusals()).toEqual([]);
      w.auditNeverHolds(credential.sessionSecret);
    } finally {
      await w.close();
    }
  });
});

/** The MCP client's side of the relay, as Claude Code writes it. */
const MCP_CLIENT_LINES = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "o4b", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "role_dispatch_pending", arguments: {} } },
];

/**
 * A `claude` stand-in that starts its MCP server exactly as `--mcp-config` names it (the real session
 * relay), speaks the client's side to it, and reports the process shape and whether the relay's tool call
 * was answered on `cto.mcp.sock`.
 */
const standInClaude = (workdir: string): string => {
  const binary = join(workdir, "claude-stand-in.cjs");
  writeFileSync(binary, `#!${process.execPath}
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const at = Math.max(args.indexOf("--resume"), args.indexOf("--session-id"));
const server = Object.values(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers)[0];
const relay = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
let err = "";
relay.stdout.setEncoding("utf8");
relay.stderr.setEncoding("utf8");
relay.stdout.on("data", (chunk) => { out += chunk; if (out.includes('"id":2')) relay.stdin.end(); });
relay.stderr.on("data", (chunk) => { err += chunk; });
relay.stdin.on("error", () => {});
relay.stdin.write(${JSON.stringify(MCP_CLIENT_LINES.map((line) => JSON.stringify(line)).join("\n") + "\n")});
const timer = setTimeout(() => relay.kill("SIGKILL"), 20000);
relay.on("close", (code) => {
  clearTimeout(timer);
  const answer = out.split("\\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((m) => m && m.id === 2);
  const stage = (err.match(/session-relay: \\S+ \\S+/) || [null])[0];
  const report = { cli: process.pid, cliParent: process.ppid, relay: relay.pid, relayExit: code, answered: Boolean(answer && "result" in answer), stage };
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, session_id: args[at + 1], result: JSON.stringify(report) }), () => process.exit(0));
});
`);
  chmodSync(binary, 0o700);
  return binary;
};

describe("O4 slice B — the real adapter's relay shape", () => {
  it("positive control: the real session relay, the CLI's MCP child under the pinned holder, takes the credential and is answered", async (ctx) => {
    requireSeatbelt(ctx);
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "o4b-real-relay");
      // The daemon's composition: the registry and the audit log beside the channel.
      const launch = await startSessionLaunchChannel(tempDir("acp-o4b-real-launch-"), { mcpToken: BOOTSTRAP_FIXTURE_TOKEN, sessions: cp.sessions, audit: cp.audit });
      try {
        const offered: SessionLaunchCredential[] = [];
        cp.sessionRuntime.attach({
          delivery: {
            prepare: () => launch.prepare(),
            provision: (credential) => {
              offered.push(credential);
              return launch.provision(credential);
            },
            withdraw: (externalSessionId) => launch.withdraw(externalSessionId),
          },
          route: { launchSocketPath: launch.socketPath, mcpSocketPath: f.ctoSocket },
        });
        const workdir = cp.sessions.require(binding.sessionId).workdir!;
        mkdirSync(workdir, { recursive: true });
        const real = new ClaudeCliAdapter({
          clock: f.harness.clock,
          capacityFile: join(tempDir("acp-o4b-cap-"), "claude.json"),
          binary: standInClaude(realpathSync(workdir)),
        });
        const results: SessionTurnResult[] = [];
        f.claude.runSessionTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
          const result = await real.runSessionTurn(request as Parameters<ClaudeCliAdapter["runSessionTurn"]>[0]);
          results.push(result);
          return result;
        };
        // What earlier turns of the fixture (on its own channel) left is not this turn's.
        const notTakenBefore = cp.audit.byKind("SESSION_CREDENTIAL_NOT_TAKEN").length;
        expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "o4b-real-relay", kind: "test" }])).toMatchObject({ allowed: true });
        await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 30_000 });
        expect(results[0]).toMatchObject({ ok: true });
        const report = JSON.parse(results[0]!.text) as {
          cli: number; cliParent: number; relay: number; relayExit: number | null; answered: boolean; stage: string | null;
        };
        // The shape: pinned holder → CLI → relay.
        expect(offered).toHaveLength(1);
        expect(report.cliParent).toBe(offered[0]!.pin!.pid);
        expect(report).toMatchObject({ relayExit: 0, answered: true, stage: null });
        expect(launch.withdraw(offered[0]!.externalSessionId)).toBe(false);
        expect(cp.audit.byKind(REFUSED)).toEqual([]);
        expect(cp.audit.byKind("SESSION_CREDENTIAL_NOT_TAKEN")).toHaveLength(notTakenBefore);
      } finally {
        await launch.close();
      }
    });
  });
});
