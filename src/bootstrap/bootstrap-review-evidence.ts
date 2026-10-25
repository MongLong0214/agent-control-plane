import type { ReviewRecordVerification } from "./bootstrap-review-evidence-github.ts";
import { z } from "zod";
import { digestOf, sha256 } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { artifactDigestMatches } from "../db/artifacts.ts";
import { ArtifactKind, RunState } from "../domain/types.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import type { HermesAdmittedTurn } from "../mcp/hermes-provenance.ts";
import type { BootstrapApplications } from "./bootstrap-applications.ts";
import { bootstrapPlanAttachAuthority, bootstrapStagingIdentity, currentBootstrapInputRun,
  readBootstrapPlanAttachment, validateBootstrapPlanDigests } from "./bootstrap-plan-artifact.ts";
import { screenPublicText } from "./genesis-bundle.ts";

type Source = Parameters<typeof currentBootstrapInputRun>[0] & {
  bootstrapApplications: Pick<BootstrapApplications, "assertNotFrozen">;
};
// Review originals and independently queried API facts each get a separate bounded budget.
// API facts follow the evidence limit, never consume or truncate original file bytes.
export const BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES = 512 * 1024;
const CANDIDATE = "acp.bootstrap-review-evidence-candidate.v1";
const ATTACHED = "acp.bootstrap-review-evidence-attached.v1";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const excerptRange = z.object({ section: z.enum(["failure", "fix", "result"]), startLine: z.number().int().positive(),
  endLine: z.number().int().positive() }).strict().refine(r => r.endLine >= r.startLine);
export const reviewEvidenceBundleSchema = z.object({
  runId: z.string(), contractDigest: digest,
  files: z.array(z.object({
    path: z.string().min(1).refine(p => !p.startsWith("/") && !p.split("/").some(s => s === "..") && !/[\x00-\x1f\x7f]/.test(p)),
    sha256: digest, origin: z.string().min(1),
    grade: z.enum(["github-api-original", "review-original", "execution-log", "implementer-final-report"]),
    bodyBase64: z.string(),
    github: z.object({ repositoryIdentity: z.string(), pullNumber: z.number().int().positive(),
      sha: z.string().regex(/^[a-f0-9]{40}$/) }).strict().optional(),
    excerpt: z.object({ originalSha256: digest, omitted: z.literal(true), ranges: z.array(excerptRange).min(3) }).strict()
      .refine(e => ["failure", "fix", "result"].every(s => e.ranges.some(r => r.section === s))).optional(),
  }).strict()),
  missing: z.array(z.string().min(1)),
}).strict();
export type ReviewEvidenceBundle = z.infer<typeof reviewEvidenceBundleSchema>;
export type ReviewEvidenceFile = ReviewEvidenceBundle["files"][number];
export interface ReviewEvidenceInput { runId: string; contractDigest: string; bootstrapPlanDigest: string; expectedSha256: string; stagedBy?: string; replacesSha256?: string }
export interface ReviewEvidenceStageInput extends ReviewEvidenceInput { evidenceBody: string }
interface Candidate { schema: typeof CANDIDATE; runId: string; contractDigest: string; bootstrapPlanDigest: string; sha256: string; bodyBase64: string; stagedBy: string }
interface Attachment { schema: typeof ATTACHED; runId: string; contractDigest: string; bootstrapPlanDigest: string; sha256: string; stagedBy: string; candidateDigest: string }
export interface FrozenReviewEvidence {
  bundle: ReviewEvidenceBundle;
  source: { bootstrapPlanDigest: string; bundleSha256: string; candidateDigest: string; attachmentDigest: string; stageEventId: number; attachEventId: number;
    stagedBy: string; collectedBySessionId: string; attachedBySessionId: string; ceoBindingGeneration: number };
  digest: string;
}

export type FrozenReviewEvidenceReference = Omit<FrozenReviewEvidence, "bundle">;
const referenceOf = ({ bundle: _bundle, ...reference }: FrozenReviewEvidence): FrozenReviewEvidenceReference => reference;

const parseBundle = (body: string, input: ReviewEvidenceInput): Decision<ReviewEvidenceBundle> => {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES || bytes.toString("utf8") !== body) {
    return deny(ReasonCode.INVALID_ARGUMENT, `review evidence bundle exceeds the ${BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES}-byte UTF-8 staging limit; no automatic summaries, split uploads or external references. Explicit excerpts must identify the original digest and line ranges and preserve failure, fix and result sections`);
  }
  if (sha256(bytes) !== input.expectedSha256) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "review evidence bundle hash differs");
  let value: unknown;
  try { value = JSON.parse(body); } catch { return deny(ReasonCode.INVALID_ARGUMENT, "review evidence bundle must be JSON"); }
  const parsed = reviewEvidenceBundleSchema.safeParse(value);
  if (!parsed.success || parsed.data.runId !== input.runId || parsed.data.contractDigest !== input.contractDigest) {
    return deny(ReasonCode.INVALID_ARGUMENT, "review evidence manifest must bind this run and contract, enumerate files and MISSING items");
  }
  try { for (const item of parsed.data.missing) screenPublicText(item); }
  catch { return deny(ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED, "review evidence missing-item labels contain credential-shaped content"); }
  const paths = new Set<string>();
  for (const file of parsed.data.files) {
    const bytes = Buffer.from(file.bodyBase64, "base64");
    if (paths.has(file.path) || bytes.toString("base64") !== file.bodyBase64 || sha256(bytes) !== file.sha256
        || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "review evidence file hash, path or UTF-8 bytes differ");
    paths.add(file.path);
    try { screenPublicText(bytes.toString("utf8")); screenPublicText(file.origin); }
    catch { return deny(ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED, "review evidence contains credential-shaped content"); }
  }
  return allow(ReasonCode.OK, parsed.data);
};
const candidates = (source: Source, runId: string) => source.artifacts.list<Candidate>(runId, ArtifactKind.HANDOFF).filter(a => a.content?.schema === CANDIDATE);
const attachments = (source: Source, runId: string) => source.artifacts.list<Attachment>(runId, ArtifactKind.HANDOFF).filter(a => a.content?.schema === ATTACHED);
const reviewEvidenceRunAccess = (source: Source, input: ReviewEvidenceInput) => {
  const digests = validateBootstrapPlanDigests({ contractDigest: input.contractDigest, expectedSha256: input.expectedSha256, replacesSha256: input.replacesSha256 });
  if (!digests.allowed) return digests;
  if (!digest.safeParse(input.bootstrapPlanDigest).success) return deny(ReasonCode.INVALID_ARGUMENT, "review evidence requires the current bootstrap PLAN digest");
  const run = currentBootstrapInputRun(source, input.runId);
  if (!run.allowed) return run;
  if (run.value.projectId !== null || ![RunState.ACTIVE, RunState.BLOCKED].some(s => run.value.state === s)
      || run.value.contractDigest !== input.contractDigest) return deny(ReasonCode.CONFLICT, "review evidence requires the current project-less bootstrap contract before review");
  const frozen = source.bootstrapApplications.assertNotFrozen(input.runId, "plan_submit");
  if (!frozen.allowed) return frozen;
  const plan = readBootstrapPlanAttachment(source, input.runId);
  if (!plan.allowed) return plan;
  return plan.value.digest === input.bootstrapPlanDigest ? run
    : deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "review evidence bootstrap PLAN attachment is no longer current");
};
/** Also evaluated before cached MCP replies, so replay cannot bypass byte or attachment checks. */
export const reviewEvidenceAttachAccess = (source: Source, input: ReviewEvidenceInput): Decision<ReturnType<typeof candidates>[number]> => {
  const run = reviewEvidenceRunAccess(source, input);
  if (!run.allowed) return run;
  const candidate = candidates(source, input.runId).find(c => c.content.stagedBy === input.stagedBy
    && c.content.sha256 === input.expectedSha256 && c.content.bootstrapPlanDigest === input.bootstrapPlanDigest
    && c.content.contractDigest === input.contractDigest && c.content.runId === input.runId);
  const receipt = candidate && source.audit.forRun(input.runId).find(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_STAGED" && e.roleKey === input.stagedBy
    && e.evidence["digest"] === candidate.digest && e.evidence["payloadDigest"] === input.expectedSha256
    && e.evidence["bootstrapPlanDigest"] === input.bootstrapPlanDigest && e.evidence["contractDigest"] === input.contractDigest);
  if (!candidate || !receipt || !artifactDigestMatches(candidate)) return deny(ReasonCode.NOT_FOUND, "no intact review evidence candidate at this run/contract/PLAN/stager/digest");
  if (attachments(source, input.runId).some(a => a.superseded && a.content.candidateDigest === candidate.digest)) {
    return deny(ReasonCode.CONFLICT, "a superseded review evidence selection cannot be made current again");
  }
  const body = Buffer.from(candidate.content.bodyBase64, "base64");
  if (body.toString("base64") !== candidate.content.bodyBase64) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "review evidence candidate encoding differs");
  const parsed = parseBundle(body.toString("utf8"), input);
  return parsed.allowed ? allow(ReasonCode.OK, candidate) : parsed;
};
export const reviewEvidenceAttachAuthority = (source: Pick<Source, "bindings">, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined): ReturnType<typeof bootstrapPlanAttachAuthority> => {
  const identity = bootstrapPlanAttachAuthority(source, peer, turn);
  if (!identity.allowed) return identity;
  if (peer.binding && (peer.binding.roleKey !== identity.value.ceo.roleKey
      || peer.binding.bindingGeneration !== identity.value.ceo.bindingGeneration)) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "review evidence attachment requires the current authenticated CEO binding");
  }
  return identity;
};
export const reviewEvidenceStageAccess = (source: Source & Parameters<typeof bootstrapStagingIdentity>[0], peer: AuthenticatedMcpPeer, input: ReviewEvidenceStageInput) => {
  const identity = bootstrapStagingIdentity(source, peer);
  if (!identity.allowed) return identity;
  const run = reviewEvidenceRunAccess(source, input);
  if (!run.allowed) return run;
  const parsed = parseBundle(input.evidenceBody, input);
  return parsed.allowed ? allow(ReasonCode.OK, identity.value) : parsed;
};
export const stageBootstrapReviewEvidence = (source: Source & Parameters<typeof bootstrapStagingIdentity>[0], peer: AuthenticatedMcpPeer, input: ReviewEvidenceStageInput) => source.db.txDecision(() => {
  const access = reviewEvidenceStageAccess(source, peer, input);
  if (!access.allowed) return access;
  const stagedBy = access.value.roleKey;
  const prior = candidates(source, input.runId).filter(c => c.content.stagedBy === stagedBy
    && c.content.bootstrapPlanDigest === input.bootstrapPlanDigest && c.content.contractDigest === input.contractDigest);
  if (prior.some(c => c.content.sha256 === input.expectedSha256 && artifactDigestMatches(c))) return allow(ReasonCode.OK, { digest: input.expectedSha256, stagedBy });
  if (prior.some(c => !attachments(source, input.runId).some(a => a.content.candidateDigest === c.digest))) {
    return deny(ReasonCode.CONFLICT, "this PRIMARY_CTO already has an unattached immutable review evidence bundle");
  }
  const artifact = source.artifacts.put(input.runId, ArtifactKind.HANDOFF, { schema: CANDIDATE, runId: input.runId,
    contractDigest: input.contractDigest, bootstrapPlanDigest: input.bootstrapPlanDigest, sha256: input.expectedSha256, stagedBy, bodyBase64: Buffer.from(input.evidenceBody).toString("base64") });
  const recorded = source.audit.record({ kind: "BOOTSTRAP_REVIEW_EVIDENCE_STAGED", runId: input.runId,
    sessionId: peer.sessionId, roleKey: stagedBy, evidence: { digest: artifact.digest, payloadDigest: input.expectedSha256,
      contractDigest: input.contractDigest, bootstrapPlanDigest: input.bootstrapPlanDigest, bindingGeneration: access.value.bindingGeneration, stagedBy } });
  return recorded.allowed ? allow(ReasonCode.OK, { digest: input.expectedSha256, stagedBy }) : recorded;
});
export const attachBootstrapReviewEvidence = (source: Source, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: ReviewEvidenceInput) => source.db.txDecision(() => {
  const identity = reviewEvidenceAttachAuthority(source, peer, turn);
  if (!identity.allowed) return identity;
  const access = reviewEvidenceAttachAccess(source, input);
  if (!access.allowed) return access;
  const candidate = access.value;
  const prior = attachments(source, input.runId).find(a => !a.superseded);
  if (prior?.content.sha256 === input.expectedSha256 && prior.content.candidateDigest === candidate.digest) return allow(ReasonCode.OK, { digest: input.expectedSha256 });
  if (prior && input.replacesSha256 !== prior.content.sha256) return deny(ReasonCode.CONFLICT, "replacement review evidence must name replacesSha256");
  const attached = source.artifacts.put(input.runId, ArtifactKind.HANDOFF, { schema: ATTACHED, runId: input.runId,
    contractDigest: input.contractDigest, bootstrapPlanDigest: input.bootstrapPlanDigest, sha256: input.expectedSha256, stagedBy: input.stagedBy!, candidateDigest: candidate.digest });
  const recorded = source.audit.record({ kind: "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED", runId: input.runId, sessionId: peer.sessionId,
    roleKey: identity.value.ceo.roleKey, evidence: { digest: attached.digest, payloadDigest: input.expectedSha256,
      contractDigest: input.contractDigest, bootstrapPlanDigest: input.bootstrapPlanDigest, bindingGeneration: identity.value.ceo.bindingGeneration,
      stagedBy: input.stagedBy, hermesPrincipal: identity.value.turn.principal, hermesPeerGrant: identity.value.turn.peerGrant } });
  if (!recorded.allowed) return recorded;
  if (prior) source.artifacts.supersede(input.runId, ArtifactKind.HANDOFF, prior.digest);
  return allow(ReasonCode.OK, { digest: input.expectedSha256 });
});

/** Resolve exact historical bytes from private artifacts, never from producer text or a latest fallback. */
const readPrivateReviewEvidence = (source: Pick<Source, "artifacts" | "audit">, runId: string,
  attached: ReturnType<typeof attachments>[number]): FrozenReviewEvidence => {
  const audit = source.audit.forRun(runId);
  const candidate = source.artifacts.list<Candidate>(runId, ArtifactKind.HANDOFF).find(c => c.digest === attached.content.candidateDigest && c.content?.schema === CANDIDATE);
  const stage = candidate && audit.find(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_STAGED" && e.roleKey === attached.content.stagedBy && e.evidence["digest"] === candidate.digest && e.evidence["payloadDigest"] === attached.content.sha256);
  const attach = audit.find(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED" && e.roleKey === "CEO" && e.evidence["digest"] === attached.digest && e.evidence["payloadDigest"] === attached.content.sha256);
  if (!candidate || !stage?.sessionId || !attach?.sessionId || !artifactDigestMatches(candidate) || !artifactDigestMatches(attached)
      || candidate.content.runId !== runId || attached.content.runId !== runId
      || candidate.content.contractDigest !== attached.content.contractDigest
      || candidate.content.bootstrapPlanDigest !== attached.content.bootstrapPlanDigest
      || stage.evidence["bootstrapPlanDigest"] !== attached.content.bootstrapPlanDigest
      || attach.evidence["bootstrapPlanDigest"] !== attached.content.bootstrapPlanDigest) throw new Error("review evidence receipt or artifact differs");
  const parsed = parseBundle(Buffer.from(candidate.content.bodyBase64, "base64").toString("utf8"), { ...attached.content, expectedSha256: attached.content.sha256 });
  if (!parsed.allowed) throw new Error(parsed.message);
  const record = { bundle: parsed.value, source: { bootstrapPlanDigest: attached.content.bootstrapPlanDigest, bundleSha256: attached.content.sha256, candidateDigest: candidate.digest,
    attachmentDigest: attached.digest, stageEventId: stage.eventId, attachEventId: attach.eventId, stagedBy: stage.roleKey!,
    collectedBySessionId: stage.sessionId, attachedBySessionId: attach.sessionId, ceoBindingGeneration: attach.evidence["bindingGeneration"] as number } };
  return { ...record, digest: digestOf(record) };
};

/** Freeze a reference only. Original bytes stay in the existing private HANDOFF candidate. */
export function collectBootstrapReviewEvidence(source: Source, runId: string): FrozenReviewEvidenceReference | null {
  const attached = attachments(source, runId).find(a => !a.superseded);
  if (!attached) {
    if (source.audit.forRun(runId).some(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED")) throw new Error("attached review evidence is missing");
    return null;
  }
  const plan = readBootstrapPlanAttachment(source, runId);
  if (!plan.allowed || plan.value.digest !== attached.content.bootstrapPlanDigest) throw new Error("review evidence names a replaced bootstrap PLAN attachment");
  return referenceOf(readPrivateReviewEvidence(source, runId, attached));
}
export function frozenBootstrapReviewEvidence(source: Pick<Source, "artifacts" | "audit">, runId: string, content: unknown): FrozenReviewEvidence | null {
  const plan = content as { bootstrapPlanDigest?: string; reviewEvidence?: FrozenReviewEvidenceReference };
  const reference = plan?.reviewEvidence;
  if (!reference) return null;
  const attached = source.artifacts.list<Attachment>(runId, ArtifactKind.HANDOFF)
    .find(a => a.content?.schema === ATTACHED && a.digest === reference.source.attachmentDigest);
  if (!attached || reference.source.bootstrapPlanDigest !== plan.bootstrapPlanDigest) throw new Error("frozen review evidence reference differs");
  const record = readPrivateReviewEvidence(source, runId, attached);
  if (digestOf(referenceOf(record)) !== digestOf(reference)) throw new Error("frozen review evidence differs");
  return record;
}

export async function originalReviewRecords(record: FrozenReviewEvidence | null,
  verify?: (file: ReviewEvidenceFile) => Promise<ReviewRecordVerification>) {
  if (!record) return null;
  const files = [];
  let apiFactBytes = 0;
  for (const { bodyBase64, ...file } of record.bundle.files) {
    const withheld = file.grade === "implementer-final-report";
    let verification = !withheld && verify && apiFactBytes < BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES ? await verify({ ...file, bodyBase64 })
      : { status: "attributed" as const, reason: apiFactBytes >= BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES
        ? "ACP API facts exceed the 512 KiB review evidence observation bound" : "ACP has not independently verified this content", facts: [] };
    const factBytes = Buffer.byteLength(JSON.stringify(verification.facts));
    if (apiFactBytes + factBytes > BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES) verification = { status: "attributed", reason: "ACP API facts exceed the 512 KiB review evidence observation bound", facts: [] };
    else apiFactBytes += factBytes;
    // Free-form manifest fields can carry the same reasoning as the withheld body.
    files.push(withheld ? { grade: file.grade, sha256: file.sha256, verification, withheld: "producer self-assessment" }
      : { ...file, verification, bodyBase64 });
  }
  return { source: record.source, bundleDigest: record.digest, missing: record.bundle.missing, files };
}
