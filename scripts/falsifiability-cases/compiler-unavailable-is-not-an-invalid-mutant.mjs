// Remove with the compiler verdict guard. Disabling it reproduces #806: a missing compiler
// is reported as an invalid mutant, even though the witness never ran.
const compilerUnavailableIsNotAnInvalidMutant = {
  id: "compiler-unavailable-is-not-an-invalid-mutant",
  what: "an unavailable compiler cannot judge a mutant",
  file: "scripts/verify-guards-are-falsifiable.mjs",
  find: "      if (compiled.error || compiled.status === null) {\n",
  replace: "      if (false) {\n",
  killedBy: [
    "tests/process/falsifiability-verdict.test.ts::refuses a missing compiler without judging the mutant or running its witness",
  ],
};

export default compilerUnavailableIsNotAnInvalidMutant;
