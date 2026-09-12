/**
 * #874 — a reader that waits for a file to *exist* and then parses it needs the file to appear
 * complete, and only a rename gives that.
 *
 * `waitForPath` loops on `existsSync`, and the window is inside `writeFileSync` itself:
 * `open(2)` with `O_CREAT|O_TRUNC` makes the path visible at zero bytes, and the `write(2)` that
 * fills it comes after. A reader polling between those two calls gets `JSON.parse("")` and
 * `Unexpected end of JSON input`. Observed once in CI on a branch that does not touch this file;
 * the file passes 13/13 alone, which is what made it look environmental.
 *
 * An earlier version of this paragraph blamed `process.exit(0)` on the next line for dropping
 * bytes the kernel had not taken. That is not the mechanism, and the error was not harmless: a
 * merge-gate review reproduced the property with no `process.exit` anywhere in the writer and
 * still got 514 empty-file parse failures in 6,568 reads. Under the wrong reading a writer that
 * keeps running looks safe, which is precisely why the first repair skipped the `pidPath` write
 * in `tests/fixtures/hermes-ceo-reference.cjs` — the one whose failure is silent rather than a
 * parse error.
 *
 * `rename` on one filesystem is atomic, so "exists" and "is parseable" become one event.
 *
 * The mutation writes straight to the awaited path again. It cannot be killed by running the
 * replay case — the race is probabilistic and loses almost every time — so the killing case
 * asserts the *invariant* on the script's source: the script that a reader parses does not write
 * to the awaited path, and does rename into it.
 */
const aParsedResultAppearsOnlyComplete = {
  id: "a-parsed-result-appears-only-complete",
  what: "a result a reader parses is renamed into place, never written straight to the path the reader waits on",
  file: "tests/scenarios/hermes-bootstrap-mutation.test.ts",
  find: "    fs.renameSync(partial, resultPath);\n",
  replace: "    fs.writeFileSync(resultPath, JSON.stringify(responses));\n",
  killedBy: [
    "tests/scenarios/hermes-bootstrap-mutation.test.ts::writes a parsed result only through a rename, so waiting on existence is sound",
  ],
};

export default aParsedResultAppearsOnlyComplete;
