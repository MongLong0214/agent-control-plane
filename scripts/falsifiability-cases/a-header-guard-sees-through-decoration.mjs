/**
 * #833/#866 — the guard that keeps counts out of the two backlog headers reads the prose the
 * repository actually writes, not an idealised form of it.
 *
 * A first version matched digits followed by `\s+` and then the noun. A merge-gate review injected
 * the removed prose's own typography and watched three of four counts walk past:
 *
 *   `**3,479** \`&&\`/\`||\` operands`   bold and backticks break the adjacency
 *   `these 86\n * files`                 the block-comment continuation breaks the whitespace run
 *   a `//`-style header                  no `*\/`, so the slice returned "" and the assertion
 *                                        passed against nothing — absence read as compliance
 *
 * Worse, the guard's apparent teeth were coincidental: splicing the base headers back in failed on
 * `86 files` inside a sentence that states no size, while none of `3,479`, `3,922` or `443` — the
 * numbers that actually went stale and that this series exists to remove — matched at all.
 *
 * The mutation narrows the noun set back to `operands`/`files`, which drops "the repository total
 * 3,922" — the census's own wording, and the form a header would copy.
 *
 * It is killed by the *predicate* case, not by the one that reads the real headers, and that is
 * measured rather than chosen. The headers are clean, so they pass whichever way the predicate is
 * written and cannot witness it; naming that case left this row SURVIVED. The observable that
 * changes is whether the three injected forms are detected.
 */
const aHeaderGuardSeesThroughDecoration = {
  id: "a-header-guard-sees-through-decoration",
  what: "the header guard matches a restated count through decoration and comment continuations, and refuses a header it cannot see",
  file: "tests/unit/the-census-prints-its-own-counts.test.ts",
  find: '  const noun = "(?:operands?|files?|total)";\n',
  replace: '  const noun = "(?:operands?|files?)";\n',
  killedBy: [
    "tests/unit/the-census-prints-its-own-counts.test.ts::sees a restated count through the decoration these headers actually used",
  ],
};

export default aHeaderGuardSeesThroughDecoration;
