/**
 * The claim socket is owner-only by mode, and this is the check that says the peer on it is this
 * daemon's own uid rather than merely someone who reached the path. Removing it admits any local
 * peer that can open the socket.
 *
 * `euid` is a parameter, so this also covers the platform where `process.geteuid` is absent: the
 * comparison against `undefined` can never match, and refusing is the fail-closed reading.
 */
const aClaimPeerRunsAsThisDaemon = {
  id: "a-claim-peer-runs-as-this-daemon",
  what: "a peer at a uid other than this daemon's own is refused, direct connection or not",
  file: "src/daemon/canonical-self-claim-listener.ts",
  // `if (false)` was the obvious mutation and it does not compile: TypeScript marks a statically
  // false block unreachable and stops narrowing into it, so `credentials.uid` on the line below
  // becomes "possibly null" (TS18047). Comparing the field with itself is false at runtime and
  // opaque to the checker, so the block stays reachable and the narrowing from the null guard
  // above survives — the guard is disabled, nothing else changes.
  find: "  if (credentials.uid !== euid) {\n",
  replace: "  if (credentials.uid !== credentials.uid) {\n",
  killedBy: [
    "tests/process/canonical-self-claim-listener-methods.test.ts::refuses a peer at a different uid, even when it is a direct connection",
  ],
};

export default aClaimPeerRunsAsThisDaemon;
