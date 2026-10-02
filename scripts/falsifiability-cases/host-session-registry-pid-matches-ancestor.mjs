/** A recycled pid must not let another process's registry entry identify this ancestor. */
const c = {
  id: "host-session-registry-pid-matches-ancestor",
  what: "the host session registry pid equals the derived Claude ancestor pid",
  file: "src/registry/canonical-self-claim.ts",
  find: "typeof fields.pid !== \"number\" || fields.pid !== pid",
  replace: "typeof fields.pid !== \"number\"",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses a registry whose pid differs from the ancestor"],
};
export default c;
