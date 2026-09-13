import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runBoundedChild } from "../helpers/bounded-child.ts";

/**
 * #858's census, pointed at fixture trees rather than at `src/`.
 *
 * The only other way to show this census can fail is to remove a tiebreaker from the product, and
 * a check whose failure has never been observed is the shape this repository keeps paying for.
 * The fixtures also pin the one classification the first version of this regex got wrong.
 */
const CENSUS = join(process.cwd(), "scripts/verify-timestamp-orderings-are-total.mjs");

const run = async (argv: readonly string[]) =>
  runBoundedChild("node", [CENSUS, ...argv], { cwd: process.cwd(), budgetMs: 60_000 });

const treeWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "acp-ts-order-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
};

describe("a timestamp ordering names a tiebreaker", () => {
  it("fails on an order over a timestamp alone and names it", async () => {
    const root = treeWith({ "probe.ts": "const q = `SELECT x FROM t ORDER BY received_at ASC`;\n" });
    const { status, stdout } = await run([`--root=${root}`]);
    expect(status).toBe(1);
    expect(stdout).toContain("PARTIAL ORDER");
    expect(stdout).toContain("probe.ts:1");
    expect(stdout).toContain("RESULT: FAIL");
  });

  it("passes when the same order names a second term", async () => {
    const root = treeWith({
      "probe.ts": "const q = `SELECT x FROM t ORDER BY received_at ASC, nonce ASC`;\n",
    });
    const { status, stdout } = await run([`--root=${root}`]);
    expect(status).toBe(0);
    expect(stdout).toContain("1 name a tiebreaker and 0 do not");
    // A fixture run must not inherit the src/ backlog: matching nothing there would report every
    // entry as stale and fail, which would make this census untestable.
    expect(stdout).toContain("exclusion(s) do not apply here");
    expect(stdout).toContain("RESULT: PASS");
  });

  /**
   * The classification the first version got wrong. It asked "is there a term *after* the
   * timestamp" and reported `ORDER BY bucket_id ASC, observed_at DESC` as partial — the
   * discriminator was in front. A tiebreaker does not have to follow the column it breaks ties for.
   */
  it("does not count a leading discriminator as absent", async () => {
    const root = treeWith({
      "probe.ts": "const q = `SELECT x FROM t ORDER BY bucket_id ASC, observed_at DESC`;\n",
    });
    const { status, stdout } = await run([`--root=${root}`]);
    expect(status).toBe(0);
    expect(stdout).toContain("1 name a tiebreaker and 0 do not");
  });

  it("counts nothing for an order over a column that is not a timestamp", async () => {
    const root = treeWith({ "probe.ts": "const q = `SELECT x FROM t ORDER BY nonce ASC`;\n" });
    const { status, stdout } = await run([`--root=${root}`]);
    expect(status).toBe(0);
    expect(stdout).toContain("0 timestamp ordering(s)");
  });

  it("refuses an argument it does not know rather than scanning something unintended", async () => {
    const { status, stderr } = await run(["--help"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unrecognised argument(s): --help");
  });
});
