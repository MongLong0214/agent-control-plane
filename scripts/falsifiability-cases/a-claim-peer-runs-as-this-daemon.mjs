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
  find: "  if (credentials.uid !== euid) {\n",
  replace: "  if (false) {\n",
  killedBy: [
    "tests/process/canonical-self-claim-listener-methods.test.ts::refuses a peer at a different uid, even when it is a direct connection",
  ],
};

export default aClaimPeerRunsAsThisDaemon;
