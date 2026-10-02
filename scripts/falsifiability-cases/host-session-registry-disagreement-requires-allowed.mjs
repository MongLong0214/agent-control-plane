/** An invalid registry has no sessionUuid to disagree with; the comparison must stay gated on it being allowed. */
const c = {
  id: "host-session-registry-disagreement-requires-allowed",
  what: "the argv/registry disagreement check is gated on the registry having been allowed",
  file: "src/registry/canonical-self-claim.ts",
  find: "registry.allowed && registry.value.sessionUuid",
  replace: "(registry as { value?: { sessionUuid: string } }).value?.sessionUuid",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::allows an argv selector when the registry file is absent",
  ],
};
export default c;
