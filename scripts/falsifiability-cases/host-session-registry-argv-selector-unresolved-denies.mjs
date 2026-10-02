/** A resolved argv selector must not be treated as if it named no session id. */
const c = {
  id: "host-session-registry-argv-selector-unresolved-denies",
  what: "a resolved argv selector is not denied as an unresolved one",
  file: "src/registry/canonical-self-claim.ts",
  find: "!argvSessionUuid",
  replace: "true",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::allows a matching argv selector and registry with argv source",
  ],
};
export default c;
