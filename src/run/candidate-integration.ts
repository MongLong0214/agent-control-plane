import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { taskCaptureRequired } from "../bootstrap/commitlore-mode.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import type { Db } from "../db/database.ts";
import { TaskState } from "../domain/types.ts";
import type { SnapshotIntegration } from "../snapshot/candidate-snapshot.ts";
import { TASK_CORRECTION_REGISTERED, type TaskRecord, tasksBuildingOn } from "./task-graph.ts";
import { type StartsFrom, TASK_WRITE_TARGET_RECORDED, recordedWriteTarget, startOf } from "./task-write-target.ts";
import {
  GIT_HARDENING,
  type PinnedRepository,
  committedChanges,
  objectFormatOf,
  pinRepository,
  pinnedGitEnvironment,
  runPinnedGit,
} from "./worker-git.ts";
import { type TaskImport, parseImportManifest } from "./task-import.ts";
import { WorkerTurnEvent } from "./worker-turn.ts";

/**
 * S6-C — the candidate of a STANDARD_WORK run whose tasks each worked on their own branch.
 *
 * A task branch starts at the run's pinned base (S-TB), or, for a task with dependsOn predecessors, at
 * their integration on it (#1242), so the checkout's HEAD may hold some tasks' work only. At freeze,
 * when some SUCCEEDED task's recorded commit is not in that HEAD, the candidate is instead every
 * SUCCEEDED task's result in the repository, integrated onto the pinned base:
 *
 * - The order is the task graph's: a task after every task it depends on, through the whole run's
 *   graph, ties broken by task id. The first task's commit is taken as it is; each later one is joined
 *   by a merge commit whose parents are the integration so far and the task's own commit, so every
 *   task commit is an ancestor of the candidate, and no task branch, ref or commit is moved (S-TB-02).
 *   A task whose commit already holds the integration so far is taken as it is instead (#1242).
 * - A task's change is what its commit changes against the commit its branch started at, path by
 *   path. Two tasks that change the same path, or a path and one beneath it, are a conflict unless one
 *   is built on the other's commit: the freeze is refused naming both tasks and the paths, before
 *   anything is written. Nothing merges file contents, so no merge driver runs and no task's bytes
 *   are overwritten or dropped.
 * - The merge commits are plumbing over a private index, in a disposable worktree the verification
 *   engine makes and tears down through the guard; the registered checkout is only read. Their
 *   author, committer, dates and messages come from their inputs, so freezing twice gives one commit.
 * - The declared parent and the pinned base come from the tasks' write-target records (S-TB-06), and
 *   must be the same for every task.
 */

/** One SUCCEEDED task's result in a repository: its last recorded commit and the origin its branch has. */
export interface TaskResult {
  taskId: string;
  title: string;
  commit: string;
  declaredParent: string;
  baseSha: string;
  /** #1242 — the commit its branch started at, when not `baseSha`: its predecessors' integration. */
  startSha?: string;
}

export interface IntegratedCandidate {
  head: string;
  integration: SnapshotIntegration;
  declaredParent: string;
  baseSha: string;
  /**
   * #1268 — internal execution evidence, one per merge commit the integration made: the parents and tree
   * CommitLore's commit-msg check was bound to, and the commit made with exactly them. No capture, no record.
   */
  commitloreMergeChecks: MergeCheckBinding[];
}

/** #1268 — a merge commit and the parents, tree and message its CommitLore check was bound to; the commit has exactly them. */
export interface MergeCheckBinding {
  commit: string;
  parents: [string, string];
  tree: string;
  messageDigest: string;
}

/**
 * #1268 — CommitLore's commit-msg check of one merge commit the integration is about to make, in the worktree
 * it is made in, on its exact message (`checkGeneratedCommitMessage`). A refusal means the commit is not made.
 * A pass is a message check, not a capture: no session produced the merge, so nothing is recorded on it.
 * Absent for a run whose contract does not require CommitLore.
 */
export type CheckMergeMessage = (input: {
  checkout: string;
  git: { gitDir: string; workTree: string; objectFormat: "sha1" | "sha256" };
  message: string;
  scratch: string;
  /** The integration's private index, staging exactly `tree`: the index the check runs with. */
  index: string;
  /** The merge's parents, in order, and the tree it will have. */
  parents: [string, string];
  tree: string;
}) => Promise<Decision<void>>;

/** A disposable worktree of the run's repository at `head`, made and torn down through the guard. */
export type RunWorktree = <T>(
  input: { purpose: string; inputDigest: string; repositoryIdentity: string; head: string },
  use: (worktreePath: string) => Promise<Decision<T>>,
) => Promise<Decision<T>>;

/** The `verification_worktrees.command_id` and worktree-id prefix of an integration's worktree. */
export const INTEGRATION_WORKTREE_PURPOSE = "candidate-integration";

/** #1242 — the same, for the integration a dependent task's branch starts from. */
export const PREDECESSOR_BASE_WORKTREE_PURPOSE = "predecessor-base";

/** One SUCCEEDED task's own commit, in the repository its execution ran in. */
export interface SucceededTaskCommit {
  taskId: string;
  commit: string;
  repositoryIdentity: string;
  /** The SUCCEEDED execution whose receipt names the commit, and the result digest that receipt reads back by. */
  executionId: string;
  resultDigest: string;
  /** #1232 — the CTO PLAN attestation the same receipt binds for exact opaque, potentially active imports. */
  imports: TaskImport[];
}

/** #1232 — a receipt's recorded opaque-active import attestation, or none when it records no valid one. */
const importsOf = (recorded: unknown): TaskImport[] => {
  if (typeof recorded !== "string") return [];
  try {
    const parsed = parseImportManifest(JSON.parse(recorded) as unknown, ["."]);
    return parsed.allowed ? parsed.value : [];
  } catch {
    return [];
  }
};

/**
 * The one source of a run's SUCCEEDED task commits, for the integration and for the freeze's
 * missing-commit guard alike (S6-B, S6-C), so the two can never be asked about different commits.
 * Each task's latest SUCCEEDED attempt only, and only when its own SUCCEEDED evidence still reads
 * back by both its execution id and its stored result digest, the two values ACP-WORKER-02 bound
 * together when the receipt was written. A receipt that cannot be read back that way names nothing.
 * CEO msg_8f666e55 — a task a registered correction supersedes is read here like any other: only the
 * freeze's task results leave it out (`supersessionOf`); a dependent task still starts from it (#1242).
 */
export const succeededTaskCommits = (db: Db, runId: string): SucceededTaskCommit[] => {
  const rows = db.all<{ taskId: string; executionId: string; resultDigest: string; commitHead: unknown; repositoryIdentity: string | null; imports: unknown }>(
    `SELECT te.task_id AS taskId,
            te.execution_id AS executionId,
            te.result_digest AS resultDigest,
            json_extract(a.evidence_json, '$.commitHead') AS commitHead,
            r.identity AS repositoryIdentity,
            json_extract(a.evidence_json, '$.imports') AS imports
       FROM task_executions te
       JOIN audit_events a
         ON a.kind = ?
        AND json_extract(a.evidence_json, '$.executionId') = te.execution_id
        AND json_extract(a.evidence_json, '$.resultDigest') = te.result_digest
       LEFT JOIN repositories r ON r.repository_id = te.repository_id
      WHERE te.run_id = ?
        AND te.status = 'SUCCEEDED'
        AND te.attempt = (
          SELECT MAX(te2.attempt) FROM task_executions te2
           WHERE te2.task_id = te.task_id AND te2.status = 'SUCCEEDED'
        )
      ORDER BY te.task_id, a.event_id DESC`,
    [WorkerTurnEvent.SUCCEEDED, runId],
  );
  const commits = new Map<string, SucceededTaskCommit>();
  for (const row of rows) {
    if (commits.has(row.taskId) || typeof row.commitHead !== "string" || row.commitHead.length === 0 || !row.repositoryIdentity) continue;
    commits.set(row.taskId, {
      taskId: row.taskId,
      commit: row.commitHead,
      repositoryIdentity: row.repositoryIdentity,
      executionId: row.executionId,
      resultDigest: row.resultDigest,
      imports: importsOf(row.imports),
    });
  }
  return [...commits.values()];
};

/**
 * CEO msg_8f666e55 — what a registered correction of a SUCCEEDED task is bound to: the receipt each of the two
 * tasks has (`succeededTaskCommits`), its execution, result digest and commit, in their one repository.
 */
export interface SupersessionBinding {
  repositoryIdentity: string;
  original: { taskId: string; executionId: string; resultDigest: string; commitHead: string };
  correction: { taskId: string; executionId: string; resultDigest: string; commitHead: string };
}

const bindingOf = (receipts: readonly SucceededTaskCommit[], originalTaskId: string, correctionTaskId: string): Decision<SupersessionBinding> => {
  const original = receipts.find((receipt) => receipt.taskId === originalTaskId);
  const correction = receipts.find((receipt) => receipt.taskId === correctionTaskId);
  if (!original || !correction) {
    return deny(ReasonCode.TASK_RECEIPT_MISSING, "a SUCCEEDED task is superseded only by a correction when both have a SUCCEEDED commit receipt", {
      refusal: "CORRECTION_RECEIPT_MISSING",
      missing: [original ? null : originalTaskId, correction ? null : correctionTaskId].filter((id) => id !== null),
    });
  }
  if (original.repositoryIdentity !== correction.repositoryIdentity) {
    return deny(ReasonCode.INVALID_ARGUMENT, "a correction's commit is in the repository of the task it supersedes", {
      refusal: "CORRECTION_ACROSS_REPOSITORIES",
      repositoryIdentity: original.repositoryIdentity,
      correctionRepositoryIdentity: correction.repositoryIdentity,
    });
  }
  const of = (receipt: SucceededTaskCommit) => ({ taskId: receipt.taskId, executionId: receipt.executionId, resultDigest: receipt.resultDigest, commitHead: receipt.commit });
  return allow(ReasonCode.OK, { repositoryIdentity: original.repositoryIdentity, original: of(original), correction: of(correction) });
};

/** CEO msg_8f666e55 — the binding `registerCorrection` records for a SUCCEEDED task and its correction, or why there is none. */
export const supersessionBinding = (db: Db, runId: string, originalTaskId: string, correctionTaskId: string): Decision<SupersessionBinding> =>
  bindingOf(succeededTaskCommits(db, runId), originalTaskId, correctionTaskId);

/**
 * CEO msg_8f666e55 — what the freeze's task results leave out (`superseded`), and the last task of each chain of
 * corrections (`terminals`), whose change is read against the run's pinned base (`succeededTaskResults`): built
 * on a task it supersedes, it carries what it kept of that task's change, which no other result now names.
 */
export interface Supersession {
  superseded: ReadonlySet<string>;
  terminals: ReadonlySet<string>;
}

/**
 * CEO msg_8f666e55 — the run's SUCCEEDED tasks a registered correction supersedes, read again from the records and
 * the receipts as they are now: exactly one correction claims the task and claims no other, a record of that
 * relation binds exactly both tasks' current receipts in one repository (`bindingOf`), and following corrections
 * from the task ends at one nothing supersedes, which alone stays a task result (a cycle supersedes nothing). A
 * FAILED task's correction (#1368) binds no receipt and supersedes nothing here. Nothing picks a winner by time or
 * ancestry: without such a relation every SUCCEEDED task is a result, and the path-level conflict check decides.
 * Review r2 — refused, CORRECTION_ORIGINAL_HAS_DEPENDENTS, while a task outside a superseded task's chain builds on
 * it (`tasksBuildingOn`), as one planned after the relation was registered can: nothing is merged around it. Review
 * r3 — only a task result counts: a superseded task, or a FAILED one a correction settles, contributes nothing.
 */
export const supersessionOf = (db: Db, runId: string, receipts: readonly SucceededTaskCommit[]): Decision<Supersession> => {
  const relations = db
    .all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`, [TASK_CORRECTION_REGISTERED, runId])
    .map((row) => JSON.parse(row.evidence_json) as { originalTaskId?: unknown; correctionTaskId?: unknown; supersedes?: unknown });
  const replacedBy = new Map<string, string>();
  for (const originalTaskId of new Set(relations.map((relation) => relation.originalTaskId))) {
    const claims = relations.filter((relation) => relation.originalTaskId === originalTaskId);
    const correctionTaskId = claims[0]?.correctionTaskId;
    if (typeof originalTaskId !== "string" || typeof correctionTaskId !== "string") continue;
    if (claims.some((claim) => claim.correctionTaskId !== correctionTaskId)) continue;
    if (relations.some((relation) => relation.correctionTaskId === correctionTaskId && relation.originalTaskId !== originalTaskId)) continue;
    const bound = bindingOf(receipts, originalTaskId, correctionTaskId);
    if (!bound.allowed) continue;
    const current = digestOf(bound.value);
    if (claims.some((claim) => claim.supersedes !== undefined && digestOf(claim.supersedes) === current)) replacedBy.set(originalTaskId, correctionTaskId);
  }
  const later = new Map<string, Set<string>>();
  const terminals = new Set<string>();
  for (const taskId of replacedBy.keys()) {
    const seen = new Set<string>();
    let at = taskId;
    while (replacedBy.has(at) && !seen.has(at)) {
      seen.add(at);
      at = replacedBy.get(at)!;
    }
    if (replacedBy.has(at)) continue;
    const after = new Set([...seen, at]);
    after.delete(taskId);
    later.set(taskId, after);
    terminals.add(at);
  }
  const results = receipts.map((receipt) => receipt.taskId).filter((taskId) => !later.has(taskId)).sort();
  for (const [taskId, after] of later) {
    const dependents = tasksBuildingOn(db, runId, taskId, after, results);
    if (dependents.length > 0) {
      return deny(ReasonCode.CORRECTION_ORIGINAL_HAS_DEPENDENTS, "a task outside its chain of corrections builds on a task a correction supersedes; the candidate is not frozen", {
        runId, refusal: "CORRECTION_ORIGINAL_HAS_DEPENDENTS", supersededTaskId: taskId, correctionTaskId: replacedBy.get(taskId), dependents,
      });
    }
  }
  return allow(ReasonCode.OK, { superseded: new Set(later.keys()), terminals });
};

/**
 * The commits of `succeededTaskCommits` in this repository that the integration can place: each
 * task's recorded write target is in the same repository and names the origin its branch was made
 * at. A commit with no such target is not integrated, and the freeze's guard then refuses the
 * candidate for it unless the checkout's HEAD already holds it.
 */
export const succeededTaskResults = (
  db: Db,
  runId: string,
  tasks: readonly TaskRecord[],
  commits: readonly SucceededTaskCommit[],
  repositoryIdentity: string,
  /** CEO msg_8f666e55 — the chains' last tasks (`Supersession.terminals`): each one's change is read from `baseSha`. */
  measuredFromBase: ReadonlySet<string> = new Set(),
): TaskResult[] => {
  const titles = new Map(tasks.map((task) => [task.taskId, task.title]));
  const results: TaskResult[] = [];
  for (const succeeded of commits) {
    if (succeeded.repositoryIdentity !== repositoryIdentity) continue;
    const target = recordedWriteTarget(db, runId, succeeded.taskId);
    if (!target || target.repositoryIdentity !== repositoryIdentity) continue;
    results.push({
      taskId: succeeded.taskId,
      title: titles.get(succeeded.taskId) ?? "",
      commit: succeeded.commit,
      declaredParent: target.declaredParent,
      baseSha: target.baseSha,
      ...(target.startsFrom && !measuredFromBase.has(succeeded.taskId) ? { startSha: startOf(target) } : {}),
    });
  }
  return results;
};

/**
 * The order results are integrated in: Kahn's order over the whole run's task graph, so a dependency
 * that passes through a task of another repository still counts, always taking the smallest ready
 * task id. Null when the graph has a cycle.
 */
export const integrationOrder = (
  tasks: readonly Pick<TaskRecord, "taskId" | "dependsOn">[],
  results: readonly TaskResult[],
): TaskResult[] | null => {
  const indegree = new Map(tasks.map((task) => [task.taskId, 0]));
  const dependents = new Map(tasks.map((task) => [task.taskId, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!indegree.has(dependency)) continue;
      indegree.set(task.taskId, indegree.get(task.taskId)! + 1);
      dependents.get(dependency)!.push(task.taskId);
    }
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([taskId]) => taskId).sort();
  const position = new Map<string, number>();
  while (ready.length > 0) {
    const next = ready.shift()!;
    position.set(next, position.size);
    for (const dependent of dependents.get(next)!) {
      const left = indegree.get(dependent)! - 1;
      indegree.set(dependent, left);
      if (left === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (position.size !== tasks.length) return null;
  return [...results].sort((a, b) => position.get(a.taskId)! - position.get(b.taskId)!);
};

interface Change {
  path: string;
  mode: string | null;
  blob: string | null;
}

interface Planned {
  result: TaskResult;
  changes: Change[];
}

/** Two changed paths collide when they are one path, or one lies beneath the other. */
const collide = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Every pair of tasks that change a colliding path, with the paths; empty when none do. */
export const pathConflicts = (planned: readonly { taskId: string; paths: readonly string[] }[]): Array<{ tasks: [string, string]; paths: string[] }> => {
  const conflicts: Array<{ tasks: [string, string]; paths: string[] }> = [];
  for (let i = 0; i < planned.length; i += 1) {
    for (let j = i + 1; j < planned.length; j += 1) {
      const paths = new Set<string>();
      for (const a of planned[i]!.paths) {
        for (const b of planned[j]!.paths) {
          if (collide(a, b)) {
            paths.add(a);
            paths.add(b);
          }
        }
      }
      if (paths.size > 0) conflicts.push({ tasks: [planned[i]!.taskId, planned[j]!.taskId], paths: [...paths].sort() });
    }
  }
  return conflicts;
};

const gitOrThrow = async (repo: PinnedRepository, args: readonly string[], options: Parameters<typeof runPinnedGit>[2] = {}): Promise<string> => {
  const run = await runPinnedGit(repo, args, options);
  if (run.exitCode !== 0) {
    throw new Error(`git ${args[0]} ${run.exitCode === null ? "did not answer" : `exited ${run.exitCode}`}: ${run.stderr.slice(0, 300)}`);
  }
  return run.stdout;
};

/** 0 when `ancestor` is an ancestor of (or is) `of`, 1 when not; anything else is a failed read. */
const isAncestor = async (repo: PinnedRepository, ancestor: string, of: string): Promise<boolean | null> => {
  const run = await runPinnedGit(repo, ["merge-base", "--is-ancestor", ancestor, of]);
  return run.exitCode === 0 ? true : run.exitCode === 1 ? false : null;
};

/** The committer timestamp in the commit object itself; no log formatting, which could run a program. */
const committerEpoch = async (repo: PinnedRepository, commit: string): Promise<number> => {
  const raw = await gitOrThrow(repo, ["cat-file", "commit", commit]);
  const header = raw.slice(0, raw.indexOf("\n\n") === -1 ? raw.length : raw.indexOf("\n\n"));
  const epoch = /^committer .* (\d+) [+-]\d{4}$/m.exec(header)?.[1];
  if (epoch === undefined) throw new Error(`commit ${commit} has no committer timestamp`);
  return Number(epoch);
};

const subjectOf = (title: string): string => {
  const subject = title.replace(/\s+/g, " ").trim().slice(0, 120);
  return subject.length > 0 ? `Integrate: ${subject}` : "Integrate a task's work";
};

const withPinned = async <T>(workTree: string, prefix: string, read: (repo: PinnedRepository, scratch: string) => Promise<Decision<T>>): Promise<Decision<T>> => {
  const scratch = acpScratchDir(prefix);
  try {
    const pinned = pinRepository(workTree, scratch);
    if (!pinned.allowed) return pinned as Decision<never>;
    try {
      return await read(pinned.value, scratch);
    } catch (error) {
      return deny(ReasonCode.PROBE_FAILED, "the integration's git step failed; nothing was frozen", {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    } finally {
      pinned.value.children.retire();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

type Conflict = { tasks: [string, string]; paths: string[] };

/** Each task's change against the commit its branch started at, and the pairs of tasks whose changes collide. */
interface TaskChanges {
  ordered: TaskResult[];
  changesOf: Map<string, Change[]>;
  conflicts: Conflict[];
}

/**
 * Read-only: the integration order over the run's whole graph, each task's change against the commit
 * its branch started at, and every pair of tasks whose changes collide. #1242 — a task built on
 * another's commit (a dependent task starts from its predecessors) changed what they share on top of
 * it, so that pair is no conflict: the later task's version is the one integrated.
 */
const readTaskChanges = async (
  repo: PinnedRepository,
  input: { runId: string; tasks: readonly TaskRecord[]; results: readonly TaskResult[] },
): Promise<Decision<TaskChanges>> => {
  const ordered = integrationOrder(input.tasks, input.results);
  if (!ordered) {
    return deny(ReasonCode.TASK_DEPENDENCY_CYCLE, "the run's task graph has a cycle, so no integration order exists", { runId: input.runId });
  }
  const changesOf = new Map<string, Change[]>();
  for (const result of ordered) changesOf.set(result.taskId, await committedChanges(repo, result.startSha ?? result.baseSha, result.commit));
  const commitOf = new Map(ordered.map((result) => [result.taskId, result.commit]));
  const conflicts: Conflict[] = [];
  // `pathConflicts` names each pair in integration order, so the first is the one the second may be built on.
  for (const conflict of pathConflicts(ordered.map((result) => ({ taskId: result.taskId, paths: changesOf.get(result.taskId)!.map((change) => change.path) })))) {
    if ((await isAncestor(repo, commitOf.get(conflict.tasks[0])!, commitOf.get(conflict.tasks[1])!)) === true) continue;
    conflicts.push(conflict);
  }
  return allow(ReasonCode.OK, { ordered, changesOf, conflicts });
};

/** What an integration places, decided read-only before anything is written. */
interface Placement {
  baseSha: string;
  declaredParent: string;
  planned: Planned[];
  format: "sha1" | "sha256";
  /** Each task's commit is built on the one before it, so the last one already holds them all. */
  chain: boolean;
}

/**
 * Read-only: every task was made from one declared parent and pinned base (S-TB-06), and its commit
 * descends from that base; the tasks in order, each with its change.
 */
const placeResults = async (repo: PinnedRepository, changes: TaskChanges, repositoryIdentity: string): Promise<Decision<Placement>> => {
  const { ordered, changesOf } = changes;
  const origins = new Set(ordered.map((result) => `${result.declaredParent}\u0000${result.baseSha}`));
  if (origins.size !== 1) {
    return deny(ReasonCode.CONFLICT, "the run's task results in this repository were made from different origins; they are not integrated", {
      repositoryIdentity,
      origins: ordered.map((result) => ({ taskId: result.taskId, declaredParent: result.declaredParent, baseSha: result.baseSha })),
    });
  }
  const baseSha = ordered[0]!.baseSha;
  const planned: Planned[] = [];
  let chain = true;
  for (const result of ordered) {
    const descends = await isAncestor(repo, baseSha, result.commit);
    if (descends !== true) {
      return deny(ReasonCode.CONFLICT, "a task's recorded commit does not descend from the run's pinned base; it is not integrated", {
        repositoryIdentity,
        taskId: result.taskId,
        commit: result.commit,
        baseSha,
        readFailed: descends === null,
      });
    }
    const previous = planned.at(-1);
    if (previous && chain) chain = (await isAncestor(repo, previous.result.commit, result.commit)) === true;
    // One origin by now, so each change was read against this base or a start built on it.
    planned.push({ result, changes: changesOf.get(result.taskId)! });
  }
  return allow(ReasonCode.OK, { baseSha, declaredParent: ordered[0]!.declaredParent, planned, format: await objectFormatOf(repo), chain });
};

const ABSENT = "- -";
const entryOf = (change: Change): string => `${change.mode ?? "-"} ${change.blob ?? "-"}`;

/**
 * Each path's `<mode> <object>` in `commit`, for the paths asked; a path the commit lacks is absent.
 * Every path asked is a leaf a diff named (a file, a link or a submodule), so a tree that now stands at
 * that name is no such leaf: a directory that took a deleted file's name is that deletion (#1242).
 */
const entriesAt = async (repo: PinnedRepository, commit: string, paths: readonly string[]): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  for (let start = 0; start < paths.length; start += 500) {
    const listed = await gitOrThrow(repo, ["ls-tree", "-z", "--full-tree", commit, "--", ...paths.slice(start, start + 500)]);
    for (const entry of listed.split("\0").filter((line) => line.length > 0)) {
      const parsed = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry);
      if (parsed && parsed[2] !== "tree") found.set(parsed[4]!, `${parsed[1]} ${parsed[3]}`);
    }
  }
  return found;
};

/**
 * The integrated commit changes exactly what the tasks changed, each path as the last task to change
 * it left it. A path a later task put back as the base had it is in no diff against the base, so it
 * is read where it stands.
 */
const exactly = async (repo: PinnedRepository, repositoryIdentity: string, placement: Placement, head: string): Promise<Decision<string>> => {
  const expected = new Map(placement.planned.flatMap((step) => step.changes.map((change) => [change.path, entryOf(change)] as const)));
  const observed = new Map((await committedChanges(repo, placement.baseSha, head)).map((change) => [change.path, entryOf(change)]));
  const unchanged = [...expected.keys()].filter((path) => !observed.has(path));
  const standing = await entriesAt(repo, head, unchanged);
  const exact = [...observed].every(([path, entry]) => expected.get(path) === entry) &&
    unchanged.every((path) => (standing.get(path) ?? ABSENT) === expected.get(path));
  if (!exact) {
    return deny(ReasonCode.INTERNAL_ERROR, "the integrated commit does not change exactly what the tasks changed; nothing was built on it", {
      repositoryIdentity,
      head,
      expected: expected.size,
      observed: observed.size,
    });
  }
  return allow(ReasonCode.OK, head);
};

/**
 * #1268 — a merge whose index, parents (values and order), tree or message are not what its CommitLore check
 * was bound to is not made, or not kept.
 */
const unbound = (
  repositoryIdentity: string,
  bound: { indexDigest: string; parents: readonly [string, string]; tree: string; message: string },
  observed: Record<string, unknown>,
): Decision<never> =>
  deny(ReasonCode.VERIFICATION_GAP, "the merge is not the one its CommitLore check was bound to; nothing was built on it", {
    refusal: "COMMITLORE_MERGE_UNBOUND",
    repositoryIdentity,
    bound: { indexDigest: bound.indexDigest, parents: [...bound.parents], tree: bound.tree, messageDigest: sha256(bound.message) },
    observed,
  });

/**
 * The integrated commit of a placement, written as plumbing over a private index, in a disposable
 * worktree the verification engine makes and tears down through the guard.
 */
const buildIntegration = async (
  input: { purpose: string; inputDigest: string; repositoryIdentity: string; worktree: RunWorktree; checkMessage?: CheckMergeMessage },
  placement: Placement,
  checked: MergeCheckBinding[] = [],
): Promise<Decision<string>> => {
  const { baseSha, planned, format } = placement;
  return input.worktree<string>(
    { purpose: input.purpose, inputDigest: input.inputDigest, repositoryIdentity: input.repositoryIdentity, head: baseSha },
    (worktreePath) => withPinned<string>(worktreePath, "acp-integration-write-", async (repo, scratch) => {
      const zero = "0".repeat(format === "sha256" ? 64 : 40);
      const index = join(scratch, "integration.index");
      let head = planned[0]!.result.commit;
      for (const step of planned.slice(1)) {
        // #1242 — a task built on everything integrated so far already holds it: taken as it is, never applied twice.
        if ((await isAncestor(repo, head, step.result.commit)) === true) {
          head = step.result.commit;
          continue;
        }
        await gitOrThrow(repo, ["read-tree", head], { index });
        const entries = step.changes
          .map((change) => (change.mode === null ? `0 ${zero}\t${change.path}\0` : `${change.mode} ${change.blob}\t${change.path}\0`))
          .join("");
        await gitOrThrow(repo, ["update-index", "-z", "--index-info"], { index, input: entries });
        const tree = (await gitOrThrow(repo, ["write-tree"], { index })).trim();
        const date = `${Math.max(await committerEpoch(repo, head), await committerEpoch(repo, step.result.commit))} +0000`;
        const message = subjectOf(step.result.title);
        // #1268 — what the check is bound to, fixed before it runs: this merge's index (its path and bytes), its
        // parents in order, its tree and its message. The commit is made from these values, never from what the
        // check was handed, and any of them that is not the same after the check refuses the merge.
        const bound = Object.freeze({
          index,
          indexDigest: sha256(readFileSync(index)),
          parents: Object.freeze([head, step.result.commit] as [string, string]),
          tree,
          message,
        });
        if (input.checkMessage) {
          // The check is handed copies, and what it holds after it ran is compared with the bound values.
          const handed = {
            checkout: repo.workTree,
            git: { gitDir: repo.gitDir, workTree: repo.workTree, objectFormat: format },
            scratch,
            index,
            parents: [bound.parents[0], bound.parents[1]] as [string, string],
            tree,
            message,
          };
          const passed = await input.checkMessage(handed);
          if (!passed.allowed) return passed as Decision<string>;
          const after = {
            index: handed.index,
            indexDigest: sha256(readFileSync(bound.index)),
            parents: handed.parents,
            tree: (await gitOrThrow(repo, ["write-tree"], { index: bound.index })).trim(),
            handedTree: handed.tree,
            message: handed.message,
          };
          const differing = [
            after.index !== bound.index || after.indexDigest !== bound.indexDigest ? "index" : null,
            after.parents.length !== 2 || after.parents[0] !== bound.parents[0] || after.parents[1] !== bound.parents[1] ? "parents" : null,
            after.tree !== bound.tree || after.handedTree !== bound.tree ? "tree" : null,
            after.message !== bound.message ? "message" : null,
          ].filter((field): field is string => field !== null);
          if (differing.length > 0) return unbound(input.repositoryIdentity, bound, { differing });
        }
        const commit = (await gitOrThrow(repo, ["commit-tree", bound.tree, "-p", bound.parents[0], "-p", bound.parents[1], "--no-gpg-sign", "-m", bound.message], {
          extraEnv: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        })).trim();
        if (input.checkMessage) {
          // Read back: the commit made has exactly the parents, in order, the tree and the message the check was bound to.
          const made = (await gitOrThrow(repo, ["rev-list", "--parents", "-n", "1", commit])).trim().split(" ").slice(1);
          const raw = await gitOrThrow(repo, ["cat-file", "commit", commit]);
          const madeTree = /^tree ([0-9a-f]+)$/m.exec(raw)?.[1] ?? null;
          const madeMessage = raw.slice(raw.indexOf("\n\n") + 2).trimEnd();
          if (made.length !== 2 || made[0] !== bound.parents[0] || made[1] !== bound.parents[1] || madeTree !== bound.tree || madeMessage !== bound.message.trimEnd()) {
            return unbound(input.repositoryIdentity, bound, { differing: ["commit"], parents: made, tree: madeTree, commit });
          }
          checked.push({ commit, parents: [bound.parents[0], bound.parents[1]], tree: bound.tree, messageDigest: sha256(bound.message) });
        }
        head = commit;
      }
      return exactly(repo, input.repositoryIdentity, placement, head);
    }),
  );
};

/** Whether `head` already holds every result's commit: the case in which the candidate is the checkout's HEAD. */
const holdsEvery = async (repo: PinnedRepository, results: readonly TaskResult[], head: string): Promise<boolean> =>
  (await Promise.all(results.map((result) => isAncestor(repo, result.commit, head)))).every((answer) => answer === true);

/**
 * #1268 — read-only: the checkout's HEAD when `integrateTaskResults` would take it as the candidate (the run has
 * no SUCCEEDED result it places in this repository, or HEAD already holds every one), else null. Conflicts are
 * not asked: the integration refuses them either way. A HEAD, or an ancestry, that cannot be read is refused
 * (CANDIDATE_RANGE_UNVERIFIABLE), never taken as an answer.
 */
export const checkoutHeadAsCandidate = async (input: {
  db: Db;
  runId: string;
  tasks: readonly TaskRecord[];
  commits: readonly SucceededTaskCommit[];
  repositoryIdentity: string;
  checkoutPath: string;
}): Promise<Decision<string | null>> => {
  const results = succeededTaskResults(input.db, input.runId, input.tasks, input.commits, input.repositoryIdentity);
  return withPinned<string | null>(input.checkoutPath, "acp-integration-head-", async (repo) => {
    const unreadable = (ref: string): Decision<never> =>
      deny(ReasonCode.CANDIDATE_RANGE_UNVERIFIABLE, "the checkout's HEAD or its history could not be read, so the freeze is refused", {
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        refusal: "OBJECT_UNREADABLE",
        ref,
      });
    const headRead = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (headRead.exitCode !== 0) return unreadable("HEAD");
    const head = headRead.stdout.trim();
    if (results.length === 0) return allow(ReasonCode.OK, head);
    const answers = await Promise.all(results.map((result) => isAncestor(repo, result.commit, head)));
    const unread = results.find((_, at) => answers[at] === null);
    if (unread !== undefined) return unreadable(unread.commit);
    return allow(ReasonCode.OK, answers.every((answer) => answer === true) ? head : null);
  });
};

/**
 * The run's integrated candidate in one repository, or null when no two tasks' changes overlap and
 * the checkout's HEAD already holds every SUCCEEDED task's commit (a single-task run, as before), or
 * there is no result at all. Overlapping tasks are refused either way.
 */
export const integrateTaskResults = async (input: {
  db: Db;
  runId: string;
  tasks: readonly TaskRecord[];
  /** The freeze's task results: `succeededTaskCommits` of the run, read once, less what a correction supersedes. */
  commits: readonly SucceededTaskCommit[];
  repositoryIdentity: string;
  checkoutPath: string;
  worktree: RunWorktree;
  /** #1268 — given for a run whose contract requires CommitLore. */
  checkMessage?: CheckMergeMessage;
  /** CEO msg_8f666e55 — `Supersession.terminals`: each one's change is read against the pinned base. */
  measuredFromBase?: ReadonlySet<string>;
}): Promise<Decision<IntegratedCandidate | null>> => {
  const results = succeededTaskResults(input.db, input.runId, input.tasks, input.commits, input.repositoryIdentity, input.measuredFromBase);
  if (results.length === 0) return allow(ReasonCode.OK, null);

  // Read-only, over the registered checkout: everything is decided, and every conflict refused,
  // before anything is written.
  type Plan = (Placement & { checkoutHead: string }) | null;
  const plan = await withPinned<Plan>(input.checkoutPath, "acp-integration-read-", async (repo) => {
    const headRead = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    const checkoutHead = headRead.exitCode === 0 ? headRead.stdout.trim() : null;
    if (checkoutHead === null) return allow(ReasonCode.OK, null);
    const read = await readTaskChanges(repo, { runId: input.runId, tasks: input.tasks, results });
    if (!read.allowed) return read as Decision<never>;
    // S6 review r2 — two tasks that change one path, or a path and one beneath it, are a conflict
    // whether or not the checkout's HEAD already holds both commits: a merge someone made by hand
    // is not the control plane choosing between them. So this is asked before the shortcut below.
    const { conflicts } = read.value;
    if (conflicts.length > 0) {
      const named = conflicts.map((conflict) => `${conflict.tasks.join(" and ")} both change ${conflict.paths.join(", ")}`).join("; ");
      return deny(
        ReasonCode.CONFLICT,
        `the run's task results cannot be integrated: ${named}. The candidate is not frozen; the control plane does not choose between them`,
        { repositoryIdentity: input.repositoryIdentity, baseSha: read.value.ordered[0]!.baseSha, conflicts: conflicts.slice(0, 20) },
      );
    }
    // No overlap, and HEAD already holds every task's commit: the candidate is HEAD, as before.
    if (await holdsEvery(repo, results, checkoutHead)) return allow(ReasonCode.OK, null);
    const placed = await placeResults(repo, read.value, input.repositoryIdentity);
    if (!placed.allowed) return placed as Decision<never>;
    return allow(ReasonCode.OK, { ...placed.value, checkoutHead });
  });
  if (!plan.allowed || plan.value === null) return plan as Decision<null>;
  const { checkoutHead, baseSha, planned } = plan.value;
  const integration: SnapshotIntegration = {
    checkoutHead,
    tasks: planned.map((step) => ({ taskId: step.result.taskId, commit: step.result.commit })),
  };
  const inputDigest = digestOf({ schema: "agent-control-plane.candidate-integration.v1", runId: input.runId, repositoryIdentity: input.repositoryIdentity, baseSha, tasks: integration.tasks });
  const checked: MergeCheckBinding[] = [];
  const built = await buildIntegration(
    {
      purpose: INTEGRATION_WORKTREE_PURPOSE,
      inputDigest,
      repositoryIdentity: input.repositoryIdentity,
      worktree: input.worktree,
      ...(input.checkMessage === undefined ? {} : { checkMessage: input.checkMessage }),
    },
    plan.value,
    checked,
  );
  if (!built.allowed) return built as Decision<null>;
  return allow(ReasonCode.OK, { head: built.value, integration, declaredParent: plan.value.declaredParent, baseSha, commitloreMergeChecks: checked });
};

/**
 * #1242 — the commit a task with dependsOn predecessors starts from: each predecessor's SUCCEEDED
 * commit in this repository, integrated on the run's pinned base by the freeze's own rules and
 * builder above (order, change, overlap, origin, exactness), so its worker starts with every file
 * they changed. Null when none of them changed this repository. Refused, never replaced by the run's
 * base: a predecessor with no SUCCEEDED commit or write target, or whose commit the repository does
 * not hold (TASK_PREDECESSOR_COMMIT_MISSING), or two predecessors that change one path where neither
 * is built on the other (TASK_PREDECESSORS_OVERLAP). Keeping the result from gc is the caller's.
 */
export const integratePredecessors = async (input: {
  db: Db;
  runId: string;
  taskId: string;
  tasks: readonly TaskRecord[];
  /** Every task `taskId` depends on, directly or through another, each SUCCEEDED. */
  predecessors: readonly string[];
  repositoryIdentity: string;
  checkoutPath: string;
  baseSha: string;
  worktree: RunWorktree;
  /** #1268 — given for a run whose contract requires CommitLore. */
  checkMessage?: CheckMergeMessage;
  /** #1268 — receives each merge the base's integration made with `checkMessage` passing, bound as the freeze's are. */
  checked?: MergeCheckBinding[];
}): Promise<Decision<StartsFrom | null>> => {
  const missing = (predecessor: string, missingWhat: string, commit: string | null, repositoryIdentity = input.repositoryIdentity): Decision<never> =>
    deny(ReasonCode.TASK_PREDECESSOR_COMMIT_MISSING, `a task this one depends on has no ${missingWhat} to start from; it is not started at the run's base instead`, {
      taskId: input.taskId,
      predecessor,
      commit,
      repositoryIdentity,
    });
  const receipts = new Map(succeededTaskCommits(input.db, input.runId).map((receipt) => [receipt.taskId, receipt]));
  const byRepository = new Map<string, SucceededTaskCommit[]>();
  for (const predecessor of [...input.predecessors].sort()) {
    const receipt = receipts.get(predecessor);
    const target = recordedWriteTarget(input.db, input.runId, predecessor);
    if (!receipt) return missing(predecessor, "SUCCEEDED commit", null);
    if (!target || target.repositoryIdentity !== receipt.repositoryIdentity) return missing(predecessor, "recorded write target in its commit's repository", receipt.commit);
    byRepository.set(receipt.repositoryIdentity, [...(byRepository.get(receipt.repositoryIdentity) ?? []), receipt]);
  }
  // Review P2-a — every predecessor's commit is asked in its own repository first, whichever one this
  // task writes: a commit lost from another repository refuses it exactly as one lost from this one.
  const checkouts = new Map(input.db.all<{ identity: string; checkoutPath: string }>(
    `SELECT r.identity, r.checkout_path AS checkoutPath FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
      WHERE rr.run_id = ?`,
    [input.runId],
  ).map((row) => [row.identity, row.checkoutPath]));
  for (const [repositoryIdentity, held] of byRepository) {
    const checkoutPath = repositoryIdentity === input.repositoryIdentity ? input.checkoutPath : checkouts.get(repositoryIdentity);
    if (!checkoutPath) return missing(held[0]!.taskId, "repository this run includes", held[0]!.commit, repositoryIdentity);
    const lost = await withPinned<SucceededTaskCommit | null>(checkoutPath, "acp-predecessor-held-", async (repo) => {
      for (const receipt of held) {
        const read = await runPinnedGit(repo, ["cat-file", "-e", `${receipt.commit}^{commit}`]);
        if (read.exitCode !== 0) return allow(ReasonCode.OK, receipt);
      }
      return allow(ReasonCode.OK, null);
    });
    if (!lost.allowed) return lost as Decision<never>;
    if (lost.value) return missing(lost.value.taskId, "commit its repository still holds", lost.value.commit, repositoryIdentity);
  }
  const here = byRepository.get(input.repositoryIdentity) ?? [];
  if (here.length === 0) return allow(ReasonCode.OK, null);
  const results = succeededTaskResults(input.db, input.runId, input.tasks, here, input.repositoryIdentity);

  const plan = await withPinned<Placement>(input.checkoutPath, "acp-predecessor-read-", async (repo) => {
    const read = await readTaskChanges(repo, { runId: input.runId, tasks: input.tasks, results });
    if (!read.allowed) return read as Decision<never>;
    const { conflicts } = read.value;
    if (conflicts.length > 0) {
      const named = conflicts.map((conflict) => `${conflict.tasks.join(" and ")} both change ${conflict.paths.join(", ")}`).join("; ");
      return deny(
        ReasonCode.TASK_PREDECESSORS_OVERLAP,
        `the tasks this one depends on cannot be integrated: ${named}. It is not started at the run's base instead; the control plane does not choose between them`,
        { taskId: input.taskId, repositoryIdentity: input.repositoryIdentity, conflicts: conflicts.slice(0, 20) },
      );
    }
    const placed = await placeResults(repo, read.value, input.repositoryIdentity);
    if (!placed.allowed || placed.value.baseSha === input.baseSha) return placed;
    return deny(ReasonCode.CONFLICT, "the tasks this one depends on were made from another base than the run's; it is not started from them", {
      taskId: input.taskId,
      repositoryIdentity: input.repositoryIdentity,
      baseSha: input.baseSha,
      predecessorsBase: placed.value.baseSha,
    });
  });
  if (!plan.allowed) return plan as Decision<never>;
  const predecessors = plan.value.planned.map((step) => ({ taskId: step.result.taskId, commit: step.result.commit }));
  const inputDigest = digestOf({
    schema: "agent-control-plane.predecessor-base.v1",
    runId: input.runId,
    taskId: input.taskId,
    repositoryIdentity: input.repositoryIdentity,
    baseSha: input.baseSha,
    tasks: predecessors,
  });
  // A chain, each predecessor built on the one before it (one predecessor is the common case), is its
  // last commit: nothing is written, and it is checked read-only over the registered checkout.
  const placement = plan.value;
  const built = placement.chain
    ? await withPinned<string>(input.checkoutPath, "acp-predecessor-check-", (repo) => exactly(repo, input.repositoryIdentity, placement, placement.planned.at(-1)!.result.commit))
    : await buildIntegration(
      {
        purpose: PREDECESSOR_BASE_WORKTREE_PURPOSE,
        inputDigest,
        repositoryIdentity: input.repositoryIdentity,
        worktree: input.worktree,
        ...(input.checkMessage === undefined ? {} : { checkMessage: input.checkMessage }),
      },
      placement,
      input.checked,
    );
  if (!built.allowed) return built as Decision<never>;
  return allow(ReasonCode.OK, { commit: built.value, predecessors });
};

/**
 * S6 review (P1) — ancestry alone can hide a task's lost bytes: a merge that keeps one side
 * (`git merge -s ours`) makes a task's commit an ancestor of a candidate that holds none of its
 * change. So when a repository has two or more task commits, every path a task's commit changes
 * against the commit its branch started at must stand in the candidate tree exactly as that task
 * left it: the same mode and blob, or absent for a deletion. The one exception is a path that a later
 * recorded task commit descending from it changed too (that task was built on top of it); the later
 * version is then the one asked for. A task without dependsOn predecessors starts at the pinned base
 * and descends from no other task (S-TB); a dependent one is built on its predecessors (#1242). The last
 * task of a chain of corrections (`measuredFromBase`) is asked against the pinned base, as it is integrated.
 * Read-only, over the registered checkout. Lists each task with the paths it lost.
 */
export const lostTaskChanges = async (input: {
  db: Db;
  runId: string;
  commits: readonly SucceededTaskCommit[];
  repositoryIdentity: string;
  checkoutPath: string;
  candidateHead: string;
  measuredFromBase?: ReadonlySet<string>;
}): Promise<Decision<Array<{ taskId: string; commitHead: string; paths: string[] }>>> => {
  const here = input.commits.filter((commit) => commit.repositoryIdentity === input.repositoryIdentity);
  if (here.length < 2) return allow(ReasonCode.OK, []);
  type Lost = Array<{ taskId: string; commitHead: string; paths: string[] }>;
  return withPinned<Lost>(input.checkoutPath, "acp-integration-content-", async (repo) => {
    const targets = new Map(here.map((commit) => [commit.taskId, recordedWriteTarget(input.db, input.runId, commit.taskId)]));
    const pin = [...targets.values()].find((target) => target?.repositoryIdentity === input.repositoryIdentity)?.baseSha ?? null;
    const shared = pin ?? (await gitOrThrow(repo, ["merge-base", "--octopus", ...here.map((commit) => commit.commit)])).trim();
    const changes = new Map<string, Map<string, string>>();
    for (const commit of here) {
      const target = targets.get(commit.taskId);
      const base = target?.repositoryIdentity !== input.repositoryIdentity ? shared : input.measuredFromBase?.has(commit.taskId) ? target.baseSha : startOf(target);
      changes.set(commit.taskId, new Map((await committedChanges(repo, base, commit.commit)).map((change) => [change.path, entryOf(change)])));
    }
    const descends = new Map<string, boolean>();
    const builtOn = async (earlier: SucceededTaskCommit, later: SucceededTaskCommit): Promise<boolean> => {
      if (earlier.commit === later.commit) return false;
      const key = `${earlier.commit}..${later.commit}`;
      if (!descends.has(key)) {
        const answer = await isAncestor(repo, earlier.commit, later.commit);
        if (answer === null) throw new Error(`the ancestry of ${earlier.commit} and ${later.commit} could not be read`);
        descends.set(key, answer);
      }
      return descends.get(key)!;
    };
    const asked = new Map<string, Array<{ path: string; expected: string }>>();
    for (const commit of here) {
      for (const [path, expected] of changes.get(commit.taskId)!) {
        let superseded = false;
        for (const later of here) {
          if (later.taskId !== commit.taskId && changes.get(later.taskId)!.has(path) && (await builtOn(commit, later))) {
            superseded = true;
            break;
          }
        }
        if (!superseded) asked.set(commit.taskId, [...(asked.get(commit.taskId) ?? []), { path, expected }]);
      }
    }
    const paths = [...new Set([...asked.values()].flat().map((entry) => entry.path))].sort();
    const inCandidate = await entriesAt(repo, input.candidateHead, paths);
    const lost: Lost = [];
    for (const commit of here) {
      const missing = (asked.get(commit.taskId) ?? [])
        .filter(({ path, expected }) => (inCandidate.get(path) ?? ABSENT) !== expected)
        .map(({ path }) => path);
      if (missing.length > 0) lost.push({ taskId: commit.taskId, commitHead: commit.commit, paths: missing.slice(0, 50) });
    }
    return allow(ReasonCode.OK, lost);
  });
};

/** #1268 — why a commit in a governed candidate's range is not one the run's CommitLore path accounts for. */
export type ForeignCommitRefusal =
  /** No SUCCEEDED worker receipt of this run in this repository names it, and it is no merge. */
  | "NOT_A_RUN_WORKER_COMMIT"
  /** A receipt names it, with no CommitLore evidence. */
  | "COMMITLORE_EVIDENCE_MISSING"
  /** A receipt names it, with an outcome other than `recorded` or `empty`. */
  | "COMMITLORE_OUTCOME_UNKNOWN"
  /** A receipt names it, with record ids that are not strings, `empty` with ids, or `recorded` with none. */
  | "COMMITLORE_EVIDENCE_MALFORMED"
  /** A receipt names it, and the commit's own `Record-Id` trailers are not exactly the receipt's record ids. */
  | "RECORD_IDS_MISMATCH"
  /** A merge no check of this freeze was bound to. */
  | "MERGE_NOT_CHECKED"
  /** A merge listed as checked whose parents, their order, tree or message are not what its check was bound to. */
  | "MERGE_NOT_BOUND";

export interface ForeignCommit {
  commit: string;
  refusal: ForeignCommitRefusal;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * #1268 — the audit kind a governed run's predecessor base (#1242) is recorded under when its integration made
 * merges: the task it is for, its commit, and each merge's check binding (`MergeCheckBinding`).
 */
export const PREDECESSOR_BASE_MERGES_CHECKED = "PREDECESSOR_BASE_MERGES_CHECKED";

/**
 * #1268 — the merge check bindings recorded for this run's predecessor bases in a repository, each only when a
 * write target recorded for the same task of this run starts from that base's commit (`startsFrom.commit`).
 */
export const recordedPredecessorMergeChecks = (db: Db, runId: string, repositoryIdentity: string): MergeCheckBinding[] => {
  const rows = db.all<{ checks: string | null }>(
    `SELECT json_extract(b.evidence_json, '$.commitloreMergeChecks') AS checks
       FROM audit_events b
      WHERE b.kind = ? AND b.run_id = ?
        AND json_extract(b.evidence_json, '$.repositoryIdentity') = ?
        AND EXISTS (
          SELECT 1 FROM audit_events t
           WHERE t.kind = ? AND t.run_id = b.run_id
             AND json_extract(t.evidence_json, '$.taskId') = json_extract(b.evidence_json, '$.taskId')
             AND json_extract(t.evidence_json, '$.writeTarget.repositoryIdentity') = ?
             AND json_extract(t.evidence_json, '$.writeTarget.startsFrom.commit') = json_extract(b.evidence_json, '$.commit')
        )`,
    [PREDECESSOR_BASE_MERGES_CHECKED, runId, repositoryIdentity, TASK_WRITE_TARGET_RECORDED, repositoryIdentity],
  );
  const isBinding = (value: unknown): value is MergeCheckBinding => {
    const check = value as Partial<MergeCheckBinding> | null;
    return typeof check === "object" && check !== null && typeof check.commit === "string" && typeof check.tree === "string" &&
      typeof check.messageDigest === "string" && Array.isArray(check.parents) && check.parents.length === 2 &&
      check.parents.every((parent) => typeof parent === "string");
  };
  return rows.flatMap((row) => {
    const checks = row.checks === null ? null : (JSON.parse(row.checks) as unknown);
    return Array.isArray(checks) ? checks.filter(isBinding) : [];
  });
};

/**
 * Every `Record-Id` line of a commit message, its value trimmed. Read more loosely than CommitLore writes it
 * (any case, any spacing), so a line that only looks like a trailer still counts against the receipt.
 */
const recordIdsOf = (message: string): string[] => [...message.matchAll(/^record-id[ \t]*:(.*)$/gim)].map((match) => match[1]!.trim());

/**
 * #1268 — this run's SUCCEEDED worker receipts in a repository, by the commit each names: every attempt's, read
 * the way `succeededTaskCommits` reads one (the row of this run and task whose execution id and result digest are
 * the ones stored on the execution), each with the CommitLore evidence it carries, or undefined.
 */
const workerReceiptsByCommit = (db: Db, runId: string, repositoryIdentity: string): Map<string, unknown[]> => {
  const rows = db.all<{ evidence: string }>(
    `SELECT a.evidence_json AS evidence
       FROM task_executions te
       JOIN repositories r ON r.repository_id = te.repository_id
       JOIN audit_events a
         ON a.kind = ?
        AND a.run_id = te.run_id
        AND json_extract(a.evidence_json, '$.taskId') = te.task_id
        AND json_extract(a.evidence_json, '$.executionId') = te.execution_id
        AND json_extract(a.evidence_json, '$.resultDigest') = te.result_digest
      WHERE te.run_id = ? AND te.status = 'SUCCEEDED' AND r.identity = ?`,
    [WorkerTurnEvent.SUCCEEDED, runId, repositoryIdentity],
  );
  const byCommit = new Map<string, unknown[]>();
  for (const row of rows) {
    const evidence = JSON.parse(row.evidence) as { commitHead?: unknown; commitlore?: unknown };
    if (typeof evidence.commitHead !== "string" || evidence.commitHead.length === 0) continue;
    byCommit.set(evidence.commitHead, [...(byCommit.get(evidence.commitHead) ?? []), evidence.commitlore]);
  }
  return byCommit;
};

/** Why one receipt's CommitLore evidence does not account for a commit whose message is `message`; null when it does. */
const unaccounted = (commitlore: unknown, message: string): ForeignCommitRefusal | null => {
  if (typeof commitlore !== "object" || commitlore === null || Array.isArray(commitlore)) return "COMMITLORE_EVIDENCE_MISSING";
  const { outcome, recordIds } = commitlore as { outcome?: unknown; recordIds?: unknown };
  if (outcome !== "recorded" && outcome !== "empty") return "COMMITLORE_OUTCOME_UNKNOWN";
  if (!Array.isArray(recordIds) || !recordIds.every((id) => typeof id === "string")) return "COMMITLORE_EVIDENCE_MALFORMED";
  if ((outcome === "empty") !== (recordIds.length === 0)) return "COMMITLORE_EVIDENCE_MALFORMED";
  const carried = recordIdsOf(message);
  return carried.length === recordIds.length && carried.every((id, at) => id === recordIds[at]) ? null : "RECORD_IDS_MISMATCH";
};

/** GAP 1 — why a task whose registered spec requires a CommitLore capture is not accounted for at freeze. */
export type TaskCaptureRefusal =
  /** The task is not SUCCEEDED (FAILED, CANCELLED, never run), or no SUCCEEDED receipt of it reads back. */
  | "CAPTURE_RECEIPT_MISSING"
  /** The commit its receipt names cannot be read in the run's checkout of the receipt's repository. */
  | "OBJECT_UNREADABLE"
  /** Its receipt's CommitLore evidence does not account for that commit: `unaccounted`'s answer, a receipt's refusals only. */
  | ForeignCommitRefusal;

export interface TaskCaptureGap {
  taskId: string;
  state: string;
  refusal: TaskCaptureRefusal;
  /** The commit the task's receipt names, which is the commit the freeze integrates for it. */
  commit?: string;
  repositoryIdentity?: string;
}

/**
 * GAP 1 — the CommitLore evidence of exactly the receipt `succeededTaskCommits` read a task's commit from: the
 * SUCCEEDED row of that execution and result digest, latest first, as it reads it. Undefined when it carries none.
 */
const receiptCommitLore = (db: Db, receipt: SucceededTaskCommit): unknown => {
  const row = db.get<{ evidence: string }>(
    `SELECT evidence_json AS evidence FROM audit_events
      WHERE kind = ? AND json_extract(evidence_json, '$.executionId') = ? AND json_extract(evidence_json, '$.resultDigest') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [WorkerTurnEvent.SUCCEEDED, receipt.executionId, receipt.resultDigest],
  );
  return row === undefined ? undefined : (JSON.parse(row.evidence) as { commitlore?: unknown }).commitlore;
};

/**
 * GAP 1 — every task of the run whose registered spec requires a CommitLore capture (`taskCaptureRequired`) and that
 * a registered correction does not supersede (`Supersession.superseded`, #1372) that is not accounted for, by task id:
 *
 * - a task that is not SUCCEEDED or has no SUCCEEDED receipt that reads back (`receipts`, `succeededTaskCommits`):
 *   a FAILED task, a CANCELLED one and one never run are no exemption (CAPTURE_RECEIPT_MISSING);
 * - one whose receipt's CommitLore evidence, outcome and record ids, is not exactly the `Record-Id` trailers re-read
 *   from the commit that receipt names (`unaccounted`, the check a governed run's range gets), which is the commit
 *   the freeze integrates for it: no evidence, an unknown outcome, malformed ids, or another commit's records.
 *
 * Whatever the run's own CommitLore mode, which keeps its own range check. Read-only, over `checkouts` (repository
 * identity to the run's checkout); a commit that cannot be read there is not accounted for.
 */
export const unaccountedTaskCaptures = async (input: {
  db: Db;
  tasks: readonly TaskRecord[];
  receipts: readonly SucceededTaskCommit[];
  superseded: ReadonlySet<string>;
  checkouts: ReadonlyMap<string, string>;
}): Promise<Decision<TaskCaptureGap[]>> => {
  const gaps: TaskCaptureGap[] = [];
  const byRepository = new Map<string, Array<{ task: TaskRecord; receipt: SucceededTaskCommit }>>();
  for (const task of input.tasks) {
    if (!taskCaptureRequired(task.spec) || input.superseded.has(task.taskId)) continue;
    const receipt = input.receipts.find((candidate) => candidate.taskId === task.taskId);
    if (task.state !== TaskState.SUCCEEDED || receipt === undefined) {
      gaps.push({ taskId: task.taskId, state: task.state, refusal: "CAPTURE_RECEIPT_MISSING" });
      continue;
    }
    byRepository.set(receipt.repositoryIdentity, [...(byRepository.get(receipt.repositoryIdentity) ?? []), { task, receipt }]);
  }
  for (const [repositoryIdentity, owed] of byRepository) {
    const gapOf = (task: TaskRecord, receipt: SucceededTaskCommit, refusal: TaskCaptureRefusal): TaskCaptureGap =>
      ({ taskId: task.taskId, state: task.state, refusal, commit: receipt.commit, repositoryIdentity });
    const checkoutPath = input.checkouts.get(repositoryIdentity);
    if (checkoutPath === undefined) {
      gaps.push(...owed.map(({ task, receipt }) => gapOf(task, receipt, "OBJECT_UNREADABLE")));
      continue;
    }
    const read = await withPinned<TaskCaptureGap[]>(checkoutPath, "acp-candidate-task-capture-", async (repo) => {
      const found: TaskCaptureGap[] = [];
      for (const { task, receipt } of owed) {
        const shown = OBJECT_ID.test(receipt.commit) ? await runPinnedGit(repo, ["cat-file", "commit", receipt.commit]) : null;
        if (shown === null || shown.exitCode !== 0) {
          found.push(gapOf(task, receipt, "OBJECT_UNREADABLE"));
          continue;
        }
        const split = shown.stdout.indexOf("\n\n");
        const refusal = unaccounted(receiptCommitLore(input.db, receipt), split === -1 ? "" : shown.stdout.slice(split + 2));
        if (refusal !== null) found.push(gapOf(task, receipt, refusal));
      }
      return allow(ReasonCode.OK, found);
    });
    if (!read.allowed) return read;
    gaps.push(...read.value);
  }
  return allow(ReasonCode.OK, gaps.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)));
};

/**
 * #1268 — for a run whose contract requires CommitLore: the first commit, oldest first, between the base a
 * repository was frozen at and the exact head frozen for it that the run's CommitLore path does not account for,
 * or null when every one is accounted for. A commit is accounted for when it is either
 *
 * - a worker commit: named by SUCCEEDED receipts of this run in this repository (`workerReceiptsByCommit`), each
 *   with CommitLore evidence of a known outcome whose record ids are exactly the `Record-Id` trailers re-read from
 *   the commit itself, none for `empty`; or
 * - an integration merge in `mergeChecks` (the merges this freeze's check passed, and those recorded for this
 *   run's predecessor bases, `recordedPredecessorMergeChecks`) whose binding is this commit's own parents in
 *   order, tree and message, re-read from the commit.
 *
 * A base that is not an ancestor of the head, or an object that cannot be read, is refused
 * (CANDIDATE_RANGE_UNVERIFIABLE). Read-only, over the registered checkout. `accounted` carries what one freeze has
 * already found accounted for, per repository (an object id names its bytes, but a receipt is a repository's), which
 * is not read again, and gains every commit this call accounts for here.
 */
export const foreignCandidateCommit = async (input: {
  db: Db;
  runId: string;
  repositoryIdentity: string;
  checkoutPath: string;
  baseHead: string;
  candidateHead: string;
  mergeChecks: readonly MergeCheckBinding[];
  accounted?: Set<string>;
}): Promise<Decision<ForeignCommit | null>> => {
  const { runId, repositoryIdentity, baseHead, candidateHead } = input;
  const unverifiable = (refusal: "BASE_NOT_ANCESTOR" | "OBJECT_UNREADABLE", commit: string | null = null): Decision<never> =>
    deny(ReasonCode.CANDIDATE_RANGE_UNVERIFIABLE, "the candidate's commits since its frozen base could not be established, so the freeze is refused", {
      runId,
      repositoryIdentity,
      baseHead,
      candidateHead,
      refusal,
      ...(commit === null ? {} : { commit }),
    });
  if (!OBJECT_ID.test(baseHead) || !OBJECT_ID.test(candidateHead)) return unverifiable("OBJECT_UNREADABLE");
  return withPinned<ForeignCommit | null>(input.checkoutPath, "acp-candidate-commitlore-", async (repo) => {
    const descends = await isAncestor(repo, baseHead, candidateHead);
    if (descends !== true) return unverifiable(descends === false ? "BASE_NOT_ANCESTOR" : "OBJECT_UNREADABLE");
    const listed = await runPinnedGit(repo, ["rev-list", "--reverse", "--topo-order", `${baseHead}..${candidateHead}`]);
    if (listed.exitCode !== 0) return unverifiable("OBJECT_UNREADABLE");
    const receipts = workerReceiptsByCommit(input.db, runId, repositoryIdentity);
    const key = (commit: string): string => `${repositoryIdentity}\u0000${commit}`;
    for (const commit of listed.stdout.split("\n").filter((line) => line.length > 0)) {
      if (input.accounted?.has(key(commit))) continue;
      const read = await runPinnedGit(repo, ["cat-file", "commit", commit]);
      if (read.exitCode !== 0) return unverifiable("OBJECT_UNREADABLE", commit);
      const split = read.stdout.indexOf("\n\n");
      const header = split === -1 ? read.stdout : read.stdout.slice(0, split);
      const message = split === -1 ? "" : read.stdout.slice(split + 2);
      const named = receipts.get(commit);
      if (named !== undefined) {
        const refusal = named.map((commitlore) => unaccounted(commitlore, message)).find((answer) => answer !== null) ?? null;
        if (refusal !== null) return allow(ReasonCode.OK, { commit, refusal });
        input.accounted?.add(key(commit));
        continue;
      }
      const parents = [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map((match) => match[1]!);
      const bound = input.mergeChecks.find((check) => check.commit === commit);
      if (bound === undefined) return allow(ReasonCode.OK, { commit, refusal: parents.length >= 2 ? "MERGE_NOT_CHECKED" : "NOT_A_RUN_WORKER_COMMIT" });
      const tree = /^tree ([0-9a-f]+)$/m.exec(header)?.[1] ?? null;
      const exact = parents.length === 2 && parents[0] === bound.parents[0] && parents[1] === bound.parents[1] &&
        tree === bound.tree && sha256(message.trimEnd()) === bound.messageDigest;
      if (!exact) return allow(ReasonCode.OK, { commit, refusal: "MERGE_NOT_BOUND" });
      input.accounted?.add(key(commit));
    }
    return allow(ReasonCode.OK, null);
  });
};

/**
 * #1268 — a checkout's HEAD commit, read with nothing awaited: the pinned git (`pinRepository`, `GIT_HARDENING`,
 * `pinnedGitEnvironment`, as `runPinnedGit` runs it) started synchronously, for a decision taken inside one
 * database transaction. Null when git does not answer it.
 */
export const checkoutHeadNow = (checkoutPath: string): string | null => {
  const scratch = acpScratchDir("acp-candidate-head-now-");
  try {
    const pinned = pinRepository(checkoutPath, scratch);
    if (!pinned.allowed) return null;
    try {
      const home = join(scratch, "home");
      const head = execFileSync("git", [...GIT_HARDENING, "rev-parse", "--verify", "-q", "HEAD^{commit}"], {
        cwd: pinned.value.workTree,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, ...pinnedGitEnvironment({ gitDir: pinned.value.gitDir, workTree: pinned.value.workTree }) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }).trim();
      return head.length > 0 ? head : null;
    } catch {
      return null;
    } finally {
      pinned.value.children.retire();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** S6 review (P2) — where an integrated candidate is kept reachable: never a branch, never HEAD. */
export const CANDIDATE_REF_NAMESPACE = "refs/acp/candidates";

/** The private ref that keeps a run's integrated candidate for one snapshot digest from git gc. */
export const candidateRefFor = (runId: string, snapshotDigest: string): string =>
  `${CANDIDATE_REF_NAMESPACE}/${runId}/${snapshotDigest.replace(/^[^:]*:/, "").slice(0, 16)}`;

/** #1242 — where the base a dependent task starts from is kept reachable: never a branch, never HEAD. */
export const BASE_REF_NAMESPACE = "refs/acp/bases";

/** The private ref that keeps the base a task of a run starts from from git gc. */
export const baseRefFor = (runId: string, taskId: string): string => `${BASE_REF_NAMESPACE}/${runId}/${taskId}`;

/**
 * The refs a run holds under `CANDIDATE_REF_NAMESPACE` (or `namespace`) in a checkout, and the
 * `update-ref --stdin` lines that would make them exactly `keep` (create it if missing; delete every
 * other one, each only at the value read here). Empty lines: nothing to write.
 */
export const candidateRefPlan = async (
  checkoutPath: string,
  runId: string,
  keep: { ref: string; commit: string } | null,
  /** #1242 — a dependent task's base ref is planned over that ref alone (`baseRefFor`). */
  namespace = `${CANDIDATE_REF_NAMESPACE}/${runId}/`,
): Promise<Decision<string[]>> =>
  withPinned<string[]>(checkoutPath, "acp-candidate-ref-read-", async (repo) => {
    const listed = await gitOrThrow(repo, ["for-each-ref", "--format=%(refname) %(objectname)", namespace]);
    const held = listed.split("\n").filter((line) => line.length > 0).map((line) => line.split(" ") as [string, string]);
    const lines: string[] = [];
    if (keep && !held.some(([ref, commit]) => ref === keep.ref && commit === keep.commit)) {
      const stale = held.find(([ref]) => ref === keep.ref);
      lines.push(stale ? `update ${keep.ref} ${keep.commit} ${stale[1]}` : `create ${keep.ref} ${keep.commit}`);
    }
    for (const [ref, commit] of held) {
      if (ref !== keep?.ref) lines.push(`delete ${ref} ${commit}`);
    }
    return allow(ReasonCode.OK, lines);
  });

/**
 * #1268 — the `update-ref --stdin` lines that undo `candidateRefPlan` lines once applied, last first, each only at
 * the value the line set: a created ref is deleted, an updated one is put back, a deleted one is created again.
 */
export const undoCandidateRefLines = (lines: readonly string[]): string[] =>
  [...lines].reverse().map((line) => {
    const [verb, ref, value, previous] = line.split(" ");
    if (verb === "create") return `delete ${ref} ${value}`;
    if (verb === "delete") return `create ${ref} ${value}`;
    return `update ${ref} ${previous} ${value}`;
  });

/** Applies `candidateRefPlan` lines as one atomic ref transaction, pinned and hook-free. */
export const applyCandidateRefPlan = async (checkoutPath: string, lines: readonly string[]): Promise<Decision<void>> =>
  withPinned<void>(checkoutPath, "acp-candidate-ref-write-", async (repo) => {
    await gitOrThrow(repo, ["update-ref", "--stdin"], { input: `${lines.join("\n")}\n` });
    return allow(ReasonCode.OK, undefined);
  });
