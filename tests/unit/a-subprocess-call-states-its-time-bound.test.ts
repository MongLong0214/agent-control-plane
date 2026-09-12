import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

const run = (root: string): { status: number; out: string } => {
  try {
    return { status: 0, out: execFileSync("node", [CENSUS, `--root=${root}`], { encoding: "utf8" }) };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    return { status: failed.status ?? 1, out: failed.stdout ?? "" };
  }
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
  it("fails on an unbounded blocking call and names it", () => {
    const root = treeWith({
      "probe.ts": `const exec = 0;\nexecFileSync("ps", ["-o", "pid="], { encoding: "utf8" });\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(1);
    expect(out).toContain("UNBOUNDED");
    expect(out).toContain("probe.ts:2");
    expect(out).toContain("RESULT: FAIL");
  });

  it("passes when the same call states a timeout", () => {
    const root = treeWith({
      "probe.ts": `execFileSync("ps", ["-o", "pid="], { encoding: "utf8", timeout: 5_000 });\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(0);
    expect(out).toContain("1 state a timeout and 0 do not");
    // A fixture run must not inherit the src/ excuse list: matching nothing there would report
    // every entry as stale and fail, which would make this census untestable.
    expect(out).toContain("exclusion(s) do not apply here");
    expect(out).toContain("RESULT: PASS");
  });

  it("does not count RegExp.prototype.exec, which the first regex census did", () => {
    const root = treeWith({
      "policy.ts": `const used = /used\\s*=\\s*([\\d.]+)M/.exec("used = 12M")?.[1];\n` +
        `const line = "(allow process-exec (literal /bin/sh))";\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(0);
    expect(out).toContain("0 blocking call(s)");
  });

  it("counts async spawn separately and never as a violation", () => {
    const root = treeWith({
      "supervisor.ts": `spawn("node", ["-e", "process.exit(0)"], { stdio: "pipe" });\n`,
    });
    const { status, out } = run(root);
    expect(status).toBe(0);
    expect(out).toContain("0 blocking call(s)");
    expect(out).toContain("1 detached call(s)");
  });
});
