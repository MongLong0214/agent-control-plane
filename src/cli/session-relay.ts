#!/usr/bin/env node
/**
 * #246 C1b — the acp-cto relay a provisioned session's headless turn runs as its only MCP server.
 *
 * Claude Code spawns this once per turn (`ClaudeCliAdapter.runSessionTurn`, `--strict-mcp-config`).
 * It asks the daemon's take-once launch channel for the credential of the one session it was
 * started for, presents it as the first line on the CTO MCP socket, and from then on copies bytes
 * in both directions. The daemon re-verifies that credential on every request, so a credential the
 * daemon has since rotated stops working mid-connection, not only at the next one.
 *
 * What it is given on its command line is a session's provider id and two socket paths, none of
 * them a secret. The credential exists in this process's memory only: it is never written to
 * stdout, stderr, a file or the environment, and the closed stderr vocabulary is
 * `session-relay: <stage> <code>`. There is no retry and no reconnect: the launch entry is gone
 * once taken, so a second connection would have nothing to present, which is the point.
 *
 * Self-contained by design — Node built-ins only, and only syntax Node can strip — because the
 * turn's sandbox re-opens exactly this file for reading and nothing it might import.
 */
import { createConnection, type Socket } from "node:net";

const MAX_LINE_BYTES = 1024 * 1024;
const LAUNCH_TIMEOUT_MS = 30_000;

const EXIT = {
  OK: 0,
  USAGE: 2,
  LAUNCH_REFUSED: 3,
  HANDSHAKE_REFUSED: 4,
  STREAM_CLOSED: 5,
} as const;

interface RelayArguments {
  launchSocketPath: string;
  mcpSocketPath: string;
  externalSessionId: string;
}

interface LaunchedCredential {
  token: string;
  sessionId: string;
  sessionSecret: string;
}

const report = (stage: string, code: string): void => {
  process.stderr.write(`session-relay: ${stage} ${code}\n`);
};

const parseArguments = (argv: readonly string[]): RelayArguments | null => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || value.length === 0) return null;
    if (name !== "--launch" && name !== "--mcp" && name !== "--session") return null;
    if (values.has(name)) return null;
    values.set(name, value);
  }
  const launchSocketPath = values.get("--launch");
  const mcpSocketPath = values.get("--mcp");
  const externalSessionId = values.get("--session");
  if (!launchSocketPath || !mcpSocketPath || !externalSessionId) return null;
  return { launchSocketPath, mcpSocketPath, externalSessionId };
};

/** One line out, one line back, on the launch channel. Null when nothing usable came back. */
const claimCredential = (socketPath: string, externalSessionId: string): Promise<LaunchedCredential | null> =>
  new Promise((resolveClaim) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (credential: LaunchedCredential | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveClaim(credential);
    };
    const timer = setTimeout(() => finish(null), LAUNCH_TIMEOUT_MS);
    socket.once("connect", () => socket.write(`${JSON.stringify({ externalSessionId })}\n`));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf(0x0a);
      if (boundary === -1) {
        if (received.length > MAX_LINE_BYTES) finish(null);
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(received.subarray(0, boundary).toString("utf8")) as unknown;
      } catch {
        finish(null);
        return;
      }
      const reply = (body ?? {}) as { ok?: unknown; token?: unknown; sessionId?: unknown; sessionSecret?: unknown };
      if (
        reply.ok !== true ||
        typeof reply.token !== "string" || reply.token.length === 0 ||
        typeof reply.sessionId !== "string" || reply.sessionId.length === 0 ||
        typeof reply.sessionSecret !== "string" || reply.sessionSecret.length === 0
      ) {
        finish(null);
        return;
      }
      finish({ token: reply.token, sessionId: reply.sessionId, sessionSecret: reply.sessionSecret });
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });

/**
 * The daemon's first line answers this relay's handshake: on refusal `{"ok":false,"reasonCode":…}`
 * and the socket ends; on success it writes nothing of its own, so the first line is already
 * MCP traffic. Only that first line is ever inspected.
 */
const refusalOf = (line: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "jsonrpc" in parsed) return null;
  const body = parsed as { ok?: unknown; reasonCode?: unknown };
  if (body.ok !== false) return null;
  return typeof body.reasonCode === "string" && body.reasonCode.length > 0 ? body.reasonCode : "UNREADABLE_REFUSAL";
};

const relay = (socket: Socket, credential: LaunchedCredential): Promise<number> =>
  new Promise((resolveRelay) => {
    let firstLine: Buffer | null = Buffer.alloc(0);
    let exitCode: number = EXIT.STREAM_CLOSED;
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      resolveRelay(code);
    };
    socket.once("connect", () => {
      // The handshake is the first line and nothing of the client's precedes it: stdin stays
      // paused until it is written.
      socket.write(`${JSON.stringify({
        token: credential.token,
        sessionId: credential.sessionId,
        sessionSecret: credential.sessionSecret,
      })}\n`);
      process.stdin.on("data", (chunk: Buffer) => {
        if (!socket.destroyed) socket.write(chunk);
      });
      process.stdin.once("end", () => {
        exitCode = EXIT.OK;
        socket.end();
      });
      process.stdin.resume();
    });
    socket.on("data", (chunk: Buffer) => {
      if (firstLine === null) {
        process.stdout.write(chunk);
        return;
      }
      firstLine = Buffer.concat([firstLine, chunk]);
      const boundary = firstLine.indexOf(0x0a);
      if (boundary === -1) {
        if (firstLine.length > MAX_LINE_BYTES) {
          report("handshake", "OVERSIZED_LINE");
          exitCode = EXIT.HANDSHAKE_REFUSED;
          socket.destroy();
        }
        return;
      }
      const refusal = refusalOf(firstLine.subarray(0, boundary).toString("utf8"));
      if (refusal !== null) {
        report("handshake", refusal);
        exitCode = EXIT.HANDSHAKE_REFUSED;
        socket.destroy();
        return;
      }
      const pending = firstLine;
      firstLine = null;
      process.stdout.write(pending);
    });
    socket.once("error", () => finish(exitCode === EXIT.OK ? EXIT.OK : exitCode));
    socket.once("close", () => finish(exitCode));
  });

const run = async (): Promise<number> => {
  process.stdin.pause();
  const args = parseArguments(process.argv.slice(2));
  if (!args) {
    report("usage", "INVALID_ARGUMENTS");
    return EXIT.USAGE;
  }
  const credential = await claimCredential(args.launchSocketPath, args.externalSessionId);
  if (!credential) {
    report("launch", "CREDENTIAL_UNAVAILABLE");
    return EXIT.LAUNCH_REFUSED;
  }
  return relay(createConnection(args.mcpSocketPath), credential);
};

void run().then(
  (code) => {
    process.exitCode = code;
    // Exit once stdout has drained; a client that stopped reading cannot hold the relay open.
    process.stdout.write("", () => process.exit(code));
  },
  () => {
    report("relay", "INTERNAL_ERROR");
    process.exit(EXIT.STREAM_CLOSED);
  },
);
