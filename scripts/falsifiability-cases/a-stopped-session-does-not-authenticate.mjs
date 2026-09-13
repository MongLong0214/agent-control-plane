/**
 * #833 - a STOPPED session's secret stops authenticating, and that is not the same fact as the
 * hash being immutable.
 *
 * The secret outlives the session: nothing rotates it at transition, so the only thing standing
 * between a stopped runtime's secret and a live authentication is this operand. Removing it leaves
 * the ERROR test, so a session that exited cleanly keeps proving it is itself - and a successor
 * binding the same role would then face two callers able to authenticate as the predecessor.
 *
 * The sibling row `an-errored-session-does-not-authenticate` removes the other half. Two rows on
 * one line, with the cost recorded in both: an edit to this condition kills both anchors, and
 * `--anchors-only` is what reports that in seconds.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-stopped-session-does-not-authenticate",
  what:
    "a STOPPED session cannot authenticate with its secret, so a terminal runtime cannot keep "
    + "proving it is the session a successor has taken over from",
  file: "src/session/session-registry.ts",
  find: "row.lifecycle === SessionLifecycle.STOPPED || ",
  replace: "",
  killedBy: ["tests/unit/trusted-core.test.ts::terminal STOPPED secret is invalid while successor and immutable-hash guards remain intact"],
};
export default c;
