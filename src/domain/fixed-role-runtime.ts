import { Role } from "./types.ts";

/** A provider and model a role runs on, fixed rather than chosen by coverage or an adapter's default. */
export interface FixedRoleRuntime {
  readonly provider: string;
  readonly model: string;
}

/**
 * Roles whose runtime is fixed: a run's BOOTSTRAP_CTO (#246, RF PRD:156) and a task's WORKER
 * (#512) run on Claude Opus. Implementation and bootstrap work run on Claude Opus; GPT does no code
 * work, and Claude's own default worker model (Sonnet) is not Opus.
 *
 * Every writer that constitutes a session for one of these roles reads this table — staffing at
 * provisioning, continuity at failover and restoration — and none substitutes another provider or
 * model for it. A role that its fixed provider cannot cover is uncovered, not moved elsewhere.
 */
export const FIXED_ROLE_RUNTIME: Readonly<Partial<Record<Role, FixedRoleRuntime>>> = Object.freeze({
  [Role.BOOTSTRAP_CTO]: Object.freeze({ provider: "claude", model: "opus" }),
  [Role.WORKER]: Object.freeze({ provider: "claude", model: "opus" }),
});
