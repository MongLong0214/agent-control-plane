/**
 * #874 — a reader that waits for a file to *exist* and then parses it needs the file to appear
 * complete, and only a rename gives that.
 *
 * `waitForPath` loops on `existsSync`. `writeFileSync` makes a path exist before its bytes are
 * necessarily visible to another process, and the runtime script called `process.exit(0)` on the
 * next line — which does not wait for what the kernel has not taken. So the reader could
 * `JSON.parse("")` and fail with `Unexpected end of JSON input`. Observed once in CI on a branch
 * that does not touch this file; the file passes 13/13 alone, which is what made it look
 * environmental.
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
