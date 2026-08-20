import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The harness edits tracked files in place and puts them back from a snapshot it took at
 * startup. Restoring that snapshot is only a *restore* while nothing else has written the file.
 *
 * On 2026-08-20 something else did. The run took twelve minutes, work continued during it, and
 * the restore wrote startup content over an edit made in between — on a run that exited 0. The
 * startup dirty-tree check cannot see this: it looks once, and what it establishes is true only
 * at that instant.
 *
 * This test reproduces that race deliberately rather than asserting the message exists.
 */
const ROOT = process.cwd();
const GUARDED = join(ROOT, "src/runtime/hermes-ceo.ts");
const HARNESS = join(ROOT, "scripts/verify-guards-are-falsifiable.mjs");

describe("the falsifiability harness, when a guarded file changes underneath it", () => {
  it("refuses to write its snapshot over the other writer's edit", async () => {
    const pristine = readFileSync(GUARDED, "utf8");

    const child = spawn(
      process.execPath,
      // Any row whose file this test can write to. Named by its `what`, not its index, so a
// reordered table does not silently select a different guard.
      [HARNESS, "--only=the tool bridge rewrites request ids"],
      { cwd: ROOT, encoding: "utf8" } as never,
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (output += c));
    child.stderr.on("data", (c: string) => (output += c));

    try {
      // Wait until the harness has actually mutated the file. Editing before that would race
      // the *other* check (the one before mutating) and prove a different thing.
      const deadline = Date.now() + 60_000;
      while (readFileSync(GUARDED, "utf8") === pristine && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(readFileSync(GUARDED, "utf8")).not.toBe(pristine);

      // The concurrent writer. A marker, so the assertion below is about *this* content
      // surviving rather than about the file merely differing.
      writeFileSync(GUARDED, `${pristine}\n// concurrent-writer-marker\n`);

      const code = await new Promise<number>((resolve) => child.once("close", (c) => resolve(c ?? -1)));

      expect(code).toBe(1);
      expect(output).toContain("changed underneath this run");
      // The point of the guard: the other writer's bytes are still on disk.
      expect(readFileSync(GUARDED, "utf8")).toContain("concurrent-writer-marker");
    } finally {
      child.kill("SIGKILL");
      writeFileSync(GUARDED, pristine);
    }
  }, 120_000);
});
