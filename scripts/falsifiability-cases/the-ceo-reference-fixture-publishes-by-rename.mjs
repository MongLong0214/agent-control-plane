/**
 * #874/#875. `tests/process/hermes-bootstrap-process.test.ts` polls four paths with `existsSync`
 * and then reads them; the fixture used to `writeFileSync` straight into each, three of the four
 * followed immediately by `process.exit`, which drops whatever the kernel has not taken. A
 * merge-gate review reproduced the property on this exact shape: 514 `Unexpected end of JSON
 * input` in 6,568 reads.
 *
 * The pid path carried the quieter consequences. `Number("")` is 0 and `Number("123")` is an
 * integer, so `Number.isInteger` was satisfied by exactly the failures it existed to catch: an
 * empty read skipped the test's `process.kill` cleanup and leaked the spawned runtime, and a
 * truncated prefix reached `process.kill` and signalled an unrelated process on the host.
 *
 * The mutation restores the defect at the pid write specifically, because that is the one whose
 * failure is silent -- the JSON writes announce themselves with a parse error, and a guard that
 * only catches the loud half would leave the signal-an-unrelated-pid path uncovered.
 */
const theCeoReferenceFixturePublishesByRename = {
  id: "the-ceo-reference-fixture-publishes-by-rename",
  what: "the CEO reference fixture publishes every path the process test awaits by rename, so no reader parses a half-written file",
  file: "tests/fixtures/hermes-ceo-reference.cjs",
  find: "publish(pidPath, String(process.pid));",
  replace: "fs.writeFileSync(pidPath, String(process.pid));",
  killedBy: [
    "tests/process/hermes-bootstrap-process.test.ts::publishes every awaited path by rename, so no reader can parse a half-written file",
  ],
};

export default theCeoReferenceFixturePublishesByRename;
