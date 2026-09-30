/**
 * A holder whose registered endpoint refused the wake it was sent is reported unwakeable.
 *
 * Every check `wake` makes before it connects is a filesystem answer, and a unix socket file
 * outlives the process that bound it: the path is there, it is a socket, this uid owns it, its
 * directory is owner-only -- and the connect is refused because nothing is listening. Both
 * reviewers reproduced the gap, with `wake` answering ROLE_PEER_FAILED for a holder this scan
 * called wakeable, which is the #674 shape again: a binding reading ACTIVE while its messages wait
 * for a delivery that cannot happen.
 *
 * The fix is deliberately not a probe. Dialling every holder's socket from a scan that runs on
 * every doctor refresh would put a side-effecting connect to a peer's messaging socket on an
 * automatic path; instead the failure of a wake the daemon was sending anyway is remembered against
 * the registration that earned it. So this reports a delivery that *failed*, never one that would
 * fail, and the mutation is the state before that was reported at all.
 *
 * The killing row makes the state the way a client that exited without cleaning up makes it -- a
 * separate process binds the socket and is killed uncatchably -- registers it through the port, and
 * requires the holder to be named with this cause while `wake` refuses it.
 */
const aWakeThatWasRefusedIsReported = {
  id: "a-wake-that-was-refused-is-reported",
  what: "the CTO port reports a holder whose registered endpoint passes every check and refused the wake it was sent",
  file: "src/mcp/role-conversation.ts",
  find: '    return peer.wakeFailure !== null ? "registered-endpoint-refused-the-wake" : null;\n',
  replace: "    return null;\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a holder whose registration still validates and whose wake was refused",
  ],
};

export default aWakeThatWasRefusedIsReported;
