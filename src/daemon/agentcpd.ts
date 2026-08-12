#!/usr/bin/env node
import { dirname } from "node:path";

import { ControlPlane, defaultConfig } from "../app/control-plane.ts";
import { BuzzAdapter, BuzzCliTransport } from "../buzz/buzz-adapter.ts";
import { isAcpError } from "../core/errors.ts";
import { Daemon } from "./daemon.ts";

/**
 * `agentcpd` — the single local runtime authority (PRD §33.1).
 *
 * Intended to run under a process supervisor (`launchd` on macOS). The daemon owns the
 * single-instance lock, restart reconciliation, the watchdog timer and Buzz delivery.
 */
const main = async (): Promise<void> => {
  const config = defaultConfig();
  const cp = new ControlPlane(config);

  const buzz = new BuzzAdapter(
    cp.db,
    cp.clock,
    cp.audit,
    cp.sessions,
    cp.bindings,
    cp.outbox,
    new BuzzCliTransport(process.env["ACP_BUZZ_BINARY"] ?? "buzz", process.env["ACP_BUZZ_CHANNEL"] ?? null),
  );
  cp.cto.attach({
    buzz: {
      connect: (sessionId, purpose) => buzz.connect(sessionId, purpose),
      disconnect: (sessionId) => buzz.disconnect(sessionId),
    },
    readiness: { checkSession: (id) => cp.doctor.sessionReadiness(id) },
  });

  const daemon = new Daemon(cp, { stateDir: dirname(config.databasePath), buzz });

  const started = await daemon.start();
  if (!started.allowed) {
    process.stderr.write(`${JSON.stringify(started, null, 2)}\n`);
    process.stderr.write(
      `backoff: ${JSON.stringify(daemon.crashLoopState())}\n`,
    );
    cp.close();
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify({ started: started.value }, null, 2)}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nshutting down on ${signal}\n`);
    await daemon.stop();
    cp.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Keep the process alive; all work is timer- and MCP-driven.
  setInterval(() => daemon.writeHealth(null), 30_000).unref();
  await new Promise<void>(() => undefined);
};

main().catch((err: unknown) => {
  const body = isAcpError(err)
    ? { reasonCode: err.reasonCode, message: err.message, evidence: err.evidence }
    : { message: (err as Error).message, stack: (err as Error).stack };
  process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exit(1);
});
