/**
 * The wake transport admits a set of client **builds**, and membership is two comparisons: the
 * vendor name and the version. Only the second one carries the claim the set's own comment makes —
 * that a newer client is *unqualified*, not *newer than qualified*.
 *
 * Re-derived at the membership predicate, `isWakeTransportQualified`, when the single pinned build
 * became a set: `registerEndpoint` no longer compares against one constant but asks that predicate,
 * so the version half of the comparison moved there, and the reason for this row did not change.
 * Deleting it is still silent everywhere it is ordinarily exercised. Every peer that arrives
 * unqualified in the socket suite arrives under a different name as well, so the name comparison
 * refuses it on its own and the version comparison is never the reason for anything. Measured on
 * 2026-09-07 at the old site: with that disjunct removed, every row in
 * `the-cto-socket-has-a-live-peer.test.ts` stayed green except this one, and so did the two other
 * files that put a role peer on a socket.
 *
 * The killing row is the one that presents the qualified vendor at a build that extends a member's
 * version and expects `ROLE_PEER_UNSUPPORTED` with `presented`/`qualified` evidence — the pair only
 * the membership branch emits, so the assertion cannot be satisfied by any of the path checks that
 * share the reason code. Its earlier refusal, of a peer whose *name* is also wrong, is the positive
 * control: it shows membership refuses at all, and this row shows what it refuses on.
 */
const theWakePinNamesABuildNotAVendor = {
  id: "the-wake-pin-names-a-build-not-a-vendor",
  what: "a wake endpoint is refused for the qualified vendor at a build outside the qualified set",
  file: "src/mcp/role-conversation.ts",
  find: "member.name === client.name && member.version === client.version",
  replace: "member.name === client.name",
  killedBy: [
    "tests/unit/the-cto-socket-has-a-live-peer.test.ts::takes a wake endpoint only where it can establish the path for itself, from a qualified client",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theWakePinNamesABuildNotAVendor;
