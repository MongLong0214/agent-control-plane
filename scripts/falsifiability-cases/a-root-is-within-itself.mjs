/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-root-is-within-itself",
  what: "a workspace root is within itself, so a write at the root of the scope it was granted is not outside it",
  file: "src/guard/workspace-probe.ts",
  find: "child === p ||",
  replace: "false ||",
  killedBy: ["tests/unit/a-path-is-within-its-parent-or-is-it.test.ts::counts the root itself as within itself"],
};
export default c;
