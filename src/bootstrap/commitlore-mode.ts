import type { Db } from "../db/database.ts";

/*
 * #1268 — the CommitLore rule, in a module that imports nothing at runtime, so any module may ask it
 * without joining an import cycle (the GitHub kernel asks it; `commitlore-observation.ts` re-exports it).
 *
 * CommitLore is used for every commit the control plane makes in a managed project. A manifest's
 * `commitlore.mode` is still parsed, so a manifest stored with `preferred` or `off` stays readable under its
 * digest, and it means nothing: the one lenient reading ever shipped (`preferred`) was on every stored manifest,
 * and so no run of any project was governed. Raising each stored manifest to `required` by a contract change was decided against, instead of ignoring the field: a manifest would stay one stored value away from not using CommitLore.
 */

/**
 * #1268 — the CommitLore mode a run is held to: `required` for any run that pins a manifest, whatever the
 * manifest says about CommitLore or fails to say (an old manifest, an unsupported value, one that cannot be
 * read). Null for a run with no pinned manifest, which belongs to no managed project and has no contract that
 * asks for CommitLore.
 */
export const commitloreRunMode = (db: Db, runId: string): "required" | null => {
  const run = db.get<{ pinned_manifest_digest: string | null }>(`SELECT pinned_manifest_digest FROM runs WHERE run_id = ?`, [runId]);
  return run?.pinned_manifest_digest ? "required" : null;
};

/** #1268 — whether the control plane commits through CommitLore for a run: it pins a manifest (`commitloreRunMode`). */
export const commitloreGoverned = (db: Db, runId: string): boolean => commitloreRunMode(db, runId) === "required";

/**
 * GAP 1 — the field of a task's PLAN spec that requires a CommitLore capture of that task alone, whatever its run's
 * mode. Its one accepted value is `{ capture: "required" }`.
 */
export const TASK_COMMITLORE_FIELD = "commitlore";

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * GAP 1 — why a task's spec cannot be registered with the CommitLore setting it carries; null when it carries none,
 * or exactly `{ capture: "required" }`. Fail closed: any other value of the field (a string, an unknown or weaker
 * capture, another key beside it) is refused at registration, never dropped.
 */
export const taskCommitloreProblem = (spec: unknown): string | null => {
  if (!isPlainRecord(spec) || !Object.hasOwn(spec, TASK_COMMITLORE_FIELD)) return null;
  const value = spec[TASK_COMMITLORE_FIELD];
  if (isPlainRecord(value) && Object.keys(value).length === 1 && value["capture"] === "required") return null;
  return `spec.${TASK_COMMITLORE_FIELD} is ${JSON.stringify(value) ?? String(value)}; the only accepted value is {"capture":"required"}`;
};

/**
 * GAP 1 — whether a task's registered spec requires a CommitLore capture of it. Fail closed: registration admits only
 * `{ capture: "required" }`, so a spec that carries the field at all is held to it, whatever the value says.
 */
export const taskCaptureRequired = (spec: unknown): boolean => isPlainRecord(spec) && Object.hasOwn(spec, TASK_COMMITLORE_FIELD);

/**
 * GAP 1 — the CommitLore mode one task's turn is held to: the stricter of its run's (`commitloreRunMode`) and its
 * registered spec's (`taskCaptureRequired`). A task only raises it: a run that requires CommitLore stays required
 * whatever its task says. Read from the task's stored spec, never from anything its worker says; a task whose stored
 * spec cannot be read is held to `required`.
 */
export const commitloreTaskMode = (db: Db, runId: string, taskId: string): "required" | null => {
  const run = commitloreRunMode(db, runId);
  if (run === "required") return run;
  const task = db.get<{ spec_json: string }>(`SELECT spec_json FROM tasks WHERE task_id = ? AND run_id = ?`, [taskId, runId]);
  let required: boolean;
  try {
    required = task === undefined || taskCaptureRequired(JSON.parse(task.spec_json) as unknown);
  } catch {
    required = true;
  }
  return required ? "required" : run;
};

/** GAP 1 — whether one task's turn commits through CommitLore (`commitloreTaskMode` is `required`). */
export const commitloreTaskGoverned = (db: Db, runId: string, taskId: string): boolean => commitloreTaskMode(db, runId, taskId) === "required";
