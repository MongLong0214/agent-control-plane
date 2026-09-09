// Claude remains capacity-managed without a registered adapter. With no persisted snapshot,
// its READY binding reaches this operand. The always-true type predicate removes only the
// runtime null check while retaining its TypeScript narrowing; no snapshot is fabricated.
// The witness's resolves assertion fails on the resulting null dereference.
const x = {
  id: "sensor-binding-preservation-requires-a-capacity-snapshot",
  what: "A READY managed provider without a snapshot completes uncovered reconciliation without dereferencing null.",
  file: "src/daemon/daemon.ts",
  find: "          currentCapacity !== null &&\n",
  replace: "          ((reading): reading is NonNullable<typeof reading> => true)(currentCapacity) &&\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#812 B2: a READY managed provider without a snapshot reaches uncovered reconciliation",
  ],
};
export default x;
