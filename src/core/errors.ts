import type { ReasonCode } from "./reason-codes.ts";

export type Evidence = Record<string, unknown>;

/**
 * Every denial carries a stable reason code plus the evidence that produced it
 * (PRD §40 Explainability). Callers across MCP / CLI / Buzz surface both verbatim.
 *
 * Implemented as fields on a plain Error rather than a subclass so the code, the
 * evidence and the message survive structured cloning and cross-realm throws.
 */
export type AcpError = Error & {
  readonly reasonCode: ReasonCode;
  readonly evidence: Evidence;
};

export const acpError = (
  reasonCode: ReasonCode,
  message: string,
  evidence: Evidence = {},
): AcpError =>
  Object.assign(new Error(message), { name: "AcpError", reasonCode, evidence });

export const isAcpError = (value: unknown): value is AcpError =>
  value instanceof Error &&
  typeof (value as Partial<AcpError>).reasonCode === "string" &&
  typeof (value as Partial<AcpError>).evidence === "object";

export const fail = (
  reasonCode: ReasonCode,
  message: string,
  evidence: Evidence = {},
): never => {
  throw acpError(reasonCode, message, evidence);
};

export const errorPayload = (
  error: AcpError,
): { reasonCode: ReasonCode; message: string; evidence: Evidence } => ({
  reasonCode: error.reasonCode,
  message: error.message,
  evidence: error.evidence,
});

/** Decision result: an allow/deny outcome that is data rather than control flow. */
export type Decision<T = undefined> =
  | { allowed: true; reasonCode: ReasonCode; evidence: Evidence; value: T }
  | { allowed: false; reasonCode: ReasonCode; evidence: Evidence; message: string };

export const allow = <T>(
  reasonCode: ReasonCode,
  value: T,
  evidence: Evidence = {},
): Decision<T> => ({ allowed: true, reasonCode, evidence, value });

export const deny = <T = undefined>(
  reasonCode: ReasonCode,
  message: string,
  evidence: Evidence = {},
): Decision<T> => ({ allowed: false, reasonCode, evidence, message });

export const unwrap = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw acpError(decision.reasonCode, decision.message, decision.evidence);
  return decision.value;
};
