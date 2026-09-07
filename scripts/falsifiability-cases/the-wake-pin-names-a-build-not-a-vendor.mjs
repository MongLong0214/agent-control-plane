/**
 * The wake transport is pinned to one client **build**, and the pin is two comparisons: the
 * vendor name and the version. Only the second one carries the claim the constant's own comment
 * makes — that a newer client is *unqualified*, not *newer than qualified*.
 *
 * Deleting the version half is silent everywhere it is ordinarily exercised. Every peer that
 * arrives unqualified in the suite arrives under a different name as well, so `name !== ...`
 * refuses it on its own and the version comparison is never the reason for anything. Measured
 * on 2026-09-07: with that disjunct removed, every row in `the-cto-socket-has-a-live-peer.test.ts`
 * stayed green, and so did the two other files that put a role peer on a socket.
 *
 * The killing row is the one that presents the qualified vendor at a build the pin does not name
 * and expects `ROLE_PEER_UNSUPPORTED` with `presented`/`qualified` evidence — the pair only the
 * pin branch emits, so the assertion cannot be satisfied by any of the path checks that share the
 * reason code. Its earlier refusal, of a peer whose *name* is also wrong, is the positive control:
 * it shows the pin refuses at all, and this row shows what it refuses on.
 */
const theWakePinNamesABuildNotAVendor = {
  id: "the-wake-pin-names-a-build-not-a-vendor",
  what: "a wake endpoint is refused for the qualified vendor at an unqualified build",
  file: "src/mcp/role-conversation.ts",
  find: "    if (client?.name !== C0_QUALIFIED_CLIENT.name || client.version !== C0_QUALIFIED_CLIENT.version) {\n",
  replace: "    if (client?.name !== C0_QUALIFIED_CLIENT.name) {\n",
  killedBy: [
    "tests/unit/the-cto-socket-has-a-live-peer.test.ts::takes a wake endpoint only where it can establish the path for itself, from a qualified client",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default theWakePinNamesABuildNotAVendor;
