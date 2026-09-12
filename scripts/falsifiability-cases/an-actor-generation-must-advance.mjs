/**
 * #833 — an actor generation must advance, and this comparison is the only thing that says so in
 * this process. The schema has a trigger on the same property, but it fires on the INSERT, after
 * the registry has already decided the call is allowed; this returns CONFLICT with the observed
 * generation in its evidence instead.
 *
 * The mutation replaces the comparison with one that is always false rather than deleting the
 * line, so the row's range covers this operand and not the two null-guards above it — those have
 * no independent witness and are answered in refusal-operands-unanswered.mjs. A range that
 * swallowed them would report coverage this mutation does not have.
 *
 * `x !== x` rather than `false`: a statically-false literal makes TypeScript stop narrowing into
 * the block, and the harness refuses a mutant that does not typecheck.
 *
 * Killed by a non-monotonic re-registration being admitted: generation 8 again, after 8, must be
 * CONFLICT.
 */
const anActorGenerationMustAdvance = {
  id: "an-actor-generation-must-advance",
  what: "a re-registration at or below the highest observed actor generation is refused by the registry, not only by the table's trigger",
  file: "src/registry/conversational-actor-registry.ts",
  find: '          input.actorGeneration <= prior.actor_generation) {\n',
  replace: '          input.actorGeneration !== input.actorGeneration) {\n',
  killedBy: [
    "tests/unit/conversational-actor-registry.test.ts::enumerates multiple CTO actors once and permits only higher-generation rotation",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anActorGenerationMustAdvance;
