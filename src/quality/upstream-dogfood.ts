import { z } from "zod";

import { COMMITLORE_OBSERVATION_ARGV, type CommitLoreObservation } from "../bootstrap/commitlore-observation.ts";
import { type Clock, isoPlus, systemClock } from "../core/clock.ts";
import { hasCredentialShape, redactCredentialShapes } from "../core/credential-shapes.ts";
import { canonicalJson, sha256Hex } from "../core/digest.ts";
import { type Decision, acpError, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import { publicTextRefusals } from "../github/branch-publish.ts";
import { type GitHubClient, transportOutcome } from "../github/github-kernel.ts";
import { FRONTIER_SIMPLIFY_DIGEST } from "../review/frontier-simplify-policy.ts";

/**
 * #1271 — what ACP finds while it uses CommitLore or frontier-simplify goes to that product's own issue
 * tracker, once, and is read back there; nothing found is dropped without a recorded reason.
 *
 * The unit is a finding, recorded before anyone has decided it is a bug. Each record ends in exactly one
 * of: NOT_REPORTED with its reason (a normal refusal, caller misuse, the environment, an undetermined
 * cause, or text that cannot be shown safe to publish), LINKED to an issue or comment that was read back
 * in the target repository, or UNPUBLISHED with its reason after a bounded number of passes. Until then it
 * is QUEUED, or IN_DOUBT once a write may have been sent.
 *
 * - The target repository is a function of the product and nothing else: `UPSTREAM_REPOSITORIES` is the
 *   whole list, and no text or URL in a finding can name another. The GitHub port refuses any other.
 * - The public payload is built before the record is stored, from scrubbed fields; the raw evidence is
 *   never stored here. What stays private is a reference to where the original already lives.
 * - A duplicate is the same product, kind, producer signature, reproduction and expected behaviour,
 *   after scrubbing. Error text and product revision are not part of it: they only decide whether an
 *   observation is new evidence for an issue that already exists.
 * - Every pass reads the target repository for this finding's correlation token before it writes, so a
 *   restart, a retry or a response lost after GitHub accepted the write links what is there instead of
 *   writing it again. The write intent is stored before the write.
 *
 * - A frontier-simplify finding is accepted only from the check that produced it: a `method` finding in a
 *   BLIND_REVIEW artifact the blind-review gate stored, bound to that review's candidate, contract and
 *   reviewer session. Nothing a caller declares on its own is recorded for frontier-simplify. A method
 *   finding never weighs on the candidate: the review keeps it apart from the candidate's findings.
 *
 * Storage is the state database's audit log, append-only: one `UPSTREAM_DOGFOOD_FINDING` row per finding
 * (its initial state included) and one `UPSTREAM_DOGFOOD_STATE` row per later state. The current state
 * is the newest of those. The outbox carries Buzz envelopes and `github_receipts` admits a fixed set of
 * run-scoped operations; neither is reused for this, and nothing here changes the schema.
 *
 * Publishing is off unless a publisher is given: without one the reporter sends nothing and moves no
 * record, so findings accumulate QUEUED.
 */

export const UPSTREAM_REPOSITORIES = Object.freeze({
  commitlore: "MongLong0214/commitlore",
  "frontier-simplify": "MongLong0214/frontier-simplify",
} as const);

export type DogfoodProduct = keyof typeof UPSTREAM_REPOSITORIES;

const PRODUCTS = Object.keys(UPSTREAM_REPOSITORIES) as [DogfoodProduct, ...DogfoodProduct[]];
const UPSTREAM_SET: ReadonlySet<string> = new Set(Object.values(UPSTREAM_REPOSITORIES));

/** Refuses every repository but the two upstream trackers, before anything is sent. */
export const assertUpstreamRepository = (repository: string): void => {
  if (!UPSTREAM_SET.has(repository)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "only the CommitLore and frontier-simplify trackers receive dogfood reports", {
      repository,
    });
  }
};

const text = (max: number) => z.string().trim().min(1).max(max);

export const dogfoodFindingSchema = z
  .object({
    product: z.enum(PRODUCTS),
    kind: z.enum(["defect", "improvement"]),
    /** For a defect: what the producer established about its cause. Only `product` is reported. */
    cause: z.enum(["product", "normal_refusal", "caller_misuse", "environment", "undetermined"]),
    /** Seen happen, or reasoned to. The issue says which. */
    basis: z.enum(["observed", "inferred"]),
    reproduced: z.boolean(),
    /** The producer's stable name for the cause; the core of the duplicate key. */
    signature: z.string().regex(/^[a-z0-9][a-z0-9.:_-]{2,119}$/),
    /** The boundary that produced the finding. */
    source: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,79}$/),
    /** Where the original evidence already lives. Kept private; never published. */
    privateEvidenceRef: z.string().min(1).max(200),
    title: text(200),
    /** The problem, or for an improvement the use case and what is inconvenient now. */
    problem: text(2000),
    expected: text(2000),
    actual: text(2000),
    /** Steps, or the boundary at which it did not reproduce. */
    reproduction: text(2000),
    productRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/),
    impact: text(2000),
    workaround: text(2000),
    evidence: z.string().max(2000).optional(),
    /** The other product's side of a finding that spans both (`splitAcrossProducts`). */
    related: z.object({ product: z.enum(PRODUCTS), key: z.string().regex(/^[0-9a-f]{24}$/) }).strict().optional(),
  })
  .strict();

export type DogfoodFindingInput = z.input<typeof dogfoodFindingSchema>;
type DogfoodFinding = z.output<typeof dogfoodFindingSchema>;

// ---------------------------------------------------------------------------
// Public text
// ---------------------------------------------------------------------------

const PATH_END = "[^\\s`'\"<>)\\]]*";
/**
 * Every absolute path: home-relative, drive-rooted, or rooted at `/` anywhere but inside a URL or a
 * relative path. Each is private unless `PUBLIC_PATHS` names it.
 */
const LOCAL_PATH = new RegExp(
  `(?:~|\\$\\{?HOME\\}?)\\/${PATH_END}|(?<![A-Za-z0-9._~:/\\\\-])\\/[A-Za-z0-9._~-]${PATH_END}|\\b[A-Za-z]:\\\\${PATH_END}`,
  "g",
);
/** The only absolute paths that name nothing about a machine or its owner. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);
const isPublicPath = (path: string): boolean => PUBLIC_PATHS.has(path.replace(/[.,;:!?]+$/, ""));
const hasPrivatePath = (value: string): boolean => [...value.matchAll(LOCAL_PATH)].some(([path]) => !isPublicPath(path));
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SESSION_ID = /\b(?:ses|sess|session)_[A-Za-z0-9]{8,}/g;
const RUN_ID = /\brun_[0-9a-f]{24}\b/g;
const MENTION = /(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*)/g;

/** Credentials, private paths, addresses and run or session ids replaced. */
export const scrubPublicText = (value: string): string =>
  redactCredentialShapes(value)
    .replace(LOCAL_PATH, (path) => (isPublicPath(path) ? path : "<local-path>"))
    .replace(EMAIL, "<email>")
    .replace(UUID, "<id>")
    .replace(SESSION_ID, "<id>")
    .replace(RUN_ID, "<run>");

/** A mention in prose notifies someone upstream; as code it does not. Evidence is fenced already. */
const inertMentions = (value: string): string => value.replace(MENTION, "$1`@$2`");

/** The publication scan's rules, the credential shapes and the private-path rule all find nothing. */
export const isPublicSafe = (value: string): boolean =>
  publicTextRefusals(value).length === 0 && !hasCredentialShape(value) && !hasPrivatePath(value);

const SUMMARY_FIELDS = ["title", "problem", "expected", "actual", "reproduction", "impact", "workaround"] as const;
type SummaryField = (typeof SUMMARY_FIELDS)[number];

export interface DogfoodPublic {
  fields: Record<SummaryField, string>;
  /** Published only when it needed no scrubbing at all; otherwise withheld and only named as withheld. */
  evidence: string | null;
  evidenceWithheld: boolean;
}

const publicPayload = (finding: DogfoodFinding): { payload: DogfoodPublic; unsafe: SummaryField[] } => {
  const fields = Object.fromEntries(
    SUMMARY_FIELDS.map((field) => [field, inertMentions(scrubPublicText(field === "title" ? finding.title.replace(/\s+/g, " ") : finding[field])).slice(0, 2000)]),
  ) as Record<SummaryField, string>;
  const unsafe = SUMMARY_FIELDS.filter((field) => !isPublicSafe(fields[field]));
  let evidence: string | null = null;
  let evidenceWithheld = false;
  if (finding.evidence !== undefined && finding.evidence.trim() !== "") {
    const scrubbed = scrubPublicText(finding.evidence);
    if (scrubbed === finding.evidence && isPublicSafe(scrubbed)) evidence = scrubbed;
    else evidenceWithheld = true;
  }
  return { payload: { fields, evidence, evidenceWithheld }, unsafe };
};

const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The duplicate key: product, kind, signature, and the scrubbed reproduction and expected behaviour. A
 * local path or run id in the reproduction is scrubbed first, so two projects meeting one defect agree.
 */
export const findingKey = (input: DogfoodFindingInput): string => {
  const finding = dogfoodFindingSchema.parse(input);
  return sha256Hex(
    canonicalJson({
      product: finding.product,
      kind: finding.kind,
      signature: finding.signature,
      reproduction: normalise(scrubPublicText(finding.reproduction)),
      expected: normalise(scrubPublicText(finding.expected)),
    }),
  ).slice(0, 24);
};

const keyToken = (key: string): string => `acpdogfood${key}`;
const evidenceToken = (evidenceKey: string): string => `acpevidence${evidenceKey}`;
const revisionLine = (revision: string): string => `Product revision: \`${revision}\``;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const DOGFOOD_FINDING_KIND = "UPSTREAM_DOGFOOD_FINDING";
export const DOGFOOD_STATE_KIND = "UPSTREAM_DOGFOOD_STATE";

/** The refusal of a frontier-simplify finding that does not come from the stored review that performed the check. */
export const FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND = "FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND";

export type NotReportedReason = "NORMAL_REFUSAL" | "CALLER_MISUSE" | "ENVIRONMENT" | "CAUSE_UNDETERMINED" | "NOT_PUBLIC_SAFE";
export type LinkAction = "created" | "commented" | "regression" | "existing";

export type DogfoodState =
  | { status: "NOT_REPORTED"; reason: NotReportedReason; at: string }
  | { status: "QUEUED"; attempts: number; nextAttemptAt: string; lastError: string | null }
  | { status: "IN_DOUBT"; attempts: number; nextAttemptAt: string; lastError: string | null; since: string }
  | { status: "LINKED"; attempts: number; url: string; issueNumber: number; commentId: number | null; action: LinkAction; readAt: string }
  | { status: "UNPUBLISHED"; attempts: number; reason: string; lastError: string | null; at: string };

/** What ACP bound a frontier-simplify finding to: the stored review whose reviewer performed the check. */
export interface ReviewBinding {
  runId: string;
  artifactId: string;
  candidateSnapshotDigest: string;
  contractDigest: string;
  reviewerSessionId: string;
  findingIndex: number;
}

export interface DogfoodRecord {
  id: string;
  key: string;
  evidenceKey: string;
  product: DogfoodProduct;
  kind: DogfoodFinding["kind"];
  basis: DogfoodFinding["basis"];
  reproduced: boolean;
  source: string;
  revision: string;
  recordedAt: string;
  /** Never published. */
  privateEvidenceRef: string;
  public: DogfoodPublic;
  related: { product: DogfoodProduct; key: string } | null;
  binding: ReviewBinding | null;
  state: DogfoodState;
}

const stateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NOT_REPORTED"), reason: z.enum(["NORMAL_REFUSAL", "CALLER_MISUSE", "ENVIRONMENT", "CAUSE_UNDETERMINED", "NOT_PUBLIC_SAFE"]), at: z.string() }).strict(),
  z.object({ status: z.literal("QUEUED"), attempts: z.number().int().min(0), nextAttemptAt: z.string(), lastError: z.string().nullable() }).strict(),
  z.object({ status: z.literal("IN_DOUBT"), attempts: z.number().int().min(1), nextAttemptAt: z.string(), lastError: z.string().nullable(), since: z.string() }).strict(),
  z.object({ status: z.literal("LINKED"), attempts: z.number().int().min(0), url: z.string(), issueNumber: z.number().int().positive(), commentId: z.number().int().positive().nullable(), action: z.enum(["created", "commented", "regression", "existing"]), readAt: z.string() }).strict(),
  z.object({ status: z.literal("UNPUBLISHED"), attempts: z.number().int().min(0), reason: z.string(), lastError: z.string().nullable(), at: z.string() }).strict(),
]);

const bindingSchema = z
  .object({
    runId: z.string(),
    artifactId: z.string(),
    candidateSnapshotDigest: z.string(),
    contractDigest: z.string(),
    reviewerSessionId: z.string(),
    findingIndex: z.number().int().min(0),
  })
  .strict();

/**
 * A finding as its audit row carries it. The audit log redacts any field whose name ends in "key", so
 * the duplicate key is stored as `correlation` and the evidence key as `observationId`.
 */
const storedFindingSchema = z
  .object({
    findingId: z.string().regex(/^[0-9a-f]{24}-[0-9a-f]{16}$/),
    correlation: z.string().regex(/^[0-9a-f]{24}$/),
    observationId: z.string().regex(/^[0-9a-f]{16}$/),
    product: z.enum(PRODUCTS),
    kind: z.enum(["defect", "improvement"]),
    basis: z.enum(["observed", "inferred"]),
    reproduced: z.boolean(),
    source: z.string(),
    revision: z.string(),
    privateEvidenceRef: z.string(),
    ...(Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, z.string()])) as Record<SummaryField, z.ZodString>),
    evidence: z.string().nullable(),
    evidenceWithheld: z.boolean(),
    related: z.object({ product: z.enum(PRODUCTS), correlation: z.string() }).strict().nullable(),
    binding: bindingSchema.nullable(),
    state: stateSchema,
  })
  .strict();

const storedStateSchema = z.object({ findingId: z.string(), state: stateSchema }).strict();

const toEvidence = (record: DogfoodRecord): Record<string, unknown> => ({
  findingId: record.id,
  correlation: record.key,
  observationId: record.evidenceKey,
  product: record.product,
  kind: record.kind,
  basis: record.basis,
  reproduced: record.reproduced,
  source: record.source,
  revision: record.revision,
  privateEvidenceRef: record.privateEvidenceRef,
  ...record.public.fields,
  evidence: record.public.evidence,
  evidenceWithheld: record.public.evidenceWithheld,
  related: record.related === null ? null : { product: record.related.product, correlation: record.related.key },
  binding: record.binding,
  state: record.state,
});

const fromEvidence = (at: string, evidenceJson: string): DogfoodRecord | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(evidenceJson);
  } catch {
    return null;
  }
  const parsed = storedFindingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const stored = parsed.data;
  return {
    id: stored.findingId,
    key: stored.correlation,
    evidenceKey: stored.observationId,
    product: stored.product,
    kind: stored.kind,
    basis: stored.basis,
    reproduced: stored.reproduced,
    source: stored.source,
    revision: stored.revision,
    recordedAt: at,
    privateEvidenceRef: stored.privateEvidenceRef,
    public: {
      fields: Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, stored[field]])) as Record<SummaryField, string>,
      evidence: stored.evidence,
      evidenceWithheld: stored.evidenceWithheld,
    },
    related: stored.related === null ? null : { product: stored.related.product, key: stored.related.correlation },
    binding: stored.binding,
    state: stored.state as DogfoodState,
  };
};

/** What makes a defect's cause reported (null) or not, and why. */
const DEFECT_CAUSE_REASON: Readonly<Record<DogfoodFinding["cause"], NotReportedReason | null>> = {
  product: null,
  normal_refusal: "NORMAL_REFUSAL",
  caller_misuse: "CALLER_MISUSE",
  environment: "ENVIRONMENT",
  undetermined: "CAUSE_UNDETERMINED",
};

/** Why a finding is not reported, or null when it is reportable. An improvement has no cause to weigh. */
const triage = (finding: DogfoodFinding, unsafe: readonly SummaryField[]): NotReportedReason | null => {
  if (unsafe.length > 0) return "NOT_PUBLIC_SAFE";
  return finding.kind === "improvement" ? null : DEFECT_CAUSE_REASON[finding.cause];
};

/** The part of a stored BLIND_REVIEW packet a method finding is read from; the gate wrote all of it. */
const reviewPacketSchema = z
  .object({
    runId: z.string(),
    candidateSnapshotDigest: z.string(),
    contractDigest: z.string(),
    reviewerSessionId: z.string().min(1),
    methodFindings: z
      .array(z.object({ category: z.literal("method"), severity: z.string(), summary: z.string(), detail: z.string() }).passthrough())
      .default([]),
  })
  .passthrough();

/** A stored review the gate wrote, read for its method findings. */
type BoundReview = { artifactId: string; packet: z.output<typeof reviewPacketSchema> };

const FRONTIER_SIMPLIFY_REVISION = FRONTIER_SIMPLIFY_DIGEST.replace(/^sha256:/, "").slice(0, 12);

/**
 * A reviewer's `method` finding as a frontier-simplify finding. The reviewer's envelope carries a summary
 * and a detail only; what it does not state is said to be unstated, never filled in.
 */
const reviewMethodFinding = (
  finding: { severity: string; summary: string; detail: string },
  privateEvidenceRef: string,
): DogfoodFindingInput => {
  const summary = finding.summary.trim() || "frontier-simplify review method finding";
  return {
    product: "frontier-simplify",
    kind: finding.severity === "MAJOR" || finding.severity === "BLOCKER" ? "defect" : "improvement",
    cause: "product",
    basis: "observed",
    reproduced: false,
    signature: `review-method.${sha256Hex(normalise(summary)).slice(0, 16)}`,
    source: "blind-review.method-finding",
    privateEvidenceRef,
    title: summary.slice(0, 200),
    problem: (finding.detail.trim() || summary).slice(0, 2000),
    expected: "Not stated separately by the reviewer; the problem above names the gap.",
    actual: summary.slice(0, 2000),
    reproduction: "Seen by an independent reviewer applying frontier-simplify to one candidate review; not reproduced.",
    productRevision: FRONTIER_SIMPLIFY_REVISION,
    impact: "Not assessed by the reviewer.",
    workaround: "None stated.",
  };
};

export interface DogfoodStoreDeps {
  db: Pick<Db, "tx" | "all">;
  audit: Pick<AuditLog, "record">;
  artifacts: Pick<ArtifactStore, "list">;
  clock?: Clock;
}

/** Where a finding came from, as the audit row names it. */
export interface DogfoodOrigin {
  runId?: string | null;
  actor: string;
}

/** The durable finding store, on the state database's append-only audit log. */
export class DogfoodFindingStore {
  readonly #deps: DogfoodStoreDeps;
  readonly #clock: Clock;

  constructor(deps: DogfoodStoreDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Records a CommitLore finding, idempotently: the same finding with the same public evidence is one
   * record, so a restart, a retry or a second project meeting it adds nothing. A frontier-simplify
   * finding is refused here: it is accepted only through `recordReviewMethodFindings` and
   * `recordAcrossProducts`, bound to the stored review. A finding recorded again whose cause is now
   * established as the product's releases a record kept back only for its cause. Never throws: a
   * failure to record is a refusal, never the outcome of the work that found it.
   */
  record(input: unknown, origin: DogfoodOrigin): Decision<DogfoodRecord> {
    const parsed = dogfoodFindingSchema.safeParse(input);
    if (!parsed.success) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the finding is not a dogfood finding this store records", {
        fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "<root>"))],
      });
    }
    if (parsed.data.product === "frontier-simplify") {
      return deny(
        ReasonCode.VERIFICATION_GAP,
        "a frontier-simplify finding is accepted only as a method finding of the stored review that performed the check",
        { refusal: FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND },
      );
    }
    return this.#store(parsed.data, null, origin);
  }

  /**
   * The frontier-simplify findings of one stored review: each `method` finding its reviewer returned,
   * bound to the review's run, candidate, contract and reviewer session. Refused unless the artifact is a
   * BLIND_REVIEW the blind-review gate stored for that run and candidate. A review with no method finding
   * records nothing; no other statement about frontier-simplify is ever recorded.
   */
  recordReviewMethodFindings(runId: string, artifactId: string): Decision<DogfoodRecord[]> {
    const review = this.#boundReview(runId, artifactId);
    if (!review.allowed) return review as Decision<never>;
    const recorded: DogfoodRecord[] = [];
    let refused = 0;
    review.value.packet.methodFindings.forEach((_, findingIndex) => {
      const stored = this.#storeMethodFinding(review.value, findingIndex);
      if (stored.allowed) recorded.push(stored.value);
      else refused += 1;
    });
    return allow(ReasonCode.OK, recorded, { refused });
  }

  /**
   * A stored review's method finding that is CommitLore's too, split so each tracker gets its own side
   * (`splitAcrossProducts`): the frontier-simplify side is the review's own record of that finding, the
   * CommitLore side the caller's statement of CommitLore's part, and each names the other. Both are bound
   * to the review; refused, like `recordReviewMethodFindings`, unless the gate stored it.
   */
  recordAcrossProducts(
    review: { runId: string; artifactId: string; findingIndex: number },
    commitlore: { signature: string; expected: string; productRevision: string },
    origin: DogfoodOrigin,
  ): Decision<[DogfoodRecord, DogfoodRecord]> {
    const bound = this.#boundReview(review.runId, review.artifactId);
    if (!bound.allowed) return bound as Decision<never>;
    if (bound.value.packet.methodFindings[review.findingIndex] === undefined) {
      return this.#unbound(review.runId, review.artifactId, "the review has no method finding at that index") as Decision<never>;
    }
    const own = this.#methodFindingInput(bound.value, review.findingIndex);
    const { product: _product, signature, expected, productRevision, related: _related, ...shared } = own;
    let halves: [DogfoodFindingInput, DogfoodFindingInput];
    try {
      halves = splitAcrossProducts(shared, [
        { product: "frontier-simplify", signature, expected, productRevision },
        { product: "commitlore", ...commitlore },
      ]);
    } catch (error) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the finding could not be split", { message: (error as Error).message.slice(0, 300) });
    }
    const binding = this.#binding(bound.value, review.findingIndex);
    const sides = halves.map((half) => dogfoodFindingSchema.safeParse(half));
    if (!sides[0]!.success || !sides[1]!.success) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the CommitLore side is not a dogfood finding this store records", {});
    }
    const methodSide = this.#store(sides[0]!.data, binding, { runId: review.runId, actor: "blind-review-gate" });
    if (!methodSide.allowed) return methodSide as Decision<never>;
    const commitloreSide = this.#store(sides[1]!.data, binding, origin);
    if (!commitloreSide.allowed) return commitloreSide as Decision<never>;
    return allow(ReasonCode.OK, [methodSide.value, commitloreSide.value]);
  }

  #unbound(runId: string, artifactId: string, why: string): Decision<never> {
    return deny(ReasonCode.VERIFICATION_GAP, `the review's method findings cannot be bound: ${why}`, {
      refusal: FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND,
      runId,
      artifactId,
    });
  }

  /** The BLIND_REVIEW the blind-review gate stored for this run and candidate, or the refusal to bind to it. */
  #boundReview(runId: string, artifactId: string): Decision<BoundReview> {
    let artifacts: ReturnType<ArtifactStore["list"]>;
    try {
      artifacts = this.#deps.artifacts.list(runId, ArtifactKind.BLIND_REVIEW);
    } catch {
      return this.#unbound(runId, artifactId, "the run's reviews could not be read");
    }
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (artifact === undefined) return this.#unbound(runId, artifactId, "no stored review of this run has that id");
    if (artifact.producedBy !== "blind-review-gate" || artifact.candidateSnapshotDigest === null) {
      return this.#unbound(runId, artifactId, "the artifact is not a review the blind-review gate stored");
    }
    const packet = reviewPacketSchema.safeParse(artifact.content);
    if (!packet.success || packet.data.runId !== runId || packet.data.candidateSnapshotDigest !== artifact.candidateSnapshotDigest) {
      return this.#unbound(runId, artifactId, "the stored review does not name this run and candidate");
    }
    return allow(ReasonCode.OK, { artifactId: artifact.artifactId, packet: packet.data });
  }

  #binding(review: BoundReview, findingIndex: number): ReviewBinding {
    return {
      runId: review.packet.runId,
      artifactId: review.artifactId,
      candidateSnapshotDigest: review.packet.candidateSnapshotDigest,
      contractDigest: review.packet.contractDigest,
      reviewerSessionId: review.packet.reviewerSessionId,
      findingIndex,
    };
  }

  #methodFindingInput(review: BoundReview, findingIndex: number): DogfoodFindingInput {
    return reviewMethodFinding(review.packet.methodFindings[findingIndex]!, `blind review ${review.artifactId}, method finding ${findingIndex}`);
  }

  #storeMethodFinding(review: BoundReview, findingIndex: number): Decision<DogfoodRecord> {
    const input = dogfoodFindingSchema.safeParse(this.#methodFindingInput(review, findingIndex));
    if (!input.success) return deny(ReasonCode.INVALID_ARGUMENT, "the method finding is not a dogfood finding this store records", {});
    return this.#store(input.data, this.#binding(review, findingIndex), { runId: review.packet.runId, actor: "blind-review-gate" });
  }

  #store(finding: DogfoodFinding, binding: ReviewBinding | null, origin: DogfoodOrigin): Decision<DogfoodRecord> {
    try {
      const key = findingKey(finding);
      const { payload, unsafe } = publicPayload(finding);
      const evidenceKey = sha256Hex(
        canonicalJson({
          key,
          revision: finding.productRevision,
          problem: normalise(payload.fields.problem),
          actual: normalise(payload.fields.actual),
          evidence: payload.evidence,
          withheld: payload.evidenceWithheld,
        }),
      ).slice(0, 16);
      const id = `${key}-${evidenceKey}`;
      return this.#deps.db.tx(() => {
        const existing = this.get(id);
        const now = this.#clock.nowIso();
        const reason = triage(finding, unsafe);
        if (existing !== null) {
          // A cause established since (undetermined, then product) releases what was kept back for its cause.
          const held = existing.state.status === "NOT_REPORTED" && existing.state.reason !== "NOT_PUBLIC_SAFE";
          if (!held || reason !== null) return allow(ReasonCode.OK, existing, { replayed: true });
          const released = this.transition(existing, { status: "QUEUED", attempts: 0, nextAttemptAt: now, lastError: null }, origin.actor);
          return allow(ReasonCode.OK, released, { replayed: true, released: true });
        }
        const record: DogfoodRecord = {
          id,
          key,
          evidenceKey,
          product: finding.product,
          kind: finding.kind,
          basis: finding.basis,
          reproduced: finding.reproduced,
          source: finding.source,
          revision: finding.productRevision,
          recordedAt: now,
          privateEvidenceRef: finding.privateEvidenceRef,
          public: payload,
          related: finding.related ?? null,
          binding,
          state:
            reason === null
              ? { status: "QUEUED", attempts: 0, nextAttemptAt: now, lastError: null }
              : { status: "NOT_REPORTED", reason, at: now },
        };
        this.#append({ kind: DOGFOOD_FINDING_KIND, runId: origin.runId ?? null, actor: origin.actor, evidence: toEvidence(record) });
        return allow(ReasonCode.OK, record, { replayed: false, ...(unsafe.length > 0 ? { unsafeFields: unsafe } : {}) });
      });
    } catch (error) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the finding could not be recorded", { message: (error as Error).message.slice(0, 300) });
    }
  }

  get(id: string): DogfoodRecord | null {
    const row = this.#deps.db.all<{ at: string; evidence_json: string }>(
      `SELECT at, evidence_json FROM audit_events WHERE kind = ? AND json_extract(evidence_json, '$.findingId') = ? ORDER BY event_id LIMIT 1`,
      [DOGFOOD_FINDING_KIND, id],
    )[0];
    if (row === undefined) return null;
    const record = fromEvidence(row.at, row.evidence_json);
    if (record === null) throw acpError(ReasonCode.INVALID_ARGUMENT, "a dogfood record is unreadable", { id });
    const latest = this.#deps.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = ? AND json_extract(evidence_json, '$.findingId') = ? ORDER BY event_id DESC LIMIT 1`,
      [DOGFOOD_STATE_KIND, id],
    )[0];
    if (latest === undefined) return record;
    const state = storedStateSchema.safeParse(JSON.parse(latest.evidence_json));
    if (!state.success) throw acpError(ReasonCode.INVALID_ARGUMENT, "a dogfood state is unreadable", { id });
    return { ...record, state: state.data.state as DogfoodState };
  }

  /** Every record, and the audit rows that are not readable records: named, never skipped in silence. */
  list(): { records: DogfoodRecord[]; unreadable: string[] } {
    const records: DogfoodRecord[] = [];
    const unreadable: string[] = [];
    const findings = this.#deps.db.all<{ event_id: number; at: string; evidence_json: string }>(
      `SELECT event_id, at, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`,
      [DOGFOOD_FINDING_KIND],
    );
    const latest = new Map<string, DogfoodState>();
    for (const row of this.#deps.db.all<{ event_id: number; evidence_json: string }>(
      `SELECT event_id, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`,
      [DOGFOOD_STATE_KIND],
    )) {
      let parsed: ReturnType<typeof storedStateSchema.safeParse>;
      try {
        parsed = storedStateSchema.safeParse(JSON.parse(row.evidence_json));
      } catch {
        unreadable.push(`audit:${row.event_id}`);
        continue;
      }
      if (parsed.success) latest.set(parsed.data.findingId, parsed.data.state as DogfoodState);
      else unreadable.push(`audit:${row.event_id}`);
    }
    const seen = new Set<string>();
    for (const row of findings) {
      const record = fromEvidence(row.at, row.evidence_json);
      if (record === null) {
        unreadable.push(`audit:${row.event_id}`);
        continue;
      }
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push({ ...record, state: latest.get(record.id) ?? record.state });
    }
    return { records, unreadable };
  }

  /** Moves a record from the state it was read in; a record that moved meanwhile is left alone. */
  transition(record: DogfoodRecord, state: DogfoodState, actor = "upstream-dogfood-reporter"): DogfoodRecord {
    return this.#deps.db.tx(() => {
      const current = this.get(record.id);
      if (current === null || canonicalJson(current.state) !== canonicalJson(record.state)) {
        throw acpError(ReasonCode.INVALID_ARGUMENT, "the dogfood record changed under this transition", { id: record.id });
      }
      this.#append({ kind: DOGFOOD_STATE_KIND, runId: current.binding?.runId ?? null, actor, evidence: { findingId: record.id, state } });
      return { ...current, state };
    });
  }

  #append(entry: { kind: string; runId: string | null; actor: string; evidence: Record<string, unknown> }): void {
    const written = this.#deps.audit.record(entry);
    if (!written.allowed) throw acpError(written.reasonCode, written.message, written.evidence);
  }
}

/**
 * A finding that spans both products, split so each tracker gets its own side: the shared observation,
 * each product's own responsibility, and each side naming the other's key so the issues cross-link.
 */
export const splitAcrossProducts = (
  shared: Omit<DogfoodFindingInput, "product" | "signature" | "expected" | "productRevision" | "related">,
  sides: readonly [
    { product: DogfoodProduct; signature: string; expected: string; productRevision: string },
    { product: DogfoodProduct; signature: string; expected: string; productRevision: string },
  ],
): [DogfoodFindingInput, DogfoodFindingInput] => {
  if (sides[0].product === sides[1].product) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "a cross-product finding names two different products", {});
  }
  const [first, second] = sides.map((side) => ({ ...shared, ...side })) as [DogfoodFindingInput, DogfoodFindingInput];
  return [
    { ...first, related: { product: second.product, key: findingKey(second) } },
    { ...second, related: { product: first.product, key: findingKey(first) } },
  ];
};

// ---------------------------------------------------------------------------
// Producer bridge: a judged CommitLore observation
// ---------------------------------------------------------------------------

const COMMITLORE_REPRODUCTION =
  `In a freshly initialised git repository, run ${COMMITLORE_OBSERVATION_ARGV.map((argv) => `\`commitlore ${argv.join(" ")}\``).join(", then ")}.`;

/**
 * The finding a failed CommitLore observation is, by the judge's own failure text: a doctor report that
 * contradicts its exit code, or one that is not a `commitlore_doctor.v2` report, is a product defect;
 * a doctor that exits non-zero on a repository it finds unhealthy is a normal refusal; a CLI that could
 * not be run is the environment; an `init` that failed is undetermined. A PASS is no finding.
 */
export const commitloreObservationFinding = (
  observation: CommitLoreObservation,
  context: { productRevision: string; privateEvidenceRef: string },
): DogfoodFindingInput | null => {
  if (observation.outcome === "PASS") return null;
  const detail = observation.detail;
  const base = {
    product: "commitlore" as const,
    kind: "defect" as const,
    basis: "observed" as const,
    reproduced: false,
    source: "repo-factory.commitlore-observation",
    privateEvidenceRef: context.privateEvidenceRef,
    productRevision: context.productRevision,
    actual: detail,
    reproduction: COMMITLORE_REPRODUCTION,
    impact: "A caller that trusts the exit code or the report alone reads a failing repository as healthy, or the reverse.",
    workaround: "Callers judge the exit code and the report together and refuse when they disagree.",
  };
  const contradiction = /^commitlore doctor (.+) while the process exited 0$/.exec(detail);
  if (contradiction) {
    return {
      ...base,
      cause: "product",
      signature: "doctor.report-contradicts-exit-code",
      title: "doctor --json reports a failure while the process exits 0",
      problem: "The doctor's JSON report and its exit code disagree about whether the repository passed.",
      expected: "`commitlore doctor --json` exits non-zero whenever its report says the repository failed (status failed, a failing check, or a non-zero exitCode field).",
    };
  }
  const invalid = /^commitlore doctor returned an invalid JSON report: (.+)$/.exec(detail);
  if (invalid) {
    const part = /invalid (schema|status|checks)/.exec(invalid[1]!)?.[1] ?? (invalid[1] === "not an object" ? "shape" : "json");
    return {
      ...base,
      cause: "product",
      signature: `doctor.invalid-report.${part}`,
      title: `doctor --json prints a report that is not a well-formed commitlore_doctor.v2 report (${part})`,
      problem: "A caller cannot judge the doctor's report because it does not follow the report contract.",
      expected: "`commitlore doctor --json` prints a JSON object with schema commitlore_doctor.v2, a status of ok, degraded or failed, and checks each ok, warn, fail or skipped.",
    };
  }
  const common = {
    ...base,
    title: "commitlore observation did not pass",
    problem: "The CommitLore observation in a new repository did not pass.",
    expected: "`commitlore init` and `commitlore doctor --json` both pass in a freshly initialised repository.",
  };
  if (/^commitlore doctor failed \(/.test(detail)) return { ...common, cause: "normal_refusal", signature: "doctor.nonzero-exit" };
  if (/^commitlore(?: init| doctor)? could not be run/.test(detail) || /^the CommitLore observation did not complete/.test(detail)) {
    return { ...common, cause: "environment", signature: "observation.not-run" };
  }
  if (/^commitlore init failed \(/.test(detail)) return { ...common, cause: "undetermined", signature: "init.nonzero-exit" };
  return { ...common, cause: "undetermined", signature: "observation.unclassified" };
};

// ---------------------------------------------------------------------------
// Upstream port
// ---------------------------------------------------------------------------

export interface UpstreamIssue {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  url: string;
}

export interface UpstreamComment {
  id: number;
  body: string;
  url: string;
}

/** Reads and writes one upstream tracker. Every method refuses a repository outside the two. */
export interface UpstreamIssuePort {
  /** Open and closed issues (never pull requests) whose body carries `token`. */
  findIssues(repository: string, token: string): Promise<UpstreamIssue[]>;
  readIssue(repository: string, number: number): Promise<UpstreamIssue>;
  listComments(repository: string, number: number): Promise<UpstreamComment[]>;
  createIssue(repository: string, title: string, body: string): Promise<{ number: number }>;
  createComment(repository: string, number: number, body: string): Promise<{ id: number }>;
  readComment(repository: string, id: number): Promise<UpstreamComment>;
}

interface RawIssue {
  number: number;
  state: string;
  title: string;
  body: string | null;
  html_url: string;
  repository_url?: string;
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  body: string | null;
  html_url: string;
}

const COMMENT_PAGES = 10;

/**
 * The port over the existing GitHub client. Discovery is the search index and the hundred most recently
 * created issues together: the index can lag a write by minutes, the recent list cannot, and a write this
 * reporter may have sent is among the most recent.
 */
export const githubUpstreamIssuePort = (client: GitHubClient): UpstreamIssuePort => {
  const base = (repository: string): string => {
    assertUpstreamRepository(repository);
    return `/repos/${repository}`;
  };
  const issue = (raw: RawIssue): UpstreamIssue => ({
    number: raw.number,
    state: raw.state === "open" ? "open" : "closed",
    title: raw.title,
    body: raw.body ?? "",
    url: raw.html_url,
  });
  const comment = (raw: RawComment): UpstreamComment => ({ id: raw.id, body: raw.body ?? "", url: raw.html_url });
  return {
    async findIssues(repository, token) {
      const path = base(repository);
      const query = encodeURIComponent(`${token} repo:${repository} is:issue`);
      const searched = await client.request<{ items?: RawIssue[] } | null>("GET", `/search/issues?q=${query}&per_page=100`);
      const recent = await client.request<RawIssue[] | null>("GET", `${path}/issues?state=all&sort=created&direction=desc&per_page=100`);
      const inRepository = (raw: RawIssue): boolean =>
        raw.repository_url === undefined || raw.repository_url === `https://api.github.com/repos/${repository}`;
      const found = new Map<number, UpstreamIssue>();
      for (const raw of [...(searched?.items ?? []), ...(recent ?? [])]) {
        if (raw.pull_request !== undefined || !inRepository(raw)) continue;
        const mapped = issue(raw);
        if (mapped.body.includes(token)) found.set(mapped.number, mapped);
      }
      return [...found.values()].sort((left, right) => left.number - right.number);
    },
    async readIssue(repository, number) {
      return issue(await client.request<RawIssue>("GET", `${base(repository)}/issues/${number}`));
    },
    async listComments(repository, number) {
      const path = base(repository);
      const comments: UpstreamComment[] = [];
      for (let page = 1; page <= COMMENT_PAGES; page += 1) {
        const batch = (await client.request<RawComment[] | null>("GET", `${path}/issues/${number}/comments?per_page=100&page=${page}`)) ?? [];
        comments.push(...batch.map(comment));
        if (batch.length < 100) return comments;
      }
      throw acpError(ReasonCode.INVALID_ARGUMENT, "an upstream issue has more comments than a pass reads", { repository, number });
    },
    async createIssue(repository, title, body) {
      const created = await client.request<{ number: number }>("POST", `${base(repository)}/issues`, { title, body });
      return { number: created.number };
    },
    async createComment(repository, number, body) {
      const created = await client.request<{ id: number }>("POST", `${base(repository)}/issues/${number}/comments`, { body });
      return { id: created.id };
    },
    async readComment(repository, id) {
      return comment(await client.request<RawComment>("GET", `${base(repository)}/issues/comments/${id}`));
    },
  };
};

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

const fence = (value: string): string => {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}text\n${value}\n${marks}`;
};

const observationSection = (record: DogfoodRecord): string[] => {
  const { fields } = record.public;
  return [
    "## Actual",
    fields.actual,
    "",
    "## Reproduction",
    fields.reproduction,
    "",
    record.reproduced ? "Reproduced." : "Not reproduced: observed once at the boundary named above.",
    record.basis === "observed" ? "Basis: observed." : "Basis: inferred, not observed directly.",
    "",
    revisionLine(record.revision),
    "",
    "## Evidence",
    record.public.evidence !== null
      ? fence(record.public.evidence)
      : record.public.evidenceWithheld
        ? "Withheld: the original could not be shown safe to publish. A private reference to it is kept."
        : "None beyond the above.",
  ];
};

const footer = (record: DogfoodRecord): string[] => [
  "",
  "---",
  `Reported from agent-control-plane's use of ${record.product}. Correlation: \`${keyToken(record.key)}\` \`${evidenceToken(record.evidenceKey)}\``,
];

type Counterpart = { product: DogfoodProduct; key: string; url: string | null };

const issueBody = (record: DogfoodRecord, extra: { previous?: UpstreamIssue; related: Counterpart | null }): string => {
  const { fields } = record.public;
  const lines = [
    record.kind === "improvement" ? "## Use case" : "## Problem",
    fields.problem,
    "",
    "## Expected",
    fields.expected,
    "",
    ...observationSection(record),
    "",
    "## Impact",
    fields.impact,
    "",
    "## Workaround",
    fields.workaround,
  ];
  if (extra.previous) lines.push("", "## Regression", `Previously reported as ${extra.previous.url}, which is closed; this is a new observation at the revision above.`);
  const related = extra.related;
  if (related) {
    lines.push("", "## Related", `The ${related.product} side of this finding: ${related.url ?? `correlation \`${keyToken(related.key)}\` in ${UPSTREAM_REPOSITORIES[related.product]}`}.`);
  }
  return [...lines, ...footer(record)].join("\n");
};

const commentBody = (record: DogfoodRecord): string =>
  [
    "New observation of this finding.",
    "",
    record.kind === "improvement" ? "## Use case" : "## Problem",
    record.public.fields.problem,
    "",
    ...observationSection(record),
    ...footer(record),
  ].join("\n");

type Plan =
  | { action: "created" }
  | { action: "commented"; issue: UpstreamIssue }
  | { action: "regression"; previous: UpstreamIssue };

type Located = { linked: { issue: UpstreamIssue; comment: UpstreamComment | null } } | { plan: Plan };

export interface DogfoodReporterOptions {
  clock?: Clock;
  /** Passes that may write. An IN_DOUBT record gets one more, read-only. */
  maxAttempts?: number;
  backoffMs?: number;
  /** Records taken per pass. */
  limit?: number;
}

export interface DogfoodReportSummary {
  linked: string[];
  waiting: string[];
  unpublished: string[];
  /** Record files that did not read as records, and a store that could not be listed: named, not skipped. */
  unreadable: string[];
  storeError: string | null;
  publishing: "enabled" | "disabled";
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** A failure GitHub answered with a status that will not change by asking again. */
const refusedStatus = (error: unknown): number | null => {
  const outcome = transportOutcome(error);
  if (outcome.outcome !== "answered" || outcome.status === undefined) return null;
  return outcome.status === 429 || outcome.status >= 500 ? null : outcome.status;
};

const errorText = (error: unknown): string => {
  const outcome = transportOutcome(error);
  return outcome.outcome === "answered" ? `GitHub answered ${outcome.status}` : "no answer from GitHub";
};

/**
 * Reports due findings. One pass per record: read the tracker for the finding's token, link what is
 * there, otherwise store the intent and write once, then read the write back. In-process claims on the
 * finding key keep two passes off one finding; the daemon is the single writer. Nothing a pass meets escapes it: a failure is
 * the record's state, never the caller's exception, so no other work waits on a tracker.
 */
export class UpstreamDogfoodReporter {
  readonly #claims = new Set<string>();
  readonly #clock: Clock;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #limit: number;

  /**
   * `publisher` null is publishing off: a pass names what is due and sends nothing, and no record moves.
   */
  constructor(
    private readonly store: DogfoodFindingStore,
    private readonly publisher: UpstreamIssuePort | null,
    options: DogfoodReporterOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#limit = options.limit ?? 20;
  }

  async reportDue(): Promise<DogfoodReportSummary> {
    const publisher = this.publisher;
    const summary: DogfoodReportSummary = {
      linked: [], waiting: [], unpublished: [], unreadable: [], storeError: null, publishing: publisher === null ? "disabled" : "enabled",
    };
    let listed: DogfoodRecord[];
    try {
      const read = this.store.list();
      listed = read.records;
      summary.unreadable = read.unreadable;
    } catch (error) {
      summary.storeError = (error as Error).message.slice(0, 300);
      return summary;
    }
    const now = this.#clock.now().getTime();
    const due = listed
      .filter((record) => (record.state.status === "QUEUED" || record.state.status === "IN_DOUBT") && new Date(record.state.nextAttemptAt).getTime() <= now)
      .slice(0, this.#limit);
    if (publisher === null) {
      summary.waiting = due.map((record) => record.id);
      return summary;
    }
    for (const record of due) {
      // Claimed by the finding, not the observation: two observations of one finding share its issue.
      if (this.#claims.has(record.key)) continue;
      this.#claims.add(record.key);
      try {
        const after = await this.#pass(record, publisher);
        const status = after.state.status;
        if (status === "LINKED") summary.linked.push(record.id);
        else if (status === "UNPUBLISHED") summary.unpublished.push(record.id);
        else summary.waiting.push(record.id);
      } catch {
        summary.waiting.push(record.id);
      } finally {
        this.#claims.delete(record.key);
      }
    }
    return summary;
  }

  async #pass(record: DogfoodRecord, port: UpstreamIssuePort): Promise<DogfoodRecord> {
    const state = record.state;
    if (state.status !== "QUEUED" && state.status !== "IN_DOUBT") return record;
    const repository = UPSTREAM_REPOSITORIES[record.product];
    const attempt = state.attempts + 1;
    const now = this.#clock.nowIso();

    let located: Located;
    try {
      located = await this.#locate(record, repository, port);
    } catch (error) {
      return this.#failed(record, error, attempt);
    }
    if ("linked" in located) return this.#link(record, located.linked.issue, located.linked.comment, "existing", attempt);
    // Past the last writing pass only an in-doubt record gets here, to read once more; it writes nothing.
    if (attempt > this.#maxAttempts) {
      return this.store.transition(record, { status: "UNPUBLISHED", attempts: attempt, reason: "ATTEMPTS_EXHAUSTED", lastError: state.lastError, at: now });
    }

    const plan = located.plan;
    const title = plan.action === "regression" ? `Regression: ${record.public.fields.title}`.slice(0, 256) : record.public.fields.title;
    const body =
      plan.action === "commented"
        ? commentBody(record)
        : issueBody(record, { ...(plan.action === "regression" ? { previous: plan.previous } : {}), related: this.#counterpart(record) });
    // The publication scan's last word on the exact text, before anything is stored as sent.
    if (!isPublicSafe(body) || !isPublicSafe(title)) {
      return this.store.transition(record, { status: "UNPUBLISHED", attempts: attempt, reason: "NOT_PUBLIC_SAFE", lastError: null, at: now });
    }

    // The intent is stored before the write: a crash after it leaves a record the next pass reads for.
    const intent = this.store.transition(record, {
      status: "IN_DOUBT",
      attempts: attempt,
      nextAttemptAt: isoPlus(now, this.#delay(attempt)),
      lastError: state.lastError,
      since: now,
    });
    try {
      if (plan.action === "commented") {
        const { id } = await port.createComment(repository, plan.issue.number, body);
        const read = await port.readComment(repository, id);
        if (!this.#commentHolds(intent, repository, plan.issue.number, read)) return this.#unverified(intent);
        return this.#link(intent, plan.issue, read, "commented", attempt);
      }
      const { number } = await port.createIssue(repository, title, body);
      const read = await port.readIssue(repository, number);
      if (!this.#issueHolds(intent, repository, number, read, title)) return this.#unverified(intent);
      return this.#link(intent, read, null, plan.action, attempt);
    } catch (error) {
      return this.#failed(intent, error, attempt);
    }
  }

  async #locate(record: DogfoodRecord, repository: string, port: UpstreamIssuePort): Promise<Located> {
    const token = keyToken(record.key);
    const evidence = evidenceToken(record.evidenceKey);
    // Discovery only names candidates; each is read exactly, and only what that read shows decides.
    const issues: UpstreamIssue[] = [];
    for (const found of await port.findIssues(repository, token)) {
      let read: UpstreamIssue;
      try {
        read = await port.readIssue(repository, found.number);
      } catch (error) {
        // An issue the index still lists but GitHub no longer has is no candidate.
        const status = refusedStatus(error);
        if (status === 404 || status === 410) continue;
        throw error;
      }
      if (read.number === found.number && read.url.startsWith(`https://github.com/${repository}/issues/${found.number}`) && read.body.includes(token)) {
        issues.push(read);
      }
    }
    const carrying = issues.find((issue) => issue.body.includes(evidence));
    if (carrying) return { linked: { issue: carrying, comment: null } };
    const comments = new Map<number, UpstreamComment[]>();
    for (const issue of issues) {
      const listed = await port.listComments(repository, issue.number);
      comments.set(issue.number, listed);
      const found = listed.find((comment) => comment.body.includes(evidence));
      if (found) return { linked: { issue, comment: found } };
    }
    const open = issues.find((issue) => issue.state === "open");
    if (open) return { plan: { action: "commented", issue: open } };
    if (issues.length === 0) return { plan: { action: "created" } };
    // Every issue for this finding is closed. New evidence at a revision one of them records is posted
    // there; a new revision is a regression.
    const line = revisionLine(record.revision);
    const sameRevision = issues.find(
      (issue) => issue.body.includes(line) || (comments.get(issue.number) ?? []).some((comment) => comment.body.includes(line)),
    );
    if (sameRevision) return { plan: { action: "commented", issue: sameRevision } };
    return { plan: { action: "regression", previous: issues[issues.length - 1]! } };
  }

  #issueHolds(record: DogfoodRecord, repository: string, number: number, read: UpstreamIssue, title: string): boolean {
    return (
      read.number === number &&
      read.title === title &&
      read.url.startsWith(`https://github.com/${repository}/issues/${number}`) &&
      read.body.includes(keyToken(record.key)) &&
      read.body.includes(evidenceToken(record.evidenceKey))
    );
  }

  #commentHolds(record: DogfoodRecord, repository: string, number: number, read: UpstreamComment): boolean {
    return (
      read.url.startsWith(`https://github.com/${repository}/issues/${number}#issuecomment-`) &&
      read.body.includes(keyToken(record.key)) &&
      read.body.includes(evidenceToken(record.evidenceKey))
    );
  }

  /**
   * The other side of a finding split across products: the one this record names, or the one naming it
   * (a review's own record is stored before its CommitLore side is), with its issue once linked.
   */
  #counterpart(record: DogfoodRecord): Counterpart | null {
    try {
      const records = this.store.list().records;
      const naming = records.find((other) => other.related?.product === record.product && other.related.key === record.key);
      const side = record.related ?? (naming ? { product: naming.product, key: naming.key } : null);
      if (side === null) return null;
      const linked = records.find((other) => other.product === side.product && other.key === side.key && other.state.status === "LINKED");
      return { ...side, url: linked?.state.status === "LINKED" ? linked.state.url : null };
    } catch {
      return record.related === null ? null : { ...record.related, url: null };
    }
  }

  #link(record: DogfoodRecord, issue: UpstreamIssue, comment: UpstreamComment | null, action: LinkAction, attempts: number): DogfoodRecord {
    return this.store.transition(record, {
      status: "LINKED",
      attempts,
      url: comment?.url ?? issue.url,
      issueNumber: issue.number,
      commentId: comment?.id ?? null,
      action,
      readAt: this.#clock.nowIso(),
    });
  }

  /** A write the readback does not show stays in doubt: the next pass reads before it writes again. */
  #unverified(intent: DogfoodRecord): DogfoodRecord {
    const state = intent.state as Extract<DogfoodState, { status: "IN_DOUBT" }>;
    return this.store.transition(intent, { ...state, lastError: "READBACK_MISMATCH" });
  }

  /**
   * A refusal GitHub answered is final. Anything else waits for the next pass, up to the last writing pass;
   * a record in doubt there keeps one read-only pass, so a write that did land is still linked.
   */
  #failed(record: DogfoodRecord, error: unknown, attempt: number): DogfoodRecord {
    const now = this.#clock.nowIso();
    const status = refusedStatus(error);
    const lastError = errorText(error);
    const inDoubt = record.state.status === "IN_DOUBT";
    if (status !== null) {
      return this.store.transition(record, { status: "UNPUBLISHED", attempts: attempt, reason: `UPSTREAM_REFUSED_${status}`, lastError, at: now });
    }
    if (attempt > this.#maxAttempts || (attempt === this.#maxAttempts && !inDoubt)) {
      return this.store.transition(record, {
        status: "UNPUBLISHED",
        attempts: attempt,
        reason: inDoubt ? "IN_DOUBT_UNRESOLVED" : "ATTEMPTS_EXHAUSTED",
        lastError,
        at: now,
      });
    }
    const nextAttemptAt = isoPlus(now, this.#delay(attempt));
    return this.store.transition(
      record,
      inDoubt
        ? { status: "IN_DOUBT", attempts: attempt, nextAttemptAt, lastError, since: (record.state as { since: string }).since }
        : { status: "QUEUED", attempts: attempt, nextAttemptAt, lastError },
    );
  }

  #delay(attempt: number): number {
    return Math.min(MAX_BACKOFF_MS, this.#backoffMs * 2 ** Math.max(0, attempt - 1));
  }
}
