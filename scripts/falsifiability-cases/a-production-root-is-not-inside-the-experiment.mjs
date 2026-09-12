/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-production-root-is-not-inside-the-experiment",
  what: "a production artifact root nested inside the experiment root is refused, because the containment check is not symmetric on its own",
  file: "src/export/experiment-isolation.ts",
  find: "sameOrNested(productionArtifactRoot, experimentArtifactRoot)",
  replace: "false",
  killedBy: ["tests/unit/baseline-export.test.ts::refuses a production root nested inside the experiment root, not only the other way"],
};
export default c;
