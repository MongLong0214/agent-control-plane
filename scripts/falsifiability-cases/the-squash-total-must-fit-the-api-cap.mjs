/**
 * The cap. The commits API exposes at most 250 records, so a larger PR cannot supply its
 * complete commit list through this path. Removing that refusal lets collection begin
 * when the API cannot provide every record needed for the composed message.
 */
const theSquashTotalMustFitTheApiCap = {
  id: "the-squash-total-must-fit-the-api-cap",
  what: "a PR exceeding the 250 commit API cap cannot be composed",
  file: "src/github/github-kernel.ts",
  find: "    if (expectedCount > 250) {",
  replace: "    if (false) {",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::refuses a capped 250-commit list",
  ],
};

export default theSquashTotalMustFitTheApiCap;
