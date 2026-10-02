/**
 * #1044 ACP-1044-02. A surviving move keeps the generation and replaces the runtime, and a queued
 * owner's message is re-addressed to the new runtime. A peer message's proof names the runtime that
 * went, so it is rejected. The mutation lets the owner rule carry it.
 */
const aPeerRowIsNotCarriedToAnotherRuntime = {
  id: "a-peer-row-is-not-carried-to-another-runtime",
  what: "a CTO runtime move rejects a queued peer message instead of carrying it",
  file: "src/outbox/outbox.ts",
  find: "          row.status === \"PENDING\" && !IDENTITY_BOUND_KINDS.has(row.kind as MessageKind)\n",
  replace: "          row.status === \"PENDING\"\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::rejects a queued peer message when the CTO runtime is replaced within its generation instead of carrying it",
  ],
};

export default aPeerRowIsNotCarriedToAnotherRuntime;
