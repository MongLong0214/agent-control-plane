/** A FIFO at the registry path must not block the daemon's synchronous open. */
const c = {
  id: "host-session-registry-open-is-nonblocking",
  what: "the host session registry is opened with O_NONBLOCK",
  file: "src/registry/canonical-self-claim.ts",
  find: "constants.O_NOFOLLOW | constants.O_NONBLOCK;",
  replace: "constants.O_NOFOLLOW;",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::opens the registry non-blocking so a FIFO planted at its path cannot stall the open"],
};
export default c;
