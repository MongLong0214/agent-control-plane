import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import {
  SESSION_METADATA_KEYS,
  composeSquashCommitMessage,
  composeSquashCommitTitle,
  githubSquashCommitMessage,
  withoutSessionMetadata,
} from "../../src/github/merge-commit-message.ts";
import { RECORD_TRAILER_KEYS } from "../../scripts/lib/record-trailer-keys.mjs";

/**
 * What the daemon publishes into `main` when it squashes an approved pull request.
 *
 * Until this module existed the merge PUT carried `{ sha, merge_method }` and nothing else, so the
 * squash message was composed entirely by GitHub from the branch's commit messages
 * (`squash_merge_commit_message = COMMIT_MESSAGES`). Whatever a branch commit said landed verbatim,
 * which is how a session-identifying URL reaches a history nobody may rewrite.
 *
 * Composing the message ourselves buys that exclusion and takes on the opposite risk. Before
 * `COMMIT_MESSAGES` was set, three squash merges dropped 129 of 132 CommitLore record lines and a
 * check called them clean. So every exclusion case below is paired with a preservation case: a
 * suite that only proves the first has traded one silent loss for another.
 *
 * A synthetic session id is used throughout. The shape is what the rules key on; embedding a real
 * one would put the identifier this module exists to remove into the repository.
 */
const SESSION_URL = "https://claude.ai/code/session_0000000000000000000000";

/** Lines git will store as trailers, asked of git rather than of a regex that restates its rule. */
const parsedTrailers = (message: string): string[] =>
  (spawnSync("git", ["interpret-trailers", "--parse"], { encoding: "utf8", input: message }).stdout ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "");

const recordLines = (message: string): string[] =>
  message.split("\n").filter((line) => RECORD_TRAILER_KEYS.some((key) => line.startsWith(`${key}: `)));

describe("the composed message reproduces what GitHub would have written", () => {
  it("matches the observed COMMIT_MESSAGES body of a real multi-commit squash (d0d885f)", () => {
    // Anchored to bytes already on `main` rather than to a reading of GitHub's documentation:
    // `git log -1 --format=%b d0d885fb41fd8d916d2f5e54bfd50b3bd759dd4c`. Each commit contributes
    // `* <subject>`, a blank line, then its body; the contributions are joined by a blank line.
    const commits = [
      {
        sha: "1".repeat(40),
        message:
          "fix: isolate managed runtime version probe cwd\n\n" +
          "Warn: Keep version-probe cwd in the existing invocation-private scratch.\n" +
          "Record-Id: r-806bafc284d3\n" +
          "Provenance: drafted\n",
      },
      {
        sha: "2".repeat(40),
        message:
          "test(buzz): make invalid signature fixture deterministic\n\n" +
          "Ruled-out: overwrite the final signature byte with 00 | can leave a valid signature unchanged\n" +
          "Record-Id: r-593794147ab9\n" +
          "Provenance: drafted\n",
      },
    ];

    expect(githubSquashCommitMessage(commits)).toBe(
      "* fix: isolate managed runtime version probe cwd\n" +
        "\n" +
        "Warn: Keep version-probe cwd in the existing invocation-private scratch.\n" +
        "Record-Id: r-806bafc284d3\n" +
        "Provenance: drafted\n" +
        "\n" +
        "* test(buzz): make invalid signature fixture deterministic\n" +
        "\n" +
        "Ruled-out: overwrite the final signature byte with 00 | can leave a valid signature unchanged\n" +
        "Record-Id: r-593794147ab9\n" +
        "Provenance: drafted",
    );
  });

  it("writes a single commit's body with no bullet, as GitHub does (b7b7a50)", () => {
    const composed = githubSquashCommitMessage([
      {
        sha: "3".repeat(40),
        message:
          "fix: allow npm scoped-package members in sealed rollback\n\n" +
          "Warn: Keep the ordinary member grammar unchanged.\n" +
          "Record-Id: r-c19e9b4eeacc\n" +
          "Provenance: drafted\n",
      },
    ]);
    expect(composed.startsWith("*")).toBe(false);
    expect(composed).toBe(
      "Warn: Keep the ordinary member grammar unchanged.\nRecord-Id: r-c19e9b4eeacc\nProvenance: drafted",
    );
  });

  it("leaves a branch that carries no metadata byte-identical to GitHub's own composition", () => {
    // The composition only earns its risk if it is inert when there is nothing to remove.
    const commits = [
      { sha: "4".repeat(40), message: "feat: a thing\n\nwhy the thing.\n\nLimit: a stated limit\n" },
      { sha: "5".repeat(40), message: "test: cover the thing\n\nRecord-Id: r-aaaabbbbcccc\n" },
    ];
    expect(composeSquashCommitMessage(commits)).toBe(githubSquashCommitMessage(commits));
  });
});

describe("no agent, session or model metadata survives the composition", () => {
  it("removes the trailer form, which a shape-based filter keeps", () => {
    // `X-Claude-Session` is an `X-<Name>`, which is exactly what CommitLore's commit-msg hook
    // accepts. A filter phrased as "keep SPEC §3 keys and X-*" therefore keeps the one line it
    // most needs to drop. Exclusion has to be by the identity of the key.
    const message = `docs: a change\n\nwhy.\n\nLimit: a record that must survive\nX-Claude-Session: ${SESSION_URL}\n`;
    expect(parsedTrailers(message)).toContain(`X-Claude-Session: ${SESSION_URL}`);

    const filtered = withoutSessionMetadata(message);
    expect(filtered).not.toContain("X-Claude-Session");
    expect(filtered).not.toContain("session_0000000000000000000000");
    expect(filtered).toContain("Limit: a record that must survive");
  });

  it("removes the prose form, which is not a trailer at all", () => {
    // The shape one of the two open branches deliberately uses, because the hook rejects
    // `Claude-Session` as a trailer key. git parses no trailers here, so a filter that inspects
    // the parsed trailer block passes it straight through.
    const message =
      "fix: a change\n\n" +
      "The hook refuses `Claude-Session` as a trailer key, so this is written as an ordinary\n" +
      `last line rather than as a trailer.\nClaude-Session: ${SESSION_URL}\n`;
    expect(parsedTrailers(message)).toEqual([]);

    const filtered = withoutSessionMetadata(message);
    // Asserted per line rather than over the whole string: this fixture's prose names the key in
    // backticks, exactly as the real commit does, and a substring test would call that a leak
    // while a line that opens with the key is the only thing that carries the identifier.
    expect(filtered.split("\n").filter((line) => /^\s*Claude-Session\s*:/i.test(line))).toEqual([]);
    expect(filtered).not.toContain("session_0000000000000000000000");
    expect(filtered).toContain("The hook refuses");
  });

  it("redacts a session identifier under a key nobody enumerated", () => {
    // The backstop. The key list is a list, and a list is a guess about next month; the identifier
    // is the thing that must not reach `main`. Prose around it survives — removing the line would
    // be a second silent loss.
    const filtered = withoutSessionMetadata(
      `chore: a change\n\nsee ${SESSION_URL} for the transcript, and note the ordering.\n`,
    );
    expect(filtered).not.toContain("session_0000000000000000000000");
    expect(filtered).toContain("for the transcript, and note the ordering.");
  });

  it("keeps a record line whose value carries an identifier, and redacts only the identifier", () => {
    // Ordering between the two rules, stated where it can fail: a record line is never dropped.
    const filtered = withoutSessionMetadata(`fix: a change\n\nRefs: ${SESSION_URL}\n`);
    expect(filtered).toContain("Refs:");
    expect(filtered).not.toContain("session_0000000000000000000000");
  });

  it("excludes by key identity for every key it claims, case-insensitively", () => {
    for (const key of SESSION_METADATA_KEYS) {
      const upper = withoutSessionMetadata(`s\n\nLimit: keep me\n${key.toUpperCase()}: ${SESSION_URL}\n`);
      const lower = withoutSessionMetadata(`s\n\nLimit: keep me\n${key.toLowerCase()}: ${SESSION_URL}\n`);
      for (const filtered of [upper, lower]) {
        expect(filtered).toContain("Limit: keep me");
        expect(filtered.toLowerCase()).not.toContain(key.toLowerCase());
      }
    }
  });
});

describe("every record line GitHub would have carried survives the composition", () => {
  /** Three commits, each with records, and metadata in both of the shapes that reach `main`. */
  const branch = [
    {
      sha: "a".repeat(40),
      message:
        "feat: the first change\n\n" +
        "why the first change was made.\n\n" +
        "Limit: the first commit's record\n" +
        "Record-Id: r-111111111111\n" +
        "Provenance: drafted\n" +
        `X-Claude-Session: ${SESSION_URL}\n`,
    },
    {
      sha: "b".repeat(40),
      message:
        "fix: the second change\n\n" +
        "why the second change was made.\n\n" +
        "Ruled-out: an alternative | why not\n" +
        "Warn: something the next person needs\n" +
        "Record-Id: r-222222222222\n",
    },
    {
      sha: "c".repeat(40),
      message:
        "docs: the third change\n\n" +
        "The capture flow could not run, so the context is in this prose.\n" +
        `Claude-Session: ${SESSION_URL}\n`,
    },
  ];

  it("loses no line of GitHub's composition except the metadata", () => {
    // Measured over *every* line rather than over the record keys: the canonical key list is a
    // list, and preservation stated in its terms can only be as complete as the list is. A line
    // GitHub would have carried is either present or it is session metadata — nothing else.
    const baseline = githubSquashCommitMessage(branch);
    const composed = composeSquashCommitMessage(branch);
    const survivors = new Set(composed.split("\n").map((line) => line.trim()));

    const lost = baseline
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !survivors.has(line));

    expect(lost).toEqual([`X-Claude-Session: ${SESSION_URL}`, `Claude-Session: ${SESSION_URL}`]);
  });

  it("carries every record line of a multi-commit branch, named rather than counted", () => {
    const composed = composeSquashCommitMessage(branch);
    expect(recordLines(composed)).toEqual(recordLines(githubSquashCommitMessage(branch)));
    expect(recordLines(composed)).toEqual([
      "Limit: the first commit's record",
      "Record-Id: r-111111111111",
      "Ruled-out: an alternative | why not",
      "Warn: something the next person needs",
      "Record-Id: r-222222222222",
    ]);
  });

  it("never names a record key in its exclusion set", () => {
    // The one place the two policies are compared. The exclusion list is not a second copy of the
    // record list — it is asserted disjoint from it, so a key added to either can never make the
    // composer eat a record.
    const excluded = new Set(SESSION_METADATA_KEYS.map((key) => key.toLowerCase()));
    for (const key of RECORD_TRAILER_KEYS) {
      expect(excluded.has(key.toLowerCase())).toBe(false);
    }
  });
});

/**
 * Content, order and record-block survival, measured together on one message.
 *
 * Split fixtures are how a composer passes both halves without ever doing both to the same input:
 * exclusion proved on one message and preservation on another says nothing about the message that
 * actually reaches `main`. Every assertion below reads the same `composed` string.
 *
 * Order is the property worth its own test rather than an assumed side effect. A composer that
 * gathers record lines into a set, sorts them, groups them by key or de-duplicates them satisfies
 * "every line is present" and quietly loses the sequence — and on a single-commit fixture the loss
 * is invisible, because one commit's lines are already in their own order.
 */
describe("one message, both halves, with the record lines in the order the branch wrote them", () => {
  const SESSION_URL = "https://claude.ai/code/session_0000000000000000000000";

  /**
   * Three commits whose record lines are deliberately neither sorted nor unique.
   *
   * `Provenance: drafted` repeats across all three because that is what real records do — d0d885f
   * on `main` carries it once per source commit — and a de-duplicating composer would collapse
   * three lines into one while still passing a membership check.
   */
  const branch = [
    {
      sha: "a".repeat(40),
      message:
        "feat: the first change\n\n" +
        "why the first change was made.\n\n" +
        "Warn: the first thing the next person needs\n" +
        "Limit: the first commit's stated limit\n" +
        "Record-Id: r-311111111111\n" +
        "Provenance: drafted\n" +
        `X-Claude-Session: ${SESSION_URL}\n`,
    },
    {
      sha: "b".repeat(40),
      message:
        "fix: the second change\n\n" +
        "why the second change was made, in prose that must survive.\n\n" +
        "Ruled-out: an alternative | why it was not taken\n" +
        "Limit: the second commit's stated limit\n" +
        "Record-Id: r-122222222222\n" +
        "Provenance: drafted\n",
    },
    {
      sha: "c".repeat(40),
      message:
        "docs: the third change\n\n" +
        "The capture flow could not run, so the context is in this prose.\n" +
        `Claude-Session: ${SESSION_URL}\n\n` +
        "Limit: the third commit's stated limit\n" +
        "Record-Id: r-233333333333\n" +
        "Provenance: drafted\n",
    },
  ];

  /** The sequence the branch wrote, which is what the merge commit has to still say. */
  const WRITTEN_IN_THIS_ORDER = [
    "Warn: the first thing the next person needs",
    "Limit: the first commit's stated limit",
    "Record-Id: r-311111111111",
    "Provenance: drafted",
    "Ruled-out: an alternative | why it was not taken",
    "Limit: the second commit's stated limit",
    "Record-Id: r-122222222222",
    "Provenance: drafted",
    "Limit: the third commit's stated limit",
    "Record-Id: r-233333333333",
    "Provenance: drafted",
  ];

  const recordSequence = (message: string): string[] =>
    message.split("\n").filter((line) => /^(Warn|Limit|Ruled-out|Record-Id|Provenance):/.test(line));

  const composed = composeSquashCommitMessage(branch);
  const baseline = githubSquashCommitMessage(branch);

  it("has a fixture that can actually catch a sort and a de-duplication", () => {
    // Guarding the guard. If the expected sequence were already sorted, a composer that sorts
    // would satisfy it and the order assertion below would be decorative; if it carried no
    // repeats, a composer that de-duplicates would pass too.
    expect(WRITTEN_IN_THIS_ORDER).not.toEqual([...WRITTEN_IN_THIS_ORDER].sort());
    expect(new Set(WRITTEN_IN_THIS_ORDER).size).toBeLessThan(WRITTEN_IN_THIS_ORDER.length);
  });

  it("keeps every record line in the order the branch wrote it, repeats included", () => {
    expect(recordSequence(composed)).toEqual(WRITTEN_IN_THIS_ORDER);
    // And the same sequence GitHub's own composition would have carried, so this is conservation
    // across the transformation rather than agreement with a list someone typed twice.
    expect(recordSequence(composed)).toEqual(recordSequence(baseline));
  });

  it("carries no session metadata anywhere in that same message, prose included", () => {
    // The other half, on the identical string the assertions above just read.
    expect(composed).not.toContain("session_0000000000000000000000");
    for (const key of SESSION_METADATA_KEYS) {
      expect(composed.split("\n").filter((line) => new RegExp(`^\\s*${key}\\s*:`, "i").test(line))).toEqual([]);
    }
    // Prose that merely sits next to the metadata is not collateral.
    expect(composed).toContain("The capture flow could not run");
    expect(composed).toContain("why the second change was made, in prose that must survive.");
  });

  it("loses no line at all except the two metadata lines", () => {
    const survivors = new Set(composed.split("\n").map((line) => line.trim()));
    const lost = baseline
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !survivors.has(line));
    expect(lost).toEqual([`X-Claude-Session: ${SESSION_URL}`, `Claude-Session: ${SESSION_URL}`]);
  });
});

/**
 * What the CommitLore SPEC actually requires of a record, asked of the SPEC rather than assumed.
 *
 * SPEC §4 marks no key required: "A record MAY omit every optional key. A commit with no trailers
 * is not an error." So "the required trailer keys are still present" cannot be tested as a list —
 * there is no such list to test against, and inventing one would be a second policy beside the
 * spec's, which is the failure this module already avoids for the record keys.
 *
 * Two obligations in the spec are real and conditional, and both are testable here:
 *
 *   §2.4 — a paragraph earlier than the last is a *record block* if and only if every line in it
 *          is a trailer AND it declares `Record-Id:`. A composition that drops a `Record-Id:`, or
 *          that leaves a non-trailer line inside such a paragraph, silently demotes a record to
 *          body prose while every line it contains is still technically present.
 *   §3.1 — the `|` in a `Ruled-out:` value is REQUIRED and the first one separates. Losing it
 *          turns the record into a `format` violation rather than a missing line.
 */
describe("the record blocks the SPEC recognises survive the composition", () => {
  const SESSION_URL = "https://claude.ai/code/session_0000000000000000000000";

  const branch = [
    {
      sha: "d".repeat(40),
      message:
        "feat: a change\n\n" +
        "why.\n\n" +
        "Ruled-out: the other approach | it hides the exit status\n" +
        "Record-Id: r-444444444444\n" +
        `X-Claude-Session: ${SESSION_URL}\n`,
    },
    {
      sha: "e".repeat(40),
      message: "fix: another change\n\nwhy.\n\nLimit: a stated limit\nRecord-Id: r-555555555555\n",
    },
  ];

  /**
   * §2.4's own test, delegated to git paragraph by paragraph exactly as the spec prescribes: a
   * synthetic one-line subject in front of the paragraph, and git decides whether it is trailers.
   * Restating git's rule here is what the repository's `commit-msg` hook was rewritten to stop
   * doing, and it drifted the first time.
   */
  const recordBlockIds = (message: string): string[] => {
    const paragraphs = message.split(/\n{2,}/).filter((p) => p.trim() !== "");
    const ids: string[] = [];
    for (const paragraph of paragraphs) {
      const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
        encoding: "utf8",
        input: `subject\n\n${paragraph}\n`,
      }).stdout ?? "";
      const lines = paragraph.trim().split("\n");
      const allTrailers = parsed.split("\n").filter((l) => l.trim() !== "").length === lines.length;
      const id = lines.find((line) => line.startsWith("Record-Id: "));
      if (allTrailers && id !== undefined) ids.push(id);
    }
    return ids;
  };

  it("recognises the same record blocks, by the same identities, before and after", () => {
    const baseline = githubSquashCommitMessage(branch);
    const composed = composeSquashCommitMessage(branch);
    // The fixture is only meaningful if the baseline had blocks to lose.
    expect(recordBlockIds(baseline)).toEqual(["Record-Id: r-444444444444", "Record-Id: r-555555555555"]);
    expect(recordBlockIds(composed)).toEqual(recordBlockIds(baseline));
  });

  it("keeps the separator SPEC §3.1 marks REQUIRED inside a Ruled-out value", () => {
    const composed = composeSquashCommitMessage(branch);
    const ruledOut = composed.split("\n").filter((line) => line.startsWith("Ruled-out: "));
    expect(ruledOut).toEqual(["Ruled-out: the other approach | it hides the exit status"]);
    expect(ruledOut[0]!.slice("Ruled-out: ".length).includes(" | ")).toBe(true);
  });
});

/**
 * `composeSquashCommitTitle` builds COMMIT_OR_PR_TITLE for the squash PUT, and until #833 it had
 * no test at all — both operands of its `title || "Squash pull request"` fallback were unanswered
 * in the census because this file was on the exclusion list.
 *
 * The fallback is not decoration. The subject is sanitized before it is used, so a subject that
 * consists only of session metadata, or a multi-commit branch whose pull title is absent, leaves
 * an empty string — and an empty COMMIT_OR_PR_TITLE would publish `(#7)` as the commit subject of
 * a merge into `main`.
 */
describe("the squash title survives a subject that sanitizes to nothing", () => {
  it("uses the real subject when there is one", () => {
    const title = composeSquashCommitTitle(
      [{ sha: "a".repeat(40), message: "fix: the probe states its bound\n\nbody" }],
      "a pull title nobody should see here",
      7,
    );

    // The single-commit branch takes the commit's own subject, not the pull title.
    expect(title).toBe("fix: the probe states its bound (#7)");
  });

  it("falls back rather than publishing a bare number as the subject", () => {
    // Two commits with no pull title: `subject` is `?? ""`, so the sanitized title is empty.
    const title = composeSquashCommitTitle(
      [
        { sha: "a".repeat(40), message: "first\n" },
        { sha: "b".repeat(40), message: "second\n" },
      ],
      undefined,
      7,
    );

    expect(title).toBe("Squash pull request (#7)");
    // The assertion that matters: whatever the fallback says, the subject is not empty.
    expect(title.startsWith(" (#")).toBe(false);
  });

  it("falls back when the subject is nothing but session metadata", () => {
    // The sanitizer removes these keys wherever they appear, including a first line — which is
    // the reachable version of the empty subject on a one-commit branch.
    const title = composeSquashCommitTitle(
      [{ sha: "a".repeat(40), message: `${SESSION_METADATA_KEYS[0]}: ${SESSION_URL}\n` }],
      undefined,
      7,
    );

    expect(title).toBe("Squash pull request (#7)");
  });
});
