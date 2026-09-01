/**
 * A durable Telegram turn is claimed in one OS process and revisited by another. The restart
 * uses the production HermesReceiptPort seam, not a hand-built receipt object, so the test can
 * distinguish a terminal executor result from a caller merely repeating the turn identity.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson, digestOf } from "../../../src/core/digest.ts";
import { Role, roleKeyFor } from "../../../src/domain/types.ts";
import { startDaemonTelegramListener } from "../../../src/daemon/agentcpd.ts";
import { TelegramInterruption } from "../../../src/ingress/telegram-router.ts";
import type { TelegramBotTransport } from "../../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../../src/ingress/telegram.ts";
import type { HermesAcpExecute, HermesAcpResult } from "../../../src/runtime/hermes-acp-client.ts";
import type { HermesReceiptPortOptions } from "../../../src/runtime/hermes-receipt-port.ts";
import { bindCeo, makeHarness, TEST_OWNER } from "../../helpers/harness.ts";

export const OWNER_ID = "424242";
export const CHAT_ID = "-100999";
export const UPDATE_ID = 4242;
export const PROMPT = "did Hermes finish this exact turn?";

type ReceiptMode = "matching" | "missing" | "wrong-turn" | "wrong-runtime" | "corrupt";

export interface LostReport {
  pid: number;
  root: string;
  directCalls: number;
  turnRequestId: string | null;
}

export interface RestartReport {
  pid: number;
  directCalls: number;
  executorCalls: number;
  offsetsRequested: Array<number | null>;
  offsetAfter: number | null;
  noReplyAt: string | null;
  receiptId: string | null;
}

const update: TelegramUpdate = {
  update_id: UPDATE_ID,
  message: {
    message_id: 7,
    date: 1_700_000_000,
    text: PROMPT,
    from: { id: Number(OWNER_ID), username: "owner" },
    chat: { id: Number(CHAT_ID) },
  },
};

const telegramConfig = {
  botToken: "fake-bot-token",
  allowedOwnerIds: [OWNER_ID],
  allowedChatIds: [CHAT_ID],
  webhookSecret: "telegram-configured-secret",
  pollTimeoutSeconds: 1,
  retryDelayMs: 1,
} as const;

const daemonStub = { finalizeApprovedRun: async (): Promise<void> => undefined };

const receiptOptions = (
  mode: ReceiptMode,
  executorCalls: { value: number },
): HermesReceiptPortOptions => ({
  executable: "fixture-hermes",
  cwd: "/tmp",
  home: "/tmp",
  hermesHome: "/tmp",
  hermesProfile: "default",
  timeoutMs: 1_000,
  maxStdoutBytes: 16_384,
  maxStderrBytes: 16_384,
  maxLineBytes: 16_384,
  execute: (async (input) => {
    executorCalls.value += 1;
    if (mode === "missing") return { status: "NEVER_FOUND" };
    if (mode === "corrupt") return { status: "FAILED", reason: "MALFORMED_TERMINAL_RECEIPT" };
    const identity = mode === "wrong-turn"
      ? { ...input.receiptIdentity, turnRequestId: "tr_wrong_turn" }
      : mode === "wrong-runtime"
        ? { ...input.receiptIdentity, executorSessionId: "runtime:wrong" }
        : input.receiptIdentity;
    return {
      status: "ABORTED",
      receiptIdentity: identity,
      receiptId: `receipt:${mode}`,
      evidenceDigest: digestOf({ mode, identity }),
      reasonCode: "HERMES_EXECUTOR_ABORTED",
    } satisfies HermesAcpResult;
  }) satisfies HermesAcpExecute,
});

const transportFor = (offsetsRequested: Array<number | null>): TelegramBotTransport => ({
  redeliveryRetentionMs: 24 * 60 * 60 * 1000,
  getUpdates: async ({ offset }) => {
    offsetsRequested.push(offset ?? null);
    return offset === undefined || offset <= UPDATE_ID ? [update] : [];
  },
  sendMessage: async () => ({ messageId: 1 }),
});

/** Installs an authenticated, historical Hermes target proof for the CEO that bindCeo created. */
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
  const targetBindingId = "target:hermes-ceo";
  const targetLocator = "hermes-owner-session";
  const runtimeIdentity = "hermes-runtime:fixture";
  const receiptPublic = {
    domain: "hermes.target-bind" as const,
    version: 1 as const,
    actor_id: binding.actor_id,
    binding_generation: binding.binding_generation,
    executor_runtime_identity: runtimeIdentity,
    requested_session_id: targetLocator,
    lineage_root_digest: digestOf({ targetLocator }),
  };
  const targetBindReceipt = { ...receiptPublic, receipt_digest: digestOf(receiptPublic) };
  harness.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [targetBindingId, binding.actor_id, targetLocator, receiptPublic.lineage_root_digest, harness.clock.nowIso()],
  );
  harness.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, binding_generation, assignment_id,
        executor_session_id, executor_session_incarnation, protocol_version, attestation_digest,
        target_bind_receipt_json, target_bind_executor_runtime_identity, attested_at)
     VALUES (?, ?, ?, ?, ?, ?, 'hermes.target-bind/v1', ?, ?, ?, ?)`,
    [
      "attestation:hermes-ceo",
      targetBindingId,
      binding.binding_generation,
      binding.assignment_id,
      binding.session_id,
      binding.session_incarnation,
      targetBindReceipt.receipt_digest,
      canonicalJson(targetBindReceipt),
      runtimeIdentity,
      harness.clock.nowIso(),
    ],
  );
};

const claim = async (): Promise<LostReport> => {
  const executorCalls = { value: 0 };
  const harness = makeHarness({
    ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    hermesReceipt: receiptOptions("missing", executorCalls),
  });
  bindCeo(harness);
  installHermesTarget(harness);
  const offsets: Array<number | null> = [];
  let directCalls = 0;
  const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
    transport: transportFor(offsets),
    start: false,
    onDirect: () => {
      directCalls += 1;
      throw new TelegramInterruption("after-admission");
    },
  });
  try {
    const cycle = await listener.service.pollOnce();
    await listener.service.pendingTurnsSettled().catch(() => undefined);
    await cycle.settled().catch(() => undefined);
  } finally {
    await listener.close().catch(() => undefined);
  }
  const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [`update:${UPDATE_ID}`],
  );
  const turnRequestId = row?.turn_claim_json
    ? (JSON.parse(row.turn_claim_json) as { turnRequestId?: unknown }).turnRequestId
    : null;
  return {
    pid: process.pid,
    root: harness.root,
    directCalls,
    turnRequestId: typeof turnRequestId === "string" ? turnRequestId : null,
  };
};

const restart = async (root: string, mode: ReceiptMode): Promise<RestartReport> => {
  const executorCalls = { value: 0 };
  const harness = makeHarness({
    root,
    ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    hermesReceipt: receiptOptions(mode, executorCalls),
  });
  const offsets: Array<number | null> = [];
  let directCalls = 0;
  const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
    transport: transportFor(offsets),
    start: false,
    onDirect: () => {
      directCalls += 1;
      return "this must never run on a redelivery";
    },
  });
  try {
    const first = await listener.service.pollOnce();
    await listener.service.pendingTurnsSettled();
    await first.settled();
    // A second request proves the committed acknowledgement is the next offset exactly once,
    // rather than merely a local service field that was advanced without affecting getUpdates.
    await listener.service.pollOnce();
  } finally {
    await listener.close();
  }
  const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [`update:${UPDATE_ID}`],
  );
  const claim = row?.turn_claim_json ? JSON.parse(row.turn_claim_json) as Record<string, unknown> : {};
  const receipt = claim["hermesReceipt"] as { receiptId?: unknown } | undefined;
  return {
    pid: process.pid,
    directCalls,
    executorCalls: executorCalls.value,
    offsetsRequested: offsets,
    offsetAfter: listener.service.offset ?? null,
    noReplyAt: typeof claim["noReplyAt"] === "string" ? claim["noReplyAt"] : null,
    receiptId: typeof receipt?.receiptId === "string" ? receipt.receiptId : null,
  };
};

const SCRIPT = fileURLToPath(import.meta.url);

export const runInItsOwnProcess = <T>(mode: "claim" | "restart", ...args: readonly string[]): T => {
  const done = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, mode, ...args], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (done.status !== 0) throw new Error(`${mode} process exited ${done.status}\n${done.stdout}\n${done.stderr}`);
  return JSON.parse(done.stdout.trim().split("\n").at(-1) ?? "null") as T;
};

const main = async (): Promise<void> => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "claim") {
    process.stdout.write(`${JSON.stringify(await claim())}\n`);
    return;
  }
  if (mode === "restart") {
    process.stdout.write(`${JSON.stringify(await restart(args[0] ?? "", args[1] as ReceiptMode))}\n`);
    return;
  }
  throw new Error(`unknown mode: ${String(mode)}`);
};

if (process.argv[1] === SCRIPT) await main();
