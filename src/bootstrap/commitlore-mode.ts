import type { Db } from "../db/database.ts";

/*
 * #1268 — the CommitLore mode rule, in a module that imports nothing at runtime, so any module may ask it
 * without joining an import cycle (the GitHub kernel asks it; `commitlore-observation.ts` re-exports it).
 */

/**
 * Whether the mode holds the gate shut without a passing observation. Fail closed: only the two lenient
 * values the manifest contract defines are lenient, so an unsupported value is never downgraded.
 */
export const commitloreRequired = (mode: unknown): boolean => mode !== "preferred" && mode !== "off";

/**
 * #1268 — the CommitLore mode a run's pinned manifest names, as `commitloreRequired` reads it: `preferred` and
 * `off` only when the manifest says exactly that, and `required` for any other value and for a pinned manifest
 * that cannot be read. Null for a run with no pinned manifest, which has no contract that asks for CommitLore.
 */
export const commitloreRunMode = (db: Db, runId: string): "required" | "preferred" | "off" | null => {
  const run = db.get<{ pinned_manifest_digest: string | null }>(`SELECT pinned_manifest_digest FROM runs WHERE run_id = ?`, [runId]);
  if (!run?.pinned_manifest_digest) return null;
  const manifest = db.get<{ content_json: string }>(`SELECT content_json FROM manifests WHERE digest = ?`, [run.pinned_manifest_digest]);
  let mode: unknown;
  try {
    mode = manifest ? (JSON.parse(manifest.content_json) as { commitlore?: { mode?: unknown } }).commitlore?.mode : undefined;
  } catch {
    mode = undefined;
  }
  return commitloreRequired(mode) ? "required" : (mode as "preferred" | "off");
};

/**
 * #1268 — whether a run's pinned manifest requires CommitLore of the commits the control plane makes for it.
 * A pinned manifest that cannot be read is held to requiring it; a run with no pinned manifest has no
 * contract that asks for it.
 */
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
export const commitloreTaskMode = (db: Db, runId: string, taskId: string): "required" | "preferred" | "off" | null => {
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
