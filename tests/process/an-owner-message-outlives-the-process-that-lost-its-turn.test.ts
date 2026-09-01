import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  expectedSessionDigest,
  runInItsOwnProcess,
  MESSAGE_ID,
  PROMPT,
  UPDATE_ID,
  type LoseReport,
  type NextMessageReport,
  type RecoverReport,
  type RedeliverReport,
} from "./fixtures/an-owner-message-across-a-restart.ts";

/**
 * #631: an inbound update is persisted before the offset advances — the *update*, not only its
 * key.
 *
 * Before this, `inbound_messages` held a nonce, an actor, a timestamp, a reply lifecycle and a
 * turn claim, and nothing that says what the owner wrote. The only copy of the words was
 * Telegram's, and the restart path spends it: a redelivered update whose turn is unresolved is
 * refused `INGRESS_TURN_OUTCOME_UNKNOWN`, `deniedOrReplay` returns `reply: null`, and the poller
 * calls `completeUpdate` on it — which advances the offset, which is how ACP tells Telegram to
 * drop it. No answer was sent and no copy was kept, so the owner's message becomes
 * indistinguishable from one they never wrote. That is this issue's headline sentence, reached
 * through the restart rather than through the offset outrunning a running turn — #630's ordered
 * queue closed the second route and left this one, which is what its own comment says.
 *
 * Three real processes, because that is the boundary: the first dies holding a claim, the second
 * is the daemon coming back up and spending Telegram's copy, and the third asks the file alone
 * what is left. An in-process rehearsal of the same sentence cannot fail — the words are still in
 * a variable.
 */
describe("an owner message outlives the process that lost its turn", () => {
  it("keeps the owner's own words readable from the file after Telegram's copy is spent", () => {
    const lost = runInItsOwnProcess<LoseReport>("lose");
    try {
      // The dying process really did take the turn: this is the mid-turn state, not a message
      // that was never admitted.
      expect(lost.claimed, "the first process left no claim, so nothing was interrupted").toBe(true);

      const restarted = runInItsOwnProcess<RedeliverReport>("redeliver", lost.root);
      expect(restarted.pid, "the restart ran in the dead process").not.toBe(lost.pid);

      // The restart tells the owner nothing and confirms the update away in the same poll. Both
      // halves are asserted: an offset that advanced while a reply was sent would be an answer,
      // and a silent poll that held the offset would still have Telegram's copy.
      expect(restarted.sent, "the restart answered the owner").toEqual([]);
      expect(
        restarted.offsetAfter,
        "the restart held the offset, so Telegram still has the owner's message",
      ).toBe(UPDATE_ID + 1);

      // Telegram's copy is gone. Everything the owner said now has to come out of the file.
      const recovered = runInItsOwnProcess<RecoverReport>(
        "recover",
        lost.databasePath,
        expectedSessionDigest(),
      );
      expect(recovered.pid, "the reader ran in the writer's process").not.toBe(lost.pid);
      expect(recovered.unresolved, "the turn is not outstanding, so there is nothing to recover")
        .toHaveLength(1);

      // The claim survives — #639 established that — but a claim is a digest and an id. Neither
      // can be read back to a person or re-run as a turn. This is the assertion that separates
      // "we know a turn was lost" from "we still have what it was."
      expect(recovered.recoveredText).toBe(PROMPT);
      expect(recovered.recoveredMessageId).toBe(MESSAGE_ID);

      // And the persisted copy is load-bearing on the production path, not a column nobody reads:
      // the next thing the owner sends is parked, and the park names the message that was lost.
      const parked = runInItsOwnProcess<NextMessageReport>("next-message", lost.root);
      expect(parked.sent).toHaveLength(1);
      expect(parked.sent[0]).toContain(PROMPT);
    } finally {
      rmSync(lost.root, { recursive: true, force: true });
    }
  }, 180_000);
});
