import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { collapseTrailerParagraphs } from "../../scripts/lib/collapse-trailer-paragraphs.mjs";

afterAll(cleanupTempDirs);

/**
 * What a squash merge does to a branch's records, and what the check that watched it could see.
 *
 * The `commit-msg` hook was installed and working when the merge commit for #665 landed a wrapped
 * `Limit:` on `main`. No local hook runs on a commit GitHub composes server-side, so the guard was
 * never reached — the first failure here.
 *
 * Measuring that found the larger one. A squash concatenates every branch commit message and git
 * reads only the **last paragraph** as trailers, so all but the final commit's records are dropped
 * by the merge itself:
 *
 *     8ab3342   19 record lines on the branch    3 stored by the merge
 *     108ab1a   30                                0
 *     74c37fa   83                                0        (32 commits)
 *
 * The range check reported all three clean. It looked for a continuation line directly after a
 * trailer, which cannot see a trailer sitting in a paragraph that is not the last one — a check
 * whose name ("trailers are parsable") was wider than what it enforced, for the seventh time on
 * this branch and the first where the fix for one shape had the other shape.
 *
 * So the check asks git now, and these are the two shapes it used to miss.
 */
const ROOT = process.cwd();

const verify = (message: string): { status: number; stdout: string } => {
  const file = join(tempDir("acp-trailer-msg-"), "MESSAGE");
  writeFileSync(file, message);
  const out = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/verify-trailers-are-parsable.mjs"), "--message-file", file],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: out.status ?? -1, stdout: out.stdout };
};

/** What a squash produces: two commit messages joined, each with its own trailer block. */
const squashed = [
  "first commit subject",
  "",
  "why the first change was made.",
  "",
  "Limit: the first commit's record, which the squash drops.",
  "",
  "second commit subject",
  "",
  "why the second change was made.",
  "",
  "Limit: the last paragraph, which survives.",
  "",
].join("\n");

describe("the trailer check sees what git stores, not what the message looks like", () => {
  it("refuses a record stranded in a paragraph that is not the last one", () => {
    // The defect that reached main three times and was reported clean each time. git returns the
    // final `Limit:` and nothing else, so the message writes two records and stores one.
    const { status, stdout } = verify(squashed);
    expect(status).toBe(1);
    expect(stdout).toContain("the first commit's record");
    // And it names the lost one rather than reporting that a count disagreed — the author needs to
    // know which record went missing, not that arithmetic failed.
    expect(stdout).not.toContain("the last paragraph, which survives");
  });

  it("refuses the wrapped trailer that landed on main in 74c37fa", () => {
    expect(
      verify(
        "subject\n\nbody\n\nLimit: `observe()` authenticates a settlement as coming from the coordinator, not as coming from\nthe authority it names.\n",
      ).status,
    ).toBe(1);
  });

  it("refuses a trailer block with no blank line before it", () => {
    // The shape the previous regex could not see either: git needs the block to be its own
    // paragraph, and a trailer pressed against the body is not one.
    expect(verify("subject\n\nbody line\nLimit: pressed against the body\n").status).toBe(1);
  });

  it("accepts the same records collected into one final block, which is what squash-preserve does", () => {
    const { status } = verify(
      [
        "merge subject",
        "",
        "what the branch did.",
        "",
        "Limit: the first commit's record, which the squash drops.",
        "Limit: the last paragraph, which survives.",
        "",
      ].join("\n"),
    );
    expect(status).toBe(0);
  });

  it("accepts a message with no records at all", () => {
    expect(verify("subject\n\njust a body\n").status).toBe(0);
  });

  it("reports a range it cannot resolve as a failure, not as a clean result", () => {
    // A check that answers without having looked is the shape this whole file is about.
    const out = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/verify-trailers-are-parsable.mjs"), "refs/nothing/here..HEAD"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("nothing was examined");
  });
});

describe("the inherited records are collapsed into one block git will keep", () => {
  it("joins the per-commit paragraphs squash-preserve writes", () => {
    // What `commitlore squash-preserve --message-file` actually produces: one paragraph per source
    // commit, each closed by its own `Provenance:` line. Measured on #667 — the tool whose job is
    // to preserve the records emitted a message that loses all but the last commit's.
    const preserved = [
      "merge subject",
      "",
      "what the branch did.",
      "",
      "Limit: the first commit's record.",
      "Provenance: inherited aaaaaaa",
      "",
      "Limit: the second commit's record.",
      "Ruled-out: an alternative | why not",
      "Provenance: inherited bbbbbbb",
      "",
    ].join("\n");

    const collapsed = collapseTrailerParagraphs(preserved);

    expect(collapsed).toContain("the first commit's record.\nProvenance: inherited aaaaaaa\nLimit:");
    // The property, stated where it can fail: git keeps every line, and each record still precedes
    // the provenance it belongs to.
    const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
      cwd: ROOT,
      encoding: "utf8",
      input: collapsed,
    }).stdout;
    expect(parsed.split("\n").filter((l) => /^(Limit|Ruled-out|Provenance):/.test(l))).toHaveLength(5);
  });

  it("leaves a message whose records are already one block alone", () => {
    const one = "subject\n\nbody\n\nLimit: one\nRuled-out: two | three\n";
    expect(collapseTrailerParagraphs(one)).toBe(one);
  });

  it("does not join paragraphs that are not all trailers", () => {
    // A prose paragraph between two trailer blocks means the earlier block is already lost, and
    // joining across it would move prose into the trailer block rather than report the loss.
    const mixed = "subject\n\nLimit: stranded\n\nprose that ends the block\n\nLimit: kept\n";
    expect(collapseTrailerParagraphs(mixed)).toBe(mixed);
  });
});

describe("the merge path asks before the commit exists", () => {
  it("refuses arguments it cannot check rather than merging on a default", () => {
    const out = spawnSync(process.execPath, [join(ROOT, "scripts/merge-pr.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("--body-file");
  });
});
