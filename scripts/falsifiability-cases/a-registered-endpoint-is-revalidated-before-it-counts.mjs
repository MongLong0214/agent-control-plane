/**
 * An endpoint that has stopped passing the checks `wake` makes is not a holder that can be woken.
 *
 * `wake` revalidates the registered path immediately before it connects -- the socket must still be
 * a socket this uid owns, directly inside a state directory that is still owner-only and still not
 * a symlink -- and refuses when it does not. A scan that asked only whether *some* endpoint had
 * been registered would call that holder wakeable while every wake to it is refused, which is the
 * same silence the qualified-build early return produced, one step further along.
 *
 * The mutation accepts any registration, however old. The killing row registers a real socket, sees
 * the holder reported as wakeable, removes the socket, and requires the report to name it -- with
 * the port's own `wake` refusing the same holder, so the row is anchored to the state that actually
 * blocks a delivery rather than to a filesystem detail.
 */
const aRegisteredEndpointIsRevalidatedBeforeItCounts = {
  id: "a-registered-endpoint-is-revalidated-before-it-counts",
  what: "the CTO port reports a holder whose registered wake endpoint no longer passes the checks a wake makes",
  file: "src/mcp/role-conversation.ts",
  find: '    if (!this.#validateEndpointPath(endpoint).allowed) return "registered-endpoint-not-usable";\n',
  replace: "",
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a registered endpoint that has stopped being usable, which is the state a wake would refuse",
  ],
};

export default aRegisteredEndpointIsRevalidatedBeforeItCounts;
