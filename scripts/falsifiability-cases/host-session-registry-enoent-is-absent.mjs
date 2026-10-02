/** A missing registry file must be reported as absent, not folded into the generic open failure. */
const c = {
  id: "host-session-registry-enoent-is-absent",
  what: "ENOENT opening the registry file is reported as the file being absent",
  file: "src/registry/canonical-self-claim.ts",
  find: 'error.code === "ENOENT"',
  replace: "false",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::names the checked registry path when no selector and no file exist",
  ],
};
export default c;
