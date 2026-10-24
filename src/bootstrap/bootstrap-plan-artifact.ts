import type { z } from "zod";
import { sha256 } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { artifactDigestMatches, type ArtifactStore, type StoredArtifact } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, Role, roleKeyFor, RunKind, RunState, type RunRow } from "../domain/types.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import type { HermesAdmittedTurn } from "../mcp/hermes-provenance.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { RunEngine } from "../run/run-engine.ts";
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
  planBody: string;
  expectedSha256: string;
  replacesSha256?: string;
}
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
const sameBinding = (a: PlanBinding, b: PlanBinding) =>
  Object.entries(bindingOf(a)).every(([key, value]) => b[key as keyof PlanBinding] === value);

/** CEO admission is separate from this check of the run's current owner and lifecycle. */
const currentRun = (source: Source, runId: string): Decision<RunRow> => {
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
  if (expected.runId !== run.runId || expected.contractDigest !== run.contractDigest || plan.requestDigest !== run.contractDigest
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

/** Decoding never reserializes JSON: read returns the very UTF-8 bytes attach hashed. */
export const readBootstrapPlanAttachment = (source: Source, runId: string): Decision<{ digest: string; planBody: string }> => {
  const run = currentRun(source, runId);
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
  const run = currentRun(source, input.runId);
  if (!run.allowed) return run;
  const frozen = source.bootstrapApplications.assertNotFrozen(input.runId, "plan_submit");
  if (!frozen.allowed) return frozen;
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

export const attachBootstrapPlan = (
  source: AttachSource, peer: AuthenticatedMcpPeer, turn: HermesAdmittedTurn | undefined, input: BootstrapPlanAttachInput,
): Decision<{ digest: string }> => source.db.txDecision(() => {
  const ceo = source.bindings.active(roleKeyFor(Role.CEO));
  if (!peer.sessionId || !peer.sessionIncarnation || !ceo || ceo.sessionId !== peer.sessionId
      || ceo.sessionIncarnation !== peer.sessionIncarnation || turn?.principal !== "owner") {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "attaching input requires the current CEO's authenticated Hermes owner turn");
  }
  // Canonical artifact JSON normalizes CR/CRLF. Identifiers must survive storage unchanged;
  // use ACP's C0/DEL exclusion for identifiers, without restricting the exact-bytes body.
  if (Object.values(bindingOf(input)).some(value => /[\x00-\x1f\x7f]/.test(value))) {
    return deny(ReasonCode.INVALID_ARGUMENT, "bootstrap PLAN binding identifiers must not contain control characters", {
      refusal: "BOOTSTRAP_PLAN_BINDING_INVALID",
    });
  }
  const admitted = assertBootstrapPlanAttachable(source, input);
  if (!admitted.allowed) return admitted;
  const run = admitted.value;
  const bytes = Buffer.from(input.planBody, "utf8");
  if (bytes.length > BOOTSTRAP_PLAN_MAX_BYTES || bytes.toString("utf8") !== input.planBody) {
    return deny(ReasonCode.INVALID_ARGUMENT, `PLAN input must be valid UTF-8 of at most ${BOOTSTRAP_PLAN_MAX_BYTES} bytes`);
  }
  if (sha256(bytes) !== input.expectedSha256) return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "PLAN input differs from expectedSha256");
  const parsed = parseBody(run, input.planBody, input);
  if (!parsed.allowed) return parsed;
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
      byteLength: bytes.length, bindingGeneration: ceo.bindingGeneration, hermesPrincipal: turn.principal } });
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
  if (!input.plan || !input.tasks) return deny(ReasonCode.INVALID_ARGUMENT, "plan_submit requires plan and tasks, or bootstrapPlanDigest");
  return allow(ReasonCode.OK, { plan: input.plan, tasks: input.tasks });
};
