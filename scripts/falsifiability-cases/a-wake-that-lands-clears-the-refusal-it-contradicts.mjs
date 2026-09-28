/**
 * A wake that lands clears the refusal remembered before it.
 *
 * The memory exists so a holder whose endpoint takes no wake can be reported; it must not outlive
 * the fact it describes. A delivery that succeeds is the direct contradiction of one that failed on
 * the same registration, so it is where the memory ends -- along with a re-registration, which
 * replaces the fact rather than contradicting it. Without this the first refused wake would make a
 * holder permanently unwakeable in the report, and an operator would be sent to repair a binding
 * that had been receiving wakes for hours.
 *
 * The mutation keeps the memory across a successful delivery. The killing row puts a real listener
 * back behind the same path, sends a wake, requires the frame to arrive, and requires the report to
 * go quiet -- so it cannot pass on a report that says nothing to begin with.
 */
const aWakeThatLandsClearsTheRefusalItContradicts = {
  id: "a-wake-that-lands-clears-the-refusal-it-contradicts",
  what: "a wake the peer accepts clears the refusal remembered against that registration",
  file: "src/mcp/role-conversation.ts",
  find: "    // A wake that landed is the contradiction of an earlier one that did not, so the memory goes.\n    peer.wakeFailure = null;\n",
  replace: "    peer.wakeFailure = peer.wakeFailure;\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a holder whose registration still validates and whose wake was refused",
  ],
};

export default aWakeThatLandsClearsTheRefusalItContradicts;
