const c = {
  id: "a-start-requires-completed-startup",
  what: "start waits for the current daemon's completed-start record before accepting its pid",
  file: "deploy/install-launchd.sh",
  find: '      tail -c "+$((stdout_bytes + 1))" "$stdout_log" | grep -F \'"started":\' >/dev/null; then\n',
  replace: '      true; then\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::refuses a pid that appears before the daemon reports completed startup",
  ],
};
export default c;
