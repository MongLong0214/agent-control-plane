/**
 * #833 - entering ERROR fences the session's undelivered messages.
 *
 * Removing `to !== SessionLifecycle.ERROR` leaves only the STOPPED test, so a crashed session's
 * PENDING and IN_FLIGHT outbox rows survive it. The docblock above this function records what that
 * costs, and it is not a lost message: this write "knows nothing about ingress claims, so an
 * owner-message reaching it went terminal with its claim left unresolved - the `(buzz, nonce)`
 * slot then permanently exempt from `IngressGuard.prune`, and the turn reported outstanding
 * forever."
 *
 * ERROR fires first in the ordinary failure ordering - the runtime dies, then a successor binds -
 * so this is the operand an outage actually reaches.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-session-entering-error-fences-its-outbox",
  what:
    "a session entering ERROR fences its undelivered outbox rows, so a crash does not leave a turn "
    + "outstanding forever behind an unresolved ingress claim",
  file: "src/session/session-registry.ts",
  find: "to !== SessionLifecycle.ERROR && ",
  replace: "",
  killedBy: ["tests/unit/outbox-buzz-claims-r2.test.ts::#175 atomically rejects pending and in-flight messages when their target enters ERROR or STOPPED"],
};
export default c;
