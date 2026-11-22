import { existsSync } from "node:fs";
import { hostname } from "node:os";

import { digestOf } from "../core/digest.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { withDatabaseSnapshotAsync } from "../db/database-snapshot.ts";
import type { Db } from "../db/database.ts";
import { type HermesTargetHead, judgeLiveHead, readHermesTargetHead } from "../session/hermes-target-head.ts";
import { recordedStartIsLive } from "../session/runtime-lineage.ts";
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
import {
  DAEMON_NOTICES_PATH, createHermesGatewayDaemonNoticeSender, probeDaemonNoticeRoute,
} from "../runtime/hermes-gateway-conversation.ts";
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

/**
 * What the bound lends a transport. `begin` is called synchronously right before the request leaves, and the
 * transport sends only if it answers true: once the bound has expired it answers false for good, so a
 * lookup that finishes late cannot start a send. `signal` aborts what is in flight when the bound expires.
 */
export interface RefusalNoticeDispatch {
  begin(): boolean;
  signal: AbortSignal;
}

/** The route as the start resolved it, or why it cannot be. The two ports are the test seam. */
export type RefusalNoticeRoute =
  | { configured: false; reason: string }
  | {
      configured: true;
      laneSecret: string;
      destination(signal: AbortSignal): Promise<DaemonNoticeDestination>;
      send(body: DaemonNoticeBody, dispatch: RefusalNoticeDispatch): Promise<DaemonNoticeSendOutcome>;
    };

export interface RefusalNoticeOptions {
  route: RefusalNoticeRoute;
  /** The whole delivery's bound: the refusal waits no longer than this for it. */
  timeoutMs?: number;
  host?: string;
}

/** The one reason a destination the active CEO binding does not name is refused, whatever differed. */
export const DESTINATION_MISMATCH = "destination does not match the active CEO binding";
/** The one reason a Gateway that does not confirm the signed daemon-notice route is told nothing. */
export const NO_NOTICE_ROUTE = "receiver has no signed daemon-notice route";

/** The one reason a notice is not sent because the process the binding names changed after it was checked. */
export const DESTINATION_CHANGED = "destination changed before dispatch";

/** A refusal to send, with what was observed beside the reason (recorded as `detail`). */
class NoticeNotSent extends Error {
  constructor(message: string, readonly detail?: string) { super(message); }
}

/** The active CEO binding as a private copy of the database says it is, with the process it names. */
interface ActiveCeoBinding {
  sessionId: string;
  osPid: number;
  osProcessStartedAt: string;
  /** The native start pinned for the session, when one is. */
  pinnedStart: string | null;
  target: HermesTargetHead;
}

/**
 * The active CEO binding, read the way the outbox route's pin reads it (`configuredHermesCeoPin`: the ACTIVE
 * assignment, its READY Hermes session at the bound incarnation with a recorded process, and the actor's
 * target head), but from a private copy of the database files. The live database is never opened. Null is
 * no binding, or one the pin would not accept.
 */
const readActiveCeoBinding = async (databasePath: string, lineageRootDigest: string): Promise<ActiveCeoBinding | null> => {
  if (!existsSync(databasePath)) return null;
  return withDatabaseSnapshotAsync(databasePath, (copy): ActiveCeoBinding | null => {
    try {
      const rows = copy.prepare(
        `SELECT a.actor_id AS actorId, a.session_id AS sessionId, a.session_incarnation AS incarnation,
                COALESCE(c.current_session_id, a.session_id) AS liveSessionId,
                COALESCE(c.current_session_incarnation, a.session_incarnation) AS liveIncarnation,
                s.lifecycle AS lifecycle, s.incarnation AS sessionIncarnation, s.provider AS provider,
                s.os_pid AS osPid, s.os_process_started_at AS osProcessStartedAt
           FROM assignments a
           LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
           JOIN sessions s ON s.session_id = COALESCE(c.current_session_id, a.session_id)
          WHERE a.role_key = 'CEO' AND a.status = 'ACTIVE'`,
      ).all() as Array<{
        actorId: string; sessionId: string; incarnation: string; liveSessionId: string; liveIncarnation: string;
        lifecycle: string; sessionIncarnation: string; provider: string; osPid: number | null;
        osProcessStartedAt: string | null;
      }>;
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      if (row.liveSessionId !== row.sessionId || row.liveIncarnation !== row.incarnation) return null;
      if (row.lifecycle !== "READY" || row.sessionIncarnation !== row.incarnation || row.provider !== "hermes" ||
          !Number.isSafeInteger(row.osPid) || !row.osPid || row.osPid <= 0 || !row.osProcessStartedAt) return null;
      const db = { all: (sql: string, params: unknown[] = []) => copy.prepare(sql).all(...params) } as Pick<Db, "all">;
      const target = readHermesTargetHead(db, row.actorId);
      if (!target || target.executorKind !== "hermes" || target.lineageRootDigest !== lineageRootDigest) return null;
      const pin = copy.prepare(
        `SELECT evidence_json FROM audit_events WHERE kind = 'SESSION_NATIVE_START_PINNED' AND session_id = ?
          ORDER BY event_id LIMIT 1`,
      ).get(row.sessionId) as { evidence_json: string } | undefined;
      let pinnedStart: string | null = null;
      if (pin) {
        try {
          const startedAt = (JSON.parse(pin.evidence_json) as { startedAt?: unknown } | null)?.startedAt;
          pinnedStart = typeof startedAt === "string" ? startedAt : null;
        } catch { pinnedStart = null; }
      }
      return { sessionId: row.sessionId, osPid: row.osPid, osProcessStartedAt: row.osProcessStartedAt, pinnedStart, target };
    } catch {
      // A schema older than the binding tables has no binding to name.
      return null;
    }
  });
};

/** The process reads the binding is held to; tests replace them, production reads `ps` and the native start. */
export interface RefusalNoticeProcessPorts {
  processStartToken?: typeof readProcessStartToken;
  processStartedAt?: typeof processStartedAt;
}

/**
 * Whether the Gateway's own report names the process and conversation the active CEO binding names: the
 * recorded process is alive as recorded, the Gateway's pid and native start are that process's, and its head
 * is the binding's lineage's head (`judgeLiveHead`). A head that has moved forward inside the lineage is
 * accepted but not recorded: recording it writes the database.
 */
const matchesBinding = (
  binding: ActiveCeoBinding,
  reported: DaemonNoticeDestination,
  ports: RefusalNoticeProcessPorts,
): boolean => {
  const startToken = liveStartToken(binding, ports);
  if (startToken === null) return false;
  if (reported.process_pid !== binding.osPid || reported.process_started_at !== startToken) return false;
  return judgeLiveHead(binding.target, reported).verdict !== "REFUSE";
};

/**
 * The native start token of the process the binding names, when that process is alive as recorded and its
 * start is the one pinned for the session; null otherwise. Synchronous, so it can be asked again at the
 * instant before the request leaves, as the outbox route's `preDispatch` asks `currentAuthority`.
 */
const liveStartToken = (binding: ActiveCeoBinding, ports: RefusalNoticeProcessPorts): string | null => {
  if ((ports.processStartedAt ?? processStartedAt)(binding.osPid) !== binding.osProcessStartedAt) return null;
  const startToken = (ports.processStartToken ?? readProcessStartToken)(binding.osPid);
  if (!startToken) return null;
  const recordedStart = recordedStartIsLive(
    { sessionId: binding.sessionId, osProcessStartedAt: binding.osProcessStartedAt },
    startToken,
    { pinnedNativeStart: () => binding.pinnedStart },
  );
  return recordedStart.allowed ? startToken : null;
};

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
  /** The database file whose private copy names the active CEO binding. */
  databasePath: string;
  ports?: RefusalNoticeProcessPorts;
}): RefusalNoticeRoute => {
  if (!input.noticeEnabled) return { configured: false, reason: "ACP_DAEMON_NOTICE_ENABLED is not 1" };
  if (!input.adoption) return { configured: false, reason: "no Hermes adoption configuration" };
  const laneSecret = input.laneSecret?.trim();
  if (!laneSecret) return { configured: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" };
  const { apiKey, port, lineageRootDigest } = input.adoption;
  // The binding the destination was checked against, held for the check made again right before the POST.
  let checkedBinding: ActiveCeoBinding | null = null;
  return {
    configured: true,
    laneSecret,
    destination: async (signal) => {
      // The binding first, from a private copy: with none, the Gateway is not asked at all.
      const binding = await readActiveCeoBinding(input.databasePath, lineageRootDigest);
      if (!binding) throw new Error(DESTINATION_MISMATCH);
      checkedBinding = binding;
      const identity = await createHermesGatewayIdentityReader({ apiKey, port, signal })();
      if (identity.lineage_root_digest !== lineageRootDigest || !matchesBinding(binding, identity, input.ports ?? {})) {
        throw new Error(DESTINATION_MISMATCH);
      }
      // Then, before anything is sent: the receiver says it has the route. Not confirmed is not sent, and this
      // notice goes nowhere else (not `/events`, not Buzz).
      const route = await probeDaemonNoticeRoute({ port, signal });
      if (!route.supported) throw new NoticeNotSent(NO_NOTICE_ROUTE, route.detail);
      return { ...identity };
    },
    // The sender asks `preDispatch` synchronously before it writes the request, and answers NOT_SENT when told no.
    // The endpoint is named, never read from an origin the notice does not have.
    send: async (body, dispatch) => {
      // Synchronously, as the request is about to leave: the bound process is still alive as recorded, and
      // its native start is still the one the destination names. The bound is asked second, so a notice that
      // is not sent for this reason never counts as begun.
      let changed = false;
      const result = await createHermesGatewayDaemonNoticeSender({
        apiKey, port, path: DAEMON_NOTICES_PATH, signal: dispatch.signal,
        preDispatch: () => {
          const binding = checkedBinding;
          changed = binding === null || body.destination.process_pid !== binding.osPid ||
            liveStartToken(binding, input.ports ?? {}) !== body.destination.process_started_at;
          return !changed && dispatch.begin();
        },
      })(body);
      if (changed) throw new NoticeNotSent(DESTINATION_CHANGED);
      return result;
    },
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

export const UNKNOWN_AT_TIMEOUT = "request in flight at timeout; receipt cannot be assumed either way";

/**
 * Sends the one notice for this refusal, bounded by `timeoutMs`, and says what happened. Never throws and
 * never touches the database: the caller writes the answer into `crash-loop.json`.
 *
 * The bound is on the send, not only on the return. When it expires before the request began, `begin` says
 * no from then on and nothing is ever sent, whenever the lookup finishes; the outcome is `failed`. When it
 * expires with the request already out, the outcome is `unknown`: the receiver may or may not have it, and
 * neither is claimed. What is in flight is aborted either way.
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
  const controller = new AbortController();
  let expired = false;
  let dispatched = false;
  const dispatch: RefusalNoticeDispatch = {
    signal: controller.signal,
    begin: () => {
      if (expired || dispatched) return false;
      dispatched = true;
      return true;
    },
  };
  const attempt = async (): Promise<RefusalNoticeOutcome> => {
    const destination = await route.destination(controller.signal);
    if (expired) throw new Error("the bound expired before the request began");
    const { messageId, text } = refusalNoticeMessage(refusal, context);
    // The outbox's own derivation for a one-part CEO notification, so the id is stable for this refusal.
    eventId = daemonNoticeEventId(messageId, "CEO", `CEO_NOTIFICATION:${digestOf(destination)}:0`);
    const body = sealDaemonNotice(daemonNoticeCanonical(daemonNoticeFields(eventId, destination, text)),
      daemonNoticeKey(route.laneSecret));
    // Checked synchronously with the call: nothing between this line and the transport's `begin` yields.
    if (expired) throw new Error("the bound expired before the request began");
    const result = await route.send(body, dispatch);
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
    timer = setTimeout(() => {
      expired = true;
      const outcome: RefusalNoticeOutcome = dispatched && eventId
        ? { outcome: "unknown", at: nowIso(), eventId, reason: UNKNOWN_AT_TIMEOUT }
        : { outcome: "failed", at: nowIso(), ...(eventId ? { eventId } : {}),
            reason: `timeout after ${timeoutMs}ms before the request began; nothing was sent` };
      controller.abort();
      resolve(outcome);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      attempt().catch((error: unknown): RefusalNoticeOutcome => ({
        outcome: "failed", at: nowIso(), ...(eventId ? { eventId } : {}), reason: reasonOf(error),
        ...(error instanceof NoticeNotSent && error.detail ? { detail: error.detail } : {}),
      })),
      bound,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const refusalHost = (): string => hostname();
