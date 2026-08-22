/**
 * Joins the trailing trailer-only paragraphs of a commit message into one.
 *
 * `commitlore squash-preserve --message-file` writes **one paragraph per source commit**, each
 * ending in its own `Provenance: inherited <sha>`. That is readable, and `git interpret-trailers`
 * stores only the last paragraph — so inheriting four commits' records produced a merge message
 * that lost three of them. Measured on #667 while testing the merge path: 9 of 13 lines, by the
 * tool whose job is to preserve them.
 *
 * Collapsing keeps the pairing, because each record still precedes its own `Provenance:` line and
 * git preserves trailer order. Only the blank lines between the blocks go.
 *
 * Deliberately narrow: it joins a run of paragraphs at the *end* whose every line is a trailer and
 * touches nothing else. The blank line before the first of them is what makes it a trailer block
 * at all, so that one stays.
 *
 * Lives in its own file so a test can run it. Inside `merge-pr.mjs` its only proof was a dry run
 * against a live pull request, which is not a check anything can repeat.
 */
export const collapseTrailerParagraphs = (message) => {
  const paragraphs = message.split(/\n{2,}/);
  // Trimmed before splitting: the final paragraph carries the file's trailing newline, so an
  // untrimmed `every` sees one empty line and reports the last block — the only one git currently
  // stores — as not a trailer block at all. That single miss made the whole collapse a no-op.
  const isTrailerOnly = (p) =>
    p.trim() !== "" && p.trim().split("\n").every((line) => /^[A-Za-z][A-Za-z-]*: /.test(line));
  let first = paragraphs.length;
  while (first > 0 && isTrailerOnly(paragraphs[first - 1])) first -= 1;
  if (paragraphs.length - first < 2) return message;
  return [...paragraphs.slice(0, first), paragraphs.slice(first).join("\n")].join("\n\n");
};
