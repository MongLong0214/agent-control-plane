/**
 * #833 — A fractional actorGeneration passes every other check on this path: `1.5 <= 0` is false, and
 * SQLite's INTEGER affinity stores 1.5 as REAL rather than rejecting it, so the registration lands
 * with a generation the monotonic comparison then treats as a float.
 *
 * The reason code is the observable this row rests on: INVALID_ARGUMENT is the claim that the
 * call never reached a write. Killed by a test that registers once successfully first — that
 * positive control is what stops "denied" from meaning "this registry denies everything".
 */
const anActorGenerationIsAWholeNumber = {
  id: 'an-actor-generation-is-a-whole-number',
  what: "a fractional actorGeneration is refused as an argument error rather than stored, which SQLite's INTEGER affinity would permit",
  file: "src/registry/conversational-actor-registry.ts",
  find: '  if (!Number.isSafeInteger(input.actorGeneration) || input.actorGeneration <= 0) {\n',
  replace: '  if (input.actorGeneration <= 0) {\n',
  killedBy: [
    'tests/unit/conversational-actor-registry.test.ts::refuses each malformed generation as an argument error, before anything is written',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default anActorGenerationIsAWholeNumber;
