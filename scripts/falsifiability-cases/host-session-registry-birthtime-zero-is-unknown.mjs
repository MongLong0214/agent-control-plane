/** A zero birth time is no birth time, not a creation at the epoch; nothing stands in for it. */
const c = {
  id: "host-session-registry-birthtime-zero-is-unknown",
  what: "a registry file whose birth time reads zero has no established creation time and is refused",
  file: "src/registry/canonical-self-claim.ts",
  find: "opened.birthtimeNs <= 0n",
  replace: "false",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a registry file whose birth time the kernel does not report, with no ctime fallback",
  ],
};
export default c;
