/**
 * #738. The mutation is the exact citation this packet carried before #747 moved it: 1088-1095
 * was `claudeCredentialPaths`, and today those lines are somewhere else in the same file. A
 * document the owner executes during an incident cannot hold a coordinate that goes stale
 * without saying so, and thirteen of them were in this file at the time.
 */
const anOperatorDocumentCitesSymbolsNotLineNumbers = {
  id: "an-operator-document-cites-symbols-not-line-numbers",
  what: "an operator procedure names the code it points at, so a citation that stops resolving is visible",
  file: "docs/ops/owner-actions.md",
  find: "reviewer's readable credential scope (`claudeCredentialPaths` in `src/runtime/cli-adapters.ts`).\n",
  replace: "reviewer's readable credential scope (`src/runtime/cli-adapters.ts:1088-1095`).\n",
  killedBy: [
    "tests/unit/an-operator-document-cites-symbols-not-line-numbers.test.ts::cites code by symbol rather than by a line number that moves under it",
  ],
};

export default anOperatorDocumentCitesSymbolsNotLineNumbers;
