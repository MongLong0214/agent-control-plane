#!/usr/bin/env node
/**
 * The index's "What is actually open" list must not route a reader to a closed issue, and must not
 * omit an open one.
 *
 * ## Why this exists rather than another correction
 *
 * The list has gone stale four times, and #306's own body records each time it happened:
 *
 * ```
 * Measured 2026-09-12  "all 16" — named seven issues that were already closed
 * Measured 2026-09-13  named #674, #777, #859, #784, all closed; fourteen became twelve
 * 2026-09-15           the heading said 11
 * 2026-09-18           six of nine live bullets named closed issues
 * ```
 *
 * The body also says why the correction keeps not sticking: *"the correction keeps not sticking
 * because the list is a copy"*. A copy with no reconciler drifts on the tracker's schedule, not on
 * anyone's attention, and an index that routes a reader to a closed issue is worse than one that
 * omits it — the reader opens it, sees green, and concludes the area is finished.
 *
 * So this is the reconciler. It does not maintain the list; it refuses a list that has stopped
 * being true, which is the only part a machine can do honestly.
 *
 * ## What it reads, and why that subject and not a wider one
 *
 * Only bullets of the exact shape the section already uses:
 *
 * ```
 * - **#627** — retire the legacy CEO fork...          live
 * - ~~**#674**~~ — **closed 2026-09-13.** ...          struck through
 * ```
 *
 * A first draft took every `#N` in the section and failed on the section's own history — the
 * `> Measured …` notes cite closed issues deliberately, as the record of a previous drift. Those
 * citations are the document working correctly, and a check that calls them defects would teach
 * the maintainer to delete the history. The bullet form is the list; everything else in the section
 * is prose about the list.
 *
 * Strikethrough is the section's existing marker for "named here, but finished", so it is the
 * escape: a closed issue may stay in the list struck through, which is how a reader learns the area
 * is done rather than wondering why it vanished.
 *
 * ## Three rules, and each one is a failure the tracker has actually produced
 *
 * 1. A live bullet must name an open issue. (Four occurrences.)
 * 2. The heading's count must equal the number of live bullets. (Observed at 11 against 9.)
 * 3. An open issue must appear in the section, live. (#954 was absent while the deployment waited
 *    on it.) The index issue itself is exempt: a map does not route to itself.
 *
 * ## Exit codes, matching this repository's other tracker checks
 *
 * 0 the list reconciles · 1 it does not · 2 nobody could look. `verify-tracker-loci-resolve.mjs`
 * draws the same distinction for the same reason: "nobody could look" must not read as "the list
 * disagrees with the tracker", and conflating them sends a reader hunting a disagreement that may
 * not exist.
 *
 * This module is the rules; `scripts/verify-index-lists-what-is-open.mjs` is the command that
 * fetches the tracker and prints them. Split for this repository's own reason: a `.mjs` a
 * TypeScript test imports needs a checked-in declaration, and `scripts/lib/*.mjs` with a
 * generated `.d.mts` is where that already lives. It also keeps the rules testable without a
 * network, which is the property the fixture seam exists for.
 */

/** The marker that names the index issue, so nothing here depends on an issue number. */
export const INDEX_MARKER = "<!-- acp-work:ssot-index -->";

/** The section whose list is reconciled. Matched on its heading prefix, not its whole text. */
export const SECTION_HEADING_PREFIX = "## What is actually open";

/**
 * The section's own text, or `null` when the body has no such section.
 *
 * Bounded at the next `## ` heading rather than the end of the body: the sections after it
 * ("Suggested order of work", "Reference material") name issues too, and they are not this list.
 */
export const openSectionOf = (body) => {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith(SECTION_HEADING_PREFIX));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
};

/**
 * The issue numbers the section's bullets name, split by whether they are struck through.
 *
 * Deliberately two lists rather than a set of "mentioned" numbers: the whole judgment this check
 * makes is about which of the two a number is in.
 */
export const bulletsOf = (section) => {
  const live = [];
  const struck = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    const strikethrough = /^- ~~\*\*#(\d+)\*\*~~/.exec(line);
    if (strikethrough) {
      struck.push(Number(strikethrough[1]));
      continue;
    }
    const plain = /^- \*\*#(\d+)\*\*/.exec(line);
    if (plain) live.push(Number(plain[1]));
  }
  return { live, struck };
};

/** The count the heading claims, or `null` when it states none. */
export const headingCountOf = (section) => {
  const heading = section.split("\n")[0] ?? "";
  const stated = /—\s*(\d+)\b/.exec(heading);
  return stated ? Number(stated[1]) : null;
};

/**
 * Every finding, as `{ rule, detail }`. An empty array is the list reconciling.
 *
 * Takes the issues rather than fetching them so the rules are testable without a network, and
 * returns findings rather than printing them so a caller can count them.
 */
export const reconcile = (issues) => {
  const index = issues.find((issue) => (issue.body ?? "").includes(INDEX_MARKER));
  if (!index) return [{ rule: "index-missing", detail: `no open issue carries ${INDEX_MARKER}` }];

  const section = openSectionOf(index.body ?? "");
  if (section === null) {
    return [{
      rule: "section-missing",
      detail: `#${index.number} has no "${SECTION_HEADING_PREFIX}" section`,
    }];
  }

  const { live } = bulletsOf(section);
  const openNumbers = new Set(issues.map((issue) => issue.number));
  const findings = [];

  // Rule 1. The list is a route, and a route to a closed issue is worse than no route.
  for (const number of live) {
    if (!openNumbers.has(number)) {
      findings.push({
        rule: "closed-issue-listed-as-open",
        detail: `#${number} is a live bullet and is not open — strike it through, or remove it`,
      });
    }
  }

  // Rule 2. The heading's number is a second statement of the list's length, so it is exactly the
  // kind of copy that drifts. Requiring the two to agree is what keeps the cheap one honest.
  const stated = headingCountOf(section);
  const liveOpen = live.filter((number) => openNumbers.has(number)).length;
  if (stated !== null && stated !== liveOpen) {
    findings.push({
      rule: "heading-count-disagrees",
      detail: `the heading says ${stated} and the section has ${liveOpen} live bullet(s) naming open issues`,
    });
  }

  // Rule 3. The other half of the same defect: a reader who does not find an issue here concludes
  // it does not exist. The index issue is exempt because a map does not route to itself.
  const listed = new Set(live);
  for (const issue of issues) {
    if (issue.number === index.number) continue;
    if (!listed.has(issue.number)) {
      findings.push({
        rule: "open-issue-absent",
        detail: `#${issue.number} is open and has no live bullet — ${(issue.title ?? "").slice(0, 60)}`,
      });
    }
  }

  return findings;
};

