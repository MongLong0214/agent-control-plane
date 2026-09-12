import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { runSandboxed } from "../../src/verify/sandbox.ts";

/**
 * #844/#859 — the sandbox awaits its own `ps` probes unconditionally, and `timeoutSeconds` binds
 * the child rather than that waiting. Without a bound on the probe, probe latency becomes the
 * sandbox's runtime: measured at 8s per `ps`, a command needing 50ms against a 3-second budget
 * took 24,081ms, and `#167`'s escalation test took 24,543ms against a one-second subject timeout.
 * On CI that shape consumed the runner's whole 60,022ms budget on one lane while the other lane
 * passed the same commit.
 *
 * The subject is a bound in time, so the assertion is on elapsed time — there is nothing else to
 * read. What makes it a measurement rather than a guess is the margin: with a `ps` that takes 60s,
 * three serialised probes cost 15,079ms bounded and 180,086ms unbounded, so the 30s threshold sits
 * 2x above the bounded cost and 6x below the unbounded one. Both numbers were taken on this
 * machine by changing only the constant.
 */
describe("a process probe has a time bound", () => {
  let restorePath: string | undefined;

  beforeEach(() => {
    const bin = mkdtempSync(join(tmpdir(), "acp-slow-ps-"));
    // `ps` is resolved through PATH by this process, not by the sandboxed child, whose environment
    // is built separately and sanitised. Slowing it down changes nothing else about the run.
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nsleep 60\nexec /bin/ps \"$@\"\n");
    chmodSync(join(bin, "ps"), 0o755);
    restorePath = process.env.PATH;
    process.env.PATH = `${bin}:${restorePath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = restorePath;
  });

  it("returns on a bound of its own when every ps stalls, rather than on the probe's latency", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "acp-probe-bound-"));
    const startedMs = Date.now();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "fast",
        argv: ["node", "-e", "process.exit(0)"],
        timeoutSeconds: 3,
      }),
      worktreePath: worktree,
    });
    const elapsedMs = Date.now() - startedMs;

    expect(elapsedMs).toBeLessThan(30_000);

    // Stated because the bound does not fix it: a probe that hits the bound still lands on the
    // "containment could not be proved" path, which CP-HI-08 makes a refusal on purpose. So a
    // machine slow enough to exceed the bound refuses instead of hanging, and it is still told it
    // failed containment rather than that the host could not answer. That relabelling is #859's
    // other half, and this assertion is here so the next reader does not mistake this test for it.
    expect(outcome.status).toBe("ERROR");
  }, 120_000);
});
