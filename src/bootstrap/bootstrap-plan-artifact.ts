import type { z } from "zod";
import { digestOf, isDigest, sha256 } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { artifactDigestMatches, type ArtifactStore, type StoredArtifact } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, Role, roleKeyFor, RunKind, RunState, SessionLifecycle, type RoleBinding, type RunRow } from "../domain/types.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import type { HermesAdmittedTurn } from "../mcp/hermes-provenance.ts";
import { isTerminal } from "../domain/run-state.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { BootstrapApplications } from "./bootstrap-applications.ts";
import { bootstrapPlanInputSchema, type submittedTasksSchema } from "./plan-input-schema.ts";

// Leaves room for JSON escaping and the MCP envelope within the existing 1 MiB line limit.
export const BOOTSTRAP_PLAN_MAX_BYTES = 128 * 1024;
export const BOOTSTRAP_PLAN_INPUT_SCHEMA = "acp.bootstrap-plan-input.v1";
interface PlanBinding {
  runId: string;
  contractDigest: string;
  bootstrapOperationId: string;
  projectId: string;
  repositoryIdentity: string;
}
export interface BootstrapPlanAttachInput extends PlanBinding {
  planBody?: string;
  expectedSha256: string;
  replacesSha256?: string;
  stagedBy?: string;
}
export type BootstrapPlanStageInput = Omit<BootstrapPlanAttachInput, "replacesSha256" | "planBody" | "stagedBy"> & { planBody: string; idempotencyKey?: string };

interface PlanAttachment extends PlanBinding {
  schema: typeof BOOTSTRAP_PLAN_INPUT_SCHEMA;
  sha256: string;
  bodyBase64: string;
  replacesSha256: string | null;
}
interface Source {
  db: Db; artifacts: ArtifactStore; audit: AuditLog; runs: RunEngine; bindings: BindingRegistry;
}
type AttachSource = Source & { outbox: Outbox; bootstrapApplications: Pick<BootstrapApplications, "assertNotFrozen"> };
export const isBootstrapPlanAttachment = (content: unknown): content is PlanAttachment =>
  typeof content === "object" && content !== null && "schema" in content && content.schema === BOOTSTRAP_PLAN_INPUT_SCHEMA;

const attachmentsOf = (source: Source, runId: string) =>
  source.artifacts.list<PlanAttachment>(runId, ArtifactKind.HANDOFF).filter(a => isBootstrapPlanAttachment(a.content));
const attachmentOf = (source: Source, runId: string): StoredArtifact<PlanAttachment> | null =>
  attachmentsOf(source, runId).reverse().find(a => !a.superseded) ?? null;
// A damaged/missing subtype marker must not reopen the legacy body-submission path.
const hasAttachmentReceipt = (source: Source, runId: string): boolean =>
  source.audit.forRun(runId).some(e => e.kind === "BOOTSTRAP_PLAN_ATTACHED");
const bindingOf = (input: PlanBinding): PlanBinding => ({ runId: input.runId, contractDigest: input.contractDigest,
  bootstrapOperationId: input.bootstrapOperationId, projectId: input.projectId, repositoryIdentity: input.repositoryIdentity });

/** Validate inside authenticated MCP authority checks, rather than emitting SDK schema errors. */
export const validateBootstrapPlanDigests = (input: Record<string, string | undefined>): Decision<void> => {
  const values = Object.values(input).filter(value => value !== undefined);
  if (values.some(value => /[\x00-\x1f\x7f]/.test(value))) {
    return deny(ReasonCode.INVALID_ARGUMENT, "bootstrap PLAN binding identifiers must not contain control characters", {
      refusal: "BOOTSTRAP_PLAN_BINDING_INVALID",
    });
  }
  if (values.some(value => !isDigest(value))) {
    return deny(ReasonCode.INVALID_ARGUMENT, "bootstrap PLAN digests must use sha256 followed by 64 lowercase hexadecimal digits", {
      refusal: "BOOTSTRAP_PLAN_DIGEST_INVALID",
    });
  }
  return allow(ReasonCode.OK, undefined);
};
const sameBinding = (a: PlanBinding, b: PlanBinding) =>
  Object.entries(bindingOf(a)).every(([key, value]) => b[key as keyof PlanBinding] === value);

/** CEO admission is separate from this check of the run's current owner and lifecycle. */
export const currentBootstrapInputRun = (source: Source, runId: string): Decision<RunRow> => {
  const run = source.runs.get(runId);
  if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run");
  if (run.kind !== RunKind.PROJECT_BOOTSTRAP) return deny(ReasonCode.INVALID_ARGUMENT, "PLAN input requires a PROJECT_BOOTSTRAP run");
  if (![RunState.QUEUED, RunState.ACTIVE, RunState.BLOCKED, RunState.REVISION_REQUIRED,
    RunState.READY_FOR_CEO_REVIEW, RunState.AWAITING_HUMAN].some(state => state === run.state)) {
    return deny(ReasonCode.CONFLICT, "this run no longer accepts bootstrap input access");
  }
  if (!run.ownerSessionId) return run.state === RunState.QUEUED
    ? allow(ReasonCode.OK, run) : deny(ReasonCode.RUN_OWNER_NOT_PINNED, "bootstrap run has no current owner");
  const binding = run.ownerRoleKey ? source.bindings.active(run.ownerRoleKey) : null;
  if (!binding || binding.sessionId !== run.ownerSessionId || binding.sessionIncarnation !== run.ownerSessionIncarnation
      || binding.bindingGeneration !== run.ownerBindingGeneration) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "bootstrap run owner is no longer current");
  }
  return allow(ReasonCode.OK, run);
};

const parseBody = (run: RunRow, body: string, expected: PlanBinding) => {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return deny(ReasonCode.INVALID_ARGUMENT, "PLAN input must be JSON containing runId, plan and tasks"); }
  const parsed = bootstrapPlanInputSchema.safeParse(value);
  if (!parsed.success || parsed.data.runId !== run.runId) return deny(ReasonCode.INVALID_ARGUMENT, "PLAN input must contain this runId and a valid plan and task graph");
  const plan = parsed.data.plan;
  const manifest = plan.projectManifest;
  const repositories = manifest?.["repositories"];
  const operations = plan.githubOperations;
  if (expected.runId !== run.runId || expected.contractDigest !== run.contractDigest
      || plan.bootstrapOperationId !== expected.bootstrapOperationId || manifest?.["projectId"] !== expected.projectId
      || (run.projectId !== null && run.projectId !== expected.projectId)
      || (run.pinnedManifestDigest !== null && plan.projectManifestDigest !== run.pinnedManifestDigest)
      || !Array.isArray(repositories) || repositories.length !== 1 || repositories[0]?.remote !== expected.repositoryIdentity
      || !operations?.length || operations[0]?.resourceType !== "repository" || operations[0]?.resourceIdentity !== expected.repositoryIdentity
      || operations.some(op => op.resourceIdentity !== expected.repositoryIdentity && !op.resourceIdentity.startsWith(`${expected.repositoryIdentity}#`))) {
    return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "PLAN input differs from its run, contract, operation or project/repository binding");
  }
  return allow(ReasonCode.OK, parsed.data);
};

export const BOOTSTRAP_PLAN_CANDIDATE_SCHEMA = "acp.bootstrap-plan-candidate.v1";
interface PlanCandidate extends PlanBinding {
  schema: typeof BOOTSTRAP_PLAN_CANDIDATE_SCHEMA;
  sha256: string;
  bodyBase64: string;
  stagedBy: string;
}
/** Both input subtypes share HANDOFF storage but are never activation handoff packages. */
export const isBootstrapPlanInputArtifact = (content: unknown): boolean => isBootstrapPlanAttachment(content)
  || (typeof content === "object" && content !== null && "schema" in content && (content.schema === BOOTSTRAP_PLAN_CANDIDATE_SCHEMA || content.schema === "acp.bootstrap-review-evidence-candidate.v1" || content.schema === "acp.bootstrap-review-evidence-attached.v1" || content.schema === "acp.bootstrap-review-context.v1"));
const candidatesOf = (source: Source, runId: string, stagedBy: string) => source.artifacts.list<PlanCandidate>(runId, ArtifactKind.HANDOFF)
  .filter(a => a.content?.schema === BOOTSTRAP_PLAN_CANDIDATE_SCHEMA && a.content.stagedBy === stagedBy);
const selectedStager = (stagedBy: string | undefined): Decision<string> => {
  if (stagedBy !== undefined && /[\x00-\x1f\x7f]/.test(stagedBy)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "bootstrap PLAN binding identifiers must not contain control characters", {
      refusal: "BOOTSTRAP_PLAN_BINDING_INVALID",
    });
  }
  if (!stagedBy?.startsWith("PRIMARY_CTO:") || stagedBy === "PRIMARY_CTO:") {
    return deny(ReasonCode.INVALID_ARGUMENT, "digest-only attach requires stagedBy in PRIMARY_CTO:<projectId> format");
  }
  return allow(ReasonCode.OK, stagedBy);
};
const validIdentifiers = (input: PlanBinding): Decision<void> => Object.values(bindingOf(input)).some(value => /[\x00-\x1f\x7f]/.test(value))
  ? deny(ReasonCode.INVALID_ARGUMENT, "bootstrap PLAN binding identifiers must not contain control characters", {
    refusal: "BOOTSTRAP_PLAN_BINDING_INVALID",
  }) : allow(ReasonCode.OK, undefined);
const validateBody = (run: RunRow, body: string, input: PlanBinding & { expectedSha256: string }): Decision<Buffer> => {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > BOOTSTRAP_PLAN_MAX_BYTES || bytes.toString("utf8") !== body) {
    return deny(ReasonCode.INVALID_ARGUMENT, `PLAN input must be valid UTF-8 of at most ${BOOTSTRAP_PLAN_MAX_BYTES} bytes`);
  }
  if (sha256(bytes) !== input.expectedSha256) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "PLAN input differs from expectedSha256");
  const parsed = parseBody(run, body, input);
  return parsed.allowed ? allow(ReasonCode.OK, bytes) : parsed;
};
const readCandidate = (source: Source, run: RunRow, input: PlanBinding & { expectedSha256: string; stagedBy?: string }): Decision<string> => {
  // Always run-scoped. A digest is never a global artifact lookup capability.
  const stager = selectedStager(input.stagedBy);
  if (!stager.allowed) return stager;
  const candidates = candidatesOf(source, run.runId, stager.value).filter(a => a.content.sha256 === input.expectedSha256);
  const candidate = candidates[0];
  if (!candidate) return deny(ReasonCode.NOT_FOUND, "the named run/stager slot has no candidate with expectedSha256");
  const body = Buffer.from(candidate.content.bodyBase64, "base64");
  const receipt = source.audit.forRun(run.runId).some(e => e.kind === "BOOTSTRAP_PLAN_STAGED" && e.roleKey === stager.value
    && e.evidence["digest"] === candidate.digest && e.evidence["payloadDigest"] === input.expectedSha256);
  if (candidates.length !== 1 || candidate.superseded || !receipt || !artifactDigestMatches(candidate)
      || body.toString("base64") !== candidate.content.bodyBase64 || sha256(body) !== input.expectedSha256
      || !Buffer.from(body.toString("utf8"), "utf8").equals(body)) {
    return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "staged PLAN candidate fails its receipt or exact-byte hash");
  }
  if (!sameBinding(candidate.content, input)) {
    return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "staged PLAN candidate differs from current run bindings");
  }
  const checked = validateBody(run, body.toString("utf8"), input);
  return checked.allowed ? allow(ReasonCode.OK, body.toString("utf8")) : checked;
};

type StageSource = AttachSource & { sessions: Pick<SessionRegistry, "get"> };
/** Shared current PRIMARY_CTO admission for the two bounded bootstrap uploads. */
export const bootstrapStagingIdentity = (source: StageSource, peer: AuthenticatedMcpPeer): Decision<RoleBinding> => {
  const session = peer.sessionId ? source.sessions.get(peer.sessionId) : null;
  if (!peer.sessionId || !peer.sessionIncarnation || session?.incarnation !== peer.sessionIncarnation || session.lifecycle !== SessionLifecycle.READY) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "staging requires a current PRIMARY_CTO session");
  }
  if (!peer.binding) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "staging requires an authenticated PRIMARY_CTO binding");
  }
  const primary = source.bindings.active(peer.binding.roleKey);
  if (primary?.role !== Role.PRIMARY_CTO || !primary.projectId
      || primary.roleKey !== roleKeyFor(Role.PRIMARY_CTO, { projectId: primary.projectId })
      || primary.sessionId !== peer.sessionId || primary.sessionIncarnation !== peer.sessionIncarnation
      || primary.bindingGeneration !== peer.binding.bindingGeneration) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "staging requires the project's current PRIMARY_CTO binding");
  }
  return allow(ReasonCode.OK, primary);
};

/**
 * No provenance links a PRIMARY_CTO to a project-less bootstrap run. This is a non-authoritative
 * upload of immutable candidates, with at most one unattached candidate per stager. Only CEO attach selects run input;
 * neither the stager's generation nor the run's owner pin is part of the candidate's identity.
 */
export const bootstrapPlanStageAccess = (source: StageSource, peer: AuthenticatedMcpPeer, input: BootstrapPlanStageInput)
  : Decision<{ run: RunRow; primary: RoleBinding; bytes: Buffer }> => {
  const identity = bootstrapStagingIdentity(source, peer);
  if (!identity.allowed) return identity;
  const primary = identity.value;
  const stager = selectedStager(primary.roleKey);
  if (!stager.allowed) return stager;
  const identifiers = validIdentifiers(input);
  if (!identifiers.allowed) return identifiers;
  if (input.idempotencyKey !== undefined && /[\x00-\x1f\x7f]/.test(input.idempotencyKey)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "bootstrap PLAN binding identifiers must not contain control characters", {
      refusal: "BOOTSTRAP_PLAN_BINDING_INVALID",
    });
  }
  const digests = validateBootstrapPlanDigests({ contractDigest: input.contractDigest, expectedSha256: input.expectedSha256 });
  if (!digests.allowed) return digests;
  const current = currentBootstrapInputRun(source, input.runId);
  if (!current.allowed) return current;
  const run = current.value;
  if (run.projectId !== null || !run.ownerSessionId || run.ownerRoleKey !== roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId })) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "staging requires a project-less bootstrap run with its current run-scoped owner");
  }
  const checked = validateBody(run, input.planBody, input);
  if (!checked.allowed) return checked;
  const candidates = candidatesOf(source, run.runId, primary.roleKey);
  const audit = source.audit.forRun(run.runId);
  if (!candidates.length && audit.some(e => e.kind === "BOOTSTRAP_PLAN_STAGED" && e.roleKey === primary.roleKey)) {
    return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "recorded staged PLAN candidate is missing or damaged");
  }
  if (candidates.some(a => a.content.sha256 === input.expectedSha256)) {
    const prior = readCandidate(source, run, { ...input, stagedBy: primary.roleKey });
    if (!prior.allowed) return prior;
    if (prior.value !== input.planBody) return deny(ReasonCode.CONFLICT, "staged PLAN candidate bytes differ");
  } else {
    const prior = attachmentOf(source, run.runId);
    const attachments = attachmentsOf(source, run.runId);
    if (candidates.length && (!prior || candidates.some(candidate => !attachments.some(a =>
      a.content.sha256 === candidate.content.sha256 && a.content.bodyBase64 === candidate.content.bodyBase64
      && sameBinding(a.content, candidate.content) && artifactDigestMatches(a)
      && audit.some(e => e.kind === "BOOTSTRAP_PLAN_ATTACHED" && e.roleKey === roleKeyFor(Role.CEO)
        && e.evidence["digest"] === a.digest && e.evidence["payloadDigest"] === candidate.content.sha256))))) {
      return deny(ReasonCode.CONFLICT, "this stager already has a different immutable candidate for this run");
    }
    if (prior) {
      // Reuse attach's current-run, frozen, lifecycle and replacement binding checks.
      const attachable = assertBootstrapPlanAttachable(source, { ...input, replacesSha256: prior.content.sha256 });
      if (!attachable.allowed) return attachable;
    } else {
      const frozen = source.bootstrapApplications.assertNotFrozen(run.runId, "plan_submit");
      if (!frozen.allowed) return frozen;
      if (![RunState.ACTIVE, RunState.BLOCKED].some(state => state === run.state) || source.artifacts.latest(run.runId, ArtifactKind.PLAN)) {
        return deny(ReasonCode.CONFLICT, "this run no longer accepts initial PLAN staging");
      }
    }
  }
  return allow(ReasonCode.OK, { run, primary, bytes: checked.value });
};

export const stageBootstrapPlan = (source: StageSource, peer: AuthenticatedMcpPeer, input: BootstrapPlanStageInput)
  : Decision<{ digest: string; stagedBy: string }> => source.db.txDecision(() => {
  const checked = bootstrapPlanStageAccess(source, peer, input);
  if (!checked.allowed) return checked;
  const { run, primary, bytes } = checked.value;
  if (candidatesOf(source, input.runId, primary.roleKey).some(a => a.content.sha256 === input.expectedSha256)) {
    return allow(ReasonCode.OK, { digest: input.expectedSha256, stagedBy: primary.roleKey });
  }
  const artifact = source.artifacts.put(run.runId, ArtifactKind.HANDOFF, {
    schema: BOOTSTRAP_PLAN_CANDIDATE_SCHEMA, ...bindingOf(input), sha256: input.expectedSha256,
    bodyBase64: bytes.toString("base64"), stagedBy: primary.roleKey,
  });
  const audit = source.audit.record({ kind: "BOOTSTRAP_PLAN_STAGED", runId: run.runId, sessionId: peer.sessionId,
    roleKey: primary.roleKey, evidence: { digest: artifact.digest, payloadDigest: input.expectedSha256,
      contractDigest: input.contractDigest, operationId: input.bootstrapOperationId, projectId: input.projectId,
      repositoryIdentity: input.repositoryIdentity, byteLength: bytes.length, bindingGeneration: primary.bindingGeneration,
      stagedBy: primary.roleKey } });
  if (!audit.allowed) return audit;
  return allow(ReasonCode.OK, { digest: input.expectedSha256, stagedBy: primary.roleKey });
});

/** Decoding never reserializes JSON: read returns the very UTF-8 bytes attach hashed. */
export const readBootstrapPlanAttachment = (source: Source, runId: string): Decision<{ digest: string; planBody: string }> => {
  const run = currentBootstrapInputRun(source, runId);
  if (!run.allowed) return run;
  const artifact = attachmentOf(source, runId);
  if (!artifact) return hasAttachmentReceipt(source, runId)
    ? deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "recorded bootstrap input is missing or damaged")
    : deny(ReasonCode.NOT_FOUND, "this run has no current bootstrap PLAN input");
  const body = Buffer.from(artifact.content.bodyBase64, "base64");
  const receipt = source.audit.forRun(runId).some(e => e.kind === "BOOTSTRAP_PLAN_ATTACHED"
    && e.evidence["digest"] === artifact.digest && e.evidence["payloadDigest"] === artifact.content.sha256);
  if (!receipt || !artifactDigestMatches(artifact) || body.toString("base64") !== artifact.content.bodyBase64
      || sha256(body) !== artifact.content.sha256 || !Buffer.from(body.toString("utf8"), "utf8").equals(body)) {
    return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "bootstrap PLAN input fails its attachment receipt or exact-byte hash");
  }
  const parsed = parseBody(run.value, body.toString("utf8"), artifact.content);
  return parsed.allowed ? allow(ReasonCode.OK, { digest: artifact.content.sha256, planBody: body.toString("utf8") }) : parsed;
};

/** Runs inside MCP authority evaluation too, so a cached success cannot skip current checks. */
export const bootstrapPlanAttachAccess = (source: AttachSource, input: BootstrapPlanAttachInput): Decision<RunRow> => {
  const run = currentBootstrapInputRun(source, input.runId);
  if (!run.allowed) return run;
  const frozen = source.bootstrapApplications.assertNotFrozen(input.runId, "plan_submit");
  if (!frozen.allowed) return frozen;
  if (input.planBody === undefined) {
    const identifiers = validIdentifiers(input);
    if (!identifiers.allowed) return identifiers;
    const staged = readCandidate(source, run.value, input);
    if (!staged.allowed) return staged;
  }
  const prior = attachmentOf(source, input.runId);
  if (!prior && hasAttachmentReceipt(source, input.runId)) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "recorded bootstrap input is missing or damaged");
  if (prior) {
    const read = readBootstrapPlanAttachment(source, input.runId);
    if (!read.allowed) return read;
    if (input.expectedSha256 !== read.value.digest && input.replacesSha256 !== read.value.digest) {
      return deny(ReasonCode.CONFLICT, "different input requires replacesSha256 naming the current attachment");
    }
  }
  return run;
};

const assertBootstrapPlanAttachable = (source: AttachSource, input: BootstrapPlanAttachInput): Decision<RunRow> => {
  const run = bootstrapPlanAttachAccess(source, input);
  if (!run.allowed) return run;
  if (input.contractDigest !== run.value.contractDigest) return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "attachment contract is no longer current");
  const prior = attachmentOf(source, input.runId);
  if (prior && !sameBinding(prior.content, input)) return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "replacement cannot retarget a bootstrap input binding");
  return run;
};

/** The complete attachment identity check also runs before MCP argument validation and replay. */
export const bootstrapPlanAttachAuthority = (
  source: Pick<Source, "bindings">, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined,
): Decision<{ ceo: RoleBinding; turn: HermesAdmittedTurn }> => {
  const ceo = source.bindings.active(roleKeyFor(Role.CEO));
  if (!peer.sessionId || !peer.sessionIncarnation || !ceo || ceo.sessionId !== peer.sessionId
      || ceo.sessionIncarnation !== peer.sessionIncarnation || (turn?.principal !== "owner" && turn?.principal !== "peer")) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "attaching input requires the current CEO's authenticated Hermes owner or peer turn");
  }
  return allow(ReasonCode.OK, { ceo, turn });
};

export const attachBootstrapPlan = (
  source: AttachSource, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: BootstrapPlanAttachInput,
): Decision<{ digest: string }> => source.db.txDecision(() => {
  const identity = bootstrapPlanAttachAuthority(source, peer, turn);
  if (!identity.allowed) return identity;
  const { ceo, turn: ownerTurn } = identity.value;
  // Canonical artifact JSON normalizes CR/CRLF. Identifiers must survive storage unchanged;
  // use ACP's C0/DEL exclusion for identifiers, without restricting the exact-bytes body.
  const identifiers = validIdentifiers(input);
  if (!identifiers.allowed) return identifiers;
  const digests = validateBootstrapPlanDigests({ contractDigest: input.contractDigest,
    expectedSha256: input.expectedSha256, replacesSha256: input.replacesSha256 });
  if (!digests.allowed) return digests;
  const admitted = assertBootstrapPlanAttachable(source, input);
  if (!admitted.allowed) return admitted;
  const run = admitted.value;
  const body = input.planBody === undefined ? readCandidate(source, run, input) : allow(ReasonCode.OK, input.planBody);
  if (!body.allowed) return body;
  const checked = validateBody(run, body.value, input);
  if (!checked.allowed) return checked;
  const bytes = checked.value;
  const prior = attachmentOf(source, run.runId);
  if (prior?.content.sha256 === input.expectedSha256) {
    if (!bytes.equals(Buffer.from(prior.content.bodyBase64, "base64"))) return deny(ReasonCode.CONFLICT, "attachment bytes differ");
    return allow(ReasonCode.OK, { digest: input.expectedSha256 });
  }
  if (!prior && (input.replacesSha256 !== undefined || source.artifacts.latest(run.runId, ArtifactKind.PLAN)
      || ![RunState.QUEUED, RunState.ACTIVE, RunState.BLOCKED].some(state => state === run.state))) {
    return deny(ReasonCode.CONFLICT, "this run no longer accepts an initial PLAN input");
  }
  if (attachmentsOf(source, run.runId).some(a => a.content.sha256 === input.expectedSha256)) {
    return deny(ReasonCode.CONFLICT, "a superseded input cannot be made current again");
  }
  if (prior) {
    // Existing invalidation withdraws candidate-bound review/approval authority atomically.
    const invalidated = source.runs.invalidateCandidate(run.runId, "CEO explicitly replaced bootstrap input", { payloadDigest: input.expectedSha256 });
    if (!invalidated.allowed) return invalidated;
    source.artifacts.supersede(run.runId, ArtifactKind.HANDOFF, prior.digest);
    const plan = source.artifacts.latest(run.runId, ArtifactKind.PLAN);
    if (plan) source.artifacts.supersede(run.runId, ArtifactKind.PLAN, plan.digest);
  }
  const artifact = source.artifacts.put(run.runId, ArtifactKind.HANDOFF, {
    schema: BOOTSTRAP_PLAN_INPUT_SCHEMA, ...bindingOf(input), sha256: input.expectedSha256,
    bodyBase64: bytes.toString("base64"), replacesSha256: input.replacesSha256 ?? null,
  });
  const binding = run.ownerRoleKey ? source.bindings.active(run.ownerRoleKey) : null;
  if (binding) {
    const queued = source.outbox.enqueue({ idempotencyKey: `bootstrap-plan-input:${run.runId}:${input.expectedSha256}`,
      roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration, targetSessionId: binding.sessionId,
      runId: run.runId, kind: MessageKind.RUN_DISPATCH,
      payload: { runId: run.runId, bootstrapPlanDigest: input.expectedSha256,
        directive: "Read bootstrap_plan_get, then plan_submit with idempotencyKey, runId and bootstrapPlanDigest. Resolve any escalation or redispatch a revision first. Input delivery is not execution approval; result_submit, blind review and CEO CONFIRM are still required." } });
    if (!queued.allowed) return queued;
  }
  const audit = source.audit.record({ kind: "BOOTSTRAP_PLAN_ATTACHED", runId: run.runId, sessionId: peer.sessionId,
    roleKey: ceo.roleKey, evidence: { digest: artifact.digest, payloadDigest: input.expectedSha256,
      contractDigest: input.contractDigest, operationId: input.bootstrapOperationId, projectId: input.projectId,
      repositoryIdentity: input.repositoryIdentity, replacesSha256: input.replacesSha256 ?? null,
      byteLength: bytes.length, bindingGeneration: ceo.bindingGeneration, hermesPrincipal: ownerTurn.principal,
      ...(ownerTurn.principal === "peer" ? { hermesPeerGrant: ownerTurn.peerGrant } : {}) } });
  return audit.allowed ? allow(ReasonCode.OK, { digest: input.expectedSha256 }) : audit;
});

/** Bind mutation fingerprints to current input without validating changed arguments before replay lookup. */
export const bootstrapInputMutationAuthority = (source: Source, runId: string, result: boolean): Decision<Record<string, unknown>> => {
  if (!hasAttachmentReceipt(source, runId) && !attachmentsOf(source, runId).length) return allow(ReasonCode.OK, {});
  const read = readBootstrapPlanAttachment(source, runId);
  if (!read.allowed) return read;
  if (result) {
    const plan = source.artifacts.latest<{ bootstrapPlanDigest?: string }>(runId, ArtifactKind.PLAN);
    if (plan?.content.bootstrapPlanDigest !== read.value.digest) {
      return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "current bootstrap input must be submitted before its result can be reviewed");
    }
  } else if (source.runs.require(runId).state !== RunState.ACTIVE) {
    return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "input submission requires an ACTIVE run");
  }
  return allow(ReasonCode.OK, { bootstrapPlanDigest: read.value.digest });
};

/** The exact-byte reference resolves both PLAN and tasks; ordinary semantic checks follow unchanged. */
export const resolveBootstrapPlanInput = (
  source: Source, runId: string,
  input: { bootstrapPlanDigest?: string; plan?: Record<string, unknown>; tasks?: z.infer<typeof submittedTasksSchema> },
): Decision<{ plan: Record<string, unknown>; tasks: z.infer<typeof submittedTasksSchema>; bootstrapPlanDigest?: string }> => {
  if (hasAttachmentReceipt(source, runId) || attachmentsOf(source, runId).length || input.bootstrapPlanDigest !== undefined) {
    if (input.plan !== undefined || input.tasks !== undefined) return deny(ReasonCode.INVALID_ARGUMENT, "attached input is submitted by digest reference only, without plan or tasks");
    const read = readBootstrapPlanAttachment(source, runId);
    if (!read.allowed) return read;
    if (input.bootstrapPlanDigest !== read.value.digest) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "submitted exact-byte reference differs from current input");
    if (source.runs.require(runId).state !== RunState.ACTIVE) return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "input submission requires an ACTIVE run; resolve any escalation or redispatch the revision first");
    const parsed = bootstrapPlanInputSchema.parse(JSON.parse(read.value.planBody));
    return allow(ReasonCode.OK, { plan: parsed.plan, tasks: parsed.tasks, bootstrapPlanDigest: read.value.digest });
  }
  // #1240 — a PLAN that declares work units may re-link the run's existing tasks without adding any.
  if (!input.plan || (!input.tasks && input.plan["workUnits"] === undefined)) return deny(ReasonCode.INVALID_ARGUMENT, "plan_submit requires plan and tasks, or bootstrapPlanDigest");
  return allow(ReasonCode.OK, { plan: input.plan, tasks: input.tasks ?? [] });
};

export interface BootstrapReviewResumeInput {
  idempotencyKey: string;
  runId: string;
  contractDigest: string;
  bootstrapPlanDigest: string;
  ownerSessionId: string;
  ownerSessionIncarnation: string;
  ownerBindingGeneration: number;
}

/** Exact attachment identity and bytes, also checked at outbox receipt/claim and handover. */
export const resumeReviewAttachmentMatches = (
  db: Pick<Db, "get" | "all">, runId: string, payload: unknown,
): boolean => {
  try {
    const p = payload as { runId: string; contractDigest: string; bootstrapPlanDigest: string; attachmentDigest: string };
    if (p.runId !== runId) return false;
    const run = db.get<{ contract_digest: string }>("SELECT contract_digest FROM runs WHERE run_id = ?", [runId]);
    if (!run || run.contract_digest !== p.contractDigest) return false;
    const rows = db.all<{ digest: string; content_json: string }>(
      `SELECT digest, content_json FROM run_artifacts WHERE run_id = ? AND kind = 'HANDOFF' AND superseded = 0
        ORDER BY created_at DESC, rowid DESC`, [runId]);
    const attachments = rows.map(a => ({ digest: a.digest, content: JSON.parse(a.content_json) as PlanAttachment }))
      .filter(a => isBootstrapPlanAttachment(a.content));
    if (attachments.length !== 1) return false;
    const a = attachments[0]!;
    const bytes = Buffer.from(a.content.bodyBase64, "base64");
    return a.digest === p.attachmentDigest && digestOf(a.content) === a.digest
      && a.content.runId === runId && a.content.contractDigest === p.contractDigest
      && a.content.sha256 === p.bootstrapPlanDigest && sha256(bytes) === p.bootstrapPlanDigest
      && bytes.toString("base64") === a.content.bodyBase64
      && Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)
      && JSON.parse(bytes.toString("utf8")).runId === runId
      && !!db.get(`SELECT 1 FROM audit_events WHERE run_id = ? AND kind = 'BOOTSTRAP_PLAN_ATTACHED'
        AND json_extract(evidence_json, '$.digest') = ? AND json_extract(evidence_json, '$.payloadDigest') = ?`,
      [runId, a.digest, p.bootstrapPlanDigest]);
  } catch { return false; }
};

/** Admission is repeated inside the atomic decision/enqueue transaction. No state transition. */
export const bootstrapReviewResumeAccess = (source: Source, input: BootstrapReviewResumeInput): Decision<RunRow> => {
  const digests = validateBootstrapPlanDigests({ contractDigest: input.contractDigest, bootstrapPlanDigest: input.bootstrapPlanDigest });
  if (!digests.allowed) return digests;
  const run = source.runs.get(input.runId);
  if (!run) return deny(ReasonCode.NOT_FOUND, "unknown resume-review run");
  if (isTerminal(run.state)) return deny(ReasonCode.RUN_ALREADY_TERMINAL, "resume review requires a live run");
  if (run.kind !== RunKind.PROJECT_BOOTSTRAP) return deny(ReasonCode.INVALID_ARGUMENT, "resume review requires a PROJECT_BOOTSTRAP run");
  if (run.state !== RunState.ACTIVE) return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "resume review requires an ACTIVE run");
  if (run.contractDigest !== input.contractDigest) return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "resume-review contract is no longer current");
  const binding = run.ownerRoleKey ? source.bindings.active(run.ownerRoleKey) : null;
  if (!binding || binding.sessionId !== run.ownerSessionId || binding.sessionIncarnation !== run.ownerSessionIncarnation
      || binding.bindingGeneration !== run.ownerBindingGeneration || binding.sessionId !== input.ownerSessionId
      || binding.sessionIncarnation !== input.ownerSessionIncarnation || binding.bindingGeneration !== input.ownerBindingGeneration) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "resume-review owner session, incarnation or generation is stale");
  }
  const attachment = readBootstrapPlanAttachment(source, run.runId);
  if (!attachment.allowed || attachment.value.digest !== input.bootstrapPlanDigest) {
    return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "resume review requires the current, intact attached PLAN digest");
  }
  return allow(ReasonCode.OK, run);
};

type ResumeReviewResult = { runId: string; bootstrapPlanDigest: string; messageId: string };
const resumeReviewKey = (peer: AuthenticatedMcpPeer, input: BootstrapReviewResumeInput) =>
  `bootstrap-review-resume:${sha256(JSON.stringify({ sessionId: peer.sessionId, idempotencyKey: input.idempotencyKey }))}`;

/** Recover the committed instruction when the shared MCP response store failed after commit. */
export const replayBootstrapReviewResume = (
  source: Source & { outbox: Outbox }, peer: AuthenticatedMcpPeer, input: BootstrapReviewResumeInput, mcpFingerprint: string,
): Decision<ResumeReviewResult> | null => {
  const prior = source.outbox.byIdempotencyKey(resumeReviewKey(peer, input));
  if (!prior) return null;
  const recorded = source.audit.forRun(input.runId).some(a => a.kind === "CEO_DECISION"
    && a.evidence["instruction"] === "RESUME_REVIEW" && a.evidence["messageId"] === prior.messageId
    && a.evidence["requestDigest"] === digestOf(input) && a.evidence["mcpFingerprint"] === mcpFingerprint);
  return recorded ? allow(ReasonCode.OK, { runId: input.runId, bootstrapPlanDigest: input.bootstrapPlanDigest, messageId: prior.messageId })
    : deny(ReasonCode.CONFLICT, "resume-review key belongs to another request or principal");
};

export const resumeBootstrapReview = (
  source: Source & { outbox: Outbox }, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined,
  input: BootstrapReviewResumeInput, mcpFingerprint: string,
): Decision<ResumeReviewResult> => source.db.txDecision(() => {
  const identity = bootstrapPlanAttachAuthority(source, peer, turn);
  if (!identity.allowed) return identity;
  const admitted = bootstrapReviewResumeAccess(source, input);
  if (!admitted.allowed) return admitted;
  const run = admitted.value;
  const attachment = attachmentOf(source, run.runId)!;
  const replay = replayBootstrapReviewResume(source, peer, input, mcpFingerprint);
  if (replay) return replay;
  // As with ordinary outbox enqueue, distinct keys create distinct instructions, even while pending.
  const queued = source.outbox.enqueue({ idempotencyKey: resumeReviewKey(peer, input), roleKey: run.ownerRoleKey!,
    bindingGeneration: run.ownerBindingGeneration!, targetSessionId: run.ownerSessionId!, runId: run.runId,
    kind: MessageKind.RESUME_REVIEW,
    payload: { intent: "RESUME_REVIEW", runId: run.runId, contractDigest: input.contractDigest,
      bootstrapPlanDigest: input.bootstrapPlanDigest, attachmentDigest: attachment.digest,
      directive: "Resume review only: read bootstrap_plan_get and verify bootstrapPlanDigest is still current, then plan_submit with idempotencyKey, runId and bootstrapPlanDigest, followed by result_submit for a new blind review. Acknowledge this message with run_ack after handling it; deduplicate effects by messageId. If the digest changed, this instruction is void. This is not CONFIRM, not genesis or workflow approval, not a review PASS, and grants no execution authority. Blind review and CEO CONFIRM are still required." } });
  if (!queued.allowed) return queued;
  const audit = source.audit.record({ kind: "CEO_DECISION", runId: run.runId, projectId: run.projectId,
    sessionId: peer.sessionId, roleKey: identity.value.ceo.roleKey,
    evidence: { instruction: "RESUME_REVIEW", messageId: queued.value.messageId, requestDigest: digestOf(input), mcpFingerprint,
      contractDigest: input.contractDigest, payloadDigest: input.bootstrapPlanDigest, digest: attachment.digest,
      ownerSessionId: input.ownerSessionId, ownerSessionIncarnation: input.ownerSessionIncarnation,
      ownerBindingGeneration: input.ownerBindingGeneration, bindingGeneration: identity.value.ceo.bindingGeneration,
      hermesPrincipal: identity.value.turn.principal, hermesPeerGrant: identity.value.turn.peerGrant } });
  return audit.allowed ? allow(ReasonCode.OK, { runId: run.runId, bootstrapPlanDigest: input.bootstrapPlanDigest, messageId: queued.value.messageId }) : audit;
});
