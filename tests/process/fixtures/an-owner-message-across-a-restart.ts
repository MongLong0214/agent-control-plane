/**
 * A restart taken as three processes, so the loss window is a real one.
 *
 * `lose` drives one owner message through the production Telegram entry point
 * (`startDaemonTelegramListener` → `pollOnce`) until the turn is claimed, then dies with no reply
 * — the shape of a daemon killed mid-turn. `redeliver` is a *different* process that opens the
 * same state root and polls again with the update still in Telegram's queue, because the offset
 * never advanced past it. `recover` is a third process that asks the database alone what the
 * owner wrote.
 *
 * Three processes rather than three objects, for the same reason #639's fixture uses two: the
 * property is about what survives a process boundary, and a value that never left memory passes
 * any in-process rehearsal of it. The `redeliver` half exists because the loss is not visible in
 * the database alone — it is the poller confirming Telegram's only copy away while producing no
 * answer, and only a real poll does that.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { systemClock } from "../../../src/core/clock.ts";
import { digestOf } from "../../../src/core/digest.ts";
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
export const CHANNEL = "telegram";
/** The owner's words. The one thing in this fixture that exists nowhere else. */
export const PROMPT = "배포 멈춰. 지금 올라간 커밋 되돌려.";
export const UPDATE_ID = 4242;
export const MESSAGE_ID = 7;
/** What the owner sends after the restart, to see what ACP tells them about the lost one. */
export const NEXT_PROMPT = "아까 그거 어떻게 됐어?";
export const NEXT_UPDATE_ID = 4243;
export const NEXT_MESSAGE_ID = 8;

const updateFrom = (updateId: number, messageId: number, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: messageId,
    date: 1_700_000_000,
    text,
    from: { id: Number(OWNER_ID), username: "owner" },
    chat: { id: Number(CHAT_ID) },
  },
});

/** What `lose` reports before its process ends. */
export interface LoseReport {
  pid: number;
  root: string;
  databasePath: string;
  /** The claim the dying process left behind, so the next half is looking at a real one. */
  claimed: boolean;
}

/** What `redeliver` reports, having restarted over the same state root. */
export interface RedeliverReport {
  pid: number;
  /** Every text this restart actually sent to the owner. Empty means they were told nothing. */
  sent: readonly string[];
  /**
   * The offset the poller holds after the redelivered update. `UPDATE_ID + 1` means Telegram has
   * been told to drop it, and the only copy of the owner's words outside ACP is gone.
   */
  offsetAfter: number | null;
}

/** What `recover` reports, asking the file alone. */
export interface RecoverReport {
  pid: number;
  /** Through `IngressGuard.unresolvedTurns` — the production reader a reconciler would use. */
  unresolved: Array<Record<string, unknown>>;
  /** What the owner wrote, as the database can produce it. `null` when nothing holds it. */
  recoveredText: string | null;
  recoveredMessageId: number | null;
}

/** What `nextMessage` reports: what ACP tells the owner about the turn it lost. */
export interface NextMessageReport {
  pid: number;
  sent: readonly string[];
}

/**
 * Telegram's own queue, as the Bot API defines it: an update stays until `getUpdates` is called
 * with an offset past it, and is gone afterwards. Modelling the deletion is the point — a fake
 * that keeps handing the update back forever cannot show a message being lost.
 */
const telegramQueue = (
  updates: readonly TelegramUpdate[],
  sent: string[],
): TelegramBotTransport & { readonly queued: () => readonly TelegramUpdate[] } => {
  let queue = [...updates];
  return {
    redeliveryRetentionMs: 24 * 60 * 60 * 1000,
    queued: () => queue,
    getUpdates: async (options) => {
      if (options.offset !== undefined) {
        queue = queue.filter((update) => update.update_id >= options.offset!);
      }
      return [...queue];
    },
    sendMessage: async (input) => {
      sent.push(input.text);
      return { messageId: 100 + sent.length };
    },
  };
};

const listenerOver = async (
  root: string | undefined,
  transport: TelegramBotTransport,
  options: { onDirect?: () => never; bind?: boolean } = {},
) => {
  const harness = makeHarness({
    ...(root === undefined ? {} : { root }),
    ownerIdentities: [TEST_OWNER, { channel: CHANNEL, actor: OWNER_ID }],
  });
  if (options.bind !== false) bindCeo(harness);
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
      transport,
      start: false,
      ...(options.onDirect ? { onDirect: options.onDirect } : {}),
    },
  );
  return { harness, listener };
};

const pollOnceAndSettle = async (
  listener: Awaited<ReturnType<typeof listenerOver>>["listener"],
): Promise<void> => {
  const cycle = await listener.service.pollOnce();
  await listener.service.pendingTurnsSettled().catch(() => undefined);
  await cycle.settled().catch(() => undefined);
};

const lose = async (): Promise<LoseReport> => {
  const sent: string[] = [];
  const { harness, listener } = await listenerOver(
    undefined,
    telegramQueue([updateFrom(UPDATE_ID, MESSAGE_ID, PROMPT)], sent),
    // The death, placed after the turn is claimed and before any reply exists — the window
    // #631 names. A handler that returns normally resolves the turn, and a resolved turn has
    // nothing left to lose.
    { onDirect: () => { throw new TelegramInterruption("after-admission"); } },
  );
  try {
    await pollOnceAndSettle(listener);
  } finally {
    await listener.close().catch(() => undefined);
  }
  const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [CHANNEL, `update:${UPDATE_ID}`],
  );
  return {
    pid: process.pid,
    root: harness.root,
    databasePath: harness.cp.db.file,
    claimed: Boolean(row?.turn_claim_json),
  };
};

const redeliver = async (root: string): Promise<RedeliverReport> => {
  const sent: string[] = [];
  // Telegram still holds the update: the dying process never advanced its offset past it, so
  // this is exactly what the Bot API hands a restarted daemon.
  const transport = telegramQueue([updateFrom(UPDATE_ID, MESSAGE_ID, PROMPT)], sent);
  const { listener } = await listenerOver(root, transport, { bind: false });
  try {
    await pollOnceAndSettle(listener);
  } finally {
    await listener.close().catch(() => undefined);
  }
  return {
    pid: process.pid,
    sent,
    offsetAfter: listener.service.offset ?? null,
  };
};

const nextMessage = async (root: string): Promise<NextMessageReport> => {
  const sent: string[] = [];
  const { listener } = await listenerOver(
    root,
    telegramQueue([updateFrom(NEXT_UPDATE_ID, NEXT_MESSAGE_ID, NEXT_PROMPT)], sent),
    { bind: false },
  );
  try {
    await pollOnceAndSettle(listener);
  } finally {
    await listener.close().catch(() => undefined);
  }
  return { pid: process.pid, sent };
};

const recover = (databasePath: string, sessionDigest: string): RecoverReport => {
  const db = new Db(databasePath);
  const guard = new IngressGuard(db, systemClock, new AuditLog(db, systemClock), {
    [CHANNEL]: {
      allowedActors: [OWNER_ID],
      allowedConversations: [CHAT_ID],
      recoverInFlight: true,
    },
  });
  const unresolved = guard.unresolvedTurns(CHANNEL, sessionDigest) as unknown as Array<
    Record<string, unknown>
  >;
  const payload = unresolved[0]?.["payload"];
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const text = record?.["text"];
  const messageId = record?.["messageId"];
  return {
    pid: process.pid,
    unresolved,
    recoveredText: typeof text === "string" ? text : null,
    recoveredMessageId: typeof messageId === "number" ? messageId : null,
  };
};

/** The session digest the claim stores, derived here rather than read back from the row. */
export const expectedSessionDigest = (): string =>
  digestOf({ channel: CHANNEL, conversation: CHAT_ID });

const SCRIPT = fileURLToPath(import.meta.url);

/** Runs one half in its own OS process and returns what it printed. */
export const runInItsOwnProcess = <T>(
  mode: "lose" | "redeliver" | "recover" | "next-message",
  ...args: readonly string[]
): T => {
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
  if (mode === "lose") {
    process.stdout.write(`${JSON.stringify(await lose())}\n`);
    return;
  }
  if (mode === "redeliver") {
    process.stdout.write(`${JSON.stringify(await redeliver(rest[0] ?? ""))}\n`);
    return;
  }
  if (mode === "next-message") {
    process.stdout.write(`${JSON.stringify(await nextMessage(rest[0] ?? ""))}\n`);
    return;
  }
  if (mode === "recover") {
    process.stdout.write(`${JSON.stringify(recover(rest[0] ?? "", rest[1] ?? ""))}\n`);
    return;
  }
  throw new Error(`unknown mode: ${String(mode)}`);
};

// Only when this file *is* the process. Imported by the test for its constants and helpers, it
// must not run any half.
if (process.argv[1] === SCRIPT) {
  await main();
}
