/**
 * PR #1043 review, RF1043-02 — Without it any same-named repository is adopted after a lost create response, whoever made it.
 */
const rf1043ALostCreateIsAdoptedOnlyByItsMarker = {
  id: "rf1043-a-lost-create-is-adopted-only-by-its-marker",
  what: "a create whose response was lost is adopted only when the repository carries the marker the create recorded",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "recordedMarker !== null ? observed.value.description === recordedMarker : false;",
  replace: "recordedMarker !== null ? true : false;",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043ALostCreateIsAdoptedOnlyByItsMarker;
