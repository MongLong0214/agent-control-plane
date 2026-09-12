/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "an-experiment-root-is-not-inside-production",
  what: "an experiment artifact root nested inside the production root is refused",
  file: "src/export/experiment-isolation.ts",
  find: "sameOrNested(experimentArtifactRoot, productionArtifactRoot) ||",
  replace: "false ||",
  killedBy: ["tests/unit/baseline-export.test.ts::requires an offline experiment to use a separate database and artifact root"],
};
export default c;
