import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runBoundedChild } from "../helpers/bounded-child.ts";

/**
 * #859 — the census that keeps the next unbounded subprocess call from arriving unnoticed.
 *
 * It is pointed at a fixture tree rather than at `src/`, because the only other way to show this
 * census can fail is to remove a bound from the product, and a check whose failure has never been
 * observed is the shape this repository keeps paying for. The fixtures also pin the two
 * classifications a regex got wrong: `RegExp.prototype.exec` is not a subprocess call, and async
 * `spawn` is not a violation.
 */
const CENSUS = join(process.cwd(), "scripts/verify-subprocess-calls-are-bounded.mjs");

/**
 * The census's own child gets the bound the census is about. It was itself one of the 186
 * unbounded calls under `tests/`, which is the kind of thing a census finds about its own test.
 */
const run = async (root: string, budgets?: ReadonlyArray<readonly [string, number]>) => {
  const argv = [CENSUS, `--root=${root}`];
  if (budgets !== undefined) {
    const path = join(root, "budgets.json");
    writeFileSync(path, JSON.stringify(budgets));
    argv.push(`--budgets=${path}`);
  }
  const { status, stdout } = await runBoundedChild("node", argv, { budgetMs: 60_000 });
  return { status, out: stdout };
};

const treeWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "acp-census-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
};

describe("a subprocess call states its time bound", () => {
  it("fails on an unbounded blocking call and names it", async () => {
    const root = treeWith({
      "probe.ts": `const exec = 0;\nexecFileSync("ps", ["-o", "pid="], { encoding: "utf8" });\n`,
    });
    const { status, out } = await run(root);
    expect(status).toBe(1);
    expect(out).toContain("UNBOUNDED");
    expect(out).toContain("probe.ts:2");
    expect(out).toContain("RESULT: FAIL");
  });

  it("passes when the same call states a timeout", async () => {
    const root = treeWith({
      "probe.ts": `execFileSync("ps", ["-o", "pid="], { encoding: "utf8", timeout: 5_000 });\n`,
    });
    const { status, out } = await run(root);
    expect(status).toBe(0);
    expect(out).toContain("1 state a timeout and 0 do not");
    // A fixture run must not inherit the src/ excuse list: matching nothing there would report
    // every entry as stale and fail, which would make this census untestable.
    expect(out).toContain("exclusion(s) do not apply here");
    expect(out).toContain("RESULT: PASS");
  });

  it("does not count RegExp.prototype.exec, which the first regex census did", async () => {
    const root = treeWith({
      "policy.ts": `const used = /used\\s*=\\s*([\\d.]+)M/.exec("used = 12M")?.[1];\n` +
        `const line = "(allow process-exec (literal /bin/sh))";\n`,
    });
    const { status, out } = await run(root);
    expect(status).toBe(0);
    expect(out).toContain("0 blocking call(s)");
  });

  it("counts async spawn separately and never as a violation", async () => {
    const root = treeWith({
      "supervisor.ts": `spawn("node", ["-e", "process.exit(0)"], { stdio: "pipe" });\n`,
    });
    const { status, out } = await run(root);
    expect(status).toBe(0);
    expect(out).toContain("0 blocking call(s)");
    expect(out).toContain("1 detached call(s)");
  });

  it("counts the tests tree per file, and passes when the budget equals what is there", async () => {
    const root = treeWith({
      "probe.ts": `execFileSync("ps", ["-o", "pid="], { encoding: "utf8" });\n` +
        `spawnSync("ps", ["-o", "pid="], { encoding: "utf8" });\n`,
    });
    const { status, out } = await run(root, [["probe.ts", 2]]);
    expect(status).toBe(0);
    expect(out).toContain("1 file(s) carry a budget totalling 2; 2 unbounded call(s) found in 1 file(s)");
    expect(out).toContain("RESULT: PASS");
  });

  it("refuses one more unbounded call than the file's budget, and names the file", async () => {
    const root = treeWith({
      "probe.ts": `execFileSync("ps", ["-o", "pid="], { encoding: "utf8" });\n` +
        `spawnSync("ps", ["-o", "pid="], { encoding: "utf8" });\n`,
    });
    const { status, out } = await run(root, [["probe.ts", 1]]);
    expect(status).toBe(1);
    expect(out).toContain("OVER BUDGET  probe.ts  2 unbounded call(s), budget 1");
    expect(out).toContain("RESULT: FAIL");
  });

  /**
   * The direction that keeps this a ratchet. A budget left above what the file now contains is not
   * harmless: it silently permits the next unbounded call, which is exactly what this census
   * exists to refuse. So bounding a call and not lowering the number fails too.
   */
  it("refuses a budget left above what the file now contains", async () => {
    const root = treeWith({
      "probe.ts": `execFileSync("ps", ["-o", "pid="], { encoding: "utf8", timeout: 5_000 });\n`,
    });
    const { status, out } = await run(root, [["probe.ts", 1]]);
    expect(status).toBe(1);
    expect(out).toContain("BUDGET NOW STALE  probe.ts  0 unbounded call(s), budget 1");
    expect(out).toContain("RESULT: FAIL");
  });

  it("refuses the first unbounded call in a file no budget names", async () => {
    const root = treeWith({
      "probe.ts": `execFileSync("ps", ["-o", "pid="], { encoding: "utf8" });\n`,
    });
    const { status, out } = await run(root, []);
    expect(status).toBe(1);
    expect(out).toContain("OVER BUDGET  probe.ts  1 unbounded call(s), budget 0");
    expect(out).toContain("RESULT: FAIL");
  });
});
