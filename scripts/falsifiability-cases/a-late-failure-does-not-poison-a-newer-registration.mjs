/**
 * A wake that fails after the holder registered again writes nothing about the new registration.
 *
 * The reverse of the erasure, and the direction an endpoint string cannot separate at all: a holder
 * that rebinds the *same* pathname and registers again produces a live registration whose endpoint
 * equals the one the earlier delivery failed against. Both reviewers reproduced it -- a working
 * registration reported as one the endpoint refused, on the strength of a delivery to the process
 * before it, which sends an operator to repair a binding that is taking wakes.
 *
 * The mutation writes the failure whenever it arrives. The killing row registers the same path
 * twice, completes the second registration's wake successfully, then refuses the first's, and
 * requires the report to stay quiet; the control row requires a refusal under the registration in
 * force to still be reported.
 */
const aLateFailureDoesNotPoisonANewerRegistration = {
  id: "a-late-failure-does-not-poison-a-newer-registration",
  what: "a wake that is refused is remembered only against the registration it was sent under",
  file: "src/mcp/role-conversation.ts",
  find:
    "      if (peer.registration === registration) {\n" +
    "        peer.wakeFailure = { registration, shape: (failure as WakeFailure).shape };\n" +
    "      }\n",
  replace: "      peer.wakeFailure = { registration, shape: (failure as WakeFailure).shape };\n",
  killedBy: [
    "tests/unit/a-late-wake-belongs-to-the-registration-it-began-under.test.ts::a failure completing after a later registration of the same path does not poison it",
  ],
};

export default aLateFailureDoesNotPoisonANewerRegistration;
