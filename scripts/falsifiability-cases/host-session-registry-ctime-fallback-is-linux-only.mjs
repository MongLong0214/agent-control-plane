/** ctime stands in for a missing birth time only on Linux, where statx may not report one. */
const c = {
  id: "host-session-registry-ctime-fallback-is-linux-only",
  what: "the ctime fallback for a missing birth time applies only on Linux",
  file: "src/registry/canonical-self-claim.ts",
  find: "if (process.platform === \"linux\" &&",
  replace: "if (true &&",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a registry file whose birth time the kernel does not report, falling back to ctime only on Linux",
  ],
};
export default c;
