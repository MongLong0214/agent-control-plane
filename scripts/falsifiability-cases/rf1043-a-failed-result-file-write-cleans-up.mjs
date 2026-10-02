/**
 * PR #1043 review round 2, RF1043-02 — Without it the failed write strands the owned checkout outside the cleanup path.
 */
const rf1043AFailedResultFileWriteCleansUp = {
  id: "rf1043-a-failed-result-file-write-cleans-up",
  what: "a failure to keep the produced result removes this run's checkout, like every other failure",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "    } catch (thrown) {\n      cleanup();\n      throw thrown;\n    }\n  }\n  return allow(ReasonCode.OK, result);\n",
  replace: "    } catch (thrown) {\n      throw thrown;\n    }\n  }\n  return allow(ReasonCode.OK, result);\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf1043AFailedResultFileWriteCleansUp;
