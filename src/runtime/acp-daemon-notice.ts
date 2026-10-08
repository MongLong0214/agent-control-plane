import { createHash, createHmac, hkdfSync } from "node:crypto";

/**
 * `acp-daemon-notice/v1` (ACP-RESTART-04, #1068 finding 04): the notice ACP owes the CEO for a
 * queued peer message it refused, pushed into the CEO's existing canonical conversation as a daemon
 * notice — neither owner speech nor CTO speech — without waiting for a successor CTO to relay it.
 *
 * The contract both sides build against fixes every byte here: the request body, the canonical
 * serialization, the digest, the HKDF-derived key and the HMAC. This module is the ACP half of it and
 * nothing else: it decides no delivery and holds no secret. `tests/fixtures/acp-daemon-notice-v1-vector.json`
 * is the shared test vector the Hermes side asserts too.
 *
 * What the signature proves, stated as the contract states it: the sender holds the ACP↔Hermes lane
 * secret, and the notice is bound to its exact protocol, principal, binding, destination and payload.
 * It does not prove the sender is agentcpd rather than another process of the same user that can read
 * that secret. HKDF separates this use of the secret from the Telegram lane's; it is not an identity
 * proof between holders.
 */
export const DAEMON_NOTICE_PROTOCOL = "acp-daemon-notice/v1";
export const DAEMON_NOTICE_PRINCIPAL = "acp-daemon";
export const DAEMON_NOTICE_BINDING = "acp-canonical-ceo";
/** The notice text's ceiling, in characters (UTF-16 code units, as the text is built). */
export const DAEMON_NOTICE_MAX_TEXT = 2000;

const HKDF_SALT = "acp-hermes-lane";
const HKDF_INFO = DAEMON_NOTICE_PROTOCOL;

/** The four fields ACP pins for the CEO Gateway today, as the Gateway itself names them. */
export interface DaemonNoticeDestination {
  session_id: string;
  lineage_root_digest: string;
  process_pid: number;
  process_started_at: string;
}

/** The signed fields: everything in the body except the digest and the signature over them. */
export interface DaemonNoticeFields {
  protocol: typeof DAEMON_NOTICE_PROTOCOL;
  principal: typeof DAEMON_NOTICE_PRINCIPAL;
  binding: typeof DAEMON_NOTICE_BINDING;
  event_id: string;
  destination: DaemonNoticeDestination;
  text: string;
}

export interface DaemonNoticeBody extends DaemonNoticeFields {
  payload_digest: string;
  signature: string;
}

const sha256Hex = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");

/**
 * The notice's stable identity: `acp-notice:` and the sha256 of `<message_id>\n<role_key>\n<reason>`,
 * the key of its OWED entry in `peer_message_refusal_notices`. Derived, never stored first, so a
 * restart arrives at the same id and a retry can never mint a new one.
 */
export const daemonNoticeEventId = (messageId: string, roleKey: string, reason: string): string =>
  `acp-notice:${sha256Hex(`${messageId}\n${roleKey}\n${reason}`)}`;

/**
 * RFC 8785 (JCS) for this restricted shape: objects with keys sorted by UTF-16 code unit at every
 * level, strings, and safe integers. No whitespace. A string is serialized exactly as
 * `JSON.stringify` serializes it, which is JCS's own rule: `"` and `\` escaped, control characters as
 * their short escape or `\u00xx`, everything else — non-ASCII included — as itself, then UTF-8.
 * Anything outside the shape (arrays, floats, booleans, null) is refused rather than guessed at.
 */
export const canonicalJson = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("the daemon notice shape has integers only");
    return String(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("the daemon notice shape has objects, strings and integers only");
};

/** The canonical bytes of exactly the six signed fields, as a string (UTF-8 is the encoding). */
export const daemonNoticeCanonical = (fields: DaemonNoticeFields): string =>
  canonicalJson({
    protocol: fields.protocol,
    principal: fields.principal,
    binding: fields.binding,
    event_id: fields.event_id,
    destination: {
      session_id: fields.destination.session_id,
      lineage_root_digest: fields.destination.lineage_root_digest,
      process_pid: fields.destination.process_pid,
      process_started_at: fields.destination.process_started_at,
    },
    text: fields.text,
  });

export const daemonNoticePayloadDigest = (canonical: string): string => `sha256:${sha256Hex(canonical)}`;

/**
 * K = HKDF-SHA256(IKM = the lane secret, salt = `acp-hermes-lane`, info = `acp-daemon-notice/v1`, 32).
 * Returned to the caller that signs and dropped with it; never stored, never logged.
 */
export const daemonNoticeKey = (laneSecret: string): Buffer => {
  if (typeof laneSecret !== "string" || laneSecret.length === 0) {
    throw new Error("the daemon notice key needs the lane secret");
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(laneSecret, "utf8"), Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"), 32));
};

export const daemonNoticeSignature = (key: Buffer, canonical: string): string =>
  `hmac-sha256:${createHmac("sha256", key).update(canonical, "utf8").digest("hex")}`;

/** The body for already-canonical bytes: the six fields as they were signed, the digest and the MAC. */
export const sealDaemonNotice = (canonical: string, key: Buffer): DaemonNoticeBody => {
  const fields = JSON.parse(canonical) as DaemonNoticeFields;
  if (daemonNoticeCanonical(fields) !== canonical) throw new Error("the stored notice is not canonical");
  return {
    ...fields,
    payload_digest: daemonNoticePayloadDigest(canonical),
    signature: daemonNoticeSignature(key, canonical),
  };
};

/** What one OWED refusal notice says, and all it may say. */
export interface DaemonNoticeSubject {
  messageId: string;
  reason: string;
  /** The Buzz identity that signed the refused event, or null when its row could not be read. */
  sender: string | null;
  /** The admitted event's key (`buzz-message:<event id>`), or null when the pointer was unreadable. */
  sourceNonce: string | null;
  createdAt: string;
}

const BUZZ_NONCE_PREFIX = "buzz-message:";

/**
 * Metadata only: the refused message id, the source event id, the signer, the reason code and the
 * time. Never the message's text and never an instruction — the notice is built from the OWED entry,
 * which holds no payload, and from nothing else.
 */
export const daemonNoticeText = (subject: DaemonNoticeSubject): string => {
  const sourceEvent = subject.sourceNonce?.startsWith(BUZZ_NONCE_PREFIX)
    ? subject.sourceNonce.slice(BUZZ_NONCE_PREFIX.length)
    : subject.sourceNonce;
  const text = [
    "ACP refused a queued peer message addressed to the CTO; it was not delivered.",
    `message_id=${subject.messageId}`,
    `source_event_id=${sourceEvent ?? "unknown"}`,
    `signer=${subject.sender ?? "unknown"}`,
    `reason=${subject.reason}`,
    `at=${subject.createdAt}`,
  ].join(" ");
  if (text.length > DAEMON_NOTICE_MAX_TEXT || /[\x00-\x1f\x7f]/.test(text)) {
    throw new Error("a daemon notice's text must be at most 2000 characters of metadata");
  }
  return text;
};

/** The six fields for one notice to one pinned destination. */
export const daemonNoticeFields = (
  eventId: string,
  destination: DaemonNoticeDestination,
  text: string,
): DaemonNoticeFields => ({
  protocol: DAEMON_NOTICE_PROTOCOL,
  principal: DAEMON_NOTICE_PRINCIPAL,
  binding: DAEMON_NOTICE_BINDING,
  event_id: eventId,
  destination,
  text,
});

/** What one POST came back with, as the transport saw it. */
export type DaemonNoticeSendOutcome =
  /** Refused before any request left: nothing reached the Gateway. */
  | { kind: "NOT_SENT"; reason: string }
  /** The request may have reached the Gateway and no answer was read. */
  | { kind: "UNCERTAIN"; reason: string }
  /** An answer, whatever its status; `body` is the parsed JSON, or null when it was not JSON. */
  | { kind: "RESPONDED"; status: number; body: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether one answer settles the notice: only a 200 whose `event_id` and `payload_digest` are this
 * notice's, whose `receipt.status` is `completed`, and whose receipt names the pinned session and
 * lineage. Every failed condition is named, so a refusal records what differed.
 */
export const daemonNoticeSettlement = (
  status: number,
  body: unknown,
  expected: { eventId: string; payloadDigest: string; destination: DaemonNoticeDestination },
): { settled: true; receiptId: string } | { settled: false; mismatches: string[] } => {
  const mismatches: string[] = [];
  if (status !== 200) mismatches.push("status");
  const answer = isRecord(body) ? body : {};
  if (answer["event_id"] !== expected.eventId) mismatches.push("event_id");
  if (answer["payload_digest"] !== expected.payloadDigest) mismatches.push("payload_digest");
  const receipt = isRecord(answer["receipt"]) ? answer["receipt"] : {};
  if (receipt["status"] !== "completed") mismatches.push("receipt.status");
  if (receipt["session_id"] !== expected.destination.session_id) mismatches.push("receipt.session_id");
  if (receipt["lineage_root_digest"] !== expected.destination.lineage_root_digest) {
    mismatches.push("receipt.lineage_root_digest");
  }
  const receiptId = receipt["receipt_id"];
  if (typeof receiptId !== "string" || receiptId.length === 0 || receiptId.length > 512 ||
      /[\x00-\x1f\x7f]/.test(receiptId)) {
    mismatches.push("receipt.receipt_id");
  }
  return mismatches.length === 0 ? { settled: true, receiptId: receiptId as string } : { settled: false, mismatches };
};

/**
 * The Hermes refusals the contract makes terminal, by status and the exact `error` code it pairs with.
 * Any other answer — `canonical_event_uncertain`, an unknown code, a body of another shape — leaves
 * the notice in doubt to be retried with the same bytes, never failed on a guess.
 */
const TERMINAL_REFUSALS: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [401, new Set(["daemon_notice_signature_invalid"])],
  [403, new Set(["daemon_notice_refused"])],
  [409, new Set(["daemon_notice_destination_mismatch", "daemon_notice_payload_mismatch"])],
]);

/**
 * The error code of a non-200 answer. Amendment 1 fixes the body as `{"error": "<code>", "detail": …}`
 * and the code as the `error` field, so that field is the only one read; `detail` is human text.
 */
export const daemonNoticeRefusalCode = (body: unknown): string | null => {
  const value = isRecord(body) ? body["error"] : undefined;
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : null;
};

/** How the consumer reads one non-200 answer: terminal for this notice, or still in doubt. */
export const daemonNoticeRefusalIsTerminal = (status: number, body: unknown): boolean =>
  TERMINAL_REFUSALS.get(status)?.has(daemonNoticeRefusalCode(body) ?? "") ?? false;

/** The pinned CEO destination for this round of deliveries, and the sender bound to it. */
export interface DaemonNoticeTarget {
  destination: DaemonNoticeDestination;
  send(body: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome>;
}
/** The current pinned CEO authority, or null when there is none to deliver to right now. */
export type DaemonNoticeTargetResolver = () => Promise<DaemonNoticeTarget | null>;

/** The delivery record the consumer reads and writes (the outbox's half of it). */
export interface DaemonNoticeDeliveryRecord {
  undeliveredPeerMessageNotices(): ReadonlyArray<DaemonNoticeSubject & {
    roleKey: string;
    inDoubt: { eventId: string; payloadDigest: string; canonicalJson: string } | null;
  }>;
  /** Null when a holder already took the notice on itself: one channel per notice. */
  recordPeerMessageNoticeInDoubt(input: {
    eventId: string; messageId: string; roleKey: string; reason: string; payloadDigest: string; canonicalJson: string;
  }): { payloadDigest: string; canonicalJson: string } | null;
  settlePeerMessageNoticeDelivery(input: {
    eventId: string; messageId: string; roleKey: string; reason: string; payloadDigest: string; receiptId: string;
  }): void;
  failPeerMessageNoticeDelivery(input: {
    eventId: string; messageId: string; roleKey: string; reason: string; payloadDigest: string;
    failure: "HERMES_REFUSED" | "RESPONSE_MISMATCH" | "DESTINATION_MOVED"; diagnostics: Record<string, unknown>;
  }): void;
}

/** What one pass did, by event id. Nothing in it is a secret or a message's content. */
export interface DaemonNoticeDeliveryReport {
  settled: string[];
  inDoubt: string[];
  failed: string[];
  /** Not attempted this pass: no pinned CEO target, or a record that does not read back. */
  waiting: string[];
}

const sameDestination = (a: DaemonNoticeDestination, b: DaemonNoticeDestination): boolean =>
  a.session_id === b.session_id && a.lineage_root_digest === b.lineage_root_digest &&
  a.process_pid === b.process_pid && a.process_started_at === b.process_started_at;

/** The receipt fields worth recording when a 200 did not settle: identifiers only, never text. */
const receivedIdentifiers = (body: unknown): Record<string, unknown> => {
  const answer = isRecord(body) ? body : {};
  const receipt = isRecord(answer["receipt"]) ? answer["receipt"] : {};
  const bounded = (value: unknown): unknown =>
    typeof value === "string" ? value.slice(0, 200) : typeof value === "number" ? value : null;
  return {
    event_id: bounded(answer["event_id"]),
    payload_digest: bounded(answer["payload_digest"]),
    receipt_status: bounded(receipt["status"]),
    receipt_session_id: bounded(receipt["session_id"]),
    receipt_lineage_root_digest: bounded(receipt["lineage_root_digest"]),
  };
};

/**
 * One pass of the daemon's notice delivery (acp-daemon-notice/v1, #1068 finding 04).
 *
 * For every OWED refusal notice with no settled or failed delivery — whether or not any CTO holds the
 * role — the notice is sent to the CEO's existing canonical conversation as a daemon notice:
 *
 *   - Its id is derived (`daemonNoticeEventId`), never stored first. Before the first POST an
 *     IN_DOUBT entry fixes its canonical bytes and digest; every later attempt resends exactly those,
 *     so a 409 `canonical_event_uncertain`, a timeout, a lost answer or a restart retries with the same
 *     id and payload and the Gateway answers it from its own record.
 *   - It settles only on a 200 that `daemonNoticeSettlement` accepts. A 200 that does not match, a
 *     Hermes refusal the contract makes terminal (401, 403, a 409 destination or payload mismatch),
 *     or a pinned destination that moved since the bytes were fixed is recorded FAILED with what
 *     differed, and the doctor shows it. Nothing is redirected and no new id is minted.
 *   - Nothing is attempted while there is no pinned CEO target; the notice simply waits.
 *
 * The key is derived here for this pass and dropped with it.
 */
export const deliverOwedPeerMessageNotices = async (
  record: DaemonNoticeDeliveryRecord,
  resolveTarget: DaemonNoticeTargetResolver,
  laneSecret: string,
): Promise<DaemonNoticeDeliveryReport> => {
  const report: DaemonNoticeDeliveryReport = { settled: [], inDoubt: [], failed: [], waiting: [] };
  const candidates = record.undeliveredPeerMessageNotices();
  if (candidates.length === 0) return report;
  const key = daemonNoticeKey(laneSecret);
  for (const notice of candidates) {
    const eventId = daemonNoticeEventId(notice.messageId, notice.roleKey, notice.reason);
    // One notice's failure to write is that notice's, not the pass's: it is left as it stands (in
    // doubt, if its IN_DOUBT entry was written) and the next notice is still delivered.
    try {
      await deliverOne(record, resolveTarget, key, notice, eventId, report);
    } catch {
      report.waiting.push(eventId);
    }
  }
  return report;
};

const deliverOne = async (
  record: DaemonNoticeDeliveryRecord,
  resolveTarget: DaemonNoticeTargetResolver,
  key: Buffer,
  notice: ReturnType<DaemonNoticeDeliveryRecord["undeliveredPeerMessageNotices"]>[number],
  eventId: string,
  report: DaemonNoticeDeliveryReport,
): Promise<void> => {
  const subject = { messageId: notice.messageId, roleKey: notice.roleKey, reason: notice.reason };
  const target = await resolveTarget();
  if (target === null) {
    report.waiting.push(eventId);
    return;
  }
  let fixed: { payloadDigest: string; canonicalJson: string };
  if (notice.inDoubt !== null) {
    if (notice.inDoubt.eventId !== eventId) {
      report.waiting.push(eventId);
      return;
    }
    fixed = { payloadDigest: notice.inDoubt.payloadDigest, canonicalJson: notice.inDoubt.canonicalJson };
  } else {
    const canonical = daemonNoticeCanonical(daemonNoticeFields(eventId, target.destination, daemonNoticeText(notice)));
    const recorded = record.recordPeerMessageNoticeInDoubt({
      ...subject, eventId, payloadDigest: daemonNoticePayloadDigest(canonical), canonicalJson: canonical,
    });
    if (recorded === null) {
      report.waiting.push(eventId);
      return;
    }
    fixed = recorded;
  }
  let body: DaemonNoticeBody;
  try {
    body = sealDaemonNotice(fixed.canonicalJson, key);
  } catch {
    report.waiting.push(eventId);
    return;
  }
  if (body.payload_digest !== fixed.payloadDigest || body.event_id !== eventId) {
    report.waiting.push(eventId);
    return;
  }
  // Never redirected: bytes fixed for one destination go to that destination or nowhere.
  if (!sameDestination(body.destination, target.destination)) {
    record.failPeerMessageNoticeDelivery({
      ...subject, eventId, payloadDigest: fixed.payloadDigest, failure: "DESTINATION_MOVED",
      diagnostics: { fixed: body.destination, pinned: target.destination },
    });
    report.failed.push(eventId);
    return;
  }
  const outcome = await target.send(body);
  if (outcome.kind !== "RESPONDED") {
    report.inDoubt.push(eventId);
    return;
  }
  const settlement = daemonNoticeSettlement(outcome.status, outcome.body, {
    eventId, payloadDigest: fixed.payloadDigest, destination: body.destination,
  });
  if (settlement.settled) {
    record.settlePeerMessageNoticeDelivery({
      ...subject, eventId, payloadDigest: fixed.payloadDigest, receiptId: settlement.receiptId,
    });
    report.settled.push(eventId);
  } else if (outcome.status === 200) {
    record.failPeerMessageNoticeDelivery({
      ...subject, eventId, payloadDigest: fixed.payloadDigest, failure: "RESPONSE_MISMATCH",
      diagnostics: { status: 200, mismatches: settlement.mismatches, received: receivedIdentifiers(outcome.body) },
    });
    report.failed.push(eventId);
  } else if (daemonNoticeRefusalIsTerminal(outcome.status, outcome.body)) {
    record.failPeerMessageNoticeDelivery({
      ...subject, eventId, payloadDigest: fixed.payloadDigest, failure: "HERMES_REFUSED",
      diagnostics: { status: outcome.status, code: daemonNoticeRefusalCode(outcome.body) },
    });
    report.failed.push(eventId);
  } else {
    report.inDoubt.push(eventId);
  }
};

/** `ACP_DAEMON_NOTICE_PROBE`: 16 to 64 characters of `[A-Za-z0-9-]` (amendment 1). */
export const DAEMON_NOTICE_PROBE_NONCE = /^[A-Za-z0-9-]{16,64}$/;

/** The probe's id: `acp-notice-probe:` and the sha256 of the nonce. Never a real notice's id. */
export const daemonNoticeProbeEventId = (nonce: string): string => `acp-notice-probe:${sha256Hex(nonce)}`;

export const daemonNoticeProbeText = (nonce: string): string =>
  `ACP daemon notice probe ${nonce} (synthetic, no action needed)`;

/** The probe's delivery record (the outbox's half of it). */
export interface DaemonNoticeProbeRecord {
  daemonNoticeDeliveryExists(eventId: string): boolean;
  recordDaemonNoticeProbe(input: {
    eventId: string; entry: "IN_DOUBT" | "SETTLED" | "FAILED" | "RESENT"; payloadDigest: string;
    canonicalJson?: string; receiptId?: string | null;
    failure?: "HERMES_REFUSED" | "RESPONSE_MISMATCH" | "DESTINATION_MOVED"; diagnostics?: Record<string, unknown>;
  }): void;
}

/** One probe answer, as recorded: settled with its receipt, failed with why, or in doubt. */
export type DaemonNoticeProbeAnswer =
  | { outcome: "SETTLED"; receiptId: string }
  | { outcome: "FAILED"; failure: "HERMES_REFUSED" | "RESPONSE_MISMATCH"; diagnostics: Record<string, unknown> }
  | { outcome: "IN_DOUBT"; diagnostics: Record<string, unknown> };

export type DaemonNoticeProbeReport =
  | { sent: false; reason: "INVALID_NONCE" | "ALREADY_RECORDED" | "NO_TARGET"; eventId: string | null }
  | { sent: true; eventId: string; first: DaemonNoticeProbeAnswer; resend: DaemonNoticeProbeAnswer;
      sameReceipt: boolean };

const probeAnswer = (
  outcome: DaemonNoticeSendOutcome,
  expected: { eventId: string; payloadDigest: string; destination: DaemonNoticeDestination },
): DaemonNoticeProbeAnswer => {
  if (outcome.kind !== "RESPONDED") return { outcome: "IN_DOUBT", diagnostics: { transport: outcome.kind, reason: outcome.reason } };
  const settlement = daemonNoticeSettlement(outcome.status, outcome.body, expected);
  if (settlement.settled) return { outcome: "SETTLED", receiptId: settlement.receiptId };
  if (outcome.status === 200) {
    return { outcome: "FAILED", failure: "RESPONSE_MISMATCH",
      diagnostics: { status: 200, mismatches: settlement.mismatches, received: receivedIdentifiers(outcome.body) } };
  }
  const code = daemonNoticeRefusalCode(outcome.body);
  return daemonNoticeRefusalIsTerminal(outcome.status, outcome.body)
    ? { outcome: "FAILED", failure: "HERMES_REFUSED", diagnostics: { status: outcome.status, code } }
    : { outcome: "IN_DOUBT", diagnostics: { status: outcome.status, code } };
};

/**
 * The live-acceptance probe (amendment 1): one synthetic daemon notice to the CEO's existing
 * conversation, then the same bytes exactly once more, both answers recorded as kind PROBE. Sent only
 * when no delivery entry for its id exists yet, so a restart with the same nonce sends nothing; it
 * names no message and touches no real notice. The second answer is what proves the Gateway answers a
 * repeated id from its record: the same receipt id, and no second turn.
 */
export const sendDaemonNoticeProbe = async (
  record: DaemonNoticeProbeRecord,
  resolveTarget: DaemonNoticeTargetResolver,
  laneSecret: string,
  nonce: string,
): Promise<DaemonNoticeProbeReport> => {
  if (!DAEMON_NOTICE_PROBE_NONCE.test(nonce)) return { sent: false, reason: "INVALID_NONCE", eventId: null };
  const eventId = daemonNoticeProbeEventId(nonce);
  if (record.daemonNoticeDeliveryExists(eventId)) return { sent: false, reason: "ALREADY_RECORDED", eventId };
  const target = await resolveTarget();
  if (target === null) return { sent: false, reason: "NO_TARGET", eventId };
  const canonical = daemonNoticeCanonical(daemonNoticeFields(eventId, target.destination, daemonNoticeProbeText(nonce)));
  const payloadDigest = daemonNoticePayloadDigest(canonical);
  record.recordDaemonNoticeProbe({ eventId, entry: "IN_DOUBT", payloadDigest, canonicalJson: canonical });
  const body = sealDaemonNotice(canonical, daemonNoticeKey(laneSecret));
  const expected = { eventId, payloadDigest, destination: body.destination };
  const first = probeAnswer(await target.send(body), expected);
  if (first.outcome === "SETTLED") {
    record.recordDaemonNoticeProbe({ eventId, entry: "SETTLED", payloadDigest, receiptId: first.receiptId });
  } else if (first.outcome === "FAILED") {
    record.recordDaemonNoticeProbe({ eventId, entry: "FAILED", payloadDigest, failure: first.failure,
      diagnostics: first.diagnostics });
  }
  const resend = probeAnswer(await target.send(body), expected);
  record.recordDaemonNoticeProbe({
    eventId, entry: "RESENT", payloadDigest,
    receiptId: resend.outcome === "SETTLED" ? resend.receiptId : null,
    diagnostics: resend.outcome === "SETTLED"
      ? { outcome: "SETTLED", sameReceipt: first.outcome === "SETTLED" && first.receiptId === resend.receiptId }
      : { outcome: resend.outcome, ...resend.diagnostics },
  });
  return {
    sent: true, eventId, first, resend,
    sameReceipt: first.outcome === "SETTLED" && resend.outcome === "SETTLED" && first.receiptId === resend.receiptId,
  };
};
