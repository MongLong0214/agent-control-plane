import { afterAll, describe, expect, it, vi } from "vitest";

import { Role } from "../../src/domain/types.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary, holdNextAttestation, workTurnsOf } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #246 PR-C C4-R2 — a driven PRIMARY_CTO is recovered on its own session and never replaced, its
 * spawns clean up only what they are proven to have created, and an attestation's failure is
 * scoped to the exact epoch it was for.
 *
 * Over the real sockets (`cto.mcp.sock`, the take-once launch channel) and the daemon's own
 * continuity reconcile; only the model is scripted (`HeadlessRuntimeDouble`).
 */

describe("#246 C4-R2 — an attestation's failure is scoped to the epoch it was for", () => {
  it("keeps a newer epoch's attestation when an earlier epoch's attestation fails late", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "late-failure");
      const held = holdNextAttestation(f, binding.sessionId);
      // Epoch N's attestation is out, inside the provider.
      const late = cp.sessionRuntime.attest(binding.sessionId, "resume");
      await vi.waitFor(() => expect(held.entered()).toBe(true));
      // The daemon drops its custody, and the session is given epoch N+1, adopted and attested.
      cp.sessionRuntime.release(binding.sessionId);
      const epoch = cp.sessions.require(binding.sessionId).credentialEpoch;
      const rotated = cp.sessions.rotateSecret(binding.sessionId, epoch);
      if (!rotated.allowed) throw new Error(rotated.message);
      expect(cp.sessionRuntime.adopt(binding.sessionId, Role.PRIMARY_CTO, rotated.value.sessionSecret, epoch + 1).allowed).toBe(true);
      expect((await cp.sessionRuntime.attest(binding.sessionId, "resume")).allowed).toBe(true);
      expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);

      // Epoch N's attestation now fails, late.
      held.release();
      expect((await late).allowed).toBe(false);
      // Its failure was for epoch N; epoch N+1's attestation stands and work is admitted.
      expect(cp.sessionRuntime.turnEligibility(binding.sessionId, "work").allowed).toBe(true);
      expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "after-the-late-failure", kind: "test" }])).toMatchObject({
        allowed: true,
      });
      await vi.waitFor(() => expect(workTurnsOf(f, binding.sessionId)).toBe(1));
    });
  });
});
