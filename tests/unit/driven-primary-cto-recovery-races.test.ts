import { afterAll, afterEach, expect, it, vi } from "vitest";

import { Role } from "../../src/domain/types.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary, holdNextAttestation } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * #246 PR-C C4-R2 — the races review 1 of the recovery slice found, kept as repository witnesses.
 * Each is the review's reproduction with only its harness adapted (no review-tree paths); R1-02's
 * concurrent bind is now expected to be refused, which is the fix it asked for (see that witness).
 * The review's real-subprocess resume witness is not kept: its sandboxed child process writes its
 * scratch under the operator's home, which no repository test may do.
 */

// ACP's transient files stay in this run's temporary tree, never under the operator's home.
vi.mock("../../src/core/scratch-root.ts", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = path.join(os.tmpdir(), "acp-c4r2-races-scratch");
  return {
    ACP_SCRATCH_ROOT: root,
    acpScratchDir: (prefix: string) => {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      return fs.mkdtempSync(path.join(root, prefix));
    },
  };
});

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

it("1084-R1-01: late recovery failure must retain the newer credential and attestation", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const { binding } = await drivenPrimary(f, "review-late-recovery");
    cp.sessionRuntime.release(binding.sessionId);
    const held = holdNextAttestation(f, binding.sessionId);
    const late = cp.cto.recoverDrivenPrimaryCto(binding.roleKey, { capacity: cp.capacity, runtime: cp.sessionRuntime });
    await vi.waitFor(() => expect(held.entered()).toBe(true));
    cp.sessionRuntime.release(binding.sessionId);
    const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
    const rotated = cp.sessions.rotateSecret(binding.sessionId, epoch);
    if (!rotated.allowed) throw new Error(rotated.message);
    expect(cp.sessionRuntime.adopt(binding.sessionId, Role.PRIMARY_CTO, rotated.value.sessionSecret, epoch + 1).allowed).toBe(true);
    expect((await cp.sessionRuntime.attest(binding.sessionId, "resume")).allowed).toBe(true);
    expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
    expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
    held.release();
    expect((await late).allowed).toBe(false);
    expect.soft(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
    expect.soft(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
  });
});
