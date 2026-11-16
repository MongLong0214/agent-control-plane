import { produceRepoFactoryResult as produce } from "../../src/bootstrap/repo-factory-producer.ts";
import { passingCommitLore } from "./commitlore-attempt.ts";

/**
 * #1268 — `produceRepoFactoryResult` is refused without a CommitLore to make its commits and observe it, whatever
 * the manifest's `commitlore.mode` says. A witness whose subject is something else gets a passing double, unless it
 * names a CommitLore of its own.
 */
export const produceRepoFactoryResult = (input: Parameters<typeof produce>[0]): ReturnType<typeof produce> =>
  produce({ commitlore: { port: passingCommitLore() }, ...input });
