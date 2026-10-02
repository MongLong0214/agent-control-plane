/** A headless or unlabelled host session must not supply a canonical identity. */
const c = {
  id: "host-session-registry-kind-is-interactive",
  what: "the host session registry entry names kind interactive",
  file: "src/registry/canonical-self-claim.ts",
  find: "if (fields.kind !== \"interactive\") {",
  replace: "if (false) {",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses a print-kind registry entry"],
};
export default c;
