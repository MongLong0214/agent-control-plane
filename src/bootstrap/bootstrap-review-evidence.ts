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
import { BOOTSTRAP_PLAN_MAX_BYTES, bootstrapPlanAttachAuthority, bootstrapStagingIdentity, currentBootstrapInputRun,
  validateBootstrapPlanDigests } from "./bootstrap-plan-artifact.ts";
import { screenPublicText } from "./genesis-bundle.ts";

type Source = Parameters<typeof currentBootstrapInputRun>[0] & {
  bootstrapApplications: Pick<BootstrapApplications, "assertNotFrozen">;
};
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
export interface ReviewEvidenceInput { runId: string; contractDigest: string; expectedSha256: string; stagedBy?: string; replacesSha256?: string }
export interface ReviewEvidenceStageInput extends ReviewEvidenceInput { evidenceBody: string }
interface Candidate { schema: typeof CANDIDATE; runId: string; contractDigest: string; sha256: string; bodyBase64: string; stagedBy: string }
interface Attachment { schema: typeof ATTACHED; runId: string; contractDigest: string; sha256: string; stagedBy: string; candidateDigest: string }
export interface FrozenReviewEvidence {
  bundle: ReviewEvidenceBundle;
  source: { bundleSha256: string; candidateDigest: string; attachmentDigest: string; stageEventId: number; attachEventId: number;
    stagedBy: string; collectedBySessionId: string; attachedBySessionId: string; ceoBindingGeneration: number };
  digest: string;
}

const parseBundle = (body: string, input: ReviewEvidenceInput): Decision<ReviewEvidenceBundle> => {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > BOOTSTRAP_PLAN_MAX_BYTES || bytes.toString("utf8") !== body) {
    return deny(ReasonCode.INVALID_ARGUMENT, `review evidence bundle exceeds the existing ${BOOTSTRAP_PLAN_MAX_BYTES}-byte UTF-8 staging limit; no automatic summaries, split uploads or external references. Explicit excerpts must identify the original digest and line ranges and preserve failure, fix and result sections`);
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
export const reviewEvidenceAttachAccess = (source: Source, input: ReviewEvidenceInput) => {
  const digests = validateBootstrapPlanDigests({ contractDigest: input.contractDigest, expectedSha256: input.expectedSha256, replacesSha256: input.replacesSha256 });
  if (!digests.allowed) return digests;
  const run = currentBootstrapInputRun(source, input.runId);
  if (!run.allowed) return run;
  if (run.value.projectId !== null || ![RunState.ACTIVE, RunState.BLOCKED].some(s => run.value.state === s)
      || run.value.contractDigest !== input.contractDigest) return deny(ReasonCode.CONFLICT, "review evidence requires the current project-less bootstrap contract before review");
  const frozen = source.bootstrapApplications.assertNotFrozen(input.runId, "plan_submit");
  return frozen.allowed ? run : frozen;
};
export const reviewEvidenceStageAccess = (source: Source & Parameters<typeof bootstrapStagingIdentity>[0], peer: AuthenticatedMcpPeer, input: ReviewEvidenceStageInput) => {
  const identity = bootstrapStagingIdentity(source, peer);
  if (!identity.allowed) return identity;
  const run = reviewEvidenceAttachAccess(source, input);
  if (!run.allowed) return run;
  const parsed = parseBundle(input.evidenceBody, input);
  return parsed.allowed ? allow(ReasonCode.OK, identity.value) : parsed;
};
export const stageBootstrapReviewEvidence = (source: Source & Parameters<typeof bootstrapStagingIdentity>[0], peer: AuthenticatedMcpPeer, input: ReviewEvidenceStageInput) => source.db.txDecision(() => {
  const access = reviewEvidenceStageAccess(source, peer, input);
  if (!access.allowed) return access;
  const stagedBy = access.value.roleKey;
  const prior = candidates(source, input.runId).filter(c => c.content.stagedBy === stagedBy);
  if (prior.some(c => c.content.sha256 === input.expectedSha256 && artifactDigestMatches(c))) return allow(ReasonCode.OK, { digest: input.expectedSha256, stagedBy });
  if (prior.some(c => !attachments(source, input.runId).some(a => a.content.candidateDigest === c.digest))) {
    return deny(ReasonCode.CONFLICT, "this PRIMARY_CTO already has an unattached immutable review evidence bundle");
  }
  const artifact = source.artifacts.put(input.runId, ArtifactKind.HANDOFF, { schema: CANDIDATE, runId: input.runId,
    contractDigest: input.contractDigest, sha256: input.expectedSha256, stagedBy, bodyBase64: Buffer.from(input.evidenceBody).toString("base64") });
  const recorded = source.audit.record({ kind: "BOOTSTRAP_REVIEW_EVIDENCE_STAGED", runId: input.runId,
    sessionId: peer.sessionId, roleKey: stagedBy, evidence: { digest: artifact.digest, payloadDigest: input.expectedSha256,
      contractDigest: input.contractDigest, bindingGeneration: access.value.bindingGeneration, stagedBy } });
  return recorded.allowed ? allow(ReasonCode.OK, { digest: input.expectedSha256, stagedBy }) : recorded;
});
export const attachBootstrapReviewEvidence = (source: Source, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: ReviewEvidenceInput) => source.db.txDecision(() => {
  const identity = bootstrapPlanAttachAuthority(source, peer, turn);
  if (!identity.allowed) return identity;
  const access = reviewEvidenceAttachAccess(source, input);
  if (!access.allowed) return access;
  const candidate = candidates(source, input.runId).find(c => c.content.stagedBy === input.stagedBy && c.content.sha256 === input.expectedSha256);
  const receipt = candidate && source.audit.forRun(input.runId).find(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_STAGED" && e.roleKey === input.stagedBy
    && e.evidence["digest"] === candidate.digest && e.evidence["payloadDigest"] === input.expectedSha256);
  if (!candidate || !receipt || !artifactDigestMatches(candidate)) return deny(ReasonCode.NOT_FOUND, "no intact review evidence candidate at this run/stager/digest");
  const body = Buffer.from(candidate.content.bodyBase64, "base64");
  if (body.toString("base64") !== candidate.content.bodyBase64) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "review evidence candidate encoding differs");
  const parsed = parseBundle(body.toString("utf8"), input);
  if (!parsed.allowed) return parsed;
  const prior = attachments(source, input.runId).find(a => !a.superseded);
  if (prior?.content.sha256 === input.expectedSha256 && prior.content.candidateDigest === candidate.digest) return allow(ReasonCode.OK, { digest: input.expectedSha256 });
  if (prior && input.replacesSha256 !== prior.content.sha256) return deny(ReasonCode.CONFLICT, "replacement review evidence must name replacesSha256");
  const attached = source.artifacts.put(input.runId, ArtifactKind.HANDOFF, { schema: ATTACHED, runId: input.runId,
    contractDigest: input.contractDigest, sha256: input.expectedSha256, stagedBy: input.stagedBy!, candidateDigest: candidate.digest });
  const recorded = source.audit.record({ kind: "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED", runId: input.runId, sessionId: peer.sessionId,
    roleKey: identity.value.ceo.roleKey, evidence: { digest: attached.digest, payloadDigest: input.expectedSha256,
      contractDigest: input.contractDigest, bindingGeneration: identity.value.ceo.bindingGeneration,
      stagedBy: input.stagedBy, hermesPrincipal: identity.value.turn.principal, hermesPeerGrant: identity.value.turn.peerGrant } });
  if (!recorded.allowed) return recorded;
  if (prior) source.artifacts.supersede(input.runId, ArtifactKind.HANDOFF, prior.digest);
  return allow(ReasonCode.OK, { digest: input.expectedSha256 });
});

/** Freeze only the CEO-selected immutable candidate; missing receipts fail closed. */
export function collectBootstrapReviewEvidence(source: Pick<Source, "artifacts" | "audit">, runId: string): FrozenReviewEvidence | null {
  const attached = source.artifacts.list<Attachment>(runId, ArtifactKind.HANDOFF).find(a => a.content?.schema === ATTACHED && !a.superseded);
  const audit = source.audit.forRun(runId);
  if (!attached) {
    if (audit.some(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED")) throw new Error("attached review evidence is missing");
    return null;
  }
  const candidate = source.artifacts.list<Candidate>(runId, ArtifactKind.HANDOFF).find(c => c.digest === attached.content.candidateDigest && c.content?.schema === CANDIDATE);
  const stage = candidate && audit.find(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_STAGED" && e.roleKey === attached.content.stagedBy && e.evidence["digest"] === candidate.digest && e.evidence["payloadDigest"] === attached.content.sha256);
  const attach = audit.find(e => e.kind === "BOOTSTRAP_REVIEW_EVIDENCE_ATTACHED" && e.roleKey === "CEO" && e.evidence["digest"] === attached.digest && e.evidence["payloadDigest"] === attached.content.sha256);
  if (!candidate || !stage?.sessionId || !attach?.sessionId || !artifactDigestMatches(candidate) || !artifactDigestMatches(attached)) throw new Error("review evidence receipt or artifact differs");
  const parsed = parseBundle(Buffer.from(candidate.content.bodyBase64, "base64").toString("utf8"), { ...attached.content, expectedSha256: attached.content.sha256 });
  if (!parsed.allowed) throw new Error(parsed.message);
  const record = { bundle: parsed.value, source: { bundleSha256: attached.content.sha256, candidateDigest: candidate.digest,
    attachmentDigest: attached.digest, stageEventId: stage.eventId, attachEventId: attach.eventId, stagedBy: stage.roleKey!,
    collectedBySessionId: stage.sessionId, attachedBySessionId: attach.sessionId, ceoBindingGeneration: attach.evidence["bindingGeneration"] as number } };
  return { ...record, digest: digestOf(record) };
}
export function frozenBootstrapReviewEvidence(content: unknown): FrozenReviewEvidence | null {
  const record = (content as { reviewEvidence?: FrozenReviewEvidence })?.reviewEvidence;
  if (!record) return null;
  const { digest, ...body } = record;
  if (digestOf(body) !== digest || !reviewEvidenceBundleSchema.safeParse(record.bundle).success) throw new Error("frozen review evidence differs");
  return record;
}

export async function originalReviewRecords(record: FrozenReviewEvidence | null,
  verify?: (file: ReviewEvidenceFile) => Promise<ReviewRecordVerification>) {
  if (!record) return null;
  const files = [];
  let apiFactBytes = 0;
  for (const { bodyBase64, ...file } of record.bundle.files) {
    const withheld = file.grade === "implementer-final-report";
    let verification = !withheld && verify && apiFactBytes < BOOTSTRAP_PLAN_MAX_BYTES ? await verify({ ...file, bodyBase64 })
      : { status: "attributed" as const, reason: "ACP has not independently verified this content", facts: [] };
    const factBytes = Buffer.byteLength(JSON.stringify(verification.facts));
    if (apiFactBytes + factBytes > BOOTSTRAP_PLAN_MAX_BYTES) verification = { status: "attributed", reason: "ACP API facts exceed the shared 128 KiB observation bound", facts: [] };
    else apiFactBytes += factBytes;
    files.push({ ...file, verification,
      ...(withheld ? { withheld: "producer self-assessment" } : { bodyBase64 }) });
  }
  return { source: record.source, bundleDigest: record.digest, missing: record.bundle.missing, files };
}
