import { chmodSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { ClaudeCliAdapter, claudeTranscriptDirectory } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, InvocationResult, ProviderAdapter } from "../../src/runtime/provider.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { requireSeatbelt, seatbeltStatus } from "../helpers/seatbelt.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";
import { seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1098 — a WORKER turn keeps no transcript, and cannot be resumed.
 *
 * The runtime profile a WORKER turn runs under denies every write except the invocation's scratch
 * and the paths the write broker granted, so the coding CLI's transcript directory is not writable.
 * That is fine for one turn per task, which is the design: each turn opens its own conversation with
 * `--session-id` and never `--resume`s one. A multi-turn WORKER would need a writable transcript
 * directory (as `runSessionTurn` has) and `--resume` for every later turn. This file pins the limit,
 * so that either change arrives as a deliberate edit here rather than as a silent drift.
 *
 * It asserts the kernel, not the profile text: the transcript directory is created beforehand, so
 * only the seatbelt stands between the provider and a transcript file. Granting that directory to a
 * WORKER turn, or passing it `--resume`, turns this red.
 *
 * HOME is a private directory before anything is imported, so the transcript directory under test is
 * never the operator's.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-worker-transcript-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

/**
 * A provider stand-in run as the real ClaudeCliAdapter's binary. It writes a transcript where the CLI
 * keeps one, makes the turn's one owned edit, and answers as the session it was told to be.
 */
const transcriptProbe = (dir: string, transcripts: string): string => {
  const binary = join(dir, "transcript-probe.mjs");
  writeFileSync(binary, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = argv.includes("--resume") ? "--resume" : "--session-id";
const sessionId = argv[argv.indexOf(flag) + 1];
let transcriptError = null;
try {
  writeFileSync(join(${JSON.stringify(transcripts)}, sessionId + ".jsonl"), "{}\\n");
} catch (error) {
  transcriptError = (error && error.code) || String(error);
}
writeFileSync(join(process.cwd(), "src", "app.js"), "module.exports = () => 2;\\n");
const report = { argv, cwd: process.cwd(), transcriptError };
process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, result: JSON.stringify(report) }));
`);
  chmodSync(binary, 0o700);
  return binary;
};

describe("#1098 a WORKER turn keeps no transcript", () => {
  it("runs under a profile that denies a write into the transcript directory, and opens a new conversation", async (ctx) => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const workdir = realpathSync(world.repoPath);
    const transcripts = claudeTranscriptDirectory(workdir);
    if (!transcripts) throw new Error(`the worktree path is too long to name a transcript directory: ${workdir}`);
    expect(transcripts.startsWith(`${isolatedHome}/`)).toBe(true);
    // Present beforehand, so a refusal is the profile's and not a missing parent's.
    mkdirSync(transcripts, { recursive: true });

    const probeDir = tempDir("acp-worker-transcript-probe-");
    const adapter = new ClaudeCliAdapter({
      clock: core.clock,
      capacityFile: join(probeDir, "capacity.json"),
      binary: transcriptProbe(probeDir, transcripts),
      managedWriteBroker: world.broker,
    });
    const answers: InvocationResult[] = [];
    const observed = {
      provider: adapter.provider,
      isProduction: adapter.isProduction,
      defaultModels: adapter.defaultModels,
      invoke: async (request: InvocationRequest) => {
        const answer = await adapter.invoke(request);
        answers.push(answer);
        return answer;
      },
    } as unknown as ProviderAdapter;
    const runner = new WorkerTurnRunner(
      { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => observed },
      { pollMs: 20 },
    );
    const started = await runner.start({
      runId: world.runId,
      taskId: world.taskId,
      claimId: world.claimId,
      ownerSessionId: world.cto.sessionId,
      ownerBindingGeneration: world.cto.generation,
      timeoutMs: 20_000,
    });
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    await runner.settled(started.value.executionId);
    const execution = world.tasks.execution(started.value.executionId)!;

    if (!seatbeltStatus().applies) {
      // Without seatbelt there is no WORKER profile to measure, and no unconfined fallback either.
      expect(execution.status).not.toBe("SUCCEEDED");
      requireSeatbelt(ctx);
    }

    // The turn does not need a transcript to succeed: one turn per task is the design.
    expect(execution.status, JSON.stringify(runner.describe(execution.executionId, world.runId))).toBe("SUCCEEDED");
    expect(answers).toHaveLength(1);
    const report = JSON.parse(answers[0]!.text) as { argv: string[]; cwd: string; transcriptError: string | null };

    // The directory measured is the one the CLI would use for this turn's working directory.
    expect(claudeTranscriptDirectory(realpathSync(report.cwd))).toBe(transcripts);
    // The kernel refused the transcript write, and nothing landed there.
    expect(["EPERM", "EACCES"]).toContain(report.transcriptError);
    expect(readdirSync(transcripts)).toEqual([]);

    // Each WORKER turn opens its own conversation under its constituted id and never resumes one.
    expect(report.argv).not.toContain("--resume");
    expect(report.argv[report.argv.indexOf("--session-id") + 1]).toBe(world.worker.externalSessionId);
  });
});
