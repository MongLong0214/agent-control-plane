import type { ControlPlane } from "../app/control-plane.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

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

/**
 * Reserves a mutation key before executing it. A completed retry returns exactly the
 * durable first response; an interrupted reservation fails closed instead of risking a
 * second side effect after a process restart.
 */
export const idempotentMcpMutation = async (
  cp: Pick<ControlPlane, "db">,
  peer: AuthenticatedMcpPeer,
  idempotencyKey: string,
  execute: () => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> => {
  if (idempotencyKey.trim().length === 0) {
    return respond(deny(ReasonCode.INVALID_ARGUMENT, "MCP mutation requires an idempotency key"));
  }

  const reservation = cp.db.tx(() => {
    const existing = cp.db.get<{ actor: string; result_json: string | null }>(
      `SELECT actor, result_json FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?`,
      [idempotencyKey],
    );
    if (existing) return { existing };
    cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('mcp', ?, ?, ?)`,
      [idempotencyKey, peer.actor, new Date().toISOString()],
    );
    return { existing: null };
  });

  if (reservation.existing) {
    if (reservation.existing.actor !== peer.actor) {
      return respond(
        deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "MCP idempotency key belongs to another peer", {
          idempotencyKey,
        }),
      );
    }
    if (!reservation.existing.result_json) {
      return respond(
        deny(ReasonCode.INGRESS_REPLAY_IGNORED, "MCP mutation is already reserved", { idempotencyKey }),
      );
    }
    return JSON.parse(reservation.existing.result_json) as ToolResult;
  }

  const result = await execute();
  cp.db.run(
    `UPDATE inbound_messages SET result_json = ? WHERE channel = 'mcp' AND nonce = ? AND actor = ?`,
    [JSON.stringify(result), idempotencyKey, peer.actor],
  );
  return result;
};
