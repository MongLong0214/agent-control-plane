import { timingSafeEqual } from "node:crypto";

import { verifyEvent } from "nostr-tools/pure";

import type { RepoFactoryApprovalScope, RepoFactoryOwnerApprovalNeed } from "../bootstrap/repo-factory-bootstrap-run.ts";
import type { OwnerApprovalReceipt } from "../ceo/owner-authority.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { RunKind, RunState, type RunRow } from "../domain/types.ts";
import {
  IngressGuard,
  type IngressPolicy,
  type OwnerApprovalIngress,
  ownerApprovalPayload,
} from "../ingress/ingress-guard.ts";
import { isAdmittedRuntime } from "../session/runtime-lineage.ts";
import { buzzBindContentOf, normalizeBuzzActor } from "./buzz-bind-challenge.ts";
import type { BuzzMentionEvent, BuzzPublishAck, BuzzSignedEvent } from "./buzz-mention-subscriber.ts";

/**
 * #246 — the owner approves a bootstrap run's GitHub writes with one Buzz reply, and ACP verifies
 * that reply's Nostr signature itself (CEO 1791605114 T3; amendments CEO 1791605708 O1–O4).
 *
 * The flow, end to end:
 *
 *   1. a PROJECT_BOOTSTRAP run at CEO review needs an owner decision on its scope
 *      (`ownerApprovalNeed`). ACP signs a prompt as the approval identity X — the repo-factory CTO's
 *      subscriber identity, checked at post time against its live binding, its room and its
 *      connection (O1) — stores the issue and the signed prompt in one transaction, and only then
 *      publishes the stored event;
 *   2. the owner replies to it once with `acp-approve-write:<code>` or `acp-decline-write:<code>`;
 *   3. the reply reaches this module from X's own connection, by the stored prompt's exact `e`
 *      reference — not by a mention — or through the mention sink, which routes any event carrying
 *      the marker here first, before the binding marker and before the message seam;
 *   4. `receive` verifies it (signature, owner key, grammar, prompt, room, code, answer slot, the
 *      server-stored expiry, the scope recomputed now, the need) and, in one transaction, writes the
 *      prompt's single answer, the `buzz` receipt admission and the APPROVAL artifact in the CLI's
 *      shape. The transaction never waits on the network; the outcome reply goes out after it;
 *   5. the CEO's CONFIRM consumes the receipt through C3's unchanged path, which accepts a `buzz`
 *      receipt only while `verifyBuzzApprovalEvidence` holds.
 *
 * Identity is `event.pubkey` after `verifyEvent` and nothing else: body text, `p` tags, a relay
 * envelope's actor and a claim's unverified actor are never consulted. Matching the reply filter is
 * not authentication; it only decides where an event is judged.
 *
 * Storage is four `inbound_messages` pseudo-channels; no schema change. Their `payload_json` is
 * write-once and cannot be inserted by a connection ACP did not open; no `IngressGuard` admits on
 * them, so nothing prunes them, and nothing reads `inbound_messages` across channels without a
 * turn claim, which these rows never carry.
 */

/** The receipt channel this module mints on. */
export const BUZZ_OWNER_APPROVAL_CHANNEL = "buzz";
/** One row per (run, scope, candidate, issue): the de-duplication point for posting a prompt. */
export const BUZZ_OWNER_APPROVAL_ISSUE_CHANNEL = "buzz-owner-approval-issue";
/** One row per prompt, by its event id: the binding and ACP's own signed prompt. */
export const BUZZ_OWNER_APPROVAL_PROMPT_CHANNEL = "buzz-owner-approval-prompt";
/** A prompt's single terminal state, by the prompt's event id: answered once, or cancelled. */
export const BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL = "buzz-owner-approval-answer";
/** An owner-signed refusal, by the refused event's id: the event's one terminal refusal. */
export const BUZZ_OWNER_APPROVAL_REFUSAL_CHANNEL = "buzz-owner-approval-refusal";
/** The receipt's ingress nonce on the `buzz` channel: its own namespace beside messages and binds. */
export const BUZZ_APPROVAL_NONCE_PREFIX = "buzz-approval:";
/** The receipt's idempotency key, naming the prompt it answers. */
export const BUZZ_APPROVAL_IDEMPOTENCY_PREFIX = "buzz:repo-factory-github-write:";
/** How long a prompt may be answered, from the moment it is signed (O3). */
export const BUZZ_OWNER_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** How far before its prompt a reply may be dated: a signer's clock skew. */
export const BUZZ_OWNER_APPROVAL_SIGNED_SKEW_SECONDS = 60;
/** How long a publication waits for the relay's verdict. */
export const BUZZ_OWNER_APPROVAL_PUBLISH_TIMEOUT_MS = 10_000;

const BUZZ_KIND = 9;
const EVENT_ID = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[0-9a-f]{128}$/u;
const PROMPT_SCHEMA = "acp.buzz-owner-approval.prompt.v1";
const ANSWER_SCHEMA = "acp.buzz-owner-approval.answer.v1";

/* ---------------------------------------------------------------------------------- grammar */

/**
 * The approval marker in any spelling a reader would take for it, after NFKC folding with format
 * characters removed, exactly as the binding marker is matched (ACP1055-01). Loose on purpose:
 * content it matches is never delivered as a message, and a false match costs a message, never an
 * approval.
 */
const APPROVAL_MARKER = /acp[\s\p{Pd}_]*(?:approve|decline)[\s\p{Pd}_]*write/giu;
/** The one form that decides: the exact token a prompt shows, standing alone. */
const WELL_FORMED_TOKEN = /(?<![0-9A-Za-z])acp-(approve|decline)-write:([0-9a-f]{16})(?![0-9A-Za-z])/g;

/**
 * What an event's content says about owner approval, in three answers:
 *
 *   - `NONE`: no approval marker in any spelling;
 *   - `TOKEN`: exactly one marker, and it is a well-formed token, with no binding marker beside it;
 *   - `MALFORMED`: any other content carrying a marker — two tokens, a token beside a mangled one,
 *     a full-width or zero-width-split spelling, or both markers. Refused, never delivered.
 */
export type BuzzOwnerApprovalContent =
  | { readonly kind: "NONE" }
  | { readonly kind: "TOKEN"; readonly approved: boolean; readonly code: string }
  | { readonly kind: "MALFORMED" };

export const buzzOwnerApprovalContentOf = (content: string): BuzzOwnerApprovalContent => {
  const folded = content.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const markers = folded.match(APPROVAL_MARKER)?.length ?? 0;
  if (markers === 0) return { kind: "NONE" };
  const tokens = [...content.matchAll(WELL_FORMED_TOKEN)];
  const token = tokens.length === 1 ? tokens[0] : undefined;
  if (markers !== 1 || token === undefined || token[1] === undefined || token[2] === undefined) return { kind: "MALFORMED" };
  if (buzzBindContentOf(content).kind !== "NONE") return { kind: "MALFORMED" };
  return { kind: "TOKEN", approved: token[1] === "approve", code: token[2] };
};

/**
 * The approval identity X as configured: a non-secret x-only key (hex in either case, or an npub)
 * naming one identity of `buzz-nostr-subscriber.json`. `null` when unset, `"INVALID"` for anything
 * else, which posts no prompt and says so in health rather than stopping the daemon.
 */
export const buzzOwnerApprovalIdentityOf = (value: string | undefined): string | null | "INVALID" => {
  const text = value?.trim() ?? "";
  if (text.length === 0) return null;
  return normalizeBuzzActor(text) ?? "INVALID";
};

/** Whether `text` carries the approval marker in any spelling: such text is never a message. */
export const carriesBuzzOwnerApprovalMarker = (text: string): boolean => buzzOwnerApprovalContentOf(text).kind !== "NONE";

/**
 * The event a reply answers: the one `e` tag marked `reply`, or else the sole `e` tag. Two reply
 * markers, or several unmarked tags with none marked, are ambiguous and name nothing.
 */
export const buzzReplyReferenceOf = (event: { readonly tags: readonly (readonly string[])[] }): string | null => {
  const references = event.tags.filter((tag) => tag[0] === "e");
  const replies = references.filter((tag) => tag[3] === "reply");
  const chosen = replies.length === 1 ? replies[0] : replies.length === 0 && references.length === 1 ? references[0] : undefined;
  const id = chosen?.[1];
  return typeof id === "string" && EVENT_ID.test(id) ? id : null;
};

const tagValues = (event: { readonly tags: readonly (readonly string[])[] }, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");

/** The seven signed fields on a fresh object, so `verifyEvent` checks rather than reads a cached verdict. */
const plainCopy = (event: BuzzSignedEvent) => ({
  id: event.id,
  pubkey: event.pubkey,
  created_at: event.created_at,
  kind: event.kind,
  tags: event.tags.map((tag) => [...tag]),
  content: event.content,
  sig: event.sig,
});

const verifies = (event: BuzzSignedEvent): boolean => {
  try {
    return verifyEvent(plainCopy(event));
  } catch {
    return false;
  }
};

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<string | symbol, unknown>)[key]);
  return Object.freeze(value);
};

/* ------------------------------------------------------------------ binding, code and texts */

/** One operation as the prompt shows it. */
export interface BuzzOwnerApprovalOperationLine {
  readonly resourceType: string;
  readonly resourceIdentity: string;
  readonly visibility: string | null;
}

/** What a prompt binds, as stored with it: the scope's fields, without the manifest it carries. */
export interface BuzzOwnerApprovalBinding {
  readonly runId: string;
  readonly operation: string;
  readonly planDigest: string;
  readonly operationsDigest: string;
  readonly operations: readonly BuzzOwnerApprovalOperationLine[];
  readonly repositoryIdentity: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly parameterDigest: string;
  readonly candidateSnapshotDigest: string | null;
  readonly projectName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const buzzOwnerApprovalBindingOf = (scope: RepoFactoryApprovalScope): BuzzOwnerApprovalBinding => ({
  runId: scope.runId,
  operation: scope.operation,
  planDigest: scope.planDigest,
  operationsDigest: scope.operationsDigest,
  operations: scope.githubOperations.map((operation) => {
    const desired: unknown = (operation as { desiredState?: unknown }).desiredState;
    const visibility = isRecord(desired) && typeof desired["visibility"] === "string" ? desired["visibility"] : null;
    return { resourceType: operation.resourceType, resourceIdentity: operation.resourceIdentity, visibility };
  }),
  repositoryIdentity: scope.repositoryIdentity,
  owner: scope.owner,
  visibility: scope.visibility,
  parameterDigest: scope.parameterDigest,
  candidateSnapshotDigest: scope.candidateSnapshotDigest,
  projectName: scope.projectName,
});

/**
 * The binding fields a reply is refused over when the run's current scope no longer has them, the
 * most specific first: a repository renamed also changes the operations and the PLAN, and the
 * refusal names the repository.
 */
const SCOPE_FIELDS = [
  "runId",
  "operation",
  "repositoryIdentity",
  "owner",
  "visibility",
  "operationsDigest",
  "planDigest",
  "candidateSnapshotDigest",
  "parameterDigest",
] as const;

/** The first binding field the current scope does not equal, or null when the prompt still binds it. */
export const buzzOwnerApprovalStaleField = (
  binding: BuzzOwnerApprovalBinding,
  scope: RepoFactoryApprovalScope,
): (typeof SCOPE_FIELDS)[number] | null => {
  const current = buzzOwnerApprovalBindingOf(scope);
  return SCOPE_FIELDS.find((field) => binding[field] !== current[field]) ?? null;
};

/** The key one issue of a prompt for (run, scope, candidate) is stored under. */
export const buzzOwnerApprovalIssueKey = (binding: Pick<BuzzOwnerApprovalBinding, "runId" | "parameterDigest" | "candidateSnapshotDigest">, issue: number): string =>
  digestOf({ runId: binding.runId, parameterDigest: binding.parameterDigest, candidateSnapshotDigest: binding.candidateSnapshotDigest, issue });

/** A correlation value the token carries back, never a secret: identity is the signature alone. */
export const buzzOwnerApprovalCode = (issueKey: string): string => issueKey.slice("sha256:".length, "sha256:".length + 16);

const operationLine = (operation: BuzzOwnerApprovalOperationLine, index: number): string =>
  `  ${index + 1}. ${operation.resourceType} ${operation.resourceIdentity}` +
  (operation.visibility === null ? "" : ` visibility=${operation.visibility}`);

/**
 * The prompt's public text. Built from the binding and nothing else, so it can carry no secret, local
 * path, session, CTO or tool detail: every field is a run id, a GitHub name, a digest or a time.
 */
export const buzzOwnerApprovalPromptText = (binding: BuzzOwnerApprovalBinding, code: string, expiresAt: string): string =>
  [
    "ACP OWNER APPROVAL REQUEST (control plane, not a CTO message)",
    `run: ${binding.runId}`,
    `repository: ${binding.repositoryIdentity}`,
    `visibility: ${binding.visibility}`,
    `github owner: ${binding.owner}`,
    `project: ${binding.projectName}`,
    `plan: ${binding.planDigest}`,
    `operations: ${binding.operationsDigest} (${binding.operations.length})`,
    ...binding.operations.map(operationLine),
    `scope: ${binding.parameterDigest}`,
    `expires: ${expiresAt}`,
    `To approve, reply to this message with:  acp-approve-write:${code}`,
    `To decline, reply to this message with:  acp-decline-write:${code}`,
    "Nothing is written until the CEO confirms the run.",
  ].join("\n");

/**
 * The outcome's public text: what was recorded, and that recording a receipt is not GitHub
 * execution (O4). Carries no marker, so it is never mistaken for an answer.
 */
export const buzzOwnerApprovalOutcomeText = (binding: BuzzOwnerApprovalBinding, approved: boolean): string =>
  [
    "ACP OWNER DECISION RECORDED (control plane, not a CTO message)",
    `decision: ${approved ? "APPROVED" : "DECLINED"}`,
    `run: ${binding.runId}`,
    `repository: ${binding.repositoryIdentity}`,
    `scope: ${binding.parameterDigest}`,
    approved
      ? "Approval receipt issued. GitHub execution has not started: nothing is written until the CEO confirms the run."
      : "Decline recorded. No GitHub write runs on this scope.",
  ].join("\n");

/* ------------------------------------------------------------------------------ publications */

/**
 * What one of the two fixed messages is derived from (O4): a prompt from its binding, or an outcome
 * from the prompt it answers and the decision recorded. Never a caller's text.
 */
export type BuzzApprovalPublicationBasis =
  | {
      readonly kind: "PROMPT";
      readonly binding: BuzzOwnerApprovalBinding;
      readonly code: string;
      readonly expiresAt: string;
      readonly room: string;
      readonly ownerKeys: readonly string[];
    }
  | {
      readonly kind: "OUTCOME";
      readonly binding: BuzzOwnerApprovalBinding;
      readonly approved: boolean;
      readonly room: string;
      readonly replyToEventId: string;
    };

/** The stored row a publication's recorded event is read from when it is spent. */
export interface BuzzApprovalPublicationSource {
  readonly kind: "PROMPT" | "OUTCOME";
  readonly promptEventId: string;
}

/**
 * One store-issued owner-approval publication (R1056-01, widened by O4 to exactly two kinds).
 *
 * Only this module makes one, from a computed binding (a prompt to sign), a stored prompt (a prompt
 * to send) or a stored answer (an outcome). Its tags and content are a pure function of its basis
 * (`buzzApprovalPublicationShape`), which the publisher recomputes rather than reads. A publication
 * is spent by its first use (`redeemBuzzApprovalPublication`), and a send is checked against the
 * event storage holds when it is spent.
 */
export interface BuzzApprovalPublication {
  readonly basis: BuzzApprovalPublicationBasis;
  readonly signer: string;
  readonly createdAt: number;
  /** The stored event to send; null for a publication that asks to be signed. */
  readonly intent: BuzzSignedEvent | null;
  readonly source: BuzzApprovalPublicationSource | null;
}

/** Every unspent publication, with the database whose rows its send is checked against. */
const ISSUED_PUBLICATIONS = new WeakMap<object, Db>();

const issuePublication = (db: Db, publication: BuzzApprovalPublication): BuzzApprovalPublication => {
  const frozen = deepFreeze(publication);
  ISSUED_PUBLICATIONS.set(frozen, db);
  return frozen;
};

/** The tags and content a publication's event must carry: the room, then the prompt's owners or the answered event. */
export const buzzApprovalPublicationShape = (basis: BuzzApprovalPublicationBasis): { tags: string[][]; content: string } =>
  basis.kind === "PROMPT"
    ? {
        tags: [["h", basis.room], ...basis.ownerKeys.map((key) => ["p", key])],
        content: buzzOwnerApprovalPromptText(basis.binding, basis.code, basis.expiresAt),
      }
    : {
        tags: [["h", basis.room], ["e", basis.replyToEventId, "", "reply"]],
        content: buzzOwnerApprovalOutcomeText(basis.binding, basis.approved),
      };

export interface RedeemedBuzzApprovalPublication {
  readonly publication: BuzzApprovalPublication;
  /** The event storage holds for the publication's source when it was spent, or null. */
  readonly recorded: BuzzSignedEvent | null;
}

/**
 * Spends `value` when it is a publication this module issued and nothing has spent, and reads its
 * source's stored event again; `null` for anything else.
 */
export const redeemBuzzApprovalPublication = (value: unknown): RedeemedBuzzApprovalPublication | null => {
  if (typeof value !== "object" || value === null) return null;
  const db = ISSUED_PUBLICATIONS.get(value);
  if (db === undefined) return null;
  ISSUED_PUBLICATIONS.delete(value);
  const publication = value as BuzzApprovalPublication;
  const source = publication.source;
  if (source === null) return { publication, recorded: null };
  if (source.kind === "PROMPT") return { publication, recorded: readPrompt(db, source.promptEventId)?.event ?? null };
  const answer = readAnswer(db, source.promptEventId);
  return { publication, recorded: answer?.state === "ANSWERED" ? answer.outcomeEvent : null };
};

/* ----------------------------------------------------------------------------- stored rows */

interface StoredPrompt {
  readonly promptEventId: string;
  readonly binding: BuzzOwnerApprovalBinding;
  readonly room: string;
  readonly signer: string;
  readonly ownerKeys: readonly string[];
  readonly code: string;
  readonly issue: number;
  readonly issueKey: string;
  readonly createdAt: number;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly event: BuzzSignedEvent;
  readonly deliveryStatus: string | null;
  readonly attempts: number;
}

type StoredAnswer =
  | {
      readonly state: "ANSWERED";
      readonly promptEventId: string;
      readonly approvalEvent: BuzzSignedEvent;
      readonly approved: boolean;
      readonly envelope: unknown;
      readonly receipt: OwnerApprovalReceipt;
      readonly receiptDigest: string;
      readonly inboundNonce: string;
      readonly answeredAt: string;
      readonly outcomeEvent: BuzzSignedEvent | null;
      readonly outcomeStatus: string | null;
      readonly outcomeAttempts: number;
    }
  | { readonly state: "CANCELLED"; readonly promptEventId: string; readonly reason: string };

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const signedEventOf = (value: unknown): BuzzSignedEvent | null => {
  if (!isRecord(value)) return null;
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = value;
  if (typeof id !== "string" || !EVENT_ID.test(id) || typeof pubkey !== "string" || !EVENT_ID.test(pubkey)) return null;
  if (typeof sig !== "string" || !SIGNATURE.test(sig) || typeof content !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || typeof kind !== "number") return null;
  if (!Array.isArray(tags)) return null;
  const copied: string[][] = [];
  for (const tag of tags as unknown[]) {
    if (!Array.isArray(tag) || !tag.every((part) => typeof part === "string")) return null;
    copied.push([...(tag as string[])]);
  }
  return deepFreeze({ id, pubkey, created_at: createdAt, kind, tags: copied, content, sig });
};

const bindingOf = (value: unknown): BuzzOwnerApprovalBinding | null => {
  if (!isRecord(value)) return null;
  const text = (key: string): string | null => (typeof value[key] === "string" ? (value[key] as string) : null);
  const operations = value["operations"];
  const candidate = value["candidateSnapshotDigest"];
  const visibility = value["visibility"];
  const fields = ["runId", "operation", "planDigest", "operationsDigest", "repositoryIdentity", "owner", "parameterDigest", "projectName"];
  if (fields.some((key) => text(key) === null)) return null;
  if (visibility !== "public" && visibility !== "private") return null;
  if (candidate !== null && typeof candidate !== "string") return null;
  if (!Array.isArray(operations)) return null;
  const lines: BuzzOwnerApprovalOperationLine[] = [];
  for (const line of operations as unknown[]) {
    if (!isRecord(line) || typeof line["resourceType"] !== "string" || typeof line["resourceIdentity"] !== "string") return null;
    const shown = line["visibility"];
    if (shown !== null && typeof shown !== "string") return null;
    lines.push({ resourceType: line["resourceType"], resourceIdentity: line["resourceIdentity"], visibility: shown });
  }
  return {
    runId: text("runId")!,
    operation: text("operation")!,
    planDigest: text("planDigest")!,
    operationsDigest: text("operationsDigest")!,
    operations: lines,
    repositoryIdentity: text("repositoryIdentity")!,
    owner: text("owner")!,
    visibility,
    parameterDigest: text("parameterDigest")!,
    candidateSnapshotDigest: candidate,
    projectName: text("projectName")!,
  };
};

/**
 * The stored prompt, or null for none or one that does not read back: its event must be the signer's
 * validly signed event under the row's own key, carrying exactly the shape its binding derives.
 */
const readPrompt = (db: Pick<Db, "get">, promptEventId: string): StoredPrompt | null => {
  if (!EVENT_ID.test(promptEventId)) return null;
  const row = db.get<{ payload_json: string | null; result_json: string | null }>(
    `SELECT payload_json, result_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [BUZZ_OWNER_APPROVAL_PROMPT_CHANNEL, promptEventId],
  );
  if (!row) return null;
  const stored = parseJson(row.payload_json);
  if (!isRecord(stored) || stored["schema"] !== PROMPT_SCHEMA) return null;
  const binding = bindingOf(stored["binding"]);
  const event = signedEventOf(stored["event"]);
  const { room, signer, code, issue, issueKey, createdAt, expiresAt, expiresAtMs, ownerKeys } = stored;
  if (binding === null || event === null || event.id !== promptEventId) return null;
  if (typeof room !== "string" || typeof signer !== "string" || typeof code !== "string" || typeof issueKey !== "string") return null;
  if (typeof issue !== "number" || typeof createdAt !== "number" || typeof expiresAt !== "string" || typeof expiresAtMs !== "number") return null;
  if (!Array.isArray(ownerKeys) || !ownerKeys.every((key) => typeof key === "string")) return null;
  if (event.pubkey !== signer || event.kind !== BUZZ_KIND || event.created_at !== createdAt || !verifies(event)) return null;
  const shape = buzzApprovalPublicationShape({ kind: "PROMPT", binding, code, expiresAt, room, ownerKeys: ownerKeys as string[] });
  if (event.content !== shape.content || JSON.stringify(event.tags) !== JSON.stringify(shape.tags)) return null;
  const delivery = parseJson(row.result_json);
  const status = isRecord(delivery) && isRecord(delivery["delivery"]) ? delivery["delivery"] : null;
  return {
    promptEventId,
    binding,
    room,
    signer,
    ownerKeys: ownerKeys as string[],
    code,
    issue,
    issueKey,
    createdAt,
    expiresAt,
    expiresAtMs,
    event,
    deliveryStatus: status !== null && typeof status["status"] === "string" ? status["status"] : null,
    attempts: status !== null && typeof status["attempts"] === "number" ? status["attempts"] : 0,
  };
};

const receiptOf = (value: unknown): OwnerApprovalReceipt | null => {
  if (!isRecord(value)) return null;
  const { channel, actor, inboundNonce, runId, candidateSnapshotDigest, operation, parameterDigest, idempotencyKey, approved } = value;
  if (typeof channel !== "string" || typeof actor !== "string" || typeof inboundNonce !== "string") return null;
  if (runId !== null && typeof runId !== "string") return null;
  if (candidateSnapshotDigest !== null && typeof candidateSnapshotDigest !== "string") return null;
  if (typeof operation !== "string" || typeof parameterDigest !== "string" || typeof idempotencyKey !== "string") return null;
  if (typeof approved !== "boolean") return null;
  if (Object.keys(value).length !== 9) return null;
  return { channel, actor, inboundNonce, runId, candidateSnapshotDigest, operation, parameterDigest, idempotencyKey, approved };
};

/** The prompt's answer slot: absent (null), answered, cancelled, or undefined for a row that does not read back. */
const readAnswer = (db: Pick<Db, "get">, promptEventId: string): StoredAnswer | null | undefined => {
  const row = db.get<{ payload_json: string | null; result_json: string | null }>(
    `SELECT payload_json, result_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL, promptEventId],
  );
  if (!row) return null;
  const stored = parseJson(row.payload_json);
  if (!isRecord(stored) || stored["schema"] !== ANSWER_SCHEMA) return undefined;
  if (stored["state"] === "CANCELLED") {
    return typeof stored["reason"] === "string" ? { state: "CANCELLED", promptEventId, reason: stored["reason"] } : undefined;
  }
  if (stored["state"] !== "ANSWERED") return undefined;
  const approvalEvent = signedEventOf(stored["approvalEvent"]);
  const receipt = receiptOf(stored["receipt"]);
  const { approved, receiptDigest, inboundNonce, answeredAt } = stored;
  const outcomeEvent = stored["outcomeEvent"] === null ? null : signedEventOf(stored["outcomeEvent"]);
  if (approvalEvent === null || receipt === null || typeof approved !== "boolean") return undefined;
  if (typeof receiptDigest !== "string" || typeof inboundNonce !== "string" || typeof answeredAt !== "string") return undefined;
  if (stored["outcomeEvent"] !== null && outcomeEvent === null) return undefined;
  const result = parseJson(row.result_json);
  const outcome = isRecord(result) && isRecord(result["outcome"]) ? result["outcome"] : null;
  return {
    state: "ANSWERED",
    promptEventId,
    approvalEvent,
    approved,
    envelope: stored["envelope"],
    receipt,
    receiptDigest,
    inboundNonce,
    answeredAt,
    outcomeEvent,
    outcomeStatus: outcome !== null && typeof outcome["status"] === "string" ? outcome["status"] : null,
    outcomeAttempts: outcome !== null && typeof outcome["attempts"] === "number" ? outcome["attempts"] : 0,
  };
};

const readRefusal = (db: Pick<Db, "get">, eventId: string): { reasonCode: string } | null => {
  const row = db.get<{ payload_json: string | null }>(
    `SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [BUZZ_OWNER_APPROVAL_REFUSAL_CHANNEL, eventId],
  );
  if (!row) return null;
  const stored = parseJson(row.payload_json);
  return isRecord(stored) && typeof stored["reasonCode"] === "string" ? { reasonCode: stored["reasonCode"] } : { reasonCode: ReasonCode.CONFLICT };
};

/** The digest `IngressGuard` recorded for the envelope a receipt was admitted with. */
const envelopeDigestOf = (receipt: OwnerApprovalReceipt): string =>
  digestOf({
    type: "OWNER_APPROVAL",
    runId: receipt.runId,
    candidateSnapshotDigest: receipt.candidateSnapshotDigest,
    operation: receipt.operation,
    parameterDigest: receipt.parameterDigest,
    idempotencyKey: receipt.idempotencyKey,
    approved: receipt.approved,
  });

/* ------------------------------------------------------------------- evidence at consumption */

/**
 * Whether a `buzz` receipt is exactly the one this module minted, re-checked from the stored
 * evidence wherever it is relied on (DESIGN §10): the answer row its idempotency key names, holding
 * this receipt and its admitted envelope; the owner's stored event, still validly signed, by the
 * receipt's actor, under the receipt's nonce, replying to that prompt with a token of the receipt's
 * decision and the prompt's code, in the prompt's room; and the prompt row, still ACP's own validly
 * signed prompt, binding this run, operation, candidate and scope.
 *
 * With `nowMs` it also asks the prompt's server-stored window (O3), which is what consumption asks;
 * an execution resuming on its anchored receipt asks without it.
 */
export const verifyBuzzApprovalEvidence = (
  db: Pick<Db, "get">,
  receipt: OwnerApprovalReceipt,
  options: { nowMs?: number } = {},
): Decision<void> => {
  const refuse = (refusal: string, message: string, evidence: Evidence = {}): Decision<void> =>
    deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, message, { refusal, runId: receipt.runId, ...evidence });
  if (
    receipt.channel !== BUZZ_OWNER_APPROVAL_CHANNEL ||
    !receipt.inboundNonce.startsWith(BUZZ_APPROVAL_NONCE_PREFIX) ||
    !receipt.idempotencyKey.startsWith(BUZZ_APPROVAL_IDEMPOTENCY_PREFIX)
  ) {
    return refuse("RECEIPT_NOT_BUZZ_APPROVAL", "the receipt is not a Buzz owner approval this daemon minted");
  }
  const approvalEventId = receipt.inboundNonce.slice(BUZZ_APPROVAL_NONCE_PREFIX.length);
  const promptEventId = receipt.idempotencyKey.slice(BUZZ_APPROVAL_IDEMPOTENCY_PREFIX.length);
  const answer = readAnswer(db, promptEventId);
  if (answer?.state !== "ANSWERED") {
    return refuse("ANSWER_MISSING", "no recorded answer of the prompt this receipt names", { promptEventId });
  }
  if (answer.inboundNonce !== receipt.inboundNonce || answer.receiptDigest !== digestOf(receipt) || digestOf(answer.receipt) !== digestOf(receipt)) {
    return refuse("ANSWER_MISMATCH", "the recorded answer is not this receipt", { promptEventId });
  }
  if (!isRecord(answer.envelope) || digestOf(answer.envelope) !== envelopeDigestOf(receipt)) {
    return refuse("ENVELOPE_MISMATCH", "the recorded envelope is not the one this receipt was admitted with", { promptEventId });
  }
  const event = answer.approvalEvent;
  if (event.id !== approvalEventId || event.kind !== BUZZ_KIND || !verifies(event)) {
    return refuse("EVENT_UNVERIFIED", "the owner's stored event does not verify under this receipt's nonce", { promptEventId });
  }
  if (normalizeBuzzActor(receipt.actor) !== event.pubkey) {
    return refuse("EVENT_AUTHOR_MISMATCH", "the owner's stored event was not signed by the receipt's actor", { promptEventId });
  }
  if (buzzReplyReferenceOf(event) !== promptEventId) {
    return refuse("EVENT_NOT_A_REPLY", "the owner's stored event does not reply to the prompt", { promptEventId });
  }
  const token = buzzOwnerApprovalContentOf(event.content);
  const prompt = readPrompt(db, promptEventId);
  if (prompt === null) return refuse("PROMPT_UNVERIFIED", "the prompt this receipt answers does not read back", { promptEventId });
  if (token.kind !== "TOKEN" || token.approved !== receipt.approved || token.code !== prompt.code) {
    return refuse("EVENT_DECISION_MISMATCH", "the owner's stored event does not carry this decision on this prompt", { promptEventId });
  }
  const rooms = tagValues(event, "h");
  if (rooms.length !== 1 || rooms[0] !== prompt.room) {
    return refuse("EVENT_ROOM_MISMATCH", "the owner's stored event is not in the prompt's room", { promptEventId });
  }
  const { binding } = prompt;
  if (
    binding.runId !== receipt.runId ||
    binding.operation !== receipt.operation ||
    binding.parameterDigest !== receipt.parameterDigest ||
    binding.candidateSnapshotDigest !== receipt.candidateSnapshotDigest
  ) {
    return refuse("PROMPT_SCOPE_MISMATCH", "the prompt binds another run, operation, candidate or scope", { promptEventId });
  }
  if (options.nowMs !== undefined && options.nowMs > prompt.expiresAtMs) {
    return refuse("PROMPT_EXPIRED", "the prompt's stored window has closed, so its answer is no longer consumable", {
      promptEventId,
      expiresAt: prompt.expiresAt,
    });
  }
  return allow(ReasonCode.OK, undefined);
};

/* --------------------------------------------------------------------------------- the store */

/** The runner questions this module asks; `RepoFactoryBootstrapRunner` answers them in production. */
export interface BuzzOwnerApprovalRunnerPort {
  approvalScopeOf(runId: string): Decision<RepoFactoryApprovalScope>;
  ownerApprovalNeed(runId: string, scope: RepoFactoryApprovalScope): RepoFactoryOwnerApprovalNeed;
  recordOwnerApproval(
    runId: string,
    record: {
      owner: string;
      visibility: "public" | "private";
      planDigest: string;
      approvedManifest: RepoFactoryApprovalScope["approvedManifest"];
      projectName: string;
      receipt: OwnerApprovalReceipt;
    },
  ): Decision<unknown>;
}

/** The subscriber's publisher, narrowed to the two owner-approval calls and what they need. */
export interface BuzzOwnerApprovalPublisherPort {
  roomsOf(pubkey: string): readonly string[] | null;
  ready(pubkey: string): boolean;
  signApprovalPublication(publication: BuzzApprovalPublication): BuzzSignedEvent | null;
  publishApprovalPublication(publication: BuzzApprovalPublication, timeoutMs: number): Promise<BuzzPublishAck>;
}

/** The subscriber's admission of one identity, judged now, and its reply filter's refresh. */
export interface BuzzOwnerApprovalIdentityPort {
  /** The identity's role and the room its bound session answers in, or why it is not admitted. */
  admitted(pubkey: string): { readonly roleKey: string; readonly room: string } | { readonly excluded: string };
  /** Asks every connected identity to send its reply filter again. */
  refreshReplies(): void;
}

export interface BuzzOwnerApprovalCeo {
  readonly sessionId: string;
  readonly sessionIncarnation: string;
  readonly live: boolean;
}

export interface BuzzOwnerApprovalPorts {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly runner: BuzzOwnerApprovalRunnerPort;
  readonly runs: { list(filter: { state?: RunState }): readonly RunRow[] };
  /** The `buzz` owner identities exactly as `owner-identities` declares them. */
  readonly ownerActors: readonly string[];
  /** The approval identity X's x-only key, or null when none is configured. */
  readonly identity: string | null;
  /** The approval identity was configured, and is not a usable key. */
  readonly identityInvalid?: boolean;
  /** The deployment's Buzz replay window, so the receipt's admission prunes nothing earlier than its own guard would. */
  readonly ingressPolicy?: Pick<IngressPolicy, "nonceTtlMs" | "transportRetentionMs"> | null;
  /** The current CEO binding, for a re-issue request (O2). */
  readonly currentCeo?: () => BuzzOwnerApprovalCeo | null;
  readonly publishTimeoutMs?: number;
}

/** One verified event, from the approval reply route or the mention sink. */
export interface BuzzOwnerApprovalRequest {
  /** The subscribed identity whose connection received it. */
  readonly identityPubkey: string;
  /** The event's single `h` tag, as the subscriber read it. */
  readonly conversation: string;
  readonly event: BuzzMentionEvent;
}

/** A recorded owner decision, newly minted or reused. */
export interface BuzzOwnerApprovalAnswer {
  readonly result: "MINTED" | "REUSED";
  readonly promptEventId: string;
  readonly receipt: OwnerApprovalReceipt;
}

export interface BuzzOwnerApprovalTick {
  readonly issued: readonly string[];
  readonly cancelled: readonly string[];
  readonly published: readonly string[];
  readonly authority: string | null;
}

export interface BuzzOwnerApprovalHealth {
  readonly configured: boolean;
  /** Why no prompt can be posted now, or null when one can. */
  readonly unavailable: string | null;
  readonly openPrompts: number;
  readonly unpublishedPrompts: number;
  readonly unpublishedOutcomes: number;
  readonly minted: number;
  readonly reused: number;
  readonly replays: number;
  readonly notApprovals: number;
  /** Refusals of events no owner signed; nothing durable was written for any of them. */
  readonly strangerRefusals: number;
  /** Owner-signed refusals by reason code. */
  readonly refusals: Readonly<Record<string, number>>;
}

const DELIVERED = new Set(["ACCEPTED", "DUPLICATE"]);
/** A relay answer that will not change by sending the same event again. */
const BLOCKED = new Set(["REFUSED_OTHER", "UNAUTHORIZED"]);

const deliveryStatusOf = (ack: BuzzPublishAck): string => (ack.status === "REFUSED" ? ack.category : ack.status);

export class BuzzOwnerApprovals {
  readonly #ports: BuzzOwnerApprovalPorts;
  /** Normalized owner key → the actor exactly as declared, which is what the receipt and allowlists carry. */
  readonly #owners: ReadonlyMap<string, string>;
  #publisher: BuzzOwnerApprovalPublisherPort | null = null;
  #identityPort: BuzzOwnerApprovalIdentityPort | null = null;
  readonly #inFlight = new Set<string>();
  #closed = false;
  #unavailable: string | null = null;
  #minted = 0;
  #reused = 0;
  #replays = 0;
  #notApprovals = 0;
  #strangerRefusals = 0;
  readonly #refusals = new Map<string, number>();

  constructor(ports: BuzzOwnerApprovalPorts) {
    this.#ports = ports;
    const owners = new Map<string, string>();
    for (const actor of ports.ownerActors) {
      const normalized = normalizeBuzzActor(actor);
      if (normalized !== null && !owners.has(normalized)) owners.set(normalized, actor.trim());
    }
    this.#owners = owners;
    this.#unavailable = ports.identity !== null ? "SUBSCRIBER_NOT_ATTACHED" : this.#identityMissing();
  }

  #identityMissing(): string {
    return this.#ports.identityInvalid === true ? "IDENTITY_INVALID" : "IDENTITY_NOT_CONFIGURED";
  }

  /** The subscriber it publishes through and whose admission it asks, once that subscriber exists. */
  attach(publisher: BuzzOwnerApprovalPublisherPort, identity: BuzzOwnerApprovalIdentityPort): void {
    this.#publisher = publisher;
    this.#identityPort = identity;
  }

  close(): void {
    this.#closed = true;
  }

  /** The configured owner actor whose key signed, compared in constant time over normalized keys. */
  #ownerActorFor(pubkey: string): string | null {
    let found: string | null = null;
    for (const [key, actor] of this.#owners) {
      if (constantTimeEquals(key, pubkey)) found = actor;
    }
    return found;
  }

  /* ---------------------------------------------------------------------------- receiving */

  /**
   * One verified event that may answer a prompt (DESIGN §6, amended by O3), judged in order: the
   * signature, the owner key, the grammar, the prompt the reply references, its room and receiving
   * identity, the code, the prompt's answer slot, the server-stored expiry, the scope recomputed now,
   * and the run's need. A stranger's refusal writes nothing; an owner-signed refusal writes one
   * refusal row for its event, and that refusal is the event's answer from then on.
   */
  receive(request: BuzzOwnerApprovalRequest): Decision<BuzzOwnerApprovalAnswer> {
    const { event } = request;
    const db = this.#ports.db;
    if (event.kind !== BUZZ_KIND || !verifies(event)) {
      this.#strangerRefusals += 1;
      return deny(ReasonCode.INGRESS_SIGNATURE_INVALID, "the approval event's signature does not verify", { channel: "buzz" });
    }
    const owner = this.#ownerActorFor(event.pubkey);
    if (owner === null) {
      this.#strangerRefusals += 1;
      return deny(ReasonCode.BUZZ_APPROVAL_NOT_OWNER, "the approval event was not signed by a declared buzz owner key", { channel: "buzz" });
    }
    const refused = readRefusal(db, event.id);
    if (refused !== null) {
      return deny(refused.reasonCode as ReasonCode, "this approval event was already refused, and its refusal stands", {
        channel: "buzz",
        eventId: event.id,
      });
    }
    const content = buzzOwnerApprovalContentOf(event.content);
    if (content.kind === "NONE") {
      // An owner's reply in the prompt's thread with no token: not an answer, and nothing is written.
      this.#notApprovals += 1;
      return deny(ReasonCode.BUZZ_APPROVAL_MALFORMED, "the event carries no approval token", { channel: "buzz", cause: "no-marker" });
    }
    if (content.kind === "MALFORMED") {
      return this.#ownerRefusal(event, null, deny(ReasonCode.BUZZ_APPROVAL_MALFORMED, "an approval reply must carry exactly one well-formed token and nothing else like it", {
        channel: "buzz",
      }));
    }
    const reference = buzzReplyReferenceOf(event);
    const prompt = reference === null ? null : readPrompt(db, reference);
    if (prompt === null) {
      return this.#ownerRefusal(event, null, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_UNRESOLVED, "the reply does not reference exactly one stored approval prompt", {
        channel: "buzz",
      }));
    }
    const promptEventId = prompt.promptEventId;
    const rooms = tagValues(event, "h");
    if (
      rooms.length !== 1 ||
      rooms[0] !== prompt.room ||
      request.conversation !== prompt.room ||
      request.identityPubkey !== prompt.signer
    ) {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_WRONG_ROOM, "the reply is not in the prompt's room, or did not reach the identity that posted it", {
        channel: "buzz",
        promptEventId,
      }));
    }
    if (content.code !== prompt.code) {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_CODE_MISMATCH, "the token's code is not the code of the prompt it replies to", {
        channel: "buzz",
        promptEventId,
      }));
    }
    const answer = readAnswer(db, promptEventId);
    if (answer === undefined) {
      return deny(ReasonCode.CONFLICT, "the prompt's answer slot does not read back, and a recorded answer is never replaced", { promptEventId });
    }
    if (answer?.state === "CANCELLED") {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_CANCELLED, "the prompt was cancelled", {
        channel: "buzz",
        promptEventId,
        reason: answer.reason,
      }));
    }
    if (answer?.state === "ANSWERED") {
      if (answer.approvalEvent.id === event.id) {
        // The relay again, or a restart: the recorded outcome is the answer, and nothing is written.
        this.#replays += 1;
        void this.#publishOutcome(promptEventId);
        return deny(ReasonCode.INGRESS_REPLAY_IGNORED, "this approval event is already recorded", { channel: "buzz", promptEventId });
      }
      if (answer.approved && content.approved) {
        // The same decision again reuses the recorded receipt, and only while its window is open:
        // a duplicate never extends it, and an expired receipt is not reported as reusable (O3).
        if (this.#ports.clock.now().getTime() > prompt.expiresAtMs) {
          return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED, "the prompt's window has closed", {
            channel: "buzz",
            promptEventId,
            expiresAt: prompt.expiresAt,
          }));
        }
        this.#reused += 1;
        return allow(ReasonCode.OK, { result: "REUSED", promptEventId, receipt: answer.receipt });
      }
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED, "the prompt already holds another answer", {
        channel: "buzz",
        promptEventId,
      }));
    }
    // O3: the server's stored expiry, never the owner's signed time, decides whether the window is open.
    if (this.#ports.clock.now().getTime() > prompt.expiresAtMs) {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED, "the prompt's window has closed", {
        channel: "buzz",
        promptEventId,
        expiresAt: prompt.expiresAt,
      }));
    }
    if (event.created_at < prompt.createdAt - BUZZ_OWNER_APPROVAL_SIGNED_SKEW_SECONDS) {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED, "the reply is dated before its prompt existed", {
        channel: "buzz",
        promptEventId,
        cause: "signed-before-prompt",
      }));
    }
    const runId = prompt.binding.runId;
    const scope = this.#ports.runner.approvalScopeOf(runId);
    const stale = scope.allowed ? buzzOwnerApprovalStaleField(prompt.binding, scope.value) : "planDigest";
    if (!scope.allowed || stale !== null) {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_PROMPT_STALE, "the run's current scope is not the one the prompt binds", {
        channel: "buzz",
        promptEventId,
        field: stale,
      }));
    }
    const need = this.#ports.runner.ownerApprovalNeed(runId, scope.value);
    const anchored = need.need === "EXECUTION_ANCHORED";
    if (need.need === "NOT_APPLICABLE" || (anchored && !content.approved)) {
      return this.#ownerRefusal(event, promptEventId, deny(ReasonCode.BUZZ_APPROVAL_RUN_NOT_AWAITING_APPROVAL, "the run is not awaiting an owner decision on this scope", {
        channel: "buzz",
        promptEventId,
        need: need.need,
      }));
    }
    if ((need.need === "SATISFIED" || anchored) && content.approved && need.receipt !== null) {
      // The same decision again: the valid receipt stands, and no artifact is recorded beside it, so
      // C3's newest decision does not move and an execution in flight is never superseded.
      this.#reused += 1;
      return allow(ReasonCode.OK, { result: "REUSED", promptEventId, receipt: need.receipt });
    }
    return this.#mint(prompt, event, owner, content.approved);
  }

  /** An owner-signed refusal: one refusal row for the event, and that refusal returned. */
  #ownerRefusal<T>(event: BuzzSignedEvent, promptEventId: string | null, decision: Decision<T>): Decision<T> {
    if (decision.allowed) return decision;
    this.#refusals.set(decision.reasonCode, (this.#refusals.get(decision.reasonCode) ?? 0) + 1);
    const db = this.#ports.db;
    db.tx(() => {
      if (readRefusal(db, event.id) !== null) return;
      db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
        [
          BUZZ_OWNER_APPROVAL_REFUSAL_CHANNEL,
          event.id,
          event.pubkey,
          this.#ports.clock.nowIso(),
          JSON.stringify({ reasonCode: decision.reasonCode, promptEventId }),
        ],
      );
      this.#ports.audit.record({
        kind: "BUZZ_OWNER_APPROVAL_REFUSED",
        reasonCode: decision.reasonCode,
        actor: `buzz:${event.pubkey}`,
        evidence: { channel: "buzz", eventId: event.id, promptEventId },
      });
    });
    return decision;
  }

  /**
   * The answer, the receipt's admission and the APPROVAL artifact, in one transaction that waits on
   * nothing: the outcome reply is signed before it and sent after it. The window and the scope are
   * asked again inside it (O3), so what is recorded is what holds at the moment it commits.
   */
  #mint(prompt: StoredPrompt, event: BuzzSignedEvent, ownerActor: string, approved: boolean): Decision<BuzzOwnerApprovalAnswer> {
    const { db, clock, audit, runner } = this.#ports;
    const promptEventId = prompt.promptEventId;
    const runId = prompt.binding.runId;
    const scope = runner.approvalScopeOf(runId);
    if (!scope.allowed) return scope as Decision<BuzzOwnerApprovalAnswer>;
    const inboundNonce = `${BUZZ_APPROVAL_NONCE_PREFIX}${event.id}`;
    const approval: OwnerApprovalIngress = {
      runId,
      candidateSnapshotDigest: scope.value.candidateSnapshotDigest,
      operation: scope.value.operation,
      parameters: scope.value.parameters,
      idempotencyKey: `${BUZZ_APPROVAL_IDEMPOTENCY_PREFIX}${promptEventId}`,
      approved,
    };
    const envelope = ownerApprovalPayload(approval);
    const receipt: OwnerApprovalReceipt = {
      channel: BUZZ_OWNER_APPROVAL_CHANNEL,
      actor: ownerActor,
      inboundNonce,
      runId,
      candidateSnapshotDigest: approval.candidateSnapshotDigest,
      operation: approval.operation,
      parameterDigest: digestOf(approval.parameters),
      idempotencyKey: approval.idempotencyKey,
      approved,
    };
    const receiptDigest = digestOf(receipt);
    const answeredAt = clock.nowIso();
    // Signed before the transaction, which waits on no network, and kept in the answer's write-once
    // payload rather than in its result_json, which any writer of that column can rewrite (R1056-01).
    const outcomeEvent = this.#signOutcome(prompt, event.id, approved, Math.floor(clock.now().getTime() / 1000));
    const minted = db.txDecision((): Decision<BuzzOwnerApprovalAnswer> => {
      if (readAnswer(db, promptEventId) !== null) {
        return deny(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED, "the prompt was answered while this answer was being recorded", { promptEventId });
      }
      if (clock.now().getTime() > prompt.expiresAtMs) {
        return deny(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED, "the prompt's window closed before this answer was recorded", { promptEventId });
      }
      const fresh = runner.approvalScopeOf(runId);
      const stale = fresh.allowed ? buzzOwnerApprovalStaleField(prompt.binding, fresh.value) : "planDigest";
      if (stale !== null || digestOf(fresh.allowed ? fresh.value.parameters : null) !== receipt.parameterDigest) {
        return deny(ReasonCode.BUZZ_APPROVAL_PROMPT_STALE, "the run's scope moved before this answer was recorded", { promptEventId, field: stale });
      }
      db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
        [
          BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL,
          promptEventId,
          event.pubkey,
          answeredAt,
          JSON.stringify({
            schema: ANSWER_SCHEMA,
            state: "ANSWERED",
            promptEventId,
            approvalEvent: plainCopy(event),
            approved,
            envelope,
            receipt,
            receiptDigest,
            inboundNonce,
            answeredAt,
            outcomeEvent: outcomeEvent === null ? null : plainCopy(outcomeEvent),
          }),
        ],
      );
      const guard = new IngressGuard(db, clock, audit, {
        buzz: {
          allowedActors: [...this.#owners.values()],
          ...(this.#ports.ingressPolicy?.nonceTtlMs === undefined ? {} : { nonceTtlMs: this.#ports.ingressPolicy.nonceTtlMs }),
          ...(this.#ports.ingressPolicy?.transportRetentionMs === undefined
            ? {}
            : { transportRetentionMs: this.#ports.ingressPolicy.transportRetentionMs }),
        },
      });
      const admitted = guard.admitOwnerApproval(
        { channel: "buzz", actor: ownerActor, conversation: prompt.room, nonce: inboundNonce, payload: envelope },
        approval,
      );
      if (!admitted.allowed) return admitted as Decision<BuzzOwnerApprovalAnswer>;
      if (digestOf(admitted.value) !== receiptDigest) {
        return deny(ReasonCode.CONFLICT, "the admitted receipt is not the one recorded with the answer", { promptEventId });
      }
      const recorded = runner.recordOwnerApproval(runId, {
        owner: fresh.allowed ? fresh.value.owner : prompt.binding.owner,
        visibility: prompt.binding.visibility,
        planDigest: prompt.binding.planDigest,
        approvedManifest: (fresh.allowed ? fresh.value : scope.value).approvedManifest,
        projectName: (fresh.allowed ? fresh.value : scope.value).projectName,
        receipt,
      });
      if (!recorded.allowed) return recorded as Decision<BuzzOwnerApprovalAnswer>;
      return allow(ReasonCode.OK, { result: "MINTED", promptEventId, receipt });
    });
    if (!minted.allowed) return minted;
    this.#minted += 1;
    this.#identityPort?.refreshReplies();
    void this.#publishOutcome(promptEventId);
    return minted;
  }

  #signOutcome(prompt: StoredPrompt, replyToEventId: string, approved: boolean, createdAt: number): BuzzSignedEvent | null {
    const publisher = this.#publisher;
    if (publisher === null) return null;
    const publication = issuePublication(this.#ports.db, {
      basis: { kind: "OUTCOME", binding: prompt.binding, approved, room: prompt.room, replyToEventId },
      signer: prompt.signer,
      createdAt,
      intent: null,
      source: null,
    });
    try {
      return publisher.signApprovalPublication(publication);
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------------------------------- filter */

  /**
   * The reply filter for one subscribed identity (CEO 1791605708): the prompts it signed that are
   * still open — unanswered, uncancelled, inside their stored window — by their exact event ids, and
   * the earliest time a reply to any of them may carry. Null for none.
   */
  replyFilter(pubkey: string): { readonly eventIds: readonly string[]; readonly since: number } | null {
    const now = this.#ports.clock.now().getTime();
    const open = this.#openPrompts().filter((prompt) => prompt.signer === pubkey && now <= prompt.expiresAtMs);
    if (open.length === 0) return null;
    return {
      eventIds: open.map((prompt) => prompt.promptEventId),
      since: Math.min(...open.map((prompt) => prompt.createdAt)) - BUZZ_OWNER_APPROVAL_SIGNED_SKEW_SECONDS,
    };
  }

  /** Every prompt with no answer row, oldest first; one that does not read back is passed over. */
  #openPrompts(): StoredPrompt[] {
    const db = this.#ports.db;
    return db
      .all<{ nonce: string }>(
        `SELECT p.nonce FROM inbound_messages AS p
          WHERE p.channel = ?
            AND NOT EXISTS (SELECT 1 FROM inbound_messages AS a WHERE a.channel = ? AND a.nonce = p.nonce)
          ORDER BY p.received_at ASC, p.nonce ASC`,
        [BUZZ_OWNER_APPROVAL_PROMPT_CHANNEL, BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL],
      )
      .flatMap((row) => {
        const prompt = readPrompt(db, row.nonce);
        return prompt === null ? [] : [prompt];
      });
  }

  /** The prompts ever issued for (run, scope, candidate), by issue number. */
  #issuedFor(binding: Pick<BuzzOwnerApprovalBinding, "runId" | "parameterDigest" | "candidateSnapshotDigest">): StoredPrompt[] {
    const db = this.#ports.db;
    return db
      .all<{ nonce: string }>(
        `SELECT nonce FROM inbound_messages WHERE channel = ? AND json_extract(payload_json, '$.binding.runId') = ?
          ORDER BY received_at ASC, nonce ASC`,
        [BUZZ_OWNER_APPROVAL_PROMPT_CHANNEL, binding.runId],
      )
      .flatMap((row) => {
        const prompt = readPrompt(db, row.nonce);
        return prompt !== null &&
          prompt.binding.parameterDigest === binding.parameterDigest &&
          prompt.binding.candidateSnapshotDigest === binding.candidateSnapshotDigest
          ? [prompt]
          : [];
      })
      .sort((left, right) => left.issue - right.issue);
  }

  /* --------------------------------------------------------------------------------- posting */

  /**
   * Who may post a prompt now, and where (O1): the configured approval identity, held by this
   * daemon's subscriber, admitted on its live canonical binding, answering in a room it subscribes
   * in, over an authenticated connection.
   */
  #postingAuthority(): Decision<{ signer: string; room: string }> {
    const unavailable = (cause: string): Decision<{ signer: string; room: string }> => {
      this.#unavailable = cause;
      return deny(ReasonCode.BUZZ_APPROVAL_IDENTITY_UNAVAILABLE, "no owner approval prompt can be posted now", { cause });
    };
    const signer = this.#ports.identity;
    if (signer === null) return unavailable(this.#identityMissing());
    const publisher = this.#publisher;
    const identityPort = this.#identityPort;
    if (publisher === null || identityPort === null) return unavailable("SUBSCRIBER_NOT_ATTACHED");
    const rooms = publisher.roomsOf(signer);
    if (rooms === null) return unavailable("IDENTITY_NOT_HELD");
    const admitted = identityPort.admitted(signer);
    if ("excluded" in admitted) return unavailable(`IDENTITY_NOT_ADMITTED:${admitted.excluded}`);
    if (!rooms.includes(admitted.room)) return unavailable("ROOM_NOT_SUBSCRIBED");
    if (!publisher.ready(signer)) return unavailable("IDENTITY_NOT_CONNECTED");
    this.#unavailable = null;
    return allow(ReasonCode.OK, { signer, room: admitted.room });
  }

  /**
   * Signs a prompt for `scope`, then stores its issue and the signed event in one transaction —
   * cancelling `replaces` in the same one — and only then sends the stored event. A retry sends the
   * identical event; an unknown outcome is never re-signed into a second prompt.
   */
  #issuePrompt(scope: RepoFactoryApprovalScope, issue: number, replaces: string | null): Decision<{ promptEventId: string }> {
    const authority = this.#postingAuthority();
    if (!authority.allowed) return authority as Decision<{ promptEventId: string }>;
    const { db, clock, audit } = this.#ports;
    const { signer, room } = authority.value;
    const binding = buzzOwnerApprovalBindingOf(scope);
    const issueKey = buzzOwnerApprovalIssueKey(binding, issue);
    const code = buzzOwnerApprovalCode(issueKey);
    const createdAt = Math.floor(clock.now().getTime() / 1000);
    const expiresAtMs = createdAt * 1000 + BUZZ_OWNER_APPROVAL_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const ownerKeys = [...this.#owners.keys()];
    const publication = issuePublication(db, {
      basis: { kind: "PROMPT", binding, code, expiresAt, room, ownerKeys },
      signer,
      createdAt,
      intent: null,
      source: null,
    });
    const event = this.#publisher?.signApprovalPublication(publication) ?? null;
    if (event === null) {
      return deny(ReasonCode.BUZZ_APPROVAL_IDENTITY_UNAVAILABLE, "the approval identity did not sign the prompt", { cause: "PROMPT_NOT_SIGNED" });
    }
    const stored = db.txDecision((): Decision<{ promptEventId: string }> => {
      const existing = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = ? AND nonce = ?`,
        [BUZZ_OWNER_APPROVAL_ISSUE_CHANNEL, issueKey],
      );
      if ((existing?.n ?? 0) > 0) return deny(ReasonCode.CONFLICT, "this issue of the prompt was already posted", { issue });
      const now = clock.nowIso();
      db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
        [BUZZ_OWNER_APPROVAL_ISSUE_CHANNEL, issueKey, signer, now, JSON.stringify({ promptEventId: event.id, runId: binding.runId, issue })],
      );
      db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, result_json) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          BUZZ_OWNER_APPROVAL_PROMPT_CHANNEL,
          event.id,
          signer,
          now,
          JSON.stringify({
            schema: PROMPT_SCHEMA,
            promptEventId: event.id,
            binding,
            room,
            signer,
            ownerKeys,
            code,
            issue,
            issueKey,
            createdAt,
            expiresAt,
            expiresAtMs,
            event: plainCopy(event),
          }),
          JSON.stringify({ delivery: { status: "PENDING", attempts: 0 } }),
        ],
      );
      if (replaces !== null && readAnswer(db, replaces) === null) this.#cancelIn(replaces, "REISSUED");
      audit.record({
        kind: "BUZZ_OWNER_APPROVAL_PROMPTED",
        runId: binding.runId,
        actor: `buzz:${signer}`,
        evidence: { channel: "buzz", promptEventId: event.id, issue, scope: binding.parameterDigest, expiresAt },
      });
      return allow(ReasonCode.OK, { promptEventId: event.id });
    });
    if (!stored.allowed) return stored;
    this.#identityPort?.refreshReplies();
    return stored;
  }

  /** Writes a prompt's cancellation into its answer slot; the caller holds the transaction. */
  #cancelIn(promptEventId: string, reason: string): void {
    this.#ports.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
      [
        BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL,
        promptEventId,
        "acp",
        this.#ports.clock.nowIso(),
        JSON.stringify({ schema: ANSWER_SCHEMA, state: "CANCELLED", promptEventId, reason }),
      ],
    );
  }

  #cancel(promptEventId: string, reason: string): boolean {
    const db = this.#ports.db;
    return db.tx(() => {
      if (readAnswer(db, promptEventId) !== null) return false;
      this.#cancelIn(promptEventId, reason);
      return true;
    });
  }

  /**
   * O2 — the currently authenticated CEO asks for the prompt of a run's current scope to be posted
   * again. It names a run and nothing else: the scope is the run's, the answer is the owner's, and
   * the previous open prompt is cancelled in the same transaction that stores the new one.
   *
   * No CEO tool calls this yet: exposing it on the adopted CEO tool socket is a separate change.
   */
  reissue(runtime: unknown, runId: string): Decision<{ promptEventId: string }> {
    if (!isAdmittedRuntime(runtime)) {
      return deny(ReasonCode.CONFLICT, "the session proof was not issued by a lineage admission");
    }
    const ceo = this.#ports.currentCeo?.() ?? null;
    if (ceo === null || !ceo.live || ceo.sessionId !== runtime.sessionId || ceo.sessionIncarnation !== runtime.sessionIncarnation) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "only the current CEO binding's runtime may ask for a prompt to be re-issued");
    }
    const scope = this.#ports.runner.approvalScopeOf(runId);
    if (!scope.allowed) return scope as Decision<{ promptEventId: string }>;
    const need = this.#ports.runner.ownerApprovalNeed(runId, scope.value);
    if (need.need === "NOT_APPLICABLE" || need.need === "SATISFIED" || need.need === "EXECUTION_ANCHORED") {
      return deny(ReasonCode.BUZZ_APPROVAL_RUN_NOT_AWAITING_APPROVAL, "the run is not awaiting an owner decision on its current scope", {
        runId,
        need: need.need,
      });
    }
    const binding = buzzOwnerApprovalBindingOf(scope.value);
    const issued = this.#issuedFor(binding);
    const last = issued.at(-1);
    const replaces = last !== undefined && readAnswer(this.#ports.db, last.promptEventId) === null ? last.promptEventId : null;
    const posted = this.#issuePrompt(scope.value, (last?.issue ?? 0) + 1, replaces);
    if (posted.allowed) void this.#publishPrompt(posted.value.promptEventId);
    return posted;
  }

  /* ------------------------------------------------------------------------------------ tick */

  /**
   * The daemon's periodic pass: cancel the open prompts that no longer stand, post the first prompt
   * of each scope that needs a decision, and send whatever stored publication is still owed. A
   * scope that was declined, or whose prompt expired unanswered, is never prompted again here (O2).
   */
  async tick(): Promise<BuzzOwnerApprovalTick> {
    const cancelled: string[] = [];
    const issued: string[] = [];
    const published: string[] = [];
    if (this.#closed) return { issued, cancelled, published, authority: "CLOSED" };
    const now = this.#ports.clock.now().getTime();

    for (const prompt of this.#openPrompts()) {
      if (now > prompt.expiresAtMs) continue;
      const scope = this.#ports.runner.approvalScopeOf(prompt.binding.runId);
      const reason = !scope.allowed
        ? "SCOPE_UNAVAILABLE"
        : buzzOwnerApprovalStaleField(prompt.binding, scope.value) !== null
          ? "SCOPE_CHANGED"
          : this.#ports.runner.ownerApprovalNeed(prompt.binding.runId, scope.value).need === "NOT_APPLICABLE"
            ? "RUN_NOT_AWAITING_APPROVAL"
            : null;
      if (reason !== null && this.#cancel(prompt.promptEventId, reason)) cancelled.push(prompt.promptEventId);
    }

    const authority = this.#postingAuthority();
    if (authority.allowed) {
      for (const run of this.#ports.runs.list({ state: RunState.READY_FOR_CEO_REVIEW })) {
        if (run.kind !== RunKind.PROJECT_BOOTSTRAP || run.projectId !== null) continue;
        const scope = this.#ports.runner.approvalScopeOf(run.runId);
        if (!scope.allowed) continue;
        const need = this.#ports.runner.ownerApprovalNeed(run.runId, scope.value).need;
        if (need !== "NONE" && need !== "NOT_CONSUMABLE" && need !== "NEW_APPROVAL_REQUIRED") continue;
        // Only the first issue is automatic. A later one is the CEO's request (O2).
        if (this.#issuedFor(buzzOwnerApprovalBindingOf(scope.value)).length > 0) continue;
        const posted = this.#issuePrompt(scope.value, 1, null);
        if (posted.allowed) issued.push(posted.value.promptEventId);
      }
    }

    for (const prompt of this.#openPrompts()) {
      if (now > prompt.expiresAtMs || DELIVERED.has(prompt.deliveryStatus ?? "") || BLOCKED.has(prompt.deliveryStatus ?? "")) continue;
      if (await this.#publishPrompt(prompt.promptEventId)) published.push(prompt.promptEventId);
    }
    for (const promptEventId of this.#owedOutcomes()) {
      if (await this.#publishOutcome(promptEventId)) published.push(promptEventId);
    }
    this.#identityPort?.refreshReplies();
    return { issued, cancelled, published, authority: authority.allowed ? null : this.#unavailable };
  }

  #owedOutcomes(): string[] {
    const db = this.#ports.db;
    return db
      .all<{ nonce: string }>(
        `SELECT nonce FROM inbound_messages WHERE channel = ? AND json_extract(payload_json, '$.state') = 'ANSWERED'
          AND json_type(payload_json, '$.outcomeEvent') = 'object'
          AND COALESCE(json_extract(result_json, '$.outcome.status'), '') NOT IN ('ACCEPTED', 'DUPLICATE', 'REFUSED_OTHER', 'UNAUTHORIZED')
          ORDER BY received_at ASC, nonce ASC`,
        [BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL],
      )
      .map((row) => row.nonce);
  }

  /** Sends a stored prompt's own event, once; true when the relay holds it. */
  async #publishPrompt(promptEventId: string): Promise<boolean> {
    const db = this.#ports.db;
    const prompt = readPrompt(db, promptEventId);
    if (prompt === null || readAnswer(db, promptEventId) !== null) return false;
    if (DELIVERED.has(prompt.deliveryStatus ?? "") || BLOCKED.has(prompt.deliveryStatus ?? "")) return false;
    return this.#send(`prompt:${promptEventId}`, prompt.signer, {
      basis: { kind: "PROMPT", binding: prompt.binding, code: prompt.code, expiresAt: prompt.expiresAt, room: prompt.room, ownerKeys: prompt.ownerKeys },
      signer: prompt.signer,
      createdAt: prompt.createdAt,
      intent: prompt.event,
      source: { kind: "PROMPT", promptEventId },
    }, (status) => {
      db.run(`UPDATE inbound_messages SET result_json = ? WHERE channel = ? AND nonce = ?`, [
        JSON.stringify({ delivery: { status, attempts: prompt.attempts + 1, at: this.#ports.clock.nowIso() } }),
        BUZZ_OWNER_APPROVAL_PROMPT_CHANNEL,
        promptEventId,
      ]);
    });
  }

  /** Sends an answer's stored outcome reply, once; true when the relay holds it. */
  async #publishOutcome(promptEventId: string): Promise<boolean> {
    const db = this.#ports.db;
    const answer = readAnswer(db, promptEventId);
    const prompt = readPrompt(db, promptEventId);
    if (answer?.state !== "ANSWERED" || answer.outcomeEvent === null || prompt === null) return false;
    if (DELIVERED.has(answer.outcomeStatus ?? "") || BLOCKED.has(answer.outcomeStatus ?? "")) return false;
    return this.#send(`outcome:${promptEventId}`, prompt.signer, {
      basis: { kind: "OUTCOME", binding: prompt.binding, approved: answer.approved, room: prompt.room, replyToEventId: answer.approvalEvent.id },
      signer: prompt.signer,
      createdAt: answer.outcomeEvent.created_at,
      intent: answer.outcomeEvent,
      source: { kind: "OUTCOME", promptEventId },
    }, (status) => {
      db.run(`UPDATE inbound_messages SET result_json = ? WHERE channel = ? AND nonce = ?`, [
        JSON.stringify({ outcome: { status, attempts: answer.outcomeAttempts + 1, at: this.#ports.clock.nowIso() } }),
        BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL,
        promptEventId,
      ]);
    });
  }

  /**
   * One send of a stored event. A publication failure is recorded as delivery state only: it is
   * never an approval's failure, and never its completion.
   */
  async #send(key: string, signer: string, publication: BuzzApprovalPublication, record: (status: string) => void): Promise<boolean> {
    const publisher = this.#publisher;
    if (this.#closed || publisher === null || this.#inFlight.has(key) || !publisher.ready(signer)) return false;
    this.#inFlight.add(key);
    try {
      const issued = issuePublication(this.#ports.db, publication);
      const ack = await publisher.publishApprovalPublication(issued, this.#ports.publishTimeoutMs ?? BUZZ_OWNER_APPROVAL_PUBLISH_TIMEOUT_MS);
      const status = deliveryStatusOf(ack);
      if (!this.#closed) record(status);
      return DELIVERED.has(status);
    } catch {
      return false;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /* ---------------------------------------------------------------------------------- health */

  health(): BuzzOwnerApprovalHealth {
    const db = this.#ports.db;
    const now = this.#ports.clock.now().getTime();
    const open = this.#openPrompts().filter((prompt) => now <= prompt.expiresAtMs);
    return {
      configured: this.#ports.identity !== null,
      unavailable: this.#unavailable,
      openPrompts: open.length,
      unpublishedPrompts: open.filter((prompt) => !DELIVERED.has(prompt.deliveryStatus ?? "")).length,
      unpublishedOutcomes: db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = ? AND json_extract(payload_json, '$.state') = 'ANSWERED'
          AND json_type(payload_json, '$.outcomeEvent') = 'object'
          AND COALESCE(json_extract(result_json, '$.outcome.status'), '') NOT IN ('ACCEPTED', 'DUPLICATE')`,
        [BUZZ_OWNER_APPROVAL_ANSWER_CHANNEL],
      )?.n ?? 0,
      minted: this.#minted,
      reused: this.#reused,
      replays: this.#replays,
      notApprovals: this.#notApprovals,
      strangerRefusals: this.#strangerRefusals,
      refusals: Object.fromEntries(this.#refusals),
    };
  }
}
