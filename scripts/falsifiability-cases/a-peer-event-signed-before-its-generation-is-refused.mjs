/**
 * #1038, narrowed by #1044. The lower edge of the current CEO generation's window, in whole seconds.
 *
 * It is no longer what separates one generation's events from another's — `created_at` is the
 * signer's claim, so a reused identity is refused outright before this is reached, rather than
 * placed in a generation by the date it gives itself. What it still
 * refuses is an event from an exclusive identity dated before its generation began. Removed, the
 * killing row's event dated one second before the start is admitted; its control, signed in the
 * second the binding began at `.500`, is admitted either way, which is the boundary #1044 fixed.
 */
const aPeerEventSignedBeforeItsGenerationIsRefused = {
  id: "a-peer-event-signed-before-its-generation-is-refused",
  what: "a CEO-authored event signed before the current CEO generation began is refused",
  file: "src/ingress/buzz-message.ts",
  find: "      signedAt < startedAtSeconds ||\n",
  replace: "",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses an exclusive key's event dated before its generation began, and admits one signed in the second it began",
  ],
};

export default aPeerEventSignedBeforeItsGenerationIsRefused;
