/**
 * R1041-03: the coordinator reads back that every claimed message records this receipt before it
 * commits; a callback that only returned `allowed` would otherwise commit a reply beside an
 * unsettled claim.
 */
const anIngressCompletionRequiresTheSettledClaim = {
  id: "an-ingress-completion-requires-the-settled-claim",
  what: "an ingress completion commits only when every claimed message records this receipt",
  file: "src/conversation/turn-coordinator.ts",
  find: "        if (unsettled !== undefined) {",
  replace: "        if (false as boolean) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-03 commits nothing when the callback queues a reply without settling the claim",
  ],
};

export default anIngressCompletionRequiresTheSettledClaim;
