/** A registry file born later than the wall clock now means the clock stepped backward after it was written. */
const c = {
  id: "host-session-registry-created-after-wall-clock",
  what: "a registry file whose kernel birth time is later than the current wall clock is refused",
  file: "src/registry/canonical-self-claim.ts",
  find: "opened.birthtimeNs > wallClockUpperNs(clock)",
  replace: "false",
  killedBy: [
    "tests/unit/canonical-host-session-registry.test.ts::refuses a registry file whose birth time is 0.5 s later than the injected wall clock, even under a matching argv selector",
  ],
};
export default c;
