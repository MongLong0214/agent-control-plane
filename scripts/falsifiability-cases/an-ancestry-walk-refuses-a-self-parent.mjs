/**
 * #833 - a process that is its own parent is a cycle, not a hop.
 *
 * The other half of the same guard, and a distinct refusal: `snapshot.ppid === current` is the
 * degenerate cycle, and the walk reports `CONFLICT` with "process ancestry cycle detected" rather
 * than climbing forever. The `visited` set catches longer cycles; this catches the one-node case
 * before the first repeat.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-ancestry-walk-refuses-a-self-parent",
  what:
    "a process reported as its own parent is refused as a cycle rather than climbed",
  file: "src/registry/canonical-self-claim.ts",
  find: " || snapshot.ppid === current",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::walks a multi-hop ancestry to the claude process and derives its session id, refusing distinctly when no claude ancestor exists, no session id is named, or the ancestry cycles",
  ],
};
export default c;
