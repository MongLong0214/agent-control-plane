/**
 * The falsifiability sweep runs as four CI jobs instead of one, and the thing that can go wrong is
 * not slowness — it is a row that no job runs.
 *
 * Four green checks look identical whether they covered the whole table or three quarters of it.
 * The two ways to end up in the second state are a partition that is not one (the harness's own
 * `--shard-report=` refuses that) and a matrix that lists fewer legs than the denominator its
 * arguments carry (nothing in the harness can see that — it is handed one shard and never learns
 * how many jobs GitHub started).
 *
 * So this reads the shard list back out of `.github/workflows/ci.yml`, which is the only place
 * that fact exists, and requires it to be exactly `1/N` through `N/N` for one `N`; then it makes
 * the harness prove that `N` shards partition the real row table. Together those two say every row
 * runs in exactly one job. Neither says it alone.
 *
 * The workflow is read as the file CI runs, not as a fixture: a fixture would be a second
 * description of the shard set, free to stop resembling the one that matters.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const HARNESS = join(REPO_ROOT, "scripts", "verify-guards-are-falsifiable.mjs");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

const harness = (...args: string[]) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

/**
 * The `shard:` values the `guard-falsifiability` job declares.
 *
 * Scoped to that job's own block rather than searched for file-wide: `shard` is an ordinary word,
 * and a match from somewhere else would be read as this job's matrix and pass on a table that
 * belongs to nothing.
 */
const declaredShards = (): string[] => {
  const text = readFileSync(WORKFLOW, "utf8");
  const job = /\n {2}guard-falsifiability:\n([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:\n)/.exec(text)?.[1];
  // Thrown, not asserted: an absent job or matrix is this reader having lost its subject, and a
  // reader that quietly returns an empty list would let every assertion below pass over nothing.
  if (job === undefined) throw new Error("ci.yml has no `guard-falsifiability:` job to read a matrix from");
  const list = /\n {8}shard: \[([^\]]*)\]\n/.exec(job)?.[1];
  if (list === undefined) throw new Error("the guard-falsifiability job declares no `shard:` matrix");
  return list.split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
};

describe("the sharded falsifiability sweep", () => {
  it("declares every shard of one total, with no leg missing and none repeated", () => {
    const shards = declaredShards();
    const total = shards.length;

    // Written as the full expected list rather than a per-entry loop: a loop over what is there
    // cannot notice what is not, which is the whole failure being guarded against.
    expect(shards).toEqual(Array.from({ length: total }, (_, index) => `${index + 1}/${total}`));
  });

  it("partitions the real row table across exactly those shards", () => {
    const total = declaredShards().length;

    const result = harness(`--shard-report=${total}`);

    // The last line, and the reason it is read rather than the exit code alone: this harness's
    // contract is that `RESULT:` is the final line and one of two words.
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("RESULT: PASS");
    expect(result.stdout).toContain(`0 row(s) in more than one shard; 0 row(s) in none`);
    expect(result.status).toBe(0);
  });

  it("refuses a shard index outside the range rather than passing over no row", () => {
    const total = declaredShards().length;

    const result = harness(`--shard=${total + 1}/${total}`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`names shard ${total + 1} of ${total}`);
    expect(result.stdout).toContain("RESULT: FAIL");
    // A refusal that ran rows would have restored a mutation on its way out; this one never
    // reaches a write, which is what makes it safe to run beside a real sweep.
    expect(result.stdout).not.toContain("killed");
  });

  it("refuses a selection that names no row, the shape that printed PASS over an empty table", () => {
    const result = harness("--only=no-row-says-this");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Zero rows is not a clean sweep");
    expect(result.stdout).toContain("RESULT: FAIL");
  });
});
