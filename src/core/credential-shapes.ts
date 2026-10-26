/**
 * The one list of credential shapes ACP recognises. Every consumer reads it from here: the
 * verification sandbox's environment filter (`verify/sandbox.ts`), an agent CLI's environment
 * (`runtime/cli-adapters.ts`), the audit log's redaction and the artifact store's credential refusal
 * (`db/audit.ts`), and the redaction of verification output kept for review
 * (`verify/verification-engine.ts`).
 *
 * This is a pattern filter. It recognises these shapes and nothing else: text that carries a
 * secret in no listed shape passes it unchanged.
 */

/** A run of 60 or more base64 (or hex) characters, inside a line or as a whole value. */
const LONG_BASE64_RUN = /[A-Za-z0-9+/]{60,}={0,2}/;

/** Unanchored, so each shape is found inside a line as well as as a whole value. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bnsec1[a-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Any length after the prefix: the sandbox refused every value that starts with one.
  /\bxox[baprs]-[A-Za-z0-9-]*/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  // A JWT's header and payload, and its signature when one follows.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/,
  // KEY=VALUE where the key looks secret, as it appears in an environment dump.
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/,
  LONG_BASE64_RUN,
];

/** Every shape but the long-base64 run: what an ACP-generated field is still checked against. */
const GENERATED_FIELD_SHAPES: readonly RegExp[] = CREDENTIAL_SHAPES.filter((shape) => shape !== LONG_BASE64_RUN);

/** Key paths (property names, array positions left out) at which ACP stores a staged file's bytes. */
const STAGED_BODY_PATHS: ReadonlySet<string> = new Set([
  // A staged bootstrap PLAN or review-evidence candidate (bootstrap/bootstrap-plan-artifact.ts,
  // bootstrap/bootstrap-review-evidence.ts).
  "bodyBase64",
  // The original records a bootstrap review was given (bootstrap/bootstrap-review-evidence.ts).
  "context.originalRecords.files.bodyBase64",
  // A bootstrap PLAN's genesis files (bootstrap/genesis-bundle.ts).
  "genesis.files.contentBase64",
  // The review evidence a bootstrap PLAN froze (bootstrap/bootstrap-review-evidence.ts).
  "reviewEvidence.bundle.files.bodyBase64",
]);

const isCanonicalBase64 = (value: string): boolean =>
  /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.from(value, "base64").toString("base64") === value;

/**
 * ACP's own identifier formats, each exact: the whole value is the id, with nothing around it. A
 * digest, a bare 64-hex id (an event id, signer, public key or hex digest), and the composite ids
 * ACP builds from them. A whitespace-free value that merely contains a 64-hex run (`exposed=<hex>`)
 * is not one of these and gets every shape. A 40-hex commit is shorter than any shape and needs none.
 */
const ACP_ID_FORMATS: readonly RegExp[] = [
  /^sha256:[0-9a-f]{64}$/,
  /^[0-9a-f]{64}$/,
  /^acp-notice(?:-probe)?:[0-9a-f]{64}$/,
  /^(?:repair|rf-write|owner-decision|telegram:owner-decision):sha256:[0-9a-f]{64}$/,
  /^(?:buzz:)?buzz-message:[0-9a-f]{64}(?::[0-9a-f]{64}|#\d+)?$/,
  /^[A-Za-z0-9._-]+:#manifest\/sha256:[0-9a-f]{64}$/,
  /^bootstrap-(?:review-retry|result-recovery):run_[0-9a-f]+:\d+:sha256:[0-9a-f]{64}(?::\d+)?$/,
];

const isAcpId = (value: string): boolean => ACP_ID_FORMATS.some((format) => format.test(value));

/**
 * A value of a field ACP generates, validated by its exact shape, which has the long-base64 shape
 * by construction: a whole `ACP_ID_FORMATS` id, or a staged file's canonical base64 bytes at its
 * known key path. Only these skip the long-base64 shape, and only that one; every other string --
 * free text included, and an id or digest inside it -- is checked against every shape.
 */
export const isAcpGeneratedField = (value: string, path: readonly string[]): boolean =>
  isAcpId(value) || (STAGED_BODY_PATHS.has(path.join(".")) && isCanonicalBase64(value));

/**
 * Key paths at which an evidence string is itself records ACP serialized, read field by field: each
 * field gets the same exact-shape validation as any other evidence field, at its path inside the
 * record. A line or string that is not a JSON record is checked as text, with every shape.
 */
const SERIALIZED_PATHS: ReadonlyMap<string, "jsonl" | "json"> = new Map([
  // The reviewer egress proxy's own log, one record per line, whose START record names the allowlist
  // by an exact `sha256:` digest (runtime/reviewer-egress.ts, review/blind-review.ts).
  ["egress", "jsonl"],
  ["egressEvidence.jsonl", "jsonl"],
  // An activation handoff's recent decisions, each a JSON record; a bootstrap's carries its genesis
  // bundle, staged files included (bootstrap/bootstrap-plan.ts).
  ["handoff.recentDecisions", "json"],
]);

/**
 * Exact ACP-generated tokens inside one free-text audit field, at that field's key path. Only the
 * token is set aside before the field is checked or redacted; the text around it, and any other
 * token, gets every shape. Never a whole field.
 */
const AUDIT_TOKENS: ReadonlyMap<string, RegExp> = new Map([
  // A reason naming the PLAN or candidate it means by an exact digest: "superseded by PLAN sha256:<hex>".
  ["reason", /(?<![A-Za-z0-9+/])sha256:[0-9a-f]{64}(?![A-Za-z0-9+/=])/g],
  // A served daemon's entrypoint path: only the id naming a `generation-<hex>` directory
  // (bootstrap/bootstrap-runtime-observation.ts), never another segment of the path.
  ["resolvedPath", /(?<=\/generation-)(?:[0-9a-f]{64}|[0-9a-f]{40})(?=\/)/g],
]);

/**
 * A field of ACP's own evidence: its key path (property names, array positions left out) and the
 * store it is written to. Free text and external values (an environment value, command output)
 * are checked with no field, against every shape.
 */
export interface EvidenceField {
  readonly path: readonly string[];
  readonly store: "audit" | "artifact";
}

export const REDACTED = "[redacted]";

const shapesFor = (value: string, path: readonly string[] | undefined): readonly RegExp[] =>
  path !== undefined && isAcpGeneratedField(value, path) ? GENERATED_FIELD_SHAPES : CREDENTIAL_SHAPES;

const holdsShape = (text: string, shapes: readonly RegExp[]): boolean => shapes.some((shape) => shape.test(text));

/** Whether a record's keys or values hold a shape, each value validated as an evidence field at its path. */
const recordHoldsShape = (value: unknown, depth: number, path: readonly string[]): boolean => {
  if (typeof value === "string") return holdsShape(value, shapesFor(value, path));
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => recordHoldsShape(item, depth + 1, path));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) =>
      holdsShape(key, CREDENTIAL_SHAPES) || recordHoldsShape(nested, depth + 1, [...path, key]));
  }
  return false;
};

const serializedHoldsShape = (text: string): boolean => {
  let record: unknown;
  try { record = JSON.parse(text); } catch { return holdsShape(text, CREDENTIAL_SHAPES); }
  return record !== null && typeof record === "object" ? recordHoldsShape(record, 0, []) : holdsShape(text, CREDENTIAL_SHAPES);
};

/** Private-use marks around an index stand in for a set-aside token; text that has them already sets nothing aside. */
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const MARKED = /\uE000(\d+)\uE001/g;

const setAside = (text: string, tokens: RegExp | undefined): { text: string; tokens: string[] } => {
  if (tokens === undefined || text.includes(MARK_OPEN) || text.includes(MARK_CLOSE)) return { text, tokens: [] };
  const kept: string[] = [];
  return { text: text.replace(tokens, (token) => `${MARK_OPEN}${kept.push(token) - 1}${MARK_CLOSE}`), tokens: kept };
};

const putBack = (text: string, tokens: readonly string[]): string =>
  tokens.length === 0 ? text : text.replace(MARKED, (mark, index: string) => tokens[Number(index)] ?? mark);

const tokensFor = (field: EvidenceField | undefined): RegExp | undefined =>
  field?.store === "audit" ? AUDIT_TOKENS.get(field.path.join(".")) : undefined;

const serializedKind = (field: EvidenceField | undefined): "jsonl" | "json" | undefined =>
  field === undefined ? undefined : SERIALIZED_PATHS.get(field.path.join("."));

/**
 * Evidence fields defined as repository-relative file paths, per store, by key path. Only these
 * take the per-segment rule below. Fields that also carry prose or other values (a review's
 * `omittedItems`, a contract's `scope`, an audit `path`, `targetPath`, `claimedPath` or `uncovered`)
 * are not listed and are read whole, as free text.
 */
const REPOSITORY_PATH_FIELDS: Readonly<Record<EvidenceField["store"], ReadonlySet<string>>> = {
  artifact: new Set([
    "repositories.touchedPaths", // CANDIDATE_SNAPSHOT
    "coveredFiles", // BLIND_REVIEW coverage keys, `<identity>:<path>`
    "findings.path", // BLIND_REVIEW finding location
    "inputManifest.binaryArtifacts.path", // BLIND_REVIEW
    "contractChange.workflowEvidence.path", // CONTRACT_CHANGE workflow files
    "contractChange.workflowRevisions.path",
    "workflowRevisions.path",
    "genesis.files.path", // bootstrap PLAN
    "projectManifest.ciWorkflows.path",
    "projectManifest.gateEntries.path",
    "reviewEvidence.bundle.files.path",
    "context.originalRecords.files.path", // bootstrap review context (HANDOFF)
    "context.originalRecords.files.verification.facts.path",
  ]),
  audit: new Set([
    "paths", // a worker turn's owned, changed or dirty paths; a check's workflow files
    "declared.paths",
    "writeTarget.paths",
    "ignoredChanges.paths",
    "workflow.path",
    "workflows.path",
    "refusal.evidence.workflow.path",
  ]),
};

/**
 * The one rule for repository-relative paths: whether `text`, at `field`, is read as a path, whose
 * shapes are then found per `/`-separated segment rather than across the whole string. A path such
 * as `src/main/java/org/apache/.../ObjectArrayIterator.java` is one long run of the base64 alphabet,
 * `/` included, while no segment of it is; a segment that is itself a shape is still found. Every
 * other field, free text included, is read whole. This is a credential filter only: the validators
 * that refuse absolute paths, `..` and control characters are separate and unchanged.
 */
const isRepositoryPath = (text: string, field: EvidenceField | undefined): boolean =>
  // A whole-value ACP id there (`<project>:#manifest/sha256:<hex>`) keeps the id rule it has today.
  field !== undefined && REPOSITORY_PATH_FIELDS[field.store].has(field.path.join(".")) && !isAcpId(text);

const segmentsHoldShape = (text: string): boolean => text.split("/").some((segment) => holdsShape(segment, CREDENTIAL_SHAPES));

const GLOBAL = new Map(CREDENTIAL_SHAPES.map((shape) => [shape, new RegExp(shape.source, `g${shape.flags}`)]));

/**
 * Whether `text` holds a listed shape. `field` is given only for a field of ACP's own evidence: it
 * lets `isAcpGeneratedField` values, such fields inside the records at a `SERIALIZED_PATHS` path,
 * and an `AUDIT_TOKENS` token inside its audit field, skip the long-base64 shape, and reads a
 * `REPOSITORY_PATH_FIELDS` path per segment.
 */
export const hasCredentialShape = (text: string, field?: EvidenceField): boolean => {
  const kind = serializedKind(field);
  if (kind === "jsonl") return text.split("\n").some(serializedHoldsShape);
  if (kind === "json") return serializedHoldsShape(text);
  if (isRepositoryPath(text, field)) return segmentsHoldShape(text);
  const aside = setAside(text, tokensFor(field));
  return holdsShape(aside.text, shapesFor(text, field?.path));
};

const redactWith = (text: string, shapes: readonly RegExp[]): string => {
  let out = text;
  for (let pass = 0; pass < 16; pass += 1) {
    if (!holdsShape(out, shapes)) return out;
    for (const shape of shapes) out = out.replace(GLOBAL.get(shape)!, REDACTED);
  }
  return holdsShape(out, shapes) ? REDACTED : out;
};

const redactSegments = (text: string): string => text.split("/").map((segment) => redactWith(segment, CREDENTIAL_SHAPES)).join("/");

/**
 * Every listed shape replaced with `[redacted]`, repeated until none is found: one replacement can
 * complete another shape (a word boundary it lacked). No shape matches the marker, and every match
 * holds characters outside one, so the passes end; the bound is a backstop that redacts the whole
 * text rather than return one with a shape left in it. A serialized record that holds a shape is
 * redacted as text, with every shape; a set-aside audit token is put back only where it survived;
 * a repository path is redacted segment by segment.
 */
export const redactCredentialShapes = (text: string, field?: EvidenceField): string => {
  const kind = serializedKind(field);
  const asRecord = (record: string): string => (serializedHoldsShape(record) ? redactWith(record, CREDENTIAL_SHAPES) : record);
  if (kind === "jsonl") return text.split("\n").map(asRecord).join("\n");
  if (kind === "json") return asRecord(text);
  if (isRepositoryPath(text, field)) return redactSegments(text);
  const aside = setAside(text, tokensFor(field));
  return putBack(redactWith(aside.text, shapesFor(text, field?.path)), aside.tokens);
};

/**
 * Every string inside `value` (keys and values, at any depth) with its listed shapes redacted, for
 * text ACP derives from an outside answer before it stores it: a reviewer's findings, API facts.
 * `at` is where `value` will sit in the stored evidence: a `REPOSITORY_PATH_FIELDS` path inside it
 * is redacted per segment, and every other string is read whole as free text. Whether anything was
 * replaced is returned so the caller can mark the removal.
 */
export const redactCredentialValues = <T>(value: T, at: EvidenceField): { value: T; redacted: boolean } => {
  let redacted = false;
  const walk = (node: unknown, depth: number, path: readonly string[]): unknown => {
    if (typeof node === "string") {
      const out = isRepositoryPath(node, { path, store: at.store }) ? redactSegments(node) : redactCredentialShapes(node);
      if (out !== node) redacted = true;
      return out;
    }
    if (depth > 16) {
      redacted = true;
      return REDACTED;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1, path));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, nested]) =>
        [walk(key, depth + 1, []) as string, walk(nested, depth + 1, [...path, key])]));
    }
    return node;
  };
  const out = walk(value, 0, at.path) as T;
  return { value: redacted ? out : value, redacted };
};

/** Characters a listed shape is made of, apart from the spaces some allow between parts. */
const CREDENTIAL_ALPHABET = /[A-Za-z0-9+/=_.:-]/;

/**
 * Text cut at a byte limit with the rest unseen: the trailing run of credential-alphabet characters
 * at the cut can be the start of a shape the filter cannot see whole, so it is withheld. Scanned
 * back from the end rather than matched with `$`, which backtracks across a long run.
 */
export const withholdCutFragment = (text: string): { text: string; withheld: number } => {
  let start = text.length;
  while (start > 0 && CREDENTIAL_ALPHABET.test(text[start - 1]!)) start -= 1;
  return { text: text.slice(0, start), withheld: text.length - start };
};
