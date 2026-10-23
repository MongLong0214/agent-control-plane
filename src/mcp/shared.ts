import { sha256 } from "../core/digest.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { runMcpReservedMutation } from "../ingress/ingress-guard.ts";

/** Shape the MCP SDK expects from a tool callback; the index signature is its contract. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * A transport-authenticated peer. This context is created for one MCP connection by
 * the Unix-socket/token boundary; it is never parsed from a tool argument.
 */
export interface AuthenticatedMcpPeer {
  actor: string;
  sessionId?: string;
  sessionIncarnation?: string;
}

/**
 * The transport invokes this on every request, after validating its per-session secret.
 * It must fail after a session respawn, because the old incarnation is no longer a peer.
 */
export type McpPeerAuthenticator = () => Decision<AuthenticatedMcpPeer>;

/**
 * The only database-shaped dependency MCP needs: it is consumed while the port is built,
 * never retained by a tool handler. Keeping this structural lets non-production callers
 * exercise idempotency without exposing a composition root to a server (#352).
 */
export interface McpMutationSource {
  readonly db: Db;
  readonly clock: Clock;
}

export const authenticateMcpPeer = (
  authenticate: McpPeerAuthenticator,
): Decision<AuthenticatedMcpPeer> => {
  const peer = authenticate();
  if (!peer.allowed) return peer;
  if (!peer.value.actor) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "authenticated MCP peer has no identity");
  }
  return allow(ReasonCode.OK, peer.value);
};

/**
 * Every MCP response carries the stable reason code and the evidence (PRD §40
 * Explainability), so a caller that is denied learns exactly which invariant refused it.
 */
export const respond = <T>(decision: Decision<T>): ToolResult => {
  const body = decision.allowed
    ? { ok: true, reasonCode: decision.reasonCode, evidence: decision.evidence, value: decision.value }
    : {
        ok: false,
        reasonCode: decision.reasonCode,
        message: decision.message,
        evidence: decision.evidence,
      };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    ...(decision.allowed ? {} : { isError: true }),
    structuredContent: body as unknown as Record<string, unknown>,
  };
};

export const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, value }, null, 2) }],
  structuredContent: { ok: true, value } as Record<string, unknown>,
});

/** Turns a thrown AcpError back into the same shape a denial would have taken. */
export const guarded = async (fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    const body = isAcpError(err)
      ? { ok: false, reasonCode: err.reasonCode, message: err.message, evidence: err.evidence }
      : {
          ok: false,
          reasonCode: ReasonCode.INTERNAL_ERROR,
          message: (err as Error).message,
          evidence: {},
        };
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      isError: true,
      structuredContent: body as unknown as Record<string, unknown>,
    };
  }
};

/** Parsed request and tool-specific current authority, never supplied by tool arguments. */
export interface McpMutationRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  /** Returns the authorizing role key/generation when role-fenced. Runs before replay too. */
  authority: () => Decision<Record<string, unknown>>;
  provenance?: unknown;
  /** Existing domain receipt recovery, consulted only after shared replay verification. */
  durableReplay?: () => ToolResult | null;
  /** Extra domain validation for settled handoff ACKs; never the mutation handler. */
  replayAuthority?: () => Decision<unknown>;
}

/**
 * MCP request identity preserves string bytes, including CR/LF. Artifact canonicalJson
 * intentionally normalizes newlines and must not be used for mutation request identity.
 */
const requestJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => requestJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${requestJson(v)}`).join(",")}}`;
  }
  throw new TypeError("MCP request contains a non-JSON value");
};

interface MutationEnvelope {
  kind: "mcp-mutation";
  version: 1;
  fingerprint: string;
  result: ToolResult | null;
}

const readEnvelope = (json: string): MutationEnvelope | null => {
  try {
    const value = JSON.parse(json) as Partial<MutationEnvelope> | null;
    return value?.kind === "mcp-mutation" && value.version === 1
      && typeof value.fingerprint === "string" && Object.hasOwn(value, "result")
      ? value as MutationEnvelope : null;
  } catch { return null; }
};

/** A sealed operation, rather than a database facade, for MCP mutation idempotency. */
export interface McpMutationPort {
  execute(
    peer: AuthenticatedMcpPeer,
    idempotencyKey: string,
    handler: () => Promise<ToolResult> | ToolResult,
    request: McpMutationRequest,
  ): Promise<ToolResult>;
}

/**
 * Captures the raw persistence dependencies in this module's closure. A tool handler receives
 * only `execute`, so it cannot turn idempotency bookkeeping into arbitrary SQL authority.
 */
export const createMcpMutationPort = (source: McpMutationSource): McpMutationPort =>
  Object.freeze({
    execute: (
      peer: AuthenticatedMcpPeer,
      idempotencyKey: string,
      handler: () => Promise<ToolResult> | ToolResult,
      request: McpMutationRequest,
    ): Promise<ToolResult> => idempotentMcpMutation(source, peer, idempotencyKey, handler, request),
  });

/**
 * Reserves a mutation key before executing it. A completed retry returns exactly the
 * durable first response only for the same request/principal under current authority.
 * A failed in-process execution releases its reservation, while
 * an abandoned process reservation becomes retryable only after a bounded recovery delay.
 */
export const idempotentMcpMutation = async (
  source: McpMutationSource,
  peer: AuthenticatedMcpPeer,
  idempotencyKey: string,
  execute: () => Promise<ToolResult> | ToolResult,
  request: McpMutationRequest,
): Promise<ToolResult> => {
  if (idempotencyKey.trim().length === 0) {
    return respond(deny(ReasonCode.INVALID_ARGUMENT, "MCP mutation requires an idempotency key"));
  }

  const authority = request.authority();
  if (!authority.allowed) return respond(authority);
  const { idempotencyKey: _key, ...args } = request.arguments;
  const fingerprintOf = (currentAuthority: Record<string, unknown>): string => sha256(requestJson({
    version: 1, tool: request.toolName, arguments: args,
    principal: {
      actor: peer.actor, sessionId: peer.sessionId ?? null,
      sessionIncarnation: peer.sessionIncarnation ?? null,
      authority: currentAuthority, provenance: request.provenance ?? null,
    },
  }));
  const fingerprint = fingerprintOf(authority.value);
  const envelope: MutationEnvelope = { kind: "mcp-mutation", version: 1, fingerprint, result: null };
  const pendingJson = JSON.stringify(envelope);
  // A durable domain decision can survive a failed response store. With no reservation,
  // let its own digest refuse a changed retry without reserving that changed request.
  const existing = source.db.get("SELECT nonce FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [idempotencyKey]);
  const recovered = existing ? null : request.durableReplay?.();
  if (recovered?.isError) return recovered;
  const reservation = await runMcpReservedMutation(
    source.db, peer.actor, idempotencyKey, source.clock.nowIso(), () => recovered ?? (existing ? request.durableReplay?.() : null) ?? execute(),
    pendingJson, result => {
      source.db.run(
        `UPDATE inbound_messages SET result_json = ? WHERE channel = 'mcp' AND nonce = ? AND actor = ?`,
        [JSON.stringify({ ...envelope, result }), idempotencyKey, peer.actor],
      );
    },
  );
  if (reservation.kind === "existing") {
    if (reservation.actor !== peer.actor) {
      return respond(
        deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "MCP idempotency key belongs to another peer", {
          idempotencyKey,
        }),
      );
    }
    if (reservation.resultJson === null) {
      return respond(
        deny(ReasonCode.INGRESS_REPLAY_IGNORED, "MCP mutation is already reserved", { idempotencyKey }),
      );
    }
    // Reservation lookup yields. Authentication or a binding can change before this
    // continuation, so obtain current authority again immediately before a replay.
    const currentAuthority = request.authority();
    if (!currentAuthority.allowed) return respond(currentAuthority);
    const stored = readEnvelope(reservation.resultJson);
    if (!stored) {
      return respond(deny(ReasonCode.MCP_REPLAY_UNVERIFIABLE, "MCP replay has no verifiable request fingerprint"));
    }
    if (stored.fingerprint !== fingerprintOf(currentAuthority.value)) {
      return respond(deny(ReasonCode.CONFLICT, "MCP idempotency key names a different request or principal"));
    }
    if (stored.result === null) {
      // A domain receipt can already prove completion after a response-store failure.
      // Its replay is safe only after the same fingerprint and current authority passed.
      const durable = request.durableReplay?.();
      if (durable) return durable;
      return respond(deny(ReasonCode.INGRESS_REPLAY_IGNORED, "MCP mutation is already reserved", { idempotencyKey }));
    }
    const replayAuthority = request.replayAuthority?.();
    if (replayAuthority && !replayAuthority.allowed) return respond(replayAuthority);
    const durable = request.durableReplay?.();
    if (durable?.isError) return durable;
    return stored.result.isError ? durable ?? stored.result : stored.result;
  }
  return reservation.result;
};
