/**
 * #760. The refusal that has to happen before the spawn. Without it a message that addresses
 * nobody is transmitted, the relay stores it, and `accepted: true` comes back — which is what
 * every one of the unaddressed sends looked like from the sender's side.
 */
const aBuzzSendThatNamesNobodyIsRefused = {
  id: "a-buzz-send-that-names-nobody-is-refused",
  what: "an outbound Buzz message with no recipient is refused before the relay is invoked",
  file: "src/buzz/buzz-adapter.ts",
  find: "    if (named.length === 0) {\n      throw acpError(\n        ReasonCode.BUZZ_SEND_UNADDRESSED,\n        `buzz send to ${channel} named no recipient`,\n        { channel },\n      );\n    }\n\n    const stdout",
  replace: "    if (false) {\n      throw acpError(\n        ReasonCode.BUZZ_SEND_UNADDRESSED,\n        `buzz send to ${channel} named no recipient`,\n        { channel },\n      );\n    }\n\n    const stdout",
  killedBy: [
    "tests/unit/buzz-cli-surface.test.ts::refuses a send that names no recipient, before the CLI is spawned at all",
  ],
};

export default aBuzzSendThatNamesNobodyIsRefused;
