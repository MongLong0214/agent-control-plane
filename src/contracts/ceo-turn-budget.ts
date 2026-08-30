/**
 * The two deadlines on one owner turn, and the relationship between them.
 *
 * An owner turn crosses a process boundary twice:
 *
 *   daemon ──sampling/createMessage──▶ CEO runtime ──spawn──▶ reply command
 *          ◀──────── budget ────────           ◀── replyTimeout ──
 *
 * They were two independent constants in two files, and they were ordered backwards: the
 * daemon gave up at 60s while the runtime was still waiting until 120s. An outer deadline
 * shorter than the inner one it contains means the inner one can never fire in the ordinary
 * case — the daemon has already abandoned the request — and the eventual reply arrives for an
 * id nobody is waiting on. #613 fixed the same shape once already, for the handshake.
 *
 * So the outer is derived here rather than written down twice. Whoever changes one gets the
 * other, and `assertOuterOutlastsInner` fails where it can be seen rather than in a deployment.
 *
 * What this does **not** buy is an attributable failure. `CeoConversationPort.ask` maps every
 * `createMessage` rejection to `CEO_CONVERSATION_TIMEOUT` and drops the peer's text, so even
 * once the inner deadline can fire first the owner is still told the CEO did not answer rather
 * than that its reply source did not. That collapse is #633, and correcting the ordering is a
 * precondition for it rather than a fix for it.
 *
 * **These values are not yet sized against a real turn, and that is deliberate.** A CEO turn is
 * a full agent loop: one measured on 2026-08-20 took 3m15s and added 92 messages, 65 of them
 * tool calls. Both numbers here are below that. Raising them is not the whole fix, because
 * routed CEO turns now leave `TelegramLongPollService.pollOnce`, so this budget is no longer
 * the ceiling on how long one owner message stalls polling. It is still below the one measured
 * turn, and one measurement is not enough to choose a production deadline. What is fixed here is
 * the relationship between the two deadlines, which is wrong at any size.
 */

/**
 * How long the CEO runtime lets its reply command run before telling the daemon nobody
 * answered. This is the inner deadline: it bounds the actual work.
 */
export const CEO_REPLY_TIMEOUT_MS = 120_000;

/**
 * How much longer the daemon waits than the runtime does.
 *
 * The margin covers the round trip and the runtime's own refusal path — the daemon should hear
 * *"the reply source did not answer"* from the runtime rather than time out on top of it. A
 * timeout at the outer edge cannot say which of the two failed; the inner one can.
 */
export const CEO_BUDGET_MARGIN_MS = 15_000;

/**
 * How long the daemon holds an owner turn open. Derived, so it cannot drift under the inner one.
 */
export const CEO_CONVERSATION_BUDGET_MS = CEO_REPLY_TIMEOUT_MS + CEO_BUDGET_MARGIN_MS;

/**
 * Throws unless the outer deadline outlasts the inner one it contains.
 *
 * Exported so a caller that overrides either value is held to the same relationship as the
 * defaults. A derived default that any override can invert is a default that documents an
 * invariant without enforcing it.
 *
 * Today the only callers that override are tests: production builds both sides with no options
 * (`agentcpd.ts` constructs `new CeoConversationPort()`, and `hermes-ceo.ts` calls `serve`
 * without `replyTimeoutMs`), and there is no CLI, env var or plist entry for either. An earlier
 * draft of this comment claimed operator configuration as a reason; that path does not exist,
 * and citing it would have made this check look like it covered a case it never sees.
 */
export const assertOuterOutlastsInner = (budgetMs: number, replyTimeoutMs: number): void => {
  if (budgetMs > replyTimeoutMs) return;
  throw new Error(
    `the CEO conversation budget (${budgetMs}ms) must outlast the reply timeout it contains ` +
      `(${replyTimeoutMs}ms); otherwise the daemon abandons the turn while the runtime is still ` +
      "waiting, and the runtime's own timeout can never report which side failed",
  );
};
