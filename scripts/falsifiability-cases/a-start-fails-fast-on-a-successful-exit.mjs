const c = {
  id: "a-start-fails-fast-on-a-successful-exit",
  what: "start does not wait for the full retry interval after an exit-0 refusal",
  file: "deploy/install-launchd.sh",
  find: "          successful_exit_without_pid; then\n",
  replace: "          false; then\n",
  killedBy: [
    "tests/unit/deploy-launchd.test.ts::refuses a restart when the job stays registered without a running pid",
  ],
};
export default c;
