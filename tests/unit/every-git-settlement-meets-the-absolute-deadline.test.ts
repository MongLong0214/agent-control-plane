/**
 * #1082 R3-01 (round 5) — every way a git call can settle is compared with the shared deadline's
 * absolute `endsAt` first: a settlement at or after it is GIT_TIMEOUT, whatever its shape.
 *
 * A closure review found `git()` exempting errors with a string `code` from that check, so a real
 * maxBuffer refusal delivered after `endsAt` read INTERNAL_ERROR. These are its witnesses, with its
 * assertions. `execFile` is replaced for the file: in "fake" mode it records each launch and
 * settles as the case says; in "delayed" mode it runs the real child and delivers its settlement
 * after a pause, as a descheduled event loop would. Times are a logical clock or real monotonic
 * time; nothing here claims how promptly the operating system delivers a kill.
 */
import type * as ChildProcess from "node:child_process";

import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  mode: "fake" as "fake" | "delayed",
  pauseMs: 1200,
  calls: [] as unknown[],
  error: null as unknown,
  settle: null as null | { code: unknown; receivedAt: number; afterPauseAt: number },
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  const replaced = (): never => {
    throw new Error("git() reaches execFile through promisify");
  };
  Object.defineProperty(replaced, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, argv: string[], options: { timeout: number } & Record<string, unknown>) => {
      if (fixture.mode === "fake") {
        fixture.calls.push({ file, argv, timeout: options.timeout });
        return fixture.error ? Promise.reject(fixture.error) : Promise.resolve({ stdout: "", stderr: "" });
      }
      return new Promise((resolve, reject) => {
        actual.execFile(file, argv, { ...options, timeout: options.timeout }, (error, stdout, stderr) => {
          const receivedAt = performance.now();
          // The event loop is descheduled before the settlement reaches git().
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fixture.pauseMs);
          fixture.settle = { code: error?.code, receivedAt, afterPauseAt: performance.now() };
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      });
    },
  });
  return { ...actual, execFile: replaced };
});

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { git } from "../../src/git/git.ts";
import { stableFixtureBinDir } from "../helpers/stable-fixture-executable.ts";

afterEach(() => {
  vi.restoreAllMocks();
  fixture.mode = "fake";
  fixture.calls = [];
  fixture.error = null;
  fixture.settle = null;
  fixture.pauseMs = 1200;
});

const settle = async (options: Parameters<typeof git>[2]): Promise<unknown> => {
  try {
    return await git("/private/tmp", ["status"], options);
  } catch (error) {
    const e = error as { reasonCode: unknown; evidence: unknown };
    return { reasonCode: e.reasonCode, evidence: e.evidence };
  }
};

for (const [name, error] of [
  ["success", null],
  ["numeric failure", { code: 1, stdout: "", stderr: "no" }],
  ["outside signal", { code: null, signal: "SIGPIPE", killed: false }],
  ["spawn failure", { code: "ENOENT", message: "missing" }],
  ["maxBuffer failure", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: "too much output" }],
] as const) {
  it(`RF-S22 arm:validator #1082 R3-01: a ${name} settling exactly at endsAt is GIT_TIMEOUT`, async () => {
    fixture.error = error;
    // The pre-check at 1, the launch instant at 2, the settlement at 1000 = endsAt.
    const samples = [1, 2, 1000];
    const observed: number[] = [];
    vi.spyOn(performance, "now").mockImplementation(() => {
      const next = samples[observed.length] ?? 1000;
      observed.push(next);
      return next;
    });
    const result = await settle({ deadline: { boundMs: 1000, endsAt: 1000 }, allowFailure: true });
    expect(result).toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT });
  });
}

it("RF-S22 arm:validator #1082 R3-01: no process is launched when the gap before launch spends the deadline", async () => {
  const observed: number[] = [];
  const samples = [500, 1000];
  vi.spyOn(performance, "now").mockImplementation(() => {
    const next = samples[observed.length] ?? 1000;
    observed.push(next);
    return next;
  });
  const result = await settle({ deadline: { boundMs: 1000, endsAt: 1000 } });
  expect(result).toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT, evidence: { started: false } });
  expect(fixture.calls).toHaveLength(0);
});

it("RF-S22 arm:validator #1082 R3-01: an actual maxBuffer error delivered beyond endsAt must be GIT_TIMEOUT", async () => {
  fixture.mode = "delayed";
  // The review used a 1000ms bound and a 1200ms pause. On a loaded host the real child had not
  // written 64 MiB within 1000ms, so the bound's kill landed first and the case measured a kill,
  // not a maxBuffer refusal. A 4000ms bound leaves room for the refusal, and the pause still
  // carries its delivery past endsAt. The bound is logical; the pause stands in for descheduling.
  const boundMs = 4000;
  fixture.pauseMs = boundMs + 200;
  // A git that writes more than git()'s 64 MiB maxBuffer, so the real child is refused for size.
  const bin = stableFixtureBinDir({ git: "#!/bin/sh\nexec /usr/bin/head -c 67112960 /dev/zero\n" });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ""}`;
  const began = performance.now();
  const endsAt = began + boundMs;
  let result: unknown;
  try {
    result = await settle({ deadline: { boundMs, endsAt }, allowFailure: true });
  } finally {
    // Assigning `undefined` would set the literal string "undefined" (every-git-call-has-a-time-bound).
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
  expect(fixture.settle?.code, JSON.stringify(result)).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(fixture.settle!.afterPauseAt).toBeGreaterThanOrEqual(endsAt);
  expect(result).toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT });
});
