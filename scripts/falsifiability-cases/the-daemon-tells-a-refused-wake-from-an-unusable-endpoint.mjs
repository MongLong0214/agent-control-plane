/**
 * The daemon's report tells a wake that was refused from an endpoint that no longer validates.
 *
 * Both are registrations that deliver nothing, and the repairs are different: one is a state
 * directory or a socket to put back, the other is a holder to restart because the file it bound
 * outlived it. A report that described them the same way would send an operator to look for a
 * directory that is exactly as it should be.
 *
 * The mutation gives the refused-wake case the other one's sentence, which is the plausible
 * shape of the mistake: both texts are true of a registration that is not working. The killing row
 * is the daemon's own report, taken through the operator door with a real holder registered against
 * a socket whose listener was killed, and it reads the sentence rather than the cause code.
 */
const theDaemonTellsARefusedWakeFromAnUnusableEndpoint = {
  id: "the-daemon-tells-a-refused-wake-from-an-unusable-endpoint",
  what: "the daemon's unwakeable-binding finding says a registered endpoint refused the wake, not that it stopped validating",
  file: "src/daemon/daemon.ts",
  find:
    "                `its holder runs ${holder.presented}, a qualified build whose registered wake endpoint still ` +\n" +
    '                "passes every check made before a wake is sent, and the last wake sent under the registration it " +\n' +
    '                "holds now was refused",\n',
  replace:
    "                `its holder runs ${holder.presented}, a qualified build, and the wake endpoint it registered no ` +\n" +
    '                "longer passes the checks made before a wake is sent",\n',
  killedBy: [
    "tests/unit/the-wake-transport-qualifies-a-set-of-builds.test.ts::reports a holder whose registered endpoint refused the wake it was sent",
  ],
};

export default theDaemonTellsARefusedWakeFromAnUnusableEndpoint;
