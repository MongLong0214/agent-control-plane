/**
 * The sweep runs as four CI jobs, and a partition that is not one is invisible from the outside:
 * four green checks read the same whether they covered the table or three quarters of it.
 *
 * The mutation collapses the assignment onto shard 1. Every row is still assigned exactly once, so
 * a check that only counted assignments would pass — what breaks is that shards 2 through 4 select
 * nothing, which is the "PASS over zero rows" shape arriving through the matrix instead of through
 * `--only=`. The witness runs `--shard-report=` against the real table and reads both halves.
 */
const everyFalsifiabilityRowLandsInExactlyOneShard = {
  id: "every-falsifiability-row-lands-in-exactly-one-shard",
  what: "the shard assignment spreads rows across every shard rather than heaping them on one",
  file: "scripts/verify-guards-are-falsifiable.mjs",
  find: "    assignment.set(rowByKey.get(key), (position % total) + 1);",
  replace: "    assignment.set(rowByKey.get(key), 1);",
  killedBy: [
    "tests/process/the-falsifiability-sweep-is-sharded-without-gaps.test.ts::partitions the real row table across exactly those shards",
  ],
};

export default everyFalsifiabilityRowLandsInExactlyOneShard;
