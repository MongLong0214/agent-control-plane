const c = {
  id: "a-start-stops-after-a-sustained-missing-pid",
  what: "start stops waiting when a job has no pid beyond one launchd retry interval",
  file: "deploy/install-launchd.sh",
  find: "  local no_pid_retry_limit=35 no_pid_refusal_limit=5\n",
  replace: "  local no_pid_retry_limit=180 no_pid_refusal_limit=5\n",
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::refuses a restart when its reported pid disappears during settling",
  ],
};
export default c;
