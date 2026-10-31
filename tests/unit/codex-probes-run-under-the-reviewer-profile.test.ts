import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CodexUsageCollector } from "../../src/capacity/usage-collectors.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import * as cliAdapters from "../../src/runtime/cli-adapters.ts";
import { CodexCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { CodexRateLimitProbe } from "../../src/capacity/usage-collectors.ts";
import type { CapacityReading, ReviewerEgressConfig } from "../../src/runtime/provider.ts";
import type * as ReviewerEgressModule from "../../src/runtime/reviewer-egress.ts";
import type { ReviewerEgressLease } from "../../src/runtime/reviewer-egress.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  type Harness,
} from "../helpers/harness.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * Every Codex process ACP starts beside a packet reviewer — the `--version` probe, the capacity
 * collector's `app-server`, and the reviewer itself — either runs under the reviewer's composed
 * profile or cannot reach the authenticated Codex home, and none starts when the reviewer egress
 * profile is missing.
 *
 * The CLI is a stub that reports, over a unix socket, its argv, ppid, CODEX_HOME, HTTPS_PROXY and
 * what it could do to canary paths; it never runs a real Codex. Seatbelt is real.
 */

/** Every reviewer-egress lease taken in this file, with what was done to it and by whom. */
const leases = vi.hoisted(() => ({
  list: [] as Array<{ id: number; events: string[]; lease: { died(): boolean; proxyUrl: string; port: number } }>,
}));

vi.mock("../../src/runtime/reviewer-egress.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ReviewerEgressModule>();
  return {
    ...actual,
    acquireReviewerEgress: async (...args: Parameters<typeof actual.acquireReviewerEgress>): Promise<ReviewerEgressLease> => {
      const lease = await actual.acquireReviewerEgress(...args);
      const entry = { id: leases.list.length + 1, events: [] as string[], lease };
      leases.list.push(entry);
      const finalise = lease.finalise.bind(lease);
      const abandon = lease.abandon.bind(lease);
      lease.finalise = async (...finaliseArgs) => {
        entry.events.push("finalise");
        return finalise(...finaliseArgs);
      };
      lease.abandon = async () => {
        entry.events.push("abandon");
        return abandon();
      };
      return lease;
    },
  };
});

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
  leases.list.length = 0;
});

interface StubRecord {
  role: string;
  argv: string[];
  pid: number;
  ppid: number;
  codexHome: string | null;
  httpsProxy: string | null;
  sandboxed: boolean;
  authRead: string;
  authAppend: string;
  authTruncate: string;
  authRename: string;
  authUnlink: string;
  homeList: string;
  reads: Record<string, string>;
  execShell: string;
  directTcp: string;
  /** Appends attempted on other paths (each undone when it succeeds). */
  writes: Record<string, string>;
}

const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("no loopback port"));
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});

/** A CONNECT through the proxy listening on `port`: its HTTP status, or the socket error. */
const proxyAnswers = async (port: number, host: string): Promise<string> => new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  let response = "";
  const done = (value: string): void => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(3_000, () => done("TIMEOUT"));
  socket.once("connect", () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
  socket.on("data", (chunk: Buffer) => {
    response += chunk.toString("latin1");
    const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(response);
    if (match) done(match[1]!);
  });
  socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? error.message));
});

const ownerProfile = (port: number, ownerCanary: string): string => [
  "(version 1)",
  "(allow default)",
  "(deny network-outbound (remote tcp))",
  "(deny network-outbound (remote udp))",
  `(allow network-outbound (remote tcp "localhost:${port}"))`,
  "(allow network-outbound (remote unix-socket))",
  // Present only in the owner's bytes: a process that cannot read it ran under the composition.
  `(deny file-read* (literal ${JSON.stringify(ownerCanary)}))`,
].join("\n");

/** Local protocol fixture only: it never opens an upstream connection or reads credentials. */
const FAKE_PROXY = `#!/usr/bin/env python3
import hashlib,json,os,signal,socket,sys,time
port=int(sys.argv[1]); allow=sys.argv[2]; logpath=sys.argv[3]
data=open(allow,'rb').read(); hosts=set(data.decode().splitlines())
def log(row):
 with open(logpath,'a') as out: out.write(json.dumps(dict(t=time.time(),**row))+'\\n')
server=socket.socket(); server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); server.bind(('127.0.0.1',port)); server.listen(32)
def stop(*_):
 server.close(); sys.exit(0)
signal.signal(signal.SIGTERM,stop)
log(dict(verdict='START',port=port,pid=os.getpid(),allowlistDigest='sha256:'+hashlib.sha256(data).hexdigest()))
while True:
 conn,_=server.accept(); conn.settimeout(3)
 try:
  request=b''
  while b'\\r\\n\\r\\n' not in request:
   part=conn.recv(4096)
   if not part: break
   request+=part
  fields=request.split(b'\\r\\n')[0].decode().split()
  if len(fields)<2: continue
  host,_,targetport=fields[1].rpartition(':'); permitted=fields[0]=='CONNECT' and host in hosts and targetport=='443'
  log(dict(verdict='ALLOW' if permitted else 'DENY',host=host,port=targetport))
  conn.sendall(b'HTTP/1.1 200 Connection Established\\r\\n\\r\\n' if permitted else b'HTTP/1.1 403 Forbidden\\r\\n\\r\\n')
 finally: conn.close()
`;

/**
 * The stub Codex. It reports first and acts second: a `--version` prints a version, `app-server`
 * answers the JSON-RPC rate-limit read, `exec` answers a reviewer turn. Every write it attempts on
 * the canary `auth.json` is undone when it succeeds, so an unconfined run leaves the canary intact.
 */
const stubSource = (config: Record<string, unknown>): string => `#!${process.execPath}
"use strict";
const fs = require("fs"), net = require("net"), cp = require("child_process");
const C = ${JSON.stringify(config)};
const knobs = (() => { try { return JSON.parse(fs.readFileSync(C.control, "utf8")); } catch (e) { return {}; } })();
const argv = process.argv.slice(2);
const role = argv.includes("app-server") ? "collector" : argv.includes("--version") ? "version" : argv.includes("exec") ? "reviewer" : argv.join(" ");
const outcome = (fn) => { try { fn(); return "ALLOWED"; } catch (e) { return (e && e.code) || String(e); } };
let original = null;
const authRead = outcome(() => { original = fs.readFileSync(C.auth, "utf8"); });
const restore = () => { if (original !== null) { try { fs.writeFileSync(C.auth, original); } catch (e) {} } };
const authAppend = outcome(() => { fs.appendFileSync(C.auth, " "); restore(); });
const authTruncate = outcome(() => { fs.truncateSync(C.auth, 0); restore(); });
const authRename = outcome(() => { fs.renameSync(C.auth, C.auth + ".moved"); fs.renameSync(C.auth + ".moved", C.auth); });
const authUnlink = outcome(() => { fs.unlinkSync(C.auth); restore(); });
const homeList = outcome(() => { fs.readdirSync(C.authHome); });
const reads = {};
const writes = {};
for (const [name, path] of Object.entries(C.writes || {})) {
  let before = null;
  writes[name] = outcome(() => { before = fs.readFileSync(path, "utf8"); fs.appendFileSync(path, " "); fs.writeFileSync(path, before); });
}
for (const [name, path] of Object.entries(C.canaries)) reads[name] = outcome(() => { fs.readFileSync(path); });
const shell = cp.spawnSync("/bin/sh", ["-c", "exit 0"]);
const execShell = shell.error ? (shell.error.code || String(shell.error)) : shell.status === 0 ? "ALLOWED" : "status " + shell.status;
const direct = () => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port: C.directPort });
  const done = (value) => { socket.destroy(); resolve(value); };
  socket.once("connect", () => done("CONNECTED"));
  socket.once("error", (e) => done(e.code || String(e)));
  setTimeout(() => done("TIMEOUT"), 2000);
});
const report = (record) => new Promise((resolve) => {
  const socket = net.createConnection(C.socket, () => socket.end(JSON.stringify(record) + "\\n"));
  socket.once("close", resolve);
  socket.once("error", resolve);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));
(async () => {
  await report({
    role, argv, pid: process.pid, ppid: process.ppid,
    codexHome: process.env.CODEX_HOME || null, httpsProxy: process.env.HTTPS_PROXY || null,
    sandboxed: reads.ssh === "EPERM",
    authRead, authAppend, authTruncate, authRename, authUnlink, homeList, reads, writes, execShell,
    directTcp: await direct(),
  });
  if (role === "version") { process.stdout.write("codex-cli 0.0.0-stub\\n"); process.exit(0); }
  if (role === "reviewer") {
    process.stdin.resume();
    process.stdin.on("error", () => {});
    await delay(knobs.execDelayMs);
    if (knobs.execExit) { process.stderr.write("stub reviewer failed\\n"); process.exit(knobs.execExit); }
    const thread = argv.includes("resume") ? argv[argv.length - 2] : "01a1448e-0001-7000-8000-000000000000";
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: thread }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "READY" } }) + "\\n");
    process.exit(0);
  }
  if (role === "collector") {
    let buffer = "";
    const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch (e) { continue; }
        if (message.id === 0) reply({ id: 0, result: { userAgent: "stub" } });
        if (message.id === 1) {
          setTimeout(() => reply({ id: 1, result: { rateLimits: { primary: {
            usedPercent: 10, windowDurationMins: 300, resetsAt: C.resetsAt,
          } } } }), knobs.answerDelayMs || 0);
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
    return;
  }
  process.exit(0);
})();
`;

interface Fixture {
  root: string;
  home: string;
  auth: string;
  stub: string;
  control: string;
  port: number;
  egress: ReviewerEgressConfig;
  records: StubRecord[];
  setKnobs(knobs: { execDelayMs?: number; execExit?: number; answerDelayMs?: number }): void;
  close(): Promise<void>;
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

const makeFixture = async (
  options: {
    profile?: "valid" | "missing";
    proxy?: "fake" | "dies";
    clockIso?: string;
    /** Appended to an otherwise contract-valid owner profile. */
    ownerProfileExtra?: string;
    /** A Codex home of this test's own, so a missing home or a linked credential reaches no other test. */
    ownHome?: { state: "present" | "missing"; credential?: "file" | "symlink-in-home" | "symlink-out-of-home" | "hardlink" };
  } = {},
): Promise<Fixture> => {
  const root = realpathSync(tempDir("acp-cpr-"));
  const user = process.env["HOME"]!;
  const home = join(user, options.ownHome ? `.codex-${randomUUID().slice(0, 8)}` : ".codex");
  const auth = join(home, "auth.json");
  const writeTargets: Record<string, string> = {};
  if (options.ownHome?.state !== "missing") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.toml"), 'model = "the user\'s own"\n');
    const credential = options.ownHome?.credential ?? "file";
    if (credential === "file") {
      writeFileSync(auth, '{"synthetic":"canary credential"}', { mode: 0o600 });
    } else {
      const target = credential === "symlink-out-of-home" ? join(root, "outside-auth.json") : join(home, "stored-auth.json");
      writeFileSync(target, '{"synthetic":"canary credential"}', { mode: 0o600 });
      if (credential === "hardlink") linkSync(target, auth);
      else symlinkSync(target, auth);
      writeTargets["target"] = target;
    }
  }
  const canaries: Record<string, string> = {
    ssh: join(user, ".ssh", "id_canary"),
    gh: join(user, ".config", "gh", "hosts.yml"),
    claude: join(user, ".claude", "canary.jsonl"),
    state: join(user, ".agent-control-plane", "canary"),
    ownerCanary: join(root, "owner-only-canary"),
  };
  for (const path of Object.values(canaries)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "canary");
  }

  const port = await freePort();
  const direct: Server = createServer((socket) => socket.end());
  const directPort = await new Promise<number>((resolve) => {
    direct.listen(0, "127.0.0.1", () => resolve((direct.address() as { port: number }).port));
  });

  const records: StubRecord[] = [];
  const socketPath = `/tmp/acp-cpr-${randomUUID().slice(0, 8)}.sock`;
  const logServer: Server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    socket.on("end", () => {
      for (const line of text.split("\n").filter(Boolean)) records.push(JSON.parse(line) as StubRecord);
    });
  });
  await new Promise<void>((resolve) => logServer.listen(socketPath, resolve));

  const control = join(root, "control.json");
  writeFileSync(control, "{}");
  const resetsAt = Math.floor(Date.parse(options.clockIso ?? "2026-10-31T00:00:00.000Z") / 1000) + 86_400;
  const stub = join(root, "bin", "codex");
  mkdirSync(join(root, "bin"));
  writeFileSync(stub, stubSource({
    control, auth, authHome: home, canaries, writes: writeTargets, socket: socketPath, directPort, resetsAt,
  }));
  chmodSync(stub, 0o755);

  const profilePath = join(root, "reviewer.sb");
  if ((options.profile ?? "valid") === "valid") {
    writeFileSync(profilePath, `${ownerProfile(port, canaries["ownerCanary"]!)}${options.ownerProfileExtra ?? ""}`);
  }
  const proxyPath = join(root, "allowlist-proxy.py");
  writeFileSync(proxyPath, (options.proxy ?? "fake") === "fake" ? FAKE_PROXY : "import sys\nsys.exit(7)\n", { mode: 0o700 });
  const egress: ReviewerEgressConfig = {
    profilePath,
    proxyPath,
    runtimeDir: join(root, "runs"),
    port,
    providerEndpoints: { gpt: ["api.openai.com"] },
  };

  const fixture: Fixture = {
    root, home, auth, stub, control, port, egress, records,
    setKnobs: (knobs) => writeFileSync(control, JSON.stringify(knobs)),
    close: async () => {
      await new Promise<void>((resolve) => logServer.close(() => resolve()));
      await new Promise<void>((resolve) => direct.close(() => resolve()));
      try { unlinkSync(socketPath); } catch { /* already gone */ }
    },
  };
  fixtures.push(fixture);
  return fixture;
};

const codexAdapter = (fixture: Fixture) =>
  new CodexCliAdapter({
    clock: new ManualClock("2026-10-31T00:00:00.000Z"),
    capacityFile: join(fixture.root, "gpt.json"),
    binary: fixture.stub,
    codexHome: fixture.home,
    reviewerEgress: fixture.egress,
  });

/** What a collector spawn must have been: the owner profile composed with the generated rules, through the proxy. */
const expectComposedReviewerProfile = (record: StubRecord, fixture: Fixture): void => {
  expect(record.sandboxed, JSON.stringify(record)).toBe(true);
  expect(record.reads).toEqual({ ssh: "EPERM", gh: "EPERM", claude: "EPERM", state: "EPERM", ownerCanary: "EPERM" });
  expect(record.authRead).toBe("ALLOWED");
  expect([record.authAppend, record.authTruncate, record.authRename, record.authUnlink]).toEqual(["EPERM", "EPERM", "EPERM", "EPERM"]);
  expect(record.execShell).not.toBe("ALLOWED");
  expect(record.directTcp).not.toBe("CONNECTED");
  expect(record.httpsProxy).toBe(`http://127.0.0.1:${fixture.port}`);
  expect(record.codexHome).toBe(realpathSync(fixture.home));
};

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: ["public api changes"],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** A run whose result is submitted, so the gate reviews it. */
const submit = async (harness: Harness) => {
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;
  const tasks = harness.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = harness.cp.tasks.ready(runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: impl.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, impl.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  await harness.cp.pipeline.submitResult({
    runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "app() now returns 2",
    recommendation: "merge",
  });
  return runId;
};

const isolationFor = (packetRoot: string) => ({
  packetRoot,
  denyReadPaths: [] as string[],
  emptyEnvironment: true as const,
  network: "provider-only" as const,
  tools: "none" as const,
});

const sandboxedProbe = (fixture: Fixture): CodexRateLimitProbe => {
  const Probe = (cliAdapters as Record<string, unknown>)["ReviewerProfiledCodexRateLimitProbe"] as
    | (new (options: { egress: ReviewerEgressConfig | undefined; provider: string; denyReadPaths: readonly string[] }) => CodexRateLimitProbe)
    | undefined;
  if (!Probe) throw new Error("no reviewer-profiled Codex rate-limit probe is exported");
  return new Probe({ egress: fixture.egress, provider: "gpt", denyReadPaths: [] });
};

const leaseDirectories = (fixture: Fixture): string[] =>
  existsSync(fixture.egress.runtimeDir) ? readdirSync(fixture.egress.runtimeDir) : [];

describe("W1: a missing reviewer egress profile stops the review before any Codex process", () => {
  it("returns ISOLATION_LOST naming REVIEWER_EGRESS_PROFILE_MISSING with no version, collector or reviewer call", async () => {
    const harness = makeHarness({ reviewer: { preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" }, fallbacks: [] } });
    const fixture = await makeFixture({ profile: "missing", clockIso: harness.clock.nowIso() });
    const adapter = new CodexCliAdapter({
      clock: harness.clock,
      capacityFile: join(fixture.root, "gpt.json"),
      binary: fixture.stub,
      codexHome: fixture.home,
      reviewerEgress: fixture.egress,
    });
    harness.cp.providers.registerForRole(adapter, Role.BLIND_REVIEWER);
    // The production wiring (control-plane.ts): the gate reads the raw Codex adapter's packet scope.
    harness.cp.review.attach({ packetReviewerScope: (provider) => (provider === "gpt" ? adapter.packetReviewerScope() : null) });

    // Every capacity reading the submission takes of this adapter: the continuity check after the gate's
    // refusal asks it once more, and that probe must start nothing either.
    const readings: CapacityReading[] = [];
    const probeCapacity = adapter.probeCapacity.bind(adapter);
    vi.spyOn(adapter, "probeCapacity").mockImplementation(async () => {
      const reading = await probeCapacity();
      readings.push(reading);
      return reading;
    });

    const runId = await submit(harness);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const unavailable = harness.cp.audit.byKind("BLIND_REVIEW_UNAVAILABLE").filter((row) => row.runId === runId).at(-1);
    expect({
      codexCalls: fixture.records.map((record) => `${record.role}${record.sandboxed ? "" : " (unconfined)"}`),
      reasonCode: unavailable?.reasonCode,
      namesTheMissingProfile: JSON.stringify(unavailable?.evidence ?? {}).includes("REVIEWER_EGRESS_PROFILE_MISSING"),
    }).toEqual({ codexCalls: [], reasonCode: ReasonCode.ISOLATION_LOST, namesTheMissingProfile: true });
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect({ sensorHealth: reading.sensorHealth, runtimeHealth: reading.runtimeHealth, refusal: reading.error?.startsWith("REVIEWER_EGRESS_PROFILE_MISSING") })
        .toEqual({ sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", refusal: true });
    }
  }, 60_000);
});

describe("W2: the collector's app-server runs under the reviewer's composed profile on every entry path", () => {
  it("daemon start, periodic sweep, doctor and review admission each spawn it confined", async (ctx) => {
    requireSeatbelt(ctx);
    const harness = makeHarness();
    const fixture = await makeFixture({ clockIso: harness.clock.nowIso() });
    harness.cp.providers.register(new CodexCliAdapter({
      clock: harness.clock,
      capacityFile: join(fixture.root, "gpt.json"),
      binary: fixture.stub,
      codexHome: fixture.home,
      reviewerEgress: fixture.egress,
    }));
    const collectors = () => fixture.records.filter((record) => record.role === "collector");

    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const daemon = new Daemon(harness.cp, {
      stateDir: tempDir("acp-cpr-daemon-"),
      capacityRefreshIntervalMs: 2_500,
      capacityRefreshBudgetMs: 2_000,
    });
    const started = await daemon.start();
    try {
      expect(started.allowed, JSON.stringify(started)).toBe(true);
      await vi.waitFor(() => expect(collectors().length).toBeGreaterThanOrEqual(1), { timeout: 10_000, interval: 50 });
      const afterStart = collectors().length;
      await vi.waitFor(() => expect(collectors().length).toBeGreaterThan(afterStart), { timeout: 15_000, interval: 100 });
    } finally {
      await daemon.stop();
    }

    const beforeDoctor = collectors().length;
    await harness.cp.doctor.run("capacity");
    await vi.waitFor(() => expect(collectors().length).toBeGreaterThan(beforeDoctor), { timeout: 5_000, interval: 25 });

    const beforeAdmission = collectors().length;
    await harness.cp.capacity.refreshForBlindReview({ provider: "gpt", capabilities: ["blind-review"], priority: "critical" });
    await vi.waitFor(() => expect(collectors().length).toBeGreaterThan(beforeAdmission), { timeout: 5_000, interval: 25 });

    expect(collectors().length).toBeGreaterThanOrEqual(4);
    for (const record of collectors()) expectComposedReviewerProfile(record, fixture);
    expect(readdirSync(fixture.home)).toContain("auth.json");
    // A sweep or continuity probe may still hold its own lease; each is released when its probe ends.
    await vi.waitFor(() => expect(leaseDirectories(fixture)).toEqual([]), { timeout: 30_000, interval: 50 });
  }, 90_000);
});

describe("W3: the version probe cannot reach the authenticated Codex home", () => {
  it("runs `--version` with the home unreadable and unwritable", async (ctx) => {
    requireSeatbelt(ctx);
    const fixture = await makeFixture();
    expect(await codexAdapter(fixture).probeRuntime()).toBe("HEALTHY");
    await vi.waitFor(() => expect(fixture.records.some((record) => record.role === "version")).toBe(true), { timeout: 5_000, interval: 25 });
    const version = fixture.records.find((record) => record.role === "version")!;
    expect(version.argv).toEqual(["--version"]);
    expect(version.sandboxed).toBe(true);
    expect(version.authRead).toBe("EPERM");
    expect(version.homeList).toBe("EPERM");
    expect([version.authAppend, version.authTruncate, version.authRename, version.authUnlink]).toEqual(["EPERM", "EPERM", "EPERM", "EPERM"]);
    expect([version.reads["ssh"], version.reads["gh"], version.reads["state"]]).toEqual(["EPERM", "EPERM", "EPERM"]);
  }, 60_000);
});

describe("W4: a missing profile or a dead proxy leaves capacity unknown with no unconfined spawn", () => {
  for (const shape of [
    { name: "missing profile", options: { profile: "missing" as const }, code: "REVIEWER_EGRESS_PROFILE_MISSING" },
    { name: "proxy that dies at start", options: { proxy: "dies" as const }, code: "REVIEWER_EGRESS_PROXY_UNREACHABLE" },
  ]) {
    it(`${shape.name}: UNKNOWN, not routable, and no collector process`, async (ctx) => {
      requireSeatbelt(ctx);
      const harness = makeHarness();
      const fixture = await makeFixture({ ...shape.options, clockIso: harness.clock.nowIso() });
      const adapter = new CodexCliAdapter({
        clock: harness.clock,
        capacityFile: join(fixture.root, "gpt.json"),
        binary: fixture.stub,
        codexHome: fixture.home,
        reviewerEgress: fixture.egress,
      });
      const reading = await adapter.probeCapacity();
      expect(reading.sensorHealth).toBe("ERROR");
      expect(reading.buckets).toEqual([]);
      expect(reading.error).toContain(shape.code);
      expect(reading.runtimeHealth).toBe("UNKNOWN");

      // Through the monitor: no stated window, admission SUSPENDED, and no provider for the capability.
      harness.cp.providers.register(adapter);
      await harness.cp.capacity.refreshForBlindReview({ provider: "gpt", capabilities: ["blind-review"], priority: "critical" });
      const current = harness.cp.capacity.current("gpt");
      expect(current).toMatchObject({ sensorHealth: "ERROR", allocationAdmission: "SUSPENDED" });
      expect(current!.buckets.filter((bucket) => bucket.remainingPercent !== null)).toEqual([]);
      expect(harness.cp.capacity.providersFor("blind-review").map((capacity) => capacity.provider)).not.toContain("gpt");

      await new Promise((resolve) => setTimeout(resolve, 300));
      // No Codex process at all: no collector, and no `--version` beside the refusal.
      expect(fixture.records).toEqual([]);
      expect(leaseDirectories(fixture)).toEqual([]);
    }, 60_000);
  }
});

describe("W6: a refused egress boundary reads as unknown capacity on every probe path, with no Codex process", () => {
  it("daemon start, the periodic sweep and a doctor run report gpt runtime UNKNOWN with the refusal reason", async (ctx) => {
    requireSeatbelt(ctx);
    const harness = makeHarness();
    const fixture = await makeFixture({ profile: "missing", clockIso: harness.clock.nowIso() });
    const adapter = new CodexCliAdapter({
      clock: harness.clock,
      capacityFile: join(fixture.root, "gpt.json"),
      binary: fixture.stub,
      codexHome: fixture.home,
      reviewerEgress: fixture.egress,
    });
    harness.cp.providers.register(adapter);
    let phase = "daemon start";
    const readings: Array<{ phase: string; reading: CapacityReading }> = [];
    const probeCapacity = adapter.probeCapacity.bind(adapter);
    vi.spyOn(adapter, "probeCapacity").mockImplementation(async () => {
      const at = phase;
      const reading = await probeCapacity();
      readings.push({ phase: at, reading });
      return reading;
    });

    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const daemon = new Daemon(harness.cp, {
      stateDir: tempDir("acp-cpr-daemon-"),
      capacityRefreshIntervalMs: 2_500,
      capacityRefreshBudgetMs: 2_000,
    });
    const started = await daemon.start();
    try {
      expect(started.allowed, JSON.stringify(started)).toBe(true);
      expect(readings.some((entry) => entry.phase === "daemon start")).toBe(true);
      // After start, the next probe is the periodic sweep's (its interval is 2.5s).
      phase = "periodic sweep";
      await vi.waitFor(() => expect(readings.some((entry) => entry.phase === "periodic sweep")).toBe(true), { timeout: 15_000, interval: 100 });
    } finally {
      await daemon.stop();
    }
    phase = "doctor";
    await harness.cp.doctor.run("capacity");

    expect([...new Set(readings.map((entry) => entry.phase))].sort()).toEqual(["daemon start", "doctor", "periodic sweep"]);
    for (const { phase: at, reading } of readings) {
      expect({
        at,
        sensorHealth: reading.sensorHealth,
        runtimeHealth: reading.runtimeHealth,
        refusal: reading.error?.startsWith("REVIEWER_EGRESS_PROFILE_MISSING"),
      }).toEqual({ at, sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", refusal: true });
    }
    // Routing is what it was before: gpt is SUSPENDED, and allocation admission refuses only an
    // UNAVAILABLE runtime, which UNKNOWN is not. (The gate's own pre-check is what refuses the review.)
    expect(harness.cp.capacity.current("gpt")).toMatchObject({ sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", allocationAdmission: "SUSPENDED" });
    const admitted = await harness.cp.capacity.refreshForBlindReview({ provider: "gpt", capabilities: ["blind-review"], priority: "critical" });
    expect(admitted.allowed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.records).toEqual([]);
  }, 90_000);

  it("with the boundary healthy, the confined `--version` still runs and reports normally", async (ctx) => {
    requireSeatbelt(ctx);
    const fixture = await makeFixture();
    const reading = await codexAdapter(fixture).probeCapacity();
    expect({ sensorHealth: reading.sensorHealth, runtimeHealth: reading.runtimeHealth }).toEqual({ sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY" });
    await vi.waitFor(() => expect(fixture.records.map((record) => record.role).sort()).toEqual(["collector", "version"]), { timeout: 5_000, interval: 25 });
    const version = fixture.records.find((record) => record.role === "version")!;
    expect(version.sandboxed).toBe(true);
    expect(version.authRead).toBe("EPERM");
  }, 60_000);
});

/** Every capacity reading `adapter` gives, as it gives it. */
const recordReadings = (adapter: CodexCliAdapter): CapacityReading[] => {
  const readings: CapacityReading[] = [];
  const probeCapacity = adapter.probeCapacity.bind(adapter);
  vi.spyOn(adapter, "probeCapacity").mockImplementation(async () => {
    const reading = await probeCapacity();
    readings.push(reading);
    return reading;
  });
  return readings;
};

const settledRecords = async (fixture: Fixture): Promise<string[]> => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return fixture.records.map((record) => record.role);
};

describe("W7: a composed profile sandbox-exec will not accept is a boundary refusal", () => {
  it("an invalid form in a contract-valid owner profile: runtime UNKNOWN, no version probe, no collector", async (ctx) => {
    requireSeatbelt(ctx);
    const fixture = await makeFixture({ ownerProfileExtra: "\n(this-is-not-a-form)\n" });
    const adapter = codexAdapter(fixture);
    // The owner profile passes the contract check, so the egress pre-check alone does not catch it.
    await expect(adapter.packetReviewerScope().verifyReviewerEgress()).resolves.toBeUndefined();

    const reading = await adapter.probeCapacity();
    expect({
      codexCalls: await settledRecords(fixture),
      sensorHealth: reading.sensorHealth,
      runtimeHealth: reading.runtimeHealth,
      refusedByTheProfile: reading.error?.includes("not accepted by sandbox-exec") ?? false,
    }).toEqual({ codexCalls: [], sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", refusedByTheProfile: true });
    await vi.waitFor(() => expect(leaseDirectories(fixture)).toEqual([]), { timeout: 5_000, interval: 25 });
  }, 60_000);
});

describe("W8: a linked credential is refused, so no write deny can be stepped around", () => {
  for (const credential of ["symlink-in-home", "symlink-out-of-home", "hardlink"] as const) {
    it(`auth.json as a ${credential}: no Codex process, runtime UNKNOWN, the target unchanged`, async (ctx) => {
      requireSeatbelt(ctx);
      const fixture = await makeFixture({ ownHome: { state: "present", credential } });
      const target = credential === "symlink-out-of-home" ? join(fixture.root, "outside-auth.json") : join(fixture.home, "stored-auth.json");
      const before = readFileSync(target, "utf8");

      const reading = await codexAdapter(fixture).probeCapacity();
      const records = await settledRecords(fixture);
      expect({
        codexCalls: records,
        targetWritable: fixture.records.some((record) => record.writes["target"] === "ALLOWED"),
        sensorHealth: reading.sensorHealth,
        runtimeHealth: reading.runtimeHealth,
        refusedAsLinked: /symbolic link|hard links/.test(reading.error ?? ""),
      }).toEqual({ codexCalls: [], targetWritable: false, sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", refusedAsLinked: true });
      expect(readFileSync(target, "utf8")).toBe(before);
    }, 60_000);
  }
});

describe("W9: a Codex home that cannot be resolved is a boundary refusal, before or beside the egress check", () => {
  for (const profile of ["missing", "valid"] as const) {
    it(`a missing home with the reviewer profile ${profile}: runtime UNKNOWN and no Codex process`, async (ctx) => {
      requireSeatbelt(ctx);
      const fixture = await makeFixture({ profile, ownHome: { state: "missing" } });
      const reading = await codexAdapter(fixture).probeCapacity();
      expect({
        codexCalls: await settledRecords(fixture),
        sensorHealth: reading.sensorHealth,
        runtimeHealth: reading.runtimeHealth,
        refusedForTheHome: reading.error?.includes("cannot be resolved") ?? false,
      }).toEqual({ codexCalls: [], sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", refusedForTheHome: true });
      expect(leaseDirectories(fixture)).toEqual([]);
    }, 60_000);
  }

  it("a blind review with both the home and the profile missing starts no Codex process for the whole submit", async () => {
    const harness = makeHarness({ reviewer: { preferred: { provider: "gpt", model: "gpt-6.1-sol", effort: "xhigh" }, fallbacks: [] } });
    const fixture = await makeFixture({ profile: "missing", ownHome: { state: "missing" }, clockIso: harness.clock.nowIso() });
    const adapter = new CodexCliAdapter({
      clock: harness.clock,
      capacityFile: join(fixture.root, "gpt.json"),
      binary: fixture.stub,
      codexHome: fixture.home,
      reviewerEgress: fixture.egress,
    });
    harness.cp.providers.registerForRole(adapter, Role.BLIND_REVIEWER);
    harness.cp.review.attach({ packetReviewerScope: (provider) => (provider === "gpt" ? adapter.packetReviewerScope() : null) });
    expect(adapter.packetReviewerScope().state).toBe("UNCONFIGURED");
    const readings = recordReadings(adapter);

    const runId = await submit(harness);
    const unavailable = harness.cp.audit.byKind("BLIND_REVIEW_UNAVAILABLE").filter((row) => row.runId === runId).at(-1);
    expect({ codexCalls: await settledRecords(fixture), reasonCode: unavailable?.reasonCode })
      .toEqual({ codexCalls: [], reasonCode: ReasonCode.ISOLATION_LOST });
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) {
      expect({ sensorHealth: reading.sensorHealth, runtimeHealth: reading.runtimeHealth }).toEqual({ sensorHealth: "ERROR", runtimeHealth: "UNKNOWN" });
    }
  }, 60_000);
});

describe("W5: a collector and a reviewer each hold and release only their own egress", () => {
  const reviewOnce = async (adapter: CodexCliAdapter) => {
    const packetRoot = realpathSync(tempDir("acp-cpr-packet-"));
    return adapter.startSession({ model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot, purpose: "blind-review", isolation: isolationFor(packetRoot) });
  };
  const collectorWithin = (fixture: Fixture, timeoutMs: number) => new CodexUsageCollector({
    clock: new ManualClock("2026-10-31T00:00:00.000Z"),
    binary: fixture.stub,
    codexHome: fixture.home,
    timeoutMs,
    codexRateLimits: sandboxedProbe(fixture),
  });

  it("a collector that times out behind a running reviewer leaves the reviewer's proxy and lease, and releases only its own", async (ctx) => {
    requireSeatbelt(ctx);
    const fixture = await makeFixture();
    fixture.setKnobs({ execDelayMs: 3_000 });
    const review = reviewOnce(codexAdapter(fixture));
    await vi.waitFor(() => expect(leases.list.length).toBe(1), { timeout: 10_000, interval: 10 });
    await vi.waitFor(() => expect(fixture.records.some((record) => record.role === "reviewer")).toBe(true), { timeout: 10_000, interval: 10 });

    const reading = await collectorWithin(fixture, 800).collect();
    expect(reading.sensorHealth).toBe("ERROR");
    // The reviewer's lease is untouched: its proxy still answers and its directory is still there.
    expect(leases.list).toHaveLength(1);
    expect(leases.list[0]!.events).toEqual([]);
    expect(leases.list[0]!.lease.died()).toBe(false);
    expect(await proxyAnswers(fixture.port, "api.openai.com")).toBe("200");
    expect(leaseDirectories(fixture)).toHaveLength(1);

    const handle = await review;
    expect(handle.providerSessionProven).toBe(true);
    // The collector's late acquisition is its own, released by it alone once the reviewer let go.
    await vi.waitFor(() => expect(leases.list.map((entry) => entry.events)).toEqual([["finalise"], ["abandon"]]), { timeout: 10_000, interval: 25 });
    await vi.waitFor(() => expect(leaseDirectories(fixture)).toEqual([]), { timeout: 5_000, interval: 25 });
    expect(fixture.records.filter((record) => record.role === "collector")).toEqual([]);
  }, 60_000);

  it("a reviewer waiting behind a collector gets its own lease after the collector releases its own", async (ctx) => {
    requireSeatbelt(ctx);
    const fixture = await makeFixture();
    fixture.setKnobs({ answerDelayMs: 1_500 });
    const adapter = codexAdapter(fixture);
    const capacity = adapter.probeCapacity();
    await vi.waitFor(() => expect(fixture.records.some((record) => record.role === "collector")).toBe(true), { timeout: 10_000, interval: 10 });
    const collectorLeases = leases.list.length;
    expect(collectorLeases).toBe(1);
    const review = reviewOnce(adapter);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The reviewer has not touched the collector's lease while it runs.
    expect(leases.list).toHaveLength(1);
    expect(leases.list[0]!.events).toEqual([]);

    const reading = await capacity;
    expect(reading.sensorHealth, JSON.stringify(reading)).toBe("HEALTHY");
    const handle = await review;
    expect(handle.providerSessionProven).toBe(true);
    expect(leases.list.map((entry) => entry.events)).toEqual([["abandon"], ["finalise"]]);
    expect(leaseDirectories(fixture)).toEqual([]);
    expectComposedReviewerProfile(fixture.records.find((record) => record.role === "collector")!, fixture);
  }, 60_000);

  it("a reviewer that fails releases only its own lease, and the waiting collector then reads under its own", async (ctx) => {
    requireSeatbelt(ctx);
    const fixture = await makeFixture();
    fixture.setKnobs({ execDelayMs: 1_000, execExit: 3 });
    const review = reviewOnce(codexAdapter(fixture)).then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(leases.list.length).toBe(1), { timeout: 10_000, interval: 10 });
    const reading = await collectorWithin(fixture, 15_000).collect();
    expect(await review).toBeInstanceOf(Error);
    expect(reading.sensorHealth, JSON.stringify(reading)).toBe("HEALTHY");
    expect(leases.list).toHaveLength(2);
    expect(leases.list[0]!.events).toHaveLength(1);
    expect(leases.list[1]!.events).toEqual(["abandon"]);
    expect(leaseDirectories(fixture)).toEqual([]);
    expectComposedReviewerProfile(fixture.records.find((record) => record.role === "collector")!, fixture);
  }, 60_000);
});
