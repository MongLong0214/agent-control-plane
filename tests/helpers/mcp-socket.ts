import { spawn } from "node:child_process";
import { createConnection } from "node:net";

import { ReasonCode } from "../../src/core/reason-codes.ts";

/** Serialize every JSON string code unit as \uXXXX, including ASCII and surrogate pairs. */
export const unicodeEscapedJson = (value: unknown): string => JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, literal =>
  '"' + (JSON.parse(literal) as string).split("").map(unit => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0")).join("") + '"');

/** What a local MCP socket's first line carries: the deployment token and the session credential. */
export interface McpSocketCredential {
  token: string;
  sessionId: string;
  sessionSecret: string;
}

/**
 * One `tools/call` on a real local MCP socket (`hermes.mcp.sock`, `cto.mcp.sock`): the credential
 * line, initialize, initialized, then the call by id. Answers the tool's structured content; a
 * JSON-RPC error or an unstructured result is reported under INTERNAL_ERROR with the transport's
 * own text, so no row can mistake it for a control-plane refusal.
 */
export const callMcpToolOverSocket = (
  socketPath: string,
  credential: McpSocketCredential,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${name} over ${socketPath} timed out`));
    }, 15_000);
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(`${[
        { token: credential.token, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acp-test", version: "1" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (!line.includes('"id":2')) continue;
        clearTimeout(timer);
        socket.end();
        const reply = JSON.parse(line) as {
          result?: { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
          error?: { message?: string };
        };
        resolve(
          reply.result?.structuredContent ?? {
            ok: false,
            reasonCode: ReasonCode.INTERNAL_ERROR,
            message: reply.error?.message ?? reply.result?.content?.map((part) => part.text ?? "").join("\n") ?? "",
          },
        );
        return;
      }
    });
    // A handshake refusal ends the socket after one `{ok:false,…}` line and no reply to the call:
    // answer that refusal at once rather than waiting out the timer.
    socket.once("close", () => {
      clearTimeout(timer);
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        try {
          const refused = JSON.parse(line) as Record<string, unknown>;
          if (refused["ok"] === false && !("jsonrpc" in refused)) {
            resolve(refused);
            return;
          }
        } catch {
          // not a refusal line
        }
      }
      resolve({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR, message: "the socket closed before the call was answered" });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/** A credential the launch channel handed over, as its relay holds it. */
export interface LaunchedCredential {
  sessionId: string;
  sessionSecret: string;
  sessionIncarnation?: string;
  token?: string;
}

/** The launch channel's one reply line, or null when it handed nothing over. */
const launchedCredentialOf = (line: string): LaunchedCredential | null => {
  const body = JSON.parse(line) as {
    ok?: unknown;
    sessionId?: unknown;
    sessionSecret?: unknown;
    sessionIncarnation?: unknown;
    token?: unknown;
  };
  if (body.ok !== true || typeof body.sessionId !== "string" || typeof body.sessionSecret !== "string") return null;
  return {
    sessionId: body.sessionId,
    sessionSecret: body.sessionSecret,
    ...(typeof body.sessionIncarnation === "string" ? { sessionIncarnation: body.sessionIncarnation } : {}),
    ...(typeof body.token === "string" ? { token: body.token } : {}),
  };
};

/**
 * Reads a launched runtime's one-time local credential exactly as the runtime would. A channel
 * started with `mcpToken` also hands back the socket gate (#246 C1b), and every reply names the
 * session's incarnation.
 *
 * The peer is this test process. That is the shape of an interactive spawn's entry
 * (`interactiveSpawns`), which pins no process; a driven turn's entry is not handed to it
 * (`claimLaunchedCredentialAsTurn`).
 */
export const claimLaunchedCredential = (
  socketPath: string,
  externalSessionId: string,
): Promise<LaunchedCredential> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ externalSessionId })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      socket.end();
      const credential = launchedCredentialOf(received.trim());
      if (credential === null) {
        reject(new Error("launch credential was not available"));
        return;
      }
      resolve(credential);
    });
    socket.once("error", reject);
  });

/**
 * One level of a turn's process tree: run `inner` as this process's only child, with this process's
 * arguments and stdout, and exit when it does. Nothing of the tree outlives its holder.
 */
const treeLevel = (inner: string): string =>
  `const { spawn } = require("node:child_process");` +
  `const child = spawn(process.execPath, ["-e", ${JSON.stringify(inner)}, ...process.argv.slice(1)], { stdio: ["ignore", "inherit", "ignore"] });` +
  `child.on("exit", (code) => process.exit(code === null ? 1 : code));`;

/** The leaf: one request on the launch socket, and the reply's first line on stdout. */
const TREE_LEAF =
  `const net = require("node:net");` +
  `const [socketPath, externalSessionId] = process.argv.slice(1);` +
  `const socket = net.createConnection(socketPath);` +
  `let received = ""; let done = false;` +
  `const report = () => { if (done) return; done = true; process.stdout.write(received.split("\\n")[0] + "\\n", () => process.exit(0)); };` +
  `socket.setEncoding("utf8");` +
  `socket.setTimeout(20000, () => socket.destroy());` +
  `socket.once("connect", () => socket.write(JSON.stringify({ externalSessionId }) + "\\n"));` +
  `socket.on("data", (chunk) => { received += chunk; });` +
  `socket.once("close", report);` +
  `socket.once("error", report);`;

/** holder → CLI stand-in → leaf. */
const TURN_TREE_HOLDER = treeLevel(treeLevel(TREE_LEAF));

/**
 * O4 — the launch claim a driven turn's relay makes, in the process shape the real adapter gives a
 * turn: a holder this call spawns, the holder's child standing in for the CLI, and that child's child
 * asking the launch socket — the relay's place under `claude -p`. `onHolderSpawned` is called with the
 * holder's pid in the spawn's own tick, before the holder can start anything, which is where the real
 * adapter reports its holder (`SessionTurnSpawnRequest.onSpawn`): the runtime then pins that pid with
 * the start token it reads from the kernel itself. The channel reads the leaf from the kernel as well;
 * nothing here tells it who is asking. Settles once the whole tree has exited.
 */
export const claimLaunchedCredentialAsTurn = (
  socketPath: string,
  externalSessionId: string,
  onHolderSpawned: (pid: number) => void,
): Promise<LaunchedCredential> =>
  new Promise((resolve, reject) => {
    const holder = spawn(process.execPath, ["-e", TURN_TREE_HOLDER, socketPath, externalSessionId], {
      stdio: ["ignore", "pipe", "ignore"],
      // The holder leads its own group, as the adapter's holder does.
      detached: true,
    });
    if (holder.pid === undefined) {
      holder.once("error", reject);
      return;
    }
    onHolderSpawned(holder.pid);
    let out = "";
    holder.stdout!.setEncoding("utf8");
    holder.stdout!.on("data", (chunk: string) => (out += chunk));
    holder.once("error", reject);
    holder.once("close", () => {
      const line = out.split("\n")[0] ?? "";
      const credential = line.length > 0 ? launchedCredentialOf(line) : null;
      if (credential === null) {
        reject(new Error("launch credential was not available"));
        return;
      }
      resolve(credential);
    });
  });
