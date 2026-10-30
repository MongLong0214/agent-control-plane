import { rmSync } from "node:fs";

import type { Clock } from "../core/clock.ts";
import { canonicalJson } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import type { BranchProfile, ProjectManifest } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { RunKind, TaskState } from "../domain/types.ts";
import { classifyBranch, validateBranchContract } from "../github/branch-contract.ts";
import { residentBaseClone } from "../registry/resident-repositories.ts";
import { type TaskImport, parseImportManifest } from "./task-import.ts";
import { type PinnedRepository, pinRepository, runPinnedGit } from "./worker-git.ts";

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
  /**
   * The run's pinned base commit for this repository. The branch is created here (or at `startsFrom`),
   * never at a branch name.
   */
  baseSha: string;
  /**
   * #1242 — only for a task whose dependsOn predecessors changed this repository: the commit its branch
   * is created at instead of `baseSha`, which is those predecessors' SUCCEEDED commits integrated on
   * `baseSha` (#1236's rules), and which predecessors it holds. Absent for every other task.
   */
  startsFrom?: StartsFrom;
  /**
   * #1232 — only for a task whose PLAN declared them: the files the control plane imports into the
   * checkout before the task's worker runs, each inside `paths`, with its size and sha256. Declaring
   * an import is the CTO PLAN's attestation authorizing those exact opaque, potentially active bytes;
   * their raw content is not made safe or passive by structural parsing (`task-import.ts`).
   */
  imports?: TaskImport[];
}

/** #1242 — the base a task with dependsOn predecessors starts from. */
export interface StartsFrom {
  /** The integration of the predecessors' SUCCEEDED commits in this repository on the run's base. */
  commit: string;
  /** Each predecessor that commit holds, in integration order, with its commit. */
  predecessors: Array<{ taskId: string; commit: string }>;
}

/**
 * #1242 — builds a dependent task's `StartsFrom` and keeps it from gc. `predecessors` is every task the
 * task depends on, directly or not, each SUCCEEDED. Null when none of them changed this repository.
 */
export type PredecessorBase = (input: {
  runId: string;
  taskId: string;
  predecessors: readonly string[];
  repositoryIdentity: string;
  checkoutPath: string;
  baseSha: string;
}) => Promise<Decision<StartsFrom | null>>;

/** #1242 — the commit a task's branch is created at: its predecessors' integration, or the run's base. */
export const startOf = (target: Pick<TaskWriteTarget, "baseSha" | "startsFrom">): string => target.startsFrom?.commit ?? target.baseSha;

export type WorkBranchClass = "task" | "hotfix";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The single policy point that picks the class of a task's work branch (CEO f5879479, c98ea8a3). A
 * dev-bearing profile (its default branch is not `main`) cuts `task/*` from dev and from nothing
 * else: a feature or release base is refused here, though the branch contract itself would accept
 * one. A main-only profile (`main` is its default and its only long-lived branch) cuts `hotfix/*`
 * from `main`, the one class the contract lets target `main`. Any other profile or base is refused
 * here, by name.
 */
export const workBranchClassFor = (
  base: string,
  profile: BranchProfile,
): Decision<{ branchClass: WorkBranchClass; declaredParent: string }> => {
  const baseClass = classifyBranch(base, profile).class;
  const mainOnly = profile.defaultBranch === "main" && profile.longLived.every((name) => name === "main");
  const devBearing = classifyBranch(profile.defaultBranch, profile).class === "dev";
  if (mainOnly && baseClass === "main") return allow(ReasonCode.OK, { branchClass: "hotfix", declaredParent: base });
  if (devBearing && baseClass === "dev") {
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

/**
 * A contract scope entry that could name one file (`README.md`), never free text. Syntax alone is not
 * evidence: the entry is used only when the run's pinned base holds a regular file at exactly that
 * path (`fileAtBase`), never a directory, a symlink or nothing.
 */
const isSingleFileScope = (entry: string): boolean => isNormalRelativePath(entry) && /^[A-Za-z0-9._/-]+$/.test(entry);

/**
 * #512 S-TB (c98ea8a3) — the audit kind the control plane writes immediately before it attempts to
 * create a task's work branch, inside the guard's grant: the run (the event's `run_id`), the task,
 * the repository, the branch and the base commit. An intent only: it proves nothing about the ref,
 * and nothing reads it as ownership (review r2, S-TB-03). A ref left by an attempt that never wrote
 * its completion is never adopted; it is refused, named by this record.
 */
export const TASK_BRANCH_CREATING = "TASK_BRANCH_CREATING";

/**
 * #512 S-TB (review r2, S-TB-03) — the completion of a task branch's creation, written only after the
 * create-only ref update succeeded, the ref was read back at the pinned base, the checkout was moved
 * onto it and found clean there. It is the one record that makes an existing branch of that name the
 * control plane's own: re-entry and the hand-off from a finished task's branch read it and nothing else.
 */
export const TASK_BRANCH_CREATED = "TASK_BRANCH_CREATED";

/**
 * #512 S-TB (review r3, S-TB-07) — an attempt that created nothing it kept: its ref never made, or made
 * and removed, with HEAD and every file as they were, all verified. It resolves that attempt's intent,
 * so a later attempt may create the branch afresh. It is never written when the attempt's own records
 * failed or when anything could not be put back: such an attempt stays unresolved, and the task's
 * branch is not attempted again on the control plane's own.
 */
export const TASK_BRANCH_CREATION_UNDONE = "TASK_BRANCH_CREATION_UNDONE";

/** Every completed creation of a repository's branch, oldest first (`TASK_BRANCH_CREATED` only). */
export const branchCreations = (
  db: Db,
  repositoryIdentity: string,
  branch: string,
): Array<{ runId: string; taskId: string; baseSha: string }> =>
  db
    .all<{ run_id: string | null; evidence_json: string }>(
      `SELECT run_id, evidence_json FROM audit_events
        WHERE kind = ? AND json_extract(evidence_json, '$.repositoryIdentity') = ?
          AND json_extract(evidence_json, '$.branch') = ?
        ORDER BY event_id`,
      [TASK_BRANCH_CREATED, repositoryIdentity, branch],
    )
    .map((row) => {
      const evidence = JSON.parse(row.evidence_json) as { taskId?: unknown; baseSha?: unknown };
      return { runId: row.run_id ?? "", taskId: String(evidence.taskId ?? ""), baseSha: String(evidence.baseSha ?? "") };
    })
    .filter((creation) => creation.runId.length > 0 && creation.taskId.length > 0 && creation.baseSha.length > 0);

/**
 * Whether an attempt to create this run and task's branch at this base was started and never resolved:
 * an intent whose attempt has neither a completion nor a verified undo (an intent written before
 * attempts carried an id is resolved only by a completion of the same scope).
 */
export const unresolvedCreationAttempt = (
  db: Db,
  scope: { runId: string; taskId: string; repositoryIdentity: string; branch: string; baseSha: string },
): boolean => {
  const rows = db.all<{ kind: string; attempt: string | null }>(
    `SELECT kind, json_extract(evidence_json, '$.attemptId') AS attempt FROM audit_events
      WHERE kind IN (?, ?, ?) AND run_id = ? AND json_extract(evidence_json, '$.taskId') = ?
        AND json_extract(evidence_json, '$.repositoryIdentity') = ? AND json_extract(evidence_json, '$.branch') = ?
        AND json_extract(evidence_json, '$.baseSha') = ?`,
    [TASK_BRANCH_CREATING, TASK_BRANCH_CREATED, TASK_BRANCH_CREATION_UNDONE, scope.runId, scope.taskId, scope.repositoryIdentity, scope.branch, scope.baseSha],
  );
  const resolved = new Set(rows.filter((row) => row.kind !== TASK_BRANCH_CREATING && row.attempt).map((row) => row.attempt));
  const completed = rows.some((row) => row.kind === TASK_BRANCH_CREATED);
  return rows.some((row) => row.kind === TASK_BRANCH_CREATING && (row.attempt ? !resolved.has(row.attempt) : !completed));
};

/** Whether an attempt to create this run and task's branch at this base was started (an intent, never ownership). */
export const branchCreationAttempted = (
  db: Db,
  scope: { runId: string; taskId: string; repositoryIdentity: string; branch: string; baseSha: string },
): boolean =>
  Boolean(db.get<{ n: number }>(
    `SELECT 1 AS n FROM audit_events
      WHERE kind = ? AND run_id = ? AND json_extract(evidence_json, '$.taskId') = ?
        AND json_extract(evidence_json, '$.repositoryIdentity') = ? AND json_extract(evidence_json, '$.branch') = ?
        AND json_extract(evidence_json, '$.baseSha') = ?
      LIMIT 1`,
    [TASK_BRANCH_CREATING, scope.runId, scope.taskId, scope.repositoryIdentity, scope.branch, scope.baseSha],
  ));

/** The recorded write target of a run whose branch, in that repository, is `branch`; the newest. */
export const recordedTargetForBranch = (
  db: Db,
  runId: string,
  repositoryIdentity: string,
  branch: string,
): (TaskWriteTarget & { taskId: string }) | null => {
  const row = db.get<{ evidence_json: string }>(
    `SELECT evidence_json FROM audit_events
      WHERE kind = ? AND run_id = ?
        AND json_extract(evidence_json, '$.writeTarget.repositoryIdentity') = ?
        AND json_extract(evidence_json, '$.writeTarget.branch') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [TASK_WRITE_TARGET_RECORDED, runId, repositoryIdentity, branch],
  );
  if (!row) return null;
  const evidence = JSON.parse(row.evidence_json) as { taskId?: unknown; writeTarget?: unknown };
  return isRecord(evidence.writeTarget) && typeof evidence.taskId === "string"
    ? { ...(evidence.writeTarget as unknown as TaskWriteTarget), taskId: evidence.taskId }
    : null;
};

/** The run's base commit for a repository as its first recorded target pinned it; null before any. */
const runBasePin = (db: Db, runId: string, repositoryIdentity: string): string | null =>
  db.get<{ base: string | null }>(
    `SELECT json_extract(evidence_json, '$.writeTarget.baseSha') AS base FROM audit_events
      WHERE kind = ? AND run_id = ? AND json_extract(evidence_json, '$.writeTarget.repositoryIdentity') = ?
      ORDER BY event_id LIMIT 1`,
    [TASK_WRITE_TARGET_RECORDED, runId, repositoryIdentity],
  )?.base ?? null;

/** #1242 — every task `taskId` depends on in its run, directly or through another, with its state. */
const predecessorsOf = (db: Db, runId: string, taskId: string): Array<{ taskId: string; state: string }> =>
  db.all<{ taskId: string; state: string }>(
    `WITH RECURSIVE up(task_id) AS (
       SELECT depends_on FROM task_dependencies WHERE task_id = ?
       UNION
       SELECT d.depends_on FROM task_dependencies d JOIN up ON d.task_id = up.task_id
     )
     SELECT t.task_id AS taskId, t.state FROM up JOIN tasks t ON t.task_id = up.task_id
      WHERE t.run_id = ? ORDER BY t.task_id`,
    [taskId, runId],
  );

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
  /** Private scratch for the pinned git reads; defaults to the control plane's scratch root. */
  readonly scratchDir?: (prefix: string) => string;
  /** #1242 — builds the base a task with dependsOn predecessors starts from; without it such a task is refused. */
  readonly predecessorBase?: PredecessorBase;
}

interface RepositoryFacts {
  repositoryId: string;
  identity: string;
  checkoutPath: string;
  baseBranch: string;
}

interface Derived {
  target: Omit<TaskWriteTarget, "baseSha">;
  repository: RepositoryFacts;
  declared: Record<string, unknown> | null;
  derivedFields: string[];
  branchClass: WorkBranchClass;
  /** The one path came from the contract's scope, so it stands only as a file at the pinned base. */
  pathFromScope: boolean;
}

/**
 * Records a STANDARD_WORK task's write target, or says exactly why it cannot. Idempotent: a task
 * with a record gets that record back unchanged. Everything is read from the database itself (the
 * run, its repositories, its pinned manifest and contract), so every official door — provisioning,
 * the runner before a first execution, the daemon before a continuation — records the same value.
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
    const run = this.ports.db.get<{ kind: string; pinned_manifest_digest: string | null }>(
      `SELECT kind, pinned_manifest_digest FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (run.kind !== RunKind.STANDARD_WORK) return allow(ReasonCode.OK, null);
    const existing = recordedWriteTarget(this.ports.db, runId, taskId);
    if (existing) return allow(ReasonCode.OK, existing);

    // #1242 — a task starts from what the tasks it depends on left, so its target is recorded only once
    // every one of them SUCCEEDED, as a worker is staffed only for a READY task.
    const predecessors = predecessorsOf(this.ports.db, runId, taskId);
    const unsatisfied = predecessors.filter((predecessor) => predecessor.state !== TaskState.SUCCEEDED);
    if (unsatisfied.length > 0) {
      return deny(
        ReasonCode.TASK_DEPENDENCY_UNSATISFIED,
        "a task this one depends on has not SUCCEEDED; its write target, and the base it starts from, are recorded only once every one has",
        { taskId, unsatisfied: unsatisfied.slice(0, 20) },
      );
    }

    const derived = this.derive(runId, run.pinned_manifest_digest, taskId);
    if (!derived.allowed) return derived as Decision<never>;
    const base = await this.pinnedBase(runId, derived.value.repository);
    if (!base.allowed) return base as Decision<never>;
    const start = await this.startFrom(runId, taskId, predecessors.map((predecessor) => predecessor.taskId), derived.value.repository, base.value);
    if (!start.allowed) return start as Decision<never>;
    const startsFrom = start.value;
    if (derived.value.pathFromScope) {
      const file = await this.fileAtBase(derived.value.repository, startsFrom?.commit ?? base.value, derived.value.target.paths[0]!);
      if (!file.allowed) return file as Decision<never>;
    }
    // Every refusal comes before the first write; a failed audit write throws and takes the spec
    // update back with it, so a spec never names a target its record does not.
    return this.ports.db.tx((): Decision<TaskWriteTarget | null> => {
      const fenced = fence();
      if (!fenced.allowed) return fenced as Decision<never>;
      const raced = recordedWriteTarget(this.ports.db, runId, taskId);
      if (raced) return allow(ReasonCode.OK, raced);
      // c98ea8a3 (S-TB-04) — one base per run and repository, decided here, in the transaction that
      // writes: a concurrent recording that committed first pinned it, and this one takes that pin.
      // A path that stood only as a file at the base this one read, or a start built on that base
      // (#1242), is not carried to another base.
      const pinned = runBasePin(this.ports.db, runId, derived.value.repository.identity);
      if (pinned !== null && pinned !== base.value && (derived.value.pathFromScope || startsFrom !== null)) {
        return deny(ReasonCode.CONFLICT, "the run's base was pinned at another commit while this target was derived; it is derived again from that pin", {
          taskId,
          pinnedBase: pinned,
          readBase: base.value,
        });
      }
      const target: TaskWriteTarget = { ...derived.value.target, baseSha: pinned ?? base.value, ...(startsFrom ? { startsFrom } : {}) };
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
  private derive(runId: string, pinnedManifestDigest: string | null, taskId: string): Decision<Derived> {
    const { db } = this.ports;
    const task = db.get<{ title: string; category: string; state: string; spec_json: string }>(
      `SELECT title, category, state, spec_json FROM tasks WHERE task_id = ? AND run_id = ?`,
      [taskId, runId],
    );
    if (!task) return deny(ReasonCode.NOT_FOUND, "unknown task", { runId, taskId });
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
    const repositories = db.all<{ repositoryId: string; identity: string; checkoutPath: string; baseBranch: string }>(
      `SELECT r.repository_id AS repositoryId, r.identity, r.checkout_path AS checkoutPath, rr.base_branch AS baseBranch
         FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
        WHERE rr.run_id = ? ORDER BY rr.merge_order, r.identity`,
      [runId],
    );
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
    const pathFromScope = declaredPaths === undefined;
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
      const contract = db.get<{ content_json: string }>(
        `SELECT content_json FROM run_artifacts WHERE run_id = ? AND kind = 'TASK_CONTRACT' AND superseded = 0
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [runId],
      );
      const scope = contract ? (JSON.parse(contract.content_json) as { scope?: unknown }).scope : undefined;
      const oneFile = (entries: unknown): string | null =>
        Array.isArray(entries) && entries.length === 1 && typeof entries[0] === "string" && isSingleFileScope(entries[0])
          ? entries[0]
          : null;
      // #512 (CEO 9a1f70bf) — a docs task planned before writeTarget existed declares its one file in
      // its own spec.files. That is the task's declaration, not a guess: it is used only when the spec
      // has no writeTarget at all, names exactly one normal file, and (pathFromScope) the pinned base
      // holds a regular file there. A declared writeTarget is never overridden by it.
      const single = declared === null ? (oneFile(isRecord(spec) ? spec["files"] : undefined) ?? oneFile(scope)) : oneFile(scope);
      if (task.category !== "docs" || single === null) {
        return deny(
          ReasonCode.INVALID_ARGUMENT,
          "the task declares no paths, and it is not a docs task whose spec files or contract declare exactly one file; the control plane does not guess its paths",
          { taskId, category: task.category },
        );
      }
      paths = [single];
      derivedFields.push("paths");
    }

    // #1232 — the PLAN's import manifest, each file inside the paths just settled; never derived.
    let imports: TaskImport[] | null = null;
    if (declared?.["imports"] !== undefined) {
      const parsed = parseImportManifest(declared["imports"], paths);
      if (!parsed.allowed) return parsed as Decision<never>;
      imports = parsed.value;
    }

    // The branch and its declared parent, from the one policy point and the branch contract.
    const manifest = pinnedManifestDigest
      ? db.get<{ content_json: string }>(`SELECT content_json FROM manifests WHERE digest = ?`, [pinnedManifestDigest])
      : undefined;
    const profile = manifest ? (JSON.parse(manifest.content_json) as Partial<ProjectManifest>).branchProfile : undefined;
    if (!profile) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "the run pins no manifest with a branch profile; no work branch can be derived", {
        policy: WORK_BRANCH_POLICY,
        runId,
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
      profile,
      declared: typeof declaredBranch === "string" ? declaredBranch : null,
    });
    if (!branch.allowed) return branch as Decision<never>;
    if (typeof declaredBranch !== "string") derivedFields.push("branch");

    return allow(ReasonCode.OK, {
      target: {
        repositoryIdentity: chosen.identity,
        branch: branch.value.branch,
        paths,
        declaredParent: branch.value.declaredParent,
        ...(imports ? { imports } : {}),
      },
      repository: { repositoryId: chosen.repositoryId, identity: chosen.identity, checkoutPath: chosen.checkoutPath, baseBranch: chosen.baseBranch },
      declared,
      derivedFields: derivedFields.sort(),
      branchClass: branch.value.branchClass,
      pathFromScope,
    });
  }

  /**
   * #1242 — where a task's branch starts: null for a task that depends on nothing, which starts at the
   * run's base exactly as before; otherwise what `predecessorBase` builds from its predecessors, or its
   * refusal. A door without `predecessorBase` refuses such a task rather than start it at the base.
   */
  private async startFrom(
    runId: string,
    taskId: string,
    predecessors: readonly string[],
    repository: RepositoryFacts,
    baseSha: string,
  ): Promise<Decision<StartsFrom | null>> {
    if (predecessors.length === 0) return allow(ReasonCode.OK, null);
    if (!this.ports.predecessorBase) {
      return deny(ReasonCode.INTERNAL_ERROR, "this door cannot build the base a task with dependsOn predecessors starts from; it is not started at the run's base instead", {
        taskId,
      });
    }
    return this.ports.predecessorBase({ runId, taskId, predecessors, repositoryIdentity: repository.identity, checkoutPath: repository.checkoutPath, baseSha });
  }

  /**
   * The run's base commit for a repository, pinned once: an earlier task's record of the same run
   * and repository, or else the commit its base branch names in the registered checkout right now.
   * Every later task of the run reads the pin, never the branch name again; `ensure` settles a
   * concurrent first pin inside its transaction.
   *
   * #1227 — a resident's repository is registered at its worker clone, whose base branch only follows
   * pins (`WorkerTurnRunner`): the base is read where the resident keeps it, its clone, which is only
   * read, and its objects are fetched into the worker clone by that name. The fetch writes objects
   * alone (no ref, no FETCH_HEAD), which a worker turn's git-dir baseline does not hold.
   */
  private async pinnedBase(runId: string, repository: RepositoryFacts): Promise<Decision<string>> {
    const earlier = runBasePin(this.ports.db, runId, repository.identity);
    if (earlier) return allow(ReasonCode.OK, earlier);
    const residentClone = residentBaseClone(this.ports.db, repository.repositoryId, repository.checkoutPath);
    if (residentClone !== null) {
      const read = await this.readBase({ ...repository, checkoutPath: residentClone });
      if (!read.allowed) return read;
      return this.withRepository(repository, async (repo) => {
        const fetched = await runPinnedGit(repo, [
          "fetch", "--quiet", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", residentClone, `refs/heads/${repository.baseBranch}`,
        ]);
        const present = await runPinnedGit(repo, ["cat-file", "-e", `${read.value}^{commit}`]);
        if (present.exitCode !== 0) {
          return deny(ReasonCode.NOT_FOUND, "the run's base commit, read in the resident's clone, could not be brought into the worker checkout", {
            repositoryIdentity: repository.identity,
            baseBranch: repository.baseBranch,
            baseSha: read.value,
            fetchExitCode: fetched.exitCode,
          });
        }
        return read;
      });
    }
    return this.readBase(repository);
  }

  /** The commit the base branch names in `repository.checkoutPath` right now. */
  private async readBase(repository: RepositoryFacts): Promise<Decision<string>> {
    return this.withRepository(repository, async (repo) => {
      const read = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", `refs/heads/${repository.baseBranch}^{commit}`]);
      const sha = read.stdout.trim();
      if (read.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
        return deny(ReasonCode.NOT_FOUND, "the run's base branch names no commit in the registered checkout", {
          repositoryIdentity: repository.identity,
          baseBranch: repository.baseBranch,
        });
      }
      return allow(ReasonCode.OK, sha);
    });
  }

  /**
   * c98ea8a3 (S-TB-08) — the contract's one scope entry stands as the task's path only when the
   * pinned base holds exactly one regular file at exactly that path: a directory, a symlink, a
   * submodule or nothing there is not file evidence, and is refused rather than widened.
   */
  private async fileAtBase(repository: RepositoryFacts, baseSha: string, path: string): Promise<Decision<void>> {
    return this.withRepository(repository, async (repo) => {
      const listed = await runPinnedGit(repo, ["ls-tree", "-z", "--full-tree", baseSha, "--", path]);
      const entries = listed.stdout.split("\0").filter((entry) => entry.length > 0);
      const entry = entries.length === 1 ? /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/s.exec(entries[0]!) : null;
      if (listed.exitCode !== 0 || !entry || entry[2] !== "blob" || (entry[1] !== "100644" && entry[1] !== "100755") || entry[3] !== path) {
        return deny(
          ReasonCode.INVALID_ARGUMENT,
          "the one file the task spec or its contract declares is not a single regular file at the run's pinned base; the control plane does not widen it to a directory or guess one",
          { repositoryIdentity: repository.identity, path, baseSha, found: entries.map((line) => line.split("\t", 1)[0]).slice(0, 5) },
        );
      }
      return allow(ReasonCode.OK, undefined);
    });
  }

  private async withRepository<T>(repository: RepositoryFacts, read: (repo: PinnedRepository) => Promise<Decision<T>>): Promise<Decision<T>> {
    const scratch = (this.ports.scratchDir ?? acpScratchDir)("acp-task-base-");
    try {
      const pinned = pinRepository(repository.checkoutPath, scratch);
      if (!pinned.allowed) return pinned as Decision<never>;
      try {
        return await read(pinned.value);
      } finally {
        pinned.value.children.retire();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
