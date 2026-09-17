import { afterAll, describe, expect, it } from "vitest";

import {
  INDEX_MARKER,
  bulletsOf,
  headingCountOf,
  openSectionOf,
  reconcile,
} from "../../scripts/lib/index-open-list.mjs";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The index's open list drifted four times, and each correction was itself a copy.
 *
 * Its own body records the first three; the fourth was measured on 2026-09-18, when six of nine
 * live bullets named closed issues and three open issues had no bullet at all. What the body also
 * records is why: *"the correction keeps not sticking because the list is a copy"*. These rows are
 * about the reconciler that refuses the copy once it has stopped being true.
 *
 * The rules are pinned here rather than the wording of the findings: a message is prose, and a
 * reader who changes it should not have to change a test. What must not change is which states are
 * refused.
 */
const indexBody = (section: string): string => `${INDEX_MARKER}
Some preamble the reconciler must not read as a list.

## Where things stand

A paragraph naming #999 in prose, which is not a bullet and is not the list.

${section}

## Suggested order of work

- **#998** — a bullet in a later section, which is a different list.
`;

const issue = (number: number, title: string, body = ""): Record<string, unknown> => ({
  number,
  title,
  body,
});

describe("the index cannot name a closed issue as open", () => {
  it("reads only the bullets of the open section, not prose or later sections", () => {
    const section = `## What is actually open — 2 listed below

> **Measured 2026-09-13.** This section named #674 and #784, both since closed. That note is the
> record of a previous drift and must not be read as a list entry.

- **#627** — still open.
- ~~**#674**~~ — **closed 2026-09-13.**
- **#631** — still open.
`;
    const extracted = openSectionOf(indexBody(section));
    expect(extracted).not.toBeNull();
    // The prose citation of #674 inside the blockquote, the #999 in an earlier section and the
    // #998 bullet in a later one are all outside this list. A first draft took every `#N` in the
    // section and failed on the section's own history, which would have taught a maintainer to
    // delete the record of the drift this check exists to stop.
    expect(bulletsOf(extracted!)).toEqual({ live: [627, 631], struck: [674] });
    expect(headingCountOf(extracted!)).toBe(2);
  });

  it("refuses a live bullet whose issue is closed, and accepts the same issue struck through", () => {
    const listed = `## What is actually open — 1 listed below

- **#627** — open.
- **#858** — closed, and presented as open.
`;
    const closedListed = reconcile([
      issue(306, "[index]", indexBody(listed)),
      issue(627, "open one"),
    ]);
    expect(closedListed.map((finding) => finding.rule)).toContain("closed-issue-listed-as-open");
    expect(closedListed.some((finding) => finding.detail.includes("#858"))).toBe(true);

    const struck = `## What is actually open — 1 listed below

- **#627** — open.
- ~~**#858**~~ — **closed 2026-09-16.**
`;
    // Strikethrough is the section's own marker for "named here, and finished". Keeping the entry
    // that way is how a reader learns the area is done rather than wondering why it vanished, so
    // it must be an accepted state and not merely an unreported one.
    expect(reconcile([issue(306, "[index]", indexBody(struck)), issue(627, "open one")])).toEqual([]);
  });

  it("refuses a heading count that disagrees with its own list", () => {
    const section = `## What is actually open — 11 listed below

- **#627** — open.
`;
    const findings = reconcile([issue(306, "[index]", indexBody(section)), issue(627, "open one")]);
    expect(findings.map((finding) => finding.rule)).toEqual(["heading-count-disagrees"]);
    expect(findings[0]?.detail).toContain("says 11");
  });

  it("refuses an open issue that has no bullet, and exempts the index itself", () => {
    const section = `## What is actually open — 1 listed below

- **#627** — open.
`;
    const findings = reconcile([
      issue(306, "[index]", indexBody(section)),
      issue(627, "open one"),
      issue(954, "a revoked binding has no way back"),
    ]);
    // The other half of the same defect: a reader who does not find an issue here concludes it
    // does not exist. #954 was absent from the list while the deployment waited on its decision.
    expect(findings.map((finding) => finding.rule)).toEqual(["open-issue-absent"]);
    expect(findings[0]?.detail).toContain("#954");

    // And the index is not required to route to itself, which is the one exemption.
    expect(reconcile([issue(306, "[index]", indexBody(section)), issue(627, "open one")])).toEqual([]);
  });

  it("says nothing was found rather than passing when the index or its section is absent", () => {
    // Absence is the failure this whole module is about, so it must not be the quiet answer.
    // An index that has lost its marker, or a body that has lost the section, produces a finding —
    // an empty findings list must mean "reconciled", never "nothing was looked at".
    expect(reconcile([issue(627, "no index among these")]).map((f) => f.rule)).toEqual(["index-missing"]);
    expect(
      reconcile([issue(306, "[index]", `${INDEX_MARKER}\nno such section here`)]).map((f) => f.rule),
    ).toEqual(["section-missing"]);
  });
});
