import { rmSync } from "node:fs";

import { type CommitLorePort, checkGeneratedCommitMessage } from "../bootstrap/commitlore-observation.ts";
import { type Decision, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { acpScratchDir } from "../core/scratch-root.ts";
import { git } from "../git/git.ts";
import type { MergeCommitCheck } from "./github-kernel.ts";

/**
 * #1268 — the check a governed run's GitHub merge commit message gets: a CommitLore commit attempt in the
 * repository's registered checkout and CommitLore's own commit-msg check on the exact message (`validate`), which is
 * no capture: the merge commit records nothing of its own, and the records of the candidate's commits are its parents'.
 * A deployment with no CommitLore (`port` null, or one that cannot make an attempt) refuses.
 */
export const mergeCommitCheck = (port: CommitLorePort | null): MergeCommitCheck => async ({ checkout, message }): Promise<Decision<void>> => {
  const gitDir = await git(checkout, ["rev-parse", "--absolute-git-dir"], { allowFailure: true });
  if (gitDir.exitCode !== 0) return deny(ReasonCode.PROBE_FAILED, "the checkout's git directory could not be read, so CommitLore cannot check the merge commit", { checkout });
  const scratch = acpScratchDir("acp-merge-commitlore-");
  try {
    return await checkGeneratedCommitMessage(port, { checkout, git: { gitDir: gitDir.stdout.trim(), workTree: checkout }, message, scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
