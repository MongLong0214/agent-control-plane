/**
 * #760 Q2. `roleKey` is the sole argument of `role_owner_message_claim`, `_complete` and
 * `_reject`, and it is a **lookup key**: it selects a slot and asserts nothing about the caller.
 * `#holderFor` is where that stays true, and `peer.server === server` is the line that makes it
 * so — everything else in the method is derived from the slot the key selected, not from the
 * connection the request arrived on.
 *
 * Deleting it is silent in every ordinary run. A connection asking for its own role still resolves
 * its own slot, `authenticate()` still succeeds, `#isCurrentHolder` still agrees with the registry,
 * and the claim still works. What changes is only the case where the key names somebody else's
 * slot: the authenticator consulted is then the *other* peer's, so the caller is handed an identity
 * it never authenticated as, and the lookup key has quietly become an address into another
 * runtime's queue.
 *
 * The killing row is the one that puts two projects and two sessions on one socket and has S1 name
 * B's key while B's own holder is attached — the only arrangement in which the two branches of this
 * method disagree. Its earlier assertion, that the same call is `ROLE_PEER_ABSENT` before B has a
 * peer, is the positive control: the refusal below is about who asked, not about B being absent.
 */
const anOwnerMessageHolderIsTheConnectionThatAsked = {
  id: "an-owner-message-holder-is-the-connection-that-asked",
  what: "the holder behind a claim, completion or rejection is the connection it arrived on",
  file: "src/mcp/role-conversation.ts",
  find:
    "    if (peer.server !== server) {\n" +
    "      return deny(\n" +
    "        ReasonCode.ROLE_PEER_STALE,\n" +
    '        "this connection is not the live peer of the role it named",\n' +
    "        { role: this.#role, roleKey },\n" +
    "      );\n" +
    "    }\n",
  replace: "",
  killedBy: [
    "tests/unit/the-cto-socket-has-a-live-peer.test.ts::does not let one session's connection hold the slot of a project another session is CTO of",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anOwnerMessageHolderIsTheConnectionThatAsked;
