import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sha256 } from "./digest.ts";
import { attemptCheckoutPath, githubLedgerPath, repositoryCheckoutPath } from "./repo-factory-paths.ts";
import { residentBootPacket, residentClonePath, residentPrivateKeyFile, residentSessionSocket } from "./resident-allocation-paths.ts";

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
  // `acp-restore-challenge:` is a canonical CTO restore challenge (daemon/agentcpd.ts restoreChallengeId).
  /^(?:repair|rf-write|owner-decision|telegram:owner-decision|acp-restore-challenge):sha256:[0-9a-f]{64}$/,
  // A Buzz message's sequence number is a count, bounded.
  /^(?:buzz:)?buzz-message:[0-9a-f]{64}(?::[0-9a-f]{64}|#\d{1,9})?$/,
  // The project id is the one part a caller names: it is captured and checked against every shape.
  /^(?<free>[A-Za-z0-9._-]+):#manifest\/sha256:[0-9a-f]{64}$/,
  // A run id is exactly what `mint` in core/ids.ts makes (`run_` and 24 hex); generation and event
  // id are counts, bounded (runtime/provisioned-session-runtime.ts).
  /^bootstrap-(?:review-retry|result-recovery):run_[0-9a-f]{24}:\d{1,9}:sha256:[0-9a-f]{64}(?::\d{1,9})?$/,
  // A production gate check's external id (github/github-kernel.ts gateExternalId): run id, snapshot
  // digest, payload digest.
  /^acp:run_[0-9a-f]{24}:sha256:[0-9a-f]{64}:sha256:[0-9a-f]{64}$/,
];

/** A whole value in one of `ACP_ID_FORMATS`, whose caller-named part holds no shape of its own. */
const isAcpId = (value: string): boolean =>
  ACP_ID_FORMATS.some((format) => {
    const match = format.exec(value);
    const free = match?.groups?.["free"];
    return match !== null && (free === undefined || !CREDENTIAL_SHAPES.some((shape) => shape.test(free)));
  });

/**
 * A value of a field ACP generates, validated by its exact shape, which has the long-base64 shape
 * by construction: a whole `ACP_ID_FORMATS` id, or a staged file's canonical base64 bytes at its
 * known key path. Only these skip the long-base64 shape, and only that one; every other string --
 * free text included, and an id or digest inside it -- is checked against every shape, except that
 * a digest or id in it that names a record the store holds skips the long-base64 shape (`isBoundRun`).
 */
export const isAcpGeneratedField = (value: string, path: readonly string[]): boolean =>
  isAcpId(value) || (STAGED_BODY_PATHS.has(path.join(".")) && isCanonicalBase64(value));

/**
 * #1254 G-2 — free-text and reviewer fields, per store, by key path (the path and every path under it):
 * a blind reviewer's omitted items, findings and covered files, and the audit copy of its omitted items;
 * #1279 G3-1 — and a CEO's rationale, wherever an audit record carries it (ceo/production-gate.ts:
 * CEO_DECISION, the RUN_TRANSITION it makes, MANIFEST_ACTIVATION_CONSUMER_BOUND).
 * Their text is the reviewer's or the CEO's, so a whole value there is never an ACP id by its format: a
 * digest or 64-hex id in such a field, whole or inside text, skips the long-base64 shape only when it
 * names a record the store holds. Every other field keeps the whole-value id rule, the fields typed as
 * digests in the same records (`candidateSnapshotDigest`, `inputManifest.reviewerPromptDigests`) included,
 * except at a `FREE_TEXT_WRITERS` writer, where only its typed fields do.
 */
const FREE_TEXT_FIELDS: Readonly<Record<EvidenceField["store"], readonly string[]>> = {
  artifact: ["omittedItems", "findings", "coveredFiles"],
  audit: ["omittedItems", "rationale"],
};

/** The writer `mcp/shared.ts` names when it checks a refusal a mutation handler threw before storing it. */
export const MCP_THROWN_REFUSAL_WRITER = "MCP_THROWN_REFUSAL";

/**
 * #1279 G3-1 — writers whose fields are free text except the ones their schema types as an ACP digest or
 * id, by `<store>:<writer>`, each with those typed key paths (array positions left out). Only a typed
 * path keeps the whole-value id rule, and a staged body's; every other field of the writer -- a CTO's or
 * CEO's prose, and any field none of the writer's records has -- is free text, where a whole digest or
 * 64-hex id is exempt from the long-base64 shape only when it names a record the store holds. A typed
 * path is a field's full key path in that writer's records, never a field name alone.
 */
const FREE_TEXT_WRITERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // A run's task contract (`run_create`, run/run-engine.ts TaskContract) types no field, its `references` included.
  ["artifact:TASK_CONTRACT", new Set<string>()],
  // A thrown refusal's message and evidence (mcp/shared.ts) type no field: a refusal names what it was handed.
  [`artifact:${MCP_THROWN_REFUSAL_WRITER}`, new Set<string>()],
  // A PLAN (mcp/cto-server.ts submitPlan): the digests plan_submit checks or ACP computes and adds
  // (bootstrap/plan-input-schema.ts, bootstrap/bootstrap-plan.ts planForSubmission, the carried manifest
  // and genesis bundle, bootstrap/bootstrap-review-evidence.ts, bootstrap/bootstrap-ceo-decisions.ts).
  // Its summary, risks, repository and verification intents and the rest of its prose are free text.
  ["artifact:PLAN", new Set([
    "bootstrapPlanDigest", "projectManifestDigest", "requestDigest", "genesisDigest",
    "workflowRevisions.fileDigest",
    "projectManifest.ciWorkflows.approvedDigest", "projectManifest.gateEntries.digest",
    "genesis.files.sha256", "genesis.files.contentBase64",
    "reviewEvidence.digest", "reviewEvidence.source.bootstrapPlanDigest", "reviewEvidence.source.bundleSha256",
    "reviewEvidence.source.candidateDigest", "reviewEvidence.source.attachmentDigest",
    "reviewEvidence.bundle.contractDigest", "reviewEvidence.bundle.files.sha256",
    "reviewEvidence.bundle.files.excerpt.originalSha256", "reviewEvidence.bundle.files.bodyBase64",
    "authenticatedCeoDecisions.digest", "authenticatedCeoDecisions.resolutionDigest",
    "authenticatedCeoDecisions.source.actorId", "authenticatedCeoDecisions.source.payloadDigest",
    "authenticatedCeoDecisions.source.contractDigest", "authenticatedCeoDecisions.source.bootstrapPlanDigest",
    "authenticatedCeoDecisions.source.attachmentDigest",
  ])],
  // A HANDOFF, by the records ACP writes as one: a staged or attached bootstrap PLAN input and review
  // evidence (bootstrap/bootstrap-plan-artifact.ts, bootstrap/bootstrap-review-evidence.ts), a bootstrap
  // review's context (review/blind-review.ts), an activation's handoff (bootstrap/activation.ts) and a
  // contract change's readback or its refusal (review/contract-change-review-context.ts). The activation
  // handoff's status, blockers, queued work, risks and next action are the CTO's prose, free text.
  ["artifact:HANDOFF", new Set([
    "sha256", "replacesSha256", "contractDigest", "bootstrapPlanDigest", "candidateDigest", "bodyBase64",
    "candidateSnapshotDigest", "planDigest",
    "context.deployment.runtimeSha256", "context.deployment.entrypointSha256", "context.deployment.lifecycleDigest",
    "context.originalRecords.bundleDigest", "context.originalRecords.source.bootstrapPlanDigest",
    "context.originalRecords.source.bundleSha256", "context.originalRecords.source.candidateDigest",
    "context.originalRecords.source.attachmentDigest", "context.originalRecords.files.sha256",
    "context.originalRecords.files.excerpt.originalSha256", "context.originalRecords.files.bodyBase64",
    "handoff.activeManifestDigest",
    "project.activeManifestDigest", "project.registrations.activeManifestDigest",
    "workflowRevisions.fileDigest", "workflowRevisions.read.observedDigest",
    // Git object ids ACP read, 64-hex in a SHA-256 repository, and the CTO's stated head of each repository.
    "repositories.lastObservedHead", "repositories.checkout.head", "repositories.checkout.acceptedHead",
    "workflowRevisions.read.blobSha", "handoff.repositoryFacts.head",
  ])],
]);

const isFreeText = (field: EvidenceField | undefined): boolean => {
  if (field === undefined) return false;
  const path = field.path.join(".");
  const typed = field.site === undefined ? undefined : FREE_TEXT_WRITERS.get(`${field.store}:${field.site.writer}`);
  if (typed !== undefined && !typed.has(path)) return true;
  return FREE_TEXT_FIELDS[field.store].some((root) => path === root || path.startsWith(`${root}.`));
};

/** A whole ACP id at a field whose schema makes it one: never at a free-text, reviewer or CEO field. */
const isWholeAcpId = (text: string, field: EvidenceField | undefined): boolean => !isFreeText(field) && isAcpId(text);

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

/** Locations ACP computed from its own configuration for the store a record is written to. */
export interface AcpLocations {
  /** The state directory, `dirname(databasePath)`: it holds each resident session's socket. */
  readonly stateRoot?: string | null;
  /** The resident home a resident project's clone, key file and boot packet are allocated under. */
  readonly residentHome?: string | null;
  /** The repo-factory work root: `<workRoot>/<runId>` holds a run's checkout and GitHub ledger. */
  readonly repoFactoryWorkRoot?: string | null;
  /** The serving daemon's own entrypoint, resolved once by the daemon at startup (daemon/agentcpd.ts). */
  readonly servingEntrypoint?: string | null;
}

/**
 * Facts ACP already stored, read by the store itself from its own database (db/registry-view.ts):
 * never a value the caller of `put` or `record` hands over. Paths are canonical.
 */
export interface RegistryView {
  /** Whether the registry records exactly this identity at exactly this checkout. */
  records(identity: string, checkoutPath: string): boolean;
  /** The same, for a repository registered for the run: its project's, or the run's own temporary one. */
  recordsForRun(runId: string, identity: string, checkoutPath: string): boolean;
  /** The checkouts the registry records for an identity. */
  checkoutsOf(identity: string): readonly string[];
  /** The run's verification trees of a repository, which the verification engine made (verification_worktrees). */
  runWorktrees(runId: string, identity: string): readonly string[];
  /**
   * Whether `token`, a `sha256:<64hex>` digest or a bare 64-hex id, names a record the store already
   * holds, by a digest ACP itself computed or observed (db/registry-view.ts): for `sha256:`, a digest of
   * one of the run's own records (an artifact, a frozen candidate and what it binds, the manifest a PLAN
   * carries, its contract or pin, its project's active manifest, a workflow's bytes ACP read) or a stored
   * manifest; for bare hex, the same digest's hex or a Buzz event the store accepted. A digest a PLAN
   * only declares is none of these.
   */
  boundReference?(runId: string | null, token: string): boolean;
}

/** Where a record is being written: the facts a verified location's contract is checked against. */
export interface WriteSite {
  /** The artifact kind or audit event kind being written: which ACP code path wrote the value. */
  readonly writer: string;
  /** The run the record is filed under: an artifact's run, an audit event's `runId`. */
  readonly runId?: string | null;
  /** Trusted configuration the store was constructed with. */
  readonly locations?: AcpLocations;
  /** Facts the store reads from its own database. */
  readonly registry?: RegistryView;
  /** The whole record being written: a contract reads facts elsewhere in it (an allocation's repository). */
  readonly record?: unknown;
}

/**
 * A field of ACP's own evidence: its key path (property names, array positions left out) and the
 * store it is written to. Free text and external values (an environment value, command output)
 * are checked with no field, against every shape.
 */
export interface EvidenceField {
  readonly path: readonly string[];
  readonly store: "audit" | "artifact";
  readonly site?: WriteSite;
  /** The object that holds the value: a location contract reads the value's sibling fields there. */
  readonly holder?: unknown;
}

export const REDACTED = "[redacted]";

const shapesFor = (value: string, field: EvidenceField | undefined): readonly RegExp[] =>
  field !== undefined && !isFreeText(field) && isAcpGeneratedField(value, field.path) ? GENERATED_FIELD_SHAPES : CREDENTIAL_SHAPES;

/** Whether a string names a record the store holds (`RegistryView.boundReference`), or nothing when no store is asked. */
type BoundTest = ((token: string) => boolean) | undefined;

const LONG_BASE64_RUNS = new RegExp(LONG_BASE64_RUN.source, "g");
const HEX64_RUN = /^[0-9a-f]{64}$/;
const DIGEST_PREFIX = "sha256:";
const BASE64_CHARACTER = /[A-Za-z0-9+/]/;

/**
 * #1254 G-1 — whether a long-base64 run, found at `at` in `text`, is exactly the hex of a digest or 64-hex
 * id standing on its own there (`sha256:<hex>` or bare `<hex>`, nothing of the long-base64 alphabet on
 * either side) that names a record the store holds. Such a run is exempt from the long-base64 shape and
 * from nothing else: every other shape is found in the text as written, the reference included, so
 * `ghp_<a bound digest's hex>` is still a GitHub token. A run is maximal, so the alphabet never touches it.
 */
const isBoundRun = (text: string, at: number, run: string, bound: BoundTest): boolean => {
  if (bound === undefined || !HEX64_RUN.test(run)) return false;
  const prefix = at - DIGEST_PREFIX.length;
  const prefixed = prefix >= 0 && text.startsWith(DIGEST_PREFIX, prefix) && !BASE64_CHARACTER.test(text.charAt(prefix - 1));
  return bound(prefixed ? `${DIGEST_PREFIX}${run}` : run);
};

const holdsShape = (text: string, shapes: readonly RegExp[], bound?: BoundTest): boolean =>
  shapes.some((shape) => (shape === LONG_BASE64_RUN && bound !== undefined
    ? [...text.matchAll(LONG_BASE64_RUNS)].some((match) => !isBoundRun(text, match.index, match[0], bound))
    : shape.test(text)));

/**
 * Whether a record's keys or values hold a shape, each value checked by the same field rules as the
 * object it was serialized from, at its path inside the record (a repository path per segment).
 */
const recordHoldsShape = (value: unknown, depth: number, field: EvidenceField): boolean => {
  if (typeof value === "string") return fieldHoldsShape(value, field);
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => recordHoldsShape(item, depth + 1, field));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) =>
      holdsShape(key, CREDENTIAL_SHAPES) || recordHoldsShape(nested, depth + 1, { ...field, path: [...field.path, key] }));
  }
  return false;
};

const serializedHoldsShape = (text: string, store: EvidenceField["store"]): boolean => {
  let record: unknown;
  try { record = JSON.parse(text); } catch { return holdsShape(text, CREDENTIAL_SHAPES); }
  return record !== null && typeof record === "object" ? recordHoldsShape(record, 0, { path: [], store }) : holdsShape(text, CREDENTIAL_SHAPES);
};

/** Private-use marks around an index stand in for a set-aside token; text that has them already sets nothing aside. */
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const MARKED = /\uE000(\d+)\uE001/g;

/**
 * The bound-reference test for a field written at a site whose store can read its own records: a
 * digest or id in any text there skips the long-base64 shape only when it names a record the store
 * holds (`RegistryView.boundReference`), never for its shape alone (`isBoundRun`). Without such a site,
 * nothing does.
 */
const boundReferenceOf = (field: EvidenceField | undefined): BoundTest => {
  const registry = field?.site?.registry;
  if (registry?.boundReference === undefined) return undefined;
  const runId = field?.site?.runId ?? null;
  return (token) => registry.boundReference!(runId, token);
};

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
    "repositories.imports.path", // CANDIDATE_SNAPSHOT, #1232
    "repositories.refusedImports.path",
    "coveredFiles", // BLIND_REVIEW coverage keys, `<identity>:<path>`
    "extraClaims", // BLIND_REVIEW claims outside the assigned items, same `<identity>:<path>` shape (#1259)
    "findings.path", // BLIND_REVIEW finding location
    "methodFindings.path", // BLIND_REVIEW method finding location (#1271)
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
    // #1232 — a task's import manifest: in its recorded write target, as declared, and in its receipt.
    "declared.imports.path",
    "writeTarget.imports.path",
    "imports.path",
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
  // A whole-value ACP id there (`<project>:#manifest/sha256:<hex>`) keeps the id rule it has today,
  // except at a free-text or reviewer field, where it is a path like any other (`FREE_TEXT_FIELDS`).
  field !== undefined && !isWholeAcpId(text, field) && REPOSITORY_PATH_FIELDS[field.store].has(field.path.join("."));

/** Whether a value is the location its writer's contract makes: given the value, its field and write site. */
type LocationContract = (text: string, field: EvidenceField) => boolean;

const sibling = (field: EvidenceField, key: string): unknown =>
  field.holder !== null && typeof field.holder === "object" && !Array.isArray(field.holder)
    ? (field.holder as Readonly<Record<string, unknown>>)[key] : undefined;

const member = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>)[key] : undefined;

/** A `local:` identity's path, or null. */
const localPath = (text: string): string | null => (text.startsWith("local:") ? text.slice("local:".length) : null);

/**
 * A path resident-project-provisioning.ts allocates, built by the same function from the root
 * control-plane.ts computes (the state directory or the resident home) and the allocation's own
 * `projectId`, which sits beside it. Only exactly that path is it; with no root known, nothing is.
 * The comparison is of the location alone: no file is read.
 */
const allocatedPath = (
  root: "stateRoot" | "residentHome", build: (root: string, projectId: string) => string,
): LocationContract => (text, field) => {
  const known = field.site?.locations?.[root];
  const projectId = sibling(field, "projectId");
  return typeof known === "string" && typeof projectId === "string" && text === build(known, projectId);
};

/**
 * The allocation's clone (resident-project-provisioning.ts): `residentClonePath` of the resident home
 * control-plane.ts computes and the allocation's repository. A host observation's checkout and the
 * resident's cwd are accepted only when they equal it, so the same contract binds them.
 */
const allocatedClone: LocationContract = (text, field) => {
  const home = field.site?.locations?.residentHome;
  const repositoryIdentity = member(member(member(field.site?.record, "provisioning"), "allocation"), "repositoryIdentity");
  return typeof home === "string" && typeof repositoryIdentity === "string" && /^[^/]+\/[^/]+$/.test(repositoryIdentity)
    && text === residentClonePath(home, repositoryIdentity);
};

const PATH_SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;
/** A repository role as repo-factory-producer.ts admits it: kebab-case. */
const REPOSITORY_ROLE = /^[a-z0-9][a-z0-9-]*$/;

/** The run's work directory, `join(workRoot, runId)`, for the run the record is filed under; or null. */
const runWorkDir = (field: EvidenceField): string | null => {
  const workRoot = field.site?.locations?.repoFactoryWorkRoot;
  const runId = field.site?.runId;
  return typeof workRoot === "string" && typeof runId === "string" && PATH_SAFE_RUN_ID.test(runId) ? join(workRoot, runId) : null;
};

/** `githubLedgerPath(join(workRoot, runId), role)` for a kebab-case role. With no work root or run known, nothing is. */
const runLedger: LocationContract = (text, field) => {
  const workDir = runWorkDir(field);
  const role = basename(text, ".json");
  return workDir !== null && REPOSITORY_ROLE.test(role) && text === githubLedgerPath(workDir, role);
};

/**
 * The producer's checkout for the result's own `role`, beside it: `repositoryCheckoutPath` or an
 * attempt's `attemptCheckoutPath` under the run's work directory, `join(workRoot, runId)`, from the
 * configured work root and the run the result is filed under. Once activation registered the binding,
 * the registry's stored record of the result's identity at exactly this checkout is it too.
 */
const factoryCheckout: LocationContract = (text, field) => {
  const identity = sibling(field, "identity");
  if (typeof identity === "string" && field.site?.registry?.records(identity, text) === true) return true;
  const workDir = runWorkDir(field);
  const role = sibling(field, "role");
  if (workDir === null || typeof role !== "string" || !REPOSITORY_ROLE.test(role)) return false;
  if (text === repositoryCheckoutPath(workDir, role)) return true;
  const attempt = /\.attempt-(\d{1,9})$/.exec(text);
  return attempt !== null && text === attemptCheckoutPath(workDir, role, Number(attempt[1]));
};

/**
 * bootstrap-runtime-observation.ts records the served entrypoint's canonical path beside the digest
 * of its bytes, `entrypointSha256`. It is exactly the entrypoint the daemon resolved for itself at
 * startup and the store was constructed with, compared as a string, and the file there still has
 * that digest. With no such entrypoint configured, nothing is.
 */
const observedEntrypoint: LocationContract = (text, field) => {
  const entrypoint = field.site?.locations?.servingEntrypoint;
  const digest = sibling(field, "entrypointSha256");
  if (typeof entrypoint !== "string" || text !== entrypoint || typeof digest !== "string") return false;
  try { return sha256(readFileSync(text)) === digest; } catch { return false; }
};

/** An activation's local binding (activation.ts): the registry's record of that identity at that checkout. */
const registeredBindingCheckout: LocationContract = (text, field) => {
  const identity = sibling(field, "identity");
  return typeof identity === "string" && field.site?.registry?.records(identity, text) === true;
};

/** A local binding's `local:` identity: `local:` and the checkout beside it, as the registry records the pair. */
const registeredBindingIdentity: LocationContract = (text, field) => {
  const checkoutPath = sibling(field, "checkoutPath");
  return typeof checkoutPath === "string" && localPath(text) === checkoutPath
    && field.site?.registry?.records(text, checkoutPath) === true;
};

/** A `local:` identity of a repository the registry records for the run, at exactly the checkout it names. */
const runRepositoryIdentity: LocationContract = (text, field) => {
  const checkoutPath = localPath(text);
  const runId = field.site?.runId;
  return checkoutPath !== null && typeof runId === "string" && field.site?.registry?.recordsForRun(runId, text, checkoutPath) === true;
};

/**
 * A registration's checkout (repository-registry.ts writes the row before its audit record): the
 * canonical toplevel the registry stored for the identity beside it.
 */
const storedRegistrationCheckout: LocationContract = (text, field) => {
  const identity = sibling(field, "identity");
  return typeof identity === "string" && field.site?.registry?.records(identity, text) === true;
};

/** A registration's `local:` identity: `local:` and the checkout beside it, as the registry stored the pair. */
const storedRegistrationIdentity: LocationContract = (text, field) => {
  const checkoutPath = sibling(field, "checkoutPath");
  return typeof checkoutPath === "string" && localPath(text) === checkoutPath
    && field.site?.registry?.records(text, checkoutPath) === true;
};

/**
 * The roots a consumed grant may reach, read from the store's own database for the grant's
 * repository and run, and only ones ACP itself made or registered: the registry's checkouts of that
 * repository and the run's verification trees of it. A task execution's worktree is a path the
 * caller supplied (`task_receipt_submit`) and is never a root; a runtime-managed worker's worktree is
 * the registered checkout, which is one.
 */
const grantRoots = (field: EvidenceField): readonly string[] => {
  const registry = field.site?.registry;
  const identity = member(field.site?.record, "repositoryIdentity");
  if (registry === undefined || typeof identity !== "string") return [];
  const runId = field.site?.runId;
  return [...registry.checkoutsOf(identity), ...(typeof runId === "string" ? registry.runWorktrees(runId, identity) : [])]
    .filter((root) => root.startsWith("/"));
};

/**
 * Inside a stored root of the grant: the root string itself or a normalized path under it at a `/`
 * boundary, compared as strings only. Nothing is resolved on the filesystem at check time, so a
 * symlink placed at a stored root later does not carry the exemption to where it points.
 */
const insideGrantRoot: LocationContract = (text, field) =>
  text.startsWith("/") && resolve(text) === text
  && grantRoots(field).some((root) => text === root || text.startsWith(root.endsWith("/") ? root : `${root}/`));

/** A grant's `local:` repository identity: the registry stores that identity at exactly that checkout. */
const storedLocalIdentity: LocationContract = (text, field) => {
  const path = localPath(text);
  return path !== null && field.site?.registry?.records(text, path) === true;
};

/**
 * Locations that ACP code itself made or checked, by the writer that stores them and the exact
 * field, each with the contract its value must meet: a location ACP itself knows, from the trusted
 * configuration the store was constructed with and facts the store reads from its own database, never
 * from the caller of `put` or `record`, and never the value's shape and its writer alone. Only a value that meets its contract is read per
 * segment. A temp directory's random segments can join `/` into a long base64-alphabet run
 * (`/private/var/folders/nj/vtw8zd2j31d1gdrtntc5y4600000gn/T/acp` is 60 such characters on a CI
 * runner) while no segment is one. A field of the same name from any other writer, a value that does
 * not meet its contract, and every other field, is read whole.
 */
const VERIFIED_LOCATIONS: ReadonlyMap<string, ReadonlyMap<string, LocationContract>> = new Map([
  ["artifact:REPO_FACTORY_RESULT", new Map([["repositories.proposedCheckoutPath", factoryCheckout]])],
  ["artifact:BOOTSTRAP_ACTIVATION_RESULT", new Map([
    ["localBindings.checkoutPath", registeredBindingCheckout], ["localBindings.identity", registeredBindingIdentity],
    ["provisioning.allocation.clonePath", allocatedClone],
    ["provisioning.observations.checkout.path", allocatedClone], ["provisioning.observations.resident.cwd", allocatedClone],
    ["provisioning.allocation.socketPath", allocatedPath("stateRoot", residentSessionSocket)],
    ["provisioning.allocation.privateKeyFile", allocatedPath("residentHome", residentPrivateKeyFile)],
    ["provisioning.allocation.bootPacket", allocatedPath("residentHome", residentBootPacket)],
  ])],
  ["artifact:CANDIDATE_SNAPSHOT", new Map([["repositories.identity", runRepositoryIdentity]])],
  ["artifact:VERIFICATION", new Map([["results.repositoryIdentity", runRepositoryIdentity], ["results.output.repositoryIdentity", runRepositoryIdentity]])],
  // doctor/repair.ts: a reservation release's preconditions name the ledger the run's attempts wrote.
  ["artifact:REPAIR_RECEIPT", new Map([["preconditionsChecked.evidence.ledgerPath", runLedger]])],
  ["audit:REPOSITORY_REGISTERED", new Map([["checkoutPath", storedRegistrationCheckout], ["identity", storedRegistrationIdentity]])],
  ["audit:REPOSITORY_TEMPORARY_BINDING", new Map([["checkoutPath", storedRegistrationCheckout], ["identity", storedRegistrationIdentity]])],
  ["audit:MANAGED_WRITE_GUARD_CONSUMED", new Map([
    ["resolvedPath", insideGrantRoot], ["targetWorktreeId", insideGrantRoot], ["repositoryIdentity", storedLocalIdentity],
  ])],
  ["audit:REPAIR_REFUSED", new Map([["preconditions.evidence.ledgerPath", runLedger]])],
  ["audit:DAEMON_RUNTIME_OBSERVED", new Map([["resolvedPath", observedEntrypoint]])],
]);

const isVerifiedLocation = (text: string, field: EvidenceField | undefined): boolean => {
  if (field?.site === undefined || isAcpId(text)) return false;
  const contract = VERIFIED_LOCATIONS.get(`${field.store}:${field.site.writer}`)?.get(field.path.join("."));
  return contract !== undefined && contract(text, field);
};

const segmentsHoldShape = (text: string, bound: BoundTest): boolean =>
  text.split("/").some((segment) => holdsShape(segment, CREDENTIAL_SHAPES, bound));

const GLOBAL = new Map(CREDENTIAL_SHAPES.map((shape) => [shape, new RegExp(shape.source, `g${shape.flags}`)]));

/**
 * Whether `text` holds a listed shape. `field` is given only for a field of ACP's own evidence: it
 * lets `isAcpGeneratedField` values, such fields inside the records at a `SERIALIZED_PATHS` path,
 * and an `AUDIT_TOKENS` token inside its audit field, skip the long-base64 shape, and reads a
 * `REPOSITORY_PATH_FIELDS` path, and a value that meets its `VERIFIED_LOCATIONS` contract, per segment.
 * Given a write site whose store reads its own records, a digest or id anywhere in the text that names
 * one of them skips the long-base64 shape too, and only it; the text around it, the reference itself
 * for every other shape, and any digest the store does not hold, get every shape. At a free-text or
 * reviewer field (`FREE_TEXT_FIELDS`, and every field but a typed one of a `FREE_TEXT_WRITERS` writer) a
 * whole ACP id is not exempt by its format, only as such a bound reference.
 */
export const hasCredentialShape = (text: string, field?: EvidenceField): boolean => {
  const kind = serializedKind(field);
  if (field !== undefined && kind === "jsonl") return text.split("\n").some((line) => serializedHoldsShape(line, field.store));
  if (field !== undefined && kind === "json") return serializedHoldsShape(text, field.store);
  return fieldHoldsShape(text, field);
};

/**
 * One field's string, not serialized records: a repository path per segment, else the whole value,
 * and a verified location per segment. A segment's shape is always also the whole value's, so the
 * location's contract is checked only for a value whose whole holds a shape.
 */
const fieldHoldsShape = (text: string, field: EvidenceField | undefined): boolean => {
  const aside = setAside(text, tokensFor(field));
  const bound = boundReferenceOf(field);
  if (isRepositoryPath(text, field)) return segmentsHoldShape(aside.text, bound);
  if (!holdsShape(aside.text, shapesFor(text, field), bound)) return false;
  return !isVerifiedLocation(text, field) || segmentsHoldShape(aside.text, bound);
};

/** A long-base64 run replaced with `[redacted]`, unless it is a bound reference's hex (`isBoundRun`). */
const redactRuns = (text: string, bound: BoundTest): string =>
  text.replace(LONG_BASE64_RUNS, (run: string, at: number, whole: string) => (isBoundRun(whole, at, run, bound) ? run : REDACTED));

const redactWith = (text: string, shapes: readonly RegExp[], bound?: BoundTest): string => {
  let out = text;
  for (let pass = 0; pass < 16; pass += 1) {
    if (!holdsShape(out, shapes, bound)) return out;
    for (const shape of shapes) {
      out = shape === LONG_BASE64_RUN && bound !== undefined ? redactRuns(out, bound) : out.replace(GLOBAL.get(shape)!, REDACTED);
    }
  }
  return holdsShape(out, shapes, bound) ? REDACTED : out;
};

const redactSegments = (text: string, bound?: BoundTest): string =>
  text.split("/").map((segment) => redactWith(segment, CREDENTIAL_SHAPES, bound)).join("/");

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
  const asRecord = (record: string): string =>
    (field !== undefined && serializedHoldsShape(record, field.store) ? redactWith(record, CREDENTIAL_SHAPES) : record);
  if (kind === "jsonl") return text.split("\n").map(asRecord).join("\n");
  if (kind === "json") return asRecord(text);
  const aside = setAside(text, tokensFor(field));
  const bound = boundReferenceOf(field);
  const shapes = shapesFor(text, field);
  const perSegment = isRepositoryPath(text, field) || (holdsShape(aside.text, shapes, bound) && isVerifiedLocation(text, field));
  return putBack(perSegment ? redactSegments(aside.text, bound) : redactWith(aside.text, shapes, bound), aside.tokens);
};

/**
 * Every string inside `value` (keys and values, at any depth) with its listed shapes redacted, for
 * text ACP derives from an outside answer before it stores it: a reviewer's findings, API facts.
 * `at` is where `value` will sit in the stored evidence: a `REPOSITORY_PATH_FIELDS` path inside it
 * is redacted per segment, and every other string is read whole as free text, where a digest or id
 * that names a record the store holds (`at.site`) is kept from the long-base64 shape alone. Whether
 * anything was replaced is returned so the caller can mark the removal.
 */
export const redactCredentialValues = <T>(value: T, at: EvidenceField): { value: T; redacted: boolean } => {
  let redacted = false;
  const bound = boundReferenceOf(at);
  const walk = (node: unknown, depth: number, path: readonly string[]): unknown => {
    if (typeof node === "string") {
      const out = isRepositoryPath(node, { path, store: at.store }) ? redactSegments(node, bound) : redactWith(node, CREDENTIAL_SHAPES, bound);
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

/**
 * The character classes the listed shapes match with (`[...]`, `\S`, `\d`, `\w`), read from the
 * shapes themselves, so a character any shape accepts is in the cut alphabet below and no second
 * list can drift from them.
 */
const SHAPE_CLASSES: readonly RegExp[] = CREDENTIAL_SHAPES.flatMap((shape) =>
  (shape.source.match(/\[(?:\\.|[^\]\\])*\]|\\[dDwWS]/g) ?? []).map((part) => new RegExp(part, shape.flags)));

const inCutAlphabet = new Map<string, boolean>();

/**
 * A character a shape can be made of: one that some shape's class accepts. Whitespace, which a few
 * shapes allow only between their parts (`Bearer <token>`, `KEY = value`), ends the run.
 */
const shapeCharacter = (char: string): boolean => {
  let known = inCutAlphabet.get(char);
  if (known === undefined) {
    known = !/\s/.test(char) && SHAPE_CLASSES.some((part) => part.test(char));
    inCutAlphabet.set(char, known);
  }
  return known;
};

/**
 * Text cut at a byte limit with the rest unseen: the trailing run of characters a shape can be made
 * of can be the start of a shape the filter cannot see whole, so it is withheld. Scanned back from
 * the end rather than matched with `$`, which backtracks across a long run.
 */
export const withholdCutFragment = (text: string): { text: string; withheld: number } => {
  let start = text.length;
  while (start > 0 && shapeCharacter(text[start - 1]!)) start -= 1;
  return { text: text.slice(0, start), withheld: text.length - start };
};
