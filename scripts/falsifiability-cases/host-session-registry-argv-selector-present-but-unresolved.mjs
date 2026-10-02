/** A present argv selector occurrence must still gate the "no selector" denial on it resolving. */
const c = {
  id: "host-session-registry-argv-selector-present-but-unresolved",
  what: "the argv selector occurrence count, not just its unresolved value, is required before denying",
  file: "src/registry/canonical-self-claim.ts",
  find: "selectorCount > 0",
  replace: "true",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::allows --continue with a valid registry and records its source",
  ],
};
export default c;
