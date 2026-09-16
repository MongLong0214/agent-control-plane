/**
 * Prose that states which callers a symbol has, declared so something can re-run the search.
 *
 * A comment saying "nothing in `src/` calls this" is a claim about a *different file*, which is
 * why it rots without anyone noticing: the change that falsifies it touches neither the comment
 * nor anything a reviewer of the comment would read. Measured 2026-09-16 on this repository —
 * `ConversationTurnCoordinator.claim()` gained two production callers, and five separate comments
 * across four files went on saying it had none. One of them (`migrations.ts` v32) carried an
 * obligation conditioned on that state, so the obligation quietly came due and nobody was told.
 *
 * Each entry names the search the prose is making and what the prose says it finds. The verifier
 * runs it. It refuses in both directions: a claim of `none` with callers present is the stale
 * comment this exists for, and a claim of `some` with no callers is a comment describing wiring
 * that has since been removed.
 *
 * What an entry is not: a place to record that a symbol *should* have no callers. Nothing here
 * forbids a call; the guard only holds the prose and the code to the same answer.
 *
 * **One stale site is knowingly left stale.** `src/db/migrations.ts` (the v32 docblock) still says
 * the canonical-turn ledger "has no production writer", and its next sentence hands an obligation
 * to whoever lands one — backfill-check, or confirm the ledger is empty. Both conditions are now
 * met: the writers exist, and `SELECT COUNT(*) FROM canonical_turns` on the deployment that
 * migration ran against returns 0, measured 2026-09-16, so the obligation is discharged by its
 * second branch. The sentence is not corrected because `migrations.ts` is a FROZEN_BLOB whose
 * digest was supplied by the CEO rather than derived here; editing a comment in it breaks the
 * seal, and re-pinning is not this change's to do. Recorded here instead, which is the one place a
 * reader of that sentence is likely to arrive from.
 */

/**
 * @typedef {object} CallerClaim
 * @property {string} id                stable name, used in the failure message
 * @property {string} declaredIn        the file whose prose makes the claim; excluded from the search
 * @property {string} pattern           JS regular expression source, searched against src/ line by line
 * @property {"none" | "some"} expect   what the prose says the search finds
 * @property {string} why               the sentence a reader should go and fix when this fails
 */

/** @type {readonly CallerClaim[]} */
export const CALLER_CLAIMS = [
  {
    id: "canonical-turn-claim-has-production-callers",
    declaredIn: "src/conversation/turn-coordinator.ts",
    pattern: "\\bconversation\\.claim\\(",
    expect: "some",
    why:
      "turn-coordinator.ts, daemon.ts and migrations.ts all describe whether `claim()` has " +
      "production callers. Two exist (telegram-polling.ts, agentcpd.ts). If this flips to none, " +
      "those three files are describing wiring that was removed.",
  },
];
