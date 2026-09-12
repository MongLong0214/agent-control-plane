import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { git } from "../../src/git/git.ts";

/**
 * #859 — `maxBuffer` bounded how much a git command may say; nothing bounded how long it may take.
 * `promisify(execFile)` without a `timeout` waits forever, so a git that never returns stopped the
 * caller instead of failing it.
 *
 * The subject is a bound in time, so the assertion is on elapsed time and on the reason code. A
 * `git` that sleeps well past the bound makes both observable: the call must come back, and it must
 * come back saying git never answered rather than that git said no.
 */
describe("every git call has a time bound", () => {
  let restorePath: string | undefined;
  let cwd = "";
  const made: string[] = [];

  beforeEach(() => {
    const bin = mkdtempSync(join(tmpdir(), "acp-slow-git-"));
    made.push(bin);
    // Resolved through PATH by this process. The sanitised env `git()` builds keeps PATH, which is
    // what makes this reachable at all — and is also why a caller cannot assume a fast git.
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 60\nexec /usr/bin/git \"$@\"\n");
    chmodSync(join(bin, "git"), 0o755);
    restorePath = process.env.PATH;
    process.env.PATH = `${bin}:${restorePath ?? ""}`;
    cwd = mkdtempSync(join(tmpdir(), "acp-git-bound-"));
    made.push(cwd);
  });

  afterEach(() => {
    // Assigning `undefined` to a `process.env` member sets the literal string "undefined", which
    // would leave every later test in this worker with a PATH of one nonexistent directory.
    if (restorePath === undefined) delete process.env.PATH;
    else process.env.PATH = restorePath;
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("kills a git that outlives its bound and says git never answered", async () => {
    const startedMs = Date.now();
    // `fail()` throws rather than returning a decision, so the refusal arrives as an AcpError and
    // the reason code is on the error.
    await expect(git(cwd, ["status", "--porcelain"], { timeoutMs: 300 })).rejects.toMatchObject({
      reasonCode: ReasonCode.GIT_TIMEOUT,
    });
    // Back long before the 60s git would have taken.
    expect(Date.now() - startedMs).toBeLessThan(10_000);
  });

  it("leaves an ordinary git alone — the control", async () => {
    // Without this the two refusals above are also what a wrapper that refused every git would
    // produce. Run with the real git on PATH and a real repository.
    process.env.PATH = restorePath;
    const initialised = await git(cwd, ["init", "--quiet"], { allowFailure: true });
    expect(initialised.exitCode).toBe(0);
    const status = await git(cwd, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(0);
  });

  it("refuses a non-positive bound rather than passing it to Node as no bound", async () => {
    // `timeout: 0` is how Node spells *no* timeout, and the census that enforces this rule reads
    // only whether the option is present. So zero is the one value that removes the bound while
    // still counting as bounded, and it is refused before it can be handed over.
    await expect(git(cwd, ["status"], { timeoutMs: 0 })).rejects.toMatchObject({
      reasonCode: ReasonCode.INVALID_ARGUMENT,
    });
    await expect(git(cwd, ["status"], { timeoutMs: -1 })).rejects.toMatchObject({
      reasonCode: ReasonCode.INVALID_ARGUMENT,
    });
  });

  it("does not let allowFailure turn a timeout into an exit code", async () => {
    // This is the collapse the reason code exists to remove. `promisify(execFile)` reports a
    // timed-out child as `{ code: null, signal: "SIGTERM", killed: true }`, so the previous
    // `e.code ?? 1` made it exit 1 — and an `allowFailure` caller reads exit 1 as "git said no".
    // A dirty working tree and a git that never ran must not be the same answer.
    await expect(
      git(cwd, ["status", "--porcelain"], { timeoutMs: 300, allowFailure: true }),
    ).rejects.toMatchObject({ reasonCode: ReasonCode.GIT_TIMEOUT });
  });
});
