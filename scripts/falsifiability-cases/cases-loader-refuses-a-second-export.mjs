/**
 * #741. The other way a module can hold two rows. A named export beside the default is a row the
 * harness would never see, and nothing else in the repository would report its absence.
 */
const casesLoaderRefusesASecondExport = {
  id: "cases-loader-refuses-a-second-export",
  what: "the case loader refuses a module carrying a second export beside its row",
  file: "scripts/lib/falsifiability-cases.mjs",
  find: "    if (exported.length !== 1 || exported[0] !== \"default\") {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/process/falsifiability-cases-load-fail-closed.test.ts::refuses a case module carrying a second export beside its row",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default casesLoaderRefusesASecondExport;
