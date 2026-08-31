/**
 * #741, and the row acceptance 2 rests on.
 *
 * The mutation is `continue`, not a deletion. Deleting the refusal leaves `namespace` undefined
 * and the next line throws a TypeError, so the loader would still fail and this row would report
 * a kill it did not earn. `continue` is the actual defect - `try { await import(f) } catch {}` -
 * which subtracts a row from the sweep and reports the survivors as a full pass.
 */
const casesLoaderRefusesAModuleItCannotLoad = {
  id: "cases-loader-refuses-a-module-it-cannot-load",
  what: "the case loader refuses a module it cannot parse rather than skipping past it",
  file: "scripts/lib/falsifiability-cases.mjs",
  find: "      refuse(moduleName, `could not be loaded \u2014 ${error.message}`);\n",
  replace: "      continue;\n",
  killedBy: [
    "tests/process/falsifiability-cases-load-fail-closed.test.ts::refuses a case module it cannot parse instead of skipping past it",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default casesLoaderRefusesAModuleItCannotLoad;
