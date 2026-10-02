/**
 * PR #1043 review, RF1043-02 (rounds 2 and 3) — Without it a result that could not be stored strands the checkout, and the retry is refused at it instead of taking the ordinary path.
 */
const rf1043AFailedResultFileWriteCleansUp = {
  id: "rf1043-a-failed-result-file-write-cleans-up",
  what: "a failure to store the produced result removes this run's checkout, like every other failure",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "    } catch (thrown) {\n      cleanup();\n      throw thrown;\n    }\n  }\n  return allow(ReasonCode.OK, result);\n",
  replace: "    } catch (thrown) {\n      throw thrown;\n    }\n  }\n  return allow(ReasonCode.OK, result);\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043AFailedResultFileWriteCleansUp;
