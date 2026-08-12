import type { Clock } from "../core/clock.ts";
import type { Db } from "../db/database.ts";
import { redact } from "../db/audit.ts";

export type TelemetryScope = "run" | "task" | "quality" | "capacity" | "graph" | "continuity";

export interface MetricInput {
  scope: TelemetryScope;
  name: string;
  runId?: string | null;
  taskId?: string | null;
  value?: number | null;
  text?: string | null;
  dims?: Record<string, unknown>;
}

export interface MetricRow {
  metricId: number;
  at: string;
  scope: TelemetryScope;
  name: string;
  runId: string | null;
  taskId: string | null;
  value: number | null;
  text: string | null;
  dims: Record<string, unknown>;
}

/**
 * B-lite decision-grade telemetry (PRD §31).
 *
 * Stores only what a future routing/graph decision could actually consume. No
 * chain-of-thought, no full prompts, no per-second heartbeat (§31.4). Missing
 * telemetry stays missing — nothing here imputes success (§31.4).
 */
export class Telemetry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(input: MetricInput): void {
    this.db.run(
      `INSERT INTO telemetry_metrics (at, scope, name, run_id, task_id, value_num, value_text, dims_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.clock.nowIso(),
        input.scope,
        input.name,
        input.runId ?? null,
        input.taskId ?? null,
        input.value ?? null,
        input.text ?? null,
        JSON.stringify(redact(input.dims ?? {})),
      ],
    );
  }

  query(scope?: TelemetryScope, name?: string): MetricRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scope) {
      clauses.push("scope = ?");
      params.push(scope);
    }
    if (name) {
      clauses.push("name = ?");
      params.push(name);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .all<RawMetricRow>(`SELECT * FROM telemetry_metrics ${where} ORDER BY metric_id`, params)
      .map((row) => ({
        metricId: row.metric_id,
        at: row.at,
        scope: row.scope,
        name: row.name,
        runId: row.run_id,
        taskId: row.task_id,
        value: row.value_num,
        text: row.value_text,
        dims: JSON.parse(row.dims_json) as Record<string, unknown>,
      }));
  }

  /**
   * §31.4 — a metric that was never collected is reported as MISSING, never as a
   * zero or a pass.
   */
  presence(scope: TelemetryScope, name: string, runId: string): "PRESENT" | "MISSING" {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM telemetry_metrics WHERE scope = ? AND name = ? AND run_id = ?`,
      [scope, name, runId],
    );
    return (row?.n ?? 0) > 0 ? "PRESENT" : "MISSING";
  }
}

interface RawMetricRow {
  metric_id: number;
  at: string;
  scope: TelemetryScope;
  name: string;
  run_id: string | null;
  task_id: string | null;
  value_num: number | null;
  value_text: string | null;
  dims_json: string;
}
