import { rmSync } from "node:fs";
import { join } from "node:path";

import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import type { Db } from "../db/database.ts";
import type { SnapshotIntegration } from "../snapshot/candidate-snapshot.ts";
import type { TaskRecord } from "./task-graph.ts";
import { recordedWriteTarget } from "./task-write-target.ts";
import { type PinnedRepository, committedChanges, objectFormatOf, pinRepository, runPinnedGit } from "./worker-git.ts";
import { WorkerTurnEvent } from "./worker-turn.ts";

/**
 * S6-C — the candidate of a STANDARD_WORK run whose tasks each worked on their own branch.
 *
 * Every task branch starts at the run's pinned base (S-TB), so the checkout's HEAD holds one task's
 * work only. At freeze, when some SUCCEEDED task's recorded commit is not in that HEAD, the candidate
 * is instead every SUCCEEDED task's result in the repository, integrated onto the pinned base:
 *
 * - The order is the task graph's: a task after every task it depends on, through the whole run's
 *   graph, ties broken by task id. The first task's commit is taken as it is; each later one is joined
 *   by a merge commit whose parents are the integration so far and the task's own commit, so every
 *   task commit is an ancestor of the candidate, and no task branch, ref or commit is moved (S-TB-02).
 * - A task's change is what its commit changes against the pinned base, path by path. Two tasks that
 *   change the same path, or a path and one beneath it, are a conflict: the freeze is refused naming
 *   both tasks and the paths, before anything is written. Nothing merges file contents, so no merge
 *   driver runs and no task's bytes are overwritten or dropped.
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
}

export interface IntegratedCandidate {
  head: string;
  integration: SnapshotIntegration;
  declaredParent: string;
  baseSha: string;
}

/** A disposable worktree of the run's repository at `head`, made and torn down through the guard. */
export type RunWorktree = <T>(
  input: { purpose: string; inputDigest: string; repositoryIdentity: string; head: string },
  use: (worktreePath: string) => Promise<Decision<T>>,
) => Promise<Decision<T>>;

/** The `verification_worktrees.command_id` and worktree-id prefix of an integration's worktree. */
export const INTEGRATION_WORKTREE_PURPOSE = "candidate-integration";

/** One SUCCEEDED task's own commit, in the repository its execution ran in. */
export interface SucceededTaskCommit {
  taskId: string;
  commit: string;
  repositoryIdentity: string;
}

/**
 * The one source of a run's SUCCEEDED task commits, for the integration and for the freeze's
 * missing-commit guard alike (S6-B, S6-C), so the two can never be asked about different commits.
 * Each task's latest SUCCEEDED attempt only, and only when its own SUCCEEDED evidence still reads
 * back by both its execution id and its stored result digest, the two values ACP-WORKER-02 bound
 * together when the receipt was written. A receipt that cannot be read back that way names nothing.
 */
export const succeededTaskCommits = (db: Db, runId: string): SucceededTaskCommit[] => {
  const rows = db.all<{ taskId: string; commitHead: unknown; repositoryIdentity: string | null }>(
    `SELECT te.task_id AS taskId,
            json_extract(a.evidence_json, '$.commitHead') AS commitHead,
            r.identity AS repositoryIdentity
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
    commits.set(row.taskId, { taskId: row.taskId, commit: row.commitHead, repositoryIdentity: row.repositoryIdentity });
  }
  return [...commits.values()];
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

/**
 * The run's integrated candidate in one repository, or null when the checkout's HEAD already holds
 * every SUCCEEDED task's commit (a single-task run, as before), or there is no result at all.
 */
export const integrateTaskResults = async (input: {
  db: Db;
  runId: string;
  tasks: readonly TaskRecord[];
  /** `succeededTaskCommits` of the run, read once by the freeze for the integration and its guard. */
  commits: readonly SucceededTaskCommit[];
  repositoryIdentity: string;
  checkoutPath: string;
  worktree: RunWorktree;
}): Promise<Decision<IntegratedCandidate | null>> => {
  const results = succeededTaskResults(input.db, input.runId, input.tasks, input.commits, input.repositoryIdentity);
  if (results.length === 0) return allow(ReasonCode.OK, null);

  // Read-only, over the registered checkout: everything is decided, and every conflict refused,
  // before anything is written.
  type Plan = { checkoutHead: string; baseSha: string; planned: Planned[]; format: "sha1" | "sha256" } | null;
  const plan = await withPinned<Plan>(input.checkoutPath, "acp-integration-read-", async (repo) => {
    const headRead = await runPinnedGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    const checkoutHead = headRead.exitCode === 0 ? headRead.stdout.trim() : null;
    if (checkoutHead === null) return allow(ReasonCode.OK, null);
    const contained = await Promise.all(results.map((result) => isAncestor(repo, result.commit, checkoutHead)));
    if (contained.every((answer) => answer === true)) return allow(ReasonCode.OK, null);

    const origins = new Set(results.map((result) => `${result.declaredParent}\u0000${result.baseSha}`));
    if (origins.size !== 1) {
      return deny(ReasonCode.CONFLICT, "the run's task results in this repository were made from different origins; they are not integrated", {
        repositoryIdentity: input.repositoryIdentity,
        origins: results.map((result) => ({ taskId: result.taskId, declaredParent: result.declaredParent, baseSha: result.baseSha })),
      });
    }
    const ordered = integrationOrder(input.tasks, results);
    if (!ordered) {
      return deny(ReasonCode.TASK_DEPENDENCY_CYCLE, "the run's task graph has a cycle, so no integration order exists", { runId: input.runId });
    }
    const baseSha = ordered[0]!.baseSha;
    const planned: Planned[] = [];
    for (const result of ordered) {
      const descends = await isAncestor(repo, baseSha, result.commit);
      if (descends !== true) {
        return deny(ReasonCode.CONFLICT, "a task's recorded commit does not descend from the run's pinned base; it is not integrated", {
          repositoryIdentity: input.repositoryIdentity,
          taskId: result.taskId,
          commit: result.commit,
          baseSha,
          readFailed: descends === null,
        });
      }
      planned.push({ result, changes: await committedChanges(repo, baseSha, result.commit) });
    }
    const conflicts = pathConflicts(planned.map((step) => ({ taskId: step.result.taskId, paths: step.changes.map((change) => change.path) })));
    if (conflicts.length > 0) {
      const named = conflicts.map((conflict) => `${conflict.tasks.join(" and ")} both change ${conflict.paths.join(", ")}`).join("; ");
      return deny(
        ReasonCode.CONFLICT,
        `the run's task results cannot be integrated: ${named}. The candidate is not frozen; the control plane does not choose between them`,
        { repositoryIdentity: input.repositoryIdentity, baseSha, conflicts: conflicts.slice(0, 20) },
      );
    }
    return allow(ReasonCode.OK, { checkoutHead, baseSha, planned, format: await objectFormatOf(repo) });
  });
  if (!plan.allowed || plan.value === null) return plan as Decision<null>;
  const { checkoutHead, baseSha, planned, format } = plan.value;
  const integration: SnapshotIntegration = {
    checkoutHead,
    tasks: planned.map((step) => ({ taskId: step.result.taskId, commit: step.result.commit })),
  };
  const inputDigest = digestOf({ schema: "agent-control-plane.candidate-integration.v1", runId: input.runId, repositoryIdentity: input.repositoryIdentity, baseSha, tasks: integration.tasks });

  const built = await input.worktree<string>(
    { purpose: INTEGRATION_WORKTREE_PURPOSE, inputDigest, repositoryIdentity: input.repositoryIdentity, head: baseSha },
    (worktreePath) => withPinned<string>(worktreePath, "acp-integration-write-", async (repo, scratch) => {
      const zero = "0".repeat(format === "sha256" ? 64 : 40);
      const index = join(scratch, "integration.index");
      let head = planned[0]!.result.commit;
      for (const step of planned.slice(1)) {
        await gitOrThrow(repo, ["read-tree", head], { index });
        const entries = step.changes
          .map((change) => (change.mode === null ? `0 ${zero}\t${change.path}\0` : `${change.mode} ${change.blob}\t${change.path}\0`))
          .join("");
        await gitOrThrow(repo, ["update-index", "-z", "--index-info"], { index, input: entries });
        const tree = (await gitOrThrow(repo, ["write-tree"], { index })).trim();
        const date = `${Math.max(await committerEpoch(repo, head), await committerEpoch(repo, step.result.commit))} +0000`;
        head = (await gitOrThrow(repo, ["commit-tree", tree, "-p", head, "-p", step.result.commit, "--no-gpg-sign", "-m", subjectOf(step.result.title)], {
          extraEnv: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        })).trim();
      }
      // The integrated commit changes exactly what the tasks changed, each path as its task left it.
      const expected = new Map(planned.flatMap((step) => step.changes.map((change) => [change.path, `${change.mode}:${change.blob}`] as const)));
      const observed = await committedChanges(repo, baseSha, head);
      const exact = observed.length === expected.size && observed.every((change) => expected.get(change.path) === `${change.mode}:${change.blob}`);
      if (!exact) {
        return deny(ReasonCode.INTERNAL_ERROR, "the integrated commit does not change exactly what the tasks changed; nothing was frozen", {
          repositoryIdentity: input.repositoryIdentity,
          head,
          expected: expected.size,
          observed: observed.length,
        });
      }
      return allow(ReasonCode.OK, head);
    }),
  );
  if (!built.allowed) return built as Decision<null>;
  return allow(ReasonCode.OK, { head: built.value, integration, declaredParent: planned[0]!.result.declaredParent, baseSha });
};

/**
 * S6 review (P1) — ancestry alone can hide a task's lost bytes: a merge that keeps one side
 * (`git merge -s ours`) makes a task's commit an ancestor of a candidate that holds none of its
 * change. So when a repository has two or more task commits, every path a task's commit changes
 * against its pinned base must stand in the candidate tree exactly as that task left it: the same
 * mode and blob, or absent for a deletion. The one exception is a path that a later recorded task
 * commit descending from it changed too (that task was built on top of it); the later version is
 * then the one asked for. Under S-TB no task commit descends from another, so every task's every
 * path is asked. Read-only, over the registered checkout. Lists each task with the paths it lost.
 */
export const lostTaskChanges = async (input: {
  db: Db;
  runId: string;
  commits: readonly SucceededTaskCommit[];
  repositoryIdentity: string;
  checkoutPath: string;
  candidateHead: string;
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
      const base = target?.repositoryIdentity === input.repositoryIdentity ? target.baseSha : shared;
      changes.set(commit.taskId, new Map((await committedChanges(repo, base, commit.commit)).map((change) => [change.path, `${change.mode ?? "-"} ${change.blob ?? "-"}`])));
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
    const inCandidate = new Map<string, string>();
    for (let start = 0; start < paths.length; start += 500) {
      const listed = await gitOrThrow(repo, ["ls-tree", "-z", "--full-tree", input.candidateHead, "--", ...paths.slice(start, start + 500)]);
      for (const entry of listed.split("\0").filter((line) => line.length > 0)) {
        const parsed = /^(\d{6}) \w+ ([0-9a-f]+)\t(.*)$/s.exec(entry);
        if (parsed) inCandidate.set(parsed[3]!, `${parsed[1]} ${parsed[2]}`);
      }
    }
    const lost: Lost = [];
    for (const commit of here) {
      const missing = (asked.get(commit.taskId) ?? [])
        .filter(({ path, expected }) => (inCandidate.get(path) ?? "- -") !== expected)
        .map(({ path }) => path);
      if (missing.length > 0) lost.push({ taskId: commit.taskId, commitHead: commit.commit, paths: missing.slice(0, 50) });
    }
    return allow(ReasonCode.OK, lost);
  });
};

/** S6 review (P2) — where an integrated candidate is kept reachable: never a branch, never HEAD. */
export const CANDIDATE_REF_NAMESPACE = "refs/acp/candidates";

/** The private ref that keeps a run's integrated candidate for one snapshot digest from git gc. */
export const candidateRefFor = (runId: string, snapshotDigest: string): string =>
  `${CANDIDATE_REF_NAMESPACE}/${runId}/${snapshotDigest.replace(/^[^:]*:/, "").slice(0, 16)}`;

/**
 * The refs a run holds under `CANDIDATE_REF_NAMESPACE` in a checkout, and the `update-ref --stdin`
 * lines that would make them exactly `keep` (create it if missing; delete every other one, each
 * only at the value read here). Empty lines: nothing to write.
 */
export const candidateRefPlan = async (
  checkoutPath: string,
  runId: string,
  keep: { ref: string; commit: string } | null,
): Promise<Decision<string[]>> =>
  withPinned<string[]>(checkoutPath, "acp-candidate-ref-read-", async (repo) => {
    const listed = await gitOrThrow(repo, ["for-each-ref", "--format=%(refname) %(objectname)", `${CANDIDATE_REF_NAMESPACE}/${runId}/`]);
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

/** Applies `candidateRefPlan` lines as one atomic ref transaction, pinned and hook-free. */
export const applyCandidateRefPlan = async (checkoutPath: string, lines: readonly string[]): Promise<Decision<void>> =>
  withPinned<void>(checkoutPath, "acp-candidate-ref-write-", async (repo) => {
    await gitOrThrow(repo, ["update-ref", "--stdin"], { input: `${lines.join("\n")}\n` });
    return allow(ReasonCode.OK, undefined);
  });
