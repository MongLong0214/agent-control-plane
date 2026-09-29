const c = {
  id: "a-restart-waits-for-bootout-to-unregister",
  what: "restart waits until bootout unregisters the job before start checks whether to bootstrap it",
  file: "deploy/install-launchd.sh",
  find:
    '    for attempt in $(seq 1 30); do\n'
    + '      job_loaded || return 0\n'
    + '      sleep 1\n'
    + '    done\n'
    + '    job_loaded || return 0\n'
    + '    fail "launchd job remains loaded after bootout"\n',
  replace: '    return 0\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::restart waits for a delayed bootout before reporting a loaded job",
  ],
};
export default c;
