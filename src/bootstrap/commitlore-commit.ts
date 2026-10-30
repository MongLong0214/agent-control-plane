import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { CommitLoreRun, CommitLoreRunner } from "./commitlore-observation.ts";

/**
 * #1268 — CommitLore on the commits ACP makes itself.
 *
 * Every argv here is one the pinned CLI documents, run through the runner one commit attempt prepared: a
 * checked copy of the package the pin loads, with the worker's git hardening (`commitloreRunner`'s
 * `prepare`). Nothing here composes a trailer, mints an id or marks a transaction.
 *
 * - A commit with a transcript (a worker's change, made by `commit-tree` over a private index with hooks
 *   off), with that index as `GIT_INDEX_FILE`: a draft of no records is `commit --no-commit -m --json`,
 *   which binds "considered, nothing to record" to HEAD, that diff and the policy; a draft with records is
 *   `capture --transcript --draft --json` (prepare, verify, stage), refused whole when any record does not
 *   verify, with a survivor it staged removed; then `prepare-commit-msg` on the message file, the command
 *   CommitLore's own hook runs, which applies the staged record. After the commit exists, `post-commit`
 *   finalises consumption against its parent, tree and message, and the transaction is read back consumed.
 *   (`capture`, not `commit --no-commit --records`: under the hardening git runs no hook, so `commit` would
 *   refuse a record it sees no hook to apply.)
 * - A commit with no transcript (the bootstrap commit, a root commit included, and the genesis commit):
 *   `commit -m --json`, CommitLore's own one-call commit with nothing recorded. No draft is made up for a
 *   commit no session produced.
 * - A commit CommitLore cannot make or bind (a plumbing merge, an empty commit): `validate --message-file`,
 *   the check CommitLore's commit-msg hook makes, on the exact message before the commit exists.
 *
 * A refusal before the commit exists leaves no commit; nothing here resets or removes a byte.
 */

/** A draft's answer once CommitLore has verified and bound it. */
export interface CommitLoreConsidered {
  /** The message to commit: the caller's, with the trailer block CommitLore applied when it staged a record. */
  readonly message: string;
  readonly outcome: "recorded" | "empty";
  /** The `Record-Id` values CommitLore applied, in order; empty for `empty`. */
  readonly recordIds: readonly string[];
  /** The capture transaction the record was staged in; null for `empty`. */
  readonly nonce: string | null;
}

export interface CommitLoreSettled {
  readonly outcome: "recorded" | "empty";
  readonly recordIds: readonly string[];
  readonly nonce: string | null;
}

/** One commit attempt on a pinned CLI that has passed its checks for it. */
export interface CommitLoreAttempt {
  /**
   * Before a commit made over `index`: verify and bind `draft` against `transcript` and the diff `index`
   * stages on HEAD (`baseHead`). Files are written into `scratch`, which is never the working tree.
   */
  consider(input: {
    checkout: string;
    index: string;
    baseHead: string;
    message: string;
    transcript: string;
    draft: string;
    scratch: string;
  }): Promise<Decision<CommitLoreConsidered>>;
  /** Once the branch is at `commit`, whose message is `committedMessage`: finalise, and read it back. */
  settle(input: { checkout: string; commit: string; committedMessage: string; considered: CommitLoreConsidered }): Promise<Decision<CommitLoreSettled>>;
  /** A commit no session produced: CommitLore makes it with nothing recorded, and names the commit it made. */
  commitWithoutTranscript(input: { checkout: string; message: string; scratch: string }): Promise<Decision<string>>;
  /**
   * A commit CommitLore has no command to make or bind: its exact message, checked as CommitLore's commit-msg
   * hook checks it, before the commit exists. Nothing is recorded on it. `scratch` is never the working tree.
   */
  validateMessage(input: { checkout: string; message: string; scratch: string; index?: string }): Promise<Decision<void>>;
  /** Removes the attempt's copy of the package. */
  dispose(): void;
}

const refused = <T>(refusal: string, message: string, evidence: Record<string, unknown> = {}): Decision<T> =>
  deny(ReasonCode.VERIFICATION_GAP, message, { refusal, ...evidence });

const tail = (text: string, size = 600): string => text.trim().slice(-size);

/** What `commit --json` answers: its outcome, the commit it made, how many records, what it refused, why. */
interface CommitAnswer {
  outcome: string;
  commit: string | null;
  records: number;
  rejected: unknown[];
  lines: string[];
}

const commitAnswer = (run: CommitLoreRun): CommitAnswer | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const answer = parsed as Record<string, unknown>;
  if (typeof answer["outcome"] !== "string" || typeof answer["records"] !== "number" || !Array.isArray(answer["lines"])) return null;
  return {
    outcome: answer["outcome"],
    commit: typeof answer["commit"] === "string" ? answer["commit"] : null,
    records: answer["records"],
    rejected: Array.isArray(answer["rejected"]) ? answer["rejected"] : [],
    lines: (answer["lines"] as unknown[]).map(String),
  };
};

const runOrRefuse = async (
  run: CommitLoreRunner,
  argv: readonly string[],
  cwd: string,
  options?: { indexFile?: string },
): Promise<Decision<CommitLoreRun>> => {
  try {
    return allow(ReasonCode.OK, await run(argv, cwd, options));
  } catch (error) {
    return refused("COMMITLORE_NOT_RUN", `commitlore ${argv[0]} could not be run: ${(error as Error).message.slice(0, 300)}`, { argv: [...argv] });
  }
};

/**
 * `validate --message-file`, the check CommitLore's commit-msg hook makes, on `message` exactly: allowed only
 * when it exits 0. The message file is written into `scratch`, never the working tree.
 */
const validated = async (run: CommitLoreRunner, checkout: string, message: string, scratch: string, index?: string): Promise<Decision<void>> => {
  const messagePath = join(scratch, "commitlore-checked-message.txt");
  writeFileSync(messagePath, message.endsWith("\n") ? message : `${message}\n`, { mode: 0o600 });
  const checked = await runOrRefuse(run, ["validate", "--message-file", messagePath, "--json"], checkout, index === undefined ? undefined : { indexFile: index });
  if (!checked.allowed) return checked as Decision<void>;
  if (checked.value.exitCode === 0) return allow(ReasonCode.OK, undefined);
  let violations: unknown = null;
  try {
    violations = (JSON.parse(checked.value.stdout) as { violations?: unknown }).violations ?? null;
  } catch {
    violations = null;
  }
  return refused("COMMITLORE_MESSAGE_REFUSED", "CommitLore's commit-msg check refused this message, so the commit is not made", {
    exitCode: checked.value.exitCode,
    violations,
    stderr: tail(checked.value.stderr),
  });
};

/** What `capture --json` answers: its outcome, the transaction it made, whether it staged, what it refused. */
const captureAnswer = (run: CommitLoreRun): { outcome: string; nonce: string | null; staged: boolean; rejected: unknown[] } | null => {
  try {
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    if (typeof parsed["outcome"] !== "string") return null;
    return {
      outcome: parsed["outcome"],
      nonce: typeof parsed["nonce"] === "string" ? parsed["nonce"] : null,
      staged: parsed["staged"] === true,
      rejected: Array.isArray(parsed["rejected"]) ? parsed["rejected"] : [],
    };
  } catch {
    return null;
  }
};

/** Whether a draft is exactly `{"records": []}`: an answer of nothing to record. */
const recordsNothing = (draft: string): boolean => {
  try {
    const parsed = JSON.parse(draft) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    const records = (parsed as { records?: unknown }).records;
    return keys.length === 1 && keys[0] === "records" && Array.isArray(records) && records.length === 0;
  } catch {
    return false;
  }
};

/** The `Record-Id` values a trailer block names, in order. */
const recordIdsIn = (text: string): string[] => [...text.matchAll(/^Record-Id: (\S+)$/gm)].map((match) => match[1] as string);

/** One transaction of `pending ls --json`: phase and base. */
const pendingTransactions = (run: CommitLoreRun): Array<{ nonce: string; phase: string; baseHead: string }> | null => {
  try {
    const parsed = JSON.parse(run.stdout) as { transactions?: unknown };
    if (!Array.isArray(parsed.transactions)) return null;
    return parsed.transactions.flatMap((entry: unknown) => {
      const row = entry as Record<string, unknown>;
      return typeof row["nonce"] === "string" && typeof row["phase"] === "string" && typeof row["base_head"] === "string"
        ? [{ nonce: row["nonce"], phase: row["phase"], baseHead: row["base_head"] }]
        : [];
    });
  } catch {
    return null;
  }
};

/** The attempt's commands, on `run`, the runner the attempt prepared; `dispose` removes what it prepared. */
export const commitloreAttempt = (run: CommitLoreRunner, dispose: () => void = () => {}): CommitLoreAttempt => ({
  async consider({ checkout, index, baseHead, message, transcript, draft, scratch }) {
    const transcriptPath = join(scratch, "commitlore-transcript.txt");
    const draftPath = join(scratch, "commitlore-draft.json");
    const messagePath = join(scratch, "commitlore-message.txt");
    // A draft of no records is the statement `commit` makes with none passed ("the same as omitting
    // --records"): it binds the consideration and stages nothing.
    if (recordsNothing(draft)) {
      const bound = await runOrRefuse(run, ["commit", "--no-commit", "-m", message, "--json"], checkout, { indexFile: index });
      if (!bound.allowed) return bound as Decision<CommitLoreConsidered>;
      const answer = commitAnswer(bound.value);
      if (answer?.outcome !== "staged" || answer.records !== 0) {
        return refused("COMMITLORE_NOT_CONSIDERED", `CommitLore did not bind this change (${answer?.outcome ?? "no answer"}); nothing was committed`, {
          lines: answer?.lines ?? [],
          exitCode: bound.value.exitCode,
          stderr: tail(bound.value.stderr),
        });
      }
      const checked = await validated(run, checkout, message, scratch, index);
      if (!checked.allowed) return checked as Decision<CommitLoreConsidered>;
      return allow(ReasonCode.OK, { message, outcome: "empty", recordIds: [], nonce: null });
    }

    writeFileSync(transcriptPath, transcript, { mode: 0o600 });
    writeFileSync(draftPath, draft, { mode: 0o600 });
    const captured = await runOrRefuse(run, ["capture", "--transcript", transcriptPath, "--draft", draftPath, "--json"], checkout, { indexFile: index });
    if (!captured.allowed) return captured as Decision<CommitLoreConsidered>;
    const answer = captureAnswer(captured.value);
    // All or nothing: a refused record refuses the commit, and a survivor capture staged beside it is removed.
    const withdraw = async (): Promise<void> => {
      if (answer?.staged === true && answer.nonce !== null) await runOrRefuse(run, ["pending", "rm", answer.nonce, "--force"], checkout, { indexFile: index });
    };
    if (answer === null || !["staged", "empty", "rejected"].includes(answer.outcome)) {
      await withdraw();
      return refused("COMMITLORE_NOT_CONSIDERED", `CommitLore's capture did not complete (${answer?.outcome ?? "no answer"}); nothing was committed`, {
        exitCode: captured.value.exitCode,
        stderr: tail(captured.value.stderr),
      });
    }
    if (answer.outcome === "rejected" || answer.rejected.length > 0) {
      await withdraw();
      return refused("COMMITLORE_RECORD_REFUSED", "a CommitLore record did not verify, so nothing was committed and nothing was bound", {
        rejected: answer.rejected,
      });
    }
    // A draft that parsed to nothing is the same statement as passing none.
    if (answer.outcome === "empty") {
      const checked = await validated(run, checkout, message, scratch, index);
      if (!checked.allowed) return checked as Decision<CommitLoreConsidered>;
      return allow(ReasonCode.OK, { message, outcome: "empty", recordIds: [], nonce: null });
    }

    // A staged record reaches the message through the command CommitLore's own prepare-commit-msg hook runs.
    writeFileSync(messagePath, message.endsWith("\n") ? message : `${message}\n`, { mode: 0o600 });
    const applied = await runOrRefuse(run, ["prepare-commit-msg", messagePath], checkout, { indexFile: index });
    if (!applied.allowed) {
      await withdraw();
      return applied as Decision<CommitLoreConsidered>;
    }
    const withRecord = readFileSync(messagePath, "utf8");
    const recordIds = recordIdsIn(withRecord.slice(message.length));
    const listed = await runOrRefuse(run, ["pending", "ls", "--json"], checkout, { indexFile: index });
    const appliedHere = listed.allowed
      ? (pendingTransactions(listed.value) ?? []).filter((entry) => entry.phase === "applied" && entry.baseHead === baseHead && entry.nonce === answer.nonce)
      : [];
    if (applied.value.exitCode !== 0 || recordIds.length === 0 || appliedHere.length !== 1) {
      return refused("COMMITLORE_RECORD_NOT_APPLIED", "CommitLore staged a record and did not apply it to this message on this base; nothing was committed", {
        exitCode: applied.value.exitCode,
        stderr: tail(applied.value.stderr),
        nonce: answer.nonce,
      });
    }
    // The commit-msg hook CommitLore installs would check this message; no hook runs here, so it is asked.
    const checked = await validated(run, checkout, withRecord, scratch, index);
    if (!checked.allowed) {
      await withdraw();
      return checked as Decision<CommitLoreConsidered>;
    }
    return allow(ReasonCode.OK, { message: withRecord, outcome: "recorded", recordIds, nonce: answer.nonce });
  },

  async settle({ checkout, commit, committedMessage, considered }) {
    const finalised = await runOrRefuse(run, ["post-commit"], checkout);
    if (!finalised.allowed) return finalised as Decision<CommitLoreSettled>;
    const landed = recordIdsIn(committedMessage);
    const missing = considered.recordIds.filter((id) => !landed.includes(id));
    const stray = landed.filter((id) => !considered.recordIds.includes(id));
    if (missing.length > 0 || stray.length > 0) {
      return refused("COMMITLORE_NOT_SETTLED", "the commit does not carry exactly the records CommitLore applied", { commit, missing, stray });
    }
    if (considered.nonce !== null) {
      const shown = await runOrRefuse(run, ["pending", "show", considered.nonce, "--json"], checkout);
      if (!shown.allowed) return shown as Decision<CommitLoreSettled>;
      let transaction: Record<string, unknown> | null = null;
      try {
        transaction = (JSON.parse(shown.value.stdout) as { transaction?: Record<string, unknown> }).transaction ?? null;
      } catch {
        transaction = null;
      }
      if (transaction?.["consumed"] !== true || transaction["consumed_by"] !== commit) {
        return refused("COMMITLORE_NOT_SETTLED", "CommitLore did not record its capture transaction consumed by this commit", {
          commit,
          nonce: considered.nonce,
          phase: transaction?.["phase"] ?? null,
          consumedBy: transaction?.["consumed_by"] ?? null,
        });
      }
    }
    return allow(ReasonCode.OK, { outcome: considered.outcome, recordIds: considered.recordIds, nonce: considered.nonce });
  },

  async commitWithoutTranscript({ checkout, message, scratch }) {
    // Git runs no hook under the hardening, so the commit-msg check CommitLore's hook makes is asked first.
    const checked = await validated(run, checkout, message, scratch);
    if (!checked.allowed) return checked as Decision<string>;
    const made = await runOrRefuse(run, ["commit", "-m", message, "--json"], checkout);
    if (!made.allowed) return made as Decision<string>;
    const answer = commitAnswer(made.value);
    if (answer === null || answer.outcome !== "empty" || answer.commit === null || answer.records !== 0) {
      return refused("COMMITLORE_COMMIT_REFUSED", "CommitLore did not make this commit with nothing recorded", {
        outcome: answer?.outcome ?? null,
        commit: answer?.commit ?? null,
        lines: answer?.lines ?? [],
        exitCode: made.value.exitCode,
        stderr: tail(made.value.stderr),
      });
    }
    return allow(ReasonCode.OK, answer.commit);
  },

  async validateMessage({ checkout, message, scratch, index }) {
    return validated(run, checkout, message, scratch, index);
  },

  dispose,
});

/** The fence a worker's reply carries its CommitLore draft in. */
export const COMMITLORE_DRAFT_FENCE = "commitlore-draft";

/**
 * A worker's reply split into its CommitLore draft and the rest of what it said. Exactly one fenced block
 * opened by "```commitlore-draft" on a line of its own; its JSON must be an object. Null when the reply has
 * none or more than one, or its JSON does not parse: the worker did not answer, and nothing stands in for it.
 */
export const draftFromReply = (reply: string): { draft: string; said: string } | null => {
  const blocks = [...reply.matchAll(new RegExp(`^\`\`\`${COMMITLORE_DRAFT_FENCE}[ \\t]*\\n([\\s\\S]*?)^\`\`\`[ \\t]*$`, "gm"))];
  if (blocks.length !== 1) return null;
  const [block] = blocks as [RegExpMatchArray];
  const draft = (block[1] as string).trim();
  try {
    const parsed: unknown = JSON.parse(draft);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  const at = block.index as number;
  return { draft, said: `${reply.slice(0, at)}${reply.slice(at + block[0].length)}`.trim() };
};

/**
 * The CommitLore part of a worker's prompt: CommitLore's own drafting contract, as the pinned CLI prints it
 * for a session before it has a transcript or a diff, and where the answer goes. It is not part of the
 * transcript the draft is verified against, so nothing in it can be cited.
 */
export const workerCommitLoreSection = (contract: string): string =>
  [
    "",
    "CommitLore: this change is committed through CommitLore. Decide whether it carries decision context the diff cannot show.",
    `End your reply with exactly one fenced block opened by \`\`\`${COMMITLORE_DRAFT_FENCE} on its own line and closed by \`\`\`, holding the draft JSON the contract below describes; this placement replaces the contract's own instruction about where to emit it. ` +
      'When there is nothing to record, the block holds {"records": []}: that is a complete answer and the common one.',
    "The draft is verified against the change you made and against this conversation: this message without the CommitLore part, and your reply without the block. Quote only from those.",
    "",
    contract.trim(),
  ].join("\n");
