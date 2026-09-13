/**
 * #833 - and one holding a claim, an execution or a pipeline attempt.
 *
 * `outstanding` is the union query over running executions, pipeline attempts and held resource
 * claims. It is a separate conjunct from `work` because it asks about a different table set, and
 * the suite has a case per source - execution, pipeline, resource, other-live-holder.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "same-live-recovery-refuses-outstanding-holders",
  what:
    "same-live recovery refuses a predecessor still holding an execution, pipeline attempt or "
    + "resource claim",
  file: "src/registry/canonical-self-claim.ts",
  find: "outstanding || ",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::same-live recovery refuses outstanding execution after assignment revocation",
  ],
};
export default c;
