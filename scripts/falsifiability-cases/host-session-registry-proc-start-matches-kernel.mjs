/** A stale entry at a reused pid must not identify the replacement process. */
const c = {
  id: "host-session-registry-proc-start-matches-kernel",
  what: "the registry procStart equals the ancestor kernel start rendered in UTC",
  file: "src/registry/canonical-self-claim.ts",
  find: "fields.procStart !== expectedProcStart",
  replace: "false",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::refuses a registry whose procStart is one second stale"],
};
export default c;
