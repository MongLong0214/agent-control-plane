/** A zero birth time is no birth time, not a creation at the epoch. */
const c = {
  id: "host-session-registry-birthtime-zero-is-unknown",
  what: "a registry file whose birth time reads zero has no established creation time",
  file: "src/registry/canonical-self-claim.ts",
  find: "stats.birthtimeNs > 0n",
  replace: "true",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a registry file whose birth time the kernel does not report, falling back to ctime only on Linux",
  ],
};
export default c;
