import { execFileSync } from "node:child_process";

import type { CommitLoreAttempt } from "../../src/bootstrap/commitlore-commit.ts";
import type { CommitLorePort } from "../../src/bootstrap/commitlore-observation.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

/**
 * #1268 — a CommitLore commit-attempt double for witnesses whose subject is something else: a commit no
 * session produced is made with plain `git commit`, and each message it was asked for is appended to
 * `messages`. It considers and settles nothing; the real procedure is witnessed against the real CLI.
 */
export const gitCommitAttempt =
  (messages: string[] = []) =>
  async (): Promise<Decision<CommitLoreAttempt>> =>
    allow(ReasonCode.OK, {
      consider: async () => deny(ReasonCode.INTERNAL_ERROR, "this double considers nothing", {}),
      settle: async () => deny(ReasonCode.INTERNAL_ERROR, "this double settles nothing", {}),
      validateMessage: async () => allow(ReasonCode.OK, undefined),
      dispose: () => {},
      commitWithoutTranscript: async ({ checkout, message }) => {
        messages.push(message);
        execFileSync("git", ["commit", "-q", "-m", message], { cwd: checkout, timeout: 30_000 });
        return allow(ReasonCode.OK, execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", timeout: 30_000 }).trim());
      },
    });

/**
 * #1268 — a CommitLore that passes, for bootstrap witnesses whose subject is something else: a new project
 * requires CommitLore, so a bootstrap needs one. It observes PASS and commits with `gitCommitAttempt`.
 */
export const passingCommitLore = (messages: string[] = []): CommitLorePort => ({
  observe: async () => ({
    outcome: "PASS",
    reportStatus: "ok",
    warnings: [],
    detail: "commitlore doctor passed",
    report: JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] }),
  }),
  attempt: gitCommitAttempt(messages),
});

/**
 * #1268 — a CommitLore that settles a worker turn the way the real one settles a turn with nothing to record: its
 * contract asks for the draft, every path answers with no records and guard finds nothing, the draft is considered
 * as `{"records": []}` and the commit settles `empty`. For fixtures whose subject is the run, not CommitLore: a
 * turn's reply gets that draft from `FakeWorkerAdapter`. The real procedure is witnessed against the real CLI.
 */
export const settlingCommitLore = (messages: string[] = []): CommitLorePort => ({
  ...passingCommitLore(messages),
  contract: async () => allow(ReasonCode.OK, "CommitLore (test double): end your reply with one ```commitlore-draft block holding {\"records\": []}."),
  beforeChange: async (_checkout, _git, request) => ({
    paths: request.paths.map((path) => ({ path, outcome: "answered" as const, text: "", cacheKey: "test-double", withheld: 0, items: null, detail: null, noHistory: true })),
    guard: { status: "clean" as const, matches: [], detail: null },
    cliIdentity: { version: "test-double", digest: `sha256:${"0".repeat(64)}` },
  }),
  attempt: async () => {
    const base = await gitCommitAttempt()();
    if (!base.allowed) return base;
    return allow(ReasonCode.OK, {
      ...base.value,
      consider: async ({ message }) => allow(ReasonCode.OK, { message, outcome: "empty" as const, recordIds: [], nonce: null }),
      settle: async () => allow(ReasonCode.OK, { outcome: "empty" as const, recordIds: [], nonce: null }),
    });
  },
});
