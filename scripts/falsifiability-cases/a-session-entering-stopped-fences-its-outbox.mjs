/**
 * #833 - the STOPPED half of the same fence.
 *
 * Removing `to !== SessionLifecycle.STOPPED` leaves only the ERROR test, so an orderly shutdown
 * keeps its undelivered rows while a crash does not. That asymmetry is worse than either
 * behaviour alone: whether a message stays deliverable would depend on how its target exited, and
 * the clean path is the one an operator is least likely to suspect.
 *
 * Its sibling `a-session-entering-error-fences-its-outbox` removes the other half, and both share
 * this line.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-session-entering-stopped-fences-its-outbox",
  what:
    "a session entering STOPPED fences its undelivered outbox rows too, so deliverability does not "
    + "depend on whether the target exited cleanly or crashed",
  file: "src/session/session-registry.ts",
  find: " && to !== SessionLifecycle.STOPPED",
  replace: "",
  killedBy: ["tests/unit/outbox-buzz-claims-r2.test.ts::#175 atomically rejects pending and in-flight messages when their target enters ERROR or STOPPED"],
};
export default c;
