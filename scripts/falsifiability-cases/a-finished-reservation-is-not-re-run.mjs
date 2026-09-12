/**
 * #833 — a reservation that already carries a result is returned, not re-run.
 *
 * The mutation neuters the result check, so an expired slot with a stored result is taken over
 * and the mutation executes a second time. That is the exact failure idempotency exists to
 * prevent: the caller's retry ran the work twice and the second run's result is what it gets.
 *
 * The witness asserts both halves — the executor did not run, and the value returned is the
 * first call's. Asserting only the first would pass against a mutant that re-runs and discards.
 */
const aFinishedReservationIsNotReRun = {
  id: "a-finished-reservation-is-not-re-run",
  what: "a reservation that already carries a result is returned rather than re-run, so an expired slot does not re-execute a mutation that finished",
  file: "src/mcp/shared.ts",
  find: "!existing.result_json &&",
  replace: "true &&",
  killedBy: ["tests/unit/an-mcp-reservation-is-taken-over-by-its-own-actor.test.ts::returns the stored result instead of re-running a reservation that already finished"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aFinishedReservationIsNotReRun;
