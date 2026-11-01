import { randomUUID } from "node:crypto";
import { sha256 } from "../core/digest.ts";
import type { Clock } from "../core/clock.ts";
import { MCP_THROWN_REFUSAL_WRITER } from "../core/credential-shapes.ts";
import { type AcpError, type Decision, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { credentialBearingField, prohibitedDurableField } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { registryView } from "../db/registry-view.ts";
import { McpMutationNotExecuted, runMcpReservedMutation } from "../ingress/ingress-guard.ts";

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
  /** Current socket admission authority, supplied only by the transport authenticator. */
  binding?: { roleKey: string; bindingGeneration: number };
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
  /**
   * Domain receipt recovery. `reservationVerified` is true only after current authority and
   * the stored reservation's request/principal fingerprint pass. Before reservation, a
   * domain receipt must independently prove the key and request it recovers. On the replay of a
   * stored result, `storedResult` is that result.
   */
  durableReplay?: (fingerprint: string, reservationVerified: boolean, storedResult?: ToolResult) => ToolResult | null;
  /**
   * Opt-in: on the replay of a stored result, a non-error `durableReplay` answer replaces it too,
   * not only a refusal. For a stored answer that names a state the domain can still leave.
   */
  durableReplaySupersedesStored?: boolean;
  /** Extra domain validation for settled handoff ACKs; never the mutation handler. */
  replayAuthority?: () => Decision<unknown>;
  /**
   * Opt-in: a replay while the first call with this key is still running in this process is answered as
   * in flight rather than refused. Nothing runs again; the key answers the stored result once it is done.
   */
  answersInFlight?: boolean;
}

/** What the request a progress notice answers carried, and the way back to its caller. */
export interface ProgressCarrier {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message: string };
  }) => Promise<void>;
}

/**
 * A `notifications/progress` sender for a long mutation's real steps, when its caller sent a progressToken;
 * undefined otherwise, so a caller that asked for none is sent none. A notice that cannot be sent (the
 * connection is gone) is dropped: the work and its stored result never depend on it.
 */
export const progressNotifier = (carrier: ProgressCarrier): ((message: string) => void) | undefined => {
  const progressToken = carrier._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    try {
      void carrier.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } })
        .catch(() => undefined);
    } catch {
      // A closed transport can refuse synchronously as well.
    }
  };
};

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
  reservationToken: string;
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
    handler: (fingerprint: string) => Promise<ToolResult> | ToolResult,
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
      handler: (fingerprint: string) => Promise<ToolResult> | ToolResult,
      request: McpMutationRequest,
    ): Promise<ToolResult> => idempotentMcpMutation(source, peer, idempotencyKey, handler, request),
  });

/**
 * A refusal a handler threw, answered as the denial it is (the shape `guarded` gives it) so that it is
 * stored as the call's outcome. Its message and evidence are kept only when they hold no credential
 * shape and no private bulk content, in a key or a value, and nest no deeper than the scans read
 * (#1279 G4); otherwise the reason code alone is. #1279 G3-1 — both are free
 * text: a digest or 64-hex id in them, whole or inside text, is kept only when it names a record the
 * store holds (`RegistryView.boundReference`) for the run the call names, never for its format alone.
 */
const thrownRefusal = (error: AcpError, db: Db, runId: string | null): ToolResult => {
  const full = { reasonCode: error.reasonCode, message: error.message, evidence: error.evidence };
  const site = { writer: MCP_THROWN_REFUSAL_WRITER, runId, registry: registryView(db) };
  return credentialBearingField(full, 0, [], site) === null && prohibitedDurableField(full) === null
    ? respond(deny(error.reasonCode, error.message, error.evidence))
    : respond(deny(error.reasonCode, "the refusal's message or evidence is not kept: it held credential-shaped or private content", {}));
};

/**
 * Reserves a mutation key before executing it. A completed retry returns exactly the
 * durable first response only for the same request/principal under current authority.
 * A refusal the handler throws (an ACP reason code) is a completed response like a returned one,
 * stored and replayed, so a refused call's key answers that refusal rather than an unknown outcome.
 * Only a certified pre-effect failure releases its reservation. An abandoned reservation
 * has an unknown outcome and is never re-executed, regardless of elapsed time.
 */
export const idempotentMcpMutation = async (
  source: McpMutationSource,
  peer: AuthenticatedMcpPeer,
  idempotencyKey: string,
  execute: (fingerprint: string) => Promise<ToolResult> | ToolResult,
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
  const envelope: MutationEnvelope = { kind: "mcp-mutation", version: 1, fingerprint, reservationToken: randomUUID(), result: null };
  const pendingJson = JSON.stringify(envelope);
  // A durable domain decision can survive a failed response store. With no reservation,
  // let its byte-preserving versioned identity refuse a changed retry without reserving that changed request.
  const existing = source.db.get("SELECT nonce FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?", [idempotencyKey]);
  const recovered = existing ? null : request.durableReplay?.(fingerprint, false);
  // The receipt is the proof; do not mint a new fingerprint over recovered history.
  if (recovered) return recovered;
  const reservation = await runMcpReservedMutation(
    source.db, peer.actor, idempotencyKey, source.clock.nowIso(), async () => {
      try {
        return await execute(fingerprint);
      } catch (error) {
        // A certified pre-effect failure still releases the key; any other throw leaves the outcome unknown.
        if (isAcpError(error) && !(error instanceof McpMutationNotExecuted)) {
          return thrownRefusal(error, source.db, typeof args["runId"] === "string" ? args["runId"] : null);
        }
        throw error;
      }
    },
    pendingJson, result => {
      const stored = source.db.run(
        `UPDATE inbound_messages SET result_json = ? WHERE channel = 'mcp' AND nonce = ? AND actor = ?
          AND result_json = ?`,
        [JSON.stringify({ ...envelope, result }), idempotencyKey, peer.actor, pendingJson],
      );
      if (stored.changes !== 1) throw acpError(ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN,
        "MCP mutation no longer owns its response reservation", { idempotencyKey });
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
        deny(ReasonCode.MCP_REPLAY_UNVERIFIABLE, "MCP replay has no verifiable request fingerprint", { idempotencyKey }),
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
      const durable = request.durableReplay?.(fingerprint, true);
      if (durable) return durable;
      if (reservation.inFlight && request.answersInFlight === true) {
        return respond(allow(ReasonCode.MCP_MUTATION_IN_FLIGHT, {
          idempotencyKey,
          inFlight: true,
          next: "the first call with this idempotencyKey is still running; call again with the same key for its result",
        }));
      }
      return respond(deny(reservation.inFlight ? ReasonCode.INGRESS_REPLAY_IGNORED : ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN,
        reservation.inFlight ? "MCP mutation is already reserved" : "MCP mutation outcome is unknown; reconcile durable state without resubmitting", { idempotencyKey }));
    }
    const replayAuthority = request.replayAuthority?.();
    if (replayAuthority && !replayAuthority.allowed) return respond(replayAuthority);
    const durable = request.durableReplay?.(fingerprint, true, stored.result);
    if (durable && (durable.isError || request.durableReplaySupersedesStored === true)) return durable;
    return stored.result;
  }
  return reservation.result;
};
