/**
 * R1041-03, round 2: a settlement is bound to the `Db` handle that issued it. Keyed by issuance alone,
 * database A's coordinator could settle database B's matching claim while A rolled its own half back.
 */
const aSettlementRedeemsOnlyOnItsIssuingDatabase = {
  id: "a-settlement-redeems-only-on-its-issuing-database",
  what: "a settlement issued against one database settles nothing in another",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (ISSUED_INGRESS_SETTLEMENTS.get(settlement) !== db) return null;",
  replace: "  if (!ISSUED_INGRESS_SETTLEMENTS.has(settlement)) return null;",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-03 refuses a settlement issued against another database",
  ],
};

export default aSettlementRedeemsOnlyOnItsIssuingDatabase;
