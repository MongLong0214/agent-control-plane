/**
 * #760. The daemon's rule and the shell's rule have to be the same rule, or the shell is the
 * way around the daemon. This is the shell half; the sends that addressed nobody all came
 * from it.
 */
const theShellSendPathRequiresARecipient = {
  id: "the-shell-send-path-requires-a-recipient",
  what: "the shell send path refuses a message with no recipient instead of relaying it",
  file: "scripts/buzz-send.mjs",
  find: "  if (recipients.length === 0) {\n    fail(",
  replace: "  if (false) {\n    fail(",
  killedBy: [
    "tests/process/the-shell-path-cannot-send-an-unaddressed-message.test.ts::refuses a message that names no recipient, and never reaches the relay",
  ],
};

export default theShellSendPathRequiresARecipient;
