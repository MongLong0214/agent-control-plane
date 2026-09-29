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
    + '      # A timed-out bootout can still unregister after the last check. Only restore a\n'
    + '      # previously loaded service, with its original plist, after observing that transition.\n'
    + '      for attempt in $(seq 1 5); do\n'
    + '        sleep 1\n'
    + '        if ! job_loaded; then\n'
    + '          printf \'agentcpd launchd installer: bootout timed out; attempting original service recovery\\n\' >&2\n'
    + '          start_job\n'
    + '          fail "bootout timed out; original service recovered; requested operation not completed"\n'
    + '        fi\n'
    + '      done\n'
    + '      fail "launchd job remains loaded after bootout; no recovery observed within bounded wait; bootout may unregister later, leaving service stopped; inspect launchctl and restore the original service if unloaded"\n'
    + '    fi\n'
    + '    fail "launchd job remains loaded after bootout; recovery not attempted"\n',
  replace: '    return 0\n',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::restart waits for a delayed bootout before reporting a loaded job",
  ],
};
export default c;
