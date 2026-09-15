import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
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
  const out = boundedSpawnSync(
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
    const out = boundedSpawnSync(
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
    const parsed = boundedSpawnSync("git", ["interpret-trailers", "--parse"], {
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
    const out = boundedSpawnSync(process.execPath, [join(ROOT, "scripts/merge-pr.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("--body-file");
  });
});

/**
 * The other place a record is stored, and the two occasions this check called one lost.
 *
 * A squash strands the branch's earlier records mid-message, which git will not parse — and
 * `commitlore squash-preserve` and the `commitlore-preserve` workflow answer exactly that by
 * attaching them to the merge commit as a note on `refs/notes/commitlore`. 0da07459 chose that
 * over rewriting pushed history, so a note is this repository's repair, not a workaround.
 *
 * The check read only the message, so it reported a repaired commit as a loss:
 *
 *     573f7eab  (#867)  eleven record lines, three parsed, records attached as notes
 *                       -> turned two green pull requests red; answered by narrowing the range
 *     8b38c9d6  (#937)  four record lines lost to the squash, all four in the commit's note
 *                       -> the range is already HEAD~1..HEAD; main stayed red over nothing
 *
 * These run the real script against a fixture repository through `GIT_DIR`, because the commit
 * path is the half that reads git and the message path cannot reach it.
 */
const fixtureGit = (dir: string) => (...args: string[]): string => {
  const done = boundedSpawnSync("git", args, { cwd: dir, encoding: "utf8" });
  expect(done.status, `git ${args.join(" ")}: ${done.stderr ?? ""}`).toBe(0);
  return (done.stdout ?? "").trim();
};

const fixtureRepo = (): string => {
  const dir = tempDir("acp-trailer-notes-");
  const git = fixtureGit(dir);
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  return dir;
};

/** A message shaped the way a squash shapes one: two trailer blocks, of which git keeps the last. */
const strandedMessage = [
  "merge subject",
  "",
  "what the branch did.",
  "",
  "Limit: the record the squash stranded.",
  "",
  "second commit subject",
  "",
  "more body.",
  "",
  "Limit: the record in the last paragraph.",
  "",
].join("\n");

let commitCounter = 0;

const commitInto = (dir: string, message: string): string => {
  const git = fixtureGit(dir);
  commitCounter += 1;
  writeFileSync(join(dir, `f${String(commitCounter)}.txt`), "content\n");
  const messageFile = join(dir, "MESSAGE");
  writeFileSync(messageFile, message);
  git("add", "-A");
  git("commit", "-q", "-F", messageFile);
  return git("rev-parse", "HEAD");
};

const note = (dir: string, sha: string, body: string): void => {
  fixtureGit(dir)("notes", "--ref=commitlore", "add", "-m", body, sha);
};

/** The real script, reading the fixture repository rather than this one. */
const verifyCommit = (dir: string, range: string): { status: number; stdout: string } => {
  const out = boundedSpawnSync(
    process.execPath,
    [join(ROOT, "scripts/verify-trailers-are-parsable.mjs"), range],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir },
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout ?? "" };
};

describe("a record a note carries is stored, and one nothing carries is lost", () => {
  it("refuses a stranded record when no note carries it", () => {
    const dir = fixtureRepo();
    const sha = commitInto(dir, strandedMessage);
    const { status, stdout } = verifyCommit(dir, sha);
    expect(status).toBe(1);
    expect(stdout).toContain("the record the squash stranded");
    expect(stdout).not.toContain("the record in the last paragraph");
  });

  it("accepts a stranded record the commit's own note carries", () => {
    const dir = fixtureRepo();
    const sha = commitInto(dir, strandedMessage);
    note(dir, sha, "Limit: the record the squash stranded.");
    expect(verifyCommit(dir, sha).status).toBe(0);
  });

  it("names only the stranded lines no note carries", () => {
    // A note that preserved half of a merge's records is the case a pass/fail on the note's mere
    // existence would wave through, and the author would never learn which record went missing.
    const dir = fixtureRepo();
    const sha = commitInto(
      dir,
      [
        "merge subject",
        "",
        "body.",
        "",
        "Limit: the first stranded record.",
        "Warn: the second stranded record.",
        "",
        "second subject",
        "",
        "more body.",
        "",
        "Limit: the record in the last paragraph.",
        "",
      ].join("\n"),
    );
    note(dir, sha, "Limit: the first stranded record.");
    const { status, stdout } = verifyCommit(dir, sha);
    expect(status).toBe(1);
    expect(stdout).toContain("the second stranded record");
    expect(stdout).not.toContain("the first stranded record");
  });

  it("refuses without the fetch advice when the notes ref is present and this commit has no note", () => {
    // The advice is for a checkout that could not look. Printing it where the check *did* look and
    // found nothing would send the reader to fetch a ref they already have, and would suggest the
    // record might be fine when this run established that it is not.
    const dir = fixtureRepo();
    const other = commitInto(dir, "unrelated subject\n\nbody.\n");
    note(dir, other, "Limit: a note on some other commit.");
    const sha = commitInto(dir, strandedMessage);
    const { status, stdout } = verifyCommit(dir, sha);
    expect(status).toBe(1);
    expect(stdout).toContain("the record the squash stranded");
    expect(stdout).not.toContain("refs/notes/commitlore is not in this checkout");
  });

  it("says what it could not read when the notes ref is absent entirely", () => {
    const dir = fixtureRepo();
    const sha = commitInto(dir, strandedMessage);
    const { status, stdout } = verifyCommit(dir, sha);
    expect(status).toBe(1);
    expect(stdout).toContain("refs/notes/commitlore is not in this checkout");
    expect(stdout).toContain("refs/notes/commitlore:refs/notes/commitlore");
  });

  it("does not let a note excuse a message that has not been merged yet", () => {
    // `--message-file` runs before the merge, from `scripts/merge-pr.mjs`. There is no commit to
    // hang a note on, so the message itself must carry every record — the note is a repair for
    // history that already exists, never a licence to compose a message that loses one.
    expect(verify(strandedMessage).status).toBe(1);
  });
});
