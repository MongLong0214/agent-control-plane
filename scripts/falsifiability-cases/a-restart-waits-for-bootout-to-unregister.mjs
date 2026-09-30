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
    + '    if [[ "${1:-}" == "maintenance" ]]; then\n'
    + '      # A successful bootout request can unregister after any finite observation window. Keep\n'
    + '      # the maintenance command attached until that transition occurs; exiting earlier would\n'
    + '      # leave nobody responsible for restoring the original, previously loaded service.\n'
    + '      printf \'agentcpd launchd installer: bootout timed out; waiting to recover the original service after unregister\\n\' >&2\n'
    + '      while job_loaded; do sleep 1; done\n'
    + '      printf \'agentcpd launchd installer: bootout completed late; attempting original service recovery\\n\' >&2\n'
    + '      start_job\n'
    + '      fail "bootout timed out; original service recovered; requested operation not completed"\n'
    + '    fi\n'
    + '    fail "launchd job remains loaded after bootout; recovery not attempted"\n',
  replace: '    return 0\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::recovers a maintenance bootout that unregisters beyond the initial recovery observations",
  ],
};
export default c;
