import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { BranchProfile } from "../contracts/manifest.ts";

export type BranchClass = "main" | "dev" | "feature" | "task" | "fix" | "release" | "hotfix" | "unknown";

export interface BranchFacts {
  name: string;
  class: BranchClass;
  /** semver for release branches, ticket/feature id otherwise. */
  identifier: string | null;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const classifyBranch = (name: string, profile: BranchProfile): BranchFacts => {
  if (name === "main") return { name, class: "main", identifier: null };
  if (name === profile.defaultBranch || name === "dev") return { name, class: "dev", identifier: null };

  const match = /^(feature|task|fix|release|hotfix)\/(.+)$/.exec(name);
  if (!match) return { name, class: "unknown", identifier: null };

  const kind = match[1] as Extract<BranchClass, "feature" | "task" | "fix" | "release" | "hotfix">;
  const rest = match[2]!;
  if (kind === "release") {
    return { name, class: "release", identifier: SEMVER.test(rest) ? rest : null };
  }
  const id = /^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*?)-/.exec(rest)?.[1] ?? null;
  return { name, class: kind, identifier: id };
};

export interface BranchContractInput {
  head: string;
  base: string;
  profile: BranchProfile;
  /** For `task/*` and `fix/*`, the parent branch declared in the run contract. */
  declaredParent?: string | null;
  /** Active release branches, needed for fix lineage and hotfix propagation. */
  activeReleases?: readonly string[];
  /**
   * Immutable source line recorded when the candidate was frozen. A PR target is
   * mutable, so it cannot prove where a branch was cut from.
   */
  sourceBranch?: string | null;
}

interface RuleContext extends BranchContractInput {
  head_: BranchFacts;
  base_: BranchFacts;
  releases: readonly string[];
  refuse: (message: string, extra?: Record<string, unknown>) => Decision<BranchFacts>;
}

/**
 * Integration §9.2 — one rule per branch class. Keyed by class so the map is exhaustive
 * by construction: adding a class to `BranchClass` fails to compile until its rule
 * exists.
 */
const RULES: Readonly<Record<BranchClass, (ctx: RuleContext) => Decision<BranchFacts>>> = {
  // feature/* is cut from dev and integrates back into dev.
  feature: (ctx) =>
    ctx.base_.class === "dev"
      ? allow(ReasonCode.OK, ctx.head_)
      : ctx.refuse("feature branches must target dev"),

  // task/* targets exactly the parent declared in the run contract.
  task: (ctx) => {
    if (!ctx.declaredParent) {
      return ctx.refuse("task branches must declare their parent branch in the run contract");
    }
    if (ctx.base !== ctx.declaredParent) {
      return ctx.refuse("task branch target does not match its declared parent", {
        declaredParent: ctx.declaredParent,
      });
    }
    const parent = classifyBranch(ctx.declaredParent, ctx.profile);
    if (!["feature", "dev", "release"].includes(parent.class)) {
      return ctx.refuse("a task branch parent must be a feature branch, dev, or a release branch", {
        declaredParent: ctx.declaredParent,
        parentClass: parent.class,
      });
    }
    return allow(ReasonCode.OK, ctx.head_);
  },

  // fix/* stays in the lineage it came from: dev, or an active release.
  fix: (ctx) => {
    if (!ctx.declaredParent) {
      return ctx.refuse("fix branches must declare the lineage they were cut from");
    }
    if (ctx.base !== ctx.declaredParent) {
      return ctx.refuse("fix branch target does not match its declared lineage", {
        declaredParent: ctx.declaredParent,
      });
    }
    if (ctx.base_.class === "dev") return allow(ReasonCode.OK, ctx.head_);
    if (ctx.base_.class === "release") {
      return ctx.releases.includes(ctx.base)
        ? allow(ReasonCode.OK, ctx.head_)
        : ctx.refuse("fix targets a release branch that is not active", {
            activeReleases: ctx.releases,
          });
    }
    return ctx.refuse("fix branches must target dev or an active release branch");
  },

  release: (ctx) => {
    if (!ctx.head_.identifier) return ctx.refuse("release branches must be named release/<semver>");
    return ctx.base_.class === "main" || ctx.base_.class === "dev"
      ? allow(ReasonCode.OK, ctx.head_)
      : ctx.refuse("release branches integrate into main and dev only");
  },

  // hotfix/* is cut from main and must reach main, dev and every active release.
  hotfix: (ctx) => {
    if (!["main", "dev", "release"].includes(ctx.base_.class)) {
      return ctx.refuse("hotfix branches target main, dev or an active release branch");
    }
    if (ctx.base_.class === "release" && !ctx.releases.includes(ctx.base)) {
      return ctx.refuse("hotfix targets a release branch that is not active", {
        activeReleases: ctx.releases,
      });
    }
    return allow(ReasonCode.OK, ctx.head_);
  },

  main: (ctx) => ctx.refuse("a long-lived branch is not a valid pull request head"),
  dev: (ctx) => ctx.refuse("a long-lived branch is not a valid pull request head"),
  unknown: (ctx) => ctx.refuse("branch name does not match any pattern in the branch contract"),
};

/**
 * Integration §9.2 — the machine contract for the Woowa-derived main/dev strategy.
 *
 * Checked here rather than in review, so `pr_prepare` refuses a wrong base or target
 * before any external write happens (RF-S10, RF-S11).
 */
export const validateBranchContract = (input: BranchContractInput): Decision<BranchFacts> => {
  const head_ = classifyBranch(input.head, input.profile);
  const base_ = classifyBranch(input.base, input.profile);
  const releases = input.activeReleases ?? [];

  const refuse = (message: string, extra: Record<string, unknown> = {}): Decision<BranchFacts> =>
    deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, message, {
      head: input.head,
      base: input.base,
      headClass: head_.class,
      baseClass: base_.class,
      ...extra,
    });

  const rule = RULES[head_.class]({ ...input, head_, base_, releases, refuse });
  if (!rule.allowed) return rule;

  const requiredBase = requiredBaseFor(input.head, input.profile, input.declaredParent);
  if (requiredBase && input.sourceBranch !== undefined && input.sourceBranch !== requiredBase) {
    return refuse("branch was not frozen from the required source lineage", {
      sourceBranch: input.sourceBranch,
      requiredBase,
    });
  }
  return rule;
};

/** Integration §9.2 — the base a branch of this class must have been cut from. */
const REQUIRED_BASE: Readonly<
  Record<BranchClass, (profile: BranchProfile, declaredParent: string | null) => string | null>
> = {
  feature: (profile) => profile.defaultBranch,
  release: (profile) => profile.defaultBranch,
  hotfix: () => "main",
  task: (profile, parent) => parent ?? profile.defaultBranch,
  fix: (profile, parent) => parent ?? profile.defaultBranch,
  main: () => null,
  dev: () => null,
  unknown: () => null,
};

export const requiredBaseFor = (
  branch: string,
  profile: BranchProfile,
  declaredParent?: string | null,
): string | null =>
  REQUIRED_BASE[classifyBranch(branch, profile).class](profile, declaredParent ?? null);

/**
 * Origins to compare during freeze when the origin is not captured by the branch-creation
 * caller. Release and hotfix branches are the only classes whose PR target can be another
 * long-lived branch, so ancestry against the configured long-lived refs must be disambiguated
 * before one of them is recorded in the candidate snapshot. Other classes have one declared
 * source and probing alternatives would reject valid parent-lineage candidates.
 */
export const sourceProbeBranchesFor = (
  branch: string,
  profile: BranchProfile,
  declaredParent?: string | null,
): string[] => {
  const required = requiredBaseFor(branch, profile, declaredParent);
  if (!required) return [];
  const branchClass = classifyBranch(branch, profile).class;
  return branchClass === "release" || branchClass === "hotfix"
    ? [...new Set([required, ...profile.longLived])]
    : [required];
};

/** Integration §9.6 — every target a hotfix must reach. */
export const hotfixPropagationTargets = (
  profile: BranchProfile,
  activeReleases: readonly string[],
): string[] => ["main", profile.defaultBranch, ...activeReleases];

/** §9.3 — history rewriting is allowed only on private task/fix branches. */
export const mayRewriteHistory = (branch: string, profile: BranchProfile): boolean => {
  const cls = classifyBranch(branch, profile).class;
  return cls === "task" || cls === "fix";
};
