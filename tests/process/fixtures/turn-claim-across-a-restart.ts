/**
 * The two halves of a restart, as two processes, so the boundary is real.
 *
 * `claim` builds a control plane, binds a CEO, and drives one owner message through the
 * production Telegram entry point (`startDaemonTelegramListener` → `pollOnce`) until the turn is
 * claimed, then crashes the handler and exits. `read` is a different process that opens the same
 * database file and asks the production reader what it holds.
 *
 * Two processes rather than two objects on purpose. The property #639's contract 1 needs is that
 * a claim's identity is still there for a reconciler that runs after the process that wrote it is
 * gone, and the existing coverage for that ("keeps it byte-identical when the row is read back by
 * a new guard") builds a second `IngressGuard` over the *same* live `Db` handle — a value that
 * never left memory would satisfy it. Nothing in that test can fail if the write never reached the
 * file.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { systemClock } from "../../../src/core/clock.ts";
import { digestOf } from "../../../src/core/digest.ts";
import { Role, roleKeyFor } from "../../../src/domain/types.ts";
import { AuditLog } from "../../../src/db/audit.ts";
import { Db } from "../../../src/db/database.ts";
import { IngressGuard } from "../../../src/ingress/ingress-guard.ts";
import { startDaemonTelegramListener } from "../../../src/daemon/agentcpd.ts";
import { TelegramInterruption } from "../../../src/ingress/telegram-router.ts";
import type { TelegramBotTransport } from "../../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../../src/ingress/telegram.ts";
import { bindCeo, makeHarness, TEST_OWNER } from "../../helpers/harness.ts";

export const OWNER_ID = "424242";
export const CHAT_ID = "-100999";
export const PROMPT = "지금 무슨 상태야?";
export const CHANNEL = "telegram";

/** What `claim` reports about the turn it made, before its process ends. */
export interface ClaimReport {
  pid: number;
  root: string;
  databasePath: string;
  /** Read from the binding registry, not from the claim — the value the digest must encode. */
  ceoGeneration: number | null;
  /** The claim as the writing process itself saw it, for the field-by-field comparison. */
  inProcessClaim: Record<string, unknown> | null;
}

/** What `read` reports, having opened the file with the writer gone. */
export interface ReadReport {
  pid: number;
  /** Through `IngressGuard.unresolvedTurns` — the one production reader of `turn_claim_json`. */
  unresolved: Array<Record<string, unknown>>;
}

const transportFor = (updates: readonly TelegramUpdate[]): TelegramBotTransport => {
  let pending: readonly TelegramUpdate[] = updates;
  return {
    redeliveryRetentionMs: 24 * 60 * 60 * 1000,
    getUpdates: async () => {
      const next = [...pending];
      pending = [];
      return next;
    },
    sendMessage: async () => ({ messageId: 1 }),
  };
};

const claim = async (): Promise<ClaimReport> => {
  const harness = makeHarness({
    ownerIdentities: [TEST_OWNER, { channel: CHANNEL, actor: OWNER_ID }],
  });
  bindCeo(harness);
  const ceoGeneration = harness.cp.bindings.active(roleKeyFor(Role.CEO))?.bindingGeneration ?? null;

  const listener = await startDaemonTelegramListener(
    harness.cp,
    {
      botToken: "fake-bot-token",
      allowedOwnerIds: [OWNER_ID],
      allowedChatIds: [CHAT_ID],
      webhookSecret: "telegram-configured-secret",
      pollTimeoutSeconds: 1,
      retryDelayMs: 1,
    },
    { finalizeApprovedRun: async (): Promise<void> => undefined },
    {
      transport: transportFor([{
        update_id: 4242,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: PROMPT,
          from: { id: Number(OWNER_ID), username: "owner" },
          chat: { id: Number(CHAT_ID) },
        },
      }]),
      start: false,
      // The crash, placed after the claim and before any reply exists. A handler that returns
      // normally resolves the turn, and a resolved turn is not what a reconciler after a restart
      // is looking at.
      onDirect: () => { throw new TelegramInterruption("after-admission"); },
    },
  );

  try {
    const cycle = await listener.service.pollOnce();
    await listener.service.pendingTurnsSettled().catch(() => undefined);
    await cycle.settled().catch(() => undefined);
  } finally {
    await listener.close().catch(() => undefined);
  }

  const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = ? AND turn_claim_json IS NOT NULL`,
    [CHANNEL],
  );
  return {
    pid: process.pid,
    root: harness.root,
    databasePath: harness.cp.db.file,
    ceoGeneration,
    inProcessClaim: row?.turn_claim_json
      ? (JSON.parse(row.turn_claim_json) as Record<string, unknown>)
      : null,
  };
};

const read = (databasePath: string, sessionDigest: string): ReadReport => {
  const db = new Db(databasePath);
  const guard = new IngressGuard(db, systemClock, new AuditLog(db, systemClock), {
    [CHANNEL]: {
      allowedActors: [OWNER_ID],
      allowedConversations: [CHAT_ID],
      recoverInFlight: true,
    },
  });
  return {
    pid: process.pid,
    unresolved: guard.unresolvedTurns(CHANNEL, sessionDigest) as unknown as Array<Record<string, unknown>>,
  };
};

/** The session digest the claim must have stored, derived here rather than read back from it. */
export const expectedSessionDigest = (): string =>
  digestOf({ channel: CHANNEL, conversation: CHAT_ID });

/** The binding digest a turn claimed under `generation` must carry. */
export const expectedBindingDigest = (generation: number | null): string =>
  digestOf({ bindingGeneration: generation });

/** The prompt digest, from the text the owner sent. */
export const expectedPromptDigest = (): string => digestOf(PROMPT);

const SCRIPT = fileURLToPath(import.meta.url);

/** Runs one half in its own OS process and returns what it printed. */
export const runInItsOwnProcess = <T>(mode: "claim" | "read", ...args: readonly string[]): T => {
  const done = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, mode, ...args], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (done.status !== 0) {
    throw new Error(`${mode} process exited ${done.status}\n${done.stdout}\n${done.stderr}`);
  }
  return JSON.parse(done.stdout.trim().split("\n").at(-1) ?? "null") as T;
};

const main = async (): Promise<void> => {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "claim") {
    process.stdout.write(`${JSON.stringify(await claim())}\n`);
    return;
  }
  if (mode === "read") {
    process.stdout.write(`${JSON.stringify(read(rest[0] ?? "", rest[1] ?? ""))}\n`);
    return;
  }
  throw new Error(`unknown mode: ${String(mode)}`);
};

// Only when this file *is* the process. Imported by the test for its constants and helpers, it
// must not run either half.
if (process.argv[1] === SCRIPT) {
  await main();
}
