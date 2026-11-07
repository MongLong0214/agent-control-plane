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
