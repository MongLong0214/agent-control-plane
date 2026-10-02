/** A valid current registry entry can expose an argv selector left stale by /resume. */
const c = {
  id: "argv-and-host-session-registry-agree",
  what: "a valid host session registry entry cannot disagree with the argv session selector",
  file: "src/registry/canonical-self-claim.ts",
  find: "registry.value.sessionUuid !== argvSessionUuid",
  replace: "registry.value.sessionUuid === argvSessionUuid",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses disagreement between an argv selector and a valid registry"],
};
export default c;
