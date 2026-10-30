import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * #1189 B1 (CEO ruling 3) — OWNER_DECISION_REQUIRED stays available on every run, with or without a
 * human gate, but it hands the run to the owner only for a reason the owner alone can answer, and it
 * names the action that reason blocks.
 *
 * The owner-only reasons are PRD §21's human-gate list, the existing authority model: the CEO cannot
 * take these decisions in the owner's place (CP-HI-07). The first three are the destructive-action
 * triggers `deriveHumanGate` already classifies.
 */
export const OWNER_ONLY_REASONS = {
  /** §21 비가역 Production Action. */
  IRREVERSIBLE_PRODUCTION_ACTION: "an irreversible production action",
  /** §21 파괴적 Data Migration/Delete. */
  DATA_LOSS: "a destructive data migration or delete",
  /** §21 Project 폐기. */
  PROJECT_DECOMMISSION: "a project decommission",
  /** §21 Security/Permission Boundary 확대. */
  PERMISSION_OR_AUTHORITY_CHANGE: "a security, permission or authority boundary expansion",
  /** §21 Public API/Protocol Breaking Change. */
  PUBLIC_API_BREAKING_CHANGE: "a public API or protocol breaking change",
  /** §21 제품 핵심 방향 변경 — a direction the approved contract does not already cover. */
  DIRECTION_CHANGE_OUTSIDE_CONTRACT: "a product direction change outside the approved contract",
  /** §21 큰 신규 비용·Paid Plan 변경. */
  NEW_COST_OR_PAID_PLAN: "a large new cost or a paid plan change",
  /** §21 Capacity 기반 Project Suspend. */
  CAPACITY_PROJECT_SUSPEND: "a capacity-driven project suspension",
  /** §21 Quality Gate Reduction Exception. */
  QUALITY_GATE_REDUCTION: "a quality gate reduction exception",
  /** §21 사전 위임되지 않은 Public/Release. */
  UNDELEGATED_PUBLIC_RELEASE: "a public release that was not delegated in advance",
} as const;
export type OwnerOnlyReason = keyof typeof OWNER_ONLY_REASONS;

/**
 * Judgements the CEO's own authority closes, each with the CEO path that closes it. §21: "the agent is
 * not sure" is not a human-gate reason, and what Hermes can judge within its authority Hermes closes;
 * §19.2 the candidate decision, §20 the CTO's escalations and §22 run priority are the CEO's. Naming one
 * of these as an owner decision is refused with the path, so the owner is never handed a CEO judgement.
 */
export const CEO_SCOPE_JUDGEMENTS = {
  CANDIDATE_QUALITY: "ceo_decision_submit CONFIRM or FINAL_REVISE (§19.2)",
  TECHNICAL_APPROACH: "escalation_resolve, or FINAL_REVISE with the direction (§20)",
  PRIORITY: "run priority is the CEO's to set (§22)",
  UNCERTAINTY: "uncertainty is not a human-gate reason; the CEO decides within its authority (§21)",
  RETRY_OR_RECOVERY: "run_dispatch, repair_execute or cto_replace",
  STAFFING: "cto_replace",
  CANCELLATION: "FINAL_REVISE, then run_cancel",
} as const;
export type CeoScopeJudgement = keyof typeof CEO_SCOPE_JUDGEMENTS;

/** The bound on the named blocked action: an action, not an essay (it is recorded in audit evidence). */
export const BLOCKED_ACTION_MAX_LENGTH = 200;

export interface OwnerDecisionReasonInput {
  ownerReason?: string | undefined;
  blockedAction?: string | undefined;
}

export interface AdmittedOwnerDecisionReason {
  ownerReason: OwnerOnlyReason;
  blockedAction: string;
}

const isOwnerOnlyReason = (value: string): value is OwnerOnlyReason => Object.hasOwn(OWNER_ONLY_REASONS, value);
const isCeoScopeJudgement = (value: string): value is CeoScopeJudgement => Object.hasOwn(CEO_SCOPE_JUDGEMENTS, value);

/**
 * Admits the reason an OWNER_DECISION_REQUIRED names, or refuses it: no reason, a reason outside
 * `OWNER_ONLY_REASONS`, or no blocked action is OWNER_DECISION_REASON_REQUIRED; a CEO-scope judgement is
 * OWNER_DECISION_CEO_SCOPE with the CEO path that closes it. Nothing here forces CONFIRM: a refused
 * request leaves the run at READY_FOR_CEO_REVIEW for whatever decision the CEO makes next.
 */
export const admitOwnerDecisionReason = (
  runId: string,
  input: OwnerDecisionReasonInput,
): Decision<AdmittedOwnerDecisionReason> => {
  const ownerReason = input.ownerReason?.trim() ?? "";
  const blockedAction = input.blockedAction?.trim() ?? "";
  const ownerOnlyReasons = Object.keys(OWNER_ONLY_REASONS);
  if (ownerReason !== "" && isCeoScopeJudgement(ownerReason)) {
    return deny(
      ReasonCode.OWNER_DECISION_CEO_SCOPE,
      `${ownerReason} is a judgement the CEO closes within its own authority: ${CEO_SCOPE_JUDGEMENTS[ownerReason]}`,
      { runId, ownerReason, ceoPath: CEO_SCOPE_JUDGEMENTS[ownerReason] },
    );
  }
  if (ownerReason === "" || !isOwnerOnlyReason(ownerReason)) {
    return deny(
      ReasonCode.OWNER_DECISION_REASON_REQUIRED,
      "OWNER_DECISION_REQUIRED names an owner-only reason (ownerReason) and the action it blocks (blockedAction)",
      { runId, ownerReason: ownerReason === "" ? null : ownerReason, ownerOnlyReasons },
    );
  }
  if (blockedAction === "" || blockedAction.length > BLOCKED_ACTION_MAX_LENGTH) {
    return deny(
      ReasonCode.OWNER_DECISION_REASON_REQUIRED,
      `OWNER_DECISION_REQUIRED names the specific action the owner-only reason blocks (blockedAction, 1-${BLOCKED_ACTION_MAX_LENGTH} characters)`,
      { runId, ownerReason, blockedActionLength: blockedAction.length },
    );
  }
  return allow(ReasonCode.OK, { ownerReason, blockedAction });
};
