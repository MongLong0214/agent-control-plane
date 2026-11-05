#!/usr/bin/env node
/**
 * #246 C1b — the acp-cto relay a provisioned session's headless turn runs as its only MCP server.
 *
 * Claude Code spawns this once per turn (`ClaudeCliAdapter.runSessionTurn`, `--strict-mcp-config`).
 * O4b B' — it claims the credential of the one session it was started for over raw Mach: it
 * `process.dlopen`s the native mach-launch addon (the one Node built-in that loads it) and makes one
 * bounded claim on the daemon's launch service, off the event loop. It then presents the credential as
 * the first line on the CTO MCP socket and copies bytes both ways. The daemon re-verifies the credential
 * on every request, so one it has since rotated stops working mid-connection, not only at the next one.
 *
 * What it is given on its command line is the addon path, the MCP socket path and the session's provider
 * id, none of them a secret, plus `--iso-service` in an isolated test. The relay accepts `--iso-service`
 * from its argv, so whoever writes that argv chooses the name it claims on: it is the adapter, which writes
 * it and passes `--iso-service` only when it was constructed with an isolated name, that fixes the
 * production name to the launchd-reserved one compiled in here. The relay does not check the reply's
 * `replier`: trusting the reply rests on launchd's protection of that reserved name (a same-uid process
 * cannot check it in), not on mutual authentication of the daemon's instance. Any claim failure —
 * the addon missing, the service absent, a daemon refusal, a dropped reply or a timeout — is a refusal:
 * the relay exits and never falls back to AF_UNIX or any other transport. The credential exists in this
 * process's memory only: never written to stdout, stderr, a file or the environment, and the closed
 * stderr vocabulary is `session-relay: <stage> <code>`. There is no retry and no reconnect.
 *
 * Self-contained by design — Node built-ins only, and only syntax Node can strip — because the
 * turn's sandbox re-opens exactly this file (and the addon it dlopens) for reading and nothing it
 * might import.
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

/**
 * O4b B' — the launchd-reserved Mach launch service name. A literal copy of
 * `MACH_LAUNCH_RESERVED_SERVICE` in `src/daemon/agentcpd.ts` and `src/runtime/cli-adapters.ts`, kept in
 * sync by hand because this relay imports nothing — it must stay loadable from the one file the turn's
 * sandbox reopens. It is the name claimed unless `--iso-service` is on the argv; it is never read from
 * configuration or the environment. A production claim stays on it because the adapter that writes the
 * argv never passes `--iso-service` there, not because this file could refuse one.
 */
const RESERVED_SERVICE = "com.agentcontrolplane.agentcpd.launch";

interface RelayArguments {
  addonPath: string;
  serviceName: string;
  mcpSocketPath: string;
  externalSessionId: string;
}

interface LaunchedCredential {
  token: string;
  sessionId: string;
  sessionSecret: string;
}

/** The subset of the native addon this relay uses: one bounded claim over raw Mach. */
interface MachLaunchClaimAddon {
  claim(serviceName: string, body: Buffer, timeoutMs: number): Promise<{ code: string; body?: Buffer }>;
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
    if (name !== "--addon" && name !== "--iso-service" && name !== "--mcp" && name !== "--session") return null;
    if (values.has(name)) return null;
    values.set(name, value);
  }
  const addonPath = values.get("--addon");
  const mcpSocketPath = values.get("--mcp");
  const externalSessionId = values.get("--session");
  if (!addonPath || !mcpSocketPath || !externalSessionId) return null;
  // The reserved name is the default; `--iso-service` is the only way to claim another, and the adapter
  // passes it only when constructed with an isolated name (a test). There is no environment or configuration input here.
  const serviceName = values.get("--iso-service") ?? RESERVED_SERVICE;
  return { addonPath, serviceName, mcpSocketPath, externalSessionId };
};

/**
 * `process.dlopen` the native addon — the one Node built-in that loads it, the same way the daemon
 * loads its side — and return just the claim surface. Null when the addon is unavailable, which is a
 * refusal, never a reason to try another transport.
 */
const loadClaimAddon = (addonPath: string): MachLaunchClaimAddon | null => {
  const module = { exports: {} as Partial<MachLaunchClaimAddon> };
  try {
    process.dlopen(module, addonPath);
  } catch {
    return null;
  }
  return typeof module.exports.claim === "function" ? (module.exports as MachLaunchClaimAddon) : null;
};

/**
 * One bounded claim over raw Mach: look the service up, send one request naming the session, and wait
 * for the daemon's reply off the event loop. Any outcome other than a well-formed credential is a
 * refusal (NATIVE_UNAVAILABLE, SERVICE_UNAVAILABLE, a daemon refusal, DROPPED, TIMED_OUT), and there is
 * no AF_UNIX attempt for a driven turn.
 */
const claimCredential = async (
  addonPath: string,
  serviceName: string,
  externalSessionId: string,
): Promise<LaunchedCredential | null> => {
  const addon = loadClaimAddon(addonPath);
  if (!addon) {
    report("launch", "NATIVE_UNAVAILABLE");
    return null;
  }
  let result: { code: string; body?: Buffer };
  try {
    result = await addon.claim(serviceName, Buffer.from(JSON.stringify({ externalSessionId }), "utf8"), LAUNCH_TIMEOUT_MS);
  } catch {
    report("launch", "CLAIM_ERROR");
    return null;
  }
  if (result.code !== "OK" || !result.body) {
    report("launch", result.code || "REFUSED");
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(result.body.toString("utf8")) as unknown;
  } catch {
    report("launch", "MALFORMED_REPLY");
    return null;
  }
  const reply = (body ?? {}) as { ok?: unknown; token?: unknown; sessionId?: unknown; sessionSecret?: unknown };
  if (
    reply.ok !== true ||
    typeof reply.token !== "string" || reply.token.length === 0 ||
    typeof reply.sessionId !== "string" || reply.sessionId.length === 0 ||
    typeof reply.sessionSecret !== "string" || reply.sessionSecret.length === 0
  ) {
    report("launch", "MALFORMED_REPLY");
    return null;
  }
  return { token: reply.token, sessionId: reply.sessionId, sessionSecret: reply.sessionSecret };
};

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
  const credential = await claimCredential(args.addonPath, args.serviceName, args.externalSessionId);
  if (!credential) {
    // claimCredential already reported the specific stage; this is the single refusal exit.
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
