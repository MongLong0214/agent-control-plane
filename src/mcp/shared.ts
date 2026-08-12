import type { Decision } from "../core/errors.ts";
import { isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/** Shape the MCP SDK expects from a tool callback; the index signature is its contract. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

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
