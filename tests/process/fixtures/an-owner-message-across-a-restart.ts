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
import { fileURLToPath } from "node:url";

import { systemClock } from "../../../src/core/clock.ts";
import { canonicalJson, digestOf } from "../../../src/core/digest.ts";
import { ReasonCode } from "../../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../../src/domain/types.ts";
import { AuditLog } from "../../../src/db/audit.ts";
import { Db } from "../../../src/db/database.ts";
import { IngressGuard } from "../../../src/ingress/ingress-guard.ts";
import { startDaemonTelegramListener } from "../../../src/daemon/agentcpd.ts";
import { TelegramInterruption } from "../../../src/ingress/telegram-router.ts";
import type { TelegramBotTransport } from "../../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../../src/ingress/telegram.ts";
import { boundedSpawnSync } from "../../helpers/bounded-sync-child.ts";
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

export interface BatchCrashReport {
  pid: number;
  root: string;
  consumedIds: readonly string[];
  unconsumedIds: readonly string[];
  claimedRows: number;
}

export interface BatchRetryReport {
  pid: number;
  executions: number;
  offsetAfter: number | null;
  claimedRows: number;
  distinctTurnRequestIds: number;
  consumedIds: readonly string[];
  pendingIds: readonly string[];
}

export interface BatchReceiptReport {
  pid: number;
  completedRows: number;
  receiptRows: number;
  noReplyRows: number;
  otherTurnHasReceipt: boolean;
  duplicateReasonCode: string;
  pendingIds: readonly string[];
}

const BATCH_RUNNING_UPDATE_ID = 4251;
const BATCH_PARKED_UPDATE_IDS = [4252, 4253] as const;
const BATCH_CURRENT_UPDATE_ID = 4254;

const installHermesTarget = (harness: ReturnType<typeof makeHarness>): void => {
  const binding = harness.cp.db.get<{
    actor_id: string;
    assignment_id: string;
    session_id: string;
    session_incarnation: string;
    binding_generation: number;
  }>(
    `SELECT actor_id, assignment_id, session_id, session_incarnation, binding_generation
       FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
    [roleKeyFor(Role.CEO)],
  );
  if (!binding) throw new Error("fixture has no active CEO binding");
  const targetLocator = "hermes-owner-batch-session";
  const receiptPublic = {
    domain: "hermes.target-bind" as const,
    version: 1 as const,
    actor_id: binding.actor_id,
    binding_generation: binding.binding_generation,
    executor_runtime_identity: "hermes-runtime:owner-batch-fixture",
    requested_session_id: targetLocator,
    lineage_root_digest: digestOf({ targetLocator }),
  };
  const targetBindReceipt = { ...receiptPublic, receipt_digest: digestOf(receiptPublic) };
  harness.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES ('target:hermes-owner-batch', ?, 'hermes', ?, ?, ?)`,
    [binding.actor_id, targetLocator, receiptPublic.lineage_root_digest, harness.clock.nowIso()],
  );
  harness.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, binding_generation, assignment_id,
        executor_session_id, executor_session_incarnation, protocol_version, attestation_digest,
        target_bind_receipt_json, target_bind_executor_runtime_identity, attested_at)
     VALUES ('attestation:hermes-owner-batch', 'target:hermes-owner-batch', ?, ?, ?, ?,
             'hermes.target-bind/v1', ?, ?, ?, ?)`,
    [
      binding.binding_generation,
      binding.assignment_id,
      binding.session_id,
      binding.session_incarnation,
      targetBindReceipt.receipt_digest,
      canonicalJson(targetBindReceipt),
      receiptPublic.executor_runtime_identity,
      harness.clock.nowIso(),
    ],
  );
};

/**
 * Telegram's own queue, as the Bot API defines it: an update stays until `getUpdates` is called
 * with an offset past it, and is gone afterwards. Modelling the deletion is the point — a fake
 * that keeps handing the update back forever cannot show a message being lost.
 */
const telegramQueue = (
  updates: readonly TelegramUpdate[],
  sent: string[],
): TelegramBotTransport & {
  readonly queued: () => readonly TelegramUpdate[];
  readonly enqueue: (update: TelegramUpdate) => void;
} => {
  let queue = [...updates];
  return {
    redeliveryRetentionMs: 24 * 60 * 60 * 1000,
    queued: () => queue,
    enqueue: (update) => { queue.push(update); },
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
  options: {
    onDirect?: (input: { text: string }) => string | Promise<string>;
    bind?: boolean;
    installHermesTarget?: boolean;
  } = {},
) => {
  const harness = makeHarness({
    ...(root === undefined ? {} : { root }),
    ownerIdentities: [TEST_OWNER, { channel: CHANNEL, actor: OWNER_ID }],
  });
  if (options.bind !== false) bindCeo(harness);
  if (options.installHermesTarget) installHermesTarget(harness);
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

const batchRows = (db: Db): Array<{ nonce: string; turn_claim_json: string }> =>
  db.all<{ nonce: string; turn_claim_json: string }>(
    `SELECT nonce, turn_claim_json FROM inbound_messages
      WHERE channel = ? AND nonce IN (?, ?, ?) AND turn_claim_json IS NOT NULL
      ORDER BY nonce`,
    [
      CHANNEL,
      `update:${BATCH_PARKED_UPDATE_IDS[0]}`,
      `update:${BATCH_PARKED_UPDATE_IDS[1]}`,
      `update:${BATCH_CURRENT_UPDATE_ID}`,
    ],
  );

const batchCrash = async (): Promise<BatchCrashReport> => {
  const transport = telegramQueue([
    updateFrom(BATCH_RUNNING_UPDATE_ID, BATCH_RUNNING_UPDATE_ID, "batch-running"),
    ...BATCH_PARKED_UPDATE_IDS.map((updateId) =>
      updateFrom(updateId, updateId, `batch-parked-${updateId}`)),
  ], []);
  const current = await listenerOver(
    undefined,
    transport,
    {
      onDirect: () => { throw new TelegramInterruption("after-dispatch"); },
      installHermesTarget: true,
    },
  );
  const root = current.harness.root;
  try {
    await pollOnceAndSettle(current.listener);

    const guard = new IngressGuard(
      current.harness.cp.db,
      systemClock,
      current.harness.cp.audit,
      { [CHANNEL]: { allowedActors: [OWNER_ID], allowedConversations: [CHAT_ID], recoverInFlight: true } },
    );
    const resolved = guard.resolveTurn(CHANNEL, `update:${BATCH_RUNNING_UPDATE_ID}`);
    if (!resolved.allowed) throw new Error(`${resolved.reasonCode}: ${resolved.message}`);

    transport.enqueue(
      updateFrom(BATCH_CURRENT_UPDATE_ID, BATCH_CURRENT_UPDATE_ID, "batch-current"),
    );
    await pollOnceAndSettle(current.listener);
  } finally {
    await current.listener.close().catch(() => undefined);
  }

  const rows = batchRows(current.harness.cp.db);
  const claim = rows[0]?.turn_claim_json
    ? JSON.parse(rows[0].turn_claim_json) as {
        batchConsumedNonces?: string[];
        batchUnconsumedNonces?: string[];
      }
    : {};
  return {
    pid: process.pid,
    root,
    consumedIds: claim.batchConsumedNonces ?? [],
    unconsumedIds: claim.batchUnconsumedNonces ?? [],
    claimedRows: rows.length,
  };
};

const batchRetry = async (root: string): Promise<BatchRetryReport> => {
  let executions = 0;
  const listener = await listenerOver(
    root,
    telegramQueue([
      updateFrom(BATCH_CURRENT_UPDATE_ID, BATCH_CURRENT_UPDATE_ID, "batch-current"),
    ], []),
    {
      bind: false,
      onDirect: () => {
        executions += 1;
        return "must not execute";
      },
    },
  );
  try {
    await pollOnceAndSettle(listener.listener);
  } finally {
    await listener.listener.close().catch(() => undefined);
  }

  const rows = batchRows(listener.harness.cp.db);
  const claims = rows.map((row) => JSON.parse(row.turn_claim_json) as {
    turnRequestId: string;
    batchConsumedNonces?: string[];
  });
  const guard = new IngressGuard(
    listener.harness.cp.db,
    systemClock,
    listener.harness.cp.audit,
    { [CHANNEL]: { allowedActors: [OWNER_ID], allowedConversations: [CHAT_ID], recoverInFlight: true } },
  );
  return {
    pid: process.pid,
    executions,
    offsetAfter: listener.listener.service.offset ?? null,
    claimedRows: rows.length,
    distinctTurnRequestIds: new Set(claims.map((claim) => claim.turnRequestId)).size,
    consumedIds: claims[0]?.batchConsumedNonces ?? [],
    pendingIds: guard.pendingOwnerMessages(expectedSessionDigest()).map((item) => item.nonce),
  };
};

const batchReceipt = (root: string): BatchReceiptReport => {
  const harness = makeHarness({
    root,
    ownerIdentities: [TEST_OWNER, { channel: CHANNEL, actor: OWNER_ID }],
  });
  const guard = new IngressGuard(
    harness.cp.db,
    systemClock,
    harness.cp.audit,
    { [CHANNEL]: { allowedActors: [OWNER_ID], allowedConversations: [CHAT_ID], recoverInFlight: true } },
  );
  const currentNonce = `update:${BATCH_CURRENT_UPDATE_ID}`;
  const query = guard.receiptIdentityForClaim(CHANNEL, currentNonce);
  if (!query) throw new Error("claimed batch has no authenticated receipt identity");
  const receipt = {
    outcome: "ABORTED" as const,
    receiptId: "receipt:owner-batch",
    evidenceDigest: digestOf({ query, outcome: "ABORTED" }),
    reasonCode: ReasonCode.HERMES_AGENT_RUN_EXCEPTION,
  };
  const completed = guard.completeClaimFromHermesReceipt(CHANNEL, currentNonce, query, receipt);
  if (!completed.allowed) throw new Error(`${completed.reasonCode}: ${completed.message}`);
  const duplicate = guard.completeClaimFromHermesReceipt(CHANNEL, currentNonce, query, receipt);
  if (!duplicate.allowed) throw new Error(`${duplicate.reasonCode}: ${duplicate.message}`);

  const rows = harness.cp.db.all<{ nonce: string; result_json: string | null; turn_claim_json: string }>(
    `SELECT nonce, result_json, turn_claim_json FROM inbound_messages
      WHERE channel = ? AND nonce IN (?, ?, ?) ORDER BY nonce`,
    [
      CHANNEL,
      `update:${BATCH_PARKED_UPDATE_IDS[0]}`,
      `update:${BATCH_PARKED_UPDATE_IDS[1]}`,
      currentNonce,
    ],
  );
  const claims = rows.map((row) => JSON.parse(row.turn_claim_json) as Record<string, unknown>);
  const other = harness.cp.db.get<{ turn_claim_json: string }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [CHANNEL, `update:${BATCH_RUNNING_UPDATE_ID}`],
  );
  const otherClaim = other?.turn_claim_json
    ? JSON.parse(other.turn_claim_json) as Record<string, unknown>
    : {};
  return {
    pid: process.pid,
    completedRows: rows.filter((row) =>
      (JSON.parse(row.result_json ?? "null") as { kind?: unknown } | null)?.kind === "TELEGRAM_NO_REPLY").length,
    receiptRows: claims.filter((claim) =>
      (claim["hermesReceipt"] as { receiptId?: unknown } | undefined)?.receiptId === receipt.receiptId).length,
    noReplyRows: claims.filter((claim) => typeof claim["noReplyAt"] === "string").length,
    otherTurnHasReceipt: otherClaim["hermesReceipt"] !== undefined,
    duplicateReasonCode: duplicate.reasonCode,
    pendingIds: guard.pendingOwnerMessages(expectedSessionDigest()).map((item) => item.nonce),
  };
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
  mode: "lose" | "redeliver" | "recover" | "next-message" | "batch-crash" | "batch-retry" | "batch-receipt",
  ...args: readonly string[]
): T => {
  const done = boundedSpawnSync(process.execPath, ["--import", "tsx", SCRIPT, mode, ...args], {
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
  if (mode === "batch-crash") {
    process.stdout.write(`${JSON.stringify(await batchCrash())}\n`);
    return;
  }
  if (mode === "batch-retry") {
    process.stdout.write(`${JSON.stringify(await batchRetry(rest[0] ?? ""))}\n`);
    return;
  }
  if (mode === "batch-receipt") {
    process.stdout.write(`${JSON.stringify(batchReceipt(rest[0] ?? ""))}\n`);
    return;
  }
  throw new Error(`unknown mode: ${String(mode)}`);
};

// Only when this file *is* the process. Imported by the test for its constants and helpers, it
// must not run any half.
if (process.argv[1] === SCRIPT) {
  await main();
}
