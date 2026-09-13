/**
 * #833 - the ancestry walk stops before pid 1.
 *
 * Removing `snapshot.ppid <= 1` lets the walk continue past init, where `snapshot(0)` has no
 * answer and the loop spends its remaining hops on a pid that cannot exist. The refusal an
 * operator then reads is the hop budget rather than "no claude ancestor exists between the calling
 * process and pid 1", which is the fact.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "an-ancestry-walk-stops-at-init",
  what:
    "the ancestry walk stops at pid 1 and says so, rather than spending its hop budget past init",
  file: "src/registry/canonical-self-claim.ts",
  find: "snapshot.ppid <= 1 || ",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::walks a multi-hop ancestry to the claude process and derives its session id, refusing distinctly when no claude ancestor exists, no session id is named, or the ancestry cycles",
  ],
};
export default c;
