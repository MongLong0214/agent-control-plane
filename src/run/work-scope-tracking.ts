import { createHash, randomUUID } from "node:crypto";

import { acpError, allow, deny, type Decision, type Evidence, isAcpError } from "../core/errors.ts";
import { canonicalJson, digestOf } from "../core/digest.ts";
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
  requestOutcomeUnknown,
} from "../bootstrap/github-write-port.ts";
import { type WorkUnitDeclaration, workUnitsSchema } from "../bootstrap/plan-input-schema.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, RunKind, TaskState } from "../domain/types.ts";
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
 * (`WORK_SCOPE_GITHUB_TRACKED`) with the digest of its declaration and task set and the approval it
 * served. Only a unit's latest verification is reused, and only while its scope has stayed the same in
 * every approval since: a PLAN that adds, removes, relinks or regroups units re-verifies exactly those,
 * and restoring an earlier scope re-verifies it rather than reviving an older receipt. An
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
/**
 * #1240 reviews R4/R5 — an issue ACP is about to create. Its intent is recorded by the write guard the
 * moment it admits the POST, with the tasks it covers and its own token: a random intent id, published
 * only as the truncated SHA-256 of that id (`<!-- acp:<16 hex> -->`), so it identifies one request and
 * nothing about the run, the unit or the tasks. Its original outcome is one of three, moved only by
 * evidence bound to that request:
 *   - CREATED: GitHub answered the POST, or a readback of the exact repository shows exactly one issue
 *     carrying the intent's own token (several carriers are not one creation);
 *   - DEFINITE_NOT_CREATED: GitHub answered that POST itself with a 4xx other than 408, which proves nothing
 *     was created — the intent is retired at once (`WORK_SCOPE_GITHUB_INTENT_RETIRED`, `outcome`);
 *   - UNKNOWN: anything else (no answer, a timeout, a 5xx, a 408, another request's 4xx). It is kept, never
 *     expired: a POST GitHub is still processing can land later. Until its token is found, no new issue is
 *     created for any task it covers, under any unit key; adopting an existing issue by number stays allowed.
 *
 * #1364 — how the run proceeds past an UNKNOWN is its disposition, kept apart from the original outcome,
 * which it never rewrites:
 *   - ADOPTED_EXISTING: the run's current owner adopted an existing issue by number for the intent's tasks,
 *     verified in the exact repository at its node id. Recorded once (`WORK_SCOPE_GITHUB_INTENT_RETIRED`,
 *     `disposition`), with the deciding owner, the issue and what the readback showed. Nothing is created or
 *     sent again; a supersede of the adopted tasks is no longer refused. A later token match is still recorded
 *     as CREATED, flagged `possibleDuplicateOf` when it is not the adopted issue.
 *   - ENDED_BY_CEO: an escalation opened after the intent and the CEO's FINAL_REVISE after it, for a run that
 *     reaches review. Read from those records: the wait ends (no longer retryable), and nothing else changes. A
 *     run held BLOCKED on it is ended by the CEO's cancel: its tasks are cancelled, so no unit waits and nothing
 *     is sent. An escalation_resolve ends nothing; its answer is free text.
 *   While any intent is UNKNOWN, every ensure reads its token, so a late result is recorded without a pending unit.
 */
export const WORK_SCOPE_GITHUB_CREATING = "WORK_SCOPE_GITHUB_CREATING";
export const WORK_SCOPE_GITHUB_INTENT_RETIRED = "WORK_SCOPE_GITHUB_INTENT_RETIRED";
export const WORK_SCOPE_GITHUB_TRACKED = "WORK_SCOPE_GITHUB_TRACKED";

interface ApprovedUnit {
  unit: string;
  taskIds: string[];
  declarationDigest: string;
}

interface ApprovedScope {
  /** The approval's own audit event: approvals are ordered by it. */
  eventId: number;
  planDigest: string;
  sessionId: string | null;
  bindingGeneration: number;
  units: ApprovedUnit[];
  /** The digest of the submitted task specs and the tasks they created (#1240 review R6: the replay). */
  tasksDigest?: string;
  submittedTaskIds?: string[];
}

export interface TrackedUnit {
  unit: string;
  declarationDigest: string;
  /** The link and task set this verification holds for (`scopeDigestOf`). */
  scopeDigest: string;
  /** The tasks the unit covered when verified: an issue tracks its tasks' work under any unit key. */
  taskIds?: string[];
  /** The approval the verification was made for; a scope change after it makes the verification stale. */
  approvalEventId?: number;
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
  | "WORK_SCOPE_CREATION_UNRESOLVED"
  | "TASK_ALREADY_TRACKED"
  | "CATCH_ALL_ISSUE"
  | "MILESTONE_LINK_MISSING"
  | "MILESTONE_LINK_WRONG";

/** A unit whose link GitHub's readback does not hold, and what corrects it. */
export interface UnmetWork {
  unit: string;
  unmet: UnmetKind;
  issues?: number[];
  milestones?: number[];
  /** The intents whose unknown outcome holds this unit back (WORK_SCOPE_CREATION_UNRESOLVED). */
  intents?: string[];
  /** #1364 — those intents' original outcome, and the CEO's end of the wait on them, when there is one. */
  originalOutcome?: "UNKNOWN";
  dispositions?: CeoEnd[];
  refusal?: string;
  retryable?: boolean;
  correction: string;
}

/** #1364 — the CEO's end of the wait on an intent: the escalation after it and the FINAL_REVISE after that. */
interface CeoEnd { intent: string; disposition: "ENDED_BY_CEO"; escalationId: number; decisionEventId: number }

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


const SHAPE =
  "declare the run's work units in its PLAN: plan_submit with plan.workUnits, each {key, tasks: [this submission's task keys or the run's task ids], " +
  "issue: {number} to adopt an existing issue or {new: {title, body}}, milestone: {number} or {new: {title}}}, every live task in exactly one unit; " +
  "tasks may be omitted to re-link the run's existing tasks";

const INTERNAL_ID = /\b(?:prj|repo|ses|run|task|art|clm|msg|asg)_[0-9a-f]{24}\b/;
// A path starts wherever the character before it cannot continue a path (src/github/branch-publish.ts
// draws the same boundary): quotes, backticks, brackets, '<', '>', '|', '=', ':' or a '/' alike. A local
// path is an absolute one under a home or system root, a home-relative one (~/, ~user/), one through the
// home environment ($HOME/, ${HOME}/, %USERPROFILE%\, %HOMEPATH%\) or a Windows drive path (C:\, C:/).
const LOCAL_PATH = /(?:^|[^A-Za-z0-9._~-])(?:\/(?:Users|home|private|var|tmp|opt|etc|root)\/|~[A-Za-z0-9._-]*\/|\$\{?HOME\}?[\\/]|%(?:USERPROFILE|HOMEPATH)%[\\/]|[A-Za-z]:[\\/])/im;
// Only an http(s) URL with a real host names a path on another machine: its scheme, host and path are set
// aside before the screen (its query and fragment are still screened). A loopback host is this machine.
const HOSTED_URL = /\bhttps?:\/\/(?!(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#\s]|$))[^\s/?#]+[^\s?#]*/gi;
// Any other URL keeps its path in the screen: its scheme and authority are dropped, so the path starts at
// a boundary. A file URL names a local file whatever its host, and is never published.
const URL_AUTHORITY = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]*/g;
const FILE_URL = /(?:^|[^A-Za-z0-9+.-])file:\/\//i;

/** Why a PLAN text may not be published as written, or null. */
const unpublishable = (text: string): string | null => {
  if (INTERNAL_ID.test(text)) return "an internal ACP id";
  const remote = text.replace(HOSTED_URL, " ");
  if (FILE_URL.test(remote) || LOCAL_PATH.test(remote.replace(URL_AUTHORITY, " "))) return "a local filesystem path";
  try {
    screenPublicText(text);
  } catch {
    return "credential-shaped content";
  }
  return null;
};

/** The non-identifying marker of ACP's own create, recognised again after a lost answer. */
/** An issue intent's public token: the truncated SHA-256 of its random id, nothing else. */
const intentMarker = (intent: string): string => `<!-- acp:${createHash("sha256").update(intent).digest("hex").slice(0, 16)} -->`;
/**
 * A 4xx other than 408, answering the intent's own POST (`issues`, the route it was admitted for), is GitHub's
 * answer that the request was refused, so nothing was created. Another request's 4xx proves nothing about it.
 */
const definitelyNotCreated = (error: unknown, issues: string): number | null => {
  if (!isAcpError(error) || requestOutcomeUnknown(error)) return null;
  const { status, method, path } = error.evidence as { status?: unknown; method?: unknown; path?: unknown };
  if (method !== "POST" || path !== issues) return null;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 ? status : null;
};
/** `listedThrough`: the highest issue number the readback before its POST listed (#1364, investigation only). */
interface IssueIntent { intent: string; unit: string; taskIds: string[]; marker: string; eventId: number; listedThrough?: number }
interface CreatedIssue { intent?: string; unit: string; taskIds: string[]; marker: string; issueNumber: number; nodeId: string }
type CreatedKey = { intent?: string; unit?: string; titleDigest?: string; taskIds?: string[]; marker?: string; possibleDuplicateOf?: number[] };
/** #1364 — an existing issue the run's owner adopted for an UNKNOWN intent's tasks. */
interface Adoption { intent: string; taskIds: string[]; issueNumber: number; issueNodeId: string }
/** The issue POST about to be sent, before the guard records its intent. */
type Outbound = Omit<IssueIntent, "eventId"> & { title: string; text: string; recorded: boolean };
const ADOPTED_EXISTING = "ADOPTED_EXISTING";

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
  runs: Pick<RunEngine, "get" | "repositoriesOf" | "assertOwner">;
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
    // #1239 — the tasks this PLAN supersedes are cancelled with it: they stay live in no unit.
    const superseded = new Set(Array.isArray(plan["supersedesTaskIds"]) ? (plan["supersedesTaskIds"] as unknown[]).filter((id): id is string => typeof id === "string") : []);
    // #1240 reviews R6/R7 — a create whose outcome is unknown may still land for a task this PLAN would cancel;
    // its replacement would then get a second issue. Refused until the intent resolves: its own token found and
    // linked, or a definite 4xx retiring it. No exception: adopting an issue for other work is unaffected.
    // #1364 — a task whose unknown create the owner settled by adopting an existing issue is no longer held.
    const adoptions = this.#adoptions(runId);
    const held = (intent: IssueIntent, taskId: string): boolean =>
      superseded.has(taskId) && !adoptions.some((a) => a.intent === intent.intent && a.taskIds.includes(taskId));
    const unsettled = this.#unknownIntents(runId).filter((intent) => intent.taskIds.some((taskId) => held(intent, taskId)));
    if (unsettled.length > 0) {
      const ended = this.#endedByCeo(runId, unsettled);
      return deny(ReasonCode.WORK_SCOPE_NOT_TRACKED_ON_GITHUB, "this PLAN supersedes a task whose issue create has an unknown outcome and may still land", {
        refusal: "WORK_SCOPE_CREATION_UNRESOLVED", retryable: ended.length < unsettled.length, runId,
        intents: unsettled.map((intent) => intent.intent),
        originalOutcome: "UNKNOWN",
        ...(ended.length > 0 ? { dispositions: ended } : {}),
        tasks: [...new Set(unsettled.flatMap((intent) => intent.taskIds.filter((taskId) => held(intent, taskId))))],
        correction: "admit the work again once GitHub has answered (ACP links the issue when its token appears), or adopt an existing issue by number for the task, then supersede it",
      });
    }
    const live = this.#live(runId).map((task) => task.taskId).filter((taskId) => !superseded.has(taskId));
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
    // Each published field on its own: a whole-value shape (a bare key) is only seen in the field it fills.
    const texts = units.flatMap((unit) => [
      ...("new" in unit.issue ? [{ unit: unit.key, field: "issue title", text: unit.issue.new.title }, { unit: unit.key, field: "issue body", text: unit.issue.new.body }] : []),
      ...("new" in unit.milestone ? [{ unit: unit.key, field: "milestone title", text: unit.milestone.new.title }, { unit: unit.key, field: "milestone description", text: unit.milestone.new.description }] : []),
    ]);
    const leaks = texts.flatMap(({ unit, field, text }) => {
      const why = unpublishable(text);
      return why === null ? [] : [{ unit, field, carries: why }];
    });
    if (leaks.length > 0) return invalid("WORK_UNITS_TEXT_NOT_PUBLIC", "a new issue or milestone's text carries what may not be published", { leaks });
    return allow(ReasonCode.OK, { units });
  }

  /**
   * #1240 reviews R6/R9 — an identical resend of the run's CURRENT work-unit PLAN (the same content as stored,
   * its submission sequence aside, and the same tasks) always answers the tasks its accepted submission
   * created, and creates nothing. Only the current PLAN counts, so A, B, A is still three submissions. After
   * an owner takeover its approval is recorded again for the new owner, over the same PLAN and task mapping.
   */
  replay(runId: string, stored: Record<string, unknown>, tasks: readonly unknown[], owner: { sessionId: string; bindingGeneration: number }): TaskRecord[] | null {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return null;
    const current = this.ports.artifacts.latest<Record<string, unknown>>(runId, ArtifactKind.PLAN);
    const scope = this.#scope(runId);
    if (current === null || scope === null || scope.tasksDigest === undefined || scope.submittedTaskIds === undefined) return null;
    const { submission: _submission, ...content } = current.content;
    if (canonicalJson(content) !== canonicalJson(stored) || scope.tasksDigest !== digestOf(tasks)) return null;
    const byId = new Map(this.ports.tasks.list(runId).map((task) => [task.taskId, task] as const));
    const replayed = scope.submittedTaskIds.map((taskId) => byId.get(taskId));
    if (!replayed.every((task) => task !== undefined)) return null;
    // An approval its run's current owner no longer holds (ACP's own owner check) is recorded again for the
    // caller, who passed the owner fence: the same PLAN and the same task mapping, nothing re-validated.
    if (scope.sessionId === null || !this.ports.runs.assertOwner(runId, scope.sessionId, scope.bindingGeneration).allowed) {
      const recorded = this.ports.audit.record({
        kind: WORK_SCOPE_APPROVED,
        runId,
        projectId: this.ports.runs.get(runId)?.projectId ?? null,
        sessionId: owner.sessionId,
        evidence: { planDigest: scope.planDigest, bindingGeneration: owner.bindingGeneration, units: scope.units, tasksDigest: scope.tasksDigest, submittedTaskIds: scope.submittedTaskIds },
      });
      if (!recorded.allowed) return null;
    }
    return replayed as TaskRecord[];
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
      evidence: { planDigest, bindingGeneration: owner.bindingGeneration, units, tasksDigest: digestOf(submitted), submittedTaskIds: created.map((task) => task.taskId) },
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

  /**
   * #1345 — read-only: the issues the run's current approved scope holds verified, on the governed repository
   * they belong to, so the run's merged pull request can close them. `null` for a run that is not governed,
   * or whose repository is unresolved (CONFIRM refuses that one).
   */
  trackedIssues(runId: string): { repositoryIdentity: string; issues: number[] } | null {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return null;
    const status = this.#status(runId, governed.value);
    const issues = [...new Set([...status.tracked.values()].map((unit) => unit.issueNumber))].sort((a, b) => a - b);
    return { repositoryIdentity: governed.value.repositoryIdentity, issues };
  }

  /**
   * #1368 — read-only: the key of the unit of the run's current approved scope that holds `taskId`, or
   * `null` for a run that is not governed, has no approval of its current PLAN, or maps the task to no unit.
   */
  unitOf(runId: string, taskId: string): string | null {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return null;
    return this.#scope(runId)?.units.find((unit) => unit.taskIds.includes(taskId))?.unit ?? null;
  }

  async #ensureNow(runId: string, taskId: string | undefined): Promise<Decision<TrackedUnit | { units: TrackedUnit[] } | null>> {
    const governed = this.#governed(runId);
    if (!governed.allowed || governed.value === null) return governed as Decision<null>;
    let status = this.#status(runId, governed.value);
    if (taskId !== undefined && !status.unitOf.has(taskId)) return this.#refused(runId, governed.value, status, { taskId, correction: SHAPE });
    // #1364 — with nothing to synchronize, a create whose outcome is unknown is read for its token first. The read
    // awaits GitHub, so nothing read before it decides anything: the status is read again after it, and a scope
    // that changed meanwhile is checked, and synchronized, as it now stands.
    if (!this.#synchronizes(status, taskId)) {
      await this.#readLateCreates(runId, governed.value);
      status = this.#status(runId, governed.value);
    }
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
    const adoptedBefore = new Map(this.#trackedRecords(runId, governed).filter((unit) => unit.adopted).map((unit) => [unit.unit, unit.issueNumber] as const));
    // The issues that already track each task's work, verified or created, under whatever unit key it had;
    // read once the pending creates are resolved, so an issue whose answer was lost is among them.
    const trackedByTask = new Map<string, Set<number>>();
    let created = new Map<string, { number: number; nodeId: string }>();
    let createdIssues: CreatedIssue[] = [];
    // The tasks an intent with an unknown outcome still covers: no new issue is created for them.
    const unresolvedByTask = new Map<string, IssueIntent[]>();
    const known = (): void => {
      created = this.#created(runId);
      createdIssues = this.#createdIssues(runId);
      trackedByTask.clear();
      for (const link of [...this.#trackedRecords(runId, governed), ...createdIssues]) {
        for (const taskId of link.taskIds ?? []) trackedByTask.set(taskId, (trackedByTask.get(taskId) ?? new Set()).add(link.issueNumber));
      }
      unresolvedByTask.clear();
      for (const intent of this.#unknownIntents(runId)) {
        for (const taskId of intent.taskIds) unresolvedByTask.set(taskId, [...(unresolvedByTask.get(taskId) ?? []), intent]);
      }
    };
    // The issue POST about to be sent: the guard admits exactly it, and records its intent as it does.
    const outbound: { current: Outbound | null } = { current: null };
    const unmet: UnmetWork[] = [];
    // The only milestone bodies a POST may carry: exactly the PLAN's new milestones, with their markers.
    const planned: Array<{ path: "milestones" | "issues"; title: string; text: string }> = [];
    for (const approved of pending) {
      const declared = declarations.get(approved.unit);
      if (declared === undefined) continue;
      if ("new" in declared.milestone) planned.push({ path: "milestones", title: declared.milestone.new.title, text: withMarker(declared.milestone.new.description, createdMarker(runId, "milestone", declared.milestone.new.title.trim().toLowerCase())) });
    }
    const resolved = new Map<string, { milestoneNumber: number; issueNumber: number; adopted: boolean }>();
    // #1365 — what this synchronization records as created, by number: the node id each create recorded.
    const createdNow = { issue: new Map<number, string>(), milestone: new Map<number, string>() };
    const recordCreated = (resource: "issue" | "milestone", key: CreatedKey, answered: { number: number; nodeId: string }): void => {
      this.#recordCreated(runId, resource, key, answered);
      createdNow[resource].set(answered.number, answered.nodeId);
    };
    let readback: { milestones: WorkMilestone[]; issues: WorkIssue[] };
    try {
      readback = await runUnderWriteGuard(this.#guard(runId, target, status.scope!, planned, outbound), async () => {
        const resources = await github.observeWorkResources!(target, repositoryNodeId);
        // First, every create with an unknown outcome, found by its own token.
        this.#recordTokenMatches(runId, resources.issues, (key, found) => recordCreated("issue", key, found));
        known();
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
              recordCreated("milestone", { titleDigest: titleDigestOf(title) }, milestone);
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
            // ACP's own earlier create for this unit: the same key, covering some of the same tasks, or tasks that
            // were all cancelled since (a re-plan replaced them). It stands only while its text is the PLAN's.
            const cancelled = new Set(this.ports.tasks.list(runId).filter((task) => task.state === TaskState.CANCELLED).map((task) => task.taskId));
            const own = [...createdIssues].reverse().find((c) => c.unit === approved.unit
              && (c.taskIds.some((t) => approved.taskIds.includes(t)) || c.taskIds.every((t) => cancelled.has(t)))
              && resources.issues.some((i) => i.number === c.issueNumber && i.nodeId === c.nodeId));
            issue = own === undefined ? undefined : resources.issues.find((i) => i.number === own.issueNumber && i.nodeId === own.nodeId);
            // ACP's own earlier create stands for this unit only while it reads as the PLAN now declares it.
            if (issue !== undefined && (issue.title !== title || !sameText(issue.body, withMarker(body, own!.marker)))) {
              unmet.push({ unit: approved.unit, unmet: "ISSUE_TEXT_DIFFERS", issues: [issue.number], correction: `issue #${issue.number}, created for this unit, does not read as the PLAN now declares it; adopt it by number, or declare it as it reads` });
              continue;
            }
            if (issue === undefined) {
              const before = adoptedBefore.get(approved.unit);
              if (before !== undefined) {
                unmet.push({ unit: approved.unit, unmet: "DUPLICATE_OF_ADOPTED", issues: [before], correction: `this unit was linked to existing issue #${before}; keep adopting it rather than creating a duplicate` });
                continue;
              }
              // Renaming a unit does not make its tasks' work new: a task an issue already tracks is adopted.
              const tracked = approved.taskIds.flatMap((taskId) => [...(trackedByTask.get(taskId) ?? [])].map((n) => [taskId, n] as const));
              if (tracked.length > 0) {
                const [taskId, number] = tracked[0]!;
                unmet.push({ unit: approved.unit, unmet: "TASK_ALREADY_TRACKED", issues: [...new Set(tracked.map(([, n]) => n))], correction: `task ${taskId} is already tracked by #${number}; adopt it by number` });
                continue;
              }
              // A create whose outcome is unknown may still land: nothing is sent again for its tasks.
              const unsettled = approved.taskIds.flatMap((taskId) => (unresolvedByTask.get(taskId) ?? []).map((intent) => [taskId, intent] as const));
              if (unsettled.length > 0) {
                const [taskId, intent] = unsettled[0]!;
                const intents = [...new Map(unsettled.map(([, i]) => [i.intent, i] as const)).values()];
                // #1364 — the CEO's end of the wait makes it no longer retryable; the outcome stays unknown.
                const ended = this.#endedByCeo(runId, intents);
                const waiting = ended.length < intents.length;
                unmet.push({
                  unit: approved.unit, unmet: "WORK_SCOPE_CREATION_UNRESOLVED", intents: intents.map((i) => i.intent), originalOutcome: "UNKNOWN",
                  ...(ended.length > 0 ? { dispositions: ended } : {}),
                  retryable: waiting,
                  correction: waiting
                    ? `an earlier issue create for task ${taskId} (intent ${intent.intent}) has an unknown outcome and may still land; ACP links it when it appears, and creates nothing for that task until then. Retry later, adopt an existing issue by number, or escalate (escalation_open): the CEO may cancel the run`
                    : `the CEO ended the wait on the earlier issue create for task ${taskId} (intent ${intent.intent}); its outcome stays unknown and ACP sends nothing again for that task. Adopt an existing issue by number`,
                });
                continue;
              }
              const clash = resources.issues.find((i) => sameTitle(i.title, title));
              if (clash !== undefined) {
                unmet.push({ unit: approved.unit, unmet: "ISSUE_EXISTS", issues: [clash.number], correction: `issue #${clash.number} already has this title; adopt it by number rather than create a duplicate` });
                continue;
              }
              // A new intent, with its own token; the guard records it the moment it admits the POST.
              const intent = `wsi_${randomUUID().replace(/-/g, "")}`;
              const marker = intentMarker(intent);
              const listedThrough = resources.issues.reduce((highest, i) => Math.max(highest, i.number), 0);
              outbound.current = { intent, unit: approved.unit, taskIds: approved.taskIds, marker, listedThrough, title, text: withMarker(body, marker), recorded: false };
              try {
                issue = await github.createWorkIssue!(target, repositoryNodeId, { title, body: withMarker(body, marker), milestone: milestone.number });
              } catch (error) {
                const sent = outbound.current.recorded;
                outbound.current = null;
                const status = definitelyNotCreated(error, `repos/${target.owner}/${target.name}/issues`);
                if (sent && status !== null) this.ports.audit.record({ kind: WORK_SCOPE_GITHUB_INTENT_RETIRED, runId, projectId: this.ports.runs.get(runId)?.projectId ?? null, evidence: { intent, outcome: "DEFINITE_NOT_CREATED", status } });
                throw error;
              }
              outbound.current = null;
              recordCreated("issue", { intent, unit: approved.unit, taskIds: approved.taskIds, marker }, issue);
              createdIssues.push({ intent, unit: approved.unit, taskIds: approved.taskIds, marker, issueNumber: issue.number, nodeId: issue.nodeId });
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
    // #1365 — GitHub's list can lag right after a create: an item this synchronization created that the listing
    // lacks is read by its number, and stands only at the node id its create recorded. A 404, another node id,
    // or a failed or unreadable read leaves it missing.
    const read = async <T extends { number: number; nodeId: string }>(listed: T[], number: number, recorded: Map<number, string>, get: ((number: number) => Promise<T | null>) | undefined): Promise<T | undefined> => {
      const found = listed.find((item) => item.number === number);
      const nodeId = recorded.get(number);
      if (found !== undefined || nodeId === undefined || get === undefined) return found;
      let fetched: unknown;
      try {
        fetched = await get(number);
      } catch {
        return undefined;
      }
      if (!isRecord(fetched) || fetched["nodeId"] !== nodeId) return undefined;
      listed.push(fetched as T);
      return fetched as T;
    };
    const verified: TrackedUnit[] = [];
    for (const [unit, link] of resolved) {
      const approved = pending.find((p) => p.unit === unit)!;
      const issue = await read(readback.issues, link.issueNumber, createdNow.issue, github.observeWorkIssue && ((n) => github.observeWorkIssue!(target, repositoryNodeId, n)));
      const milestone = issue === undefined ? undefined : await read(readback.milestones, link.milestoneNumber, createdNow.milestone, github.observeWorkMilestone && ((n) => github.observeWorkMilestone!(target, repositoryNodeId, n)));
      if (issue === undefined) unmet.push({ unit, unmet: "ISSUE_NOT_FOUND", issues: [link.issueNumber], correction: `#${link.issueNumber} is no longer an issue of ${governed.repositoryIdentity}` });
      else if (milestone === undefined) unmet.push({ unit, unmet: "MILESTONE_NOT_FOUND", milestones: [link.milestoneNumber], correction: `milestone #${link.milestoneNumber} is no longer a milestone of ${governed.repositoryIdentity}` });
      else if (claimed.get(issue.number) !== unit) unmet.push({ unit, unmet: "CATCH_ALL_ISSUE", issues: [issue.number], correction: `issue #${issue.number} already stands for unit ${claimed.get(issue.number)}; give this unit its own issue` });
      else if (issue.milestone === null) unmet.push({ unit, unmet: "MILESTONE_LINK_MISSING", issues: [issue.number], milestones: [milestone.number], correction: `link issue #${issue.number} to milestone #${milestone.number}, or declare the milestone it is in` });
      else if (issue.milestone.nodeId !== milestone.nodeId) unmet.push({ unit, unmet: "MILESTONE_LINK_WRONG", issues: [issue.number], milestones: [milestone.number, issue.milestone.number], correction: `issue #${issue.number} is in milestone #${issue.milestone.number}, not #${milestone.number}; move it, or declare the milestone it is in` });
      else {
        const refused = link.adopted ? this.#recordAdoption(runId, governed, status.scope!, approved, issue, readback.issues) : null;
        if (refused !== null) unmet.push(refused);
        else verified.push({ unit, declarationDigest: approved.declarationDigest, scopeDigest: scopeDigestOf(approved), taskIds: approved.taskIds, approvalEventId: status.scope!.eventId, issueNumber: issue.number, issueNodeId: issue.nodeId, milestoneNumber: milestone.number, milestoneNodeId: milestone.nodeId, adopted: link.adopted });
      }
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

  /** Whether an ensure (for `taskId`, or the whole scope) synchronizes: its unit, or some live unit, is not verified. */
  #synchronizes(status: Status, taskId: string | undefined): boolean {
    if (status.scope === null) return false;
    const unit = taskId === undefined ? undefined : status.unitOf.get(taskId);
    if (taskId !== undefined && (unit === undefined || status.tracked.has(unit.unit))) return false;
    return status.live.some((live) => !status.tracked.has(live.unit));
  }

  /**
   * Every create with an unknown outcome: found by its own token on exactly one issue, it is ACP's issue for the
   * tasks it covered, whatever unit key they have now; not found, or found on several, it stays unknown.
   * #1364 — found after the owner adopted another issue for it, it is recorded all the same, flagged as a
   * possible duplicate of the adopted one; nothing is closed or merged.
   */
  #recordTokenMatches(runId: string, issues: readonly WorkIssue[], record: (key: CreatedKey, found: WorkIssue) => void): void {
    const adoptions = this.#adoptions(runId);
    for (const intent of this.#unknownIntents(runId)) {
      const carrying = issues.filter((i) => i.body.includes(intent.marker));
      if (carrying.length !== 1) continue;
      const found = carrying[0]!;
      const adopted = [...new Set(adoptions.filter((a) => a.intent === intent.intent).map((a) => a.issueNumber))];
      const duplicate = adopted.length > 0 && !adopted.includes(found.number) ? { possibleDuplicateOf: adopted } : {};
      record({ intent: intent.intent, unit: intent.unit, taskIds: intent.taskIds, marker: intent.marker, ...duplicate }, found);
    }
  }

  /**
   * #1364 — while a create of the run has an unknown outcome (adopted past or not), an ensure that synchronizes
   * nothing still reads the repository for its token, so a late result is recorded as CREATED on the calls that
   * already happen, with no timer or loop of its own. Read only: a failed read changes and refuses nothing.
   */
  async #readLateCreates(runId: string, governed: Governed): Promise<void> {
    const { github } = this.ports;
    if (!github.observeWorkResources || this.#unknownIntents(runId).length === 0) return;
    let issues: WorkIssue[];
    try {
      issues = (await github.observeWorkResources(governed.target, governed.repositoryNodeId)).issues;
    } catch {
      return;
    }
    this.#recordTokenMatches(runId, issues, (key, found) => this.#recordCreated(runId, "issue", key, found));
  }

  /**
   * #1364 — a verified adoption of `issue` for tasks a create with an unknown outcome still covers is how the run
   * proceeds past it (ADOPTED_EXISTING), and it is the run's current owner's decision: the approval adopting it
   * must still pass ACP's owner check, or the unit is refused. Recorded once per intent, issue and task set, with
   * the readback's listing as investigation evidence that moves no outcome. `null` when the unit may be verified.
   */
  #recordAdoption(runId: string, governed: Governed, scope: ApprovedScope, approved: ApprovedUnit, issue: WorkIssue, listed: readonly WorkIssue[]): UnmetWork | null {
    const adoptions = this.#adoptions(runId);
    const covered = this.#unknownIntents(runId)
      .map((intent) => ({ intent, taskIds: intent.taskIds.filter((taskId) => approved.taskIds.includes(taskId)) }))
      .filter(({ intent, taskIds }) => taskIds.length > 0
        && !adoptions.some((a) => a.intent === intent.intent && a.issueNodeId === issue.nodeId && taskIds.every((taskId) => a.taskIds.includes(taskId))));
    if (covered.length === 0) return null;
    const owner = scope.sessionId === null ? null : this.ports.runs.assertOwner(runId, scope.sessionId, scope.bindingGeneration);
    if (owner === null || !owner.allowed) {
      return {
        unit: approved.unit, unmet: "WORK_SCOPE_CREATION_UNRESOLVED", intents: covered.map(({ intent }) => intent.intent), issues: [issue.number],
        originalOutcome: "UNKNOWN", refusal: "WORK_SCOPE_APPROVAL_NOT_CURRENT_OWNER", retryable: false,
        correction: `adopting #${issue.number} for tasks whose earlier issue create has an unknown outcome is the run's current owner's decision, and the PLAN adopting it was approved by an owner ACP no longer admits as current; its current owner submits it again`,
      };
    }
    const ordered = [...listed].sort((a, b) => a.number - b.number);
    const listingDigest = digestOf(ordered.map((i) => [i.number, i.nodeId]));
    const throughIssue = ordered.at(-1)?.number ?? 0;
    for (const { intent, taskIds } of covered) {
      // What the readback showed after the intent's POST: the issues above the highest one listed before it that
      // carry no other ACP token. Investigation evidence only.
      const afterIssue = intent.listedThrough ?? null;
      const candidates = afterIssue === null ? null : ordered
        .filter((i) => i.number > afterIssue && (i.body.includes(intent.marker) || !/<!-- acp(?::|-genesis:)/.test(i.body)))
        .map((i) => i.number);
      this.ports.audit.record({
        kind: WORK_SCOPE_GITHUB_INTENT_RETIRED,
        runId,
        projectId: this.ports.runs.get(runId)?.projectId ?? null,
        sessionId: scope.sessionId,
        evidence: {
          intent: intent.intent, disposition: ADOPTED_EXISTING, originalOutcome: "UNKNOWN", unit: approved.unit, taskIds,
          repositoryIdentity: governed.repositoryIdentity, repositoryNodeId: governed.repositoryNodeId, issueNumber: issue.number, issueNodeId: issue.nodeId,
          approvalEventId: scope.eventId, bindingGeneration: scope.bindingGeneration,
          investigation: { listingDigest, issuesListed: ordered.length, window: { afterIssue, throughIssue }, candidates },
        },
      });
    }
    return null;
  }

  /**
   * The only GitHub writes a synchronization makes: a POST of exactly one planned new milestone or
   * issue to the exact repository, while the run is live, its approval is its current owner's, and the
   * PLAN it serves is still the run's current one.
   */
  #guard(
    runId: string,
    target: GitHubRepositoryTarget,
    scope: ApprovedScope,
    planned: ReadonlyArray<{ path: string; title: string; text: string }>,
    outbound: { current: Outbound | null },
  ): BootstrapWriteGuard {
    const root = `repos/${target.owner}/${target.name}`;
    return {
      beforeRequest: (request) => {
        const body = isRecord(request.body) ? request.body : {};
        const path = request.target === `${root}/milestones` ? "milestones" : request.target === `${root}/issues` ? "issues" : null;
        const text = path === "milestones" ? body["description"] : body["body"];
        const sending = outbound.current;
        const exact = path === "issues"
          ? sending !== null && !sending.recorded && sending.title === body["title"] && sending.text === text
          : planned.some((p) => p.path === path && p.title === body["title"] && p.text === text);
        if (request.kind !== "api" || request.method !== "POST" || path === null || !exact || (path === "issues" && typeof body["milestone"] !== "number")) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "a work-scope synchronization writes only the PLAN's own new milestones and issues", { request: { kind: request.kind, method: request.method, target: request.target } });
        }
        // The same rule plan acceptance and the task graph apply: a sealed or ended run takes no new work.
        const run = this.ports.runs.get(runId);
        if (!run || run.kind !== RunKind.STANDARD_WORK || CLOSED_TO_NEW_TASKS.has(run.state)) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the run no longer admits work", { runId, state: run?.state ?? null });
        }
        // ACP's own owner authority, the one its MCP fence ends in (`RunEngine.assertOwner`): the approval's
        // owner is still the run's pinned owner and holds its role's active binding at that generation.
        const owner = scope.sessionId === null
          ? deny(ReasonCode.RUN_OWNER_NOT_PINNED, "the approval names no owner session", { runId })
          : this.ports.runs.assertOwner(runId, scope.sessionId, scope.bindingGeneration);
        if (!owner.allowed) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the PLAN's work units were approved by an owner ACP no longer admits as the run's current one; its current owner submits them again before anything is created", {
            refusal: "WORK_SCOPE_APPROVAL_NOT_CURRENT_OWNER", runId, ownerRefusal: owner.reasonCode,
          });
        }
        // A PLAN accepted while this synchronization waited on GitHub supersedes the one it serves.
        const current = this.#scope(runId);
        if (current === null || current.planDigest !== scope.planDigest || digestOf(current.units) !== digestOf(scope.units)) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "the PLAN this synchronization serves is no longer the run's current one; nothing of it is created", {
            refusal: "WORK_SCOPE_PLAN_SUPERSEDED", runId, planDigest: scope.planDigest, currentPlanDigest: current?.planDigest ?? null,
          });
        }
        // Admitted: from here on GitHub may create it, so its intent is durable before the request starts.
        if (path === "issues" && sending !== null) {
          this.ports.audit.record({ kind: WORK_SCOPE_GITHUB_CREATING, runId, projectId: run.projectId, evidence: { resource: "issue", intent: sending.intent, unit: sending.unit, taskIds: sending.taskIds, marker: sending.marker, ...(sending.listedThrough === undefined ? {} : { listedThrough: sending.listedThrough }) } });
          sending.recorded = true;
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
    // Only a unit's latest verification counts, and only if its scope (link and tasks) is the same in
    // every approval from the one it was made for to the current one: any change in between makes it stale.
    const latest = new Map<string, TrackedUnit>();
    for (const record of this.#trackedRecords(runId, governed)) latest.set(record.unit, record);
    const approvals = scope === null ? [] : this.#approvals(runId).filter((approval) => approval.eventId <= scope.eventId);
    const tracked = new Map<string, TrackedUnit>();
    for (const unit of liveUnits) {
      const record = latest.get(unit.unit);
      if (record === undefined || record.approvalEventId === undefined || record.scopeDigest !== scopeDigestOf(unit)) continue;
      const unchanged = approvals
        .filter((approval) => approval.eventId >= record.approvalEventId!)
        .every((approval) => approval.units.some((u) => u.unit === unit.unit && scopeDigestOf(u) === record.scopeDigest));
      if (unchanged) tracked.set(unit.unit, record);
    }
    return { scope, unitOf, unmapped: live.filter((task) => !unitOf.has(task.taskId)), live: liveUnits, tracked };
  }

  #scope(runId: string): ApprovedScope | null {
    const plan = this.ports.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    if (plan === null) return null;
    const row = this.ports.db.get<{ event_id: number; session_id: string | null; evidence_json: string }>(
      `SELECT event_id, session_id, evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id DESC LIMIT 1`,
      [WORK_SCOPE_APPROVED, runId],
    );
    if (!row) return null;
    const evidence = JSON.parse(row.evidence_json) as Partial<ApprovedScope>;
    if (evidence.planDigest !== plan.digest || !Array.isArray(evidence.units) || typeof evidence.bindingGeneration !== "number") return null;
    return {
      eventId: row.event_id, planDigest: evidence.planDigest, sessionId: row.session_id, bindingGeneration: evidence.bindingGeneration, units: evidence.units,
      ...(typeof evidence.tasksDigest === "string" ? { tasksDigest: evidence.tasksDigest } : {}),
      ...(Array.isArray(evidence.submittedTaskIds) ? { submittedTaskIds: evidence.submittedTaskIds } : {}),
    };
  }

  /** Every approval of the run, oldest first, with its units. */
  #approvals(runId: string): Array<{ eventId: number; units: ApprovedUnit[] }> {
    return this.ports.db
      .all<{ event_id: number; evidence_json: string }>(`SELECT event_id, evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`, [WORK_SCOPE_APPROVED, runId])
      .map((row) => ({ eventId: row.event_id, units: (JSON.parse(row.evidence_json) as { units?: ApprovedUnit[] }).units ?? [] }));
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

  #rows(kind: string, runId: string): Array<Record<string, unknown>> {
    return this.#events(kind, runId).map((row) => row.evidence);
  }

  #events(kind: string, runId: string): Array<{ eventId: number; evidence: Record<string, unknown> }> {
    return this.ports.db
      .all<{ event_id: number; evidence_json: string }>(`SELECT event_id, evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`, [kind, runId])
      .map((row) => ({ eventId: row.event_id, evidence: JSON.parse(row.evidence_json) as Record<string, unknown> }));
  }

  /** #1364 — every existing issue the run's owner adopted for an unknown create's tasks (ADOPTED_EXISTING). */
  #adoptions(runId: string): Adoption[] {
    return this.#rows(WORK_SCOPE_GITHUB_INTENT_RETIRED, runId).flatMap((e) =>
      e["disposition"] === ADOPTED_EXISTING && typeof e["intent"] === "string" && Array.isArray(e["taskIds"]) && typeof e["issueNumber"] === "number" && typeof e["issueNodeId"] === "string"
        ? [{ intent: e["intent"], taskIds: e["taskIds"] as string[], issueNumber: e["issueNumber"], issueNodeId: e["issueNodeId"] }]
        : []);
  }

  /**
   * #1364 — the intents among `intents` whose wait the CEO ended (ENDED_BY_CEO): an escalation the run's owner
   * opened after the intent, and a CEO FINAL_REVISE of the run after that escalation. An `escalation_resolve` is not
   * one: its answer is free text, which may say to keep waiting. A run held BLOCKED on an unresolved create is
   * ended by the CEO's cancel. Read only; it moves no outcome and opens no new create.
   */
  #endedByCeo(runId: string, intents: readonly IssueIntent[]): CeoEnd[] {
    return intents.flatMap((intent) => {
      const escalation = this.ports.db.get<{ event_id: number }>(
        `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CTO_ESCALATION' AND event_id > ? ORDER BY event_id LIMIT 1`,
        [runId, intent.eventId],
      );
      const decision = escalation === undefined ? undefined : this.ports.db.get<{ event_id: number }>(
        `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION' AND event_id > ?
           AND json_extract(evidence_json, '$.decision') = 'FINAL_REVISE' ORDER BY event_id LIMIT 1`,
        [runId, escalation.event_id],
      );
      return escalation === undefined || decision === undefined
        ? []
        : [{ intent: intent.intent, disposition: "ENDED_BY_CEO" as const, escalationId: escalation.event_id, decisionEventId: decision.event_id }];
    });
  }

  /** Every issue ACP created for the run, answered or found by its intent's token, with the tasks it covered. */
  #createdIssues(runId: string): CreatedIssue[] {
    return this.#rows(WORK_SCOPE_GITHUB_CREATED, runId).flatMap((e) =>
      e["resource"] === "issue" && typeof e["number"] === "number" && typeof e["nodeId"] === "string" && typeof e["unit"] === "string" && typeof e["marker"] === "string" && Array.isArray(e["taskIds"])
        ? [{ ...(typeof e["intent"] === "string" ? { intent: e["intent"] } : {}), unit: e["unit"], taskIds: e["taskIds"] as string[], marker: e["marker"], issueNumber: e["number"], nodeId: e["nodeId"] }]
        : []);
  }

  /**
   * Issue intents neither created (by their own token) nor retired as definitely not created: their original
   * outcome is unknown, and they are kept. A disposition (#1364) does not settle one.
   */
  #unknownIntents(runId: string): IssueIntent[] {
    const retired = this.#rows(WORK_SCOPE_GITHUB_INTENT_RETIRED, runId).filter((e) => e["outcome"] === "DEFINITE_NOT_CREATED");
    const settled = new Set([...this.#rows(WORK_SCOPE_GITHUB_CREATED, runId), ...retired].map((e) => e["intent"]).filter((i) => typeof i === "string"));
    return this.#events(WORK_SCOPE_GITHUB_CREATING, runId).flatMap(({ eventId, evidence: e }) =>
      e["resource"] === "issue" && typeof e["intent"] === "string" && typeof e["unit"] === "string" && typeof e["marker"] === "string" && Array.isArray(e["taskIds"]) && !settled.has(e["intent"])
        ? [{ intent: e["intent"], unit: e["unit"], taskIds: e["taskIds"] as string[], marker: e["marker"], eventId, ...(typeof e["listedThrough"] === "number" ? { listedThrough: e["listedThrough"] } : {}) }]
        : []);
  }

  #recordCreated(runId: string, resource: "issue" | "milestone", key: CreatedKey, answered: { number: number; nodeId: string }): void {
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
