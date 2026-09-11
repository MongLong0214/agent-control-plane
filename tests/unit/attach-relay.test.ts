import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACH_EXIT, runAttachRelay, type AttachRelayClaim } from "../../src/cli/attach-relay.ts";
import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { C0_QUALIFIED_CLIENT } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, type Harness } from "../helpers/harness.ts";

/**
 * The relay drives the **real** `cto.mcp.sock` listener, with the real MCP server behind it, so
 * "the handshake line is the daemon's first line and the client's `initialize` is the second" is
 * measured against the code that enforces it rather than a stand-in.
 *
 * The **claim** socket is a fixture here, and deliberately so: the production listener authenticates
 * the kernel's record of who opened it and then walks that process's ancestry for a real `claude`
 * executable. `tests/process/canonical-self-claim-listener-claim.test.ts` already pays for that
 * lane with a cloned ~100 MB executable image, and a second site of the same shape is what #817
 * exists to prevent. What this file owns is the relay's own behaviour once a receipt exists.
 *
 * Nothing here touches `~/.agent-control-plane`, a live socket, or a real credential: every socket
 * is bound inside this checkout and every credential is minted by the fixture registry.
 */
const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};

/** Chosen by this file, so its absence from the relay's stdio is a statement about the relay. */
const TOKEN = "unit-b-token-canary-2f9a4c";
const RECEIPT_CANARY = "unit-b-receipt-canary-2f9a4c";

interface Wire {
  id?: number;
  result?: { structuredContent?: Record<string, unknown> };
  error?: unknown;
}

interface Relay {
  exit: Promise<number>;
  stdin: PassThrough;
  stdout: PassThrough;
  request(method: string, params: unknown): Promise<Wire>;
  notify(method: string): void;
  out(): string;
  err(): string;
}

/**
 * Resolves to the relay's exit code, or to a sentinel when it does not settle inside the budget.
 * A mutation that removes a terminal path must fail an assertion rather than burn the file's
 * 60 s timeout, so the budget is the assertion's, not vitest's.
 */
const settles = async (exit: Promise<number>, budgetMs = 10_000): Promise<number | "did-not-settle"> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<"did-not-settle">((resolve) => {
    timer = setTimeout(() => resolve("did-not-settle"), budgetMs);
  });
  try {
    return await Promise.race([exit, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

describe("the canonical CTO attach relay", () => {
  let h: Harness;
  let daemon: Daemon;
  let listeners: LocalMcpListeners;
  let stateDir: string;
  let endpoint: string;
  let wake: Server;
  let subject: { sessionId: string; sessionSecret: string };
  let roleKey: string;
  let claimPath: string;
  let mcpPath: string;
  let claim: AttachRelayClaim;
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const running: Promise<number>[] = [];

  const listen = async (server: Server, path: string): Promise<Server> => {
    servers.push(server);
    // `server.close` waits out live connections, so every accepted socket is tracked and
    // destroyed in `afterEach` before the close is awaited.
    server.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    return server;
  };

  /** One scripted line, then end — the shape `canonical-self-claim-listener.ts` answers with. */
  const fakeClaim = (response: unknown): Promise<Server> => fakeClaimLine(JSON.stringify(response));

  /**
   * The same, with the response body written verbatim. A body that is not an object at all — `null`,
   * a number, an array — has no JS value this file could pass through `JSON.stringify` and get back,
   * and those are exactly the inputs the receipt guards exist for.
   */
  const fakeClaimLine = (body: string): Promise<Server> =>
    listen(
      createServer((socket) => {
        socket.once("data", () => socket.end(`${body}\n`));
      }),
      claimPath,
    );

  /** Stands in for the daemon's side of `cto.mcp.sock` for one scripted first line. */
  const fakeMcp = (firstLine: string, path = join(stateDir, "r.sock")): Promise<string> =>
    listen(
      createServer((socket) => {
        socket.once("data", () => socket.end(`${firstLine}\n`));
      }),
      path,
    ).then(() => path);

  const receipt = (): unknown => ({
    allowed: true,
    reasonCode: ReasonCode.OK,
    value: {
      sessionId: subject.sessionId,
      sessionSecret: subject.sessionSecret,
      canary: RECEIPT_CANARY,
    },
  });

  const drive = (mcpSocketPath: string, mcpToken = TOKEN): Relay => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let outBytes = Buffer.alloc(0);
    let errText = "";
    let pendingText = "";
    let nextId = 1;
    const pending = new Map<number, (message: Wire) => void>();
    stdout.on("data", (chunk: Buffer) => {
      outBytes = Buffer.concat([outBytes, chunk]);
      pendingText += chunk.toString("utf8");
      for (;;) {
        const newline = pendingText.indexOf("\n");
        if (newline < 0) break;
        const line = pendingText.slice(0, newline);
        pendingText = pendingText.slice(newline + 1);
        let message: Wire | null;
        try {
          message = JSON.parse(line) as Wire | null;
        } catch {
          continue;
        }
        // The daemon is not the only thing that writes this stream in these tests: a fixture that
        // scripts a non-object first line is exercising exactly the relay guard that lets such a
        // line through untouched, so this reader has to survive reading one back.
        if (!message || typeof message !== "object") continue;
        if (message.id !== undefined) pending.get(message.id)?.(message);
      }
    });
    stderr.on("data", (chunk: Buffer) => {
      errText += chunk.toString("utf8");
    });
    const exit = runAttachRelay(
      { claimSocketPath: claimPath, mcpSocketPath, mcpToken, claim },
      { stdin, stdout, stderr },
    );
    running.push(exit);
    return {
      exit,
      stdin,
      stdout,
      request: (method, params) =>
        new Promise<Wire>((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`timeout awaiting ${method}; stderr=${errText}; stdout=${outBytes.toString("utf8")}`));
          }, 10_000);
          pending.set(id, (message) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(message);
          });
          stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        }),
      notify: (method) => {
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
      },
      out: () => outBytes.toString("utf8"),
      err: () => errText,
    };
  };

  const attach = async (
    clientInfo: { name: string; version: string } = C0_QUALIFIED_CLIENT,
    mcpSocketPath?: string,
  ): Promise<Relay & { init: Wire }> => {
    const relay = drive(mcpSocketPath ?? mcpPath);
    const init = await relay.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo,
    });
    relay.notify("notifications/initialized");
    return { ...relay, init };
  };

  const register = async (relay: Relay): Promise<Record<string, unknown>> =>
    (await relay.request("tools/call", {
      name: "role_wake_endpoint_register",
      arguments: { endpoint },
    })).result!.structuredContent!;

  beforeEach(async () => {
    h = makeHarness();
    const manifest = fixtureManifest("attach-relay-project");
    valueOf(
      h.cp.projects.register({
        projectId: manifest.projectId,
        name: "fixture",
        manifest,
        authorization: h.cp.manifestAuthorizationForTests(manifest),
      }),
    );
    const session = h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
    if (!session.sessionSecret) throw new Error("fixture secret unavailable");
    subject = { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
    roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: manifest.projectId });
    valueOf(
      h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: subject.sessionId }),
    );
    // Short and inside this checkout, including on macOS with its 103-byte `sun_path` limit.
    stateDir = mkdtempSync(join(fileURLToPath(new URL("../../", import.meta.url)), ".ar-"));
    daemon = new Daemon(h.cp, { stateDir });
    valueOf(daemon.lock.acquire(h.clock.nowIso()));
    listeners = await startDaemonMcpListeners(h.cp, stateDir, TOKEN, daemon);
    mcpPath = listeners.socketPaths[1]!;
    claimPath = join(stateDir, "c.sock");
    claim = {
      claimedSessionUuid: randomUUID(),
      projectId: manifest.projectId,
      expectedBindingGeneration: 1,
      ownerApprovalNonce: randomUUID(),
    };
    endpoint = join(stateDir, "w.sock");
    wake = createServer((socket) => socket.resume());
    await new Promise<void>((resolve, reject) => {
      wake.once("error", reject);
      wake.listen(endpoint, resolve);
    });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const exit of running.splice(0)) await settles(exit, 5_000);
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await listeners?.close();
    if (wake?.listening) await new Promise<void>((resolve) => wake.close(() => resolve()));
    daemon?.lock.release();
    h?.cp.db.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    cleanupTempDirs();
  });

  it("attaches the claimed session and carries the client's own initialize to the daemon", async () => {
    await fakeClaim(receipt());
    const relay = await attach();
    expect(relay.init.result).toBeDefined();
    expect(relay.init.error).toBeUndefined();
    const body = await register(relay);
    expect(body["ok"]).toBe(true);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBe(endpoint);
    relay.stdin.end();
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("forwards the client's own clientInfo rather than one the relay could have written", async () => {
    await fakeClaim(receipt());
    const relay = await attach({ name: "hand-written", version: "0" });
    const body = await register(relay);
    expect(body["ok"]).toBe(false);
    expect(body["reasonCode"]).toBe(ReasonCode.ROLE_PEER_UNSUPPORTED);
    expect((body["evidence"] as { presented?: unknown }).presented).toBe("hand-written/0");
    relay.stdin.end();
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("puts neither the deployment token nor the claim receipt on the client's stdio", async () => {
    await fakeClaim(receipt());
    const relay = await attach();
    expect((await register(relay))["ok"]).toBe(true);
    relay.stdin.end();
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.OK);
    expect(relay.out()).not.toContain(TOKEN);
    expect(relay.out()).not.toContain(subject.sessionSecret);
    expect(relay.out()).not.toContain(RECEIPT_CANARY);
    expect(relay.err()).toBe("");
  });

  it("reaches no mcp socket at all when the claim is refused, and reports only the reason code", async () => {
    await fakeClaim({ allowed: false, reasonCode: ReasonCode.CONFLICT, value: { canary: RECEIPT_CANARY } });
    let connections = 0;
    const counted = join(stateDir, "m.sock");
    await listen(
      createServer((socket) => {
        connections += 1;
        socket.destroy();
      }),
      counted,
    );
    const relay = drive(counted);
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.CLAIM_REFUSED);
    expect(relay.err()).toBe(`attach: claim refused ${ReasonCode.CONFLICT}\n`);
    expect(relay.out()).toBe("");
    expect(connections).toBe(0);
  });

  it("exits on a refused handshake with the daemon's reason code and writes no byte to stdout", async () => {
    await fakeClaim(receipt());
    const relay = drive(mcpPath, "not-the-deployment-token");
    relay.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: C0_QUALIFIED_CLIENT },
      })}\n`,
    );
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(relay.err()).toBe(`attach: handshake refused ${ReasonCode.MCP_PEER_UNAUTHENTICATED}\n`);
    expect(relay.out()).toBe("");
  });

  it("exits when the socket closes under it, and opens exactly one connection in its lifetime", async () => {
    await fakeClaim(receipt());
    // A transparent forwarder in front of the real listener. `LocalMcpListeners` exports no handle
    // on the socket it accepted, and the property under test is the relay's reaction to *its* peer
    // going away — which is what a daemon exit does to it. The forwarder also counts: a relay that
    // reconnected with the credential it still holds would show a second connection here, which is
    // the credential-reuse path the restart rule forbids.
    let accepted = 0;
    const proxyPath = join(stateDir, "p.sock");
    await listen(
      createServer((down) => {
        accepted += 1;
        const up = createConnection(mcpPath);
        sockets.push(up);
        down.on("error", () => undefined);
        up.on("error", () => undefined);
        down.pipe(up);
        up.pipe(down);
      }),
      proxyPath,
    );
    const relay = await attach(C0_QUALIFIED_CLIENT, proxyPath);
    expect((await register(relay))["ok"]).toBe(true);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBe(endpoint);

    for (const socket of sockets.splice(0)) socket.destroy();
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.STREAM_CLOSED);
    expect(relay.stdout.readableEnded || relay.stdout.writableEnded).toBe(true);
    await expect.poll(() => listeners.ctoConversation.endpointFor(roleKey)).toBeNull();
    expect(accepted).toBe(1);
  });

  it("half-closes toward the daemon when the client's stdin ends, and exits zero", async () => {
    await fakeClaim(receipt());
    const relay = await attach();
    expect((await register(relay))["ok"]).toBe(true);
    relay.stdin.end();
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.OK);
    await expect.poll(() => listeners.ctoConversation.endpointFor(roleKey)).toBeNull();
  });

  it("treats a first line past the transport limit as a protocol failure, not as client traffic", async () => {
    await fakeClaim(receipt());
    const junkPath = join(stateDir, "j.sock");
    await listen(
      createServer((socket) => {
        socket.once("data", () => socket.write(Buffer.alloc(1024 * 1024 + 16, 0x41)));
      }),
      junkPath,
    );
    const relay = drive(junkPath);
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
    expect(relay.out()).toBe("");
  });

  /*
   * The receipt and handshake-reply guards below decide exit 6 against exit 3 and exit 4 — whether
   * a credential is usable at all — so `pnpm guards:operands` wants each operand accounted for.
   *
   * Four of the sixteen have no independent witness and are recorded as owed in
   * `scripts/lib/refusal-operands-unanswered.mjs`. The rest are witnessed here, and the witnesses
   * were measured one operand at a time against a baseline of nineteen inputs rather than reasoned
   * about: a non-string field and an empty-string field are separable inputs that take separate
   * branches, and a `null` body is separable from every other non-object because `typeof null` is
   * `"object"` and the neighbouring operand cannot catch it.
   */

  it("treats a claim response body that is not an object as a protocol failure, never as a crash", async () => {
    // `null` is the one non-object the `typeof` operand beside it cannot catch. Without the guard
    // the next line reads `.allowed` off it and the relay dies with a stack trace on the stderr
    // Claude Code files as its MCP server log.
    await fakeClaimLine("null");
    const relay = drive(mcpPath);
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
    expect(relay.err()).toBe("attach: claim receipt malformed\n");
    expect(relay.out()).toBe("");
  });

  it("treats a receipt whose value is null as a protocol failure, never as a crash", async () => {
    await fakeClaimLine(JSON.stringify({ allowed: true, reasonCode: ReasonCode.OK, value: null }));
    const relay = drive(mcpPath);
    expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
    expect(relay.err()).toBe("attach: claim receipt malformed\n");
    expect(relay.out()).toBe("");
  });

  it("refuses a receipt whose sessionId is not a non-empty string before it reaches the mcp socket", async () => {
    // Both inputs run against the real listener, so a relay that stopped checking would present the
    // bad credential and come back with the daemon's own refusal — exit 4, not exit 6.
    for (const sessionId of [42, ""]) {
      await fakeClaimLine(
        JSON.stringify({
          allowed: true,
          reasonCode: ReasonCode.OK,
          value: { sessionId, sessionSecret: subject.sessionSecret },
        }),
      );
      const relay = drive(mcpPath);
      expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
      expect(relay.err()).toBe("attach: claim receipt malformed\n");
      for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("refuses a receipt whose sessionSecret is not a non-empty string before it reaches the mcp socket", async () => {
    for (const sessionSecret of [42, ""]) {
      await fakeClaimLine(
        JSON.stringify({
          allowed: true,
          reasonCode: ReasonCode.OK,
          value: { sessionId: subject.sessionId, sessionSecret },
        }),
      );
      const relay = drive(mcpPath);
      expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
      expect(relay.err()).toBe("attach: claim receipt malformed\n");
      for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("reports a claim denial with no stable reason code as a protocol failure, not as a refusal", async () => {
    // A code the catalogue does not declare must not reach stderr. An array answers `.length` and a
    // string of length zero answers `typeof`, so each operand is refused by the other's blind spot.
    for (const reasonCode of [["X"], ""]) {
      await fakeClaimLine(JSON.stringify({ allowed: false, reasonCode }));
      const relay = drive(mcpPath);
      expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
      expect(relay.err()).toBe("attach: claim receipt malformed\n");
      for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("forwards a first line that is not an object as client traffic, never as a refusal to parse", async () => {
    // The daemon writes a refusal only as an object with `ok: false`. Anything else is the client's
    // own stream and crosses unread — including the two shapes the `in` operator cannot be asked
    // about, which without their guards throw instead of being forwarded.
    for (const firstLine of ["null", "42"]) {
      await fakeClaim(receipt());
      const path = await fakeMcp(firstLine, join(stateDir, `r${firstLine}.sock`));
      const relay = drive(path);
      expect(await settles(relay.exit)).toBe(ATTACH_EXIT.STREAM_CLOSED);
      expect(relay.out()).toBe(`${firstLine}\n`);
      expect(relay.err()).toBe("");
      for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("reports a handshake refusal with no stable reason code as a protocol failure", async () => {
    for (const [index, reasonCode] of [["X"], ""].entries()) {
      await fakeClaim(receipt());
      const path = await fakeMcp(JSON.stringify({ ok: false, reasonCode }), join(stateDir, `q${index}.sock`));
      const relay = drive(path);
      expect(await settles(relay.exit)).toBe(ATTACH_EXIT.PROTOCOL);
      expect(relay.err()).toBe("attach: handshake reply malformed\n");
      expect(relay.out()).toBe("");
      for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
