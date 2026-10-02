/**
 * #246 — Without it a create that landed under another owner is reported as an absent re-read, and the evidence loses the only record of where the repository went.
 */
const rf246TheCreateResponseMustNameThePlannedRepository = {
  id: "rf246-the-create-response-must-name-the-planned-repository",
  what: "the repository GitHub's create response names must be the planned one, judged before the re-read",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "    const createdJudged = judgeRepository(created.value, id);\n    if (!createdJudged.allowed) return createdJudged as Decision<Step>;\n",
  replace: "\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246TheCreateResponseMustNameThePlannedRepository;
