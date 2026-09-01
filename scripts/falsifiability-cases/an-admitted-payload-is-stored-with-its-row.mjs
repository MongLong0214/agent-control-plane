/**
 * #631 — the sender's own words go down in the INSERT that admits the message.
 *
 * The mutation stores a null instead, which is exactly the state before this change:
 * `inbound_messages` held a message's key, its reply's delivery and its turn's claim, and nothing
 * that *is* the message. For Telegram that leaves the transport as the sole custodian of the
 * owner's words, and the restart path spends that copy — a redelivered update whose turn is
 * unresolved is refused with a null reply, the poller settles it, and settling advances the offset,
 * which is how ACP tells Telegram to drop it. Nothing answered, nothing kept.
 *
 * Killed by a test that runs three real processes: only the third, reading the file with the
 * writer gone, can tell a stored payload from a variable that never left memory.
 */
const anAdmittedPayloadIsStoredWithItsRow = {
  id: "an-admitted-payload-is-stored-with-its-row",
  what: "the admitted payload is written by the same statement that admits the message, so a process that dies mid-turn still leaves the sender's words on disk",
  file: "src/ingress/ingress-guard.ts",
  find: "        JSON.stringify(request.payload ?? null),\n",
  replace: "        null,\n",
  killedBy: [
    "tests/process/an-owner-message-outlives-the-process-that-lost-its-turn.test.ts::keeps the owner's own words readable from the file after Telegram's copy is spent",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anAdmittedPayloadIsStoredWithItsRow;
