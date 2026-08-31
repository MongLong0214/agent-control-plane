/**
 * #741. `vitest run <path>` exits non-zero for a path matching no file, and this harness reads a
 * non-zero exit as a kill - so a row naming a renamed or deleted test reports coverage forever,
 * having run nothing. `--anchors-only` catches that for rows already in the tree; this catches it
 * at the moment a case module is added.
 */
const casesLoaderRefusesAKilledbyThatNamesNoFile = {
  id: "cases-loader-refuses-a-killedby-that-names-no-file",
  what: "the case loader refuses a killedBy naming a test file that does not exist",
  file: "scripts/lib/falsifiability-cases.mjs",
  find: "      if (!existsSync(join(root, testPath))) {\n",
  replace: "      if (false) {\n",
  killedBy: [
    "tests/process/falsifiability-cases-load-fail-closed.test.ts::refuses a killedBy that names a test file which does not exist",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default casesLoaderRefusesAKilledbyThatNamesNoFile;
