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

/** A sealed operation, rather than a database facade, for MCP mutation idempotency. */
export interface McpMutationPort {
  execute(
    peer: AuthenticatedMcpPeer,
    idempotencyKey: string,
    handler: () => Promise<ToolResult> | ToolResult,
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
    ): Promise<ToolResult> => idempotentMcpMutation(source, peer, idempotencyKey, handler),
  });

/**
 * Reserves a mutation key before executing it. A completed retry returns exactly the
 * durable first response. A failed in-process execution releases its reservation, while
 * an abandoned process reservation becomes retryable only after a bounded recovery delay.
 */
export const idempotentMcpMutation = async (
  source: McpMutationSource,
  peer: AuthenticatedMcpPeer,
  idempotencyKey: string,
  execute: () => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> => {
  if (idempotencyKey.trim().length === 0) {
    return respond(deny(ReasonCode.INVALID_ARGUMENT, "MCP mutation requires an idempotency key"));
  }

  const reservation = await runMcpReservedMutation(
    source.db, peer.actor, idempotencyKey, source.clock.nowIso(), execute,
  );
  if (reservation.kind === "existing") {
    if (reservation.actor !== peer.actor) {
      return respond(
        deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "MCP idempotency key belongs to another peer", {
          idempotencyKey,
        }),
      );
    }
    if (!reservation.resultJson) {
      return respond(
        deny(ReasonCode.INGRESS_REPLAY_IGNORED, "MCP mutation is already reserved", { idempotencyKey }),
      );
    }
    return JSON.parse(reservation.resultJson) as ToolResult;
  }
  source.db.run(
    `UPDATE inbound_messages SET result_json = ? WHERE channel = 'mcp' AND nonce = ? AND actor = ?`,
    [JSON.stringify(reservation.result), idempotencyKey, peer.actor],
  );
  return reservation.result;
};
