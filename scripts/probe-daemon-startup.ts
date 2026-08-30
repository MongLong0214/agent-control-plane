#!/usr/bin/env -S npx tsx
/**
 * Answers one question with evidence instead of inference: can `agentcpd` still reach a
 * listening state, and what must be true of its environment first?
 *
 * WHY this check exists
 *
 *   `main()` in src/daemon/agentcpd.ts fails closed in four separate places — a missing
 *   `ACP_MCP_TOKEN`, a single-instance lock, a startup doctor that reports BLOCKED or
 *   ERROR, and a crash-loop backoff that a *previous* failed start armed. On top of that
 *   `startLocalMcpListeners` now demands a per-connection session credential, so a token
 *   alone no longer produces a usable socket. None of these preconditions is documented,
 *   and each of them is invisible until the daemon refuses to start in production.
 *
 *   This probe runs the real startup path against throwaway state directories under the OS
 *   temp dir — never a real deployment — and records what each stage actually did. Its
 *   output is the deployment requirement list.
 *
 * The probe writes only inside its own temp directories and always removes them.
 *
 * Run: npx tsx scripts/probe-daemon-startup.ts [--json]
 * Exits non-zero if a fully provisioned deployment cannot reach a listening state.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ControlPlane, defaultConfig, type ControlPlaneConfig } from "../src/app/control-plane.ts";
import { startLocalMcpListeners } from "../src/daemon/agentcpd.ts";
import { SessionLifecycle } from "../src/domain/types.ts";

const asJson = process.argv.includes("--json");
const stages: Array<Record<string, unknown>> = [];
const problems: string[] = [];

const HARD_TIMEOUT_MS = 180_000;
const watchdog = setTimeout(() => {
  process.stderr.write("probe-daemon-startup: hard timeout\n");
  process.exit(2);
}, HARD_TIMEOUT_MS);
watchdog.unref();

const summarise = (findings: readonly { code: string; severity: string; blocking: boolean }[]) =>
  findings.map((f) => `${f.code}/${f.severity}${f.blocking ? "/blocking" : ""}`);

/** One scenario = one pristine state directory, so no earlier failure can leak into it. */
const scenario = async (
  label: string,
  prepare: (cp: ControlPlane, config: ControlPlaneConfig) => void,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "acp-daemon-probe-"));
  const config = defaultConfig(root);
  const stage: Record<string, unknown> = { label, ownerIdentities: config.ownerIdentities?.length ?? 0 };
  const cp = new ControlPlane(config);
  try {
    prepare(cp, config);

    const doctor = await cp.doctor.run("system");
    stage["doctorStatus"] = doctor.status;
    stage["doctorFindings"] = summarise(doctor.findings);

    const stateDir = dirname(config.databasePath);
    const daemon = cp.createDaemon({ stateDir });
    const started = await daemon.start();
    stage["daemonStart"] = started.allowed
      ? { allowed: true, reasonCode: started.reasonCode }
      : { allowed: false, reasonCode: started.reasonCode, message: started.message };

    if (started.allowed) {
      stage["mcp"] = await probeListeners(cp, stateDir);
      await daemon.stop();
    }
  } catch (err) {
    stage["error"] = err instanceof Error ? err.message : String(err);
  } finally {
    cp.close();
    rmSync(root, { recursive: true, force: true });
  }
  stages.push(stage);
};

/**
 * The listening state is not "a socket file exists": a peer must get past the deployment
 * token *and* a per-session secret before an MCP server is attached to its connection.
 * All three cases are exercised on the real listener.
 */
const probeListeners = async (cp: ControlPlane, stateDir: string): Promise<Record<string, unknown>> => {
  const result: Record<string, unknown> = {};

  try {
    await startLocalMcpListeners(cp, stateDir, "");
    result["emptyToken"] = "accepted — the token requirement is not enforced";
    problems.push("startLocalMcpListeners accepted an empty ACP_MCP_TOKEN");
  } catch (err) {
    result["emptyToken"] = `refused: ${err instanceof Error ? err.message : String(err)}`;
  }

  const token = "probe-deployment-token";
  const listeners = await startLocalMcpListeners(cp, stateDir, token);
  result["socketPaths"] = listeners.socketPaths;
  result["socketsPresent"] = listeners.socketPaths.every(
    (path) => existsSync(path) && lstatSync(path).isSocket(),
  );
  result["socketModes"] = listeners.socketPaths.map(
    (path) => `0${(lstatSync(path).mode & 0o777).toString(8)}`,
  );

  const target = listeners.socketPaths[0]!;

  // A session that exists and is READY is the only peer identity the transport accepts.
  const session = cp.sessions.create({ provider: "claude", model: "opus" });
  cp.sessions.transition(session.sessionId, SessionLifecycle.READY);
  result["sessionSecretIssued"] = session.sessionSecret !== null;

  result["tokenOnly"] = await handshake(target, { token });
  result["wrongToken"] = await handshake(target, {
    token: "not-the-token",
    sessionId: session.sessionId,
    sessionSecret: session.sessionSecret ?? "",
  });
  result["wrongSecret"] = await handshake(target, {
    token,
    sessionId: session.sessionId,
    sessionSecret: "not-the-secret",
  });
  result["tokenAndSessionSecret"] = await handshake(target, {
    token,
    sessionId: session.sessionId,
    sessionSecret: session.sessionSecret ?? "",
  });

  await listeners.close();
  result["socketsRemovedOnClose"] = listeners.socketPaths.every((path) => !existsSync(path));

  if (!String(result["tokenAndSessionSecret"]).startsWith("initialized")) {
    problems.push(
      `a token plus a valid session secret did not reach an MCP server: ${String(
        result["tokenAndSessionSecret"],
      )}`,
    );
  }
  for (const key of ["tokenOnly", "wrongToken", "wrongSecret"] as const) {
    if (String(result[key]).startsWith("initialized")) {
      problems.push(`${key} handshake reached an MCP server; the credential check is not effective`);
    }
  }
  return result;
};

/** Presents a handshake line, then one MCP `initialize`, and reports what came back. */
const handshake = (path: string, credential: Record<string, string>): Promise<string> =>
  new Promise((resolveOutcome) => {
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const done = (outcome: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveOutcome(outcome);
    };
    const timer = setTimeout(() => done("no response within 4s"), 4000);
    timer.unref();

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(credential)}\n`);
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "acp-startup-probe", version: "0" },
          },
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const boundary = buffer.indexOf("\n");
      if (boundary === -1) return;
      const line = buffer.slice(0, boundary);
      try {
        const parsed = JSON.parse(line) as { result?: { serverInfo?: { name?: string } } };
        const name = parsed.result?.serverInfo?.name;
        done(name ? `initialized by '${name}'` : `initialized: ${line.slice(0, 120)}`);
      } catch {
        done(`unparsable reply: ${line.slice(0, 120)}`);
      }
    });
    socket.on("error", (err) => done(`socket error: ${err.message}`));
    socket.on("close", () => done("connection closed with no reply"));
  });

// --------------------------------------------------------------------------

/**
 * §14.2's structured local capacity file. Buckets exist *only* in this file — the CLI
 * probe contributes runtime health and nothing else — so without one no provider is
 * routable, the CEO role cannot be covered, and the startup doctor blocks. The daemon
 * cannot manufacture it either: its own sensor refresh writes back whatever the file
 * says, so an absent file stays absent.
 */
const writeCapacityFile = (directory: string, provider: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, `${provider}.json`),
    JSON.stringify({
      provider,
      observedAt: new Date().toISOString(),
      runtimeHealth: "HEALTHY",
      buckets: [
        {
          id: `${provider}-5h`,
          remainingPercent: 90,
          resetAt: null,
          capabilities: ["ceo", "cto", "blind-review", "worker"],
        },
      ],
    }),
    { mode: 0o600 },
  );
};

await scenario("bare state directory (nothing provisioned)", () => undefined);

await scenario("trusted GitHub credential installed", (cp) => {
  cp.credentials.install({ token: "probe-token-not-a-real-credential", creatorIdentity: "probe-bot" });
});

await scenario("credential + structured capacity files for both providers", (cp, config) => {
  cp.credentials.install({ token: "probe-token-not-a-real-credential", creatorIdentity: "probe-bot" });
  for (const provider of cp.providers.production().map((adapter) => adapter.provider)) {
    writeCapacityFile(config.capacityDir, provider);
  }
});

/**
 * A refused start is not free: it writes `crash-loop.json` with a `retryNotBefore`, so the
 * *next* start is refused on backoff even when the operator has already fixed the cause.
 * Recorded because it changes what a deployment runbook has to say.
 */
{
  const root = mkdtempSync(join(tmpdir(), "acp-daemon-probe-"));
  const config = defaultConfig(root);
  const stage: Record<string, unknown> = { label: "restart immediately after a refused start" };
  const cp = new ControlPlane(config);
  try {
    const stateDir = dirname(config.databasePath);
    const daemon = cp.createDaemon({ stateDir });
    const first = await daemon.start();
    stage["firstStart"] = { allowed: first.allowed, reasonCode: first.reasonCode };

    cp.credentials.install({ token: "probe-token-not-a-real-credential", creatorIdentity: "probe-bot" });
    for (const provider of cp.providers.production().map((adapter) => adapter.provider)) {
      writeCapacityFile(config.capacityDir, provider);
    }
    const second = await daemon.start();
    stage["secondStartAfterFixingTheCause"] = {
      allowed: second.allowed,
      reasonCode: second.reasonCode,
      message: second.message,
      evidence: second.evidence,
    };
    if (second.allowed) await daemon.stop();
  } catch (err) {
    stage["error"] = err instanceof Error ? err.message : String(err);
  } finally {
    cp.close();
    rmSync(root, { recursive: true, force: true });
  }
  stages.push(stage);
}

if (!stages.some((stage) => stage["mcp"])) {
  const reasons = stages.map((stage) => JSON.stringify(stage["daemonStart"])).join(" | ");
  problems.push(`no scenario reached a listening state; daemon.start() outcomes were: ${reasons}`);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ stages, problems }, null, 2)}\n`);
} else {
  for (const stage of stages) {
    console.log(`--- ${stage["label"]}`);
    for (const [key, value] of Object.entries(stage)) {
      if (key === "label") continue;
      console.log(`  ${key.padEnd(22)} ${JSON.stringify(value)}`);
    }
    console.log("");
  }
  if (problems.length === 0) {
    console.log("OK — a provisioned deployment reaches a listening, credential-gated MCP state");
  } else {
    console.log(`${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
