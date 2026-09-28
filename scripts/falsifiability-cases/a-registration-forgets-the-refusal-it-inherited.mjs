/**
 * A registration clears the wake refusal the previous registration earned, before sending its own.
 *
 * The rule the surrounding doc states: a refusal is remembered *for the registration that earned
 * it*. A registration is a new fact about where to knock, so a refusal carried across one would
 * outlive the fact it describes -- a holder that rebound and registered again would be reported
 * unwakeable, and an operator told to restart it, on the strength of a delivery to the process
 * before it.
 *
 * Why the row observes from inside a registration rather than after one: `registerEndpoint` ends by
 * sending one unconditional wake, and that wake's outcome sets or clears the same field. After the
 * method returns, the memory describes that registration's own delivery whether or not the earlier
 * one was forgotten, so no post-registration observation can distinguish the two. The killing row
 * takes its reading from the listener the wake is being delivered to, which is inside the window:
 * measured 200/200 on this platform, a unix listener's `connection` event is emitted before
 * `socket.end(frame, cb)` calls back, and the wake resolves in that callback. (The `data` event is
 * the one that lands after the resolution, which is why the row beside it has to poll for the frame.)
 *
 * The mutation deletes the clearing and leaves the comment that describes it. The killing row earns
 * a refusal on an abandoned socket, rebinds the same path, registers again, and requires the port to
 * report nothing about the holder at the moment the new registration's wake arrives.
 */
const aRegistrationForgetsTheRefusalItInherited = {
  id: "a-registration-forgets-the-refusal-it-inherited",
  what: "a registration forgets the wake refusal an earlier registration earned, so no holder is reported unwakeable for a delivery to the process before it",
  file: "src/mcp/role-conversation.ts",
  find:
    "      // `a-registration-forgets-the-refusal-it-inherited`.\n" +
    "      peer.wakeFailure = null;\n",
  replace: "      // `a-registration-forgets-the-refusal-it-inherited`.\n",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::forgets the refusal an earlier registration earned, before its own wake decides anything",
  ],
};

export default aRegistrationForgetsTheRefusalItInherited;
