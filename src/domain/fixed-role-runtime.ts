import { Role } from "./types.ts";

/** A provider and model a role runs on, fixed rather than chosen by coverage or an adapter's default. */
export interface FixedRoleRuntime {
  readonly provider: string;
  readonly model: string;
}

/**
 * Roles whose runtime is fixed. A run's BOOTSTRAP_CTO (#246, RF PRD:156) runs on Claude Opus.
 * A task's WORKER (#512) runs on Claude Opus, or on GPT 6.1 Sol (CEO decision 129edfa1; owner
 * instruction of 2026-10-19). The caller names the provider. Nothing is substituted or defaulted.
 * Claude's own default worker model (Sonnet) is not Opus, and GPT's default worker model (Luna)
 * is not 6.1 Sol.
 *
 * Every writer that constitutes a session for one of these roles reads this table — staffing at
 * provisioning, continuity at a WORKER's failover and restoration — and none substitutes a
 * provider or model from outside it. A provider the table does not list for the role is uncovered,
 * not moved onto one it does, and one listed provider is not swapped for the other. Continuity
 * constitutes no session for a BOOTSTRAP_CTO at all: it is recovered on its own session (#246 C1b).
 */
export const FIXED_ROLE_RUNTIME: Readonly<Partial<Record<Role, readonly FixedRoleRuntime[]>>> = Object.freeze({
  [Role.BOOTSTRAP_CTO]: Object.freeze([Object.freeze({ provider: "claude", model: "opus" })]),
  [Role.WORKER]: Object.freeze([
    Object.freeze({ provider: "claude", model: "opus" }),
    Object.freeze({ provider: "gpt", model: "gpt-6.1-sol" }),
  ]),
});

/** The fixed provider/model pairs for a role. Empty when the role is not fixed. */
export const fixedRuntimes = (role: Role): readonly FixedRoleRuntime[] => FIXED_ROLE_RUNTIME[role] ?? [];

/**
 * #246 C4 — the runtime of a PRIMARY_CTO a bootstrap activation provisions on the headless runtime:
 * Claude Opus, like the BOOTSTRAP_CTO that built the project. Not a `FIXED_ROLE_RUNTIME` entry: the
 * role is not fixed. Every other PRIMARY_CTO, interactive or canonical, keeps the deployment's CTO
 * preference, and only a spawn recorded driven reads this.
 */
export const DRIVEN_PRIMARY_CTO_RUNTIME: FixedRoleRuntime = Object.freeze({ provider: "claude", model: "opus" });
