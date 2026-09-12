/**
 * #833 — expiry is the stated TTL elapsing, not merely two parsable timestamps.
 *
 * `reservationExpired` is `isFinite(a) && isFinite(b) && b - a >= TTL`. The mutation removes the
 * comparison, leaving the two parse checks — so any reservation with valid timestamps reads as
 * expired, which is every real one.
 *
 * This row and `a-live-reservation-is-not-taken-over` are killed by the same witness and that is
 * correct: they are two operands on one path, and the smallest input that distinguishes either
 * from its neighbours is a reservation one millisecond short of its TTL.
 *
 * The two `Number.isFinite` operands beside it carry a written reason instead. `NaN - x >= TTL`
 * is already false, so removing either changes no outcome — measured, not assumed.
 */
const aReservationExpiresOnItsStatedTtl = {
  id: "a-reservation-expires-on-its-stated-ttl",
  what: "expiry is the stated TTL elapsing, not merely two parsable timestamps",
  file: "src/mcp/shared.ts",
  find: "nowMs - reservedAtMs >= MCP_RESERVATION_TTL_MS",
  replace: "true",
  killedBy: ["tests/unit/an-mcp-reservation-is-taken-over-by-its-own-actor.test.ts::refuses a retry one millisecond before the reservation expires"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aReservationExpiresOnItsStatedTtl;
