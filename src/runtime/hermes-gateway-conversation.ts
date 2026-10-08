import { request } from "node:http";

import { allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { CeoTurnOutcome } from "../mcp/ceo-conversation.ts";
import type { DaemonNoticeBody, DaemonNoticeSendOutcome } from "./acp-daemon-notice.ts";
import {
  createHermesGatewayIdentityReader, type HermesGatewayIdentity,
} from "./hermes-gateway-identity.ts";

const PATH = "/v1/canonical-surface/events";
const MAX_REPLY_BYTES = 16_384;
const MAX_REQUEST_BYTES = 16_384;
const TIMEOUT_MS = 5_000;
const safeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 &&
  !/[\x00-\x1f\x7f]/.test(value);

const refused = (reason: typeof ReasonCode.CEO_CONVERSATION_STALE |
  typeof ReasonCode.CEO_CONVERSATION_UNAVAILABLE): CeoTurnOutcome => ({
  contact: "NEVER_REACHED", answered: deny(reason, "Gateway canonical turn refused before dispatch"),
});
const uncertain = (): CeoTurnOutcome => ({
  contact: "REACHED", answered: deny(ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED,
    "Gateway canonical turn may have reached the existing session"),
});

export interface HermesGatewayConversationOptions {
  /** Separately provisioned by the daemon; never accepted from a Buzz message. */
  apiKey: string;
  binding: string;

  /** Snapshot pinned by the daemon: all four fields must match the live GET before POST. */
  expected: HermesGatewayIdentity;
  /** Synchronous authority check after the awaited GET, at the POST dispatch boundary. */
  preDispatch?: () => boolean;
  /** Ephemeral test listener only; production uses fixed 127.0.0.1:8642. */
  port?: number;
}

export interface GatewayEventSource {
  eventId: string;
  actor: string;
  conversation: string;
}

/** One existing-only event turn; never spawns a process or creates a session. */
export const createHermesGatewayConversationSender = (options: HermesGatewayConversationOptions):
  ((text: string, source: GatewayEventSource) => Promise<CeoTurnOutcome>) => {
  const readIdentity = createHermesGatewayIdentityReader({ apiKey: options.apiKey, port: options.port });
  return async (text, source) => {
    const expected = options.expected;
    if (!safeIdentifier(options.binding) || !safeIdentifier(source?.eventId) ||
        !safeIdentifier(source.actor) || !safeIdentifier(source.conversation) ||
        typeof text !== "string" || text.length === 0 ||
        !Number.isSafeInteger(options.port ?? 8642) || (options.port ?? 8642) < 1 ||
        (options.port ?? 8642) > 65535 || !expected ||
        !safeIdentifier(expected.session_id) || !safeIdentifier(expected.process_started_at) ||
        !/^sha256:[a-f0-9]{64}$/.test(expected.lineage_root_digest) ||
        !Number.isSafeInteger(expected.process_pid) || expected.process_pid <= 0 ||
        !/^[\x21-\x7e]+$/.test(options.apiKey)) {
      return refused(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
    }
    const body = JSON.stringify({ binding: options.binding, event_id: source.eventId,
      author_id: source.actor, channel_id: source.conversation, text,
      session_id: expected.session_id, lineage_root_digest: expected.lineage_root_digest,
      process_pid: expected.process_pid, process_started_at: expected.process_started_at });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return refused(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
    let current: HermesGatewayIdentity;
    try { current = await readIdentity(); }
    catch { return refused(ReasonCode.CEO_CONVERSATION_UNAVAILABLE); }
    if (current.session_id !== expected.session_id ||
        current.lineage_root_digest !== expected.lineage_root_digest ||
        current.process_pid !== expected.process_pid ||
        current.process_started_at !== expected.process_started_at) {
      return refused(ReasonCode.CEO_CONVERSATION_STALE);
    }

    return new Promise<CeoTurnOutcome>((resolve) => {
      let reached = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: CeoTurnOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };
      try {
        const req = request({ hostname: "127.0.0.1", family: 4, port: options.port ?? 8642,
          path: PATH, method: "POST", agent: false,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body) } }, (res) => {
          if (res.statusCode !== 200 ||
              (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json" ||
              Number(res.headers["content-length"] ?? 0) > MAX_REPLY_BYTES) {
            finish(uncertain());
            res.destroy();
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) { finish(uncertain()); res.destroy(); }
            else chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              const answer: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!answer || typeof answer !== "object" || Array.isArray(answer) ||
                  JSON.stringify(Object.keys(answer).sort()) !== JSON.stringify(["event_id", "text"]) ||
                  (answer as Record<string, unknown>).event_id !== source.eventId ||
                  typeof (answer as Record<string, unknown>).text !== "string") {
                finish(uncertain());
                return;
              }
              finish({ contact: "REACHED", answered: allow(ReasonCode.OK,
                (answer as { text: string }).text) });
            } catch { finish(uncertain()); }
          });
          res.on("error", () => finish(uncertain()));
          res.on("aborted", () => finish(uncertain()));
        });
        req.on("error", () => finish(reached ? uncertain() : refused(ReasonCode.CEO_CONVERSATION_UNAVAILABLE)));
        timer = setTimeout(() => { finish(reached ? uncertain() : refused(ReasonCode.CEO_CONVERSATION_UNAVAILABLE)); req.destroy(); }, TIMEOUT_MS);
        let authorized = true;
        try { authorized = options.preDispatch ? options.preDispatch() === true : true; }
        catch { authorized = false; }
        if (!authorized) {
          finish(refused(ReasonCode.CEO_CONVERSATION_STALE));
          req.destroy();
          return;
        }
        reached = true;
        req.end(body);
      } catch { finish(reached ? uncertain() : refused(ReasonCode.CEO_CONVERSATION_UNAVAILABLE)); }
    });
  };
};

export interface HermesGatewayDaemonNoticeOptions {
  /** The same daemon-provisioned Gateway key; it authenticates the channel, not the sender. */
  apiKey: string;
  /** Synchronous authority check after the awaited identity GET, at the POST dispatch boundary. */
  preDispatch?: () => boolean;
  /** Ephemeral test listener only; production uses fixed 127.0.0.1:8642. */
  port?: number;
  /** Tests only: the answer deadline; production keeps the conversation sender's 5 s. */
  timeoutMs?: number;
}

/**
 * `acp-daemon-notice/v1`: one signed daemon notice to the CEO's existing canonical conversation, on
 * the same route and with the same pinned destination as the conversation sender above. No
 * `author_id` and no `channel_id`: the body is exactly the contract's, sealed by the caller.
 *
 * The Gateway's identity is read first and must equal the notice's `destination` field for field, as
 * the conversation sender requires of its pin; the notice is never redirected. The answer is returned
 * as it came — any status, the body parsed when it is JSON — because whether it settles the notice is
 * the delivery record's decision, not the transport's. Only an answer that was never read is
 * `UNCERTAIN`, and only a request that never left is `NOT_SENT`.
 */
export const createHermesGatewayDaemonNoticeSender = (options: HermesGatewayDaemonNoticeOptions):
  ((body: DaemonNoticeBody) => Promise<DaemonNoticeSendOutcome>) => {
  const port = options.port ?? 8642;
  const readIdentity = createHermesGatewayIdentityReader({ apiKey: options.apiKey, port: options.port });
  return async (notice) => {
    const destination = notice?.destination;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[\x21-\x7e]+$/.test(options.apiKey) ||
        !destination || !safeIdentifier(destination.session_id) || !safeIdentifier(destination.process_started_at) ||
        !/^sha256:[a-f0-9]{64}$/.test(destination.lineage_root_digest) ||
        !Number.isSafeInteger(destination.process_pid) || destination.process_pid <= 0 ||
        !/^acp-notice(?:-probe)?:[a-f0-9]{64}$/.test(notice.event_id)) {
      return { kind: "NOT_SENT", reason: "INVALID" };
    }
    const body = JSON.stringify(notice);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return { kind: "NOT_SENT", reason: "INVALID" };
    let current: HermesGatewayIdentity;
    try { current = await readIdentity(); }
    catch { return { kind: "NOT_SENT", reason: "IDENTITY_UNAVAILABLE" }; }
    if (current.session_id !== destination.session_id ||
        current.lineage_root_digest !== destination.lineage_root_digest ||
        current.process_pid !== destination.process_pid ||
        current.process_started_at !== destination.process_started_at) {
      return { kind: "NOT_SENT", reason: "STALE" };
    }

    return new Promise<DaemonNoticeSendOutcome>((resolve) => {
      let reached = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: DaemonNoticeSendOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };
      const lost = (reason: string): DaemonNoticeSendOutcome =>
        reached ? { kind: "UNCERTAIN", reason } : { kind: "NOT_SENT", reason };
      try {
        const req = request({ hostname: "127.0.0.1", family: 4, port, path: PATH, method: "POST", agent: false,
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body) } }, (res) => {
          const status = res.statusCode ?? 0;
          if (Number(res.headers["content-length"] ?? 0) > MAX_REPLY_BYTES) {
            finish({ kind: "UNCERTAIN", reason: "OVERSIZED" });
            res.destroy();
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) { finish({ kind: "UNCERTAIN", reason: "OVERSIZED" }); res.destroy(); }
            else chunks.push(chunk);
          });
          res.on("end", () => {
            const json = (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
            let parsed: unknown = null;
            if (json) {
              try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { parsed = null; }
            }
            finish({ kind: "RESPONDED", status, body: parsed });
          });
          res.on("error", () => finish({ kind: "UNCERTAIN", reason: "RESPONSE_ERROR" }));
          res.on("aborted", () => finish({ kind: "UNCERTAIN", reason: "RESPONSE_ABORTED" }));
        });
        req.on("error", () => finish(lost("TRANSPORT_ERROR")));
        timer = setTimeout(() => { finish(lost("TIMEOUT")); req.destroy(); }, options.timeoutMs ?? TIMEOUT_MS);
        let authorized = true;
        try { authorized = options.preDispatch ? options.preDispatch() === true : true; }
        catch { authorized = false; }
        if (!authorized) {
          finish({ kind: "NOT_SENT", reason: "STALE" });
          req.destroy();
          return;
        }
        reached = true;
        req.end(body);
      } catch { finish(lost("TRANSPORT_ERROR")); }
    });
  };
};
