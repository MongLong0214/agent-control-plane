import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import {
  MACH_LAUNCH_RESERVED_SERVICE,
  admitMachLaunchGrandchild,
  loadMachLaunchAddon,
  serveMachLaunchCredential,
  startSessionLaunchChannel,
  type MachLaunchAddon,
  type MachLaunchHandle,
  type MachLaunchIncoming,
  type PendingLaunchCredential,
} from "../../src/daemon/agentcpd.ts";
import type { SessionLaunchCredential } from "../../src/cto/cto-lifecycle.ts";
import type { SessionRecord, SessionRegistry } from "../../src/session/session-registry.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { tempDir } from "../helpers/fixtures.ts";

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

/** A session registry double: it answers from the one secret/incarnation/epoch this test provisioned. */
const sessionsDouble = (record: { sessionId: string; sessionSecret: string; incarnation: string; credentialEpoch: number }) => {
  let epoch = record.credentialEpoch;
  const rotations: number[] = [];
  const asRecord = (): SessionRecord => ({ incarnation: record.incarnation, credentialEpoch: epoch } as unknown as SessionRecord);
  const api: Pick<SessionRegistry, "get" | "verifySecret" | "rotateSecret"> = {
    get: (id: string): SessionRecord | null => (id === record.sessionId ? asRecord() : null),
    verifySecret: (id: string, secret: string) =>
      id === record.sessionId && secret === record.sessionSecret
        ? allow(ReasonCode.OK, asRecord())
        : deny<SessionRecord>(ReasonCode.SESSION_SECRET_INVALID, "no", { sessionId: id }),
    rotateSecret: ((id: string, expected: number) => {
      if (id !== record.sessionId || expected !== epoch) return deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "stale", {});
      epoch += 1;
      rotations.push(epoch);
      return allow(ReasonCode.OK, { sessionId: id, sessionSecret: "rotated", credentialEpoch: epoch });
    }) as SessionRegistry["rotateSecret"],
  };
  return Object.assign(api, { rotations });
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
  spawnTree(mode: "holder-cli-relay" | "holder-relay" | "holder-cli-two-relays", externalSessionId: string): {
    report: () => Record<string, number>;
    go: () => void;
    children: ChildProcess[];
  };
}

const harnesses: Array<{ cleanup: () => void }> = [];
afterEach((ctx) => {
  for (const h of harnesses.splice(0)) h.cleanup();
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
    isoName, pending, audit, sessions, mcpLines, dir, handle: undefined as unknown as MachLaunchHandle,
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
      const holder = spawn(process.execPath, [holderScript, mode, report, goFile, cliScript, count, ...relayArgs], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      children.push(holder);
      return {
        report: (): Record<string, number> => {
          const map: Record<string, number> = {};
          for (const line of readFileSync(report, "utf8").split("\n")) {
            const [k, v] = line.split("=");
            if (k && v) map[k] = Number(v);
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

  harnesses.push({
    cleanup: () => {
      for (const child of children) { try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
      try { addon.close(handle); } catch { /* already closed */ }
      mcpServer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
  return self;
};

/** Provisions one driven entry (a pinned turn) in the harness's pending map and returns its credential. */
const provision = (h: Harness, credential: SessionLaunchCredential & { sessionSecret: string }, holderPid: number): void => {
  h.pending.set(credential.externalSessionId, {
    credential: { ...credential, pin: { pid: holderPid, startToken: readProcessStartToken(holderPid) } },
    expiresAtMs: Date.now() + 60_000,
  });
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
    h.pending.set(credential.externalSessionId, { credential: { ...credential, pin }, expiresAtMs: Date.now() + 60_000 });
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
    h.pending.set(credential.externalSessionId, { credential: { ...credential, pin }, expiresAtMs: Date.now() + 60_000 });
    const request: MachLaunchIncoming = { id: 1, body: Buffer.from(JSON.stringify({ externalSessionId: credential.externalSessionId })), token, live: true, sender: { pid: 10, pidversion: 1, euid: 501 } };
    serveMachLaunchCredential(request, { pending: h.pending, sessions: h.sessions, audit: h.audit, addon: fakeAddon, handle: {}, mcpToken: MCP_TOKEN });
    expect(h.pending.has(credential.externalSessionId)).toBe(false); // not restored
    expect(h.sessions.rotations).toEqual([6]); // rotated from the epoch verifySecret returned
    expect(h.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_SEND_FAILED" && r.evidence["rotated"] === true)).toBe(true);
    expect(h.audit.rows.some((r) => r.kind === "SESSION_LAUNCH_CREDENTIAL_DELIVERED")).toBe(false);
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
    });
    expect(good.allowed).toBe(true);
    const moved = admitMachLaunchGrandchild(readers, self, token, { pid: grandparent, startToken: "darwin-tv:1.000000" });
    expect(moved.allowed).toBe(false);
    if (!moved.allowed) expect(moved.message).toBe("HOLDER_NOT_PINNED");
  });
});

describe("O4b B' step 2 — resource-safety branches expose no credential and leak no port or thread (CEO item 4)", () => {
  // The step-1 thread/port counter, loaded only to confirm the receive thread and the service ports
  // return to baseline. Absent (a clean CI runner without the step-1 evidence), the native close()
  // `released` flag is the portable no-leak statement and the thread assertions are skipped.
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

  it("W-DURING-STOP: requests in flight at close and one arriving after it are both refused, no credential, thread and ports back to baseline", async (ctx) => {
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
    // One arriving after close has begun finds no service.
    const late = await claimFrom(addon, iso, Buffer.from(JSON.stringify({ externalSessionId: "late" })), 1_000);
    expect(late.code).not.toBe("OK");
    if (DIAG) { expect(threadsAtListen).toBe(1); expect(receiveThreads()).toBe(0); } // the receive thread joined; none leaked
    void record;
  });

  it("the kernel-queue drain at close is attempted; whether any request was still queued is reported", async (ctx) => {
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

  it("W-PREV-INSTANCE: a request for a previous instance's entry, delivered to a new instance on the same name, is refused with no credential and no reissue", async (ctx) => {
    const addon = requireMach(ctx);
    const iso = isoName("prev");
    const recordA = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credE = credentialOf(recordA.sessionId);
    recordA.sessionSecret = credE.sessionSecret;
    // Instance A owns the service and holds entry E (pinned to this live process so lineage is not the
    // reason it is refused later). A is torn down before anything claims E.
    const pendingA = new Map<string, PendingLaunchCredential>();
    pendingA.set(credE.externalSessionId, { credential: { ...credE, pin: { pid: process.pid, startToken: readProcessStartToken(process.pid) } }, expiresAtMs: Date.now() + 60_000 });
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

describe("O4b B' step 2 — a driven request on the AF_UNIX launch socket is refused, and no-service fails closed", () => {
  it("W-AFUNIX: a driven (pinned) entry presented on cto.launch.sock is refused, and the entry is kept", async () => {
    const dir = tempDir("acp-o4b-afunix-");
    const record = { sessionId: `s-${randomUUID().slice(0, 8)}`, sessionSecret: "", incarnation: "inc-1", credentialEpoch: 1 };
    const credential = credentialOf(record.sessionId);
    record.sessionSecret = credential.sessionSecret;
    const channel = await startSessionLaunchChannel(dir, { mcpToken: MCP_TOKEN, sessions: sessionsDouble(record), audit: auditDouble() });
    try {
      await channel.prepare();
      // A driven entry carries a pin; drive it straight onto the id-only socket.
      await channel.provision({ ...credential, pin: { pid: process.pid, startToken: readProcessStartToken(process.pid) } });
      const reply = await new Promise<Record<string, unknown>>((resolve) => {
        const socket = createConnection(channel.socketPath, () => socket.write(`${JSON.stringify({ externalSessionId: credential.externalSessionId })}\n`));
        let buf = "";
        socket.on("data", (c) => { buf += c.toString("utf8"); if (buf.includes("\n")) { resolve(JSON.parse(buf.trim())); socket.destroy(); } });
        socket.on("error", () => resolve({ error: true }));
      });
      expect(reply["ok"]).toBe(false);
      expect(reply["reasonCode"]).toBe(ReasonCode.DRIVEN_LAUNCH_ON_AF_UNIX_REFUSED);
      expect(channel.withdraw(credential.externalSessionId)).toBe(true); // kept for the real Mach claim
    } finally {
      await channel.close();
      rmSync(dir, { recursive: true, force: true });
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
