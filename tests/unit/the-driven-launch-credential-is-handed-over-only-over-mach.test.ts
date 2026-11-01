import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import {
  MACH_LAUNCH_RESERVED_SERVICE,
  admitMachLaunchGrandchild,
  drainMachLaunchQueueOnRefusal,
  startCliPinWatcher,
  loadMachLaunchAddon,
  serveMachLaunchCredential,
  startSessionLaunchChannel,
  type MachLaunchAddon,
  type MachLaunchHandle,
  type MachLaunchCustody,
  type MachLaunchIncoming,
  type MachLaunchSessions,
  type PendingLaunchCredential,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { SessionLaunchCredential } from "../../src/cto/cto-lifecycle.ts";
import type { SessionRecord, SessionRegistry } from "../../src/session/session-registry.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { tempDir } from "../helpers/fixtures.ts";
import { BOOTSTRAP_FIXTURE_TOKEN, type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { __testing as cliAdapterTesting } from "../../src/runtime/cli-adapters.ts";

/**
 * O4b B' step 2 — the driven-turn credential is handed over only over raw Mach, admitted per message to
 * the one real process shape (pinned holder → claude CLI → the CLI's own MCP child) and nothing else.
 *
 * These witnesses use the real native addon and real Mach messages with a unique per-run service name,
 * and real process trees (a holder that spawns a CLI that spawns the real `dist/cli/session-relay.js`).
 * The session registry is a double that answers `verifySecret` from the secret this test provisioned on
 * real kernel facts — it never weakens admission, which runs entirely on the kernel audit token and
 * live `proc_*` reads. On base 3922d8e4 there is no Mach transport and a driven credential is handed to
 * any same-uid presenter of the session id over `cto.launch.sock`, so every refusal here is a property
 * that head enforces and base violates.
 *
 * W-REUSE / W-DEAD / W-CLI-EXIT / W-REPARENT need the sender or the CLI to change between the send and
 * the daemon's admission; the daemon's receive callback is where that window lives, so the test does the
 * manipulation inside a `beforeAdmit` hook and then runs the real admission on the real, now-changed
 * state. The addon delivers to that callback asynchronously, exactly as it does in production.
 */

const addonAvailable = (): MachLaunchAddon | null => {
  if (process.platform !== "darwin") return null;
  try {
    return loadMachLaunchAddon();
  } catch {
    return null;
  }
};
const ADDON = addonAvailable();
const requireMach = (ctx: { skip: (note?: string) => void }): MachLaunchAddon => {
  if (!ADDON) {
    if (process.env["ACP_REQUIRE_SEATBELT"] === "1") throw new Error("the mach-launch addon is required on this host");
    ctx.skip("mach-launch addon not built on this platform");
    throw new Error("unreachable");
  }
  return ADDON;
};

/** The relay-side `claim`, which the daemon-facing `MachLaunchAddon` type does not expose. */
const claimFrom = (addon: MachLaunchAddon, name: string, body: Buffer, timeoutMs: number): Promise<{ code: string; body?: Buffer }> =>
  (addon as unknown as { claim(n: string, b: Buffer, t: number): Promise<{ code: string; body?: Buffer }> }).claim(name, body, timeoutMs);

const RELAY_JS = join(process.cwd(), "dist/cli/session-relay.js");
const ADDON_PATH = join(process.cwd(), "dist/native/mach-launch/build/Release/mach_launch.node");

/**
 * A session registry double: it answers from the one secret/incarnation/epoch this test provisioned. As
 * the registry does, a rotation replaces the secret, and an ERROR or STOPPED session's secret stops verifying.
 */
const sessionsDouble = (record: { sessionId: string; sessionSecret: string; incarnation: string; credentialEpoch: number }) => {
  let epoch = record.credentialEpoch;
  let secret = record.sessionSecret;
  let lifecycle: SessionLifecycle = SessionLifecycle.READY;
  const rotations: number[] = [];
  const transitions: SessionLifecycle[] = [];
  const asRecord = (): SessionRecord => ({ incarnation: record.incarnation, credentialEpoch: epoch, lifecycle } as unknown as SessionRecord);
  const api: MachLaunchSessions = {
    get: (id: string): SessionRecord | null => (id === record.sessionId ? asRecord() : null),
    verifySecret: (id: string, presented: string) =>
      id === record.sessionId && presented === (secret || record.sessionSecret) &&
      lifecycle !== SessionLifecycle.ERROR && lifecycle !== SessionLifecycle.STOPPED
        ? allow(ReasonCode.OK, asRecord())
        : deny<SessionRecord>(ReasonCode.SESSION_SECRET_INVALID, "no", { sessionId: id }),
    rotateSecret: ((id: string, expected: number) => {
      if (id !== record.sessionId || expected !== epoch) return deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "stale", {});
      epoch += 1;
      secret = `rotated-${epoch}`;
      rotations.push(epoch);
      return allow(ReasonCode.OK, { sessionId: id, sessionSecret: secret, credentialEpoch: epoch });
    }) as SessionRegistry["rotateSecret"],
    transition: ((id: string, to: SessionLifecycle) => {
      if (id !== record.sessionId) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId: id });
      lifecycle = to;
      transitions.push(to);
      return allow(ReasonCode.OK, asRecord());
    }) as SessionRegistry["transition"],
  };
  return Object.assign(api, { rotations, transitions });
};

type AuditRow = { kind: string; reasonCode: string; evidence: Record<string, unknown> };
const auditDouble = () => {
  const rows: AuditRow[] = [];
  return {
    rows,
    record: (entry: { kind: string; reasonCode?: string | null; evidence?: Record<string, unknown> }) => {
      rows.push({ kind: entry.kind, reasonCode: entry.reasonCode ?? "", evidence: entry.evidence ?? {} });
      return allow(ReasonCode.OK, 1);
    },
  };
};

const credentialOf = (sessionId: string): SessionLaunchCredential & { sessionSecret: string } => ({
  sessionId,
  sessionIncarnation: "inc-1",
  externalSessionId: `ext-${sessionId}`,
  sessionSecret: `secret-${sessionId}-${randomUUID()}`,
});

const MCP_TOKEN = "mach-witness-mcp-token-not-a-deployment-secret";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (!predicate() && Date.now() < until) await sleep(15);
  return predicate();
};

interface Harness {
  readonly isoName: string;
  readonly pending: Map<string, PendingLaunchCredential>;
  readonly audit: ReturnType<typeof auditDouble>;
  readonly sessions: ReturnType<typeof sessionsDouble>;
  readonly mcpLines: string[];
  readonly handle: MachLaunchHandle;
  readonly dir: string;
  beforeAdmit: ((request: MachLaunchIncoming) => void | Promise<void>) | null;
  readonly watcher: { wake(): void; stop(): void };
  readonly mcpSock: string;
  /** Process groups this harness started (a spawned tree's holder, a real holder's sandbox-exec), killed at cleanup. */
  readonly groups: number[];
  spawnTree(mode: "holder-cli-relay" | "holder-relay" | "holder-cli-two-relays", externalSessionId: string): {
    report: () => Record<string, number>;
    go: () => void;
    children: ChildProcess[];
  };
}

/**
 * Every process a witness here started, by pid and the start token it had when it was first seen, so the
 * file can show at its end that none of them is still alive. A tree is killed as a process group: a CLI or
 * relay whose parent died is reparented to launchd but stays in its holder's group, so the group reaches it.
 */
const spawnedThisFile = new Map<number, string>();
const remember = (pid: number | undefined): void => {
  if (pid === undefined || pid <= 1 || spawnedThisFile.has(pid)) return;
  const token = readProcessStartToken(pid);
  if (token !== null) spawnedThisFile.set(pid, token);
};
const aliveAsSpawned = (pid: number): boolean => {
  const token = spawnedThisFile.get(pid);
  return token !== undefined && readProcessStartToken(pid) === token;
};
const groupMembers = (pgid: number): number[] =>
  spawnSync("/usr/bin/pgrep", ["-g", String(pgid)], { encoding: "utf8", timeout: 5_000 }).stdout
    .split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1);
/** Kills each group (only while a process this file started is still in it) and waits until all of it is gone. */
const killTrees = async (groups: readonly number[], pids: readonly number[]): Promise<void> => {
  const ours = new Set<number>([...groups, ...pids]);
  for (const pid of ours) remember(pid);
  for (const pgid of groups) {
    const members = groupMembers(pgid);
    if (!members.some((pid) => aliveAsSpawned(pid))) continue;
    for (const pid of members) { remember(pid); ours.add(pid); }
    try { process.kill(-pgid, "SIGKILL"); } catch { /* the group emptied meanwhile */ }
  }
  for (const pid of ours) {
    if (aliveAsSpawned(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  const survivors = (): number[] => [...ours].filter((pid) => aliveAsSpawned(pid));
  if (!(await waitFor(() => survivors().length === 0, 10_000))) {
    throw new Error(`spawned processes survived cleanup: ${survivors().join(", ")}`);
  }
};

const harnesses: Array<{ cleanup: () => Promise<void> }> = [];
afterAll(() => {
  // No process any witness in this file started is alive once the file is done.
  expect([...spawnedThisFile.keys()].filter((pid) => aliveAsSpawned(pid))).toEqual([]);
});
afterEach(async (ctx) => {
  for (const h of harnesses.splice(0)) await h.cleanup();
  // A marker the macos-15 CI step greps for, to show from the log that the real Mach witnesses actually
  // executed on the runner (and did not silently skip). Printed only when the case was not skipped.
  if (ctx.task.result?.state !== "skip") process.stdout.write(`MACH_WITNESS_EXECUTED ${ctx.task.name}\n`);
});

const startHarness = (addon: MachLaunchAddon, record: Parameters<typeof sessionsDouble>[0]): Harness => {
  const isoName = `com.acp-iso.o4b-step2.${process.pid}.${randomUUID().slice(0, 8)}`;
  const pending = new Map<string, PendingLaunchCredential>();
  const audit = auditDouble();
  const sessions = sessionsDouble(record);
  const mcpLines: string[] = [];
  const dir = tempDir("acp-o4b-step2-");
  const children: ChildProcess[] = [];
  const groups: number[] = [];
  const reported: number[] = [];
  const reports: string[] = [];
  // A stand-in cto.mcp.sock: it captures the first line the relay writes, which is the credential it
  // claimed. Capturing it here is how the test sees a credential was handed over.
  const mcpSock = join(dir, "mcp.sock");
  const mcpServer: Server = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) {
        mcpLines.push(buf.subarray(0, nl).toString("utf8"));
        buf = buf.subarray(nl + 1);
      }
    });
    socket.on("error", () => {});
  });
  mcpServer.listen(mcpSock);

  const self: Harness = {
    isoName, pending, audit, sessions, mcpLines, dir, mcpSock, groups, handle: undefined as unknown as MachLaunchHandle,
    watcher: undefined as unknown as { wake(): void; stop(): void },
    beforeAdmit: null,
    spawnTree: (mode, externalSessionId) => {
      const report = join(dir, `report-${randomUUID().slice(0, 6)}`);
      const goFile = join(dir, `go-${randomUUID().slice(0, 6)}`);
      writeFileSync(report, "");
      const relayArgs = [RELAY_JS, "--addon", ADDON_PATH, "--iso-service", isoName, "--mcp", mcpSock, "--session", externalSessionId];
      const cliScript = join(dir, "cli.cjs");
      const holderScript = join(dir, "holder.cjs");
      writeFileSync(cliScript, `
        const { spawn } = require("node:child_process");
        const { appendFileSync, existsSync } = require("node:fs");
        const [report, goFile, count, ...relayArgs] = process.argv.slice(2);
        appendFileSync(report, "cli=" + process.pid + "\\n");
        const wait = setInterval(() => {
          if (!existsSync(goFile)) return;
          clearInterval(wait);
          for (let i = 0; i < Number(count); i++) {
            const relay = spawn(process.execPath, relayArgs, { stdio: ["ignore", "ignore", "ignore"] });
            appendFileSync(report, "relay=" + relay.pid + "\\n");
          }
        }, 10);
        setInterval(() => {}, 1 << 30);
      `);
      writeFileSync(holderScript, `
        const { spawn } = require("node:child_process");
        const { appendFileSync } = require("node:fs");
        const [mode, report, goFile, cliScript, count, ...relayArgs] = process.argv.slice(2);
        appendFileSync(report, "holder=" + process.pid + "\\n");
        if (mode === "holder-relay") {
          // Wrong shape: the holder starts the relay itself, so the sender is the holder's direct child.
          const { existsSync } = require("node:fs");
          const wait = setInterval(() => {
            if (!existsSync(goFile)) return;
            clearInterval(wait);
            const relay = spawn(process.execPath, relayArgs, { stdio: ["ignore", "ignore", "ignore"] });
            appendFileSync(report, "relay=" + relay.pid + "\\n");
          }, 10);
        } else {
          spawn(process.execPath, [cliScript, report, goFile, count, ...relayArgs], { stdio: ["ignore", "ignore", "ignore"] });
        }
        setInterval(() => {}, 1 << 30);
      `);
      const count = mode === "holder-cli-two-relays" ? "2" : "1";
      // Its own process group, so the CLI and relays it starts are killed with it even once reparented.
      const holder = spawn(process.execPath, [holderScript, mode, report, goFile, cliScript, count, ...relayArgs], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      children.push(holder);
      remember(holder.pid);
      if (holder.pid) groups.push(holder.pid);
      reports.push(report);
      return {
        report: (): Record<string, number> => {
          const map: Record<string, number> = {};
          for (const line of readFileSync(report, "utf8").split("\n")) {
            const [k, v] = line.split("=");
            if (k && v) {
              map[k] = Number(v);
              remember(map[k]);
              reported.push(map[k]!);
            }
          }
          return map;
        },
        go: () => writeFileSync(goFile, "go"),
        children,
      };
    },
  };

  const handle = addon.listen(isoName, (request: MachLaunchIncoming) => {
    const run = async (): Promise<void> => {
      if (self.beforeAdmit) await self.beforeAdmit(request);
      serveMachLaunchCredential(request, {
        pending, sessions, audit, addon, handle, mcpToken: MCP_TOKEN,
      });
    };
    void run();
  });
  (self as { handle: MachLaunchHandle }).handle = handle;
  // The daemon's own CLI pinning, exactly as the channel runs it: kernel reads only, nothing reported.
  const watcher = startCliPinWatcher(pending, addon);
  (self as { watcher: { wake(): void; stop(): void } }).watcher = watcher;

  harnesses.push({
    cleanup: async () => {
      // Every pid a tree reported, then every group killed and confirmed gone, reparented grandchildren included.
      for (const report of reports) {
        try {
          for (const line of readFileSync(report, "utf8").split("\n")) {
            const pid = Number(line.split("=")[1]);
            if (Number.isSafeInteger(pid) && pid > 1) { remember(pid); reported.push(pid); }
          }
        } catch { /* never written */ }
      }
      try {
        await killTrees(groups, [...children.map((child) => child.pid ?? 0).filter((pid) => pid > 1), ...reported]);
      } finally {
        watcher.stop();
        try { addon.close(handle); } catch { /* already closed */ }
        mcpServer.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
  return self;
};

/** Provisions one driven entry (a pinned turn) in the harness's pending map and returns its credential. */
const provision = (h: Harness, credential: SessionLaunchCredential & { sessionSecret: string }, holderPid: number): void => {
  h.pending.set(credential.externalSessionId, {
    credential: { ...credential, pin: { pid: holderPid, startToken: readProcessStartToken(holderPid) } },
    expiresAtMs: Date.now() + 60_000,
    door: "driven",
  });
  h.watcher.wake();
};

const deliveredCredential = (h: Harness, credential: { sessionSecret: string }): boolean =>
  h.mcpLines.some((line) => line.includes(credential.sessionSecret));
const refusals = (h: Harness): AuditRow[] => h.audit.rows.filter((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_REFUSED");
const lastRefusalReason = (h: Harness): string | undefined => refusals(h).at(-1)?.evidence["reason"] as string | undefined;

describe("O4b B' step 2 — a driven credential is handed over only over raw Mach, to the real turn shape", () => {
  it("positive: a real relay under the pinned holder → CLI takes the credential, and it reaches the MCP socket", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 3 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    const tree = h.spawnTree("holder-cli-relay", credential.externalSessionId);
    expect(await waitFor(() => "holder" in tree.report() && "cli" in tree.report(), 10_000)).toBe(true);
    provision(h, credential, tree.report()["holder"]!);
    tree.go();
    expect(await waitFor(() => deliveredCredential(h, credential), 15_000)).toBe(true);
    expect(h.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toBe(true);
    expect(h.pending.has(credential.externalSessionId)).toBe(false);
    expect(refusals(h)).toHaveLength(0);
  });

  it("W-SHAPE: the step-1 harness shape (the relay directly under the holder) is refused, no credential", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    const tree = h.spawnTree("holder-relay", credential.externalSessionId);
    expect(await waitFor(() => "holder" in tree.report(), 10_000)).toBe(true);
    provision(h, credential, tree.report()["holder"]!);
    tree.go();
    expect(await waitFor(() => refusals(h).length > 0, 15_000)).toBe(true);
    expect(lastRefusalReason(h)).toBe("NOT_HOLDER_GRANDCHILD");
    expect(deliveredCredential(h, credential)).toBe(false);
    expect(h.pending.has(credential.externalSessionId)).toBe(true);
  });

  /**
   * The real turn holder: `productionRunCli` with `reapProcessGroup`, as `runSessionTurn` runs it —
   * sandbox-exec → ksh (the pinned holder) → fork → /usr/bin/env → the CLI. The holder pin is taken in
   * `onSpawn` exactly as slice A takes it; the CLI pin is taken by the daemon's watcher from the kernel.
   */
  const runUnderRealHolder = async (h: Harness, credential: SessionLaunchCredential & { sessionSecret: string }, cliBody: string, name: string) => {
    const cliFile = join(h.dir, name);
    writeFileSync(cliFile, cliBody);
    chmodSync(cliFile, 0o755);
    const workdir = tempDir("acp-o4b-real-holder-");
    return cliAdapterTesting.productionRunCli(cliFile, [], {
      cwd: workdir, timeoutMs: 20_000, stdin: "", reapProcessGroup: true,
      onSpawn: (pid: number) => {
        // The holder leads its own group (`detached`); it is killed with that group at cleanup.
        remember(pid);
        h.groups.push(pid);
        provision(h, credential, pid);
      },
    });
  };
  const relayArgv = (h: Harness, externalSessionId: string): string[] =>
    [RELAY_JS, "--addon", ADDON_PATH, "--iso-service", h.isoName, "--mcp", h.mcpSock, "--session", externalSessionId];

  it("W-CLI-INITIAL-EXEC (positive): the CLI's normal start-up exec through the real holder is not flagged, and its relay is admitted", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    // A CLI that initialises (as claude does) before starting its MCP relay as its direct child, and never
    // execs again. It reached its image through ksh's fork and /usr/bin/env — two execs after the holder pin.
    const cli = `#!${process.execPath}
const { spawn } = require("node:child_process");
setTimeout(() => {
  const relay = spawn(process.execPath, ${JSON.stringify(relayArgv(h, credential.externalSessionId))}, { stdio: ["ignore", "ignore", "ignore"] });
  relay.on("close", () => process.exit(0));
}, 300);
`;
    const result = await runUnderRealHolder(h, credential, cli, "cli-initial-exec.cjs");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await waitFor(() => deliveredCredential(h, credential), 10_000)).toBe(true);
    expect(refusals(h)).toHaveLength(0);
    expect(h.pending.has(credential.externalSessionId)).toBe(false);
  });

  it("W-CLI-EXEC-AFTER-PIN (negative): a CLI that execs after its pin is refused CLI_EXEC_AFTER_PIN, no credential", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    // The reviewer's shape: the CLI starts its relay and then execs another image. Its pid, parent and BSD
    // start time are unchanged; its pidversion is not, and the pinned token says so.
    const relay = relayArgv(h, credential.externalSessionId).map((a) => `'${a}'`).join(" ");
    const cli = `#!/bin/bash
/bin/sleep 0.4
'${process.execPath}' ${relay} </dev/null >/dev/null 2>&1 &
exec /bin/sleep 3
`;
    await runUnderRealHolder(h, credential, cli, "cli-exec-after-pin.sh");
    expect(await waitFor(() => refusals(h).length > 0, 10_000)).toBe(true);
    expect(lastRefusalReason(h)).toMatch(/^CLI_EXEC_AFTER_PIN/);
    expect(deliveredCredential(h, credential)).toBe(false);
    expect(h.pending.has(credential.externalSessionId)).toBe(true);
  });

  it("W-DEAD / W-REUSE: the sender is dead before the daemon admits — SENDER_INSTANCE_GONE, no delivery", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    h.beforeAdmit = async (request) => {
      // Kill the sender (the relay) and wait until its own instance is gone by the kernel audit token:
      // this is the pid-reuse / dead-sender window AF_UNIX could not close.
      try { process.kill(request.sender.pid, "SIGKILL"); } catch { /* already gone */ }
      await waitFor(() => !addon.instanceLive(request.token), 5_000);
    };
    const tree = h.spawnTree("holder-cli-relay", credential.externalSessionId);
    expect(await waitFor(() => "holder" in tree.report() && "cli" in tree.report(), 10_000)).toBe(true);
    provision(h, credential, tree.report()["holder"]!);
    tree.go();
    expect(await waitFor(() => refusals(h).length > 0, 15_000)).toBe(true);
    expect(lastRefusalReason(h)).toMatch(/SENDER_INSTANCE_GONE/);
    expect(deliveredCredential(h, credential)).toBe(false);
    expect(h.pending.has(credential.externalSessionId)).toBe(true);
  });

  it("W-CLI-EXIT / W-REPARENT: the middle CLI dies during the check — refused on the parent chain, no delivery", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    let cliPid = 0;
    h.beforeAdmit = async (request) => {
      // The sender's parent is the CLI; kill it so the sender is reparented away from the pinned chain.
      const info = addon.bsdInfo(request.sender.pid);
      cliPid = info?.ppid ?? 0;
      if (cliPid > 1) { try { process.kill(cliPid, "SIGKILL"); } catch { /* gone */ } }
      await waitFor(() => { const i = addon.bsdInfo(request.sender.pid); return !i || i.ppid !== cliPid; }, 5_000);
    };
    const tree = h.spawnTree("holder-cli-relay", credential.externalSessionId);
    expect(await waitFor(() => "holder" in tree.report() && "cli" in tree.report(), 10_000)).toBe(true);
    provision(h, credential, tree.report()["holder"]!);
    tree.go();
    expect(await waitFor(() => refusals(h).length > 0, 15_000)).toBe(true);
    expect(lastRefusalReason(h)).toMatch(/SENDER_PARENT_CHANGED|CLI_UNREADABLE|NOT_HOLDER_GRANDCHILD/);
    expect(deliveredCredential(h, credential)).toBe(false);
    expect(h.pending.has(credential.externalSessionId)).toBe(true);
  });

  it("W-CONCURRENT: two valid relays under one holder → CLI get exactly one credential", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    const tree = h.spawnTree("holder-cli-two-relays", credential.externalSessionId);
    expect(await waitFor(() => "holder" in tree.report() && "cli" in tree.report(), 10_000)).toBe(true);
    provision(h, credential, tree.report()["holder"]!);
    tree.go();
    await waitFor(() => h.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED"), 15_000);
    await sleep(500);
    expect(h.audit.rows.filter((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toHaveLength(1);
    expect(h.mcpLines.filter((line) => line.includes(credential.sessionSecret))).toHaveLength(1);
    expect(h.pending.has(credential.externalSessionId)).toBe(false);
  });

  it("W-STALE: an entry whose secret no longer verifies, and a changed incarnation, are both refused", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    // Secret rotated out from under the entry: provision a credential whose secret the registry rejects.
    const staleSecret = { ...credential, sessionSecret: `${credential.sessionSecret}-old` };
    const tree = h.spawnTree("holder-cli-relay", staleSecret.externalSessionId);
    expect(await waitFor(() => "holder" in tree.report() && "cli" in tree.report(), 10_000)).toBe(true);
    provision(h, staleSecret, tree.report()["holder"]!);
    tree.go();
    expect(await waitFor(() => refusals(h).length > 0, 15_000)).toBe(true);
    expect(lastRefusalReason(h)).toBe("SECRET_STALE");
    expect(deliveredCredential(h, staleSecret)).toBe(false);
    // #1336 — the secret still verifies, but the session is no longer the incarnation the entry names.
    const staleIncarnation = { ...credential, externalSessionId: `${credential.externalSessionId}-inc`, sessionIncarnation: "inc-0" };
    const second = h.spawnTree("holder-cli-relay", staleIncarnation.externalSessionId);
    expect(await waitFor(() => "holder" in second.report() && "cli" in second.report(), 10_000)).toBe(true);
    provision(h, staleIncarnation, second.report()["holder"]!);
    second.go();
    expect(await waitFor(() => refusals(h).length > 1, 15_000)).toBe(true);
    expect(lastRefusalReason(h)).toBe("INCARNATION_STALE");
    expect(deliveredCredential(h, staleIncarnation)).toBe(false);
    expect(h.pending.has(staleIncarnation.externalSessionId)).toBe(true);
  });

  it("W-MALFORMED: a request body with no session id is refused MALFORMED and exposes no credential", async (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "x", incarnation: "inc-1", credentialEpoch: 1 };
    const h = startHarness(addon, record);
    // Claim directly from this process with a body the daemon cannot read as a session id.
    const result = await (addon as unknown as { claim(n: string, b: Buffer, t: number): Promise<{ code: string }> })
      .claim(h.isoName, Buffer.from("not-json"), 3_000);
    expect(result.code).toBe("MALFORMED_REQUEST");
    expect(h.mcpLines).toHaveLength(0);
  });

  it("W-CONCURRENT atomicity (unit): once consumed, the same admitted entry cannot be handed over twice", (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    // A token for a real, live process this test owns (itself), admitted by a pin that is its own parent
    // chain is not the point here — this exercises the consume-exactly-once and send-failure branches of
    // serveMachLaunchCredential directly with a fake addon whose respond is observable.
    const token = Buffer.alloc(32);
    const fakeAddon = {
      STATUS: addon.STATUS,
      instanceLive: () => true,
      bsdInfo: (pid: number) => (pid === 10 ? { ppid: 11, startSec: 1, startUsec: 1 } : pid === 11 ? { ppid: 12, startSec: 2, startUsec: 2 } : { ppid: 1, startSec: 3, startUsec: 3 }),
      respond: () => true,
    } as unknown as MachLaunchAddon;
    const pin = { pid: 12, startToken: "darwin-tv:3.000003" };
    h.pending.set(credential.externalSessionId, { credential: { ...credential, pin }, expiresAtMs: Date.now() + 60_000, door: "driven", cliPin: { pid: 11, token: Buffer.alloc(32) } });
    const request: MachLaunchIncoming = { id: 1, body: Buffer.from(JSON.stringify({ externalSessionId: credential.externalSessionId })), token, live: true, sender: { pid: 10, pidversion: 1, euid: 501 } };
    serveMachLaunchCredential(request, { pending: h.pending, sessions: h.sessions, audit: h.audit, addon: fakeAddon, handle: {}, mcpToken: MCP_TOKEN });
    serveMachLaunchCredential({ ...request, id: 2 }, { pending: h.pending, sessions: h.sessions, audit: h.audit, addon: fakeAddon, handle: {}, mcpToken: MCP_TOKEN });
    expect(h.audit.rows.filter((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toHaveLength(1);
    expect(lastRefusalReason(h)).toBe("ENTRY_UNKNOWN");
  });

  it("W-SENDFAIL: a failed reply send keeps the entry consumed and rotates the session secret", (ctx) => {
    const addon = requireMach(ctx);
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 5 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const h = startHarness(addon, record);
    const token = Buffer.alloc(32);
    const fakeAddon = {
      STATUS: addon.STATUS,
      instanceLive: () => true,
      bsdInfo: (pid: number) => (pid === 10 ? { ppid: 11, startSec: 1, startUsec: 1 } : pid === 11 ? { ppid: 12, startSec: 2, startUsec: 2 } : { ppid: 1, startSec: 3, startUsec: 3 }),
      respond: () => false, // the Mach reply send failed or is uncertain (MACH_SEND_INVALID_DEST, timeout)
    } as unknown as MachLaunchAddon;
    const pin = { pid: 12, startToken: "darwin-tv:3.000003" };
    h.pending.set(credential.externalSessionId, { credential: { ...credential, pin }, expiresAtMs: Date.now() + 60_000, door: "driven", cliPin: { pid: 11, token: Buffer.alloc(32) } });
    const request: MachLaunchIncoming = { id: 1, body: Buffer.from(JSON.stringify({ externalSessionId: credential.externalSessionId })), token, live: true, sender: { pid: 10, pidversion: 1, euid: 501 } };
    serveMachLaunchCredential(request, { pending: h.pending, sessions: h.sessions, audit: h.audit, addon: fakeAddon, handle: {}, mcpToken: MCP_TOKEN });
    expect(h.pending.has(credential.externalSessionId)).toBe(false); // not restored
    expect(h.sessions.rotations).toEqual([6]); // rotated from the epoch verifySecret returned
    expect(h.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED" && r.evidence["rotated"] === true)).toBe(true);
    expect(h.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toBe(false);
  });

  /**
   * #1336 — one admitted hand-over whose reply send is uncertain, on a fake addon whose admission passes and
   * whose `respond` is the test's: the entry is consumed, and what happens to the secret is the subject.
   */
  const sendUncertain = (
    addon: MachLaunchAddon,
    deps: { pending: Map<string, PendingLaunchCredential>; sessions: MachLaunchSessions; audit: Pick<ReturnType<typeof auditDouble>, "record">; custody?: MachLaunchCustody },
    credential: SessionLaunchCredential & { sessionSecret: string },
    respond: (handle: MachLaunchHandle, id: number, status: number, body?: Buffer) => boolean,
  ): void => {
    const fakeAddon = {
      STATUS: addon.STATUS,
      instanceLive: () => true,
      bsdInfo: (pid: number) => (pid === 10 ? { ppid: 11, startSec: 1, startUsec: 1 } : pid === 11 ? { ppid: 12, startSec: 2, startUsec: 2 } : { ppid: 1, startSec: 3, startUsec: 3 }),
      respond,
    } as unknown as MachLaunchAddon;
    const pin = { pid: 12, startToken: "darwin-tv:3.000003" };
    deps.pending.set(credential.externalSessionId, { credential: { ...credential, pin }, expiresAtMs: Date.now() + 60_000, door: "driven", cliPin: { pid: 11, token: Buffer.alloc(32) } });
    const request: MachLaunchIncoming = { id: 1, body: Buffer.from(JSON.stringify({ externalSessionId: credential.externalSessionId })), token: Buffer.alloc(32), live: true, sender: { pid: 10, pidversion: 1, euid: 501 } };
    serveMachLaunchCredential(request, { ...deps, addon: fakeAddon, handle: {}, mcpToken: MCP_TOKEN });
  };
  const sendFailures = (audit: ReturnType<typeof auditDouble>) => audit.rows.filter((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED");
  /** A real registry's session, READY or DRAINING, with the credential a driven turn's entry would carry. */
  const realSession = (lifecycle: typeof SessionLifecycle.READY | typeof SessionLifecycle.DRAINING) => {
    const harness = makeHarness();
    const created = harness.cp.sessions.create({ provider: "claude", model: "o4b-send-uncertain" });
    expect(harness.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "fixture").allowed).toBe(true);
    if (lifecycle === SessionLifecycle.DRAINING) {
      expect(harness.cp.sessions.transition(created.sessionId, SessionLifecycle.DRAINING, "fixture").allowed).toBe(true);
    }
    const session = harness.cp.sessions.require(created.sessionId);
    const credential = {
      sessionId: session.sessionId,
      sessionIncarnation: session.incarnation,
      externalSessionId: `ext-${session.sessionId}`,
      sessionSecret: created.sessionSecret!,
    };
    return { harness, sessions: harness.cp.sessions, credential, epoch: session.credentialEpoch };
  };

  it("#1336 W-SENDTHROW: a respond that throws goes down the same path as one that returns false", (ctx) => {
    const addon = requireMach(ctx);
    const outcome = (respond: () => boolean) => {
      const record = { sessionId: "s-send", sessionSecret: "", incarnation: "inc-1", credentialEpoch: 5 };
      const credential = credentialOf(record.sessionId);
      record.sessionSecret = credential.sessionSecret;
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions: sessionsDouble(record), audit: auditDouble() };
      expect(() => sendUncertain(addon, deps, credential, respond)).not.toThrow();
      return {
        pending: deps.pending.size,
        rotations: deps.sessions.rotations,
        secretStillVerifies: deps.sessions.verifySecret(record.sessionId, credential.sessionSecret).allowed,
        delivered: deps.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED"),
        failures: sendFailures(deps.audit).map((r) => ({ reasonCode: r.reasonCode, evidence: { ...r.evidence, send: "-" } })),
        sends: sendFailures(deps.audit).map((r) => r.evidence["send"]),
      };
    };
    const returnedFalse = outcome(() => false);
    const threw = outcome(() => { throw new Error("mach_msg send raised"); });
    expect(returnedFalse).toMatchObject({ pending: 0, rotations: [6], secretStillVerifies: false, delivered: false, sends: ["FALSE"] });
    expect(returnedFalse.failures).toEqual([{ reasonCode: ReasonCode.MACH_LAUNCH_SEND_FAILED, evidence: { transport: "mach", send: "-", rotated: true, invalidated: "ROTATED" } }]);
    expect(threw.sends).toEqual(["THREW"]);
    expect({ ...threw, sends: null }).toEqual({ ...returnedFalse, sends: null });
  });

  it("#1336 W-ROTATE-REFUSED-STILL-VALID: a refused rotation whose secret still verifies blocks the session", (ctx) => {
    const addon = requireMach(ctx);
    // A real registry: a DRAINING session's secret still verifies, and its credential is not rotated.
    const { harness, sessions, credential, epoch } = realSession(SessionLifecycle.DRAINING);
    try {
      expect(sessions.verifySecret(credential.sessionId, credential.sessionSecret).allowed).toBe(true);
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions, audit: auditDouble() };
      sendUncertain(addon, deps, credential, () => false);
      expect(deps.pending.size).toBe(0); // not restored
      expect(sendFailures(deps.audit)).toEqual([{
        kind: "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED",
        reasonCode: ReasonCode.MACH_LAUNCH_SECRET_NOT_INVALIDATED,
        evidence: { transport: "mach", send: "FALSE", rotated: false, invalidated: "SESSION_BLOCKED", rotationRefused: ReasonCode.SESSION_NOT_READY, blocked: true, custodyReleased: false },
      }]);
      // Blocked through the registry's own path: the secret authenticates nothing, nothing can re-credential it.
      const after = sessions.require(credential.sessionId);
      expect(after.lifecycle).toBe(SessionLifecycle.ERROR);
      expect(after.credentialEpoch).toBe(epoch);
      expect(sessions.verifySecret(credential.sessionId, credential.sessionSecret).allowed).toBe(false);
      expect(sessions.rotateSecret(credential.sessionId, epoch).allowed).toBe(false);
      expect(deps.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toBe(false);
    } finally {
      harness.cp.close();
    }
  });

  it("#1336 W-ROTATE-REFUSED-EPOCH-MOVED: a rotation refused because the epoch already moved leaves the session alone", (ctx) => {
    const addon = requireMach(ctx);
    const { harness, sessions, credential, epoch } = realSession(SessionLifecycle.READY);
    try {
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions, audit: auditDouble() };
      // The epoch moves while the reply is in flight (another rotation of the session), and the send is uncertain.
      sendUncertain(addon, deps, credential, () => {
        expect(sessions.rotateSecret(credential.sessionId, epoch).allowed).toBe(true);
        return false;
      });
      expect(deps.pending.size).toBe(0);
      expect(sendFailures(deps.audit)).toEqual([{
        kind: "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED",
        reasonCode: ReasonCode.MACH_LAUNCH_SEND_FAILED,
        evidence: { transport: "mach", send: "FALSE", rotated: false, invalidated: "ALREADY_INVALID", rotationRefused: ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE },
      }]);
      // The old secret is already dead; the session is not blocked and keeps the epoch the other rotation set.
      expect(sessions.verifySecret(credential.sessionId, credential.sessionSecret).allowed).toBe(false);
      expect(sessions.require(credential.sessionId)).toMatchObject({ lifecycle: SessionLifecycle.READY, credentialEpoch: epoch + 1 });
    } finally {
      harness.cp.close();
    }
  });

  /**
   * #1336 N-1 — a registry whose `rotateSecret`, `verifySecret` or `transition` throws once armed (armed by
   * the uncertain send itself, so the admission before it reads the real registry), and the session runtime's
   * real custody of the session's credential, which the block must drop.
   */
  const faultySession = (lifecycle: typeof SessionLifecycle.READY | typeof SessionLifecycle.DRAINING, faults: {
    rotateSecret?: boolean; verifySecretOnce?: boolean; transition?: boolean;
  }) => {
    const real = realSession(lifecycle);
    const { cp } = real.harness;
    expect(cp.sessionRuntime.adopt(real.credential.sessionId, Role.BOOTSTRAP_CTO, real.credential.sessionSecret, real.epoch).allowed).toBe(true);
    expect(cp.sessionRuntime.holds(real.credential.sessionId)).toBe(true);
    let armed = false;
    let verifyFaults = faults.verifySecretOnce ? 1 : 0;
    const sessions: MachLaunchSessions = {
      get: (id) => real.sessions.get(id),
      rotateSecret: (id, epoch) => {
        if (armed && faults.rotateSecret) throw new Error("SQLITE_IOERR: disk I/O error (rotateSecret)");
        return real.sessions.rotateSecret(id, epoch);
      },
      verifySecret: (id, secret) => {
        if (armed && verifyFaults > 0) { verifyFaults -= 1; throw new Error("SQLITE_IOERR: disk I/O error (verifySecret)"); }
        return real.sessions.verifySecret(id, secret);
      },
      transition: (id, to, reason) => {
        if (armed && faults.transition) throw new Error("SQLITE_IOERR: disk I/O error (transition)");
        return real.sessions.transition(id, to, reason);
      },
    };
    const custody: MachLaunchCustody = { release: (id) => cp.sessionRuntime.release(id) };
    return { ...real, cp, sessions, custody, arm: () => { armed = true; } };
  };

  it("#1336 N-1 W-ROTATE-THREW: a rotateSecret that throws after an uncertain send blocks the session, drops its custody, and is audited", (ctx) => {
    const addon = requireMach(ctx);
    const f = faultySession(SessionLifecycle.READY, { rotateSecret: true });
    try {
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions: f.sessions, audit: auditDouble(), custody: f.custody };
      // The daemon stays up: nothing escapes the Mach callback.
      expect(() => sendUncertain(addon, deps, f.credential, () => { f.arm(); return false; })).not.toThrow();
      expect(sendFailures(deps.audit)).toEqual([{
        kind: "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED",
        reasonCode: ReasonCode.MACH_LAUNCH_SECRET_NOT_INVALIDATED,
        evidence: { transport: "mach", send: "FALSE", rotated: false, invalidated: "SESSION_BLOCKED", invalidationFailed: "SQLITE_IOERR: disk I/O error (rotateSecret)", blocked: true, custodyReleased: true },
      }]);
      // Unusable for turns and redelivery: ERROR, its secret refused, the runtime no longer holds a credential for it.
      expect(f.cp.sessions.require(f.credential.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(f.cp.sessions.verifySecret(f.credential.sessionId, f.credential.sessionSecret).allowed).toBe(false);
      expect(f.cp.sessionRuntime.holds(f.credential.sessionId)).toBe(false);
      expect(deps.pending.size).toBe(0);
    } finally {
      f.harness.cp.close();
    }
  });

  it("#1336 N-1 W-VERIFY-THREW: a verifySecret that throws after a refused rotation blocks the session, drops its custody, and is audited", (ctx) => {
    const addon = requireMach(ctx);
    // DRAINING: the rotation is refused, so the check of the old secret runs, and it throws.
    const f = faultySession(SessionLifecycle.DRAINING, { verifySecretOnce: true });
    try {
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions: f.sessions, audit: auditDouble(), custody: f.custody };
      expect(() => sendUncertain(addon, deps, f.credential, () => { f.arm(); return false; })).not.toThrow();
      expect(sendFailures(deps.audit)).toEqual([{
        kind: "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED",
        reasonCode: ReasonCode.MACH_LAUNCH_SECRET_NOT_INVALIDATED,
        evidence: { transport: "mach", send: "FALSE", rotated: false, invalidated: "SESSION_BLOCKED", invalidationFailed: "SQLITE_IOERR: disk I/O error (verifySecret)", blocked: true, custodyReleased: true },
      }]);
      expect(f.cp.sessions.require(f.credential.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(f.cp.sessions.verifySecret(f.credential.sessionId, f.credential.sessionSecret).allowed).toBe(false);
      expect(f.cp.sessionRuntime.holds(f.credential.sessionId)).toBe(false);
    } finally {
      f.harness.cp.close();
    }
  });

  it("#1336 N-1 W-DB-DOWN: with the registry and the audit log both failing, custody is still dropped and the reason is stated, never the secret", (ctx) => {
    const addon = requireMach(ctx);
    const f = faultySession(SessionLifecycle.READY, { rotateSecret: true, transition: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const audit = { record: () => { throw new Error("SQLITE_IOERR: disk I/O error (audit)"); } };
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions: f.sessions, audit, custody: f.custody };
      expect(() => sendUncertain(addon, deps, f.credential, () => { f.arm(); return false; })).not.toThrow();
      const stated = stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("session launch: "));
      expect(stated).toEqual([
        `session launch: ${ReasonCode.MACH_LAUNCH_SECRET_NOT_INVALIDATED} for ${f.credential.sessionId} could not be audited: SQLITE_IOERR: disk I/O error (audit)\n`,
      ]);
      expect(stated.join("")).not.toContain(f.credential.sessionSecret);
      // ERROR could not be written, so the block that remains is the dropped custody: no turn of it runs.
      expect(f.cp.sessionRuntime.holds(f.credential.sessionId)).toBe(false);
      expect(f.cp.sessions.require(f.credential.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    } finally {
      stderr.mockRestore();
      f.harness.cp.close();
    }
  });

  /**
   * #1336 R-1 — one MCP connection kept open across requests, so a request after the block is judged by the
   * connection's per-request re-authentication rather than by a new handshake.
   */
  const openMcpConnection = async (socketPath: string, credential: { token: string; sessionId: string; sessionSecret: string }) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const waiters = new Map<number, (reply: Record<string, unknown>) => void>();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { structuredContent?: Record<string, unknown> } };
          if (typeof message.id === "number") waiters.get(message.id)?.(message.result?.structuredContent ?? (message as Record<string, unknown>));
        } catch { /* not a JSON-RPC line */ }
      }
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    let next = 1;
    const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = next++;
      const answered = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answered;
    };
    socket.write(`${JSON.stringify(credential)}\n`);
    await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "r1-witness", version: "1" } });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return {
      call: (name: string, args: Record<string, unknown>) => request("tools/call", { name, arguments: args }),
      close: () => socket.destroy(),
    };
  };

  /**
   * #1336 R-1 — W-DB-DOWN's state on a real control plane: an uncertain send while the database is down, so
   * rotation, the ERROR write and the audit all throw, and the runtime's custody is dropped. The database
   * reads again afterwards; the row is still READY.
   */
  const blockWithDatabaseDown = (addon: MachLaunchAddon, cp: BootstrapRuntimeFixture["harness"]["cp"], sessionId: string, sessionSecret: string): void => {
    let armed = false;
    const failing = (what: string) => () => { throw new Error(`SQLITE_IOERR: disk I/O error (${what})`); };
    const sessions: MachLaunchSessions = {
      get: (id) => cp.sessions.get(id),
      verifySecret: (id, secret) => cp.sessions.verifySecret(id, secret),
      rotateSecret: (id, epoch) => (armed ? failing("rotateSecret")() : cp.sessions.rotateSecret(id, epoch)),
      transition: (id, to, reason) => (armed ? failing("transition")() : cp.sessions.transition(id, to, reason)),
    };
    const session = cp.sessions.require(sessionId);
    const credential = { sessionId, sessionIncarnation: session.incarnation, externalSessionId: `ext-${sessionId}`, sessionSecret };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      sendUncertain(addon, {
        pending: new Map<string, PendingLaunchCredential>(), sessions, audit: { record: failing("audit") },
        custody: { release: (id) => cp.sessionRuntime.release(id) },
      }, credential, () => { armed = true; return false; });
    } finally {
      stderr.mockRestore();
    }
    expect(cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.sessionRuntime.holds(sessionId)).toBe(false);
  };

  it("#1336 R-1 W-SAME-RUN: after the database-down block, with the database readable again, the old secret is refused at socket authentication", async (ctx) => {
    const addon = requireMach(ctx);
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "r1-same-run");
      const held = f.claude.credentials.get(binding.sessionId)!;
      const as = { token: BOOTSTRAP_FIXTURE_TOKEN, sessionId: held.sessionId, sessionSecret: held.sessionSecret };
      const open = await openMcpConnection(f.ctoSocket, as);
      try {
        expect(await open.call("role_dispatch_pending", {})).toMatchObject({ ok: true });
        blockWithDatabaseDown(addon, cp, binding.sessionId, held.sessionSecret);
        // The database reads again, and on its own it would still accept the old secret: the row is READY.
        expect(cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);
        expect(cp.sessions.verifySecret(binding.sessionId, held.sessionSecret).allowed).toBe(true);
        expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(false);
        // The connection opened before the block: its next request is refused.
        expect(await open.call("role_dispatch_pending", {})).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
        // A new connection: refused at the handshake, naming why, never the secret.
        const fresh = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
        expect(fresh).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, evidence: { reason: "DRIVEN_CREDENTIAL_NOT_HELD" } });
        expect(JSON.stringify(fresh)).not.toContain(held.sessionSecret);
      } finally {
        open.close();
      }
    });
  });

  it("#1336 R-1 W-ATTACH: role-attachment issue and revoke take a held driven secret, and refuse it after the database-down block", async (ctx) => {
    const addon = requireMach(ctx);
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      // The daemon's own attachment authority, as the operator socket reaches it.
      const attachments = f.daemon.attachments;
      const { binding } = await drivenPrimary(f, "r1-attach");
      const held = f.claude.credentials.get(binding.sessionId)!;
      const subject = { sessionId: binding.sessionId, sessionSecret: held.sessionSecret };
      expect(cp.sessionRuntime.drivesSession(binding.sessionId, Role.PRIMARY_CTO)).toBe(true);
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
      // Held: a driven primary issues and revokes as before.
      const first = attachments.issue({ ...subject, roleKey: binding.roleKey });
      expect(first).toMatchObject({ allowed: true });
      expect(attachments.revoke({ ...subject, attachmentId: first.allowed ? first.value.attachmentId : "" })).toMatchObject({ allowed: true });
      const kept = attachments.issue({ ...subject, roleKey: binding.roleKey });
      expect(kept).toMatchObject({ allowed: true });

      blockWithDatabaseDown(addon, cp, binding.sessionId, held.sessionSecret);
      expect(cp.sessions.verifySecret(binding.sessionId, held.sessionSecret).allowed).toBe(true);
      const notHeld = { allowed: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, evidence: { sessionId: binding.sessionId, reason: "DRIVEN_CREDENTIAL_NOT_HELD" } };
      // Each door on its own: a refusal of one does not hide the other.
      expect.soft(attachments.issue({ ...subject, roleKey: binding.roleKey })).toMatchObject(notHeld);
      expect.soft(attachments.revoke({ ...subject, attachmentId: kept.allowed ? kept.value.attachmentId : "" })).toMatchObject(notHeld);
    });
  });

  it("#1336 R-1 control: an interactive primary CTO's socket authentication does not depend on the runtime holding anything", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { projectId } = await registerFixtureProject(f.harness, "r1-interactive");
      const created = cp.sessions.create({ provider: "scripted", model: "r1-interactive-cto" });
      expect(cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "fixture").allowed).toBe(true);
      expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: created.sessionId }).allowed).toBe(true);
      expect(cp.sessionRuntime.drivesSession(created.sessionId, Role.PRIMARY_CTO)).toBe(false);
      expect(cp.sessionRuntime.holds(created.sessionId)).toBe(false);
      const as = { token: BOOTSTRAP_FIXTURE_TOKEN, sessionId: created.sessionId, sessionSecret: created.sessionSecret! };
      expect(await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {})).toMatchObject({ ok: true });
      const open = await openMcpConnection(f.ctoSocket, as);
      try {
        expect(await open.call("role_dispatch_pending", {})).toMatchObject({ ok: true });
        expect(await open.call("role_dispatch_pending", {})).toMatchObject({ ok: true });
      } finally {
        open.close();
      }
      // And its role-attachment issue and revoke, with nothing held for it.
      const roleKey = cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))!.roleKey;
      const subject = { sessionId: created.sessionId, sessionSecret: created.sessionSecret! };
      const issued = f.daemon.attachments.issue({ ...subject, roleKey });
      expect(issued).toMatchObject({ allowed: true });
      expect(f.daemon.attachments.revoke({ ...subject, attachmentId: issued.allowed ? issued.value.attachmentId : "" })).toMatchObject({ allowed: true });
    });
  });

  it("#1336 N-2: a respond that throws is followed by a best-effort REFUSED answer, itself guarded", (ctx) => {
    const addon = requireMach(ctx);
    const run = (refusedThrows: boolean) => {
      const record = { sessionId: "s-n2", sessionSecret: "", incarnation: "inc-1", credentialEpoch: 2 };
      const credential = credentialOf(record.sessionId);
      record.sessionSecret = credential.sessionSecret;
      const calls: Array<{ status: number; body: string }> = [];
      const deps = { pending: new Map<string, PendingLaunchCredential>(), sessions: sessionsDouble(record), audit: auditDouble() };
      expect(() => sendUncertain(addon, deps, credential, (_handle, _id, status, body) => {
        calls.push({ status, body: body?.toString("utf8") ?? "" });
        if (status === addon.STATUS.OK || refusedThrows) throw new Error("respond raised");
        return true;
      })).not.toThrow();
      return { statuses: calls.map((c) => c.status), refusedBody: calls[1]?.body, secretInRefusal: calls[1]?.body.includes(credential.sessionSecret), sends: sendFailures(deps.audit).map((r) => r.evidence["send"]) };
    };
    expect(run(false)).toEqual({ statuses: [addon.STATUS.OK, addon.STATUS.REFUSED], refusedBody: "SEND_UNCERTAIN", secretInRefusal: false, sends: ["THREW"] });
    expect(run(true)).toEqual({ statuses: [addon.STATUS.OK, addon.STATUS.REFUSED], refusedBody: "SEND_UNCERTAIN", secretInRefusal: false, sends: ["THREW"] });
  });

  it("the admission function admits the real shape and refuses a holder-pin whose start token moved", (ctx) => {
    requireMach(ctx);
    // A pure check of the pin binding: a holder whose start token differs from the pin is refused even
    // when the depth is right. Uses this process's own live ancestry as the readers' source of truth.
    const readers = { instanceLive: () => true, bsdInfo: (pid: number) => (ADDON as MachLaunchAddon).bsdInfo(pid) };
    const self = process.pid;
    const parent = readers.bsdInfo(self)!.ppid;
    const grandparent = readers.bsdInfo(parent)!.ppid;
    const token = Buffer.alloc(32);
    const good = admitMachLaunchGrandchild(readers, self, token, {
      pid: grandparent, startToken: `darwin-tv:${readers.bsdInfo(grandparent)!.startSec}.${String(readers.bsdInfo(grandparent)!.startUsec).padStart(6, "0")}`,
    }, { pid: parent, token });
    expect(good.allowed).toBe(true);
    const moved = admitMachLaunchGrandchild(readers, self, token, { pid: grandparent, startToken: "darwin-tv:1.000000" }, { pid: parent, token });
    expect(moved.allowed).toBe(false);
    if (!moved.allowed) expect(moved.message).toBe("HOLDER_NOT_PINNED");
  });
});

describe("O4b B' step 2 — resource-safety branches expose no credential and leak no port or thread (CEO item 4)", () => {
  // The step-1 thread/port counter, loaded only to confirm the receive thread and the service ports
  // return to baseline. It is read from a local evidence path that a CI runner does not have, so on CI it is
  // absent and the thread and port-count assertions below do not run there (the log says which:
  // MACH_DIAG_CHECKS); the native close() `released` flag is then the only no-leak statement.
  const DIAG = (() => {
    const p = "/Users/isaac/.claude/jobs/cto-restart/evidence/o4b-mach-step1/harness/diag.node";
    if (process.platform !== "darwin" || !existsSync(p)) return null;
    try {
      const m = { exports: {} as { threads(): { name: string; state: string }[]; ports(): { names: number } } };
      process.dlopen(m, p);
      return m.exports;
    } catch { return null; }
  })();
  const receiveThreads = (): number => (DIAG ? DIAG.threads().filter((t) => t.name === "acp.mach-launch.receive").length : -1);
  const isoName = (tag: string) => `com.acp-iso.o4b-step2-${tag}.${process.pid}.${randomUUID().slice(0, 8)}`;
  const serveDeps = (addon: MachLaunchAddon, handle: MachLaunchHandle, pending: Map<string, PendingLaunchCredential>, record: Parameters<typeof sessionsDouble>[0]) =>
    ({ pending, sessions: sessionsDouble(record), audit: auditDouble(), addon, handle, mcpToken: MCP_TOKEN });

  it("W-BUSY: past its pending cap the service refuses further requests BUSY, before admission and with no credential", async (ctx) => {
    const addon = requireMach(ctx);
    const iso = isoName("busy");
    const held: number[] = [];
    // A holder callback that records each request and never answers, so the native pending table fills.
    const handle = addon.listen(iso, (req: MachLaunchIncoming) => { held.push(req.id); });
    const codes: string[] = [];
    // Each claim delivers its request (which the callback holds) and times its own receive out, leaving a
    // held entry behind; once the cap is reached the addon answers further requests BUSY itself, before
    // the callback runs. No reply ever carries a credential.
    for (let i = 0; i < 80; i++) {
      const r = await claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: `busy-${i}` })), 30);
      codes.push(r.code);
    }
    expect(codes).toContain("BUSY");
    expect(codes).not.toContain("OK");
    const closed = addon.close(handle);
    expect(closed.released).toBe(true);
    expect(receiveThreads()).toBeLessThanOrEqual(0); // -1 when no diag, 0 when the receive thread joined
  });

  it("W-DURING-STOP: requests already at the callback when close runs, and one sent after close completed, are refused, no credential, thread and ports back to baseline", async (ctx) => {
    const addon = requireMach(ctx);
    const iso = isoName("stop");
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "valid", incarnation: "inc-1", credentialEpoch: 1 };
    const held: number[] = [];
    // A callback that holds every request (a slow daemon): the entries are valid and would be served, but
    // close() must refuse them first. Nothing is ever answered OK here.
    const handle = addon.listen(iso, (req: MachLaunchIncoming) => { held.push(req.id); });
    const inFlight: Array<Promise<{ code: string; body?: Buffer }>> = [];
    for (let i = 0; i < 4; i++) inFlight.push(claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: `stop-${i}` })), 10_000));
    await waitFor(() => held.length >= 4, 5_000);
    expect(receiveThreads()).toBeLessThanOrEqual(1); // 1 with diag, -1 without
    const threadsAtListen = receiveThreads();
    const closed = addon.close(handle);
    expect(closed.released).toBe(true);
    expect(closed.refused + closed.drained).toBeGreaterThanOrEqual(4); // every in-flight request refused, none served
    const results = await Promise.all(inFlight);
    expect(results.every((r) => r.code !== "OK")).toBe(true);
    // One sent after close completed finds no service. A request arriving while close() runs is not covered here.
    const late = await claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: "late" })), 1_000);
    expect(late.code).not.toBe("OK");
    process.stdout.write(`MACH_DIAG_CHECKS ${DIAG ? "ran" : "skipped (no step-1 diag addon on this host)"}\n`);
    if (DIAG) { expect(threadsAtListen).toBe(1); expect(receiveThreads()).toBe(0); } // the receive thread joined; none leaked
    // No per-cycle leak: a second identical held-then-close cycle leaves the port-name count where the first
    // left it (the first concurrent claims allocate threadpool state once; measured 27 -> 31 -> 31 ...).
    if (DIAG) {
      const cycle = async (tag: string): Promise<number> => {
        const name = isoName(tag);
        const got: number[] = [];
        const h2 = addon.listen(name, (req: MachLaunchIncoming) => { got.push(req.id); });
        const p2 = [0, 1, 2, 3].map((i) => claimFrom(addon, name, Buffer.from(JSON.stringify({ externalSessionId: `c-${i}` })), 5_000));
        await waitFor(() => got.length >= 4, 5_000);
        expect(addon.close(h2).released).toBe(true);
        expect((await Promise.all(p2)).every((r) => r.code !== "OK")).toBe(true);
        await sleep(50);
        return DIAG.ports().names;
      };
      const first = await cycle("stop-c1");
      expect(await cycle("stop-c2")).toBe(first);
    }
    void record;
  });

  it("the kernel-queue drain at close is attempted and its count reported; it does not force or prove that any request was still queued", async (ctx) => {
    const addon = requireMach(ctx);
    const iso = isoName("drain");
    const handle = addon.listen(iso, (req: MachLaunchIncoming) => { void req; });
    // Fire a burst without awaiting and close at once, to try to leave requests in the kernel port queue
    // when the receive thread stops. drained counts those answered STOPPING by close()'s own drain.
    for (let i = 0; i < 40; i++) void claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: `drain-${i}` })), 1_000).catch(() => {});
    const closed = addon.close(handle);
    process.stdout.write(`KERNEL_DRAIN_RESULT drained=${closed.drained} refused=${closed.refused} released=${closed.released}\n`);
    expect(closed.released).toBe(true); // either way, no port or thread is leaked
  });

  it("W-OVERSIZED: an oversized claim body is refused before any send; a maximum-size body is received, refused without overflow, and its resources released", async (ctx) => {
    const addon = requireMach(ctx);
    const iso = isoName("oversized");
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "x", incarnation: "inc-1", credentialEpoch: 1 };
    const handle: MachLaunchHandle = addon.listen(iso, (req: MachLaunchIncoming) => serveMachLaunchCredential(req, serveDeps(addon, handle, new Map(), record)));
    // A body larger than the addon's maximum is rejected locally; nothing is sent.
    expect(() => claimFrom(addon, iso, Buffer.alloc(addon.MAX_BODY + 1), 1_000)).toThrow();
    // A maximum-size body that is not a session id is received and refused MALFORMED — the fixed receive
    // buffer holds it with no overflow — and the claim returns, its reply port released.
    const max = await claimFrom(addon, iso, Buffer.alloc(addon.MAX_BODY, 0x20), 3_000);
    expect(["MALFORMED_REQUEST", "REFUSED"]).toContain(max.code);
    expect(max.body === undefined || !max.body.toString("utf8").includes("secret")).toBe(true);
    const closed = addon.close(handle);
    expect(closed.released).toBe(true);
  });

  it("#1336 W-CALLBACK-THREW: a request whose JS callback throws is answered REFUSED at once, its reply right not held until close", (ctx) => {
    requireMach(ctx);
    // In a child process, so the callback's uncaught Node-API exception stays out of this worker. The daemon
    // side runs on the in-tree build, exactly as `loadMachLaunchAddon` loads it from a source checkout.
    const script = `
      const addon = require(${JSON.stringify(join(process.cwd(), "native/mach-launch/build/Release/mach_launch.node"))});
      process.on("uncaughtException", () => {});
      const name = ${JSON.stringify(isoName("threw"))};
      const handle = addon.listen(name, () => { throw new Error("the callback threw"); });
      const started = Date.now();
      addon.claim(name, Buffer.from(JSON.stringify({ externalSessionId: "x" })), 3000).then((r) => {
        const elapsedMs = Date.now() - started;
        const closed = addon.close(handle);
        process.stdout.write(JSON.stringify({ code: r.code, answeredBeforeTimeout: elapsedMs < 2500, heldUntilClose: closed.refused, released: closed.released }));
        process.exit(0);
      });`;
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ code: "REFUSED", answeredBeforeTimeout: true, heldUntilClose: 0, released: true });
  });

  it("W-PREV-INSTANCE: a request for a previous instance's entry, delivered to a new instance on the same name, is refused with no credential and no reissue", async (ctx) => {
    const addon = requireMach(ctx);
    const iso = isoName("prev");
    const recordA = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credE = credentialOf(recordA.sessionId);
    recordA.sessionSecret = credE.sessionSecret;
    // Instance A owns the service and holds entry E (pinned to this live process so lineage is not the
    // reason it is refused later). A is torn down before anything claims E.
    const pendingA = new Map<string, PendingLaunchCredential>();
    pendingA.set(credE.externalSessionId, { credential: { ...credE, pin: { pid: process.pid, startToken: readProcessStartToken(process.pid) } }, expiresAtMs: Date.now() + 60_000, door: "driven" });
    const handleA: MachLaunchHandle = addon.listen(iso, (req: MachLaunchIncoming) => serveMachLaunchCredential(req, { ...serveDeps(addon, handleA, pendingA, recordA) }));
    expect(addon.close(handleA).released).toBe(true);
    // Instance B checks in on the same name with its own pending, which has never heard of E.
    const recordB = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "y", incarnation: "inc-1", credentialEpoch: 1 };
    const auditB = auditDouble();
    const handleB: MachLaunchHandle = addon.listen(iso, (req: MachLaunchIncoming) =>
      serveMachLaunchCredential(req, { pending: new Map<string, PendingLaunchCredential>(), sessions: sessionsDouble(recordB), audit: auditB, addon, handle: handleB, mcpToken: MCP_TOKEN }));
    try {
      const r = await claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: credE.externalSessionId })), 3_000);
      expect(r.code).toBe("REFUSED");
      expect(auditB.rows.find((x) => x.kind === "SESSION_LAUNCH_CREDENTIAL_REFUSED")?.evidence["reason"]).toBe("ENTRY_UNKNOWN");
      expect(auditB.rows.some((x) => x.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toBe(false);
      expect(r.body === undefined || !r.body.toString("utf8").includes(credE.sessionSecret)).toBe(true);
    } finally {
      addon.close(handleB);
    }
  });
});

describe("O4b B' step 2 — a #738-refused daemon drains the launch queue and serves nothing", () => {
  it("W-738-DRAIN: the refusal drain has no answering path of its own and releases the service; every queued request is refused STOPPING", async (ctx) => {
    const addon = requireMach(ctx);
    // With a recording double: the drain checks in, never calls respond, and closes exactly once.
    const calls: string[] = [];
    const spy = {
      ...addon,
      STATUS: addon.STATUS,
      listen: (name: string, cb: (r: MachLaunchIncoming) => void) => { calls.push(`listen:${name === "iso-drain" ? "iso" : name}`); void cb; return {}; },
      respond: () => { calls.push("respond"); return true; },
      close: () => { calls.push("close"); return { drained: 0, refused: 0, released: true }; },
    } as unknown as MachLaunchAddon;
    expect(drainMachLaunchQueueOnRefusal("iso-drain", () => spy)).toEqual({ drained: 0, refused: 0, released: true });
    expect(calls).toEqual(["listen:iso", "close"]);
    // With the real addon: requests held by a previous holder of the name are answered STOPPING by the
    // drain's own check-in/close, never OK, and the service's rights are released.
    const iso = `com.acp-iso.o4b-step2-drain738.${process.pid}.${randomUUID().slice(0, 8)}`;
    const inflight = [0, 1, 2].map((i) => claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: `q-${i}` })), 3_000));
    const result = drainMachLaunchQueueOnRefusal(iso, () => addon);
    expect(result?.released).toBe(true);
    const codes = (await Promise.all(inflight)).map((r) => r.code);
    expect(codes).not.toContain("OK");
    // The loader failing (no addon) returns null: nothing is checked in and nothing is answered.
    expect(drainMachLaunchQueueOnRefusal(iso, () => { throw new Error("no addon"); })).toBeNull();
  });
});

/** One id-only request on `cto.launch.sock`: the parsed reply and the raw line, so a test can look for the secret in it. */
const askAfUnix = (socketPath: string, externalSessionId: string): Promise<{ reply: Record<string, unknown>; raw: string }> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath, () => socket.write(`${JSON.stringify({ externalSessionId })}\n`));
    let buf = "";
    socket.on("data", (c) => { buf += c.toString("utf8"); if (buf.includes("\n")) { resolve({ reply: JSON.parse(buf.trim()) as Record<string, unknown>, raw: buf }); socket.destroy(); } });
    socket.on("error", () => resolve({ reply: { error: true }, raw: buf }));
  });

describe("O4b B' step 2 — a driven request on the AF_UNIX launch socket is refused, and no-service fails closed", () => {
  /** A channel as `main` wires it: the session runtime is attached with `driven`, `cp.cto` with the channel itself. */
  const openChannel = async () => {
    const dir = tempDir("acp-o4b-afunix-");
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential: SessionLaunchCredential & { sessionSecret: string } = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const audit = auditDouble();
    const channel = await startSessionLaunchChannel(dir, { mcpToken: MCP_TOKEN, sessions: sessionsDouble(record), audit });
    expect((await channel.prepare()).allowed).toBe(true);
    return {
      channel, credential, audit,
      close: async () => { await channel.close(); rmSync(dir, { recursive: true, force: true }); },
    };
  };
  const drivenRefusals = (audit: ReturnType<typeof auditDouble>) =>
    audit.rows.filter((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_REFUSED" && r.reasonCode === ReasonCode.DRIVEN_LAUNCH_ON_AF_UNIX_REFUSED);

  it("W-AFUNIX: a driven (pinned) entry presented on cto.launch.sock is refused, and the entry is kept", async () => {
    const { channel, credential, close } = await openChannel();
    try {
      // A driven entry, offered through the driven door, with its pin; drive it straight onto the id-only socket.
      await channel.driven.provision({ ...credential, pin: { pid: process.pid, startToken: readProcessStartToken(process.pid) } });
      const { reply } = await askAfUnix(channel.socketPath, credential.externalSessionId);
      expect(reply["ok"]).toBe(false);
      expect(reply["reasonCode"]).toBe(ReasonCode.DRIVEN_LAUNCH_ON_AF_UNIX_REFUSED);
      expect(channel.withdraw(credential.externalSessionId)).toBe(true); // kept for the real Mach claim
    } finally {
      await close();
    }
  });

  it("#1336 (a): a request between the driven provision and its pin is refused on AF_UNIX, hands over nothing, and keeps the entry", async () => {
    const { channel, credential, audit, close } = await openChannel();
    try {
      // The runtime's own order: provision the turn's entry, then write the holder pin into that very object
      // in the spawn tick. A same-uid presenter of the id that asks in between finds no pin yet.
      const launch: SessionLaunchCredential = { ...credential };
      expect((await channel.driven.provision(launch)).allowed).toBe(true);
      const early = await askAfUnix(channel.socketPath, credential.externalSessionId);
      expect(early.reply).toEqual({ ok: false, reasonCode: ReasonCode.DRIVEN_LAUNCH_ON_AF_UNIX_REFUSED });
      expect(early.raw).not.toContain(credential.sessionSecret);
      expect(early.raw).not.toContain(MCP_TOKEN);
      expect(drivenRefusals(audit)).toHaveLength(1);
      expect(drivenRefusals(audit)[0]!.evidence).toEqual({ transport: "af_unix", reason: "DRIVEN_ON_AF_UNIX" });
      // The pin arrives: the same entry is still pending, for its Mach claim, and still refused here.
      launch.pin = { pid: process.pid, startToken: readProcessStartToken(process.pid) };
      const late = await askAfUnix(channel.socketPath, credential.externalSessionId);
      expect(late.reply).toEqual({ ok: false, reasonCode: ReasonCode.DRIVEN_LAUNCH_ON_AF_UNIX_REFUSED });
      expect(late.raw).not.toContain(credential.sessionSecret);
      expect(channel.driven.withdraw(credential.externalSessionId)).toBe(true);
    } finally {
      await close();
    }
  });

  it("#1336 (b): a driven entry that never gets a pin is refused on AF_UNIX every time it is asked for", async () => {
    const { channel, credential, audit, close } = await openChannel();
    try {
      expect((await channel.driven.provision(credential)).allowed).toBe(true);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const asked = await askAfUnix(channel.socketPath, credential.externalSessionId);
        expect(asked.reply).toEqual({ ok: false, reasonCode: ReasonCode.DRIVEN_LAUNCH_ON_AF_UNIX_REFUSED });
        expect(asked.raw).not.toContain(credential.sessionSecret);
      }
      expect(drivenRefusals(audit)).toHaveLength(3);
      expect(audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toBe(false);
      expect(channel.withdraw(credential.externalSessionId)).toBe(true); // never consumed
    } finally {
      await close();
    }
  });

  it("#1336 (c): an interactive entry, offered through the channel's own provision, is still handed over on AF_UNIX once", async () => {
    const { channel, credential, audit, close } = await openChannel();
    try {
      expect((await channel.provision(credential)).allowed).toBe(true);
      const asked = await askAfUnix(channel.socketPath, credential.externalSessionId);
      expect(asked.reply).toEqual({
        ok: true,
        sessionId: credential.sessionId,
        sessionIncarnation: credential.sessionIncarnation,
        sessionSecret: credential.sessionSecret,
        token: MCP_TOKEN,
      });
      expect(drivenRefusals(audit)).toHaveLength(0);
      expect(channel.withdraw(credential.externalSessionId)).toBe(false); // take-once: consumed by the hand-over
      const again = await askAfUnix(channel.socketPath, credential.externalSessionId);
      expect(again.reply).toEqual({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
    } finally {
      await close();
    }
  });

  it("W-NOSERVICE: when check-in fails the Mach service is not advertised, under a named reason code", async () => {
    const dir = tempDir("acp-o4b-noservice-");
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "x", incarnation: "inc-1", credentialEpoch: 1 };
    const channel = await startSessionLaunchChannel(dir, {
      mcpToken: MCP_TOKEN, sessions: sessionsDouble(record), audit: auditDouble(),
      machLoader: () => { throw new Error("addon missing"); },
    });
    try {
      const enabled = channel.enableMachService();
      expect(enabled.allowed).toBe(false);
      expect(enabled.reasonCode).toBe(ReasonCode.MACH_LAUNCH_SERVICE_UNAVAILABLE);
      expect(channel.machServiceName).toBeNull();
    } finally {
      await channel.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the reserved service name is the production default and matches the plist and the relay", () => {
    expect(MACH_LAUNCH_RESERVED_SERVICE).toBe("com.agentcontrolplane.agentcpd.launch");
  });
});
