/**
 * #741. An empty `scripts/falsifiability-cases/` reads as "every case passed" to anything that
 * counts failures - the same silence as a skipped module, arriving one level up. Turning the
 * guard's condition off is how a directory emptied by a bad merge would report a clean sweep.
 */
const casesLoaderRefusesAnEmptyDirectory = {
  id: "cases-loader-refuses-an-empty-directory",
  what: "the case loader refuses an empty directory instead of reading zero rows as zero failures",
  file: "scripts/lib/falsifiability-cases.mjs",
  find: "  if (moduleNames.length === 0) {\n",
  replace: "  if (false) {\n",
  killedBy: [
    "tests/process/falsifiability-cases-load-fail-closed.test.ts::refuses an empty case directory rather than reporting a sweep with no subject",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default casesLoaderRefusesAnEmptyDirectory;
