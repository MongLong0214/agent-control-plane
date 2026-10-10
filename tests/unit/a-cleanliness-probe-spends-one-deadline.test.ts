/**
 * #1082 R3-01 — `isClean(cwd, { timeoutMs })` answers through two git processes, configuration
 * discovery and then status, and the caller's bound covers both.
 *
 * The doctor hands `isClean` what is left of its sweep budget. A merge-gate review found the
 * discovery read running under git's own 120s default instead: with discovery delayed 350ms, a
 * 20ms request answered after about 734ms, while the prior status-only body answered in about
 * 22ms. The first two cases are that witness and its control, with the review's assertion.
 *
 * The bounds here are logical budgets. A case asserts what the budget decides -- which process is
 * started, which answer is counted, which reason is given -- and allows wall-clock slack for the
 * operating system to deliver a kill and an answer; it does not claim 20ms of scheduling accuracy.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { git, isClean } from "../../src/git/git.ts";
import { cleanupTempDirs, gitSync, makeRepo } from "../helpers/fixtures.ts";
import { stableFixtureBinDir } from "../helpers/stable-fixture-executable.ts";

afterEach(cleanupTempDirs);

/**
 * A git that is slow to answer one kind of call, configuration discovery unless told otherwise.
 * Its per-run settings live in the repository's `.git/acp-fixture-git`, never in this text, so the
 * executable keeps one inode across runs. Every call it sees in such a repository is logged beside
 * them.
 */
const SLOW_DISCOVERY_GIT = [
  "#!/bin/sh",
  'if [ "$1" = "-C" ] && [ -f "$2/.git/acp-fixture-git" ]; then',
  '  . "$2/.git/acp-fixture-git"',
  "  printf '%s\\n' \"$*\" >> \"$2/.git/acp-fixture-git-calls\"",
  '  case "$*" in',
  '    *"$DELAY_ON"*)',
  "      if [ -n \"$IGNORE_TERM\" ]; then trap '' TERM; fi",
  '      /bin/sleep "$DELAY"',
  "      ;;",
  "  esac",
  "fi",
  'exec "${REAL_GIT:-/usr/bin/git}" "$@"',
  "",
].join("\n");

const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8", timeout: 5_000 }).trim();

/** Runs `body` with the slow git first on PATH for a repository configured by `settings`. */
const withSlowDiscovery = async <T>(
  repo: string,
  settings: { delaySeconds: number; ignoreTerm?: boolean; delayOn?: string },
  body: () => Promise<T>,
): Promise<{ result: T | { error: string; reasonCode: unknown }; elapsedMs: number; calls: string[] }> => {
  writeFileSync(
    join(repo, ".git", "acp-fixture-git"),
    [
      `DELAY=${settings.delaySeconds}`,
      `DELAY_ON='${settings.delayOn ?? "config --name-only"}'`,
      `REAL_GIT='${realGit}'`,
      ...(settings.ignoreTerm ? ["IGNORE_TERM=1"] : []),
      "",
    ].join("\n"),
  );
  const bin = stableFixtureBinDir({ git: SLOW_DISCOVERY_GIT });
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ""}`;
  const before = performance.now();
  let result: T | { error: string; reasonCode: unknown };
  try {
    result = await body();
  } catch (error) {
    result = { error: String(error), reasonCode: (error as { reasonCode?: unknown }).reasonCode };
  } finally {
    // Assigning `undefined` would set the literal string "undefined" (every-git-call-has-a-time-bound).
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
  const elapsedMs = performance.now() - before;
  const log = join(repo, ".git", "acp-fixture-git-calls");
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { result, elapsedMs, calls };
};

const statusCalls = (calls: readonly string[]): string[] => calls.filter((call) => call.includes(" status "));

describe("#1082 R3-01: one deadline bounds a cleanliness probe", () => {
  it("RF-S22 arm:validator #1082 R3-01: isClean caller timeout also bounds its newly added config discovery", async () => {
    const repo = makeRepo();
    const { result, elapsedMs, calls } = await withSlowDiscovery(repo, { delaySeconds: 0.35 }, () =>
      isClean(repo, { timeoutMs: 20 }),
    );
    // The review's assertion. 200ms is slack for the kill and the answer to be delivered, an order
    // of magnitude under the 350ms discovery the bound has to cut short.
    expect(elapsedMs, `config discovery ignored the caller time bound: ${JSON.stringify(result)}`).toBeLessThan(200);
    expect(result).toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT });
    expect(statusCalls(calls), "status started after the shared bound was spent").toEqual([]);
  });

  it("RF-S22 arm:validator #1082 R3-01: control -- the slow fixture delays discovery only, so a status-only read stays inside the bound", async () => {
    // The prior isClean body was this one status read. Under the same fixture it is back within
    // the same slack whatever it answers, so the delay the first case cuts short is discovery's.
    const repo = makeRepo();
    const { elapsedMs, calls } = await withSlowDiscovery(repo, { delaySeconds: 0.35 }, () =>
      git(repo, ["status", "--porcelain"], { timeoutMs: 20 }),
    );
    expect(elapsedMs).toBeLessThan(200);
    expect(calls.some((call) => call.includes("config --name-only"))).toBe(false);
  });

  it("RF-S22 arm:validator #1082 R3-01: a discovery that settles after the deadline is not counted, and status is never started", async () => {
    // The discovery ignores SIGTERM, so the bound's kill does not end it: it finishes its 350ms
    // and exits 0, and Node settles that as a success. The deadline is spent by then.
    const repo = makeRepo();
    const { result, calls } = await withSlowDiscovery(repo, { delaySeconds: 0.35, ignoreTerm: true }, () =>
      isClean(repo, { timeoutMs: 50 }),
    );
    expect(result).toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT });
    expect(calls.filter((call) => call.includes("config --name-only"))).toHaveLength(1);
    expect(statusCalls(calls), "a process was started after the shared bound was spent").toEqual([]);
  });

  // A child that outlives the bound's SIGTERM still settles, and Node hands back whatever that
  // settlement is. Each row is a shape that was counted as something other than the bound.
  it.each([
    // Exits 0 with nothing to say: read as "clean".
    ["exits 0 with no output, which read as git's answer", "status --porcelain", false, { exitCode: 0 }],
    // Exits 1 with nothing to say: `allowFailure` read it as "no filter driver is configured".
    ["exits 1 with no output, which allowFailure read as git saying no", "config --name-only", false, { exitCode: 1 }],
    // Still writing when its pipe was destroyed: it died of SIGPIPE, read as a signal from elsewhere.
    ["dies writing into the destroyed pipe, which read as an outside signal", "config --name-only", true, { reasonCode: ReasonCode.INTERNAL_ERROR }],
  ] as const)("RF-S22 arm:validator #1082 R3-01: a git that settles after its bound is a timeout when it %s", async (_, delayOn, driver, before) => {
    const repo = makeRepo();
    // A configured filter driver gives discovery something to write.
    if (driver) gitSync(repo, ["config", "filter.witness.clean", "cat"]);
    const args = delayOn === "status --porcelain"
      ? ["status", "--porcelain"]
      : ["config", "--name-only", "--get-regexp", "^filter\\."];
    const { result } = await withSlowDiscovery(repo, { delaySeconds: 0.3, ignoreTerm: true, delayOn }, () =>
      git(repo, args, { timeoutMs: 50, allowFailure: true }),
    );
    // `before` is what the same settlement was reported as when a late settlement was counted.
    expect(result, `previously ${JSON.stringify(before)}`).toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT });
  });
});
