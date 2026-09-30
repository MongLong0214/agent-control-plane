/**
 * A reading's counts are derived from the observations committed with it, not read from the file.
 *
 * Both reviewers held this open across two rounds. The acceptance rule recomputes a verdict from a
 * reading's own runs, which closed the stored verdict deciding its own admissibility -- but every
 * number it recomputes from was a summary integer the file stated about itself, and the twelve raw
 * captures those integers came from are under `evidence/local/`, which is gitignored. Nothing a
 * reader of the repository could see tied a count to an observation.
 *
 * Each arm now carries what it observed, and both sides derive the four counts from it: the probe
 * records what `countsFrom` returns, and this rule derives them again and reports a difference.
 * The mutation is the state before that -- the file's own numbers standing in for the derivation,
 * so a reading could state any four mutually consistent integers and be admitted.
 *
 * This does not establish that a live client produced the observations, and no rule inside the
 * artefact can; that is #1012. What it removes is the count that stood on nothing.
 */
const anArmsCountsAreDerivedFromItsObservations = {
  id: "an-arms-counts-are-derived-from-its-observations",
  what: "the acceptance rule derives an arm's four counts from the observations committed with it, rather than reading the integers the arm states",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "      const derived = countsFrom(observations);\n",
  replace: "      const derived = stated;\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm's counts have to come from the observations committed with it",
  ],
};

export default anArmsCountsAreDerivedFromItsObservations;
