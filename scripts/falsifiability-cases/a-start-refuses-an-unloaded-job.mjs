const c = {
  id: "a-start-refuses-an-unloaded-job",
  what: "start exits nonzero and names an unloaded job when kickstart does not leave it registered",
  file: "deploy/install-launchd.sh",
  find: '  job_loaded || fail "launchd job is not loaded after start"\n',
  replace: '',
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::refuses success when kickstart leaves the job unloaded",
  ],
};
export default c;
