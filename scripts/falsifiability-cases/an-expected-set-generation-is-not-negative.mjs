/**
 * #833 — Minus one is a safe integer, so only this operand refuses it. Without it the value reaches the
 * optimistic-concurrency comparison and comes back as *stale* instead.
 *
 * The reason code is the observable this row rests on: INVALID_ARGUMENT is the claim that the
 * call never reached a write. Killed by a test that registers once successfully first — that
 * positive control is what stops "denied" from meaning "this registry denies everything".
 */
const anExpectedSetGenerationIsNotNegative = {
  id: 'an-expected-set-generation-is-not-negative',
  what: 'a negative expectedRegistrySetGeneration is refused as an argument error rather than read as a stale set generation',
  file: "src/registry/conversational-actor-registry.ts",
  find: '  if (!Number.isSafeInteger(input.expectedRegistrySetGeneration) || input.expectedRegistrySetGeneration < 0) {\n',
  replace: '  if (!Number.isSafeInteger(input.expectedRegistrySetGeneration)) {\n',
  killedBy: [
    'tests/unit/conversational-actor-registry.test.ts::refuses each malformed generation as an argument error, before anything is written',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anExpectedSetGenerationIsNotNegative;
