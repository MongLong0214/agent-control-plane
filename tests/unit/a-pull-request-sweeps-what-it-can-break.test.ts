import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runBoundedChild } from "../helpers/bounded-child.ts";

/**
 * #885 unit 3. The runner composes three things that are each checked elsewhere — the relation,
 * its reconciliation against the whole table, and the harness's own row list — and adds no
 * judgement of its own. What it does own is the fallback, and that is what these rows measure.
 *
 * Every row here uses `--shard-report`, which runs no mutation: the question is *which rows would
 * be swept*, and answering it by sweeping them would cost an hour and a half per row.
 */
const RUNNER = join(process.cwd(), "scripts/run-affected-falsifiability.mjs");

const run = async (argv: readonly string[]) =>
  runBoundedChild("node", [RUNNER, ...argv], { cwd: process.cwd(), budgetMs: 180_000 });

describe("a pull request sweeps what it can break", () => {
  it("refuses without a base, because 'changed' has nothing to be measured against", async () => {
    const { status, stderr } = await run(["--shard-report=1"]);
    expect(status).toBe(2);
    expect(stderr).toContain("--base=<ref> is required");
  }, 300_000);

  it("sweeps everything when the range cannot be read, and names the range", async () => {
    const { status, stdout } = await run(["--base=no-such-ref-exists", "--shard-report=1"]);
    expect(status).toBe(0);
    expect(stdout).toContain("sweeping every row");
    expect(stdout).toContain("no-such-ref-exists");
    // The full table, not a narrowed one.
    expect(stdout).toMatch(/partitioning \d{3} row\(s\)/);
  }, 300_000);

  /**
   * This branch changes the selector and the harness, so its own run must be a full sweep. That is
   * not a contrived case: it is the rule that a change to how rows are judged puts every row in
   * scope, exercised against the change that introduces the rule.
   */
  it("sweeps everything when the change touches how rows are judged", async () => {
    const { status, stdout } = await run(["--base=origin/main", "--shard-report=4"]);
    expect(status).toBe(0);
    expect(stdout).toContain("sweeping every row");
    expect(stdout).toContain("changes how every row is judged or invoked");
    expect(stdout).toContain("RESULT: PASS");
  }, 300_000);

  /**
   * A narrowed run must still be a partition of what it selected. The harness's shard report was
   * measured reporting 641 rows while `--select-keys` had narrowed the run to 2 — a proof about a
   * different set than the one four jobs were about to split — and this is the row that would
   * catch that returning.
   */
  it("a narrowed run's shards partition the selection, not the whole table", async () => {
    const { stdout: printed } = await runBoundedChild(
      "node",
      [join(process.cwd(), "scripts/verify-guards-are-falsifiable.mjs"), "--print-rows"],
      { cwd: process.cwd(), budgetMs: 120_000 },
    );
    const table = JSON.parse(printed) as { total: number; rows: Array<{ partitionKey: string }> };
    expect(table.total).toBeGreaterThan(600);

    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const keys = join(mkdtempSync(join(tmpdir(), "acp-keys-")), "keys.txt");
    writeFileSync(keys, `${table.rows.slice(0, 3).map((row) => row.partitionKey).join("\n")}\n`);

    const { status, stdout } = await runBoundedChild(
      "node",
      [join(process.cwd(), "scripts/verify-guards-are-falsifiable.mjs"), `--select-keys=${keys}`, "--shard-report=4"],
      { cwd: process.cwd(), budgetMs: 120_000 },
    );
    expect(status).toBe(0);
    expect(stdout).toContain(`partitioning 3 row(s) into 4 shard(s) (selected from ${table.total})`);
    expect(stdout).toContain("union 3 of 3 row(s)");
    expect(stdout).toContain("RESULT: PASS");
  }, 300_000);

  it("refuses a selected key that names no row rather than sweeping a smaller set", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const keys = join(mkdtempSync(join(tmpdir(), "acp-badkeys-")), "keys.txt");
    writeFileSync(keys, "this-key-names-no-row\n");

    const { status, stdout } = await runBoundedChild(
      "node",
      [join(process.cwd(), "scripts/verify-guards-are-falsifiable.mjs"), `--select-keys=${keys}`, "--shard-report=1"],
      { cwd: process.cwd(), budgetMs: 120_000 },
    );
    expect(status).toBe(1);
    expect(stdout).toContain("NO SUCH ROW");
    expect(stdout).toContain("a selection that silently shrinks");
  }, 300_000);
});
