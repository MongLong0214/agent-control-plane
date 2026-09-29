const c = {
  id: "a-start-settles-the-same-pid",
  what: "start does not accept a pid that disappears before the settle window completes",
  file: "deploy/install-launchd.sh",
  find: '      if [[ "$settled" -ge 2 ]]; then return 0; fi\n',
  replace: '      if [[ "$settled" -ge 0 ]]; then return 0; fi\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::refuses a restart when its reported pid disappears during settling",
  ],
};
export default c;
