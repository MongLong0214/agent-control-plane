/**
 * #833 - the ERROR half of the terminal-lifecycle refusal in `verifySecret`.
 *
 * ERROR is the reachable one in an outage: the runtime dies, `fenceUndeliveredMessages` runs, and
 * a successor binds. Removing this operand leaves the STOPPED test, so the crashed session's
 * secret still authenticates, and the takeover the fence exists to make safe gains a second
 * authenticated speaker for the role.
 *
 * Its sibling `a-stopped-session-does-not-authenticate` removes the other half; both are on one
 * line and both anchors die together if that line is edited.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-errored-session-does-not-authenticate",
  what:
    "an ERROR session cannot authenticate with its secret, which is the reachable half during the "
    + "failure the outbox fence is built around",
  file: "src/session/session-registry.ts",
  find: " || row.lifecycle === SessionLifecycle.ERROR",
  replace: "",
  killedBy: ["tests/unit/trusted-core.test.ts::terminal ERROR secret is invalid while successor and immutable-hash guards remain intact"],
};
export default c;
