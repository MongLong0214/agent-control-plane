import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  expectedBindingDigest,
  expectedPromptDigest,
  expectedSessionDigest,
  runInItsOwnProcess,
  type ClaimReport,
  type ReadReport,
} from "./fixtures/turn-claim-across-a-restart.ts";

/**
 * #639 contract 1: the four values a claim fixes — `turnRequestId`, session digest, prompt digest
 * and binding digest — are the same values after the process that wrote them is gone.
 *
 * Nothing compares them to anything yet (#638 supplies the receipt), so this changes no outcome.
 * *That* is what is under test: a comparison against an id or a digest that drifts across a
 * restart fails always, and its failure is indistinguishable from a missing receipt — so the floor
 * has to be established before the comparison is built on it, not after.
 *
 * Two real processes, because the property is about a process boundary. The unit coverage for the
 * same sentence ("keeps it byte-identical when the row is read back by a new guard",
 * `tests/unit/ingress-turn-claim.test.ts`) constructs a second `IngressGuard` over the same live
 * `Db` handle: a value that never left memory passes it. And the write happens where production
 * writes — one owner message through `startDaemonTelegramListener` and `pollOnce` — not by calling
 * `claimTurn` directly, because a claim minted by a test is a claim no composition root had to
 * assemble, and the defect this test found was in the assembling.
 */
describe("a turn claim outlives the process that made it", () => {
  it("carries the same four values to a reader that opens the file after the writer is gone", () => {
    const claimed = runInItsOwnProcess<ClaimReport>("claim");
    try {
      // The writing process actually made a claim, and it is still outstanding: the handler
      // crashed before any reply, which is the state a reconciler after a restart looks at.
      expect(claimed.inProcessClaim).toBeTruthy();
      const written = claimed.inProcessClaim!;

      const observed = runInItsOwnProcess<ReadReport>(
        "read",
        claimed.databasePath,
        expectedSessionDigest(),
      );
      expect(observed.pid, "the reader ran in the writer's process").not.toBe(claimed.pid);

      // Found by the session digest alone, which is how a reconciler with only a conversation in
      // hand has to find it. An empty list here means the claim stored a digest of something
      // other than this conversation, or never reached the file at all.
      expect(observed.unresolved).toHaveLength(1);
      const read = observed.unresolved[0]!;

      // Each of the four named, not `toEqual` on the whole object: a row that lost one field
      // still compares equal to itself, and this is the test that has to notice one going
      // missing. Three are checked against values derived here from what the owner sent and what
      // the binding registry held, so the comparison is not the database against itself.
      expect(read["turnRequestId"]).toBe(written["turnRequestId"]);
      expect(read["turnRequestId"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(read["sessionDigest"]).toBe(expectedSessionDigest());
      expect(read["promptDigest"]).toBe(expectedPromptDigest());
      expect(read["bindingDigest"]).toBe(expectedBindingDigest(claimed.ceoGeneration));

      // The fourth field is the one #639 calls the fence, and until this change it was a
      // constant: `TelegramRouterOptions.bindingGeneration` was optional, defaulted to
      // `() => null`, and no composition root supplied it — so a turn claimed while a CEO was
      // bound at generation 1 stored exactly what a turn claimed with no CEO bound at all
      // stored. This is the assertion that separates them, and it is why the generation is read
      // from the binding registry in the writing process rather than taken from the claim.
      expect(claimed.ceoGeneration, "no CEO was bound, so the fence cannot be shown to move")
        .toBe(1);
      expect(read["bindingDigest"]).not.toBe(expectedBindingDigest(null));

      // And it is the claim of this message, in the claimed state.
      expect(read["nonce"]).toBe("update:4242");
      expect(read["deliveryStatus"]).toBe("TURN_CLAIMED");
    } finally {
      rmSync(claimed.root, { recursive: true, force: true });
    }
  }, 120_000);
});
