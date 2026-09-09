/**
 * #627. The CEO's Buzz room is not owner-exclusive — `run-ceo-bridge.sh` puts the orchestrator in
 * it — and SSOT §114 records that a CEO↔CTO exchange there is the *journal* of a conversation
 * that already happened, not a second CEO turn. An ingress that turned every admitted room event
 * into a user turn would therefore re-inject ACP's own traffic as new questions, which is a loop
 * the owner's canonical transcript cannot be unwound from.
 *
 * So the recipient is part of the signed envelope: the relay has to say, under the shared secret,
 * that this event was addressed to the CEO, and anything else is refused *before* admission — so
 * a journal event does not even consume a nonce.
 *
 * Removing the recipient branch admits an event addressed to the CTO and delivers it as
 * a CEO turn, which is the loop above in one message.
 *
 * This row and the seven beside it guard a path that is being *built* rather than one that broke:
 * the deployed Buzz bridge answers the owner by spawning `hermes acp` as a session child, and
 * #627 replaces it. `ALLOWED_FIELDS` has no place to say which of those two a row is, so it is
 * said here, where the row's only reader is looking.
 */
const buzzEventNotAddressedToTheCeoIsNotATurn = {
  id: "buzz-event-not-addressed-to-the-ceo-is-not-a-turn",
  what: "a Buzz event the relay did not address to the CEO does not become a CEO turn",
  file: "src/ingress/buzz-message.ts",
  // Remove the whole recipient branch; an unreachable body loses its local narrowing too.
  find: "    if (input.addressedTo !== BUZZ_MESSAGE_RECIPIENT_CEO) {\n" +
    "      // Role-addressed, so the `p` tag is the address and there is no second place to look. The\n" +
    "      // five ways it can fail to be one are one outcome to the sender and one journal row each:\n" +
    "      // an absent tag is not \"therefore the CEO\", because reading it that way would hand a\n" +
    "      // message meant for some role to the owner's own conversation.\n" +
    "      const presented = input.mention;\n" +
    "      const mention = typeof presented === \"string\" ? presented.trim() : \"\";\n" +
    "      const candidates = mention.length === 0 ? [] : [...new Set(this.router.rolesFor(mention))];\n" +
    "      const roleKey = candidates.length === 1 ? candidates[0] : undefined;\n" +
    "      if (roleKey === undefined) {\n" +
    "        const shape: UnboundMentionShape =\n" +
    "          presented === undefined || presented === null\n" +
    "            ? \"missing\"\n" +
    "            : typeof presented !== \"string\"\n" +
    "              ? \"not-a-string\"\n" +
    "              : mention.length === 0\n" +
    "                ? \"blank\"\n" +
    "                : candidates.length === 0\n" +
    "                  ? \"unknown\"\n" +
    "                  : \"ambiguous\";\n" +
    "        // The one journal row B4 asks for, written here because this is the only place that\n" +
    "        // knows both the tag and what it resolved to, and after this point there is nothing left\n" +
    "        // to record: no turn is claimed and nothing is sent to anyone.\n" +
    "        this.router.journalUnbound({\n" +
    "          actor: input.actor,\n" +
    "          conversation: input.conversation,\n" +
    "          eventId: input.eventId,\n" +
    "          mention,\n" +
    "          candidates,\n" +
    "          shape,\n" +
    "        });\n" +
    "        return deny(\n" +
    "          ReasonCode.MENTION_TARGET_UNBOUND,\n" +
    "          \"the mentioned buzz channel identity does not name exactly one role this daemon can address\",\n" +
    "          { channel: \"buzz\", target: mention, candidates: candidates.length, shape },\n" +
    "        );\n" +
    "      }\n" +
    "      return allow(ReasonCode.OK, { kind: \"ROLE\", roleKey });\n" +
    "    }\n",
  replace: "",
  killedBy: [
    "tests/unit/buzz-message-ingress.test.ts::refuses a forged signature, a channel identity that is not allowlisted, and a message not addressed to the CEO",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default buzzEventNotAddressedToTheCeoIsNotATurn;
