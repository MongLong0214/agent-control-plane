/** #833 — placeholder; verdict measured before prose. */
const c = {
  id: "a-child-is-within-its-root",
  what: "a path beneath the root is within it, and the separator is appended so a shared prefix is not",
  file: "src/guard/workspace-probe.ts",
  find: "child.startsWith(p + sep)",
  replace: "false",
  killedBy: ["tests/unit/a-path-is-within-its-parent-or-is-it.test.ts::counts a real child as within"],
};
export default c;
