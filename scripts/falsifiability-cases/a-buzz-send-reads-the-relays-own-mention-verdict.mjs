/**
 * #760. Exit 0 means the relay stored the event; it does not mean the relay notified the
 * identities the message named. The relay reports which mentions it resolved and this is the
 * line that reads it — deleting the check restores the state where the two facts are one.
 */
const aBuzzSendReadsTheRelaysOwnMentionVerdict = {
  id: "a-buzz-send-reads-the-relays-own-mention-verdict",
  what: "a recipient the relay did not resolve fails the send rather than passing as accepted",
  file: "src/buzz/buzz-adapter.ts",
  find: "    if (unresolved.length > 0) {\n      throw acpError(\n        ReasonCode.BUZZ_MENTION_NOT_RESOLVED,\n        `buzz relay did not resolve ${unresolved.length} recipient(s) on ${channel}`,\n        { channel, unresolved, resolved: receipt.mentionPubkeys, eventId: receipt.eventId },\n      );\n    }\n    return receipt;",
  replace: "    if (false) {\n      throw acpError(\n        ReasonCode.BUZZ_MENTION_NOT_RESOLVED,\n        `buzz relay did not resolve ${unresolved.length} recipient(s) on ${channel}`,\n        { channel, unresolved, resolved: receipt.mentionPubkeys, eventId: receipt.eventId },\n      );\n    }\n    return receipt;",
  killedBy: [
    "tests/unit/buzz-cli-surface.test.ts::fails the send when the relay did not resolve a recipient it was given",
  ],
};

export default aBuzzSendReadsTheRelaysOwnMentionVerdict;
