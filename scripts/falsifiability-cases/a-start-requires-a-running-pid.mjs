const c = {
  id: "a-start-requires-a-running-pid",
  what: "start refuses a registered job whose current launchctl print has no running pid",
  file: "deploy/install-launchd.sh",
  find: '    if pid="$(running_pid)" && [[ -f "$stdout_log" ]] &&\n',
  replace: '    if pid="4242" && [[ -f "$stdout_log" ]] &&\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::refuses a restart when the job stays registered without a running pid",
  ],
};
export default c;
