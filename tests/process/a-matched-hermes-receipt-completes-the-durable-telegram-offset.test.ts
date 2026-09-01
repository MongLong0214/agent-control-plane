import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  UPDATE_ID,
  type LostReport,
  type RestartReport,
  runInItsOwnProcess,
} from "./fixtures/a-hermes-receipt-across-a-restart.ts";

/**
 * The original process has already crossed the direct-handler boundary, so a restart may not run
 * it again. The only completion this lane accepts is the production HermesReceiptPort's terminal
 * result for the immutable ingress turn identity. A result absent, malformed, or attesting to a
 * different turn/runtime is not a weaker kind of success: it leaves Telegram's ordered update
 * unacknowledged for the next reconciliation attempt.
 */
describe("a matched Hermes receipt completes the durable Telegram offset", () => {
  it("advances the exact redelivered update once and holds every unverified result", () => {
    const lost = runInItsOwnProcess<LostReport>("claim");
    try {
      expect(lost.directCalls, "the first process did not cross the handler boundary").toBe(1);
      expect(lost.turnRequestId, "the durable claim has no canonical turn identity").toEqual(expect.any(String));

      const matched = runInItsOwnProcess<RestartReport>("restart", lost.root, "matching");
      expect(matched.pid).not.toBe(lost.pid);
      expect(matched.executorCalls, "the restart did not ask Hermes for the claimed turn").toBe(1);
      expect(matched.directCalls, "a matched receipt re-executed the owner turn").toBe(0);
      expect(matched.noReplyAt, "the receipt did not settle the durable ingress event").toEqual(expect.any(String));
      expect(matched.receiptId).toBe("receipt:matching");
      expect(matched.offsetAfter, "the matched receipt did not release the ordered update").toBe(UPDATE_ID + 1);
      expect(matched.offsetsRequested).toEqual([null, UPDATE_ID + 1]);

      for (const mode of ["missing", "wrong-turn", "wrong-runtime", "corrupt"] as const) {
        const negativeLost = runInItsOwnProcess<LostReport>("claim");
        try {
          const restarted = runInItsOwnProcess<RestartReport>("restart", negativeLost.root, mode);
          expect(restarted.executorCalls, `${mode} did not reach the authenticated receipt boundary`).toBe(1);
          expect(restarted.directCalls, `${mode} re-executed a possibly committed turn`).toBe(0);
          expect(restarted.noReplyAt, `${mode} settled an unverified ingress event`).toBeNull();
          expect(restarted.receiptId, `${mode} wrote a receipt into the durable claim`).toBeNull();
          expect(restarted.offsetAfter, `${mode} advanced Telegram past an unresolved turn`).toBeNull();
          expect(restarted.offsetsRequested).toEqual([null, null]);
        } finally {
          rmSync(negativeLost.root, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(lost.root, { recursive: true, force: true });
    }
  }, 180_000);
});
