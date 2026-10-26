import { acpError, allow, deny, type Decision, type Evidence } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type BootstrapWriteGuard, runUnderWriteGuard } from "../bootstrap/bootstrap-write-guard.ts";
import {
  type GitHubRepositoryTarget,
  type GitHubWritePort,
  type ObservedWorkIssues,
  type WorkIssuesPlan,
  isGitHubNodeId,
  parseGitHubIdentity,
} from "../bootstrap/github-write-port.ts";
import type { WorkUnitMarker } from "../bootstrap/work-unit-marker.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { RunKind, RunState, TaskState } from "../domain/types.ts";
import type { RunEngine } from "./run-engine.ts";
import type { TaskGraph, TaskRecord } from "./task-graph.ts";

/**
 * #1240 (ACP part) — a Repo Factory project's approved work units are linked on GitHub before any of
 * them is first admitted to execution.
 *
 * The unit is the task: the PLAN approves tasks, and each is staffed, given its own write target and
 * branch, and executed on its own (#512 S-TB), so each gets its own issue; one run-wide issue would be
 * the catch-all that stands for independent work. A single-task run therefore gets one issue. The
 * run is the owner goal its CEO dispatched, so its goal is the milestone those issues link to.
 *
 * ACP creates what is missing rather than asking the PLAN to name issue numbers: the CTO has no
 * GitHub credential to make them with, and an approved scope that already exists (the live
 * myeotnyeon runs) is synchronized by its next admission with no re-plan. The writes go through
 * the Repo Factory GitHub port the genesis issues went through, under a write guard that admits only
 * this run's milestone and issue POSTs, and every unit is found by its work-unit marker (the one
 * Repo Factory's genesis issues carry, `work-unit-marker.ts`) on every page first, so a retry after
 * any partial failure reuses what GitHub holds and creates only the rest.
 *
 * What is verified is structure and linkage, never content: a readback (never a write's answer) of
 * the repository at the node id the genesis receipted, in which the unit's marker is on exactly one
 * issue, that issue carries no other unit, and it links by node id to the run's one goal milestone.
 * Each unit so verified is recorded once (`WORK_SCOPE_GITHUB_TRACKED`) and reused: a unit is admitted
 * by its own record, so a task added later, or a GitHub outage, never holds back a unit already linked,
 * and an admitted unit's later turns ask GitHub nothing. Only units not yet recorded are synchronized,
 * at plan acceptance and at their first admission.
 *
 * Only a Repo Factory project is governed: one whose resident provisioning row names the
 * repository and its node id. Every other project's runs are admitted exactly as before.
 */
export const WORK_SCOPE_GITHUB_TRACKED = "WORK_SCOPE_GITHUB_TRACKED";

export interface TrackedUnit {
  taskId: string;
  issueNumber: number;
  issueNodeId: string;
}

export interface TrackedWorkScope {
  repositoryIdentity: string;
  repositoryNodeId: string;
  milestone: { number: number; nodeId: string } | null;
  units: TrackedUnit[];
}

export type UnmetKind =
  | "MILESTONE_MISSING"
  | "MILESTONE_DUPLICATED"
  | "ISSUE_MISSING"
  | "ISSUE_DUPLICATED"
  | "CATCH_ALL_ISSUE"
  | "MILESTONE_LINK_MISSING"
  | "MILESTONE_LINK_WRONG";

/** A unit, or the goal milestone, that GitHub's readback does not hold, and what corrects it. */
export interface UnmetWork {
  taskId?: string;
  unmet: UnmetKind;
  issues?: number[];
  milestones?: number[];
  covers?: string[];
  correction: string;
}

interface Governed {
  target: GitHubRepositoryTarget;
  repositoryIdentity: string;
  repositoryNodeId: string;
}

/** The run states that admit no more work, so no issue is written for one. */
const ENDED: ReadonlySet<string> = new Set([RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED]);

const milestoneKeyOf = (runId: string): string => `goal:${runId}`;
const TITLE_LIMIT = 120;
const titleOf = (text: string): string => {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
};

/** What a task's issue says: its goal and acceptance when its spec states them, else its title. */
const issueBody = (task: TaskRecord): string => {
  const goal = task.spec["goal"] ?? task.spec["description"];
  const acceptance = Array.isArray(task.spec["acceptance"]) ? task.spec["acceptance"].filter((a): a is string => typeof a === "string") : [];
  return [
    typeof goal === "string" && goal.trim() ? goal.trim() : task.title,
    ...(acceptance.length > 0 ? ["", "Acceptance:", ...acceptance.map((a) => `- ${a}`)] : []),
  ].join("\n");
};

const list = (numbers: readonly number[]): string => numbers.map((n) => `#${n}`).join(", ");

/**
 * The readback judged for the units being verified: each one's marker on one issue, that issue standing
 * for no other unit (in this readback or in an earlier record), linked to the run's one goal milestone.
 */
export const judgeWorkIssues = (
  units: readonly TaskRecord[],
  observed: ObservedWorkIssues,
  recorded: ReadonlyMap<number, string> = new Map(),
): { unmet: UnmetWork[]; milestone: { number: number; nodeId: string } | null; units: TrackedUnit[] } => {
  const unmet: UnmetWork[] = [];
  const goal = observed.milestones.length === 1 ? observed.milestones[0]! : null;
  if (observed.milestones.length === 0) {
    unmet.push({ unmet: "MILESTONE_MISSING", correction: "the run's goal milestone was not created; admit the work again and ACP creates it" });
  }
  if (observed.milestones.length > 1) {
    const numbers = observed.milestones.map((m) => m.number);
    unmet.push({ unmet: "MILESTONE_DUPLICATED", milestones: numbers, correction: `milestones ${list(numbers)} all carry the run's goal marker; remove it from all but one` });
  }
  const tracked: TrackedUnit[] = [];
  for (const task of units) {
    const carrying = observed.issues.filter((issue) => issue.keys.includes(task.taskId));
    const issue = carrying[0];
    const earlier = issue === undefined ? undefined : recorded.get(issue.number);
    if (issue === undefined) {
      unmet.push({ taskId: task.taskId, unmet: "ISSUE_MISSING", correction: "no issue carries this unit's marker; admit it again and ACP creates its issue" });
    } else if (carrying.length > 1) {
      const numbers = carrying.map((i) => i.number);
      unmet.push({ taskId: task.taskId, unmet: "ISSUE_DUPLICATED", issues: numbers, correction: `issues ${list(numbers)} all carry this unit's work-unit marker; remove it from all but one` });
    } else if (issue.keys.length > 1 || (earlier !== undefined && earlier !== task.taskId)) {
      const covers = [...new Set([...issue.keys, ...(earlier === undefined ? [] : [earlier])])];
      unmet.push({ taskId: task.taskId, unmet: "CATCH_ALL_ISSUE", issues: [issue.number], covers, correction: `issue #${issue.number} stands for more than one unit; leave one unit's marker on it, and ACP creates an issue for each other unit` });
    } else if (issue.milestoneNodeId === null) {
      unmet.push({ taskId: task.taskId, unmet: "MILESTONE_LINK_MISSING", issues: [issue.number], correction: `link issue #${issue.number} to the run's goal milestone${goal ? ` #${goal.number}` : ""}` });
    } else if (goal === null || issue.milestoneNodeId !== goal.nodeId) {
      unmet.push({ taskId: task.taskId, unmet: "MILESTONE_LINK_WRONG", issues: [issue.number], correction: `issue #${issue.number} links another milestone; link it to the run's goal milestone${goal ? ` #${goal.number}` : ""}` });
    } else {
      tracked.push({ taskId: task.taskId, issueNumber: issue.number, issueNodeId: issue.nodeId });
    }
  }
  return { unmet, milestone: goal === null ? null : { number: goal.number, nodeId: goal.nodeId }, units: tracked };
};

export interface WorkScopeTrackingPorts {
  db: Db;
  audit: AuditLog;
  runs: Pick<RunEngine, "get" | "repositoriesOf">;
  tasks: Pick<TaskGraph, "list">;
  github: GitHubWritePort;
}

export class WorkScopeTracking {
  /** One synchronization per run at a time, so two admissions never both create a missing issue. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: WorkScopeTrackingPorts) {}

  /**
   * Synchronous, and asked inside every execution's transaction: this task's link is recorded. `null`
   * when the run is not a Repo Factory project's STANDARD_WORK run, so nothing is required of it.
   */
  assertTracked(runId: string, taskId: string): Decision<TrackedUnit | null> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<null>;
    const recorded = this.#recorded(runId, governed.value);
    const unit = recorded.get(taskId);
    if (unit !== undefined) return allow(ReasonCode.OK, unit);
    return this.#refusedFor(runId, governed.value, this.#approved(runId).filter((task) => !recorded.has(task.taskId)), taskId, {
      correction: "admit the unit through task_worker_provision or task_worker_run: ACP creates or reuses its issue and the run's goal milestone, and reads them back",
    });
  }

  /**
   * Plan acceptance's and admission's entry. With a task: asks GitHub nothing when that task's link is
   * already recorded; otherwise every unit of the run not yet recorded is synchronized, read back, and
   * each one verified is recorded, and the task is admitted only if it is among them. Without a task
   * (plan acceptance): the same synchronization, answered for the whole approved scope.
   */
  ensure(runId: string, taskId?: string): Promise<Decision<TrackedWorkScope | TrackedUnit | null>> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.#ensureNow(runId, taskId), () => this.#ensureNow(runId, taskId));
    const settled = next.then(() => undefined, () => undefined);
    this.#queues.set(runId, settled);
    void settled.then(() => {
      if (this.#queues.get(runId) === settled) this.#queues.delete(runId);
    });
    return next;
  }

  async #ensureNow(runId: string, taskId: string | undefined): Promise<Decision<TrackedWorkScope | TrackedUnit | null>> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<null>;
    const recordedBefore = this.#recorded(runId, governed.value);
    if (taskId !== undefined && recordedBefore.has(taskId)) return allow(ReasonCode.OK, recordedBefore.get(taskId)!);
    const pending = this.#approved(runId).filter((task) => !recordedBefore.has(task.taskId));
    if (pending.length > 0) {
      const synced = await this.#synchronize(runId, governed.value, pending, recordedBefore);
      if (!synced.allowed) return synced;
    }
    const recorded = this.#recorded(runId, governed.value);
    const untracked = this.#approved(runId).filter((task) => !recorded.has(task.taskId));
    if (taskId !== undefined) return recorded.has(taskId) ? allow(ReasonCode.OK, recorded.get(taskId)!) : this.#refusedFor(runId, governed.value, untracked, taskId);
    if (untracked.length > 0) return this.#refusedFor(runId, governed.value, untracked, undefined);
    return allow(ReasonCode.OK, { repositoryIdentity: governed.value.repositoryIdentity, repositoryNodeId: governed.value.repositoryNodeId, milestone: this.#milestone(runId), units: [...recorded.values()] });
  }

  /**
   * Writes and reads back the pending units; records the ones the readback verifies, whatever happens
   * to the rest. A refusal here names every pending unit, the cause, and what corrects it.
   */
  async #synchronize(runId: string, governed: Governed, pending: readonly TaskRecord[], recorded: ReadonlyMap<string, TrackedUnit>): Promise<Decision<void>> {
    const { target, repositoryNodeId } = governed;
    const { github } = this.ports;
    if (!github.ensureWorkIssues || !github.observeWorkIssues) {
      return this.#refusedFor(runId, governed, pending, undefined, { cause: "the GitHub port cannot write or read work issues", correction: "compose the daemon with the Repo Factory GitHub port" });
    }
    const run = this.ports.runs.get(runId)!;
    const goal = titleOf(run.goal) || runId;
    // The same marker Repo Factory's genesis issues carry, keyed by the task. A run's scope grows by
    // addition and an issue is never rewritten, so k of n is the unit's place among the approved units
    // when its issue is written; the key alone is what links and what is judged.
    const approved = this.#approved(runId);
    const unitOf = (task: TaskRecord): WorkUnitMarker => ({ k: approved.findIndex((t) => t.taskId === task.taskId) + 1, n: approved.length, key: task.taskId });
    const plan: WorkIssuesPlan = {
      milestone: { key: milestoneKeyOf(runId), title: goal, description: run.goal.trim() || goal },
      issues: pending.map((task) => ({ unit: unitOf(task), title: titleOf(task.title) || task.taskId, body: issueBody(task) })),
    };
    let observed: ObservedWorkIssues;
    try {
      observed = await runUnderWriteGuard(this.#guard(runId, target), async () => {
        await github.ensureWorkIssues!(target, repositoryNodeId, plan);
        return github.observeWorkIssues!(target, repositoryNodeId, plan);
      });
    } catch (error) {
      const evidence = isRecord(error) && isRecord(error["evidence"]) ? (error["evidence"] as Evidence) : {};
      const refusal = typeof evidence["refusal"] === "string" ? evidence["refusal"] : null;
      return this.#refusedFor(runId, governed, pending, undefined, {
        cause: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        ...(refusal === null ? {} : { causeRefusal: refusal }),
        correction: refusal === "WRONG_REPOSITORY"
          ? "the repository at the project's name is not the one its genesis receipted; a person resolves which repository the project is before any work is tracked"
          : "GitHub did not complete the synchronization; admit the work again, and the retry reuses the milestone and issues already created",
      });
    }
    const byIssue = new Map([...recorded.values()].map((unit) => [unit.issueNumber, unit.taskId] as const));
    const judged = judgeWorkIssues(pending, observed, byIssue);
    if (judged.units.length > 0) {
      const record: TrackedWorkScope = { repositoryIdentity: governed.repositoryIdentity, repositoryNodeId, milestone: judged.milestone, units: judged.units };
      const written = this.ports.audit.record({ kind: WORK_SCOPE_GITHUB_TRACKED, runId, projectId: run.projectId, evidence: { ...record } });
      if (!written.allowed) return written as Decision<void>;
    }
    if (judged.unmet.length > 0) {
      const verified = new Set(judged.units.map((unit) => unit.taskId));
      return this.#refusedFor(runId, governed, pending.filter((task) => !verified.has(task.taskId)), undefined, { unmet: judged.unmet });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** The only GitHub writes a synchronization makes: this run's milestone and issues, while it admits work. */
  #guard(runId: string, target: GitHubRepositoryTarget): BootstrapWriteGuard {
    const root = `repos/${target.owner}/${target.name}`;
    return {
      beforeRequest: (request) => {
        if (request.kind !== "api" || request.method !== "POST" || (request.target !== `${root}/milestones` && request.target !== `${root}/issues`)) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "a work-scope synchronization writes only its run's milestone and issues", { request: { ...request } });
        }
        const run = this.ports.runs.get(runId);
        if (!run || run.kind !== RunKind.STANDARD_WORK || ENDED.has(run.state)) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the run no longer admits work", { runId, state: run?.state ?? null });
        }
      },
    };
  }

  /**
   * The run's governing repository, or `null` when nothing is required of it. A Repo Factory project's
   * resident provisioning row names the repository and the node id its genesis receipted; a run of it
   * whose primary repository is another one is refused rather than tracked somewhere else.
   */
  #governed(runId: string): Decision<Governed | null> {
    const run = this.ports.runs.get(runId);
    if (!run || run.kind !== RunKind.STANDARD_WORK || !run.projectId) return allow(ReasonCode.OK, null);
    const row = this.ports.db.get<{ repositoryIdentity: unknown; repositoryNodeId: unknown }>(
      `SELECT json_extract(allocation_json, '$.repositoryIdentity') AS repositoryIdentity,
              json_extract(allocation_json, '$.repositoryNodeId') AS repositoryNodeId
         FROM resident_project_provisioning WHERE project_id = ? AND status IN ('PENDING', 'COMPLETE')`,
      [run.projectId],
    );
    if (!row || (row.repositoryIdentity == null && row.repositoryNodeId == null)) return allow(ReasonCode.OK, null);
    const identity = typeof row.repositoryIdentity === "string" ? row.repositoryIdentity : "";
    const parsed = parseGitHubIdentity(identity);
    const primary = this.ports.runs.repositoriesOf(runId).find((repository) => repository.repositoryRole === "primary");
    if (parsed === null || parsed.ref !== null || !isGitHubNodeId(row.repositoryNodeId) || (primary !== undefined && primary.identity !== identity)) {
      return deny(ReasonCode.WORK_SCOPE_NOT_TRACKED_ON_GITHUB, "the run's work cannot be tracked: its project's repository is not one GitHub repository at a recorded node id, or not the run's primary repository", {
        refusal: "WORK_SCOPE_REPOSITORY_UNRESOLVED",
        runId,
        projectRepository: identity || null,
        runPrimaryRepository: primary?.identity ?? null,
        correction: "the run's primary repository must be its Repo Factory project's repository, at the node id its genesis receipted",
      });
    }
    return allow(ReasonCode.OK, { target: { owner: parsed.owner, name: parsed.name }, repositoryIdentity: identity, repositoryNodeId: row.repositoryNodeId });
  }

  #approved(runId: string): TaskRecord[] {
    return this.ports.tasks.list(runId).filter((task) => task.state !== TaskState.CANCELLED);
  }

  /** Every unit of the run a readback verified, on this repository; the first record of a unit stands. */
  #recorded(runId: string, governed: Governed): Map<string, TrackedUnit> {
    const units = new Map<string, TrackedUnit>();
    for (const record of this.#records(runId)) {
      if (record.repositoryNodeId !== governed.repositoryNodeId) continue;
      for (const unit of record.units) if (!units.has(unit.taskId)) units.set(unit.taskId, unit);
    }
    return units;
  }

  #milestone(runId: string): TrackedWorkScope["milestone"] {
    return this.#records(runId).find((record) => record.milestone !== null)?.milestone ?? null;
  }

  #records(runId: string): TrackedWorkScope[] {
    return this.ports.db
      .all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`, [WORK_SCOPE_GITHUB_TRACKED, runId])
      .map((row) => JSON.parse(row.evidence_json) as Partial<TrackedWorkScope>)
      .filter((record): record is TrackedWorkScope => Array.isArray(record.units) && typeof record.repositoryNodeId === "string");
  }

  #refusedFor(runId: string, governed: Governed, untracked: readonly TaskRecord[], taskId: string | undefined, evidence: Evidence = {}): Decision<never> {
    return this.#refused(runId, governed, "some of its approved work units are not linked on GitHub as one issue each in the run's goal milestone", {
      ...(taskId === undefined ? {} : { taskId }),
      untracked: untracked.map((task) => ({ taskId: task.taskId, title: task.title })),
      ...evidence,
    });
  }

  #refused(runId: string, governed: Governed, why: string, evidence: Evidence): Decision<never> {
    return deny(ReasonCode.WORK_SCOPE_NOT_TRACKED_ON_GITHUB, `run ${runId} is not admitted: ${why}`, {
      refusal: ReasonCode.WORK_SCOPE_NOT_TRACKED_ON_GITHUB,
      runId,
      repository: governed.repositoryIdentity,
      repositoryNodeId: governed.repositoryNodeId,
      ...evidence,
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
