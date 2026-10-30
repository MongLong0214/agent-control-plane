import type * as ChildProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { writeCommitLoreInstall } from "../helpers/commitlore-install.ts";
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
      // #1268 — the CommitLore child is node running the copied bundle, `dist/commitlore.mjs`.
      if (basename(command) === "commitlore" || String(args[0] ?? "").endsWith("/dist/commitlore.mjs")) {
        timing.requested.push(options["timeout"]);
        // Real subprocesses and real timeout delivery; shorten only the 180-second wait.
        return actual.spawn(command, args, { ...options, timeout: 1500 });
      }
      return actual.spawn(command, args, options);
    },
  };
});
import { COMMITLORE_LIMITS, commitloreRunner, createCommitLoreCliPort } from "../../src/bootstrap/commitlore-observation.ts";
import { latestRelease } from "../helpers/commitlore-release.ts";

afterEach(() => vi.unstubAllEnvs());
afterAll(cleanupTempDirs);

it("R1-02: timeout is refused even if the signalled child exits zero with valid output", async () => {
  const root = tempDir("acp-s11-r1-timeout-");
  const dir = tempDir("acp-s11-r1-timeout-bin-");
  const events = join(root, "timeout-events.txt");
  writeFileSync(events, "");
  // #1268 — installed as the installer installs it: a run copies the package its wrapper names.
  writeCommitLoreInstall(
    dir,
    `
    // Slice S16: the pin's checks are answered at once, as a supported CLI answers them.
    if (process.argv[2] === '--version') { process.stdout.write('1.7.3\\n'); return; }
    if (process.argv[2] === 'doctor' && process.argv[3] === '--help') { process.stdout.write('Usage: commitlore doctor [options]\\n\\nOptions:\\n  --json\\n'); return; }
    if (process.argv[2] === 'init' && process.argv[3] === '--help') { process.stdout.write('Usage: commitlore init [options]\\n\\nOptions:\\n  --mcp-scope <scope>\\n  --no-unattended\\n  --no-agent-hooks\\n'); return; }
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(events)}, process.argv[2] + ':ready\\n');
    process.on('SIGTERM', () => {
      fs.appendFileSync(${JSON.stringify(events)}, process.argv[2] + ':SIGTERM\\n');
      if (process.argv[2] === 'doctor') console.log(JSON.stringify({schema:'commitlore_doctor.v2',status:'ok',exitCode:0,checks:[]}));
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `,
  );
  vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
  vi.stubEnv("ACP_COMMITLORE_BINARY", join(dir, "commitlore"));
  // CEO 19aabbda (C-2): fixture preparation, bounded and before the observation. Every spawn here runs under
  // the shortened 1.5 s, and since slice S16 the first is the `--version` check: the newly written fake is
  // executed once first, so the cold first exec of a new file (0.13-5.1 s on this host, s16-r1-fix-evidence) is
  // not inside that bound. A preparation that does not complete is a FIXTURE-PREPARATION FAILURE, never a
  // pass; this witness is no evidence about a cold first spawn.
  try {
    execFileSync(join(dir, "commitlore"), ["--version"], { stdio: "ignore", timeout: 30_000 });
  } catch (error) {
    throw new Error(`FIXTURE-PREPARATION FAILURE: the fake's --version did not complete within 30000 ms (${(error as Error).message.split("\n", 1)[0]}); the witness was not judged`);
  }
  const result = await createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, undefined, latestRelease("1.7.3"))).observe(root);
  // The review asserted both commands asked for 180 s; at the fix `init` is refused, so only it asks, after
  // the pin's three checks (slice S16: `--version`, `doctor --help`, `init --help`), under the same bound.
  expect(timing.requested).toEqual([180000, 180000, 180000, 180000]);
  expect(result.outcome).toBe("FAIL");
  // `init` was signalled at the shortened bound and exited 0: refused there, so `doctor` never ran.
  expect(readFileSync(events, "utf8")).toBe("init:ready\ninit:SIGTERM\n");
  expect(result.detail).toMatch(/init could not be run: commitlore init was signalled before it answered \(it then exited 0\)/);
});
