import { createHash } from "node:crypto";

import { acpError, allow, deny, type Decision, type Evidence } from "../core/errors.ts";
import { digestOf } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type BootstrapWriteGuard, runUnderWriteGuard } from "../bootstrap/bootstrap-write-guard.ts";
import { screenPublicText } from "../bootstrap/genesis-bundle.ts";
import {
  type GitHubRepositoryTarget,
  type GitHubWritePort,
  type WorkIssue,
  type WorkMilestone,
  isGitHubNodeId,
  parseGitHubIdentity,
} from "../bootstrap/github-write-port.ts";
import { type WorkUnitDeclaration, workUnitsSchema } from "../bootstrap/plan-input-schema.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, RunKind, RunState, TaskState } from "../domain/types.ts";
import type { RunEngine } from "./run-engine.ts";
import { CLOSED_TO_NEW_TASKS, type TaskGraph, type TaskRecord } from "./task-graph.ts";

/**
 * #1240 (ACP part) — a Repo Factory project's approved work units are linked on GitHub, by readback
 * from the exact repository, before any of their tasks is admitted to execution or the run is confirmed.
 *
 * The units are the PLAN's (`plan.workUnits`): the current owner maps the run's tasks to responsibility
 * units, several tasks to one unit when they share one deliverable and its rollback, and gives each unit
 * an issue and a milestone — an existing one by number, adopted and verified, or a `new` one ACP creates
 * with exactly the PLAN's text. Nothing is created per task or per execution. The latest PLAN's units are
 * the whole approved scope; its mapping, resolved to task ids, and the owner who submitted it are
 * recorded at plan acceptance (`WORK_SCOPE_APPROVED`).
 *
 * What is verified is structure and linkage, never content: the issue exists in the repository at the
 * node id the genesis receipted (all pages, pull requests excluded, every item naming that repository),
 * it links by node id to the unit's milestone, and no other unit links it. A verified unit is recorded
 * (`WORK_SCOPE_GITHUB_TRACKED`) with the digest of its declaration and task set, and reused only while
 * both are unchanged: a PLAN that adds, removes, relinks or regroups units re-verifies exactly those. An
 * outage or another unit's change never holds back a unit already linked.
 *
 * No internal id is published. A created issue or milestone carries the PLAN's text and one marker,
 * `<!-- acp:<16 hex> -->`, the truncated SHA-256 of the run id and the unit key (or milestone title):
 * strictly needed only to recognise ACP's own create after a lost answer, and non-identifying. Its
 * number and node id are recorded the moment GitHub answers (`WORK_SCOPE_GITHUB_CREATED`).
 *
 * Writes go through the Repo Factory GitHub port under a guard that admits only a POST of exactly a
 * planned new milestone or issue, to the exact repository, while the run is live, its approval is the
 * current owner's and its PLAN is still the current one. Only a Repo Factory project is governed.
 */
export const WORK_SCOPE_APPROVED = "WORK_SCOPE_APPROVED";
export const WORK_SCOPE_GITHUB_CREATED = "WORK_SCOPE_GITHUB_CREATED";
export const WORK_SCOPE_GITHUB_TRACKED = "WORK_SCOPE_GITHUB_TRACKED";

interface ApprovedUnit {
  unit: string;
  taskIds: string[];
  declarationDigest: string;
}

interface ApprovedScope {
  planDigest: string;
  sessionId: string | null;
  bindingGeneration: number;
  units: ApprovedUnit[];
}

export interface TrackedUnit {
  unit: string;
  declarationDigest: string;
  /** The link and task set this verification holds for (`scopeDigestOf`). */
  scopeDigest: string;
  issueNumber: number;
  issueNodeId: string;
  milestoneNumber: number;
  milestoneNodeId: string;
  adopted: boolean;
}

export type UnmetKind =
  | "DECLARATION_CHANGED"
  | "MILESTONE_NOT_FOUND"
  | "MILESTONE_EXISTS"
  | "MILESTONE_TEXT_DIFFERS"
  | "ISSUE_TEXT_DIFFERS"
  | "ISSUE_NOT_FOUND"
  | "ISSUE_EXISTS"
  | "DUPLICATE_OF_ADOPTED"
  | "CATCH_ALL_ISSUE"
  | "MILESTONE_LINK_MISSING"
  | "MILESTONE_LINK_WRONG";

/** A unit whose link GitHub's readback does not hold, and what corrects it. */
export interface UnmetWork {
  unit: string;
  unmet: UnmetKind;
  issues?: number[];
  milestones?: number[];
  correction: string;
}

/** What `declare` admitted of a PLAN, before it is stored. */
export interface WorkScopeDeclaration {
  units: WorkUnitDeclaration[];
}

interface Governed {
  target: GitHubRepositoryTarget;
  repositoryIdentity: string;
  repositoryNodeId: string;
}

interface Status {
  scope: ApprovedScope | null;
  unitOf: Map<string, ApprovedUnit>;
  unmapped: TaskRecord[];
  live: ApprovedUnit[];
  tracked: Map<string, TrackedUnit>;
}

/** The run states that admit no more work, so no issue is written for one. */
const ENDED: ReadonlySet<string> = new Set([RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED]);

const SHAPE =
  "declare the run's work units in its PLAN: plan_submit with plan.workUnits, each {key, tasks: [this submission's task keys or the run's task ids], " +
  "issue: {number} to adopt an existing issue or {new: {title, body}}, milestone: {number} or {new: {title}}}, every live task in exactly one unit; " +
  "tasks may be omitted to re-link the run's existing tasks";

const INTERNAL_ID = /\b(?:prj|repo|ses|run|task|art|clm|msg|asg)_[0-9a-f]{24}\b/;
// A path starts wherever the character before it cannot continue a path (src/github/branch-publish.ts
// draws the same boundary): quotes, backticks, brackets, '<', '>', '|', '=', ':' or a '/' alike.
const LOCAL_PATH = /(?:^|[^A-Za-z0-9._~-])(?:\/(?:Users|home|private|var|tmp|opt|etc)\/|[A-Za-z]:\\)/m;

/** Why a PLAN text may not be published as written, or null. */
const unpublishable = (text: string): string | null => {
  if (INTERNAL_ID.test(text)) return "an internal ACP id";
  if (LOCAL_PATH.test(text)) return "a local filesystem path";
  try {
    screenPublicText(text);
  } catch {
    return "credential-shaped content";
  }
  return null;
};

/** The non-identifying marker of ACP's own create, recognised again after a lost answer. */
const createdMarker = (runId: string, resource: "issue" | "milestone", key: string): string =>
  `<!-- acp:${createHash("sha256").update(`${runId}\n${resource}\n${key}`).digest("hex").slice(0, 16)} -->`;
const withMarker = (text: string, marker: string): string => (text.trimEnd() ? `${text.trimEnd()}\n\n${marker}` : marker);
const sameTitle = (left: string, right: string): boolean => left.trim().toLowerCase() === right.trim().toLowerCase();
const declarationDigestOf = (unit: WorkUnitDeclaration): string => digestOf({ issue: unit.issue, milestone: unit.milestone });
/** What a unit's verification is reused for: its link and its task set; any change verifies it again. */
const scopeDigestOf = (unit: { declarationDigest: string; taskIds: readonly string[] }): string =>
  digestOf({ declarationDigest: unit.declarationDigest, taskIds: [...unit.taskIds].sort() });
/** GitHub's text as the PLAN's: line endings and trailing space aside, exactly. */
const sameText = (left: string, right: string): boolean => left.replace(/\r\n/g, "\n").trimEnd() === right.replace(/\r\n/g, "\n").trimEnd();
const titleDigestOf = (title: string): string => digestOf(title.trim().toLowerCase());
const list = (numbers: readonly number[]): string => numbers.map((n) => `#${n}`).join(", ");

export interface WorkScopeTrackingPorts {
  db: Db;
  audit: AuditLog;
  artifacts: Pick<ArtifactStore, "latest">;
  runs: Pick<RunEngine, "get" | "repositoriesOf">;
  tasks: Pick<TaskGraph, "list">;
  github: GitHubWritePort;
}

export class WorkScopeTracking {
  /** One synchronization per run at a time, so two admissions never both create a missing issue. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: WorkScopeTrackingPorts) {}

  /**
   * At plan_submit, before anything is stored: a governed run's PLAN declares its units, every live task
   * (the run's, and this submission's by key) in exactly one, no two units sharing an adopted issue or a
   * new title, and nothing unpublishable in the text ACP would create. `null` for a run not governed.
   */
  declare(runId: string, plan: Record<string, unknown>, submitted: ReadonlyArray<{ key: string }>): Decision<WorkScopeDeclaration | null> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<null>;
    const run = this.ports.runs.get(runId)!;
    const invalid = (refusal: string, message: string, evidence: Evidence = {}): Decision<never> =>
      deny(ReasonCode.INVALID_ARGUMENT, message, { refusal, runId, ...evidence, correction: SHAPE });
    if (CLOSED_TO_NEW_TASKS.has(run.state)) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}; its approved scope is sealed`, { refusal: "WORK_UNITS_RUN_SEALED", runId, state: run.state });
    }
    if (plan["workUnits"] === undefined) return invalid("WORK_UNITS_MISSING", "a Repo Factory project's STANDARD_WORK PLAN declares its work units");
    const parsed = workUnitsSchema.safeParse(plan["workUnits"]);
    if (!parsed.success) {
      return invalid("WORK_UNITS_INVALID", "the PLAN's work units are not well formed", { problems: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
    }
    const units = parsed.data;
    const keys = units.map((unit) => unit.key);
    const repeatedKeys = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
    if (repeatedKeys.length > 0) return invalid("WORK_UNITS_INVALID", `unit keys ${repeatedKeys.join(", ")} are declared more than once`, { units: repeatedKeys });
    const live = this.#live(runId).map((task) => task.taskId);
    const known = new Set([...submitted.map((task) => task.key), ...live]);
    const refs = units.flatMap((unit) => unit.tasks);
    const unknown = refs.filter((ref) => !known.has(ref));
    const twice = [...new Set(refs.filter((ref, index) => refs.indexOf(ref) !== index))];
    const unmapped = [...live, ...submitted.map((task) => task.key)].filter((ref) => !refs.includes(ref));
    if (unknown.length > 0 || twice.length > 0 || unmapped.length > 0) {
      return invalid("WORK_UNITS_TASKS_UNMAPPED", "every live task belongs to exactly one declared unit, and a unit names only live tasks", { unknown, inMoreThanOneUnit: twice, unmapped });
    }
    const adopted = units.flatMap((unit) => ("number" in unit.issue ? [unit.issue.number] : []));
    const sharedIssues = [...new Set(adopted.filter((n, index) => adopted.indexOf(n) !== index))];
    if (sharedIssues.length > 0) return invalid("WORK_UNITS_SHARE_AN_ISSUE", `issues ${list(sharedIssues)} are each adopted by more than one unit; one issue stands for one unit`, { issues: sharedIssues });
    const newTitles = units.flatMap((unit) => ("new" in unit.issue ? [unit.issue.new.title.trim().toLowerCase()] : []));
    const repeatedTitles = [...new Set(newTitles.filter((t, index) => newTitles.indexOf(t) !== index))];
    if (repeatedTitles.length > 0) return invalid("WORK_UNITS_NEW_ISSUE_DUPLICATED", "two new units would create issues of the same title", { titles: repeatedTitles });
    const milestones = new Map<string, string>();
    for (const unit of units) {
      if (!("new" in unit.milestone)) continue;
      const title = unit.milestone.new.title.trim().toLowerCase();
      const seen = milestones.get(title);
      if (seen !== undefined && seen !== unit.milestone.new.description) return invalid("WORK_UNITS_NEW_MILESTONE_CONFLICT", "one new milestone is declared with two descriptions", { milestone: unit.milestone.new.title });
      milestones.set(title, unit.milestone.new.description);
    }
    const texts = units.flatMap((unit) => [
      ...("new" in unit.issue ? [{ unit: unit.key, field: "issue", text: `${unit.issue.new.title}\n${unit.issue.new.body}` }] : []),
      ...("new" in unit.milestone ? [{ unit: unit.key, field: "milestone", text: `${unit.milestone.new.title}\n${unit.milestone.new.description}` }] : []),
    ]);
    const leaks = texts.flatMap(({ unit, field, text }) => {
      const why = unpublishable(text);
      return why === null ? [] : [{ unit, field, carries: why }];
    });
    if (leaks.length > 0) return invalid("WORK_UNITS_TEXT_NOT_PUBLIC", "a new issue or milestone's text carries what may not be published", { leaks });
    return allow(ReasonCode.OK, { units });
  }

  /** After the PLAN and its tasks are stored: the declared mapping, resolved to task ids, and its owner. */
  approve(
    runId: string,
    planDigest: string,
    declaration: WorkScopeDeclaration,
    submitted: ReadonlyArray<{ key: string }>,
    created: readonly TaskRecord[],
    owner: { sessionId: string; bindingGeneration: number },
  ): Decision<void> {
    const idOf = new Map(submitted.map((task, index) => [task.key, created[index]!.taskId] as const));
    const units: ApprovedUnit[] = declaration.units.map((unit) => ({
      unit: unit.key,
      taskIds: unit.tasks.map((ref) => idOf.get(ref) ?? ref),
      declarationDigest: declarationDigestOf(unit),
    }));
    const recorded = this.ports.audit.record({
      kind: WORK_SCOPE_APPROVED,
      runId,
      projectId: this.ports.runs.get(runId)?.projectId ?? null,
      sessionId: owner.sessionId,
      evidence: { planDigest, bindingGeneration: owner.bindingGeneration, units },
    });
    return recorded.allowed ? allow(ReasonCode.OK, undefined) : (recorded as Decision<void>);
  }

  /** Synchronous, inside every execution's transaction: this task's unit is linked and verified. */
  assertTracked(runId: string, taskId: string): Decision<TrackedUnit | null> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<null>;
    const status = this.#status(runId, governed.value);
    const unit = status.unitOf.get(taskId);
    const tracked = unit === undefined ? undefined : status.tracked.get(unit.unit);
    if (tracked !== undefined) return allow(ReasonCode.OK, tracked);
    return this.#refused(runId, governed.value, status, {
      taskId,
      correction: unit === undefined ? SHAPE : "admit the task through task_worker_provision or task_worker_run: ACP verifies its unit's link, or creates what the PLAN marks new",
    });
  }

  /**
   * Plan acceptance's and admission's entry. With a task whose unit is verified, GitHub is not asked.
   * Otherwise every live unit not verified under its current declaration is synchronized at once —
   * adopted links read back, new ones created first — and each unit verified is recorded, whatever
   * happens to the rest; the task is admitted if its unit is among them. Without a task (plan
   * acceptance) the answer is for the whole approved scope.
   */
  ensure(runId: string, taskId?: string): Promise<Decision<TrackedUnit | { units: TrackedUnit[] } | null>> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.#ensureNow(runId, taskId), () => this.#ensureNow(runId, taskId));
    const settled = next.then(() => undefined, () => undefined);
    this.#queues.set(runId, settled);
    void settled.then(() => {
      if (this.#queues.get(runId) === settled) this.#queues.delete(runId);
    });
    return next;
  }

  /**
   * The CONFIRM path's question, read-only: a run of a governed project passes as complete only when
   * every live task is in a unit of its current PLAN and every such unit is verified. A sealed run is
   * refused with the units named; it is recovered through the existing FINAL_REVISE path.
   */
  assertSettled(runId: string): Decision<void> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<void>;
    const status = this.#status(runId, governed.value);
    if (status.unmapped.length === 0 && status.live.every((unit) => status.tracked.has(unit.unit))) return allow(ReasonCode.OK, undefined);
    return this.#refused(runId, governed.value, status, {
      correction: "send the run back with FINAL_REVISE; its owner declares the PLAN's work units (adopting the issues that already exist) and ACP verifies them before the run is confirmed",
    });
  }

  async #ensureNow(runId: string, taskId: string | undefined): Promise<Decision<TrackedUnit | { units: TrackedUnit[] } | null>> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<null>;
    let status = this.#status(runId, governed.value);
    if (taskId !== undefined) {
      const unit = status.unitOf.get(taskId);
      if (unit === undefined) return this.#refused(runId, governed.value, status, { taskId, correction: SHAPE });
      const tracked = status.tracked.get(unit.unit);
      if (tracked !== undefined) return allow(ReasonCode.OK, tracked);
    }
    const pending = status.live.filter((unit) => !status.tracked.has(unit.unit));
    const synced = pending.length > 0 && status.scope !== null ? await this.#synchronize(runId, governed.value, status, pending) : {};
    status = this.#status(runId, governed.value);
    if (taskId !== undefined) {
      const tracked = status.tracked.get(status.unitOf.get(taskId)?.unit ?? "");
      return tracked !== undefined ? allow(ReasonCode.OK, tracked) : this.#refused(runId, governed.value, status, { taskId, ...synced });
    }
    if (status.unmapped.length > 0 || status.live.some((unit) => !status.tracked.has(unit.unit))) {
      return this.#refused(runId, governed.value, status, { correction: status.unmapped.length > 0 ? SHAPE : "admit the work again, or correct the PLAN's links as each unmet item says", ...synced });
    }
    return allow(ReasonCode.OK, { units: status.live.map((unit) => status.tracked.get(unit.unit)!) });
  }

  /**
   * Resolves each pending unit's milestone and issue — adopted by number, or ACP's own create found by
   * its record or marker, or created now — reads everything back, and records the units verified.
   */
  async #synchronize(runId: string, governed: Governed, status: Status, pending: readonly ApprovedUnit[]): Promise<Evidence> {
    const { target, repositoryNodeId } = governed;
    const { github } = this.ports;
    if (!github.observeWorkResources || !github.createWorkMilestone || !github.createWorkIssue) {
      return { cause: "the GitHub port cannot read or write work issues", correction: "compose the daemon with the Repo Factory GitHub port" };
    }
    const declarations = this.#declarations(runId);
    const created = this.#created(runId);
    const adoptedBefore = new Map(this.#trackedRecords(runId, governed).filter((unit) => unit.adopted).map((unit) => [unit.unit, unit.issueNumber] as const));
    const unmet: UnmetWork[] = [];
    // The only bodies a POST may carry: exactly the PLAN's new milestones and issues, with their markers.
    const planned: Array<{ path: "milestones" | "issues"; title: string; text: string }> = [];
    for (const approved of pending) {
      const declared = declarations.get(approved.unit);
      if (declared === undefined) continue;
      if ("new" in declared.milestone) planned.push({ path: "milestones", title: declared.milestone.new.title, text: withMarker(declared.milestone.new.description, createdMarker(runId, "milestone", declared.milestone.new.title.trim().toLowerCase())) });
      if ("new" in declared.issue) planned.push({ path: "issues", title: declared.issue.new.title, text: withMarker(declared.issue.new.body, createdMarker(runId, "issue", approved.unit)) });
    }
    const resolved = new Map<string, { milestoneNumber: number; issueNumber: number; adopted: boolean }>();
    let readback: { milestones: WorkMilestone[]; issues: WorkIssue[] };
    try {
      readback = await runUnderWriteGuard(this.#guard(runId, target, status.scope!, planned), async () => {
        const resources = await github.observeWorkResources!(target, repositoryNodeId);
        for (const approved of pending) {
          const declared = declarations.get(approved.unit);
          if (declared === undefined || declarationDigestOf(declared) !== approved.declarationDigest) {
            unmet.push({ unit: approved.unit, unmet: "DECLARATION_CHANGED", correction: "the stored PLAN's unit differs from its approval; submit the PLAN again" });
            continue;
          }
          let milestone: WorkMilestone | undefined;
          if ("number" in declared.milestone) {
            const number = declared.milestone.number;
            milestone = resources.milestones.find((m) => m.number === number);
            if (milestone === undefined) {
              unmet.push({ unit: approved.unit, unmet: "MILESTONE_NOT_FOUND", milestones: [number], correction: `milestone #${number} is not a milestone of ${governed.repositoryIdentity}; name an existing one or declare it new` });
              continue;
            }
          } else {
            const { title, description } = declared.milestone.new;
            const marker = createdMarker(runId, "milestone", title.trim().toLowerCase());
            const record = created.get(`milestone:${titleDigestOf(title)}`);
            milestone = resources.milestones.find((m) => record !== undefined && m.number === record.number && m.nodeId === record.nodeId)
              ?? resources.milestones.find((m) => m.description.includes(marker));
            // ACP's own earlier create stands for this unit only while it reads as the PLAN now declares it.
            if (milestone !== undefined && (milestone.title !== title || !sameText(milestone.description, withMarker(description, marker)))) {
              unmet.push({ unit: approved.unit, unmet: "MILESTONE_TEXT_DIFFERS", milestones: [milestone.number], correction: `milestone #${milestone.number}, created for this unit, does not read as the PLAN now declares it; adopt it by number, or declare it as it reads` });
              continue;
            }
            if (milestone === undefined) {
              const clash = resources.milestones.find((m) => sameTitle(m.title, title));
              if (clash !== undefined) {
                unmet.push({ unit: approved.unit, unmet: "MILESTONE_EXISTS", milestones: [clash.number], correction: `milestone #${clash.number} already has this title; adopt it by number` });
                continue;
              }
              milestone = await github.createWorkMilestone!(target, repositoryNodeId, { title, description: withMarker(description, marker) });
              this.#recordCreated(runId, "milestone", { titleDigest: titleDigestOf(title) }, milestone);
              created.set(`milestone:${titleDigestOf(title)}`, milestone);
              resources.milestones.push(milestone);
            }
          }
          let issue: WorkIssue | undefined;
          const adopted = "number" in declared.issue;
          if ("number" in declared.issue) {
            const number = declared.issue.number;
            issue = resources.issues.find((i) => i.number === number);
            if (issue === undefined) {
              unmet.push({ unit: approved.unit, unmet: "ISSUE_NOT_FOUND", issues: [number], correction: `#${number} is not an issue of ${governed.repositoryIdentity}; name an existing issue or declare the unit new` });
              continue;
            }
          } else {
            const { title, body } = declared.issue.new;
            const marker = createdMarker(runId, "issue", approved.unit);
            const record = created.get(`issue:${approved.unit}`);
            issue = resources.issues.find((i) => record !== undefined && i.number === record.number && i.nodeId === record.nodeId)
              ?? resources.issues.find((i) => i.body.includes(marker));
            // ACP's own earlier create stands for this unit only while it reads as the PLAN now declares it.
            if (issue !== undefined && (issue.title !== title || !sameText(issue.body, withMarker(body, marker)))) {
              unmet.push({ unit: approved.unit, unmet: "ISSUE_TEXT_DIFFERS", issues: [issue.number], correction: `issue #${issue.number}, created for this unit, does not read as the PLAN now declares it; adopt it by number, or declare it as it reads` });
              continue;
            }
            if (issue === undefined) {
              const before = adoptedBefore.get(approved.unit);
              if (before !== undefined) {
                unmet.push({ unit: approved.unit, unmet: "DUPLICATE_OF_ADOPTED", issues: [before], correction: `this unit was linked to existing issue #${before}; keep adopting it rather than creating a duplicate` });
                continue;
              }
              const clash = resources.issues.find((i) => sameTitle(i.title, title));
              if (clash !== undefined) {
                unmet.push({ unit: approved.unit, unmet: "ISSUE_EXISTS", issues: [clash.number], correction: `issue #${clash.number} already has this title; adopt it by number rather than create a duplicate` });
                continue;
              }
              issue = await github.createWorkIssue!(target, repositoryNodeId, { title, body: withMarker(body, marker), milestone: milestone.number });
              this.#recordCreated(runId, "issue", { unit: approved.unit }, issue);
              created.set(`issue:${approved.unit}`, issue);
              resources.issues.push(issue);
            }
          }
          resolved.set(approved.unit, { milestoneNumber: milestone.number, issueNumber: issue.number, adopted });
        }
        return github.observeWorkResources!(target, repositoryNodeId);
      });
    } catch (error) {
      const evidence = isRecord(error) && isRecord(error["evidence"]) ? (error["evidence"] as Evidence) : {};
      const refusal = typeof evidence["refusal"] === "string" ? evidence["refusal"] : null;
      return {
        ...(unmet.length > 0 ? { unmet } : {}),
        cause: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        ...(refusal === null ? {} : { causeRefusal: refusal }),
        correction: refusal === "WRONG_REPOSITORY"
          ? "the repository at the project's name is not the one its genesis receipted; a person resolves which repository the project is before any work is tracked"
          : "GitHub did not complete the synchronization; admit the work again: what was created is reused, never duplicated",
      };
    }
    // The readback alone decides: each resolved issue and milestone present, linked by node id, one unit each.
    const claimed = new Map<number, string>();
    for (const unit of status.tracked.values()) claimed.set(unit.issueNumber, unit.unit);
    for (const [unit, link] of resolved) if (!claimed.has(link.issueNumber)) claimed.set(link.issueNumber, unit);
    const verified: TrackedUnit[] = [];
    for (const [unit, link] of resolved) {
      const approved = pending.find((p) => p.unit === unit)!;
      const issue = readback.issues.find((i) => i.number === link.issueNumber);
      const milestone = readback.milestones.find((m) => m.number === link.milestoneNumber);
      if (issue === undefined) unmet.push({ unit, unmet: "ISSUE_NOT_FOUND", issues: [link.issueNumber], correction: `#${link.issueNumber} is no longer an issue of ${governed.repositoryIdentity}` });
      else if (milestone === undefined) unmet.push({ unit, unmet: "MILESTONE_NOT_FOUND", milestones: [link.milestoneNumber], correction: `milestone #${link.milestoneNumber} is no longer a milestone of ${governed.repositoryIdentity}` });
      else if (claimed.get(issue.number) !== unit) unmet.push({ unit, unmet: "CATCH_ALL_ISSUE", issues: [issue.number], correction: `issue #${issue.number} already stands for unit ${claimed.get(issue.number)}; give this unit its own issue` });
      else if (issue.milestone === null) unmet.push({ unit, unmet: "MILESTONE_LINK_MISSING", issues: [issue.number], milestones: [milestone.number], correction: `link issue #${issue.number} to milestone #${milestone.number}, or declare the milestone it is in` });
      else if (issue.milestone.nodeId !== milestone.nodeId) unmet.push({ unit, unmet: "MILESTONE_LINK_WRONG", issues: [issue.number], milestones: [milestone.number, issue.milestone.number], correction: `issue #${issue.number} is in milestone #${issue.milestone.number}, not #${milestone.number}; move it, or declare the milestone it is in` });
      else verified.push({ unit, declarationDigest: approved.declarationDigest, scopeDigest: scopeDigestOf(approved), issueNumber: issue.number, issueNodeId: issue.nodeId, milestoneNumber: milestone.number, milestoneNodeId: milestone.nodeId, adopted: link.adopted });
    }
    if (verified.length > 0) {
      this.ports.audit.record({
        kind: WORK_SCOPE_GITHUB_TRACKED,
        runId,
        projectId: this.ports.runs.get(runId)?.projectId ?? null,
        evidence: { repositoryIdentity: governed.repositoryIdentity, repositoryNodeId, units: verified },
      });
    }
    return unmet.length > 0 ? { unmet } : {};
  }

  /**
   * The only GitHub writes a synchronization makes: a POST of exactly one planned new milestone or
   * issue to the exact repository, while the run is live, its approval is its current owner's, and the
   * PLAN it serves is still the run's current one.
   */
  #guard(runId: string, target: GitHubRepositoryTarget, scope: ApprovedScope, planned: ReadonlyArray<{ path: string; title: string; text: string }>): BootstrapWriteGuard {
    const root = `repos/${target.owner}/${target.name}`;
    return {
      beforeRequest: (request) => {
        const body = isRecord(request.body) ? request.body : {};
        const path = request.target === `${root}/milestones` ? "milestones" : request.target === `${root}/issues` ? "issues" : null;
        const text = path === "milestones" ? body["description"] : body["body"];
        const exact = planned.some((p) => p.path === path && p.title === body["title"] && p.text === text);
        if (request.kind !== "api" || request.method !== "POST" || path === null || !exact || (path === "issues" && typeof body["milestone"] !== "number")) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "a work-scope synchronization writes only the PLAN's own new milestones and issues", { request: { kind: request.kind, method: request.method, target: request.target } });
        }
        const run = this.ports.runs.get(runId);
        if (!run || run.kind !== RunKind.STANDARD_WORK || ENDED.has(run.state)) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the run no longer admits work", { runId, state: run?.state ?? null });
        }
        if (run.ownerSessionId !== scope.sessionId || run.ownerBindingGeneration !== scope.bindingGeneration) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the PLAN's work units were approved by another owner than the run's current one; its current owner submits them again before anything is created", {
            refusal: "WORK_SCOPE_APPROVAL_NOT_CURRENT_OWNER", runId,
          });
        }
        // A PLAN accepted while this synchronization waited on GitHub supersedes the one it serves.
        const current = this.#scope(runId);
        if (current === null || current.planDigest !== scope.planDigest || digestOf(current.units) !== digestOf(scope.units)) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the PLAN this synchronization serves is no longer the run's current one; nothing of it is created", {
            refusal: "WORK_SCOPE_PLAN_SUPERSEDED", runId, planDigest: scope.planDigest, currentPlanDigest: current?.planDigest ?? null,
          });
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

  #live(runId: string): TaskRecord[] {
    return this.ports.tasks.list(runId).filter((task) => task.state !== TaskState.CANCELLED);
  }

  /** The current approved scope (the latest approval, of the run's current PLAN), and each live unit's verification. */
  #status(runId: string, governed: Governed): Status {
    const scope = this.#scope(runId);
    const live = this.#live(runId);
    const unitOf = new Map<string, ApprovedUnit>();
    for (const unit of scope?.units ?? []) for (const taskId of unit.taskIds) unitOf.set(taskId, unit);
    const liveIds = new Set(live.map((task) => task.taskId));
    const liveUnits = (scope?.units ?? []).filter((unit) => unit.taskIds.some((taskId) => liveIds.has(taskId)));
    const tracked = new Map<string, TrackedUnit>();
    for (const record of this.#trackedRecords(runId, governed)) {
      const unit = liveUnits.find((u) => u.unit === record.unit && record.scopeDigest === scopeDigestOf(u));
      if (unit !== undefined) tracked.set(unit.unit, record);
    }
    return { scope, unitOf, unmapped: live.filter((task) => !unitOf.has(task.taskId)), live: liveUnits, tracked };
  }

  #scope(runId: string): ApprovedScope | null {
    const plan = this.ports.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    if (plan === null) return null;
    const row = this.ports.db.get<{ session_id: string | null; evidence_json: string }>(
      `SELECT session_id, evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id DESC LIMIT 1`,
      [WORK_SCOPE_APPROVED, runId],
    );
    if (!row) return null;
    const evidence = JSON.parse(row.evidence_json) as Partial<ApprovedScope>;
    if (evidence.planDigest !== plan.digest || !Array.isArray(evidence.units) || typeof evidence.bindingGeneration !== "number") return null;
    return { planDigest: evidence.planDigest, sessionId: row.session_id, bindingGeneration: evidence.bindingGeneration, units: evidence.units };
  }

  #declarations(runId: string): Map<string, WorkUnitDeclaration> {
    const content = this.ports.artifacts.latest<Record<string, unknown>>(runId, ArtifactKind.PLAN)?.content;
    const parsed = workUnitsSchema.safeParse(content?.["workUnits"]);
    return new Map(parsed.success ? parsed.data.map((unit) => [unit.key, unit] as const) : []);
  }

  /** Every unit verification recorded for the run on this repository, oldest first. */
  #trackedRecords(runId: string, governed: Governed): TrackedUnit[] {
    return this.ports.db
      .all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`, [WORK_SCOPE_GITHUB_TRACKED, runId])
      .map((row) => JSON.parse(row.evidence_json) as { repositoryNodeId?: unknown; units?: unknown })
      .filter((record) => record.repositoryNodeId === governed.repositoryNodeId && Array.isArray(record.units))
      .flatMap((record) => record.units as TrackedUnit[]);
  }

  /** What ACP created for the run, by unit (issues) or title digest (milestones), as GitHub first answered it. */
  #created(runId: string): Map<string, { number: number; nodeId: string }> {
    const created = new Map<string, { number: number; nodeId: string }>();
    for (const row of this.ports.db.all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`, [WORK_SCOPE_GITHUB_CREATED, runId])) {
      const e = JSON.parse(row.evidence_json) as { resource?: string; unit?: string; titleDigest?: string; number?: number; nodeId?: string };
      if (typeof e.number !== "number" || typeof e.nodeId !== "string") continue;
      const key = e.resource === "issue" ? `issue:${e.unit}` : `milestone:${e.titleDigest}`;
      if (!created.has(key)) created.set(key, { number: e.number, nodeId: e.nodeId });
    }
    return created;
  }

  #recordCreated(runId: string, resource: "issue" | "milestone", key: { unit?: string; titleDigest?: string }, answered: { number: number; nodeId: string }): void {
    this.ports.audit.record({
      kind: WORK_SCOPE_GITHUB_CREATED,
      runId,
      projectId: this.ports.runs.get(runId)?.projectId ?? null,
      evidence: { resource, ...key, number: answered.number, nodeId: answered.nodeId },
    });
  }

  #refused(runId: string, governed: Governed, status: Status, evidence: Evidence): Decision<never> {
    const untracked = status.live.filter((unit) => !status.tracked.has(unit.unit));
    return deny(ReasonCode.WORK_SCOPE_NOT_TRACKED_ON_GITHUB, `run ${runId} is not admitted: some of its approved work is not linked on GitHub as its PLAN's units`, {
      refusal: ReasonCode.WORK_SCOPE_NOT_TRACKED_ON_GITHUB,
      runId,
      repository: governed.repositoryIdentity,
      repositoryNodeId: governed.repositoryNodeId,
      untracked: untracked.map((unit) => ({ unit: unit.unit, tasks: unit.taskIds })),
      unmapped: status.unmapped.map((task) => ({ taskId: task.taskId, title: task.title })),
      ...evidence,
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
