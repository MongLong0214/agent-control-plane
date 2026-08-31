/**
 * #741. Two rows under one name make `--only=` ambiguous and a report unattributable - which is
 * the merged-object-literal defect (the `what:` count agreed while the earlier row was silently
 * discarded) in the form this directory can still take.
 */
const casesLoaderRefusesADuplicateId = {
  id: "cases-loader-refuses-a-duplicate-id",
  what: "the case loader refuses two modules claiming one id rather than letting the later shadow the earlier",
  file: "scripts/lib/falsifiability-cases.mjs",
  find: "    if (seenIds.has(row.id)) {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/process/falsifiability-cases-load-fail-closed.test.ts::refuses two case modules that claim the same id",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default casesLoaderRefusesADuplicateId;
