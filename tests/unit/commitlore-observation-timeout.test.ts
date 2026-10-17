import type * as ChildProcess from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Review S11-R1-02 (PR #1138) — the reviewer's timeout witness: real subprocesses and real timeout
 * delivery, with only the 180-second wait shortened, by rewriting the `timeout` `spawn` is asked for.
 * Changed from the review's reproduction only for paths and isolation: the files live in a temporary
 * directory of this run, and `commitlore` is recognised by its basename, since the observer now spawns
 * the executable it resolved on PATH rather than the bare name.
 */

const timing = vi.hoisted(() => ({ requested: [] as unknown[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      if (basename(command) === "commitlore") {
        timing.requested.push(options["timeout"]);
        // Real subprocesses and real timeout delivery; shorten only the 180-second wait.
        return actual.spawn(command, args, { ...options, timeout: 1500 });
      }
      return actual.spawn(command, args, options);
    },
  };
});
import { createCommitLoreCliPort } from "../../src/bootstrap/commitlore-observation.ts";

afterEach(() => vi.unstubAllEnvs());
afterAll(cleanupTempDirs);

it("R1-02: timeout is refused even if the signalled child exits zero with valid output", async () => {
  const root = tempDir("acp-s11-r1-timeout-");
  const dir = tempDir("acp-s11-r1-timeout-bin-");
  const events = join(root, "timeout-events.txt");
  writeFileSync(events, "");
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    join(dir, "commitlore"),
    `#!${process.execPath}\n
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(events)}, process.argv[2] + ':ready\\n');
    process.on('SIGTERM', () => {
      fs.appendFileSync(${JSON.stringify(events)}, process.argv[2] + ':SIGTERM\\n');
      if (process.argv[2] === 'doctor') console.log(JSON.stringify({schema:'commitlore_doctor.v2',status:'ok',exitCode:0,checks:[]}));
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
  const result = await createCommitLoreCliPort().observe(root);
  // The review asserted both commands asked for 180 s; at the fix `init` is refused, so only it asks.
  expect(timing.requested).toEqual([180000]);
  expect(result.outcome).toBe("FAIL");
  // `init` was signalled at the shortened bound and exited 0: refused there, so `doctor` never ran.
  expect(readFileSync(events, "utf8")).toBe("init:ready\ninit:SIGTERM\n");
  expect(result.detail).toMatch(/init could not be run: commitlore init was signalled before it answered \(it then exited 0\)/);
});
