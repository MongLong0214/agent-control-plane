/**
 * The one list of credential shapes ACP recognises. Every consumer reads it from here: the
 * verification sandbox's environment filter (`verify/sandbox.ts`), the audit log's redaction and
 * the artifact store's credential refusal (`db/audit.ts`), and the redaction of verification
 * output kept for review (`verify/verification-engine.ts`).
 *
 * This is a pattern filter. It recognises these shapes and nothing else: text that carries a
 * secret in no listed shape passes it unchanged.
 */

/** Where a shape is looked for. */
export type CredentialScope =
  /** Free text (command output, file content) and whole external values (an environment value). */
  | "text"
  /** ACP's own structured evidence: audit rows and artifact fields. */
  | "evidence";

interface CredentialShape {
  /** Unanchored, so a shape is found inside a line as well as as a whole value. */
  readonly pattern: RegExp;
  /**
   * False only for the bare long-base64 run. ACP's own evidence has that shape by construction --
   * every `sha256:<64 hex>` digest, a staged file's `bodyBase64`, a 64-hex event id -- and audit
   * rows are read back by the gates that wrote them, so redacting or refusing it there would
   * destroy evidence rather than a credential. In text it applies, hex digests included.
   */
  readonly inEvidence: boolean;
}

const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
  { pattern: /gh[pousr]_[A-Za-z0-9]{16,}/, inEvidence: true },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, inEvidence: true },
  { pattern: /\bnsec1[a-z0-9]{20,}/, inEvidence: true },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, inEvidence: true },
  // Any length after the prefix: the sandbox refused every value that starts with one.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]*/, inEvidence: true },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, inEvidence: true },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, inEvidence: true },
  { pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/, inEvidence: true },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, inEvidence: true },
  // A JWT's header and payload, and its signature when one follows.
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/, inEvidence: true },
  // KEY=VALUE where the key looks secret, as it appears in an environment dump.
  { pattern: /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/, inEvidence: true },
  // A run of 60 or more base64 (or hex) characters, inside a line or as a whole value.
  { pattern: /[A-Za-z0-9+/]{60,}={0,2}/, inEvidence: false },
];

export const REDACTED = "[redacted]";

const inScope = (scope: CredentialScope): readonly CredentialShape[] =>
  scope === "text" ? CREDENTIAL_SHAPES : CREDENTIAL_SHAPES.filter((shape) => shape.inEvidence);

const SEARCH: Readonly<Record<CredentialScope, readonly RegExp[]>> = {
  text: inScope("text").map((shape) => shape.pattern),
  evidence: inScope("evidence").map((shape) => shape.pattern),
};

const REPLACE: Readonly<Record<CredentialScope, readonly RegExp[]>> = {
  text: SEARCH.text.map((pattern) => new RegExp(pattern.source, `g${pattern.flags}`)),
  evidence: SEARCH.evidence.map((pattern) => new RegExp(pattern.source, `g${pattern.flags}`)),
};

export const hasCredentialShape = (text: string, scope: CredentialScope): boolean =>
  SEARCH[scope].some((pattern) => pattern.test(text));

/**
 * Every listed shape in scope replaced with `[redacted]`, repeated until none is found: one
 * replacement can complete another shape (a word boundary it lacked). No shape matches the marker,
 * and every match holds characters outside one, so the passes end; the bound is a backstop that
 * redacts the whole text rather than return one with a shape left in it.
 */
export const redactCredentialShapes = (text: string, scope: CredentialScope): string => {
  let out = text;
  for (let pass = 0; pass < 16; pass += 1) {
    if (!hasCredentialShape(out, scope)) return out;
    for (const pattern of REPLACE[scope]) out = out.replace(pattern, REDACTED);
  }
  return hasCredentialShape(out, scope) ? REDACTED : out;
};
