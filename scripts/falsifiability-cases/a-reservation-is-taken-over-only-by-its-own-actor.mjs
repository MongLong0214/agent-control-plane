/**
 * #833 — an expired MCP reservation is taken over only by the actor that made it.
 *
 * An idempotency key reserves a `(mcp, nonce)` slot before the mutation runs, so a retry of a
 * call that never returned does not run it twice. The slot expires, because a caller that
 * vanished would otherwise hold it forever — and this operand is what keeps expiry from turning
 * the slot into a free-for-all.
 *
 * The mutation neuters the actor comparison. A second peer presenting another peer's key then
 * takes over its expired reservation and runs the mutation under its own authority; the refusal
 * that exists for it, `MCP_PEER_UNAUTHENTICATED`, becomes unreachable.
 *
 * Neutered to `true &&` rather than deleted so `existing` and `peer` stay used and the mutant
 * type-checks.
 */
const aReservationIsTakenOverOnlyByItsOwnActor = {
  id: "a-reservation-is-taken-over-only-by-its-own-actor",
  what: "an expired MCP reservation is taken over only by the actor that made it, so one peer cannot complete another's reserved mutation",
  file: "src/mcp/shared.ts",
  find: "existing.actor === peer.actor &&",
  replace: "true &&",
  killedBy: ["tests/unit/an-mcp-reservation-is-taken-over-by-its-own-actor.test.ts::refuses a different actor holding the same key, expired or not"],
};
// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aReservationIsTakenOverOnlyByItsOwnActor;
