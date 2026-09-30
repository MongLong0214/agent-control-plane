/**
 * A wake that succeeds after the holder registered again leaves the newer registration alone.
 *
 * Reproduced by both reviewers on the real port with controlled socket completions: hold
 * registration A's wake pending, register endpoint B, let B's wake be refused -- the port reports
 * the refusal correctly -- then complete A's wake successfully, and B vanishes from
 * `unwakeableHolders()` despite its own failed delivery. What is left is a holder nothing can wake,
 * reported wakeable, with nothing observable to contradict it until somebody tries another wake.
 *
 * The mutation clears unconditionally, which is what the code did. The killing row is that exact
 * sequence, and the control row beside it requires a success under the registration in force to go
 * on clearing -- so this cannot pass by never clearing at all.
 */
const aLateSuccessDoesNotEraseANewerRegistrationsRefusal = {
  id: "a-late-success-does-not-erase-a-newer-registrations-refusal",
  what: "a wake that lands clears only the memory of the registration it was sent under",
  file: "src/mcp/role-conversation.ts",
  find: "    if (peer.registration === registration) peer.wakeFailure = null;\n",
  replace: "    peer.wakeFailure = null;\n",
  killedBy: [
    "tests/unit/a-late-wake-belongs-to-the-registration-it-began-under.test.ts::a success completing after a later registration does not erase that registration's refusal",
  ],
};

export default aLateSuccessDoesNotEraseANewerRegistrationsRefusal;
