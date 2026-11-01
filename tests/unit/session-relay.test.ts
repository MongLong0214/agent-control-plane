import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { machLaunchAddonPath, sessionRelayScript } from "../../src/runtime/cli-adapters.ts";
import { loadMachLaunchAddon } from "../../src/daemon/agentcpd.ts";
import { type BootstrapRuntimeFixture, openHeldCtoConnection, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Issue #246 PR-C slice C1b + O4b B' — the acp-cto relay a provisioned session's turn runs as its only
 * MCP server, executed as the CLI executes it (the interpreter running the shipped script). The relay
 * now claims its credential over raw Mach, not a launch socket, so it is run as it really runs: under a
 * pinned holder → CLI → the relay (the CLI's own MCP child), which is the one shape the daemon's
 * per-message admission accepts. The CLI stand-in forwards the MCP client's lines to the relay's stdin
 * and reads its stdout, as Claude Code would. No model is involved.
 */

const addonReady = (() => {
  if (process.platform !== "darwin") return false;
  try { loadMachLaunchAddon(); return true; } catch { return false; }
})();
const requireMach = (ctx: { skip: (note?: string) => void }): void => {
  if (addonReady) return;
  if (process.env["ACP_REQUIRE_SEATBELT"] === "1") throw new Error("the mach-launch addon is required on this host");
  ctx.skip("mach-launch addon not built on this platform");
};

interface RelayRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MCP_CLIENT_LINES = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "relay-test", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "role_dispatch_pending", arguments: {} } },
];

/**
 * Runs the real relay under a real pinned holder → CLI tree, the one shape admission accepts, with the
 * credential offered on the fixture's Mach launch service. `provision` is called with the holder's pid
 * once the tree exists, so the test can offer a pinned entry for exactly this holder, or offer nothing.
 * The CLI stand-in writes the MCP client's lines to the relay's stdin and collects its stdout.
 */
const runRelayUnderTree = async (
  f: BootstrapRuntimeFixture,
  externalSessionId: string,
  provision: (holderPid: number) => Promise<void> | void,
): Promise<RelayRun> => {
  const isoName = f.machServiceName!;
  const dir = mkdtempSync(join(tmpdir(), "acp-relay-tree-"));
  const report = join(dir, "report");
  const goFile = join(dir, "go");
  const resultFile = join(dir, "result.json");
  const linesFile = join(dir, "lines");
  writeFileSync(report, "");
  writeFileSync(linesFile, `${MCP_CLIENT_LINES.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const relayArgs = [sessionRelayScript(), "--addon", machLaunchAddonPath(), "--iso-service", isoName, "--mcp", f.ctoSocket, "--session", externalSessionId];
  const cli = join(dir, "cli.cjs");
  const holder = join(dir, "holder.cjs");
  writeFileSync(cli, `
    const { spawn } = require("node:child_process");
    const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
    const [report, goFile, resultFile, linesFile, ...relayArgs] = process.argv.slice(2);
    appendFileSync(report, "cli=" + process.pid + "\\n");
    const wait = setInterval(() => {
      if (!existsSync(goFile)) return;
      clearInterval(wait);
      const relay = spawn(process.execPath, relayArgs, { stdio: ["pipe", "pipe", "pipe"] });
      appendFileSync(report, "relay=" + relay.pid + "\\n");
      let stdout = "", stderr = "";
      relay.stdout.setEncoding("utf8"); relay.stderr.setEncoding("utf8");
      relay.stdout.on("data", (c) => { stdout += c; if (stdout.includes('"id":2')) relay.stdin.end(); });
      relay.stderr.on("data", (c) => { stderr += c; });
      relay.stdin.on("error", () => {});
      relay.stdin.write(readFileSync(linesFile));
      const timer = setTimeout(() => relay.kill("SIGKILL"), 20000);
      relay.on("close", (code) => { clearTimeout(timer); writeFileSync(resultFile, JSON.stringify({ exitCode: code, stdout, stderr })); process.exit(0); });
    }, 10);
    setInterval(() => {}, 1 << 30);
  `);
  writeFileSync(holder, `
    const { spawn } = require("node:child_process");
    const { appendFileSync } = require("node:fs");
    const [cli, ...rest] = process.argv.slice(2);
    appendFileSync(rest[0], "holder=" + process.pid + "\\n");
    spawn(process.execPath, [cli, ...rest], { stdio: ["ignore", "ignore", "ignore"] });
    setInterval(() => {}, 1 << 30);
  `);
  const holderProc = spawn(process.execPath, [holder, cli, report, goFile, resultFile, linesFile, ...relayArgs], { stdio: ["ignore", "ignore", "ignore"] });
  const readReport = (): Record<string, number> => {
    const map: Record<string, number> = {};
    for (const line of readFileSync(report, "utf8").split("\n")) { const [k, v] = line.split("="); if (k && v) map[k] = Number(v); }
    return map;
  };
  const until = Date.now() + 10_000;
  while (!("holder" in readReport()) && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
  const holderPid = readReport()["holder"]!;
  await provision(holderPid);
  writeFileSync(goFile, "go");
  const deadline = Date.now() + 25_000;
  let raw = "";
  while (Date.now() < deadline) {
    try { raw = readFileSync(resultFile, "utf8"); if (raw) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  try { if (holderProc.pid) process.kill(holderProc.pid, "SIGKILL"); } catch { /* gone */ }
  const result = raw ? (JSON.parse(raw) as RelayRun) : { exitCode: null, stdout: "", stderr: "" };
  return { ...result, stderr: result.stderr.replace(/^\(node:\d+\) ExperimentalWarning:.*\n(\(Use `node --trace-warnings.*\n)?/gm, "") };
};

/** Offers the session's credential as a pinned (driven) entry for the given holder, over Mach. */
const offerPinned = (f: BootstrapRuntimeFixture, ownerSessionId: string, holderPid: number, secret?: string) => {
  const session = f.harness.cp.sessions.require(ownerSessionId);
  const externalSessionId = session.incarnation.split("#", 1)[0]!;
  const held = f.claude.credentials.get(ownerSessionId)!;
  return f.launch.provision({
    sessionId: ownerSessionId,
    sessionIncarnation: session.incarnation,
    externalSessionId,
    sessionSecret: secret ?? held.sessionSecret,
    pin: { pid: holderPid, startToken: readProcessStartToken(holderPid) },
  });
};

const dispatchedSession = async (f: BootstrapRuntimeFixture) => {
  const { ownerSessionId } = await f.dispatchBootstrap();
  await f.awaitFinishedTurns(ownerSessionId, 1);
  return ownerSessionId;
};

const externalOf = (f: BootstrapRuntimeFixture, sessionId: string): string =>
  f.harness.cp.sessions.require(sessionId).incarnation.split("#", 1)[0]!;

describe("C1b/O4b relay: the credential crosses the Mach launch service once and the MCP socket once, and nowhere else", () => {
  it("takes the credential over Mach under the pinned holder → CLI shape, authenticates, and carries traffic both ways; the secret is in no output", async (ctx) => {
    requireMach(ctx);
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const external = externalOf(f, sessionId);
      const secret = f.claude.credentials.get(sessionId)!.sessionSecret;
      const run = await runRelayUnderTree(f, external, async (holderPid) => {
        expect((await offerPinned(f, sessionId, holderPid))).toMatchObject({ allowed: true });
      });
      expect(run.exitCode).toBe(0);
      const reply = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((message) => message["id"] === 2) as { result?: { structuredContent?: Record<string, unknown> } };
      expect(reply.result?.structuredContent).toMatchObject({ ok: true });
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
      expect(f.launch.withdraw(external)).toBe(false); // take-once: the entry is gone
    });
  });

  it("with no credential on offer it never connects: exit 3, a closed stderr code, no output", async (ctx) => {
    requireMach(ctx);
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const external = externalOf(f, sessionId);
      const run = await runRelayUnderTree(f, external, () => { /* nothing offered */ });
      expect(run).toMatchObject({ exitCode: 3, stdout: "" });
      expect(run.stderr.trim()).toBe("session-relay: launch REFUSED");
    });
  });

  it("a second relay for the same turn finds nothing: the credential was taken once", async (ctx) => {
    requireMach(ctx);
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const external = externalOf(f, sessionId);
      const first = await runRelayUnderTree(f, external, async (holderPid) => {
        expect((await offerPinned(f, sessionId, holderPid))).toMatchObject({ allowed: true });
      });
      expect(first.exitCode).toBe(0);
      const second = await runRelayUnderTree(f, external, () => { /* already taken */ });
      expect(second.exitCode).toBe(3);
    });
  });

  it("a credential whose secret the daemon does not accept is refused at admission, before any handshake: exit 3", async (ctx) => {
    requireMach(ctx);
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const external = externalOf(f, sessionId);
      const secret = "not-this-session's-secret-" + "y".repeat(16);
      const run = await runRelayUnderTree(f, external, async (holderPid) => {
        expect((await offerPinned(f, sessionId, holderPid, secret))).toMatchObject({ allowed: true });
      });
      expect(run.exitCode).toBe(3);
      expect(run.stderr.trim()).toBe("session-relay: launch REFUSED");
      expect(run.stdout).toBe("");
      expect(run.stderr).not.toContain(secret);
    });
  });

  it("rejects an argv that is not exactly its named options", async () => {
    const child = spawn(process.execPath, [sessionRelayScript(), "--session", "x"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(exitCode).toBe(2);
    expect(stderr).toContain("session-relay: usage INVALID_ARGUMENTS");
  });
});

describe("readiness does not open an unbound MCP authority", () => {
  it("keeps an unbound STARTING session off the role socket without readiness challenges", async () => {
    await withBootstrapRuntime(async (f) => {
      const created = f.harness.cp.sessions.create({ provider: "claude", model: "opus" });
      const credential = { sessionId: created.sessionId, sessionSecret: created.sessionSecret! };
      expect(await openHeldCtoConnection(f.ctoSocket, credential)).toMatchObject({ refused: { ok: false } });
    });
  });
});
