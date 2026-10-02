/** A path outside the host registry must not enter through a symlink. */
const c = {
  id: "host-session-registry-is-not-symlink",
  what: "the host session registry entry is not a symlink",
  file: "src/registry/canonical-self-claim.ts",
  find: "export const HOST_SESSION_REGISTRY_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;",
  replace: "export const HOST_SESSION_REGISTRY_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;",
  killedBy: ["tests/unit/canonical-host-session-registry.test.ts::opens the registry with O_RDONLY and O_NOFOLLOW and refuses a symlink swapped in at open"],
};
export default c;
