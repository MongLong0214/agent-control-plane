/**
 * #627. The composition half of the unsigned-policy property: a listener that binds its socket
 * first and discovers the missing secret per-message would already be reachable, and its refusals
 * would be a runtime behaviour rather than a deployment fact. `startBuzzActorIngressListener`
 * refuses at construction for that reason, and the message listener does the same.
 *
 * Deleting the throw opens `buzz-message.ingress.sock` on a policy that cannot verify anything.
 * Nothing else in the listener would notice: the guard is constructed, the socket is chmod 0600,
 * the daemon prints "Buzz message ingress started", and the deployment looks correct.
 *
 * The class-level refusal (`buzz-message-on-an-unsigned-policy-reaches-nobody`) does not cover
 * this: it would still refuse each message, but only after the daemon had advertised a working
 * ingress. These are two callers, not one property checked twice.
 *
 * A row on a path being built, not on a defect that shipped — see
 * `buzz-event-not-addressed-to-the-ceo-is-not-a-turn` for why that distinction lives in prose.
 */
const buzzMessageSocketDoesNotOpenUnsigned = {
  id: "buzz-message-socket-does-not-open-unsigned",
  what: "the Buzz message listener refuses to open on a policy with no signing secret",
  file: "src/daemon/agentcpd.ts",
  find: "    throw new Error(\"Buzz message ingress requires a non-empty signing secret\");\n",
  replace: "",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses to open a message socket on a policy with no signing secret",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzMessageSocketDoesNotOpenUnsigned;
