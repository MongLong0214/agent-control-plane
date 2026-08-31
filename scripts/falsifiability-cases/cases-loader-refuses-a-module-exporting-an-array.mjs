/**
 * #741. One module is one row. An array inside a module rebuilds exactly the thing this directory
 * removes: a single point every branch appends to, with the conflict decided by where each
 * happened to insert.
 */
const casesLoaderRefusesAModuleExportingAnArray = {
  id: "cases-loader-refuses-a-module-exporting-an-array",
  what: "the case loader refuses a module exporting an array of rows, which reintroduces a shared insertion point",
  file: "scripts/lib/falsifiability-cases.mjs",
  find: "    if (Array.isArray(row)) {\n",
  replace: "    if (false) {\n",
  killedBy: [
    "tests/process/falsifiability-cases-load-fail-closed.test.ts::refuses a case module that exports an array of rows",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default casesLoaderRefusesAModuleExportingAnArray;
