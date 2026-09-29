const c = {
  id: "a-start-waits-for-slow-startup",
  what: "start allows the startup budgets and settle window to finish beyond 30 polls",
  file: "deploy/install-launchd.sh",
  find: "  local start_poll_limit=180\n",
  replace: "  local start_poll_limit=30\n",
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::accepts a completed start after more than 30 polls with the same pid",
  ],
};
export default c;
