import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { startAdoptedCeoToolSocket, startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import type { Decision } from "../../src/core/errors.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { adoptedFixture, GATEWAY, type AdoptedCeoFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

/**
 * Review PR1046-R3: the daemon's shutdown closes its listeners before it stops and releases the
 * lock, and a listener that waits for its connections to end on their own never let it get there
 * while a runtime stayed attached. This drives that order — close the tool socket, close the MCP
 * listeners, stop the daemon — with a CTO attached on `cto.mcp.sock` and the adopted CEO attached on
 * its tool socket, neither of which ever ends its own connection, and requires the lock released.
 */

const TOKEN = "fixture-mcp-token";
const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};

const settles = async <T>(work: Promise<T>, budgetMs = 10_000): Promise<T | "did-not-settle"> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<"did-not-settle">((resolve) => {
    timer = setTimeout(() => resolve("did-not-settle"), budgetMs);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const roots: string[] = [];
const fixtures: AdoptedCeoFixture[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

/** Connects and writes `lines`, and never ends the connection from this side. */
const attach = (path: string, lines: unknown[]): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    sockets.push(socket);
    socket.on("data", () => undefined);
    socket.once("error", reject);
    socket.once("connect", () => {
      for (const line of lines) socket.write(`${JSON.stringify(line)}\n`);
      resolve(socket);
    });
  });

describe("shutdown with peers still attached", () => {
  it("closes every listener and releases the daemon lock", async () => {
    const fixture = adoptedFixture();
    fixtures.push(fixture);
    const { h } = fixture;
    fixture.parents.set(process.pid, GATEWAY);
    const manifest = fixtureManifest("shutdown-project");
    valueOf(h.cp.projects.register({
      projectId: manifest.projectId,
      name: "fixture",
      manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest),
    }));
    const cto = h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(h.cp.sessions.transition(cto.sessionId, SessionLifecycle.READY));
    valueOf(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: cto.sessionId }));

    const stateDir = mkdtempSync("/tmp/acp37s-");
    roots.push(stateDir);
    const daemon = new Daemon(h.cp, { stateDir });
    valueOf(daemon.lock.acquire(h.clock.nowIso()));
    const listeners = await startDaemonMcpListeners(h.cp, stateDir, TOKEN, daemon);
    const tools = await startAdoptedCeoToolSocket(h.cp, daemon, stateDir, fixture.admission());

    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" },
    } };
    const ctoPeer = await attach(listeners.socketPaths[1]!, [
      { token: TOKEN, sessionId: cto.sessionId, sessionSecret: cto.sessionSecret },
      initialize,
    ]);
    const ceoPeer = await attach(tools.socketPath, [initialize]);
    const ended = (socket: Socket) => new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const peersEnded = Promise.all([ended(ctoPeer), ended(ceoPeer)]);

    // The shutdown's order in `main`: the tool socket, then the MCP listeners, then the daemon.
    expect(await settles(tools.close().then(() => "closed"))).toBe("closed");
    expect(await settles(listeners.close().then(() => "closed"))).toBe("closed");
    await daemon.stop();
    expect(daemon.lock.held()).toBe(false);
    expect(await settles(peersEnded.then(() => "ended"))).toBe("ended");
  });
});
