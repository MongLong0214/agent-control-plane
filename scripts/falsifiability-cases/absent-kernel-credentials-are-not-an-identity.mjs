/**
 * Absence of an identity is not a weak identity. `derivePeerCredentialsFromSocket` answers `null`
 * when the socket has no raw fd or the kernel refuses the lookup, and admitting on that would hand
 * the claim socket's one identity check to whatever could make the lookup fail.
 *
 * The mutation admits with a fabricated peer rather than deleting the branch, because deleting it
 * does not typecheck — `credentials` is `PeerCredentials | null` and everything below narrows on
 * this line. Admitting is also the shape the defect would actually take.
 */
const absentKernelCredentialsAreNotAnIdentity = {
  id: "absent-kernel-credentials-are-not-an-identity",
  what: "a peer whose kernel credentials could not be read is refused, never admitted as an unknown",
  file: "src/daemon/canonical-self-claim-listener.ts",
  find:
    "  if (credentials === null) {\n" +
    "    return deny(\n" +
    "      ReasonCode.OPERATOR_UNAUTHENTICATED,\n" +
    '      "the connecting peer\'s kernel credentials could not be established",\n' +
    "      {},\n" +
    "    );\n" +
    "  }\n",
  replace:
    "  if (credentials === null) {\n" +
    "    return allow(ReasonCode.OK, { peerPid: 0, uid: 0 });\n" +
    "  }\n",
  killedBy: [
    "tests/process/canonical-self-claim-listener-methods.test.ts::refuses a peer whose kernel credentials could not be established",
  ],
};

export default absentKernelCredentialsAreNotAnIdentity;
