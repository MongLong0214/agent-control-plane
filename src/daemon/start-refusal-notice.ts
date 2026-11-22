import { hostname } from "node:os";

import { digestOf } from "../core/digest.ts";
import {
  type DaemonNoticeBody,
  type DaemonNoticeDestination,
  type DaemonNoticeSendOutcome,
  daemonNoticeCanonical,
  daemonNoticeEventId,
  daemonNoticeFields,
  daemonNoticeKey,
  daemonNoticeSettlement,
  sealDaemonNotice,
} from "../runtime/acp-daemon-notice.ts";
import { createHermesGatewayDaemonNoticeSender } from "../runtime/hermes-gateway-conversation.ts";
import { createHermesGatewayIdentityReader } from "../runtime/hermes-gateway-identity.ts";
import type { CrashLoopFile, RefusalNoticeOutcome } from "./crash-loop.ts";

/**
 * #1496 — a start the pre-open gate refused tells the CEO, through the route the outbox's CEO notifications
 * already use (the canonical `acp-daemon-notice/v1` surface of the pinned Hermes CEO Gateway), and never
 * through the database or the outbox.
 *
 * The outbox route resolves its destination from the database (the CEO binding, its session, its pinned
 * process). A start refused before the database is opened must not read it, so the destination here is what
 * the Gateway itself reports at `/v1/canonical-surface/identity`, held to the configured lineage root: the
 * same four fields the outbox pin sends, taken from the Gateway instead of the row that names its process.
 * The signer is the same (HKDF key from the ACP-Hermes lane secret), so the Gateway authenticates this notice
 * exactly as it authenticates the outbox's. The notice's wrapper is the outbox's too (`ACP notification <id>
 * part 1/1: {messageId, kind: CEO_NOTIFICATION, payload}`), so the CEO reads it as it reads any other.
 *
 * What is configured is the route's own switch (`ACP_DAEMON_NOTICE_ENABLED=1`), the lane secret
 * (`ACP_TELEGRAM_EXTERNAL_SECRET`) and the Hermes adoption variables. Without them the outcome is
 * `route-unconfigured` and nothing is sent. The outcome is recorded in `crash-loop.json` only.
 */
export const REFUSAL_NOTICE_TIMEOUT_MS = 8_000;
export const REFUSAL_NOTICE_SOURCE = "DAEMON_START_REFUSED_BEFORE_OPEN";
const MAX_NOTICE_FINDINGS = 10;
const MAX_NOTICE_TEXT = 1_500;

/** The route as the start resolved it, or why it cannot be. The two ports are the test seam. */
export type RefusalNoticeRoute =
  | { configured: false; reason: string }
  | {
      configured: true;
      laneSecret: string;
      destination(): Promise<DaemonNoticeDestination>;
      send(body: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome>;
    };

export interface RefusalNoticeOptions {
  route: RefusalNoticeRoute;
  /** The whole delivery's bound: the refusal waits no longer than this for it. */
  timeoutMs?: number;
  host?: string;
}

/** What `configuredHermesAdoptionValues` hands over: only the three values this route reads. */
export interface RefusalNoticeAdoption {
  apiKey: string;
  port: number;
  lineageRootDigest: string;
}

/**
 * The same conditions `startEnabledCeoNotificationRoute` checks, in the same order, resolved to the pinned
 * Gateway's own readback. A Gateway whose lineage is not the configured one is not the CEO and is not told.
 */
export const refusalNoticeRouteFrom = (input: {
  noticeEnabled: boolean;
  adoption: RefusalNoticeAdoption | null;
  laneSecret: string | undefined;
}): RefusalNoticeRoute => {
  if (!input.noticeEnabled) return { configured: false, reason: "ACP_DAEMON_NOTICE_ENABLED is not 1" };
  if (!input.adoption) return { configured: false, reason: "no Hermes adoption configuration" };
  const laneSecret = input.laneSecret?.trim();
  if (!laneSecret) return { configured: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" };
  const { apiKey, port, lineageRootDigest } = input.adoption;
  const readIdentity = createHermesGatewayIdentityReader({ apiKey, port });
  return {
    configured: true,
    laneSecret,
    destination: async () => {
      const identity = await readIdentity();
      if (identity.lineage_root_digest !== lineageRootDigest) throw new Error("the Gateway's lineage is not the configured one");
      return { ...identity };
    },
    send: async (body) => createHermesGatewayDaemonNoticeSender({ apiKey, port })(body),
  };
};

type Refusal = NonNullable<CrashLoopFile["lastRefusal"]>;

/** The notice a CEO reads: every field the receiver needs to match it to `lastRefusal`. */
export const refusalNoticeMessage = (
  refusal: Refusal,
  context: { failures: number; retryNotBefore: string | null },
): { messageId: string; text: string } => {
  const messageId = `start-refusal:${refusal.refusalId}`;
  const build = (findings: Refusal["blockingFindings"]): string => {
    const wrapped = JSON.stringify({
      messageId,
      kind: "CEO_NOTIFICATION",
      payload: {
        source: REFUSAL_NOTICE_SOURCE,
        refusalId: refusal.refusalId,
        reasonCode: refusal.reasonCode,
        stage: refusal.stage,
        doctorStatus: refusal.doctorStatus,
        blockingFindings: findings,
        blockingFindingsTotal: refusal.blockingFindings.length,
        host: refusal.host,
        at: refusal.at,
        failures: context.failures,
        retryNotBefore: context.retryNotBefore,
        databaseWritten: false,
        statement:
          "ACP refused this start before it opened the database; nothing was written to it. The refusal is recorded " +
          "in crash-loop.json lastRefusal under the same refusalId, and each later start is judged again.",
      },
    });
    return `ACP notification ${messageId} part 1/1: ${wrapped}`;
  };
  let keep = Math.min(MAX_NOTICE_FINDINGS, refusal.blockingFindings.length);
  let text = build(refusal.blockingFindings.slice(0, keep));
  while (text.length > MAX_NOTICE_TEXT && keep > 1) {
    keep -= 1;
    text = build(refusal.blockingFindings.slice(0, keep));
  }
  return { messageId, text };
};

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, " ").slice(0, 200);

/**
 * Sends the one notice for this refusal, bounded by `timeoutMs`, and says what happened. Never throws and
 * never touches the database: the caller writes the answer into `crash-loop.json`.
 */
export const deliverRefusalNotice = async (
  refusal: Refusal,
  context: { failures: number; retryNotBefore: string | null },
  options: RefusalNoticeOptions,
  nowIso: () => string,
): Promise<RefusalNoticeOutcome> => {
  const route = options.route;
  if (!route.configured) return { outcome: "route-unconfigured", at: nowIso(), reason: route.reason };
  const timeoutMs = options.timeoutMs ?? REFUSAL_NOTICE_TIMEOUT_MS;
  let eventId: string | undefined;
  const attempt = async (): Promise<RefusalNoticeOutcome> => {
    const destination = await route.destination();
    const { messageId, text } = refusalNoticeMessage(refusal, context);
    // The outbox's own derivation for a one-part CEO notification, so the id is stable for this refusal.
    eventId = daemonNoticeEventId(messageId, "CEO", `CEO_NOTIFICATION:${digestOf(destination)}:0`);
    const body = sealDaemonNotice(daemonNoticeCanonical(daemonNoticeFields(eventId, destination, text)),
      daemonNoticeKey(route.laneSecret));
    const result = await route.send(body);
    if (result.kind !== "RESPONDED") {
      return { outcome: "failed", at: nowIso(), eventId, reason: `${result.kind}: ${result.reason}` };
    }
    const settled = daemonNoticeSettlement(result.status, result.body, {
      eventId: body.event_id, payloadDigest: body.payload_digest, destination,
    });
    return settled.settled
      ? { outcome: "delivered", at: nowIso(), eventId, receiptId: settled.receiptId }
      : { outcome: "failed", at: nowIso(), eventId, reason: `not settled (status ${result.status}): ${settled.mismatches.join(",")}` };
  };
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<RefusalNoticeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({
      outcome: "failed", at: nowIso(), ...(eventId ? { eventId } : {}), reason: `timeout after ${timeoutMs}ms`,
    }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      attempt().catch((error: unknown): RefusalNoticeOutcome => ({
        outcome: "failed", at: nowIso(), ...(eventId ? { eventId } : {}), reason: reasonOf(error),
      })),
      bound,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const refusalHost = (): string => hostname();
