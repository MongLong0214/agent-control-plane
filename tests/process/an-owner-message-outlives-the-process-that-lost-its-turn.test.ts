import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  expectedSessionDigest,
  runInItsOwnProcess,
  MESSAGE_ID,
  PROMPT,
  type BatchCrashReport,
  type BatchReceiptReport,
  type BatchRetryReport,
  type LoseReport,
  type NextMessageReport,
  type RecoverReport,
  type RedeliverReport,
} from "./fixtures/an-owner-message-across-a-restart.ts";

/**
 * A redelivered update whose earlier claimed turn has no governed completion is not a replay that
 * the poller may acknowledge away. `deniedOrReplay` intentionally returns no reply for
 * `INGRESS_TURN_OUTCOME_UNKNOWN`: sending an apology would incorrectly turn an unknown CEO turn
 * into an answer. The poller must therefore hold Telegram's offset as well — otherwise the
 * restarted process has silently spent the only transport copy before any matched completion.
 *
 * Three real processes make the restart boundary observable: the first dies holding the claim,
 * the second polls the same update, and the third proves the durable inbox still identifies it.
 */
describe("an owner message outlives the process that lost its turn", () => {
  it("holds Telegram's copy when restart finds an unresolved governed turn", () => {
    const lost = runInItsOwnProcess<LoseReport>("lose");
    try {
      // The dying process really did take the turn: this is the mid-turn state, not a message
      // that was never admitted.
      expect(lost.claimed, "the first process left no claim, so nothing was interrupted").toBe(true);

      const restarted = runInItsOwnProcess<RedeliverReport>("redeliver", lost.root);
      expect(restarted.pid, "the restart ran in the dead process").not.toBe(lost.pid);

      // The restart sends no answer and does not confirm the update away. The unresolved claim
      // has no matched governed completion, so either action would silently close an unknown turn.
      expect(restarted.sent, "the restart answered the owner").toEqual([]);
      expect(
        restarted.offsetAfter,
        "the restart advanced the offset without a governed completion",
      ).toBeNull();

      // The durable inbox still identifies the unresolved turn, including its original payload.
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

  it("keeps a claimed batch durable and refuses to execute it again after restart", () => {
    const crashed = runInItsOwnProcess<BatchCrashReport>("batch-crash");
    try {
      expect(crashed.consumedIds).toEqual(["update:4252", "update:4253", "update:4254"]);
      expect(crashed.unconsumedIds).toEqual([]);
      expect(crashed.claimedRows).toBe(3);
      expect(crashed.renderedBatch).toBe([
        "[1/3 update_id=4252 message_id=52]",
        "batch-parked-4252",
        "",
        "[2/3 update_id=4253 message_id=53]",
        "batch-parked-4253",
        "",
        "[3/3 update_id=4254 message_id=54]",
        "batch-current",
      ].join("\n"));

      const retried = runInItsOwnProcess<BatchRetryReport>("batch-retry", crashed.root);
      expect(retried.pid).not.toBe(crashed.pid);
      expect(retried.executions, "the restarted process ran the already-claimed batch again").toBe(0);
      expect(retried.claimedRows).toBe(3);
      expect(retried.distinctTurnRequestIds).toBe(1);
      expect(retried.consumedIds).toEqual(crashed.consumedIds);
      expect(retried.pendingIds, "consumed items were reattached to a later batch").toEqual([]);
      expect(retried.offsetAfter, "retry acknowledged an outcome-unknown claimed batch").toBeNull();
    } finally {
      rmSync(crashed.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("fans an authenticated receipt out to every consumed batch member across a restart", () => {
    const crashed = runInItsOwnProcess<BatchCrashReport>("batch-crash");
    try {
      const receipt = runInItsOwnProcess<BatchReceiptReport>("batch-receipt", crashed.root);
      expect(receipt.pid).not.toBe(crashed.pid);
      expect(receipt.completedRows).toBe(3);
      expect(receipt.receiptRows).toBe(3);
      expect(receipt.noReplyRows).toBe(3);
      expect(receipt.otherTurnHasReceipt).toBe(false);
      expect(receipt.duplicateReasonCode).toBe("INGRESS_REPLAY_IGNORED");
      expect(receipt.pendingIds).toEqual([]);

      const replay = runInItsOwnProcess<BatchRetryReport>("batch-retry", crashed.root);
      expect(replay.executions).toBe(0);
      expect(replay.pendingIds).toEqual([]);
    } finally {
      rmSync(crashed.root, { recursive: true, force: true });
    }
  }, 180_000);
});
