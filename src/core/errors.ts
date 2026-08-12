import type { ReasonCode } from "./reason-codes.ts";

export type Evidence = Record<string, unknown>;

/**
 * Every denial carries a stable reason code plus the evidence that produced it
 * (PRD §40 Explainability). Callers across MCP / CLI / Buzz surface both verbatim.
 *
 * Fields live on a plain Error rather than a subclass so that `instanceof` across module
 * copies is never the discriminator. Note what this does *not* buy: structured cloning
 * drops own properties of an Error, and an Error from another realm fails `instanceof`.
 * Anything that crosses a process, worker or message boundary must therefore carry
 * `errorPayload()` and be rebuilt with `fromErrorPayload()` — see `DenialPayload`.
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

/**
 * Structural, not `instanceof`-based: a value carrying the contract is treated as
 * carrying it, whichever realm or module copy produced it.
 */
export const isAcpError = (value: unknown): value is AcpError => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AcpError>;
  return (
    typeof candidate.reasonCode === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.evidence === "object" &&
    candidate.evidence !== null
  );
};

/** Wire form of a denial. Plain data, so it survives any boundary. */
export interface DenialPayload {
  reasonCode: ReasonCode;
  message: string;
  evidence: Evidence;
}

export const isDenialPayload = (value: unknown): value is DenialPayload => isAcpError(value);

/** Rebuilds a throwable denial from its wire form. */
export const fromErrorPayload = (payload: DenialPayload): AcpError =>
  acpError(payload.reasonCode, payload.message, payload.evidence);

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
