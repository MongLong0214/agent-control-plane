/**
 * #833 — a reservation that has not expired is refused.
 *
 * The mutation makes every reservation look expired. A retry arriving while the first call is
 * still in flight then runs the mutation concurrently with it, which is worse than running it
 * twice in sequence: the two share the slot they were each meant to hold exclusively.
 *
 * Witnessed one millisecond before the TTL, so the case distinguishes "expired" from "nearly
 * expired" rather than from "fresh".
 */
const aLiveReservationIsNotTakenOver = {
  id: "a-live-reservation-is-not-taken-over",
  what: "a reservation that has not expired is refused, so a retry cannot run concurrently with a call still in flight",
  file: "src/mcp/shared.ts",
  find: "reservationExpired(existing.received_at, receivedAt)",
  replace: "true",
  killedBy: ["tests/unit/an-mcp-reservation-is-taken-over-by-its-own-actor.test.ts::refuses a retry one millisecond before the reservation expires"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aLiveReservationIsNotTakenOver;
