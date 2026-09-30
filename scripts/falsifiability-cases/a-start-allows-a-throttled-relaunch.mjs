const c = {
  id: "a-start-allows-a-throttled-relaunch",
  what: "start permits a single ThrottleInterval before declaring a missing pid permanent",
  file: "deploy/install-launchd.sh",
  find: "  local no_pid_retry_limit=35 no_pid_refusal_limit=5\n",
  replace: "  local no_pid_retry_limit=5 no_pid_refusal_limit=5\n",
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::allows a throttled relaunch after 30 consecutive polls without a pid",
  ],
};
export default c;
