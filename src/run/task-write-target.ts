import { rmSync } from "node:fs";

import type { Clock } from "../core/clock.ts";
import { canonicalJson } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import type { BranchProfile, ProjectManifest } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, RunKind, type RunRow, TaskState } from "../domain/types.ts";
import { classifyBranch, validateBranchContract } from "../github/branch-contract.ts";
import type { RunEngine } from "./run-engine.ts";
import { pinRepository, runPinnedGit } from "./worker-git.ts";

/**
 * #512 S-TB (CEO 0a16329c, f5879479) — a STANDARD_WORK task's write target, recorded once by the
 * control plane and then named by everything that writes for the task.
 *
 * The record is the task's `writeTarget`: the repository, the work branch and its declared parent,
 * the paths, and the run's pinned base commit for that repository. It is written in one transaction
 * into the task's spec (which `contract_get` answers, so the PLAN's spec, the claim and the runner all
 * read the same value) and as a `TASK_WRITE_TARGET_RECORDED` audit event. The audit event is the
 * authority: only the control plane appends one, and the runner refuses a spec that no longer equals
 * it. A PLAN can declare the repository, the paths and, within the branch policy below, the branch;
 * it never declares the base commit or the parent, and nothing here fills a gap by guessing.
 *
 * It is recorded when the task's first worker is provisioned (`task_worker_provision`), which is the
 * first control-plane step for a task and comes before any claim. That covers a task planned before
 * the field existed (the live task_e959ee8b) exactly as it covers a new one.
 */
export const TASK_WRITE_TARGET_RECORDED = "TASK_WRITE_TARGET_RECORDED";

/** The name the one branch-class policy point is refused under, so a refusal says where to change it. */
export const WORK_BRANCH_POLICY = "WORK_BRANCH_POLICY";

export interface TaskWriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
  /** The branch this one is cut from and integrates into: its declared parent under the branch contract. */
  declaredParent: string;
  /** The run's pinned base commit for this repository. The branch is created here, never at a branch name. */
  baseSha: string;
}

export type WorkBranchClass = "task" | "hotfix";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The single policy point that picks the class of a task's work branch (CEO f5879479). A
 * dev-bearing profile (its default branch is not `main`) cuts `task/*` from the run's base, which
 * the branch contract accepts when that base is dev, a feature or a release branch. A main-only
 * profile (`main` is its default and its only long-lived branch) cuts `hotfix/*` from `main`, the
 * one class the contract lets target `main`. Any other profile or base is refused here, by name.
 */
export const workBranchClassFor = (
  base: string,
  profile: BranchProfile,
): Decision<{ branchClass: WorkBranchClass; declaredParent: string }> => {
  const baseClass = classifyBranch(base, profile).class;
  const mainOnly = profile.defaultBranch === "main" && profile.longLived.every((name) => name === "main");
  const devBearing = classifyBranch(profile.defaultBranch, profile).class === "dev";
  if (mainOnly && baseClass === "main") return allow(ReasonCode.OK, { branchClass: "hotfix", declaredParent: base });
  if (devBearing && (baseClass === "dev" || baseClass === "feature" || baseClass === "release")) {
    return allow(ReasonCode.OK, { branchClass: "task", declaredParent: base });
  }
  return deny(
    ReasonCode.PR_BRANCH_CONTRACT_VIOLATION,
    `${WORK_BRANCH_POLICY} has no work branch class for this run's base under this branch profile`,
    {
      policy: WORK_BRANCH_POLICY,
      base,
      baseClass,
      defaultBranch: profile.defaultBranch,
      longLived: profile.longLived,
    },
  );
};

/** The task id in the branch classifier's id format: letters and digits only (`classifyBranch`). */
export const branchIdOf = (taskId: string): string => taskId.replace(/[^A-Za-z0-9]/g, "");

const slugOf = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "") || "work";

/** A branch name git accepts and nothing here has to escape: segments of `[A-Za-z0-9._-]`, no `..`, no `.lock`. */
const isPlainBranchName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 200 &&
  !name.includes("..") &&
  name.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && !segment.endsWith(".lock"));

/**
 * The one function that names a task's work branch and its declared parent (CEO f5879479): the class
 * comes from `workBranchClassFor`, the name is `<class>/<taskId in classifier format>-<slug of the
 * title>`, and the pair must pass the branch contract the PR is later checked against. A branch the
 * PLAN declared is kept only when it is a plain name of the policy's class that passes the same check;
 * otherwise it is refused, never replaced.
 */
export const deriveWorkBranch = (input: {
  taskId: string;
  title: string;
  base: string;
  profile: BranchProfile;
  declared?: string | null;
}): Decision<{ branch: string; declaredParent: string; branchClass: WorkBranchClass }> => {
  const policy = workBranchClassFor(input.base, input.profile);
  if (!policy.allowed) return policy as Decision<never>;
  const { branchClass, declaredParent } = policy.value;
  let branch: string;
  if (input.declared != null) {
    if (!isPlainBranchName(input.declared) || classifyBranch(input.declared, input.profile).class !== branchClass) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, `the PLAN's branch is not a ${branchClass} branch ${WORK_BRANCH_POLICY} admits for this base`, {
        policy: WORK_BRANCH_POLICY,
        declared: input.declared,
        branchClass,
        base: input.base,
      });
    }
    branch = input.declared;
  } else {
    const id = branchIdOf(input.taskId);
    if (!id) return deny(ReasonCode.INVALID_ARGUMENT, "the task id has no letters or digits to name a branch after", { taskId: input.taskId });
    branch = `${branchClass}/${id}-${slugOf(input.title)}`;
  }
  const contract = validateBranchContract({ head: branch, base: input.base, profile: input.profile, declaredParent });
  if (!contract.allowed) return contract as Decision<never>;
  return allow(ReasonCode.OK, { branch, declaredParent, branchClass });
};

/** A repository-relative path in normal form: no leading `/`, no empty, `.` or `..` segment, no backslash. */
const isNormalRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !path.includes("\0") &&
  !path.includes("\\") &&
  !path.startsWith("/") &&
  path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

/** A contract scope entry that names one file and nothing else (`README.md`), never free text. */
const isSingleFileScope = (entry: string): boolean => isNormalRelativePath(entry) && /^[A-Za-z0-9._/-]+$/.test(entry);

/** The latest write target the control plane recorded for a task, read from its audit record. */
export const recordedWriteTarget = (db: Db, runId: string, taskId: string): TaskWriteTarget | null => {
  const row = db.get<{ evidence_json: string }>(
    `SELECT evidence_json FROM audit_events
      WHERE kind = ? AND run_id = ? AND json_extract(evidence_json, '$.taskId') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [TASK_WRITE_TARGET_RECORDED, runId, taskId],
  );
  if (!row) return null;
  const target = (JSON.parse(row.evidence_json) as { writeTarget?: unknown }).writeTarget;
  return isRecord(target) ? (target as unknown as TaskWriteTarget) : null;
};

/** Whether two write targets are the same value, compared canonically. */
export const sameWriteTarget = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

export interface TaskWriteTargetPorts {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly runs: Pick<RunEngine, "get" | "repositoriesOf">;
  readonly projects: { manifest(digest: string): ProjectManifest | null };
  readonly artifacts: { latest<T>(runId: string, kind: ArtifactKind): { content: T } | null };
  /** Private scratch for the one pinned git read; defaults to the control plane's scratch root. */
  readonly scratchDir?: (prefix: string) => string;
}

/**
 * Records a STANDARD_WORK task's write target, or says exactly why it cannot. Idempotent: a task
 * with a record gets that record back unchanged.
 */
export class TaskWriteTargets {
  constructor(private readonly ports: TaskWriteTargetPorts) {}

  /**
   * `null` for a run that is not STANDARD_WORK: nothing is recorded for it. `fence` is the caller's
   * owner check, asked again inside the transaction that writes.
   */
  async ensure(
    runId: string,
    taskId: string,
    fence: () => Decision<unknown>,
  ): Promise<Decision<TaskWriteTarget | null>> {
    const run = this.ports.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (run.kind !== RunKind.STANDARD_WORK) return allow(ReasonCode.OK, null);
    const existing = recordedWriteTarget(this.ports.db, runId, taskId);
    if (existing) return allow(ReasonCode.OK, existing);

    const derived = this.derive(run, taskId);
    if (!derived.allowed) return derived as Decision<never>;
    const base = await this.pinnedBase(runId, derived.value.repository);
    if (!base.allowed) return base as Decision<never>;
    const target: TaskWriteTarget = { ...derived.value.target, baseSha: base.value };
    // Every refusal comes before the first write; a failed audit write throws and takes the spec
    // update back with it, so a spec never names a target its record does not.
    return this.ports.db.tx((): Decision<TaskWriteTarget | null> => {
      const fenced = fence();
      if (!fenced.allowed) return fenced as Decision<never>;
      const raced = recordedWriteTarget(this.ports.db, runId, taskId);
      if (raced) return allow(ReasonCode.OK, raced);
      const task = this.ports.db.get<{ spec_json: string }>(
        `SELECT spec_json FROM tasks WHERE task_id = ? AND run_id = ?`,
        [taskId, runId],
      );
      if (!task) return deny(ReasonCode.NOT_FOUND, "unknown task", { runId, taskId });
      let spec: unknown;
      try {
        spec = JSON.parse(task.spec_json) as unknown;
      } catch {
        spec = {};
      }
      this.ports.db.run(
        `UPDATE tasks SET spec_json = ?, updated_at = ? WHERE task_id = ?`,
        [JSON.stringify({ ...(isRecord(spec) ? spec : {}), writeTarget: target }), this.ports.clock.nowIso(), taskId],
      );
      const recorded = this.ports.audit.record({
        kind: TASK_WRITE_TARGET_RECORDED,
        runId,
        evidence: {
          taskId,
          writeTarget: target,
          declared: derived.value.declared,
          derived: derived.value.derivedFields,
          policy: WORK_BRANCH_POLICY,
          branchClass: derived.value.branchClass,
          baseBranch: derived.value.repository.baseBranch,
        } as unknown as Evidence,
      });
      if (!recorded.allowed) fail(recorded.reasonCode, recorded.message, recorded.evidence);
      return allow(ReasonCode.OK, target);
    });
  }

  /** Everything but the base commit, from the task, its spec, the run's contract, base and profile. */
  private derive(run: RunRow, taskId: string): Decision<{
    target: Omit<TaskWriteTarget, "baseSha">;
    repository: { identity: string; checkoutPath: string; baseBranch: string };
    declared: Record<string, unknown> | null;
    derivedFields: string[];
    branchClass: WorkBranchClass;
  }> {
    const { db } = this.ports;
    const task = db.get<{ title: string; category: string; state: string; spec_json: string }>(
      `SELECT title, category, state, spec_json FROM tasks WHERE task_id = ? AND run_id = ?`,
      [taskId, run.runId],
    );
    if (!task) return deny(ReasonCode.NOT_FOUND, "unknown task", { runId: run.runId, taskId });
    if (task.state === TaskState.SUCCEEDED || task.state === TaskState.FAILED || task.state === TaskState.CANCELLED) {
      return deny(ReasonCode.CONFLICT, `the task is ${task.state}; no write target is recorded for it`, { taskId, state: task.state });
    }
    let spec: unknown;
    try {
      spec = JSON.parse(task.spec_json) as unknown;
    } catch {
      spec = {};
    }
    const declared = isRecord(spec) && isRecord(spec["writeTarget"]) ? spec["writeTarget"] : null;
    if (isRecord(spec) && spec["writeTarget"] !== undefined && declared === null) {
      return deny(ReasonCode.INVALID_ARGUMENT, "the task's spec writeTarget is not an object", { taskId });
    }
    const derivedFields: string[] = ["declaredParent", "baseSha"];

    // The repository: the one the PLAN named, or the run's only one.
    const repositories = this.ports.runs.repositoriesOf(run.runId);
    const named = declared?.["repositoryIdentity"];
    if (named !== undefined && typeof named !== "string") {
      return deny(ReasonCode.INVALID_ARGUMENT, "the task's writeTarget.repositoryIdentity is not a string", { taskId });
    }
    let repository = named === undefined ? null : (repositories.find((candidate) => candidate.identity === named) ?? null);
    if (named !== undefined && !repository) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "the task's writeTarget names a repository this run does not include", {
        taskId,
        repositoryIdentity: named,
      });
    }
    if (named === undefined) {
      if (repositories.length !== 1) {
        return deny(ReasonCode.INVALID_ARGUMENT, "the task names no repository and the run has more than one; the control plane does not pick one", {
          taskId,
          repositories: repositories.map((candidate) => candidate.identity),
        });
      }
      repository = repositories[0]!;
      derivedFields.push("repositoryIdentity");
    }
    const chosen = repository!;

    // The paths: the task's own, or, for a docs task with none, the one file its contract declares.
    let paths: string[];
    const declaredPaths = declared?.["paths"];
    if (declaredPaths !== undefined) {
      if (
        !Array.isArray(declaredPaths) ||
        declaredPaths.length === 0 ||
        !declaredPaths.every((path): path is string => typeof path === "string" && isNormalRelativePath(path))
      ) {
        return deny(ReasonCode.INVALID_ARGUMENT, "the task's writeTarget.paths must be repository-relative paths in normal form", { taskId });
      }
      paths = [...new Set(declaredPaths)].sort();
    } else {
      const scope = this.ports.artifacts.latest<{ scope?: unknown }>(run.runId, ArtifactKind.TASK_CONTRACT)?.content?.scope;
      const single = Array.isArray(scope) && scope.length === 1 && typeof scope[0] === "string" && isSingleFileScope(scope[0])
        ? scope[0]
        : null;
      if (task.category !== "docs" || single === null) {
        return deny(
          ReasonCode.INVALID_ARGUMENT,
          "the task declares no paths, and it is not a docs task whose contract declares exactly one file; the control plane does not guess its paths",
          { taskId, category: task.category },
        );
      }
      paths = [single];
      derivedFields.push("paths");
    }

    // The branch and its declared parent, from the one policy point and the branch contract.
    const manifest = run.pinnedManifestDigest ? this.ports.projects.manifest(run.pinnedManifestDigest) : null;
    if (!manifest?.branchProfile) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "the run pins no manifest with a branch profile; no work branch can be derived", {
        policy: WORK_BRANCH_POLICY,
        runId: run.runId,
      });
    }
    const declaredBranch = declared?.["branch"];
    if (declaredBranch !== undefined && declaredBranch !== null && typeof declaredBranch !== "string") {
      return deny(ReasonCode.INVALID_ARGUMENT, "the task's writeTarget.branch is not a string", { taskId });
    }
    const branch = deriveWorkBranch({
      taskId,
      title: task.title,
      base: chosen.baseBranch,
      profile: manifest.branchProfile,
      declared: typeof declaredBranch === "string" ? declaredBranch : null,
    });
    if (!branch.allowed) return branch as Decision<never>;
    if (typeof declaredBranch !== "string") derivedFields.push("branch");

    return allow(ReasonCode.OK, {
      target: { repositoryIdentity: chosen.identity, branch: branch.value.branch, paths, declaredParent: branch.value.declaredParent },
      repository: { identity: chosen.identity, checkoutPath: chosen.checkoutPath, baseBranch: chosen.baseBranch },
      declared,
      derivedFields: derivedFields.sort(),
      branchClass: branch.value.branchClass,
    });
  }

  /**
   * The run's base commit for a repository, pinned once: an earlier task's record of the same run
   * and repository, or else the commit its base branch names in the registered checkout right now.
   * Every later task of the run reads the pin, never the branch name again.
   */
  private async pinnedBase(
    runId: string,
    repository: { identity: string; checkoutPath: string; baseBranch: string },
  ): Promise<Decision<string>> {
    const earlier = this.ports.db.get<{ base: string | null }>(
      `SELECT json_extract(evidence_json, '$.writeTarget.baseSha') AS base FROM audit_events
        WHERE kind = ? AND run_id = ? AND json_extract(evidence_json, '$.writeTarget.repositoryIdentity') = ?
        ORDER BY event_id LIMIT 1`,
      [TASK_WRITE_TARGET_RECORDED, runId, repository.identity],
    );
    if (earlier?.base) return allow(ReasonCode.OK, earlier.base);
    const scratch = (this.ports.scratchDir ?? acpScratchDir)("acp-task-base-");
    try {
      const pinned = pinRepository(repository.checkoutPath, scratch);
      if (!pinned.allowed) return pinned as Decision<never>;
      try {
        const read = await runPinnedGit(pinned.value, ["rev-parse", "--verify", "-q", `refs/heads/${repository.baseBranch}^{commit}`]);
        const sha = read.stdout.trim();
        if (read.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
          return deny(ReasonCode.NOT_FOUND, "the run's base branch names no commit in the registered checkout", {
            repositoryIdentity: repository.identity,
            baseBranch: repository.baseBranch,
          });
        }
        return allow(ReasonCode.OK, sha);
      } finally {
        pinned.value.children.retire();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
