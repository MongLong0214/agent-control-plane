/**
 * PR #1043 review, RF1043-01 — Without it operations the PLAN never stated in full reach the producer as though they were approved.
 */
const rf1043RunAPlanWithoutDesiredStateExecutesNothing = {
  id: "rf1043-run-a-plan-without-desired-state-executes-nothing",
  what: "an approved PLAN whose operations carry no desired state is refused, not executed",
  file: "src/bootstrap/repo-factory-bootstrap-run.ts",
  find: "const executableOperationsSchema = z.array(githubOperationSchema).min(1);\n",
  replace: "const executableOperationsSchema = z.array(z.any()).min(1);\n",
  killedBy: ["tests/unit/repo-factory-bootstrap-run.test.ts"],
};

export default rf1043RunAPlanWithoutDesiredStateExecutesNothing;
