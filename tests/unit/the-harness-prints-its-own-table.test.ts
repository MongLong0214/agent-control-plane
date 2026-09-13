import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runBoundedChild } from "../helpers/bounded-child.ts";

/**
 * #885. The harness owns the row table and would not let anything read it: the 385 inline rows
 * live in a `const GUARDS` literal inside a module that runs the sweep when imported. `--print-rows`
 * is how the owner hands the table over — no parser, no copy, no second authority.
 *
 * The rows below are the three consequences that were measured rather than assumed.
 */
const HARNESS = join(process.cwd(), "scripts/verify-guards-are-falsifiable.mjs");

describe("the harness prints its own table", () => {
  it("emits every row, writes nothing, and exits zero", async () => {
    const { status, stdout } = await runBoundedChild("node", [HARNESS, "--print-rows"], {
      cwd: process.cwd(),
      budgetMs: 120_000,
    });
    expect(status).toBe(0);
    const table = JSON.parse(stdout) as {
      total: number;
      runnable: number;
      rows: Array<{ partitionKey: string; file: string; killedBy: readonly string[]; id?: string }>;
    };
    expect(table.rows.length).toBe(table.total);
    expect(table.total).toBeGreaterThan(600);
    expect(table.runnable).toBeLessThanOrEqual(table.total);

    // The whole point of going through the owner: the count agrees with what the sweep partitions.
    const { stdout: reported } = await runBoundedChild("node", [HARNESS, "--shard-report=1"], {
      cwd: process.cwd(),
      budgetMs: 120_000,
    });
    expect(reported).toContain(`partitioning ${table.total} row(s)`);
  }, 300_000);

  /**
   * `partitionKey` rather than `id`, because 378 of the 385 inline rows carry no `id` — an
   * `id`-keyed consumer would collapse them into one entry and reconcile a table of six against a
   * sweep of six hundred. This is the same content-derived key `assignShards` refuses duplicates
   * on, so uniqueness here is the uniqueness the sweep already requires.
   */
  it("keys every row uniquely, which id could not do", async () => {
    const { stdout } = await runBoundedChild("node", [HARNESS, "--print-rows"], {
      cwd: process.cwd(),
      budgetMs: 120_000,
    });
    const table = JSON.parse(stdout) as { rows: Array<{ partitionKey: string; id?: string }> };
    expect(new Set(table.rows.map((row) => row.partitionKey)).size).toBe(table.rows.length);
    // Not a hypothetical: most rows have no id, so this is why the key exists.
    expect(table.rows.filter((row) => row.id === undefined).length).toBeGreaterThan(300);
  }, 300_000);

  /**
   * The table is ~360KB and the exit is immediate, so the write has to be awaited.
   *
   * Measured both ways, and the first measurement was wrong: with the output redirected to a
   * **file** the unawaited write arrived complete, because a regular fd does not lose what
   * `process.exit` has not drained. Through a **pipe** it delivered exactly 65,536 bytes with a
   * zero status. This row reads through a pipe for that reason — the channel is the thing being
   * measured, not the byte count.
   */
  it("delivers the whole table through a pipe, where an unawaited write would not", async () => {
    const child = spawn("node", [HARNESS, "--print-rows"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const bytes = Buffer.concat(chunks);

    expect(code).toBe(0);
    // 65,536 is the pipe buffer this repository has measured twice; a table that stops there is
    // truncated output reported as success.
    expect(bytes.byteLength).toBeGreaterThan(65_536);
    expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();
  }, 300_000);
});
