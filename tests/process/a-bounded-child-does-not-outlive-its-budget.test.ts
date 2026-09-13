import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BoundedChildTimeout, runBoundedChild } from "../helpers/bounded-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #872, and the CEO's condition on it: a timeout must not be swallowed as a pass, the failure must
 * name the concrete command, and parent-return *and* child-cleanup must be verified against a real
 * hang rather than argued.
 *
 * The fixture is a child that never exits and whose own grandchild never exits either. That second
 * generation is the point: `spawnSync`'s timeout reaps the direct child only, measured —
 *
 *     { elapsedMs: 2002, status: null, signal: "SIGTERM", killed: null, grandchildStillAlive: true }
 *
 * — so a bound without a process-group signal returns on time and leaves the wedge for the next
 * test to inherit. On a host where the wedge is shared (Gatekeeper assessing a new inode, say)
 * that is how one hung child turns into an arbitrary set of 60-second timeouts elsewhere.
 */
const FIXTURE = "tests/fixtures/bounded-child/hangs-with-a-grandchild.cjs";

const grandchildPid = (marker: string): number | null => {
  if (!existsSync(marker)) return null;
  const text = readFileSync(marker, "utf8").trim();
  return text.length === 0 ? null : Number(text);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a process with that pid exists and belongs to somebody else, which for a pid
    // this test's own fixture created can only mean it was reaped and the number reused. Reporting
    // it as alive would make a pass depend on pid reuse.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

describe("a bounded child does not outlive its budget, and neither does its grandchild (#872)", () => {
  it("returns at the budget with a typed failure naming the command, and reaps the whole group", async () => {
    const marker = join(tempDir("acp-bounded-child-"), "grandchild.pid");

    const startedAt = Date.now();
    await expect(runBoundedChild(process.execPath, [FIXTURE, marker], { budgetMs: 2_000 }))
      .rejects.toThrowError(BoundedChildTimeout);
    const elapsed = Date.now() - startedAt;

    // The parent returned, and it returned at the budget rather than at some later moment the
    // runner happened to notice. The upper bound is generous because this is not a performance
    // assertion — it is the difference between a bound and no bound.
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(30_000);

    // The grandchild existed, which is what makes the next assertion mean something: a fixture
    // that failed to start one would satisfy "nothing survived" trivially.
    const pid = grandchildPid(marker);
    expect(pid, "the fixture published its grandchild's pid before hanging").not.toBeNull();

    // `close` fires when the group leader is gone; the grandchild is reaped by the same signal but
    // the kernel does not order the two, so this polls rather than asserting on the first read.
    const deadline = Date.now() + 10_000;
    while (isAlive(pid!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isAlive(pid!), `grandchild ${pid} outlived the process-group signal`).toBe(false);
  }, 60_000);

  it("names the concrete command in the failure, so a reader is not told only that something timed out", async () => {
    const marker = join(tempDir("acp-bounded-child-named-"), "grandchild.pid");

    // The message is the whole deliverable of a typed failure: a test that reports "timed out"
    // without the argv sends its reader to guess which of a file's children hung.
    await expect(runBoundedChild(process.execPath, [FIXTURE, marker], { budgetMs: 1_000 }))
      .rejects.toThrow(new RegExp(`${FIXTURE}.*did not complete within 1000ms`, "u"));
  }, 60_000);

  it("returns the child's verdict when it finishes inside the budget — the control", async () => {
    const done = await runBoundedChild(process.execPath, ["-e", "process.stdout.write('ok'); process.exit(3)"], {
      budgetMs: 30_000,
    });

    // Both halves: a status a caller can read as a verdict, and the output that explains it.
    // Without this case the two above would pass against a helper that always throws.
    expect(done.status).toBe(3);
    expect(done.stdout).toBe("ok");
  }, 60_000);
});
